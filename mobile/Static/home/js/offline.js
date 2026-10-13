/**
 * Streamify offline storage. Metadata lives in IndexedDB and media bodies live
 * in CacheStorage; both are scoped to the authenticated username.
 */

const DB_NAME = 'StreamifyOffline';
const DB_VERSION = 7;
const STORE_SONGS = 'songsByUser';
const STORE_PROFILE = 'profilesByUser';
const STORE_PLAYLISTS = 'playlistsByUser';
const STORE_STATE = 'offlineState';
const USER_INDEX = 'byUser';

const LEGACY_STORE_SONGS = 'songs';
const LEGACY_STORE_PROFILE = 'profile';
const LEGACY_STORE_PLAYLISTS = 'playlists';
const MEDIA_CACHE_PREFIX = 'streamify-media-cache-';
const OFFLINE_STATE_CACHE_NAME = 'streamify-offline-state-v1';
const ACTIVE_USER_STATE_URL = '/__streamify_offline_state__/active-user';

let offlineDB = null;
let offlineDBPromise = null;
let activeUserKey = null;
let activeUsername = null;

function normalizeUsername(username) {
    if (typeof username !== 'string') return null;
    const normalized = username.trim().toLowerCase();
    return normalized || null;
}

function normalizeEntityId(id) {
    if (typeof id === 'number' && Number.isFinite(id)) return id;
    if (typeof id === 'string' && id.trim() !== '' && !Number.isNaN(Number(id))) {
        return Number(id);
    }
    if (typeof id === 'string' && id !== '') return id;
    throw new TypeError('Offline records require a valid ID');
}

function getMediaCacheName(userKey) {
    return `${MEDIA_CACHE_PREFIX}${encodeURIComponent(userKey)}`;
}

function createBlockedError() {
    const error = new Error('Offline storage upgrade is blocked by another open Streamify tab. Close or reload the other tab and try again.');
    error.name = 'BlockedError';
    return error;
}

function ensureScopedStore(db, transaction, name, keyPath) {
    const store = db.objectStoreNames.contains(name)
        ? transaction.objectStore(name)
        : db.createObjectStore(name, { keyPath });
    if (!store.indexNames.contains(USER_INDEX)) {
        store.createIndex(USER_INDEX, 'offlineUser', { unique: false });
    }
    return store;
}

function migrateLegacyRecords(db, transaction, stores) {
    if (!db.objectStoreNames.contains(LEGACY_STORE_PROFILE)) return;

    const profileRequest = transaction.objectStore(LEGACY_STORE_PROFILE).get('currentUser');
    profileRequest.onsuccess = () => {
        try {
            const profile = profileRequest.result;
            const userKey = profile && normalizeUsername(profile.username);
            if (!userKey) return;

            stores.profile.put({ ...profile, offlineUser: userKey });
            stores.state.put({ key: 'activeUser', offlineUser: userKey, username: profile.username });

            if (db.objectStoreNames.contains(LEGACY_STORE_SONGS)) {
                const cursorRequest = transaction.objectStore(LEGACY_STORE_SONGS).openCursor();
                cursorRequest.onsuccess = () => {
                    try {
                        const cursor = cursorRequest.result;
                        if (!cursor) return;
                        if (cursor.value && cursor.value.id !== undefined && cursor.value.id !== null) {
                            stores.songs.put({
                                ...cursor.value,
                                id: normalizeEntityId(cursor.value.id),
                                offlineUser: userKey
                            });
                        }
                        cursor.continue();
                    } catch (error) {
                        console.error('[Offline DB] Song migration failed:', error);
                        transaction.abort();
                    }
                };
            }

            if (db.objectStoreNames.contains(LEGACY_STORE_PLAYLISTS)) {
                const cursorRequest = transaction.objectStore(LEGACY_STORE_PLAYLISTS).openCursor();
                cursorRequest.onsuccess = () => {
                    try {
                        const cursor = cursorRequest.result;
                        if (!cursor) return;
                        if (cursor.value && cursor.value.id !== undefined && cursor.value.id !== null) {
                            stores.playlists.put({
                                ...cursor.value,
                                id: normalizeEntityId(cursor.value.id),
                                offlineUser: userKey
                            });
                        }
                        cursor.continue();
                    } catch (error) {
                        console.error('[Offline DB] Playlist migration failed:', error);
                        transaction.abort();
                    }
                };
            }
        } catch (error) {
            console.error('[Offline DB] Profile migration failed:', error);
            transaction.abort();
        }
    };
}

function runTransaction(db, storeNames, mode, operation) {
    return new Promise((resolve, reject) => {
        let transaction;
        let result;
        let operationError = null;
        let settled = false;

        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error || new Error('IndexedDB transaction failed'));
        };

        try {
            transaction = db.transaction(storeNames, mode);
        } catch (error) {
            fail(error);
            return;
        }

        transaction.oncomplete = () => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        transaction.onerror = event => {
            operationError = operationError || event.target.error || transaction.error;
            fail(operationError);
        };
        transaction.onabort = () => fail(operationError || transaction.error || new Error('IndexedDB transaction was aborted'));

        try {
            operation(transaction, value => {
                result = value;
            });
        } catch (error) {
            operationError = error;
            try {
                transaction.abort();
            } catch (abortError) {
                fail(error);
            }
        }
    });
}

function readActiveUserState(db) {
    return runTransaction(db, STORE_STATE, 'readonly', (transaction, setResult) => {
        const request = transaction.objectStore(STORE_STATE).get('activeUser');
        request.onsuccess = () => setResult(request.result || null);
    });
}

function postUserStateToWorker(userKey) {
    if (!('serviceWorker' in navigator)) return;

    const message = userKey
        ? { type: 'SET_CURRENT_USER', username: userKey }
        : { type: 'CLEAR_ACTIVE_USER' };
    const controller = navigator.serviceWorker.controller;
    if (controller) controller.postMessage(message);

    navigator.serviceWorker.ready.then(registration => {
        if (registration.active && registration.active !== controller) {
            registration.active.postMessage(message);
        }
    }).catch(() => undefined);
}

async function syncWorkerUserState(userKey) {
    postUserStateToWorker(userKey);
    if (typeof caches !== 'undefined') {
        const cache = await caches.open(OFFLINE_STATE_CACHE_NAME);
        if (userKey) {
            await cache.put(ACTIVE_USER_STATE_URL, new Response(JSON.stringify({ username: userKey }), {
                headers: { 'Content-Type': 'application/json' }
            }));
        } else {
            await cache.delete(ACTIVE_USER_STATE_URL);
        }
    }
}

function initOfflineDB() {
    if (offlineDB) return Promise.resolve(offlineDB);
    if (offlineDBPromise) return offlineDBPromise;

    offlineDBPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        let settled = false;

        const rejectOpen = error => {
            if (settled) return;
            settled = true;
            console.error('[Offline DB] Error initializing DB:', error);
            reject(error);
        };

        request.onupgradeneeded = event => {
            const db = event.target.result;
            const transaction = event.target.transaction;
            try {
                const stores = {
                    songs: ensureScopedStore(db, transaction, STORE_SONGS, ['offlineUser', 'id']),
                    profile: ensureScopedStore(db, transaction, STORE_PROFILE, 'offlineUser'),
                    playlists: ensureScopedStore(db, transaction, STORE_PLAYLISTS, ['offlineUser', 'id']),
                    state: db.objectStoreNames.contains(STORE_STATE)
                        ? transaction.objectStore(STORE_STATE)
                        : db.createObjectStore(STORE_STATE, { keyPath: 'key' })
                };
                migrateLegacyRecords(db, transaction, stores);
            } catch (error) {
                console.error('[Offline DB] Upgrade failed:', error);
                transaction.abort();
            }
        };

        request.onblocked = () => rejectOpen(createBlockedError());
        request.onerror = () => rejectOpen(request.error || new Error('Could not open offline storage'));
        request.onsuccess = async () => {
            const db = request.result;
            if (settled) {
                db.close();
                return;
            }

            db.onversionchange = () => {
                db.close();
                if (offlineDB === db) {
                    offlineDB = null;
                    offlineDBPromise = null;
                }
            };
            db.onclose = () => {
                if (offlineDB === db) {
                    offlineDB = null;
                    offlineDBPromise = null;
                }
            };

            try {
                const state = await readActiveUserState(db);
                activeUserKey = state ? normalizeUsername(state.offlineUser || state.username) : null;
                activeUsername = state && state.username ? state.username : activeUserKey;
                offlineDB = db;
                settled = true;
                resolve(db);
                syncWorkerUserState(activeUserKey).catch(error => {
                    console.warn('[Offline DB] Could not sync user state to the service worker:', error);
                });
            } catch (error) {
                db.close();
                rejectOpen(error);
            }
        };
    });

    return offlineDBPromise;
}

async function getDB() {
    return initOfflineDB();
}

async function requireActiveUser() {
    await getDB();
    if (!activeUserKey) {
        throw new Error('Offline storage is not initialized for the authenticated user');
    }
    return { key: activeUserKey, username: activeUsername || activeUserKey };
}

async function setCurrentUser(username) {
    const userKey = normalizeUsername(username);
    if (!userKey) throw new TypeError('A username is required for offline storage');

    const db = await getDB();
    await runTransaction(db, STORE_STATE, 'readwrite', transaction => {
        transaction.objectStore(STORE_STATE).put({ key: 'activeUser', offlineUser: userKey, username });
    });

    activeUserKey = userKey;
    activeUsername = username;
    await syncWorkerUserState(userKey);
    return userKey;
}

async function clearActiveUser() {
    const dbPromise = getDB();
    activeUserKey = null;
    activeUsername = null;
    let workerClearError = null;
    const earlyWorkerClear = syncWorkerUserState(null).catch(error => {
        workerClearError = error;
    });
    const db = await dbPromise;

    activeUserKey = null;
    activeUsername = null;
    await runTransaction(db, STORE_STATE, 'readwrite', transaction => {
        transaction.objectStore(STORE_STATE).delete('activeUser');
    });
    await earlyWorkerClear;
    await syncWorkerUserState(null);
    if (workerClearError) throw workerClearError;
}

function stripOfflineScope(record) {
    if (!record) return record;
    const copy = { ...record };
    delete copy.offlineUser;
    return copy;
}

async function cacheUserProfile(username, avatarUrl) {
    const userKey = normalizeUsername(username);
    if (!userKey) throw new TypeError('A username is required for offline storage');

    let localAvatarPath = null;
    let avatarDataUrl = null;

    if (isCapacitorNative() && avatarUrl && typeof avatarUrl === 'string') {
        try {
            const Filesystem = window.Capacitor.Plugins.Filesystem;
            const cleanAvatar = avatarUrl.split('?')[0];
            const avatarExt = cleanAvatar.includes('.') ? cleanAvatar.split('.').pop() : 'jpg';
            const avatarFileName = `streamify_offline_avatar_${userKey}.${avatarExt}`;
            const baseOrigin = window.API_BASE_URL || window.location.origin;
            let fullAvatarUrl = new URL(avatarUrl, baseOrigin).href;
            const sessionId = localStorage.getItem('streamify_session_id');
            if (sessionId && !fullAvatarUrl.includes('session_id=')) {
                const u = new URL(fullAvatarUrl);
                u.searchParams.set('session_id', sessionId);
                fullAvatarUrl = u.href;
            }

            const avatarRes = await Filesystem.downloadFile({
                url: fullAvatarUrl,
                path: `StreamifyDownloads/${avatarFileName}`,
                directory: 'DOCUMENTS',
                recursive: true
            });
            localAvatarPath = avatarRes.path;

            try {
                const readRes = await Filesystem.readFile({
                    path: `StreamifyDownloads/${avatarFileName}`,
                    directory: 'DOCUMENTS'
                });
                if (readRes && readRes.data) {
                    const mime = avatarExt === 'png' ? 'image/png' : 'image/jpeg';
                    avatarDataUrl = readRes.data.startsWith('data:') ? readRes.data : `data:${mime};base64,${readRes.data}`;
                }
            } catch (rErr) {}
        } catch (aErr) {
            console.warn('[Offline DB] Non-fatal native avatar caching failure:', aErr);
        }
    }

    const db = await getDB();
    await runTransaction(db, [STORE_PROFILE, STORE_STATE], 'readwrite', transaction => {
        transaction.objectStore(STORE_PROFILE).put({
            offlineUser: userKey,
            username,
            avatarUrl: avatarDataUrl || (localAvatarPath && window.Capacitor ? window.Capacitor.convertFileSrc(localAvatarPath) : avatarUrl),
            localAvatarPath
        });
        transaction.objectStore(STORE_STATE).put({ key: 'activeUser', offlineUser: userKey, username });
    });

    activeUserKey = userKey;
    activeUsername = username;
    await syncWorkerUserState(userKey);

    if (typeof caches !== 'undefined' && avatarUrl && avatarUrl.startsWith('/')) {
        // Account scoping is ready at this point. Avatar network work is useful
        // offline, but must not hold up initial routing and the library paint.
        (async () => {
            const cache = await caches.open(getMediaCacheName(userKey));
            const request = createCacheRequest(avatarUrl);
            const cached = await cache.match(request, { ignoreVary: true });
            if (!cached) await fetchAndCacheResource(cache, avatarUrl, false);
        })().catch(error => {
            console.error('[Offline DB] Failed to cache avatar:', error);
        });
    }
}

async function getCachedUserProfile() {
    const db = await getDB();
    if (activeUserKey) {
        const userKey = activeUserKey;
        const profile = await runTransaction(db, STORE_PROFILE, 'readonly', (transaction, setResult) => {
            const request = transaction.objectStore(STORE_PROFILE).get(userKey);
            request.onsuccess = () => setResult(request.result || null);
        });
        if (profile) return stripOfflineScope(profile);
    }

    // Fallback: load first available cached profile if activeUserKey is not yet set
    try {
        const allProfiles = await runTransaction(db, STORE_PROFILE, 'readonly', (transaction, setResult) => {
            const request = transaction.objectStore(STORE_PROFILE).getAll();
            request.onsuccess = () => setResult(request.result || []);
        });
        if (allProfiles && allProfiles.length > 0) {
            return stripOfflineScope(allProfiles[0]);
        }
    } catch (e) {}
    return null;
}

async function saveSongMetadata(songData, expectedUserKey = null) {
    const db = await getDB();
    const user = await requireActiveUser();
    if (expectedUserKey && user.key !== expectedUserKey) {
        throw new Error('The active user changed before the download could be committed');
    }
    const id = normalizeEntityId(songData.id);

    await runTransaction(db, STORE_SONGS, 'readwrite', transaction => {
        transaction.objectStore(STORE_SONGS).put({ ...songData, id, offlineUser: user.key });
    });
}

function enrichOfflineSongUrls(record) {
    const song = stripOfflineScope(record);
    if (song.coverDataUrl) {
        song.cover = song.coverDataUrl;
    } else if (song.localCoverPath && window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
        song.cover = window.Capacitor.convertFileSrc(song.localCoverPath);
    }
    if (song.localAudioPath && window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
        song.url = window.Capacitor.convertFileSrc(song.localAudioPath);
    }
    return song;
}

async function getOfflineSongs() {
    const db = await getDB();
    let records = [];
    if (activeUserKey) {
        const userKey = activeUserKey;
        records = await runTransaction(db, STORE_SONGS, 'readonly', (transaction, setResult) => {
            const request = transaction.objectStore(STORE_SONGS).index(USER_INDEX).getAll(userKey);
            request.onsuccess = () => setResult(request.result || []);
        });
    }

    // Fallback: return all songs in STORE_SONGS if none found for activeUserKey
    if (!records || records.length === 0) {
        try {
            records = await runTransaction(db, STORE_SONGS, 'readonly', (transaction, setResult) => {
                const request = transaction.objectStore(STORE_SONGS).getAll();
                request.onsuccess = () => setResult(request.result || []);
            });
        } catch (e) {
            records = [];
        }
    }

    return (records || []).map(enrichOfflineSongUrls);
}

async function getOfflineSong(songId) {
    const db = await getDB();
    const id = normalizeEntityId(songId);
    let found = null;
    if (activeUserKey) {
        found = await getOfflineSongForUser(db, activeUserKey, id);
    }

    // Fallback: search across all records
    if (!found) {
        try {
            const allRecords = await runTransaction(db, STORE_SONGS, 'readonly', (transaction, setResult) => {
                const request = transaction.objectStore(STORE_SONGS).getAll();
                request.onsuccess = () => setResult(request.result || []);
            });
            const match = (allRecords || []).find(r => normalizeEntityId(r.id) === id);
            if (match) found = match;
        } catch (e) {}
    }

    return found ? enrichOfflineSongUrls(found) : null;
}

async function getOfflineSongForUser(db, userKey, songId) {
    const key = [userKey, songId];

    const record = await runTransaction(db, STORE_SONGS, 'readonly', (transaction, setResult) => {
        const request = transaction.objectStore(STORE_SONGS).get(key);
        request.onsuccess = () => setResult(request.result || null);
    });
    return stripOfflineScope(record);
}

async function isSongDownloaded(songId) {
    const db = await getDB();
    if (!activeUserKey) return false;
    const key = [activeUserKey, normalizeEntityId(songId)];

    return runTransaction(db, STORE_SONGS, 'readonly', (transaction, setResult) => {
        const request = transaction.objectStore(STORE_SONGS).getKey(key);
        request.onsuccess = () => setResult(request.result !== undefined);
    });
}

function isCapacitorNative() {
    return Boolean(
        typeof window !== 'undefined' &&
        window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === 'function' &&
        window.Capacitor.isNativePlatform() &&
        window.Capacitor.Plugins &&
        window.Capacitor.Plugins.Filesystem
    );
}

function createCacheRequest(url) {
    const base = window.API_BASE_URL || window.location.origin;
    const resolved = new URL(url, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        throw new TypeError(`Unsupported offline URL protocol: ${resolved.protocol}`);
    }
    return new Request(resolved.href, { method: 'GET', credentials: 'include' });
}

async function downloadSongNative(songData, audioUrl, coverUrl, user) {
    const Filesystem = window.Capacitor.Plugins.Filesystem;
    const songId = normalizeEntityId(songData.id);
    const audioExt = (songData.extension || 'mp3').replace(/^\./, '');
    const fileName = `streamify_offline_song_${songId}.${audioExt}`;
    const baseOrigin = window.API_BASE_URL || window.location.origin;
    const sessionId = localStorage.getItem('streamify_session_id');

    let fullAudioUrl = new URL(audioUrl, baseOrigin).href;
    if (sessionId && !fullAudioUrl.includes('session_id=')) {
        const u = new URL(fullAudioUrl);
        u.searchParams.set('session_id', sessionId);
        fullAudioUrl = u.href;
    }

    console.log(`[Offline Native] Downloading audio for song ${songId} to native documents...`);
    const downloadRes = await Filesystem.downloadFile({
        url: fullAudioUrl,
        path: `StreamifyDownloads/${fileName}`,
        directory: 'DOCUMENTS',
        recursive: true
    });

    let localCoverPath = null;
    let coverDataUrl = null;
    if (coverUrl && typeof coverUrl === 'string') {
        try {
            const cleanCover = coverUrl.split('?')[0];
            const coverExt = cleanCover.includes('.') ? cleanCover.split('.').pop() : 'jpg';
            const coverFileName = `streamify_offline_cover_${songId}.${coverExt}`;
            let fullCoverUrl = new URL(coverUrl, baseOrigin).href;
            if (sessionId && !fullCoverUrl.includes('session_id=')) {
                const u = new URL(fullCoverUrl);
                u.searchParams.set('session_id', sessionId);
                fullCoverUrl = u.href;
            }

            const coverRes = await Filesystem.downloadFile({
                url: fullCoverUrl,
                path: `StreamifyDownloads/${coverFileName}`,
                directory: 'DOCUMENTS',
                recursive: true
            });
            localCoverPath = coverRes.path;

            try {
                const readRes = await Filesystem.readFile({
                    path: `StreamifyDownloads/${coverFileName}`,
                    directory: 'DOCUMENTS'
                });
                if (readRes && readRes.data) {
                    const mime = coverExt === 'png' ? 'image/png' : (coverExt === 'webp' ? 'image/webp' : 'image/jpeg');
                    coverDataUrl = readRes.data.startsWith('data:') ? readRes.data : `data:${mime};base64,${readRes.data}`;
                }
            } catch (rErr) {}
        } catch (cErr) {
            console.warn('[Offline Native] Non-fatal cover download failure:', cErr);
        }
    }

    const enrichedSongData = {
        ...songData,
        localAudioPath: downloadRes.path,
        localCoverPath: localCoverPath,
        coverDataUrl: coverDataUrl,
        cover: coverDataUrl || (localCoverPath && window.Capacitor ? window.Capacitor.convertFileSrc(localCoverPath) : songData.cover)
    };

    if (activeUserKey !== user.key) {
        throw new Error('The active user changed before the download could be committed');
    }
    await saveSongMetadata(enrichedSongData, user.key);
    window.dispatchEvent(new CustomEvent('songDownloaded', { detail: { id: songData.id } }));
    return true;
}

async function removeOfflineSong(songId) {
    const db = await getDB();
    const user = await requireActiveUser();
    const id = normalizeEntityId(songId);
    const song = await getOfflineSongForUser(db, user.key, id);

    if (isCapacitorNative() && song && song.localAudioPath) {
        try {
            const Filesystem = window.Capacitor.Plugins.Filesystem;
            const audioExt = (song.extension || 'mp3').replace(/^\./, '');
            await Filesystem.deleteFile({
                path: `StreamifyDownloads/streamify_offline_song_${id}.${audioExt}`,
                directory: 'DOCUMENTS'
            }).catch(() => null);
            if (song.localCoverPath) {
                const cleanCover = (song.cover || '').split('?')[0];
                const coverExt = cleanCover.includes('.') ? cleanCover.split('.').pop() : 'jpg';
                await Filesystem.deleteFile({
                    path: `StreamifyDownloads/streamify_offline_cover_${id}.${coverExt}`,
                    directory: 'DOCUMENTS'
                }).catch(() => null);
            }
        } catch (nativeErr) {
            console.warn('[Offline Native] Error cleaning native offline files:', nativeErr);
        }
    }

    if (typeof caches !== 'undefined') {
        const urls = new Set([`/api/stream/${encodeURIComponent(id)}`]);
        if (song && song.url) urls.add(song.url);
        if (song && song.cover && (song.cover.startsWith('/') || song.cover.startsWith('http'))) urls.add(song.cover);

        const cacheNames = [];
        const userCacheName = getMediaCacheName(user.key);
        if (await caches.has(userCacheName)) cacheNames.push(userCacheName);
        for (const cacheName of cacheNames) {
            const cache = await caches.open(cacheName);
            for (const url of urls) {
                try {
                    await cache.delete(createCacheRequest(url), { ignoreVary: true });
                } catch (delErr) {}
            }
        }
    }

    await runTransaction(db, STORE_SONGS, 'readwrite', transaction => {
        transaction.objectStore(STORE_SONGS).delete([user.key, id]);
    });
}

async function savePlaylist(playlistData, songsList) {
    const db = await getDB();
    const user = await requireActiveUser();
    const id = normalizeEntityId(playlistData.id);

    await runTransaction(db, STORE_PLAYLISTS, 'readwrite', transaction => {
        transaction.objectStore(STORE_PLAYLISTS).put({
            offlineUser: user.key,
            id,
            playlist: playlistData,
            songs: songsList
        });
    });
}

async function getOfflinePlaylist(playlistId) {
    const db = await getDB();
    if (!activeUserKey) return null;
    const key = [activeUserKey, normalizeEntityId(playlistId)];

    const record = await runTransaction(db, STORE_PLAYLISTS, 'readonly', (transaction, setResult) => {
        const request = transaction.objectStore(STORE_PLAYLISTS).get(key);
        request.onsuccess = () => setResult(request.result || null);
    });
    return stripOfflineScope(record);
}

class InsecureContextError extends Error {
    constructor() {
        super(
            'Offline downloads require a secure connection (HTTPS). ' +
            'This page is served over plain HTTP, so your browser will not ' +
            'allow songs to be stored for offline playback.'
        );
        this.name = 'InsecureContextError';
        this.isInsecureContext = true;
    }
}

async function fetchAndCacheResource(cache, url, requireByteLength) {
    const cacheRequest = createCacheRequest(url);
    const networkUrl = new URL(cacheRequest.url);
    networkUrl.searchParams.set('_streamify_offline', `${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const response = await fetch(new Request(networkUrl.href, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
    }));
    if ((response.status !== 200 && response.status !== 206) || !response.body) {
        throw new Error(`Could not download ${networkUrl.pathname} (HTTP ${response.status})`);
    }

    const headers = new Headers(response.headers);
    if (headers.has('Content-Encoding')) {
        headers.delete('Content-Encoding');
        headers.delete('Content-Length');
    }

    let responseBlob = null;
    let contentLength = Number(headers.get('Content-Length'));
    if (requireByteLength) {
        if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
            // Read blob to determine exact full size if Content-Length header is omitted by proxy/compression
            responseBlob = await response.blob();
            contentLength = responseBlob.size;
        }
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Length', String(contentLength));
    }

    const bodyToCache = responseBlob || response.body;
    await cache.put(cacheRequest, new Response(bodyToCache, {
        status: 200,
        statusText: 'OK',
        headers
    }));
    return cacheRequest;
}

function describeDownloadError(error) {
    if (error && error.name === 'QuotaExceededError') {
        return 'Not enough device storage is available for this download.';
    }
    if (error && (error.name === 'AbortError' || error.name === 'TransactionInactiveError')) {
        return 'The offline storage transaction could not be committed.';
    }
    return error && error.message ? error.message : 'The download could not be stored.';
}

async function downloadSong(songId) {
    const isNative = isCapacitorNative();
    if (!isNative && (typeof caches === 'undefined' || (window.StreamifyEnv && !window.StreamifyEnv.canDownloadOffline))) {
        const error = new InsecureContextError();
        if (typeof showToast === 'function') showToast(error.message, 'error', 6000);
        throw error;
    }

    try {
        const user = await requireActiveUser();
        const base = (window.API_BASE_URL || '').replace(/\/+$/, '');
        const response = await fetch(`${base}/api/play/${encodeURIComponent(songId)}`, {
            credentials: 'include',
            cache: 'no-store'
        });
        if (!response.ok) throw new Error(`Failed to fetch song details (HTTP ${response.status})`);
        const songData = await response.json();

        if (isNative) {
            return await downloadSongNative(songData, songData.url, songData.cover, user);
        } else {
            return await fallbackDownload(songData, songData.url, songData.cover, user);
        }
    } catch (error) {
        console.error('[Offline DB] Download error:', error);
        if (typeof showToast === 'function') {
            showToast(describeDownloadError(error), 'error', 6000);
        }
        throw error;
    }
}

async function fallbackDownload(songData, audioUrl, coverUrl, user) {
    console.log(`[Offline DB] Download starting for ${songData.id}`);
    const cache = await caches.open(getMediaCacheName(user.key));
    const cleanupRequests = [];

    try {
        cleanupRequests.push(createCacheRequest(audioUrl));
        await fetchAndCacheResource(cache, audioUrl, true);

        if (coverUrl && typeof coverUrl === 'string' && (coverUrl.startsWith('/') || coverUrl.startsWith('http'))) {
            try {
                cleanupRequests.push(createCacheRequest(coverUrl));
                await fetchAndCacheResource(cache, coverUrl, false);
            } catch (coverErr) {
                console.warn('[Offline DB] Non-fatal cover art caching failure:', coverErr);
            }
        }

        if (activeUserKey !== user.key) {
            throw new Error('The active user changed before the download could be committed');
        }
        await saveSongMetadata(songData, user.key);
    } catch (error) {
        for (const request of cleanupRequests) {
            try {
                await cache.delete(request, { ignoreVary: true });
            } catch (cleanupError) {
                console.error('[Offline DB] Failed to roll back cached media:', cleanupError);
            }
        }
        throw error;
    }

    window.dispatchEvent(new CustomEvent('songDownloaded', { detail: { id: songData.id } }));
    return true;
}

initOfflineDB().catch(error => {
    console.error('[Offline DB] Initialization failed:', error);
});

window.OfflineStore = {
    downloadSong,
    getOfflineSongs,
    getOfflineSong,
    isSongDownloaded,
    removeOfflineSong,
    cacheUserProfile,
    getCachedUserProfile,
    savePlaylist,
    getOfflinePlaylist,
    setCurrentUser,
    clearActiveUser,
    isSupported: () => {
        if (isCapacitorNative()) return true;
        return typeof caches !== 'undefined'
            && (!window.StreamifyEnv || window.StreamifyEnv.canDownloadOffline);
    },
    InsecureContextError
};

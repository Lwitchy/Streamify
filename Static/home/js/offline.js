/**
 * ============================================================================
 * STREAMIFY — offline.js
 * ============================================================================
 * Manages Offline Storage via IndexedDB and CacheStorage
 * ============================================================================
 */

const DB_NAME = 'StreamifyOffline';
const DB_VERSION = 6;
const STORE_SONGS = 'songs';
const STORE_PROFILE = 'profile';
const STORE_PLAYLISTS = 'playlists';

let offlineDB = null;

// Initialize IndexedDB
function initOfflineDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION); // Use DB_VERSION variable

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_SONGS)) {
                db.createObjectStore(STORE_SONGS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_PROFILE)) {
                db.createObjectStore(STORE_PROFILE, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
                db.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
            }
        };

        request.onsuccess = (event) => {
            offlineDB = event.target.result;
            resolve(offlineDB);
        };

        request.onerror = (event) => {
            console.error('[Offline DB] Error initializing DB:', event.target.error);
            reject(event.target.error);
        };
    });
}

// Ensure DB is initialized
async function getDB() {
    if (!offlineDB) {
        await initOfflineDB();
    }
    return offlineDB;
}

// ---------------------------
// PROFILE CACHING
// ---------------------------
async function cacheUserProfile(username, avatarUrl) {
    const db = await getDB();
    const tx = db.transaction(STORE_PROFILE, 'readwrite');
    const store = tx.objectStore(STORE_PROFILE);
    store.put({ key: 'currentUser', username, avatarUrl });

    // Also cache the avatar image via Background Fetch or simple fetch
    if (avatarUrl && avatarUrl.startsWith('/')) {
        try {
            const cache = await caches.open('streamify-app-shell-v1');
            await cache.add(avatarUrl);
        } catch (e) {
            console.error('[Offline DB] Failed to cache avatar:', e);
        }
    }
}

async function getCachedUserProfile() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_PROFILE, 'readonly');
        const store = tx.objectStore(STORE_PROFILE);
        const req = store.get('currentUser');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ---------------------------
// SONG CACHING
// ---------------------------
async function saveSongMetadata(songData) {
    const db = await getDB();
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SONGS);
    store.put(songData);
}

async function getOfflineSongs() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_SONGS, 'readonly');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function isSongDownloaded(songId) {
    const db = await getDB();
    const id = isNaN(songId) ? songId : Number(songId);
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_SONGS, 'readonly');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.get(id);
        req.onsuccess = () => resolve(!!req.result);
        req.onerror = () => resolve(false);
    });
}

async function removeOfflineSong(songId) {
    const db = await getDB();
    const id = isNaN(songId) ? songId : Number(songId);

    // Get the song first to find its URL to remove from CacheStorage
    const songReq = new Promise((resolve) => {
        const tx = db.transaction(STORE_SONGS, 'readonly');
        const store = tx.objectStore(STORE_SONGS);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });

    const song = await songReq;

    // 1. Remove metadata
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SONGS);
    store.delete(id);

    // 2. Remove audio/cover from cache
    if (song) {
        try {
            const cache = await caches.open('streamify-media-cache');
            const keys = await cache.keys();
            for (const req of keys) {
                const url = new URL(req.url);
                if (url.pathname === decodeURIComponent(song.url) || url.pathname === decodeURIComponent(song.cover)) {
                    await cache.delete(req);
                }
            }
            // Also notify the server to delete the downloaded record if needed? 
            // The user said: "no user can't delete the song if it's offline (because file has to be removed from the server too)"
            // Actually, the user means deleting their UPLOADED song? 
            // Wait, "a way to delete downloaded songs (via clicking the same download button again?)"
            // "also no user can't delete the song if it's offline (because file has to be removed from the server too)"
            // Oh, the user is talking about deleting the song from the SERVER (the trash can icon).
            // Wait, the user meant "the user can't delete the song if it's offline". So my previous code disabled the "Edit mode" / "Manage library" button, which solves that!
        } catch (e) {
            console.error('[Offline DB] Error removing cached media files', e);
        }
    }
}

// ---------------------------
// PLAYLIST CACHING
// ---------------------------
async function savePlaylist(playlistData, songsList) {
    const db = await getDB();
    const tx = db.transaction(STORE_PLAYLISTS, 'readwrite');
    const store = tx.objectStore(STORE_PLAYLISTS);
    store.put({ id: playlistData.id, playlist: playlistData, songs: songsList });
}

async function getOfflinePlaylist(playlistId) {
    const db = await getDB();
    const id = isNaN(playlistId) ? playlistId : Number(playlistId);
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_PLAYLISTS, 'readonly');
        const store = tx.objectStore(STORE_PLAYLISTS);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

// ---------------------------
// DOWNLOAD LOGIC
// ---------------------------
async function downloadSong(songId) {
    try {
        // 1. Fetch metadata from API
        const response = await fetch(`/api/play/${songId}`);
        if (!response.ok) throw new Error('Failed to fetch song details');
        const songData = await response.json();

        const audioUrl = songData.url;
        const coverUrl = songData.cover;

        // Use standard cache API for reliable UI syncing and cross-browser support
        return await fallbackDownload(songData, audioUrl, coverUrl);
    } catch (e) {
        console.error('[Offline DB] Download error:', e);
        throw e;
    }
}

async function fallbackDownload(songData, audioUrl, coverUrl) {
    console.log(`[Offline DB] Fallback download starting for ${songData.id}`);
    const cache = await caches.open('streamify-media-cache');

    // Fetch manually to ensure we bypass HTTP cache partial content issues 
    // and wait for the full file to download before saving it.
    const fetchAndCache = async (url) => {
        // Append a cache-busting query parameter to force a full 200 OK network fetch 
        const cacheBusterUrl = url.includes('?') ? `${url}&_t=${Date.now()}` : `${url}?_t=${Date.now()}`;
        const res = await fetch(cacheBusterUrl);

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        // Ensure we explicitly convert the response to an ArrayBuffer/Blob and recreate the response
        // so it has zero ties to the 'opaque' fetch that might cause cache.put matching issues later.
        const blob = await res.blob();
        const headers = new Headers(res.headers);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Length', blob.size);

        const cleanResponse = new Response(blob, {
            status: 200,
            statusText: 'OK',
            headers: headers
        });

        // Store under the EXACT original URL as a string, not a Request object.
        await cache.put(url, cleanResponse);
    };

    await fetchAndCache(audioUrl);
    if (coverUrl && coverUrl.startsWith('/')) {
        await fetchAndCache(coverUrl);
    }

    await saveSongMetadata(songData);

    // Notify UI manually since SW won't fire backgroundfetchsuccess
    window.dispatchEvent(new CustomEvent('songDownloaded', { detail: { id: songData.id } }));
    return true;
}

// Init on load
initOfflineDB();

window.OfflineStore = {
    downloadSong,
    getOfflineSongs,
    isSongDownloaded,
    removeOfflineSong,
    cacheUserProfile,
    getCachedUserProfile,
    savePlaylist,
    getOfflinePlaylist
};

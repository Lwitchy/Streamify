/**
 * ============================================================================
 * STREAMIFY - player.js
 * ============================================================================
 * Audio engine: playback, seek, volume, shuffle, repeat, MediaSession.
 * Depends on: config.js (globals)
 * ============================================================================
 */

/* --- DOM references --- */
const audio = document.getElementById('audio-player');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const playerImg = document.getElementById('player-img');
const btnPlay = document.getElementById('btn-play');
const btnNext = document.getElementById('btn-next');
const btnPrev = document.getElementById('btn-prev');
const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat = document.getElementById('btn-repeat');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.querySelector('.progress-bar-wrapper');
const currTimeEl = document.getElementById('current-time');
const durTimeEl = document.getElementById('duration');
const volSlider = document.getElementById('volume-slider');
const volIcon = document.getElementById('vol-icon');

/* Dedicated Player DOM references */
const playerSection = document.getElementById('player-section');
const dedicatedBackdrop = document.getElementById('dedicated-player-backdrop');
const dedicatedImg = document.getElementById('dedicated-player-img');
const dedicatedTitle = document.getElementById('dedicated-player-title');
const dedicatedArtist = document.getElementById('dedicated-player-artist');
const dedicatedBtnPlay = document.getElementById('dedicated-btn-play');
const dedicatedBtnNext = document.getElementById('dedicated-btn-next');
const dedicatedBtnPrev = document.getElementById('dedicated-btn-prev');
const dedicatedBtnShuffle = document.getElementById('dedicated-btn-shuffle');
const dedicatedBtnRepeat = document.getElementById('dedicated-btn-repeat');
const dedicatedProgressBar = document.getElementById('dedicated-progress-bar');
const dedicatedProgressContainer = document.getElementById('dedicated-progress-container');
const dedicatedCurrTimeEl = document.getElementById('dedicated-current-time');
const dedicatedDurTimeEl = document.getElementById('dedicated-duration');
const dedicatedVolSlider = document.getElementById('dedicated-volume-slider');
const dedicatedVolIcon = document.getElementById('dedicated-vol-icon');
const btnLyrics = document.getElementById('dedicated-btn-lyrics');
const btnFindLyrics = document.getElementById('dedicated-btn-find-lyrics');
const lyricsScrollArea = document.getElementById('lyrics-scroll-area');
const lyricsContent = document.getElementById('lyrics-content');

// Lyrics lookup, picker and editor live in lyrics.js (loaded right after this file).
let isLyricEditMode = false;
let tempLyricsData = [];

/* Set gradient placeholder until a song is playing */
if (playerImg) playerImg.src = COVER_PLACEHOLDER;
if (dedicatedImg) dedicatedImg.src = COVER_PLACEHOLDER;

/* --- Seek guard --- */
let canSeek = false;
let lastWidgetUpdateTime = 0;

// Listening history (telemetry v2, see telemetry.js).
// telemetrySongId is also used to find the offline copy when streaming fails.
let telemetrySongId = null;
let lastTimeUpdateValue = 0;
// Why the playback in progress is about to be replaced: next | previous |
// selected | error. Consumed by loadSong() when the next track starts.
let pendingPlaybackEndReason = null;

function listening() {
    return window.StreamifyListening || null;
}

function setPendingPlaybackEndReason(reason) {
    pendingPlaybackEndReason = reason;
}

/* ========== MARQUEE LOGIC ========== */
let marqueeMeasureFrame = null;
let desktopArtworkPrimeToken = 0;

function updateMarquees(...elements) {
    const targets = elements.filter(Boolean);
    if (targets.length === 0) return;

    targets.forEach(element => {
        element.classList.remove('scroll-marquee');
        element.style.transform = 'translateX(0)';
        element.style.removeProperty('--scroll-dist');
    });

    if (marqueeMeasureFrame !== null) cancelAnimationFrame(marqueeMeasureFrame);
    marqueeMeasureFrame = requestAnimationFrame(() => {
        marqueeMeasureFrame = null;

        // Read every width first, then write every class. This produces one
        // layout pass instead of two delayed read/write cycles during entry.
        const measurements = targets.map(element => {
            const parent = element.parentElement;
            if (!parent || element.scrollWidth <= parent.clientWidth) return null;
            return {
                element,
                distance: parent.clientWidth - element.scrollWidth - 10
            };
        }).filter(Boolean);

        measurements.forEach(({ element, distance }) => {
            element.style.setProperty('--scroll-dist', `${distance}px`);
            element.classList.add('scroll-marquee');
        });
    });
}

function scheduleDesktopArtworkPrime() {
    const token = ++desktopArtworkPrimeToken;
    const prime = () => {
        if (
            token !== desktopArtworkPrimeToken ||
            !isDesktopPlayerOverlayEnabled() ||
            document.body.classList.contains('player-section-active')
        ) return;

        playerSection.classList.add('player-overlay-prime');
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (token === desktopArtworkPrimeToken) {
                playerSection.classList.remove('player-overlay-prime');
            }
        }));
    };

    if ('requestIdleCallback' in window) requestIdleCallback(prime, { timeout: 900 });
    else setTimeout(prime, 120);
}

/* ========== CORE PLAYBACK ========== */


function getQualityBadgeHTML(song) {
    if (!song) return '';
    let bitrate = Number(song.bitrate);
    if (!Number.isFinite(bitrate) || bitrate <= 0) bitrate = 0;
    if (bitrate && bitrate > 1000) {
        bitrate = Math.round(bitrate / 1000);
    }
    let extension = typeof song.extension === 'string' ? song.extension : '';
    
    if (!bitrate && !extension.toLowerCase().includes('flac')) {
        bitrate = 128; 
    }
    
    const isFlac = (extension && extension.toLowerCase().includes('flac'));
    const label = isFlac ? 'FLAC' : `${bitrate}kbps`;
    
    return `<span class="artist-separator"></span><span class="quality-badge">${label}</span>`;
}

/* Now-playing title opens the album, artist opens the artist page. */
const TRACK_LINK_UID = /^[a-f0-9]{20}$/;

function setTrackLink(element, kind, uid) {
    if (!element) return;
    const valid = typeof uid === 'string' && TRACK_LINK_UID.test(uid);
    element.classList.toggle('is-link', valid);
    if (valid) {
        element.dataset.linkKind = kind;
        element.dataset.linkUid = uid;
        element.setAttribute('role', 'link');
        element.tabIndex = 0;
        element.title = kind === 'album' ? 'Go to album' : 'Go to artist';
    } else {
        delete element.dataset.linkKind;
        delete element.dataset.linkUid;
        element.removeAttribute('role');
        element.removeAttribute('tabindex');
        element.removeAttribute('title');
    }
}

function followTrackLink(event) {
    const element = event.currentTarget;
    const uid = element.dataset.linkUid;
    if (!uid) return;
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    if (element.dataset.linkKind === 'album' && typeof window.navigateToAlbum === 'function') {
        window.navigateToAlbum(uid);
    } else if (element.dataset.linkKind === 'artist' && typeof window.navigateToArtist === 'function') {
        window.navigateToArtist(uid);
    }
}

[playerTitle, playerArtist, dedicatedTitle, dedicatedArtist].forEach(element => {
    if (!element) return;
    element.addEventListener('click', followTrackLink);
    element.addEventListener('keydown', followTrackLink);
});

function loadSong(song) {
    const endReason = pendingPlaybackEndReason || 'selected';
    pendingPlaybackEndReason = null;
    if (listening()) listening().start(song.id, activePlaybackContext, endReason);
    telemetrySongId = song.id;
    lastTimeUpdateValue = 0;

    playerTitle.textContent = song.title;
    playerArtist.textContent = song.artist; // No badge in mini player
    setTrackLink(playerTitle, 'album', song.album_uid);
    setTrackLink(playerArtist, 'artist', song.artist_uid);
    setTrackLink(dedicatedTitle, 'album', song.album_uid);
    setTrackLink(dedicatedArtist, 'artist', song.artist_uid);

    let audioUrl = song.url;
    let coverUrl = song.coverDataUrl || safeImageURL(song.cover, COVER_PLACEHOLDER);

    if (song.localAudioPath && window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
        audioUrl = window.Capacitor.convertFileSrc(song.localAudioPath);
    } else if (audioUrl && audioUrl.startsWith('/') && window.API_BASE_URL) {
        audioUrl = window.API_BASE_URL.replace(/\/+$/, '') + audioUrl;
    }

    if (song.coverDataUrl) {
        coverUrl = song.coverDataUrl;
    } else if (song.localCoverPath && window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
        coverUrl = window.Capacitor.convertFileSrc(song.localCoverPath);
    } else if (coverUrl && coverUrl.startsWith('/') && window.API_BASE_URL) {
        coverUrl = window.API_BASE_URL.replace(/\/+$/, '') + coverUrl;
    }

    playerImg.src = coverUrl;
    audio.src = audioUrl;

    // Sync Dedicated Player
    if (dedicatedTitle) {
        dedicatedTitle.textContent = song.title;
    }
    if (dedicatedArtist) {
        dedicatedArtist.innerHTML = `${escapeHTML(song.artist)}${getQualityBadgeHTML(song)}`;
    }
    if (document.body.classList.contains('player-section-active')) {
        updateMarquees(dedicatedTitle, dedicatedArtist);
    }
    if (dedicatedImg) {
        dedicatedImg.src = coverUrl;
        if (typeof dedicatedImg.decode === 'function') {
            dedicatedImg.decode().catch(() => undefined).finally(scheduleDesktopArtworkPrime);
        } else {
            scheduleDesktopArtworkPrime();
        }
    }
    document.documentElement.style.setProperty('--player-backdrop-image', `url(${JSON.stringify(coverUrl)})`);
    syncThemeColorToCover(coverUrl);

    // Trigger animation for dedicated player if active
    if (document.body.classList.contains('player-section-active')) {
        const animTargets = [
            document.querySelector('.dedicated-art-wrapper'),
            document.querySelector('.dedicated-info-container'),
            document.getElementById('dedicated-lyrics-container')
        ];
        const targets = animTargets.filter(Boolean);
        targets.forEach(el => el.classList.remove('song-change-fade-in'));
        if (targets.length > 0) void targets[0].offsetWidth;
        targets.forEach(el => el.classList.add('song-change-fade-in'));
    }

    // Track the currently playing song ID for cross-tab highlighting
    window.currentlyPlayingSongId = song.id || null;
    window.dispatchEvent(new CustomEvent('streamifytrackchange', { detail: { songId: window.currentlyPlayingSongId } }));

    // Start the authenticated media request before secondary lyric work.
    try { audio.load(); } catch (e) { /* ignore */ }
    canSeek = false;

    resetLyrics();
    setCurrentLyricsTrack(song);
    fetchLyrics(song.title, song.artist, song.id, song.playlistOwner);

    progressBar.style.width = '0%';
    currTimeEl.textContent = '0:00';
    if (dedicatedProgressBar) dedicatedProgressBar.style.width = '0%';
    if (dedicatedCurrTimeEl) dedicatedCurrTimeEl.textContent = '0:00';

    /* Mark the new song in every list that shows it. */
    syncNowPlayingRows();

    /* OS / lock-screen media session: update metadata only */
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title,
            artist: song.artist,
            album: song.album || 'Streamify',
            artwork: [96, 128, 192, 256, 384, 512].map(s => ({
                src: coverUrl, sizes: `${s}x${s}`, type: 'image/jpeg'
            }))
        });
    }

    /* Update iOS Widget */
    if (typeof updateWidgetNowPlaying === 'function') {
        updateWidgetNowPlaying(song.title, song.artist, coverUrl, false, 0);
    }

    /* Discord Rich Presence (desktop app only; a no-op everywhere else).
       Only the metadata is handed over here — playback has not started yet, so
       the card is published by syncPlaybackUI once the 'play' event lands. */
    if (window.StreamifyDiscord) {
        window.StreamifyDiscord.trackChanged(song);
    }
}

/* Play and pause icons both live in the button; switching cross-fades and
 * turns one into the other while the button gives a small swell, instead of
 * swapping the icon's HTML. */
function setPlayPauseIcon(button, playing, playOffset) {
    if (!button) return;
    if (!button.querySelector('.pp-icon')) {
        button.innerHTML =
            `<span class="pp-icon pp-play" aria-hidden="true"><i class='bx bx-play' style='margin-left:${playOffset}px;'></i></span>` +
            "<span class=\"pp-icon pp-pause\" aria-hidden=\"true\"><i class='bx bx-pause'></i></span>";
        button.dataset.state = playing ? 'playing' : 'paused';
        return;
    }
    const next = playing ? 'playing' : 'paused';
    if (button.dataset.state === next) return;
    button.dataset.state = next;
    button.classList.remove('pp-swell');
    void button.offsetWidth; // restart the swell
    button.classList.add('pp-swell');
}

setPlayPauseIcon(btnPlay, false, 2);
setPlayPauseIcon(dedicatedBtnPlay, false, 4);

function syncPlaybackUI(playing) {
    isPlaying = playing;
    const playbackLabel = playing ? 'Pause' : 'Play';
    setPlayPauseIcon(btnPlay, playing, 2);
    btnPlay.setAttribute('aria-label', playbackLabel);
    if (dedicatedBtnPlay) {
        setPlayPauseIcon(dedicatedBtnPlay, playing, 4);
        dedicatedBtnPlay.setAttribute('aria-label', playbackLabel);
    }

    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';

    if (typeof updateWidgetNowPlaying === 'function') {
        updateWidgetNowPlaying(playerTitle.textContent, playerArtist.textContent, playerImg.src, playing, audio.currentTime);
    }

    /* Discord Rich Presence. This is the only place playback start/stop is
       reported, so pausing clears the card from here too. The duration is
       passed because it is not known until 'loadedmetadata', which fires
       after loadSong. */
    if (window.StreamifyDiscord) {
        window.StreamifyDiscord.playbackChanged(playing, audio.currentTime, audio.duration);
    }
}

function playSong() {
    if (!audio.currentSrc && !audio.src) return Promise.resolve(false);
    return audio.play()
        .then(() => true)
        .catch(err => {
            syncPlaybackUI(false);
            console.warn('[PLAYBACK] Play request rejected:', err);
            showToast('Playback could not start.', 'error');
            return false;
        });
}

function pauseSong() {
    audio.pause();
}

function togglePlay() {
    if (isPlaying) pauseSong(); else playSong();
}

/* Register MediaSession action handlers ONCE at startup; re-registering on every track
   change causes iOS/Android to briefly tear down the Dynamic Island / lock screen widget. */
(function initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => playSong());
    navigator.mediaSession.setActionHandler('pause', () => pauseSong());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevSong());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextSong());
    try {
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (canSeek && details.seekTime !== undefined) {
                audio.currentTime = details.seekTime;
            }
        });
    } catch (e) { /* seekto not supported on all platforms */ }
}());

/* ========== PLAYLIST NAVIGATION ========== */

let _songSelectionSeq = 0;
let _songSelectionAbort = null;

/**
 * Internal: plays a song at `index` from the given `pl` playlist and `sh` shuffle order.
 * All autoplay (next/prev) routes through here using the activePlaylist snapshot.
 */
function _playSongFromPlaylist(index, pl, sh) {
    if (index < 0 || index >= pl.length) return;

    const selectionSeq = ++_songSelectionSeq;
    if (_songSelectionAbort) _songSelectionAbort.abort();
    const controller = new AbortController();
    _songSelectionAbort = controller;

    if (isShuffle) {
        const shufflePos = sh.indexOf(index);
        currentIndex = shufflePos !== -1 ? shufflePos : 0;
    } else {
        currentIndex = index;
    }

    const song = pl[index];

    const loadAndPlay = (songData) => {
        if (selectionSeq !== _songSelectionSeq || controller.signal.aborted) return;
        const responseCover = safeImageURL(songData.cover);
        if (responseCover) song.cover = responseCover;
        const cover = safeImageURL(song.cover, COVER_PLACEHOLDER);
        loadSong({
            id: song.id,
            title: song.title,
            artist: song.artist,
            album: song.album,
            album_uid: song.album_uid || songData.album_uid || null,
            artist_uid: song.artist_uid || songData.artist_uid || null,
            url: songData.url,
            cover: cover,
            bitrate: songData.bitrate || song.bitrate,
            extension: songData.extension || song.extension,
            playlistOwner: song.playlistOwner
        });
        playSong();

    };

    if (song.localAudioPath) {
        loadAndPlay(song);
        return;
    }

    if ((!navigator.onLine || window.StreamifyOfflineMode || (window.StreamifyNetwork && !window.StreamifyNetwork.isServerReachable)) && window.OfflineStore) {
        window.OfflineStore.getOfflineSong(song.id).then(cachedSong => {
            if (selectionSeq !== _songSelectionSeq || controller.signal.aborted) return;
            if (cachedSong) {
                loadAndPlay(cachedSong);
            } else {
                showToast("Song not available offline", "error");
            }
        }).catch(err => {
            if (selectionSeq !== _songSelectionSeq || controller.signal.aborted) return;
            console.error('[OFFLINE PLAYBACK]', err);
            showToast("Song not available offline", "error");
        });
        return;
    }

    // Every visible list result already contains the metadata needed by the
    // player, and /api/stream performs the same authentication/access checks.
    // Starting it directly removes an otherwise redundant metadata round trip.
    if (song.id !== undefined && song.id !== null && song.id !== '') {
        const base = (window.API_BASE_URL || '').replace(/\/+$/, '');
        const sessionId = localStorage.getItem('streamify_session_id');
        const streamUrl = sessionId
            ? `${base}/api/stream/${encodeURIComponent(song.id)}?session_id=${encodeURIComponent(sessionId)}`
            : `${base}/api/stream/${encodeURIComponent(song.id)}`;
        loadAndPlay({
            url: streamUrl,
            cover: song.cover,
            bitrate: song.bitrate,
            extension: song.extension
        });
        return;
    }

    fetch(song.url, { signal: controller.signal })
        .then(r => {
            if (!r.ok) throw new Error(`Song request failed: ${r.status}`);
            return r.json();
        })
        .then(loadAndPlay)
        .catch(err => {
            if (err.name === 'AbortError') return;
            console.error(err);
            if (!navigator.onLine) showToast("Song not available offline", "error");
        });
}

/**
 * Public: called when the user clicks a song row.
 * Snapshots the current view playlist so autoplay (next/prev) stays within this context.
 */
function playSongAtIndex(index) {
    if (index < 0 || index >= currentPlaylist.length) return;
    // Freeze the current view as the active playback context
    setPendingPlaybackEndReason('selected');
    activePlaybackContext = { ...currentPlaybackContext };
    activePlaylist = [...currentPlaylist];
    activeShuffledPlaylist = [...shuffledPlaylist];
    _playSongFromPlaylist(index, activePlaylist, activeShuffledPlaylist);
}

/* The "now playing" row is matched by song id, in every list on the page
 * (Library, playlists, albums, Liked Songs...), and stays marked while paused.
 * It used to be picked by position in whichever section was visible, which
 * marked nothing (or the wrong row) when the song was started from another
 * list, and lists rebuilt while paused lost the mark. */
function syncNowPlayingRows(root = document) {
    const id = window.currentlyPlayingSongId;
    const key = id === undefined || id === null || id === '' ? null : String(id);
    root.querySelectorAll('.song-row.playing').forEach(row => {
        if (key === null || row.dataset.id !== key) row.classList.remove('playing');
    });
    if (key === null) return;
    const selector = `.song-row[data-id="${window.CSS && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')}"]`;
    root.querySelectorAll(selector).forEach(row => {
        if (!row.classList.contains('header-row')) row.classList.add('playing');
    });
}
window.syncNowPlayingRows = syncNowPlayingRows;

function syncPausedClass() {
    document.body.classList.toggle('audio-paused', audio.paused);
}
['play', 'playing', 'pause', 'ended', 'emptied'].forEach(type => audio.addEventListener(type, syncPausedClass));

function getCurrentRealIndex() {
    return isShuffle ? activeShuffledPlaylist[currentIndex] : currentIndex;
}

function nextSong() {
    if (activePlaylist.length === 0) return false;

    if (isShuffle) {
        if (currentIndex >= activeShuffledPlaylist.length - 1) {
            if (repeatMode === 1) currentIndex = 0;
            else return false;
        } else { currentIndex++; }
    } else {
        if (currentIndex >= activePlaylist.length - 1) {
            if (repeatMode === 1) currentIndex = 0;
            else return false;
        } else { currentIndex++; }
    }
    setPendingPlaybackEndReason('next');
    _playSongFromPlaylist(getCurrentRealIndex(), activePlaylist, activeShuffledPlaylist);
    return true;
}

function prevSong() {
    if (activePlaylist.length === 0) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    setPendingPlaybackEndReason('previous');

    if (currentIndex > 0) {
        currentIndex--;
    } else {
        if (repeatMode === 1)
            currentIndex = isShuffle ? activeShuffledPlaylist.length - 1 : activePlaylist.length - 1;
        else
            currentIndex = 0;
    }
    _playSongFromPlaylist(getCurrentRealIndex(), activePlaylist, activeShuffledPlaylist);
}

/* ========== SHUFFLE / REPEAT ========== */

function toggleShuffle() {
    const realIndex = currentIndex >= 0 ? getCurrentRealIndex() : -1;
    isShuffle = !isShuffle;
    btnShuffle.style.color = isShuffle ? 'var(--accent)' : '#b3b3b3';
    btnShuffle.classList.toggle('active', isShuffle);
    btnShuffle.setAttribute('aria-pressed', String(isShuffle));

    shuffledPlaylist = [...Array(currentPlaylist.length).keys()];
    activeShuffledPlaylist = [...Array(activePlaylist.length).keys()];

    if (isShuffle) {
        for (let i = shuffledPlaylist.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledPlaylist[i], shuffledPlaylist[j]] = [shuffledPlaylist[j], shuffledPlaylist[i]];
        }
        // Also shuffle the active playlist order
        for (let i = activeShuffledPlaylist.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [activeShuffledPlaylist[i], activeShuffledPlaylist[j]] = [activeShuffledPlaylist[j], activeShuffledPlaylist[i]];
        }
        if (realIndex >= 0) {
            const shuffledPosition = activeShuffledPlaylist.indexOf(realIndex);
            if (shuffledPosition > 0) {
                activeShuffledPlaylist.splice(shuffledPosition, 1);
                activeShuffledPlaylist.unshift(realIndex);
            }
            currentIndex = 0;
        }
    } else {
        if (realIndex >= 0 && activePlaylist.length > 0) currentIndex = realIndex;
    }

    // Sync Dedicated Shuffle button style
    if (dedicatedBtnShuffle) {
        dedicatedBtnShuffle.setAttribute('aria-pressed', String(isShuffle));
        if (isShuffle) {
            dedicatedBtnShuffle.style.color = 'var(--accent)';
            dedicatedBtnShuffle.classList.add('active');
        } else {
            dedicatedBtnShuffle.style.color = 'rgba(255,255,255,0.8)';
            dedicatedBtnShuffle.classList.remove('active');
        }
    }
}

function toggleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const repeatLabel = repeatMode === 0 ? 'Repeat off' : (repeatMode === 1 ? 'Repeat all' : 'Repeat one');
    btnRepeat.setAttribute('aria-label', repeatLabel);
    btnRepeat.setAttribute('aria-pressed', String(repeatMode !== 0));
    if (dedicatedBtnRepeat) {
        dedicatedBtnRepeat.setAttribute('aria-label', repeatLabel);
        dedicatedBtnRepeat.setAttribute('aria-pressed', String(repeatMode !== 0));
    }
    if (repeatMode === 0) {
        btnRepeat.style.color = '#b3b3b3';
        btnRepeat.innerHTML = "<i class='bx bx-repeat'></i>";
        btnRepeat.title = '';
        if (dedicatedBtnRepeat) {
            dedicatedBtnRepeat.style.color = 'rgba(255,255,255,0.8)';
            dedicatedBtnRepeat.innerHTML = "<i class='bx bx-repeat'></i>";
        }
    } else if (repeatMode === 1) {
        btnRepeat.style.color = 'var(--accent)';
        btnRepeat.innerHTML = "<i class='bx bx-repeat'></i>";
        if (dedicatedBtnRepeat) {
            dedicatedBtnRepeat.style.color = 'var(--accent)';
            dedicatedBtnRepeat.innerHTML = "<i class='bx bx-repeat'></i>";
        }
    } else {
        btnRepeat.style.color = 'var(--accent)';
        btnRepeat.innerHTML = "<i class='bx bx-analyse'></i>";
        btnRepeat.title = 'Repeat One';
        if (dedicatedBtnRepeat) {
            dedicatedBtnRepeat.style.color = 'var(--accent)';
            dedicatedBtnRepeat.innerHTML = "<i class='bx bx-analyse'></i>";
        }
    }
}

/* ========== CONTROL BINDINGS ========== */

btnPlay.addEventListener('click', togglePlay);
btnNext.addEventListener('click', nextSong);
btnPrev.addEventListener('click', prevSong);
btnShuffle.addEventListener('click', toggleShuffle);
btnRepeat.addEventListener('click', toggleRepeat);

/* ========== AUDIO EVENTS ========== */

audio.addEventListener('ended', () => {
    if (repeatMode === 2) {
        // Each loop of repeat-one is its own playback in the history.
        if (listening()) listening().restart('completed');
        lastTimeUpdateValue = 0;
        audio.currentTime = 0;
        playSong();
    } else {
        if (listening()) listening().end('completed');
        if (!nextSong()) syncPlaybackUI(false);
    }
});

audio.addEventListener('play', () => {
    syncPlaybackUI(true);
    startDesktopLyricsSync();
});
audio.addEventListener('pause', () => {
    syncPlaybackUI(false);
    stopDesktopLyricsSync();
});
function failCurrentPlayback() {
    if (listening()) listening().end('error');
    if (audio.currentSrc || audio.src) showToast('This song could not be played.', 'error');
}

audio.addEventListener('error', () => {
    syncPlaybackUI(false);
    if (window.OfflineStore && telemetrySongId) {
        window.OfflineStore.getOfflineSong(telemetrySongId).then(cachedSong => {
            if (cachedSong) {
                console.log('[PLAYBACK] Streaming audio error, falling back to offline copy');
                setPendingPlaybackEndReason('error');
                loadSong(cachedSong);
                playSong();
                return;
            }
            failCurrentPlayback();
        }).catch(() => {
            failCurrentPlayback();
        });
    } else {
        failCurrentPlayback();
    }
});

const fmt = t => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${s < 10 ? '0' + s : s}`; };

audio.addEventListener('loadedmetadata', () => {
    canSeek = true;
    if (listening()) listening().setDuration(audio.duration);
    if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration))
        durTimeEl.textContent = fmt(audio.duration);
});

/* ---- Seek-stall recovery ----
   If the audio element is still in 'seeking' state N seconds after the seek started,
   it means the browser got a bad (or no) response. Force a cache-busted reload of
   the same source so a fresh Range request goes all the way to the server. */
let _seekStallTimer = null;
audio.addEventListener('seeking', () => {
    clearTimeout(_seekStallTimer);
    _seekStallTimer = setTimeout(() => {
        isSeekingPending = false;
        if (!audio.seeking) return; // Already recovered on its own
        const t  = audio.currentTime;
        const wasPlaying = isPlaying;
        const baseSrc = (audio.currentSrc || audio.src).split('?')[0];
        // One-shot: restore position once the new src has metadata
        audio.addEventListener('loadedmetadata', () => {
            audio.currentTime = t;
            if (wasPlaying) playSong();
        }, { once: true });
        // Cache-bust forces a fresh network fetch, bypassing HTTP cache
        audio.src = baseSrc + '?_t=' + Date.now();
        audio.load();
    }, 3000);
});
audio.addEventListener('seeked', () => {
    clearTimeout(_seekStallTimer);
    isSeekingPending = false;
    if (isLyricsActive) {
        updateActiveLyric();
        startDesktopLyricsSync();
    }
    /* The Discord progress bar is drawn from timestamps, so a seek invalidates
       it. Debounced inside the module — dragging fires this repeatedly. */
    if (window.StreamifyDiscord) {
        window.StreamifyDiscord.seeked(audio.currentTime, audio.duration);
    }
});
audio.addEventListener('ratechange', startDesktopLyricsSync);

audio.addEventListener('timeupdate', e => {
    const { duration, currentTime } = e.srcElement;

    // Listening time: only normal forward playback counts (not seeks).
    if (!audio.paused && currentTime > lastTimeUpdateValue && (currentTime - lastTimeUpdateValue) < 2) {
        if (listening()) listening().addPlayed(currentTime - lastTimeUpdateValue);
    }
    lastTimeUpdateValue = currentTime;

    // Prevent background timeupdate from overriding slider while scrubbing or seeking
    if (isScrubbing || isSeekingPending) return;
    if (!duration) return;

    progressBar.style.width = `${(currentTime / duration) * 100}%`;
    currTimeEl.textContent = fmt(currentTime);
    durTimeEl.textContent = fmt(duration);

    // Sync Dedicated Progress Bar
    if (dedicatedProgressBar) dedicatedProgressBar.style.width = `${(currentTime / duration) * 100}%`;
    if (dedicatedCurrTimeEl) dedicatedCurrTimeEl.textContent = fmt(currentTime);
    if (dedicatedDurTimeEl) dedicatedDurTimeEl.textContent = fmt(duration);

    // Update Lyrics
    if (typeof updateActiveLyric === 'function') {
        updateActiveLyric();
    }

    /* Throttled iOS Widget Update (every 30 seconds) */
    const now = Date.now();
    if (now - lastWidgetUpdateTime > 30000) {
        if (typeof updateWidgetNowPlaying === 'function') {
            updateWidgetNowPlaying(playerTitle.textContent, playerArtist.textContent, playerImg.src, isPlaying, currentTime);
        }
        lastWidgetUpdateTime = now;
    }
});

/* ========== HIGH-PERFORMANCE PROGRESS BAR SCRUB & SEEK ========== */

let isScrubbing = false;
let isSeekingPending = false;
let pendingSeekFraction = 0;
let activeScrubContainer = null;

function applyScrubVisual(fraction) {
    if (!audio.duration || !Number.isFinite(audio.duration)) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    const pct = clamped * 100;
    const targetSeconds = clamped * audio.duration;
    const formatted = fmt(targetSeconds);

    progressBar.style.width = `${pct}%`;
    currTimeEl.textContent = formatted;

    if (dedicatedProgressBar) dedicatedProgressBar.style.width = `${pct}%`;
    if (dedicatedCurrTimeEl) dedicatedCurrTimeEl.textContent = formatted;
}

function calculateScrubFraction(e, containerElem) {
    const rect = containerElem.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const clientX = e.touches && e.touches.length > 0
        ? e.touches[0].clientX
        : (e.changedTouches && e.changedTouches.length > 0 ? e.changedTouches[0].clientX : e.clientX);
    const clampedX = Math.max(rect.left, Math.min(clientX, rect.right));
    return (clampedX - rect.left) / rect.width;
}

function startScrubbing(e, containerElem) {
    if (!canSeek || !audio.duration || !Number.isFinite(audio.duration)) return;
    isScrubbing = true;
    activeScrubContainer = containerElem;
    containerElem.classList.add('scrubbing');

    pendingSeekFraction = calculateScrubFraction(e, containerElem);
    applyScrubVisual(pendingSeekFraction);
}

function updateScrubbing(e) {
    if (!isScrubbing || !activeScrubContainer) return;
    pendingSeekFraction = calculateScrubFraction(e, activeScrubContainer);
    applyScrubVisual(pendingSeekFraction);
}

function commitScrubbing(e) {
    if (!isScrubbing) return;
    isScrubbing = false;

    if (activeScrubContainer) {
        activeScrubContainer.classList.remove('scrubbing');
        if (e) {
            pendingSeekFraction = calculateScrubFraction(e, activeScrubContainer);
            applyScrubVisual(pendingSeekFraction);
        }
        activeScrubContainer = null;
    }

    if (canSeek && audio.duration && Number.isFinite(audio.duration)) {
        const targetTime = Math.max(0, Math.min(audio.duration, pendingSeekFraction * audio.duration));
        isSeekingPending = true;
        audio.currentTime = targetTime;
    }
}

// Mouse events on standard progress bar
progressContainer.addEventListener('mousedown', e => {
    e.preventDefault();
    startScrubbing(e, progressContainer);
});

// Touch events on standard progress bar
progressContainer.addEventListener('touchstart', e => {
    startScrubbing(e, progressContainer);
}, { passive: false });

// Dedicated progress bar
if (dedicatedProgressContainer) {
    dedicatedProgressContainer.addEventListener('mousedown', e => {
        e.preventDefault();
        startScrubbing(e, dedicatedProgressContainer);
    });
    dedicatedProgressContainer.addEventListener('touchstart', e => {
        startScrubbing(e, dedicatedProgressContainer);
    }, { passive: false });
}

// Window events for smooth tracking outside container bounds
window.addEventListener('mousemove', e => {
    if (isScrubbing) updateScrubbing(e);
}, { passive: true });

window.addEventListener('mouseup', commitScrubbing);

window.addEventListener('touchmove', e => {
    if (isScrubbing) {
        if (e.cancelable) e.preventDefault();
        updateScrubbing(e);
    }
}, { passive: false });

window.addEventListener('touchend', commitScrubbing);
window.addEventListener('touchcancel', commitScrubbing);

// Wheel scrubbing with immediate visual and throttled seek
function handleWheelSeek(e) {
    e.preventDefault();
    if (!canSeek || !audio.duration || !Number.isFinite(audio.duration)) return;
    const delta = e.deltaY < 0 ? 5 : -5;
    const targetTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));
    isSeekingPending = true;
    applyScrubVisual(targetTime / audio.duration);
    audio.currentTime = targetTime;
}

progressContainer.addEventListener('wheel', handleWheelSeek, { passive: false });
if (dedicatedProgressContainer) {
    dedicatedProgressContainer.addEventListener('wheel', handleWheelSeek, { passive: false });
}

/* ========== BROWSER CHROME TINTING ==========
 *
 * iOS Safari tints the strip behind its toolbars using <meta name="theme-color">
 * (falling back to the page background colour). With a static dark value, the
 * bottom of the dedicated player showed a flat black band under the URL bar
 * that visibly did not belong to the blurred artwork above it.
 *
 * Here we sample the average colour of the current cover, darken it to roughly
 * match the backdrop's own brightness(0.4) filter, and use it as a fallback
 * behind the full-screen artwork. Older Safari versions also use theme-color.
 *
 * Entirely cosmetic and fully optional: any failure (a tainted canvas from
 * cross-origin artwork, a missing cover, an unsupported browser) silently falls
 * back to the default. Desktop browsers ignore theme-color, so this is a no-op
 * there.
 */
const DEFAULT_THEME_COLOR = '#121212';
let _themeColorToken = 0;
const _coverThemeColorCache = new Map();

function setThemeColor(color) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
    }
    meta.setAttribute('content', color);

    // iOS 26 Safari no longer uses theme-color for browser UI while browsing
    // (only for installed web apps). Instead it samples the background-color
    // of <body> or of a qualifying fixed element at the screen edge.
    //
    // Publish the color as a CSS fallback. The fixed backdrop itself remains
    // transparent so Safari can composite the absolute artwork layer instead
    // of extending a solid sampled color behind its toolbar.
    if (color === DEFAULT_THEME_COLOR) {
        document.documentElement.style.removeProperty('--player-tint');
    } else {
        document.documentElement.style.setProperty('--player-tint', color);
    }
}

/* A bright, saturated color picked from the cover (the darkened average
 * above is for the backdrop; this one is for accents: progress bar, volume,
 * the playing row, the beat glow). Returned as "r, g, b". */
const _coverAccentCache = new Map();
function vividCoverColor(data) {
    // Group pixels by hue and keep the strongest group, so a pink-and-orange
    // cover gives pink (its biggest vivid area), not a muddy average of both.
    const BUCKETS = 12;
    const buckets = Array.from({ length: BUCKETS }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
    let avgSat = 0, n = 0, gr = 0, gg = 0, gb = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const [h, sat, light] = rgbToHsl(r, g, b);
        const vivid = sat * (1 - Math.abs(light - 0.55) * 1.4);
        avgSat += sat; n++;
        gr += r; gg += g; gb += b;
        if (vivid <= 0.05) continue;
        const weight = vivid * vivid;
        const bucket = buckets[Math.floor(h * BUCKETS) % BUCKETS];
        bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight; bucket.w += weight;
    }
    if (!n) return null;
    const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
    const source = best.w > 0.5 ? [best.r / best.w, best.g / best.w, best.b / best.w] : [gr / n, gg / n, gb / n];
    let [h, s, l] = rgbToHsl(...source);
    if (best.w <= 0.5 || avgSat / n < 0.08) s = Math.min(s, 0.12);  // black & white art: stay neutral
    else s = Math.max(s, 0.55);
    l = Math.min(0.74, Math.max(0.62, l));
    return hslToRgb(h, s, l).map(v => Math.round(v)).join(', ');
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return [h, s, l];
}

function hslToRgb(h, s, l) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const hue = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

let _coverAccentToken = 0;
function applyCoverAccent(coverUrl) {
    const token = ++_coverAccentToken;
    const publish = rgb => {
        if (token !== _coverAccentToken) return;
        if (rgb) document.documentElement.style.setProperty('--cover-accent-rgb', rgb);
        else document.documentElement.style.removeProperty('--cover-accent-rgb');
        window.dispatchEvent(new CustomEvent('streamifycoveraccent', { detail: { rgb } }));
    };
    if (!coverUrl) { publish(null); return; }
    if (_coverAccentCache.has(coverUrl)) { publish(_coverAccentCache.get(coverUrl)); return; }
    Promise.resolve(getCoverThemeColor(coverUrl)).then(() => publish(_coverAccentCache.get(coverUrl) || null));
}

function getCoverThemeColor(coverUrl) {
    const cached = _coverThemeColorCache.get(coverUrl);
    if (cached) return cached;

    const pending = new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous'; // required for getImageData on remote art
        img.onload = () => {
            try {
                const SIZE = 16;
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = SIZE;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, SIZE, SIZE);

                const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
                _coverAccentCache.set(coverUrl, vividCoverColor(data));
                let r = 0, g = 0, b = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] < 128) continue;
                    r += data[i]; g += data[i + 1]; b += data[i + 2];
                    count++;
                }
                if (!count) {
                    resolve(DEFAULT_THEME_COLOR);
                    return;
                }

                const DARKEN = 0.4;
                r = Math.round((r / count) * DARKEN);
                g = Math.round((g / count) * DARKEN);
                b = Math.round((b / count) * DARKEN);
                resolve('#' + [r, g, b]
                    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
                    .join(''));
            } catch (err) {
                resolve(DEFAULT_THEME_COLOR);
            }
        };
        img.onerror = () => resolve(DEFAULT_THEME_COLOR);
        img.src = coverUrl;
    }).then(color => {
        _coverThemeColorCache.set(coverUrl, color);
        return color;
    });

    _coverThemeColorCache.set(coverUrl, pending);
    if (_coverThemeColorCache.size > 128) {
        _coverThemeColorCache.delete(_coverThemeColorCache.keys().next().value);
    }
    return pending;
}

function syncThemeColorToCover(coverUrl) {
    applyCoverAccent(coverUrl);
    const token = ++_themeColorToken;
    if (!coverUrl) {
        setThemeColor(DEFAULT_THEME_COLOR);
        return;
    }

    // Sampling starts when the song loads, while the full player is hidden.
    // Reopening then applies a cached string instead of decoding and reading a
    // canvas during the first animation frame.
    const cached = getCoverThemeColor(coverUrl);
    const playerIsActive = document.body.classList.contains('player-section-active');
    if (!playerIsActive) setThemeColor(DEFAULT_THEME_COLOR);

    if (typeof cached === 'string') {
        if (playerIsActive) setThemeColor(cached);
        return;
    }

    cached.then(color => {
        if (token !== _themeColorToken || !document.body.classList.contains('player-section-active')) return;
        setThemeColor(color);
    });
}

/* ========== VOLUME ========== */

const savedVolume = parseFloat(localStorage.getItem('streamify_volume'));
let lastVolume = Number.isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : 0.7;

// Initialize volume on load
audio.volume = lastVolume;
if (volSlider) volSlider.value = lastVolume * 100;
if (dedicatedVolSlider) dedicatedVolSlider.value = lastVolume * 100;

function updateVolumeUI(val) {
    const volPercent = val * 100;
    if (volSlider) volSlider.value = volPercent;
    if (dedicatedVolSlider) dedicatedVolSlider.value = volPercent;
    // Drives the filled part of the volume track (customize.css).
    [volSlider, dedicatedVolSlider].forEach(slider => { if (slider) slider.style.setProperty('--vol', `${volPercent}%`); });

    const iconClass = val === 0 ? 'bx bx-volume-mute' : (val < 0.5 ? 'bx bx-volume-low' : 'bx bx-volume-full');
    if (volIcon) volIcon.className = iconClass;
    if (dedicatedVolIcon) dedicatedVolIcon.className = iconClass;
}

// Initial UI Sync
updateVolumeUI(lastVolume);

function handleVolumeScroll(e, sliderElem = volSlider) {
    e.preventDefault();
    let current = parseInt(sliderElem.value);
    current = e.deltaY < 0 ? Math.min(current + 5, 100) : Math.max(current - 5, 0);

    volSlider.value = current;
    volSlider.dispatchEvent(new Event('input'));

    if (dedicatedVolSlider) {
        dedicatedVolSlider.value = current;
    }
}

volSlider.addEventListener('wheel', e => handleVolumeScroll(e, volSlider), { passive: false });
volIcon.addEventListener('wheel', e => handleVolumeScroll(e, volSlider), { passive: false });
const volWrapper = document.querySelector('.volume-wrapper');
if (volWrapper) volWrapper.addEventListener('wheel', e => handleVolumeScroll(e, volSlider), { passive: false });

if (dedicatedVolSlider) dedicatedVolSlider.addEventListener('wheel', e => handleVolumeScroll(e, dedicatedVolSlider), { passive: false });
if (dedicatedVolIcon) dedicatedVolIcon.addEventListener('wheel', e => handleVolumeScroll(e, dedicatedVolSlider), { passive: false });
const dedicatedVolWrapper = document.querySelector('.dedicated-volume-wrapper');
if (dedicatedVolWrapper) dedicatedVolWrapper.addEventListener('wheel', e => handleVolumeScroll(e, dedicatedVolSlider), { passive: false });

volSlider.addEventListener('input', e => {
    const val = e.target.value / 100;
    audio.volume = val;
    lastVolume = val;
    localStorage.setItem('streamify_volume', val);
    updateVolumeUI(val);
});

if (dedicatedVolSlider) {
    dedicatedVolSlider.addEventListener('input', e => {
        const val = e.target.value / 100;
        audio.volume = val;
        lastVolume = val;
        localStorage.setItem('streamify_volume', val);
        updateVolumeUI(val);
    });
}

function toggleMute() {
    if (audio.volume > 0) {
        audio.volume = 0;
        updateVolumeUI(0);
    } else {
        const targetVol = lastVolume > 0 ? lastVolume : 0.7;
        audio.volume = targetVol;
        lastVolume = targetVol;
        localStorage.setItem('streamify_volume', targetVol);
        updateVolumeUI(targetVol);
    }
}

volIcon.addEventListener('click', toggleMute);
if (dedicatedVolIcon) dedicatedVolIcon.addEventListener('click', toggleMute);

/* ========== DEDICATED PLAYER VIEW BINDINGS ========== */

if (dedicatedBtnPlay) dedicatedBtnPlay.addEventListener('click', togglePlay);
if (dedicatedBtnNext) dedicatedBtnNext.addEventListener('click', nextSong);
if (dedicatedBtnPrev) dedicatedBtnPrev.addEventListener('click', prevSong);
if (dedicatedBtnShuffle) dedicatedBtnShuffle.addEventListener('click', toggleShuffle);
if (dedicatedBtnRepeat) dedicatedBtnRepeat.addEventListener('click', toggleRepeat);

// Open Dedicated Player Page (from mini player image)
let previousSectionId = null;
let savedUnderlayScrollTop = 0;
let previousSidebarActiveEl = null; // snapshot of the active sidebar link (nav or playlist)
let desktopPlayerUnderlayState = null;
const desktopPlayerMedia = window.matchMedia('(min-width: 901px)');
const playerSectionHome = playerSection ? {
    parent: playerSection.parentNode,
    nextSibling: playerSection.nextSibling
} : null;
const desktopShellAnimations = new Set();
const desktopPlayerAnimations = new Set();
let desktopPlayerOverlayPrepared = false;
let desktopPlayerOverlayPreparePromise = null;

function rememberAnimation(collection, animation) {
    collection.add(animation);
    animation.finished.then(
        () => collection.delete(animation),
        () => collection.delete(animation)
    );
    return animation;
}

function cancelAnimations(collection) {
    collection.forEach(animation => animation.cancel());
    collection.clear();
}

function isDesktopPlayerOverlayEnabled() {
    return desktopPlayerMedia.matches &&
        document.body.classList.contains('desktop-player-overlay-enabled') &&
        playerSection?.classList.contains('player-overlay-mounted');
}

function setPlayerTreeInteractive(interactive) {
    if (!playerSection) return;
    playerSection.inert = !interactive;
    playerSection.setAttribute('aria-hidden', interactive ? 'false' : 'true');
}

function mountDesktopPlayerOverlay() {
    if (!playerSection || !desktopPlayerMedia.matches) return;
    const playerWasActive = document.body.classList.contains('player-section-active');
    document.body.classList.add('desktop-player-overlay-enabled');
    playerSection.classList.remove('hidden', 'fade-in-animate');
    playerSection.classList.add('player-overlay-mounted');
    playerSection.classList.toggle('player-overlay-active', playerWasActive);

    const footer = document.querySelector('.music-player');
    if (playerSection.parentNode !== document.body) {
        document.body.insertBefore(playerSection, footer || null);
    }

    setPlayerTreeInteractive(playerWasActive);
}

function unmountDesktopPlayerOverlay() {
    if (!playerSection || !playerSectionHome) return;
    cancelAnimations(desktopPlayerAnimations);
    cancelAnimations(desktopShellAnimations);
    playerSection.classList.remove('player-overlay-mounted', 'player-overlay-active');
    document.body.classList.remove('desktop-player-overlay-enabled');
    setPlayerTreeInteractive(true);

    const { parent, nextSibling } = playerSectionHome;
    if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(playerSection, nextSibling);
    else parent.appendChild(playerSection);
    if (!document.body.classList.contains('player-section-active')) playerSection.classList.add('hidden');
}

function applyDedicatedPlayerClasses(active) {
    document.body.classList.toggle('player-section-active', active);
    document.documentElement.classList.toggle('player-chrome-active', active);
    const topBar = document.querySelector('.top-bar');
    if (topBar) {
        topBar.inert = active;
        if (active) topBar.setAttribute('aria-hidden', 'true');
        else topBar.removeAttribute('aria-hidden');
    }
    const miniPlayer = document.querySelector('.music-player');
    if (miniPlayer) {
        miniPlayer.inert = active;
        if (active) miniPlayer.setAttribute('aria-hidden', 'true');
        else miniPlayer.removeAttribute('aria-hidden');
    }
}

function animateDesktopShell(active) {
    cancelAnimations(desktopShellAnimations);
    document.querySelectorAll('.top-bar-logo-transition-clone').forEach(clone => clone.remove());

if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applyDedicatedPlayerClasses(active);
        return;
    }

    const sidebar = document.querySelector('.sidebar');
    const topBar = document.querySelector('.top-bar');
    const logo = document.querySelector('.top-bar-logo');
    const firstSidebar = sidebar?.getBoundingClientRect();
    const topBarItems = topBar ? Array.from(topBar.children).filter(item => item !== logo) : [];
    const firstTopBarItems = new Map(topBarItems.map(item => [item, item.getBoundingClientRect()]));
    let logoExitClone = null;
    if (!active && logo) {
        const rect = logo.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            logoExitClone = logo.cloneNode(true);
            logoExitClone.removeAttribute('id');
            logoExitClone.classList.add('top-bar-logo-transition-clone');
            logoExitClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;opacity:1;overflow:hidden;display:flex;align-items:center;z-index:6;pointer-events:none;`;
            const text = logoExitClone.querySelector('.morph-text');
            if (text) {
                text.style.opacity = '1';
                text.style.filter = 'none';
                text.style.transform = 'none';
                text.style.animation = 'gradient-anim 5s linear infinite';
            }
            document.body.appendChild(logoExitClone);
        }
    }

applyDedicatedPlayerClasses(active);

    const lastSidebar = sidebar?.getBoundingClientRect();
    const options = {
        duration: 300,
        easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)'
    };

    if (sidebar && firstSidebar && lastSidebar) {
        const deltaX = firstSidebar.left - lastSidebar.left;
        rememberAnimation(desktopShellAnimations, sidebar.animate([
            {
                transform: `translate3d(${deltaX}px, 0, 0)`,
                opacity: active ? 1 : 0
            },
            {
                transform: 'translate3d(0, 0, 0)',
                opacity: active ? 0 : 1
            }
        ], options));
    }

    topBarItems.forEach(item => {
        const first = firstTopBarItems.get(item);
        const last = item.getBoundingClientRect();
        if (!first || !last.width) return;
        const deltaX = first.left - last.left;
        const deltaY = first.top - last.top;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
        rememberAnimation(desktopShellAnimations, item.animate([
            { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' }
        ], options));
    });

    if (logo && active) {
        rememberAnimation(desktopShellAnimations, logo.animate([
            { opacity: 0 },
            { opacity: 1 }
        ], options));
    }

    if (logoExitClone) {
        const animation = rememberAnimation(desktopShellAnimations, logoExitClone.animate([
            { opacity: 1 },
            { opacity: 0 }
        ], options));
        const removeClone = () => logoExitClone.remove();
        animation.finished.then(removeClone, removeClone);
    }
}

function setDedicatedPlayerActive(active) {
    const wasActive = document.body.classList.contains('player-section-active');
    if (wasActive === active) return;

    if (isDesktopPlayerOverlayEnabled()) {
        animateDesktopShell(active);
        if (!active) {
            _themeColorToken++;
            if (isLyricsActive) deactivateLyricsView({ resetLineDepth: false });
        }
        return;
    }

    applyDedicatedPlayerClasses(active);

    if (!active) {
        _themeColorToken++;
        deactivateLyricsView();
        const offset = parseFloat(getComputedStyle(document.documentElement)
            .getPropertyValue('--safari-player-scroll-offset')) || 0;
        if (offset > 0) {
            const restoreRootScroll = () => {
                document.documentElement.scrollTop = 0;
                document.body.scrollTop = 0;
                window.scrollTo(0, 0);
            };

            restoreRootScroll();
            requestAnimationFrame(() => {
                if (document.documentElement.classList.contains('player-chrome-active')) return;
                restoreRootScroll();
            });
        }
        return;
    }

    requestAnimationFrame(() => {
        if (!document.documentElement.classList.contains('player-chrome-active')) return;
        const offset = parseFloat(getComputedStyle(document.documentElement)
            .getPropertyValue('--safari-player-scroll-offset')) || 0;
        if (offset > 0) window.scrollTo(0, offset);
    });
}

window.setDedicatedPlayerActive = setDedicatedPlayerActive;

function suspendDesktopPlayerUnderlay(section) {
    if (!section) return;
    desktopPlayerUnderlayState = {
        element: section,
        inert: section.inert,
        ariaHidden: section.getAttribute('aria-hidden')
    };
    section.classList.remove('fade-in-animate');
    section.classList.add('player-underlay-suspended');
    section.inert = true;
    section.setAttribute('aria-hidden', 'true');
}

function restoreDesktopPlayerUnderlay({ animate = true } = {}) {
    const state = desktopPlayerUnderlayState;
    desktopPlayerUnderlayState = null;
    if (!state?.element) return null;

    const section = state.element;
    section.classList.remove('player-underlay-suspended');
    section.inert = state.inert;
    if (state.ariaHidden === null) section.removeAttribute('aria-hidden');
    else section.setAttribute('aria-hidden', state.ariaHidden);

    if (animate) section.classList.add('fade-in-animate');
    return section;
}

function playDesktopPlayerEntry() {
    if (!playerSection) return;
    cancelAnimations(desktopPlayerAnimations);
    playerSection.classList.add('player-overlay-active');
    setPlayerTreeInteractive(true);

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        updateMarquees(dedicatedTitle, dedicatedArtist);
        return;
    }

    const outerAnimation = rememberAnimation(desktopPlayerAnimations, playerSection.animate([
        { opacity: 0, transform: 'translate3d(0, 40px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' }
    ], {
        duration: 500,
        easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)'
    }));

    const activeView = !lyricsContainer?.classList.contains('hidden')
        ? lyricsContainer
        : standardContainer;
    if (activeView) {
        activeView.getAnimations().forEach(animation => animation.cancel());
        rememberAnimation(desktopPlayerAnimations, activeView.animate([
            { opacity: 0, transform: 'translate3d(0, 15px, 0)', filter: 'blur(8px)' },
            { opacity: 1, transform: 'translate3d(0, 0, 0)', filter: 'blur(0px)' }
        ], {
            duration: 800,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
        }));
    }

    outerAnimation.finished.then(() => {
        if (document.body.classList.contains('player-section-active')) {
            updateMarquees(dedicatedTitle, dedicatedArtist);
        }
    }, () => {});
}

function focusDedicatedPlayerClose() {
    requestAnimationFrame(() => {
        document.getElementById('close-dedicated-player')?.focus({ preventScroll: true });
    });
}

function openDesktopPlayerOverlay() {
    if (!playerSection || document.body.classList.contains('player-section-active')) return;
    desktopArtworkPrimeToken++;
    playerSection.classList.remove('player-overlay-prime');
    const activeSection = document.querySelector(
        'main.main-content > div.content-container > section:not(.hidden):not(#player-section)'
    );
    if (activeSection) {
        previousSectionId = activeSection.id;
        suspendDesktopPlayerUnderlay(activeSection);
    }

    previousSidebarActiveEl = document.querySelector(
        '.sidebar-nav a.active, #sidebar-playlist-list li a.active, #sidebar-playlist-list li.active > a'
    );

    setDedicatedPlayerActive(true);
    syncThemeColorToCover(dedicatedImg ? dedicatedImg.src : null);
    playDesktopPlayerEntry();
    focusDedicatedPlayerClose();
}

function closeDesktopPlayerOverlay({ animateUnderlay = true, focusCover = true } = {}) {
    if (!playerSection || !document.body.classList.contains('player-section-active')) return false;
    cancelAnimations(desktopPlayerAnimations);
    playerSection.classList.remove('player-overlay-active');
    setPlayerTreeInteractive(false);
    setDedicatedPlayerActive(false);
    setThemeColor(DEFAULT_THEME_COLOR);

    const restoredSection = restoreDesktopPlayerUnderlay({ animate: animateUnderlay });
    if (restoredSection) {
        const listContainer = restoredSection.querySelector('.song-list, #trending-list, #playlist-songs-list');
        if (listContainer && typeof highlightCurrentSong === 'function') {
            highlightCurrentSong(listContainer);
        }
    }
    if (previousSidebarActiveEl) previousSidebarActiveEl.classList.add('active');
    if (focusCover) playerImg?.focus({ preventScroll: true });
    return true;
}

window.closeDesktopPlayerOverlay = closeDesktopPlayerOverlay;

function syncDesktopPlayerOverlayMode() {
    if (!desktopPlayerOverlayPrepared) return;
    if (desktopPlayerMedia.matches) {
        // Crossing the breakpoint while the mobile/tablet player is open would
        // otherwise leave its routed page hidden beneath the new overlay.
        if (
            document.body.classList.contains('player-section-active') &&
            !document.body.classList.contains('desktop-player-overlay-enabled')
        ) {
            setDedicatedPlayerActive(false);
            playerSection?.classList.add('hidden');
            document.getElementById(previousSectionId)?.classList.remove('hidden');
        }
        mountDesktopPlayerOverlay();
        return;
    }

    if (
        document.body.classList.contains('desktop-player-overlay-enabled') &&
        document.body.classList.contains('player-section-active')
    ) {
        closeDesktopPlayerOverlay({ animateUnderlay: false, focusCover: false });
    }
    unmountDesktopPlayerOverlay();
}

function prepareDesktopPlayerOverlay() {
    if (desktopPlayerOverlayPreparePromise) return desktopPlayerOverlayPreparePromise;
    desktopPlayerOverlayPrepared = true;
    desktopPlayerOverlayPreparePromise = (async () => {
        syncDesktopPlayerOverlayMode();
        if (!isDesktopPlayerOverlayEnabled() || document.body.classList.contains('player-section-active')) return;

        playerSection.classList.add('player-overlay-prime');
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
        playerSection.classList.remove('player-overlay-prime');
        await new Promise(resolve => requestAnimationFrame(resolve));
    })().finally(() => {
        desktopPlayerOverlayPreparePromise = null;
    });
    return desktopPlayerOverlayPreparePromise;
}

window.prepareDesktopPlayerOverlay = prepareDesktopPlayerOverlay;
desktopPlayerMedia.addEventListener('change', syncDesktopPlayerOverlayMode);

/* ---------------------------------------------------------------------------
 * Underlay entrance animations must never replay.
 *
 * The page behind the mobile player has one-shot entrance animations
 * (.content-container fadeInUp, .playlist-detail-section fadeInPlaylist, ...).
 * Closing the player used to set `animation: none` on the section and restore
 * it a frame later, and the stylesheet switched .content-container to
 * `animation: none !important` while the player was open. Both restart the
 * keyframes when they are undone, so every swipe-down replayed the whole
 * page's fade/slide-in and looked like the page had refreshed.
 *
 * Instead: the container's entrance is marked finished for good once it has
 * run, and a section's animation is frozen until the next real navigation
 * (the section gets .hidden or .fade-in-animate again).
 * ------------------------------------------------------------------------- */
const contentContainerEl = document.querySelector('.content-container');
function settleUnderlayEntrance() {
    if (contentContainerEl) contentContainerEl.classList.add('entrance-done');
}
if (contentContainerEl) {
    const onEntranceEnd = event => { if (event.target === contentContainerEl) settleUnderlayEntrance(); };
    contentContainerEl.addEventListener('animationend', onEntranceEnd);
    contentContainerEl.addEventListener('animationcancel', onEntranceEnd);
}

function freezeSectionEntrance(section) {
    if (!section) return;
    section.style.animation = 'none';
    if (section._entranceFreeze) return;
    const observer = new MutationObserver(() => {
        if (section.classList.contains('hidden') || section.classList.contains('fade-in-animate')) {
            observer.disconnect();
            section._entranceFreeze = null;
            section.style.animation = '';
        }
    });
    section._entranceFreeze = observer;
    observer.observe(section, { attributes: true, attributeFilter: ['class'] });
}

function openDedicatedPlayerFromCover() {
    if (isDesktopPlayerOverlayEnabled()) {
        openDesktopPlayerOverlay();
        return;
    }

    // Remember which section we were on before opening the player
    const activeSection = document.querySelector(
        'main.main-content > div.content-container > section:not(.hidden):not(#player-section)'
    );
    if (activeSection) {
        previousSectionId = activeSection.id;
        activeSection.inert = true;
        activeSection.setAttribute('aria-hidden', 'true');
        activeSection.classList.remove('fade-in-animate');
        freezeSectionEntrance(activeSection);
    } else if (!previousSectionId) {
        previousSectionId = 'trending-section';
    }
    settleUnderlayEntrance();

    // Save scroll position of the underlay container so dismiss never jumps or resets
    const scrollContainer = window.getAppScrollContainer ? window.getAppScrollContainer() : document.querySelector('.main-content');
    if (scrollContainer) {
        savedUnderlayScrollTop = scrollContainer.scrollTop;
    }

    // Snapshot the active sidebar element so we can restore it when the player is closed
    previousSidebarActiveEl = document.querySelector(
        '.sidebar-nav a.active, #sidebar-playlist-list li a.active, #sidebar-playlist-list li.active > a'
    );

    if (playerSection) {
        setDedicatedPlayerActive(true);
        playerSection.classList.remove('hidden');
        syncThemeColorToCover(dedicatedImg ? dedicatedImg.src : null);
        updateMarquees(dedicatedTitle, dedicatedArtist);

        // Native iOS sheet slide-up presentation animation
        playerSection.style.transition = 'none';
        playerSection.style.transform = 'translate3d(0, 100%, 0)';
        void playerSection.offsetHeight;
        playerSection.style.transition = 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1)';
        playerSection.style.transform = 'translate3d(0, 0, 0)';
        setTimeout(() => {
            playerSection.style.transition = '';
            playerSection.style.transform = '';
        }, 300);
    }
    focusDedicatedPlayerClose();
}

if (playerImg) {
    playerImg.addEventListener('click', openDedicatedPlayerFromCover);
    playerImg.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openDedicatedPlayerFromCover();
    });
}

let isClosingMobilePlayer = false;

function finalizeCloseDedicatedPlayer() {
    if (playerSection) {
        playerSection.classList.add('hidden');
        playerSection.classList.remove('player-dismissing');
        playerSection.style.transition = '';
        playerSection.style.transform = '';
        playerSection.style.opacity = '';
        playerSection.style.borderTopLeftRadius = '';
        playerSection.style.borderTopRightRadius = '';
        playerSection.style.boxShadow = '';
        playerSection.style.borderRadius = '';
        playerSection.style.willChange = '';
    }
    document.body.classList.remove('player-is-dismissing');
    isClosingMobilePlayer = false;

    setDedicatedPlayerActive(false);
    setThemeColor(DEFAULT_THEME_COLOR);

    const topBar = document.querySelector('.top-bar');
    if (topBar) {
        topBar.style.removeProperty('display');
        topBar.style.removeProperty('opacity');
        topBar.style.removeProperty('transition');
        topBar.style.removeProperty('pointer-events');
    }

    const miniPlayer = document.querySelector('.music-player');
    if (miniPlayer) {
        miniPlayer.style.removeProperty('display');
        miniPlayer.style.removeProperty('opacity');
        miniPlayer.style.removeProperty('transition');
        miniPlayer.style.removeProperty('pointer-events');
    }

    const secId = previousSectionId || 'trending-section';
    const prevSec = document.getElementById(secId);
    if (prevSec) {
        prevSec.classList.remove('hidden', 'fade-in-animate');
        freezeSectionEntrance(prevSec);
        prevSec.inert = false;
        prevSec.removeAttribute('aria-hidden');

        // Restore scroll position so library list never jumps
        const scrollContainer = window.getAppScrollContainer ? window.getAppScrollContainer() : document.querySelector('.main-content');
        if (scrollContainer && typeof savedUnderlayScrollTop === 'number') {
            scrollContainer.scrollTop = savedUnderlayScrollTop;
        }

        // Re-highlight the correct sidebar nav link without clicking or re-fetching
        const navMap = {
            'trending-section':   'library-link',
            'downloads-section':  'downloads-link',
            'upload-section':     'upload-link',
            'playlist-detail-section': null,
        };
        const linkId = navMap[secId];
        if (linkId) document.getElementById(linkId)?.classList.add('active');

        // Restore sidebar playlist / nav highlight
        if (previousSidebarActiveEl) {
            previousSidebarActiveEl.classList.add('active');
        }

        // Re-apply the "now playing" blue highlight on the song row
        const listContainer = prevSec.querySelector('.song-list, #trending-list, #playlist-songs-list');
        if (listContainer && typeof highlightCurrentSong === 'function') {
            highlightCurrentSong(listContainer);
        }

        if (isDesktopPlayerOverlayEnabled()) playerImg?.focus({ preventScroll: true });
        return;
    }

    // Safety fallback: ensure trending-section is visible without clicking #library-link or calling fetchLibrary()
    const fallbackSec = document.getElementById('trending-section');
    if (fallbackSec) {
        fallbackSec.classList.remove('hidden', 'fade-in-animate');
        freezeSectionEntrance(fallbackSec);
        fallbackSec.inert = false;
        fallbackSec.removeAttribute('aria-hidden');
        document.getElementById('library-link')?.classList.add('active');
    }
    if (isDesktopPlayerOverlayEnabled()) playerImg?.focus({ preventScroll: true });
}

function snapBackDedicatedPlayerMobile() {
    if (!playerSection) return;

    playerSection.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1), border-radius 0.25s ease, box-shadow 0.25s ease';
    playerSection.style.transform = 'translate3d(0, 0, 0)';
    playerSection.style.borderTopLeftRadius = '';
    playerSection.style.borderTopRightRadius = '';
    playerSection.style.boxShadow = '';
    playerSection.style.willChange = '';

    setTimeout(() => {
        playerSection.classList.remove('player-dismissing');
        document.body.classList.remove('player-is-dismissing');
        playerSection.style.transition = '';
        playerSection.style.transform = '';
        playerSection.style.borderTopLeftRadius = '';
        playerSection.style.borderTopRightRadius = '';
        playerSection.style.boxShadow = '';
    }, 260);
}

function dismissDedicatedPlayerMobile(initialY = 0, velocity = 0) {
    if (!playerSection || !document.body.classList.contains('player-section-active') || isClosingMobilePlayer) return;
    isClosingMobilePlayer = true;

    const prevSec = previousSectionId ? document.getElementById(previousSectionId) : document.getElementById('trending-section');
    if (prevSec) {
        prevSec.classList.remove('hidden', 'fade-in-animate');
        freezeSectionEntrance(prevSec);
    }

    document.body.classList.add('player-is-dismissing');
    playerSection.classList.add('player-dismissing');

    if (initialY > 0) {
        playerSection.style.transform = `translate3d(0, ${initialY}px, 0)`;
    }

    void playerSection.offsetHeight;

    let duration = 0.24;
    if (velocity > 0.6) duration = 0.18;
    else if (velocity > 0.35) duration = 0.21;

    playerSection.style.transition = `transform ${duration}s cubic-bezier(0.32, 0.72, 0, 1), border-radius ${duration}s ease`;
    playerSection.style.transform = 'translate3d(0, 100%, 0)';

    setTimeout(() => {
        finalizeCloseDedicatedPlayer();
    }, duration * 1000 + 30);
}

window.dismissDedicatedPlayerMobile = dismissDedicatedPlayerMobile;
window.snapBackDedicatedPlayerMobile = snapBackDedicatedPlayerMobile;
window.finalizeCloseDedicatedPlayer = finalizeCloseDedicatedPlayer;

// Back Button from Dedicated Player
const btnCloseDedicated = document.getElementById('close-dedicated-player');
if (btnCloseDedicated) {
    btnCloseDedicated.addEventListener('click', () => {
        if (isDesktopPlayerOverlayEnabled()) {
            if (closeDesktopPlayerOverlay()) return;
        } else {
            dismissDedicatedPlayerMobile();
            return;
        }

        finalizeCloseDedicatedPlayer();
    });
}

document.addEventListener('keydown', event => {
    if (!playerSection || !document.body.classList.contains('player-section-active')) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        btnCloseDedicated?.click();
        return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(playerSection.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.closest('.hidden') && element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!playerSection.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

/* ========== DESKTOP GLOBAL KEYBOARD SHORTCUTS ========== */
(function setupDesktopKeyboardShortcuts() {
    function isInteractiveInputTarget(target) {
        if (!target) return false;
        const tagName = target.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
        if (target.isContentEditable || target.getAttribute('contenteditable') === 'true') return true;
        return false;
    }

    function isModalOrEditorOpen() {
        return Boolean(document.querySelector('.modal:not(.hidden), .confirm-modal:not(.hidden), #edit-song-modal:not(.hidden), #settings-modal:not(.hidden), #connect-phone-modal:not(.hidden), #ai-metadata-modal:not(.hidden), #lyrics-selection-modal:not(.hidden), .lyrics-editing'));
    }

    document.addEventListener('keydown', event => {
        // If user is focused on an input element, don't hijack keystrokes
        if (isInteractiveInputTarget(event.target)) {
            if (event.key === 'Escape') {
                event.target.blur();
            }
            return;
        }

        // If a modal or lyrics editor is active, don't run global shortcuts
        if (isModalOrEditorOpen()) return;

        // Search shortcut: '/'
        if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const searchInput = document.querySelector('.search-wrapper input, #search-input');
            if (searchInput) {
                event.preventDefault();
                searchInput.focus();
                searchInput.select();
                return;
            }
        }

        // Toggle Play / Pause: Space
        if (event.key === ' ' || event.code === 'Space') {
            event.preventDefault();
            if (typeof togglePlay === 'function') togglePlay();
            return;
        }

        // Next Track: Shift + ArrowRight OR 'j' / 'J'
        if ((event.shiftKey && event.key === 'ArrowRight') || ((event.key === 'j' || event.key === 'J') && !event.ctrlKey && !event.metaKey && !event.altKey)) {
            event.preventDefault();
            if (typeof nextSong === 'function') nextSong();
            return;
        }

        // Previous Track: Shift + ArrowLeft OR 'k' / 'K'
        if ((event.shiftKey && event.key === 'ArrowLeft') || ((event.key === 'k' || event.key === 'K') && !event.ctrlKey && !event.metaKey && !event.altKey)) {
            event.preventDefault();
            if (typeof prevSong === 'function') prevSong();
            return;
        }

        // Seek Forward 5s: ArrowRight (without Shift)
        if (event.key === 'ArrowRight' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            if (audio && !isNaN(audio.duration) && audio.duration > 0) {
                audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
            }
            return;
        }

        // Seek Backward 5s: ArrowLeft (without Shift)
        if (event.key === 'ArrowLeft' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            if (audio && !isNaN(audio.duration) && audio.duration > 0) {
                audio.currentTime = Math.max(0, audio.currentTime - 5);
            }
            return;
        }

        // Volume Up 5%: ArrowUp
        if (event.key === 'ArrowUp' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            if (audio) {
                const newVol = Math.min(1, Math.round((audio.volume + 0.05) * 100) / 100);
                audio.volume = newVol;
                lastVolume = newVol;
                localStorage.setItem('streamify_volume', newVol);
                if (typeof updateVolumeUI === 'function') updateVolumeUI(newVol);
            }
            return;
        }

        // Volume Down 5%: ArrowDown
        if (event.key === 'ArrowDown' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            if (audio) {
                const newVol = Math.max(0, Math.round((audio.volume - 0.05) * 100) / 100);
                audio.volume = newVol;
                lastVolume = newVol;
                localStorage.setItem('streamify_volume', newVol);
                if (typeof updateVolumeUI === 'function') updateVolumeUI(newVol);
            }
            return;
        }

        // Mute / Unmute: 'm' / 'M'
        if ((event.key === 'm' || event.key === 'M') && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            if (typeof toggleMute === 'function') toggleMute();
            return;
        }

        // Toggle Lyrics: 'l' / 'L'
        if ((event.key === 'l' || event.key === 'L') && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            if (isLyricsActive) {
                if (typeof deactivateLyricsView === 'function') deactivateLyricsView();
            } else if (btnLyrics) {
                btnLyrics.click();
            }
            return;
        }
    });
})();


/* ========== DEDICATED PLAYER LYRICS LOGIC ========== */
let lyricsData = []; // Array of {time: seconds|null, text: string}
let lyricsAreSynced = true; // false => plain lyrics, shown statically
let isLyricsActive = false;
let isUserScrollingLyrics = false;
let userScrollingLyricsTimeout = null;
let activeLyricIndex = -1;
let desktopLyricsSyncTimer = null;

/* ========== SCREEN WAKE LOCK (keeps screen on during lyrics) ========== */
let _wakeLockSentinel = null;

async function _acquireWakeLock() {
    if (!('wakeLock' in navigator) || _wakeLockSentinel) return;
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (!isLyricsActive || !document.body.classList.contains('player-section-active')) {
            await sentinel.release();
            return;
        }
        _wakeLockSentinel = sentinel;
        sentinel.addEventListener('release', () => {
            if (_wakeLockSentinel === sentinel) _wakeLockSentinel = null;
        });
    } catch (err) {
        console.warn('[WAKELOCK] Could not acquire:', err.message);
    }
}

async function _releaseWakeLock() {
    if (_wakeLockSentinel) {
        try { await _wakeLockSentinel.release(); } catch (e) { /* ignore */ }
        _wakeLockSentinel = null;
    }
}

// Re-acquire if page becomes visible again while lyrics are still open
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isLyricsActive && document.body.classList.contains('player-section-active')) {
        _acquireWakeLock();
    } else if (document.visibilityState === 'hidden') {
        _releaseWakeLock();
    }
});
window.addEventListener('pagehide', _releaseWakeLock);

const btnCloseLyrics = document.getElementById('close-lyrics-btn');
const standardContainer = document.getElementById('dedicated-standard-container');
const lyricsContainer = document.getElementById('dedicated-lyrics-container');

function stopDesktopLyricsSync() {
    if (desktopLyricsSyncTimer !== null) clearTimeout(desktopLyricsSyncTimer);
    desktopLyricsSyncTimer = null;
}

function startDesktopLyricsSync() {
    stopDesktopLyricsSync();
    if (
        !isLyricsActive ||
        isLyricEditMode ||
        !lyricsAreSynced ||
        audio.paused ||
        !document.body.classList.contains('player-section-active')
    ) return;

    const currentTime = audio.currentTime;
    const nextLine = lyricsData.find(line => Number(line.time) > currentTime + 0.01);
    if (!nextLine) return;

    const playbackRate = Math.max(0.1, Number(audio.playbackRate) || 1);
    const delay = Math.max(16, ((nextLine.time - currentTime) / playbackRate) * 1000 + 12);
    desktopLyricsSyncTimer = setTimeout(() => {
        desktopLyricsSyncTimer = null;
        updateActiveLyric();
        startDesktopLyricsSync();
    }, delay);
}

function setDesktopLyricDepth(lineElements, nextActiveIndex) {
    activeLyricIndex = nextActiveIndex;

    lineElements.forEach((lineEl, index) => {
        // Signed distance preserves whether the line is before or after focus.
        const distance = index - nextActiveIndex;
        lineEl.dataset.distance = String(distance);
        lineEl.classList.toggle('active', distance === 0);
        lineEl.classList.toggle('lyric-line-far', Math.abs(distance) > 3);

        if (distance === 0) lineEl.setAttribute('aria-current', 'true');
        else lineEl.removeAttribute('aria-current');
    });
}

/* Instrumental-break rows (the three dots) fold away when they aren't being
 * sung and unfold when their break starts; the height animates. Centering has
 * to aim at where the active line ends up once that settles, not where it is
 * on the first frame, or the track would drift off-center by a whole row.
 * Returns how far the active line will still move up, and its final height. */
const LYRIC_DOTS_LINE_EM = 1.5; // keep in sync with .lyric-dots-line height in player.css
function lyricSettledGeometry(activeEl) {
    let shift = 0;
    let height = activeEl.offsetHeight;
    if (!lyricsContent || !lyricsContent.querySelector('.lyric-dots-line')) return { shift, height };
    const gap = parseFloat(getComputedStyle(lyricsContent).rowGap) || 0;
    for (let el = activeEl.previousElementSibling; el; el = el.previousElementSibling) {
        if (!el.classList.contains('lyric-dots-line')) continue;
        // A folded row nets to zero: no height, and a negative top margin
        // that cancels its gap. Whatever it adds right now will disappear.
        shift += el.offsetHeight + gap + (parseFloat(getComputedStyle(el).marginTop) || 0);
    }
    if (activeEl.classList.contains('lyric-dots-line')) {
        const style = getComputedStyle(activeEl);
        shift += parseFloat(style.marginTop) || 0;
        height = (parseFloat(style.fontSize) || 0) * LYRIC_DOTS_LINE_EM;
    }
    return { shift, height };
}

let desktopLyricsTrackY = 0;

function desktopLyricsMaxTopInset() {
    return Math.max(16, Math.min(28, lyricsScrollArea.clientHeight * 0.08));
}

function centerDesktopLyric(activeEl, immediate = false) {
    if (!activeEl || !lyricsScrollArea || !lyricsContent || window.innerWidth <= 900) return;
    // While the user is scrolling through the lyrics, leave the track where
    // they put it; it returns to the sung line when they stop.
    if (isUserScrollingLyrics && !immediate) return;
    if (isUserScrollingLyrics) stopLyricsBrowsing({ recenter: false });

    // Desktop never scrolls the outer viewport. The inner lyric track moves so
    // the active line's layout center lands on the viewport's visual center.
    lyricsScrollArea.scrollTop = 0;
    const settled = lyricSettledGeometry(activeEl);
    const lineCenter = activeEl.offsetTop - settled.shift + (settled.height / 2);
    const centeredTranslateY = (lyricsScrollArea.clientHeight / 2) - lineCenter;
    // The first few lines have no content above them. Full centering would move
    // the entire track down by half a viewport and create the large empty band
    // seen in the screenshot. Once enough lines exist above, normal centering
    // and the exact same spring transition take over.
    const maxTopInset = desktopLyricsMaxTopInset();
    const translateY = Math.min(maxTopInset, centeredTranslateY);
    desktopLyricsTrackY = Math.round(translateY);

    if (immediate) lyricsContent.classList.add('lyrics-position-immediate');
    lyricsContent.style.transform = `translateY(${Math.round(translateY)}px)`;

    if (immediate) {
        requestAnimationFrame(() => {
            if (lyricsContent) lyricsContent.classList.remove('lyrics-position-immediate');
        });
    }
}

function resetDesktopLyricsPresentation({ resetLineDepth = true } = {}) {
    if (!lyricsContent) return;
    lyricsContent.style.removeProperty('transform');
    lyricsContent.classList.remove('lyrics-position-immediate');
    if (!resetLineDepth) return;
    lyricsContent.querySelectorAll('.lyric-line').forEach(lineEl => {
        lineEl.removeAttribute('data-distance');
        lineEl.classList.remove('lyric-line-far');
    });
}

/* ----- Browsing the lyrics by hand ------------------------------------------
 * Phones scroll natively (below). On desktop the lyrics are a moving track
 * inside a clipped panel, so the mouse wheel and touch drags move the track
 * directly. Every line turns sharp and readable while browsing, and after a
 * few seconds without input the track springs back to the sung line. */
const LYRICS_BROWSE_RESUME_MS = 3000;
let desktopBrowseY = 0;
let desktopBrowseTarget = 0;
let desktopBrowseRaf = null;

function readDesktopTrackY() {
    // The track may be mid-spring; start browsing from where it actually is.
    try {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(lyricsContent).transform);
        if (Number.isFinite(matrix.m42)) return matrix.m42;
    } catch (e) { /* 'none' or unsupported */ }
    return desktopLyricsTrackY;
}

function desktopBrowseBounds() {
    const lines = lyricsContent.querySelectorAll('.lyric-line');
    const max = desktopLyricsMaxTopInset();
    const last = lines[lines.length - 1];
    if (!last) return { min: max, max };
    const lastCenter = last.offsetTop + last.offsetHeight / 2;
    return { min: Math.min(max, lyricsScrollArea.clientHeight / 2 - lastCenter), max };
}

function stepDesktopBrowse() {
    desktopBrowseRaf = null;
    if (!isUserScrollingLyrics || !lyricsContent) return;
    const diff = desktopBrowseTarget - desktopBrowseY;
    desktopBrowseY = Math.abs(diff) < 0.4 ? desktopBrowseTarget : desktopBrowseY + diff * 0.24;
    lyricsContent.style.transform = `translateY(${desktopBrowseY.toFixed(1)}px)`;
    if (desktopBrowseY !== desktopBrowseTarget) desktopBrowseRaf = requestAnimationFrame(stepDesktopBrowse);
}

function scheduleLyricsBrowseResume() {
    if (userScrollingLyricsTimeout) clearTimeout(userScrollingLyricsTimeout);
    userScrollingLyricsTimeout = setTimeout(() => {
        userScrollingLyricsTimeout = null;
        stopLyricsBrowsing({ recenter: true });
    }, LYRICS_BROWSE_RESUME_MS);
}

function browseDesktopLyrics(deltaY) {
    if (!isLyricsActive || isLyricEditMode || !lyricsAreSynced || !lyricsContent || !lyricsScrollArea) return false;
    if (window.innerWidth <= 900) return false;
    if (!isUserScrollingLyrics) {
        isUserScrollingLyrics = true;
        desktopBrowseY = readDesktopTrackY();
        desktopBrowseTarget = desktopBrowseY;
        lyricsScrollArea.classList.add('is-user-scrolling');
    }
    const bounds = desktopBrowseBounds();
    desktopBrowseTarget = Math.min(bounds.max, Math.max(bounds.min, desktopBrowseTarget - deltaY));
    if (desktopBrowseRaf === null) desktopBrowseRaf = requestAnimationFrame(stepDesktopBrowse);
    scheduleLyricsBrowseResume();
    return true;
}

function stopLyricsBrowsing({ recenter = true } = {}) {
    if (userScrollingLyricsTimeout) {
        clearTimeout(userScrollingLyricsTimeout);
        userScrollingLyricsTimeout = null;
    }
    if (desktopBrowseRaf !== null) cancelAnimationFrame(desktopBrowseRaf);
    desktopBrowseRaf = null;
    const wasBrowsing = isUserScrollingLyrics;
    isUserScrollingLyrics = false;
    if (lyricsScrollArea) lyricsScrollArea.classList.remove('is-user-scrolling');
    if (recenter && wasBrowsing && isLyricsActive && !isLyricEditMode) scrollToActiveLyric();
}

function handleLyricsWheel(event) {
    if (window.innerWidth <= 900 || event.ctrlKey) return;
    const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? lyricsScrollArea.clientHeight : 1;
    if (browseDesktopLyrics(event.deltaY * unit) && event.cancelable) event.preventDefault();
}

// Touch / pen drags on desktop-sized screens (touch laptops, iPad landscape).
let lyricsDragPointer = null;
let lyricsDragLastY = 0;
function handleLyricsPointerDown(event) {
    if (window.innerWidth <= 900 || event.pointerType === 'mouse') return;
    lyricsDragPointer = event.pointerId;
    lyricsDragLastY = event.clientY;
}
function handleLyricsPointerMove(event) {
    if (event.pointerId !== lyricsDragPointer) return;
    const dy = event.clientY - lyricsDragLastY;
    lyricsDragLastY = event.clientY;
    if (dy) browseDesktopLyrics(-dy);
}
function handleLyricsPointerEnd(event) {
    if (event.pointerId === lyricsDragPointer) lyricsDragPointer = null;
}

function handleLyricsInteraction() {
    if (!isLyricsActive || window.innerWidth > 900) return;
    isUserScrollingLyrics = true;
    // While the finger is browsing, every line is shown sharp and readable
    // (Apple Music behaviour); depth/blur returns when auto-follow resumes.
    if (lyricsScrollArea) lyricsScrollArea.classList.add('is-user-scrolling');
    if (userScrollingLyricsTimeout) clearTimeout(userScrollingLyricsTimeout);
    userScrollingLyricsTimeout = setTimeout(() => {
        isUserScrollingLyrics = false;
        userScrollingLyricsTimeout = null;
        if (lyricsScrollArea) lyricsScrollArea.classList.remove('is-user-scrolling');
        if (isLyricsActive && !isLyricEditMode) scrollToActiveLyric();
    }, 3000); // Resume auto-scroll after 3 seconds of no manual interaction
}

/* Lyrics open animation (phones / tablets).
 * The old CSS gave .lyric-line:nth-child(1..20) increasing delays and every
 * other line none. The view opens scrolled to the current line, so mid-song
 * the lines on screen were a mix of "wait up to 1s" and "appear instantly" -
 * half the screen animated, half did not. Now exactly the lines that are on
 * screen are staggered top-to-bottom; off-screen lines are left alone. The
 * class only drives a transition, so the line lands on its real depth
 * (opacity / scale / blur) instead of snapping from a keyframe end state. */
let lyricsEntranceTimers = [];
function clearLyricsEntrance() {
    lyricsEntranceTimers.forEach(clearTimeout);
    lyricsEntranceTimers = [];
    if (lyricsContent) {
        lyricsContent.querySelectorAll('.lyric-pre-enter').forEach(el => el.classList.remove('lyric-pre-enter'));
    }
}

function playLyricsEntrance() {
    clearLyricsEntrance();
    if (!lyricsContent || !lyricsScrollArea || window.innerWidth > 900 || isLyricEditMode) return;
    const reduced = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
        document.documentElement.classList.contains('lyrics-no-motion');
    if (reduced) return;

    const area = lyricsScrollArea.getBoundingClientRect();
    if (area.height <= 0) return;
    const visible = Array.from(lyricsContent.querySelectorAll('.lyric-line, .lyrics-loading, .lyrics-unsynced-note'))
        .filter(el => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.bottom > area.top - 24 && r.top < area.bottom + 24;
        });
    if (!visible.length) return;

    visible.forEach(el => el.classList.add('lyric-pre-enter'));
    void lyricsContent.offsetHeight; // commit the hidden state before revealing
    visible.forEach((el, i) => {
        lyricsEntranceTimers.push(setTimeout(() => el.classList.remove('lyric-pre-enter'), 60 + Math.min(i * 45, 420)));
    });
}

if (lyricsScrollArea) {
    lyricsScrollArea.addEventListener('wheel', handleLyricsInteraction, { passive: true });
    lyricsScrollArea.addEventListener('wheel', handleLyricsWheel, { passive: false });
    lyricsScrollArea.addEventListener('touchmove', handleLyricsInteraction, { passive: true });
    lyricsScrollArea.addEventListener('pointerdown', handleLyricsPointerDown);
    lyricsScrollArea.addEventListener('pointermove', handleLyricsPointerMove);
    lyricsScrollArea.addEventListener('pointerup', handleLyricsPointerEnd);
    lyricsScrollArea.addEventListener('pointercancel', handleLyricsPointerEnd);
}

if (btnLyrics) {
    btnLyrics.addEventListener('click', () => {
        isLyricsActive = true;
        isUserScrollingLyrics = false;
        standardContainer.classList.add('hidden');
        lyricsContainer.classList.remove('hidden');
        const contentArea = document.querySelector('.dedicated-player-content');
        if (contentArea) contentArea.classList.add('lyrics-active-view');
        document.body.classList.add('lyrics-view-active');
        if (lyricsScrollArea) lyricsScrollArea.classList.remove('is-user-scrolling');
        updateActiveLyric(true);
        startDesktopLyricsSync();
        playLyricsEntrance();
        _acquireWakeLock(); // Keep screen on while reading lyrics
    });
}

function deactivateLyricsView({ resetLineDepth = true } = {}) {
    if (isLyricEditMode && typeof closeLyricEditor === 'function') {
        if (lyricEditorState.dirty) showToast('Unsaved lyric edits were discarded', 'error');
        closeLyricEditor({ render: true });
    }
    isLyricsActive = false;
    activeLyricIndex = -1;
    clearLyricsEntrance();
    stopLyricsBrowsing({ recenter: false });
    stopDesktopLyricsSync();
    resetDesktopLyricsPresentation({ resetLineDepth });
    isUserScrollingLyrics = false;
    if (userScrollingLyricsTimeout) {
        clearTimeout(userScrollingLyricsTimeout);
        userScrollingLyricsTimeout = null;
    }
    if (lyricsContainer) lyricsContainer.classList.add('hidden');
    if (standardContainer) standardContainer.classList.remove('hidden');
    const contentArea = document.querySelector('.dedicated-player-content');
    if (contentArea) contentArea.classList.remove('lyrics-active-view');
    document.body.classList.remove('lyrics-view-active');
    _releaseWakeLock();
}

if (btnCloseLyrics) {
    btnCloseLyrics.addEventListener('click', () => {
        deactivateLyricsView();
    });
}

/* ========== DEDICATED PLAYER & LYRICS SWIPE GESTURES ========== */
(function setupDedicatedPlayerGestures() {
    const dedicatedView = document.getElementById('dedicated-player-view');
    if (!dedicatedView || !playerSection) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let isGestureIgnored = false;
    let isPullingDown = false;
    let currentPullY = 0;
    let lastMoveTime = 0;
    let lastMoveY = 0;
    let currentVelocity = 0;

    let lastMoveX = 0;
    let touchStartedInLyrics = false;

    dedicatedView.addEventListener('touchstart', e => {
        if (!document.body.classList.contains('player-section-active') || isClosingMobilePlayer) return;
        if (isDesktopPlayerOverlayEnabled()) return;
        if (e.touches.length !== 1) {
            isGestureIgnored = true;
            return;
        }

        const target = e.target;
        // Never hijack progress sliders, volume sliders, buttons, inputs, links, or the lyrics editor
        if (isLyricEditMode || target.closest('.dedicated-progress-bar-wrapper, .progress-bar-wrapper, .volume-slider, button, input, textarea, a, .lyric-editor, .lyric-editor-footer')) {
            isGestureIgnored = true;
            return;
        }

        isGestureIgnored = false;
        isPullingDown = false;
        currentPullY = 0;
        currentVelocity = 0;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        lastMoveX = touchStartX;
        lastMoveY = touchStartY;
        touchStartTime = Date.now();
        // In the lyrics view only the lyric list scrolls. A drag that starts
        // anywhere above it (grabber, "Now Playing", the gaps around the
        // Close / Find / Edit pills) always pulls the sheet down.
        touchStartedInLyrics = Boolean(isLyricsActive && lyricsScrollArea && lyricsScrollArea.contains(target));
        lastMoveTime = touchStartTime;
    }, { passive: true });

    dedicatedView.addEventListener('touchmove', e => {
        if (isGestureIgnored || !document.body.classList.contains('player-section-active') || isClosingMobilePlayer) return;
        if (isDesktopPlayerOverlayEnabled()) return;
        if (!e.touches || e.touches.length === 0) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const deltaX = currentX - touchStartX;
        const deltaY = currentY - touchStartY;
        const absX = Math.abs(deltaX);

        if (!isPullingDown) {
            // Horizontal motion (e.g. lyrics switch back)
            if (absX > 10 && absX > Math.abs(deltaY)) {
                if (isLyricsActive && deltaX > 0 && e.cancelable) {
                    e.preventDefault();
                }
                lastMoveX = currentX;
                return;
            }

            // Check if pulling downwards predominantly
            if (deltaY > 8 && deltaY > absX * 1.1) {
                // Inside the lyric list: scroll the lyrics, unless they are
                // already at the very top (then the pull closes the player,
                // like Apple Music). Above the list: always close.
                if (touchStartedInLyrics && lyricsScrollArea.scrollTop > 0) {
                    return;
                }
                isPullingDown = true;
                playerSection.style.willChange = 'transform';
                const prevSec = previousSectionId ? document.getElementById(previousSectionId) : document.getElementById('trending-section');
                if (prevSec) {
                    prevSec.classList.remove('hidden', 'fade-in-animate');
                    freezeSectionEntrance(prevSec);
                }

                document.body.classList.add('player-is-dismissing');
                playerSection.classList.add('player-dismissing');
            }
        }

        if (isPullingDown) {
            if (e.cancelable) e.preventDefault();

            // Calculate instantaneous velocity for flick detection
            const now = Date.now();
            const timeStep = now - lastMoveTime;
            if (timeStep > 0) {
                currentVelocity = (currentY - lastMoveY) / timeStep;
                lastMoveTime = now;
                lastMoveY = currentY;
            }

            // Direct 1:1 finger tracking
            if (deltaY < 0) {
                // High rubber-band resistance when dragging above top
                currentPullY = deltaY * 0.15;
            } else {
                currentPullY = deltaY;
            }

            const clampedY = Math.max(0, currentPullY);
            playerSection.style.transition = 'none';
            playerSection.style.transform = `translate3d(0, ${clampedY}px, 0)`;

            // Apple Music / Spotify sheet styling
            const radius = Math.min(32, Math.max(0, clampedY * 0.22));
            playerSection.style.borderTopLeftRadius = `${radius}px`;
            playerSection.style.borderTopRightRadius = `${radius}px`;
            playerSection.style.boxShadow = clampedY > 2 ? '0 -12px 48px rgba(0, 0, 0, 0.75)' : '';
        }
    }, { passive: false });

    dedicatedView.addEventListener('touchend', e => {
        if (!document.body.classList.contains('player-section-active') || isClosingMobilePlayer) return;
        if (isDesktopPlayerOverlayEnabled()) return;
        if (!e.changedTouches || e.changedTouches.length === 0) return;

        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        const deltaX = touchEndX - touchStartX;
        const deltaY = touchEndY - touchStartY;
        const absX = Math.abs(deltaX);

        if (!isPullingDown) {
            // Swipe Left-to-Right in Lyrics view to go back to album art view
            if (!isGestureIgnored && isLyricsActive && deltaX > 35 && absX > Math.abs(deltaY)) {
                deactivateLyricsView();
            }
            return;
        }

        playerSection.style.willChange = '';
        if (isGestureIgnored) return;

        isPullingDown = false;
        const totalDuration = Math.max(1, Date.now() - touchStartTime);
        const overallVelocity = deltaY / totalDuration;
        const effectiveVelocity = Math.max(overallVelocity, currentVelocity);

        // Apple Music / Spotify threshold: dragged down > 120px OR flicked down with velocity > 0.4 px/ms
        if (currentPullY > 120 || (currentPullY > 30 && effectiveVelocity > 0.4)) {
            dismissDedicatedPlayerMobile(currentPullY, effectiveVelocity);
        } else {
            // Snaps back smoothly if let go early
            snapBackDedicatedPlayerMobile();
        }
    }, { passive: true });

    dedicatedView.addEventListener('touchcancel', () => {
        if (isPullingDown) {
            isPullingDown = false;
            snapBackDedicatedPlayerMobile();
        } else if (isLyricsActive && !isGestureIgnored) {
            const lastDeltaX = (lastMoveX || touchStartX) - touchStartX;
            if (lastDeltaX > 35) {
                deactivateLyricsView();
            }
        }
    }, { passive: true });
})();

function updateActiveLyric(immediate = false) {
    if (!isLyricsActive || !lyricsContent) return;
    // The editor has its own lightweight "now playing" marker; never apply the
    // desktop depth/visibility classes to editor rows (that hid them before).
    if (isLyricEditMode) {
        if (typeof lyricEditorOnTimeUpdate === 'function') lyricEditorOnTimeUpdate();
        return;
    }
    const data = lyricsData;
    if (!lyricsAreSynced || data.length === 0) return;

    const currentTime = audio.currentTime;
    let activeIndex = -1;

    // Find the current active line
    for (let i = 0; i < data.length; i++) {
        if (currentTime >= data[i].time) {
            activeIndex = i;
        } else {
            break;
        }
    }

    // If the song has no lyrics before the first line, keep the first line active
    if (activeIndex === -1 && data.length > 0 && currentTime < data[0].time) {
        activeIndex = 0;
    }

    if (activeIndex !== -1) {
        if (activeIndex === activeLyricIndex) return;

        const currentActiveEl = lyricsContent.querySelector('.lyric-line.active');
        const lineElements = Array.from(lyricsContent.querySelectorAll('.lyric-line'));
        const newActiveEl = lineElements[activeIndex];
        if (!newActiveEl) return;

        if (window.innerWidth > 900) {
            if (activeLyricIndex !== activeIndex || currentActiveEl !== newActiveEl || newActiveEl.dataset.distance !== '0') {
                setDesktopLyricDepth(lineElements, activeIndex);
                scrollToActiveLyric(newActiveEl, immediate || !currentActiveEl);
                startDesktopLyricsSync();
            }
        } else if (activeLyricIndex !== activeIndex || currentActiveEl !== newActiveEl) {
            // Phones get the same depth model as desktop (data-distance drives
            // opacity / scale / blur in mobile_app.css) but keep native
            // scrolling so the lyrics can still be browsed with a finger.
            setDesktopLyricDepth(lineElements, activeIndex);
            scrollToActiveLyric(newActiveEl, immediate || !currentActiveEl);
            // Switch exactly on time rather than on the next coarse
            // 'timeupdate' (up to ~250ms late).
            startDesktopLyricsSync();
        }
    }
}

function scrollToActiveLyric(activeEl = null, immediate = false) {
    if (!lyricsScrollArea || !lyricsContent || isLyricEditMode) return;

    if (!activeEl) {
        activeEl = lyricsContent.querySelector('.lyric-line.active');
    }

    if (activeEl) {
        if (window.innerWidth > 900) {
            centerDesktopLyric(activeEl, immediate);
            return;
        }
        if (isUserScrollingLyrics) return;

        // Always scroll within the lyricsScrollArea container.
        // On mobile the lyrics container is now a fixed overlay so
        // lyricsScrollArea is the correct scroll parent (no more window-level scrolling).
        const containerHeight = lyricsScrollArea.clientHeight;
        if (containerHeight <= 0) return;

        const settled = lyricSettledGeometry(activeEl);
        const activeHeight = settled.height;
        const edgePadding = Math.max(40, Math.round((containerHeight - activeHeight) / 2));
        // Bottom padding allows the final lyric lines to scroll into the center
        lyricsContent.style.setProperty('--lyrics-scroll-padding', `${edgePadding}px`);

        const scrollAreaRect = lyricsScrollArea.getBoundingClientRect();
        const activeRect = activeEl.getBoundingClientRect();

        const relativeTop = (activeRect.top - scrollAreaRect.top) + lyricsScrollArea.scrollTop - settled.shift;

        // When the song is near the beginning, start cleanly at top (scrollTop: 0)
        const rawTarget = relativeTop - (containerHeight / 2) + (activeHeight / 2);
        const target = Math.max(0, Math.round(rawTarget));
        if (immediate) {
            // The scroller has `scroll-behavior: smooth` in CSS, which also
            // applies to behavior:'auto'. Opening lyrics mid-song therefore
            // glided down from the top, and the entrance animation ran on
            // lines that were then scrolled away. Jump for real instead.
            const previous = lyricsScrollArea.style.scrollBehavior;
            lyricsScrollArea.style.scrollBehavior = 'auto';
            lyricsScrollArea.scrollTop = target;
            lyricsScrollArea.style.scrollBehavior = previous;
        } else {
            lyricsScrollArea.scrollTo({ top: target, behavior: 'smooth' });
        }
    }
}

// Ensure resize events adjust scroll if lyrics are open
window.addEventListener('resize', () => {
    if (isLyricsActive && !isLyricEditMode) {
        if (window.innerWidth > 900) {
            startDesktopLyricsSync();
            const activeEl = lyricsContent?.querySelector('.lyric-line.active');
            const activeIndex = Number(activeEl?.dataset.index);
            if (Number.isFinite(activeIndex)) {
                const lineElements = Array.from(lyricsContent.querySelectorAll('.lyric-line'));
                setDesktopLyricDepth(lineElements, activeIndex);
                centerDesktopLyric(activeEl, true);
            }
        } else {
            startDesktopLyricsSync();
            resetDesktopLyricsPresentation({ resetLineDepth: false });
            const activeEl = lyricsContent?.querySelector('.lyric-line.active');
            const activeIndex = Number(activeEl?.dataset.index);
            if (Number.isFinite(activeIndex)) {
                setDesktopLyricDepth(Array.from(lyricsContent.querySelectorAll('.lyric-line')), activeIndex);
            }
            scrollToActiveLyric(activeEl, true);
        }
    }
});

// The toggleMute and scroll handling is already implemented above, commenting out duplicate logic
/*
volIcon.addEventListener('click', () => {
    if (audio.volume > 0) {
        lastVolume    = audio.volume;
        audio.volume  = 0;
        volSlider.value = 0;
    } else {
        audio.volume    = lastVolume > 0.1 ? lastVolume : 0.5;
        volSlider.value = audio.volume * 100;
    }
    volSlider.dispatchEvent(new Event('input'));
});

volSlider.addEventListener('input', e => {
    const val    = e.target.value;
    audio.volume = val / 100;
    if      (val == 0)  volIcon.className = 'bx bx-volume-mute';
    else if (val < 50)  volIcon.className = 'bx bx-volume-low';
    else                volIcon.className = 'bx bx-volume-full';
});
*/

/* ========== COVER EXPAND OVERLAY ========== */

const coverOverlay    = document.getElementById('cover-expand-overlay');
const coverExpandImg  = document.getElementById('cover-expand-img');
const coverExpandTitle  = document.querySelector('.cover-expand-title');
const coverExpandArtist = document.querySelector('.cover-expand-artist');

function openCoverExpand() {
    if (!coverOverlay || !coverExpandImg) return;
    coverExpandImg.src = dedicatedImg ? dedicatedImg.src : playerImg.src;
    if (coverExpandTitle)  coverExpandTitle.textContent  = dedicatedTitle ? dedicatedTitle.textContent : playerTitle.textContent;
    if (coverExpandArtist) coverExpandArtist.textContent = dedicatedArtist ? dedicatedArtist.textContent : playerArtist.textContent;
    coverOverlay.classList.add('show');
}

function closeCoverExpand() {
    if (coverOverlay) coverOverlay.classList.remove('show');
}

if (dedicatedImg) {
    dedicatedImg.addEventListener('click', openCoverExpand);

    // Dynamic 3D tilt and shine based on mouse position.
    //
    // Desktop only. Touch devices synthesise a mousemove on tap, which would
    // apply the tilt transform and leave it stuck (mouseleave often never
    // fires from a touch), so the artwork would sit permanently rotated and
    // scaled. The matching CSS is gated behind the same media query.
    const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const dedicatedArtContainer = dedicatedImg.closest('.dedicated-art-container');
    if (dedicatedArtContainer && supportsHover) {
        let tiltRect = null;
        let tiltFrame = null;
        let pointerX = 0;
        let pointerY = 0;

        dedicatedArtContainer.addEventListener('mouseenter', () => {
            tiltRect = dedicatedArtContainer.getBoundingClientRect();
        });
        dedicatedArtContainer.addEventListener('mousemove', (e) => {
            pointerX = e.clientX;
            pointerY = e.clientY;
            if (tiltFrame) return;
            tiltFrame = requestAnimationFrame(() => {
                tiltFrame = null;
                const rect = tiltRect || dedicatedArtContainer.getBoundingClientRect();
                const x = pointerX - rect.left;
                const y = pointerY - rect.top;
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                const rotateX = ((y - centerY) / centerY) * -8;
                const rotateY = ((x - centerX) / centerX) * 8;
                const angle = Math.atan2(y - centerY, x - centerX) * (180 / Math.PI) - 90;

                dedicatedArtContainer.style.setProperty('--shine-deg', `${angle}deg`);
                dedicatedArtContainer.style.transform = `scale(1.03) perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
            });
        });

        dedicatedArtContainer.addEventListener('mouseleave', () => {
            tiltRect = null;
            if (tiltFrame) cancelAnimationFrame(tiltFrame);
            tiltFrame = null;
            dedicatedArtContainer.style.transform = '';
        });
    }
}

if (coverOverlay) {
    coverOverlay.addEventListener('click', e => {
        if (e.target === coverOverlay || e.target === coverExpandImg) closeCoverExpand();
    });
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCoverExpand();
});

/* ========== EQUALIZER (Simple 3-band) ========== */

const btnEq = document.getElementById('btn-eq');
const eqPopup = document.getElementById('eq-popup');
const eqToggle = document.getElementById('eq-toggle');
const eqPresetSelect = document.getElementById('eq-preset-select');
const eqLow = document.getElementById('eq-low');
const eqMid = document.getElementById('eq-mid');
const eqHigh = document.getElementById('eq-high');

let audioContext = null;
let mediaElementSource = null;
let eqNodes = {};
let isEqEnabled = false;
let analyserNode = null;

const EQ_PRESETS = {
    'custom': null,
    'flat': { low: 0, mid: 0, high: 0 },
    'bass-boost': { low: 8, mid: 0, high: 2 },
    'vocal': { low: -2, mid: 6, high: 2 },
    'electronic': { low: 6, mid: -2, high: 6 },
    'rock': { low: 5, mid: -1, high: 4 }
};

// Setup EQ nodes
function initEq() {
    if (audioContext) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    buildAudioGraph(new AudioContext());
}

/* One audio graph serves both the equalizer and the beat analyser (the
 * background pulse and progress-bar glow in playerfx.js). The analyser is a
 * passive tap: it is never connected to the speakers, so it can't change what
 * you hear. Once an <audio> element is routed through Web Audio it stays
 * routed, which is why the graph is only ever built once. */
function buildAudioGraph(context) {
    audioContext = context;

    // <audio crossorigin="anonymous"> means streams already need CORS to play,
    // so routing them through Web Audio can't silence them.
    mediaElementSource = audioContext.createMediaElementSource(audio);

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.5;

    // Create filters
    eqNodes.low = audioContext.createBiquadFilter();
    eqNodes.low.type = 'lowshelf';
    eqNodes.low.frequency.value = 320;
    eqNodes.low.gain.value = 0;

    eqNodes.mid = audioContext.createBiquadFilter();
    eqNodes.mid.type = 'peaking';
    eqNodes.mid.frequency.value = 1000;
    eqNodes.mid.Q.value = 0.5;
    eqNodes.mid.gain.value = 0;

    eqNodes.high = audioContext.createBiquadFilter();
    eqNodes.high.type = 'highshelf';
    eqNodes.high.frequency.value = 3200;
    eqNodes.high.gain.value = 0;

    // Connect original path first (bypassed)
    mediaElementSource.connect(audioContext.destination);

    // Update visual state based on toggle
    updateEqRoute();
}

/* Beat analysis is skipped on iPhone / iPad (and in the iOS app): routing the
 * audio element through Web Audio there stops music when the screen locks. */
function audioAnalysisSupported() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) return false;
    const ua = navigator.userAgent || '';
    const iOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return !iOS;
}

let _analyserPromise = null;
/** Resolves to the AnalyserNode, or null when analysis isn't available. */
function ensureAudioAnalyser() {
    if (analyserNode) return Promise.resolve(analyserNode);
    if (!audioAnalysisSupported()) return Promise.resolve(null);
    if (_analyserPromise) return _analyserPromise;
    _analyserPromise = (async () => {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContext();
        // Never route the music into a context that isn't running yet - that
        // would mute it. Browsers start one only after a user gesture.
        if (context.state !== 'running') {
            try { await Promise.race([context.resume(), new Promise(r => setTimeout(r, 800))]); } catch (e) { /* stays suspended */ }
        }
        if (context.state !== 'running' || analyserNode || audioContext) {
            context.close().catch(() => {});
            return analyserNode;
        }
        buildAudioGraph(context);
        return analyserNode;
    })().finally(() => { _analyserPromise = null; });
    return _analyserPromise;
}

window.StreamifyAudio = Object.freeze({
    ensureAnalyser: ensureAudioAnalyser,
    get analyser() { return analyserNode; },
    get context() { return audioContext; },
    supported: audioAnalysisSupported
});

function updateEqRoute() {
    if (!audioContext) return;

    // Disconnect existing
    mediaElementSource.disconnect();
    eqNodes.low.disconnect();
    eqNodes.mid.disconnect();
    eqNodes.high.disconnect();

    // Passive tap for the beat analyser (survives every re-route).
    if (analyserNode) mediaElementSource.connect(analyserNode);

    if (isEqEnabled) {
        // Connect through EQ
        mediaElementSource.connect(eqNodes.low);
        eqNodes.low.connect(eqNodes.mid);
        eqNodes.mid.connect(eqNodes.high);
        eqNodes.high.connect(audioContext.destination);

        // Enable sliders visually
        [eqLow, eqMid, eqHigh].forEach(slider => slider.classList.remove('disabled'));
    } else {
        // Bypass EQ
        mediaElementSource.connect(audioContext.destination);

        // Disable sliders visually
        [eqLow, eqMid, eqHigh].forEach(slider => slider.classList.add('disabled'));
    }
}

// Event listeners for UI
if (btnEq) {
    btnEq.addEventListener('click', (e) => {
        e.stopPropagation();
        eqPopup.classList.toggle('hidden');

        // Initialize EQ on first interaction
        if (!eqPopup.classList.contains('hidden') && !audioContext) {
            initEq();
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
        }
    });
}

// Close popup when clicking outside
document.addEventListener('click', (e) => {
    if (eqPopup && !eqPopup.classList.contains('hidden') && !eqPopup.contains(e.target) && e.target !== btnEq && !btnEq.contains(e.target)) {
        eqPopup.classList.add('hidden');
    }
});

if (eqToggle) {
    eqToggle.addEventListener('change', (e) => {
        isEqEnabled = e.target.checked;
        if (isEqEnabled && !audioContext) initEq();
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume();
        }
        updateEqRoute();
        btnEq.style.color = isEqEnabled ? 'var(--accent)' : '#b3b3b3';

        // Update gains to match current sliders when enabling
        if (isEqEnabled && audioContext) {
            eqNodes.low.gain.value = parseFloat(eqLow.value);
            eqNodes.mid.gain.value = parseFloat(eqMid.value);
            eqNodes.high.gain.value = parseFloat(eqHigh.value);
        }
    });
}

// Slider events
const updateGain = (node, value) => {
    if (node) node.gain.value = parseFloat(value);
};

const handleSliderInput = (e, node) => {
    if (eqPresetSelect && eqPresetSelect.value !== 'custom') {
        eqPresetSelect.value = 'custom';
    }
    if (isEqEnabled) updateGain(node, e.target.value);
};

if (eqLow) eqLow.addEventListener('input', (e) => handleSliderInput(e, eqNodes.low));
if (eqMid) eqMid.addEventListener('input', (e) => handleSliderInput(e, eqNodes.mid));
if (eqHigh) eqHigh.addEventListener('input', (e) => handleSliderInput(e, eqNodes.high));

if (eqPresetSelect) {
    eqPresetSelect.addEventListener('change', (e) => {
        const preset = EQ_PRESETS[e.target.value];
        if (preset) {
            eqLow.value = preset.low;
            eqMid.value = preset.mid;
            eqHigh.value = preset.high;

            if (isEqEnabled && audioContext) {
                eqNodes.low.gain.value = preset.low;
                eqNodes.mid.gain.value = preset.mid;
                eqNodes.high.gain.value = preset.high;
            }
        }
    });
}

// Resume context if suspended
audio.addEventListener('play', () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
});

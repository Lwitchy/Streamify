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
const btnEditLyrics = document.getElementById('edit-lyrics-btn');
const btnSaveLyrics = document.getElementById('save-lyrics-btn');
const btnClearLyrics = document.getElementById('clear-lyrics-btn');
const btnCancelLyrics = document.getElementById('cancel-lyric-edit-btn');
const editorControls = document.getElementById('lyric-editor-controls');
const lyricsScrollArea = document.getElementById('lyrics-scroll-area');
const lyricsContent = document.getElementById('lyrics-content');

// Lyrics Selection UI
const btnReRequestLyrics = document.getElementById('re-request-lyrics-btn');
const lyricsSelectionModal = document.getElementById('lyrics-selection-modal');
const closeLyricsSelectionModal = document.getElementById('close-lyrics-selection-modal');
const lyricsSearchTitle = document.getElementById('lyrics-search-title');
const lyricsSearchArtist = document.getElementById('lyrics-search-artist');
const lyricsSearchBtn = document.getElementById('lyrics-search-btn');
const lyricsSelectionResults = document.getElementById('lyrics-selection-results');
const lyricsSelectionLoading = document.getElementById('lyrics-selection-loading');
const lyricsSelectionEmpty = document.getElementById('lyrics-selection-empty');

let isLyricEditMode = false;
let tempLyricsData = [];
let originalLyricsData = []; // To restore on cancel
let _lyricsFetchAbort = null;
let _lyricsSearchAbort = null;
let _lyricsSelectionAbort = null;

/* Set gradient placeholder until a song is playing */
if (playerImg) playerImg.src = COVER_PLACEHOLDER;
if (dedicatedImg) dedicatedImg.src = COVER_PLACEHOLDER;

/* --- Seek guard --- */
let canSeek = false;
let lastWidgetUpdateTime = 0;

// Telemetry state
let telemetrySongId = null;
let lastTimeUpdateValue = 0;
let accumulatedTelemetryTime = 0;
let totalTelemetryTime = 0;
let hasCountedPlay = false;

function flushTelemetry() {
    if (accumulatedTelemetryTime > 0 && telemetrySongId) {
        const isPlay = totalTelemetryTime >= 30 && !hasCountedPlay;
        if (isPlay) hasCountedPlay = true;

        if (typeof window.reportTelemetry === 'function') {
            window.reportTelemetry(telemetrySongId, accumulatedTelemetryTime, isPlay);
        }
    }
    accumulatedTelemetryTime = 0;
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

function loadSong(song) {
    flushTelemetry();
    telemetrySongId = song.id;
    hasCountedPlay = false;
    lastTimeUpdateValue = 0;
    totalTelemetryTime = 0;

    playerTitle.textContent = song.title;
    playerArtist.textContent = song.artist; // No badge in mini player

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

    // Start the authenticated media request before secondary lyric work.
    try { audio.load(); } catch (e) { /* ignore */ }
    canSeek = false;

    resetLyrics();
    fetchLyrics(song.title, song.artist, song.id, song.playlistOwner);

    progressBar.style.width = '0%';
    currTimeEl.textContent = '0:00';
    if (dedicatedProgressBar) dedicatedProgressBar.style.width = '0%';
    if (dedicatedCurrTimeEl) dedicatedCurrTimeEl.textContent = '0:00';

    /* Highlight the new row if it exists in the current view */
    // Clear all existing highlights across the entire app
    document.querySelectorAll('.song-row.playing').forEach(r => r.classList.remove('playing'));

    // Target the specific section that is currently visible
    const activeSection = document.querySelector('section:not(.hidden)');
    if (activeSection) {
        // Find visible rows specifically in this section, ignoring headers
        const rows = activeSection.querySelectorAll('.song-row:not(.header-row)');
        const realIndex = getCurrentRealIndex();
        if (rows[realIndex]) {
            rows[realIndex].classList.add('playing');
        }
    }

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

function syncPlaybackUI(playing) {
    isPlaying = playing;
    const playbackLabel = playing ? 'Pause' : 'Play';
    btnPlay.innerHTML = playing
        ? "<i class='bx bx-pause' style='margin-left:0;'></i>"
        : "<i class='bx bx-play' style='margin-left:2px;'></i>";
    btnPlay.setAttribute('aria-label', playbackLabel);
    if (dedicatedBtnPlay) {
        dedicatedBtnPlay.innerHTML = playing
            ? "<i class='bx bx-pause' style='margin-left:0;'></i>"
            : "<i class='bx bx-play' style='margin-left:4px;'></i>";
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
    activePlaylist = [...currentPlaylist];
    activeShuffledPlaylist = [...shuffledPlaylist];
    _playSongFromPlaylist(index, activePlaylist, activeShuffledPlaylist);
}

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
    _playSongFromPlaylist(getCurrentRealIndex(), activePlaylist, activeShuffledPlaylist);
    return true;
}

function prevSong() {
    if (activePlaylist.length === 0) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }

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
    flushTelemetry();
    if (repeatMode === 2) {
        audio.currentTime = 0;
        playSong();
    } else if (!nextSong()) {
        syncPlaybackUI(false);
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
audio.addEventListener('error', () => {
    syncPlaybackUI(false);
    if (window.OfflineStore && telemetrySongId) {
        window.OfflineStore.getOfflineSong(telemetrySongId).then(cachedSong => {
            if (cachedSong) {
                console.log('[PLAYBACK] Streaming audio error, falling back to offline copy');
                loadSong(cachedSong);
                playSong();
                return;
            }
            if (audio.currentSrc || audio.src) showToast('This song could not be played.', 'error');
        }).catch(() => {
            if (audio.currentSrc || audio.src) showToast('This song could not be played.', 'error');
        });
    } else {
        if (audio.currentSrc || audio.src) showToast('This song could not be played.', 'error');
    }
});

const fmt = t => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${s < 10 ? '0' + s : s}`; };

audio.addEventListener('loadedmetadata', () => {
    canSeek = true;
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

window.addEventListener('beforeunload', () => {
    flushTelemetry();
});

audio.addEventListener('timeupdate', e => {
    const { duration, currentTime } = e.srcElement;

    // Telemetry time accumulation
    if (!audio.paused && currentTime > lastTimeUpdateValue && (currentTime - lastTimeUpdateValue) < 2) {
        // Accumulate delta if playback is normal (not seeking backwards, not seeking far forward)
        const delta = currentTime - lastTimeUpdateValue;
        accumulatedTelemetryTime += delta;
        totalTelemetryTime += delta;
    }
    lastTimeUpdateValue = currentTime;

    if (accumulatedTelemetryTime >= 10) {
        flushTelemetry();
    }

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

/* --- Lyric Editor Listeners --- */
if (btnEditLyrics) btnEditLyrics.addEventListener('click', toggleLyricEditor);
if (btnSaveLyrics) btnSaveLyrics.addEventListener('click', saveLyricsToServer);
if (btnClearLyrics) btnClearLyrics.addEventListener('click', clearLyricsFromServer);
if (btnCancelLyrics) btnCancelLyrics.addEventListener('click', cancelLyricEdit);

/* --- Lyrics Selection Listeners --- */
function openLyricsSearchModal() {
    if (!window.currentlyPlayingSongId) return;
    if (_lyricsFetchAbort) _lyricsFetchAbort.abort();
    _lyricsFetchAbort = null;
    const currentTitle = document.getElementById('dedicated-player-title')?.textContent || '';
    const currentArtist = document.getElementById('dedicated-player-artist')?.textContent || '';

    const cleaned = cleanMetadata(currentTitle, currentArtist);

    lyricsSearchTitle.value = cleaned.title;
    lyricsSearchArtist.value = cleaned.artist !== 'Unknown Artist' ? cleaned.artist : '';

    lyricsSelectionResults.innerHTML = '';
    lyricsSelectionLoading.classList.add('hidden');
    lyricsSelectionEmpty.classList.add('hidden');
    lyricsSelectionModal.classList.remove('hidden');

    performLyricsSearch();
}

if (btnReRequestLyrics) {
    btnReRequestLyrics.addEventListener('click', openLyricsSearchModal);
}
if (btnFindLyrics) {
    btnFindLyrics.addEventListener('click', openLyricsSearchModal);
}

if (closeLyricsSelectionModal) {
    closeLyricsSelectionModal.addEventListener('click', () => {
        if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
        _lyricsSearchAbort = null;
        lyricsSelectionModal.classList.add('hidden');
    });
}

if (lyricsSearchBtn) {
    lyricsSearchBtn.addEventListener('click', performLyricsSearch);
}
if (lyricsSearchTitle) {
    lyricsSearchTitle.addEventListener('keypress', e => {
        if (e.key === 'Enter') performLyricsSearch();
    });
}
if (lyricsSearchArtist) {
    lyricsSearchArtist.addEventListener('keypress', e => {
        if (e.key === 'Enter') performLyricsSearch();
    });
}

async function performLyricsSearch() {
    const title = lyricsSearchTitle.value.trim();
    const artist = lyricsSearchArtist.value.trim();
    const songId = window.currentlyPlayingSongId;

    if (!title || !songId) return;

    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    const controller = new AbortController();
    _lyricsSearchAbort = controller;

    lyricsSelectionLoading.classList.remove('hidden');
    lyricsSelectionResults.innerHTML = '';
    lyricsSelectionEmpty.classList.add('hidden');

    try {
        const url = new URL('https://lrclib.net/api/search');
        url.searchParams.append('q', `${title} ${artist}`.trim());

        const response = await fetch(url, { signal: controller.signal });
        if (_lyricsSearchAbort !== controller || songId !== window.currentlyPlayingSongId || lyricsSelectionModal.classList.contains('hidden')) return;
        if (response.ok) {
            const results = await response.json();
            if (_lyricsSearchAbort !== controller || songId !== window.currentlyPlayingSongId || lyricsSelectionModal.classList.contains('hidden')) return;
            lyricsSelectionLoading.classList.add('hidden');

            if (results && results.length > 0) {
                renderLyricsSelectionResults(results, songId);
            } else {
                lyricsSelectionEmpty.classList.remove('hidden');
            }
        } else {
            lyricsSelectionLoading.classList.add('hidden');
            lyricsSelectionEmpty.classList.remove('hidden');
        }
    } catch (e) {
        if (e.name === 'AbortError' || _lyricsSearchAbort !== controller) return;
        console.error("Lyrics search failed:", e);
        lyricsSelectionLoading.classList.add('hidden');
        lyricsSelectionEmpty.classList.remove('hidden');
    } finally {
        if (_lyricsSearchAbort === controller) _lyricsSearchAbort = null;
    }
}

function renderLyricsSelectionResults(results, songId) {
    lyricsSelectionResults.innerHTML = '';

    results.forEach(result => {
        const resultItem = document.createElement('div');
        resultItem.style.cssText = `
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;

        const infoDiv = document.createElement('div');
        const titleSpan = document.createElement('div');
        titleSpan.style.fontWeight = 'bold';
        titleSpan.textContent = result.name || 'Unknown Title';

        const artistSpan = document.createElement('div');
        artistSpan.style.fontSize = '12px';
        artistSpan.style.color = '#b3b3b3';
        const durationStr = result.duration ? Math.floor(result.duration / 60) + ':' + String(result.duration % 60).padStart(2, '0') : '?';
        artistSpan.textContent = `${result.artistName || 'Unknown Artist'} \u2022 ${result.albumName || 'Unknown Album'} (${durationStr})`;

        const typeSpan = document.createElement('div');
        typeSpan.style.fontSize = '11px';
        typeSpan.style.marginTop = '4px';

        if (result.syncedLyrics) {
            typeSpan.innerHTML = `<span style="background: var(--accent); color: var(--on-accent); padding: 2px 6px; border-radius: 4px; font-weight: bold;">Synced</span>`;
        } else if (result.plainLyrics) {
            typeSpan.innerHTML = `<span style="background: rgba(255,255,255,0.2); padding: 2px 6px; border-radius: 4px;">Plain Text</span>`;
        } else {
            typeSpan.innerHTML = `<span style="background: rgba(244,63,94,0.2); color: #f43f5e; padding: 2px 6px; border-radius: 4px;">Instrumental/None</span>`;
        }

        infoDiv.appendChild(titleSpan);
        infoDiv.appendChild(artistSpan);
        infoDiv.appendChild(typeSpan);

        const selectBtn = document.createElement('button');
        selectBtn.className = 'btn btn-sm';
        selectBtn.style.cssText = 'background: var(--accent); color: var(--on-accent); font-weight: bold; padding: 6px 12px; border-radius: 30px;';
        selectBtn.textContent = 'Select';
        selectBtn.addEventListener('click', () => selectLyricsResult(result, songId));

        if (!result.syncedLyrics && !result.plainLyrics) {
            selectBtn.disabled = true;
            selectBtn.style.opacity = '0.5';
        }

        resultItem.appendChild(infoDiv);
        resultItem.appendChild(selectBtn);

        lyricsSelectionResults.appendChild(resultItem);
    });
}

function selectLyricsResult(result, expectedSongId = window.currentlyPlayingSongId) {
    const songId = window.currentlyPlayingSongId;
    if (!songId || String(songId) !== String(expectedSongId)) return;
    const lyricsToSave = result.syncedLyrics || result.plainLyrics;
    const isSynced = !!result.syncedLyrics;
    if (typeof lyricsToSave !== 'string' || !lyricsToSave) return;

    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    _lyricsSearchAbort = null;
    if (_lyricsSelectionAbort) _lyricsSelectionAbort.abort();
    const controller = new AbortController();
    _lyricsSelectionAbort = controller;

    // Apply locally immediately
    lyricsData = [];
    if (lyricsContent) lyricsContent.innerHTML = '';

    if (isSynced) {
        parseLRC(lyricsToSave);
    } else {
        lyricsData = [{ time: 0, text: lyricsToSave }];
    }
    renderLyrics();

    // Ensure lyrics button is visible
    if (btnLyrics) {
        if (btnFindLyrics) btnFindLyrics.classList.remove('show-lyrics-btn');
        btnLyrics.classList.add('show-lyrics-btn');
        btnLyrics.parentElement.classList.add('has-lyrics');
    }
    lyricsSelectionModal.classList.add('hidden');

    // Attempt to save to our server
    fetch(`/api/lyrics/${encodeURIComponent(songId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
            lyrics: lyricsToSave,
            is_synced: isSynced
        })
    }).then(async response => {
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            if (response.status === 403) {
                console.warn("Applied lyrics locally. You don't have permission to update the lyrics in the database.");
            } else {
                console.error("Failed to save lyrics to database:", errData.error || response.status);
            }
        }
    }).catch(err => {
        if (err.name === 'AbortError') return;
        console.error("Failed to save selected lyrics:", err);
    }).finally(() => {
        if (_lyricsSelectionAbort === controller) _lyricsSelectionAbort = null;
    });
}


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
        const restoreRootScroll = () => {
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
            window.scrollTo(0, 0);
        };

        restoreRootScroll();
        requestAnimationFrame(() => {
            if (document.documentElement.classList.contains('player-chrome-active')) return;
            restoreRootScroll();
            requestAnimationFrame(() => {
                if (!document.documentElement.classList.contains('player-chrome-active')) {
                    restoreRootScroll();
                }
            });
        });
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

function openDedicatedPlayerFromCover() {
    if (isDesktopPlayerOverlayEnabled()) {
        openDesktopPlayerOverlay();
        return;
    }

    const miniPlayer = document.querySelector('.music-player');
    if (miniPlayer) {
        miniPlayer.style.display = 'none';
    }

    // Remember which section we were on before opening the player
    const activeSection = document.querySelector(
        'main.main-content > div.content-container > section:not(.hidden):not(#player-section)'
    );
    if (activeSection) {
        previousSectionId = activeSection.id;
        activeSection.inert = true;
        activeSection.setAttribute('aria-hidden', 'true');
    } else if (!previousSectionId) {
        previousSectionId = 'trending-section';
    }

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

    const miniPlayer = document.querySelector('.music-player');
    if (miniPlayer) {
        miniPlayer.style.removeProperty('display');
        miniPlayer.style.removeProperty('opacity');
        miniPlayer.style.removeProperty('transition');
        miniPlayer.style.removeProperty('pointer-events');
    }

    setDedicatedPlayerActive(false);
    setThemeColor(DEFAULT_THEME_COLOR);

    const secId = previousSectionId || 'trending-section';
    const prevSec = document.getElementById(secId);
    if (prevSec) {
        prevSec.classList.remove('hidden');
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

        playerImg?.focus({ preventScroll: true });
        return;
    }

    // Safety fallback: ensure trending-section is visible without clicking #library-link or calling fetchLibrary()
    const fallbackSec = document.getElementById('trending-section');
    if (fallbackSec) {
        fallbackSec.classList.remove('hidden');
        fallbackSec.inert = false;
        fallbackSec.removeAttribute('aria-hidden');
        document.getElementById('library-link')?.classList.add('active');
    }
    playerImg?.focus({ preventScroll: true });
}

function snapBackDedicatedPlayerMobile() {
    if (!playerSection) return;

    playerSection.style.transition = 'transform 0.25s cubic-bezier(0.25, 1, 0.5, 1), border-radius 0.25s ease, box-shadow 0.25s ease, opacity 0.25s ease';
    playerSection.style.transform = 'translate3d(0, 0, 0)';
    playerSection.style.borderTopLeftRadius = '';
    playerSection.style.borderTopRightRadius = '';
    playerSection.style.boxShadow = '';
    playerSection.style.opacity = '1';
    playerSection.style.willChange = '';

    const miniPlayer = document.querySelector('.music-player');
    if (miniPlayer) {
        miniPlayer.style.transition = 'opacity 0.2s ease';
        miniPlayer.style.opacity = '0';
    }

    setTimeout(() => {
        playerSection.classList.remove('player-dismissing');
        document.body.classList.remove('player-is-dismissing');
        playerSection.style.transition = '';
        playerSection.style.transform = '';
        playerSection.style.borderTopLeftRadius = '';
        playerSection.style.borderTopRightRadius = '';
        playerSection.style.boxShadow = '';
        if (miniPlayer) {
            miniPlayer.style.display = 'none';
            miniPlayer.style.transition = '';
        }
    }, 260);
}

function dismissDedicatedPlayerMobile(initialY = 0, velocity = 0) {
    if (!playerSection || !document.body.classList.contains('player-section-active') || isClosingMobilePlayer) return;
    isClosingMobilePlayer = true;

    const prevSec = previousSectionId ? document.getElementById(previousSectionId) : document.getElementById('trending-section');
    if (prevSec) prevSec.classList.remove('hidden');

    document.body.classList.add('player-is-dismissing');
    playerSection.classList.add('player-dismissing');

    const miniPlayer = document.querySelector('.music-player');
    if (miniPlayer) {
        miniPlayer.style.display = 'flex';
        miniPlayer.style.transition = 'opacity 0.25s ease';
        miniPlayer.style.opacity = '1';
        miniPlayer.style.pointerEvents = '';
    }

    if (initialY > 0) {
        playerSection.style.transform = `translate3d(0, ${initialY}px, 0)`;
    }

    void playerSection.offsetHeight;

    let duration = 0.24;
    if (velocity > 0.6) duration = 0.18;
    else if (velocity > 0.35) duration = 0.21;

    playerSection.style.transition = `transform ${duration}s cubic-bezier(0.32, 0.72, 0, 1), opacity ${duration}s ease, border-radius ${duration}s ease`;
    playerSection.style.transform = 'translate3d(0, 100%, 0)';
    playerSection.style.opacity = '0.5';

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


/* ========== DEDICATED PLAYER LYRICS LOGIC ========== */
let lyricsData = []; // Array of {time: seconds, text: string}
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
        window.innerWidth <= 900 ||
        audio.paused ||
        !document.body.classList.contains('player-section-active')
    ) return;

    const data = isLyricEditMode ? tempLyricsData : lyricsData;
    const currentTime = audio.currentTime;
    const nextLine = data.find(line => Number(line.time) > currentTime + 0.01);
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

function centerDesktopLyric(activeEl, immediate = false) {
    if (!activeEl || !lyricsScrollArea || !lyricsContent || window.innerWidth <= 900) return;

    // Desktop never scrolls the outer viewport. The inner lyric track moves so
    // the active line's layout center lands on the viewport's visual center.
    lyricsScrollArea.scrollTop = 0;
    const lineCenter = activeEl.offsetTop + (activeEl.offsetHeight / 2);
    const centeredTranslateY = (lyricsScrollArea.clientHeight / 2) - lineCenter;
    // The first few lines have no content above them. Full centering would move
    // the entire track down by half a viewport and create the large empty band
    // seen in the screenshot. Once enough lines exist above, normal centering
    // and the exact same spring transition take over.
    const maxTopInset = Math.max(16, Math.min(28, lyricsScrollArea.clientHeight * 0.08));
    const translateY = Math.min(maxTopInset, centeredTranslateY);

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

function handleLyricsInteraction() {
    if (!isLyricsActive || window.innerWidth > 900) return;
    isUserScrollingLyrics = true;
    if (userScrollingLyricsTimeout) clearTimeout(userScrollingLyricsTimeout);
    userScrollingLyricsTimeout = setTimeout(() => {
        isUserScrollingLyrics = false;
    }, 3000); // Resume auto-scroll after 3 seconds of no manual interaction
}

if (lyricsScrollArea) {
    lyricsScrollArea.addEventListener('wheel', handleLyricsInteraction, { passive: true });
    lyricsScrollArea.addEventListener('touchmove', handleLyricsInteraction, { passive: true });
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
        updateActiveLyric(true);
        startDesktopLyricsSync();
        _acquireWakeLock(); // Keep screen on while reading lyrics
    });
}

function deactivateLyricsView({ resetLineDepth = true } = {}) {
    isLyricsActive = false;
    activeLyricIndex = -1;
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

    dedicatedView.addEventListener('touchstart', e => {
        if (!document.body.classList.contains('player-section-active') || isClosingMobilePlayer) return;
        if (isDesktopPlayerOverlayEnabled()) return;
        if (e.touches.length !== 1) {
            isGestureIgnored = true;
            return;
        }

        const target = e.target;
        // Never hijack progress sliders, volume sliders, buttons, inputs, links, or lyric edit controls
        if (target.closest('.dedicated-progress-bar-wrapper, .progress-bar-wrapper, .volume-slider, button, input, a, .lyric-sync-btn, .lyric-edit-input')) {
            isGestureIgnored = true;
            return;
        }

        isGestureIgnored = false;
        isPullingDown = false;
        currentPullY = 0;
        currentVelocity = 0;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        lastMoveY = touchStartY;
        touchStartTime = Date.now();
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
            // Horizontal motion (e.g. lyrics switch back) - ignore for pull-down, but don't drop gesture
            if (absX > 10 && absX > Math.abs(deltaY)) {
                return;
            }

            // Check if pulling downwards predominantly
            if (deltaY > 8 && deltaY > absX * 1.1) {
                // If lyrics view is scrolled down, let user scroll lyrics rather than dismissing sheet
                if (isLyricsActive && lyricsScrollArea && lyricsScrollArea.scrollTop > 5) {
                    return;
                }
                isPullingDown = true;
                playerSection.style.willChange = 'transform';
                const prevSec = previousSectionId ? document.getElementById(previousSectionId) : document.getElementById('trending-section');
                if (prevSec) prevSec.classList.remove('hidden');

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

            // Reveal mini-player gradually only after dragging past 35% of the screen
            const miniPlayer = document.querySelector('.music-player');
            if (miniPlayer) {
                const triggerThreshold = window.innerHeight * 0.35;
                if (clampedY > triggerThreshold) {
                    const progress = Math.min(1, (clampedY - triggerThreshold) / (window.innerHeight * 0.45));
                    miniPlayer.style.display = 'flex';
                    miniPlayer.style.opacity = progress.toFixed(2);
                    miniPlayer.style.pointerEvents = 'none';
                } else {
                    miniPlayer.style.display = 'none';
                    miniPlayer.style.opacity = '0';
                }
            }
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
            if (!isGestureIgnored && isLyricsActive && deltaX > 45 && absX > Math.abs(deltaY) * 1.1) {
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
        }
    }, { passive: true });
})();

function resetLyrics() {
    if (_lyricsFetchAbort) _lyricsFetchAbort.abort();
    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    if (_lyricsSelectionAbort) _lyricsSelectionAbort.abort();
    _lyricsFetchAbort = null;
    _lyricsSearchAbort = null;
    _lyricsSelectionAbort = null;
    if (lyricsSelectionModal) lyricsSelectionModal.classList.add('hidden');
    if (lyricsSelectionLoading) lyricsSelectionLoading.classList.add('hidden');

    lyricsData = [];
    activeLyricIndex = -1;
    if (lyricsContent) {
        lyricsContent.style.removeProperty('transform');
        lyricsContent.classList.remove('lyrics-position-immediate');
        lyricsContent.classList.remove('lyrics-editing');
        lyricsContent.innerHTML = '';
    }
    if (lyricsScrollArea) lyricsScrollArea.classList.remove('lyrics-editing');
    if (btnLyrics) btnLyrics.classList.remove('show-lyrics-btn');
    if (btnFindLyrics) btnFindLyrics.classList.remove('show-lyrics-btn');
    if (btnLyrics && btnLyrics.parentElement) {
        btnLyrics.parentElement.classList.remove('has-lyrics');
    }

    // Cancel edit mode if active
    if (isLyricEditMode) {
        isLyricEditMode = false;
        if (btnEditLyrics) btnEditLyrics.classList.remove('hidden');
        if (editorControls) editorControls.classList.add('hidden');
    }

    // If lyrics view is active but we reset, go back to standard view
    if (isLyricsActive) {
        deactivateLyricsView();
    }
}

/**
 * Utility to strip common noise from song titles and artists (4K, Official Video, etc.)
 * @param {string} title 
 * @param {string} artist 
 * @returns {object} {title, artist}
 */
function cleanMetadata(title, artist) {
    let cleanTitle = title || '';
    let cleanArtist = artist && artist !== 'Unknown Artist' ? artist : '';

    // 1. Remove common YouTube suffixes and noise
    const noisePatterns = [
        // Parentheses/Brackets that START with noise keywords (Wildcard match)
        /\((?:official|music|video|audio|lyrics?|hd|4k|8k|uhd|hdr|full|hq|high quality|visualizer|mv|m\/v|remastered|remaster|live|performance|exclusive|premiere|vevo|topic|dolby|atmos|dts|spatial audio|hi-res|360ra|8d|432hz|extended|radio edit|original mix|prod\.\s+by|featuring|feat\.).*?\)/gi,
        /\[(?:official|music|video|audio|lyrics?|hd|4k|8k|uhd|hdr|full|hq|high quality|visualizer|mv|m\/v|remastered|remaster|live|performance|exclusive|premiere|vevo|topic|dolby|atmos|dts|spatial audio|hi-res|360ra|8d|432hz|extended|radio edit|original mix|prod\.\s+by|featuring|feat\.).*?\]/gi,

        // Standalone keywords
        /\b(?:official|music|video|audio|lyrics?|hd|4k|8k|uhd|hdr|full|hq|high quality|visualizer|mv|m\/v|remastered|remaster|live|performance|exclusive|premiere|vevo|topic|dolby|atmos|dts|disney plus|disney\+|netflix|apple music|spotify|vevo|topic|prod\.\s+by|featuring|feat\.)\b/gi,

        // Patterns like "Official Video", "Lyric Video"
        /\b(?:official\s+video|music\s+video|lyric\s+video|official\s+audio|official\s+lyric\s+video)\b/gi,

        // Remove tour/version info
        /\b(?:eras tour|world tour|tour version|taylor\'s version)\b/gi,

        // Year strings
        /\b\(\d{4}\)\b/g,
        /\b\[\d{4}\]\b/g,
    ];

    noisePatterns.forEach(pattern => {
        cleanTitle = cleanTitle.replace(pattern, ' ');
    });

    // 2. Intelligently handle separators (| or //)
    // If it looks like "Artist | Title | Noise", we want to keep the first two parts
    if (cleanTitle.includes(' | ')) {
        const parts = cleanTitle.split(' | ').map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length >= 2 && !cleanTitle.includes(' - ')) {
            // Use the first two parts as Artist - Title
            cleanTitle = `${parts[0]} - ${parts[1]}`;
        } else {
            cleanTitle = parts[0]; // Just take the first part
        }
    }
    cleanTitle = cleanTitle.replace(/\/\/.*$/g, ' ');

    // 3. Handle Artist-Title split in the title itself (Standard " - ")
    // Many YouTube titles are "Artist - Title"
    if (cleanTitle.includes(' - ')) {
        const parts = cleanTitle.split(' - ').map(p => p.trim());
        if (cleanArtist) {
            const lowArtist = cleanArtist.toLowerCase();
            const lowPart0 = parts[0].toLowerCase();
            const lowPart1 = parts[1].toLowerCase();

            // Normalized comparison (ignore spaces/special chars)
            const normArtist = lowArtist.replace(/[^\w]/g, '');
            const normPart0 = lowPart0.replace(/[^\w]/g, '');
            const normPart1 = lowPart1.replace(/[^\w]/g, '');

            if (normPart0 && normArtist && (normPart0.includes(normArtist) || normArtist.includes(normPart0))) {
                cleanTitle = parts[1];
                cleanArtist = parts[0]; // Adopt the cleaner name from the title
            } else if (normPart1 && normArtist && (normPart1.includes(normArtist) || normArtist.includes(normPart1))) {
                cleanTitle = parts[0];
                cleanArtist = parts[1]; // Adopt the cleaner name from the title
            }
        } else {
            // No artist, assume Part 0 is artist, Part 1 is title
            cleanArtist = parts[0];
            cleanTitle = parts[1];
        }
    }

    // 4. Remove artist from title if it's still present
    if (cleanArtist && cleanArtist !== 'Unknown Artist') {
        // Strip common channel noise from the artist name itself for better matching
        const artistNoise = /\b(?:vevo|topic|official|channel)\b/gi;
        const baseArtist = cleanArtist.replace(artistNoise, '').trim();

        const escapedArtist = baseArtist.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const artistRegex = new RegExp(`\\b${escapedArtist}\\b`, 'gi');
        cleanTitle = cleanTitle.replace(artistRegex, ' ');

        // Update cleanArtist to the stripped version if it's not empty
        if (baseArtist) cleanArtist = baseArtist;
    }

    // 5. Final cleanup of whitespace and special characters
    cleanTitle = cleanTitle
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\-\'\!\?\&\.]/gi, '') // Remove weird non-song symbols
        .trim();

    cleanArtist = cleanArtist
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\-\'\!\?\&\.]/gi, '')
        .trim();

    if (cleanTitle !== title || cleanArtist !== artist) {
        console.log(`[METADATA CLEAN] Original: "${title}" [${artist}] -> Cleaned: "${cleanTitle}" [${cleanArtist}]`);
    }

    return { title: cleanTitle, artist: cleanArtist };
}

async function fetchLyrics(title, artist, songId, preferUser = null) {
    if (_lyricsFetchAbort) _lyricsFetchAbort.abort();
    if (!title || !navigator.onLine) return;
    if (songId !== window.currentlyPlayingSongId) return;

    const controller = new AbortController();
    _lyricsFetchAbort = controller;

    try {
        // Try fetching from our server first
        if (songId) {
            let lyricsUrl = `/api/lyrics/${encodeURIComponent(songId)}`;
            if (preferUser) lyricsUrl += `?prefer=${encodeURIComponent(preferUser)}`;
            const serverResponse = await fetch(lyricsUrl, { signal: controller.signal });
            if (_lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId) return;

            if (serverResponse.ok) {
                const cachedData = await serverResponse.json();
                if (_lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId) return;
                if (cachedData && cachedData.lyrics) {
                    console.log(`[LYRICS] Serving cached lyrics for song ID: ${songId}`);
                    if (cachedData.is_synced) {
                        parseLRC(cachedData.lyrics);
                    } else {
                        lyricsData = [{ time: 0, text: cachedData.lyrics }];
                    }
                    renderLyrics();
                    if (btnLyrics) {
                        if (btnFindLyrics) btnFindLyrics.classList.remove('show-lyrics-btn');
                        btnLyrics.classList.add('show-lyrics-btn');
                        btnLyrics.parentElement.classList.add('has-lyrics');
                    }
                    return; // Successfully used cache
                }
            }
        }

        // --- AUTOMATIC SEARCH WITH ROBUST CLEANING ---
        const cleaned = cleanMetadata(title, artist);
        let searchTitle = cleaned.title;
        let searchArtist = cleaned.artist;

        console.log(`[LYRICS] Searching for: "${searchTitle}" by "${searchArtist}" (Cleaned from "${title}")`);

        // Inner function to do the actual fetch using /api/search
        const tryFetch = async (t, a) => {
            const url = new URL('https://lrclib.net/api/search');
            url.searchParams.append('q', `${t} ${a}`.trim());

            try {
                const response = await fetch(url, { signal: controller.signal });
                if (response.ok) {
                    const results = await response.json();
                    if (results && results.length > 0) {
                        // Priority: Synced > Plain
                        const synced = results.find(r => r.syncedLyrics);
                        if (synced) return synced;
                        const plain = results.find(r => r.plainLyrics);
                        if (plain) return plain;
                    }
                }
            } catch (e) {
                console.warn("[LYRICS] fetch error:", e);
            }
            return null;
        };

        // Try 1: Fully Cleaned Title + Artist
        let data = await tryFetch(searchTitle, searchArtist);
        if (_lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId) return;

        // Try 2: Title only (sometimes artist name in metadata vs LRCLIB differs)
        if (!data && searchArtist) {
            console.log(`[LYRICS] Stage 1 failed. Trying Stage 2 (Title only): "${searchTitle}"`);
            data = await tryFetch(searchTitle, '');
            if (_lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId) return;
        }

        // Try 3: Aggressive stripping (remove all non-alphanumeric)
        if (!data) {
            let ultraCleanTitle = searchTitle.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            if (ultraCleanTitle && ultraCleanTitle !== searchTitle) {
                console.log(`[LYRICS] Stage 2 failed. Trying Stage 3 (Aggressive): "${ultraCleanTitle}"`);
                data = await tryFetch(ultraCleanTitle, '');
                if (_lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId) return;
            }
        }

        // Try 4: Text before brackets (handles "Title (Live at...)")
        if (!data && (searchTitle.includes('(') || searchTitle.includes('['))) {
            let beforeBrackets = searchTitle.split(/[\(\[]/)[0].trim();
            if (beforeBrackets && beforeBrackets.length > 2) {
                console.log(`[LYRICS] Stage 3 failed. Trying Stage 4 (Before Brackets): "${beforeBrackets}"`);
                data = await tryFetch(beforeBrackets, searchArtist);
                if (_lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId) return;
            }
        }

        if (!data) {
            if (songId === window.currentlyPlayingSongId && btnFindLyrics) {
                if (btnLyrics) btnLyrics.classList.remove('show-lyrics-btn');
                btnFindLyrics.classList.add('show-lyrics-btn');
                btnFindLyrics.parentElement.classList.add('has-lyrics');
            }
            return;
        }
        if (songId !== window.currentlyPlayingSongId) return;

        console.log(`[LYRICS] Found lyrics from lrclib.net for ${title}`);

        // Cache them on our server for future
        fetch(`/api/lyrics/${encodeURIComponent(songId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                lyrics: data.syncedLyrics || data.plainLyrics,
                is_synced: !!data.syncedLyrics
            })
        }).catch(err => console.error("[LYRICS] Cache save failed:", err));

        if (data.syncedLyrics) {
            parseLRC(data.syncedLyrics);
        } else {
            lyricsData = [{ time: 0, text: data.plainLyrics }];
        }

        if (songId === window.currentlyPlayingSongId) {
            renderLyrics();
            if (btnLyrics) {
                if (btnFindLyrics) btnFindLyrics.classList.remove('show-lyrics-btn');
                btnLyrics.classList.add('show-lyrics-btn');
                btnLyrics.parentElement.classList.add('has-lyrics');
            }
        }
    } catch (err) {
        if (err.name === 'AbortError' || _lyricsFetchAbort !== controller) return;
        console.error("Failed to fetch lyrics:", err);
        if (songId === window.currentlyPlayingSongId && btnFindLyrics) {
            if (btnLyrics) btnLyrics.classList.remove('show-lyrics-btn');
            btnFindLyrics.classList.add('show-lyrics-btn');
            btnFindLyrics.parentElement.classList.add('has-lyrics');
        }
    } finally {
        if (_lyricsFetchAbort === controller) _lyricsFetchAbort = null;
    }
}

function parseLRC(lrcString) {
    lyricsData = [];
    const lines = lrcString.split('\n');
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const milliseconds = parseInt(match[3], 10);

            // Normalize MS depending on if it's 2 or 3 digits
            const msMultiplier = match[3].length === 2 ? 10 : 1;
            const timeInSeconds = minutes * 60 + seconds + (milliseconds * msMultiplier) / 1000;

            const text = line.replace(timeRegex, '').trim();
            if (text) {
                lyricsData.push({ time: timeInSeconds, text: text });
            }
        }
    }

    // Sort by time just in case
    lyricsData.sort((a, b) => a.time - b.time);
}

function renderLyrics() {
    if (!lyricsContent) return;
    activeLyricIndex = -1;
    resetDesktopLyricsPresentation();
    lyricsContent.classList.toggle('lyrics-editing', isLyricEditMode);
    if (lyricsScrollArea) lyricsScrollArea.classList.toggle('lyrics-editing', isLyricEditMode);
    lyricsContent.innerHTML = '';

    const data = isLyricEditMode ? tempLyricsData : lyricsData;

    data.forEach((line, index) => {
        const lineEl = document.createElement('div');
        lineEl.className = 'lyric-line';
        if (line.text === '\u266a') lineEl.classList.add('instrumental');

        if (isLyricEditMode) {
            lineEl.classList.add('editing');

            // Time Display
            const timeEl = document.createElement('span');
            timeEl.className = 'lyric-edit-time';
            timeEl.textContent = formatLyricsTime(line.time);
            lineEl.appendChild(timeEl);

            // Text Input
            const input = document.createElement('input');
            input.className = 'lyric-edit-input';
            input.value = line.text;
            input.addEventListener('change', (e) => {
                tempLyricsData[index].text = e.target.value;
            });
            lineEl.appendChild(input);

            // Sync Button (Now always Sync & Shift Following as requested)
            const syncBtn = document.createElement('button');
            syncBtn.className = 'lyric-sync-btn';
            syncBtn.style.background = 'rgba(var(--accent-rgb), 0.2)';
            syncBtn.innerHTML = "<i class='bx bx-time-five'></i>";
            syncBtn.title = "Sync this and all following lines";
            syncBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                captureTimestamp(index, true);
            });
            lineEl.appendChild(syncBtn);

            // Mark active edit if audio is near this line
            if (Math.abs(audio.currentTime - line.time) < 0.5) {
                lineEl.classList.add('active-edit');
            }

        } else {
            // Standard View Mode
            String(line.text || '').split('\n').forEach((part, partIndex) => {
                if (partIndex > 0) lineEl.appendChild(document.createElement('br'));
                lineEl.appendChild(document.createTextNode(part));
            });
            lineEl.dataset.index = index;
            lineEl.dataset.time = line.time;
            lineEl.setAttribute('role', 'button');
            lineEl.setAttribute('tabindex', '0');

            const activateLine = () => {
                if (audio && isFinite(line.time)) {
                    audio.currentTime = line.time;
                    isUserScrollingLyrics = false;
                    updateActiveLyric();
                    playSong();
                }
            };

            // Click or keyboard activation seeks and updates the depth states
            // immediately instead of waiting for the next audio timeupdate.
            lineEl.addEventListener('click', activateLine);
            lineEl.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                activateLine();
            });
        }

        lyricsContent.appendChild(lineEl);
    });

    // Add Offset Controls footer in editor mode
    if (isLyricEditMode) {
        const footer = document.createElement('div');
        footer.className = 'lyric-editor-footer';
        footer.innerHTML = `
            <div class="offset-controls">
                <span>Shift All:</span>
                <button type="button" class="offset-btn" data-offset="-500">-0.5s</button>
                <button type="button" class="offset-btn" data-offset="-100">-0.1s</button>
                <button type="button" class="offset-btn" data-offset="100">+0.1s</button>
                <button type="button" class="offset-btn" data-offset="500">+0.5s</button>
            </div>
            <div style="font-size: 11px; color: #666;">Tip: Press 'S' to sync active line</div>
        `;
        footer.querySelectorAll('.offset-btn').forEach(button => {
            button.addEventListener('click', () => shiftAllLyrics(Number(button.dataset.offset)));
        });
        lyricsContent.appendChild(footer);
    }

    if (isLyricsActive && !isLyricEditMode) {
        updateActiveLyric(true);
    }
}

/* --- Lyric Editor Functions --- */

function toggleLyricEditor() {
    if (isLyricEditMode) {
        // This is now handled by the "Save" or "Cancel" buttons in the header
        return;
    } else {
        isLyricEditMode = true;
        originalLyricsData = JSON.parse(JSON.stringify(lyricsData));
        tempLyricsData = JSON.parse(JSON.stringify(lyricsData));

        btnEditLyrics.classList.add('hidden'); // Hide the "Edit" button
        editorControls.classList.remove('hidden'); // Show Save/Clear/Cancel
    }
    renderLyrics();
}

function cancelLyricEdit() {
    isLyricEditMode = false;
    lyricsData = JSON.parse(JSON.stringify(originalLyricsData));
    btnEditLyrics.classList.remove('hidden');
    editorControls.classList.add('hidden');
    renderLyrics();
}

async function saveLyricsToServer() {
    const songId = window.currentlyPlayingSongId;
    if (!songId) return;

    try {
        const isSynced = tempLyricsData.length > 1 || (tempLyricsData[0] && tempLyricsData[0].time > 0);

        let lyricsPayload = "";
        if (isSynced) {
            // Sort by time before saving
            tempLyricsData.sort((a, b) => a.time - b.time);

            lyricsPayload = tempLyricsData.map(line => {
                const min = Math.floor(line.time / 60);
                const sec = (line.time % 60).toFixed(2).padStart(5, '0');
                return `[${min.toString().padStart(2, '0')}:${sec}]${line.text}`;
            }).join('\n');
        } else {
            lyricsPayload = tempLyricsData[0]?.text || "";
        }

        const res = await fetch(`/api/lyrics/${encodeURIComponent(songId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lyrics: lyricsPayload,
                is_synced: isSynced
            })
        });

        if (String(songId) !== String(window.currentlyPlayingSongId)) return;
        if (res.ok) {
            lyricsData = JSON.parse(JSON.stringify(tempLyricsData));
            isLyricEditMode = false;
            btnEditLyrics.classList.remove('hidden');
            editorControls.classList.add('hidden');
            renderLyrics();
            console.log("[LYRICS] Saved edits to server.");
        } else {
            alert("Failed to save lyrics.");
        }
    } catch (err) {
        console.error("Save lyrics error:", err);
    }
}

async function clearLyricsFromServer() {
    const songId = window.currentlyPlayingSongId;
    if (!songId) return;

    if (!confirm("Are you sure you want to delete the cached lyrics for this song? This will revert to fetching from external APIs.")) return;

    try {
        const res = await fetch(`/api/lyrics/${encodeURIComponent(songId)}`, {
            method: 'DELETE'
        });

        if (String(songId) !== String(window.currentlyPlayingSongId)) return;
        if (res.ok) {
            console.log("[LYRICS] Cache cleared.");
            isLyricEditMode = false;
            btnEditLyrics.classList.remove('hidden', 'active');
            editorControls.classList.add('hidden');

            // Reload lyrics (will trigger external fetch)
            const currentSong = {
                title: playerTitle.textContent,
                artist: playerArtist.textContent,
                id: songId
            };
            resetLyrics();
            fetchLyrics(currentSong.title, currentSong.artist, currentSong.id);
        } else {
            alert("Failed to clear lyrics.");
        }
    } catch (err) {
        console.error("Clear lyrics error:", err);
    }
}

function captureTimestamp(index, shiftFollowing = false) {
    if (!isLyricEditMode) return;
    const oldTime = tempLyricsData[index].time;
    const newTime = audio.currentTime;
    const delta = newTime - oldTime;

    if (shiftFollowing) {
        // Shift this line and all subsequent lines by the same delta
        for (let i = index; i < tempLyricsData.length; i++) {
            tempLyricsData[i].time = Math.max(0, tempLyricsData[i].time + delta);
        }
        renderLyrics(); // Full re-render to update all lines
    } else {
        tempLyricsData[index].time = newTime;
        // Update UI instantly for just this line
        const lineEl = lyricsContent.querySelector(`.lyric-line:nth-child(${index + 1})`);
        if (lineEl) {
            const timeDisplay = lineEl.querySelector('.lyric-edit-time');
            if (timeDisplay) timeDisplay.textContent = formatLyricsTime(newTime);

            lineEl.style.background = 'rgba(var(--accent-rgb), 0.3)';
            setTimeout(() => lineEl.style.background = "", 300);
        }
    }
}

function shiftAllLyrics(ms) {
    if (!isLyricEditMode) return;
    const offset = ms / 1000;
    tempLyricsData.forEach(line => {
        line.time = Math.max(0, line.time + offset);
    });
    renderLyrics();
}

function formatLyricsTime(time) {
    const min = Math.floor(time / 60);
    const sec = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 100);
    return `${min}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

// Keyboard shortcuts for Editor
document.addEventListener('keydown', (e) => {
    if (!isLyricEditMode) return;

    // If 'S' is pressed and not in an input
    if (e.key.toLowerCase() === 's' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        // Find the "next" line to sync based on current playback
        // Usually it's the first line whose time is > current playback, or the line after the last active one
        const currentTime = audio.currentTime;
        let indexToSync = tempLyricsData.findIndex(l => l.time > currentTime);
        if (indexToSync === -1) indexToSync = tempLyricsData.length - 1;

        captureTimestamp(indexToSync);
    }
});

function updateActiveLyric(immediate = false) {
    const data = isLyricEditMode ? tempLyricsData : lyricsData;
    if (!isLyricsActive || data.length === 0 || !lyricsContent) return;

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
            activeLyricIndex = activeIndex;
            lineElements.forEach(lineEl => {
                lineEl.removeAttribute('data-distance');
                lineEl.removeAttribute('aria-current');
            });
            if (currentActiveEl) currentActiveEl.classList.remove('active');
            newActiveEl.classList.add('active');
            newActiveEl.setAttribute('aria-current', 'true');
            scrollToActiveLyric(newActiveEl);
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

        const activeHeight = activeEl.getBoundingClientRect().height;
        const edgePadding = Math.max(40, Math.round((containerHeight - activeHeight) / 2));
        // Bottom padding allows the final lyric lines to scroll into the center
        lyricsContent.style.setProperty('--lyrics-scroll-padding', `${edgePadding}px`);

        const scrollAreaRect = lyricsScrollArea.getBoundingClientRect();
        const activeRect = activeEl.getBoundingClientRect();

        const relativeTop = (activeRect.top - scrollAreaRect.top) + lyricsScrollArea.scrollTop;

        // When the song is near the beginning, start cleanly at top (scrollTop: 0)
        const rawTarget = relativeTop - (containerHeight / 2) + (activeRect.height / 2);
        const target = Math.max(0, Math.round(rawTarget));
        lyricsScrollArea.scrollTo({ top: target, behavior: immediate ? 'auto' : 'smooth' });
    }
}

// Ensure resize events adjust scroll if lyrics are open
window.addEventListener('resize', () => {
    if (isLyricsActive) {
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
            stopDesktopLyricsSync();
            resetDesktopLyricsPresentation();
            scrollToActiveLyric();
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

    // Create audio context
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContext();

    // Create media element source
    // Ensure CORS allows this if files are loaded across origins
    mediaElementSource = audioContext.createMediaElementSource(audio);

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

function updateEqRoute() {
    if (!audioContext) return;

    // Disconnect existing
    mediaElementSource.disconnect();
    eqNodes.low.disconnect();
    eqNodes.mid.disconnect();
    eqNodes.high.disconnect();

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

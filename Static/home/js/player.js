/**
 * ============================================================================
 * STREAMIFY — player.js
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
let hasCountedPlay = false;

function flushTelemetry() {
    if (accumulatedTelemetryTime > 0 && telemetrySongId) {
        const isPlay = accumulatedTelemetryTime >= 30 && !hasCountedPlay;
        if (isPlay) hasCountedPlay = true;

        if (typeof window.reportTelemetry === 'function') {
            window.reportTelemetry(telemetrySongId, accumulatedTelemetryTime, isPlay);
        }
    }
    accumulatedTelemetryTime = 0;
}

/* ========== MARQUEE LOGIC ========== */
function updateMarquee(element) {
    if (!element) return;
    element.classList.remove('scroll-marquee');
    element.style.transform = 'translateX(0)'; // Reset transform

    // Wait a tiny bit for the DOM to render the new text width
    setTimeout(() => {
        const parent = element.parentElement;
        if (!parent) return;

        if (element.scrollWidth > parent.clientWidth) {
            // Negative distance to scroll left
            const dist = parent.clientWidth - element.scrollWidth - 10; // 10px buffer
            element.style.setProperty('--scroll-dist', `${dist}px`);
            element.classList.add('scroll-marquee');
        }
    }, 50);
}

/* ========== CORE PLAYBACK ========== */


function getQualityBadgeHTML(song) {
    if (!song) return '';
    let bitrate = song.bitrate;
    let extension = song.extension || '';
    
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

    playerTitle.textContent = song.title;
    playerArtist.textContent = song.artist; // No badge in mini player
    playerImg.src = song.cover;
    audio.src = song.url;

    // Sync Dedicated Player
    if (dedicatedTitle) {
        dedicatedTitle.textContent = song.title;
        // Marquee will be calculated when view is actually opened or updated
        if (document.body.classList.contains('player-section-active')) {
            updateMarquee(dedicatedTitle);
        }
    }
    if (dedicatedArtist) {
        dedicatedArtist.innerHTML = `${escapeHTML(song.artist)}${getQualityBadgeHTML(song)}`;
        if (document.body.classList.contains('player-section-active')) {
            updateMarquee(dedicatedArtist);
        }
    }
    if (dedicatedImg) dedicatedImg.src = song.cover;
    if (dedicatedBackdrop) dedicatedBackdrop.style.backgroundImage = `url('${song.cover}')`;

    // Trigger animation for dedicated player if active
    if (document.body.classList.contains('player-section-active')) {
        const animTargets = [
            document.querySelector('.dedicated-art-container'),
            document.querySelector('.dedicated-info-container'),
            document.getElementById('dedicated-lyrics-container')
        ];
        animTargets.forEach(el => {
            if (el) {
                el.classList.remove('song-change-fade-in');
                void el.offsetWidth; // force reflow
                el.classList.add('song-change-fade-in');
            }
        });
    }

    // Track the currently playing song ID for cross-tab highlighting
    window.currentlyPlayingSongId = song.id || null;

    // Reset and fetch lyrics
    resetLyrics();
    fetchLyrics(song.title, song.artist, song.id, song.playlistOwner);

    try { audio.load(); } catch (e) { /* ignore */ }
    canSeek = false;

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

    /* OS / lock-screen media session — update metadata only */
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title,
            artist: song.artist,
            album: song.album || 'Streamify',
            artwork: [96, 128, 192, 256, 384, 512].map(s => ({
                src: song.cover, sizes: `${s}x${s}`, type: 'image/jpeg'
            }))
        });
    }

    /* Update iOS Widget */
    if (typeof updateWidgetNowPlaying === 'function') {
        updateWidgetNowPlaying(song.title, song.artist, song.cover, false, 0);
    }
}

function playSong() {
    isPlaying = true;
    audio.play().catch(() => { });
    btnPlay.innerHTML = "<i class='bx bx-pause' style='margin-left:0;'></i>";
    if (dedicatedBtnPlay) dedicatedBtnPlay.innerHTML = "<i class='bx bx-pause' style='margin-left:0;'></i>";

    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';

    /* Update iOS Widget */
    if (typeof updateWidgetNowPlaying === 'function') {
        updateWidgetNowPlaying(playerTitle.textContent, playerArtist.textContent, playerImg.src, true, audio.currentTime);
    }
}

function pauseSong() {
    isPlaying = false;
    audio.pause();
    btnPlay.innerHTML = "<i class='bx bx-play' style='margin-left:2px;'></i>";
    if (dedicatedBtnPlay) dedicatedBtnPlay.innerHTML = "<i class='bx bx-play' style='margin-left:4px;'></i>";

    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';

    /* Update iOS Widget */
    if (typeof updateWidgetNowPlaying === 'function') {
        updateWidgetNowPlaying(playerTitle.textContent, playerArtist.textContent, playerImg.src, false, audio.currentTime);
    }
}

function togglePlay() {
    if (isPlaying) pauseSong(); else playSong();
}

/* Register MediaSession action handlers ONCE at startup — re-registering on every track
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

/**
 * Internal: plays a song at `index` from the given `pl` playlist and `sh` shuffle order.
 * All autoplay (next/prev) routes through here using the activePlaylist snapshot.
 */
function _playSongFromPlaylist(index, pl, sh) {
    if (index < 0 || index >= pl.length) return;

    if (isShuffle) {
        const shufflePos = sh.indexOf(index);
        currentIndex = shufflePos !== -1 ? shufflePos : 0;
    } else {
        currentIndex = index;
    }

    const song = pl[index];

    const loadAndPlay = (songData) => {
        if (songData.cover) song.cover = songData.cover;
        const cover = song.cover || COVER_PLACEHOLDER;
        loadSong({
            id: song.id,
            title: song.title,
            artist: song.artist,
            album: song.album,
            url: songData.url,
            cover: cover,
            bitrate: songData.bitrate || song.bitrate,
            extension: songData.extension || song.extension
        });
        playSong();

        if (!song.cover) {
            fetchWebCover(song.artist, song.title).then(url => {
                if (url) {
                    playerImg.src = url;
                    if (typeof dedicatedImg !== 'undefined' && dedicatedImg) dedicatedImg.src = url;
                    if (typeof dedicatedBackdrop !== 'undefined' && dedicatedBackdrop) dedicatedBackdrop.style.backgroundImage = `url('${url}')`;
                    song.cover = url; // update directly on the song object (shared reference)
                    saveCoverToServer(song.title, url);
                    const expandImg = document.getElementById('cover-expand-img');
                    if (expandImg && document.getElementById('cover-expand-overlay') && document.getElementById('cover-expand-overlay').classList.contains('show'))
                        expandImg.src = url;
                }
            });
        }
    };

    if (!navigator.onLine && window.OfflineStore) {
        window.OfflineStore.getOfflineSongs().then(songs => {
            const cachedSong = songs.find(s => s.id === song.id);
            if (cachedSong) {
                loadAndPlay(cachedSong);
            } else {
                showToast("Song not available offline", "error");
            }
        });
        return;
    }

    fetch(song.url)
        .then(r => r.json())
        .then(loadAndPlay)
        .catch(err => {
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
    if (activePlaylist.length === 0) return;

    if (isShuffle) {
        if (currentIndex >= activeShuffledPlaylist.length - 1) {
            if (repeatMode === 1) currentIndex = 0; else return;
        } else { currentIndex++; }
    } else {
        if (currentIndex >= activePlaylist.length - 1) {
            if (repeatMode === 1) currentIndex = 0; else return;
        } else { currentIndex++; }
    }
    _playSongFromPlaylist(getCurrentRealIndex(), activePlaylist, activeShuffledPlaylist);
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
    isShuffle = !isShuffle;
    btnShuffle.style.color = isShuffle ? 'var(--accent)' : '#b3b3b3';

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
        if (currentIndex !== -1) currentIndex = 0;
    } else {
        if (currentIndex !== -1 && activePlaylist.length > 0)
            currentIndex = activeShuffledPlaylist[currentIndex];
    }

    // Sync Dedicated Shuffle button style
    if (dedicatedBtnShuffle) {
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
    if (repeatMode === 2) { audio.currentTime = 0; audio.play(); }
    else nextSong();
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
        if (!audio.seeking) return; // Already recovered on its own
        const t  = audio.currentTime;
        const wasPlaying = isPlaying;
        const baseSrc = (audio.currentSrc || audio.src).split('?')[0];
        // One-shot: restore position once the new src has metadata
        audio.addEventListener('loadedmetadata', () => {
            audio.currentTime = t;
            if (wasPlaying) audio.play().catch(() => {});
        }, { once: true });
        // Cache-bust forces a fresh network fetch, bypassing HTTP cache
        audio.src = baseSrc + '?_t=' + Date.now();
        audio.load();
    }, 3000);
});
audio.addEventListener('seeked', () => clearTimeout(_seekStallTimer));

window.addEventListener('beforeunload', () => {
    flushTelemetry();
});

audio.addEventListener('timeupdate', e => {
    const { duration, currentTime } = e.srcElement;

    // Telemetry time accumulation
    if (currentTime > lastTimeUpdateValue && (currentTime - lastTimeUpdateValue) < 2) {
        // Accumulate delta if playback is normal (not seeking backwards, not seeking far forward)
        accumulatedTelemetryTime += (currentTime - lastTimeUpdateValue);
    }
    lastTimeUpdateValue = currentTime;

    if (accumulatedTelemetryTime >= 10) {
        flushTelemetry();
    }

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

/* ========== PROGRESS BAR DRAG ========== */

let isDraggingProgress = false;
let isDraggingDedicatedProgress = false;

function updateProgressFromEvent(e, containerElem) {
    if (!canSeek || !audio.duration) return;
    const rect = containerElem.getBoundingClientRect();
    let clientX = Math.max(rect.left, Math.min(e.clientX || e.touches[0].clientX, rect.right));
    audio.currentTime = ((clientX - rect.left) / rect.width) * audio.duration;
}

progressContainer.addEventListener('mousedown', e => { isDraggingProgress = true; updateProgressFromEvent(e, progressContainer); });
document.addEventListener('mousemove', e => {
    if (isDraggingProgress) updateProgressFromEvent(e, progressContainer);
    if (isDraggingDedicatedProgress) updateProgressFromEvent(e, dedicatedProgressContainer);
});
document.addEventListener('mouseup', () => {
    isDraggingProgress = false;
    isDraggingDedicatedProgress = false;
});

/* Touch support for progress bar */
progressContainer.addEventListener('touchstart', e => {
    if (e.touches.length === 1) { isDraggingProgress = true; updateProgressFromEvent(e, progressContainer); }
}, { passive: true });
document.addEventListener('touchmove', e => {
    if (isDraggingProgress && e.touches.length === 1) updateProgressFromEvent(e, progressContainer);
    if (isDraggingDedicatedProgress && e.touches.length === 1) updateProgressFromEvent(e, dedicatedProgressContainer);
}, { passive: true });
document.addEventListener('touchend', () => {
    isDraggingProgress = false;
    isDraggingDedicatedProgress = false;
});

progressContainer.addEventListener('wheel', e => {
    e.preventDefault();
    if (!canSeek || !audio.duration) return;
    audio.currentTime = e.deltaY < 0
        ? Math.min(audio.currentTime + 5, audio.duration)
        : Math.max(audio.currentTime - 5, 0);
}, { passive: false });

/* Dedicated Progress Bar Listeners */
if (dedicatedProgressContainer) {
    dedicatedProgressContainer.addEventListener('mousedown', e => { isDraggingDedicatedProgress = true; updateProgressFromEvent(e, dedicatedProgressContainer); });
    dedicatedProgressContainer.addEventListener('touchstart', e => {
        if (e.touches.length === 1) { isDraggingDedicatedProgress = true; updateProgressFromEvent(e, dedicatedProgressContainer); }
    }, { passive: true });

    dedicatedProgressContainer.addEventListener('wheel', e => {
        e.preventDefault();
        if (!canSeek || !audio.duration) return;
        audio.currentTime = e.deltaY < 0
            ? Math.min(audio.currentTime + 5, audio.duration)
            : Math.max(audio.currentTime - 5, 0);
    }, { passive: false });
}

/* ========== VOLUME ========== */

let lastVolume = parseFloat(localStorage.getItem('streamify_volume')) || 0.7;

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

    if (!title) return;

    lyricsSelectionLoading.classList.remove('hidden');
    lyricsSelectionResults.innerHTML = '';
    lyricsSelectionEmpty.classList.add('hidden');

    try {
        const url = new URL('https://lrclib.net/api/search');
        url.searchParams.append('q', `${title} ${artist}`.trim());

        const response = await fetch(url);
        if (response.ok) {
            const results = await response.json();
            lyricsSelectionLoading.classList.add('hidden');

            if (results && results.length > 0) {
                renderLyricsSelectionResults(results);
            } else {
                lyricsSelectionEmpty.classList.remove('hidden');
            }
        } else {
            lyricsSelectionLoading.classList.add('hidden');
            lyricsSelectionEmpty.classList.remove('hidden');
        }
    } catch (e) {
        console.error("Lyrics search failed:", e);
        lyricsSelectionLoading.classList.add('hidden');
        lyricsSelectionEmpty.classList.remove('hidden');
    }
}

function renderLyricsSelectionResults(results) {
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
        artistSpan.textContent = `${result.artistName || 'Unknown Artist'} • ${result.albumName || 'Unknown Album'} (${durationStr})`;

        const typeSpan = document.createElement('div');
        typeSpan.style.fontSize = '11px';
        typeSpan.style.marginTop = '4px';

        if (result.syncedLyrics) {
            typeSpan.innerHTML = `<span style="background: var(--accent); color: #000; padding: 2px 6px; border-radius: 4px; font-weight: bold;">Synced</span>`;
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
        selectBtn.style.cssText = 'background: var(--accent); color: #000; font-weight: bold; padding: 6px 12px; border-radius: 30px;';
        selectBtn.textContent = 'Select';
        selectBtn.onclick = () => selectLyricsResult(result);

        if (!result.syncedLyrics && !result.plainLyrics) {
            selectBtn.disabled = true;
            selectBtn.style.opacity = '0.5';
        }

        resultItem.appendChild(infoDiv);
        resultItem.appendChild(selectBtn);

        lyricsSelectionResults.appendChild(resultItem);
    });
}

function selectLyricsResult(result) {
    const songId = window.currentlyPlayingSongId;
    if (!songId) return;

    const lyricsToSave = result.syncedLyrics || result.plainLyrics;
    const isSynced = !!result.syncedLyrics;

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
    fetch(`/api/lyrics/${songId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        console.error("Failed to save selected lyrics:", err);
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
let previousSidebarActiveEl = null; // snapshot of the active sidebar link (nav or playlist)

if (playerImg) {
    playerImg.addEventListener('click', () => {
        // Remember which section we were on before opening the player
        const activeSection = document.querySelector('main.main-content > div.content-container > section:not(.hidden)');
        if (activeSection && activeSection.id !== 'player-section') {
            previousSectionId = activeSection.id;
        }

        // Snapshot the active sidebar element so we can restore it when the player is closed
        previousSidebarActiveEl = document.querySelector(
            '.sidebar-nav a.active, #sidebar-playlist-list li a.active, #sidebar-playlist-list li.active > a'
        );

        if (typeof window.hideAllSections === 'function' && playerSection) {
            window.hideAllSections();
            window.showSection(playerSection);
            document.body.classList.add('player-section-active');
            updateMarquee(dedicatedTitle);
            updateMarquee(dedicatedArtist);
        } else {
            // Fallback if ui.js navigation is not available
            document.querySelectorAll('main.main-content > div.content-container > section').forEach(sec => {
                sec.classList.add('hidden');
            });
            document.querySelectorAll('.sidebar-nav ul li a').forEach(link => {
                link.classList.remove('active');
            });

            if (playerSection) {
                playerSection.classList.remove('hidden');
                document.body.classList.add('player-section-active');
                updateMarquee(dedicatedTitle);
                updateMarquee(dedicatedArtist);
            }
        }
    });
}

// Back Button from Dedicated Player
const btnCloseDedicated = document.getElementById('close-dedicated-player');
if (btnCloseDedicated) {
    btnCloseDedicated.addEventListener('click', () => {
        document.body.classList.remove('player-section-active');

        if (typeof window.hideAllSections === 'function' && previousSectionId) {
            const prevSec = document.getElementById(previousSectionId);
            if (prevSec) {
                window.hideAllSections();
                window.showSection(prevSec);

                // Re-highlight the correct sidebar nav link
                const navMap = {
                    'feed-section':       'home-link',
                    'trending-section':   'library-link',
                    'people-section':     'people-link',
                    'upload-section':     'upload-link',
                    'about-section':      'about-link',
                    'playlist-detail-section': null,
                };
                const linkId = navMap[previousSectionId];
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

                return;
            }
        }

        // True fallback: history was lost, go to library
        document.getElementById('library-link')?.click();
    });
}


/* ========== DEDICATED PLAYER LYRICS LOGIC ========== */
let lyricsData = []; // Array of {time: seconds, text: string}
let isLyricsActive = false;
let isUserScrollingLyrics = false;
let userScrollingLyricsTimeout = null;

/* ========== SCREEN WAKE LOCK (keeps screen on during lyrics) ========== */
let _wakeLockSentinel = null;

async function _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        _wakeLockSentinel = await navigator.wakeLock.request('screen');
        _wakeLockSentinel.addEventListener('release', () => { _wakeLockSentinel = null; });
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
    if (document.visibilityState === 'visible' && isLyricsActive) {
        _acquireWakeLock();
    }
});

const btnCloseLyrics = document.getElementById('close-lyrics-btn');
const standardContainer = document.getElementById('dedicated-standard-container');
const lyricsContainer = document.getElementById('dedicated-lyrics-container');

function handleLyricsInteraction() {
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
window.addEventListener('wheel', handleLyricsInteraction, { passive: true });
window.addEventListener('touchmove', handleLyricsInteraction, { passive: true });

if (btnLyrics) {
    btnLyrics.addEventListener('click', () => {
        isLyricsActive = true;
        isUserScrollingLyrics = false;
        standardContainer.classList.add('hidden');
        lyricsContainer.classList.remove('hidden');
        const contentArea = document.querySelector('.dedicated-player-content');
        if (contentArea) contentArea.classList.add('lyrics-active-view');
        document.body.classList.add('lyrics-view-active');
        scrollToActiveLyric();
        _acquireWakeLock(); // Keep screen on while reading lyrics
    });
}

if (btnCloseLyrics) {
    btnCloseLyrics.addEventListener('click', () => {
        isLyricsActive = false;
        lyricsContainer.classList.add('hidden');
        standardContainer.classList.remove('hidden');
        const contentArea = document.querySelector('.dedicated-player-content');
        if (contentArea) contentArea.classList.remove('lyrics-active-view');
        document.body.classList.remove('lyrics-view-active');
        _releaseWakeLock(); // Allow screen to sleep again
    });
}

function resetLyrics() {
    lyricsData = [];
    if (lyricsContent) lyricsContent.innerHTML = '';
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
        isLyricsActive = false;
        _releaseWakeLock(); // Song changed — release wake lock
        document.body.classList.remove('lyrics-view-active');
        if (lyricsContainer) lyricsContainer.classList.add('hidden');
        if (standardContainer) standardContainer.classList.remove('hidden');
        const contentArea = document.querySelector('.dedicated-player-content');
        if (contentArea) contentArea.classList.remove('lyrics-active-view');
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
    if (!title || !navigator.onLine) return;
    if (songId !== window.currentlyPlayingSongId) return;

    try {
        // Try fetching from our server first
        if (songId) {
            let lyricsUrl = `/api/lyrics/${songId}`;
            if (preferUser) lyricsUrl += `?prefer=${encodeURIComponent(preferUser)}`;
            const serverResponse = await fetch(lyricsUrl);
            if (songId !== window.currentlyPlayingSongId) return; // Verify again after await

            if (serverResponse.ok) {
                const cachedData = await serverResponse.json();
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
                const response = await fetch(url);
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
        if (songId !== window.currentlyPlayingSongId) return;

        // Try 2: Title only (sometimes artist name in metadata vs LRCLIB differs)
        if (!data && searchArtist) {
            console.log(`[LYRICS] Stage 1 failed. Trying Stage 2 (Title only): "${searchTitle}"`);
            data = await tryFetch(searchTitle, '');
            if (songId !== window.currentlyPlayingSongId) return;
        }

        // Try 3: Aggressive stripping (remove all non-alphanumeric)
        if (!data) {
            let ultraCleanTitle = searchTitle.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            if (ultraCleanTitle && ultraCleanTitle !== searchTitle) {
                console.log(`[LYRICS] Stage 2 failed. Trying Stage 3 (Aggressive): "${ultraCleanTitle}"`);
                data = await tryFetch(ultraCleanTitle, '');
            }
        }

        // Try 4: Text before brackets (handles "Title (Live at...)")
        if (!data && (searchTitle.includes('(') || searchTitle.includes('['))) {
            let beforeBrackets = searchTitle.split(/[\(\[]/)[0].trim();
            if (beforeBrackets && beforeBrackets.length > 2) {
                console.log(`[LYRICS] Stage 3 failed. Trying Stage 4 (Before Brackets): "${beforeBrackets}"`);
                data = await tryFetch(beforeBrackets, searchArtist);
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
        fetch(`/api/lyrics/${songId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        console.error("Failed to fetch lyrics:", err);
        if (songId === window.currentlyPlayingSongId && btnFindLyrics) {
            if (btnLyrics) btnLyrics.classList.remove('show-lyrics-btn');
            btnFindLyrics.classList.add('show-lyrics-btn');
            btnFindLyrics.parentElement.classList.add('has-lyrics');
        }
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
    lyricsContent.innerHTML = '';

    const data = isLyricEditMode ? tempLyricsData : lyricsData;

    data.forEach((line, index) => {
        const lineEl = document.createElement('div');
        lineEl.className = 'lyric-line';
        if (line.text === '♪') lineEl.classList.add('instrumental');

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
            syncBtn.style.background = 'rgba(29, 185, 84, 0.2)';
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
            lineEl.innerHTML = line.text.replace(/\n/g, '<br>');
            lineEl.dataset.index = index;
            lineEl.dataset.time = line.time;

            // Click to seek
            lineEl.addEventListener('click', () => {
                if (audio && isFinite(line.time)) {
                    audio.currentTime = line.time;
                    audio.play();
                    isUserScrollingLyrics = false;
                }
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
                <button class="offset-btn" onclick="shiftAllLyrics(-500)">-0.5s</button>
                <button class="offset-btn" onclick="shiftAllLyrics(-100)">-0.1s</button>
                <button class="offset-btn" onclick="shiftAllLyrics(100)">+0.1s</button>
                <button class="offset-btn" onclick="shiftAllLyrics(500)">+0.5s</button>
            </div>
            <div style="font-size: 11px; color: #666;">Tip: Press 'S' to sync active line</div>
        `;
        lyricsContent.appendChild(footer);
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

        const res = await fetch(`/api/lyrics/${songId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lyrics: lyricsPayload,
                is_synced: isSynced
            })
        });

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
        const res = await fetch(`/api/lyrics/${songId}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            console.log("[LYRICS] Cache cleared.");
            isLyricEditMode = false;
            btnEditLyrics.classList.remove('active');
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

            lineEl.style.background = "rgba(29, 185, 84, 0.3)";
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

function updateActiveLyric() {
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
        const currentActiveEl = lyricsContent.querySelector('.lyric-line.active');
        const newActiveEl = lyricsContent.children[activeIndex];

        if (currentActiveEl !== newActiveEl) {
            if (currentActiveEl) currentActiveEl.classList.remove('active');
            if (newActiveEl) {
                newActiveEl.classList.add('active');
                scrollToActiveLyric(newActiveEl);
            }
        }
    }
}

function scrollToActiveLyric(activeEl = null) {
    if (!lyricsScrollArea || !lyricsContent || isUserScrollingLyrics || isLyricEditMode) return;

    if (!activeEl) {
        activeEl = lyricsContent.querySelector('.lyric-line.active');
    }

    if (activeEl) {
        // Always scroll within the lyricsScrollArea container.
        // On mobile the lyrics container is now a fixed overlay so
        // lyricsScrollArea is the correct scroll parent (no more window-level scrolling).
        const containerHeight = lyricsScrollArea.clientHeight;
        const scrollAreaRect = lyricsScrollArea.getBoundingClientRect();
        const activeRect = activeEl.getBoundingClientRect();

        const relativeTop = (activeRect.top - scrollAreaRect.top) + lyricsScrollArea.scrollTop;

        lyricsScrollArea.scrollTo({
            top: relativeTop - (containerHeight / 2) + (activeRect.height / 2),
            behavior: 'smooth'
        });
    }
}

// Ensure resize events adjust scroll if lyrics are open
window.addEventListener('resize', () => {
    if (isLyricsActive) {
        scrollToActiveLyric();
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

/* ========== COVER EXPAND OVERLAY (DEPRECATED) ========== */

/*
const coverOverlay    = document.getElementById('cover-expand-overlay');
const coverExpandImg  = document.getElementById('cover-expand-img');
const coverExpandTitle  = document.querySelector('.cover-expand-title');
const coverExpandArtist = document.querySelector('.cover-expand-artist');

function openCoverExpand() {
    if (!coverOverlay || !coverExpandImg) return;
    coverExpandImg.src = playerImg.src;
    if (coverExpandTitle)  coverExpandTitle.textContent  = playerTitle.textContent;
    if (coverExpandArtist) coverExpandArtist.textContent = playerArtist.textContent;
    coverOverlay.classList.add('show');
}

function closeCoverExpand() {
    if (coverOverlay) coverOverlay.classList.remove('show');
}

if (playerImg) {
    playerImg.addEventListener('click', openCoverExpand);
}

if (coverOverlay) {
    coverOverlay.addEventListener('click', e => {
        if (e.target === coverOverlay || e.target === coverExpandImg) closeCoverExpand();
    });
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCoverExpand();
});
*/

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

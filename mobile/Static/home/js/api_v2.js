/**
 * ============================================================================
 * STREAMIFY - api.js
 * ============================================================================
 * All network calls: trending, library, people, current user, search.
 * Depends on: config.js, player.js (playSongAtIndex, currentPlaylist, etc.)
 * ============================================================================
 */

let socket; // Global for identification access
let isLibraryEditMode = false;
let selectedSongIds = new Set();
let isPlaylistEditMode = false;
let selectedPlaylistSongIds = new Set();
let feedState = {
    sortBy: 'newest',
    page: 1,
    limit: 10,
    hasMore: true,
    isLoading: false
};

/* ========== UTILITIES ========== */

function getQualityBadgeHTML(song) {
    if (!song) return '';
    let bitrate = Number(song.bitrate);
    if (!Number.isFinite(bitrate) || bitrate <= 0) bitrate = 0;
    if (bitrate && bitrate > 1000) {
        bitrate = Math.round(bitrate / 1000);
    }
    let extension = typeof song.extension === 'string' ? song.extension : '';
    
    // Fallback if bitrate is missing but it's not FLAC
    if (!bitrate && !extension.toLowerCase().includes('flac')) {
        bitrate = 128; 
    }
    
    const isFlac = (extension && extension.toLowerCase().includes('flac'));
    const label = isFlac ? 'FLAC' : `${bitrate}kbps`;
    
    return `<span class="artist-separator"></span><span class="quality-badge">${label}</span>`;
}

function escapeHTML(str) {
    if (!str) return "";
    const htmlEntities = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return String(str).replace(/[&<>"']/g, s => htmlEntities[s]);
}

function parseMentions(text) {
    if (!text) return "";
    // First escape the text to prevent XSS
    let escaped = escapeHTML(text);
    // Then replace @username with clickable links
    return escaped.replace(/@(\w+)/g, (match, username) => {
        return `<a href="/profile/${username}" class="mention-link" onclick="event.stopPropagation(); if(typeof openUserProfileModal==='function'){openUserProfileModal('${username}');}else if(window.navigateToProfile){window.navigateToProfile('${username}');}else{window.location.href='/profile/${username}';} return false;">@${username}</a>`;
    });
}

function truncateString(str, len = 30) {
    if (!str) return "";
    return str.length > len ? str.substring(0, len) + "..." : str;
}

function buildPlaylistOrder(length) {
    const order = [...Array(length).keys()];
    if (typeof isShuffle !== 'undefined' && isShuffle) {
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
    }
    return order;
}

function safeStyleURL(url) {
    url = safeImageURL(url);
    if (!url) return '';
    // The URL constructor rejects non-http(s) schemes before CSS escaping.
    return url.replace(/[)'"]/g, '');
}

function getDownloadedSongIdSet() {
    if (!window.OfflineStore) return Promise.resolve(new Set());
    return window.OfflineStore.getOfflineSongs()
        .then(songs => new Set(songs.map(song => String(song.id))))
        .catch(error => {
            console.warn('[OFFLINE STATUS] Could not read downloaded songs:', error);
            return new Set();
        });
}

window.triggerDownload = async function (songId, btnElement) {
    if (!window.OfflineStore) return;
    if (!navigator.onLine && !btnElement.classList.contains('downloaded')) return;

    const icon = btnElement.querySelector('i');
    const isDownloaded = await window.OfflineStore.isSongDownloaded(songId);

    if (isDownloaded) {
        // If offline, ignore clicks on already downloaded (green) buttons
        if (!navigator.onLine) {
            showToast("Cannot delete downloads while offline", "warning");
            return;
        }

        // If already downloaded, delete it
        icon.className = 'bx bx-loader-alt bx-spin';
        try {
            await window.OfflineStore.removeOfflineSong(songId);
            icon.className = 'bx bx-download';
            btnElement.classList.remove('downloaded');
            btnElement.style.color = '#fff';
            // If offline, remove the row from DOM
            if (!navigator.onLine) {
                const row = btnElement.closest('.song-row');
                if (row) row.remove();
            }
        } catch (e) {
            console.error('Removal failed', e);
            icon.className = 'bx bxs-check-circle';
        }
        return;
    }

    icon.className = 'bx bx-loader-alt bx-spin';

    try {
        await window.OfflineStore.downloadSong(songId);
        icon.className = 'bx bxs-check-circle';
        btnElement.classList.add('downloaded');
        btnElement.style.color = '#4CAF50';
    } catch (e) {
        console.error('Download failed', e);
        icon.className = 'bx bx-error';
        setTimeout(() => icon.className = 'bx bx-download', 2000);
    }
};

window.downloadAllSongs = async function (songs, btnElement) {
    if (!window.OfflineStore || !songs || songs.length === 0) return;
    if (!navigator.onLine) {
        showToast("Cannot download while offline", "warning");
        return;
    }

    const icon = btnElement.querySelector('i');
    icon.className = 'bx bx-loader-alt bx-spin';
    btnElement.style.pointerEvents = 'none';

    let successCount = 0;
    const downloadedIds = await getDownloadedSongIdSet();

    for (const song of songs) {
        try {
            const isDownloaded = downloadedIds.has(String(song.id));
            if (!isDownloaded) {
                await window.OfflineStore.downloadSong(song.id);
                downloadedIds.add(String(song.id));

                // Try to update individual row icons if visible
                const listContainer = btnElement.closest('section')?.querySelector('.song-list');
                if (listContainer) {
                    const row = listContainer.querySelector(`.song-row[data-id="${song.id}"]`);
                    if (row) {
                        const rowBtn = row.querySelector('.row-download-btn');
                        if (rowBtn) {
                            const rowIcon = rowBtn.querySelector('i');
                            if (rowIcon) {
                                rowIcon.className = 'bx bxs-check-circle';
                                rowBtn.classList.add('downloaded');
                                rowBtn.style.color = '#4CAF50';
                            }
                        }
                    }
                }
            }
            successCount++;
        } catch (e) {
            console.error(`Failed to download song ${song.id}:`, e);
        }
    }

    icon.className = 'bx bx-cloud-download';
    btnElement.style.pointerEvents = 'auto';

    if (successCount === songs.length) {
        showToast("Successfully downloaded all songs!", "success");
    } else {
        showToast(`Downloaded ${successCount}/${songs.length} songs`, "warning");
    }
};

/* ========== RENDER HELPERS ========== */

const songListRenderTokens = new WeakMap();

function renderSongList(songs, listContainer, options = {}) {
    if (!listContainer) return;
    const {
        allowHiddenInitialBatch = false,
        deferSecondaryWork = false,
        deferRemainingBatches = false
    } = options;

    const header = listContainer.querySelector('.header-row');
    listContainer.replaceChildren(...(header ? [header] : []));

    const renderToken = {};
    songListRenderTokens.set(listContainer, renderToken);

    const renderedPlaylist = (songs || []).map(s => ({
        id: s.id,
        title: s.name || s.title || s,
        artist: s.artist || 'Unknown Artist',
        album: s.album || 'Single',
        cover: s.cover,
        uploaded_by: s.uploaded_by || 'Unknown',
        duration: s.duration,
        is_private: s.is_private || 'public',
        bitrate: s.bitrate,
        source: s.source,
        extension: s.extension,
        url: `/api/play/${s.id || encodeURIComponent(s.name || s.title || s)}`
    }));
    currentPlaylist = renderedPlaylist;
    shuffledPlaylist = buildPlaylistOrder(currentPlaylist.length);

    let downloadedIds = null;
    const markDownloaded = row => {
        if (!downloadedIds || !downloadedIds.has(String(row.dataset.id))) return;
        const icon = row.querySelector('.row-download-btn i');
        if (!icon) return;
        icon.className = 'bx bxs-check-circle';
        icon.parentElement.classList.add('downloaded');
        icon.parentElement.style.color = '#4CAF50';
    };

    const loadDownloadedState = () => getDownloadedSongIdSet().then(ids => {
        if (songListRenderTokens.get(listContainer) !== renderToken) return;
        downloadedIds = ids;
        listContainer.querySelectorAll('.song-row[data-id]').forEach(markDownloaded);
    });
    if (deferSecondaryWork && typeof window.streamifyAfterStartupMotion === 'function') {
        window.streamifyAfterStartupMotion(loadDownloadedState);
    } else {
        loadDownloadedState();
    }

    const createSongRow = (song, index) => {
        const duration = song.duration || '--:--';
        let songCover = song.coverDataUrl || song.cover;
        if (song.localCoverPath && window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
            songCover = window.Capacitor.convertFileSrc(song.localCoverPath);
        } else if (songCover && songCover.startsWith('/') && window.API_BASE_URL) {
            songCover = window.API_BASE_URL.replace(/\/+$/, '') + songCover;
        }
        const hasCover = !!(songCover);
        const cover = safeImageURL(hasCover ? songCover : COVER_PLACEHOLDER, COVER_PLACEHOLDER);

        const title = escapeHTML(song.title);
        const artist = escapeHTML(song.artist);
        const album = escapeHTML(song.album);
        const uploadedBy = escapeHTML(song.uploaded_by || 'Unknown');
        const safeDuration = escapeHTML(duration);

        const row = document.createElement('div');
        row.className = 'song-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `Play ${song.title} by ${song.artist}`);
        if (isLibraryEditMode) row.classList.add('edit-mode');
        if (selectedSongIds.has(song.id)) row.classList.add('selected');

        row.dataset.id = song.id;
        row.dataset.index = index;
        if (isPlaying && String(window.currentlyPlayingSongId) === String(song.id)) {
            row.classList.add('playing');
        }

        const isOwner = appCache.user && String(appCache.user.role || '').toLowerCase() === 'owner';
        const canEdit = !!appCache.user && (isOwner || (song.source !== 'folder' && appCache.user.username === song.uploaded_by));
        const isPrivate = song.is_private === 'private';
        const visibilityIcon = isPrivate
            ? `<i class='bx bx-lock-alt' style="font-size:14px;color:var(--text-secondary);margin-left:6px;" title="Private"></i>`
            : `<i class='bx bx-globe' style="font-size:14px;color:var(--text-secondary);margin-left:6px;opacity:0.5;" title="Public"></i>`;

        row.innerHTML = `<div class="index-cell"><div class="select-indicator"></div><span class="row-index-number">${index + 1}</span></div><div class="song-info"><img alt="cover" class="song-cover-img" loading="lazy" decoding="async"><div><div class="song-title-row">${title}</div><div style="font-size: 12px;">${artist}</div></div></div><span>${album}</span><span>${uploadedBy}</span><span>${safeDuration}${visibilityIcon}</span><div class="edit-btn-container">
            <button type="button" class="row-download-btn" aria-label="Download ${title}"><i class='bx bx-download'></i></button>
            ${canEdit ? `<button type="button" class="row-edit-btn" title="Edit song metadata" aria-label="Edit ${title}"><i class='bx bx-edit-alt'></i></button>` : ''}
        </div>`;

        const imgEl = row.querySelector('.song-cover-img');
        if (imgEl) imgEl.src = cover;
        const downloadBtn = row.querySelector('.row-download-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', event => {
                event.stopPropagation();
                triggerDownload(song.id, downloadBtn);
            });
        }
        const editBtn = row.querySelector('.row-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', event => {
                event.stopPropagation();
                openEditSongModal(index);
            });
        }

        markDownloaded(row);

        /* Touch & Click handling */
        let isScrolling = false, startX = 0, startY = 0, touchHandled = false;
        row.addEventListener('touchstart', e => {
            isScrolling = false;
            touchHandled = false;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });
        row.addEventListener('touchmove', e => {
            if (Math.abs(e.touches[0].clientX - startX) > 10 ||
                Math.abs(e.touches[0].clientY - startY) > 10) isScrolling = true;
        }, { passive: true });
        row.addEventListener('touchend', e => {
            if (e.target.closest('.row-edit-btn') || e.target.closest('.edit-btn-container') || e.target.closest('.row-menu-btn') || e.target.closest('.song-context-menu')) return;
            if (!isScrolling) {
                touchHandled = true;
                if (isLibraryEditMode) {
                    toggleSongSelection(song.id, row);
                } else {
                    if (e.cancelable) e.preventDefault();
                    playSongAtIndex(index);
                }
            }
        });

        row.addEventListener('click', e => {
            if (touchHandled) { touchHandled = false; return; }
            if (e.target.closest('.row-edit-btn') || e.target.closest('.edit-btn-container') || e.target.closest('.row-menu-btn') || e.target.closest('.song-context-menu')) return;

            if (isLibraryEditMode) {
                toggleSongSelection(song.id, row);
            } else {
                playSongAtIndex(index);
            }
        });
        row.addEventListener('keydown', e => {
            if ((e.key !== 'Enter' && e.key !== ' ') || e.target.closest('button')) return;
            e.preventDefault();
            if (isLibraryEditMode) toggleSongSelection(song.id, row);
            else playSongAtIndex(index);
        });

        /* Hover scroll for long titles */
        row.addEventListener('mouseenter', () => {
            const titleEl = row.querySelector('.song-title-row');
            if (titleEl && titleEl.scrollWidth > titleEl.clientWidth) {
                titleEl.style.setProperty('--scroll-amount', `-${titleEl.scrollWidth - titleEl.clientWidth + 10}px`);
                titleEl.classList.add('scrolling');
            }
        });
        row.addEventListener('mouseleave', () => {
            const titleEl = row.querySelector('.song-title-row');
            if (titleEl) {
                titleEl.classList.remove('scrolling');
                titleEl.style.removeProperty('--scroll-amount');
            }
        });

        return row;
    };

    // Paint the first viewport quickly, then yield between larger batches. The
    // section animation is unchanged; this only prevents one long DOM task from
    // blocking its frames when a library contains hundreds of songs.
    let nextIndex = 0;
    let remainingBatchesDeferred = false;
    const appendBatch = (batchSize, allowHidden = false) => {
        if (songListRenderTokens.get(listContainer) !== renderToken) return;
        const section = listContainer.closest('section');
        if (!allowHidden && section && section.classList.contains('hidden')) {
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => appendBatch(batchSize, true), { timeout: 500 });
            } else {
                setTimeout(() => appendBatch(batchSize, true), 100);
            }
            return;
        }

        const fragment = document.createDocumentFragment();
        const end = Math.min(renderedPlaylist.length, nextIndex + batchSize);
        for (; nextIndex < end; nextIndex++) {
            fragment.appendChild(createSongRow(renderedPlaylist[nextIndex], nextIndex));
        }
        listContainer.appendChild(fragment);

        if (nextIndex < renderedPlaylist.length) {
            if (
                deferRemainingBatches &&
                !remainingBatchesDeferred &&
                typeof window.streamifyAfterStartupMotion === 'function'
            ) {
                remainingBatchesDeferred = true;
                window.streamifyAfterStartupMotion(() => appendBatch(48, true));
            } else {
                requestAnimationFrame(() => appendBatch(48));
            }
        } else {
            highlightCurrentSong(listContainer);
        }
    };

    appendBatch(24, allowHiddenInitialBatch);
}

function highlightCurrentSong(listContainer) {
    if (currentIndex < 0 || !isPlaying || !window.currentlyPlayingSongId) return;
    const rows = listContainer.querySelectorAll('.song-row:not(.header-row)');
    rows.forEach(row => {
        if (row.dataset.id == window.currentlyPlayingSongId) {
            row.classList.add('playing');
        }
    });
}

/* ========== LIBRARY MANAGEMENT FUNCTIONS ========== */

function toggleLibraryEditMode() {
    isLibraryEditMode = !isLibraryEditMode;
    const btn = document.getElementById('manage-library-btn');
    const bar = document.getElementById('batch-actions-bar');
    const list = document.getElementById('trending-list');

    if (isLibraryEditMode) {
        btn.classList.add('active');
        btn.innerHTML = "<i class='bx bx-check'></i>";
        bar.classList.remove('hidden');
    } else {
        clearLibrarySelection();
        btn.classList.remove('active');
        btn.innerHTML = "<i class='bx bx-pencil'></i>";
        bar.classList.add('hidden');
    }

    if (list) {
        if (window.currentActiveView === 'library') {
            if (!navigator.onLine && window.OfflineStore) {
                window.OfflineStore.getOfflineSongs().then(songs => {
                    renderSongList(songs, list);
                });
            } else {
                renderSongList(appCache.library, list);
            }
        }
    }
}

function clearLibrarySelection() {
    selectedSongIds.clear();
    updateSelectedCount();
    const btn = document.getElementById('manage-library-btn');
    const bar = document.getElementById('batch-actions-bar');
    if (btn) { btn.classList.remove('active'); btn.innerHTML = "<i class='bx bx-pencil'></i>"; }
    if (bar) bar.classList.add('hidden');
    isLibraryEditMode = false;
    document.querySelectorAll('.song-row.selected').forEach(r => r.classList.remove('selected'));
    if (window.currentActiveView === 'library') {
        const list = document.getElementById('trending-list');
        if (!navigator.onLine && window.OfflineStore) {
            window.OfflineStore.getOfflineSongs().then(songs => {
                renderSongList(songs, list);
            });
        } else if (appCache.library) {
            renderSongList(appCache.library, list);
        }
    }
}

function toggleSongSelection(id, row) {
    if (selectedSongIds.has(id)) {
        selectedSongIds.delete(id);
        row.classList.remove('selected');
    } else {
        selectedSongIds.add(id);
        row.classList.add('selected');
    }
    updateSelectedCount();
}

function updateSelectedCount() {
    const el = document.getElementById('selected-count');
    if (el) el.textContent = selectedSongIds.size;
}

function deleteSelectedSongs() {
    if (selectedSongIds.size === 0) return;

    const ids = Array.from(selectedSongIds);
    fetch(window.API_BASE_URL + '/api/songs/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ids })
    })
        .then(r => r.json())
        .then(data => {
            if (data.success && data.success.length > 0) {
                // Refresh library
                fetchLibrary(true);
                toggleLibraryEditMode();
            } else if (data.failed && data.failed.length > 0) {
                showToast(`Failed to delete some songs. ${data.failed[0].error}`, 'error');
            }
        })
        .catch(err => console.error('[BULK DELETE]', err));
}

let _editSongAbort = null;

function cancelEditSongRequest() {
    if (_editSongAbort) _editSongAbort.abort();
    _editSongAbort = null;
}
window.cancelEditSongRequest = cancelEditSongRequest;

function openEditSongModal(index) {
    const song = currentPlaylist[index];
    if (!song) return;

    if (typeof cancelSmartMetadataReview === 'function') cancelSmartMetadataReview();
    cancelEditSongRequest();
    const controller = new AbortController();
    _editSongAbort = controller;

    const modal = document.getElementById('edit-song-modal');
    document.getElementById('edit-song-id').value = song.id;
    document.getElementById('edit-song-metadata-revision').value = song.metadata_revision || 0;
    document.getElementById('edit-song-name').value = song.title;
    document.getElementById('edit-song-artist').value = song.artist;
    document.getElementById('edit-song-album').value = song.album;
    const genreInput = document.getElementById('edit-song-genre');
    const yearInput = document.getElementById('edit-song-year');
    if (genreInput) genreInput.value = song.genre || '';
    if (yearInput) yearInput.value = song.year || '';

    const coverImg = document.getElementById('edit-song-cover-img');
    coverImg.src = safeImageURL(song.cover, COVER_PLACEHOLDER);

    // Fetch full song data to get visibility (is_private), genre & year
    fetch(window.API_BASE_URL + `/api/play/${encodeURIComponent(song.id)}`, { signal: controller.signal })
        .then(r => {
            if (!r.ok) throw new Error(`Song request failed: ${r.status}`);
            return r.json();
        })
        .then(fullData => {
            if (_editSongAbort !== controller || document.getElementById('edit-song-id').value !== String(song.id)) return;
            document.getElementById('edit-song-visibility').value = fullData.is_private === 'private' ? 'private' : 'public';
            document.getElementById('edit-song-name').value = fullData.name || '';
            document.getElementById('edit-song-artist').value = fullData.artist || '';
            document.getElementById('edit-song-album').value = fullData.album || '';
            document.getElementById('edit-song-metadata-revision').value = fullData.metadata_revision || 0;
            if (genreInput) genreInput.value = fullData.genre || '';
            if (yearInput) yearInput.value = fullData.year || '';
            if (coverImg) coverImg.src = safeImageURL(fullData.cover, COVER_PLACEHOLDER);
        })
        .catch(err => {
            if (err.name !== 'AbortError') console.warn('[EDIT SONG DETAILS]', err);
        })
        .finally(() => {
            if (_editSongAbort === controller) _editSongAbort = null;
        });

    modal.classList.remove('hidden');
}

function saveSongChanges() {
    cancelEditSongRequest();
    const id = document.getElementById('edit-song-id').value;
    const songname = document.getElementById('edit-song-name').value;
    const artist = document.getElementById('edit-song-artist').value;
    const album = document.getElementById('edit-song-album').value;
    const genre = document.getElementById('edit-song-genre') ? document.getElementById('edit-song-genre').value : undefined;
    const year = document.getElementById('edit-song-year') ? document.getElementById('edit-song-year').value : undefined;
    const is_private = document.getElementById('edit-song-visibility').value;
    const expectedRevision = Number(document.getElementById('edit-song-metadata-revision').value) || 0;

    fetch(window.API_BASE_URL + `/api/songs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ songname, artist, album, genre, year, is_private, expectedRevision })
    })
        .then(r => r.json())
        .then(data => {
            if (document.getElementById('edit-song-id').value !== String(id)) return;
            if (data.success) {
                document.getElementById('edit-song-modal').classList.add('hidden');
                fetchLibrary(true);
                showToast('Song details updated successfully!', 'success');
            } else {
                showToast(data.error || 'Failed to save song changes', 'error');
            }
        });
}

// ============================================
// SMART METADATA REVIEW JOB / REVIEW SYSTEM
// ============================================

let _aiReviewState = null;
let _aiReviewAbort = null;
let _aiApplyAbort = null;
let _aiPollTimer = null;
let _aiSessionSequence = 0;
let _enrichmentSession = null;

window._enrichmentQueue = null;
window._enrichmentTotal = 0;

const AI_STAGE_INFO = Object.freeze({
    idle: { badge: 'Ready', label: 'Before you start', title: 'Ready to review', message: 'Check the review scope and lookup method before starting.' },
    preparing: { badge: 'Preparing', label: 'Preparing review', title: 'Preparing your library', message: 'Starting the metadata scan. Strong acoustic matches may fill safe, missing fields automatically.' },
    local_analysis: { badge: 'Local analysis', label: 'Reading local metadata', title: 'Analyzing local metadata', message: 'Reading embedded tags and filename hints without changing the song.' },
    fingerprinting: { badge: 'Fingerprinting', label: 'Fingerprinting audio', title: 'Fingerprinting audio', message: 'Building an audio identity for a more reliable lookup.' },
    registry_lookup: { badge: 'Registry lookup', label: 'Checking music registries', title: 'Checking music registries', message: 'Comparing returned catalogue records and source evidence.' },
    auto_matched: { badge: 'Strong match', label: 'Strong match found', title: 'Match ready', message: 'Choose which suggested fields belong in your library.' },
    needs_review: { badge: 'Review', label: 'Your decision is needed', title: 'Review needed', message: 'Compare the suggestion with your current library metadata.' },
    unidentified: { badge: 'Unidentified', label: 'No reliable match', title: 'No reliable match', message: 'Current metadata has been preserved.' },
    provider_error: { badge: 'Source error', label: 'Source problem', title: 'A source could not complete the lookup', message: 'Current metadata has been preserved. You can skip this item and continue.' },
    applying: { badge: 'Applying', label: 'Applying approved fields', title: 'Applying your decision', message: 'Saving only the fields you selected.' },
    paused: { badge: 'Paused', label: 'Scan paused', title: 'Metadata scan paused', message: 'Resume when you are ready to continue.' },
    completed: { badge: 'Completed', label: 'Review complete', title: 'Review complete', message: 'All available review items have been handled.' }
});

const FIELD_CONFIG = [
    { key: 'songname', label: 'Title', icon: 'bx-music', originalKeys: ['songname', 'title', 'name'], candidateKeys: ['songname', 'title', 'trackTitle', 'name'] },
    { key: 'artist', label: 'Artist', icon: 'bx-user', originalKeys: ['artist', 'artistName'], candidateKeys: ['artist', 'artistName', 'artists'] },
    { key: 'album', label: 'Album / release', icon: 'bx-album', originalKeys: ['album', 'release', 'releaseTitle'], candidateKeys: ['album', 'albumName', 'releaseTitle', 'collectionName'] },
    { key: 'genre', label: 'Genre', icon: 'bx-category', originalKeys: ['genre'], candidateKeys: ['genre', 'primaryGenre'] },
    { key: 'year', label: 'Year', icon: 'bx-calendar', originalKeys: ['year', 'releaseYear'], candidateKeys: ['year', 'releaseYear', 'releaseDate', 'date'] }
];

const AI_ABSENT_ENDPOINT_STATUSES = new Set([404, 405, 501]);
const AI_CANDIDATES_PER_PAGE = 4;

function aiElement(id) {
    return document.getElementById(id);
}

function aiSetVisible(id, visible) {
    const element = aiElement(id);
    if (element) element.classList.toggle('hidden', !visible);
}

function aiEscape(value) {
    return escapeHTML(value === undefined || value === null ? '' : String(value));
}

function aiHumanize(value) {
    return String(value || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, character => character.toUpperCase());
}

function aiProviderLabel(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const labels = {
        acoustid: 'AcoustID',
        musicbrainz: 'MusicBrainz',
        itunes: 'Apple Music',
        apple: 'Apple Music',
        local: 'Local metadata',
        local_file: 'Local file',
        metadata_lookup: 'Metadata lookup'
    };
    return labels[normalized] || aiHumanize(value);
}

function aiFiniteNumber(value) {
    if (typeof value === 'boolean' || value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function aiNormalizeStage(value, fallback = 'preparing') {
    const stage = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (AI_STAGE_INFO[stage]) return stage;
    const aliases = {
        queued: 'preparing', pending: 'preparing', created: 'preparing', starting: 'preparing',
        analyzing: 'local_analysis', analysing: 'local_analysis', local: 'local_analysis',
        fingerprint: 'fingerprinting', fingerprint_lookup: 'fingerprinting',
        lookup: 'registry_lookup', searching: 'registry_lookup', registry: 'registry_lookup', processing: 'registry_lookup', running: 'registry_lookup',
        matched: 'auto_matched', auto_match: 'auto_matched',
        review: 'needs_review', reviewing: 'needs_review', pending_review: 'needs_review', awaiting_review: 'needs_review', awaiting_decision: 'needs_review', requires_review: 'needs_review',
        no_match: 'unidentified', unknown: 'unidentified', not_found: 'unidentified',
        error: 'provider_error', failed: 'provider_error', rate_limited: 'provider_error', invalid_key: 'provider_error', offline: 'provider_error',
        saving: 'applying', apply: 'applying',
        pause: 'paused',
        complete: 'completed', done: 'completed', finished: 'completed', cancelled: 'completed', canceled: 'completed'
    };
    return aliases[stage] || (AI_STAGE_INFO[fallback] ? fallback : 'preparing');
}

function aiNormalizeProviderStatus(value) {
    const status = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
        ok: 'available', success: 'available', ready: 'available', online: 'available',
        match: 'matched', found: 'matched',
        nomatch: 'no_match', not_found: 'no_match', empty: 'no_match',
        unavailable: 'offline', network_error: 'offline',
        throttled: 'rate_limited', rate_limit: 'rate_limited',
        unauthorized: 'invalid_key', authentication_error: 'invalid_key', auth_error: 'invalid_key',
        failed: 'provider_error', error: 'provider_error',
        loading: 'searching', queued: 'pending'
    };
    const normalized = aliases[status] || status;
    return ['matched', 'available', 'no_match', 'offline', 'rate_limited', 'invalid_key', 'provider_error', 'searching', 'pending'].includes(normalized)
        ? normalized
        : 'unknown';
}

function aiReadProperty(source, keys) {
    if (!source || typeof source !== 'object') return undefined;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
            return source[key];
        }
    }
    return undefined;
}

function aiReadMetadataProperty(source, keys) {
    const direct = aiReadProperty(source, keys);
    if (direct !== undefined) return direct;
    for (const nestedKey of ['metadata', 'suggested', 'proposed', 'fields']) {
        const nested = source && source[nestedKey];
        const value = aiReadProperty(nested, keys);
        if (value !== undefined) return value;
    }
    return undefined;
}

function aiDisplayValue(value, fieldKey = '') {
    if (Array.isArray(value)) {
        value = value.map(item => typeof item === 'object' ? (item.name || item.artist || '') : item).filter(Boolean).join(', ');
    } else if (value && typeof value === 'object') {
        value = value.name || value.title || value.value || '';
    }
    if (fieldKey === 'year' && typeof value === 'string') {
        const yearMatch = value.match(/^\s*(\d{4})/);
        if (yearMatch) return yearMatch[1];
    }
    return value === undefined || value === null ? '' : String(value).trim();
}

function aiOriginalValue(original, field) {
    return aiDisplayValue(aiReadMetadataProperty(original, field.originalKeys), field.key);
}

function aiCandidateValue(candidate, field) {
    let value = aiReadMetadataProperty(candidate, field.candidateKeys);
    if (value === undefined && field.key === 'album' && candidate && candidate.release) {
        value = aiReadProperty(candidate.release, ['album', 'title', 'name']);
    }
    return aiDisplayValue(value, field.key);
}

function aiCandidateCover(candidate) {
    const value = aiReadMetadataProperty(candidate, ['coverUrl', 'cover_url', 'cover', 'artworkUrl', 'artwork', 'imageUrl', 'image']);
    return safeImageURL(typeof value === 'object' && value ? (value.url || value.src) : value);
}

function aiCandidateId(candidate) {
    return aiReadMetadataProperty(candidate, ['candidateId', 'candidate_id', 'releaseId', 'release_id', 'recordingId', 'recording_id', 'id']);
}

function aiIsReleaseSpecificCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (candidate._aiCandidateType === 'Release' || candidate._selectedReleaseId) return true;
    return String(candidate._aiDecisionId || '').includes('::release::');
}

function aiRequiresReleaseSelection(candidate) {
    return !aiIsReleaseSpecificCandidate(candidate) &&
        Array.isArray(candidate && candidate.releaseCandidates) &&
        candidate.releaseCandidates.length > 1;
}

function aiIsPlaceholder(value, fieldKey = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    const placeholders = new Set(['unknown', 'n/a', 'none', 'null', 'not available', 'untitled', 'untitled track']);
    if (placeholders.has(normalized)) return true;
    if (fieldKey === 'songname' && ['unknown title', 'unknown track'].includes(normalized)) return true;
    if (fieldKey === 'artist' && normalized === 'unknown artist') return true;
    if (fieldKey === 'album' && ['unknown album', 'unknown release'].includes(normalized)) return true;
    if (fieldKey === 'genre' && normalized === 'unknown genre') return true;
    return false;
}

function aiValuesDiffer(current, suggested) {
    return String(current || '').trim().toLocaleLowerCase() !== String(suggested || '').trim().toLocaleLowerCase();
}

function aiFieldAliases(fieldKey) {
    if (fieldKey === 'coverUrl') return ['coverUrl', 'cover_url', 'cover', 'cover_path', 'coverPath', 'artwork', 'artworkUrl'];
    const field = FIELD_CONFIG.find(entry => entry.key === fieldKey);
    return field ? [field.key, ...field.originalKeys, ...field.candidateKeys] : [fieldKey];
}

function aiReadFieldSetting(container, fieldKey) {
    if (container === true || container === false) return container;
    if (Array.isArray(container)) {
        const normalized = container.map(value => String(value).toLowerCase());
        return aiFieldAliases(fieldKey).some(alias => normalized.includes(String(alias).toLowerCase()));
    }
    if (!container || typeof container !== 'object') return undefined;
    for (const alias of aiFieldAliases(fieldKey)) {
        if (!Object.prototype.hasOwnProperty.call(container, alias)) continue;
        const value = container[alias];
        if (value && typeof value === 'object') {
            if (value.safeToApply !== undefined) return value.safeToApply === true;
            if (value.safe_to_apply !== undefined) return value.safe_to_apply === true;
            if (value.safe !== undefined) return value.safe === true;
            if (value.confidence !== undefined) return value.confidence;
            if (value.score !== undefined) return value.score;
        }
        return value;
    }
    return undefined;
}

function aiIsFieldSafe(state, candidate, fieldKey) {
    const sources = [
        candidate && candidate.safeToApply,
        candidate && candidate.safe_to_apply,
        candidate && candidate.fieldSafety,
        candidate && candidate.fields,
        state.raw && state.raw.safeToApply,
        state.raw && state.raw.safe_to_apply,
        state.raw && state.raw.fieldSafety,
        state.raw && state.raw.fields
    ];
    return sources.some(source => aiReadFieldSetting(source, fieldKey) === true);
}

function aiFieldConfidence(state, candidate, fieldKey) {
    const sources = [
        candidate && candidate.fieldConfidence,
        candidate && candidate.fieldConfidences,
        candidate && candidate.confidenceByField,
        candidate && candidate.field_confidence,
        state.raw && state.raw.fieldConfidence,
        state.raw && state.raw.fieldConfidences,
        state.raw && state.raw.confidenceByField,
        state.raw && state.raw.field_confidence
    ];
    for (const source of sources) {
        const value = aiReadFieldSetting(source, fieldKey);
        if (value !== undefined && value !== null && value !== false) return value;
    }
    const fieldRecord = candidate && candidate.fields && aiReadFieldSetting(candidate.fields, fieldKey);
    return fieldRecord !== undefined && fieldRecord !== true && fieldRecord !== false ? fieldRecord : null;
}

function aiExplicitAmbiguousFields(state, candidate) {
    const fields = new Set();
    const sources = [
        state.raw && state.raw.ambiguousFields,
        state.raw && state.raw.ambiguous_fields,
        state.raw && state.raw.ambiguities,
        candidate && candidate.ambiguousFields,
        candidate && candidate.ambiguous_fields,
        candidate && candidate.ambiguities
    ];
    sources.forEach(source => {
        if (Array.isArray(source)) source.forEach(value => fields.add(String(value).toLowerCase()));
        else if (source && typeof source === 'object') {
            Object.keys(source).forEach(key => { if (source[key]) fields.add(key.toLowerCase()); });
        }
    });
    if ((state.raw && (state.raw.ambiguous === true || state.raw.isAmbiguous === true)) || (candidate && candidate.ambiguous === true)) {
        fields.add('album');
        fields.add('coverurl');
        fields.add('cover');
    }
    return fields;
}

function aiIsFieldAmbiguous(state, candidate, fieldKey) {
    const explicit = aiExplicitAmbiguousFields(state, candidate);
    if (aiFieldAliases(fieldKey).some(alias => explicit.has(String(alias).toLowerCase()))) return true;
    const fieldContainers = [candidate && candidate.fields, state.raw && state.raw.fields];
    for (const container of fieldContainers) {
        if (!container || typeof container !== 'object') continue;
        for (const alias of aiFieldAliases(fieldKey)) {
            const record = container[alias];
            if (record && typeof record === 'object' && (record.ambiguous === true || record.isAmbiguous === true)) return true;
        }
    }
    if (fieldKey !== 'album' && fieldKey !== 'coverUrl') return false;
    const values = new Set();
    state.candidates.forEach(entry => {
        const value = fieldKey === 'coverUrl'
            ? aiCandidateCover(entry)
            : aiCandidateValue(entry, FIELD_CONFIG.find(field => field.key === 'album'));
        if (value) values.add(String(value).toLocaleLowerCase());
    });
    return values.size > 1 || (state.releaseCandidateCount || 0) > 1;
}

function aiIsFieldLocked(state, fieldKey) {
    const source = state && state.raw && (state.raw.lockedFields || state.raw.locked_fields);
    if (!Array.isArray(source)) return false;
    const locked = new Set(source.map(value => String(value).toLowerCase()));
    return aiFieldAliases(fieldKey).some(alias => locked.has(String(alias).toLowerCase()));
}

function aiCollectEvidence(raw, candidate) {
    const evidence = [];
    const add = (label, value) => {
        if (value === undefined || value === null || value === '' || value === false) return;
        const text = value === true ? String(label) : `${label ? `${label}: ` : ''}${value}`;
        if (!evidence.includes(text)) evidence.push(text);
    };
    const consume = source => {
        if (!source) return;
        if (Array.isArray(source)) {
            source.forEach(item => {
                if (typeof item === 'string' || typeof item === 'number') add('', item);
                else if (item && typeof item === 'object') add(item.label || item.type || item.name || '', item.value ?? item.detail ?? item.message ?? true);
            });
        } else if (typeof source === 'object') {
            if (source.label || source.value || source.detail) add(source.label || source.type || '', source.value ?? source.detail ?? true);
            else Object.keys(source).forEach(key => add(aiHumanize(key), source[key]));
        } else {
            add('', source);
        }
    };
    consume(raw && raw.evidence);
    consume(raw && raw.matchEvidence);
    consume(raw && raw.match_evidence);
    consume(raw && raw.signals);
    consume(raw && raw.parsed);
    consume(raw && raw.fingerprintEvidence);
    consume(raw && raw.fingerprint_evidence);
    consume(candidate && candidate.evidence);
    consume(candidate && candidate.matchEvidence);
    consume(candidate && candidate.signals);
    return evidence.slice(0, 12);
}

function aiCollectProviderStatuses(...sources) {
    const providers = new Map();
    const add = (name, status, detail = '') => {
        if (!name && !status) return;
        const providerName = String(name || 'Metadata source');
        providers.set(providerName.toLowerCase(), {
            name: providerName,
            status: aiNormalizeProviderStatus(status),
            detail: detail ? String(detail) : ''
        });
    };
    const consume = source => {
        if (!source) return;
        if (Array.isArray(source)) {
            source.forEach(entry => {
                if (typeof entry === 'string') add(entry, 'pending');
                else if (entry && typeof entry === 'object') add(entry.name || entry.provider || entry.source, entry.status || entry.state || entry.result, entry.detail || entry.message);
            });
        } else if (typeof source === 'string') {
            add('Metadata source', source);
        } else if (typeof source === 'object') {
            if (source.name || source.provider || source.source) {
                add(source.name || source.provider || source.source, source.status || source.state || source.result, source.detail || source.message);
            } else {
                Object.keys(source).forEach(name => {
                    const value = source[name];
                    if (value && typeof value === 'object') add(name, value.status || value.state || value.result, value.detail || value.message);
                    else add(name, value);
                });
            }
        }
    };
    sources.forEach(consume);
    return Array.from(providers.values());
}

function aiCandidateKey(candidate, index) {
    const id = candidate && candidate._aiDecisionId !== undefined ? candidate._aiDecisionId : aiCandidateId(candidate);
    if (id !== undefined && id !== null && id !== '') return `id:${id}`;
    return ['songname', 'artist', 'album', 'year'].map(key => {
        const field = FIELD_CONFIG.find(entry => entry.key === key);
        return aiCandidateValue(candidate, field).toLocaleLowerCase();
    }).join('|') || `candidate:${index}`;
}

function aiCandidateList(raw) {
    const primary = [];
    const addList = value => {
        if (Array.isArray(value)) value.forEach(candidate => { if (candidate && typeof candidate === 'object') primary.push(candidate); });
    };
    addList(raw && raw.candidates);
    addList(raw && raw.suggestions);
    addList(raw && raw.alternatives);
    addList(raw && raw.matches);
    const suggested = raw && (raw.suggested || raw.proposed || raw.recommendation || raw.bestMatch || raw.best_match || raw.candidate);
    if (suggested && typeof suggested === 'object' && !Array.isArray(suggested)) primary.unshift(suggested);

    const releases = [];
    const initialCandidates = [...primary];
    initialCandidates.forEach((parent, parentIndex) => {
        const parentReleases = [];
        if (parentIndex === 0) {
            [raw && raw.releaseCandidates, raw && raw.release_candidates, raw && raw.releases]
                .forEach(value => { if (Array.isArray(value)) parentReleases.push(...value); });
        }
        [parent.releaseCandidates, parent.release_candidates, parent.releases]
            .forEach(value => { if (Array.isArray(value)) parentReleases.push(...value); });

        parentReleases.forEach(release => {
            if (!release || typeof release !== 'object') return;
            releases.push(release);
            const parentId = aiCandidateId(parent) ?? `candidate-${parentIndex}`;
            const releaseId = aiCandidateId(release);
            const merged = Object.assign({}, parent, release, {
                title: aiCandidateValue(parent, FIELD_CONFIG[0]),
                songname: aiCandidateValue(parent, FIELD_CONFIG[0]),
                album: aiReadMetadataProperty(release, ['album', 'albumName', 'releaseTitle', 'title', 'name']) || aiCandidateValue(parent, FIELD_CONFIG[2]),
                _aiCandidateType: 'Release',
                _aiDecisionId: releaseId === undefined || releaseId === null
                    ? parentId
                    : `${parentId}::release::${releaseId}`
            });
            primary.push(merged);
        });
    });

    const unique = new Map();
    primary.forEach((candidate, index) => {
        const key = aiCandidateKey(candidate, index);
        if (!unique.has(key)) unique.set(key, candidate);
    });
    return { candidates: Array.from(unique.values()), releaseCandidateCount: releases.length };
}

function aiLibrarySong(songId) {
    const songs = Array.isArray(appCache.library) ? appCache.library : [];
    return songs.find(song => String(song.id) === String(songId)) || null;
}

function aiCurrentCover(original, songId) {
    const originalCover = aiReadMetadataProperty(original, ['coverUrl', 'cover_url', 'cover', 'cover_path', 'coverPath']);
    const librarySong = aiLibrarySong(songId);
    const editId = aiElement('edit-song-id');
    const editCover = aiElement('edit-song-cover-img');
    const sameEditSong = editId && String(editId.value) === String(songId);
    return safeImageURL(originalCover || (librarySong && librarySong.cover) || (sameEditSong && editCover ? editCover.src : ''), COVER_PLACEHOLDER);
}

function aiUnwrapItem(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.item && typeof payload.item === 'object') return payload.item;
    if (payload.data && payload.data.item && typeof payload.data.item === 'object') return payload.data.item;
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
    return payload;
}

function aiProjectFieldValues(fields, side) {
    if (!fields || typeof fields !== 'object') return {};
    const projected = {};
    [...FIELD_CONFIG, { key: 'coverUrl' }].forEach(field => {
        let record;
        for (const alias of aiFieldAliases(field.key)) {
            if (Object.prototype.hasOwnProperty.call(fields, alias)) {
                record = fields[alias];
                break;
            }
        }
        let value;
        if (record && typeof record === 'object') {
            value = side === 'current'
                ? aiReadProperty(record, ['current', 'original', 'existing', 'currentValue', 'current_value'])
                : aiReadProperty(record, ['suggested', 'proposed', 'newValue', 'new_value', 'value']);
        } else if (side === 'suggested') {
            value = record;
        }
        if (value !== undefined && value !== null && value !== '') projected[field.key] = value;
    });
    return projected;
}

function aiNormalizeItem(payload, options = {}) {
    const raw = aiUnwrapItem(payload);
    const projectedCurrent = aiProjectFieldValues(raw.fields, 'current');
    const projectedSuggestion = aiProjectFieldValues(raw.fields, 'suggested');
    const original = raw.current || raw.original || raw.song || raw.track
        || (Object.keys(projectedCurrent).length ? projectedCurrent : null)
        || options.original || {};
    const list = aiCandidateList(raw);
    if (!list.candidates.length && Object.keys(projectedSuggestion).length) list.candidates.push(projectedSuggestion);
    const songId = aiReadProperty(raw, ['songId', 'song_id', 'trackId', 'track_id'])
        ?? aiReadProperty(raw.song, ['id', 'songId'])
        ?? aiReadProperty(raw.track, ['id', 'trackId'])
        ?? options.songId;
    const itemId = aiReadProperty(raw, ['itemId', 'item_id', 'enrichmentItemId', 'enrichment_item_id', 'id']) ?? options.itemId;
    const selectedIndex = Math.max(0, Math.min(Number(options.selectedIndex) || 0, Math.max(list.candidates.length - 1, 0)));
    const candidate = list.candidates[selectedIndex] || null;
    let providers = aiCollectProviderStatuses(
        raw.providers,
        raw.providerStatuses,
        raw.provider_statuses,
        raw.sources,
        raw.sourceStatus,
        raw.source_status
    );
    if (candidate) {
        const sourceName = aiReadMetadataProperty(candidate, ['source', 'provider', 'registry']);
        const existingProvider = sourceName && providers.find(provider => provider.name.toLowerCase() === String(sourceName).toLowerCase());
        if (existingProvider && ['pending', 'searching', 'unknown'].includes(existingProvider.status)) {
            existingProvider.status = 'matched';
        } else if (sourceName && !existingProvider) {
            providers.push({ name: String(sourceName), status: 'matched', detail: '' });
        }
    }
    const explicitStage = aiReadProperty(raw, ['stage', 'status', 'state']);
    let stage = aiNormalizeStage(explicitStage, candidate ? 'needs_review' : 'unidentified');
    if (!candidate && providers.some(provider => ['offline', 'rate_limited', 'invalid_key', 'provider_error'].includes(provider.status))) stage = 'provider_error';
    if (candidate && !['auto_matched', 'needs_review'].includes(stage)) stage = 'needs_review';
    return {
        raw,
        itemId,
        songId,
        original,
        candidates: list.candidates,
        releaseCandidateCount: list.releaseCandidateCount,
        selectedIndex,
        candidate,
        providers,
        evidence: aiCollectEvidence(raw, candidate),
        stage,
        error: aiReadProperty(raw, ['error', 'errorMessage', 'error_message', 'message']) || options.error || ''
    };
}

function aiUnwrapJob(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.job && typeof payload.job === 'object') return payload.job;
    if (payload.data && payload.data.job && typeof payload.data.job === 'object') return payload.data.job;
    if (payload.data && typeof payload.data === 'object' && !payload.data.item) return payload.data;
    return payload;
}

function aiNormalizeJob(payload) {
    const raw = aiUnwrapJob(payload);
    const progress = raw.progress && typeof raw.progress === 'object' ? raw.progress : {};
    const rawStage = String(aiReadProperty(raw, ['stage', 'status', 'state']) || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const count = keys => {
        const value = aiReadProperty(progress, keys) ?? aiReadProperty(raw, keys);
        const number = aiFiniteNumber(value);
        return number === null ? null : Math.max(0, number);
    };
    return {
        raw,
        id: aiReadProperty(raw, ['jobId', 'job_id', 'id']),
        stage: aiNormalizeStage(rawStage, 'preparing'),
        cancelled: ['cancelled', 'canceled'].includes(rawStage) || raw.cancelled === true || raw.canceled === true,
        total: count(['total', 'totalCount', 'total_count', 'itemsTotal', 'items_total']),
        processed: count(['scanned', 'processed', 'processedCount', 'processed_count', 'completed', 'completedCount', 'completed_count']),
        matched: count(['matched', 'matchedCount', 'matched_count', 'autoMatched', 'auto_matched']),
        automatic: count(['automatic', 'automaticCount', 'automatic_count']),
        approved: count(['approved', 'approvedCount', 'approved_count']),
        skipped: count(['skipped', 'skippedCount', 'skipped_count']),
        review: count(['needsReview', 'needs_review', 'reviewCount', 'review_count', 'pendingReview', 'pending_review']),
        unidentified: count(['unidentified', 'unidentifiedCount', 'unidentified_count', 'noMatch', 'no_match']),
        errors: count(['errors', 'errorCount', 'error_count', 'sourceErrors', 'source_errors']),
        noMatch: count(['noMatch', 'no_match', 'unmatched', 'unmatchedCount', 'unmatched_count']),
        sourceErrors: count(['sourceErrors', 'source_errors', 'issues', 'issueCount', 'issue_count']),
        pendingDecisions: count(['pendingDecisions', 'pending_decisions']),
        decisionsCompleted: count(['decisionsCompleted', 'decisions_completed']),
        percent: count(['percent', 'percentage', 'progressPercent', 'progress_percent']),
        providers: aiCollectProviderStatuses(raw.providers, raw.providerStatuses, raw.provider_statuses, raw.sources),
        item: raw.currentItem || raw.current_item || raw.item || null,
        lookupMode: aiReadProperty(raw, ['lookupMode', 'lookup_mode']),
        scope: aiReadProperty(raw, ['scope']),
        targetSongId: aiReadProperty(raw, ['targetSongId', 'target_song_id', 'songId', 'song_id']),
        message: aiReadProperty(raw, ['message', 'detail']) || ''
    };
}

function aiIsCurrentSession(session) {
    return !!session && _enrichmentSession === session && session.token === _aiSessionSequence && !session.disposed;
}

function aiClearPollTimer() {
    if (_aiPollTimer) clearTimeout(_aiPollTimer);
    _aiPollTimer = null;
}

function aiAbortReadRequest() {
    if (_aiReviewAbort) _aiReviewAbort.abort();
    _aiReviewAbort = null;
}

function aiBeginReadRequest(session) {
    aiAbortReadRequest();
    const controller = new AbortController();
    controller._aiSessionToken = session.token;
    _aiReviewAbort = controller;
    return controller;
}

async function aiParseResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.error || body.message || `Request failed (${response.status})`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body;
}

function aiShowPanel(panel) {
    const modal = aiElement('ai-metadata-modal');
    const panelChanged = !modal || modal.dataset.panel !== panel;
    if (modal) modal.dataset.panel = panel;
    aiSetVisible('ai-review-preflight', panel === 'preflight');
    aiSetVisible('ai-review-loading', panel === 'loading');
    aiSetVisible('ai-review-content', panel === 'content');
    aiSetVisible('ai-review-empty', panel === 'empty');
    aiSetVisible('ai-review-complete', panel === 'complete');
    aiSetVisible('ai-job-overview', panel !== 'preflight');
    const visiblePanel = aiElement(`ai-review-${panel}`);
    if (visiblePanel && panelChanged) {
        visiblePanel.classList.remove('ai-panel-enter');
        void visiblePanel.offsetWidth;
        visiblePanel.classList.add('ai-panel-enter');
    }
    requestAnimationFrame(() => {
        if (!modal || modal.classList.contains('hidden')) return;
        const active = document.activeElement;
        const focusLost = !active || !modal.contains(active) || active.disabled || active.getClientRects().length === 0;
        if (!focusLost) return;
        const target = aiElement(`ai-review-${panel}`);
        if (target) target.focus();
    });
}

function aiSetStage(session, stage, message = '') {
    if (session && !aiIsCurrentSession(session)) return;
    stage = aiNormalizeStage(stage, 'preparing');
    if (session) session.stage = stage;
    const info = AI_STAGE_INFO[stage];
    const modal = aiElement('ai-metadata-modal');
    if (modal) modal.dataset.stage = stage;
    const badge = aiElement('ai-stage-badge');
    const label = aiElement('ai-stage-label');
    const title = aiElement('ai-loading-title');
    const detail = aiElement('ai-loading-message');
    const loadingIcon = aiElement('ai-loading-icon');
    if (badge) badge.textContent = info.badge;
    if (label) label.textContent = info.label;
    if (title) title.textContent = info.title;
    if (detail) detail.textContent = message || info.message;
    if (loadingIcon) {
        loadingIcon.classList.toggle('ai-state-orbit--paused', stage === 'paused');
        loadingIcon.innerHTML = stage === 'paused'
            ? `<i class='bx bx-pause' aria-hidden="true"></i>`
            : `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i>`;
    }
}

function aiRenderProviderStatuses(providers) {
    const container = aiElement('ai-provider-statuses');
    if (!container) return;
    if (!Array.isArray(providers) || providers.length === 0) {
        container.innerHTML = '<span class="ai-provider-empty">No source details were returned</span>';
        return;
    }
    container.innerHTML = providers.map(provider => {
        const status = aiNormalizeProviderStatus(provider.status);
        const statusLabel = aiHumanize(status);
        const title = provider.detail ? ` title="${aiEscape(provider.detail)}"` : '';
        return `<span class="ai-provider-chip" data-status="${status}"${title}>${aiEscape(aiProviderLabel(provider.name))}: ${aiEscape(statusLabel)}</span>`;
    }).join('');
}

function aiUpdateProgress(session, snapshot = null) {
    if (!aiIsCurrentSession(session)) return;
    if (snapshot) {
        [
            'total', 'processed', 'matched', 'automatic', 'approved', 'skipped',
            'review', 'unidentified', 'errors', 'noMatch', 'sourceErrors',
            'pendingDecisions', 'decisionsCompleted', 'lookupMode', 'scope'
        ].forEach(key => {
            if (snapshot[key] !== null && snapshot[key] !== undefined) session[key] = snapshot[key];
        });
        if (snapshot.providers && snapshot.providers.length) session.providers = snapshot.providers;
        if (snapshot.percent !== null && snapshot.percent !== undefined) session.percent = snapshot.percent;
    }
    const total = Math.max(0, Number(session.total) || 0);
    const processed = Math.max(0, Number(session.processed) || 0);
    const rawPercent = session.percent !== undefined && session.percent !== null
        ? Number(session.percent)
        : (total > 0 ? (processed / total) * 100 : (session.stage === 'completed' ? 100 : 0));
    const percent = Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0));
    const values = {
        'ai-count-processed': processed,
        'ai-count-total': total,
        'ai-count-matched': Math.max(0, Number(session.mode === 'job' ? (session.automatic ?? session.matched) : (session.automatic ?? 0)) || 0),
        'ai-count-approved': Math.max(0, Number(session.approved) || 0),
        'ai-count-skipped': Math.max(0, Number(session.skipped) || 0),
        'ai-count-review': Math.max(0, Number(session.pendingDecisions ?? session.review) || (session.item ? 1 : 0)),
        'ai-count-unidentified': Math.max(0, Number(session.noMatch ?? session.unidentified) || 0),
        'ai-count-errors': Math.max(0, Number(session.sourceErrors ?? session.errors) || 0)
    };
    Object.keys(values).forEach(id => { const element = aiElement(id); if (element) element.textContent = values[id]; });
    const fill = aiElement('ai-progress-fill');
    const percentLabel = aiElement('ai-progress-percent');
    const track = aiElement('ai-progress-track');
    const queueStatus = aiElement('ai-review-queue-status');
    const methodLabel = aiElement('ai-job-method');
    if (fill) fill.style.width = `${percent}%`;
    if (percentLabel) percentLabel.textContent = `${Math.round(percent)}%`;
    if (track) track.setAttribute('aria-valuenow', String(Math.round(percent)));
    if (methodLabel) {
        const labels = {
            local_only: 'Local analysis',
            text_only: 'Text lookup',
            acoustic_with_text_fallback: 'Audio fingerprint + text'
        };
        const label = labels[session.lookupMode] || '';
        methodLabel.textContent = label;
        methodLabel.classList.toggle('hidden', !label);
    }
    if (queueStatus) {
        const waiting = Math.max(0, Number(session.pendingDecisions ?? session.review) || 0);
        queueStatus.textContent = waiting > 0
            ? `${waiting} ${waiting === 1 ? 'item' : 'items'} waiting`
            : (total > processed ? `${total - processed} left to scan` : 'Scan complete');
    }
    aiRenderProviderStatuses(session.providers || []);
}

function aiSetBatchButtonBusy(busy) {
    const button = aiElement('batch-ai-enrich-btn');
    if (!button) return;
    button.disabled = busy;
    button.innerHTML = busy ? `<i class='bx bx-loader-alt bx-spin'></i>` : `<i class='bx bxs-magic-wand'></i>`;
}

function aiUpdateControls(session) {
    if (!aiIsCurrentSession(session)) return;
    const hasItem = !!session.item;
    const hasCandidate = !!(_aiReviewState && _aiReviewState.candidate);
    const hasAvailableChanges = hasCandidate && _aiReviewState.enriched
        && Object.entries(_aiReviewState.enriched).some(([field, value]) =>
            value !== undefined && value !== null && value !== '' && !aiIsFieldLocked(_aiReviewState, field)
        );
    const isComplete = session.stage === 'completed';
    const isPaused = session.stage === 'paused';
    const isPreflight = session.mode === 'preflight';
    const isChoosingMatch = hasCandidate && _aiReviewState.reviewStep !== 'approval';
    const isApproving = hasCandidate && _aiReviewState.reviewStep === 'approval';
    const isCandidateConfirmed = hasCandidate && _aiReviewState.candidateConfirmed === true;
    const isBusy = session.applying || session.controlPending;
    const jobControls = aiElement('ai-job-controls');
    const pauseButton = aiElement('ai-pause-job');
    const cancelJobButton = aiElement('ai-cancel-job');
    const skipButton = aiElement('cancel-ai-metadata');
    const applyButton = aiElement('apply-ai-metadata');
    const closeButton = aiElement('close-ai-metadata-modal');
    const preflightActions = aiElement('ai-preflight-actions');
    const startButton = aiElement('ai-start-review');
    const reviewMatchButton = aiElement('ai-review-selected-match');
    const backToMatchesButton = aiElement('ai-back-to-matches');

    if (preflightActions) preflightActions.classList.toggle('hidden', !isPreflight);
    if (startButton) startButton.disabled = !!session.preflightLoading || !!session.preflightBlocked || isBusy;
    if (reviewMatchButton) {
        reviewMatchButton.classList.toggle('hidden', !isChoosingMatch || isComplete || isPreflight);
        reviewMatchButton.disabled = isBusy || isPaused || !isCandidateConfirmed;
    }
    if (backToMatchesButton) {
        backToMatchesButton.classList.toggle('hidden', !isApproving || isComplete);
        backToMatchesButton.disabled = isBusy || isPaused;
    }
    if (jobControls) jobControls.classList.toggle('hidden', session.mode !== 'job' || isComplete || isPreflight);
    if (pauseButton) {
        pauseButton.classList.toggle('hidden', session.mode !== 'job' || isComplete);
        pauseButton.disabled = isBusy;
        pauseButton.innerHTML = isPaused
            ? `<i class='bx bx-play' aria-hidden="true"></i><span>Resume</span>`
            : `<i class='bx bx-pause' aria-hidden="true"></i><span>Pause</span>`;
    }
    if (cancelJobButton) cancelJobButton.disabled = isBusy;
    if (closeButton) closeButton.disabled = !!isBusy;

    if (skipButton) {
        skipButton.classList.toggle('hidden', isPreflight || !(hasItem || isComplete));
        skipButton.disabled = !!session.applying || isPaused;
        skipButton.textContent = isComplete ? 'Close' : (session.mode === 'job' || session.isBatch ? 'Skip for this review' : 'Not now');
        skipButton.title = !isComplete && (session.mode === 'job' || session.isBatch)
            ? 'Leave this track unchanged for now. It may appear in a future review.'
            : '';
    }
    if (applyButton) {
        applyButton.classList.toggle('hidden', isPreflight || !isApproving || !hasAvailableChanges || isComplete);
        applyButton.disabled = !!session.applying || isPaused;
        applyButton.innerHTML = session.applying
            ? `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i><span>${session.decisionAction === 'skip' ? 'Saving decision...' : 'Applying...'}</span>`
            : `<i class='bx bx-check' aria-hidden="true"></i><span>Apply selected fields</span>`;
    }

    document.querySelectorAll('#ai-metadata-modal input, #ai-metadata-modal .ai-suggestion-card, #ai-metadata-modal .ai-page-button').forEach(control => {
        control.disabled = control.dataset.aiDisabled === 'true' || !!session.applying || isPaused;
    });
    const modal = aiElement('ai-metadata-modal');
    if (modal) modal.setAttribute('aria-busy', String(!!isBusy));
}

function aiOpenWorkspace(session, panel = 'loading') {
    const modal = aiElement('ai-metadata-modal');
    if (!modal || !aiIsCurrentSession(session)) return;
    aiShowPanel(panel);
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        if (!aiIsCurrentSession(session)) return;
        const workspace = modal.querySelector('.ai-enrich-workspace');
        if (workspace) workspace.focus();
    });
}

function aiCreateSession({ isBatch, mode = 'legacy', songId = null }) {
    cancelSmartMetadataReview({ hide: false, cancelRemote: false });
    const session = {
        token: ++_aiSessionSequence,
        isBatch: !!isBatch,
        mode,
        songId,
        jobId: null,
        queue: [],
        total: isBatch ? 0 : 1,
        processed: 0,
        matched: 0,
        automatic: null,
        approved: 0,
        skipped: 0,
        review: 0,
        unidentified: 0,
        errors: 0,
        noMatch: null,
        sourceErrors: null,
        pendingDecisions: null,
        decisionsCompleted: 0,
        percent: null,
        providers: [],
        item: null,
        stage: 'idle',
        applying: false,
        controlPending: false,
        disposed: false
    };
    _enrichmentSession = session;
    window._enrichmentQueue = session.queue;
    window._enrichmentTotal = session.total;
    return session;
}

function aiHideWorkspace() {
    const modal = aiElement('ai-metadata-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.dataset.stage = 'idle';
        delete modal.dataset.panel;
        modal.setAttribute('aria-busy', 'false');
    }
}

function cancelSmartMetadataReview(options = {}) {
    const session = _enrichmentSession;
    aiClearPollTimer();
    aiAbortReadRequest();
    if (_aiApplyAbort) _aiApplyAbort.abort();
    _aiApplyAbort = null;
    if (session && options.cancelRemote === true && session.mode === 'job' && session.jobId && session.stage !== 'completed') {
        fetch(window.API_BASE_URL + `/api/enrichment/jobs/${encodeURIComponent(session.jobId)}/cancel`, {
            method: 'POST',
            credentials: 'include'
        }).catch(() => {});
    }
    if (session) session.disposed = true;
    _aiReviewState = null;
    _enrichmentSession = null;
    _aiSessionSequence++;
    window._enrichmentQueue = null;
    window._enrichmentTotal = 0;
    aiSetBatchButtonBusy(false);
    const autoFillButton = aiElement('ai-autofill-btn');
    if (autoFillButton) {
        autoFillButton.disabled = false;
        autoFillButton.innerHTML = `<i class='bx bxs-magic-wand' aria-hidden="true"></i>`;
    }
    if (options.hide !== false) aiHideWorkspace();
}
window.cancelSmartMetadataReview = cancelSmartMetadataReview;

async function aiRequireOwner() {
    const user = appCache.user || await fetchCurrentUser();
    const isOwner = !!user && String(user.role || '').toLowerCase() === 'owner';
    if (!isOwner) showToast('Smart Metadata Review is available to the server Owner only.', 'error');
    return isOwner;
}

const AI_LOOKUP_METHODS = Object.freeze({
    local_only: {
        title: 'Local analysis',
        detail: 'Embedded tags and filename hints stay on this server.'
    },
    text_only: {
        title: 'Text lookup',
        detail: 'Title and artist hints are checked with MusicBrainz and Apple.'
    },
    acoustic_with_text_fallback: {
        title: 'Acoustic matching with text fallback',
        detail: 'A local fingerprint is checked with AcoustID before text lookup is used.'
    }
});

function aiRenderPreflight(session, settings = {}) {
    if (!aiIsCurrentSession(session)) return;
    const mode = AI_LOOKUP_METHODS[settings.mode] ? settings.mode : 'local_only';
    const method = AI_LOOKUP_METHODS[mode];
    const methodTitle = aiElement('ai-preflight-method');
    const methodDetail = aiElement('ai-preflight-method-detail');
    const changeTitle = aiElement('ai-preflight-change-title');
    const changeDetail = aiElement('ai-preflight-change-detail');
    const readiness = aiElement('ai-preflight-readiness');
    if (methodTitle) methodTitle.textContent = method.title;
    if (methodDetail) methodDetail.textContent = method.detail;

    const usesAcoustic = mode === 'acoustic_with_text_fallback';
    if (changeTitle) changeTitle.textContent = usesAcoustic ? 'Safe missing fields may update' : 'Every change waits for you';
    if (changeDetail) changeDetail.textContent = usesAcoustic
        ? 'A strong acoustic match may fill only safe, missing text fields. Existing values and artwork still wait for review.'
        : 'Streamify will show suggestions without changing your library until you approve them.';

    session.preflightBlocked = usesAcoustic && settings.acoustid_configured !== true;
    if (readiness) {
        let status = 'ready';
        let icon = 'bx-check-circle';
        let message = 'Ready to scan.';
        if (settings.loading) {
            status = 'loading';
            icon = 'bx-loader-alt bx-spin';
            message = 'Checking metadata tools and saved settings...';
        } else if (settings.loadFailed) {
            status = 'warning';
            icon = 'bx-error-circle';
            message = 'Tool readiness could not be verified. You can still start the review.';
        } else if (session.preflightBlocked) {
            status = 'blocked';
            icon = 'bx-error-circle';
            message = 'Add an AcoustID application key in Metadata settings before using acoustic matching.';
        } else if (usesAcoustic && settings.fpcalc_available !== true) {
            status = 'warning';
            icon = 'bx-info-circle';
            message = 'The fingerprint tool is unavailable, so this review will rely on text fallback.';
        } else if (usesAcoustic) {
            const keySource = settings.acoustid_key_source === 'environment' ? 'environment-managed key' : 'saved key';
            message = `Fingerprint tool and ${keySource} are configured. Key validity is checked during lookup.`;
        } else if (mode === 'local_only') {
            message = 'Ready. No metadata leaves this server.';
        } else {
            message = 'Ready to check MusicBrainz and Apple.';
        }
        readiness.dataset.status = status;
        readiness.innerHTML = `<i class='bx ${icon}' aria-hidden="true"></i><span>${aiEscape(message)}</span>`;
    }
    aiUpdateControls(session);
}

async function aiPrepareBatchPreflight(session) {
    if (!aiIsCurrentSession(session)) return;
    session.preflightLoading = true;
    session.preflightBlocked = false;
    aiRenderPreflight(session, { mode: 'local_only', loading: true });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(window.API_BASE_URL + '/api/settings/metadata', {
            credentials: 'include',
            signal: controller.signal
        });
        const settings = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(settings.error || 'Metadata settings could not be loaded');
        if (!aiIsCurrentSession(session)) return;
        session.preflightLoading = false;
        aiRenderPreflight(session, settings);
    } catch (error) {
        if (!aiIsCurrentSession(session)) return;
        session.preflightLoading = false;
        aiRenderPreflight(session, { mode: 'local_only', loadFailed: true });
    } finally {
        clearTimeout(timeout);
    }
}

async function startSmartMetadataReview() {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session) || session.mode !== 'preflight' || session.preflightLoading || session.preflightBlocked) return;
    session.mode = 'probing';
    aiSetBatchButtonBusy(true);
    aiSetStage(session, 'preparing');
    aiShowPanel('loading');
    aiUpdateProgress(session);
    aiUpdateControls(session);
    try {
        const startedRichJob = await aiTryStartRichJob(session);
        if (!aiIsCurrentSession(session)) return;
        if (!startedRichJob) await aiLoadLegacyQueue(session);
    } catch (error) {
        if (!aiIsCurrentSession(session)) return;
        if (error.name === 'AbortError') error = new Error('The metadata review did not start in time. Please try again.');
        aiRenderJobError(session, error);
        showToast(`Could not start Smart Metadata Review: ${error.message}`, 'error');
    }
}
window.startSmartMetadataReview = startSmartMetadataReview;

async function openMetadataSettingsFromReview() {
    const session = _enrichmentSession;
    if (aiIsCurrentSession(session) && session.mode === 'job' && session.stage !== 'completed') {
        if (!window.confirm('Cancel this run and open Metadata settings? Failed items need a new review after settings change.')) return;
        const cancelled = await cancelSmartMetadataJob({ confirmed: true, closeAfter: true });
        if (!cancelled) return;
    } else {
        cancelSmartMetadataReview({ hide: true, cancelRemote: false });
    }
    if (typeof window.openMetadataSettings === 'function') window.openMetadataSettings();
}
window.openMetadataSettingsFromReview = openMetadataSettingsFromReview;

function aiLegacyOriginal(songId) {
    const librarySong = aiLibrarySong(songId) || {};
    const editId = aiElement('edit-song-id');
    const useEditForm = editId && String(editId.value) === String(songId);
    return {
        title: useEditForm && aiElement('edit-song-name') ? aiElement('edit-song-name').value : (librarySong.name || librarySong.title || ''),
        artist: useEditForm && aiElement('edit-song-artist') ? aiElement('edit-song-artist').value : (librarySong.artist || ''),
        album: useEditForm && aiElement('edit-song-album') ? aiElement('edit-song-album').value : (librarySong.album || ''),
        genre: useEditForm && aiElement('edit-song-genre') ? aiElement('edit-song-genre').value : (librarySong.genre || ''),
        year: useEditForm && aiElement('edit-song-year') ? aiElement('edit-song-year').value : (librarySong.year || ''),
        cover: librarySong.cover || (useEditForm && aiElement('edit-song-cover-img') ? aiElement('edit-song-cover-img').src : '')
    };
}

function aiProviderStatusForError(error) {
    if (!navigator.onLine) return 'offline';
    if (error && error.status === 429) return 'rate_limited';
    return 'provider_error';
}

function aiRenderUnknownState(session, state) {
    if (!aiIsCurrentSession(session)) return;
    state.providers = aiCollectProviderStatuses(session.providers, state.providers);
    _aiReviewState = state;
    session.item = state;
    session.providers = state.providers || [];
    const isProviderError = state.stage === 'provider_error';
    aiSetStage(session, state.stage, state.error || '');
    aiShowPanel('empty');
    const icon = aiElement('ai-empty-icon');
    const title = aiElement('ai-empty-title');
    const message = aiElement('ai-empty-message');
    const detail = aiElement('ai-empty-detail');
    const settingsAction = aiElement('ai-empty-settings-action');
    const currentTitle = aiOriginalValue(state.original, FIELD_CONFIG[0]);
    if (icon) icon.innerHTML = isProviderError ? `<i class='bx bx-error-circle'></i>` : `<i class='bx bx-search-alt'></i>`;
    if (title) title.textContent = isProviderError ? 'Lookup could not be completed' : 'No reliable match';
    if (message) message.textContent = state.error || (isProviderError ? 'A metadata source returned an error.' : 'No source returned a match that is safe to present.');
    if (detail) detail.textContent = currentTitle
        ? `"${currentTitle}" keeps its current metadata and cover.`
        : 'Current title, metadata, and cover remain unchanged.';
    if (settingsAction) settingsAction.classList.toggle('hidden', !isProviderError);
    aiUpdateProgress(session);
    aiUpdateControls(session);
}

async function aiLoadLegacyPreview(session, songId) {
    if (!aiIsCurrentSession(session)) return;
    session.songId = songId;
    session.item = null;
    _aiReviewState = null;
    session.providers = [];
    session.percent = null;
    aiShowPanel('loading');
    aiSetStage(session, 'local_analysis');
    aiUpdateProgress(session);
    aiUpdateControls(session);

    const controller = aiBeginReadRequest(session);
    requestAnimationFrame(() => {
        if (aiIsCurrentSession(session) && _aiReviewAbort === controller) aiSetStage(session, 'registry_lookup');
    });

    try {
        const response = await fetch(window.API_BASE_URL + `/api/songs/${encodeURIComponent(songId)}/preview-ai-metadata`, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal
        });
        const body = await aiParseResponse(response);
        if (!aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        const payload = body.data || body.item || body;
        const state = aiNormalizeItem(payload, { songId, original: aiLegacyOriginal(songId) });
        if (state.candidates.length > 0) {
            session.review += 1;
            renderSmartReviewModal(songId, state);
        } else {
            if (!state.providers.length) state.providers = [{ name: 'Music registry', status: 'no_match', detail: '' }];
            state.stage = 'unidentified';
            aiRenderUnknownState(session, state);
        }
    } catch (error) {
        if (error.name === 'AbortError' || !aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        const status = aiProviderStatusForError(error);
        const state = aiNormalizeItem({
            original: aiLegacyOriginal(songId),
            providers: [{ name: 'Metadata lookup', status }],
            status,
            error: error.message
        }, { songId, error: error.message });
        state.stage = 'provider_error';
        aiRenderUnknownState(session, state);
        showToast(`Metadata lookup failed: ${error.message}`, 'error');
    } finally {
        if (_aiReviewAbort === controller) _aiReviewAbort = null;
        const button = aiElement('ai-autofill-btn');
        if (button) {
            button.disabled = false;
            button.innerHTML = `<i class='bx bxs-magic-wand' aria-hidden="true"></i>`;
        }
    }
}

async function triggerSmartMetadataAutoFill(songId = null) {
    if (!await aiRequireOwner()) return;
    const id = songId || (aiElement('edit-song-id') && aiElement('edit-song-id').value);
    if (!id) {
        showToast('Select a song before reviewing its metadata.', 'warning');
        return;
    }
    cancelEditSongRequest();
    const session = aiCreateSession({ isBatch: false, mode: 'legacy', songId: id });
    const button = aiElement('ai-autofill-btn');
    if (button) {
        button.disabled = true;
        button.innerHTML = `<i class='bx bx-loader-alt bx-spin' aria-hidden="true"></i>`;
    }
    aiSetStage(session, 'preparing');
    aiOpenWorkspace(session);
    aiUpdateProgress(session);
    aiUpdateControls(session);
    try {
        const startedRichJob = await aiTryStartRichJob(session, { songId: id });
        if (!startedRichJob) await aiLoadLegacyPreview(session, id);
    } catch (error) {
        if (!aiIsCurrentSession(session)) return;
        showToast(`Could not start metadata review: ${error.message}`, 'error');
        aiRenderJobError(session, error);
    } finally {
        const currentButton = aiElement('ai-autofill-btn');
        if (currentButton) {
            currentButton.disabled = false;
            currentButton.innerHTML = `<i class='bx bxs-magic-wand' aria-hidden="true"></i>`;
        }
    }
}

function aiConfidenceLabel(value) {
    const number = aiFiniteNumber(value);
    if (number !== null) {
        const normalized = number > 1 ? number / 100 : number;
        if (normalized >= 0.9) return 'High confidence';
        if (normalized >= 0.75) return 'Good confidence';
        return 'Review carefully';
    }
    const text = String(value || '').trim().toLowerCase();
    if (text.includes('high') || text.includes('strong')) return 'High confidence';
    if (text.includes('medium') || text.includes('good')) return 'Good confidence';
    return text ? 'Review carefully' : null;
}

function aiRenderReviewGuidance(state) {
    const panel = aiElement('ai-review-guidance');
    if (!panel) return;
    const notes = [];
    const ambiguous = [...FIELD_CONFIG, { key: 'coverUrl', label: 'Artwork' }]
        .filter(field => aiIsFieldAmbiguous(state, state.candidate, field.key))
        .map(field => field.label);
    const locked = [...FIELD_CONFIG, { key: 'coverUrl', label: 'Artwork' }]
        .filter(field => aiIsFieldLocked(state, field.key))
        .map(field => field.label);
    const conflicts = state.raw && state.raw.conflicts;
    if (aiRequiresReleaseSelection(state.candidate)) notes.push('Several releases match this recording. Choose the correct release first.');
    if (ambiguous.length) notes.push(`Sources disagree about ${ambiguous.join(', ')}. Those fields are not preselected.`);
    if (locked.length) notes.push(`${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked and will not be changed.`);
    if (Array.isArray(conflicts) && conflicts.length && !ambiguous.length) notes.push('The metadata sources disagree on part of this match. Compare the values before applying them.');
    panel.classList.toggle('hidden', notes.length === 0);
    panel.innerHTML = notes.length ? `
        <i class='bx bx-info-circle' aria-hidden="true"></i>
        <div><strong>Take a closer look</strong><ul>${notes.map(note => `<li>${aiEscape(note)}</li>`).join('')}</ul></div>
    ` : '';
}

function aiFriendlyEvidence(value) {
    const text = String(value || '').trim();
    const separator = text.indexOf(':');
    if (separator < 0) return text.replace(/[_-]+/g, ' ');
    const label = aiHumanize(text.slice(0, separator));
    const rawDetail = text.slice(separator + 1).trim();
    const numericDetail = aiFiniteNumber(rawDetail);
    const detail = numericDetail !== null && numericDetail >= 0 && numericDetail <= 1 && /confidence|score|similarity/i.test(label)
        ? `${Math.round(numericDetail * 100)}%`
        : rawDetail.replace(/[_-]+/g, ' ');
    return `${label}: ${detail}`;
}

function aiRenderEvidence(state) {
    const container = aiElement('ai-evidence-list');
    if (!container) return;
    state.evidence = aiCollectEvidence(state.raw, state.candidate);
    if (!state.evidence.length) {
        container.innerHTML = '<span class="ai-evidence-empty">No evidence details were returned for this candidate.</span>';
        return;
    }
    container.innerHTML = state.evidence.map(item => `
        <span class="ai-evidence-chip"><i class='bx bx-check-shield' aria-hidden="true"></i>${aiEscape(aiFriendlyEvidence(item))}</span>
    `).join('');
}

function aiRenderFields(state) {
    const container = aiElement('ai-fields-container');
    if (!container || !state.candidate) return;
    state.enriched = {};
    const releaseSelectionRequired = aiRequiresReleaseSelection(state.candidate);
    container.innerHTML = FIELD_CONFIG.map(field => {
        const current = aiOriginalValue(state.original, field);
        const suggested = aiCandidateValue(state.candidate, field);
        const usableSuggestion = !!suggested && !aiIsPlaceholder(suggested, field.key);
        const changed = usableSuggestion && aiValuesDiffer(current, suggested);
        const safeToApply = aiIsFieldSafe(state, state.candidate, field.key);
        const ambiguous = aiIsFieldAmbiguous(state, state.candidate, field.key);
        const locked = aiIsFieldLocked(state, field.key);
        const releaseOnlyField = field.key === 'album' || field.key === 'year';
        const releaseAmbiguous = releaseOnlyField && releaseSelectionRequired && ambiguous;
        const defaultChecked = changed && (aiIsPlaceholder(current, field.key) || safeToApply) && !ambiguous && !locked;
        const selectionKey = aiCandidateKey(state.candidate, state.selectedIndex);
        const savedSelections = state.selectionByCandidate && state.selectionByCandidate[selectionKey];
        const checked = savedSelections && Object.prototype.hasOwnProperty.call(savedSelections, field.key)
            ? savedSelections[field.key] === true
            : defaultChecked;
        const confidence = aiConfidenceLabel(aiFieldConfidence(state, state.candidate, field.key));
        if (changed) state.enriched[field.key] = suggested;
        const currentLabel = current || 'Not set';
        const suggestedLabel = usableSuggestion ? suggested : 'Not returned';
        const confidenceLabel = locked
            ? 'Locked in your library'
            : releaseAmbiguous
            ? 'Multiple releases disagree; select manually or choose a Release card'
            : (confidence || (changed ? 'Review this suggestion' : 'No new value'));
        const rowClass = changed ? 'changed' : 'unavailable';
        return `
            <div class="ai-review-row ${rowClass}">
                <div class="ai-review-label"><i class='bx ${field.icon}' aria-hidden="true"></i><span>${aiEscape(field.label)}</span></div>
                <div class="ai-review-current ${current ? '' : 'ai-review-placeholder'}" title="${aiEscape(currentLabel)}" aria-label="Current ${aiEscape(field.label)}: ${aiEscape(currentLabel)}">${aiEscape(currentLabel)}</div>
                <div class="ai-review-suggested-wrap">
                    <div class="ai-review-suggested ${usableSuggestion ? '' : 'ai-review-placeholder'}" title="${aiEscape(suggestedLabel)}" aria-label="Suggested ${aiEscape(field.label)}: ${aiEscape(suggestedLabel)}">${aiEscape(suggestedLabel)}</div>
                    <span class="ai-field-confidence ${confidence ? 'has-score' : ''}">${aiEscape(confidenceLabel)}</span>
                </div>
                <label class="ai-check-control" title="${locked ? `${field.label} is locked` : (releaseAmbiguous ? 'Applying this value will not select a canonical release' : (changed ? `Apply suggested ${field.label}` : `No new ${field.label} value`))}">
                    <input type="checkbox" data-field="${field.key}" data-ai-disabled="${String(!changed || locked)}" ${checked ? 'checked' : ''} ${changed && !locked ? '' : 'disabled'} aria-label="Apply suggested ${aiEscape(field.label)}">
                    <span aria-hidden="true"><i class='bx bx-check'></i></span>
                </label>
            </div>`;
    }).join('');
}

function aiRenderCover(state) {
    const section = aiElement('ai-cover-section');
    const currentImage = aiElement('ai-cover-current');
    const suggestedImage = aiElement('ai-cover-suggested');
    const checkbox = aiElement('ai-accept-cover');
    const note = aiElement('ai-cover-note');
    const suggestedCover = aiCandidateCover(state.candidate);
    state.enriched.coverUrl = suggestedCover || null;
    if (!section || !suggestedCover) {
        if (section) section.classList.add('hidden');
        return;
    }
    const currentCover = aiCurrentCover(state.original, state.songId);
    const rawCurrentCover = aiReadMetadataProperty(state.original, ['coverUrl', 'cover_url', 'cover', 'cover_path', 'coverPath'])
        || (aiLibrarySong(state.songId) && aiLibrarySong(state.songId).cover);
    const ambiguous = aiIsFieldAmbiguous(state, state.candidate, 'coverUrl');
    const locked = aiIsFieldLocked(state, 'coverUrl');
    const releaseSelectionRequired = aiRequiresReleaseSelection(state.candidate);
    const safeToApply = aiIsFieldSafe(state, state.candidate, 'coverUrl');
    const currentMissing = !safeImageURL(rawCurrentCover) || currentCover === COVER_PLACEHOLDER;
    section.classList.remove('hidden');
    if (currentImage) currentImage.src = currentCover;
    if (suggestedImage) suggestedImage.src = suggestedCover;
    if (checkbox) {
        const selectionKey = aiCandidateKey(state.candidate, state.selectedIndex);
        const savedSelections = state.selectionByCandidate && state.selectionByCandidate[selectionKey];
        checkbox.checked = savedSelections && Object.prototype.hasOwnProperty.call(savedSelections, 'coverUrl')
            ? savedSelections.coverUrl === true
            : !ambiguous && !locked && (currentMissing || safeToApply);
        checkbox.disabled = locked;
        checkbox.dataset.aiDisabled = String(locked);
    }
    if (note) note.textContent = locked
        ? 'Artwork is locked in your library'
        : releaseSelectionRequired && ambiguous
        ? 'Multiple releases returned different covers; choose one manually or select a Release card'
        : 'Artwork changes only after approval';
}

function aiRenderCandidates(state) {
    const section = aiElement('ai-suggestions-section');
    const list = aiElement('ai-suggestions-list');
    const pagination = aiElement('ai-candidate-pagination');
    const previousButton = aiElement('ai-candidates-previous');
    const nextButton = aiElement('ai-candidates-next');
    const pageStatus = aiElement('ai-candidate-page-status');
    if (!section || !list || state.candidates.length < 1) {
        if (section) section.classList.add('hidden');
        if (list) list.innerHTML = '';
        return;
    }
    section.classList.toggle('hidden', state.reviewStep === 'approval');
    const pageCount = Math.max(1, Math.ceil(state.candidates.length / AI_CANDIDATES_PER_PAGE));
    const selectedPage = Math.floor(state.selectedIndex / AI_CANDIDATES_PER_PAGE);
    state.candidatePage = Number.isInteger(state.candidatePage) ? state.candidatePage : selectedPage;
    state.candidatePage = Math.max(0, Math.min(state.candidatePage, pageCount - 1));
    const pageStart = state.candidatePage * AI_CANDIDATES_PER_PAGE;
    const pageCandidates = state.candidates.slice(pageStart, pageStart + AI_CANDIDATES_PER_PAGE);
    list.classList.remove('ai-panel-enter');
    void list.offsetWidth;
    list.classList.add('ai-panel-enter');
    list.innerHTML = pageCandidates.map((candidate, pageIndex) => {
        const index = pageStart + pageIndex;
        const title = aiCandidateValue(candidate, FIELD_CONFIG[0]) || 'Untitled candidate';
        const artist = aiCandidateValue(candidate, FIELD_CONFIG[1]) || 'Artist not returned';
        const album = aiCandidateValue(candidate, FIELD_CONFIG[2]);
        const year = aiCandidateValue(candidate, FIELD_CONFIG[4]);
        const cover = aiCandidateCover(candidate);
        const confidence = aiConfidenceLabel(aiReadMetadataProperty(candidate, ['matchScore', 'match_score', 'confidence', 'score']));
        const type = candidate._aiCandidateType ||
            (Array.isArray(candidate.releaseCandidates) && candidate.releaseCandidates.length > 1
                ? 'Recording'
                : (index === 0 ? 'Suggested' : 'Alternative'));
        const source = aiReadMetadataProperty(candidate, ['provider', 'source', 'registry']);
        const detail = [source ? aiProviderLabel(source) : null, artist, album, year].filter(Boolean).join(' / ');
        return `
            <button type="button" class="ai-suggestion-card ${state.candidateConfirmed && index === state.selectedIndex ? 'active' : ''}"
                data-sug-index="${index}" aria-pressed="${String(state.candidateConfirmed && index === state.selectedIndex)}">
                ${cover
                    ? `<img class="ai-suggestion-cover" src="${aiEscape(cover)}" alt="" loading="lazy" decoding="async">`
                    : `<span class="ai-suggestion-cover-placeholder" aria-hidden="true"><i class='bx bx-music'></i></span>`}
                <span class="ai-suggestion-info">
                    <span class="ai-suggestion-title">${aiEscape(title)}</span>
                    <span class="ai-suggestion-detail">${aiEscape(detail || 'No release details returned')}</span>
                </span>
                <span class="ai-candidate-meta">
                    <span class="ai-candidate-type">${aiEscape(type)}</span>
                    ${confidence ? `<span class="ai-candidate-score">${aiEscape(confidence)}</span>` : ''}
                </span>
            </button>`;
    }).join('');
    list.querySelectorAll('.ai-suggestion-card').forEach(button => {
        button.addEventListener('click', () => {
            const session = _enrichmentSession;
            if (!aiIsCurrentSession(session) || session.applying || session.stage === 'paused') return;
            const index = Number(button.dataset.sugIndex);
            if (!Number.isInteger(index) || !state.candidates[index]) return;
            state.selectedIndex = index;
            state.candidate = state.candidates[index];
            state.candidateConfirmed = true;
            aiRenderReviewState(session, state);
            requestAnimationFrame(() => {
                document.querySelector(`#ai-suggestions-list .ai-suggestion-card[data-sug-index="${index}"]`)?.focus();
            });
        });
    });
    if (pagination) pagination.classList.toggle('hidden', pageCount <= 1);
    if (pageStatus) pageStatus.textContent = `Page ${state.candidatePage + 1} of ${pageCount}`;
    if (previousButton) {
        previousButton.dataset.aiDisabled = String(state.candidatePage === 0);
        previousButton.disabled = state.candidatePage === 0;
        previousButton.onclick = () => {
            if (state.candidatePage === 0) return;
            state.candidatePage -= 1;
            aiRenderCandidates(state);
            requestAnimationFrame(() => document.querySelector('#ai-suggestions-list .ai-suggestion-card:last-child')?.focus());
        };
    }
    if (nextButton) {
        nextButton.dataset.aiDisabled = String(state.candidatePage >= pageCount - 1);
        nextButton.disabled = state.candidatePage >= pageCount - 1;
        nextButton.onclick = () => {
            if (state.candidatePage >= pageCount - 1) return;
            state.candidatePage += 1;
            aiRenderCandidates(state);
            requestAnimationFrame(() => document.querySelector('#ai-suggestions-list .ai-suggestion-card')?.focus());
        };
    }
}

function aiRememberReviewSelections(state) {
    if (!state || state.reviewStep !== 'approval' || !state.candidate) return;
    const selectionKey = aiCandidateKey(state.candidate, state.selectedIndex);
    const selections = {};
    document.querySelectorAll('#ai-fields-container input[type="checkbox"][data-field]').forEach(checkbox => {
        selections[checkbox.dataset.field] = checkbox.checked;
    });
    const coverCheckbox = aiElement('ai-accept-cover');
    if (coverCheckbox && !aiElement('ai-cover-section')?.classList.contains('hidden')) {
        selections.coverUrl = coverCheckbox.checked;
    }
    if (!state.selectionByCandidate) state.selectionByCandidate = {};
    state.selectionByCandidate[selectionKey] = selections;
}

function aiSetReviewStep(step) {
    const session = _enrichmentSession;
    const state = _aiReviewState;
    if (!aiIsCurrentSession(session) || !state || session.applying || session.stage === 'paused') return;
    if (state.reviewStep === 'approval') aiRememberReviewSelections(state);
    state.reviewStep = step === 'approval' ? 'approval' : 'match';
    aiRenderReviewState(session, state);
    const scrollRegion = document.querySelector('#ai-metadata-modal .ai-workspace-scroll');
    if (scrollRegion) scrollRegion.scrollTop = 0;
    requestAnimationFrame(() => {
        const focusTarget = state.reviewStep === 'approval'
            ? aiElement('ai-back-to-matches')
            : document.querySelector('#ai-suggestions-list .ai-suggestion-card.active');
        if (focusTarget) focusTarget.focus();
    });
}
window.reviewSelectedMetadataMatch = () => aiSetReviewStep('approval');
window.backToMetadataMatches = () => aiSetReviewStep('match');

function aiRenderReviewState(session, state) {
    if (!aiIsCurrentSession(session) || !state || !state.candidate) return;
    state.selectedIndex = Math.max(0, Math.min(state.selectedIndex || 0, state.candidates.length - 1));
    state.reviewStep = state.reviewStep === 'approval' ? 'approval' : 'match';
    state.candidateConfirmed = state.candidateConfirmed === true;
    state.candidate = state.candidates[state.selectedIndex];
    state.evidence = aiCollectEvidence(state.raw, state.candidate);
    state.providers = aiCollectProviderStatuses(session.providers, state.providers);
    const selectedSource = aiReadMetadataProperty(state.candidate, ['source', 'provider', 'registry']);
    const existingProvider = selectedSource && state.providers.find(provider => provider.name.toLowerCase() === String(selectedSource).toLowerCase());
    if (existingProvider && ['pending', 'searching', 'unknown'].includes(existingProvider.status)) {
        existingProvider.status = 'matched';
    } else if (selectedSource && !existingProvider) {
        state.providers.push({ name: String(selectedSource), status: 'matched', detail: '' });
    }
    _aiReviewState = state;
    session.item = state;
    session.songId = state.songId;
    session.providers = state.providers;
    session.percent = null;

    const stage = state.stage === 'auto_matched' && state.selectedIndex === 0 ? 'auto_matched' : 'needs_review';
    aiSetStage(session, stage);
    aiShowPanel('content');
    const currentTitle = aiOriginalValue(state.original, FIELD_CONFIG[0]);
    const suggestedTitle = aiCandidateValue(state.candidate, FIELD_CONFIG[0]);
    const title = aiElement('ai-item-title');
    const kicker = aiElement('ai-item-kicker');
    const scoreBadge = aiElement('ai-match-score');
    const evidencePanel = aiElement('ai-evidence-section');
    const approvalStep = aiElement('ai-approval-step');
    const score = aiConfidenceLabel(aiReadMetadataProperty(state.candidate, ['matchScore', 'match_score', 'confidence', 'score']));
    if (title) title.textContent = currentTitle || suggestedTitle || `Song ${state.songId || ''}`.trim();
    if (kicker) kicker.textContent = 'Needs your review';
    if (scoreBadge) {
        scoreBadge.classList.toggle('hidden', !score);
        scoreBadge.textContent = score || '';
    }
    if (evidencePanel) evidencePanel.removeAttribute('open');
    if (approvalStep) approvalStep.classList.toggle('hidden', state.reviewStep !== 'approval');

    aiRenderCandidates(state);
    aiRenderReviewGuidance(state);
    aiRenderFields(state);
    aiRenderCover(state);
    aiRenderEvidence(state);
    aiUpdateProgress(session);
    aiUpdateControls(session);
}

function renderSmartReviewModal(songId, data) {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session)) return;
    const alreadyNormalized = data && data.raw && Array.isArray(data.candidates);
    const previousIndex = _aiReviewState && String(_aiReviewState.itemId) === String(data && data.itemId)
        ? _aiReviewState.selectedIndex
        : 0;
    const state = alreadyNormalized ? data : aiNormalizeItem(data, { songId, selectedIndex: previousIndex });
    const previousState = _aiReviewState && String(_aiReviewState.itemId) === String(state.itemId)
        ? _aiReviewState
        : null;
    if (previousState && state !== previousState) {
        state.selectedIndex = previousState.selectedIndex;
        state.candidatePage = previousState.candidatePage;
        state.candidateConfirmed = previousState.candidateConfirmed;
        state.reviewStep = previousState.reviewStep;
        state.selectionByCandidate = previousState.selectionByCandidate;
        state.candidate = state.candidates[state.selectedIndex] || state.candidates[0] || null;
    }
    if (!state.songId) state.songId = songId;
    if (!state.candidates.length) {
        aiRenderUnknownState(session, state);
        return;
    }
    aiRenderReviewState(session, state);
}

function aiCollectSelectedUpdates(state) {
    const updates = {};
    document.querySelectorAll('#ai-fields-container input[type="checkbox"][data-field]').forEach(checkbox => {
        const field = checkbox.dataset.field;
        if (checkbox.checked && state.enriched && state.enriched[field] !== undefined && state.enriched[field] !== null && state.enriched[field] !== '') {
            updates[field] = state.enriched[field];
        }
    });
    const coverCheckbox = aiElement('ai-accept-cover');
    if (coverCheckbox && coverCheckbox.checked && state.enriched && state.enriched.coverUrl) {
        updates.coverUrl = state.enriched.coverUrl;
    }
    return updates;
}

function aiSyncEditForm(songId, updates, responseBody = {}) {
    const editId = aiElement('edit-song-id');
    if (!editId || String(editId.value) !== String(songId)) return;
    const fieldInputs = {
        songname: 'edit-song-name', artist: 'edit-song-artist', album: 'edit-song-album',
        genre: 'edit-song-genre', year: 'edit-song-year'
    };
    Object.keys(fieldInputs).forEach(field => {
        const input = aiElement(fieldInputs[field]);
        if (input && updates[field] !== undefined) input.value = updates[field];
    });
    if (updates.coverUrl) {
        const cover = aiElement('edit-song-cover-img');
        const returnedCover = responseBody.cover || responseBody.coverUrl || responseBody.cover_url;
        if (cover && returnedCover) cover.src = safeImageURL(returnedCover, cover.src || COVER_PLACEHOLDER);
    }
}

function aiCompleteSession(session, options = {}) {
    if (!aiIsCurrentSession(session)) return;
    aiClearPollTimer();
    aiAbortReadRequest();
    session.item = null;
    session.applying = false;
    session.controlPending = false;
    if (!options.cancelled && session.total > 0) session.processed = Math.max(session.processed, session.total);
    session.percent = options.cancelled ? null : 100;
    _aiReviewState = null;
    window._enrichmentQueue = null;
    window._enrichmentTotal = 0;
    aiSetStage(session, 'completed', options.message || '');
    aiShowPanel('complete');
    const title = aiElement('ai-complete-title');
    const message = aiElement('ai-complete-message');
    const summary = aiElement('ai-complete-summary');
    if (title) title.textContent = options.title || (options.cancelled ? 'Run cancelled' : 'Review complete');
    if (message) message.textContent = options.message || (options.cancelled
        ? 'No further items will be requested from this review session.'
        : 'Your approved metadata changes have been saved.');
    const summaryValues = {
        'ai-complete-automatic': Math.max(0, Number(session.mode === 'job' ? (session.automatic ?? session.matched) : (session.automatic ?? 0)) || 0),
        'ai-complete-approved': Math.max(0, Number(session.approved) || 0),
        'ai-complete-skipped': Math.max(0, Number(session.skipped) || 0),
        'ai-complete-unmatched': Math.max(0, Number(session.noMatch ?? session.unidentified) || 0),
        'ai-complete-errors': Math.max(0, Number(session.sourceErrors ?? session.errors) || 0)
    };
    Object.entries(summaryValues).forEach(([id, value]) => {
        const element = aiElement(id);
        if (element) element.textContent = value;
    });
    if (summary) summary.classList.toggle('hidden', !!options.cancelled || session.total === 0);
    aiUpdateProgress(session);
    aiUpdateControls(session);
    aiSetBatchButtonBusy(false);
    if (typeof fetchLibrary === 'function') fetchLibrary(true);
}

function aiAdvanceLegacySession(session, decision, state) {
    if (!aiIsCurrentSession(session)) return;
    session.processed += 1;
    session.percent = null;
    if (decision === 'apply') {
        session.matched += 1;
        session.approved += 1;
    }
    const skippedUnknown = decision === 'skip' && state && state.stage === 'unidentified';
    const skippedError = decision === 'skip' && state && state.stage === 'provider_error';
    if (decision === 'skip' && !skippedUnknown && !skippedError) session.skipped += 1;
    if (skippedUnknown) session.unidentified += 1;
    if (skippedError) session.errors += 1;
    if (session.review > 0) session.review -= 1;
    session.item = null;
    _aiReviewState = null;
    aiUpdateProgress(session);
    if (session.isBatch) processNextInQueue();
    else aiCompleteSession(session, {
        title: decision === 'apply' ? 'Metadata applied' : 'No changes made',
        message: decision === 'apply' ? 'Only your checked fields were saved.' : 'Current metadata and cover were left unchanged.'
    });
}

async function aiSubmitDecision(decision) {
    const session = _enrichmentSession;
    const state = _aiReviewState;
    if (!aiIsCurrentSession(session) || !state || session.applying || session.controlPending || session.stage === 'paused') return;
    const updates = decision === 'apply' ? aiCollectSelectedUpdates(state) : {};
    if (decision === 'apply' && Object.keys(updates).length === 0) {
        showToast('Select at least one changed field, or skip this item.', 'warning');
        return;
    }
    if (session.mode === 'job' && !state.itemId) {
        showToast('This job item has no decision identifier. It cannot be applied safely.', 'error');
        return;
    }

    if (_aiApplyAbort) _aiApplyAbort.abort();
    const controller = new AbortController();
    _aiApplyAbort = controller;
    const previousStage = session.stage;
    session.applying = true;
    session.decisionAction = decision;
    aiSetStage(session, 'applying', decision === 'skip' ? 'Recording the skip decision.' : 'Saving only the checked fields and staged cover.');
    const actionStatus = aiElement('ai-action-status');
    if (actionStatus) actionStatus.textContent = decision === 'skip' ? 'Recording skip decision' : 'Applying selected metadata fields';
    aiUpdateControls(session);

    try {
        let response;
        if (session.mode === 'job') {
            const decisionBody = {
                decision,
                fields: Object.keys(updates),
                updates
            };
            const candidateId = state.candidate && (state.candidate._aiDecisionId ?? aiCandidateId(state.candidate));
            if (candidateId !== undefined && candidateId !== null && candidateId !== '') decisionBody.candidateId = candidateId;
            response = await fetch(window.API_BASE_URL + `/api/enrichment/items/${encodeURIComponent(state.itemId)}/decision`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                signal: controller.signal,
                body: JSON.stringify(decisionBody)
            });
        } else {
            response = await fetch(window.API_BASE_URL + `/api/songs/${encodeURIComponent(state.songId)}/enrich-metadata`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                signal: controller.signal,
                body: JSON.stringify(updates)
            });
        }
        const body = await aiParseResponse(response);
        if (body.success === false) throw new Error(body.error || 'The decision could not be saved');
        if (!aiIsCurrentSession(session) || _aiApplyAbort !== controller || _aiReviewState !== state) return;
        if (decision === 'apply') aiSyncEditForm(state.songId, updates, body);
        if (session.mode === 'job') {
            session.item = null;
            _aiReviewState = null;
            await aiAfterJobDecision(session, body, decision, state);
        } else {
            aiAdvanceLegacySession(session, decision, state);
        }
    } catch (error) {
        if (error.name === 'AbortError' || !aiIsCurrentSession(session) || _aiApplyAbort !== controller) return;
        aiSetStage(session, previousStage);
        if (actionStatus) actionStatus.textContent = `Decision failed: ${error.message}`;
        showToast(`Could not save this decision: ${error.message}`, 'error');
    } finally {
        if (_aiApplyAbort === controller) _aiApplyAbort = null;
        if (aiIsCurrentSession(session)) {
            session.applying = false;
            session.decisionAction = null;
            aiUpdateControls(session);
        }
    }
}

function applySmartReviewSelections() {
    aiSubmitDecision('apply');
}

function skipSmartMetadataItem() {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session) || session.applying || session.controlPending || session.stage === 'paused') return;
    if (session.stage === 'completed') {
        return requestCloseSmartMetadataReview();
    }
    if (session.mode === 'job') return aiSubmitDecision('skip');
    if (!session.isBatch) {
        cancelSmartMetadataReview({ hide: true, cancelRemote: false });
        return;
    }
    return aiAdvanceLegacySession(session, 'skip', _aiReviewState);
}
window.skipSmartMetadataItem = skipSmartMetadataItem;

function aiRenderJobError(session, error, providers = []) {
    if (!aiIsCurrentSession(session)) return;
    session.item = null;
    _aiReviewState = null;
    session.providers = providers.length ? providers : [{ name: 'Enrichment service', status: aiProviderStatusForError(error), detail: '' }];
    aiSetStage(session, 'provider_error', error && error.message ? error.message : 'The enrichment job could not continue.');
    aiShowPanel('empty');
    const icon = aiElement('ai-empty-icon');
    const title = aiElement('ai-empty-title');
    const message = aiElement('ai-empty-message');
    const detail = aiElement('ai-empty-detail');
    const settingsAction = aiElement('ai-empty-settings-action');
    if (icon) icon.innerHTML = `<i class='bx bx-error-circle'></i>`;
    if (title) title.textContent = 'Enrichment job needs attention';
    if (message) message.textContent = error && error.message ? error.message : 'The server could not continue this job.';
    if (detail) detail.textContent = 'Review the metadata setup, or close this window and return later.';
    if (settingsAction) settingsAction.classList.remove('hidden');
    aiUpdateProgress(session);
    aiUpdateControls(session);
}

function aiScheduleJobPoll(session, delay = 1200) {
    if (!aiIsCurrentSession(session) || session.mode !== 'job' || session.stage === 'paused' || session.stage === 'completed' || session.item) return;
    aiClearPollTimer();
    _aiPollTimer = setTimeout(() => {
        _aiPollTimer = null;
        aiRefreshJob(session);
    }, delay);
}

async function aiHandleJobSnapshot(session, snapshot) {
    if (!aiIsCurrentSession(session)) return;
    if (snapshot.id !== undefined && snapshot.id !== null) session.jobId = snapshot.id;
    session.providers = snapshot.providers || session.providers;
    aiSetStage(session, snapshot.stage, snapshot.message);
    aiUpdateProgress(session, snapshot);

    if (snapshot.stage === 'completed') {
        aiCompleteSession(session, snapshot.cancelled
            ? { cancelled: true, title: 'Run cancelled', message: snapshot.message || 'No further review items will be requested.' }
            : (snapshot.total === 0
                ? { title: 'Your library is up to date', message: 'No unfinished metadata was found.' }
                : { message: snapshot.message || 'All available review items have been handled.' }));
        return;
    }
    if (snapshot.stage === 'paused') {
        aiShowPanel(session.item ? 'content' : 'loading');
        aiUpdateControls(session);
        return;
    }
    if (snapshot.item) {
        const state = aiNormalizeItem(snapshot.item);
        if (state.candidates.length) renderSmartReviewModal(state.songId, state);
        else aiRenderUnknownState(session, state);
        return;
    }
    if (snapshot.stage === 'provider_error') {
        aiRenderJobError(session, new Error(snapshot.message || 'A metadata source failed.'), snapshot.providers);
        return;
    }
    if (['needs_review', 'auto_matched', 'unidentified'].includes(snapshot.stage)) {
        await aiLoadNextJobItem(session);
        return;
    }
    aiShowPanel('loading');
    aiUpdateControls(session);
    aiScheduleJobPoll(session);
}

async function aiRefreshJob(session) {
    if (!aiIsCurrentSession(session) || session.mode !== 'job' || !session.jobId) return;
    if (session.loadingJob) {
        aiScheduleJobPoll(session, 500);
        return;
    }
    session.loadingJob = true;
    const controller = aiBeginReadRequest(session);
    try {
        const response = await fetch(window.API_BASE_URL + `/api/enrichment/jobs/${encodeURIComponent(session.jobId)}`, {
            credentials: 'include',
            signal: controller.signal
        });
        const body = await aiParseResponse(response);
        if (!aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        await aiHandleJobSnapshot(session, aiNormalizeJob(body));
    } catch (error) {
        if (error.name === 'AbortError' || !aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        aiRenderJobError(session, error);
    } finally {
        if (_aiReviewAbort === controller) _aiReviewAbort = null;
        if (aiIsCurrentSession(session)) {
            session.loadingJob = false;
            if (!session.item && !['paused', 'completed', 'provider_error'].includes(session.stage)) {
                aiScheduleJobPoll(session);
            }
        }
    }
}

function aiLooksLikeItem(value) {
    if (!value || typeof value !== 'object') return false;
    return ['songId', 'song_id', 'itemId', 'item_id', 'song', 'track', 'current', 'original', 'candidates', 'suggestions', 'suggested', 'proposed', 'recommendation', 'bestMatch']
        .some(key => Object.prototype.hasOwnProperty.call(value, key));
}

async function aiLoadNextJobItem(session) {
    if (!aiIsCurrentSession(session) || session.mode !== 'job' || !session.jobId || session.loadingNext || session.item) return;
    session.loadingNext = true;
    aiShowPanel('loading');
    aiUpdateControls(session);
    const controller = aiBeginReadRequest(session);
    try {
        const response = await fetch(window.API_BASE_URL + `/api/enrichment/jobs/${encodeURIComponent(session.jobId)}/items/next`, {
            credentials: 'include',
            signal: controller.signal
        });
        if (response.status === 204) {
            if (aiIsCurrentSession(session)) aiScheduleJobPoll(session, 700);
            return;
        }
        const body = await aiParseResponse(response);
        if (!aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        const explicitItem = body.item ?? (body.data && body.data.item) ?? body.nextItem ?? body.next_item;
        const itemPayload = explicitItem
            || (body.data && aiLooksLikeItem(body.data) ? body.data : null)
            || (aiLooksLikeItem(body) ? body : null);
        if (!itemPayload) {
            const snapshot = aiNormalizeJob(body);
            if (snapshot.stage === 'completed' || snapshot.id || body.job || (body.data && body.data.job)) {
                await aiHandleJobSnapshot(session, snapshot);
                if (aiIsCurrentSession(session) && !session.item && ['needs_review', 'auto_matched', 'unidentified'].includes(snapshot.stage)) {
                    aiScheduleJobPoll(session, 700);
                }
            } else {
                aiScheduleJobPoll(session, 700);
            }
            return;
        }
        const state = aiNormalizeItem(itemPayload);
        if (state.candidates.length) renderSmartReviewModal(state.songId, state);
        else aiRenderUnknownState(session, state);
    } catch (error) {
        if (error.name === 'AbortError' || !aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        aiRenderJobError(session, error);
    } finally {
        if (_aiReviewAbort === controller) _aiReviewAbort = null;
        if (aiIsCurrentSession(session)) session.loadingNext = false;
    }
}

async function aiAfterJobDecision(session, body, decision, decidedState = null) {
    if (!aiIsCurrentSession(session)) return;
    const hasJobSnapshot = !!(body.job || (body.data && body.data.job));
    if (hasJobSnapshot) {
        const snapshot = aiNormalizeJob(body);
        aiUpdateProgress(session, snapshot);
        if (snapshot.stage === 'completed') {
            aiCompleteSession(session, snapshot.cancelled
                ? { cancelled: true, title: 'Run cancelled', message: snapshot.message || 'No further review items will be requested.' }
                : { message: snapshot.message || 'All available review items have been handled.' });
            return;
        }
    } else {
        session.processed += 1;
        session.percent = null;
        if (decision === 'apply') {
            session.matched += 1;
            session.approved += 1;
        }
        const skippedUnknown = decision === 'skip' && decidedState && decidedState.stage === 'unidentified';
        const skippedError = decision === 'skip' && decidedState && decidedState.stage === 'provider_error';
        if (decision === 'skip' && !skippedUnknown && !skippedError) session.skipped += 1;
        if (skippedUnknown) session.unidentified += 1;
        if (skippedError) session.errors += 1;
        if (session.review > 0) session.review -= 1;
        aiUpdateProgress(session);
    }
    const nextItem = body.nextItem || body.next_item || (body.data && (body.data.nextItem || body.data.next_item));
    if (nextItem) {
        const state = aiNormalizeItem(nextItem);
        if (state.candidates.length) renderSmartReviewModal(state.songId, state);
        else aiRenderUnknownState(session, state);
        return;
    }
    aiSetStage(session, 'preparing', 'Loading the next review item.');
    aiShowPanel('loading');
    await aiLoadNextJobItem(session);
}

async function aiTryStartRichJob(session, options = {}) {
    const controller = aiBeginReadRequest(session);
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 20000);
    let response;
    try {
        response = await fetch(window.API_BASE_URL + '/api/enrichment/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal: controller.signal,
            body: JSON.stringify(options.songId
                ? { mode: 'review', scope: 'song', songId: Number(options.songId), force: true }
                : { mode: 'review', scope: 'library' })
        });
        if (AI_ABSENT_ENDPOINT_STATUSES.has(response.status)) return false;
        let body;
        if (response.status === 409) {
            body = await response.json().catch(() => ({}));
            if (!body.job && !(body.data && body.data.job)) {
                throw new Error(body.error || 'An enrichment job is already active');
            }
        } else {
            body = await aiParseResponse(response);
        }
        if (body.success === false && response.status !== 409) {
            throw new Error(body.error || 'Could not create an enrichment job');
        }
        if (!aiIsCurrentSession(session) || _aiReviewAbort !== controller) return true;
        const snapshot = aiNormalizeJob(body);
        if (snapshot.id === undefined || snapshot.id === null || snapshot.id === '') {
            throw new Error('The enrichment job response did not include a job id');
        }
        if (response.status === 409 && options.songId &&
            (snapshot.scope !== 'song' || String(snapshot.targetSongId || '') !== String(options.songId))) {
            throw new Error('Another metadata review is already active. Reopen it from Your Library, or cancel it before reviewing this track.');
        }
        session.mode = 'job';
        session.jobId = snapshot.id;
        await aiHandleJobSnapshot(session, snapshot);
        return true;
    } catch (error) {
        if (timedOut && error.name === 'AbortError') {
            throw new Error('The server took too long to start the metadata review. Please try again.');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        if (_aiReviewAbort === controller) _aiReviewAbort = null;
    }
}

async function aiLoadLegacyQueue(session) {
    if (!aiIsCurrentSession(session)) return;
    session.mode = 'legacy';
    aiSetStage(session, 'preparing', 'Loading the current enrichment queue.');
    aiShowPanel('loading');
    const controller = aiBeginReadRequest(session);
    try {
        const response = await fetch(window.API_BASE_URL + '/api/songs/enrichment-queue', {
            credentials: 'include',
            signal: controller.signal
        });
        const body = await aiParseResponse(response);
        if (body.success === false) throw new Error(body.error || 'Could not load the enrichment queue');
        if (!aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;

        let librarySongs = Array.isArray(appCache.library) ? appCache.library : [];
        if (!librarySongs.length && typeof fetchLibrary === 'function') {
            const fetched = await fetchLibrary(true);
            if (Array.isArray(fetched)) librarySongs = fetched;
        }
        if (!aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        const queue = [];
        const seen = new Set();
        const addId = id => {
            if (id && typeof id === 'object') id = id.id ?? id.songId ?? id.song_id;
            if (id === undefined || id === null || id === '') return;
            const key = String(id);
            if (seen.has(key)) return;
            seen.add(key);
            queue.push(id);
        };
        if (Array.isArray(body.queue)) body.queue.forEach(addId);
        // The current queue endpoint is user-scoped. Owners also review every
        // song visible in their library, including indexed folders and shares.
        librarySongs.forEach(song => addId(song && song.id));

        session.queue = queue;
        session.total = queue.length;
        session.processed = 0;
        session.percent = null;
        window._enrichmentQueue = session.queue;
        window._enrichmentTotal = session.total;
        aiUpdateProgress(session);
        if (!queue.length) {
            aiCompleteSession(session, { title: 'Nothing to review', message: 'No reviewable songs were returned for this library.' });
            return;
        }
        processNextInQueue();
    } catch (error) {
        if (error.name === 'AbortError' || !aiIsCurrentSession(session) || _aiReviewAbort !== controller) return;
        aiRenderJobError(session, error);
    } finally {
        if (_aiReviewAbort === controller) _aiReviewAbort = null;
    }
}

async function enrichBatchSongs() {
    if (!await aiRequireOwner()) return;
    const session = aiCreateSession({ isBatch: true, mode: 'preflight' });
    aiSetStage(session, 'idle');
    aiOpenWorkspace(session, 'preflight');
    aiUpdateProgress(session);
    aiUpdateControls(session);
    await aiPrepareBatchPreflight(session);
}

function processNextInQueue() {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session) || session.mode !== 'legacy' || !session.isBatch) return;
    if (!session.queue.length) {
        aiCompleteSession(session);
        return;
    }
    const nextSongId = session.queue.shift();
    window._enrichmentQueue = session.queue;
    window._enrichmentTotal = session.total;
    aiLoadLegacyPreview(session, nextSongId);
}

async function toggleSmartMetadataPause() {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session) || session.mode !== 'job' || !session.jobId || session.applying || session.controlPending) return;
    const resume = session.stage === 'paused';
    if (!resume) aiRememberReviewSelections(_aiReviewState);
    session.controlPending = true;
    aiClearPollTimer();
    aiAbortReadRequest();
    aiUpdateControls(session);
    try {
        const response = await fetch(window.API_BASE_URL + `/api/enrichment/jobs/${encodeURIComponent(session.jobId)}/${resume ? 'resume' : 'pause'}`, {
            method: 'POST',
            credentials: 'include'
        });
        const body = await aiParseResponse(response);
        if (body.success === false) throw new Error(body.error || `Could not ${resume ? 'resume' : 'pause'} the job`);
        if (!aiIsCurrentSession(session)) return;
        session.controlPending = false;
        if (resume) {
            const snapshot = aiNormalizeJob(body);
            if (snapshot.id || body.job || (body.data && body.data.job)) await aiHandleJobSnapshot(session, snapshot);
            else {
                aiSetStage(session, 'preparing', 'Resuming enrichment.');
                aiShowPanel('loading');
                aiRefreshJob(session);
            }
        } else {
            aiSetStage(session, 'paused');
            aiShowPanel(session.item ? 'content' : 'loading');
            aiUpdateControls(session);
        }
    } catch (error) {
        if (!aiIsCurrentSession(session)) return;
        session.controlPending = false;
        showToast(`Could not ${resume ? 'resume' : 'pause'} this job: ${error.message}`, 'error');
        aiUpdateControls(session);
        if (!resume) aiScheduleJobPoll(session);
    }
}
window.toggleSmartMetadataPause = toggleSmartMetadataPause;

async function cancelSmartMetadataJob(options = {}) {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session) || session.applying || session.controlPending || session.stage === 'completed') return false;
    if (options.confirmed !== true && !window.confirm('Cancel this metadata review? Scanning will stop and remaining items will be left unchanged.')) {
        return false;
    }
    session.controlPending = true;
    aiClearPollTimer();
    aiAbortReadRequest();
    aiUpdateControls(session);
    try {
        if (session.mode === 'job' && session.jobId) {
            const response = await fetch(window.API_BASE_URL + `/api/enrichment/jobs/${encodeURIComponent(session.jobId)}/cancel`, {
                method: 'POST',
                credentials: 'include'
            });
            const body = await aiParseResponse(response);
            if (body.success === false) throw new Error(body.error || 'The server did not cancel the job');
        }
        if (!aiIsCurrentSession(session)) return false;
        session.controlPending = false;
        aiCompleteSession(session, { cancelled: true, title: 'Run cancelled', message: 'No further review items will be requested.' });
        if (options.closeAfter) cancelSmartMetadataReview({ hide: true, cancelRemote: false });
        return true;
    } catch (error) {
        if (!aiIsCurrentSession(session)) return false;
        session.controlPending = false;
        showToast(`Cancellation could not be confirmed: ${error.message}`, 'error');
        aiUpdateControls(session);
        if (session.mode === 'job') aiScheduleJobPoll(session);
        return false;
    }
}
window.cancelSmartMetadataJob = cancelSmartMetadataJob;

async function requestCloseSmartMetadataReview() {
    const session = _enrichmentSession;
    if (!aiIsCurrentSession(session)) {
        aiHideWorkspace();
        return;
    }
    if (session.applying || session.controlPending) return;
    const jobContinues = session.mode === 'job' && session.stage !== 'completed';
    cancelSmartMetadataReview({ hide: true, cancelRemote: false });
    if (jobContinues) showToast('Metadata review closed. Reopen it from Your Library to continue.', 'success');
}
window.requestCloseSmartMetadataReview = requestCloseSmartMetadataReview;


function uploadSongCover(id, file) {
    const formData = new FormData();
    formData.append('cover_file', file);

    fetch(window.API_BASE_URL + `/api/songs/${id}/cover`, {
        method: 'POST',
        credentials: 'include',
        body: formData
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                document.getElementById('edit-song-cover-img').src = safeImageURL(data.cover, COVER_PLACEHOLDER);
                // Optionally update the list immediately
                fetchLibrary(true);
            } else {
                showToast(data.error, 'error');
            }
        });
}

function renderPeopleGrid(users) {
    const grid = document.getElementById('people-grid');
    grid.innerHTML = '';

    if (!users || users.length === 0) {
        grid.innerHTML = '<p style="color:#b3b3b3; padding: 20px;">No users found.</p>';
        return;
    }

    users.forEach(user => {
        const card = document.createElement('div');
        card.className = 'card';
        const initial = user.username ? user.username.charAt(0).toUpperCase() : '?';
        const safeUsername = escapeHTML(user.username);
        const avatarHtml = user.avatar
            ? `<div style="width:120px;max-width:100%;aspect-ratio:1;border-radius:50%;background:url('${safeStyleURL(user.avatar)}') center/cover;margin:0 auto 16px;box-shadow:0 4px 10px rgba(0,0,0,0.5);overflow:hidden;"></div>`
            : `<div style="width:120px;max-width:100%;aspect-ratio:1;background:linear-gradient(45deg,var(--gradient-1),var(--gradient-2));color:var(--on-gradient);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:bold;margin:0 auto 16px;box-shadow:0 4px 10px rgba(0,0,0,0.5);">${initial}</div>`;

        const userRole = user.role || 'User';
        let roleClass = '';
        let badgeHtml = '';

        // Admin and Moderator badges only visible to Owner
        const isSelfOwner = appCache.user && appCache.user.role === 'Owner';
        if (isSelfOwner) {
            if (userRole === 'Admin') {
                roleClass = 'badge-admin';
                badgeHtml = `<span class="role-badge ${roleClass}">${userRole}</span>`;
            } else if (userRole === 'Moderator') {
                roleClass = 'badge-mod';
                badgeHtml = `<span class="role-badge ${roleClass}">${userRole}</span>`;
            }
        }

        const displayName = truncateString(escapeHTML(user.display_name || user.username));
        const handle = escapeHTML(user.username.toLowerCase());
        card.innerHTML = `${avatarHtml}
            <div class="card-title" style="text-align:center;font-size:1.1em;margin-bottom:2px;">${displayName}</div>
            <div class="card-handle" style="text-align:center;font-size:0.85em;color:var(--text-secondary);margin-bottom:8px;">@${handle}</div>
            <div class="card-desc" style="text-align:center;">${badgeHtml}</div>`;
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            clearUserProfile();
            const m = document.getElementById('profile-modal');
            if (m) m.classList.remove('hidden');
            // Fetch fresh profile data so songs_count/likes_count are accurate
            fetch(window.API_BASE_URL + `/api/profile/${encodeURIComponent(user.username)}`)
                .then(r => r.json())
                .then(profile => displayUserProfile(profile.user || profile))
                .catch(() => displayUserProfile(user));
        });
        grid.appendChild(card);
    });
}

function renderUserUI(data) {
    const username = data.username || 'User';

    // 1. Update the name in the top pill
    const userPillName = document.querySelector('.user-pill span');
    if (userPillName) userPillName.textContent = truncateString(data.display_name || username);

    // 2. Select both avatars (Top Bar and Feed Compose Bar)
    const topAvatar = document.querySelector('.user-avatar');

    // Helper to apply styles to any avatar element
    const applyAvatar = (el) => {
        if (!el) return;
        if (data.avatar) {
            el.textContent = '';
            el.style.backgroundImage = `url('${safeStyleURL(data.avatar)}')`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
        } else {
            el.style.backgroundImage = 'linear-gradient(45deg, var(--gradient-1), var(--gradient-2))';
            el.style.backgroundSize = '';
            el.style.backgroundPosition = '';
            el.textContent = username.charAt(0).toUpperCase();
        }
    };

    applyAvatar(topAvatar);
    displayUserProfile(data);
}

function clearUserProfile() {
    const els = {
        name: document.getElementById('profile-username-display'),
        avatar: document.getElementById('profile-avatar-display'),
        bio: document.getElementById('profile-bio-display'),
        playlists: document.getElementById('profile-playlists-count')
    };
    if (els.name) els.name.textContent = 'Loading...';
    if (els.avatar) { els.avatar.innerHTML = ''; els.avatar.style.backgroundImage = 'linear-gradient(45deg,var(--gradient-1),var(--gradient-2))'; els.avatar.textContent = 'L'; }
    if (els.bio) els.bio.textContent = 'Loading...';
    if (els.playlists) els.playlists.textContent = '\u2014';
}

function openUserProfileModal(username) {
    if (!username) return;
    const profileModal = document.getElementById('profile-modal');
    if (!profileModal) return;

    // Clear and show loading state
    clearUserProfile();
    profileModal.classList.remove('hidden');

    // Fetch user profile and display in modal
    fetch(`${window.API_BASE_URL}/api/profile/${username}`)
        .then(r => r.json())
        .then(data => {
            displayUserProfile(data.user || data);
        })
        .catch(err => {
            console.error('Error fetching user profile:', err);
            profileModal.classList.add('hidden');
        });
}

function displayUserProfile(data) {
    const username = data.username || 'User';
    const displayName = data.display_name || username;

    const nameEl = document.getElementById('profile-username-display');
    if (nameEl) {
        const safeDisplayName = truncateString(escapeHTML(displayName)); // Modal now uses the standard 30-char limit
        const isSelfOwner = appCache.user && appCache.user.role === 'Owner';
        let badgeHtml = '';
        if (isSelfOwner) {
            if (data.role === 'Admin') badgeHtml = '<span class="role-badge badge-admin" style="margin-left:8px; vertical-align:middle;">Admin</span>';
            else if (data.role === 'Moderator') badgeHtml = '<span class="role-badge badge-mod" style="margin-left:8px; vertical-align:middle;">Mod</span>';
        }

        nameEl.innerHTML = safeDisplayName + badgeHtml;
    }

    const bioEl = document.getElementById('profile-bio-display');
    if (bioEl) bioEl.textContent = data.bio || "No bio yet.";

    const avatarEl = document.getElementById('profile-avatar-display');
    if (avatarEl) {
        const avatarUrl = safeImageURL(data.avatar);
        if (avatarUrl) {
            avatarEl.textContent = '';
            const image = document.createElement('img');
            image.src = avatarUrl;
            image.alt = 'avatar';
            image.style.cssText = 'width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%;';
            avatarEl.appendChild(image);
        } else {
            avatarEl.style.backgroundImage = 'linear-gradient(45deg,var(--gradient-1),var(--gradient-2))';
            avatarEl.style.backgroundSize = '';
            avatarEl.style.backgroundPosition = '';
            avatarEl.textContent = displayName.charAt(0).toUpperCase();
        }
    }

    const playlistsEl = document.getElementById('profile-playlists-count');
    if (playlistsEl) playlistsEl.textContent = (typeof data.playlists_count === 'number') ? data.playlists_count : '\u2014';

    // --- Detailed View Logic ---
    const detailBtn = document.getElementById('view-full-profile-btn');
    if (detailBtn) {
        detailBtn.onclick = () => {
            if (typeof navigateToProfile === 'function') {
                navigateToProfile(data.username);
            } else {
                window.location.href = `/profile/${data.username}`;
            }
        };
    }

    // --- Role / Promote UI ---
    const content = document.querySelector('.profile-content');
    let manager = document.getElementById('profile-manager');
    if (manager) manager.remove();

    const currentUser = appCache.user;
    if (currentUser && data.username !== currentUser.username) {
        const isOwner = currentUser.role === 'Owner';
        const isAdmin = currentUser.role === 'Admin';

        if (isOwner || isAdmin) {
            manager = document.createElement('div');
            manager.id = 'profile-manager';
            manager.className = 'perm-panel';

            let targetRole = data.role || 'User';
            let options = '';

            if (isOwner) {
                options = `
                    <option value="User" ${targetRole === 'User' ? 'selected' : ''}>User</option>
                    <option value="Moderator" ${targetRole === 'Moderator' ? 'selected' : ''}>Moderator</option>
                    <option value="Admin" ${targetRole === 'Admin' ? 'selected' : ''}>Admin</option>
                `;
            } else if (isAdmin) {
                // Admin can only promote to Moderator or User, and only if target is not higher
                if (targetRole !== 'Owner' && targetRole !== 'Admin') {
                    options = `
                        <option value="User" ${targetRole === 'User' ? 'selected' : ''}>User</option>
                        <option value="Moderator" ${targetRole === 'Moderator' ? 'selected' : ''}>Moderator</option>
                    `;
                }
            }

            if (options) {
                const safeUsername = escapeHTML(data.username);
                manager.innerHTML = `
                    <div class="perm-panel-header">
                        <i class='bx bx-shield-quarter'></i>
                        <span>Manage Permissions</span>
                    </div>

                    <div class="perm-role-row">
                        <select id="role-select">
                            ${options}
                        </select>
                        <button class="perm-update-btn" onclick="promoteUser('${safeUsername}')">
                            <i class='bx bx-check'></i> Update
                        </button>
                    </div>

                    <div class="perm-divider"></div>
                    <div class="perm-mod-label">Moderation</div>

                    <div class="perm-actions-grid">
                        <button class="perm-action-btn perm-action-btn--danger" onclick="banUser('${safeUsername}')">
                            <i class='bx bx-block'></i> Ban User
                        </button>
                        <button class="perm-action-btn" onclick="timeoutUserPrompt('${safeUsername}')">
                            <i class='bx bx-time-five'></i> Timeout
                        </button>
                    </div>

                    ${isOwner ? `
                    <div class="perm-actions-grid" style="margin-top:8px;">
                        <button class="perm-action-btn perm-action-btn--critical" onclick="deleteProfile('${safeUsername}')">
                            <i class='bx bx-trash'></i> Delete Profile
                        </button>
                    </div>` : ''}
                `;
                content.appendChild(manager);
            }
        }
    }
}

function promoteUser(username) {
    const role = document.getElementById('role-select').value;
    fetch(window.API_BASE_URL + '/api/admin/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, role })
    }).then(r => r.json()).then(data => {
        if (data.success) { showToast(data.message, 'success'); fetchPeople(true); } else showToast(data.error, 'error');
    });
}

function banUser(username) {
    fetch(window.API_BASE_URL + '/api/admin/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username })
    }).then(r => r.json()).then(data => { if (data.success) showToast(data.message, 'success'); else showToast(data.error, 'error'); });
}

function timeoutUserPrompt(username) {
    const mins = "60";
    if (!mins) return;
    fetch(window.API_BASE_URL + '/api/admin/timeout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, durationMinutes: parseInt(mins) })
    }).then(r => r.json()).then(data => { if (data.success) showToast(data.message, 'success'); else showToast(data.error, 'error'); });
}

function deleteProfile(username) {
    fetch(window.API_BASE_URL + `/api/admin/users/${username}`, {
        method: 'DELETE',
        credentials: 'include'
    }).then(r => r.json()).then(data => {
        if (data.success) {
            showToast(data.message, 'success');
            const m = document.getElementById('profile-modal');
            if (m) m.classList.add('hidden');
            if (typeof fetchPeople === 'function') fetchPeople(true);
        } else showToast(data.error, 'error');
    });
}

/* ========== NETWORK FETCH FUNCTIONS ========== */

let _currentUserPromise = null;

function fetchCurrentUser(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && appCache.user && (now - appCache.userTime < CACHE_DURATION)) {
        renderUserUI(appCache.user);
        window.currentUserPromise = Promise.resolve(appCache.user);
        return window.currentUserPromise;
    }

    if (_currentUserPromise) return _currentUserPromise;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const request = fetch(window.API_BASE_URL + '/api/me', { credentials: 'include', signal: controller.signal })
        .then(async r => {
            clearTimeout(timeoutId);
            if (!r.ok) {
                if (r.status === 401 && window.StreamifyEnv && window.StreamifyEnv.isCapacitor) {
                    const cached = window.OfflineStore ? await window.OfflineStore.getCachedUserProfile().catch(() => null) : null;
                    if (!cached) {
                        window.location.replace('/Static/loginpage/login.html');
                    }
                }
                throw new Error(`User request failed: ${r.status}`);
            }
            if (window.StreamifyNetwork) window.StreamifyNetwork.setServerReachable(true);
            return r.json();
        })
        .then(async data => {
            clearTimeout(timeoutId);
            const user = data.user || data;
            appCache.user = user;
            appCache.userTime = Date.now();
            renderUserUI(user);

            if (window.OfflineStore && user.username) {
                try {
                    await window.OfflineStore.cacheUserProfile(user.username, user.avatarUrl || user.avatar_url || user.avatar);
                } catch (error) {
                    console.warn('[OFFLINE PROFILE] Could not initialize account-scoped storage:', error);
                }
            }
            return user;
        })
        .catch(err => {
            clearTimeout(timeoutId);
            console.warn('Network error fetching user, falling back to offline profile:', err);
            if (window.StreamifyNetwork) window.StreamifyNetwork.setServerReachable(false);
            if (window.OfflineStore) {
                return window.OfflineStore.getCachedUserProfile().then(profile => {
                    const fallbackUser = profile
                        ? { username: profile.username, avatar: profile.avatarUrl, role: 'User' }
                        : { username: 'Offline User', avatar: '', role: 'User' };
                    renderUserUI(fallbackUser);
                    appCache.user = fallbackUser;
                    return fallbackUser;
                }).catch(() => {
                    const defaultOffline = { username: 'Offline User', avatar: '', role: 'User' };
                    renderUserUI(defaultOffline);
                    appCache.user = defaultOffline;
                    return defaultOffline;
                });
            }
            const defaultOffline = { username: 'Offline User', avatar: '', role: 'User' };
            renderUserUI(defaultOffline);
            appCache.user = defaultOffline;
            return defaultOffline;
        })
        .finally(() => {
            clearTimeout(timeoutId);
            if (_currentUserPromise === request) _currentUserPromise = null;
        });

    _currentUserPromise = request;
    window.currentUserPromise = request;
    return request;
}
window.fetchCurrentUser = fetchCurrentUser;

function updateWidgetNowPlaying(trackName, artist, albumArt, isPlaying, progress) {
    // Only send if we are logged in and online
    if (!appCache.user || !navigator.onLine) return;

    fetch(window.API_BASE_URL + '/api/widget/now-playing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            trackName,
            artist,
            albumArt,
            isPlaying,
            progress: Math.floor(progress) // seconds
        })
    }).catch(err => console.error('[WIDGET UPDATE ERROR]', err));
}

let _fetchTrendingSeq = 0;

function fetchTrending(forceRefresh = false) {
    const list = document.getElementById('trending-list');
    const now = Date.now();
    if (!forceRefresh && appCache.trending && (now - appCache.trendingTime < CACHE_DURATION)) {

        renderSongList(appCache.trending, list);
        return;
    }
    const seq = ++_fetchTrendingSeq;
    fetch(window.API_BASE_URL + '/api/trending')
        .then(r => r.json())
        .then(songs => {
            if (window.currentActiveView !== 'home' || seq !== _fetchTrendingSeq) return;
            appCache.trending = songs; appCache.trendingTime = Date.now();
            renderSongList(songs, list);
        })
        .catch(err => console.error('Error fetching trending:', err));
}

let _fetchLibrarySeq = 0;

function fetchLibrary(forceRefresh = false, options = {}) {
    const list = document.getElementById('trending-list'); // Streamify codebase calls the library list 'trending-list'.
    const shouldRender = options.render !== false;
    const renderOptions = options.renderOptions || {};

    if ((!navigator.onLine || window.StreamifyOfflineMode || (window.StreamifyNetwork && !window.StreamifyNetwork.isServerReachable)) && window.OfflineStore) {
        return window.OfflineStore.getOfflineSongs().then(songs => {
            if (shouldRender) renderSongList(songs, list, renderOptions);
            return songs;
        });
    }

    const now = Date.now();
    if (!forceRefresh && appCache.library && (now - appCache.libraryTime < CACHE_DURATION)) {
        if (shouldRender) renderSongList(appCache.library, list, renderOptions);
        return Promise.resolve(appCache.library);
    }
    const seq = ++_fetchLibrarySeq;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    return fetch(window.API_BASE_URL + '/api/library', { signal: controller.signal })
        .then(r => {
            clearTimeout(timeoutId);
            if (!r.ok) throw new Error(`Library request failed: ${r.status}`);
            return r.json();
        })
        .then(songs => {
            clearTimeout(timeoutId);
            if (window.StreamifyNetwork) window.StreamifyNetwork.setServerReachable(true);
            appCache.library = songs;
            appCache.libraryTime = Date.now();
            if (!shouldRender || window.currentActiveView !== 'library' || seq !== _fetchLibrarySeq) return songs;
            renderSongList(songs, list, renderOptions);
            return songs;
        })
        .catch(err => {
            clearTimeout(timeoutId);
            console.warn('Network error fetching library, checking offline storage:', err);
            if (window.StreamifyNetwork) window.StreamifyNetwork.setServerReachable(false);
            if (window.OfflineStore) {
                return window.OfflineStore.getOfflineSongs().then(songs => {
                    if (shouldRender) renderSongList(songs, list, renderOptions);
                    return songs;
                });
            }
            return [];
        });
}

// Global compatibility alias for legacy fetchSongs calls
window.fetchSongs = (force = true) => fetchLibrary(force);

function fetchPeople(forceRefresh = false) {
    const grid = document.getElementById('people-grid');
    const now = Date.now();
    if (!forceRefresh && appCache.people && (now - appCache.peopleTime < CACHE_DURATION)) {

        renderPeopleGrid(appCache.people);
        return;
    }
    grid.innerHTML = '<p style="color:#b3b3b3; padding:20px;">Loading...</p>';
    fetch(window.API_BASE_URL + '/api/users')
        .then(r => r.json())
        .then(users => { appCache.people = users; appCache.peopleTime = Date.now(); renderPeopleGrid(users); })
        .catch(err => { console.error('Error fetching people:', err); grid.innerHTML = '<p style="color:red;padding:20px;">Error loading people.</p>'; });
}

let notifsOffset = 0;
const NOTIFS_LIMIT = 20;

function fetchNotifications(append = false) {
    if (!append) notifsOffset = 0;
    fetch(`${window.API_BASE_URL}/api/notifications?offset=${notifsOffset}`, { credentials: 'include' })
        .then(r => r.json())
        .then(notifs => {
            if (append) {
                appCache.notifications = (appCache.notifications || []).concat(notifs);
            } else {
                appCache.notifications = notifs;
            }
            renderNotifications(appCache.notifications, notifs.length === NOTIFS_LIMIT);
        });
}

function loadMoreNotifications() {
    notifsOffset += NOTIFS_LIMIT;
    fetchNotifications(true);
}

function renderNotifications(notifs, hasMore = false) {
    const menu = document.getElementById('notification-menu');
    const badge = document.getElementById('notif-badge');
    if (!menu) return;

    // Filter unread
    const unreadCount = notifs.filter(n => !n.is_read).length;
    if (unreadCount > 0) {
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    // Preserve header
    menu.innerHTML = '<h4>Notifications</h4><div class="notif-list" id="notif-list"></div>';
    const list = document.getElementById('notif-list');

    if (!notifs || notifs.length === 0) {
        list.innerHTML = '<p style="color:#b3b3b3; padding:15px; text-align:center; font-size:13px;">No notifications yet.</p>';
        return;
    }

    notifs.forEach(n => {
        const safeActor = truncateString(escapeHTML(n.actor_username));
        const initial = safeActor.charAt(0).toUpperCase();
        let actionText = '';
        if (n.type === 'like') actionText = 'liked your post';
        else if (n.type === 'comment') actionText = 'commented on your post';
        else if (n.type === 'mention') actionText = 'mentioned you in a post';
        else if (n.type === 'dm') actionText = 'sent you a message';
        else actionText = 'interacted with your post';

        const unreadClass = n.is_read ? '' : 'unread';
        const timeStr = timeAgo(n.created_at);

        const avatarHtml = n.avatar
            ? `<img src="${escapeHTML(n.avatar)}" class="notif-item-img" alt="${safeActor}">`
            : `<div class="notif-item-avatar-placeholder">${initial}</div>`;

        const item = document.createElement('div');
        item.className = `notif-item ${unreadClass}`;
        item.innerHTML = `
            <div class="notif-item-avatar">${avatarHtml}</div>
            <div class="notif-item-content">
                <div class="notif-item-text"><b>${safeActor}</b> ${actionText}</div>
                <div class="notif-item-time">${timeStr}</div>
            </div>
        `;
        item.onclick = () => {
            if (n.type === 'dm') {
                const dmBtn = document.getElementById('open-dm-btn');
                if (dmBtn) dmBtn.click();
            } else if (n.post_id) {
                if (typeof navigateToPost === 'function') {
                    navigateToPost(n.post_id);
                } else {
                    // Fallback to scrolling if navigateToPost is not available
                    const target = document.querySelector(`.post-card[data-id="${n.post_id}"]`);
                    if (target) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        target.style.outline = '2px solid var(--accent)';
                        setTimeout(() => target.style.outline = '', 2000);
                    }
                }
            }
            menu.classList.remove('show');
        };
        list.appendChild(item);
    });

    if (hasMore) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'btn btn-outline btn-sm';
        loadMoreBtn.style.width = 'calc(100% - 16px)';
        loadMoreBtn.style.margin = '8px';
        loadMoreBtn.innerHTML = 'Load More';
        loadMoreBtn.onclick = (e) => {
            e.stopPropagation();
            loadMoreBtn.innerHTML = 'Loading...';
            loadMoreBtn.disabled = true;
            loadMoreNotifications();
        };
        list.appendChild(loadMoreBtn);
    }
}

function markNotificationsAsRead() {
    fetch(window.API_BASE_URL + '/api/notifications/mark-read', {
        method: 'POST',
        credentials: 'include'
    }).then(() => {
        const badge = document.getElementById('notif-badge');
        if (badge) badge.classList.add('hidden');
        if (appCache.notifications) {
            appCache.notifications.forEach(n => n.is_read = 1);
        }
    });
}

let _searchAbort = null;

function cancelSearchRequest(clearPlaylist = false) {
    if (_searchAbort) _searchAbort.abort();
    _searchAbort = null;
    if (clearPlaylist) {
        currentPlaylist = [];
        shuffledPlaylist = [];
    }
}
window.cancelSearchRequest = cancelSearchRequest;

function performSearch(query) {
    if (!query) return;

    cancelSearchRequest();
    const controller = new AbortController();
    _searchAbort = controller;

    const songsList = document.getElementById('search-songs-list');
    if (!songsList) {
        _searchAbort = null;
        return;
    }
    songsList.innerHTML = '<p style="color:#b3b3b3;">Searching...</p>';

    fetch(window.API_BASE_URL + `/api/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
        signal: controller.signal
    })
        .then(r => {
            if (!r.ok) throw new Error(`Search failed (${r.status})`);
            return r.json();
        })
        .then(data => {
            if (_searchAbort !== controller || window.currentActiveView !== 'search') return;
            songsList.innerHTML = `
                <div class="song-row header-row" style="cursor:default;background:transparent;color:#b3b3b3;border-bottom:1px solid #333;margin-bottom:10px;">
                    <span>#</span><span>Title</span><span>Album</span><span>Uploaded By</span><span><i class='bx bx-time'></i></span><span></span>
                </div>`;

            if (data.songs && data.songs.length > 0) {
                const renderedPlaylist = data.songs.map(s => ({
                    id: s.id,
                    title: s.name || s.title || s,
                    artist: s.artist || 'Unknown Artist',
                    album: s.album || 'Single',
                    cover: s.cover,
                    uploaded_by: s.uploaded_by || 'Unknown',
                    duration: s.duration,
                    bitrate: s.bitrate,
                    extension: s.extension,
                    url: `/api/play/${s.id || encodeURIComponent(s.name || s.title || s)}`
                }));
                currentPlaylist = renderedPlaylist;
                shuffledPlaylist = buildPlaylistOrder(currentPlaylist.length);
                currentPlaylist.forEach((song, index) => {
                    const cover = safeImageURL(song.cover, COVER_PLACEHOLDER);
                    const title = escapeHTML(song.title);
                    const artist = escapeHTML(song.artist);
                    const album = escapeHTML(song.album);
                    const uploadedBy = escapeHTML(song.uploaded_by);
                    const duration = escapeHTML(song.duration || '--:--');

                    const row = document.createElement('div');
                    row.className = 'song-row';
                    row.tabIndex = 0;
                    row.setAttribute('role', 'button');
                    row.setAttribute('aria-label', `Play ${song.title} by ${song.artist}`);
                    row.innerHTML = `<div class="index-cell"><div class="select-indicator"></div><span class="row-index-number">${index + 1}</span></div><div class="song-info"><img alt="cover" loading="lazy" decoding="async"><div><div class="song-title-row">${title}</div><div style="font-size:12px;">${artist}</div></div></div><span>${album}</span><span>${uploadedBy}</span><span>${duration}</span><div class="edit-btn-container"></div>`;
                    row.querySelector('img').src = cover;
                    row.onclick = () => playSongAtIndex(index);
                    row.addEventListener('keydown', event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        playSongAtIndex(index);
                    });
                    songsList.appendChild(row);
                });
            } else {
                currentPlaylist = [];
                shuffledPlaylist = [];
                songsList.insertAdjacentHTML('beforeend', '<p style="padding:10px;color:#b3b3b3;">No songs match your search.</p>');
            }
        })
        .catch(err => {
            if (err.name === 'AbortError') return;
            if (_searchAbort !== controller || window.currentActiveView !== 'search') return;
            console.error(err);
            songsList.innerHTML = '<p style="padding:10px;color:#f87171;">Error searching songs.</p>';
        })
        .finally(() => {
            if (_searchAbort === controller) _searchAbort = null;
        });
}

/* ========== POSTS FUNCTIONS ========== */

function createPost(body, photoFile = null) {
    if (!photoFile && (!body || body.trim() === '')) return Promise.reject("Empty post");

    if (photoFile) {
        const formData = new FormData();
        formData.append('body', body || "");
        // Crucial: Provide a filename for the blob so multer can detect extension
        formData.append('photo', photoFile, 'post_image.jpg');

        return fetch(window.API_BASE_URL + '/api/posts/photo', {
            method: 'POST',
            body: formData,
            credentials: 'include'
        }).then(r => r.json());
    }

    return fetch(window.API_BASE_URL + '/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
        credentials: 'include'
    }).then(r => r.json());
}

function fetchPosts(append = false) {
    const container = document.getElementById('posts-container');
    const loadMoreBtn = document.getElementById('load-more-btn');
    const endMsg = document.getElementById('feed-end-message');
    if (!container || feedState.isLoading) return;

    if (!append) {
        feedState.page = 1;
        feedState.hasMore = true;
        if (endMsg) endMsg.classList.add('hidden');
    }

    feedState.isLoading = true;
    if (loadMoreBtn) {
        loadMoreBtn.classList.add('loading');
        loadMoreBtn.classList.remove('hidden');
        loadMoreBtn.querySelector('span').textContent = 'Loading...';
    }

    const url = new URL(window.API_BASE_URL + '/api/posts', window.location.origin);
    url.searchParams.set('sortBy', feedState.sortBy);
    url.searchParams.set('limit', feedState.limit);
    url.searchParams.set('page', feedState.page);

    if (!navigator.onLine) {
        feedState.isLoading = false;
        if (!append) {
            container.innerHTML = `
                <div style="padding:20px; text-align:center;">
                    <p style="color:var(--text-secondary); margin-bottom: 10px;">Offline Mode: Feed is unavailable.</p>
                    <button onclick="fetchPosts()" class="btn btn-outline" style="padding: 6px 12px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; margin: 0 auto;">
                        <i class='bx bx-refresh' style="font-size: 18px;"></i> Refresh
                    </button>
                </div>
            `;
        }
        if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
        return;
    }

    fetch(url, { credentials: 'include' })
        .then(r => r.json())
        .then(posts => {
            feedState.isLoading = false;

            if (!posts || posts.length < feedState.limit) {
                feedState.hasMore = false;
                if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
                if (endMsg && (append || posts.length > 0)) endMsg.classList.remove('hidden');
            } else {
                if (loadMoreBtn) {
                    loadMoreBtn.classList.remove('hidden');
                    loadMoreBtn.classList.remove('loading');
                    loadMoreBtn.querySelector('span').textContent = 'Load More';
                }
            }

            if (!append) {
                renderPosts(posts);
            } else {
                appendPosts(posts);
            }

            feedState.page++;
        })
        .catch(err => {
            feedState.isLoading = false;
            console.error('[FETCH POSTS]', err);
            if (!append) {
                container.innerHTML = '<p style="color:red; padding:20px; text-align:center;">Error loading feed.</p>';
            }
            if (loadMoreBtn) {
                loadMoreBtn.classList.remove('loading');
                loadMoreBtn.querySelector('span').textContent = 'Load More';
            }
        });
}

function appendPosts(posts) {
    const container = document.getElementById('posts-container');
    if (!container || !posts) return;
    posts.forEach(post => container.appendChild(createPostElement(post)));
}

function createPostElement(post) {
    const article = document.createElement('article');
    article.className = 'post-card';
    article.dataset.id = post.id;

    const isOwnerTask = post.role === 'Owner';
    const isAdminTask = post.role === 'Admin';
    const isModTask = post.role === 'Moderator';

    if (isOwnerTask) article.classList.add('post-card--owner');
    else if (isAdminTask) article.classList.add('post-card--glow');

    const initial = post.username.charAt(0).toUpperCase();
    const safeInitial = escapeHTML(initial);
    const avatarStyle = post.avatar
        ? `background-image: url('${safeStyleURL(post.avatar)}'); background-size: cover; background-position: center;`
        : `background: linear-gradient(135deg, var(--gradient-1), var(--gradient-2)); color: var(--on-gradient);`;

    let badgeHtml = '';
    const isSelfOwner = appCache.user && appCache.user.role === 'Owner';
    if (isSelfOwner) {
        if (isAdminTask) badgeHtml = '<span class="role-badge badge-admin">Admin</span>';
        else if (isModTask) badgeHtml = '<span class="role-badge badge-mod">Mod</span>';
    }

    const timeStr = timeAgo(post.created_at);
    const likedClass = post.user_has_liked ? 'active' : '';
    const heartIcon = post.user_has_liked ? 'bxs-heart' : 'bx-heart';

    const safeUsername = escapeHTML(post.username);
    const safeDisplayName = truncateString(escapeHTML(post.display_name || post.username));
    const parsedBody = parseMentions(post.body);

    const canDelete = appCache.user && (
        ['Owner', 'Admin', 'Moderator'].includes(appCache.user.role) ||
        appCache.user.username === post.username
    );

    article.innerHTML = `
        <div class="post-header">
            <div class="post-avatar" style="${avatarStyle};cursor:pointer">${post.avatar ? '' : safeInitial}</div>
            <div class="post-user-info">
                <span class="post-username" style="cursor:pointer">${safeDisplayName} ${badgeHtml}</span>
                <span class="post-handle" style="cursor:pointer">@${safeUsername.toLowerCase()} \u00b7 ${timeStr}</span>
            </div>
            ${canDelete ? `
            <div class="post-menu-wrap">
                <button class="post-menu-btn" onclick="togglePostMenu(event, ${post.id})"><i class='bx bx-dots-vertical-rounded'></i></button>
                <div class="post-context-menu hidden" id="post-menu-${post.id}">
                    <button onclick="if(this.dataset.ready){deletePost(${post.id});}else{this.dataset.ready=true;this.style.color='#ff4d4d';this.querySelector('span').textContent='Double click';setTimeout(()=>{this.dataset.ready='';this.style.color='';this.querySelector('span').textContent='Delete';}, 3000);}"><i class='bx bx-trash'></i> <span>Delete</span></button>
                    ${(appCache.user && ['Owner', 'Admin'].includes(appCache.user.role)) ?
                `<button onclick="shadowBanPost(${post.id}, this)"><i class='bx bx-low-vision'></i> <span>${post.is_flagged ? 'Un-Shadow Ban' : 'Shadow Ban'}</span></button>` : ''}
                </div>
            </div>` : ''}
        </div>
        ${parsedBody ? `<p class="post-body">${parsedBody}</p>` : ''}
        ${post.image_url ? `
            <div class="post-image-container">
                <img src="${post.image_url}" class="post-image" loading="lazy">
            </div>
        ` : ''}
        <div class="post-actions">
            <button class="post-action-btn like-btn ${likedClass}" onclick="handleLikeClick(this, ${post.id})">
                <i class='bx ${heartIcon}'></i> <span>${post.likes || 0}</span>
            </button>
            <button class="post-action-btn comment-btn" onclick="toggleComments(this, ${post.id})">
                <i class='bx bx-comment'></i> <span>${post.comments || 0}</span>
            </button>
            <button class="post-action-btn share-btn" onclick="copyPostLink(${post.id})">
                <i class='bx bx-share-alt'></i> Share
            </button>
            ${(post.is_flagged && appCache.user && ['Owner', 'Admin'].includes(appCache.user.role)) ?
            `<span class="shadow-ban-badge" style="color: #f39c12; font-size: 11px; margin-left: 10px; display: flex; align-items: center; gap: 4px; font-weight: 500;">
                    <i class='bx bx-low-vision' style="font-size: 14px;"></i> Shadow Banned
                </span>` : ''}
        </div>
        <div class="comments-section hidden" id="comments-${post.id}">
            <div class="comments-list" id="comments-list-${post.id}"></div>
            <div class="comment-input-wrap">
                <input type="text" placeholder="Write a comment..." id="comment-input-${post.id}" onkeypress="if(event.key==='Enter') submitComment(${post.id}, this)">
                <button class="btn-send-comment" onclick="submitComment(${post.id}, this)"><i class='bx bx-send'></i></button>
            </div>
        </div>
    `;

    article.querySelectorAll('.post-avatar, .post-username, .post-handle').forEach(element => {
        element.addEventListener('click', event => {
            event.stopPropagation();
            openUserProfileModal(post.username);
        });
    });

    // Click Redirection: Clicking the post (header or body) redirects to the Focused Detail View
    article.onclick = (e) => {
        // Don't redirect if clicking actions or comments or menu
        if (e.target.closest('.post-actions') || e.target.closest('.comments-section') || e.target.closest('.post-menu-wrap')) return;
        // Don't redirect if the user is selecting text
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        // Don't redirect if clicking a link inside the post body
        if (e.target.closest('.mention-link') || e.target.tagName === 'A') return;

        // Show detail view
        navigateToPost(post.id);
    };

    // Initialize Mention Autocomplete for the comment input
    const commentInput = article.querySelector(`#comment-input-${post.id}`);
    if (commentInput && window.initMentionAutocomplete) {
        window.initMentionAutocomplete(commentInput);
    } else if (commentInput) {
        // Fallback for when ui.js loads later
        setTimeout(() => {
            if (window.initMentionAutocomplete) window.initMentionAutocomplete(commentInput);
        }, 100);
    }

    return article;
}
function renderPosts(posts) {
    const container = document.getElementById('posts-container');
    if (!container) return;

    if (!posts || posts.length === 0) {
        container.innerHTML = '<p style="color:#b3b3b3; padding: 40px; text-align: center;">No posts yet. Be the first!</p>';
        return;
    }

    container.innerHTML = '';
    posts.forEach(post => container.appendChild(createPostElement(post)));
}

function updateProfile(display_name, bio) {
    return fetch(window.API_BASE_URL + '/api/user/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name, bio }),
        credentials: 'include'
    }).then(r => r.json());
}

function changePassword(old_password, new_password) {
    return fetch(window.API_BASE_URL + '/api/user/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password, new_password }),
        credentials: 'include'
    }).then(r => r.json());
}

function logoutOthers() {
    return fetch(window.API_BASE_URL + '/api/user/logout-others', {
        method: 'POST',
        credentials: 'include'
    }).then(r => r.json());
}

function togglePostMenu(event, id) {
    event.stopPropagation();
    // Find the menu relative to the clicked button's post card
    const btn = event.currentTarget;
    const card = btn.closest('.post-card');
    const menu = card ? card.querySelector(`#post-menu-${id}`) : document.getElementById(`post-menu-${id}`);
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.post-context-menu').forEach(m => { m.classList.add('hidden'); m.style.left = ''; m.style.top = ''; });
    if (isHidden) {
        menu.classList.remove('hidden');
    }
}

function deletePost(id) {
    fetch(window.API_BASE_URL + `/api/posts/${id}`, {
        method: 'DELETE',
        credentials: 'include'
    }).then(r => r.json()).then(data => {
        if (data.success) {
            document.querySelectorAll(`.post-card[data-id="${id}"]`).forEach(postCard => {
                postCard.classList.add('deleting-anim');
                setTimeout(() => postCard.remove(), 400);
            });
            // If we were on the post detail view, go back
            const detailSection = document.getElementById('post-detail-section');
            if (detailSection && !detailSection.classList.contains('hidden')) {
                const backBtn = document.getElementById('back-to-feed-btn');
                if (backBtn) backBtn.click();
            }
        } else {
            showToast(data.error, 'error');
        }
    });
}

function shadowBanPost(id, btn) {
    fetch(window.API_BASE_URL + '/api/admin/post/shadow-ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: id }),
        credentials: 'include'
    }).then(r => r.json()).then(data => {
        if (data.success) {
            showToast(data.message, 'success');
            if (btn) {
                btn.querySelector('span').textContent = data.is_shadow_banned ? 'Un-Shadow Ban' : 'Shadow Ban';
            }
            // Refresh the post to show the badge correctly
            fetchPosts();
        } else {
            showToast(data.error, 'error');
        }
    });
}

function handleLikeClick(btn, postId) {
    togglePostLike(postId).then(data => {
        const icon = btn.querySelector('i');
        const span = btn.querySelector('span');

        // Use ground truth if available, otherwise fallback to local guess (rare)
        if (typeof data.likes === 'number') {
            span.textContent = data.likes;
        } else {
            let count = parseInt(span.textContent);
            span.textContent = data.liked ? count + 1 : Math.max(0, count - 1);
        }

        if (data.liked) {
            btn.classList.add('active');
            icon.className = 'bx bxs-heart';
            triggerHeartConfetti(btn);
        } else {
            btn.classList.remove('active');
            icon.className = 'bx bx-heart';
        }
    });
}

function toggleComments(btn, postId) {
    const card = btn ? btn.closest('.post-card') : document.getElementById(`comments-${postId}`)?.parentElement;
    if (!card) return;

    const section = card.querySelector('.comments-section');
    const list = card.querySelector('.comments-list');

    if (section.classList.contains('hidden')) {
        section.classList.remove('hidden');
        fetchComments(postId, false, list);
    } else {
        section.classList.add('hidden');
    }
}

function togglePostLike(postId) {
    return fetch(window.API_BASE_URL + `/api/posts/${postId}/like`, {
        method: 'POST',
        credentials: 'include'
    }).then(r => r.json());
}

function fetchComments(postId, silent = false, explicitList = null) {
    const list = explicitList || document.getElementById(`comments-list-${postId}`);
    if (!list) return;
    if (!silent) list.innerHTML = '<div class="loading-comments">Loading...</div>';

    fetch(window.API_BASE_URL + `/api/posts/${postId}/comments`)
        .then(r => r.json())
        .then(comments => {
            list.innerHTML = '';
            if (comments.length === 0) {
                list.innerHTML = '<div class="no-comments">No comments yet.</div>';
                return;
            }
            comments.forEach(c => {
                const initial = c.username.charAt(0).toUpperCase();
                const avatarStyle = c.avatar
                    ? `background-image: url('${safeStyleURL(c.avatar)}'); background-size: cover;`
                    : `background: linear-gradient(135deg, #666, #444);`;

                const safeDisplayName = escapeHTML(c.display_name || c.username);
                const safeUsername = escapeHTML(c.username);
                const parsedBody = parseMentions(c.body);
                const timeStr = timeAgo(c.created_at);

                const canDeleteComment = appCache.user && (
                    ['Owner', 'Admin', 'Moderator'].includes(appCache.user.role) ||
                    appCache.user.username === c.username
                );

                const deleteBtnHtml = canDeleteComment ?
                    `<button class="comment-delete-btn" onclick="if(this.classList.contains('confirm-mode')){deleteComment(${c.id}, ${postId}, this);}else{this.classList.add('confirm-mode');setTimeout(()=>{this.classList.remove('confirm-mode');},3000);}"><i class='bx bx-trash'></i><span class="btn-text">Delete?</span></button>` : '';

                const item = document.createElement('div');
                item.className = 'comment-item';
                item.dataset.id = c.id;
                item.innerHTML = `
                    <div class="comment-avatar" style="${avatarStyle}">${c.avatar ? '' : initial}</div>
                    <div class="comment-content">
                        <div class="comment-user">
                            ${safeDisplayName} <span class="post-handle">@${safeUsername.toLowerCase()}</span>
                            <span class="comment-time">${timeStr}</span>
                        </div>
                        <div class="comment-body">${parsedBody}</div>
                        ${deleteBtnHtml}
                    </div>
                `;
                list.appendChild(item);
            });
        });
}

function submitComment(postId, el = null) {
    const input = el ? (el.tagName === 'INPUT' ? el : el.parentElement.querySelector('input')) : document.getElementById(`comment-input-${postId}`);
    if (!input) return;
    const body = input.value.trim();
    if (!body) return;

    fetch(window.API_BASE_URL + `/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
        credentials: 'include'
    }).then(r => r.json()).then(data => {
        if (data.success) {
            input.value = '';
            // Fetch comments for the specific list where the comment was added
            const list = input.closest('.comments-section').querySelector('.comments-list');
            fetchComments(postId, false, list);
            // Update comment count in UI
            const postCard = document.querySelector(`.post-card[data-id="${postId}"]`);
            if (postCard) {
                const countSpan = postCard.querySelector('.comment-btn span');
                if (countSpan && typeof data.comments === 'number') {
                    countSpan.textContent = data.comments;
                }
            }
        }
    });
}

function deleteComment(id, postId, el = null) {
    fetch(window.API_BASE_URL + `/api/comments/${id}`, {
        method: 'DELETE',
        credentials: 'include'
    }).then(r => r.json()).then(data => {
        if (data.success) {
            const commentEl = el ? el.closest('.comment-item') : document.querySelector(`.comment-item[data-id="${id}"]`);
            if (commentEl) {
                commentEl.classList.add('deleting-anim');
                setTimeout(() => commentEl.remove(), 400);
            } else {
                fetchComments(postId);
            }
            // Update comment count in UI
            const postCard = document.querySelector(`.post-card[data-id="${postId}"]`);
            if (postCard) {
                const countSpan = postCard.querySelector('.comment-btn span');
                if (countSpan && typeof data.comments === 'number') {
                    countSpan.textContent = data.comments;
                }
            }
        } else {
            showToast(data.error, 'error');
        }
    });
}

function copyPostLink(postId) {
    const url = window.location.origin + '/home#post-' + postId;
    // copyToClipboard falls back to execCommand when navigator.clipboard is
    // unavailable, which is the case on a plain-HTTP LAN origin.
    window.copyToClipboard(url).then((ok) => {
        showToast(
            ok ? 'Post link copied to clipboard!' : 'Could not copy link.',
            ok ? 'success' : 'error'
        );
    });
}

function timeAgo(dateString) {
    const now = new Date();
    const past = new Date(dateString);
    const diff = Math.floor((now - past) / 1000);

    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
    return past.toLocaleDateString();
}

/* ========== MISC HELPERS ========== */

function triggerHeartConfetti(element) {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < 30; i++) {
        const heart = document.createElement('div');
        heart.className = 'particle';
        heart.innerHTML = "<i class='bx bxs-heart'></i>";
        heart.style.color = `hsl(${330 + Math.random() * 20}, 100%, 70%)`;
        heart.style.setProperty('--tx', `${(Math.random() - 0.5) * 200}px`);
        heart.style.setProperty('--rot', `${(Math.random() - 0.5) * 360}deg`);
        heart.style.left = `${cx}px`;
        heart.style.top = `${cy}px`;
        document.body.appendChild(heart);
        setTimeout(() => heart.remove(), 1500);
    }
}

// Global click listener for menus
window.addEventListener('click', (e) => {
    if (!e.target.closest('.post-menu-wrap') && !e.target.closest('.row-menu-btn') && !e.target.closest('.song-context-menu')) {
        document.querySelectorAll('.post-context-menu').forEach(m => { m.classList.add('hidden'); m.style.left = ''; m.style.top = ''; });
    }
});

/* ========== PLAYLIST FUNCTIONS ========== */

function fetchPlaylists(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && appCache.playlists && (now - appCache.playlistsTime < CACHE_DURATION)) {
        renderSidebarPlaylists(appCache.playlists);
        return appCache.playlists;
    }
    fetch(window.API_BASE_URL + '/api/playlists', { credentials: 'include' })
        .then(r => {
            if (!r.ok) throw new Error(`Playlist request failed: ${r.status}`);
            return r.json();
        })
        .then(playlists => {
            appCache.playlists = playlists;
            appCache.playlistsTime = Date.now();
            renderSidebarPlaylists(playlists);
        })
        .catch(err => console.error('[FETCH PLAYLISTS]', err));
}

function renderSidebarPlaylists(playlists) {
    const list = document.getElementById('sidebar-playlist-list');
    if (!list) return;
    list.innerHTML = '';

    if (!playlists || playlists.length === 0) {
        list.innerHTML = '<li><span style="color: var(--text-secondary); font-size: 12px; padding: 4px 8px; display: block;">No playlists yet</span></li>';
        return;
    }

    playlists.forEach(p => {
        const li = document.createElement('li');
        const safeName = escapeHTML(p.name);
        const activeId = window.currentPlaylistId || window.requestedPlaylistId;
        const isActive = activeId && (activeId == p.id || activeId == p.share_id);
        const pid = p.share_id || p.id;
        li.innerHTML = `<a href="#" class="sidebar-playlist-link${isActive ? ' active' : ''}" data-playlist-id="${pid}"><i class='bx bx-list-ul'></i><span>${safeName}</span></a>`;
        li.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof navigateToPlaylist === 'function') navigateToPlaylist(pid);
        });
        list.appendChild(li);
    });
}

function createPlaylist(name) {
    return fetch(window.API_BASE_URL + '/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name })
    }).then(r => r.json());
}

function renamePlaylist(id, name, bio = '', visibility = 'private') {
    return fetch(window.API_BASE_URL + `/api/playlists/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, bio, is_private: visibility })
    }).then(r => r.json())
        .then(res => {
            if (appCache.playlistDetails && appCache.playlistDetails[id]) delete appCache.playlistDetails[id];
            return res;
        });
}

function uploadPlaylistCover(id, file) {
    const formData = new FormData();
    formData.append('cover_file', file);

    return fetch(window.API_BASE_URL + `/api/playlists/${id}/cover`, {
        method: 'POST',
        credentials: 'include',
        body: formData
    }).then(r => r.json())
        .then(res => {
            if (appCache.playlistDetails && appCache.playlistDetails[id]) delete appCache.playlistDetails[id];
            return res;
        });
}

function deletePlaylist(id) {
    return fetch(window.API_BASE_URL + `/api/playlists/${id}`, {
        method: 'DELETE',
        credentials: 'include'
    }).then(r => r.json())
        .then(res => {
            if (appCache.playlistDetails && appCache.playlistDetails[id]) delete appCache.playlistDetails[id];
            return res;
        });
}

function addSongToPlaylist(playlistId, songId) {
    return fetch(window.API_BASE_URL + `/api/playlists/${playlistId}/songs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ songId })
    }).then(r => r.json())
        .then(res => {
            if (appCache.playlistDetails && appCache.playlistDetails[playlistId]) delete appCache.playlistDetails[playlistId];
            return res;
        });
}

function removeSongFromPlaylist(playlistId, songId) {
    return fetch(window.API_BASE_URL + `/api/playlists/${playlistId}/songs/${songId}`, {
        method: 'DELETE',
        credentials: 'include'
    }).then(r => r.json())
        .then(res => {
            if (appCache.playlistDetails && appCache.playlistDetails[playlistId]) delete appCache.playlistDetails[playlistId];
            return res;
        });
}

function fetchPlaylistSongs(playlistId, forceRefresh = false, signal) {
    const now = Date.now();
    if (!forceRefresh && appCache.playlistDetails[playlistId] && (now - appCache.playlistDetailsTime[playlistId] < CACHE_DURATION)) {
        return Promise.resolve(appCache.playlistDetails[playlistId]);
    }

    // Detect if playlistId is a share_id (16-char hex string) or a numeric ID
    const isShareId = typeof playlistId === 'string' && /^[0-9a-f]{16}$/i.test(playlistId);
    const url = isShareId
        ? `${window.API_BASE_URL}/api/playlists/share/${playlistId}`
        : `${window.API_BASE_URL}/api/playlists/${playlistId}/songs`;

    return fetch(url, { credentials: 'include', signal })
        .then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok && !data.error) throw new Error(`Playlist request failed: ${r.status}`);
            return data;
        })
        .then(data => {
            if (!data.error) {
                appCache.playlistDetails[playlistId] = data;
                appCache.playlistDetailsTime[playlistId] = Date.now();
            }
            return data;
        });
}

let _playlistRenderSeq = 0;
let _playlistRenderAbort = null;

function cancelPlaylistDetailRequest() {
    if (_playlistRenderAbort) _playlistRenderAbort.abort();
    _playlistRenderAbort = null;
    _playlistRenderSeq++;
}
window.cancelPlaylistDetailRequest = cancelPlaylistDetailRequest;

function setPlaylistDetailName(value) {
    const nameEl = document.getElementById('playlist-detail-name');
    if (!nameEl) return;
    let textNode = Array.from(nameEl.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
    if (!textNode) {
        textNode = document.createTextNode('');
        nameEl.prepend(textNode);
    }
    textNode.nodeValue = `${value} `;
}

async function renderPlaylistDetail(playlistId) {
    const seq = ++_playlistRenderSeq;
    if (_playlistRenderAbort) _playlistRenderAbort.abort();
    const controller = new AbortController();
    _playlistRenderAbort = controller;

    window.requestedPlaylistId = playlistId;
    window.currentPlaylistId = null;
    window.currentPlaylistOwner = null;
    window.currentPlaylistIsPrivate = null;
    window.currentPlaylistShareId = null;
    currentPlaylist = [];
    shuffledPlaylist = [];
    selectedPlaylistSongIds.clear();
    isPlaylistEditMode = false;
    updatePlaylistSelectedCount();

    const playlistBar = document.getElementById('playlist-batch-bar');
    if (playlistBar) playlistBar.classList.add('hidden');
    const manageButton = document.getElementById('manage-playlist-btn');
    if (manageButton) {
        manageButton.classList.remove('active');
        manageButton.innerHTML = "<i class='bx bx-pencil'></i> Edit songs";
    }
    ['manage-playlist-btn', 'rename-playlist-btn', 'delete-playlist-btn', 'clone-playlist-btn', 'share-playlist-btn', 'download-playlist-btn'].forEach(id => {
        const button = document.getElementById(id);
        if (button) {
            button.classList.add('hidden');
            if (id === 'clone-playlist-btn' || id === 'share-playlist-btn') button.onclick = null;
        }
    });

    // Clear old content immediately to prevent stale data flash
    setPlaylistDetailName('Loading...');
    document.getElementById('playlist-detail-count').textContent = '';
    const ownerLabel = document.getElementById('playlist-detail-owner');
    if (ownerLabel) ownerLabel.textContent = '';
    const initialLockIcon = document.getElementById('playlist-lock-icon');
    if (initialLockIcon) initialLockIcon.classList.add('hidden');

    const bioEl = document.getElementById('playlist-detail-bio');
    if (bioEl) {
        bioEl.textContent = '';
        bioEl.style.display = 'none';
    }

    const coverEl = document.getElementById('playlist-detail-cover');
    if (coverEl) {
        delete coverEl.dataset.playlistId;
        coverEl.style.backgroundImage = 'linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(168, 85, 247, 0.3))';
        const icon = coverEl.querySelector('.bx-music');
        if (icon) icon.style.display = 'block';
        coverEl.classList.remove('editable');
    }

    const list = document.getElementById('playlist-songs-list');
    const header = list ? list.querySelector('.header-row') : null;
    if (list) {
        list.innerHTML = '';
        if (header) list.appendChild(header);
    }

    const userPromise = typeof fetchCurrentUser === 'function' ? fetchCurrentUser() : Promise.resolve(null);

    try {
        let songs = [];
        let playlist = null;
        let data;

        try {
            data = await fetchPlaylistSongs(playlistId, true, controller.signal); // Force refresh to bypass in-memory JS cache on load
        } catch (e) {
            if (e.name === 'AbortError' || seq !== _playlistRenderSeq) return;
            // If fetch fails (e.g. offline and not in SW cache), try checking IndexedDB as a fallback
            if (!navigator.onLine && window.OfflineStore) {
                const cachedPlaylistData = await window.OfflineStore.getOfflinePlaylist(playlistId);
                if (cachedPlaylistData) {
                    data = cachedPlaylistData;
                } else {
                    setPlaylistDetailName('Offline or Unavailable');
                    return;
                }
            } else {
                console.warn("Failed to fetch playlist songs:", e);
                setPlaylistDetailName('Offline or Unavailable');
                return;
            }
        }

        // Discard if a newer render was triggered
        if (seq !== _playlistRenderSeq || controller.signal.aborted || !data) return;

        if (data.error) {
            setPlaylistDetailName('Private Playlist');
            document.getElementById('playlist-detail-count').textContent = data.error;

            ['manage-playlist-btn', 'rename-playlist-btn', 'delete-playlist-btn', 'clone-playlist-btn', 'share-playlist-btn', 'download-playlist-btn'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.classList.add('hidden');
            });

            return;
        }

        playlist = data.playlist;
        const canonicalPlaylistId = Number(playlist && playlist.id);
        if (!Number.isSafeInteger(canonicalPlaylistId) || canonicalPlaylistId <= 0) {
            throw new Error('Playlist response did not include a valid numeric ID');
        }
        window.currentPlaylistId = canonicalPlaylistId;
        window.currentPlaylistShareId = playlist.share_id || null;

        // Update URL hash to use share_id for privacy if we're currently showing a numeric ID
        if (playlist.share_id && window.location.hash === `#playlist-${playlist.id}`) {
            history.replaceState(null, '', `/home#playlist-${playlist.share_id}`);
        }

        // If offline, filter the returned songs to only those downloaded
        if (!navigator.onLine && window.OfflineStore) {
            const offlineSongs = await window.OfflineStore.getOfflineSongs();
            if (seq !== _playlistRenderSeq || controller.signal.aborted) return;
            const offlineIds = new Set(offlineSongs.map(s => s.id));
            songs = (Array.isArray(data.songs) ? data.songs : []).filter(s => offlineIds.has(s.id));
        } else {
            songs = Array.isArray(data.songs) ? data.songs : [];
            // Cache it for offline use!
            if (window.OfflineStore) {
                window.OfflineStore.savePlaylist(playlist, songs);
            }
        }

        await userPromise;
        if (seq !== _playlistRenderSeq || controller.signal.aborted) return;
        setPlaylistDetailName(playlist.name || 'Playlist');
        const lockIcon = document.getElementById('playlist-lock-icon');
        if (lockIcon) {
            if (playlist.is_private === 'private') {
                lockIcon.classList.remove('hidden');
            } else {
                lockIcon.classList.add('hidden');
            }
        }

        window.currentPlaylistOwner = playlist.owner;
        window.currentPlaylistIsPrivate = playlist.is_private;
        const durationStr = data.total_duration_formatted ? ` \u2022 ${data.total_duration_formatted}` : '';
        document.getElementById('playlist-detail-count').textContent = `${songs.length} song${songs.length !== 1 ? 's' : ''}${durationStr}`;

        // Handle Share Button
        const shareBtn = document.getElementById('share-playlist-btn');
        if (shareBtn) shareBtn.classList.toggle('hidden', !playlist.share_id);
        if (shareBtn && playlist.share_id) {
            const shareUrl = `${window.location.origin}/home?playlist=${playlist.share_id}`;
            shareBtn.onclick = (e) => {
                e.stopPropagation();
                window.copyToClipboard(shareUrl).then((ok) => {
                    if (!ok) {
                        showToast('Could not copy link. Long-press to copy it manually.', 'error');
                        return;
                    }
                    showToast('Share link copied to clipboard!', 'success');
                    const originalText = shareBtn.innerHTML;
                    shareBtn.innerHTML = "<i class='bx bx-check'></i> Copied!";
                    setTimeout(() => shareBtn.innerHTML = originalText, 2000);
                });
            };
        }

        const bioEl = document.getElementById('playlist-detail-bio');
        if (playlist.bio) {
            bioEl.textContent = playlist.bio;
            bioEl.style.display = 'block';
        } else {
            bioEl.textContent = '';
            bioEl.style.display = 'none';
        }

        const coverEl = document.getElementById('playlist-detail-cover');
        coverEl.dataset.playlistId = canonicalPlaylistId;
        const playlistCoverUrl = safeImageURL(playlist.cover_url);
        if (playlistCoverUrl) {
            coverEl.style.backgroundImage = `url(${JSON.stringify(playlistCoverUrl)})`;
            const icon = coverEl.querySelector('.bx-music');
            if (icon) icon.style.display = 'none';
        } else {
            coverEl.style.backgroundImage = 'linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(168, 85, 247, 0.3))';
            const icon = coverEl.querySelector('.bx-music');
            if (icon) icon.style.display = 'block';
        }

        // Made by label
        const ownerEl = document.getElementById('playlist-detail-owner');
        if (ownerEl) {
            ownerEl.textContent = `Made by ${playlist.original_owner || playlist.owner}`;
        }

        // Action buttons visibility
        const currentUsername = appCache.user && appCache.user.username ? appCache.user.username : null;
        const isOwner = currentUsername && currentUsername === playlist.owner;
        const manageBtn = document.getElementById('manage-playlist-btn');
        const renameBtn = document.getElementById('rename-playlist-btn');
        const deleteBtn = document.getElementById('delete-playlist-btn');
        const cloneBtn = document.getElementById('clone-playlist-btn');
        const downloadBtn = document.getElementById('download-playlist-btn');

        if (manageBtn) manageBtn.classList.toggle('hidden', !isOwner);
        if (renameBtn) renameBtn.classList.toggle('hidden', !isOwner);
        if (deleteBtn) deleteBtn.classList.toggle('hidden', !isOwner);
        if (downloadBtn) downloadBtn.classList.toggle('hidden', !isOwner);
        if (cloneBtn) {
            cloneBtn.classList.toggle('hidden', isOwner);
            if (!isOwner) {
                cloneBtn.onclick = () => clonePlaylist(playlist.share_id);
            }
        }

        const overlay = coverEl.querySelector('.cover-overlay');
        console.log("Checking Playlist Ownership - Current User:", currentUsername, "Playlist Owner:", playlist.owner);
        if (isOwner) {
            coverEl.classList.add('editable');
            if (overlay) overlay.classList.remove('hidden');
        } else {
            coverEl.classList.remove('editable');
            if (overlay) overlay.classList.add('hidden');
        }

        list.innerHTML = '';
        if (header) list.appendChild(header);

        if (songs.length === 0) {
            const emptyMsg = document.createElement('p');
            emptyMsg.style.cssText = 'color: var(--text-secondary); padding: 20px; text-align: center;';
            emptyMsg.textContent = 'This playlist is empty. Add songs from the library.';
            list.appendChild(emptyMsg);
            return;
        }

        currentPlaylist = songs.map(s => ({
            id: s.id,
            title: s.name || s.songname || s.title || s,
            artist: s.artist || 'Unknown Artist',
            album: s.album || 'Single',
            cover: s.cover,
            uploaded_by: s.uploaded_by || 'Unknown',
            duration: s.duration,
            bitrate: s.bitrate,
            extension: s.extension,
            url: `/api/play/${s.id}`,
            playlistOwner: playlist.owner
        }));
        const downloadedIdsPromise = getDownloadedSongIdSet();
        shuffledPlaylist = buildPlaylistOrder(currentPlaylist.length);

        currentPlaylist.forEach((song, index) => {
            const cover = safeImageURL(song.cover, COVER_PLACEHOLDER);
            const title = escapeHTML(song.title);
            const artist = escapeHTML(song.artist);
            const album = escapeHTML(song.album);
            const uploadedBy = escapeHTML(song.uploaded_by);
            const duration = escapeHTML(song.duration || '--:--');

            const row = document.createElement('div');
            row.className = 'song-row';
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-label', `Play ${song.title} by ${song.artist}`);
            if (isPlaylistEditMode) row.classList.add('edit-mode');
            if (selectedPlaylistSongIds.has(song.id)) row.classList.add('selected');
            row.dataset.id = song.id;
            row.innerHTML = `
                <div class="index-cell">
                    <div class="select-indicator"></div>
                    <span class="row-index-number">${index + 1}</span>
                </div>
                <div class="song-info">
                    <img alt="cover" class="song-cover-img" loading="lazy" decoding="async">
                    <div>
                        <div class="song-title-row">${title}</div>
                        <div style="font-size: 12px;">${artist}</div>
                    </div>
                </div>
                <span>${album}</span>
                <span>${uploadedBy}</span>
                <span>${duration}</span>
                <div class="edit-btn-container song-row-actions">
                    <button type="button" class="row-download-btn" aria-label="Download ${title}"><i class='bx bx-download'></i></button>
                    <button type="button" class="playlist-remove-song-btn row-edit-btn" title="Remove from playlist" aria-label="Remove ${title} from playlist">
                        <i class='bx bx-x'></i>
                    </button>
                </div>`;

            const image = row.querySelector('.song-cover-img');
            if (image) image.src = cover;
            const downloadButton = row.querySelector('.row-download-btn');
            if (downloadButton) {
                downloadButton.addEventListener('click', event => {
                    event.stopPropagation();
                    triggerDownload(song.id, downloadButton);
                });
            }

            // Async offline check for individual song
            if (window.OfflineStore) {
                downloadedIdsPromise.then(downloadedIds => {
                    if (downloadedIds.has(String(song.id)) && row.isConnected) {
                        const btn = row.querySelector('.row-download-btn i');
                        if (btn) {
                            btn.className = 'bx bxs-check-circle';
                            btn.parentElement.classList.add('downloaded');
                            btn.parentElement.style.color = '#4CAF50';
                        }
                    }
                });
            }

            row.querySelector('.playlist-remove-song-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                removeSongFromPlaylist(canonicalPlaylistId, song.id).then(res => {
                    if (window.currentPlaylistId !== canonicalPlaylistId || window.currentActiveView !== 'playlist') return;
                    if (res.success) {
                        row.classList.add('deleting-anim');
                        setTimeout(() => {
                            if (window.currentPlaylistId === canonicalPlaylistId && window.currentActiveView === 'playlist') {
                                renderPlaylistDetail(canonicalPlaylistId);
                            }
                        }, 400);
                    } else {
                        showToast(res.error || 'Failed to remove song', 'error');
                    }
                });
            });

            row.addEventListener('click', (e) => {
                if (e.target.closest('.playlist-remove-song-btn')) return;
                if (isPlaylistEditMode) {
                    togglePlaylistSongSelection(song.id, row);
                } else {
                    playSongAtIndex(index);
                }
            });
            row.addEventListener('keydown', event => {
                if ((event.key !== 'Enter' && event.key !== ' ') || event.target.closest('button')) return;
                event.preventDefault();
                if (isPlaylistEditMode) togglePlaylistSongSelection(song.id, row);
                else playSongAtIndex(index);
            });

            list.appendChild(row);
        });

        // Re-apply playing indicator after render
        highlightCurrentSong(list);
    } catch (err) {
        if (err.name === 'AbortError' || seq !== _playlistRenderSeq) return;
        window.currentPlaylistId = null;
        window.currentPlaylistOwner = null;
        window.currentPlaylistIsPrivate = null;
        currentPlaylist = [];
        shuffledPlaylist = [];
        setPlaylistDetailName('Offline or Unavailable');
        document.getElementById('playlist-detail-count').textContent = 'Failed to load playlist.';
        console.error('[RENDER PLAYLIST DETAIL]', err);
    } finally {
        if (_playlistRenderAbort === controller) _playlistRenderAbort = null;
    }
}

function togglePlaylistEditMode() {
    isPlaylistEditMode = !isPlaylistEditMode;
    const btn = document.getElementById('manage-playlist-btn');
    const bar = document.getElementById('playlist-batch-bar');

    if (isPlaylistEditMode) {
        btn.classList.add('active');
        btn.innerHTML = "<i class='bx bx-check'></i>";
        bar.classList.remove('hidden');
    } else {
        clearPlaylistSelection();
        btn.classList.remove('active');
        btn.innerHTML = "<i class='bx bx-pencil'></i>";
        bar.classList.add('hidden');
    }

    // Toggle edit-mode class on existing rows instead of full re-render
    document.querySelectorAll('#playlist-songs-list .song-row').forEach(row => {
        row.classList.toggle('edit-mode', isPlaylistEditMode);
    });
}

function togglePlaylistSongSelection(id, row) {
    if (selectedPlaylistSongIds.has(id)) {
        selectedPlaylistSongIds.delete(id);
        row.classList.remove('selected');
    } else {
        selectedPlaylistSongIds.add(id);
        row.classList.add('selected');
    }
    updatePlaylistSelectedCount();
}

function clearPlaylistSelection() {
    selectedPlaylistSongIds.clear();
    updatePlaylistSelectedCount();
    document.querySelectorAll('#playlist-songs-list .song-row.selected').forEach(r => r.classList.remove('selected'));
}

function updatePlaylistSelectedCount() {
    const el = document.getElementById('playlist-selected-count');
    if (el) el.textContent = selectedPlaylistSongIds.size;
}

async function removeSelectedPlaylistSongs() {
    if (selectedPlaylistSongIds.size === 0) return;
    const playlistId = Number(window.currentPlaylistId);
    if (!Number.isSafeInteger(playlistId) || playlistId <= 0) return;

    const ids = Array.from(selectedPlaylistSongIds);
    const results = await Promise.allSettled(ids.map(songId => removeSongFromPlaylist(playlistId, songId)));
    const failed = results.filter(result => result.status === 'rejected' || !result.value || !result.value.success).length;
    if (window.currentPlaylistId !== playlistId) return;

    selectedPlaylistSongIds.clear();
    isPlaylistEditMode = false;
    const bar = document.getElementById('playlist-batch-bar');
    if (bar) bar.classList.add('hidden');
    const btn = document.getElementById('manage-playlist-btn');
    if (btn) { btn.classList.remove('active'); btn.innerHTML = "<i class='bx bx-pencil'></i> Edit songs"; }
    if (failed) showToast(`Could not remove ${failed} of ${ids.length} songs.`, 'error');
    renderPlaylistDetail(playlistId);
    fetchPlaylists(true);
}

function showAddToPlaylistModal(songIdOrIds) {
    const modal = document.getElementById('add-to-playlist-modal');
    const list = document.getElementById('add-to-playlist-list');
    if (!modal || !list) return;

    const songIds = Array.isArray(songIdOrIds) ? songIdOrIds : [songIdOrIds];
    const isBulk = songIds.length > 1;

    list.innerHTML = '<p style="color:#b3b3b3; padding:15px; text-align:center;">Loading...</p>';
    modal.classList.remove('hidden');

    const titleEl = modal.querySelector('h3');
    if (titleEl) titleEl.textContent = isBulk ? `Add ${songIds.length} Songs to Playlist` : 'Add to Playlist';

    fetch(window.API_BASE_URL + '/api/playlists', { credentials: 'include' })
        .then(r => r.json())
        .then(playlists => {
            list.innerHTML = '';
            if (playlists.length === 0) {
                list.innerHTML = '<p style="color: var(--text-secondary); padding: 15px; text-align: center;">No playlists yet. Create one first!</p>';
                return;
            }
            playlists.forEach(p => {
                const item = document.createElement('button');
                item.className = 'add-to-playlist-item';
                item.innerHTML = `<i class='bx bx-list-ul'></i><span>${escapeHTML(p.name)}</span><span class="add-to-playlist-count">${p.song_count || 0}</span>`;
                item.addEventListener('click', async () => {
                    item.disabled = true;
                    item.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i><span>${escapeHTML(p.name)}</span>`;

                    const results = await Promise.allSettled(songIds.map(sid => addSongToPlaylist(p.id, sid)));
                    const added = results.filter(result => result.status === 'fulfilled' && result.value && result.value.success).length;
                    const failed = results.length - added;
                    const songCount = Number(p.song_count) || 0;

                    if (added > 0) {
                        item.innerHTML = `<i class='bx bx-check' style="color: var(--accent);"></i><span>${escapeHTML(p.name)}</span><span class="add-to-playlist-count">${songCount + added}</span>`;
                        if (isBulk) clearLibrarySelection();
                        setTimeout(() => modal.classList.add('hidden'), failed ? 1500 : 800);
                    } else {
                        item.innerHTML = `<i class='bx bx-list-ul'></i><span>${escapeHTML(p.name)}</span><span class="add-to-playlist-count">${songCount}</span>`;
                        item.disabled = false;
                    }
                    if (failed) showToast(`Could not add ${failed} of ${songIds.length} songs.`, 'error');
                    fetchPlaylists(true);
                });
                list.appendChild(item);
            });
        })
        .catch(err => {
            console.error('[ADD TO PLAYLIST]', err);
            list.innerHTML = '<p style="color:#f87171; padding:15px; text-align:center;">Could not load playlists.</p>';
        });
}

window.fetchPlaylists = fetchPlaylists;
window.renderPlaylistDetail = renderPlaylistDetail;
window.showAddToPlaylistModal = showAddToPlaylistModal;
window.togglePlaylistEditMode = togglePlaylistEditMode;
window.removeSelectedPlaylistSongs = removeSelectedPlaylistSongs;

// togglePostMenu is defined earlier (line ~1070); CSS handles positioning via
// position:absolute + top:100% + right:0 inside the .post-menu-wrap container.

function toggleSongMenu(id) {
    const menu = document.getElementById(`song-menu-${id}`);
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    document.querySelectorAll('.post-context-menu').forEach(m => { m.classList.add('hidden'); m.style.left = ''; m.style.top = ''; });
    if (isHidden) {
        // Find the button from the song row, not the menu's current parent
        const songRow = document.querySelector(`.song-row[data-id="${id}"]`);
        const btn = songRow ? songRow.querySelector('.row-menu-btn') : null;
        // Move menu to body so position:fixed isn't trapped by parent transforms
        if (menu.parentElement !== document.body) {
            document.body.appendChild(menu);
        }
        if (btn) {
            const rect = btn.getBoundingClientRect();
            let left = rect.right - 180;
            let top = rect.bottom + 4;
            if (left < 8) left = 8;
            if (top + 150 > window.innerHeight) top = rect.top - 150;
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        }
        menu.classList.remove('hidden');
    }
}


function deleteSong(id) {
    fetch(window.API_BASE_URL + `/api/songs/${id}`, {
        method: 'DELETE',
        credentials: 'include'
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                if (window.currentActiveView === 'library') fetchLibrary(true);
                else if (window.currentActiveView === 'home') fetchTrending(true);
                else if (window.currentActiveView === 'people') {
                    if (typeof fetchPeople === 'function') fetchPeople(true);
                    const profileModal = document.getElementById('profile-modal');
                    if (profileModal) profileModal.classList.add('hidden');
                }
            } else {
                showToast(data.error || "Failed to delete song", 'error');
            }
        });
}

function fetchSessions() {
    return fetch(window.API_BASE_URL + '/api/user/sessions', {
        credentials: 'include'
    }).then(r => r.json());
}

function revokeSession(sessionId) {
    return fetch(window.API_BASE_URL + `/api/user/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include'
    }).then(r => r.json());
}
// Attach globally if needed for other pages
window.createPostElement = createPostElement;
window.handleLikeClick = handleLikeClick;
window.toggleComments = toggleComments;
window.submitComment = submitComment;
window.togglePostMenu = togglePostMenu;
window.deletePost = deletePost;
window.copyPostLink = copyPostLink;
// window.getGlobalData = getGlobalData; // Removed: not defined in this scope

/* ===================================================
 * SPA PROFILE DETAIL FUNCTIONS
 * =================================================== */

let _profileRenderSeq = 0;

async function fetchDetailedProfile(username) {
    const section = document.getElementById('profile-detail-section');
    if (!section) return;

    const seq = ++_profileRenderSeq;
    window.profileContextUser = username;

    // Clear old profile content immediately to prevent stale data flash
    const nameEl = document.getElementById('profile-name');
    const handleEl = document.getElementById('profile-handle');
    const bioEl = document.getElementById('profile-bio');
    const avatarEl = document.getElementById('profile-avatar');
    const bannerEl = document.getElementById('profile-banner');
    if (nameEl) nameEl.textContent = 'Loading...';
    if (handleEl) handleEl.textContent = '';
    if (bioEl) bioEl.textContent = '';
    if (avatarEl) { avatarEl.innerHTML = ''; avatarEl.style.backgroundImage = 'linear-gradient(45deg, var(--gradient-1), var(--gradient-2))'; }
    if (bannerEl) { bannerEl.style.background = ''; bannerEl.style.backgroundImage = 'none'; }
    const backdropEl = document.getElementById('profile-banner-backdrop');
    if (backdropEl) backdropEl.style.backgroundImage = 'none';

    const postsContainer = document.getElementById('profile-posts-container');
    if (postsContainer) postsContainer.innerHTML = '';
    const playlistsContainer = document.getElementById('profile-playlists-container');
    if (playlistsContainer) playlistsContainer.innerHTML = '';

    try {
        const response = await fetch(`/api/profile/${encodeURIComponent(username)}`);
        if (!response.ok) throw new Error("Profile not found");
        const data = await response.json();
        // Discard if a newer profile render was triggered
        if (seq !== _profileRenderSeq) return;
        renderDetailedProfile(data, seq);
    } catch (err) {
        if (seq !== _profileRenderSeq) return;
        console.error("Fetch Profile Error:", err);
        showToast("Failed to load profile.", 'error');
        if (typeof showSection === 'function') {
            // Fallback to home if profile fails
            const libraryLink = document.getElementById('library-link');
            if (libraryLink) libraryLink.click();
        }
    }
}

function renderDetailedProfile(data, seq = _profileRenderSeq) {
    if (seq !== _profileRenderSeq) return;
    const user = data.user || data;
    document.title = `Streamify | ${user.display_name || user.username}'s Profile`;

    const nameEl = document.getElementById('profile-name');
    const handleEl = document.getElementById('profile-handle');
    const bioEl = document.getElementById('profile-bio');
    const avatarEl = document.getElementById('profile-avatar');
    const bannerEl = document.getElementById('profile-banner');

    if (nameEl) nameEl.textContent = user.display_name || user.username;
    if (handleEl) handleEl.textContent = `@${user.username}`;
    if (bioEl) bioEl.textContent = user.bio || "No bio yet.";

    const avatarUrl = safeImageURL(user.avatar);
    if (avatarUrl) {
        avatarEl.textContent = '';
        const image = document.createElement('img');
        image.src = avatarUrl;
        image.alt = 'avatar';
        image.style.cssText = 'width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%;';
        avatarEl.appendChild(image);
    } else {
        avatarEl.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
        avatarEl.style.backgroundImage = 'linear-gradient(135deg, var(--gradient-1), var(--gradient-2))';
        avatarEl.style.backgroundSize = '';
        avatarEl.style.backgroundPosition = '';
    }

    const safeBannerUrl = safeImageURL(user.banner);
    if (safeBannerUrl) {
        bannerEl.style.backgroundImage = `url(${JSON.stringify(safeBannerUrl)})`;
        bannerEl.style.backgroundSize = 'cover';
        bannerEl.style.backgroundPosition = 'center';
        bannerEl.style.backgroundRepeat = 'no-repeat';

        const backdropEl = document.getElementById('profile-banner-backdrop');
        if (backdropEl) {
            backdropEl.style.backgroundImage = `url(${JSON.stringify(safeBannerUrl)})`;
            backdropEl.style.backgroundSize = 'cover';
            backdropEl.style.backgroundPosition = 'center';
        }
        const img = new Image();
        img.onload = () => {
            if (seq !== _profileRenderSeq) return;
            const mainContent = window.getAppScrollContainer();
            if (mainContent) mainContent.scrollTop = 0;
            window.scrollTo(0, 0);
        };
        img.src = safeBannerUrl;
    } else {
        bannerEl.style.backgroundImage = 'none';
        const backdropEl = document.getElementById('profile-banner-backdrop');
        if (backdropEl) backdropEl.style.backgroundImage = 'none';
    }

    // Reset edit buttons
    const editBannerBtn = document.getElementById('edit-banner-btn');
    const editAvatarBtn = document.getElementById('edit-avatar-btn');
    if (editBannerBtn) editBannerBtn.classList.add('hidden');
    if (editAvatarBtn) editAvatarBtn.classList.add('hidden');

    // Check ownership case-insensitively
    if (appCache.user && appCache.user.username && user.username && appCache.user.username.toLowerCase() === user.username.toLowerCase()) {
        if (editBannerBtn) editBannerBtn.classList.remove('hidden');
        if (editAvatarBtn) editAvatarBtn.classList.remove('hidden');
        setupProfileUploadHandlers();
    }

    // Force top after rendering all content; double rAF ensures layout settles
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const mainContent = window.getAppScrollContainer();
            if (mainContent) mainContent.scrollTop = 0;
            window.scrollTo(0, 0);
        });
    });
}

function setupProfileUploadHandlers() {
    const bannerBtn = document.getElementById('edit-banner-btn');
    const avatarBtn = document.getElementById('edit-avatar-btn');
    const bannerInput = document.getElementById('banner-upload-input');
    const avatarInput = document.getElementById('avatar-upload');

    bannerBtn.onclick = (e) => { e.stopPropagation(); bannerInput.click(); };
    avatarBtn.onclick = (e) => { e.stopPropagation(); avatarInput.click(); };

    // New onchange for banner specifically
    bannerInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            handleProfilePhotoUpload(file, 'banner');
            // Reset value so same file can be selected again if crop was canceled/failed
            bannerInput.value = '';
        }
    };

    // Note: avatar-upload is already handled by ui.js, 
    // but for the profile detail page, we might need to override it or share it.
}

function handleProfilePhotoUpload(file, type) {
    if (!file || typeof window.openProfileCropper !== 'function') return;
    window.openProfileCropper(file, type);
}

async function uploadProfileFile(file, type) {
    const formData = new FormData();
    const endpoint = type === 'banner' ? '/api/upload-banner' : '/api/upload-avatar';
    const fieldName = type === 'banner' ? 'banner_file' : 'avatar_file';

    formData.append(fieldName, file);

    try {
        const res = await fetch(window.API_BASE_URL + endpoint, {
            method: 'POST',
            body: formData,
            credentials: 'include'
        });
        const result = await res.json();
        if (result.success) {
            if (typeof showToast === 'function') showToast(`${type === 'banner' ? 'Banner' : 'Avatar'} updated!`, 'success');
            const targetUser = window.profileContextUser || (appCache.user && appCache.user.username);
            if (targetUser && typeof fetchDetailedProfile === 'function') {
                fetchDetailedProfile(targetUser);
            }
        } else {
            if (typeof showToast === 'function') showToast(result.error || "Upload failed", 'error');
        }
    } catch (e) {
        console.error("Upload Error:", e);
        showToast("Upload failed", 'error');
    }
}

window.fetchDetailedProfile = fetchDetailedProfile;

async function fetchSinglePost(postId) {
    const res = await fetch(`${window.API_BASE_URL}/api/posts/${postId}`, { credentials: 'include' });
    return res.json();
}

/**
 * NAVIGATE TO POST
 * Focused Detail View logic
 */
async function navigateToPost(postId) {
    const container = document.getElementById('single-post-container');
    const detailSection = document.getElementById('post-detail-section');
    if (!container || !detailSection) return;

    // Save scroll position and track current view
    const mainContent = window.getAppScrollContainer();
    if (mainContent && window.currentActiveView !== 'post') {
        window.savedScrollPosition = mainContent.scrollTop;
    }
    window.currentActiveView = 'post';
    window.currentPostId = postId;

    // Update Section Visibility
    if (typeof window.hideAllSections === 'function') {
        window.hideAllSections();
    } else {
        detailSection.parentElement.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    }
    detailSection.classList.remove('hidden');
    container.innerHTML = '<p class="loading-text" style="text-align:center; padding:40px; color:#b3b3b3;">Loading post...</p>';

    // Update Document Title and URL
    document.title = "Streamify | Post View";
    if (window.location.hash !== `#post-${postId}`) {
        history.pushState({ view: 'post', id: postId }, '', `/home#post-${postId}`);
    }

    try {
        const post = await fetchSinglePost(postId);
        if (post.error) {
            container.innerHTML = `<p style="color:red; text-align:center; padding:20px;">${post.error}</p>`;
            return;
        }

        // Render the post card
        container.innerHTML = '';
        const postEl = createPostElement(post);

        // Remove the click handler on the card itself to avoid recursion if clicked again
        // (profile/avatar clicks are handled by inline onclick with stopPropagation)
        postEl.onclick = null;

        container.appendChild(postEl);

        // Auto-expand comments in detail view
        const commentsSec = postEl.querySelector('.comments-section');
        const commentsList = postEl.querySelector('.comments-list');
        if (commentsSec && commentsList) {
            commentsSec.classList.remove('hidden');
            fetchComments(post.id, false, commentsList);
        }

        // Scroll to top of the detail view
        window.getAppScrollContainer()?.scrollTo({ top: 0, behavior: 'smooth' });

    } catch (err) {
        console.error('[DETAIL VIEW]', err);
        container.innerHTML = '<p style="color:red; text-align:center;">Failed to load post details.</p>';
    }
}

// Global context for "Back" button logic
function setupPostDetailHandlers() {
    const backBtn = document.getElementById('back-to-feed-btn');
    if (backBtn) {
        backBtn.onclick = () => {
            // Clear hash
            if (window.location.hash) {
                history.pushState({ view: 'home' }, '', '/home');
            }

            const lastView = window.currentActiveView || 'home';
            if (lastView === 'profile' && window.profileContextUser) {
                navigateToProfile(window.profileContextUser);
            } else if (lastView === 'people') {
                document.getElementById('people-link').click();
            } else {
                document.getElementById('home-link').click();
            }
        };
    }

    const backFromProfileBtn = document.getElementById('back-from-profile-btn');
    if (backFromProfileBtn) {
        backFromProfileBtn.onclick = () => {
            if (window.location.hash && window.location.hash.startsWith('#user-')) {
                history.pushState({ view: 'home' }, '', '/home');
            }

            const libraryLink = document.getElementById('library-link');
            const lastView = window.lastViewBeforeProfile || 'library';

            if (lastView === 'search') {
                const searchSection = document.getElementById('search-section');
                if (searchSection) {
                    if (typeof window.hideAllSections === 'function') window.hideAllSections();
                    if (typeof window.showSection === 'function') window.showSection(searchSection);
                    window.currentActiveView = 'search';
                    document.title = "Streamify | Search";
                    return;
                }
            }

            if (libraryLink) {
                libraryLink.click();
            } else if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.href = '/home';
            }
        };
    }
}

// Run on load
document.addEventListener('DOMContentLoaded', setupPostDetailHandlers);
window.navigateToPost = navigateToPost;

/* ============================================================
 * DM (Direct Messages)
 * ============================================================ */

let activeDmConversation = null;
let dmTypingTimeout = null;

function fetchDmUnreadCount() {
    fetch(`${window.API_BASE_URL}/api/dm/unread-count`, { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
            const badge = document.getElementById('dm-badge');
            const reqBadge = document.getElementById('dm-req-badge');
            appCache.dmUnreadCount = data.count || 0;
            if (badge) badge.classList.toggle('hidden', appCache.dmUnreadCount === 0);
        })
        .catch(() => { });
}

function fetchDmContacts() {
    const now = Date.now();
    if (appCache.dmContacts && (now - appCache.dmContactsTime < CACHE_DURATION)) {
        renderDmContacts(appCache.dmContacts);
        return;
    }
    fetch(`${window.API_BASE_URL}/api/dm/contacts`, { credentials: 'include' })
        .then(r => r.json())
        .then(contacts => {
            appCache.dmContacts = contacts;
            appCache.dmContactsTime = Date.now();
            renderDmContacts(contacts);
        })
        .catch(() => { });
}

function renderDmContacts(contacts) {
    const list = document.getElementById('dm-contacts-list');
    if (!list) return;

    if (!contacts || contacts.length === 0) {
        list.innerHTML = '<p style="color: var(--text-secondary); padding: 20px; text-align: center; font-size: 13px;">No conversations yet</p>';
        return;
    }

    list.innerHTML = contacts.map(c => {
        const initial = (c.other_display_name || c.other_username).charAt(0).toUpperCase();
        const avatarHtml = c.other_avatar
            ? `<img src="${escapeHTML(c.other_avatar)}" alt="">`
            : initial;
        const preview = c.last_message ? escapeHTML(c.last_message).substring(0, 40) + (c.last_message.length > 40 ? '...' : '') : '';
        const timeStr = c.last_message_time ? timeAgo(c.last_message_time) : '';
        const activeClass = activeDmConversation === c.id ? ' active' : '';

        return `<div class="dm-contact-item${activeClass}" data-conversation-id="${c.id}" data-username="${escapeHTML(c.other_username)}" data-display-name="${escapeHTML(c.other_display_name)}" data-avatar="${escapeHTML(c.other_avatar || '')}">
            <div class="dm-contact-avatar">${avatarHtml}</div>
            <div class="dm-contact-info">
                <span class="dm-contact-name">${escapeHTML(c.other_display_name)}</span>
                <span class="dm-contact-preview">${preview}</span>
            </div>
            <div class="dm-contact-meta">
                ${timeStr ? `<span class="dm-contact-time">${timeStr}</span>` : ''}
                ${c.unread_count > 0 ? `<span class="dm-contact-unread">${c.unread_count}</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

function openDmConversation(conversationId, username, displayName, avatar) {
    activeDmConversation = conversationId;

    // Update UI
    const chatEmpty = document.getElementById('dm-chat-empty');
    const chatActive = document.getElementById('dm-chat-active');
    const dmSection = document.getElementById('dm-section');
    if (chatEmpty) chatEmpty.classList.add('hidden');
    if (chatActive) chatActive.classList.remove('hidden');
    if (dmSection) dmSection.classList.add('dm-chat-open');

    // Set header
    const userInfo = document.getElementById('dm-chat-user-info');
    const initial = (displayName || username).charAt(0).toUpperCase();
    const avatarHtml = avatar
        ? `<img src="${escapeHTML(avatar)}" alt="">`
        : initial;
    if (userInfo) {
        userInfo.innerHTML = `
            <div class="dm-chat-user-avatar">${avatarHtml}</div>
            <span class="dm-chat-user-name">${escapeHTML(displayName || username)}</span>
        `;
    }

    // Highlight active contact
    document.querySelectorAll('.dm-contact-item').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.conversationId) === conversationId);
    });

    // Hide load-more until we know there are older messages
    const loadMoreBtn = document.getElementById('dm-messages')?.querySelector('.dm-load-more');
    if (loadMoreBtn) loadMoreBtn.classList.add('hidden');

    // Fetch messages
    fetchDmMessages(conversationId);

    // Focus input
    const input = document.getElementById('dm-message-input');
    if (input) input.focus();
}

let dmMessagesOffset = 0;
const dmMessagesLimit = 30;
let dmMessagesHasMore = false;

function fetchDmMessages(conversationId, append = false) {
    const container = document.getElementById('dm-messages');
    if (!container) return;

    if (!append) {
        dmMessagesOffset = 0;
        dmMessagesHasMore = false;
        container.innerHTML = '<p class="loading-text" style="text-align:center;padding:20px;color:var(--text-secondary);">Loading...</p>';
    }

    const url = new URL(`${window.API_BASE_URL}/api/dm/conversation/${conversationId}/messages`, window.location.origin);
    url.searchParams.set('limit', dmMessagesLimit);
    url.searchParams.set('offset', dmMessagesOffset);

    fetch(url.toString(), { credentials: 'include' })
        .then(r => r.json())
        .then(messages => {
            // Server returns DESC (newest first), reverse for display (oldest first)
            const sorted = messages ? messages.reverse() : [];
            dmMessagesHasMore = messages && messages.length >= dmMessagesLimit;
            const loadMoreBtn = dmEnsureLoadMoreBtn();
            if (loadMoreBtn) loadMoreBtn.classList.toggle('hidden', !dmMessagesHasMore);

            if (append) {
                prependDmMessages(sorted);
            } else {
                renderDmMessages(sorted);
                fetchDmUnreadCount();
                const activeItem = document.querySelector(`.dm-contact-item[data-conversation-id="${conversationId}"]`);
                if (activeItem) {
                    const unreadEl = activeItem.querySelector('.dm-contact-unread');
                    if (unreadEl) unreadEl.remove();
                }
            }
            dmMessagesOffset += messages ? messages.length : 0;
        })
        .catch(() => {
            if (!append) container.innerHTML = '<p style="color:red;text-align:center;padding:20px;">Failed to load messages</p>';
        });
}

function prependDmMessages(messages) {
    const container = document.getElementById('dm-messages');
    if (!container || !messages || messages.length === 0) return;

    const prevHeight = container.scrollHeight;
    const fragment = document.createDocumentFragment();

    messages.forEach(m => {
        const isSent = m.sender_username === appCache.user?.username;
        const timeStr = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const bubble = document.createElement('div');
        bubble.className = `dm-message-bubble ${isSent ? 'sent' : 'received'}`;
        bubble.innerHTML = `${escapeHTML(m.body)}<div class="dm-message-time">${timeStr}</div>`;
        fragment.appendChild(bubble);
    });

    // Insert after the load-more button (first child), before existing messages
    const loadMoreBtn = container.querySelector('.dm-load-more');
    if (loadMoreBtn && loadMoreBtn.nextSibling) {
        container.insertBefore(fragment, loadMoreBtn.nextSibling);
    } else if (loadMoreBtn) {
        container.appendChild(fragment);
    } else {
        container.insertBefore(fragment, container.firstChild);
    }
    // Preserve scroll position after prepending
    container.scrollTop = container.scrollHeight - prevHeight;
}

function dmEnsureLoadMoreBtn() {
    const container = document.getElementById('dm-messages');
    if (!container) return null;
    let btn = container.querySelector('.dm-load-more');
    if (!btn) {
        btn = document.createElement('button');
        btn.className = 'dm-load-more hidden';
        btn.id = 'dm-load-more-btn';
        btn.innerHTML = '<i class=\'bx bx-arrow-to-top\'></i> <span>Load earlier</span>';
        btn.addEventListener('click', () => {
            if (typeof activeDmConversation !== 'undefined' && activeDmConversation) {
                fetchDmMessages(activeDmConversation, true);
            }
        });
        container.prepend(btn);
    }
    return btn;
}

function renderDmMessages(messages) {
    const container = document.getElementById('dm-messages');
    if (!container) return;

    // Preserve or create the load-more button
    let loadMoreBtn = container.querySelector('.dm-load-more');
    if (!loadMoreBtn) loadMoreBtn = null;

    if (!messages || messages.length === 0) {
        container.innerHTML = '';
        dmEnsureLoadMoreBtn();
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--text-secondary);text-align:center;padding:20px;';
        p.textContent = 'No messages yet. Say hello!';
        container.appendChild(p);
        return;
    }

    // Build message HTML into a fragment, then append after the load-more button
    const html = messages.map(m => {
        const isSent = m.sender_username === appCache.user?.username;
        const timeStr = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<div class="dm-message-bubble ${isSent ? 'sent' : 'received'}">
            ${escapeHTML(m.body)}
            <div class="dm-message-time">${timeStr}</div>
        </div>`;
    }).join('');

    // Keep the load-more button, replace everything else
    const btn = container.querySelector('.dm-load-more');
    if (btn) {
        // Remove everything except the button
        Array.from(container.children).forEach(child => {
            if (child !== btn) container.removeChild(child);
        });
        // Insert message HTML after the button
        btn.insertAdjacentHTML('afterend', html);
    } else {
        container.innerHTML = html;
        dmEnsureLoadMoreBtn();
    }

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function dmDisableInputTemporarily(ms) {
    const input = document.getElementById('dm-message-input');
    const sendBtn = document.getElementById('dm-send-btn');
    if (input) { input.disabled = true; input.placeholder = 'Slow down... wait a moment'; }
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.5'; }
    setTimeout(() => {
        if (input) { input.disabled = false; input.placeholder = 'Type a message...'; }
        if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ''; }
    }, ms);
}

function sendDmMessage() {
    const input = document.getElementById('dm-message-input');
    if (!input || !input.value.trim() || !activeDmConversation) return;

    const body = input.value.trim();
    input.value = '';

    // Optimistic: append immediately
    const tempMsg = {
        conversation_id: activeDmConversation,
        sender_username: appCache.user?.username,
        body: body,
        created_at: new Date().toISOString()
    };
    appendDmMessage(tempMsg);

    fetch(`${window.API_BASE_URL}/api/dm/conversation/${activeDmConversation}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
        credentials: 'include'
    })
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                showToast(data.error || 'Failed to send message', 'error');
                // Remove the optimistic bubble
                const container = document.getElementById('dm-messages');
                if (container && container.lastElementChild) container.lastElementChild.remove();
                // If rate limited (429), disable input temporarily
                if (data.error && (data.error.includes('Too') || data.error.includes('slow') || data.error.includes('fast'))) {
                    dmDisableInputTemporarily(60000);
                }
            } else {
                // Update contact preview in-place without full re-render
                const contactItem = document.querySelector(`.dm-contact-item[data-conversation-id="${activeDmConversation}"]`);
                if (contactItem) {
                    const previewEl = contactItem.querySelector('.dm-contact-preview');
                    if (previewEl) previewEl.textContent = body.substring(0, 40) + (body.length > 40 ? '...' : '');
                    const timeEl = contactItem.querySelector('.dm-contact-time');
                    if (timeEl) timeEl.textContent = 'now';
                    const list = document.getElementById('dm-contacts-list');
                    if (list && list.firstChild !== contactItem) list.prepend(contactItem);
                }
            }
        })
        .catch(() => {
            showToast('Failed to send message', 'error');
            const container = document.getElementById('dm-messages');
            if (container && container.lastElementChild) container.lastElementChild.remove();
        });
}

function appendDmMessage(msg) {
    const container = document.getElementById('dm-messages');
    if (!container) return;

    const isSent = msg.sender_username === appCache.user?.username;
    const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const bubble = document.createElement('div');
    bubble.className = `dm-message-bubble ${isSent ? 'sent' : 'received'} dm-bubble-pop`;
    bubble.innerHTML = `${escapeHTML(msg.body)}<div class="dm-message-time">${timeStr}</div>`;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
}

function sendDmRequest() {
    const input = document.getElementById('dm-new-username');
    if (!input) return;
    const toUsername = input.value.trim();
    if (!toUsername) { showToast('Please enter a username', 'warning'); return; }

    fetch(`${window.API_BASE_URL}/api/dm/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_username: toUsername }),
        credentials: 'include'
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Request sent!', 'success');
                input.value = '';
                document.getElementById('dm-new-modal')?.classList.add('hidden');
            } else {
                showToast(data.error || 'Failed to send request', 'error');
                if (data.error && (data.error.includes('Too') || data.error.includes('wait'))) {
                    const newSendBtn = document.getElementById('dm-new-send');
                    if (newSendBtn) { newSendBtn.disabled = true; newSendBtn.style.opacity = '0.5'; setTimeout(() => { newSendBtn.disabled = false; newSendBtn.style.opacity = ''; }, 60000); }
                }
            }
        })
        .catch(() => showToast('Failed to send request', 'error'));
}

let dmReqActiveTab = 'received';

function fetchDmRequests() {
    const list = document.getElementById('dm-requests-list');
    if (!list) return;
    list.innerHTML = '<p class="loading-text">Loading...</p>';

    if (dmReqActiveTab === 'received') {
        fetch(`${window.API_BASE_URL}/api/dm/requests`, { credentials: 'include' })
            .then(r => r.json())
            .then(requests => renderDmRequests(requests, 'received'))
            .catch(() => { list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">Failed to load</p>'; });
    } else {
        fetch(`${window.API_BASE_URL}/api/dm/requests/sent`, { credentials: 'include' })
            .then(r => r.json())
            .then(requests => renderDmRequests(requests, 'sent'))
            .catch(() => { list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">Failed to load</p>'; });
    }
}

function renderDmRequests(requests, type) {
    const list = document.getElementById('dm-requests-list');
    if (!list) return;

    if (type === 'received') {
        const reqBadge = document.getElementById('dm-req-badge');
        const pendingCount = requests ? requests.length : 0;
        if (reqBadge) reqBadge.classList.toggle('hidden', pendingCount === 0);

        if (!requests || requests.length === 0) {
            list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No pending requests</p>';
            return;
        }

        list.innerHTML = requests.map(r => {
            const initial = (r.from_username || 'U').charAt(0).toUpperCase();
            const avatarHtml = r.avatar
                ? `<img src="${escapeHTML(r.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
                : initial;
            return `<div class="dm-request-item">
                <div class="dm-contact-avatar">${avatarHtml}</div>
                <div class="dm-request-info">
                    <span class="dm-request-name">@${escapeHTML(r.from_username)}</span>
                    <span class="dm-request-time">${timeAgo(r.created_at)}</span>
                </div>
                <div class="dm-request-actions">
                    <button class="btn btn-outline" onclick="respondDmRequest(${r.id}, 'rejected')">Decline</button>
                    <button class="btn" onclick="respondDmRequest(${r.id}, 'accepted')">Accept</button>
                </div>
            </div>`;
        }).join('');
    } else {
        if (!requests || requests.length === 0) {
            list.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">No sent requests</p>';
            return;
        }

        list.innerHTML = requests.map(r => {
            const statusColor = r.status === 'accepted' ? 'var(--accent)' : r.status === 'rejected' ? '#ff4d4d' : 'var(--text-secondary)';
            const statusLabel = r.status.charAt(0).toUpperCase() + r.status.slice(1);
            const initial = (r.to_username || 'U').charAt(0).toUpperCase();
            const avatarHtml = r.avatar
                ? `<img src="${escapeHTML(r.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
                : initial;
            return `<div class="dm-request-item">
                <div class="dm-contact-avatar">${avatarHtml}</div>
                <div class="dm-request-info">
                    <span class="dm-request-name">@${escapeHTML(r.to_username)}</span>
                    <span class="dm-request-time">${timeAgo(r.created_at)}</span>
                </div>
                <span style="font-size:12px;font-weight:600;color:${statusColor};">${statusLabel}</span>
            </div>`;
        }).join('');
    }
}

function respondDmRequest(requestId, status) {
    fetch(`${window.API_BASE_URL}/api/dm/request/${requestId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        credentials: 'include'
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                fetchDmRequests(); // Refresh list
                if (status === 'accepted') {
                    appCache.dmContactsTime = 0; // Force refresh contacts
                    fetchDmContacts();
                }
            } else {
                showToast(data.error || 'Failed to respond', 'error');
            }
        })
        .catch(() => showToast('Failed to respond', 'error'));
}

function initDmSocketListeners() {
    if (typeof socket === 'undefined' || !socket) return;

    socket.on('dm_request', () => {
        fetchDmUnreadCount();
        fetchDmRequests();
    });

    socket.on('dm_request_responded', (data) => {
        if (data.status === 'accepted') {
            appCache.dmContactsTime = 0;
            fetchDmContacts();
        }
    });

    socket.on('dm_message', (msg) => {
        if (parseInt(activeDmConversation) === parseInt(msg.conversation_id)) {
            appendDmMessage(msg);
            fetch(`${window.API_BASE_URL}/api/dm/conversation/${msg.conversation_id}/messages`, { credentials: 'include' })
                .then(r => r.json())
                .then(() => fetchDmUnreadCount())
                .catch(() => { });
        } else {
            fetchDmUnreadCount();
        }
        // Smart contact update: just move/reorder the contact item without full re-render
        const contactItem = document.querySelector(`.dm-contact-item[data-conversation-id="${msg.conversation_id}"]`);
        if (contactItem) {
            const previewEl = contactItem.querySelector('.dm-contact-preview');
            if (previewEl) previewEl.textContent = msg.body.substring(0, 40) + (msg.body.length > 40 ? '...' : '');
            const timeEl = contactItem.querySelector('.dm-contact-time');
            if (timeEl) timeEl.textContent = 'now';
            // Move to top of the list
            const list = document.getElementById('dm-contacts-list');
            if (list && list.firstChild !== contactItem) {
                contactItem.style.animation = 'none';
                contactItem.offsetHeight;
                list.prepend(contactItem);
                contactItem.style.animation = 'dmContactBump 0.3s cubic-bezier(0.2, 0.8, 0.2, 1) forwards';
            }
            // Update unread count badge if not the active conversation
            if (parseInt(activeDmConversation) !== parseInt(msg.conversation_id)) {
                const unreadEl = contactItem.querySelector('.dm-contact-unread');
                if (unreadEl) {
                    unreadEl.textContent = parseInt(unreadEl.textContent || '0') + 1;
                } else {
                    const metaEl = contactItem.querySelector('.dm-contact-meta');
                    if (metaEl) {
                        const badge = document.createElement('span');
                        badge.className = 'dm-contact-unread';
                        badge.textContent = '1';
                        metaEl.appendChild(badge);
                    }
                }
            }
        } else {
            // New conversation; need full refresh
            appCache.dmContactsTime = 0;
            fetchDmContacts();
        }
    });

    socket.on('dm_typing', (data) => {
        if (data.conversation_id === activeDmConversation) {
            const indicator = document.getElementById('dm-typing-indicator');
            if (indicator) {
                indicator.textContent = `${data.username} is typing...`;
                indicator.classList.remove('hidden');
            }
        }
    });

    socket.on('dm_stop_typing', (data) => {
        if (data.conversation_id === activeDmConversation) {
            const indicator = document.getElementById('dm-typing-indicator');
            if (indicator) indicator.classList.add('hidden');
        }
    });
}

window.fetchDmUnreadCount = fetchDmUnreadCount;
window.fetchDmContacts = fetchDmContacts;
window.openDmConversation = openDmConversation;
window.sendDmMessage = sendDmMessage;
window.sendDmRequest = sendDmRequest;
window.fetchDmRequests = fetchDmRequests;
window.respondDmRequest = respondDmRequest;
window.initDmSocketListeners = initDmSocketListeners;

// Telemetry
async function reportTelemetry(songId, listenDuration, isPlay) {
    if (!songId || listenDuration <= 0) return;
    try {
        await fetch(window.API_BASE_URL + '/api/telemetry/listen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                song_id: songId,
                listen_duration: listenDuration,
                play_count_delta: isPlay ? 1 : 0
            })
        });
    } catch (e) {
        console.error("Telemetry report failed:", e);
    }
}
window.reportTelemetry = reportTelemetry;

async function setAnalyticsEnabled(enabled) {
    try {
        const res = await fetch(window.API_BASE_URL + '/api/settings/privacy/analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || "Failed to update settings");
        showToast("Privacy settings updated.", "success");
        return true;
    } catch (e) {
        console.error(e);
        showToast("Failed to update privacy settings.", "error");
        return false;
    }
}
window.setAnalyticsEnabled = setAnalyticsEnabled;

async function clonePlaylist(shareId) {
    if (!shareId) return;
    try {
        const res = await fetch(`${window.API_BASE_URL}/api/playlists/share/${shareId}/clone`, {
            method: 'POST',
            credentials: 'include'
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Added to library as "${data.name}"`, "success");
            // Refresh sidebar to show the new playlist (force refresh)
            fetchPlaylists(true);
            // Switch to the new playlist
            window.location.hash = `#playlist-${data.playlistId}`;
        } else {
            showToast(data.error || "Failed to clone playlist", "error");
        }
    } catch (e) {
        console.error("Clone failed:", e);
        showToast("Failed to clone playlist.", "error");
    }
}
window.clonePlaylist = clonePlaylist;

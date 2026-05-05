/**
 * ============================================================================
 * STREAMIFY — upload.js
 * ============================================================================
 * Handles song upload: form intercept, confirmation modal, XHR with progress.
 * Depends on: config.js
 * ============================================================================
 */

/* --- DOM references --- */
const uploadForm = document.getElementById('upload-form');
const fileInput = document.getElementById('song_file');
const confirmModal = document.getElementById('upload-confirmation-modal');
const confirmBtn = document.getElementById('confirm-upload-btn');
const cancelUploadBtn = document.getElementById('cancel-upload-btn');
const fileNameDisplay = document.getElementById('confirm-filename');
const fileSizeDisplay = document.getElementById('confirm-filesize');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressBar = document.getElementById('upload-progress-fill');
const uploadStatusText = document.getElementById('upload-status-text');

/* --- Spotify Import DOM references --- */
const spotifyForm = document.getElementById('spotify-import-form');
const spotifyUrlInput = document.getElementById('spotify-url-input');
const spotifyNameInput = document.getElementById('spotify-playlist-name');
const spotifyBtn = document.getElementById('spotify-import-btn');
const spotifyProgressContainer = document.getElementById('spotify-progress-container');
const spotifyProgressBar = document.getElementById('spotify-progress-bar');
const spotifyProgressText = document.getElementById('spotify-progress-text');
const spotifyProgressCount = document.getElementById('spotify-progress-count');
const spotifyProgressLog = document.getElementById('spotify-progress-log');
const spotifySkipBtn = document.getElementById('spotify-skip-btn');

let spotifyImportState = { total: 0, current: 0, currentSong: null };

const uploadPercentage = document.getElementById('upload-percentage');
const mainUploadBtn = document.getElementById('upload-submit-btn');

/* --- Helpers --- */
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

function escapeJS(str) {
    if (!str) return "";
    return str.replace(/'/g, "\\'");
}

window.skipSoulseek = (songName, btn) => {
    const targetSong = songName || spotifyImportState.currentSong;
    if (!targetSong) return;

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Skipping...";
        btn.style.opacity = '0.5';
    } else if (spotifySkipBtn) {
        spotifySkipBtn.disabled = true;
        spotifySkipBtn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Skipping...";
    }
    if (typeof socket !== 'undefined' && socket) {
        socket.emit('skip_soulseek', { song: targetSong });
    }
};

window.skipAllSoulseek = () => {
    if (confirm("Skip Soulseek for all remaining tracks in this import?")) {
        if (typeof socket !== 'undefined' && socket) {
            socket.emit('skip_all_soulseek');
        }
    }
};

window.stopImport = () => {
    if (confirm("Are you sure you want to cancel the entire import?")) {
        if (typeof socket !== 'undefined' && socket) {
            socket.emit('stop_import');
            spotifyProgressText.textContent = "Import Cancelled";
            spotifyProgressText.style.color = "#e74c3c";
            // Hide controls
            const controls = document.getElementById('spotify-global-controls');
            if (controls) controls.classList.add('hidden');
        }
    }
};

function resetUploadUI() {
    mainUploadBtn.disabled = false;
    mainUploadBtn.textContent = 'Upload';
    mainUploadBtn.classList.remove('button-appear');

    const nameEl = document.getElementById('file-name');
    nameEl.textContent = 'No files chosen...';
    nameEl.classList.remove('active');

    uploadProgressContainer.style.display = 'none';
    uploadProgressBar.style.width = '0%';

    if (fileInput) fileInput.value = '';
}

function handleFileUpload(input) {
    const nameEl = document.getElementById('file-name');

    if (input.files.length > 0) {
        const count = input.files.length;
        if (count === 1) {
            nameEl.textContent = input.files[0].name;
        } else {
            nameEl.textContent = `${count} files selected`;
        }

        nameEl.classList.add('active');
        mainUploadBtn.classList.add('button-appear');
    } else {
        nameEl.textContent = 'No files chosen...';
        nameEl.classList.remove('active');
        mainUploadBtn.classList.remove('button-appear');
    }
}



/* --- Step 1: Intercept form → show confirmation modal --- */
if (uploadForm) {
    uploadForm.addEventListener('submit', e => {
        e.preventDefault();
        const files = fileInput.files;
        if (files.length === 0) { showToast('Please select at least one file.', 'error'); return; }

        // 1. Enforce 5 file limit
        if (files.length > 5) {
            showToast('You can only upload up to 5 songs at a time.', 'error');
            return;
        }

        const allowedExts = ['mp3', 'wav', 'm4a', 'flac', 'ogg'];
        const MAX_SIZE = 20 * 1024 * 1024; // 20MB per file
        let totalSize = 0;
        let fileListHtml = '';

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const ext = file.name.split('.').pop().toLowerCase();

            // Validate Extension
            if (!allowedExts.includes(ext)) {
                showToast(`Invalid file type for "${file.name}". Allowed: ${allowedExts.join(', ')}`, 'error');
                return;
            }

            // Validate Size
            if (file.size > MAX_SIZE) {
                showToast(`"${file.name}" is too large (${formatBytes(file.size)}). Maximum is 20MB per file.`, 'error');
                return;
            }

            totalSize += file.size;
            fileListHtml += `<div style="font-size:13px; margin-bottom:5px;">• ${file.name} (${formatBytes(file.size)})</div>`;
        }

        // Update Modal UI
        if (files.length === 1) {
            fileNameDisplay.textContent = files[0].name;
            fileSizeDisplay.textContent = formatBytes(files[0].size);
        } else {
            fileNameDisplay.innerHTML = `<div style="margin-bottom:10px;">${files.length} Songs Selected:</div><div style="text-align:left; max-height:150px; overflow-y:auto; background:rgba(0,0,0,0.2); padding:10px; border-radius:8px;">${fileListHtml}</div>`;
            fileSizeDisplay.textContent = `Total Batch Size: ${formatBytes(totalSize)}`;
        }

        confirmModal.classList.remove('hidden');
    });
}

/* --- Step 2: Cancel --- */
if (cancelUploadBtn) {
    cancelUploadBtn.addEventListener('click', () => confirmModal.classList.add('hidden'));
}

/* --- Step 3: Confirm → XHR upload with progress --- */
if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
        confirmModal.classList.add('hidden');
        uploadProgressContainer.style.display = 'block';
        mainUploadBtn.disabled = true;
        mainUploadBtn.textContent = 'Please wait...';

        const formData = new FormData(uploadForm);
        const xhr = new XMLHttpRequest();

        const compressionSelect = document.getElementById('enable-compression');
        formData.append('visibility', 'private'); // Always private — Vault mode
        if (compressionSelect) formData.append('compression', compressionSelect.value);

        xhr.upload.addEventListener('progress', event => {
            if (!event.lengthComputable) return;
            const percent = Math.round((event.loaded / event.total) * 100);
            uploadProgressBar.style.width = percent + '%';
            uploadPercentage.textContent = percent + '%';
            uploadStatusText.textContent = percent >= 100
                ? 'Compressing audio (this may take a moment)...'
                : 'Uploading...';
            if (percent >= 100) uploadStatusText.style.color = '#1db954';
        });

        xhr.addEventListener('load', () => {
            let res;
            try { res = JSON.parse(xhr.responseText); } catch (e) { }

            if (xhr.status < 400) {
                resetUploadUI();
                // Redirect to Library tab instead of full page reload
                const libraryLink = document.getElementById('library-link');
                if (libraryLink) libraryLink.click();
            } else {
                const errMsg = (res && res.error) ? res.error : 'Upload failed. Please try again.';
                showToast('Error: ' + errMsg, 'error');
                resetUploadUI();
            }
        });

        xhr.addEventListener('error', () => { showToast('An error occurred during upload.', 'error'); resetUploadUI(); });

        xhr.open('POST', window.API_BASE_URL + '/upload-song');
        xhr.send(formData);
    });
}

/* --- YouTube Import --- */
const youtubeImportBtn = document.getElementById('youtube-import-btn');
const youtubeUrlInput = document.getElementById('youtube-url');
const youtubeProgress = document.getElementById('youtube-progress-container');
const youtubeProgressFill = document.getElementById('youtube-progress-fill');
const youtubeStatusText = document.getElementById('youtube-status-text');
const youtubePercentage = document.getElementById('youtube-percentage');

if (youtubeImportBtn) {
    let ratelimitInterval = null;
    // Utility to parse rate limit headers and update UI with a live countdown
    const updateRateLimitDisplay = (headers_or_data) => {
        let remaining, resetSeconds;

        // Handle both fetch headers and JSON status objects
        if (headers_or_data && typeof headers_or_data.get === 'function') {
            remaining = headers_or_data.get('ratelimit-remaining');
            resetSeconds = parseInt(headers_or_data.get('ratelimit-reset')) || 0;
        } else if (headers_or_data) {
            remaining = headers_or_data.remaining;
            resetSeconds = headers_or_data.resetSeconds || 0;
        }

        const infoEl = document.getElementById('youtube-ratelimit-info');
        if (infoEl) {
            // Normalize values
            const count = (remaining !== undefined && remaining !== null) ? remaining : (window.YOUTUBE_LIMIT_MAX || 2);
            const reset = (resetSeconds !== undefined && resetSeconds !== null) ? resetSeconds : 0;

            if (ratelimitInterval) clearInterval(ratelimitInterval);

            let currentReset = parseInt(reset);
            const updateUI = () => {
                if (currentReset <= 0) {
                    infoEl.innerHTML = `<i class='bx bx-check-circle' style='color: #1db954;'></i> You have <b>${count}</b> downloads remaining. Quota refreshed!`;
                    infoEl.style.opacity = "1";
                    clearInterval(ratelimitInterval);
                    return;
                }
                const mins = Math.floor(currentReset / 60);
                const secs = currentReset % 60;
                infoEl.innerHTML = `<i class='bx bx-time-five'></i> You have <b>${count}</b> downloads remaining. Refills in <b>${mins}m ${secs}s</b>`;
                infoEl.style.display = 'block';
                infoEl.style.opacity = "0.7";
                currentReset--;
            };

            updateUI();
            ratelimitInterval = setInterval(updateUI, 1000);
        }
    };

    // Utility to sanitize YouTube URLs by removing playlists and other params
    const sanitizeYouTubeUrl = (url) => {
        try {
            const urlObj = new URL(url);
            if (urlObj.hostname.includes('youtube.com')) {
                const v = urlObj.searchParams.get('v');
                if (v) return `https://www.youtube.com/watch?v=${v}`;
            } else if (urlObj.hostname.includes('youtu.be')) {
                const id = urlObj.pathname.substring(1);
                if (id) return `https://www.youtube.com/watch?v=${id}`;
            }
        } catch (e) {
            console.warn("[SANITIZE] Failed to parse URL, using raw string.", e);
        }
        return url;
    };

    youtubeImportBtn.addEventListener('click', async () => {
        const rawUrl = youtubeUrlInput.value.trim();
        const url = sanitizeYouTubeUrl(rawUrl);
        const compressCheckbox = document.getElementById('youtube-compress');
        const compress = compressCheckbox ? compressCheckbox.checked : false;
        const compressOptions = document.getElementById('youtube-options');
        const previewBox = document.getElementById('youtube-preview');

        if (!url) {
            showToast('Please enter a YouTube URL.', 'error');
            return;
        }

        // Basic validation
        if (!url.includes('youtube.com/') && !url.includes('youtu.be/')) {
            showToast('Invalid YouTube URL.', 'error');
            return;
        }

        // UI Feedback
        youtubeImportBtn.disabled = true;
        youtubeImportBtn.innerHTML = '<i class="bx bx-loader-alt bx-spin"></i> Processing...';

        if (compressOptions) {
            compressOptions.classList.remove('expand-show');
            compressOptions.classList.add('shrink-hide');
        }

        youtubeProgress.style.display = 'block';
        youtubeProgressFill.style.width = '10%';
        youtubePercentage.textContent = '10%';
        youtubeStatusText.textContent = 'Fetching metadata...';
        youtubeStatusText.style.color = '#ccc';

        try {
            // STEP 1: Fetch Metadata for Preview
            const metaResponse = await fetch(window.API_BASE_URL + '/api/youtube-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            const metaRes = await metaResponse.json();
            updateRateLimitDisplay(metaResponse.headers);

            if (!metaResponse.ok) throw new Error(metaRes.error || 'Failed to fetch metadata');

            // Show Preview Box with pop-in + expand animation
            if (previewBox) {
                previewBox.style.display = 'block';
                previewBox.classList.remove('shrink-hide');
                previewBox.classList.add('expand-show');
                previewBox.classList.add('pop-in');

                document.getElementById('youtube-preview-img').style.backgroundImage = `url('${metaRes.thumbnail}')`;
                document.getElementById('youtube-preview-title').textContent = metaRes.title;
                document.getElementById('youtube-preview-artist').textContent = metaRes.artist;
                const m = Math.floor(metaRes.duration / 60);
                const s = metaRes.duration % 60;
                document.getElementById('youtube-preview-duration').textContent = `${m}:${s.toString().padStart(2, '0')}`;
            }

            youtubeProgressFill.style.width = '30%';
            youtubePercentage.textContent = '30%';
            youtubeStatusText.textContent = compress ? 'Downloading and compressing (MP3)...' : 'Downloading audio stream...';

            // STEP 2: Actual Download & Save
            const response = await fetch(window.API_BASE_URL + '/api/youtube-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, compress })
            });

            const res = await response.json();
            updateRateLimitDisplay(response.headers);

            if (response.ok) {
                youtubeProgressFill.style.width = '100%';
                youtubePercentage.textContent = '100%';
                youtubeStatusText.textContent = 'Success!';
                youtubeStatusText.style.color = '#1db954';
                showToast('YouTube song imported successfully!', 'success');

                youtubeUrlInput.value = '';

                setTimeout(() => {
                    youtubeProgress.style.display = 'none';
                    if (previewBox) {
                        previewBox.classList.remove('expand-show');
                        previewBox.classList.add('shrink-hide');
                        // No need for display: none if shrink-hide works, 
                        // but keeping a small delay for cleanup
                        setTimeout(() => {
                            if (previewBox.classList.contains('shrink-hide')) {
                                previewBox.style.display = 'none';
                            }
                        }, 400);
                    }

                    if (compressOptions) {
                        compressOptions.classList.remove('shrink-hide');
                        compressOptions.classList.add('expand-show');
                    }

                    youtubeImportBtn.disabled = false;
                    youtubeImportBtn.innerHTML = '<i class="bx bx-link-external"></i> Import';

                    // Switch to library and THEN refresh
                    const libraryLink = document.getElementById('library-link');
                    if (libraryLink) {
                        libraryLink.click();
                        setTimeout(() => {
                            if (typeof fetchLibrary === 'function') fetchLibrary(true);
                        }, 500); // Wait for tab switch animation/logic
                    }
                }, 2000);
            } else {
                throw new Error(res.error || 'Import failed');
            }
        } catch (err) {
            console.error('[YOUTUBE IMPORT]', err);
            showToast('Error: ' + err.message, 'error');
            youtubeProgress.style.display = 'none';
            if (compressOptions) {
                compressOptions.classList.remove('shrink-hide');
                compressOptions.classList.add('expand-show');
            }
            youtubeImportBtn.disabled = false;
            youtubeImportBtn.innerHTML = '<i class="bx bx-link-external"></i> Import';
        }
    });

    // Initialize Rate Limit Display on Load
    const initRateLimit = async () => {
        const infoEl = document.getElementById('youtube-ratelimit-info');
        try {
            if (typeof window.API_BASE_URL === 'undefined') {
                console.warn("[YOUTUBE-UI] API_BASE_URL not ready, retrying...");
                setTimeout(initRateLimit, 500);
                return;
            }

            const resp = await fetch(window.API_BASE_URL + '/api/youtube-ratelimit-status');
            if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);

            const data = await resp.json();
            if (data && data.success) {
                updateRateLimitDisplay(data);
            } else {
                // Fallback to default if somehow API fails but returns 200
                updateRateLimitDisplay({ remaining: window.YOUTUBE_LIMIT_MAX || 2, resetSeconds: 0 });
            }
        } catch (e) {
            console.error("[YOUTUBE UI] Could not init ratelimit status:", e);
            // If we have an element, clear the "Checking..." text so it's not stuck
            if (infoEl) {
                updateRateLimitDisplay({ remaining: window.YOUTUBE_LIMIT_MAX || 2, resetSeconds: 0 });
            }
        }
    }

    /* --- Spotify Import Logic --- */
    if (spotifyBtn) {
        spotifyBtn.addEventListener('click', async (e) => {
            const url = spotifyUrlInput.value.trim();
            const playlistName = spotifyNameInput.value.trim();
            const useSoulseek = document.getElementById('spotify-use-soulseek').checked;

            if (spotifyBtn.dataset.state === 'importing') {
                if (confirm("Are you sure you want to cancel the entire import?")) {
                    spotifyBtn.disabled = true;
                    spotifyBtn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Stopping...";
                    if (typeof socket !== 'undefined' && socket) {
                        socket.emit('stop_import');
                    }
                }
                return;
            }

            if (!url.includes('spotify.com')) {
                if (typeof showToast === 'function') showToast("Please enter a valid Spotify URL", "error");
                return;
            }

            spotifyBtn.disabled = true;
            spotifyBtn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Starting...";

            try {
                const resp = await fetch(window.API_BASE_URL + '/api/import/spotify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, playlistName, useSoulseek })
                });

                const data = await resp.json();

                if (resp.ok && data.success) {
                    if (typeof showToast === 'function') showToast(data.message, "success");

                    // Show progress UI
                    spotifyProgressContainer.classList.remove('hidden');
                    spotifyProgressText.textContent = "Fetching tracklist...";
                    spotifyProgressBar.style.width = '5%';
                    spotifyProgressLog.innerHTML = ''; // Clear previous logs

                    // Change button to STOP
                    spotifyBtn.dataset.state = 'importing';
                    spotifyBtn.style.background = '#c0392b';
                    spotifyBtn.innerHTML = "<i class='bx bx-stop-circle'></i> Stop Import";
                    spotifyBtn.disabled = false;

                    // Use explicit totalTracks if provided, fallback to regex
                    const total = data.totalTracks || (data.message.match(/Importing (\d+) tracks/) || [])[1];
                    if (total) {
                        spotifyImportState.total = parseInt(total);
                        spotifyImportState.current = 0;
                        spotifyProgressCount.textContent = `0/${spotifyImportState.total}`;
                    }

                    spotifyForm.reset();
                } else {
                    if (typeof showToast === 'function') showToast(data.error || "Failed to start import", "error");
                    spotifyBtn.innerHTML = "<i class='bx bx-import'></i> Start Import";
                }
            } catch (err) {
                console.error("[SPOTIFY IMPORT]", err);
                if (typeof showToast === 'function') showToast("Network error during import.", "error");
                spotifyBtn.innerHTML = "<i class='bx bx-import'></i> Start Import";
            } finally {
                if (spotifyBtn.dataset.state !== 'importing') {
                    spotifyBtn.disabled = false;
                }
            }
        });

        if (spotifySkipBtn) {
            spotifySkipBtn.addEventListener('click', () => {
                window.skipSoulseek();
            });
        }
    } else {
        console.error("Spotify import form not found in DOM");
    }

    // Bind socket listener for real-time import progress
    if (typeof socket !== 'undefined' && socket) {
        socket.on('import_error', (data) => {
            if (typeof showToast === 'function') showToast(data.message, "error");
            spotifyProgressText.textContent = "Import Paused (Quota Reached)";
            spotifyProgressText.style.color = '#e74c3c';
        });

        socket.on('import_cancelled', () => {
            if (typeof showToast === 'function') showToast("Import stopped by user.", "info");

            // Reset button
            spotifyBtn.dataset.state = '';
            spotifyBtn.style.background = '';
            spotifyBtn.innerHTML = "<i class='bx bx-import'></i> Start Import";
            spotifyBtn.disabled = false;

            // Hide progress container
            spotifyProgressContainer.classList.add('hidden');

            // Refresh playlists/library to show partial import
            if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
            if (typeof fetchLibrary === 'function') fetchLibrary(true);
        });

        socket.on('import_progress', (data) => {
            spotifyProgressContainer.classList.remove('hidden');

            if (data.status === 'done' && spotifyImportState.total > 0) {
                spotifyImportState.current++;
                spotifyProgressCount.textContent = `${spotifyImportState.current}/${spotifyImportState.total}`;

                const percent = Math.min(100, Math.round((spotifyImportState.current / spotifyImportState.total) * 100));
                spotifyProgressBar.style.width = `${percent}%`;
                spotifyProgressBar.style.background = '#555';
            }

            // Find or create a dedicated log line for this specific song
            const safeSongId = `log-${data.song.replace(/[^a-z0-9]/gi, '-')}`;
            let logEntry = document.getElementById(safeSongId);

            if (!logEntry) {
                logEntry = document.createElement('div');
                logEntry.id = safeSongId;
                logEntry.style.marginBottom = '8px';
                logEntry.style.padding = '8px';
                logEntry.style.background = 'rgba(255,255,255,0.05)';
                logEntry.style.borderRadius = '4px';
                logEntry.style.fontSize = '12px';
                spotifyProgressLog.appendChild(logEntry);
            }

            if (data.status === 'searching_slsk') {
                spotifyImportState.currentSong = data.song;
                logEntry.innerHTML = `<span style="color:#b3b3b3;">⌛</span> Searching Soulseek (HQ): <b>${escapeHTML(data.song)}</b>`;
                spotifyProgressText.textContent = `Searching Soulseek...`;
                if (spotifySkipBtn) spotifySkipBtn.classList.add('hidden');
            } else if (data.status === 'searching_yt') {
                logEntry.innerHTML = `<span style="color:#b3b3b3;">⌛</span> Falling back to YouTube: <b>${escapeHTML(data.song)}</b>`;
                spotifyProgressText.textContent = `Falling back to YouTube...`;
                if (spotifySkipBtn) spotifySkipBtn.classList.add('hidden');
            } else if (data.status === 'downloading') {
                spotifyImportState.currentSong = data.song;
                const sourceName = data.source === 'soulseek' ? 'Soulseek (HQ)' : 'YouTube';

                let etaDisplay = '';
                if (data.eta) {
                    if (typeof data.eta === 'number') {
                        const mins = Math.floor(data.eta / 60);
                        const secs = data.eta % 60;
                        etaDisplay = ` — Est. ${mins > 0 ? mins + 'm ' : ''}${secs}s`;
                    } else {
                        etaDisplay = ` — ${data.eta}`; // For 'Stalled' or other strings
                    }
                }

                const etaId = `eta-${safeSongId}`;
                const existingEta = document.getElementById(etaId);

                // If the span exists, just update its text
                if (existingEta) {
                    existingEta.textContent = etaDisplay;
                } else {
                    // Otherwise, build the whole line (ensuring the ID is present for future updates)
                    logEntry.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span><span style="color:#888;">⬇</span> Downloading from ${sourceName}: <b>${escapeHTML(data.song)}</b><span style="color:#888;" id="${etaId}">${etaDisplay}</span></span>
                        </div>
                    `;
                }

                // Always update the main status text at the top
                spotifyProgressText.textContent = `Downloading ${escapeHTML(data.song)}${etaDisplay}`;

                // Show global skip button only for Soulseek downloads
                if (data.source === 'soulseek' && spotifySkipBtn) {
                    spotifySkipBtn.classList.remove('hidden');
                    spotifySkipBtn.disabled = false;
                    spotifySkipBtn.innerHTML = "<i class='bx bx-fast-forward'></i> Skip Current";
                } else if (spotifySkipBtn) {
                    spotifySkipBtn.classList.add('hidden');
                }
            } else if (data.status === 'done') {
                logEntry.innerHTML = `<span style="color:#1db954;">✔</span> <b>${escapeHTML(data.song)}</b> <span style="color:#888;">imported via ${escapeHTML(data.source)}</span>`;
                logEntry.style.background = 'transparent'; // Make it look "settled"
                spotifyProgressText.textContent = `Finished: ${escapeHTML(data.song)}`;
            } else if (data.status === 'failed') {
                logEntry.innerHTML = `<span style="color:#e74c3c;">✖</span> <b>${escapeHTML(data.song)}</b> <span style="color:#888;">failed to download</span>`;
                spotifyProgressText.textContent = `Failed: ${escapeHTML(data.song)}`;
            }

            spotifyProgressLog.scrollTop = spotifyProgressLog.scrollHeight;

            if (spotifyImportState.total > 0 && spotifyImportState.current >= spotifyImportState.total) {
                spotifyProgressText.textContent = "Import Complete!";
                spotifyProgressText.style.color = '#1db954';
                if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
                if (typeof fetchLibrary === 'function') fetchLibrary(true);
            }
        });

        socket.on('storage_update', () => {
            if (typeof loadStorage === 'function') loadStorage();
        });
    }

    // Initial fetch of rate limit
    initRateLimit();

    const uploadLink = document.getElementById('upload-link');
    if (uploadLink) {
        uploadLink.addEventListener('click', () => {
            setTimeout(initRateLimit, 100);
        });
    }
}


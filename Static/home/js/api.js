/**
 * ============================================================================
 * STREAMIFY — api.js
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
    let bitrate = song.bitrate;
    let extension = song.extension || '';
    
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

function safeStyleURL(url) {
    if (!url) return '';
    // Strip any characters that could break out of a CSS url('...') context
    return url.replace(/[)'"]/g, '');
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

    for (const song of songs) {
        try {
            const isDownloaded = await window.OfflineStore.isSongDownloaded(song.id);
            if (!isDownloaded) {
                await window.OfflineStore.downloadSong(song.id);

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

function renderSongList(songs, listContainer) {
    const header = listContainer.querySelector('.header-row');
    listContainer.innerHTML = '';
    if (header) listContainer.appendChild(header);

    currentPlaylist = songs.map(s => ({
        id: s.id,
        title: s.name || s.title || s,
        artist: s.artist || 'Unknown Artist',
        album: s.album || 'Single',
        cover: s.cover,
        uploaded_by: s.uploaded_by || 'Unknown',
        duration: s.duration,
        is_private: s.is_private || 'public',
        bitrate: s.bitrate,
        extension: s.extension,
        url: `/api/play/${s.id || encodeURIComponent(s.name || s.title || s)}`
    }));

    shuffledPlaylist = [...Array(currentPlaylist.length).keys()];

    currentPlaylist.forEach((song, index) => {
        const duration = song.duration || '--:--';
        const hasCover = !!(song.cover);
        const cover = hasCover ? song.cover : COVER_PLACEHOLDER;

        const title = escapeHTML(song.title);
        const artist = escapeHTML(song.artist);
        const album = escapeHTML(song.album);
        const uploadedBy = escapeHTML(song.uploaded_by || 'Unknown');

        const row = document.createElement('div');
        row.className = 'song-row';
        if (isLibraryEditMode) row.classList.add('edit-mode');
        if (selectedSongIds.has(song.id)) row.classList.add('selected');

        row.dataset.id = song.id;

        const canEdit = appCache.user && (appCache.user.role === 'Owner' || appCache.user.username === song.uploaded_by);
        const isPrivate = song.is_private === 'private';
        const visibilityIcon = isPrivate
            ? `<i class='bx bx-lock-alt' style="font-size:14px;color:var(--text-secondary);margin-left:6px;" title="Private"></i>`
            : `<i class='bx bx-globe' style="font-size:14px;color:var(--text-secondary);margin-left:6px;opacity:0.5;" title="Public"></i>`;

        // Check offline status
        const isDownloaded = window.OfflineStore ? window.OfflineStore.isSongDownloaded(song.id) : Promise.resolve(false);

        row.innerHTML = `<div class="index-cell"><div class="select-indicator"></div><span class="row-index-number">${index + 1}</span></div><div class="song-info"><img src="${cover}" alt="cover" class="song-cover-img"><div><div class="song-title-row">${title}</div><div style="font-size: 12px;">${artist}</div></div></div><span>${album}</span><span>${uploadedBy}</span><span>${duration}${visibilityIcon}</span><div class="edit-btn-container" onclick="event.stopPropagation();">
            <button class="row-download-btn" onclick="event.stopPropagation(); triggerDownload('${song.id}', this)"><i class='bx bx-download'></i></button>
            ${(canEdit && isLibraryEditMode) ? `<button class="row-edit-btn" onclick="event.stopPropagation(); openEditSongModal(${index})"><i class='bx bx-edit-alt'></i></button>` : ''}
        </div>`;

        // Async offline check
        if (window.OfflineStore) {
            window.OfflineStore.isSongDownloaded(song.id).then(downloaded => {
                if (downloaded) {
                    const btn = row.querySelector('.row-download-btn i');
                    if (btn) {
                        btn.className = 'bx bxs-check-circle';
                        btn.parentElement.classList.add('downloaded');
                        btn.parentElement.style.color = '#4CAF50';
                    }
                }
            });
        }

        /* Async cover art fetch from iTunes if none embedded */
        if (!hasCover) {
            const imgEl = row.querySelector('.song-cover-img');
            fetchWebCover(song.artist, song.title).then(url => {
                if (url) {
                    if (imgEl) imgEl.src = url;
                    currentPlaylist[index].cover = url;
                    saveCoverToServer(song.title, url);
                }
            });
        }

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

        listContainer.appendChild(row);
    });

    // Re-apply playing indicator after render
    highlightCurrentSong(listContainer);
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

function openEditSongModal(index) {
    const song = currentPlaylist[index];
    if (!song) return;

    const modal = document.getElementById('edit-song-modal');
    document.getElementById('edit-song-id').value = song.id;
    document.getElementById('edit-song-name').value = song.title;
    document.getElementById('edit-song-artist').value = song.artist;
    document.getElementById('edit-song-album').value = song.album;

    const coverImg = document.getElementById('edit-song-cover-img');
    coverImg.src = song.cover || COVER_PLACEHOLDER;

    // Fetch full song data to get visibility (is_private)
    fetch(window.API_BASE_URL + `/api/play/${song.id}`)
        .then(r => r.json())
        .then(fullData => {
            document.getElementById('edit-song-visibility').value = fullData.is_private === 'private' ? 'private' : 'public';
        })
        .catch(() => { });

    modal.classList.remove('hidden');
}

function saveSongChanges() {
    const id = document.getElementById('edit-song-id').value;
    const songname = document.getElementById('edit-song-name').value;
    const artist = document.getElementById('edit-song-artist').value;
    const album = document.getElementById('edit-song-album').value;
    const is_private = document.getElementById('edit-song-visibility').value;

    fetch(window.API_BASE_URL + `/api/songs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ songname, artist, album, is_private })
    })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                document.getElementById('edit-song-modal').classList.add('hidden');
                fetchLibrary(true);
            } else {
                showToast(data.error, 'error');
            }
        });
}

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
                document.getElementById('edit-song-cover-img').src = data.cover;
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
            : `<div style="width:120px;max-width:100%;aspect-ratio:1;background:linear-gradient(45deg,#1db954,#191414);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:bold;margin:0 auto 16px;box-shadow:0 4px 10px rgba(0,0,0,0.5);">${initial}</div>`;

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
    const composeAvatar = document.getElementById('compose-avatar');

    // Helper to apply styles to any avatar element
    const applyAvatar = (el) => {
        if (!el) return;
        if (data.avatar) {
            el.textContent = '';
            el.style.backgroundImage = `url('${safeStyleURL(data.avatar)}')`;
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
        } else {
            el.style.backgroundImage = 'linear-gradient(45deg, #1db954, #191414)';
            el.style.backgroundSize = '';
            el.style.backgroundPosition = '';
            el.textContent = username.charAt(0).toUpperCase();
        }
    };

    applyAvatar(topAvatar);
    applyAvatar(composeAvatar);

    // 3. Role-based Feed Actions (Now available for everyone)
    const addPhotoBtn = document.getElementById('add-photo-btn');
    if (addPhotoBtn) {
        addPhotoBtn.classList.remove('hidden');
    }

    fetchPosts(); // Load posts after user info is ready
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
    if (els.avatar) { els.avatar.innerHTML = ''; els.avatar.style.backgroundImage = 'linear-gradient(45deg,#1db954,#191414)'; els.avatar.textContent = 'L'; }
    if (els.bio) els.bio.textContent = 'Loading...';
    if (els.playlists) els.playlists.textContent = '—';
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
        if (data.avatar) {
            avatarEl.innerHTML = `<img src="${escapeHTML(data.avatar)}" alt="avatar" style="width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%;">`;
        } else {
            avatarEl.style.backgroundImage = 'linear-gradient(45deg,#1db954,#191414)';
            avatarEl.style.backgroundSize = '';
            avatarEl.style.backgroundPosition = '';
            avatarEl.textContent = displayName.charAt(0).toUpperCase();
        }
    }

    const playlistsEl = document.getElementById('profile-playlists-count');
    if (playlistsEl) playlistsEl.textContent = (typeof data.playlists_count === 'number') ? data.playlists_count : '—';

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

function fetchCurrentUser(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && appCache.user && (now - appCache.userTime < CACHE_DURATION)) {

        renderUserUI(appCache.user);
        return;
    }
    fetch(window.API_BASE_URL + '/api/me')
        .then(r => r.json())
        .then(data => {
            appCache.user = data;
            appCache.userTime = Date.now();
            renderUserUI(data);

            if (window.OfflineStore && data.username) {
                window.OfflineStore.cacheUserProfile(data.username, data.avatarUrl || data.avatar_url || data.avatar);
            }

            // Socket room join no longer needed manually
            if (typeof socket !== 'undefined' && data.username) {
                // socket.emit('join', data.username); // Server now handles this automatically on connect
            }
            fetchNotifications();
        })
        .catch(err => console.error('Error fetching user:', err));
}

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

function fetchLibrary(forceRefresh = false) {
    const list = document.getElementById('trending-list'); // Wait, why trending-list? Streamify codebase calls the library list 'trending-list'.

    if (!navigator.onLine && window.OfflineStore) {
        window.OfflineStore.getOfflineSongs().then(songs => {
            renderSongList(songs, list);
        });
        return;
    }

    const now = Date.now();
    if (!forceRefresh && appCache.library && (now - appCache.libraryTime < CACHE_DURATION)) {

        renderSongList(appCache.library, list);
        return;
    }
    const seq = ++_fetchLibrarySeq;
    fetch(window.API_BASE_URL + '/api/library')
        .then(r => r.json())
        .then(songs => {
            if (window.currentActiveView !== 'library' || seq !== _fetchLibrarySeq) return;
            appCache.library = songs; appCache.libraryTime = Date.now();
            renderSongList(songs, list);
        })
        .catch(err => console.error('Error fetching library:', err));
}

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

function performSearch(query) {
    if (!query) return;

    // Abort any in-flight search to prevent stale results
    if (_searchAbort) _searchAbort.abort();
    _searchAbort = new AbortController();

    const usersGrid = document.getElementById('search-users-grid');
    const songsList = document.getElementById('search-songs-list');
    usersGrid.innerHTML = '<p style="color:#b3b3b3;">Searching...</p>';
    songsList.innerHTML = '<p style="color:#b3b3b3;">Searching...</p>';

    fetch(window.API_BASE_URL + `/api/search?q=${encodeURIComponent(query)}`, { signal: _searchAbort.signal })
        .then(r => r.json())
        .then(data => {
            _searchAbort = null;
            /* Users */
            usersGrid.innerHTML = '';
            if (data.users && data.users.length > 0) {
                data.users.forEach(u => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    const initial = u.username.charAt(0).toUpperCase();
                    const safeUsername = escapeHTML(u.username);
                    const avatarHtml = u.avatar
                        ? `<div style="width:100px;max-width:100%;aspect-ratio:1;border-radius:50%;background:url('${safeStyleURL(u.avatar)}') center/cover;margin:0 auto 10px;"></div>`
                        : `<div style="width:100px;max-width:100%;aspect-ratio:1;background:linear-gradient(45deg,#555,#333);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 10px;">${initial}</div>`;
                    card.innerHTML = `${avatarHtml}<div style="text-align:center;font-weight:bold;">${safeUsername}</div>`;
                    card.style.cursor = 'pointer';
                    card.addEventListener('click', () => {
                        clearUserProfile();
                        const m = document.getElementById('profile-modal');
                        if (m) m.classList.remove('hidden');
                        // Fetch fresh profile data so songs_count/likes_count are accurate
                        fetch(window.API_BASE_URL + `/api/profile/${encodeURIComponent(u.username)}`)
                            .then(r => r.json())
                            .then(profile => displayUserProfile(profile.user || profile))
                            .catch(() => displayUserProfile(u));
                    });
                    usersGrid.appendChild(card);
                });
            } else {
                usersGrid.innerHTML = '<p style="color:#b3b3b3;">No users match your search.</p>';
            }

            /* Songs */
            songsList.innerHTML = `
                <div class="song-row header-row" style="cursor:default;background:transparent;color:#b3b3b3;border-bottom:1px solid #333;margin-bottom:10px;">
                    <span></span><span>#</span><span>Title</span><span>Album</span><span>Uploaded By</span><span><i class='bx bx-time'></i></span><span></span>
                </div>`;

            if (data.songs && data.songs.length > 0) {
                currentPlaylist = data.songs.map(s => ({
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
                shuffledPlaylist = [...Array(currentPlaylist.length).keys()];
                currentPlaylist.forEach((song, index) => {
                    const cover = song.cover || 'https://via.placeholder.com/60';
                    const title = escapeHTML(song.title);
                    const artist = escapeHTML(song.artist);
                    const album = escapeHTML(song.album);
                    const uploadedBy = escapeHTML(song.uploaded_by);

                    const row = document.createElement('div');
                    row.className = 'song-row';
                    row.innerHTML = `<div class="index-cell"><div class="select-indicator"></div><span class="row-index-number">${index + 1}</span></div><div class="song-info"><img src="${cover}" alt="cover"><div><div class="song-title-row">${title}</div><div style="font-size:12px;">${artist}</div></div></div><span>${album}</span><span>${uploadedBy}</span><span>${song.duration}</span><div class="edit-btn-container"></div>`;
                    row.onclick = () => playSongAtIndex(index);
                    songsList.appendChild(row);
                });
            } else {
                songsList.insertAdjacentHTML('beforeend', '<p style="padding:10px;color:#b3b3b3;">No songs match your search.</p>');
            }
        })
        .catch(err => { if (err.name === 'AbortError') return; console.error(err); usersGrid.innerHTML = '<p style="color:red;">Error searching.</p>'; });
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
    const avatarStyle = post.avatar
        ? `background-image: url('${safeStyleURL(post.avatar)}'); background-size: cover; background-position: center;`
        : `background: linear-gradient(135deg, #4169e1, #8b5cf6);`;

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
            <div class="post-avatar" style="${avatarStyle};cursor:pointer" onclick="event.stopPropagation();openUserProfileModal('${safeUsername}')">${post.avatar ? '' : initial}</div>
            <div class="post-user-info">
                <span class="post-username" style="cursor:pointer" onclick="event.stopPropagation();openUserProfileModal('${safeUsername}')">${safeDisplayName} ${badgeHtml}</span>
                <span class="post-handle" style="cursor:pointer" onclick="event.stopPropagation();openUserProfileModal('${safeUsername}')">@${safeUsername.toLowerCase()} · ${timeStr}</span>
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
    navigator.clipboard.writeText(url).then(() => {
        showToast('Post link copied to clipboard!', 'success');
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

function fetchWebCover(artist, title) {
    let cleanTitle = title
        .replace(/\(.*\)/g, '').replace(/\[.*\]/g, '').replace(/\.mp3$/i, '')
        .replace(/official\s+video/gi, '').replace(/visuali[sz]er/gi, '').replace(/lyrics/gi, '').trim();

    if ((!artist || artist === 'Unknown Artist') && cleanTitle.includes('-')) {
        const parts = cleanTitle.split('-');
        if (parts.length >= 2) { artist = parts[0].trim(); cleanTitle = parts.slice(1).join(' ').trim(); }
    }

    const queryTerm = (artist && artist !== 'Unknown Artist') ? `${artist} ${cleanTitle}` : cleanTitle;
    return fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(queryTerm)}&media=music&limit=1`)
        .then(r => r.json())
        .then(data => data.resultCount > 0 ? data.results[0].artworkUrl100.replace('100x100bb', '600x600bb') : null)
        .catch(() => null);
}

/**
 * Persist a fetched iTunes cover URL to disk via the server.
 * Fire-and-forget — UI is never blocked waiting for this.
 */
function saveCoverToServer(songname, coverUrl) {
    fetch(window.API_BASE_URL + '/api/save-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ songname, coverUrl })
    }).catch(() => { }); // intentionally silent — non-critical background operation
}



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
        .then(r => r.json())
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
        const isActive = window.currentPlaylistId && (window.currentPlaylistId == p.id || window.currentPlaylistId == p.share_id);
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

function fetchPlaylistSongs(playlistId, forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && appCache.playlistDetails[playlistId] && (now - appCache.playlistDetailsTime[playlistId] < CACHE_DURATION)) {
        return Promise.resolve(appCache.playlistDetails[playlistId]);
    }

    // Detect if playlistId is a share_id (16-char hex string) or a numeric ID
    const isShareId = typeof playlistId === 'string' && /^[0-9a-f]{16}$/i.test(playlistId);
    const url = isShareId
        ? `${window.API_BASE_URL}/api/playlists/share/${playlistId}`
        : `${window.API_BASE_URL}/api/playlists/${playlistId}/songs`;

    return fetch(url, { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
            if (!data.error) {
                appCache.playlistDetails[playlistId] = data;
                appCache.playlistDetailsTime[playlistId] = Date.now();
            }
            return data;
        });
}

let _playlistRenderSeq = 0;

async function renderPlaylistDetail(playlistId) {
    const seq = ++_playlistRenderSeq;

    // Clear old content immediately to prevent stale data flash
    document.getElementById('playlist-detail-name').textContent = 'Loading...';
    document.getElementById('playlist-detail-count').textContent = '';

    const bioEl = document.getElementById('playlist-detail-bio');
    if (bioEl) {
        bioEl.textContent = '';
        bioEl.style.display = 'none';
    }

    const coverEl = document.getElementById('playlist-detail-cover');
    if (coverEl) {
        coverEl.style.backgroundImage = 'linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(168, 85, 247, 0.3))';
        const icon = coverEl.querySelector('.bx-music');
        if (icon) icon.style.display = 'block';
        coverEl.classList.remove('editable');
    }

    const list = document.getElementById('playlist-songs-list');
    const header = list ? list.querySelector('.header-row') : null;

    try {
        let songs = [];
        let playlist = null;
        let data;

        try {
            data = await fetchPlaylistSongs(playlistId, true); // Force refresh to bypass in-memory JS cache on load
        } catch (e) {
            // If fetch fails (e.g. offline and not in SW cache), try checking IndexedDB as a fallback
            if (!navigator.onLine && window.OfflineStore) {
                const cachedPlaylistData = await window.OfflineStore.getOfflinePlaylist(playlistId);
                if (cachedPlaylistData) {
                    data = cachedPlaylistData;
                } else {
                    document.getElementById('playlist-detail-name').textContent = 'Offline or Unavailable';
                    return;
                }
            } else {
                console.warn("Failed to fetch playlist songs:", e);
                document.getElementById('playlist-detail-name').textContent = 'Offline or Unavailable';
                return;
            }
        }

        // Discard if a newer render was triggered
        if (seq !== _playlistRenderSeq || !data) return;

        if (data.error) {
            document.getElementById('playlist-detail-name').textContent = 'Private Playlist';
            document.getElementById('playlist-detail-count').textContent = data.error;

            ['manage-playlist-btn', 'rename-playlist-btn', 'delete-playlist-btn', 'clone-playlist-btn', 'share-playlist-btn'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.classList.add('hidden');
            });

            return;
        }

        playlist = data.playlist;
        window.currentPlaylistId = playlist.id; // Store internal numeric ID for other API calls

        // Update URL hash to use share_id for privacy if we're currently showing a numeric ID
        if (playlist.share_id && window.location.hash === `#playlist-${playlist.id}`) {
            history.replaceState(null, '', `/home#playlist-${playlist.share_id}`);
        }

        // If offline, filter the returned songs to only those downloaded
        if (!navigator.onLine && window.OfflineStore) {
            const offlineSongs = await window.OfflineStore.getOfflineSongs();
            const offlineIds = new Set(offlineSongs.map(s => s.id));
            songs = data.songs.filter(s => offlineIds.has(s.id));
        } else {
            songs = data.songs;
            // Cache it for offline use!
            if (window.OfflineStore) {
                window.OfflineStore.savePlaylist(playlist, songs);
            }
        }

        document.getElementById('playlist-detail-name').childNodes[0].textContent = playlist.name + ' ';
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
        const durationStr = data.total_duration_formatted ? ` • ${data.total_duration_formatted}` : '';
        document.getElementById('playlist-detail-count').textContent = `${songs.length} song${songs.length !== 1 ? 's' : ''}${durationStr}`;

        // Handle Share Button
        const shareBtn = document.getElementById('share-playlist-btn');
        if (shareBtn && playlist.share_id) {
            const shareUrl = `${window.location.origin}/home?playlist=${playlist.share_id}`;
            shareBtn.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(shareUrl).then(() => {
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
        coverEl.dataset.playlistId = playlist.id;
        if (playlist.cover_url) {
            coverEl.style.backgroundImage = `url(${playlist.cover_url})`;
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
        const currentUsername = (appCache.user && appCache.user.username) ? appCache.user.username : (window.currentUser ? window.currentUser.username || window.currentUser : null);
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
        shuffledPlaylist = [...Array(currentPlaylist.length).keys()];

        currentPlaylist.forEach((song, index) => {
            const cover = song.cover || COVER_PLACEHOLDER;
            const title = escapeHTML(song.title);
            const artist = escapeHTML(song.artist);
            const album = escapeHTML(song.album);
            const uploadedBy = escapeHTML(song.uploaded_by);
            const duration = song.duration || '--:--';

            const row = document.createElement('div');
            row.className = 'song-row';
            if (isPlaylistEditMode) row.classList.add('edit-mode');
            if (selectedPlaylistSongIds.has(song.id)) row.classList.add('selected');
            row.dataset.id = song.id;
                        row.innerHTML = `
                <div class="index-cell">
                    <div class="select-indicator"></div>
                    <span class="row-index-number">${index + 1}</span>
                </div>
                <div class="song-info">
                    <img src="${cover}" alt="cover" class="song-cover-img">
                    <div>
                        <div class="song-title-row">${title}</div>
                        <div style="font-size: 12px;">${artist}</div>
                    </div>
                </div>
                <span>${album}</span>
                <span>${uploadedBy}</span>
                <span>${duration}</span>
                <div class="edit-btn-container song-row-actions">
                    <button class="row-download-btn" onclick="event.stopPropagation(); triggerDownload('${song.id}', this)"><i class='bx bx-download'></i></button>
                    <button class="playlist-remove-song-btn row-edit-btn" data-song-id="${song.id}" title="Remove from playlist">
                        <i class='bx bx-x'></i>
                    </button>
                </div>`;

            // Async offline check for individual song
            if (window.OfflineStore) {
                window.OfflineStore.isSongDownloaded(song.id).then(downloaded => {
                    if (downloaded) {
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
                removeSongFromPlaylist(playlistId, song.id).then(res => {
                    if (res.success) {
                        row.classList.add('deleting-anim');
                        setTimeout(() => renderPlaylistDetail(playlistId), 400);
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

            list.appendChild(row);
        });

        // Re-apply playing indicator after render
        highlightCurrentSong(list);
    } catch (err) {
        console.error('[RENDER PLAYLIST DETAIL]', err);
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

function removeSelectedPlaylistSongs() {
    if (selectedPlaylistSongIds.size === 0) return;
    const playlistId = window.currentPlaylistId;

    const ids = Array.from(selectedPlaylistSongIds);
    let done = 0, failed = 0;
    ids.forEach(songId => {
        removeSongFromPlaylist(playlistId, songId).then(res => {
            done++;
            if (!res.success) failed++;
            if (done === ids.length) {
                selectedPlaylistSongIds.clear();
                isPlaylistEditMode = false;
                const bar = document.getElementById('playlist-batch-bar');
                if (bar) bar.classList.add('hidden');
                const btn = document.getElementById('manage-playlist-btn');
                if (btn) { btn.classList.remove('active'); btn.innerHTML = "<i class='bx bx-pencil'></i>"; }
                renderPlaylistDetail(playlistId);
                fetchPlaylists(true);
            }
        });
    });
}

function showAddToPlaylistModal(songIdOrIds) {
    const modal = document.getElementById('add-to-playlist-modal');
    const list = document.getElementById('add-to-playlist-list');
    if (!modal || !list) return;

    const songIds = Array.isArray(songIdOrIds) ? songIdOrIds : [songIdOrIds];
    const isBulk = songIds.length > 1;

    list.innerHTML = '<p style="color:#b3b3b3; padding:15px; text-align:center;">Loading...</p>';
    modal.classList.remove('hidden');

    if (isBulk) {
        const titleEl = modal.querySelector('h3');
        if (titleEl) titleEl.textContent = `Add ${songIds.length} Songs to Playlist`;
    }

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
                item.addEventListener('click', () => {
                    item.disabled = true;
                    item.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i><span>${escapeHTML(p.name)}</span>`;

                    let added = 0, failed = 0, done = 0;
                    songIds.forEach(sid => {
                        addSongToPlaylist(p.id, sid).then(res => {
                            done++;
                            if (res.success) added++;
                            else failed++;
                            if (done === songIds.length) {
                                if (failed === 0) {
                                    item.innerHTML = `<i class='bx bx-check' style="color: var(--accent);"></i><span>${escapeHTML(p.name)}</span><span class="add-to-playlist-count">${p.song_count + added}</span>`;
                                    if (isBulk) clearLibrarySelection();
                                    setTimeout(() => modal.classList.add('hidden'), 800);
                                } else {
                                    item.innerHTML = `<i class='bx bx-check' style="color: var(--accent);"></i><span>${escapeHTML(p.name)}</span>`;
                                    item.disabled = false;
                                    if (added > 0) { if (isBulk) clearLibrarySelection(); setTimeout(() => modal.classList.add('hidden'), 1500); }
                                }
                                fetchPlaylists(true);
                            }
                        });
                    });
                });
                list.appendChild(item);
            });
        });
}

window.fetchPlaylists = fetchPlaylists;
window.renderPlaylistDetail = renderPlaylistDetail;
window.showAddToPlaylistModal = showAddToPlaylistModal;
window.togglePlaylistEditMode = togglePlaylistEditMode;
window.removeSelectedPlaylistSongs = removeSelectedPlaylistSongs;

// === REAL-TIME WEB SOCKETS ===
if (typeof io !== 'undefined') {
    socket = io(window.API_BASE_URL, { withCredentials: true });

    socket.on('new_post', () => {
        fetch(window.API_BASE_URL + '/api/posts', { credentials: 'include' })
            .then(r => r.json())
            .then(posts => {
                posts.reverse().forEach(post => {
                    if (!document.querySelector(`.post-card[data-id="${post.id}"]`)) {
                        const article = createPostElement(post);
                        document.getElementById('posts-container').prepend(article);
                    }
                });
            });
    });

    socket.on('post_deleted', (data) => {
        const postCard = document.querySelector(`.post-card[data-id="${data.postId}"]`);
        if (postCard) {
            postCard.classList.add('deleting-anim');
            setTimeout(() => postCard.remove(), 400);
        }
    });

    socket.on('update_likes', (data) => {
        const postCard = document.querySelector(`.post-card[data-id="${data.postId}"]`);
        if (postCard) {
            const span = postCard.querySelector('.like-btn span');
            if (span && parseInt(span.textContent) !== data.likes) {
                span.textContent = data.likes;
                span.style.animation = 'none';
                span.offsetHeight;
                span.style.animation = 'pulseAnim 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            }
        }
    });

    socket.on('new_comment', (data) => {
        const postCard = document.querySelector(`.post-card[data-id="${data.postId}"]`);
        if (postCard) {
            const span = postCard.querySelector('.comment-btn span');
            if (span && parseInt(span.textContent) !== data.comments) {
                span.textContent = data.comments;
                span.style.animation = 'none';
                span.offsetHeight;
                span.style.animation = 'pulseAnim 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            }
        }
        const cs = document.getElementById(`comments-${data.postId}`);
        if (cs && !cs.classList.contains('hidden')) {
            fetchComments(data.postId, true);
        }
    });

    socket.on('comment_deleted', (data) => {
        const postCard = document.querySelector(`.post-card[data-id="${data.postId}"]`);
        if (postCard) {
            const span = postCard.querySelector('.comment-btn span');
            if (span && parseInt(span.textContent) !== data.comments) {
                span.textContent = data.comments;
                span.style.animation = 'none';
                span.offsetHeight;
                span.style.animation = 'pulseAnim 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            }
        }
        const cEl = document.querySelector(`.comment-item[data-id="${data.commentId}"]`);
        if (cEl) {
            cEl.classList.add('deleting-anim');
            setTimeout(() => cEl.remove(), 400);
        }
    });

    socket.on('new_notification', () => {
        fetchNotifications();
    });
}

// togglePostMenu is defined earlier (line ~1070) — CSS handles positioning via
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

    // Clear old profile content immediately to prevent stale data flash
    const nameEl = document.getElementById('profile-name');
    const handleEl = document.getElementById('profile-handle');
    const bioEl = document.getElementById('profile-bio');
    const avatarEl = document.getElementById('profile-avatar');
    const bannerEl = document.getElementById('profile-banner');
    if (nameEl) nameEl.textContent = 'Loading...';
    if (handleEl) handleEl.textContent = '';
    if (bioEl) bioEl.textContent = '';
    if (avatarEl) { avatarEl.innerHTML = ''; avatarEl.style.backgroundImage = 'linear-gradient(45deg, #4169e1, #8b5cf6)'; }
    if (bannerEl) { bannerEl.style.background = ''; bannerEl.style.backgroundImage = 'none'; }
    const backdropEl = document.getElementById('profile-banner-backdrop');
    if (backdropEl) backdropEl.style.backgroundImage = 'none';

    const postsContainer = document.getElementById('profile-posts-container');
    if (postsContainer) postsContainer.innerHTML = '';
    const playlistsContainer = document.getElementById('profile-playlists-container');
    if (playlistsContainer) playlistsContainer.innerHTML = '';

    try {
        const response = await fetch(`/api/profile/${username}`);
        if (!response.ok) throw new Error("Profile not found");
        const data = await response.json();
        // Discard if a newer profile render was triggered
        if (seq !== _profileRenderSeq) return;
        renderDetailedProfile(data);
    } catch (err) {
        console.error("Fetch Profile Error:", err);
        showToast("Failed to load profile.", 'error');
        if (typeof showSection === 'function') {
            // Fallback to home if profile fails
            const homeLink = document.getElementById('home-link');
            if (homeLink) homeLink.click();
        }
    }
}

function renderDetailedProfile(data) {
    const { user, posts, playlists } = data;
    document.title = `Streamify | ${user.display_name || user.username}'s Profile`;

    const nameEl = document.getElementById('profile-name');
    const handleEl = document.getElementById('profile-handle');
    const bioEl = document.getElementById('profile-bio');
    const avatarEl = document.getElementById('profile-avatar');
    const bannerEl = document.getElementById('profile-banner');

    if (nameEl) nameEl.textContent = user.display_name || user.username;
    if (handleEl) handleEl.textContent = `@${user.username}`;
    if (bioEl) bioEl.textContent = user.bio || "No bio yet.";

    if (user.avatar) {
        avatarEl.innerHTML = `<img src="${escapeHTML(user.avatar)}" alt="avatar" style="width:100%;height:100%;object-fit:cover;object-position:center;border-radius:50%;">`;
    } else {
        avatarEl.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
        avatarEl.style.backgroundImage = 'linear-gradient(135deg, var(--gradient-1), var(--gradient-2))';
        avatarEl.style.backgroundSize = '';
        avatarEl.style.backgroundPosition = '';
    }

    if (user.banner) {
        bannerEl.style.background = `url('${safeStyleURL(user.banner)}') center / cover no-repeat`;        /* Set the blurred backdrop to the same image */
        const backdropEl = document.getElementById('profile-banner-backdrop');
        if (backdropEl) backdropEl.style.backgroundImage = `url('${safeStyleURL(user.banner)}')`;
        // Re-scroll after banner image loads to prevent layout shift
        const img = new Image();
        img.onload = () => {
            const mainContent = document.querySelector('.main-content');
            if (mainContent) mainContent.scrollTop = 0;
            window.scrollTo(0, 0);
        };
        img.src = user.banner;
    } else {
        bannerEl.style.background = '';
        bannerEl.style.backgroundImage = 'none';
        /* Clear backdrop */
        const backdropEl = document.getElementById('profile-banner-backdrop');
        if (backdropEl) backdropEl.style.backgroundImage = 'none';
    }

    // Reset edit buttons
    document.getElementById('edit-banner-btn').classList.add('hidden');
    document.getElementById('edit-avatar-btn').classList.add('hidden');

    // Check ownership
    if (appCache.user && appCache.user.username === user.username) {
        document.getElementById('edit-banner-btn').classList.remove('hidden');
        document.getElementById('edit-avatar-btn').classList.remove('hidden');
        setupProfileUploadHandlers();
    }

    renderProfilePosts(posts);
    renderProfilePlaylists(playlists);
    // Force top after rendering all content — double rAF ensures layout settles
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const mainContent = document.querySelector('.main-content');
            if (mainContent) mainContent.scrollTop = 0;
            window.scrollTo(0, 0);
        });
    });
}

function renderProfilePosts(posts) {
    const container = document.getElementById('profile-posts-container');
    if (!container) return;
    container.innerHTML = "";

    if (posts.length === 0) {
        container.innerHTML = `<p class="loading-text" style="opacity: 0.5; padding: 20px; text-align: center;">This user hasn't posted anything yet.</p>`;
        return;
    }

    posts.forEach(post => {
        const postElement = createPostElement(post);
        container.appendChild(postElement);
    });
}

function renderProfilePlaylists(playlists) {
    const container = document.getElementById('profile-playlists-container');
    if (!container) return;

    container.innerHTML = "";

    if (!playlists || playlists.length === 0) {
        const emptyMsg = document.createElement('p');
        emptyMsg.className = 'loading-text';
        emptyMsg.style.cssText = 'opacity: 0.5; padding: 20px; text-align: center; grid-column: 1 / -1;';
        emptyMsg.textContent = 'No public playlists found.';
        container.appendChild(emptyMsg);
        return;
    }

    playlists.forEach(playlist => {
        const card = document.createElement('div');
        card.className = 'playlist-card';
        card.innerHTML = `
            <div class="playlist-cover">
                <img src="${escapeHTML(playlist.cover_url || COVER_PLACEHOLDER)}" alt="cover" onerror="this.onerror=null; this.src=COVER_PLACEHOLDER;">
                <div class="playlist-overlay">
                    <button class="playlist-play-btn"><i class='bx bx-show'></i></button>
                </div>
            </div>
            <div class="playlist-info">
                <h4>${escapeHTML(playlist.name)}</h4>
                <p>${playlist.song_count} songs</p>
            </div>
        `;

        card.onclick = () => {
            if (typeof window.navigateToPlaylist === 'function') {
                window.navigateToPlaylist(playlist.id);
            }
        };

        container.appendChild(card);
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
    const reader = new FileReader();
    reader.onload = (e) => {
        const modal = document.getElementById('crop-modal');
        const img = document.getElementById('crop-image');
        const applyBtn = document.getElementById('save-crop-btn');

        img.src = e.target.result;
        modal.classList.remove('hidden');

        // We use the existing cropper logic in ui.js or create a new one if needed
        // For banner, we explicitly need 3/1 ratio
        if (window.currentCropper) window.currentCropper.destroy();

        window.currentCropper = new Cropper(img, {
            aspectRatio: type === 'banner' ? 3 / 1 : 1 / 1,
            viewMode: 1,
            dragMode: 'move',
            background: false
        });

        applyBtn.onclick = () => {
            const canvas = window.currentCropper.getCroppedCanvas({
                width: type === 'banner' ? 1500 : 512,
                height: type === 'banner' ? 500 : 512
            });

            canvas.toBlob((blob) => {
                const finalFile = new File([blob], "photo.jpg", { type: "image/jpeg" });
                uploadProfileFile(finalFile, type);
                modal.classList.add('hidden');
            }, 'image/jpeg');
        };
    };
    reader.readAsDataURL(file);
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
            // refresh profile data instead of reload
            const pathParts = window.location.pathname.split('/');
            const username = pathParts[pathParts.length - 1];
            fetchDetailedProfile(username);
        } else {
            showToast(result.error || "Upload failed", 'error');
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
    const mainContent = document.querySelector('.main-content');
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
        window.scrollTo({ top: 0, behavior: 'smooth' });

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
            // Clear user hash if exists
            if (window.location.hash && window.location.hash.startsWith('#user-')) {
                history.pushState({ view: 'home' }, '', '/home');
            }

            const lastView = window.lastViewBeforeProfile || 'home';
            if (lastView === 'people') {
                document.getElementById('people-link').click();
            } else if (lastView === 'library') {
                document.getElementById('library-link').click();
            } else if (lastView === 'post' && window.profileContextPostId) {
                if (typeof navigateToPost === 'function') navigateToPost(window.profileContextPostId);
            } else if (lastView === 'search') {
                // If we came from search, we stay in the search view
                // Triggering home-link might clear search, so we just toggle visibility
                // or easier: if search input has value, it's a search
                const searchSection = document.getElementById('search-section');
                if (searchSection) {
                    if (typeof window.hideAllSections === 'function') window.hideAllSections();
                    if (typeof window.showSection === 'function') window.showSection(searchSection);
                    window.currentActiveView = 'search';
                    document.title = "Streamify | Search";
                } else {
                    document.getElementById('home-link').click();
                }
            } else {
                document.getElementById('home-link').click();
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
            // New conversation — need full refresh
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
            body: JSON.stringify({ enabled })
        });
        if (!res.ok) throw new Error("Failed to update settings");
        showToast("Privacy settings updated.", "success");
    } catch (e) {
        console.error(e);
        showToast("Failed to update privacy settings.", "error");
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
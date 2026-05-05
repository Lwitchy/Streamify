/**
 * ============================================================================
 * STREAMIFY — ui.js
 * ============================================================================
 * DOM initialization, sidebar navigation, modals, search box,
 * mobile menu, avatar upload, and logout.
 * Must be loaded LAST so it can call functions from all other modules.
 * ============================================================================
 */

document.addEventListener('DOMContentLoaded', () => {

    /* ===================================================
     * PWA Service Worker Registration
     * =================================================== */
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js?v=2.2')
            .then(reg => console.log('[SW] Registered successfully:', reg.scope))
            .catch(err => console.error('[SW] Registration failed:', err));
    }

    /* ===================================================
     * OFFLINE MODE MANAGEMENT
     * =================================================== */
    function handleOfflineMode() {
        if (!navigator.onLine) {
            document.body.classList.add('offline-mode');
            showToast('You are offline. Switching to Offline Library.', 'warning');

            // Disable other links
            ['home-link', 'people-link', 'upload-link', 'about-link'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.style.pointerEvents = 'none';
                    el.style.opacity = '0.5';
                }
            });

            // Disable user-pill
            const userPill = document.querySelector('.user-pill');
            if (userPill) {
                userPill.style.pointerEvents = 'none';
                userPill.style.opacity = '0.5';
            }

            // Disable manage library button since we can't edit songs offline
            const manageBtn = document.getElementById('manage-library-btn');
            if (manageBtn) {
                manageBtn.style.pointerEvents = 'none';
                manageBtn.style.opacity = '0.5';
            }
            if (typeof isLibraryEditMode !== 'undefined' && isLibraryEditMode && typeof clearLibrarySelection === 'function') {
                clearLibrarySelection();
            }

            // Switch to library
            if (document.getElementById('library-link')) {
                document.getElementById('library-link').click();
            }

            // Load offline songs
            if (window.OfflineStore && typeof renderSongList !== 'undefined') {
                window.OfflineStore.getOfflineSongs().then(songs => {
                    const list = document.getElementById('trending-list');
                    if (list) {
                        renderSongList(songs, list);
                    }
                });
            }

            // Load cached profile
            if (window.OfflineStore) {
                window.OfflineStore.getCachedUserProfile().then(profile => {
                    if (profile && typeof renderUserUI !== 'undefined') {
                        renderUserUI({ username: profile.username, avatar: profile.avatarUrl });
                    }
                });
            }

        } else {
            document.body.classList.remove('offline-mode');
            showToast('You are back online.', 'success');

            // Re-enable links
            ['home-link', 'people-link', 'upload-link', 'about-link'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.style.pointerEvents = 'auto';
                    el.style.opacity = '1';
                }
            });

            // Re-enable user-pill
            const userPill = document.querySelector('.user-pill');
            if (userPill) {
                userPill.style.pointerEvents = 'auto';
                userPill.style.opacity = '1';
            }

            // Re-enable manage library button
            const manageBtn = document.getElementById('manage-library-btn');
            if (manageBtn) {
                manageBtn.style.pointerEvents = 'auto';
                manageBtn.style.opacity = '1';
            }

            // Trigger fetch refresh
            if (typeof fetchLibrary === 'function') fetchLibrary();
            if (typeof fetchPosts === 'function') {
                const postsContainer = document.getElementById('posts-container');
                if (postsContainer && (postsContainer.innerHTML.includes('Error') || postsContainer.children.length === 0 || window.currentActiveView === 'home')) {
                    if (postsContainer.innerHTML.includes('Error') || postsContainer.children.length === 0) {
                        postsContainer.innerHTML = '<div class="loader"></div>';
                    }
                    fetchPosts(false);
                }
            }
        }
    }

    window.addEventListener('offline', handleOfflineMode);
    window.addEventListener('online', handleOfflineMode);

    // Initial check
    if (!navigator.onLine) {
        handleOfflineMode();
    }


    /* ===================================================
     * LOGOUT
     * POST /logout → clear session → redirect to /login
     * =================================================== */
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', e => {
            e.preventDefault();
            fetch(window.API_BASE_URL + '/logout', { method: 'POST', credentials: 'include' })
                .then(r => r.json())
                .then(() => { window.location.href = '/login'; })
                .catch(() => { window.location.href = '/login'; }); // fail-safe redirect
        });
    }

    /* ===================================================
     * USER MENU DROPDOWN
     * =================================================== */
    const userPill = document.querySelector('.user-pill');
    const userMenu = document.getElementById('user-menu');
    const notifPill = document.querySelector('.notif-pill');
    const notifMenu = document.getElementById('notification-menu');

    if (notifPill && notifMenu) {
        notifPill.addEventListener('click', e => {
            e.stopPropagation();
            if (userMenu) userMenu.classList.remove('show');
            const becomingVisible = !notifMenu.classList.contains('show');
            notifMenu.classList.toggle('show');
            if (becomingVisible && typeof markNotificationsAsRead === 'function') markNotificationsAsRead();
        });
    }
    if (userPill && userMenu) {
        userPill.addEventListener('click', e => {
            e.stopPropagation();
            if (notifMenu) notifMenu.classList.remove('show');
            userMenu.classList.toggle('show');
        });
    }

    document.addEventListener('click', e => {
        if (userMenu && userMenu.classList.contains('show') && !userMenu.contains(e.target) && !userPill.contains(e.target)) userMenu.classList.remove('show');
        if (notifMenu && notifMenu.classList.contains('show') && !notifMenu.contains(e.target) && !notifPill.contains(e.target)) notifMenu.classList.remove('show');
    });

    /* ===================================================
     * PROFILE MODAL
     * =================================================== */
    const profileBtn = document.getElementById('open-profile-btn');
    const profileModal = document.getElementById('profile-modal');
    const closeProfileBtn = document.getElementById('close-profile-modal-btn');

    const closeProfileModal = () => profileModal && profileModal.classList.add('hidden');

    if (profileBtn) {
        profileBtn.addEventListener('click', e => {
            e.preventDefault();
            clearUserProfile();
            fetchCurrentUser();
            userMenu.classList.remove('show');
            profileModal.classList.remove('hidden');
        });
    }
    if (closeProfileBtn) closeProfileBtn.addEventListener('click', closeProfileModal);
    if (profileModal) profileModal.addEventListener('click', e => { if (e.target === profileModal) closeProfileModal(); });


    /* ===================================================
     * SETTINGS MODAL (Tabbed)
     * =================================================== */
    const settingsBtn = document.getElementById('open-settings-btn');
    const settingsModal = document.getElementById('settings-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const settingsTabs = document.querySelectorAll('.settings-tab');
    const settingsPanes = document.querySelectorAll('.settings-pane');

    const openSettings = () => {
        if (!appCache.user) {
            fetchCurrentUser(true);
        }
        userMenu.classList.remove('show');
        settingsModal.classList.remove('hidden');
        populateSettings();
    };

    const closeSettings = () => settingsModal && settingsModal.classList.add('hidden');

    const populateSettings = () => {
        if (!appCache.user) return;
        const dispNameInput = document.getElementById('settings-display-name');
        const bioInput = document.getElementById('settings-bio');
        const preview = document.getElementById('settings-avatar-preview');
        const analyticsToggle = document.getElementById('allow-analytics-toggle');

        dispNameInput.value = appCache.user.display_name || appCache.user.username;
        bioInput.value = appCache.user.bio || "";

        if (analyticsToggle) {
            analyticsToggle.checked = appCache.user.allow_analytics !== false;
        }

        if (appCache.user.avatar) {
            preview.style.backgroundImage = `url('${safeStyleURL(appCache.user.avatar)}')`;
            preview.style.backgroundSize = 'cover';
            preview.style.backgroundPosition = 'center';
            preview.textContent = '';
        } else {
            preview.style.backgroundImage = 'none';
            preview.textContent = appCache.user.username.charAt(0).toUpperCase();
        }
    };

    if (settingsBtn) settingsBtn.addEventListener('click', e => { e.preventDefault(); openSettings(); });
    if (closeModalBtn) closeModalBtn.addEventListener('click', closeSettings);
    if (settingsModal) settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });

    // Tab Switching
    settingsTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            settingsTabs.forEach(t => t.classList.remove('active'));
            settingsPanes.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const pane = document.getElementById(`pane-${target}`);
            if (pane) {
                pane.classList.add('active');
                if (target === 'account') loadSessions();
                if (target === 'storage') loadStorage();
            }
        });
    });

    async function loadStorage() {
        const textEl = document.getElementById('settings-storage-text');
        const barEl = document.getElementById('settings-storage-bar');
        if (!textEl || !barEl || !appCache.user) return;

        try {
            // Re-fetch /me to get fresh storage stats
            const res = await fetch(window.API_BASE_URL + '/api/me');
            if (res.ok) {
                const data = await res.json();
                appCache.user = data; // update cache

                const usedMB = (data.storage_used / (1024 * 1024)).toFixed(1);
                const limitMB = (data.storage_limit / (1024 * 1024)).toFixed(0);
                textEl.textContent = `${usedMB} MB / ${limitMB} MB`;
                
                let percentage = (data.storage_used / data.storage_limit) * 100;
                if (percentage > 100) percentage = 100;
                
                barEl.style.width = `${percentage}%`;
                
                // Tiered coloring: Blue < 50%, Yellow 50-85%, Red > 85%
                if (percentage < 50) {
                    barEl.style.background = '#4169e1'; // Blue
                    textEl.style.color = '#4169e1';
                } else if (percentage < 85) {
                    barEl.style.background = '#f59e0b'; // Yellow
                    textEl.style.color = '#f59e0b';
                } else {
                    barEl.style.background = '#e74c3c'; // Red
                    textEl.style.color = '#e74c3c';
                }
            }
        } catch (e) {
            console.error('[LOAD STORAGE]', e);
        }
    }

    async function loadSessions() {
        const container = document.getElementById('devices-list');
        if (!container) return;

        try {
            const sessions = await fetchSessions();
            renderSessions(sessions, container);
        } catch (err) {
            console.error('[LOAD SESSIONS]', err); // keep: critical error path
            container.innerHTML = '<p style="color:red; font-size:12px; text-align:center;">Failed to load sessions.</p>';
        }
    }

    function renderSessions(sessions, container) {
        container.innerHTML = '';
        if (!sessions || sessions.length === 0) {
            container.innerHTML = '<p style="color:#666; font-size:12px; text-align:center;">No active sessions found.</p>';
            return;
        }

        // We assume the first session in the list (or the one matching our cookie) is "This Device"
        // Since we don't have the exact ID here easily without a separate /me call, 
        // we'll just check if we can find a way to identify it or just show the list.
        // Actually, the server could flag it, but for now we'll just show them.

        sessions.forEach(s => {
            const item = document.createElement('div');
            item.className = 'device-item';

            const icon = getDeviceIcon(s.os);
            const date = new Date(s.created_at).toLocaleDateString();

            item.innerHTML = `
                <div class="device-info">
                    <div class="device-icon-container">
                        <i class='bx ${icon}'></i>
                    </div>
                    <div class="device-details">
                        <div class="device-name">${s.browser} on ${s.os}</div>
                        <div class="device-meta">${s.ip} • Started ${date}</div>
                    </div>
                </div>
                <button class="device-logout-btn" data-id="${s.id}">
                    <i class='bx bx-log-out'></i>
                </button>
            `;

            const logoutBtn = item.querySelector('.device-logout-btn');
            logoutBtn.onclick = async () => {
                logoutBtn.disabled = true;
                try {
                    const res = await revokeSession(s.id);
                    if (res.success) {
                        item.classList.add('fade-out');
                        setTimeout(() => item.remove(), 300);
                    } else {
                        showToast(res.error || 'Failed to revoke session', 'error');
                        logoutBtn.disabled = false;
                    }
                } catch (err) {
                    console.error(err);
                    showToast('Connection error', 'error');
                    logoutBtn.disabled = false;
                }
            };

            container.appendChild(item);
        });
    }

    function getDeviceIcon(os) {
        os = os.toLowerCase();
        if (os.includes('windows')) return 'bxl-windows';
        if (os.includes('macos') || os.includes('ios')) return 'bxl-apple';
        if (os.includes('android')) return 'bxl-android';
        if (os.includes('linux')) return 'bxl-tux';
        return 'bx-devices';
    }

    const settingsToggle = document.getElementById('settings-menu-toggle');
    const settingsSidebar = document.querySelector('.settings-sidebar');
    const settingsOverlay = document.getElementById('settings-overlay');

    const toggleSettingsMenu = (show) => {
        if (settingsSidebar) settingsSidebar.classList.toggle('mobile-active', show);
        if (settingsOverlay) settingsOverlay.classList.toggle('active', show);
    };

    if (settingsToggle && settingsSidebar) {
        settingsToggle.addEventListener('click', e => {
            e.stopPropagation();
            const isClosing = settingsSidebar.classList.contains('mobile-active');
            toggleSettingsMenu(!isClosing);
        });

        document.addEventListener('click', e => {
            if (settingsSidebar.classList.contains('mobile-active') &&
                !settingsSidebar.contains(e.target) &&
                !settingsToggle.contains(e.target)) {
                toggleSettingsMenu(false);
            }
        });

        if (settingsOverlay) {
            settingsOverlay.addEventListener('click', () => toggleSettingsMenu(false));
        }

        settingsTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                if (window.innerWidth <= 768) toggleSettingsMenu(false);
            });
        });
    }

    // Profile Form Submission
    const profileForm = document.getElementById('profile-form');
    if (profileForm) {
        profileForm.addEventListener('submit', async e => {
            e.preventDefault();
            const btn = profileForm.querySelector('button[type="submit"]');
            const originalText = btn.textContent;

            const dispName = document.getElementById('settings-display-name').value.trim();
            const bio = document.getElementById('settings-bio').value.trim();

            btn.disabled = true;
            btn.textContent = 'Saving...';

            try {
                const res = await updateProfile(dispName, bio);
                if (res.success) {
                    fetchCurrentUser(true); // Refresh user cache
                    if (typeof fetchPeople === 'function') fetchPeople(true); // Refresh people cache if available
                } else {
                    showToast(res.error || 'Failed to update profile', 'error');
                }
            } catch (err) {
                console.error(err);
                showToast('Connection error', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });
    }

    // Password Form Submission
    const passwordForm = document.getElementById('password-form');
    if (passwordForm) {
        passwordForm.addEventListener('submit', async e => {
            e.preventDefault();
            const oldPass = document.getElementById('old-password').value;
            const newPass = document.getElementById('new-password').value;
            const confirmPass = document.getElementById('confirm-new-password').value;

            if (newPass !== confirmPass) {
                showToast("Passwords don't match", 'error');
                return;
            }

            const btn = passwordForm.querySelector('button[type="submit"]');
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Updating...';

            try {
                const res = await changePassword(oldPass, newPass);
                if (res.success) {
                    showToast('Password updated successfully', 'success');
                    passwordForm.reset();
                    // Refresh the devices list since others are invalidated
                    if (typeof loadSessions === 'function') {
                        loadSessions();
                    }
                } else {
                    showToast(res.error || 'Failed to update password', 'error');
                }
            } catch (err) {
                console.error(err);
                showToast('Connection error', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });
    }

    // Logout from other devices
    const logoutOthersBtn = document.getElementById('logout-others-btn');
    if (logoutOthersBtn) {
        logoutOthersBtn.addEventListener('click', async () => {
            const originalContent = logoutOthersBtn.innerHTML;
            logoutOthersBtn.disabled = true;
            logoutOthersBtn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Logging out...";

            try {
                const res = await logoutOthers();
                if (res.success) {
                    showToast('Successfully logged out from all other devices.', 'success');
                    // Refresh the devices list
                    if (typeof loadSessions === 'function') {
                        loadSessions();
                    }
                } else {
                    showToast(res.error || 'Failed to logout from other devices', 'error');
                }
            } catch (err) {
                console.error(err);
                showToast('Connection error', 'error');
            } finally {
                logoutOthersBtn.disabled = false;
                logoutOthersBtn.innerHTML = originalContent;
            }
        });
    }

    // Privacy Settings
    const analyticsToggle = document.getElementById('allow-analytics-toggle');
    if (analyticsToggle) {
        analyticsToggle.addEventListener('change', async (e) => {
            if (typeof setAnalyticsEnabled === 'function') {
                await setAnalyticsEnabled(e.target.checked);
                // Optimistically update cache
                if (appCache.user) appCache.user.allow_analytics = e.target.checked;
            }
        });
    }

    const downloadDataBtn = document.getElementById('download-data-btn');
    if (downloadDataBtn) {
        downloadDataBtn.addEventListener('click', () => {
            window.location.href = window.API_BASE_URL + '/api/settings/privacy/export';
        });
    }

    /* ===================================================
     * AVATAR CROP & UPLOAD
     * =================================================== */
    const avatarInput = document.getElementById('avatar-upload');
    const triggerBtn = document.getElementById('trigger-upload-btn');
    const cropModal = document.getElementById('crop-modal');
    const cropImage = document.getElementById('crop-image');
    const applyCropBtn = document.getElementById('save-crop-btn');
    const cancelCropBtn = document.getElementById('cancel-crop-btn');
    const closeCropBtn = document.getElementById('close-crop-btn');

    let cropper = null;

    if (triggerBtn && avatarInput) triggerBtn.addEventListener('click', () => avatarInput.click());

    if (avatarInput) {
        avatarInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                cropImage.src = event.target.result;
                cropModal.classList.remove('hidden');

                if (cropper) cropper.destroy();
                cropper = new Cropper(cropImage, {
                    aspectRatio: 1,
                    viewMode: 2,
                    dragMode: 'move',
                    background: false,
                    autoCropArea: 1,
                    responsive: true
                });
            };
            reader.readAsDataURL(file);
        });
    }

    const closeCrop = () => {
        cropModal.classList.add('hidden');
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }
        avatarInput.value = '';
    };

    if (cancelCropBtn) cancelCropBtn.addEventListener('click', closeCrop);
    if (closeCropBtn) closeCropBtn.addEventListener('click', closeCrop);

    if (applyCropBtn) {
        applyCropBtn.addEventListener('click', () => {
            if (!cropper) return;

            applyCropBtn.disabled = true;
            applyCropBtn.textContent = 'Processing...';

            cropper.getCroppedCanvas({
                width: 400,
                height: 400
            }).toBlob((blob) => {
                const formData = new FormData();
                formData.append('avatar_file', blob, 'avatar.png');

                fetch(window.API_BASE_URL + '/api/upload-avatar', {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                })
                    .then(r => {
                        if (r.ok) {
                            showToast('Avatar updated!', 'success');
                            closeCrop();
                            fetchCurrentUser(true); // Refresh cache + UI
                            populateSettings(); // Update preview in settings modal
                        } else {
                            showToast('Upload failed', 'error');
                        }
                    })
                    .catch(err => {
                        console.error(err);
                        showToast('Error uploading avatar', 'error');
                    })
                    .finally(() => {
                        applyCropBtn.disabled = false;
                        applyCropBtn.textContent = 'Apply Crop';
                    });
            }, 'image/png');
        });
    }

    /* ===================================================
     * SIDEBAR NAVIGATION
     * =================================================== */
    const homeLink = document.getElementById('home-link');
    const libraryLink = document.getElementById('library-link');
    const peopleLink = document.getElementById('people-link');
    const uploadLink = document.getElementById('upload-link');
    const aboutLink = document.getElementById('about-link');
    const thanksLink = document.getElementById('thanks-link');
    const sidebarLogo = document.querySelector('.morph-logo');

    if (sidebarLogo && homeLink) {
        sidebarLogo.style.cursor = 'pointer';
        sidebarLogo.addEventListener('click', () => {
            homeLink.click();
        });
    }

    // Global view state for refreshes
    window.currentActiveView = 'home';


    const feedSection = document.getElementById('feed-section');
    const trendingSection = document.getElementById('trending-section');
    const peopleSection = document.getElementById('people-section');
    const uploadSection = document.getElementById('upload-section');
    const searchSection = document.getElementById('search-section');
    const aboutSection = document.getElementById('about-section');
    const profileDetailSection = document.getElementById('profile-detail-section');
    const postDetailSection = document.getElementById('post-detail-section');
    const playlistDetailSection = document.getElementById('playlist-detail-section');
    const dmSection = document.getElementById('dm-section');
    const playerSection = document.getElementById('player-section'); // Added player section reference

    function showSection(section) {
        if (!section) return;
        
        // Ensure Owner-only cards are visible when needed
        if (section === uploadSection) {
            const spotifyCard = document.getElementById('spotify-import-card');
            if (spotifyCard && appCache.user && appCache.user.role === 'Owner') {
                spotifyCard.classList.remove('hidden');
            }
        }
        
        section.classList.remove('hidden', 'fade-in-animate');
        void section.offsetWidth;
        section.classList.add('fade-in-animate');
    }

    function hideAllSections() {
        [feedSection, trendingSection, peopleSection, uploadSection, searchSection, aboutSection, profileDetailSection, postDetailSection, playlistDetailSection, dmSection, playerSection].forEach(sec => {
            if (sec) { sec.classList.add('hidden'); sec.classList.remove('fade-in-animate'); }
        });
        document.querySelector('.main-content')?.classList.remove('no-scroll');
        document.body.classList.remove('dm-open');
        document.body.classList.remove('player-section-active'); // ensure bottom player reappears when navigating away
        [homeLink, libraryLink, peopleLink, uploadLink, aboutLink].forEach(l => l && l.classList.remove('active'));
        document.querySelectorAll('.sidebar-playlist-link').forEach(l => l.classList.remove('active'));
        // Reset edit modes on view switch to prevent stale UI state
        if (typeof isLibraryEditMode !== 'undefined' && isLibraryEditMode) {
            isLibraryEditMode = false;
            selectedSongIds.clear();
            const btn = document.getElementById('manage-library-btn');
            const bar = document.getElementById('batch-actions-bar');
            if (btn) { btn.classList.remove('active'); btn.innerHTML = "<i class='bx bx-pencil'></i>"; }
            if (bar) bar.classList.add('hidden');
        }
        if (typeof isPlaylistEditMode !== 'undefined' && isPlaylistEditMode) {
            isPlaylistEditMode = false;
            selectedPlaylistSongIds.clear();
            const pBtn = document.getElementById('manage-playlist-btn');
            const pBar = document.getElementById('playlist-batch-bar');
            if (pBtn) { pBtn.classList.remove('active'); pBtn.innerHTML = "<i class='bx bx-pencil'></i>"; }
            if (pBar) pBar.classList.add('hidden');
        }
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.scrollTop = 0;
        window.scrollTo(0, 0);
    }

    // Export navigation helpers for api.js
    window.hideAllSections = hideAllSections;
    window.showSection = showSection;

    if (homeLink) {
        homeLink.addEventListener('click', e => {
            e.preventDefault();
            if (window.location.pathname !== '/home' || window.location.hash !== '#feed') {
                history.pushState({ view: 'home' }, '', '/home#feed');
            }
            window.currentActiveView = 'home';
            hideAllSections();
            homeLink.classList.add('active');
            showSection(feedSection);
            document.title = "Streamify | Home";

            // Retry fetching posts if it previously failed or is empty
            const postsContainer = document.getElementById('posts-container');
            if (navigator.onLine && postsContainer && (postsContainer.innerHTML.includes('Error') || postsContainer.children.length === 0) && typeof fetchPosts === 'function') {
                postsContainer.innerHTML = '<div class="loader"></div>';
                fetchPosts(false);
            }

            // Restore scroll position if coming back from another view
            const mainContent = document.querySelector('.main-content');
            if (mainContent && window.savedScrollPosition !== undefined) {
                mainContent.scrollTop = window.savedScrollPosition;
                window.savedScrollPosition = undefined;
            }
        });
    }

    if (libraryLink) {
        libraryLink.addEventListener('click', e => {
            e.preventDefault();
            if (window.location.pathname !== '/home' || window.location.hash !== '#library') {
                history.pushState({ view: 'library' }, '', '/home#library');
            }
            window.currentActiveView = 'library';
            hideAllSections();
            libraryLink.classList.add('active');
            showSection(trendingSection);
            fetchLibrary();
            document.title = "Streamify | Library";
        });
    }

    if (peopleLink) {
        peopleLink.addEventListener('click', e => {
            e.preventDefault();
            if (window.location.pathname !== '/home' || window.location.hash !== '#people') {
                history.pushState({ view: 'people' }, '', '/home#people');
            }
            window.currentActiveView = 'people';
            hideAllSections();
            peopleLink.classList.add('active');
            showSection(peopleSection);
            fetchPeople();
        });
    }

    if (uploadLink) {
        uploadLink.addEventListener('click', e => {
            e.preventDefault();
            if (window.location.pathname !== '/home' || window.location.hash !== '#upload') {
                history.pushState({ view: 'upload' }, '', '/home#upload');
            }
            window.currentActiveView = 'upload';
            hideAllSections();
            uploadLink.classList.add('active');
            showSection(uploadSection);
        });
    }

    if (aboutLink) {
        aboutLink.addEventListener('click', e => {
            e.preventDefault();
            if (window.location.pathname !== '/home' || window.location.hash !== '#about') {
                history.pushState({ view: 'about' }, '', '/home#about');
            }
            window.currentActiveView = 'about';
            hideAllSections();
            aboutLink.classList.add('active');
            showSection(aboutSection);
        });
    }

    /* Thanks glow effect */
    if (thanksLink) {
        thanksLink.addEventListener('click', e => {
            e.preventDefault();
            thanksLink.classList.remove('glow-active');
            void thanksLink.offsetWidth;
            thanksLink.classList.add('glow-active');
            setTimeout(() => thanksLink.classList.remove('glow-active'), 2000);
        });
    }

    /* ===================================================
     * SEARCH BOX
     * =================================================== */
    const searchInput = document.getElementById('gsearch');
    let searchTimeout = null;

    if (searchInput) {
        searchInput.addEventListener('input', e => {
            const query = e.target.value.trim();
            if (searchTimeout) clearTimeout(searchTimeout);
            if (query.length > 0) {
                searchTimeout = setTimeout(() => {
                    window.currentActiveView = 'search';
                    hideAllSections();
                    showSection(searchSection);
                    performSearch(query);
                }, 500);
            } else {
                if (homeLink) homeLink.click();
            }
        });

        searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                if (searchTimeout) clearTimeout(searchTimeout);
                const query = searchInput.value.trim();
                hideAllSections();
                showSection(searchSection);
                performSearch(query);
            }
        });
    }

    /* ===================================================
     * MOBILE SIDEBAR TOGGLE
     * =================================================== */
    const menuBtn = document.getElementById('menu-btn');
    const sidebar = document.querySelector('.sidebar');

    if (menuBtn && sidebar) {
        menuBtn.addEventListener('click', e => { e.stopPropagation(); sidebar.classList.toggle('mobile-active'); });
        document.addEventListener('click', e => {
            if (sidebar.classList.contains('mobile-active') && !sidebar.contains(e.target) && !menuBtn.contains(e.target))
                sidebar.classList.remove('mobile-active');
        });
        sidebar.querySelectorAll('a').forEach(link => link.addEventListener('click', () => sidebar.classList.remove('mobile-active')));
        // Event delegation for dynamically added links (playlists)
        sidebar.addEventListener('click', e => {
            if (e.target.closest('a')) sidebar.classList.remove('mobile-active');
        });
    }

    /* ===================================================
     * POST COMPOSER
     * =================================================== */
    const postBtn = document.getElementById('post-btn');
    const postTextarea = document.getElementById('compose-textarea');
    const addPhotoBtn = document.getElementById('add-photo-btn');
    const photoInput = document.getElementById('feed-photo-upload');
    const photoPreview = document.getElementById('compose-photo-preview');
    const previewImg = document.getElementById('compose-photo-img');
    const removePhotoBtn = document.getElementById('remove-photo-btn');
    let selectedPhotoFile = null;

    /* Feed Photo Cropper */
    const feedCropModal = document.getElementById('feed-crop-modal');
    const feedCropImg = document.getElementById('feed-crop-image');
    const applyFeedCropBtn = document.getElementById('save-feed-crop-btn');
    const cancelFeedCropBtn = document.getElementById('cancel-feed-crop-btn');
    const closeFeedCropBtn = document.getElementById('close-feed-crop-btn');
    let feedCropper = null;

    const closeFeedCrop = () => {
        if (feedCropModal) feedCropModal.classList.add('hidden');
        if (feedCropper) {
            feedCropper.destroy();
            feedCropper = null;
        }
        photoInput.value = '';
    };

    if (cancelFeedCropBtn) cancelFeedCropBtn.addEventListener('click', closeFeedCrop);
    if (closeFeedCropBtn) closeFeedCropBtn.addEventListener('click', closeFeedCrop);

    if (applyFeedCropBtn) {
        applyFeedCropBtn.addEventListener('click', () => {
            if (!feedCropper) return;
            applyFeedCropBtn.disabled = true;
            applyFeedCropBtn.textContent = 'Processing...';

            feedCropper.getCroppedCanvas({
                maxWidth: 2048,
                maxHeight: 2048,
                fillColor: '#000',
                imageSmoothingEnabled: true,
                imageSmoothingQuality: 'high',
            }).toBlob((blob) => {
                selectedPhotoFile = blob;
                const reader = new FileReader();
                reader.onload = (event) => {
                    previewImg.src = event.target.result;
                    photoPreview.classList.remove('hidden');
                    closeFeedCrop();
                };
                reader.readAsDataURL(blob);

                applyFeedCropBtn.disabled = false;
                applyFeedCropBtn.textContent = 'Apply Crop';
            }, 'image/jpeg', 0.9);
        });
    }

    if (addPhotoBtn && photoInput) {
        addPhotoBtn.addEventListener('click', () => photoInput.click());

        photoInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('Please select an image file', 'error');
                photoInput.value = '';
                return;
            }

            // Enforce 10MB limit on client side
            if (file.size > 10 * 1024 * 1024) {
                showToast('File too large. Maximum size for image sharing is 10MB.', 'error');
                photoInput.value = '';
                return;
            }

            const reader = new FileReader();
            reader.onload = (event) => {
                feedCropImg.src = event.target.result;
                feedCropModal.classList.remove('hidden');

                if (feedCropper) feedCropper.destroy();
                feedCropper = new Cropper(feedCropImg, {
                    aspectRatio: 1, // Match avatar for square posts as requested/implied
                    viewMode: 2,    // Contain within canvas
                    dragMode: 'move',
                    background: false,
                    autoCropArea: 1,
                    responsive: true,
                    restore: false,
                    guides: true,
                    center: true,
                    highlight: false,
                    cropBoxMovable: true,
                    cropBoxResizable: true,
                    toggleDragModeOnDblclick: false,
                });
            };
            reader.readAsDataURL(file);
        });
    }

    if (removePhotoBtn) {
        removePhotoBtn.addEventListener('click', () => {
            selectedPhotoFile = null;
            photoInput.value = '';
            previewImg.src = '';
            photoPreview.classList.add('hidden');
        });
    }

    if (postBtn && postTextarea) {
        // Initialize Mention Autocomplete for Post Box
        initMentionAutocomplete(postTextarea);

        postBtn.addEventListener('click', () => {
            const body = postTextarea.value.trim();
            if (!body && !selectedPhotoFile) return;

            postBtn.disabled = true;
            postBtn.textContent = 'Posting...';

            createPost(body, selectedPhotoFile)
                .then(res => {
                    if (res.success) {
                        postTextarea.value = '';
                        // Clear photo preview
                        if (removePhotoBtn) removePhotoBtn.click();
                        fetchPosts(); // Refresh feed
                    } else {
                        showToast('Error: ' + (res.error || 'Failed to post'), 'error');
                    }
                })
                .catch(err => {
                    console.error(err);
                    showToast('Network error while posting', 'error');
                })
                .finally(() => {
                    postBtn.disabled = false;
                    postBtn.textContent = 'Post';
                });
        });
    }

    /* ===================================================
     * FEED FILTERING & PAGINATION
     * =================================================== */
    const filterBtn = document.getElementById('filter-dropdown-btn');
    const filterMenu = document.getElementById('filter-dropdown-menu');
    const currentFilterLabel = document.getElementById('current-filter');
    const loadMoreBtn = document.getElementById('load-more-btn');

    if (filterBtn && filterMenu) {
        filterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            filterMenu.classList.toggle('hidden');
        });

        document.addEventListener('click', (e) => {
            if (!filterBtn.contains(e.target) && !filterMenu.contains(e.target)) {
                filterMenu.classList.add('hidden');
            }
        });

        const filterOptions = document.querySelectorAll('.filter-option');
        filterOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                const sort = opt.dataset.sort;
                const label = opt.textContent;

                // Update UI
                filterOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                if (currentFilterLabel) currentFilterLabel.textContent = label;
                filterMenu.classList.add('hidden');

                // Update State & Fetch
                if (typeof feedState !== 'undefined') {
                    feedState.sortBy = sort;
                    fetchPosts(false);
                }
            });
        });
    }

    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            if (typeof fetchPosts === 'function') {
                fetchPosts(true);
            }
        });
    }

    /* ===================================================
     * MENTION AUTOCOMPLETE LOGIC
     * =================================================== */
    function initMentionAutocomplete(input) {
        if (!input || input.dataset.mentionAttached) return;
        input.dataset.mentionAttached = "true";

        const dropdown = document.createElement('div');
        dropdown.className = 'mention-suggestions';
        document.body.appendChild(dropdown);

        let suggestions = [];
        let activeIndex = -1;
        let query = "";
        let queryStart = -1;

        const closeDropdown = () => {
            dropdown.style.display = 'none';
            activeIndex = -1;
        };

        const renderSuggestions = () => {
            if (suggestions.length === 0) {
                closeDropdown();
                return;
            }

            dropdown.innerHTML = suggestions.map((u, i) => {
                const avatar = u.avatar || COVER_PLACEHOLDER;
                return `
                    <div class="mention-item ${i === activeIndex ? 'active' : ''}" data-index="${i}">
                        <img src="${avatar}" alt="${u.username}">
                        <div class="mention-info">
                            <span class="mention-name">${escapeHTML(u.display_name)}</span>
                            <span class="mention-handle">@${u.username}</span>
                        </div>
                    </div>
                `;
            }).join('');

            dropdown.style.display = 'block';

            // Positioning: below the input (use getBoundingClientRect for viewport-relative coords)
            const rect = input.getBoundingClientRect();
            dropdown.style.position = 'fixed';
            dropdown.style.top = `${rect.bottom + 5}px`;
            dropdown.style.left = `${rect.left}px`;
            dropdown.style.width = `${Math.max(200, rect.width)}px`;
        };

        const selectUser = (index) => {
            const user = suggestions[index];
            if (!user) return;

            const text = input.value;
            const before = text.substring(0, queryStart);
            const after = text.substring(input.selectionStart);

            input.value = before + '@' + user.username + ' ' + after;
            input.selectionStart = input.selectionEnd = before.length + user.username.length + 2;

            closeDropdown();
            input.focus();
        };

        input.addEventListener('input', () => {
            const val = input.value;
            const cursor = input.selectionStart;
            const lastAt = val.lastIndexOf('@', cursor - 1);

            if (lastAt !== -1) {
                const textSinceAt = val.substring(lastAt + 1, cursor);
                // Check if there are no spaces between @ and cursor
                if (!textSinceAt.includes(' ')) {
                    query = textSinceAt;
                    queryStart = lastAt;

                    fetch(`/api/users/search-mentions?q=${encodeURIComponent(query)}`)
                        .then(r => r.json())
                        .then(data => {
                            suggestions = data;
                            activeIndex = 0;
                            renderSuggestions();
                        });
                    return;
                }
            }
            closeDropdown();
        });

        input.addEventListener('keydown', (e) => {
            if (dropdown.style.display === 'block') {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    activeIndex = (activeIndex + 1) % suggestions.length;
                    renderSuggestions();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
                    renderSuggestions();
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    selectUser(activeIndex);
                } else if (e.key === 'Escape') {
                    closeDropdown();
                }
            }
        });

        dropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.mention-item');
            if (item) {
                selectUser(parseInt(item.dataset.index));
            }
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (e.target !== input && !dropdown.contains(e.target)) {
                closeDropdown();
            }
        });
    }

    // Expose globally for dynamic components
    window.initMentionAutocomplete = initMentionAutocomplete;

    /* ===================================================
     * LOCKED EMBEDS (Video placeholders)
     * =================================================== */
    document.querySelectorAll('.yt-placeholder').forEach(placeholder => {
        // Add "Locked" badge
        const badge = document.createElement('div');
        badge.className = 'yt-locked-overlay';
        badge.innerHTML = `<i class='bx bx-lock-alt'></i> Locked`;
        placeholder.appendChild(badge);

        // Override/prevent click handling
        placeholder.addEventListener('click', function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();

            // Subtle shake or feedback
            this.classList.remove('shake-anim');
            void this.offsetWidth;
            this.classList.add('shake-anim');

            /* locked — no action */
        }, true); // Capture phase to preempt other listeners
    });

    /* ===================================================
     * LOGO MORPH TIMER (Every 2 Minutes)
     * =================================================== */
    const logoText = document.querySelector('.morph-text');

    if (logoText) {
        // Function to trigger the animation
        const triggerMorph = () => {
            logoText.classList.remove('animate');
            void logoText.offsetWidth; // "Magic" line to force CSS reflow/reset
            logoText.classList.add('animate');
        };

        // Run once on load
        triggerMorph();

        // Repeat every 2 minutes (120,000 milliseconds)
        setInterval(triggerMorph, 5000);
    }

    /* ===================================================
     * LIBRARY MANAGEMENT
     * =================================================== */
    const downloadLibraryBtn = document.getElementById('download-library-btn');
    if (downloadLibraryBtn) {
        downloadLibraryBtn.addEventListener('click', () => {
            if (typeof downloadAllSongs === 'function' && typeof appCache !== 'undefined' && appCache.library) {
                downloadAllSongs(appCache.library, downloadLibraryBtn);
            }
        });
    }

    const manageBtn = document.getElementById('manage-library-btn');
    const batchDeleteBtn = document.getElementById('batch-delete-btn');
    const batchCancelBtn = document.getElementById('batch-cancel-btn');
    const batchAddToPlaylistBtn = document.getElementById('batch-add-to-playlist-btn');

    if (manageBtn) manageBtn.addEventListener('click', toggleLibraryEditMode);
    if (batchDeleteBtn) batchDeleteBtn.addEventListener('click', deleteSelectedSongs);
    if (batchCancelBtn) batchCancelBtn.addEventListener('click', toggleLibraryEditMode);
    if (batchAddToPlaylistBtn) batchAddToPlaylistBtn.addEventListener('click', () => {
        if (selectedSongIds.size === 0) return;
        showAddToPlaylistModal(Array.from(selectedSongIds));
    });

    /* Edit Song Modal */
    const editSongModal = document.getElementById('edit-song-modal');
    const closeEditSongBtn = document.getElementById('close-edit-song-modal');
    const cancelEditSongBtn = document.getElementById('cancel-edit-song');
    const saveSongChangesBtn = document.getElementById('save-song-changes');
    const changeCoverBtn = document.getElementById('change-song-cover-btn');
    const songCoverInput = document.getElementById('song-cover-upload');

    const closeEditSong = () => editSongModal && editSongModal.classList.add('hidden');

    if (closeEditSongBtn) closeEditSongBtn.addEventListener('click', closeEditSong);
    if (cancelEditSongBtn) cancelEditSongBtn.addEventListener('click', closeEditSong);
    if (editSongModal) editSongModal.addEventListener('click', e => { if (e.target === editSongModal) closeEditSong(); });

    if (saveSongChangesBtn) saveSongChangesBtn.addEventListener('click', saveSongChanges);

    if (changeCoverBtn && songCoverInput) {
        changeCoverBtn.addEventListener('click', (e) => { e.stopPropagation(); songCoverInput.click(); });
        songCoverInput.addEventListener('change', e => {
            const file = e.target.files[0];
            const songId = document.getElementById('edit-song-id').value;
            if (file && songId) uploadSongCover(songId, file);
        });
    }

    /* ===================================================
     * PLAYLIST NAVIGATION & HANDLERS
     * =================================================== */
    window.navigateToPlaylist = function (playlistId) {
        if (!playlistId) return;

        window.lastViewBeforePlaylist = window.currentActiveView;
        window.currentActiveView = 'playlist';
        window.currentPlaylistId = playlistId;

        // Update URL hash (prefer share_id if it's a 16-char hex)
        const isShareId = typeof playlistId === 'string' && playlistId.length === 16 && /^[0-9a-fA-F]+$/.test(playlistId);
        if (window.location.hash !== `#playlist-${playlistId}`) {
            history.pushState({ view: 'playlist', id: playlistId }, '', `/home#playlist-${playlistId}`);
        }

        hideAllSections();
        showSection(playlistDetailSection);
        document.title = "Streamify | Playlist";

        document.querySelectorAll('.sidebar-playlist-link').forEach(l => {
            l.classList.toggle('active', l.dataset.playlistId == playlistId);
        });

        if (typeof renderPlaylistDetail === 'function') renderPlaylistDetail(playlistId);
    };

    // Back from playlist
    const backFromPlaylistBtn = document.getElementById('back-from-playlist-btn');
    if (backFromPlaylistBtn) {
        backFromPlaylistBtn.addEventListener('click', () => {
            const lastView = window.lastViewBeforePlaylist || 'home';
            if (lastView === 'library') {
                libraryLink && libraryLink.click();
            } else if (lastView === 'people') {
                peopleLink && peopleLink.click();
            } else {
                homeLink && homeLink.click();
            }
        });
    }

    // Create Playlist Modal
    const createPlaylistBtn = document.getElementById('create-playlist-btn');
    const createPlaylistModal = document.getElementById('create-playlist-modal');
    const closeCreatePlaylistBtn = document.getElementById('close-create-playlist-btn');
    const cancelCreatePlaylistBtn = document.getElementById('cancel-create-playlist-btn');
    const confirmCreatePlaylistBtn = document.getElementById('confirm-create-playlist-btn');

    const closeCreatePlaylist = () => {
        if (createPlaylistModal) createPlaylistModal.classList.add('hidden');
        const input = document.getElementById('new-playlist-name');
        if (input) input.value = '';
    };

    if (createPlaylistBtn) createPlaylistBtn.addEventListener('click', () => createPlaylistModal && createPlaylistModal.classList.remove('hidden'));
    if (closeCreatePlaylistBtn) closeCreatePlaylistBtn.addEventListener('click', closeCreatePlaylist);
    if (cancelCreatePlaylistBtn) cancelCreatePlaylistBtn.addEventListener('click', closeCreatePlaylist);
    if (createPlaylistModal) createPlaylistModal.addEventListener('click', e => { if (e.target === createPlaylistModal) closeCreatePlaylist(); });

    if (confirmCreatePlaylistBtn) {
        confirmCreatePlaylistBtn.addEventListener('click', async () => {
            const nameInput = document.getElementById('new-playlist-name');
            const name = nameInput ? nameInput.value.trim() : '';
            if (!name) return;

            confirmCreatePlaylistBtn.disabled = true;
            confirmCreatePlaylistBtn.textContent = 'Creating...';

            try {
                const res = await createPlaylist(name);
                if (res.success) {
                    closeCreatePlaylist();
                    if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
                    if (res.playlist && typeof navigateToPlaylist === 'function') navigateToPlaylist(res.playlist.id);
                } else {
                    showToast(res.error || 'Failed to create playlist', 'error');
                }
            } catch (err) {
                console.error('[CREATE PLAYLIST]', err);
                showToast('Failed to create playlist', 'error');
            } finally {
                confirmCreatePlaylistBtn.disabled = false;
                confirmCreatePlaylistBtn.textContent = 'Create';
            }
        });
    }

    // Add to Playlist Modal close
    const closeAddToPlaylistBtn = document.getElementById('close-add-to-playlist-btn');
    const addToPlaylistModal = document.getElementById('add-to-playlist-modal');
    const resetAddToPlaylistTitle = () => { const t = addToPlaylistModal?.querySelector('h3'); if (t) t.textContent = 'Add to Playlist'; };
    if (closeAddToPlaylistBtn) closeAddToPlaylistBtn.addEventListener('click', () => { addToPlaylistModal && addToPlaylistModal.classList.add('hidden'); resetAddToPlaylistTitle(); });
    if (addToPlaylistModal) addToPlaylistModal.addEventListener('click', e => { if (e.target === addToPlaylistModal) { addToPlaylistModal.classList.add('hidden'); resetAddToPlaylistTitle(); } });

    // Download Playlist
    const downloadPlaylistBtn = document.getElementById('download-playlist-btn');
    if (downloadPlaylistBtn) {
        downloadPlaylistBtn.addEventListener('click', () => {
            if (typeof downloadAllSongs === 'function' && typeof currentPlaylist !== 'undefined') {
                // currentPlaylist holds the songs currently rendered in the playlist view
                downloadAllSongs(currentPlaylist, downloadPlaylistBtn);
            }
        });
    }

    // Rename Playlist Modal
    const renamePlaylistBtn = document.getElementById('rename-playlist-btn');
    const renamePlaylistModal = document.getElementById('rename-playlist-modal');
    const closeRenamePlaylistBtn = document.getElementById('close-rename-playlist-btn');
    const cancelRenamePlaylistBtn = document.getElementById('cancel-rename-playlist-btn');
    const confirmRenamePlaylistBtn = document.getElementById('confirm-rename-playlist-btn');

    const closeRenamePlaylist = () => {
        if (renamePlaylistModal) renamePlaylistModal.classList.add('hidden');
    };

    if (renamePlaylistBtn) {
        renamePlaylistBtn.addEventListener('click', () => {
            const nameEl = document.getElementById('playlist-detail-name');
            const bioEl = document.getElementById('playlist-detail-bio');
            const nameInput = document.getElementById('rename-playlist-name');
            const bioInput = document.getElementById('rename-playlist-bio');
            const idInput = document.getElementById('rename-playlist-id');
            if (nameEl && nameInput) nameInput.value = nameEl.textContent;
            if (bioEl && bioInput) {
                // Remove bio visibility check when getting text, just get the text
                bioInput.value = bioEl.style.display !== 'none' ? bioEl.textContent : '';
            }
            if (idInput) idInput.value = window.currentPlaylistId || '';
            const visibilityInput = document.getElementById('rename-playlist-visibility');
            if (visibilityInput) visibilityInput.value = window.currentPlaylistIsPrivate || 'private';
            if (renamePlaylistModal) renamePlaylistModal.classList.remove('hidden');
        });
    }
    if (closeRenamePlaylistBtn) closeRenamePlaylistBtn.addEventListener('click', closeRenamePlaylist);
    if (cancelRenamePlaylistBtn) cancelRenamePlaylistBtn.addEventListener('click', closeRenamePlaylist);
    if (renamePlaylistModal) renamePlaylistModal.addEventListener('click', e => { if (e.target === renamePlaylistModal) closeRenamePlaylist(); });

    if (confirmRenamePlaylistBtn) {
        confirmRenamePlaylistBtn.addEventListener('click', async () => {
            const id = document.getElementById('rename-playlist-id').value;
            const name = document.getElementById('rename-playlist-name').value.trim();
            const bio = document.getElementById('rename-playlist-bio') ? document.getElementById('rename-playlist-bio').value.trim() : '';
            const visibility = document.getElementById('rename-playlist-visibility') ? document.getElementById('rename-playlist-visibility').value : 'private';
            if (!name || !id) return;

            confirmRenamePlaylistBtn.disabled = true;
            try {
                const res = await renamePlaylist(id, name, bio, visibility);
                if (res.success) {
                    closeRenamePlaylist();
                    if (typeof navigateToPlaylist === 'function') navigateToPlaylist(id);
                    if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
                } else {
                    showToast(res.error || 'Failed to rename', 'error');
                }
            } finally {
                confirmRenamePlaylistBtn.disabled = false;
            }
        });
    }

    // Playlist Cover Upload
    const playlistCoverUpload = document.getElementById('playlist-cover-upload');
    const playlistDetailCover = document.getElementById('playlist-detail-cover');
    if (playlistDetailCover && playlistCoverUpload) {
        playlistDetailCover.addEventListener('click', () => {
            if (window.currentPlaylistOwner === (appCache.user ? appCache.user.username : window.currentUser)) {
                playlistCoverUpload.click();
            }
        });
        playlistCoverUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            const playlistId = window.currentPlaylistId;
            if (file && playlistId) {
                try {
                    const res = await uploadPlaylistCover(playlistId, file);
                    if (res.success && res.cover) {
                        playlistDetailCover.style.backgroundImage = `url(${res.cover})`;
                        playlistDetailCover.querySelector('.bx-music').style.display = 'none';
                        if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
                    } else {
                        showToast(res.error || 'Failed to upload cover', 'error');
                    }
                } catch (err) {
                    console.error("Cover upload error:", err);
                    showToast('Failed to upload cover', 'error');
                }
            }
        });
    }

    // Manage Playlist (bulk remove)
    const managePlaylistBtn = document.getElementById('manage-playlist-btn');
    if (managePlaylistBtn) managePlaylistBtn.addEventListener('click', () => {
        if (typeof togglePlaylistEditMode === 'function') togglePlaylistEditMode();
    });

    // Delete Playlist
    const deletePlaylistBtn = document.getElementById('delete-playlist-btn');
    if (deletePlaylistBtn) {
        deletePlaylistBtn.addEventListener('click', async () => {
            const playlistId = window.currentPlaylistId;
            if (!playlistId) return;

            try {
                const res = await deletePlaylist(playlistId);
                if (res.success) {
                    if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
                    const lastView = window.lastViewBeforePlaylist || 'home';
                    if (lastView === 'library') {
                        libraryLink && libraryLink.click();
                    } else {
                        homeLink && homeLink.click();
                    }
                } else {
                    showToast(res.error || 'Failed to delete playlist', 'error');
                }
            } catch (err) {
                console.error('[DELETE PLAYLIST]', err);
                showToast('Failed to delete playlist', 'error');
            }
        });
    }

    /* ===================================================
     * INITIAL ROUTING & NAVIGATION
     * =================================================== */
    function handleRouting() {
        const path = window.location.pathname;
        const hash = window.location.hash;
        const params = new URLSearchParams(window.location.search);
        const playlistShareId = params.get('playlist');

        if (playlistShareId) {
            // Handle Share Link
            if (typeof window.hideAllSections === 'function') window.hideAllSections();
            if (typeof window.showSection === 'function' && playlistDetailSection) {
                window.showSection(playlistDetailSection);
                if (typeof renderPlaylistDetail === 'function') {
                    renderPlaylistDetail(playlistShareId);
                }
            }
            return;
        }

        // Handle Hashes
        if (hash) {
            if (hash === '#feed') {
                if (homeLink) homeLink.click();
                return;
            } else if (hash === '#library') {
                if (libraryLink) libraryLink.click();
                return;
            } else if (hash === '#people') {
                if (peopleLink) peopleLink.click();
                return;
            } else if (hash === '#upload') {
                if (uploadLink) uploadLink.click();
                return;
            } else if (hash === '#about') {
                if (aboutLink) aboutLink.click();
                return;
            } else if (hash.startsWith('#playlist-')) {
                const pid = hash.replace('#playlist-', '');
                if (typeof window.navigateToPlaylist === 'function') {
                    window.navigateToPlaylist(pid);
                }
                return;
            } else if (hash.startsWith('#post-')) {
                const postId = hash.split('-')[1];
                if (postId && typeof navigateToPost === 'function') {
                    navigateToPost(postId);
                }
                return;
            } else if (hash.startsWith('#user-')) {
                const username = hash.split('-')[1];
                if (username && typeof navigateToProfile === 'function') {
                    navigateToProfile(username);
                }
                return;
            }
        }

        if (path.startsWith('/profile/')) {
            const username = path.split('/profile/')[1];
            if (username) {
                hideAllSections();
                showSection(profileDetailSection);
                if (typeof fetchDetailedProfile === 'function') {
                    fetchDetailedProfile(username);
                }
            }
        } else {
            // Default to home if on /home or root
            if (homeLink && (path === '/home' || path === '/')) {
                // Already handled by potential initial state or manual trigger
                // but let's ensure feed is shown
                if (feedSection && feedSection.classList.contains('hidden')) {
                    homeLink.click();
                }
            }
        }
    }


    window.navigateToProfile = function (username) {
        if (!username) return;

        // Remember where we came from if we're not already on a profile
        if (window.currentActiveView !== 'profile') {
            window.lastViewBeforeProfile = window.currentActiveView;
        }
        // Save scroll position before leaving current view
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            window.savedScrollPosition = mainContent.scrollTop;
        }
        // If coming from post detail, remember which post
        if (window.currentActiveView === 'post' && window.currentPostId) {
            window.profileContextPostId = window.currentPostId;
        }

        window.currentActiveView = 'profile';

        const profileModal = document.getElementById('profile-modal');
        if (profileModal) {
            profileModal.style.transition = 'none';
            profileModal.classList.add('hidden');
            void profileModal.offsetHeight;
            profileModal.style.transition = '';
        }

        history.pushState({ view: 'profile', username }, '', `/profile/${username}`);
        hideAllSections();
        showSection(profileDetailSection);
        if (mainContent) mainContent.scrollTop = 0;
        window.scrollTo(0, 0);
        if (typeof fetchDetailedProfile === 'function') {
            fetchDetailedProfile(username);
        }
    };

    // Profile Detail Tabs
    const profileTabBtns = document.querySelectorAll('.profile-detail-section .tab-btn');
    const profilePanes = document.querySelectorAll('.profile-detail-section .profile-pane');

    profileTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            profileTabBtns.forEach(b => b.classList.remove('active'));
            profilePanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const targetPane = document.getElementById(`pane-${tab}`);
            if (targetPane) targetPane.classList.add('active');
        });
    });

    window.addEventListener('popstate', (e) => {
        handleRouting();
    });

    /* ===================================================
     * INITIAL DATA FETCH
     * =================================================== */
    fetchCurrentUser();
    fetchPlaylists(true); // Force refresh to bypass in-memory JS cache on page load
    handleRouting();
    window.addEventListener('hashchange', handleRouting);

    /* ===================================================
     * DM (Direct Messages) UI
     * =================================================== */
    const openDmBtn = document.getElementById('open-dm-btn');
    if (openDmBtn) {
        openDmBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const userMenu = document.getElementById('user-menu');
            if (userMenu) userMenu.classList.remove('show');

            window.currentActiveView = 'dm';
            if (typeof window.hideAllSections === 'function') window.hideAllSections();
            if (typeof window.showSection === 'function' && dmSection) window.showSection(dmSection);
            document.body.classList.add('dm-open');
            document.title = "Streamify | Messages";

            if (typeof fetchDmContacts === 'function') fetchDmContacts();
            if (typeof fetchDmUnreadCount === 'function') fetchDmUnreadCount();
            if (typeof fetchDmRequests === 'function') fetchDmRequests();
        });
    }

    // DM close button
    const dmCloseBtn = document.getElementById('dm-close-btn');
    if (dmCloseBtn && dmSection) {
        dmCloseBtn.addEventListener('click', () => {
            dmSection.classList.add('hidden');
            activeDmConversation = null;
            // Reset chat state
            const chatEmpty = document.getElementById('dm-chat-empty');
            const chatActive = document.getElementById('dm-chat-active');
            if (chatEmpty) chatEmpty.classList.remove('hidden');
            if (chatActive) chatActive.classList.add('hidden');
            dmSection.classList.remove('dm-chat-open');
            // Go back to feed
            window.currentActiveView = 'home';
            document.getElementById('home-link')?.click();
        });
    }

    // DM contact list click (event delegation)
    const dmContactsList = document.getElementById('dm-contacts-list');
    if (dmContactsList) {
        dmContactsList.addEventListener('click', (e) => {
            const item = e.target.closest('.dm-contact-item');
            if (!item) return;
            const convId = parseInt(item.dataset.conversationId);
            const username = item.dataset.username;
            const displayName = item.dataset.displayName;
            const avatar = item.dataset.avatar;
            if (convId && typeof openDmConversation === 'function') {
                openDmConversation(convId, username, displayName, avatar);
            }
        });
    }

    // DM contacts search filter
    const dmContactsSearch = document.getElementById('dm-contacts-search');
    if (dmContactsSearch) {
        dmContactsSearch.addEventListener('input', () => {
            const query = dmContactsSearch.value.toLowerCase();
            document.querySelectorAll('.dm-contact-item').forEach(item => {
                const name = item.dataset.displayName?.toLowerCase() || '';
                const username = item.dataset.username?.toLowerCase() || '';
                item.style.display = (name.includes(query) || username.includes(query)) ? '' : 'none';
            });
        });
    }

    // New DM request modal
    const dmNewBtn = document.getElementById('dm-new-btn');
    const dmNewModal = document.getElementById('dm-new-modal');
    const closeDmNewModal = document.getElementById('close-dm-new-modal');
    const dmNewCancel = document.getElementById('dm-new-cancel');
    const dmNewSend = document.getElementById('dm-new-send');

    if (dmNewBtn && dmNewModal) {
        dmNewBtn.addEventListener('click', () => dmNewModal.classList.remove('hidden'));
    }
    if (closeDmNewModal) closeDmNewModal.addEventListener('click', () => dmNewModal.classList.add('hidden'));
    if (dmNewCancel) dmNewCancel.addEventListener('click', () => dmNewModal.classList.add('hidden'));
    if (dmNewSend) dmNewSend.addEventListener('click', () => { if (typeof sendDmRequest === 'function') sendDmRequest(); });
    if (dmNewModal) dmNewModal.addEventListener('click', (e) => { if (e.target === dmNewModal) dmNewModal.classList.add('hidden'); });

    // DM username input with autocomplete
    const dmNewUsernameInput = document.getElementById('dm-new-username');
    let dmSuggestList = null;
    let dmSuggestTimeout = null;
    let dmSuggestActiveIndex = -1;
    let dmSuggestUsers = [];

    if (dmNewUsernameInput) {
        dmNewUsernameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (dmSuggestActiveIndex >= 0 && dmSuggestUsers[dmSuggestActiveIndex]) {
                    dmNewUsernameInput.value = dmSuggestUsers[dmSuggestActiveIndex].username;
                    dmCloseSuggest();
                }
                if (typeof sendDmRequest === 'function') sendDmRequest();
            }
        });

        const dmCloseSuggest = () => {
            if (dmSuggestList) { dmSuggestList.remove(); dmSuggestList = null; }
            dmSuggestActiveIndex = -1;
            dmSuggestUsers = [];
        };

        const dmRenderSuggest = () => {
            if (!dmSuggestList || dmSuggestUsers.length === 0) return;
            dmSuggestList.querySelectorAll('.dm-suggest-item').forEach((el, i) => {
                el.classList.toggle('active', i === dmSuggestActiveIndex);
                el.style.background = i === dmSuggestActiveIndex ? 'rgba(255,255,255,0.08)' : '';
            });
        };

        dmNewUsernameInput.addEventListener('input', () => {
            const q = dmNewUsernameInput.value.trim();
            clearTimeout(dmSuggestTimeout);

            dmCloseSuggest();
            if (q.length < 2) return;

            dmSuggestTimeout = setTimeout(() => {
                fetch(`${window.API_BASE_URL}/api/users/search-mentions?q=${encodeURIComponent(q)}`)
                    .then(r => r.json())
                    .then(users => {
                        if (!users || users.length === 0) return;
                        dmCloseSuggest();

                        dmSuggestUsers = users;
                        dmSuggestActiveIndex = 0;

                        dmSuggestList = document.createElement('div');
                        dmSuggestList.className = 'dm-suggest-list';
                        dmSuggestList.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:rgba(20,20,20,0.97);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.1);border-radius:10px;margin-top:4px;max-height:200px;overflow-y:auto;z-index:100;box-shadow:0 8px 24px rgba(0,0,0,0.4);';

                        users.forEach((u, i) => {
                            const item = document.createElement('div');
                            item.className = 'dm-suggest-item';
                            item.dataset.username = u.username;
                            const avatarUrl = u.avatar || '';
                            const avatarHtml = avatarUrl
                                ? `<img src="${avatarUrl}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
                                : `<div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#4169e1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${(u.display_name || u.username).charAt(0).toUpperCase()}</div>`;
                            item.style.cssText = `padding:10px 14px;cursor:pointer;font-size:13px;color:var(--text-primary);border-bottom:1px solid rgba(255,255,255,0.03);display:flex;align-items:center;gap:10px;${i === 0 ? 'background:rgba(255,255,255,0.08);' : ''}`;
                            item.innerHTML = `${avatarHtml}<div style="display:flex;flex-direction:column;gap:1px;"><strong style="font-size:13px;">@${u.username}</strong>${u.display_name && u.display_name !== u.username ? `<span style="color:var(--text-secondary);font-size:11px;">${u.display_name}</span>` : ''}</div>`;

                            item.addEventListener('mousedown', (e) => {
                                e.preventDefault();
                                dmNewUsernameInput.value = u.username;
                                dmCloseSuggest();
                                dmNewUsernameInput.focus();
                            });
                            dmSuggestList.appendChild(item);
                        });

                        const inputGroup = dmNewUsernameInput.closest('.input-group') || dmNewUsernameInput.parentElement;
                        inputGroup.style.position = 'relative';
                        inputGroup.appendChild(dmSuggestList);
                    })
                    .catch(() => { });
            }, 200);
        });

        dmNewUsernameInput.addEventListener('keydown', (e) => {
            if (!dmSuggestList || dmSuggestUsers.length === 0) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                dmSuggestActiveIndex = (dmSuggestActiveIndex + 1) % dmSuggestUsers.length;
                dmRenderSuggest();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                dmSuggestActiveIndex = (dmSuggestActiveIndex - 1 + dmSuggestUsers.length) % dmSuggestUsers.length;
                dmRenderSuggest();
            } else if (e.key === 'Escape') {
                dmCloseSuggest();
            }
        });

        dmNewUsernameInput.addEventListener('blur', () => {
            setTimeout(dmCloseSuggest, 250);
        });
    }

    // DM requests modal
    const dmRequestsBtn = document.getElementById('dm-requests-btn');
    const dmRequestsModal = document.getElementById('dm-requests-modal');
    const closeDmRequestsModal = document.getElementById('close-dm-requests-modal');

    if (dmRequestsBtn && dmRequestsModal) {
        dmRequestsBtn.addEventListener('click', () => {
            dmRequestsModal.classList.remove('hidden');
            if (typeof fetchDmRequests === 'function') fetchDmRequests();
        });
    }
    if (closeDmRequestsModal) closeDmRequestsModal.addEventListener('click', () => dmRequestsModal.classList.add('hidden'));
    if (dmRequestsModal) dmRequestsModal.addEventListener('click', (e) => { if (e.target === dmRequestsModal) dmRequestsModal.classList.add('hidden'); });

    // DM requests tab switching
    document.querySelectorAll('.dm-req-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.dm-req-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            if (typeof window.dmReqActiveTab !== 'undefined') window.dmReqActiveTab = tab.dataset.tab;
            dmReqActiveTab = tab.dataset.tab;
            if (typeof fetchDmRequests === 'function') fetchDmRequests();
        });
    });

    // DM message input
    const dmMessageInput = document.getElementById('dm-message-input');
    const dmSendBtn = document.getElementById('dm-send-btn');

    if (dmMessageInput) {
        dmMessageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (typeof sendDmMessage === 'function') sendDmMessage();
            }
        });

        // Typing indicator
        dmMessageInput.addEventListener('input', () => {
            if (typeof socket !== 'undefined' && socket && activeDmConversation) {
                socket.emit('dm_typing', { conversation_id: activeDmConversation });
                clearTimeout(dmTypingTimeout);
                dmTypingTimeout = setTimeout(() => {
                    socket.emit('dm_stop_typing', { conversation_id: activeDmConversation });
                }, 1500);
            }
        });
    }

    if (dmSendBtn) {
        dmSendBtn.addEventListener('click', () => { if (typeof sendDmMessage === 'function') sendDmMessage(); });
    }

    // Back to contacts (mobile)
    const dmBackContactsBtn = document.getElementById('dm-back-contacts-btn');
    if (dmBackContactsBtn) {
        dmBackContactsBtn.addEventListener('click', () => {
            activeDmConversation = null;
            const chatEmpty = document.getElementById('dm-chat-empty');
            const chatActive = document.getElementById('dm-chat-active');
            if (chatEmpty) chatEmpty.classList.remove('hidden');
            if (chatActive) chatActive.classList.add('hidden');
            if (dmSection) dmSection.classList.remove('dm-chat-open');
        });
    }

    // Init DM socket listeners after socket is ready
    if (typeof initDmSocketListeners === 'function') {
        setTimeout(() => initDmSocketListeners(), 1000);
    }

    // Fetch DM unread count on load
    if (typeof fetchDmUnreadCount === 'function') {
        setTimeout(() => fetchDmUnreadCount(), 2000);
    }
});

/**
 * ============================================================================
 * STREAMIFY - ui.js
 * ============================================================================
 * DOM initialization, sidebar navigation, modals, search box,
 * mobile menu, avatar upload, and logout.
 * Must be loaded LAST so it can call functions from all other modules.
 * ============================================================================
 */

document.addEventListener('DOMContentLoaded', () => {

    let resolveFirstVisualPaint;
    let firstVisualPaintResolved = false;
    const firstVisualPaint = new Promise(resolve => {
        resolveFirstVisualPaint = resolve;
    });
    window.streamifyAfterFirstPaint = callback => firstVisualPaint.then(() => callback());
    window.streamifyAfterStartupMotion = callback => firstVisualPaint.then(() => new Promise(resolve => {
        setTimeout(resolve, 950);
    })).then(() => callback());

    const scheduleIdle = (callback, timeout = 4000) => {
        if ('requestIdleCallback' in window) {
            requestIdleCallback(callback, { timeout });
        } else {
            setTimeout(callback, 0);
        }
    };

    const nextPaint = () => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    function finishInitialVisualPaint() {
        if (firstVisualPaintResolved) return;
        firstVisualPaintResolved = true;

        requestAnimationFrame(() => {
            document.body.classList.remove('app-booting');
            const bootScreen = document.getElementById('app-boot-screen');
            if (bootScreen) bootScreen.classList.add('app-boot-screen-exit');

            // The next rAF runs after Chromium has had an opportunity to paint
            // the populated library and start the unchanged entrance animation.
            requestAnimationFrame(() => resolveFirstVisualPaint());
            setTimeout(() => bootScreen?.remove(), 1100);
        });
    }
    setTimeout(() => {
        if (!firstVisualPaintResolved) {
            console.warn('[INITIAL PAINT] Startup gate timed out; revealing the available shell.');
            finishInitialVisualPaint();
        }
    }, 15000);

    /* Chromium initializes some filter shaders and compositor paths lazily.
       Warm a tiny isolated layer while the app is idle so the cost is not paid
       on the user's first player/lyrics click. All real animation CSS remains
       unchanged. */
    const warmPlayerPipeline = () => {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const warmup = document.createElement('div');
        warmup.className = 'player-pipeline-warmup';
        warmup.textContent = 'Aa';
        document.body.appendChild(warmup);

        const animation = warmup.animate([
            { transform: 'translateZ(0) scale(0.94)', opacity: 0.005, filter: 'blur(8px) brightness(0.6) saturate(1.5)' },
            { transform: 'translate3d(0, -2px, 0) scale(1.04)', opacity: 0.012, filter: 'blur(0px) brightness(0.6) saturate(1.5)' }
        ], {
            duration: 180,
            easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
            fill: 'both'
        });
        const cleanup = () => warmup.remove();
        animation.finished.then(cleanup, cleanup);
        setTimeout(cleanup, 600);
    };

    window.streamifyAfterStartupMotion(() => scheduleIdle(warmPlayerPipeline, 2500));

    /* ===================================================
     * PWA Service Worker Registration
     * ===================================================
     * Service workers are only available in a secure context. That means
     * https://, or localhost (which the desktop app always uses).
     * A phone on a plain-HTTP LAN address cannot register one, so we skip it
     * and tell the user what that costs instead of throwing an error into the
     * console on every page load.
    */
    if (window.StreamifyEnv && window.StreamifyEnv.canUseServiceWorker) {
        const registerServiceWorker = () => {
            navigator.serviceWorker.register('/sw.js?v=4.46')
                .then(reg => console.log('[SW] Registered successfully:', reg.scope))
                .catch(err => console.error('[SW] Registration failed:', err));
        };
        const scheduleRegistration = () => scheduleIdle(registerServiceWorker, 4000);

        // A cache install can fetch the entire app shell. Let the first library
        // paint win that bandwidth and CPU time; an existing worker continues
        // controlling the page while registration waits for an idle period.
        const pageLoaded = document.readyState === 'complete'
            ? Promise.resolve()
            : new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
        Promise.all([pageLoaded, firstVisualPaint])
            .then(() => new Promise(resolve => setTimeout(resolve, 1200)))
            .then(scheduleRegistration);
    } else if (window.StreamifyEnv && !window.StreamifyEnv.isSecure) {
        console.info(
            '[SW] Skipped: this page is not a secure context. ' +
            'Offline downloads and installing to the home screen need HTTPS.'
        );
    }

    /* Explain the above to the user, once, if it applies to them. */
    if (typeof window.initInsecureContextNotice === 'function') {
        window.initInsecureContextNotice();
    }

    /* ===================================================
     * OFFLINE MODE MANAGEMENT
     * =================================================== */
    let _currentOfflineMode = null;
    let _lastOfflineToastTime = 0;

    function handleOfflineMode(forceState) {
        const isOffline = (typeof forceState === 'boolean')
            ? forceState
            : (!navigator.onLine || window.StreamifyOfflineMode || (window.StreamifyNetwork && !window.StreamifyNetwork.isServerReachable));

        if (_currentOfflineMode === isOffline) return;
        _currentOfflineMode = isOffline;

        if (isOffline) {
            document.body.classList.add('offline-mode');
            const now = Date.now();
            if (now - _lastOfflineToastTime > 3000) {
                _lastOfflineToastTime = now;
                showToast('You are offline. Switching to Offline Library.', 'warning');
            }

            // Disable other links
            ['upload-link'].forEach(id => {
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
            ['manage-library-btn'].forEach(id => {
                const button = document.getElementById(id);
                if (!button) return;
                button.disabled = true;
                button.style.pointerEvents = 'none';
                button.style.opacity = '0.5';
            });
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
            const now = Date.now();
            if (now - _lastOfflineToastTime > 3000) {
                _lastOfflineToastTime = now;
                showToast('You are back online.', 'success');
            }

            // Re-enable links
            ['upload-link'].forEach(id => {
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
            ['manage-library-btn'].forEach(id => {
                const button = document.getElementById(id);
                if (!button) return;
                button.disabled = false;
                button.style.pointerEvents = 'auto';
                button.style.opacity = '1';
            });

            // Trigger fetch refresh
            if (typeof fetchLibrary === 'function') fetchLibrary();
        }
    }
    window.handleOfflineMode = handleOfflineMode;

    window.addEventListener('offline', () => handleOfflineMode(true));
    window.addEventListener('online', () => {
        if (window.StreamifyNetwork) window.StreamifyNetwork.checkServer();
        else handleOfflineMode(false);
    });

    window.addEventListener('streamifynetworkchange', (e) => {
        handleOfflineMode(!e.detail.isServerReachable);
    });

    // Initial check
    if (!navigator.onLine || window.StreamifyOfflineMode || (window.StreamifyNetwork && !window.StreamifyNetwork.isServerReachable)) {
        handleOfflineMode(true);
    }


    /* ===================================================
     * LOGOUT
     * POST /logout -> clear session -> redirect to /login
     * =================================================== */
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async e => {
            e.preventDefault();
            try {
                await fetch(window.API_BASE_URL + '/logout', { method: 'POST', credentials: 'include' });
            } catch (error) {
                console.warn('[LOGOUT] Server logout failed; clearing local state anyway.', error);
            }
            try {
                if (window.OfflineStore) await window.OfflineStore.clearActiveUser();
            } catch (error) {
                console.error('[LOGOUT] Failed to clear offline account state:', error);
            }
            localStorage.removeItem('streamify_session_id');
            if (window.StreamifyEnv && window.StreamifyEnv.isCapacitor) {
                window.location.replace('/Static/loginpage/login.html');
            } else {
                window.location.href = '/login';
            }
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
        const toggleUserMenu = () => {
            if (notifMenu) notifMenu.classList.remove('show');
            userMenu.classList.toggle('show');
            userPill.setAttribute('aria-expanded', String(userMenu.classList.contains('show')));
        };
        userPill.addEventListener('click', e => {
            e.stopPropagation();
            toggleUserMenu();
        });
        userPill.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            toggleUserMenu();
        });
    }

    document.addEventListener('click', e => {
        if (userMenu && userMenu.classList.contains('show') && !userMenu.contains(e.target) && !userPill.contains(e.target)) {
            userMenu.classList.remove('show');
            if (userPill) userPill.setAttribute('aria-expanded', 'false');
        }
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
            if (userPill) userPill.setAttribute('aria-expanded', 'false');
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

    const metadataModes = new Set([
        'local_only',
        'text_only',
        'acoustic_with_text_fallback'
    ]);
    const metadataSettingsState = {
        mode: 'local_only',
        acoustidConfigured: false,
        acoustidKeySource: null,
        acoustidStoredKeyConfigured: false,
        fpcalcAvailable: false,
        fpcalcSource: null,
        acoustidStatusKnown: false,
        fpcalcStatusKnown: false,
        apiSupport: 'unknown',
        clearKeyUnsupported: false,
        loading: false,
        loadFailed: false
    };
    let metadataLoadPromise = null;

    const metadataEndpoint = () => (window.API_BASE_URL || '') + '/api/settings/metadata';
    const isMissingMetadataEndpoint = response => [404, 405, 501].includes(response.status);
    const normalizeMetadataMode = mode => metadataModes.has(mode) ? mode : 'local_only';
    const metadataScopes = () => document.querySelectorAll('[data-metadata-scope]');

    function clearMetadataKeyInputs() {
        metadataScopes().forEach(scope => {
            const keyInput = scope.querySelector('[data-acoustid-key]');
            if (keyInput) keyInput.value = '';
        });
    }

    function selectedMetadataMode(scope) {
        const selected = scope && scope.querySelector('input[type="radio"]:checked');
        return normalizeMetadataMode(selected ? selected.value : 'local_only');
    }

    function setMetadataNotice(scope, message) {
        const notice = scope && scope.querySelector('[data-metadata-api-notice]');
        if (!notice) return;
        notice.textContent = message || '';
        notice.classList.toggle('hidden', !message);
    }

    function setMetadataFormStatus(scope, message, type = '') {
        const status = scope && scope.querySelector('[data-metadata-form-status]');
        if (!status) return;
        status.textContent = message || '';
        status.dataset.status = type;
        status.classList.toggle('hidden', !message);
    }

    function renderMetadataScope(scope, forceMode = false) {
        if (!scope) return;

        if (forceMode || scope.dataset.metadataDirty !== 'true') {
            scope.querySelectorAll('input[type="radio"]').forEach(input => {
                input.checked = input.value === metadataSettingsState.mode;
            });
        }

        const mode = selectedMetadataMode(scope);
        const isAcoustic = mode === 'acoustic_with_text_fallback';
        const isSettingsScope = scope.dataset.metadataScope === 'settings';
        const busy = scope.dataset.metadataBusy === 'true';
        const controlsUnavailable = metadataSettingsState.loading || busy || metadataSettingsState.apiSupport === 'missing';
        const keyInput = scope.querySelector('[data-acoustid-key]');
        const keyStatus = scope.querySelector('[data-acoustid-status]');
        const fpcalcStatus = scope.querySelector('[data-fpcalc-status]');
        const acoustidFields = scope.querySelector('[data-acoustid-fields]');
        const keySourceNote = scope.querySelector('[data-acoustid-source-note]');
        const clearKeyButton = scope.querySelector('[data-clear-acoustid-key]');
        const saveButton = scope.querySelector('[data-save-metadata]');
        const openReviewButton = scope.querySelector('#open-metadata-review-btn');
        const unsavedBadge = scope.querySelector('[data-metadata-unsaved]');
        const isEnvironmentKey = metadataSettingsState.acoustidKeySource === 'environment';

        scope.querySelectorAll('.metadata-mode-option').forEach(option => {
            const radio = option.querySelector('input[type="radio"]');
            option.classList.toggle('is-selected', !!radio && radio.checked);
        });
        scope.querySelectorAll('input[type="radio"]').forEach(input => {
            input.disabled = controlsUnavailable;
        });

        if (acoustidFields) acoustidFields.classList.toggle('hidden', !isSettingsScope && !isAcoustic);
        if (keySourceNote) {
            keySourceNote.textContent = isEnvironmentKey
                ? (metadataSettingsState.acoustidStoredKeyConfigured
                    ? 'The active key is managed by the server environment. A saved fallback key is also stored and can be removed below.'
                    : 'The active key is managed by the ACOUSTID_CLIENT_KEY environment variable. Change it on the server.')
                : (metadataSettingsState.acoustidConfigured
                    ? 'A key is saved. Enter a new key only if you want to replace it.'
                    : 'Add an AcoustID application key to make fingerprint matching available.');
        }
        if (keyInput) {
            keyInput.disabled = controlsUnavailable || isEnvironmentKey;
            keyInput.required = isAcoustic && !metadataSettingsState.acoustidConfigured && metadataSettingsState.apiSupport !== 'missing';
            keyInput.placeholder = isEnvironmentKey
                ? 'Managed by server environment'
                : metadataSettingsState.acoustidConfigured
                ? 'Enter a replacement key'
                : 'Enter application client key';
        }
        if (clearKeyButton) {
            clearKeyButton.classList.toggle(
                'hidden',
                !metadataSettingsState.acoustidStoredKeyConfigured ||
                metadataSettingsState.apiSupport === 'missing' ||
                metadataSettingsState.clearKeyUnsupported
            );
            clearKeyButton.disabled = metadataSettingsState.loading || busy;
            clearKeyButton.textContent = isEnvironmentKey ? 'Remove saved fallback key' : 'Remove key';
        }
        if (saveButton) {
            saveButton.disabled = controlsUnavailable;
            saveButton.innerHTML = busy
                ? "<i class='bx bx-loader-alt bx-spin'></i> Saving..."
                : 'Save changes';
        }
        if (openReviewButton) {
            const hasUnsavedChanges = scope.dataset.metadataDirty === 'true';
            openReviewButton.disabled = controlsUnavailable || hasUnsavedChanges;
            openReviewButton.title = hasUnsavedChanges ? 'Save your metadata settings before opening a review' : '';
        }
        if (unsavedBadge) unsavedBadge.classList.toggle('hidden', scope.dataset.metadataDirty !== 'true');

        if (keyStatus && fpcalcStatus) {
            if (metadataSettingsState.loading) {
                keyStatus.textContent = 'Checking...';
                keyStatus.dataset.status = 'unknown';
                fpcalcStatus.textContent = 'Checking...';
                fpcalcStatus.dataset.status = 'unknown';
            } else {
                const statusesReadable = metadataSettingsState.apiSupport === 'available' && !metadataSettingsState.loadFailed;
                if (statusesReadable && metadataSettingsState.acoustidStatusKnown) {
                    keyStatus.textContent = metadataSettingsState.acoustidConfigured
                        ? (metadataSettingsState.acoustidKeySource === 'environment' ? 'Managed by server' : 'Key saved')
                        : 'No key saved';
                    keyStatus.dataset.status = metadataSettingsState.acoustidConfigured ? 'configured' : 'missing';
                } else {
                    keyStatus.textContent = 'Status unavailable';
                    keyStatus.dataset.status = 'unknown';
                }
                if (statusesReadable && metadataSettingsState.fpcalcStatusKnown) {
                    const sourceLabels = {
                        bundled: 'Bundled',
                        'bundled-x64-emulation': 'Bundled (compatible)',
                        environment: 'Server configured',
                        path: 'Found on server'
                    };
                    fpcalcStatus.textContent = metadataSettingsState.fpcalcAvailable
                        ? (sourceLabels[metadataSettingsState.fpcalcSource] || 'Ready')
                        : 'Unavailable';
                    fpcalcStatus.dataset.status = metadataSettingsState.fpcalcAvailable ? 'available' : 'unavailable';
                } else {
                    fpcalcStatus.textContent = 'Status unavailable';
                    fpcalcStatus.dataset.status = 'unknown';
                }
            }
        }

        if (metadataSettingsState.apiSupport === 'missing') {
            setMetadataNotice(scope, isSettingsScope
                ? 'Metadata settings are unavailable on this server.'
                : 'This server does not expose metadata settings. Setup will continue with local analysis.');
        } else if (metadataSettingsState.loadFailed) {
            setMetadataNotice(scope, isSettingsScope
                ? 'Current metadata settings could not be loaded. Choose a method and save to try again.'
                : 'Current metadata settings could not be loaded. Setup can still continue with local analysis.');
        } else if (metadataSettingsState.clearKeyUnsupported) {
            setMetadataNotice(scope, 'This server does not expose AcoustID key removal. Lookup modes can still be saved.');
        } else {
            setMetadataNotice(scope, '');
        }
    }

    function renderMetadataScopes(forceMode = false) {
        metadataScopes().forEach(scope => renderMetadataScope(scope, forceMode));
    }

    async function loadMetadataSettings() {
        if (metadataLoadPromise) return metadataLoadPromise;

        metadataSettingsState.loading = true;
        metadataSettingsState.loadFailed = false;
        renderMetadataScopes();

        metadataLoadPromise = (async () => {
            try {
                const response = await fetch(metadataEndpoint(), { credentials: 'include' });
                const data = await response.json().catch(() => ({}));

                if (isMissingMetadataEndpoint(response)) {
                    metadataSettingsState.apiSupport = 'missing';
                    metadataSettingsState.mode = 'local_only';
                    metadataSettingsState.acoustidConfigured = false;
                    metadataSettingsState.acoustidKeySource = null;
                    metadataSettingsState.acoustidStoredKeyConfigured = false;
                    metadataSettingsState.fpcalcAvailable = false;
                    metadataSettingsState.fpcalcSource = null;
                    metadataSettingsState.acoustidStatusKnown = false;
                    metadataSettingsState.fpcalcStatusKnown = false;
                    clearMetadataKeyInputs();
                    return false;
                }

                metadataSettingsState.apiSupport = 'available';
                if (!response.ok) throw new Error(data.error || 'Could not load metadata settings.');

                metadataSettingsState.mode = normalizeMetadataMode(data.mode);
                metadataSettingsState.acoustidConfigured = data.acoustid_configured === true;
                metadataSettingsState.acoustidKeySource = data.acoustid_key_source || null;
                metadataSettingsState.acoustidStoredKeyConfigured = typeof data.acoustid_stored_key_configured === 'boolean'
                    ? data.acoustid_stored_key_configured
                    : data.acoustid_key_source === 'stored';
                metadataSettingsState.fpcalcAvailable = data.fpcalc_available === true;
                metadataSettingsState.fpcalcSource = data.fpcalc_source || null;
                metadataSettingsState.acoustidStatusKnown = typeof data.acoustid_configured === 'boolean';
                metadataSettingsState.fpcalcStatusKnown = typeof data.fpcalc_available === 'boolean';
                return true;
            } catch (error) {
                metadataSettingsState.loadFailed = true;
                console.warn('[METADATA SETTINGS] Could not load settings:', error.message);
                return false;
            } finally {
                metadataSettingsState.loading = false;
                const forceLocalMode = metadataSettingsState.apiSupport === 'missing';
                metadataLoadPromise = null;
                renderMetadataScopes(forceLocalMode);
            }
        })();

        return metadataLoadPromise;
    }

    async function saveMetadataSettings(scopeName, { allowLocalFallback = false } = {}) {
        if (metadataLoadPromise) await metadataLoadPromise;

        const scope = document.querySelector(`[data-metadata-scope="${scopeName}"]`);
        if (!scope) return false;

        if (metadataSettingsState.apiSupport === 'missing') {
            metadataSettingsState.mode = 'local_only';
            renderMetadataScopes(true);
            return allowLocalFallback;
        }

        const mode = selectedMetadataMode(scope);
        const keyInput = scope.querySelector('[data-acoustid-key]');
        if (mode === 'acoustic_with_text_fallback' && !metadataSettingsState.acoustidConfigured && (!keyInput || !keyInput.value.trim())) {
            setMetadataFormStatus(scope, 'Add an AcoustID application key before selecting audio fingerprint matching.', 'error');
            showToast('Enter an AcoustID application client key to use acoustic lookup.', 'warning');
            if (keyInput) keyInput.focus();
            return false;
        }

        const payload = { mode };
        if (keyInput && keyInput.value.trim()) {
            payload.acoustid_client_key = keyInput.value.trim();
        }

        scope.dataset.metadataBusy = 'true';
        setMetadataFormStatus(scope, '', '');
        renderMetadataScope(scope);

        try {
            const response = await fetch(metadataEndpoint(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const data = await response.json().catch(() => ({}));

            if (isMissingMetadataEndpoint(response)) {
                metadataSettingsState.apiSupport = 'missing';
                metadataSettingsState.mode = 'local_only';
                metadataSettingsState.acoustidConfigured = false;
                metadataSettingsState.acoustidKeySource = null;
                metadataSettingsState.acoustidStoredKeyConfigured = false;
                metadataSettingsState.fpcalcAvailable = false;
                metadataSettingsState.fpcalcSource = null;
                metadataSettingsState.acoustidStatusKnown = false;
                metadataSettingsState.fpcalcStatusKnown = false;
                clearMetadataKeyInputs();
                renderMetadataScopes(true);
                showToast('Metadata settings are unavailable; continuing without changing metadata behavior.', 'warning');
                return allowLocalFallback;
            }
            if (!response.ok || data.success === false) {
                throw new Error(data.error || 'Could not save metadata settings.');
            }

            metadataSettingsState.apiSupport = 'available';
            metadataSettingsState.loadFailed = false;
            metadataSettingsState.mode = metadataModes.has(data.mode) ? data.mode : mode;
            if (typeof data.acoustid_configured === 'boolean') {
                metadataSettingsState.acoustidConfigured = data.acoustid_configured;
                metadataSettingsState.acoustidStatusKnown = true;
            } else if (payload.acoustid_client_key) {
                metadataSettingsState.acoustidConfigured = true;
                metadataSettingsState.acoustidStatusKnown = true;
            }
            metadataSettingsState.acoustidKeySource = data.acoustid_key_source ||
                (metadataSettingsState.acoustidConfigured ? 'stored' : null);
            if (typeof data.acoustid_stored_key_configured === 'boolean') {
                metadataSettingsState.acoustidStoredKeyConfigured = data.acoustid_stored_key_configured;
            } else if (payload.acoustid_client_key) {
                metadataSettingsState.acoustidStoredKeyConfigured = true;
            }
            if (typeof data.fpcalc_available === 'boolean') {
                metadataSettingsState.fpcalcAvailable = data.fpcalc_available;
                metadataSettingsState.fpcalcStatusKnown = true;
            }
            metadataSettingsState.fpcalcSource = data.fpcalc_source || null;
            clearMetadataKeyInputs();
            metadataScopes().forEach(item => delete item.dataset.metadataDirty);
            renderMetadataScopes(true);
            setMetadataFormStatus(scope, 'Metadata settings saved.', 'success');
            showToast('Metadata settings saved.', 'success');
            return true;
        } catch (error) {
            console.warn('[METADATA SETTINGS] Could not save settings:', error.message);
            if (allowLocalFallback && mode === 'local_only') {
                showToast('Local-only setup will continue; the metadata preference could not be saved.', 'warning');
                return true;
            }
            setMetadataFormStatus(scope, error.message || 'Could not save metadata settings.', 'error');
            showToast(error.message || 'Could not save metadata settings.', 'error');
            return false;
        } finally {
            delete scope.dataset.metadataBusy;
            renderMetadataScope(scope);
        }
    }

    async function clearAcoustidKey(scope) {
        if (!scope || metadataSettingsState.apiSupport === 'missing') return;
        if (!window.confirm('Remove the saved AcoustID key? Acoustic matching will switch to text lookup if no server-managed key is available.')) return;

        scope.dataset.metadataBusy = 'true';
        setMetadataFormStatus(scope, '', '');
        renderMetadataScope(scope);
        try {
            const response = await fetch(metadataEndpoint() + '/acoustid-key', {
                method: 'DELETE',
                credentials: 'include'
            });
            const data = await response.json().catch(() => ({}));

            if (isMissingMetadataEndpoint(response)) {
                metadataSettingsState.clearKeyUnsupported = true;
                renderMetadataScopes();
                showToast('This server does not expose AcoustID key settings.', 'warning');
                return;
            }
            if (!response.ok || data.success === false) {
                throw new Error(data.error || 'Could not clear the AcoustID key.');
            }

            metadataSettingsState.apiSupport = 'available';
            metadataSettingsState.loadFailed = false;
            metadataSettingsState.clearKeyUnsupported = false;
            metadataSettingsState.mode = normalizeMetadataMode(data.mode);
            metadataSettingsState.acoustidConfigured = data.acoustid_configured === true;
            metadataSettingsState.acoustidKeySource = data.acoustid_key_source || null;
            metadataSettingsState.acoustidStoredKeyConfigured = data.acoustid_stored_key_configured === true;
            metadataSettingsState.acoustidStatusKnown = true;
            if (typeof data.fpcalc_available === 'boolean') {
                metadataSettingsState.fpcalcAvailable = data.fpcalc_available;
                metadataSettingsState.fpcalcStatusKnown = true;
            }
            metadataSettingsState.fpcalcSource = data.fpcalc_source || null;
            clearMetadataKeyInputs();
            metadataScopes().forEach(item => delete item.dataset.metadataDirty);
            renderMetadataScopes(true);
            const message = metadataSettingsState.acoustidConfigured
                ? 'Stored key removed; the server-managed key remains active.'
                : (data.mode_changed
                    ? 'Key removed. Matching switched to text lookup because acoustic matching requires a key.'
                    : 'AcoustID application key removed.');
            setMetadataFormStatus(scope, message, 'success');
            showToast(message, 'success');
        } catch (error) {
            console.warn('[METADATA SETTINGS] Could not clear key:', error.message);
            setMetadataFormStatus(scope, error.message || 'Could not remove the AcoustID key.', 'error');
            showToast(error.message || 'Could not clear the AcoustID key.', 'error');
        } finally {
            delete scope.dataset.metadataBusy;
            renderMetadataScope(scope);
        }
    }

    metadataScopes().forEach(scope => {
        scope.querySelectorAll('input[type="radio"]').forEach(input => {
            input.addEventListener('change', () => {
                scope.dataset.metadataDirty = 'true';
                setMetadataFormStatus(scope, '', '');
                renderMetadataScope(scope);
            });
        });

        const keyInput = scope.querySelector('[data-acoustid-key]');
        if (keyInput) {
            keyInput.addEventListener('input', () => {
                scope.dataset.metadataDirty = 'true';
                setMetadataFormStatus(scope, '', '');
                renderMetadataScope(scope);
            });
        }

        const clearKeyButton = scope.querySelector('[data-clear-acoustid-key]');
        if (clearKeyButton) clearKeyButton.addEventListener('click', () => clearAcoustidKey(scope));
    });

    const metadataSettingsForm = document.getElementById('metadata-settings-form');
    if (metadataSettingsForm) {
        metadataSettingsForm.addEventListener('submit', async event => {
            event.preventDefault();
            await saveMetadataSettings('settings');
        });
    }

    renderMetadataScopes();

    /* --- Appearance settings -------------------------------------------
     * Theme state is applied by theme.js in <head> to prevent a flash of the
     * default palette. This block only keeps the controls in sync with that
* shared controller. */
    const themeOptionGrid = document.getElementById('theme-option-grid');
    const customThemeColor = document.getElementById('custom-theme-color');
    const customThemeHex = document.getElementById('custom-theme-hex');
    const overallColorToggle = document.getElementById('overall-color-toggle');
    const themesExperimentToggle = document.getElementById('experimental-themes-toggle');
    const themesAppearanceControls = document.getElementById('themes-appearance-controls');
    const themesDisabledState = document.getElementById('themes-disabled-state');

    const renderThemeOptions = () => {
        if (!themeOptionGrid || !window.StreamifyTheme) return;
        const state = window.StreamifyTheme.getState();
        const options = [
            ...Object.entries(window.StreamifyTheme.presets),
            ['custom', { name: 'Custom', accent: state.customColor }]
        ];

        themeOptionGrid.replaceChildren(...options.map(([value, definition]) => {
            const label = document.createElement('label');
            label.className = 'theme-option';
            label.dataset.themeOption = value;

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'color-theme';
            input.value = value;

            const swatch = document.createElement('span');
            swatch.className = 'theme-swatch';
            swatch.setAttribute('aria-hidden', 'true');
            swatch.style.setProperty('--option-color', definition.accent);

            const name = document.createElement('span');
            name.textContent = definition.name;
            label.append(input, swatch, name);
            return label;
        }));
    };

renderThemeOptions();
    const themeInputs = document.querySelectorAll('input[name="color-theme"]');

    const syncExperimentalSettings = () => {
        const experiments = window.StreamifyExperiments;
        const enabled = Boolean(experiments && experiments.isEnabled('themes'));
        if (themesExperimentToggle) {
            themesExperimentToggle.checked = enabled;
            themesExperimentToggle.disabled = !experiments;
        }
        if (themesAppearanceControls) {
            themesAppearanceControls.classList.toggle('hidden', !enabled);
            themesAppearanceControls.setAttribute('aria-hidden', String(!enabled));
        }
        if (themesDisabledState) {
            themesDisabledState.classList.toggle('hidden', enabled);
            themesDisabledState.setAttribute('aria-hidden', String(enabled));
        }
    };

const syncAppearanceSettings = () => {
        if (!window.StreamifyTheme) return;
        const state = window.StreamifyTheme.getState();
        themeInputs.forEach(input => { input.checked = input.value === state.preset; });
        if (customThemeColor) customThemeColor.value = state.customColor;
        if (customThemeHex) customThemeHex.value = state.customColor.toUpperCase();
        if (overallColorToggle) overallColorToggle.checked = state.scope === 'overall';
        const customSwatch = themeOptionGrid?.querySelector('[data-theme-option="custom"] .theme-swatch');
        if (customSwatch) customSwatch.style.setProperty('--option-color', state.customColor);
    };

themeInputs.forEach(input => {
        input.addEventListener('change', () => {
            if (!input.checked || !window.StreamifyTheme) return;
            window.StreamifyTheme.setTheme(input.value, customThemeColor?.value);
        });
    });

    if (customThemeColor) {
        const applyCustomTheme = () => {
            if (!window.StreamifyTheme) return;
            window.StreamifyTheme.setTheme('custom', customThemeColor.value);
        };
        customThemeColor.addEventListener('input', applyCustomTheme);
    }

    if (overallColorToggle) {
        overallColorToggle.addEventListener('change', () => {
            if (!window.StreamifyTheme) return;
            const state = window.StreamifyTheme.getState();
            window.StreamifyTheme.setTheme(state.preset, state.customColor, {
                scope: overallColorToggle.checked ? 'overall' : 'accent'
            });
        });
    }

    if (themesExperimentToggle) {
        themesExperimentToggle.addEventListener('change', () => {
            if (!window.StreamifyExperiments) return;
            window.StreamifyExperiments.setEnabled('themes', themesExperimentToggle.checked);
        });
    }

    window.addEventListener('streamifythemechange', syncAppearanceSettings);
    window.addEventListener('streamifyexperimentchange', event => {
        if (!event.detail || event.detail.feature === 'themes') syncExperimentalSettings();
    });
    syncExperimentalSettings();
    syncAppearanceSettings();

    const visibleSettingsTabs = () => Array.from(settingsTabs).filter(tab => !tab.classList.contains('hidden'));
    const settingsTabList = document.querySelector('.settings-sidebar[role="tablist"]');
    const updateSettingsTabOrientation = () => {
        if (settingsTabList) settingsTabList.setAttribute('aria-orientation', window.innerWidth <= 768 ? 'horizontal' : 'vertical');
    };
    updateSettingsTabOrientation();
    window.addEventListener('resize', updateSettingsTabOrientation);

    const activateSettingsTab = target => {
        const availableTabs = visibleSettingsTabs();
        const targetTab = availableTabs.find(tab => tab.dataset.tab === target) || availableTabs[0];
        if (!targetTab) return;

        settingsTabs.forEach(tab => {
            const active = tab === targetTab;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
        });
        settingsPanes.forEach(pane => {
            const active = pane.id === `pane-${targetTab.dataset.tab}`;
            pane.classList.toggle('active', active);
            pane.setAttribute('aria-hidden', String(!active));
        });

        const isOwnerRole = appCache.user && String(appCache.user.role || '').toLowerCase() === 'owner';
        if (targetTab.dataset.tab === 'account') {
            loadSessions();
            if (appCache.user && appCache.user.role === 'Owner') loadMusicDirectories();
        } else if (targetTab.dataset.tab === 'metadata' && isOwnerRole) {
            loadMetadataSettings();
        } else if (targetTab.dataset.tab === 'downloads' && isOwnerRole) {
            loadDownloadSettings();
        } else if (targetTab.dataset.tab === 'discord') {
            loadDiscordSettings();
        }

        // The Discord pane polls its connection status while it is open, so a
        // silent failure (Discord closed) is visible instead of mysterious.
        setDiscordStatusPolling(targetTab.dataset.tab === 'discord');

        // The updater pushes its own state, so the pane only has to say when
        // it is worth painting.
        if (window.StreamifyUpdates && window.StreamifyUpdates.isSupported()) {
            if (targetTab.dataset.tab === 'updates') window.StreamifyUpdates.load();
            else window.StreamifyUpdates.unload();
        }
    };

    /* --- Downloads settings (Soulseek account) --- */

    const downloadSettingsStatus = (message, kind = '') => {
        const target = document.getElementById('downloads-settings-status');
        if (!target) return;
        target.textContent = message || '';
        target.className = `downloads-setting-status${kind ? ` is-${kind}` : ''}`;
    };

    function renderDownloadSettings(data) {
        const usernameInput = document.getElementById('soulseek-username');
        const passwordInput = document.getElementById('soulseek-password');
        const folder = document.getElementById('downloads-settings-folder');
        const soulseek = (data && data.soulseek) || {};

        if (usernameInput) {
            usernameInput.value = soulseek.username || '';
            usernameInput.disabled = Boolean(soulseek.fromEnvironment);
        }
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.placeholder = soulseek.configured ? 'Saved - type to replace' : 'Your Soulseek password';
            passwordInput.disabled = Boolean(soulseek.fromEnvironment);
        }
        
        if (folder) {
            folder.textContent = data && data.downloadFolder
                ? data.downloadFolder
                : 'No music directory configured yet.';
        }

        if (soulseek.fromEnvironment) {
            downloadSettingsStatus('Using SLSK_USER / SLSK_PASS from the environment.', 'ok');
        } else if (soulseek.connected) {
            downloadSettingsStatus(`Connected as ${soulseek.connectedAs || soulseek.username}.`, 'ok');
        } else if (soulseek.configured) {
            downloadSettingsStatus(soulseek.error || 'Saved. Use "Test connection" to verify.', soulseek.error ? 'error' : '');
        } else {
            downloadSettingsStatus('Not configured. Add an account to enable music search.', '');
        }
    }

    async function loadDownloadSettings() {
        try {
            const res = await fetch('/api/settings/downloads');
            if (!res.ok) return;
            renderDownloadSettings(await res.json());
        } catch (err) {
            console.error('[DOWNLOAD SETTINGS]', err);
        }
    }

    const downloadSettingsForm = document.getElementById('downloads-settings-form');
    if (downloadSettingsForm) {
        downloadSettingsForm.addEventListener('submit', async e => {
            e.preventDefault();
            const username = document.getElementById('soulseek-username')?.value.trim();
            const password = document.getElementById('soulseek-password')?.value;

            if (!username || !password) {
                downloadSettingsStatus('Enter both a username and a password.', 'error');
                return;
            }

            downloadSettingsStatus('Saving...', 'busy');
            try {
                const res = await fetch('/api/settings/downloads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not save.');

                renderDownloadSettings(data);
                downloadSettingsStatus('Saved. Testing the connection...', 'busy');
                await testSoulseekConnection();
                showToast('Soulseek account saved.', 'success');
            } catch (err) {
                downloadSettingsStatus(err.message, 'error');
            }
        });
    }

    async function testSoulseekConnection() {
        downloadSettingsStatus('Connecting to Soulseek...', 'busy');
        try {
            const res = await fetch('/api/settings/downloads/test', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not reach Soulseek.');

            if (data.ok) downloadSettingsStatus('Connected successfully.', 'ok');
            else downloadSettingsStatus(data.error || 'Could not connect.', 'error');
            return data.ok;
        } catch (err) {
            downloadSettingsStatus(err.message, 'error');
            return false;
        }
    }

    const soulseekTestBtn = document.getElementById('soulseek-test-btn');
    if (soulseekTestBtn) {
        soulseekTestBtn.addEventListener('click', async () => {
            soulseekTestBtn.disabled = true;
            try { await testSoulseekConnection(); } finally { soulseekTestBtn.disabled = false; }
        });
    }

    const soulseekClearBtn = document.getElementById('soulseek-clear-btn');
    if (soulseekClearBtn) {
        soulseekClearBtn.addEventListener('click', async () => {
            if (!window.confirm('Remove the saved Soulseek account? Music search and Spotify imports will stop working.')) return;
            try {
                const res = await fetch('/api/settings/downloads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clear: true })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not remove.');
                renderDownloadSettings(data);
                showToast('Soulseek account removed.', 'success');
            } catch (err) {
                downloadSettingsStatus(err.message, 'error');
            }
        });
    }

    // Used by the "Add account" shortcut on the Get Music page.
    window.openDownloadSettings = () => openSettings('downloads');

    const applyOwnerOnlyControls = () => {
        const isOwner = appCache.user && String(appCache.user.role || '').toLowerCase() === 'owner';
        const musicDirectoriesSetting = document.getElementById('music-directories-setting');
        const refreshButton = document.getElementById('refresh-library-btn');
        const batchEnrichButton = document.getElementById('batch-ai-enrich-btn');
        const autoFillButton = document.getElementById('ai-autofill-btn');
        const metadataTab = document.getElementById('metadata-settings-tab');
        const metadataPane = document.getElementById('pane-metadata');
        const downloadsTab = document.getElementById('downloads-settings-tab');
        const downloadsPane = document.getElementById('pane-downloads');
        const downloadsNav = document.querySelector('.owner-only-nav');
        if (musicDirectoriesSetting) musicDirectoriesSetting.classList.toggle('hidden', !isOwner);
        if (refreshButton) refreshButton.classList.toggle('hidden', !isOwner);
        if (batchEnrichButton) batchEnrichButton.classList.toggle('hidden', !isOwner);
        if (autoFillButton) autoFillButton.classList.toggle('hidden', !isOwner);
        if (metadataTab) metadataTab.classList.toggle('hidden', !isOwner);
        if (metadataPane) metadataPane.classList.toggle('hidden', !isOwner);
        if (downloadsTab) downloadsTab.classList.toggle('hidden', !isOwner);
        if (downloadsPane) downloadsPane.classList.toggle('hidden', !isOwner);
        // Server routes are Owner-gated too; this only removes the entry point.
        if (downloadsNav) downloadsNav.classList.toggle('hidden', !isOwner);

        if (!isOwner && metadataPane && metadataPane.classList.contains('active')) {
            activateSettingsTab('profile');
        }
        if (!isOwner && downloadsPane && downloadsPane.classList.contains('active')) {
            activateSettingsTab('profile');
        }

        // The public-URL field configures the server itself, so it stays Owner
        // only even though the rest of the Discord pane is per-device.
        const discordPublicUrlSetting = document.getElementById('discord-public-url-setting');
        if (discordPublicUrlSetting) discordPublicUrlSetting.classList.toggle('hidden', !isOwner);

        // Auto-update is server-wide: everyone can read the status and run a
        // manual check, but only the Owner sees the switch.
        const autoUpdateSetting = document.getElementById('auto-update-setting');
        if (autoUpdateSetting) autoUpdateSetting.classList.toggle('hidden', !isOwner);
    };

    /* --- Discord Rich Presence settings ---------------------------------
     * Gated on the desktop app rather than on a role: Discord's RPC runs over
     * a local socket, so the whole pane is meaningless in a browser or on a
     * phone. The toggles are per-device (localStorage), because presence
     * belongs to the machine Discord is running on, not to the account. */

    const discordSettingsStatus = (message, kind = '') => {
        const target = document.getElementById('discord-settings-status');
        if (!target) return;
        target.textContent = message || '';
        target.className = `downloads-setting-status${kind ? ` is-${kind}` : ''}`;
    };

    const renderDiscordStatus = status => {
        const toggle = document.getElementById('discord-rpc-toggle');
        const enabled = Boolean(toggle && toggle.checked);

        if (!enabled) {
            discordSettingsStatus('Rich Presence is off. Nothing is shared with Discord.', '');
            return;
        }
        if (!status) {
            discordSettingsStatus('Could not reach the desktop app.', 'error');
            return;
        }
        if (!status.configured) {
            discordSettingsStatus('This build has no Discord application ID.', 'error');
            return;
        }
        if (status.connected) {
            discordSettingsStatus(
                status.user ? `Connected to Discord as ${status.user}.` : 'Connected to Discord.', 'ok');
            return;
        }
        if (status.connecting) {
            discordSettingsStatus('Looking for Discord...', 'busy');
            return;
        }
        discordSettingsStatus(
            status.error || 'Discord is not running. It will connect automatically once you start it.', 'busy');
    };

    const refreshDiscordStatus = async () => {
        if (!window.StreamifyDiscord || !window.StreamifyDiscord.isSupported()) return;
        renderDiscordStatus(await window.StreamifyDiscord.getStatus());
    };

    let discordStatusTimer = null;
    // A declaration, not a const: activateSettingsTab is defined above this
    // point and calls it, so hoisting keeps the order safe either way.
    function setDiscordStatusPolling(active) {
        clearInterval(discordStatusTimer);
        discordStatusTimer = null;
        if (!active || !window.StreamifyDiscord || !window.StreamifyDiscord.isSupported()) return;
        // Reconnects run on a backoff of up to a minute, so a slow poll is
        // enough to reflect them. It stops as soon as the pane is left.
        discordStatusTimer = setInterval(refreshDiscordStatus, 3000);
    }

    async function loadDiscordSettings() {
        if (!window.StreamifyDiscord || !window.StreamifyDiscord.isSupported()) return;

        const toggle = document.getElementById('discord-rpc-toggle');
        if (toggle) toggle.checked = window.StreamifyDiscord.isEnabled();
        const artworkMode = window.StreamifyDiscord.artworkMode();
        document.querySelectorAll('input[name="discord-artwork-mode"]').forEach(input => {
            input.checked = input.value === artworkMode;
        });

        await refreshDiscordStatus();

        // The public URL is server state and Owner-gated; a non-Owner simply
        // never sees the field, and the request would be rejected anyway.
        const isOwner = appCache.user && String(appCache.user.role || '').toLowerCase() === 'owner';
        if (!isOwner) return;

        try {
            const res = await fetch((window.API_BASE_URL || '') + '/api/settings/discord');
            if (!res.ok) return;
            const data = await res.json();
            const input = document.getElementById('discord-public-url');
            if (input) input.value = data.publicUrl || '';
        } catch (err) {
            console.error('[DISCORD SETTINGS]', err);
        }
    }

    /* Reveals the Discord and Updates panes in the desktop app. The markup
     * ships hidden so a browser never shows a tab it cannot use.
     *
     * Gated on the preload bridge itself rather than on any one feature: both
     * panes need Node in the main process, and neither is meaningful without
     * it. Each pane still guards its own bridge before calling into it. */
    const applyDesktopOnlyControls = () => {
        const isDesktop = Boolean(window.streamifyDesktop);
        document.querySelectorAll('.desktop-only-setting').forEach(el => {
            el.classList.toggle('hidden', !isDesktop);
        });
    };

    let settingsReturnFocus = null;
    const openSettings = async (targetTab = null) => {
        if (userMenu) userMenu.classList.remove('show');
        if (userPill) userPill.setAttribute('aria-expanded', 'false');
        const activeElement = document.activeElement;
        const activeInHiddenModal = activeElement && activeElement.closest && activeElement.closest('.modal-overlay.hidden');
        settingsReturnFocus = activeElement && activeElement !== document.body && !activeInHiddenModal
            ? activeElement
            : settingsBtn;
        settingsModal.classList.remove('hidden');
        requestAnimationFrame(() => settingsModal.querySelector('.settings-modal-box')?.focus());
        if (!appCache.user) await fetchCurrentUser();
        populateSettings();
        const isOwner = appCache.user && String(appCache.user.role || '').toLowerCase() === 'owner';
        activateSettingsTab(targetTab === 'metadata' && !isOwner ? 'profile' : (targetTab || document.querySelector('.settings-tab.active')?.dataset.tab || 'profile'));
        requestAnimationFrame(() => {
            const activeTab = document.querySelector('.settings-tab.active');
            if (activeTab) activeTab.focus();
            else settingsModal.querySelector('.settings-modal-box')?.focus();
        });
    };

    const closeSettings = (force = false) => {
        const metadataForm = document.getElementById('metadata-settings-form');
        const hasUnsavedMetadata = metadataForm && metadataForm.dataset.metadataDirty === 'true';
        if (!force && hasUnsavedMetadata && !window.confirm('Discard unsaved metadata settings?')) return false;
        if (hasUnsavedMetadata) {
            delete metadataForm.dataset.metadataDirty;
            clearMetadataKeyInputs();
            setMetadataFormStatus(metadataForm, '', '');
            renderMetadataScopes(true);
        }
        if (settingsModal) settingsModal.classList.add('hidden');
        setDiscordStatusPolling(false);
        if (window.StreamifyUpdates && window.StreamifyUpdates.isSupported()) window.StreamifyUpdates.unload();
        if (settingsReturnFocus && settingsReturnFocus.isConnected) settingsReturnFocus.focus();
        settingsReturnFocus = null;
        return true;
    };
    window.openMetadataSettings = () => openSettings('metadata');

    const populateSettings = () => {
        syncAppearanceSettings();
        if (!appCache.user) return;
        applyOwnerOnlyControls();
        applyDesktopOnlyControls();
        const dispNameInput = document.getElementById('settings-display-name');
        const bioInput = document.getElementById('settings-bio');
        const preview = document.getElementById('settings-avatar-preview');
        const analyticsToggle = document.getElementById('allow-analytics-toggle');
        const registrationSetting = document.getElementById('registration-setting');
        const registrationToggle = document.getElementById('allow-registration-toggle');

        dispNameInput.value = appCache.user.display_name || appCache.user.username;
        bioInput.value = appCache.user.bio || "";

        if (analyticsToggle) {
            analyticsToggle.checked = appCache.user.allow_analytics !== false;
        }

        if (registrationSetting) {
            const isOwner = appCache.user.role === 'Owner';
            registrationSetting.classList.toggle('hidden', !isOwner);
            if (registrationToggle && isOwner) registrationToggle.checked = appCache.user.allow_registration === true;
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
    if (closeModalBtn) closeModalBtn.addEventListener('click', () => closeSettings());
    if (settingsModal) settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });

    // Tab Switching
    settingsTabs.forEach(tab => {
        tab.addEventListener('click', () => activateSettingsTab(tab.dataset.tab));
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = visibleSettingsTabs();
            const currentIndex = Math.max(0, tabs.indexOf(tab));
            let nextIndex = currentIndex;
            if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = tabs.length - 1;
            else nextIndex = (currentIndex + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
            const nextTab = tabs[nextIndex];
            if (nextTab) {
                activateSettingsTab(nextTab.dataset.tab);
                nextTab.focus();
            }
        });
    });

    if (settingsModal) {
        settingsModal.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeSettings();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(settingsModal.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
            )).filter(element => !element.classList.contains('hidden') && element.getClientRects().length > 0);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
    }

    /* ===================================================
     * CONNECT PHONE (QR CODE MODAL)
     * =================================================== */
    const connectPhoneLink = document.getElementById('connect-phone-link');
    const connectPhoneModal = document.getElementById('connect-phone-modal');
    const closeConnectPhoneBtn = document.getElementById('close-connect-phone-btn');
    const connectPhoneQrImg = document.getElementById('connect-phone-qr-img');
    const connectPhoneUrlText = document.getElementById('connect-phone-url-text');
    const copyConnectUrlBtn = document.getElementById('copy-connect-url-btn');

    let activeConnectUrl = '';

    const openConnectPhone = async () => {
        if (!connectPhoneModal) return;
        connectPhoneModal.classList.remove('hidden');
        if (connectPhoneUrlText) connectPhoneUrlText.textContent = 'Generating connection info...';

        try {
            const res = await fetch((window.API_BASE_URL || '') + '/api/system/connect-info', {
                cache: 'no-store'
            });
            if (!res.ok) throw new Error('Failed to load connection info');
            const data = await res.json();
            activeConnectUrl = data.primary_url || (data.urls && data.urls[0]) || '';

            if (connectPhoneQrImg && data.qr_data_url) {
                connectPhoneQrImg.src = data.qr_data_url;
            }
            if (connectPhoneUrlText) {
                connectPhoneUrlText.textContent = activeConnectUrl;
            }
        } catch (err) {
            console.error('[CONNECT-PHONE]', err);
            if (connectPhoneUrlText) {
                connectPhoneUrlText.textContent = window.location.origin;
            }
        }
    };

    const closeConnectPhone = () => {
        if (connectPhoneModal) connectPhoneModal.classList.add('hidden');
    };

    if (connectPhoneLink) {
        if (window.StreamifyEnv && window.StreamifyEnv.isCapacitor) {
            const span = connectPhoneLink.querySelector('span');
            if (span) span.textContent = 'Server Connection';
            const icon = connectPhoneLink.querySelector('i');
            if (icon) icon.className = 'bx bx-server';
            connectPhoneLink.addEventListener('click', e => {
                e.preventDefault();
                if (confirm(`Currently connected to:\n${window.API_BASE_URL || 'Local Server'}\n\nDo you want to disconnect and change server?`)) {
                    localStorage.removeItem('streamify_server_url');
                    localStorage.removeItem('streamify_session_id');
                    window.location.replace('/index.html');
                }
            });
        } else {
            connectPhoneLink.addEventListener('click', e => {
                e.preventDefault();
                openConnectPhone();
            });
        }
    }
    if (closeConnectPhoneBtn) {
        closeConnectPhoneBtn.addEventListener('click', closeConnectPhone);
    }
    if (connectPhoneModal) {
        connectPhoneModal.addEventListener('click', e => {
            if (e.target === connectPhoneModal) closeConnectPhone();
        });
        connectPhoneModal.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeConnectPhone();
        });
    }
    if (copyConnectUrlBtn) {
        copyConnectUrlBtn.addEventListener('click', async () => {
            const urlToCopy = activeConnectUrl || connectPhoneUrlText?.textContent || '';
            if (!urlToCopy) return;
            const ok = await window.copyToClipboard(urlToCopy);
            if (ok) {
                copyConnectUrlBtn.textContent = 'Copied!';
                setTimeout(() => { copyConnectUrlBtn.textContent = 'Copy'; }, 2000);
            }
        });
    }

    async function loadMusicDirectories() {
        const listEl = document.getElementById('music-dirs-list');
        if (!listEl) return;
        try {
            const res = await fetch('/api/config/music-directories');
            if (res.ok) {
                const data = await res.json();
                renderMusicDirectories(data.directories || []);
            }
        } catch (err) {
            console.error('[LOAD MUSIC DIRS]', err);
        }
    }

    function renderMusicDirectories(directories) {
        const listEl = document.getElementById('music-dirs-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        if (!directories || directories.length === 0) {
            listEl.innerHTML = '<p style="color:#888; font-size:12px;">No directories configured.</p>';
            return;
        }
        directories.forEach((dir, index) => {
            const item = document.createElement('div');
            item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.04); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);';
            const safeDir = typeof escapeHTML === 'function' ? escapeHTML(dir) : dir;
            item.innerHTML = `
                <span style="font-size: 13px; font-family: monospace; color: #eee; word-break: break-all;">${safeDir}</span>
                ${directories.length > 1 ? `<button type="button" class="btn-remove-dir" style="background: none; border: none; color: #f43f5e; cursor: pointer; padding: 4px; font-size: 16px;"><i class='bx bx-trash'></i></button>` : ''}
            `;
            const removeBtn = item.querySelector('.btn-remove-dir');
            if (removeBtn) {
                removeBtn.onclick = async () => {
                    const newDirs = directories.filter((_, i) => i !== index);
                    await updateMusicDirectories(newDirs);
                };
            }
            listEl.appendChild(item);
        });
    }

    async function updateMusicDirectories(directories) {
        try {
            const res = await fetch('/api/config/music-directories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ directories })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                showToast('Music directories updated!', 'success');
                renderMusicDirectories(data.directories);
                if (typeof fetchLibrary === 'function') fetchLibrary(true);
                else if (typeof fetchSongs === 'function') fetchSongs();
            } else {
                showToast(data.error || 'Failed to update music directories.', 'error');
            }
        } catch (err) {
            console.error('[UPDATE MUSIC DIRS]', err);
            showToast('Error updating music directories.', 'error');
        }
    }

    /* ===================================================
     * NATIVE FOLDER PICKER (desktop app only)
     * ===================================================
     * In a browser there is no way to obtain a real filesystem path, so the
     * music directory has to be typed by hand. The Electron shell exposes a
     * native picker via the preload bridge, so when it is available we add a
     * "Browse" button beside the relevant inputs.
     *
     * This is a progressive enhancement: in a normal browser, or on a phone,
     * nothing changes and the text input keeps working exactly as before.
     */
    function attachFolderPicker(inputEl) {
        if (!inputEl) return;
        if (!window.streamifyDesktop || typeof window.streamifyDesktop.pickFolder !== 'function') return;
        if (inputEl.dataset.pickerAttached === '1') return;
        inputEl.dataset.pickerAttached = '1';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-secondary folder-picker-btn';
        btn.innerHTML = "<i class='bx bx-folder-open'></i> Browse";
        btn.style.cssText =
            'flex-shrink:0;padding:8px 14px;font-size:13px;border-radius:6px;cursor:pointer;' +
            'border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.07);color:#fff;' +
            'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;';

        btn.addEventListener('click', async () => {
            try {
                const picked = await window.streamifyDesktop.pickFolder({
                    title: 'Select your music folder'
                });
                if (picked) {
                    inputEl.value = picked;
                    // Let any existing listeners react to the change.
                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (err) {
                console.error('[DESKTOP] Folder picker failed:', err);
                showToast('Could not open the folder picker.', 'error');
            }
        });

        // The settings input sits in a flex row; the OOBE one is full width.
        // Inserting directly after the input works for both, but the OOBE input
        // needs its own row so the button does not overflow.
        const parent = inputEl.parentElement;
        if (parent && getComputedStyle(parent).display === 'flex') {
            parent.insertBefore(btn, inputEl.nextSibling);
        } else {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
            row.appendChild(btn);
            inputEl.insertAdjacentElement('afterend', row);
        }
    }

    attachFolderPicker(document.getElementById('new-music-dir-input'));
    attachFolderPicker(document.getElementById('oobe-music-dir-input'));

    const addDirBtn = document.getElementById('add-music-dir-btn');
    const newDirInput = document.getElementById('new-music-dir-input');
    if (addDirBtn && newDirInput) {
        addDirBtn.onclick = async () => {
            const val = newDirInput.value.trim();
            if (!val) return;
            const currentItems = Array.from(document.querySelectorAll('#music-dirs-list span')).map(s => s.textContent);
            if (currentItems.includes(val)) {
                showToast('Directory path already exists in list.', 'warning');
                return;
            }
            const updated = [...currentItems, val];
            await updateMusicDirectories(updated);
            newDirInput.value = '';
        };
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
                        <div class="device-meta">${s.ip} \u2022 Started ${date}</div>
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
                const requestedValue = e.target.checked;
                const previousValue = appCache.user ? appCache.user.allow_analytics !== false : !requestedValue;
                e.target.disabled = true;
                const saved = await setAnalyticsEnabled(requestedValue);
                if (saved) {
                    if (appCache.user) appCache.user.allow_analytics = requestedValue;
                } else {
                    e.target.checked = previousValue;
                }
                e.target.disabled = false;
            }
        });
    }

    const registrationToggle = document.getElementById('allow-registration-toggle');
    if (registrationToggle) {
        registrationToggle.addEventListener('change', async (e) => {
            try {
                const res = await fetch(window.API_BASE_URL + '/api/settings/registration', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ enabled: e.target.checked })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update registration');
                if (appCache.user) appCache.user.allow_registration = data.allow_registration;
                showToast(e.target.checked ? 'Registration enabled.' : 'Registration disabled.', 'success');
            } catch (err) {
                e.target.checked = !e.target.checked;
                showToast(err.message, 'error');
            }
        });
    }

    const downloadDataBtn = document.getElementById('download-data-btn');
    if (downloadDataBtn) {
        downloadDataBtn.addEventListener('click', () => {
            window.location.href = window.API_BASE_URL + '/api/settings/privacy/export';
        });
    }

    /* --- Discord Rich Presence --- */

    const discordRpcToggle = document.getElementById('discord-rpc-toggle');
    if (discordRpcToggle) {
        discordRpcToggle.addEventListener('change', async (e) => {
            if (!window.StreamifyDiscord || !window.StreamifyDiscord.isSupported()) return;

            const requested = e.target.checked;
            e.target.disabled = true;
            discordSettingsStatus(requested ? 'Looking for Discord...' : 'Turning off...', 'busy');

            const status = await window.StreamifyDiscord.setEnabled(requested);
            e.target.disabled = false;

            if (requested && !status) {
                // The bridge itself failed, which is not the same as Discord
                // being closed. Roll the toggle back rather than lie about it.
                e.target.checked = false;
                await window.StreamifyDiscord.setEnabled(false);
            }
            renderDiscordStatus(status);
        });
    }

    document.querySelectorAll('input[name="discord-artwork-mode"]').forEach(input => {
        input.addEventListener('change', event => {
            if (!event.target.checked || !window.StreamifyDiscord || !window.StreamifyDiscord.isSupported()) return;
            window.StreamifyDiscord.setArtworkMode(event.target.value);
            const messages = {
                app_logo: 'Discord will always use the Streamify logo.',
                stored_only: 'Discord artwork will use stored and public covers only.',
                youtube_exact: 'Missing Discord artwork will use exact YouTube matches.',
                apple_only: 'Missing Discord artwork will use Apple Music matches only.',
                best_effort: 'Missing Discord artwork will use YouTube, then Apple as a fallback.'
            };
            showToast(messages[event.target.value] || 'Discord artwork setting updated.', 'success');
        });
    });

    const discordArtRefresh = document.getElementById('discord-art-refresh');
    if (discordArtRefresh) {
        discordArtRefresh.addEventListener('click', async () => {
            if (!window.StreamifyDiscord || !window.StreamifyDiscord.isSupported()) return;
            discordArtRefresh.disabled = true;
            const refreshed = await window.StreamifyDiscord.refreshArtwork();
            discordArtRefresh.disabled = false;
            showToast(
                refreshed ? 'Artwork cache cleared. The current track will be checked again.' : 'Play a library track before refreshing its artwork.',
                refreshed ? 'success' : 'info');
        });
    }

    const discordPublicUrlForm = document.getElementById('discord-public-url-form');
    if (discordPublicUrlForm) {
        const publicUrlStatus = (message, kind = '') => {
            const target = document.getElementById('discord-public-url-status');
            if (!target) return;
            target.textContent = message || '';
            target.className = `downloads-setting-status${kind ? ` is-${kind}` : ''}`;
        };

        discordPublicUrlForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const input = document.getElementById('discord-public-url');
            const publicUrl = input ? input.value.trim() : '';

            publicUrlStatus('Saving...', 'busy');
            try {
                const res = await fetch((window.API_BASE_URL || '') + '/api/settings/discord', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ publicUrl })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not save.');

                if (input) input.value = data.publicUrl || '';
                publicUrlStatus(
                    data.publicUrl
                        ? 'Saved. Discord will now load your own cover art.'
                        : 'Cleared. Discord will use matched or fallback artwork.',
                    'ok');
            } catch (err) {
                publicUrlStatus(err.message, 'error');
            }
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
    let cropTargetType = 'avatar';
    let cropObjectUrl = null;

    const destroyCropper = () => {
        const activeCropper = cropper || window.currentCropper;
        if (activeCropper) activeCropper.destroy();
        cropper = null;
        window.currentCropper = null;
        if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
        cropObjectUrl = null;
        if (cropImage) {
            cropImage.onload = null;
            cropImage.onerror = null;
            cropImage.removeAttribute('src');
        }
    };

    const closeCrop = () => {
        if (cropModal) cropModal.classList.add('hidden');
        destroyCropper();
        if (avatarInput) avatarInput.value = '';
        const bannerInput = document.getElementById('banner-upload-input');
        if (bannerInput) bannerInput.value = '';
    };

    window.openProfileCropper = (file, type = 'avatar') => {
        if (!file || !file.type.startsWith('image/') || !cropImage || !cropModal) return;
        destroyCropper();
        cropTargetType = type === 'banner' ? 'banner' : 'avatar';
        cropObjectUrl = URL.createObjectURL(file);
        const sourceUrl = cropObjectUrl;
        cropImage.onload = () => {
            if (sourceUrl !== cropObjectUrl) return;
            cropper = new Cropper(cropImage, {
                aspectRatio: cropTargetType === 'banner' ? 3 / 1 : 1,
                viewMode: cropTargetType === 'banner' ? 1 : 2,
                dragMode: 'move',
                background: false,
                autoCropArea: 1,
                responsive: true
            });
            window.currentCropper = cropper;
        };
        cropImage.onerror = closeCrop;
        cropImage.src = sourceUrl;
        cropModal.classList.remove('hidden');
    };

    if (triggerBtn && avatarInput) triggerBtn.addEventListener('click', () => avatarInput.click());
    if (avatarInput) {
        avatarInput.addEventListener('change', event => {
            const file = event.target.files[0];
            if (file) window.openProfileCropper(file, 'avatar');
        });
    }

    const discordPublicUrlClear = document.getElementById('discord-public-url-clear');
    if (discordPublicUrlClear && discordPublicUrlForm) {
        discordPublicUrlClear.addEventListener('click', () => {
            const input = document.getElementById('discord-public-url');
            if (input) input.value = '';
            discordPublicUrlForm.requestSubmit();
        });
    }

    if (cancelCropBtn) cancelCropBtn.addEventListener('click', closeCrop);
    if (closeCropBtn) closeCropBtn.addEventListener('click', closeCrop);

    if (applyCropBtn) {
        applyCropBtn.addEventListener('click', async () => {
            if (!cropper) return;

            const targetType = cropTargetType;
            applyCropBtn.disabled = true;
            applyCropBtn.textContent = 'Processing...';

            try {
                const canvas = cropper.getCroppedCanvas(targetType === 'banner'
                    ? { width: 1500, height: 500 }
                    : { width: 400, height: 400 });
                const mimeType = targetType === 'banner' ? 'image/jpeg' : 'image/png';
                const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, 0.92));
                if (!blob) throw new Error('Could not create cropped image');

                const formData = new FormData();
                const fieldName = targetType === 'banner' ? 'banner_file' : 'avatar_file';
                formData.append(fieldName, blob, targetType === 'banner' ? 'banner.jpg' : 'avatar.png');
                const endpoint = targetType === 'banner' ? '/api/upload-banner' : '/api/upload-avatar';
                const response = await fetch(window.API_BASE_URL + endpoint, {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || result.success === false) throw new Error(result.error || 'Upload failed');

                showToast(`${targetType === 'banner' ? 'Banner' : 'Avatar'} updated!`, 'success');
                closeCrop();
                await fetchCurrentUser(true);
                populateSettings();
                if (window.profileContextUser && typeof fetchDetailedProfile === 'function') {
                    fetchDetailedProfile(window.profileContextUser);
                }
            } catch (err) {
                console.error('[PROFILE IMAGE UPLOAD]', err);
                showToast(err.message || 'Error uploading image', 'error');
            } finally {
                applyCropBtn.disabled = false;
                applyCropBtn.textContent = 'Apply Crop';
            }
        });
    }

    /* ===================================================
     * SIDEBAR NAVIGATION
     * =================================================== */
    const homeLink = document.getElementById('home-link');
    const libraryLink = document.getElementById('library-link');
    const downloadsLink = document.getElementById('downloads-link');
    const peopleLink = document.getElementById('people-link');
    const uploadLink = document.getElementById('upload-link');
    const thanksLink = document.getElementById('thanks-link');
    const sidebarLogo = document.querySelector('.morph-logo');

    if (sidebarLogo && homeLink) {
        sidebarLogo.style.cursor = 'pointer';
        sidebarLogo.addEventListener('click', () => {
            homeLink.click();
        });
    }

    // Global view state for refreshes
    window.currentActiveView = 'library';


    const trendingSection = document.getElementById('trending-section');
    const downloadsSection = document.getElementById('downloads-section');
    const uploadSection = document.getElementById('upload-section');
    const searchSection = document.getElementById('search-section');
    const profileDetailSection = document.getElementById('profile-detail-section');
    const playlistDetailSection = document.getElementById('playlist-detail-section');
    const playerSection = document.getElementById('player-section'); // Added player section reference
    const dmSection = null;

    function showSection(section) {
        if (!section) return;
        
        // Ensure Owner-only cards are visible when needed
        if (section === uploadSection) {
            const spotifyCard = document.getElementById('spotify-import-card');
            if (spotifyCard && appCache.user && appCache.user.role === 'Owner') {
                spotifyCard.classList.remove('hidden');
            }
        }
        
        // hideAllSections removes this class before every normal navigation.
        // Add it back while revealing the section so the same animation starts
        // without a synchronous offsetWidth layout flush on the click frame.
        section.classList.remove('fade-in-animate');
        section.classList.add('fade-in-animate');
        section.classList.remove('hidden');
        section.addEventListener('animationend', () => {
            section.classList.remove('fade-in-animate');
        }, { once: true });
    }

    function hideAllSections({ preserveDedicatedPlayer = false } = {}) {
        if (
            !preserveDedicatedPlayer &&
            document.body.classList.contains('desktop-player-overlay-enabled') &&
            document.body.classList.contains('player-section-active') &&
            typeof window.closeDesktopPlayerOverlay === 'function'
        ) {
            window.closeDesktopPlayerOverlay({ animateUnderlay: false, focusCover: false });
        }
        if (
            !preserveDedicatedPlayer &&
            !document.body.classList.contains('desktop-player-overlay-enabled') &&
            document.body.classList.contains('player-section-active') &&
            typeof window.finalizeCloseDedicatedPlayer === 'function'
        ) {
            window.finalizeCloseDedicatedPlayer();
        }
        if (typeof window.cancelPlaylistDetailRequest === 'function') window.cancelPlaylistDetailRequest();
        if (window.currentActiveView !== 'playlist') {
            window.requestedPlaylistId = null;
            window.currentPlaylistId = null;
            window.currentPlaylistOwner = null;
            window.currentPlaylistIsPrivate = null;
        }
        if (window.currentActiveView !== 'search' && typeof window.cancelSearchRequest === 'function') {
            window.cancelSearchRequest(false);
        }
        if (window.currentActiveView !== 'downloads' && window.StreamifyDownloads) {
            window.StreamifyDownloads.close();
        }
        const routedSections = [trendingSection, downloadsSection, uploadSection, searchSection, profileDetailSection, playlistDetailSection];
        if (!document.body.classList.contains('desktop-player-overlay-enabled')) routedSections.push(playerSection);
        routedSections.forEach(sec => {
            if (sec) { sec.classList.add('hidden'); sec.classList.remove('fade-in-animate'); }
        });
        document.querySelector('.main-content')?.classList.remove('no-scroll');
        if (!preserveDedicatedPlayer) {
            if (typeof window.setDedicatedPlayerActive === 'function') {
                window.setDedicatedPlayerActive(false);
            } else {
                document.body.classList.remove('player-section-active');
                document.documentElement.classList.remove('player-chrome-active');
            }
            // Restore the flat app colour behind the browser toolbars; the
            // album-tinted value only applies inside the full-screen player.
            if (typeof setThemeColor === 'function' && typeof DEFAULT_THEME_COLOR !== 'undefined') {
                setThemeColor(DEFAULT_THEME_COLOR);
            }
        }
        [libraryLink, downloadsLink, uploadLink].forEach(l => l && l.classList.remove('active'));
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
        const mainContent = window.getAppScrollContainer();
        if (mainContent) mainContent.scrollTop = 0;
        window.scrollTo(0, 0);
    }

    // Export navigation helpers for api.js
    window.hideAllSections = hideAllSections;
    window.showSection = showSection;

    if (libraryLink) {
        libraryLink.addEventListener('click', e => {
            e.preventDefault();
            if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
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

    if (downloadsLink) {
        downloadsLink.addEventListener('click', e => {
            e.preventDefault();
            if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
            if (window.location.pathname !== '/home' || window.location.hash !== '#downloads') {
                history.pushState({ view: 'downloads' }, '', '/home#downloads');
            }
            window.currentActiveView = 'downloads';
            hideAllSections();
            downloadsLink.classList.add('active');
            showSection(downloadsSection);
            // Loads the queue and opens the progress socket on first view.
            if (window.StreamifyDownloads) window.StreamifyDownloads.open();
            document.title = "Streamify | Get Music";
        });
    }

    if (uploadLink) {
        uploadLink.addEventListener('click', e => {
            e.preventDefault();
            if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
            if (window.location.pathname !== '/home' || window.location.hash !== '#upload') {
                history.pushState({ view: 'upload' }, '', '/home#upload');
            }
            window.currentActiveView = 'upload';
            hideAllSections();
            uploadLink.classList.add('active');
            showSection(uploadSection);
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
            if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
            if (query.length > 0) {
                searchTimeout = setTimeout(() => {
                    window.currentActiveView = 'search';
                    hideAllSections();
                    showSection(searchSection);
                    performSearch(query);
                }, 500);
            } else {
                if (libraryLink) libraryLink.click();
            }
        });

        searchInput.addEventListener('keypress', e => {
            if (e.key === 'Enter') {
                if (searchTimeout) clearTimeout(searchTimeout);
                const query = searchInput.value.trim();
                if (!query) {
                    if (libraryLink) libraryLink.click();
                    return;
                }
                window.currentActiveView = 'search';
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
        if (feedCropImg) feedCropImg.removeAttribute('src');
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

            /* locked; no action */
        }, true); // Capture phase to preempt other listeners
    });

    /* ===================================================
     * LIBRARY MANAGEMENT
     * =================================================== */
    const refreshLibraryBtn = document.getElementById('refresh-library-btn');
    if (refreshLibraryBtn) {
        refreshLibraryBtn.addEventListener('click', async () => {
            const icon = refreshLibraryBtn.querySelector('i');
            if (icon) icon.classList.add('bx-spin');
            refreshLibraryBtn.disabled = true;
            try {
                const res = await fetch('/api/library/rescan', { method: 'POST' });
                if (res.ok) {
                    const data = await res.json();
                    showToast(`Rescan complete! ${data.syncedCount || 0} song(s) indexed.`, 'success');
                    if (typeof fetchLibrary === 'function') await fetchLibrary(true);
                    else if (typeof fetchSongs === 'function') await fetchSongs();
                } else {
                    showToast('Failed to rescan music library.', 'error');
                }
            } catch (err) {
                console.error('[RESCAN LIBRARY]', err);
                showToast('Error rescanning music library.', 'error');
            } finally {
                if (icon) icon.classList.remove('bx-spin');
                refreshLibraryBtn.disabled = false;
            }
        });
    }

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
    const aiAutofillBtn = document.getElementById('ai-autofill-btn');
    const openMetadataReviewBtn = document.getElementById('open-metadata-review-btn');

    // Smart Metadata Review workspace elements
    const aiMetadataModal = document.getElementById('ai-metadata-modal');
    const closeAiModalBtn = document.getElementById('close-ai-metadata-modal');
    const cancelAiModalBtn = document.getElementById('cancel-ai-metadata');
    const applyAiModalBtn = document.getElementById('apply-ai-metadata');
    const pauseAiJobBtn = document.getElementById('ai-pause-job');
    const cancelAiJobBtn = document.getElementById('ai-cancel-job');
    const startAiReviewBtn = document.getElementById('ai-start-review');
    const reviewSelectedMatchBtn = document.getElementById('ai-review-selected-match');
    const backToMatchesBtn = document.getElementById('ai-back-to-matches');
    const aiPreflightSettingsBtn = document.getElementById('ai-preflight-settings');
    const aiEmptySettingsBtn = document.getElementById('ai-empty-settings-action');
    let aiModalReturnFocus = null;

    const closeEditSong = () => {
        if (typeof window.cancelEditSongRequest === 'function') window.cancelEditSongRequest();
        if (editSongModal) editSongModal.classList.add('hidden');
    };
    const restoreAiModalFocus = () => {
        if (aiMetadataModal && aiMetadataModal.classList.contains('hidden') && aiModalReturnFocus && aiModalReturnFocus.isConnected) {
            aiModalReturnFocus.focus();
            aiModalReturnFocus = null;
        }
    };
    const closeAiModal = async () => {
        if (typeof window.requestCloseSmartMetadataReview === 'function') {
            await window.requestCloseSmartMetadataReview();
        } else {
            if (typeof window.cancelSmartMetadataReview === 'function') window.cancelSmartMetadataReview();
            if (aiMetadataModal) aiMetadataModal.classList.add('hidden');
        }
        restoreAiModalFocus();
    };

    if (closeEditSongBtn) closeEditSongBtn.addEventListener('click', closeEditSong);
    if (cancelEditSongBtn) cancelEditSongBtn.addEventListener('click', closeEditSong);
    if (editSongModal) editSongModal.addEventListener('click', e => { if (e.target === editSongModal) closeEditSong(); });

    if (saveSongChangesBtn) saveSongChangesBtn.addEventListener('click', saveSongChanges);

    const batchAiEnrichBtn = document.getElementById('batch-ai-enrich-btn');
    if (batchAiEnrichBtn) {
        batchAiEnrichBtn.addEventListener('click', () => {
            aiModalReturnFocus = batchAiEnrichBtn;
            if (typeof enrichBatchSongs === 'function') {
                enrichBatchSongs();
            }
        });
    }

    if (aiAutofillBtn) {
        aiAutofillBtn.addEventListener('click', () => {
            aiModalReturnFocus = aiAutofillBtn;
            if (typeof triggerSmartMetadataAutoFill === 'function') {
                triggerSmartMetadataAutoFill();
            }
        });
    }

    if (closeAiModalBtn) closeAiModalBtn.addEventListener('click', closeAiModal);

    if (cancelAiModalBtn) cancelAiModalBtn.addEventListener('click', async () => {
        if (typeof window.skipSmartMetadataItem === 'function') await window.skipSmartMetadataItem();
        restoreAiModalFocus();
    });

    if (aiMetadataModal) aiMetadataModal.addEventListener('click', e => { if (e.target === aiMetadataModal) closeAiModal(); });

    if (applyAiModalBtn) {
        applyAiModalBtn.addEventListener('click', () => {
            if (typeof applySmartReviewSelections === 'function') {
                applySmartReviewSelections();
            }
        });
    }

    if (openMetadataReviewBtn) {
        openMetadataReviewBtn.addEventListener('click', () => {
            if (!closeSettings(true)) return;
            aiModalReturnFocus = settingsBtn;
            if (typeof enrichBatchSongs === 'function') enrichBatchSongs();
        });
    }

    if (pauseAiJobBtn) pauseAiJobBtn.addEventListener('click', () => {
        if (typeof window.toggleSmartMetadataPause === 'function') window.toggleSmartMetadataPause();
    });

    if (cancelAiJobBtn) cancelAiJobBtn.addEventListener('click', () => {
        if (typeof window.cancelSmartMetadataJob === 'function') window.cancelSmartMetadataJob();
    });

    if (startAiReviewBtn) startAiReviewBtn.addEventListener('click', () => {
        if (typeof window.startSmartMetadataReview === 'function') window.startSmartMetadataReview();
    });

    if (reviewSelectedMatchBtn) reviewSelectedMatchBtn.addEventListener('click', () => {
        if (typeof window.reviewSelectedMetadataMatch === 'function') window.reviewSelectedMetadataMatch();
    });

    if (backToMatchesBtn) backToMatchesBtn.addEventListener('click', () => {
        if (typeof window.backToMetadataMatches === 'function') window.backToMetadataMatches();
    });

    [aiPreflightSettingsBtn, aiEmptySettingsBtn].forEach(button => {
        if (!button) return;
        button.addEventListener('click', () => {
            if (typeof window.openMetadataSettingsFromReview === 'function') window.openMetadataSettingsFromReview();
        });
    });

    if (aiMetadataModal) {
        aiMetadataModal.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                if (aiMetadataModal.getAttribute('aria-busy') !== 'true') {
                    event.preventDefault();
                    closeAiModal();
                }
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = Array.from(aiMetadataModal.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
                .filter(element => !element.classList.contains('hidden') && element.getClientRects().length > 0);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const workspace = aiMetadataModal.querySelector('.ai-enrich-workspace');
            if (event.shiftKey && (document.activeElement === first || document.activeElement === workspace)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
    }

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

        if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
        window.lastViewBeforePlaylist = window.currentActiveView;
        window.currentActiveView = 'playlist';
        window.requestedPlaylistId = playlistId;
        window.currentPlaylistId = null;

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
                libraryLink && libraryLink.click();
            } else {
                libraryLink && libraryLink.click();
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
            const id = Number(document.getElementById('rename-playlist-id').value);
            const name = document.getElementById('rename-playlist-name').value.trim();
            const bio = document.getElementById('rename-playlist-bio') ? document.getElementById('rename-playlist-bio').value.trim() : '';
            const visibility = document.getElementById('rename-playlist-visibility') ? document.getElementById('rename-playlist-visibility').value : 'private';
            if (!name || !Number.isSafeInteger(id) || id <= 0) return;

            confirmRenamePlaylistBtn.disabled = true;
            try {
                const res = await renamePlaylist(id, name, bio, visibility);
                if (window.currentPlaylistId !== id) return;
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
            if (appCache.user && window.currentPlaylistOwner === appCache.user.username) {
                playlistCoverUpload.click();
            }
        });
        playlistCoverUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            const playlistId = Number(window.currentPlaylistId);
            if (file && Number.isSafeInteger(playlistId) && playlistId > 0) {
                try {
                    const res = await uploadPlaylistCover(playlistId, file);
                    if (window.currentPlaylistId !== playlistId) return;
                    const coverUrl = res.success ? safeImageURL(res.cover) : '';
                    if (coverUrl) {
                        playlistDetailCover.style.backgroundImage = `url(${JSON.stringify(coverUrl)})`;
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
            const playlistId = Number(window.currentPlaylistId);
            if (!Number.isSafeInteger(playlistId) || playlistId <= 0) return;

            try {
                const res = await deletePlaylist(playlistId);
                if (window.currentPlaylistId !== playlistId) return;
                if (res.success) {
                    if (typeof fetchPlaylists === 'function') fetchPlaylists(true);
                    const lastView = window.lastViewBeforePlaylist || 'home';
                    if (lastView === 'library') {
                        libraryLink && libraryLink.click();
                    } else {
                        libraryLink && libraryLink.click();
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
    function isHomeOrRootRoute(path = window.location.pathname) {
        if (path === '/home' || path === '/' || path.endsWith('/home.html') || path.endsWith('/index.html')) return true;
        if (window.Capacitor || document.documentElement.classList.contains('is-capacitor') || document.documentElement.classList.contains('is-ios')) return true;
        return false;
    }

    function isInitialLibraryRoute() {
        const path = window.location.pathname;
        const hash = window.location.hash;
        const params = new URLSearchParams(window.location.search);
        if (params.has('playlist') || path.startsWith('/profile/')) return false;
        if (!isHomeOrRootRoute(path)) return false;
        return !hash || hash === '#library' || hash === '#feed' || hash === '#people';
    }

    async function preloadInitialLibraryVisuals(songs) {
        const urls = Array.from(new Set((songs || [])
            .slice(0, 12)
            .map(song => safeImageURL(song && song.cover))
            .filter(Boolean)));
        const imageWork = Promise.allSettled(urls.map(url => new Promise(resolve => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => {
                if (typeof image.decode === 'function') image.decode().catch(() => undefined).finally(resolve);
                else resolve();
            };
            image.onerror = resolve;
            image.src = url;
        })));
        const fontWork = document.fonts?.ready || Promise.resolve();
        const timeout = new Promise(resolve => setTimeout(resolve, 700));
        await Promise.race([Promise.allSettled([imageWork, fontWork]), timeout]);
    }

    async function revealInitialLibrary(libraryPromise) {
        if (!isHomeOrRootRoute(window.location.pathname)) return false;

        window.currentActiveView = 'library';
        hideAllSections();
        libraryLink?.classList.add('active');
        document.title = 'Streamify | Library';
        if (window.location.hash !== '#library') {
            const isCap = window.Capacitor || document.documentElement.classList.contains('is-capacitor');
            const targetUrl = isCap ? `${window.location.pathname}#library` : '/home#library';
            try {
                history.replaceState({ view: 'library' }, '', targetUrl);
            } catch (e) {
                // Ignore history rewrite errors on restricted mobile webviews
            }
        }

        const songs = await libraryPromise;
        if (window.currentActiveView !== 'library') return false;

        const list = document.getElementById('trending-list');
        renderSongList(Array.isArray(songs) ? songs : [], list, {
            allowHiddenInitialBatch: true,
            deferSecondaryWork: true,
            deferRemainingBatches: true
        });
        await preloadInitialLibraryVisuals(songs);

        // The DOM and first viewport covers now exist before either unchanged
        // entrance animation starts, so the animation cannot be invalidated
        // halfway through by the library response.
        showSection(trendingSection);
        return true;
    }

    function handleRouting() {
        const path = window.location.pathname;
        const hash = window.location.hash;
        const params = new URLSearchParams(window.location.search);
        const playlistShareId = params.get('playlist');

        if (playlistShareId) {
            // Handle Share Link
            window.lastViewBeforePlaylist = 'library';
            window.currentActiveView = 'playlist';
            window.requestedPlaylistId = playlistShareId;
            window.currentPlaylistId = null;
            hideAllSections();
            showSection(playlistDetailSection);
            document.title = "Streamify | Playlist";
            if (typeof renderPlaylistDetail === 'function') {
                renderPlaylistDetail(playlistShareId);
            }
            return;
        }

        // Handle Hashes
        if (hash) {
            if (hash === '#feed' || hash === '#people') {
                if (libraryLink) libraryLink.click();
                return;
            } else if (hash === '#library') {
                if (libraryLink) libraryLink.click();
                return;
            } else if (hash === '#downloads') {
                // Owner-only view: fall back to the library for everyone else.
                if (downloadsLink && !downloadsLink.closest('.owner-only-nav.hidden')) downloadsLink.click();
                else if (libraryLink) libraryLink.click();
                return;
            } else if (hash === '#upload') {
                if (uploadLink) uploadLink.click();
                return;
            } else if (hash === '#about') {
                // The Beta Info page is gone; keep old bookmarks working.
                if (libraryLink) libraryLink.click();
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
            let username = path.slice('/profile/'.length);
            try { username = decodeURIComponent(username); } catch (err) { /* use raw path segment */ }
            if (username) {
                window.currentActiveView = 'profile';
                window.profileContextUser = username;
                hideAllSections();
                showSection(profileDetailSection);
                if (typeof fetchDetailedProfile === 'function') {
                    fetchDetailedProfile(username);
                }
            }
        } else {
            // Default to the personal library on /home, root, or Capacitor mobile app launch
            if (libraryLink && isHomeOrRootRoute(path)) {
                if (trendingSection && trendingSection.classList.contains('hidden')) {
                    libraryLink.click();
                }
            }
        }

        // Safety fallback: if no content section is visible on screen, default to Library
        if (libraryLink && (!window.currentActiveView || (trendingSection && trendingSection.classList.contains('hidden') && !document.querySelector('.content-container > section:not(.hidden)')))) {
            libraryLink.click();
        }
    }


    window.navigateToProfile = function (username) {
        if (!username) return;

        if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(false);
        // Remember where we came from if we're not already on a profile
        if (window.currentActiveView !== 'profile') {
            window.lastViewBeforeProfile = window.currentActiveView;
        }
        // Save scroll position before leaving current view
        const mainContent = window.getAppScrollContainer();
        if (mainContent) {
            window.savedScrollPosition = mainContent.scrollTop;
        }
        // If coming from post detail, remember which post
        if (window.currentActiveView === 'post' && window.currentPostId) {
            window.profileContextPostId = window.currentPostId;
        }

        window.currentActiveView = 'profile';
        window.profileContextUser = username;

        const profileModal = document.getElementById('profile-modal');
        if (profileModal) {
            profileModal.style.transition = 'none';
            profileModal.classList.add('hidden');
            void profileModal.offsetHeight;
            profileModal.style.transition = '';
        }

        history.pushState({ view: 'profile', username }, '', `/profile/${encodeURIComponent(username)}`);
        hideAllSections();
        showSection(profileDetailSection);
        if (mainContent) mainContent.scrollTop = 0;
        window.scrollTo(0, 0);
        if (typeof fetchDetailedProfile === 'function') {
            fetchDetailedProfile(username);
        }
    };

    // Profile Detail Tabs (Cleaned up for single-view profile)
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
    const primeLibraryOnLaunch = isInitialLibraryRoute();
    const initialLibraryPromise = primeLibraryOnLaunch
        ? fetchLibrary(false, { render: false })
        : null;
    const currentUserPromise = fetchCurrentUser();
    Promise.resolve(currentUserPromise).then(applyOwnerOnlyControls).finally(async () => {
        try {
            if (primeLibraryOnLaunch) {
                const revealed = await revealInitialLibrary(initialLibraryPromise);
                if (!revealed) handleRouting();
            } else {
                handleRouting();
            }

            // Allocate the real retained player and its large backdrop while a
            // static boot surface still covers the app, not during first use.
            if (typeof window.prepareDesktopPlayerOverlay === 'function') {
                await window.prepareDesktopPlayerOverlay();
            }
            await nextPaint();
        } catch (error) {
            console.error('[INITIAL PAINT]', error);
            handleRouting();
        } finally {
            finishInitialVisualPaint();
        }
    });
    window.streamifyAfterStartupMotion(() => scheduleIdle(() => fetchPlaylists(true), 2000));
    // Desktop-only panes depend on the preload bridge, not on the user, so
    // they can be revealed immediately.
    applyDesktopOnlyControls();
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
                                : `<div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--gradient-1),var(--gradient-2));color:var(--on-gradient);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${(u.display_name || u.username).charAt(0).toUpperCase()}</div>`;
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
        window.streamifyAfterFirstPaint(() => setTimeout(() => initDmSocketListeners(), 1000));
    }

    /* ===================================================
     * FIRST TIME EXPERIENCE / OOBE WIZARD MODAL
     * =================================================== */
    async function initOOBEWizard() {
        const modal = document.getElementById('oobe-modal');
        if (!modal) return;

        const closeBtn = document.getElementById('close-oobe-modal-btn');
        if (closeBtn) {
            closeBtn.onclick = () => {
                if (modal.dataset.busy !== 'true') modal.classList.add('hidden');
            };
        }
        modal.onclick = (e) => {
            if (e.target === modal && modal.dataset.busy !== 'true') modal.classList.add('hidden');
        };

        try {
            const user = await fetchCurrentUser();
            if (!user) return;

            // Only the Owner can configure host filesystem paths.
            const isOwner = user.role === 'Owner';
            const isCompleted = user.oobe_completed === true;
            if (isOwner && !isCompleted) {
                // Prefill existing music directories
                const dirInput = document.getElementById('oobe-music-dir-input');
                if (dirInput) {
                    try {
                        const dirRes = await fetch('/api/config/music-directories');
                        if (dirRes.ok) {
                            const dirData = await dirRes.json();
                            if (dirData.directories && dirData.directories.length > 0) {
                                dirInput.value = dirData.directories[0];
                            } else {
                                dirInput.value = '../MusicLibrary/uploads';
                            }
                        }
                    } catch (e) {
                        dirInput.value = '../MusicLibrary/uploads';
                    }
                }

                // Metadata API support is optional; load it without delaying basic setup.
                loadMetadataSettings();

                // Show modal
                modal.classList.remove('hidden');
                setupOOBESteps();
            }
        } catch (err) {
            console.error('[OOBE INIT ERROR]', err);
        }
    }

    function setupOOBESteps() {
        let currentStep = 1;
        const totalSteps = 5;

        const nextBtn = document.getElementById('oobe-next-btn');
        const prevBtn = document.getElementById('oobe-prev-btn');
        const titleEl = document.getElementById('oobe-title');
        const subtitleEl = document.getElementById('oobe-subtitle');
        const badgeIcon = document.getElementById('oobe-badge-icon');

        const stepHeaders = {
            1: {
                badge: "<i class='bx bxs-party'></i>",
                title: "Welcome to Streamify!",
                subtitle: "Streamify will scan this path for Audio files, and this path will be default."
            },
            2: {
                badge: "<i class='bx bx-fingerprint'></i>",
                title: "Identify Music Your Way",
                subtitle: "Choose whether identification stays local or uses online metadata services."
            },
            3: {
                badge: "<i class='bx bx-slider-alt'></i>",
                title: "Managing Music Folders",
                subtitle: "Learn where to manage your music directories."
            },
            4: {
                badge: "<i class='bx bx-rocket'></i>",
                title: "How Streamify Works",
                subtitle: "Discover the features of your new music server."
            },
            5: {
                badge: "<i class='bx bxs-check-shield'></i>",
                title: "Setup Complete!",
                subtitle: "Streamify setup is complete and it's ready."
            }
        };

        function updateStepUI() {
            // Update step panes
            for (let i = 1; i <= totalSteps; i++) {
                const pane = document.getElementById(`oobe-step-${i}`);
                if (pane) {
                    if (i === currentStep) {
                        pane.classList.add('active');
                    } else {
                        pane.classList.remove('active');
                    }
                }
            }

            // Update step dots
            document.querySelectorAll('.oobe-step-dot').forEach(dot => {
                const stepNum = parseInt(dot.getAttribute('data-step'), 10);
                dot.classList.remove('active', 'completed');
                if (stepNum === currentStep) {
                    dot.classList.add('active');
                } else if (stepNum < currentStep) {
                    dot.classList.add('completed');
                }
            });

            // Update Header
            if (stepHeaders[currentStep]) {
                if (badgeIcon) badgeIcon.innerHTML = stepHeaders[currentStep].badge;
                if (titleEl) titleEl.textContent = stepHeaders[currentStep].title;
                if (subtitleEl) subtitleEl.textContent = stepHeaders[currentStep].subtitle;
            }

            // Update Prev Button
            if (prevBtn) {
                prevBtn.style.visibility = currentStep > 1 ? 'visible' : 'hidden';
            }

            // Update Next Button text
            if (nextBtn) {
                if (currentStep === totalSteps) {
                    nextBtn.innerHTML = `Finish & Launch Streamify <i class='bx bx-check'></i>`;
                } else {
                    nextBtn.innerHTML = `Continue <i class='bx bx-right-arrow-alt'></i>`;
                }
            }
        }

        if (prevBtn) {
            prevBtn.onclick = () => {
                if (currentStep > 1) {
                    currentStep--;
                    updateStepUI();
                }
            };
        }

        if (nextBtn) {
            nextBtn.onclick = async () => {
                if (currentStep === 1) {
                    // Save Music Directory
                    const dirInput = document.getElementById('oobe-music-dir-input');
                    const dirValue = dirInput ? dirInput.value.trim() : '';
                    const finalDir = dirValue || '../MusicLibrary/uploads';

                    nextBtn.disabled = true;
                    nextBtn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
                    const modal = document.getElementById('oobe-modal');
                    if (modal) modal.dataset.busy = 'true';

                    try {
                        const res = await fetch('/api/config/music-directories', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ directories: [finalDir] })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok || !data.success) throw new Error(data.error || 'Could not save the music directory.');
                        if (typeof showToast === 'function') showToast('Default music directory saved!', 'success');
                        currentStep++;
                    } catch (e) {
                        console.error('[OOBE DIR SAVE ERROR]', e);
                        if (typeof showToast === 'function') showToast(e.message || 'Could not save the music directory.', 'error');
                    } finally {
                        nextBtn.disabled = false;
                        if (modal) delete modal.dataset.busy;
                        updateStepUI();
                    }
                } else if (currentStep === 2) {
                    nextBtn.disabled = true;
                    nextBtn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Saving...`;
                    const modal = document.getElementById('oobe-modal');
                    if (modal) modal.dataset.busy = 'true';

                    try {
                        const saved = await saveMetadataSettings('oobe', { allowLocalFallback: true });
                        if (saved) currentStep++;
                    } finally {
                        nextBtn.disabled = false;
                        if (modal) delete modal.dataset.busy;
                        updateStepUI();
                    }
                } else if (currentStep < totalSteps) {
                    currentStep++;
                    updateStepUI();
                } else if (currentStep === totalSteps) {
                    // Complete OOBE
                    nextBtn.disabled = true;
                    nextBtn.innerHTML = `<i class='bx bx-loader-alt bx-spin'></i> Completing...`;
                    const modal = document.getElementById('oobe-modal');
                    if (modal) modal.dataset.busy = 'true';

                    try {
                        const res = await fetch('/api/config/oobe', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ completed: true })
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok || !data.success) throw new Error(data.error || 'Could not complete setup.');
                        if (appCache.user) appCache.user.oobe_completed = true;

                        if (modal) modal.classList.add('hidden');

                        if (typeof showToast === 'function') {
                            showToast('Welcome to Streamify! Your library is ready.', 'success');
                        }
                        if (typeof fetchLibrary === 'function') {
                            fetchLibrary(true);
                        } else if (typeof fetchSongs === 'function') {
                            fetchSongs();
                        }
                    } catch (e) {
                        console.error('[OOBE COMPLETE ERROR]', e);
                        if (typeof showToast === 'function') showToast(e.message || 'Could not complete setup.', 'error');
                    } finally {
                        nextBtn.disabled = false;
                        if (modal) delete modal.dataset.busy;
                        updateStepUI();
                    }
                }
            };
        }

        updateStepUI();
    }

    // Trigger OOBE Check on Load
    window.streamifyAfterStartupMotion(initOOBEWizard);
});

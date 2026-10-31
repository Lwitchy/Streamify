/* ==========================================================================
 * Liked Songs.
 *
 * Keeps the signed-in user's liked song IDs in memory (GET /api/likes/ids),
 * drives every heart button on the page, and renders the Liked Songs page
 * (#liked). Any element with data-like-song="<id>" is a heart for that song;
 * elements with data-like-current are hearts for the song now playing.
 * ======================================================================== */

(function initStreamifyLikes() {
    'use strict';

    const likedIds = new Set();
    let loaded = false;
    let loadPromise = null;
    let likedSongs = [];
    let pageSeq = 0;
    let rerenderTimer = null;
    const pending = new Set();

    const $ = id => document.getElementById(id);

    function isOffline() {
        return !navigator.onLine || Boolean(window.StreamifyOfflineMode) ||
            Boolean(window.StreamifyNetwork && window.StreamifyNetwork.isServerReachable === false);
    }

    function load(force = false) {
        if (loadPromise && !force) return loadPromise;
        loadPromise = fetch(window.API_BASE_URL + '/api/likes/ids', { credentials: 'include' })
            .then(response => (response.ok ? response.json() : []))
            .then(ids => {
                likedIds.clear();
                (Array.isArray(ids) ? ids : []).forEach(id => likedIds.add(String(id)));
                loaded = true;
                refreshButtons();
            })
            .catch(() => { /* offline: hearts stay as they are */ });
        return loadPromise;
    }

    function isLiked(songId) {
        return likedIds.has(String(songId));
    }

    function paintButton(button, liked) {
        button.classList.toggle('liked', liked);
        button.setAttribute('aria-pressed', String(liked));
        const label = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
        button.setAttribute('aria-label', label);
        button.title = label;
        const icon = button.querySelector('i');
        if (icon) icon.className = liked ? 'bx bxs-heart' : 'bx bx-heart';
    }

    function currentSongId() {
        return window.currentlyPlayingSongId ? String(window.currentlyPlayingSongId) : null;
    }

    function refreshButtons(root = document) {
        root.querySelectorAll('[data-like-song]').forEach(button => {
            paintButton(button, isLiked(button.dataset.likeSong));
        });
        const current = currentSongId();
        document.querySelectorAll('[data-like-current]').forEach(button => {
            button.disabled = !current;
            paintButton(button, Boolean(current) && isLiked(current));
        });
    }

    async function setLiked(songId, liked) {
        const key = String(songId);
        if (!key || pending.has(key)) return;
        if (isOffline()) {
            showToast('Liking songs needs a connection to your server', 'warning');
            return;
        }
        pending.add(key);
        const before = isLiked(key);
        if (liked) likedIds.add(key); else likedIds.delete(key);
        refreshButtons();
        try {
            const response = await fetch(window.API_BASE_URL + `/api/likes/${encodeURIComponent(key)}`, {
                method: liked ? 'PUT' : 'DELETE',
                credentials: 'include'
            });
            if (!response.ok) throw new Error(`Like request failed (${response.status})`);
            showToast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs', 'success');
            if (window.currentActiveView === 'liked') scheduleRerender();
        } catch (error) {
            if (before) likedIds.add(key); else likedIds.delete(key);
            refreshButtons();
            showToast('Could not update Liked Songs', 'error');
        } finally {
            pending.delete(key);
        }
    }

    function toggle(songId) {
        return setLiked(songId, !isLiked(songId));
    }

    /** Heart button markup for song rows. */
    function rowButtonHTML(songId) {
        if (songId === undefined || songId === null || songId === '') return '';
        const id = escapeHTML(String(songId));
        const liked = isLiked(songId);
        const label = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
        return `<button type="button" class="row-like-btn${liked ? ' liked' : ''}" data-like-song="${id}" aria-pressed="${liked}" aria-label="${label}" title="${label}"><i class='bx ${liked ? 'bxs-heart' : 'bx-heart'}'></i></button>`;
    }

    /* --- Liked Songs page ------------------------------------------------- */

    function setPageMeta(text) {
        const meta = $('liked-detail-meta');
        if (meta) meta.textContent = text;
    }

    async function renderPage() {
        const seq = ++pageSeq;
        const list = $('liked-tracks-list');
        if (!list) return;
        const header = list.querySelector('.header-row');
        const buttons = ['liked-play-btn', 'liked-shuffle-btn', 'download-liked-btn'].map($);

        if (isOffline()) {
            list.replaceChildren(...(header ? [header] : []));
            setPageMeta('Liked Songs need a connection to your server.');
            buttons.forEach(button => { if (button) button.disabled = true; });
            return;
        }
        try {
            const response = await fetch(window.API_BASE_URL + '/api/likes', { credentials: 'include' });
            if (!response.ok) throw new Error(`Liked songs request failed (${response.status})`);
            const songs = await response.json();
            if (seq !== pageSeq || window.currentActiveView !== 'liked') return;
            likedSongs = Array.isArray(songs) ? songs : [];
            likedIds.clear();
            likedSongs.forEach(song => likedIds.add(String(song.id)));
            setPageMeta(`${likedSongs.length} ${likedSongs.length === 1 ? 'song' : 'songs'}`);
            buttons.forEach(button => { if (button) button.disabled = likedSongs.length === 0; });
            if (likedSongs.length === 0) {
                list.replaceChildren(...(header ? [header] : []));
                const empty = document.createElement('p');
                empty.className = 'collection-empty';
                empty.textContent = 'Songs you like will appear here. Tap the heart next to any song to save it.';
                list.appendChild(empty);
                currentPlaylist = [];
                shuffledPlaylist = [];
                return;
            }
            renderSongList(likedSongs, list, { playbackContext: { type: 'liked', id: null } });
        } catch (error) {
            if (seq !== pageSeq) return;
            console.error('[LIKES]', error);
            setPageMeta('Could not load Liked Songs.');
        }
    }

    function scheduleRerender() {
        clearTimeout(rerenderTimer);
        rerenderTimer = setTimeout(() => {
            if (window.currentActiveView === 'liked') renderPage();
        }, 600);
    }

    function likedUrl() {
        const isCap = window.Capacitor || document.documentElement.classList.contains('is-capacitor');
        return isCap ? `${window.location.pathname}#liked` : '/home#liked';
    }

    function navigateToLiked({ fromHistory = false, fromBack = false } = {}) {
        if (!fromBack && window.StreamifyNav) window.StreamifyNav.rememberOrigin();
        window.currentActiveView = 'liked';
        if (!fromHistory && window.location.hash !== '#liked') {
            try { history.pushState({ view: 'liked' }, '', likedUrl()); } catch (e) { /* restricted webview */ }
        }
        hideAllSections();
        const link = $('liked-songs-link');
        if (link) link.classList.add('active');
        showSection($('liked-songs-section'));
        document.title = 'Streamify | Liked Songs';
        setPageMeta('Loading…');
        renderPage();
    }

    /* --- Wiring ----------------------------------------------------------- */

    document.addEventListener('click', event => {
        const button = event.target.closest && event.target.closest('[data-like-song], [data-like-current]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const songId = button.dataset.likeSong || currentSongId();
        if (songId) toggle(songId);
    });

    window.addEventListener('streamifytrackchange', () => refreshButtons());
    window.addEventListener('online', () => load(true));

    const link = $('liked-songs-link');
    if (link) link.addEventListener('click', event => {
        event.preventDefault();
        if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
        navigateToLiked();
    });

    const play = (shuffle) => {
        if (likedSongs.length > 0 && window.StreamifyAlbums) {
            window.StreamifyAlbums.playTracks(likedSongs, { type: 'liked', id: null }, { shuffle });
        }
    };
    const playButton = $('liked-play-btn');
    if (playButton) playButton.addEventListener('click', () => play(false));
    const shuffleButton = $('liked-shuffle-btn');
    if (shuffleButton) shuffleButton.addEventListener('click', () => play(true));
    const downloadButton = $('download-liked-btn');
    if (downloadButton) downloadButton.addEventListener('click', () => {
        if (likedSongs.length > 0 && typeof window.downloadAllSongs === 'function') {
            window.downloadAllSongs(likedSongs, downloadButton);
        }
    });
    const backButton = $('back-from-liked-btn');
    if (backButton) backButton.addEventListener('click', () => {
        if (window.StreamifyNav) window.StreamifyNav.goBack();
    });

    load();

    window.navigateToLiked = navigateToLiked;
    window.StreamifyLikes = Object.freeze({
        load,
        isLiked,
        toggle,
        setLiked,
        rowButtonHTML,
        refreshButtons,
        navigateToLiked,
        isLoaded: () => loaded
    });
})();

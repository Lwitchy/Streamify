/* ==========================================================================
 * Albums - library Albums tab, album page, album results in search.
 *
 * Albums come from GET /api/albums and GET /api/albums/:uid; the server
 * groups songs into albums (Server/albums.js). Album pages render their tracks
 * with the shared renderSongList, so rows behave exactly like library rows,
 * and playback started there is recorded with source_type "album".
 * ======================================================================== */

(function initStreamifyAlbums() {
    'use strict';

    const TAB_KEY = 'streamify:library-tab:v1';
    const UID_PATTERN = /^[a-f0-9]{20}$/;

    let libraryTab = readSavedTab();
    let albumsCache = null;
    let albumsRequest = null;
    let detailSeq = 0;
    let detailAbort = null;
    let currentAlbum = null;
    let currentTracks = [];

    const $ = id => document.getElementById(id);

    function readSavedTab() {
        try {
            const saved = localStorage.getItem(TAB_KEY);
            return saved === 'albums' || saved === 'artists' ? saved : 'songs';
        } catch (e) {
            return 'songs';
        }
    }

    function saveTab(tab) {
        try { localStorage.setItem(TAB_KEY, tab); } catch (e) { /* per-device convenience only */ }
    }

    function isOffline() {
        return !navigator.onLine || Boolean(window.StreamifyOfflineMode) ||
            Boolean(window.StreamifyNetwork && window.StreamifyNetwork.isServerReachable === false);
    }

    function coverURL(cover) {
        return safeImageURL(cover, COVER_PLACEHOLDER);
    }

    function formatTotalDuration(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.round((total % 3600) / 60);
        if (hours > 0) return `${hours} hr ${minutes} min`;
        if (minutes > 0) return `${minutes} min`;
        return `${total} sec`;
    }

    function albumSubtitle(album) {
        return [album.artist, album.year].filter(Boolean).join(' · ');
    }

    /* --- Playback --------------------------------------------------------- */

    // Same shape renderSongList gives currentPlaylist entries.
    function toPlayable(s) {
        return {
            id: s.id,
            title: s.name || s.title || 'Unknown Track',
            artist: s.artist || 'Unknown Artist',
            album: s.album || 'Single',
            album_uid: s.album_uid || null,
            track_number: s.track_number || null,
            disc_number: s.disc_number || null,
            cover: s.cover,
            uploaded_by: s.uploaded_by || 'Unknown',
            duration: s.duration,
            is_private: s.is_private || 'public',
            bitrate: s.bitrate,
            source: s.source,
            extension: s.extension,
            url: `/api/play/${s.id}`
        };
    }

    /**
     * Play a list of tracks (an album, an artist, Liked Songs) without
     * disturbing the list on screen: the visible view's queue is swapped out
     * only for the synchronous call that snapshots the playback context, then
     * put back - unless the list on screen is the one being played.
     * `context` is the listening-history source, e.g. { type: 'album', id }.
     */
    function playTracks(tracks, context, { shuffle = false, startIndex = null } = {}) {
        if (!Array.isArray(tracks) || tracks.length === 0) return;
        if (typeof context === 'string') context = { type: 'album', id: context };
        const saved = {
            playlist: currentPlaylist,
            order: shuffledPlaylist,
            context: currentPlaybackContext
        };
        const viewingThis = Boolean(currentPlaybackContext && context &&
            currentPlaybackContext.type === context.type &&
            String(currentPlaybackContext.id) === String(context.id));
        try {
            currentPlaylist = tracks.map(toPlayable);
            currentPlaybackContext = { type: context.type, id: context.id === undefined ? null : context.id };
            if (shuffle && !isShuffle) {
                toggleShuffle();
            } else {
                shuffledPlaylist = buildPlaylistOrder(currentPlaylist.length);
            }
            const start = Number.isInteger(startIndex) ? startIndex : (isShuffle ? shuffledPlaylist[0] : 0);
            playSongAtIndex(start);
        } finally {
            if (!viewingThis) {
                currentPlaylist = saved.playlist;
                currentPlaybackContext = saved.context;
                shuffledPlaylist = buildPlaylistOrder(currentPlaylist.length);
            }
        }
    }

    async function playAlbum(albumUid, options = {}) {
        if (currentAlbum && currentAlbum.album_uid === albumUid && currentTracks.length > 0) {
            playTracks(currentTracks, { type: 'album', id: albumUid }, options);
            return;
        }
        try {
            const data = await fetchAlbum(albumUid);
            playTracks(data.tracks, { type: 'album', id: albumUid }, options);
        } catch (error) {
            showToast(isOffline() ? 'Albums are not available offline' : 'Could not play this album', 'error');
        }
    }

    /* --- Data ------------------------------------------------------------- */

    async function fetchAlbums() {
        if (albumsRequest) return albumsRequest;
        albumsRequest = fetch(window.API_BASE_URL + '/api/albums', { credentials: 'include' })
            .then(response => {
                if (!response.ok) throw new Error(`Albums request failed (${response.status})`);
                return response.json();
            })
            .then(albums => {
                albumsCache = Array.isArray(albums) ? albums : [];
                return albumsCache;
            })
            .finally(() => { albumsRequest = null; });
        return albumsRequest;
    }

    async function fetchAlbum(albumUid, signal) {
        const response = await fetch(window.API_BASE_URL + `/api/albums/${encodeURIComponent(albumUid)}`, {
            credentials: 'include',
            signal
        });
        if (response.status === 404) {
            const error = new Error('Album not found');
            error.notFound = true;
            throw error;
        }
        if (!response.ok) throw new Error(`Album request failed (${response.status})`);
        return response.json();
    }

    /* --- Album cards ------------------------------------------------------ */

    function createAlbumCard(album) {
        const card = document.createElement('a');
        card.className = 'album-card';
        card.href = `#album-${album.album_uid}`;
        card.dataset.albumUid = album.album_uid;
        card.setAttribute('aria-label', `${album.title} by ${album.artist}`);
        card.innerHTML = `
            <div class="album-card-cover">
                <img alt="" loading="lazy" decoding="async">
                <button type="button" class="album-card-play" aria-label="Play ${escapeHTML(album.title)}">
                    <i class='bx bx-play'></i>
                </button>
            </div>
            <div>
                <div class="album-card-title">${escapeHTML(album.title)}</div>
                <div class="album-card-subtitle">${escapeHTML(albumSubtitle(album))}</div>
            </div>`;
        card.querySelector('img').src = coverURL(album.cover);
        card.addEventListener('click', event => {
            event.preventDefault();
            if (event.target.closest('.album-card-play')) {
                playAlbum(album.album_uid);
                return;
            }
            navigateToAlbum(album.album_uid);
        });
        return card;
    }

    function renderAlbumGrid(container, albums, emptyText) {
        if (!container) return;
        if (!albums || albums.length === 0) {
            container.innerHTML = `<p class="album-grid-message">${escapeHTML(emptyText)}</p>`;
            return;
        }
        const fragment = document.createDocumentFragment();
        albums.forEach(album => fragment.appendChild(createAlbumCard(album)));
        container.replaceChildren(fragment);
    }

    function showGridMessage(container, text) {
        if (container) container.innerHTML = `<p class="album-grid-message">${escapeHTML(text)}</p>`;
    }

    /* --- Library tab ------------------------------------------------------ */

    async function loadLibraryAlbums() {
        const grid = $('library-albums-grid');
        if (!grid) return;
        if (albumsCache) {
            renderAlbumGrid(grid, albumsCache, 'No albums yet.');
        } else {
            showGridMessage(grid, 'Loading albums…');
        }
        if (isOffline()) {
            if (!albumsCache) showGridMessage(grid, 'Albums are not available offline. Your downloaded songs are in the Songs tab.');
            return;
        }
        try {
            const albums = await fetchAlbums();
            if (libraryTab !== 'albums' || window.currentActiveView !== 'library') return;
            renderAlbumGrid(grid, albums,
                'No albums yet. Songs with an album name in their tags appear here.');
        } catch (error) {
            console.error('[ALBUMS]', error);
            if (!albumsCache) showGridMessage(grid, 'Could not load albums.');
        }
    }

    function showLibraryTab(tab, { focus = false } = {}) {
        libraryTab = tab === 'albums' || tab === 'artists' ? tab : 'songs';
        saveTab(libraryTab);
        const section = $('trending-section');
        const list = $('trending-list');
        const grid = $('library-albums-grid');
        const artistGrid = $('library-artists-grid');
        const isAlbums = libraryTab === 'albums';
        const isArtists = libraryTab === 'artists';

        document.querySelectorAll('.library-tab').forEach(button => {
            const active = button.dataset.libraryTab === libraryTab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
            if (active && focus) button.focus();
        });
        if (section) section.classList.toggle('library-albums-active', isAlbums || isArtists);
        if (list) list.classList.toggle('hidden', isAlbums || isArtists);
        if (grid) grid.classList.toggle('hidden', !isAlbums);
        if (artistGrid) artistGrid.classList.toggle('hidden', !isArtists);
        if (isAlbums || isArtists) {
            if (typeof isLibraryEditMode !== 'undefined' && isLibraryEditMode && typeof toggleLibraryEditMode === 'function') {
                toggleLibraryEditMode();
            }
        }
        if (isAlbums) loadLibraryAlbums();
        if (isArtists && window.StreamifyArtists) window.StreamifyArtists.loadLibraryArtists();
    }

    /** Called by the router every time the library section is shown. */
    function onLibraryShown() {
        originStack.length = 0;
        showLibraryTab(libraryTab);
    }

    /* --- Album page ------------------------------------------------------- */

    function setDetailPlaceholder(title, meta = '') {
        currentAlbum = null;
        currentTracks = [];
        $('album-detail-title').textContent = title;
        $('album-detail-artist').textContent = '';
        $('album-detail-meta').textContent = meta;
        $('album-detail-kind').textContent = 'Album';
        $('album-detail-cover').src = COVER_PLACEHOLDER;
        $('album-play-btn').disabled = true;
        $('album-shuffle-btn').disabled = true;
        $('download-album-btn').disabled = true;
        const list = $('album-tracks-list');
        const header = list.querySelector('.header-row');
        list.replaceChildren(...(header ? [header] : []));
    }

    async function renderAlbumDetail(albumUid) {
        const seq = ++detailSeq;
        if (detailAbort) detailAbort.abort();
        const controller = new AbortController();
        detailAbort = controller;
        setDetailPlaceholder('Loading…');

        if (isOffline()) {
            setDetailPlaceholder('Offline', 'Albums are not available offline.');
            return;
        }

        try {
            const data = await fetchAlbum(albumUid, controller.signal);
            if (seq !== detailSeq || window.currentActiveView !== 'album') return;
            const album = data.album;
            const tracks = Array.isArray(data.tracks) ? data.tracks : [];
            currentAlbum = album;
            currentTracks = tracks;

            $('album-detail-title').textContent = album.title;
            const artistLine = $('album-detail-artist');
            if (album.album_artist_uid) {
                artistLine.innerHTML = `<a href="#artist-${escapeHTML(album.album_artist_uid)}" class="song-artist-link" data-artist-uid="${escapeHTML(album.album_artist_uid)}">${escapeHTML(album.artist)}</a>`;
            } else {
                artistLine.textContent = album.artist;
            }
            $('album-detail-kind').textContent = album.is_compilation ? 'Compilation' : 'Album';
            $('album-detail-cover').src = coverURL(album.cover);
            $('album-detail-cover').alt = `${album.title} cover`;
            const songCount = `${album.track_count} ${album.track_count === 1 ? 'song' : 'songs'}`;
            $('album-detail-meta').textContent = [album.year, songCount, formatTotalDuration(album.duration_seconds)]
                .filter(Boolean).join(' · ');
            $('album-play-btn').disabled = false;
            $('album-shuffle-btn').disabled = false;
            $('download-album-btn').disabled = false;
            document.title = `Streamify | ${album.title}`;

            const discs = new Set(tracks.map(track => track.disc_number || 1));
            const multiDisc = discs.size > 1;
            renderSongList(tracks, $('album-tracks-list'), {
                playbackContext: { type: 'album', id: album.album_uid },
                indexLabel: (song, index) => {
                    if (!song.track_number) return String(index + 1);
                    return multiDisc ? `${song.disc_number || 1}-${song.track_number}` : String(song.track_number);
                }
            });
        } catch (error) {
            if (error.name === 'AbortError' || seq !== detailSeq) return;
            console.error('[ALBUM DETAIL]', error);
            setDetailPlaceholder(error.notFound ? 'Album not found' : 'Could not load album',
                error.notFound ? 'It may have been renamed or removed from your library.' : '');
        } finally {
            if (detailAbort === controller) detailAbort = null;
        }
    }

    function albumUrl(albumUid) {
        const isCap = window.Capacitor || document.documentElement.classList.contains('is-capacitor');
        return isCap ? `${window.location.pathname}#album-${albumUid}` : `/home#album-${albumUid}`;
    }

    /**
     * Open an album page. `fromHistory` is set when the router is replaying a
     * URL (initial load, Back/Forward), so no new history entry is pushed.
     */
    function navigateToAlbum(albumUid, { fromHistory = false, fromBack = false } = {}) {
        if (!UID_PATTERN.test(String(albumUid || ''))) return;
        if (window.currentActiveView === 'album' && currentAlbum && currentAlbum.album_uid === albumUid && !fromHistory) return;

        if (!fromBack) rememberOrigin();
        window.currentActiveView = 'album';
        if (!fromHistory && window.location.hash !== `#album-${albumUid}`) {
            try {
                history.pushState({ view: 'album', id: albumUid }, '', albumUrl(albumUid));
            } catch (e) {
                // Restricted webviews: navigation still works without history.
            }
        }

        hideAllSections();
        showSection($('album-detail-section'));
        document.title = 'Streamify | Album';
        renderAlbumDetail(albumUid);
    }

    /* --- In-app Back ------------------------------------------------------
     * Album, artist and Liked Songs pages each have a Back button. Each
     * navigation into one of them remembers where it came from on a small
     * stack, so album -> artist -> album -> Back -> Back works as expected.
     * Opening Your Library clears the stack. */

    const originStack = [];

    function currentOrigin() {
        const view = window.currentActiveView || 'library';
        if (view === 'album') return currentAlbum ? { view, id: currentAlbum.album_uid } : null;
        if (view === 'artist') {
            const id = window.StreamifyArtists && window.StreamifyArtists.currentArtistUid();
            return id ? { view, id } : null;
        }
        if (view === 'playlist') {
            const id = window.currentPlaylistShareId || window.currentPlaylistId || window.requestedPlaylistId;
            return id ? { view, id } : { view: 'library' };
        }
        if (view === 'search' || view === 'liked') return { view };
        return { view: 'library' };
    }

    function rememberOrigin() {
        const origin = currentOrigin();
        if (!origin) return;
        const last = originStack[originStack.length - 1];
        if (last && last.view === origin.view && last.id === origin.id) return;
        originStack.push(origin);
        if (originStack.length > 20) originStack.shift();
    }

    function goBack() {
        const target = originStack.pop() || { view: 'library' };
        if (target.view === 'album' && target.id) {
            navigateToAlbum(target.id, { fromBack: true });
            return;
        }
        if (target.view === 'artist' && target.id && typeof window.navigateToArtist === 'function') {
            window.navigateToArtist(target.id, { fromBack: true });
            return;
        }
        if (target.view === 'liked' && window.StreamifyLikes) {
            window.StreamifyLikes.navigateToLiked({ fromBack: true });
            return;
        }
        if (target.view === 'search') {
            const searchSection = $('search-section');
            const searchInput = $('gsearch');
            if (searchSection && searchInput && searchInput.value.trim()) {
                window.currentActiveView = 'search';
                hideAllSections();
                showSection(searchSection);
                if (typeof performSearch === 'function') performSearch(searchInput.value.trim());
                return;
            }
        }
        if (target.view === 'playlist' && target.id && typeof window.navigateToPlaylist === 'function') {
            window.navigateToPlaylist(target.id);
            return;
        }
        const libraryLink = $('library-link');
        if (libraryLink) libraryLink.click();
    }

    /* --- Search ----------------------------------------------------------- */

    function renderSearchAlbums(albums) {
        const block = $('search-albums-block');
        const grid = $('search-albums-grid');
        if (!block || !grid) return;
        const list = Array.isArray(albums) ? albums : [];
        block.classList.toggle('hidden', list.length === 0);
        if (list.length > 0) renderAlbumGrid(grid, list, '');
        else grid.replaceChildren();
    }

    /* --- Wiring ----------------------------------------------------------- */

    document.querySelectorAll('.library-tab').forEach(button => {
        button.addEventListener('click', () => showLibraryTab(button.dataset.libraryTab));
        button.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const tabs = ['songs', 'albums', 'artists'];
            const step = event.key === 'ArrowRight' ? 1 : tabs.length - 1;
            showLibraryTab(tabs[(tabs.indexOf(libraryTab) + step) % tabs.length], { focus: true });
        });
    });

    // Album names in any song row.
    document.addEventListener('click', event => {
        const link = event.target.closest && event.target.closest('.song-album-link');
        if (!link) return;
        event.preventDefault();
        event.stopPropagation();
        navigateToAlbum(link.dataset.albumUid);
    });

    const playButton = $('album-play-btn');
    if (playButton) playButton.addEventListener('click', () => {
        if (currentAlbum) playTracks(currentTracks, { type: 'album', id: currentAlbum.album_uid });
    });
    const shuffleButton = $('album-shuffle-btn');
    if (shuffleButton) shuffleButton.addEventListener('click', () => {
        if (currentAlbum) playTracks(currentTracks, { type: 'album', id: currentAlbum.album_uid }, { shuffle: true });
    });
    const downloadButton = $('download-album-btn');
    if (downloadButton) downloadButton.addEventListener('click', () => {
        if (currentTracks.length > 0 && typeof window.downloadAllSongs === 'function') {
            window.downloadAllSongs(currentTracks, downloadButton);
        }
    });
    const backButton = $('back-from-album-btn');
    if (backButton) backButton.addEventListener('click', goBack);

    window.navigateToAlbum = navigateToAlbum;
    window.StreamifyNav = Object.freeze({ rememberOrigin, goBack });
    window.StreamifyAlbums = Object.freeze({
        onLibraryShown,
        showLibraryTab,
        navigateToAlbum,
        renderSearchAlbums,
        renderAlbumGrid,
        playAlbum,
        playTracks,
        coverURL,
        formatTotalDuration,
        getLibraryTab: () => libraryTab
    });
})();

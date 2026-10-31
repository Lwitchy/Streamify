/* ==========================================================================
 * Artists - library Artists tab and artist pages (#artist-<uid>).
 *
 * Data comes from GET /api/artists and GET /api/artists/:uid. Popular tracks
 * are ranked by the signed-in user's own listening. The artist photo is the
 * server's (uploaded or downloaded); without one, a mosaic of the artist's
 * album covers is shown. Owners and Admins can upload or remove the photo.
 * ======================================================================== */

(function initStreamifyArtists() {
    'use strict';

    const UID_PATTERN = /^[a-f0-9]{20}$/;
    const POPULAR_PREVIEW = 5;

    let artistsCache = null;
    let artistsRequest = null;
    let detailSeq = 0;
    let detailAbort = null;
    let currentArtist = null;
    let currentTracks = [];
    let showAllTracks = false;

    const $ = id => document.getElementById(id);

    function isOffline() {
        return !navigator.onLine || Boolean(window.StreamifyOfflineMode) ||
            Boolean(window.StreamifyNetwork && window.StreamifyNetwork.isServerReachable === false);
    }

    function imageURL(url) {
        return safeImageURL(url, '');
    }

    /** Photo, or a mosaic of album covers, or initials. */
    function fillArtistImage(container, artist) {
        container.replaceChildren();
        container.classList.remove('artist-image--mosaic', 'artist-image--initials');
        const photo = imageURL(artist.image);
        if (photo) {
            const img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            img.loading = 'lazy';
            img.src = photo;
            container.appendChild(img);
            return;
        }
        const covers = (artist.fallback_covers || []).map(imageURL).filter(Boolean);
        if (covers.length > 0) {
            container.classList.add('artist-image--mosaic');
            const tiles = covers.length >= 4 ? covers.slice(0, 4) : [covers[0]];
            container.dataset.tiles = String(tiles.length);
            tiles.forEach(src => {
                const img = document.createElement('img');
                img.alt = '';
                img.decoding = 'async';
                img.loading = 'lazy';
                img.src = src;
                container.appendChild(img);
            });
            return;
        }
        container.classList.add('artist-image--initials');
        const initials = String(artist.name || '?').trim().split(/\s+/).slice(0, 2)
            .map(word => word.charAt(0).toUpperCase()).join('');
        const span = document.createElement('span');
        span.textContent = initials || '?';
        container.appendChild(span);
    }

    function artistSubtitle(artist) {
        const parts = [`${artist.song_count} ${artist.song_count === 1 ? 'song' : 'songs'}`];
        if (artist.album_count > 0) parts.push(`${artist.album_count} ${artist.album_count === 1 ? 'album' : 'albums'}`);
        return parts.join(' · ');
    }

    /* --- Data ------------------------------------------------------------- */

    function fetchArtists() {
        if (artistsRequest) return artistsRequest;
        artistsRequest = fetch(window.API_BASE_URL + '/api/artists', { credentials: 'include' })
            .then(response => {
                if (!response.ok) throw new Error(`Artists request failed (${response.status})`);
                return response.json();
            })
            .then(artists => {
                artistsCache = Array.isArray(artists) ? artists : [];
                return artistsCache;
            })
            .finally(() => { artistsRequest = null; });
        return artistsRequest;
    }

    async function fetchArtist(uid, signal) {
        const response = await fetch(window.API_BASE_URL + `/api/artists/${encodeURIComponent(uid)}`, {
            credentials: 'include',
            signal
        });
        if (response.status === 404) {
            const error = new Error('Artist not found');
            error.notFound = true;
            throw error;
        }
        if (!response.ok) throw new Error(`Artist request failed (${response.status})`);
        return response.json();
    }

    /* --- Library tab ------------------------------------------------------ */

    function createArtistCard(artist) {
        const card = document.createElement('a');
        card.className = 'artist-card';
        card.href = `#artist-${artist.artist_uid}`;
        card.dataset.artistUid = artist.artist_uid;
        card.setAttribute('aria-label', artist.name);
        card.innerHTML = `
            <div class="artist-image"></div>
            <div class="artist-card-name">${escapeHTML(artist.name)}</div>
            <div class="artist-card-subtitle">${escapeHTML(artistSubtitle(artist))}</div>`;
        fillArtistImage(card.querySelector('.artist-image'), artist);
        card.addEventListener('click', event => {
            event.preventDefault();
            navigateToArtist(artist.artist_uid);
        });
        return card;
    }

    function renderArtistGrid(grid, artists, emptyText) {
        if (!artists || artists.length === 0) {
            grid.innerHTML = `<p class="album-grid-message">${escapeHTML(emptyText)}</p>`;
            return;
        }
        const fragment = document.createDocumentFragment();
        artists.forEach(artist => fragment.appendChild(createArtistCard(artist)));
        grid.replaceChildren(fragment);
    }

    async function loadLibraryArtists() {
        const grid = $('library-artists-grid');
        if (!grid) return;
        if (artistsCache) renderArtistGrid(grid, artistsCache, 'No artists yet.');
        else grid.innerHTML = '<p class="album-grid-message">Loading artists…</p>';
        if (isOffline()) {
            if (!artistsCache) grid.innerHTML = '<p class="album-grid-message">Artists are not available offline. Your downloaded songs are in the Songs tab.</p>';
            return;
        }
        try {
            const artists = await fetchArtists();
            if (window.currentActiveView !== 'library' || !window.StreamifyAlbums ||
                window.StreamifyAlbums.getLibraryTab() !== 'artists') return;
            renderArtistGrid(grid, artists, 'No artists yet.');
        } catch (error) {
            console.error('[ARTISTS]', error);
            if (!artistsCache) grid.innerHTML = '<p class="album-grid-message">Could not load artists.</p>';
        }
    }

    /* --- Artist page ------------------------------------------------------ */

    function setPlaceholder(title, meta = '') {
        currentArtist = null;
        currentTracks = [];
        $('artist-detail-name').textContent = title;
        $('artist-detail-meta').textContent = meta;
        fillArtistImage($('artist-detail-image'), { name: '' });
        $('artist-hero').style.removeProperty('--artist-backdrop');
        ['artist-play-btn', 'artist-shuffle-btn'].forEach(id => { $(id).disabled = true; });
        $('artist-photo-actions').classList.add('hidden');
        ['artist-popular-block', 'artist-albums-block', 'artist-appears-block'].forEach(id => $(id).classList.add('hidden'));
    }

    function renderPopular() {
        const list = $('artist-tracks-list');
        const toggle = $('artist-tracks-toggle');
        const visible = showAllTracks ? currentTracks : currentTracks.slice(0, POPULAR_PREVIEW);
        renderSongList(visible, list, { playbackContext: { type: 'artist', id: currentArtist.artist_uid } });
        const extra = currentTracks.length - POPULAR_PREVIEW;
        toggle.classList.toggle('hidden', extra <= 0);
        toggle.textContent = showAllTracks ? 'Show less' : `Show all ${currentTracks.length} songs`;
        $('artist-popular-title').textContent = currentTracks.some(track => track.play_count > 0) ? 'Popular' : 'Songs';
    }

    async function renderArtistDetail(uid) {
        const seq = ++detailSeq;
        if (detailAbort) detailAbort.abort();
        const controller = new AbortController();
        detailAbort = controller;
        showAllTracks = false;
        setPlaceholder('Loading…');

        if (isOffline()) {
            setPlaceholder('Offline', 'Artists are not available offline.');
            return;
        }
        try {
            const data = await fetchArtist(uid, controller.signal);
            if (seq !== detailSeq || window.currentActiveView !== 'artist') return;
            const artist = data.artist;
            currentArtist = artist;
            currentTracks = Array.isArray(data.tracks) ? data.tracks : [];

            $('artist-detail-name').textContent = artist.name;
            $('artist-detail-meta').textContent = artistSubtitle(artist);
            fillArtistImage($('artist-detail-image'), artist);
            const backdrop = imageURL(artist.image) || imageURL((artist.fallback_covers || [])[0]);
            if (backdrop) $('artist-hero').style.setProperty('--artist-backdrop', `url("${backdrop.replace(/"/g, '%22')}")`);
            document.title = `Streamify | ${artist.name}`;

            const hasTracks = currentTracks.length > 0;
            $('artist-play-btn').disabled = !hasTracks;
            $('artist-shuffle-btn').disabled = !hasTracks;
            $('artist-photo-actions').classList.toggle('hidden', !artist.can_edit_image);
            $('artist-photo-remove').classList.toggle('hidden', !artist.image_source);

            $('artist-popular-block').classList.toggle('hidden', !hasTracks);
            if (hasTracks) renderPopular();

            const albums = Array.isArray(data.albums) ? data.albums : [];
            const appears = Array.isArray(data.appears_on) ? data.appears_on : [];
            $('artist-albums-block').classList.toggle('hidden', albums.length === 0);
            $('artist-appears-block').classList.toggle('hidden', appears.length === 0);
            if (window.StreamifyAlbums) {
                window.StreamifyAlbums.renderAlbumGrid($('artist-albums-grid'), albums, '');
                window.StreamifyAlbums.renderAlbumGrid($('artist-appears-grid'), appears, '');
            }
        } catch (error) {
            if (error.name === 'AbortError' || seq !== detailSeq) return;
            console.error('[ARTIST DETAIL]', error);
            setPlaceholder(error.notFound ? 'Artist not found' : 'Could not load artist',
                error.notFound ? 'This artist is no longer in your library.' : '');
        } finally {
            if (detailAbort === controller) detailAbort = null;
        }
    }

    function artistUrl(uid) {
        const isCap = window.Capacitor || document.documentElement.classList.contains('is-capacitor');
        return isCap ? `${window.location.pathname}#artist-${uid}` : `/home#artist-${uid}`;
    }

    function navigateToArtist(uid, { fromHistory = false, fromBack = false } = {}) {
        if (!UID_PATTERN.test(String(uid || ''))) return;
        if (window.currentActiveView === 'artist' && currentArtist && currentArtist.artist_uid === uid && !fromHistory) return;
        if (!fromBack && window.StreamifyNav) window.StreamifyNav.rememberOrigin();
        window.currentActiveView = 'artist';
        if (!fromHistory && window.location.hash !== `#artist-${uid}`) {
            try { history.pushState({ view: 'artist', id: uid }, '', artistUrl(uid)); } catch (e) { /* restricted webview */ }
        }
        hideAllSections();
        showSection($('artist-detail-section'));
        document.title = 'Streamify | Artist';
        renderArtistDetail(uid);
    }

    /* --- Photo upload ----------------------------------------------------- */

    async function uploadPhoto(file) {
        if (!currentArtist || !file) return;
        const uid = currentArtist.artist_uid;
        const form = new FormData();
        form.append('image', file);
        try {
            const response = await fetch(window.API_BASE_URL + `/api/artists/${uid}/image`, {
                method: 'POST',
                credentials: 'include',
                body: form
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Upload failed');
            artistsCache = null;
            showToast('Artist photo updated', 'success');
            if (window.currentActiveView === 'artist' && currentArtist && currentArtist.artist_uid === uid) renderArtistDetail(uid);
        } catch (error) {
            showToast(error.message || 'Could not update the artist photo', 'error');
        }
    }

    async function removePhoto() {
        if (!currentArtist) return;
        if (!window.confirm(`Remove the photo for ${currentArtist.name}?`)) return;
        const uid = currentArtist.artist_uid;
        try {
            const response = await fetch(window.API_BASE_URL + `/api/artists/${uid}/image`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (!response.ok) throw new Error('Remove failed');
            artistsCache = null;
            showToast('Artist photo removed', 'success');
            if (window.currentActiveView === 'artist') renderArtistDetail(uid);
        } catch (error) {
            showToast('Could not remove the artist photo', 'error');
        }
    }

    /* --- Wiring ----------------------------------------------------------- */

    // Artist names in song rows and album headers.
    document.addEventListener('click', event => {
        const link = event.target.closest && event.target.closest('.song-artist-link');
        if (!link) return;
        event.preventDefault();
        event.stopPropagation();
        navigateToArtist(link.dataset.artistUid);
    });

    const play = shuffle => {
        if (!currentArtist || currentTracks.length === 0 || !window.StreamifyAlbums) return;
        window.StreamifyAlbums.playTracks(currentTracks, { type: 'artist', id: currentArtist.artist_uid }, { shuffle });
    };
    $('artist-play-btn')?.addEventListener('click', () => play(false));
    $('artist-shuffle-btn')?.addEventListener('click', () => play(true));
    $('artist-tracks-toggle')?.addEventListener('click', () => {
        showAllTracks = !showAllTracks;
        renderPopular();
    });
    $('back-from-artist-btn')?.addEventListener('click', () => {
        if (window.StreamifyNav) window.StreamifyNav.goBack();
    });
    const photoInput = $('artist-photo-input');
    $('artist-photo-change')?.addEventListener('click', () => photoInput && photoInput.click());
    photoInput?.addEventListener('change', () => {
        const file = photoInput.files && photoInput.files[0];
        photoInput.value = '';
        uploadPhoto(file);
    });
    $('artist-photo-remove')?.addEventListener('click', removePhoto);

    /* --- Settings: download artist photos (Owner) ---------------------- */
    const photoSetting = $('artist-photos-online-toggle');

    async function loadPhotoSetting() {
        if (!photoSetting) return;
        try {
            const response = await fetch(window.API_BASE_URL + '/api/settings/artist-images', { credentials: 'include' });
            if (!response.ok) return;
            const data = await response.json();
            photoSetting.checked = data.online !== false;
        } catch (e) { /* keep the current state */ }
    }

    photoSetting?.addEventListener('change', async () => {
        const requested = photoSetting.checked;
        photoSetting.disabled = true;
        try {
            const response = await fetch(window.API_BASE_URL + '/api/settings/artist-images', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ online: requested })
            });
            if (!response.ok) throw new Error('Save failed');
            showToast(requested ? 'Artist photos will be downloaded.' : 'Artist photo downloads turned off.', 'success');
        } catch (error) {
            photoSetting.checked = !requested;
            showToast('Could not save the setting', 'error');
        } finally {
            photoSetting.disabled = false;
        }
    });

    window.navigateToArtist = navigateToArtist;
    window.StreamifyArtists = Object.freeze({
        loadLibraryArtists,
        navigateToArtist,
        loadPhotoSetting,
        fillArtistImage,
        renderArtistGrid,
        currentArtistUid: () => (currentArtist ? currentArtist.artist_uid : null)
    });
})();

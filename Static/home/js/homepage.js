/* ==========================================================================
 * Home - the personal landing page (#home).
 *
 * Renders GET /api/home: a "Jump back in" tile grid followed by shelves of
 * songs, albums and artists built from the user's own listening, likes and
 * library (see Server/home.js). Songs played from a shelf are recorded with
 * source_type "home". Offline, Home shows the downloaded songs instead.
 * ======================================================================== */

(function initStreamifyHome() {
    'use strict';

    let cached = null;
    let requestSeq = 0;

    const $ = id => document.getElementById(id);

    function isOffline() {
        return !navigator.onLine || Boolean(window.StreamifyOfflineMode) ||
            Boolean(window.StreamifyNetwork && window.StreamifyNetwork.isServerReachable === false);
    }

    function greeting() {
        const hour = new Date().getHours();
        const part = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        const user = typeof appCache !== 'undefined' && appCache.user;
        const name = user && (user.display_name || user.username);
        return name ? `${part}, ${name}` : part;
    }

    /* --- Cards ------------------------------------------------------------ */

    function tileImage(tile) {
        const box = document.createElement('div');
        box.className = `home-tile-image home-tile-image--${tile.kind}`;
        if (tile.kind === 'liked') {
            box.innerHTML = "<i class='bx bxs-heart'></i>";
            return box;
        }
        if (tile.kind === 'artist' && window.StreamifyArtists) {
            const holder = document.createElement('div');
            holder.className = 'artist-image';
            window.StreamifyArtists.fillArtistImage(holder, {
                name: tile.title, image: tile.image, fallback_covers: tile.covers || []
            });
            box.appendChild(holder);
            return box;
        }
        const src = safeImageURL(tile.image, '');
        if (src) {
            const img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = src;
            box.appendChild(img);
        } else {
            box.innerHTML = `<i class='bx ${tile.kind === 'playlist' ? 'bxs-playlist' : 'bx-music'}'></i>`;
        }
        return box;
    }

    function openTile(tile) {
        if (tile.kind === 'album' && window.navigateToAlbum) window.navigateToAlbum(tile.id);
        else if (tile.kind === 'artist' && window.navigateToArtist) window.navigateToArtist(tile.id);
        else if (tile.kind === 'playlist' && window.navigateToPlaylist) window.navigateToPlaylist(tile.id);
        else if (tile.kind === 'liked' && window.navigateToLiked) window.navigateToLiked();
    }

    function renderTiles(container, tiles) {
        const grid = document.createElement('div');
        grid.className = 'home-tiles';
        tiles.forEach(tile => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'home-tile';
            button.appendChild(tileImage(tile));
            const text = document.createElement('div');
            text.className = 'home-tile-text';
            text.innerHTML = `<span class="home-tile-title">${escapeHTML(tile.title)}</span>` +
                (tile.subtitle ? `<span class="home-tile-subtitle">${escapeHTML(tile.subtitle)}</span>` : '');
            button.appendChild(text);
            button.setAttribute('aria-label', [tile.title, tile.subtitle].filter(Boolean).join(', '));
            button.addEventListener('click', () => openTile(tile));
            grid.appendChild(button);
        });
        container.appendChild(grid);
    }

    function createSongCard(song, index, songs, sectionId) {
        const card = document.createElement('div');
        card.className = 'home-song-card';
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `Play ${song.name} by ${song.artist}`);
        card.innerHTML = `
            <div class="album-card-cover">
                <img alt="" loading="lazy" decoding="async">
                <span class="album-card-play" aria-hidden="true"><i class='bx bx-play'></i></span>
            </div>
            <div>
                <div class="album-card-title">${escapeHTML(song.name)}</div>
                <div class="album-card-subtitle">${escapeHTML(song.artist)}</div>
            </div>`;
        card.querySelector('img').src = safeImageURL(song.cover, COVER_PLACEHOLDER);
        const play = () => {
            if (window.StreamifyAlbums) {
                window.StreamifyAlbums.playTracks(songs, { type: 'home', id: sectionId }, { startIndex: index });
            }
        };
        card.addEventListener('click', play);
        card.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            play();
        });
        return card;
    }

    /* --- Shelves ---------------------------------------------------------- */

    function shelfAction(section) {
        if (section.id === 'liked') return { label: 'Show all', run: () => window.navigateToLiked && window.navigateToLiked() };
        if (section.id === 'recently_added' && section.type === 'albums') {
            return { label: 'Show all', run: () => openLibraryTab('albums') };
        }
        if (section.id === 'top_artists') return { label: 'All artists', run: () => openLibraryTab('artists') };
        return null;
    }

    function openLibraryTab(tab) {
        if (window.StreamifyAlbums) {
            try { localStorage.setItem('streamify:library-tab:v1', tab); } catch (e) { /* convenience only */ }
        }
        const link = $('library-link');
        if (link) link.click();
        if (window.StreamifyAlbums) window.StreamifyAlbums.showLibraryTab(tab);
    }

    function renderShelf(container, section) {
        const shelf = document.createElement('section');
        shelf.className = 'home-shelf';
        shelf.setAttribute('aria-label', section.title);

        const header = document.createElement('div');
        header.className = 'home-shelf-header';
        header.innerHTML = `<div><h3 class="home-shelf-title">${escapeHTML(section.title)}</h3>` +
            (section.subtitle ? `<p class="home-shelf-subtitle">${escapeHTML(section.subtitle)}</p>` : '') + '</div>';
        const controls = document.createElement('div');
        controls.className = 'home-shelf-controls';
        const action = shelfAction(section);
        if (action) {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'home-shelf-link';
            link.textContent = action.label;
            link.addEventListener('click', action.run);
            controls.appendChild(link);
        }
        const row = document.createElement('div');
        row.className = 'home-row';
        ['left', 'right'].forEach(direction => {
            const arrow = document.createElement('button');
            arrow.type = 'button';
            arrow.className = 'home-scroll-btn';
            arrow.setAttribute('aria-label', direction === 'left' ? `Scroll ${section.title} back` : `Scroll ${section.title} forward`);
            arrow.innerHTML = `<i class='bx bx-chevron-${direction}'></i>`;
            arrow.addEventListener('click', () => {
                row.scrollBy({ left: (direction === 'left' ? -1 : 1) * row.clientWidth * 0.85, behavior: 'smooth' });
            });
            controls.appendChild(arrow);
        });
        header.appendChild(controls);
        shelf.appendChild(header);

        if (section.type === 'songs') {
            section.items.forEach((song, index) => row.appendChild(createSongCard(song, index, section.items, section.id)));
        } else if (section.type === 'albums' && window.StreamifyAlbums) {
            window.StreamifyAlbums.renderAlbumGrid(row, section.items, '');
        } else if (section.type === 'artists' && window.StreamifyArtists) {
            window.StreamifyArtists.renderArtistGrid(row, section.items, '');
        }
        shelf.appendChild(row);

        const updateArrows = () => {
            const [back, forward] = controls.querySelectorAll('.home-scroll-btn');
            const overflow = row.scrollWidth - row.clientWidth > 4;
            back.hidden = !overflow;
            forward.hidden = !overflow;
            back.disabled = row.scrollLeft <= 2;
            forward.disabled = row.scrollLeft >= row.scrollWidth - row.clientWidth - 2;
        };
        row.addEventListener('scroll', updateArrows, { passive: true });
        requestAnimationFrame(updateArrows);
        container.appendChild(shelf);
    }

    function renderPayload(payload) {
        const container = $('home-sections');
        if (!container) return;
        container.replaceChildren();
        const sections = (payload && payload.sections) || [];
        if (sections.length === 0) {
            container.innerHTML = '<p class="home-empty">Your library is empty. Add a music folder in Settings or use Get Music, and Home will fill up as you listen.</p>';
            return;
        }
        sections.forEach(section => {
            if (section.type === 'tiles') renderTiles(container, section.items);
            else renderShelf(container, section);
        });
        if (!payload.has_history) {
            const hint = document.createElement('p');
            hint.className = 'home-hint';
            hint.textContent = 'Play some music and Home will start showing your favourites, your top artists and what you have on repeat.';
            container.insertBefore(hint, container.children[1] || null);
        }
    }

    async function renderOffline() {
        const container = $('home-sections');
        if (!container) return;
        container.innerHTML = '<p class="home-hint">You are offline. Here is what you have downloaded.</p>';
        try {
            const songs = window.OfflineStore ? await window.OfflineStore.getOfflineSongs() : [];
            if (!songs || songs.length === 0) {
                container.innerHTML = '<p class="home-empty">You are offline and have no downloaded songs yet.</p>';
                return;
            }
            const normalized = songs.map(song => ({ ...song, name: song.name || song.title }));
            renderShelf(container, { id: 'offline', title: 'Downloaded', type: 'songs', items: normalized.slice(0, 30) });
        } catch (error) {
            console.error('[HOME OFFLINE]', error);
        }
    }

    async function render() {
        const seq = ++requestSeq;
        const greetingEl = $('home-greeting');
        if (greetingEl) greetingEl.textContent = greeting();
        if (isOffline()) {
            renderOffline();
            return;
        }
        if (cached) renderPayload(cached);
        else $('home-sections').innerHTML = '<p class="home-hint">Loading…</p>';
        try {
            const response = await fetch(window.API_BASE_URL + '/api/home', { credentials: 'include' });
            if (!response.ok) throw new Error(`Home request failed (${response.status})`);
            const payload = await response.json();
            if (seq !== requestSeq || window.currentActiveView !== 'home') return;
            cached = payload;
            renderPayload(payload);
        } catch (error) {
            console.error('[HOME]', error);
            if (seq !== requestSeq) return;
            if (!cached) renderOffline();
        }
    }

    function homeUrl() {
        const isCap = window.Capacitor || document.documentElement.classList.contains('is-capacitor');
        return isCap ? `${window.location.pathname}#home` : '/home#home';
    }

    function showHome({ fromHistory = false } = {}) {
        if (typeof window.cancelSearchRequest === 'function') window.cancelSearchRequest(true);
        if (!fromHistory && window.location.hash !== '#home') {
            try { history.pushState({ view: 'home' }, '', homeUrl()); } catch (e) { /* restricted webview */ }
        }
        window.currentActiveView = 'home';
        if (window.StreamifyNav && window.StreamifyNav.reset) window.StreamifyNav.reset();
        hideAllSections();
        const link = $('home-link');
        if (link) link.classList.add('active');
        showSection($('home-section'));
        document.title = 'Streamify | Home';
        render();
    }

    const link = $('home-link');
    if (link) link.addEventListener('click', event => {
        event.preventDefault();
        showHome();
    });

    window.navigateToHome = showHome;
    window.StreamifyHome = Object.freeze({ show: showHome, render });
})();

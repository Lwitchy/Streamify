/*
 * Streamify - native iOS tab bar (Settings > Experimental >
 * "Native tab bar on iPhone").
 *
 * The bar itself is a real UITabBar drawn by the app
 * (ios/App/App/NativeTabBar.swift), so on iOS 26 it is Liquid Glass. This
 * file decides which tabs exist, keeps the highlighted tab in step with the
 * page, hides the bar while the full-screen player, a sheet or the sidebar
 * is open, and publishes its height as --native-tabbar-h so the mini player
 * can sit on top of it (css/mobile_app.css, html.native-tabbar-on).
 *
 * Tabs reuse the sidebar links, so navigation behaves exactly as before.
 * Nothing happens outside the iPhone app or with the experiment off.
 */
(function () {
    'use strict';

    var FEATURE = 'nativeTabBar';
    var root = document.documentElement;
    var PHONE = window.matchMedia ? window.matchMedia('(max-width: 768px)') : { matches: false };

    function getPlugin() {
        var cap = window.Capacitor;
        if (!cap || !root.classList.contains('is-capacitor-ios')) return null;
        if (cap.Plugins && cap.Plugins.NativeTabBar) return cap.Plugins.NativeTabBar;
        if (typeof cap.registerPlugin === 'function') return cap.registerPlugin('NativeTabBar');
        return null;
    }

    var plugin = getPlugin();
    if (!plugin) return;

    var TABS = [
        { id: 'home', title: 'Home', icon: 'house', selectedIcon: 'house.fill', link: 'home-link' },
        { id: 'search', title: 'Search', icon: 'magnifyingglass', selectedIcon: 'magnifyingglass' },
        { id: 'library', title: 'Library', icon: 'books.vertical', selectedIcon: 'books.vertical.fill', link: 'library-link' },
        { id: 'downloads', title: 'Get Music', icon: 'arrow.down.circle', selectedIcon: 'arrow.down.circle.fill', link: 'downloads-link', ownerOnly: true }
    ];

    var active = false;      // experiment on and the bar is in use
    var shown = false;       // what we last asked the native side for
    var listeners = [];
    var observers = [];
    var syncQueued = false;
    var lastTabsKey = '';

    function isEnabled() {
        return Boolean(window.StreamifyExperiments && window.StreamifyExperiments.isEnabled(FEATURE));
    }

    function byId(id) { return document.getElementById(id); }

    function ownerTabVisible() {
        var link = byId('downloads-link');
        var item = link && link.closest('li');
        return Boolean(item && !item.classList.contains('hidden'));
    }

    function currentTabs() {
        var ownerOk = ownerTabVisible();
        return TABS.filter(function (tab) { return !tab.ownerOnly || ownerOk; }).map(function (tab) {
            return { id: tab.id, title: tab.title, icon: tab.icon, selectedIcon: tab.selectedIcon };
        });
    }

    function isVisible(el) {
        return Boolean(el && !el.classList.contains('hidden'));
    }

    /* Which tab the page is on, from the same "active" classes the sidebar uses. */
    function currentTabId() {
        if (isVisible(byId('search-section'))) return 'search';
        var homeLink = byId('home-link');
        if (homeLink && homeLink.classList.contains('active')) return 'home';
        var downloadsLink = byId('downloads-link');
        if (downloadsLink && downloadsLink.classList.contains('active')) return 'downloads';
        var library = ['library-link', 'liked-songs-link'].some(function (id) {
            var el = byId(id);
            return el && el.classList.contains('active');
        });
        if (library || document.querySelector('.sidebar-playlist-link.active')) return 'library';
        if (isVisible(byId('home-section'))) return 'home';
        if (isVisible(byId('playlist-detail-section')) || isVisible(byId('liked-songs-section'))) return 'library';
        // Album / artist pages keep the tab you came from highlighted.
        return lastTabId;
    }

    var lastTabId = 'home';

    /* The bar steps aside for anything that covers the bottom of the screen. */
    function shouldShow() {
        if (!active || !PHONE.matches) return false;
        var body = document.body;
        if (!body) return false;
        if (body.classList.contains('player-section-active')) return false;
        var sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('mobile-active')) return false;
        if (document.querySelector('.modal-overlay:not(.hidden)')) return false;
        return true;
    }

    function applyMetrics(data) {
        if (!data || typeof data.height !== 'number') return;
        var height = data.visible === false ? 0 : Math.round(data.height);
        root.style.setProperty('--native-tabbar-h', height + 'px');
    }

    function sync() {
        syncQueued = false;
        var want = shouldShow();
        var tabs = currentTabs();
        var key = tabs.map(function (t) { return t.id; }).join(',');
        var selected = currentTabId();
        if (selected) lastTabId = selected;
        // The top bar shows the search field only on the Search page.
        root.classList.toggle('native-tab-search', active && selected === 'search');
        // Page classes first: they decide whether the profile button shows.
        syncPage(want);
        syncProfileMenu(want);

        if (want) {
            // show() also refreshes the items when owner status changes.
            var payload = { selected: selected };
            if (!shown || key !== lastTabsKey) payload.tabs = tabs;
            lastTabsKey = key;
            shown = true;
            root.classList.add('native-tabbar-visible');
            plugin.show(payload).then(applyMetrics).catch(function () {});
        } else if (shown) {
            shown = false;
            root.classList.remove('native-tabbar-visible');
            plugin.hide().catch(function () {});
        }
    }

    function queueSync() {
        if (syncQueued) return;
        syncQueued = true;
        requestAnimationFrame(sync);
    }

    function scrollToTop() {
        var scroller = typeof window.getAppScrollContainer === 'function'
            ? window.getAppScrollContainer()
            : document.querySelector('.content-container');
        if (scroller && scroller.scrollTo) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /* Search page without the keyboard: last results (or a hint) show, and
       the field in the top bar is there to tap when you want to type. */
    function openSearch() {
        if (typeof window.openSearchView === 'function') window.openSearchView();
        scrollToTop();
    }

    /* --- Library > Playlists tab ------------------------------------------
       The sidebar (and its hamburger) is not used in this mode, so Library
       gets a Playlists tab next to Songs / Albums / Artists (albums.js
       switches the panels). Rows come from the playlists the app already
       loaded (appCache.playlists, the data the sidebar is drawn from) and
       open through the sidebar's own navigation. */
    var playlistsTab = null;
    var playlistsPanel = null;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function playlistRow(options) {
        var row = el('button', 'native-playlist-row' + (options.extraClass ? ' ' + options.extraClass : ''));
        row.type = 'button';
        row.setAttribute('role', 'listitem');
        var art = el('span', 'native-playlist-art');
        if (options.cover) {
            var img = document.createElement('img');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = options.cover;
            img.onerror = function () { img.remove(); art.appendChild(el('i', 'bx ' + options.icon)); };
            art.appendChild(img);
        } else {
            art.appendChild(el('i', 'bx ' + options.icon));
        }
        var text = el('span', 'native-playlist-text');
        text.appendChild(el('span', 'native-playlist-name', options.name));
        if (options.meta) text.appendChild(el('span', 'native-playlist-meta', options.meta));
        row.appendChild(art);
        row.appendChild(text);
        row.addEventListener('click', options.onClick);
        return row;
    }

    function cachedPlaylists() {
        // appCache and safeImageURL are globals from config.js
        if (typeof appCache === 'undefined' || !Array.isArray(appCache.playlists)) return [];
        return appCache.playlists;
    }

    function coverFor(playlist) {
        if (!playlist.cover_url) return '';
        return typeof safeImageURL === 'function' ? safeImageURL(playlist.cover_url, '') : playlist.cover_url;
    }

    function openPlaylist(pid) {
        var links = document.querySelectorAll('#sidebar-playlist-list .sidebar-playlist-link');
        for (var i = 0; i < links.length; i++) {
            if (links[i].dataset.playlistId === String(pid)) { links[i].click(); return; }
        }
        if (typeof window.navigateToPlaylist === 'function') window.navigateToPlaylist(pid);
    }

    function renderPlaylists() {
        if (!playlistsPanel) return;
        playlistsPanel.textContent = '';
        var liked = byId('liked-songs-link');
        if (liked) {
            playlistsPanel.appendChild(playlistRow({
                name: 'Liked Songs', meta: 'Playlist', icon: 'bxs-heart', extraClass: 'is-liked',
                onClick: function () { liked.click(); }
            }));
        }
        cachedPlaylists().forEach(function (p) {
            var pid = p.share_id || p.id;
            var count = Number(p.song_count) || 0;
            playlistsPanel.appendChild(playlistRow({
                name: p.name || 'Playlist',
                meta: 'Playlist · ' + count + (count === 1 ? ' song' : ' songs'),
                icon: 'bx-list-ul',
                cover: coverFor(p),
                onClick: function () { openPlaylist(pid); }
            }));
        });
        var create = byId('create-playlist-btn');
        if (create) {
            playlistsPanel.appendChild(playlistRow({
                name: 'New playlist', icon: 'bx-plus', extraClass: 'is-create',
                onClick: function () { create.click(); }
            }));
        }
    }

    function showLibraryTab(tab) {
        if (window.StreamifyAlbums && typeof window.StreamifyAlbums.showLibraryTab === 'function') {
            window.StreamifyAlbums.showLibraryTab(tab);
        }
    }

    function mountPlaylistsTab() {
        var tabs = document.querySelector('#trending-section .library-tabs');
        var artists = byId('library-artists-grid');
        if (!tabs || !artists || playlistsTab) return;

        playlistsTab = el('button', 'library-tab', 'Playlists');
        playlistsTab.type = 'button';
        playlistsTab.id = 'library-tab-playlists';
        playlistsTab.dataset.libraryTab = 'playlists';
        playlistsTab.setAttribute('role', 'tab');
        playlistsTab.setAttribute('aria-selected', 'false');
        playlistsTab.setAttribute('aria-controls', 'library-playlists-list');
        playlistsTab.tabIndex = -1;
        playlistsTab.addEventListener('click', function () { showLibraryTab('playlists'); });
        tabs.insertBefore(playlistsTab, tabs.firstChild);

        playlistsPanel = el('div', 'native-playlists-list hidden');
        playlistsPanel.id = 'library-playlists-list';
        playlistsPanel.setAttribute('role', 'tabpanel');
        playlistsPanel.setAttribute('aria-labelledby', 'library-tab-playlists');
        artists.parentNode.insertBefore(playlistsPanel, artists.nextSibling);
        renderPlaylists();

        // renderSidebarPlaylists() rebuilds this list whenever playlists change.
        var list = byId('sidebar-playlist-list');
        if (list && typeof MutationObserver === 'function') {
            var observer = new MutationObserver(renderPlaylists);
            observer.observe(list, { childList: true });
            observers.push(observer);
        }

        // First time in this mode: Library opens on Playlists, like Spotify.
        try {
            if (!localStorage.getItem('streamify:library-tab:v1')) localStorage.setItem('streamify:library-tab:v1', 'playlists');
        } catch (e) { /* convenience only */ }
        if (window.StreamifyAlbums && typeof window.StreamifyAlbums.syncLibraryTab === 'function') {
            window.StreamifyAlbums.syncLibraryTab();
        }
    }

    function unmountPlaylistsTab() {
        var wasOpen = playlistsPanel && !playlistsPanel.classList.contains('hidden');
        if (playlistsTab && playlistsTab.parentNode) playlistsTab.parentNode.removeChild(playlistsTab);
        if (playlistsPanel && playlistsPanel.parentNode) playlistsPanel.parentNode.removeChild(playlistsPanel);
        playlistsTab = null;
        playlistsPanel = null;
        if (wasOpen) showLibraryTab('songs');
    }

    /* --- Profile menu ------------------------------------------------------
       A native iOS menu (Liquid Glass on iOS 26) opened by an invisible
       native button laid exactly over the avatar pill in the top bar. Items
       click the web menu's own links, so behaviour doesn't change. */
    var PROFILE_ITEMS = [
        { id: 'profile', title: 'Profile', icon: 'person.crop.circle', link: 'open-profile-btn' },
        { id: 'settings', title: 'Settings', icon: 'gearshape', link: 'open-settings-btn' },
        { id: 'logout', title: 'Log out', icon: 'rectangle.portrait.and.arrow.right', link: 'logout-btn',
            destructive: true, confirm: 'Log out of Streamify on this iPhone?' }
    ];
    var lastProfileKey = '';

    function syncProfileMenu(want) {
        if (typeof plugin.setMenuButton !== 'function') return;
        var pill = document.querySelector('.top-bar .user-pill');
        var r = want && pill ? pill.getBoundingClientRect() : null;
        if (r && (r.width < 1 || r.height < 1)) r = null;
        var key = r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : 'hidden';
        if (key === lastProfileKey) return;
        var first = !lastProfileKey;
        lastProfileKey = key;
        var payload = {
            id: 'profile',
            label: 'Account',
            visible: Boolean(r),
            rect: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: 0, y: 0, width: 0, height: 0 }
        };
        if (first) {
            payload.items = PROFILE_ITEMS.map(function (item) {
                return { id: item.id, title: item.title, icon: item.icon, destructive: Boolean(item.destructive), confirm: item.confirm || '' };
            });
        }
        plugin.setMenuButton(payload).catch(function () {});
    }

    function onMenuAction(event) {
        if (!event) return;
        if (event.menu === 'page') {
            var action = pageActionById(event.item);
            if (action) action.click();
            return;
        }
        if (event.menu !== 'profile') return;
        var item = PROFILE_ITEMS.filter(function (i) { return i.id === event.item; })[0];
        var link = item && byId(item.link);
        if (link) link.click();
    }

    /* --- Detail pages: top-bar Back and "more" --------------------------------
       Playlist, album, Liked Songs and artist pages lose their web header
       (Back + a row of buttons, css/mobile_app.css). Instead the top bar
       shows a glass "‹" (clicks the page's own Back) and a glass "⋯" that
       opens a native menu built from the page's visible action buttons -
       so owner-only actions, disabled states and download progress stay
       whatever the page says. Library gets the "⋯" for its header buttons. */
    var PAGES = [
        { id: 'playlist', section: 'playlist-detail-section' },
        { id: 'album', section: 'album-detail-section' },
        { id: 'liked', section: 'liked-songs-section' },
        { id: 'artist', section: 'artist-detail-section' },
        { id: 'library', section: 'trending-section', actions: '.library-section-actions', noBack: true }
    ];

    var ACTION_META = {
        'clone-playlist-btn': { icon: 'plus.square.on.square' },
        'share-playlist-btn': { icon: 'square.and.arrow.up' },
        'download-playlist-btn': { icon: 'arrow.down.circle' },
        'download-album-btn': { icon: 'arrow.down.circle' },
        'download-liked-btn': { icon: 'arrow.down.circle' },
        'download-library-btn': { icon: 'arrow.down.circle', title: 'Download all' },
        'manage-playlist-btn': { icon: 'pencil' },
        'rename-playlist-btn': { icon: 'square.and.pencil' },
        'delete-playlist-btn': { icon: 'trash', destructive: true },
        'artist-photo-change': { icon: 'camera' },
        'artist-photo-remove': { icon: 'trash', destructive: true },
        'batch-ai-enrich-btn': { icon: 'wand.and.stars', title: 'Review metadata' },
        'refresh-library-btn': { icon: 'arrow.clockwise', title: 'Rescan library' },
        'manage-library-btn': { icon: 'checkmark.circle', title: 'Select songs' },
        'album-go-artist': { icon: 'music.mic', title: 'Go to artist' }
    };

    var backButton = null;
    var moreButton = null;
    var lastPageKey = '';

    function currentPage() {
        for (var i = 0; i < PAGES.length; i++) {
            if (isVisible(byId(PAGES[i].section))) return PAGES[i];
        }
        return null;
    }

    function hiddenWithin(node, stop) {
        while (node && node !== stop) {
            if (node.classList && node.classList.contains('hidden')) return true;
            node = node.parentNode;
        }
        return false;
    }

    /* The page's action buttons that are usable right now, in page order. */
    function pageActions(page) {
        var section = page && byId(page.section);
        if (!section) return [];
        var container = section.querySelector(page.actions || '.playlist-detail-header');
        if (!container) return [];
        var actions = [];
        container.querySelectorAll('button[id]').forEach(function (button) {
            if (button.classList.contains('playlist-back-btn')) return;
            if (button.disabled || hiddenWithin(button, section)) return;
            var meta = ACTION_META[button.id] || {};
            var title = meta.title || (button.textContent || '').replace(/\s+/g, ' ').trim() ||
                button.getAttribute('aria-label') || button.title || button.id;
            actions.push({ id: button.id, title: title, icon: meta.icon || 'circle', destructive: Boolean(meta.destructive), el: button });
        });
        if (page.id === 'album') {
            var artistLink = document.querySelector('#album-detail-artist .song-artist-link');
            if (artistLink) {
                actions.push({ id: 'album-go-artist', title: ACTION_META['album-go-artist'].title,
                    icon: ACTION_META['album-go-artist'].icon, destructive: false, el: artistLink });
            }
        }
        return actions;
    }

    function pageActionById(id) {
        var actions = pageActions(currentPage());
        for (var i = 0; i < actions.length; i++) {
            if (actions[i].id === id) return actions[i].el;
        }
        return null;
    }

    function topButton(className, label, iconClass) {
        var button = el('button', 'native-top-btn ' + className);
        button.type = 'button';
        button.setAttribute('aria-label', label);
        var icon = el('i', 'bx ' + iconClass);
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        return button;
    }

    function mountTopButtons() {
        var bar = document.querySelector('.top-bar');
        if (!bar || backButton) return;
        backButton = topButton('native-back-btn', 'Back', 'bx-chevron-left');
        backButton.addEventListener('click', function () {
            var page = currentPage();
            var section = page && byId(page.section);
            var back = section && section.querySelector('.playlist-back-btn');
            if (back) back.click();
        });
        moreButton = topButton('native-more-btn', 'More', 'bx-dots-horizontal-rounded');
        bar.insertBefore(backButton, bar.firstChild);
        bar.appendChild(moreButton);
    }

    function unmountTopButtons() {
        [backButton, moreButton].forEach(function (b) { if (b && b.parentNode) b.parentNode.removeChild(b); });
        backButton = null;
        moreButton = null;
    }

    /* Blurred copy of the page's cover behind its header (Apple Music). */
    function syncBackdrop(page) {
        if (!page || page.id === 'library') return;
        var section = byId(page.section);
        if (!section) return;
        var value = 'none';
        if (page.id === 'album') {
            var img = byId('album-detail-cover');
            var src = img && img.getAttribute('src');
            if (src) value = 'url("' + img.src.replace(/"/g, '%22') + '")';
        } else if (page.id === 'playlist') {
            var cover = byId('playlist-detail-cover');
            var bg = cover ? cover.style.backgroundImage : '';
            if (bg && bg.indexOf('url(') !== -1) value = bg;
        } else if (page.id === 'artist') {
            var hero = byId('artist-hero');
            var artistBg = hero ? hero.style.getPropertyValue('--artist-backdrop') : '';
            if (artistBg) value = artistBg;
        }
        if (section.style.getPropertyValue('--native-backdrop') !== value) {
            section.style.setProperty('--native-backdrop', value);
        }
    }

    function syncPage(want) {
        var page = want ? currentPage() : null;
        var detail = Boolean(page && !page.noBack);
        var actions = page ? pageActions(page) : [];
        root.classList.toggle('native-page-detail', detail);
        root.classList.toggle('native-page-more', actions.length > 0);
        syncBackdrop(page);

        if (typeof plugin.setMenuButton !== 'function') return;
        // Layout settles after the classes above change; measure next frame.
        requestAnimationFrame(function () {
            var r = actions.length && moreButton ? moreButton.getBoundingClientRect() : null;
            if (r && (r.width < 1 || r.height < 1)) r = null;
            var items = actions.map(function (a) {
                return { id: a.id, title: a.title, icon: a.icon, destructive: a.destructive };
            });
            var key = (page ? page.id : '-') + '|' + (r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : 'hidden') +
                '|' + JSON.stringify(items);
            if (key === lastPageKey) return;
            lastPageKey = key;
            plugin.setMenuButton({
                id: 'page',
                label: 'More',
                visible: Boolean(r),
                rect: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : { x: 0, y: 0, width: 0, height: 0 },
                items: items
            }).catch(function () {});
        });
    }

    function observePages() {
        var watch = { attributes: true, attributeFilter: ['class', 'disabled'], childList: true, subtree: true, characterData: true };
        PAGES.forEach(function (page) {
            var section = byId(page.section);
            if (!section) return;
            observe(section, { attributes: true, attributeFilter: ['class'] });
            var container = section.querySelector(page.actions || '.playlist-detail-header');
            observe(container, watch);
        });
        observe(byId('album-detail-artist'), { childList: true, subtree: true });
        observe(byId('album-detail-cover'), { attributes: true, attributeFilter: ['src'] });
        observe(byId('playlist-detail-cover'), { attributes: true, attributeFilter: ['style'] });
        observe(byId('artist-hero'), { attributes: true, attributeFilter: ['style'] });
    }

    /* Compact mini player: tapping anywhere on the card (except its buttons)
       opens the full player, like tapping the cover does. Runs in the
       capture phase so the title / artist don't also follow their album /
       artist links (that's the desktop behaviour). */
    function onMiniPlayerTap(event) {
        if (!active || !root.classList.contains('has-track')) return;
        var target = event.target;
        if (!target || !target.closest) return;
        if (!target.closest('.music-player')) return;
        if (target.closest('#player-img')) return; // the cover opens it itself
        if (target.closest('button, input, .progress-container')) return;
        event.preventDefault();
        event.stopPropagation();
        var cover = byId('player-img');
        if (cover) cover.click();
    }

    function onTabSelected(event) {
        var id = event && event.id;
        var tab = TABS.filter(function (t) { return t.id === id; })[0];
        if (!tab) return;
        if (event.reselected && id !== 'search') {
            scrollToTop();
            return;
        }
        if (id === 'search') {
            openSearch();
        } else if (tab.link) {
            var link = byId(tab.link);
            if (link) link.click();
        }
        queueSync();
    }

    function observe(target, options) {
        if (!target || typeof MutationObserver !== 'function') return;
        var observer = new MutationObserver(queueSync);
        observer.observe(target, options);
        observers.push(observer);
    }

    function start() {
        if (active) return;
        active = true;
        root.classList.add('native-tabbar-on');

        var classOnly = { attributes: true, attributeFilter: ['class'] };
        observe(document.body, classOnly);
        observe(document.querySelector('.sidebar'), classOnly);
        ['home-link', 'library-link', 'liked-songs-link', 'downloads-link', 'search-section', 'home-section'].forEach(function (id) {
            observe(byId(id), classOnly);
        });
        var ownerItem = byId('downloads-link') && byId('downloads-link').closest('li');
        observe(ownerItem, classOnly);
        observe(byId('sidebar-playlist-list'), { attributes: true, attributeFilter: ['class'], subtree: true });
        document.querySelectorAll('.modal-overlay').forEach(function (overlay) { observe(overlay, classOnly); });
        mountPlaylistsTab();
        mountTopButtons();
        observePages();
        document.addEventListener('click', onMiniPlayerTap, true);
        window.addEventListener('resize', queueSync);

        Promise.resolve(plugin.addListener('tabSelected', onTabSelected)).then(function (handle) { listeners.push(handle); });
        Promise.resolve(plugin.addListener('layout', applyMetrics)).then(function (handle) { listeners.push(handle); });
        Promise.resolve(plugin.addListener('menuAction', onMenuAction)).then(function (handle) { listeners.push(handle); });
        if (PHONE.addEventListener) PHONE.addEventListener('change', queueSync);
        queueSync();
    }

    function stop() {
        if (!active) return;
        active = false;
        shown = false;
        lastTabsKey = '';
        observers.forEach(function (o) { o.disconnect(); });
        observers = [];
        listeners.forEach(function (h) { if (h && h.remove) h.remove(); });
        listeners = [];
        if (PHONE.removeEventListener) PHONE.removeEventListener('change', queueSync);
        document.removeEventListener('click', onMiniPlayerTap, true);
        window.removeEventListener('resize', queueSync);
        unmountPlaylistsTab();
        unmountTopButtons();
        lastPageKey = '';
        PAGES.forEach(function (page) {
            var section = byId(page.section);
            if (section) section.style.removeProperty('--native-backdrop');
        });
        lastProfileKey = '';
        root.classList.remove('native-tabbar-on', 'native-tabbar-visible', 'native-tab-search',
            'native-page-detail', 'native-page-more');
        root.style.removeProperty('--native-tabbar-h');
        plugin.remove().catch(function () {});
    }

    function refresh() {
        if (isEnabled()) start(); else stop();
    }

    window.addEventListener('streamifyexperimentchange', function (event) {
        if (event.detail && event.detail.feature === FEATURE) refresh();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refresh, { once: true });
    } else {
        refresh();
    }
})();

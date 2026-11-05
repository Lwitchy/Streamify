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
        return null;
    }

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
        // The top bar shows the search field only on the Search page.
        root.classList.toggle('native-tab-search', active && selected === 'search');

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

    /* --- Library shelf ----------------------------------------------------
       The sidebar (and its hamburger) is gone in this mode, so Library gets
       the sidebar's Liked Songs, playlists and "New playlist" as a row of
       chips. Each chip clicks the matching sidebar control, so behaviour is
       the sidebar's own. */
    var shelf = null;

    function chip(label, iconClass, onClick, extraClass) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'native-shelf-chip' + (extraClass ? ' ' + extraClass : '');
        var icon = document.createElement('i');
        icon.className = 'bx ' + iconClass;
        icon.setAttribute('aria-hidden', 'true');
        var text = document.createElement('span');
        text.textContent = label;
        button.appendChild(icon);
        button.appendChild(text);
        button.addEventListener('click', onClick);
        return button;
    }

    function renderShelf() {
        if (!shelf) return;
        shelf.textContent = '';
        var liked = byId('liked-songs-link');
        if (liked) shelf.appendChild(chip('Liked Songs', 'bxs-heart', function () { liked.click(); }, 'is-liked'));
        document.querySelectorAll('#sidebar-playlist-list .sidebar-playlist-link').forEach(function (link) {
            var name = (link.textContent || '').trim();
            if (!name) return;
            shelf.appendChild(chip(name, 'bx-list-ul', function () { link.click(); }));
        });
        var create = byId('create-playlist-btn');
        if (create) shelf.appendChild(chip('New playlist', 'bx-plus', function () { create.click(); }, 'is-create'));
    }

    function mountShelf() {
        var library = byId('trending-section');
        if (!library || shelf) return;
        shelf = document.createElement('div');
        shelf.className = 'native-library-shelf';
        shelf.setAttribute('role', 'list');
        shelf.setAttribute('aria-label', 'Playlists');
        library.insertBefore(shelf, library.firstChild);
        renderShelf();
        var list = byId('sidebar-playlist-list');
        if (list && typeof MutationObserver === 'function') {
            var observer = new MutationObserver(renderShelf);
            observer.observe(list, { childList: true, subtree: true, characterData: true });
            observers.push(observer);
        }
    }

    function unmountShelf() {
        if (shelf && shelf.parentNode) shelf.parentNode.removeChild(shelf);
        shelf = null;
    }

    /* Compact mini player: the whole title area opens the full player, like
       tapping the cover does. */
    function onMiniPlayerTap(event) {
        if (!active || event.target.closest('button, input, a')) return;
        if (!event.target.closest('.music-player .track-info')) return;
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
        mountShelf();
        document.addEventListener('click', onMiniPlayerTap);

        Promise.resolve(plugin.addListener('tabSelected', onTabSelected)).then(function (handle) { listeners.push(handle); });
        Promise.resolve(plugin.addListener('layout', applyMetrics)).then(function (handle) { listeners.push(handle); });
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
        document.removeEventListener('click', onMiniPlayerTap);
        unmountShelf();
        root.classList.remove('native-tabbar-on', 'native-tabbar-visible', 'native-tab-search');
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

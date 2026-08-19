/**
 * Streamify Downloads (client)
 * ============================
 *
 * Owner-only page for pulling music from Soulseek into the configured
 * music folder. Talks to /api/downloads/* and listens for live progress on the
 * Socket.IO 'role:owner' room.
 *
 * Every node here is built with createElement/textContent rather than innerHTML
 * string concatenation: search results are remote, attacker-influenced strings
 * (peer usernames, filenames, video titles) and must never reach the parser.
 */

(function () {
    'use strict';

    const API = () => (window.API_BASE_URL || '');

    /* ------------------------------------------------------------------ *
     * State
     * ------------------------------------------------------------------ */

    const state = {
        initialised: false,
        loading: false,
        searching: false,
        results: { soulseek: [] },
        sourceStatus: { soulseek: null },
        queue: [],
        downloadFolder: null,
        queuedIds: new Set(),
        socket: null,
        pollTimer: null,
        searchToken: 0,
        noticeEntrancePending: false,
        noticeEntrancePlayed: false
    };

    const el = {};

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    function toast(message, type = 'error') {
        if (typeof window.showToast === 'function') window.showToast(message, type);
        else console.log(`[DOWNLOADS] ${message}`);
    }

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = String(text);
        return element;
    }

    function icon(name) {
        const element = document.createElement('i');
        element.className = `bx ${name}`;
        element.setAttribute('aria-hidden', 'true');
        return element;
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value <= 0) return '';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
        return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function formatEta(seconds) {
        const total = Math.round(Number(seconds) || 0);
        if (total <= 0) return '';
        if (total < 60) return `${total}s left`;
        return `${Math.floor(total / 60)}m ${total % 60}s left`;
    }

    async function apiCall(pathname, options = {}) {
        const response = await fetch(API() + pathname, {
            method: options.method || 'GET',
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: options.signal
        });

        let payload = {};
        try { payload = await response.json(); } catch { /* empty body */ }

        if (!response.ok) {
            const error = new Error(payload.error || `Request failed (${response.status})`);
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    /* ------------------------------------------------------------------ *
     * Source status chips
     * ------------------------------------------------------------------ */

    /** True once Soulseek can actually be searched. Drives the whole Soulseek UI. */
    function soulseekUsable() {
        const soulseek = state.sourceStatus.soulseek;
        return Boolean(soulseek && soulseek.configured && !soulseek.error);
    }

    /**
     * Renders a notice only when Soulseek needs the user's attention. A working
     * source is not worth a status badge, so the page stays clean until
     * something is actually wrong.
     */
    function renderSourceNotice() {
        if (!el.notice) return;
        el.notice.replaceChildren();

        const soulseek = state.sourceStatus.soulseek;
        if (!soulseek || soulseekUsable()) return;

        const failed = Boolean(soulseek.configured && soulseek.error);
        const card = node('div', `downloads-notice downloads-notice--${failed ? 'error' : 'warn'}`);
        if (state.noticeEntrancePending && !state.noticeEntrancePlayed) {
            card.classList.add('downloads-notice--enter');
            state.noticeEntrancePending = false;
            state.noticeEntrancePlayed = true;
        }

        const iconWrap = node('div', 'downloads-notice-icon');
        iconWrap.appendChild(icon(failed ? 'bx-error-circle' : 'bx-network-chart'));
        card.appendChild(iconWrap);

        const body = node('div', 'downloads-notice-body');
        body.appendChild(node('div', 'downloads-notice-title',
            failed ? 'Soulseek is not connected' : 'Soulseek is not set up'));
        body.appendChild(node('div', 'downloads-notice-text', failed
            ? `${soulseek.error} Fix the connection before searching or importing Spotify tracklists.`
            : 'Add a Soulseek account to search files shared by other users, often at 320 kbps or lossless.'));
        card.appendChild(body);

        const action = node('button', 'btn');
        action.type = 'button';
        action.textContent = failed ? 'Fix it' : 'Add account';
        action.addEventListener('click', () => {
            if (typeof window.openDownloadSettings === 'function') window.openDownloadSettings();
        });
        card.appendChild(action);

        el.notice.appendChild(card);
    }

    function renderFolder() {
        if (!el.folder) return;
        el.folder.replaceChildren();
        if (!state.downloadFolder) {
            el.folder.appendChild(icon('bx-error-circle'));
            el.folder.appendChild(node('span', null, 'No music folder configured yet - add one in Settings > Account.'));
            return;
        }
        el.folder.appendChild(icon('bx-folder-open'));
        el.folder.appendChild(node('span', null, state.downloadFolder));
    }

    /* ------------------------------------------------------------------ *
     * Search results
     * ------------------------------------------------------------------ */

    function qualityTags(result) {
        const wrap = node('div', 'download-result-tags');

        if (result.extension) {
            const lossless = result.extension === 'FLAC' || result.extension === 'WAV';
            wrap.appendChild(node('span', `download-tag${lossless ? ' download-tag--lossless' : ''}`, result.extension));
        }
        if (result.bitrate) {
            const good = result.bitrate >= 256;
            wrap.appendChild(node('span', `download-tag${good ? ' download-tag--good' : ''}`, `${result.bitrate} kbps`));
        }
        if (result.sizeBytes) wrap.appendChild(node('span', 'download-tag', formatBytes(result.sizeBytes)));
        wrap.appendChild(node(
            'span',
            `download-tag${result.slots ? ' download-tag--good' : ' download-tag--warn'}`,
            result.slots ? 'Free slot' : 'Queued'
        ));

        return wrap;
    }

    function buildResultRow(result) {
        const row = node('div', 'download-result');

        const placeholder = node('div', 'download-result-art');
        placeholder.appendChild(icon('bx-user-voice'));
        row.appendChild(placeholder);

        const main = node('div', 'download-result-main');
        main.appendChild(node('div', 'download-result-title', result.title || 'Unknown'));
        main.appendChild(node(
            'div',
            'download-result-sub',
            `Shared by ${result.user}${result.queueLength ? ` - ${result.queueLength} in queue` : ''}`
        ));
        row.appendChild(main);

        row.appendChild(qualityTags(result));

        const button = node('button', 'download-get-btn');
        button.type = 'button';
        const alreadyQueued = state.queuedIds.has(result.id);
        button.disabled = alreadyQueued;
        button.appendChild(icon(alreadyQueued ? 'bx-check' : 'bx-download'));
        button.appendChild(node('span', null, alreadyQueued ? 'Queued' : 'Download'));
        button.addEventListener('click', () => requestDownload(result, button));
        row.appendChild(button);

        return row;
    }

    function renderResults() {
        const panel = el.panelSoulseek;
        if (!panel) return;
        panel.replaceChildren();
        if (!soulseekUsable()) return;
        if (state.searching) {
            panel.appendChild(emptyState('bx-loader-alt', 'Searching Soulseek...'));
            return;
        }
        const results = state.results.soulseek || [];
        if (results.length === 0) {
            const status = state.sourceStatus.soulseek;
            const message = status && status.error
                ? status.error
                : (status && status.searched ? 'No results found for that search.' : 'Search for a song above.');
            panel.appendChild(emptyState('bx-search-alt', message));
            return;
        }
        const list = node('div', 'download-result-list');
        results.forEach(result => list.appendChild(buildResultRow(result)));
        panel.appendChild(list);
    }

    function emptyState(iconName, message) {
        const wrap = node('div', 'downloads-empty');
        wrap.appendChild(icon(iconName));
        wrap.appendChild(node('span', null, message));
        return wrap;
    }

    /* ------------------------------------------------------------------ *
     * Queue rendering
     * ------------------------------------------------------------------ */

    const STAGE_LABELS = {
        pending: 'Waiting',
        preparing: 'Preparing',
        searching: 'Looking for a source',
        connecting: 'Connecting to peer',
        downloading: 'Downloading',
        tagging: 'Writing tags and artwork',
        saving: 'Saving to the music folder',
        indexing: 'Adding to your library'
    };

    function queueItemIcon(item) {
        if (item.status === 'completed') return 'bx-check-circle';
        if (item.status === 'failed') return 'bx-error-circle';
        if (item.status === 'cancelled') return 'bx-x-circle';
        if (item.status === 'running') return 'bx-loader-alt bx-spin';
        return 'bx-time-five';
    }

    function queueItemMeta(item) {
        if (item.status === 'completed') {
            const source = item.resolvedSource === 'youtube' ? 'YouTube (legacy)' : 'Soulseek';
            return `Saved from ${source}`;
        }
        if (item.status === 'failed') return item.error || 'Download failed.';
        if (item.status === 'cancelled') return 'Cancelled.';
        if (item.status === 'queued') return 'Waiting in queue';

        const parts = [STAGE_LABELS[item.stage] || 'Working'];
        if (item.stage === 'downloading') {
            if (item.resolvedSource) parts[0] += ` from ${item.resolvedSource === 'youtube' ? 'YouTube (legacy)' : 'Soulseek'}`;
            if (item.resolvedSource === 'soulseek') {
                // Peers send the whole file in one go, so only the expected
                // total is known - never a running byte count.
                if (item.totalBytes > 0) parts.push(formatBytes(item.totalBytes));
            }
            const eta = formatEta(item.etaSeconds);
            if (eta) parts.push(eta);
        }
        return parts.join(' - ');
    }

    function buildQueueRow(item) {
        const row = node('div', `queue-item is-${item.status}`);

        const top = node('div', 'queue-item-top');
        const iconWrap = node('div', 'queue-item-icon');
        iconWrap.appendChild(icon(queueItemIcon(item)));
        top.appendChild(iconWrap);

        const body = node('div', 'queue-item-body');
        const label = [item.artist, item.title].filter(Boolean).join(' - ') || item.title;
        body.appendChild(node('div', 'queue-item-title', label));
        body.appendChild(node(
            'div',
            `queue-item-meta${item.status === 'failed' ? ' is-error' : ''}`,
            queueItemMeta(item)
        ));
        top.appendChild(body);

        const actions = node('div', 'queue-item-actions');
        if (item.status === 'queued' || item.status === 'running') {
            const cancel = node('button', 'queue-icon-btn queue-icon-btn--danger');
            cancel.type = 'button';
            cancel.title = 'Cancel';
            cancel.setAttribute('aria-label', `Cancel ${label}`);
            cancel.appendChild(icon('bx-x'));
            cancel.addEventListener('click', () => cancelQueueItem(item.id));
            actions.appendChild(cancel);
        } else if (item.status === 'failed' || item.status === 'cancelled') {
            const retry = node('button', 'queue-icon-btn');
            retry.type = 'button';
            retry.title = 'Retry';
            retry.setAttribute('aria-label', `Retry ${label}`);
            retry.appendChild(icon('bx-revision'));
            retry.addEventListener('click', () => retryQueueItem(item.id));
            actions.appendChild(retry);
        }
        top.appendChild(actions);
        row.appendChild(top);

        if (item.status === 'running') {
            const track = node('div', 'queue-progress');
            const bar = node('div', 'queue-progress-bar');
            // Soulseek exposes no byte-level progress, so use an indeterminate sweep.
            bar.classList.add('is-indeterminate');
            track.appendChild(bar);
            row.appendChild(track);
        }

        return row;
    }

    function renderQueue() {
        if (!el.queueList) return;
        el.queueList.replaceChildren();

        if (state.queue.length === 0) {
            el.queueList.appendChild(emptyState('bx-cloud-download', 'Nothing queued. Search for a song to get started.'));
        } else {
            state.queue.forEach(item => el.queueList.appendChild(buildQueueRow(item)));
        }

        const pending = state.queue.filter(item => item.status === 'queued' || item.status === 'running').length;
        const finished = state.queue.length - pending;
        if (el.cancelAllBtn) el.cancelAllBtn.disabled = pending === 0;
        if (el.clearBtn) el.clearBtn.disabled = finished === 0;
        if (el.queueCount) {
            el.queueCount.textContent = pending > 0 ? `${pending} pending` : '';
        }
    }

    /* ------------------------------------------------------------------ *
     * Actions
     * ------------------------------------------------------------------ */

    async function refresh() {
        if (state.loading) return;
        state.loading = true;
        try {
            const data = await apiCall('/api/downloads/status');
            state.queue = data.items || [];
            state.downloadFolder = data.downloadFolder || null;
            state.sourceStatus.soulseek = Object.assign({}, state.sourceStatus.soulseek, data.soulseek);
            renderQueue();
            renderSourceNotice();
            // Soulseek availability decides whether the tab strip exists at all,
            // so the results have to be re-rendered whenever status changes.
            renderResults();
            renderFolder();
            schedulePolling();
        } catch (error) {
            if (error.status === 403 || error.status === 401) return;
            console.error('[DOWNLOADS] status', error);
        } finally {
            state.loading = false;
        }
    }

    /**
     * Sockets carry progress normally. Polling is a safety net for when the
     * socket cannot connect (proxy, blocked upgrade) so the page is never stuck.
     */
    function schedulePolling() {
        clearTimeout(state.pollTimer);
        const busy = state.queue.some(item => item.status === 'queued' || item.status === 'running');
        const visible = el.section && !el.section.classList.contains('hidden');
        if (!busy || !visible) return;

        const interval = state.socket && state.socket.connected ? 6000 : 1500;
        state.pollTimer = setTimeout(() => refresh(), interval);
    }

    async function runSearch(rawQuery) {
        const query = String(rawQuery || '').trim();
        if (query.length < 2) {
            toast('Type at least two characters.', 'error');
            return;
        }
        if (!soulseekUsable()) {
            toast('Set up Soulseek in Settings before searching.', 'error');
            if (typeof window.openDownloadSettings === 'function') window.openDownloadSettings();
            return;
        }

        // A pasted link is a different operation; route it before searching.
        if (/^https?:\/\//i.test(query)) {
            return resolveLink(query);
        }

        const token = ++state.searchToken;
        state.searching = true;
        state.results = { soulseek: [] };
        if (el.searchBtn) el.searchBtn.disabled = true;
        renderResults();

        try {
            const data = await apiCall('/api/downloads/search', {
                method: 'POST',
                body: { query, sources: ['soulseek'] }
            });
            if (token !== state.searchToken) return;

            state.results.soulseek = data.soulseek.results || [];
            state.sourceStatus.soulseek = Object.assign({}, state.sourceStatus.soulseek, {
                error: data.soulseek.error,
                searched: true
            });
        } catch (error) {
            if (token !== state.searchToken) return;
            toast(error.message, 'error');
        } finally {
            if (token === state.searchToken) {
                state.searching = false;
                if (el.searchBtn) el.searchBtn.disabled = false;
                renderResults();
                renderSourceNotice();
            }
        }
    }

    async function resolveLink(url) {
        if (el.searchBtn) el.searchBtn.disabled = true;
        toast('Reading that link...', 'info');

        try {
            const data = await apiCall('/api/downloads/resolve', { method: 'POST', body: { url } });

            openConfirm({
                title: data.label || 'Import',
                note: `${data.tracks.length} track${data.tracks.length === 1 ? '' : 's'} found. Each one will be searched on Soulseek.`,
                tracks: data.tracks,
                batchLabel: data.label
            });
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            if (el.searchBtn) el.searchBtn.disabled = false;
        }
    }

    /* --- Confirmation ------------------------------------------------- */

    // Held in a closure rather than a data attribute so the payload keeps its
    // real types and never round-trips through the DOM.
    let pendingConfirm = null;

    /**
     * Single entry point for "are you sure?". Nothing reaches the queue without
     * passing through here, whether it is one picked result or a whole Spotify
     * album.
     */
    function openConfirm({ title, note, tracks, preview, batchLabel, onCancel }) {
        if (!el.confirmModal) return;

        pendingConfirm = { tracks, batchLabel: batchLabel || null, onCancel: onCancel || null };

        el.confirmTitle.textContent = title;
        el.confirmNote.textContent = note || '';

        // Single track: show a summary card. Many: show a numbered list.
        el.confirmSingle.replaceChildren();
        el.confirmList.replaceChildren();
        const isSingle = Boolean(preview);
        el.confirmList.classList.toggle('hidden', isSingle);

        if (isSingle) {
            el.confirmSingle.appendChild(buildConfirmTrack(preview));
        } else {
            tracks.slice(0, 100).forEach((track, index) => {
                const row = node('div', 'resolve-preview-item');
                row.appendChild(node('span', 'resolve-preview-index', String(index + 1)));
                const text = node('div', 'resolve-preview-text');
                text.appendChild(node('strong', null, track.title));
                if (track.artist) text.appendChild(node('span', null, ` - ${track.artist}`));
                row.appendChild(text);
                el.confirmList.appendChild(row);
            });
        }

        el.confirmAccept.replaceChildren(
            icon('bx-download'),
            node('span', null, isSingle ? 'Download' : `Download ${tracks.length}`)
        );

        el.confirmModal.classList.remove('hidden');
        requestAnimationFrame(() => el.confirmAccept.focus());
    }

    function buildConfirmTrack(preview) {
        const card = node('div', 'download-confirm-track');

        if (preview.thumbnail) {
            const image = document.createElement('img');
            image.className = 'download-confirm-art';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.alt = '';
            image.src = preview.thumbnail;
            image.addEventListener('error', () => {
                const fallback = node('div', 'download-confirm-art');
                fallback.appendChild(icon('bx-music'));
                image.replaceWith(fallback);
            });
            card.appendChild(image);
        } else {
            const placeholder = node('div', 'download-confirm-art');
            placeholder.appendChild(icon(preview.source === 'soulseek' ? 'bx-user-voice' : 'bx-music'));
            card.appendChild(placeholder);
        }

        const info = node('div', 'download-confirm-info');
        info.appendChild(node('div', 'download-confirm-title', preview.title || 'Unknown'));
        info.appendChild(node('div', 'download-confirm-sub', preview.subtitle || ''));
        if (preview.tags && preview.tags.length > 0) {
            const tags = node('div', 'download-confirm-tags');
            preview.tags.forEach(tag => tags.appendChild(node('span', `download-tag${tag.variant ? ` download-tag--${tag.variant}` : ''}`, tag.label)));
            info.appendChild(tags);
        }
        card.appendChild(info);

        return card;
    }

    function closeConfirm(runCancel = true) {
        if (!el.confirmModal) return;
        el.confirmModal.classList.add('hidden');
        const pending = pendingConfirm;
        pendingConfirm = null;
        if (runCancel && pending && typeof pending.onCancel === 'function') pending.onCancel();
    }

    async function acceptConfirm() {
        if (!pendingConfirm) return;
        const { tracks, batchLabel } = pendingConfirm;
        // Cleared without firing onCancel: this is an accept, not a dismissal.
        closeConfirm(false);
        if (el.searchInput) el.searchInput.value = '';
        await enqueueItemsSafely(tracks, batchLabel);
    }

    async function enqueueItems(tracks, batchLabel) {
        const data = await apiCall('/api/downloads/enqueue', {
            method: 'POST',
            body: { items: tracks, batchLabel }
        });

        const skipped = (data.skipped || []).length;
        if (data.queued > 0) {
            toast(
                `Queued ${data.queued} track${data.queued === 1 ? '' : 's'}${skipped ? ` (${skipped} already queued)` : ''}.`,
                'success'
            );
        } else if (skipped > 0) {
            toast('Those tracks are already in the queue.', 'info');
        }

        await refresh();
        return data;
    }

    async function enqueueItemsSafely(tracks, batchLabel) {
        try {
            return await enqueueItems(tracks, batchLabel);
        } catch (error) {
            toast(error.message, 'error');
            return null;
        }
    }

    /** Asks first, then queues. Never downloads straight off a result click. */
    function requestDownload(result, button) {
        const item = {
            requestedSource: 'soulseek',
            title: result.title,
            artist: null,
            searchQuery: result.title,
            sourcePayload: result.payload
        };

        const restoreButton = () => {
            state.queuedIds.delete(result.id);
            if (button) {
                button.disabled = false;
                button.replaceChildren(icon('bx-download'), node('span', null, 'Download'));
            }
        };

        // Optimistic so the row cannot be double-submitted while the dialog is
        // open; reverted if the user backs out or the request is rejected.
        state.queuedIds.add(result.id);
        if (button) {
            button.disabled = true;
            button.replaceChildren(icon('bx-check'), node('span', null, 'Queued'));
        }

        openConfirm({
            title: 'Download this track?',
            note: 'Downloaded from another Soulseek user, then saved to your music folder and added to your library.',
            tracks: [item],
            preview: {
                source: result.source,
                title: result.title,
                subtitle: `Shared by ${result.user}`,
                thumbnail: result.thumbnail,
                tags: confirmTags(result)
            },
            onCancel: restoreButton
        });
    }

    /** The same quality summary shown on the result row, for the dialog. */
    function confirmTags(result) {
        const tags = [];
        if (result.extension) {
            const lossless = result.extension === 'FLAC' || result.extension === 'WAV';
            tags.push({ label: result.extension, variant: lossless ? 'lossless' : null });
        }
        if (result.bitrate) tags.push({ label: `${result.bitrate} kbps`, variant: result.bitrate >= 256 ? 'good' : null });
        if (result.sizeBytes) tags.push({ label: formatBytes(result.sizeBytes) });
        tags.push({ label: result.slots ? 'Free slot' : 'Queued', variant: result.slots ? 'good' : 'warn' });
        return tags;
    }

    async function cancelQueueItem(id) {
        try {
            await apiCall(`/api/downloads/queue/${id}/cancel`, { method: 'POST' });
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function retryQueueItem(id) {
        try {
            await apiCall(`/api/downloads/queue/${id}/retry`, { method: 'POST' });
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function cancelAll() {
        try {
            await apiCall('/api/downloads/queue/cancel-all', { method: 'POST' });
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function clearFinished() {
        try {
            await apiCall('/api/downloads/queue/clear', { method: 'POST' });
            await refresh();
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    /* ------------------------------------------------------------------ *
     * Live progress
     * ------------------------------------------------------------------ */

    /**
     * A dedicated socket rather than reusing api_v2's `socket` binding: that one
     * is declared but never connected, and activating it would wake unrelated
     * dormant listeners.
     */
    function connectSocket() {
        if (state.socket || typeof window.io !== 'function') return;

        try {
            const socket = window.io({ withCredentials: true, transports: ['websocket', 'polling'] });
            state.socket = socket;

            socket.on('downloads:progress', payload => {
                if (!payload || !payload.item) return;
                const index = state.queue.findIndex(entry => entry.id === payload.item.id);
                if (index >= 0) state.queue[index] = payload.item;
                else state.queue.unshift(payload.item);
                renderQueue();
            });

            socket.on('downloads:changed', () => refresh());

            socket.on('downloads:completed', payload => {
                if (payload && payload.item) {
                    const label = [payload.item.artist, payload.item.title].filter(Boolean).join(' - ');
                    toast(`Downloaded ${label}`, 'success');
                }
                // The song now exists in the library, so drop the cached copy.
                // appCache is a top-level `const` in config.js, which binds in
                // the global lexical scope and NOT on window - referencing it
                // through window.appCache silently does nothing.
                if (typeof appCache !== 'undefined') {
                    appCache.library = null;
                    appCache.libraryTime = 0;
                    appCache.trending = null;
                    appCache.trendingTime = 0;
                }
            });

            socket.on('connect_error', error => {
                console.warn('[DOWNLOADS] socket unavailable, falling back to polling:', error.message);
            });
        } catch (error) {
            console.warn('[DOWNLOADS] socket setup failed:', error.message);
        }
    }

    /* ------------------------------------------------------------------ *
     * Wiring
     * ------------------------------------------------------------------ */

    function cacheElements() {
        el.section = document.getElementById('downloads-section');
        el.notice = document.getElementById('downloads-source-notice');
        el.folder = document.getElementById('downloads-folder-path');
        el.form = document.getElementById('downloads-search-form');
        el.searchInput = document.getElementById('downloads-search-input');
        el.searchBtn = document.getElementById('downloads-search-btn');
        el.panelSoulseek = document.getElementById('downloads-panel-soulseek');
        el.queueList = document.getElementById('downloads-queue-list');
        el.queueCount = document.getElementById('downloads-queue-count');
        el.cancelAllBtn = document.getElementById('downloads-cancel-all-btn');
        el.clearBtn = document.getElementById('downloads-clear-btn');
        el.confirmModal = document.getElementById('downloads-confirm-modal');
        el.confirmTitle = document.getElementById('downloads-confirm-title');
        el.confirmNote = document.getElementById('downloads-confirm-note');
        el.confirmSingle = document.getElementById('downloads-confirm-single');
        el.confirmList = document.getElementById('downloads-confirm-list');
        el.confirmAccept = document.getElementById('downloads-confirm-accept');
        el.confirmCancel = document.getElementById('downloads-confirm-cancel');
        el.confirmClose = document.getElementById('downloads-confirm-close');
    }

    function bindEvents() {
        if (el.form) {
            el.form.addEventListener('submit', event => {
                event.preventDefault();
                runSearch(el.searchInput ? el.searchInput.value : '');
            });
        }

        if (el.cancelAllBtn) el.cancelAllBtn.addEventListener('click', cancelAll);
        if (el.clearBtn) el.clearBtn.addEventListener('click', clearFinished);

        if (el.confirmAccept) el.confirmAccept.addEventListener('click', acceptConfirm);
        if (el.confirmCancel) el.confirmCancel.addEventListener('click', () => closeConfirm());
        if (el.confirmClose) el.confirmClose.addEventListener('click', () => closeConfirm());
        if (el.confirmModal) {
            el.confirmModal.addEventListener('click', event => {
                if (event.target === el.confirmModal) closeConfirm();
            });
        }

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && el.confirmModal && !el.confirmModal.classList.contains('hidden')) {
                closeConfirm();
            }
        });
    }

    /** Called by ui.js whenever the Downloads view becomes visible. */
    function open() {
        if (!state.initialised) {
            cacheElements();
            if (!el.section) return;
            bindEvents();
            renderResults();
            state.initialised = true;
        }
        if (!state.noticeEntrancePlayed) state.noticeEntrancePending = true;
        connectSocket();
        refresh();
    }

    function close() {
        clearTimeout(state.pollTimer);
    }

    window.StreamifyDownloads = { open, close, refresh };
})();

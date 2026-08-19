/* =========================================================================
 * Streamify — auto-update (renderer side)
 * =========================================================================
 *
 * The desktop app owns the update machinery; this file is only its face.
 * electron/updater.js talks to GitHub, verifies the download and runs the
 * installer. Everything here is display plus four user intents:
 *
 *     check now · download now · restart and install · turn it off
 *
 * Inert in a browser or on a phone. window.streamifyDesktop does not exist
 * there, so the module short-circuits at load and ui.js can call into it
 * unconditionally.
 *
 * WHY THE SWITCH IS NOT localStorage
 * ----------------------------------
 * Unlike the Discord toggles next door, this one is not a per-device
 * preference. On a self-hosted server the Owner is the only person who can
 * apply an update, so the switch lives in the server's system_config table and
 * is written through the Owner-gated POST /api/settings/updates. The desktop
 * bridge deliberately exposes no way to write it. After a successful save we
 * call refreshPolicy() so the running main process re-reads the row instead of
 * waiting for a restart.
 * ========================================================================= */

window.StreamifyUpdates = (function () {
    'use strict';

    const bridge = (window.streamifyDesktop && window.streamifyDesktop.updates) || null;
    const supported = Boolean(bridge);

    /** Latest status pushed by the main process, or null before the first read. */
    let status = null;

    /** Version we have already announced, so the toast fires once per release. */
    let announcedVersion = null;

    /** True only while the Updates pane is on screen. */
    let paneVisible = false;

    const el = id => document.getElementById(id);

    /* --- Copy ------------------------------------------------------------- */

    /**
     * Why this particular build cannot replace itself. Being specific matters:
     * "updates unavailable" reads like a bug, while "your package manager owns
     * this install" tells the user exactly what to do instead.
     */
    const UNSUPPORTED_COPY = {
        development: 'Running from source. Update with git pull instead.',
        portable: 'Portable builds cannot update themselves. Download a newer portable build from the releases page.',
        'linux-package': 'This install is managed by your package manager. Update it the same way you installed it.',
        'unsigned-macos': 'Automatic updates are not available in the macOS build yet.'
    };

    function formatTime(timestamp) {
        if (!timestamp) return null;
        try {
            return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (err) {
            return null;
        }
    }

    /** @returns {{ text: string, kind: string }} */
    function describe(state) {
        if (!state.supported) {
            return {
                text: UNSUPPORTED_COPY[state.unsupportedReason] || 'Automatic updates are not available for this build.',
                kind: ''
            };
        }

        switch (state.state) {
            case 'checking':
                return { text: 'Checking GitHub for a newer release\u2026', kind: 'busy' };
            case 'available':
                return state.enabled
                    ? { text: `Version ${state.latestVersion} is available. Starting the download\u2026`, kind: 'busy' }
                    : { text: `Version ${state.latestVersion} is available.`, kind: '' };
            case 'downloading':
                return { text: `Downloading version ${state.latestVersion} \u2014 ${state.percent}%`, kind: 'busy' };
            case 'downloaded':
                // With the switch off nothing is applied automatically, so the
                // only honest instruction is the explicit one.
                return {
                    text: state.enabled
                        ? `Version ${state.latestVersion} is ready. It installs the next time Streamify quits.`
                        : `Version ${state.latestVersion} is downloaded. Press Restart and install to apply it.`,
                    kind: 'ok'
                };
            case 'error':
                return { text: state.error || 'The update check failed.', kind: 'error' };
            default:
                break;
        }

        if (!state.enabled) {
            return { text: 'Automatic updates are turned off for this server.', kind: '' };
        }
        const checkedAt = formatTime(state.lastCheckedAt);
        return {
            text: checkedAt
                ? `Streamify is up to date. Last checked at ${checkedAt}.`
                : 'No check has run yet.',
            kind: checkedAt ? 'ok' : ''
        };
    }

    /* --- Rendering -------------------------------------------------------- */

    function render() {
        if (!status) return;

        const setting = el('auto-update-setting');
        const toggle = el('auto-update-toggle');
        const version = el('update-current-version');
        const statusLine = el('update-status');
        const progress = el('update-progress');
        const progressFill = el('update-progress-fill');
        const notesWrap = el('update-notes-wrap');
        const notes = el('update-notes');
        const notesVersion = el('update-notes-version');
        const checkBtn = el('update-check-btn');
        const downloadBtn = el('update-download-btn');
        const installBtn = el('update-install-btn');

        if (version) version.textContent = status.currentVersion || '\u2014';

        // The row itself is Owner-gated by ui.js; only the value is ours.
        if (toggle) toggle.checked = status.enabled === true;
        // Nothing to switch off when the build cannot update in the first place.
        if (setting && !status.supported) setting.classList.add('hidden');

        if (statusLine) {
            const described = describe(status);
            statusLine.textContent = described.text;
            statusLine.className = `downloads-setting-status${described.kind ? ` is-${described.kind}` : ''}`;
        }

        const downloading = status.state === 'downloading';
        if (progress) progress.classList.toggle('hidden', !downloading);
        if (progressFill) progressFill.style.width = `${downloading ? status.percent : 0}%`;

        const hasNotes = Boolean(status.releaseNotes) &&
            (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded');
        if (notesWrap) notesWrap.classList.toggle('hidden', !hasNotes);
        if (hasNotes) {
            // textContent, never innerHTML: these notes come off the network.
            if (notes) notes.textContent = status.releaseNotes;
            if (notesVersion) notesVersion.textContent = status.latestVersion || '';
        }

        if (checkBtn) {
            checkBtn.classList.toggle('hidden', !status.supported);
            checkBtn.disabled = status.state === 'checking' || downloading;
            checkBtn.textContent = status.state === 'checking' ? 'Checking\u2026' : 'Check now';
        }
        if (downloadBtn) {
            downloadBtn.classList.toggle('hidden', !(status.supported && status.state === 'available'));
        }
        if (installBtn) {
            installBtn.classList.toggle('hidden', status.state !== 'downloaded');
        }
    }

    /**
     * Announces a finished download once, even when Settings is closed: an
     * update that sits there unmentioned until the user happens to open a
     * settings pane may as well not exist.
     */
    function announce(next) {
        if (next.state !== 'downloaded' || !next.latestVersion) return;
        if (announcedVersion === next.latestVersion) return;
        announcedVersion = next.latestVersion;
        if (typeof window.showToast !== 'function') return;
        window.showToast(
            next.enabled
                ? `Streamify ${next.latestVersion} is ready. It installs when you quit the app.`
                : `Streamify ${next.latestVersion} is downloaded. Apply it from Settings \u203a Updates.`,
            'success',
            7000
        );
    }

    function apply(next) {
        if (!next) return;
        status = next;
        announce(next);
        if (paneVisible) render();
    }

    /* --- Actions ---------------------------------------------------------- */

    async function refresh() {
        if (!supported) return null;
        try {
            apply(await bridge.getStatus());
        } catch (err) {
            console.error('[UPDATES] Could not read the update status:', err);
        }
        return status;
    }

    async function checkNow() {
        if (!supported) return;
        try {
            apply(await bridge.check());
        } catch (err) {
            console.error('[UPDATES] Check failed:', err);
        }
    }

    async function downloadNow() {
        if (!supported) return;
        try {
            apply(await bridge.download());
        } catch (err) {
            console.error('[UPDATES] Download failed:', err);
        }
    }

    async function installNow() {
        if (!supported) return;
        if (!window.confirm('Streamify will close, install the update and reopen. Continue?')) return;
        try {
            const result = await bridge.install();
            if (result && result.ok === false && typeof window.showToast === 'function') {
                window.showToast(result.error || 'The update could not be installed.', 'error');
            }
        } catch (err) {
            console.error('[UPDATES] Install failed:', err);
            if (typeof window.showToast === 'function') {
                window.showToast('The update could not be installed.', 'error');
            }
        }
    }

    /**
     * Owner-only. Writes the server-wide switch, then tells the main process to
     * re-read it. Returns false so the caller can put the toggle back if the
     * request was rejected.
     */
    async function setAutoUpdate(enabled) {
        try {
            const res = await fetch((window.API_BASE_URL || '') + '/api/settings/updates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ enabled: enabled === true })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not save the setting.');

            if (supported) apply(await bridge.refreshPolicy());
            return true;
        } catch (err) {
            console.error('[UPDATES] Could not change the auto-update setting:', err);
            if (typeof window.showToast === 'function') {
                window.showToast(err.message || 'Could not save the setting.', 'error');
            }
            await refresh();
            render();
            return false;
        }
    }

    function openReleases() {
        const url = (status && (status.releaseUrl || status.releasesUrl)) ||
            'https://github.com/Lwitchy/Streamify/releases';
        if (window.streamifyDesktop && typeof window.streamifyDesktop.openExternal === 'function') {
            window.streamifyDesktop.openExternal(url);
        } else {
            window.open(url, '_blank', 'noopener');
        }
    }

    /* --- Wiring ----------------------------------------------------------- */

    /** Called by ui.js when the Updates pane becomes visible. */
    async function load() {
        paneVisible = true;
        await refresh();
        render();
    }

    /** Called by ui.js when any other pane is selected or Settings closes. */
    function unload() {
        paneVisible = false;
    }

    function whenReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    if (supported) {
        // Subscribed at load, not when the pane opens: download progress and
        // the "ready to install" moment both arrive unprompted.
        bridge.onState(apply);

        whenReady(() => {
            el('update-check-btn')?.addEventListener('click', checkNow);
            el('update-download-btn')?.addEventListener('click', downloadNow);
            el('update-install-btn')?.addEventListener('click', installNow);
            el('update-releases-btn')?.addEventListener('click', openReleases);

            const toggle = el('auto-update-toggle');
            toggle?.addEventListener('change', async () => {
                const wanted = toggle.checked;
                toggle.disabled = true;
                const saved = await setAutoUpdate(wanted);
                toggle.disabled = false;
                if (!saved) toggle.checked = !wanted;
            });
        });

        // Seed the cached status so a download that finishes before the user
        // ever opens Settings still produces a toast.
        void refresh();
    }

    return {
        isSupported: () => supported,
        load,
        unload,
        refresh,
        checkNow,
        getStatus: () => status
    };
})();

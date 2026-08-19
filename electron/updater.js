/**
 * Streamify Desktop — auto-update
 * ==============================
 *
 * Wraps electron-updater so the rest of the app never touches it directly.
 *
 * How the pieces fit
 * ------------------
 *   GitHub Releases ──> latest.yml ──> electron-updater ──> this module
 *                                                              │
 *                                        state broadcast ──────┤
 *                                                              ▼
 *                                              Settings → Updates pane
 *
 * electron-builder writes app-update.yml into the packaged app from the
 * `publish:` block in electron-builder.yml. That file is the feed; there is no
 * hand-written GitHub API call anywhere, because electron-updater already does
 * signature-adjacent checks (SHA-512 of every asset, taken from latest.yml)
 * that a naive fetch of /releases/latest would skip.
 *
 * The on/off switch
 * ------------------
 * The switch is server state, not device state: it lives in the SQLite
 * `system_config` table under `auto_update_enabled` and only the Owner can
 * change it, through POST /api/settings/updates. The desktop app hosts that
 * same server in-process (see main.js), so the value is read straight from the
 * database instead of making an authenticated HTTP call to ourselves — main.js
 * passes that read in as `readSetting`. The renderer calls refreshPolicy()
 * after a successful toggle so the change takes effect without a restart.
 *
 * When the switch is off nothing is contacted: no scheduled check, no
 * download, and a pending download is not installed on quit.
 *
 * What is deliberately NOT here
 * -----------------------------
 * No silent restart. Updates download in the background and install on the
 * next ordinary quit (or when the user presses "Restart and install"), because
 * yanking the app out from under someone mid-song is user-hostile.
 */

'use strict';

const { app } = require('electron');

/** Re-check interval for a session that stays open for days. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delay before the first check. Startup already competes for disk and CPU with
 * the library scan and the service worker install; an update check is never
 * urgent enough to join that fight.
 */
const FIRST_CHECK_DELAY_MS = 45 * 1000;

/** system_config key holding the Owner-controlled switch. */
const CONFIG_KEY = 'auto_update_enabled';

/** Absent from the database means "not migrated yet", not "opted out". */
const DEFAULT_ENABLED = true;

const REPO_OWNER = 'Lwitchy';
const REPO_NAME = 'Streamify';
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

/** Release notes are shown as plain text in a small pane; cap the payload. */
const MAX_RELEASE_NOTES = 1500;

/**
 * GitHub returns release notes as rendered HTML. The renderer writes them with
 * textContent, so tags would show up literally — and injecting them as HTML
 * would hand the release feed a scripting primitive. Flatten to text here,
 * where it only has to happen once.
 */
function toPlainText(notes) {
    if (Array.isArray(notes)) {
        return toPlainText(notes.map(entry => (entry && entry.note) || '').join('\n\n'));
    }
    if (typeof notes !== 'string' || !notes) return null;

    const text = notes
        .replace(/<\s*(br|\/p|\/li|\/h[1-6])\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (!text) return null;
    return text.length > MAX_RELEASE_NOTES ? `${text.slice(0, MAX_RELEASE_NOTES)}\u2026` : text;
}

/**
 * Link to the release the update came from.
 *
 * The GitHub provider reports the real tag it resolved, so prefer it: guessing
 * `v${version}` only holds while every tag follows electron-builder's default
 * prefix, and a single hand-made `0.4.0` tag would 404 the button.
 */
function releaseUrlFor(info) {
    const tag = info && typeof info.tag === 'string' && info.tag
        ? info.tag
        : (info && info.version ? `v${info.version}` : null);
    return tag ? `${RELEASES_URL}/tag/${encodeURIComponent(tag)}` : RELEASES_URL;
}

/**
 * Decides whether this particular build can replace itself.
 *
 * Getting this wrong is worse than having no updater at all: a deb install
 * that quietly swapped its own files would desync from dpkg's manifest, and a
 * portable exe has no install root to write to. Report the reason instead, so
 * the settings pane can explain rather than showing a check that always fails.
 */
function describeTargetSupport() {
    if (!app.isPackaged) {
        return { supported: false, reason: 'development' };
    }
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        return { supported: false, reason: 'portable' };
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
        return { supported: false, reason: 'linux-package' };
    }
    if (process.platform === 'darwin') {
        // macOS refuses to launch an updated bundle whose signature does not
        // match, and this project ships no signing identity.
        return { supported: false, reason: 'unsigned-macos' };
    }
    return { supported: true, reason: null };
}

/**
 * @param {object} options
 * @param {Function} options.log           (level, ...parts) => void
 * @param {Function} options.broadcast     (state) => void, main -> renderer.
 * @param {Function} options.beforeInstall Awaited before the installer runs.
 * @param {Function} options.readSetting   (key) => Promise<string|null>, the raw
 *   system_config value. Injected so this module never has to know that the
 *   switch happens to live in SQLite.
 */
function createUpdater({ log, broadcast, beforeInstall, readSetting }) {
    const target = describeTargetSupport();

    let autoUpdater = null;
    let loadError = null;
    let enabled = DEFAULT_ENABLED;
    let checkTimer = null;
    let firstCheckTimer = null;
    let inFlightCheck = null;
    let destroyed = false;

    const state = {
        state: 'idle',           // idle|checking|available|downloading|downloaded|error
        latestVersion: null,
        releaseNotes: null,
        releaseUrl: RELEASES_URL,
        percent: 0,
        error: null,
        lastCheckedAt: null,
    };

    function snapshot() {
        return {
            supported: target.supported,
            unsupportedReason: target.reason,
            enabled,
            currentVersion: app.getVersion(),
            releasesUrl: RELEASES_URL,
            ...state,
        };
    }

    function publish(patch) {
        Object.assign(state, patch);
        if (destroyed) return;
        try {
            broadcast(snapshot());
        } catch (err) {
            log('WARN', 'Could not broadcast update state:', err);
        }
    }

    /* --- electron-updater ------------------------------------------------ */

    function getAutoUpdater() {
        if (autoUpdater || loadError) return autoUpdater;

        try {
            // Required lazily: a packaging mistake that drops the dependency
            // must degrade to "updates unavailable", never to a dead app.
            ({ autoUpdater } = require('electron-updater'));
        } catch (err) {
            loadError = err;
            log('ERROR', 'electron-updater could not be loaded:', err);
            return null;
        }

        autoUpdater.logger = {
            info: (...parts) => log('INFO', '[updater]', ...parts),
            warn: (...parts) => log('WARN', '[updater]', ...parts),
            error: (...parts) => log('ERROR', '[updater]', ...parts),
            debug: () => { /* far too chatty for a shared log file */ },
        };

        // We drive the download ourselves so the switch is honoured at the
        // moment of download, not at the moment the check was scheduled.
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.allowPrerelease = false;
        autoUpdater.allowDowngrade = false;

        autoUpdater.on('checking-for-update', () => {
            publish({ state: 'checking', error: null });
        });

        autoUpdater.on('update-available', (info) => {
            log('INFO', `Update available: ${info && info.version}`);
            publish({
                state: 'available',
                latestVersion: (info && info.version) || null,
                releaseNotes: toPlainText(info && info.releaseNotes),
                releaseUrl: releaseUrlFor(info),
                percent: 0,
                error: null,
                lastCheckedAt: Date.now(),
            });
            if (enabled) void download();
        });

        autoUpdater.on('update-not-available', () => {
            publish({
                state: 'idle',
                latestVersion: null,
                releaseNotes: null,
                releaseUrl: RELEASES_URL,
                percent: 0,
                error: null,
                lastCheckedAt: Date.now(),
            });
        });

        autoUpdater.on('download-progress', (progress) => {
            const percent = progress && Number.isFinite(progress.percent)
                ? Math.max(0, Math.min(100, Math.round(progress.percent)))
                : 0;
            // Only publish whole-percent movements: this fires per chunk and
            // every publish crosses the IPC boundary.
            if (state.state === 'downloading' && percent === state.percent) return;
            publish({ state: 'downloading', percent });
        });

        autoUpdater.on('update-downloaded', (info) => {
            log('INFO', `Update ${info && info.version} downloaded and staged.`);
            // Only now is installing on quit safe: the payload is on disk and
            // its checksum has already been verified against latest.yml.
            if (enabled) autoUpdater.autoInstallOnAppQuit = true;
            publish({
                state: 'downloaded',
                latestVersion: (info && info.version) || state.latestVersion,
                releaseNotes: toPlainText(info && info.releaseNotes) || state.releaseNotes,
                // The download event may carry less than the check did; keep the
                // link we already resolved rather than regressing to a guess.
                releaseUrl: (info && info.tag) ? releaseUrlFor(info) : state.releaseUrl,
                percent: 100,
                error: null,
            });
        });

        autoUpdater.on('error', (err) => {
            log('ERROR', 'Update failed:', err);
            publish({
                state: 'error',
                percent: 0,
                error: (err && err.message) || 'Update failed.',
            });
        });

        return autoUpdater;
    }

    /* --- Owner-controlled switch ----------------------------------------- */

    /**
     * Reads the switch the HTTP API writes to. Never throws: an unreadable
     * database must not take the desktop app down, and the safe fallback is
     * the documented default rather than silently opting the user out.
     */
    async function readPolicy() {
        try {
            const raw = await readSetting(CONFIG_KEY);
            if (raw === null || raw === undefined) return DEFAULT_ENABLED;

            let value = raw;
            // Stored as JSON by the server; tolerate a bare string either way.
            try { value = JSON.parse(raw); } catch { /* legacy plain value */ }
            return value !== false && value !== 'false' && value !== 0;
        } catch (err) {
            log('WARN', 'Could not read the auto-update setting; assuming enabled:', err);
            return DEFAULT_ENABLED;
        }
    }

    function scheduleChecks() {
        clearInterval(checkTimer);
        checkTimer = null;
        if (!enabled || !target.supported || destroyed) return;
        checkTimer = setInterval(() => { void check({ manual: false }); }, CHECK_INTERVAL_MS);
        // Electron's own event loop keeps the process alive; this timer should
        // never be the reason a quit hangs.
        if (typeof checkTimer.unref === 'function') checkTimer.unref();
    }

    /** Re-reads the switch and applies it to a session already in progress. */
    async function refreshPolicy() {
        const next = await readPolicy();
        const changed = next !== enabled;
        enabled = next;

        if (!enabled) {
            // A payload already on disk stays on disk, but it will not be
            // installed behind the user's back after they opted out.
            if (autoUpdater) autoUpdater.autoInstallOnAppQuit = false;
        } else if (autoUpdater && state.state === 'downloaded') {
            autoUpdater.autoInstallOnAppQuit = true;
        }

        scheduleChecks();
        publish({});

        if (changed) log('INFO', `Auto-update ${enabled ? 'enabled' : 'disabled'}.`);
        if (changed && enabled && state.state === 'idle') void check({ manual: false });
        return snapshot();
    }

    /* --- Actions ---------------------------------------------------------- */

    /**
     * @param {object} [options]
     * @param {boolean} [options.manual] Manual checks bypass the switch, because
     *   the user pressing "Check now" is itself the consent. They still never
     *   download automatically.
     */
    async function check({ manual = false } = {}) {
        if (destroyed) return snapshot();

        if (!target.supported) return snapshot();
        if (!enabled && !manual) return snapshot();

        const updater = getAutoUpdater();
        if (!updater) {
            publish({ state: 'error', error: 'The updater component is missing from this build.' });
            return snapshot();
        }

        // Collapse overlapping checks: the scheduled timer and a button press
        // can easily land together.
        if (inFlightCheck) {
            await inFlightCheck.catch(() => {});
            return snapshot();
        }

        inFlightCheck = updater.checkForUpdates();
        try {
            await inFlightCheck;
        } catch (err) {
            // The 'error' event already published the failure.
            log('WARN', 'Update check did not complete:', err);
        } finally {
            inFlightCheck = null;
        }
        return snapshot();
    }

    async function download() {
        const updater = getAutoUpdater();
        if (!updater || !target.supported) return snapshot();
        if (state.state === 'downloading' || state.state === 'downloaded') return snapshot();

        publish({ state: 'downloading', percent: 0, error: null });
        try {
            await updater.downloadUpdate();
        } catch (err) {
            log('WARN', 'Update download did not complete:', err);
        }
        return snapshot();
    }

    /**
     * Closes the server and the database first, then hands over to the
     * installer. NSIS waits for the old process, but the SQLite file and the
     * TCP port are ours to release cleanly — an installer-forced exit would
     * skip the graceful shutdown path entirely.
     */
    async function installNow() {
        const updater = getAutoUpdater();
        if (!updater || state.state !== 'downloaded') {
            return { ok: false, error: 'No update has been downloaded yet.' };
        }

        log('INFO', 'Installing update and restarting.');
        try {
            await beforeInstall();
        } catch (err) {
            log('ERROR', 'Pre-install shutdown failed; installing anyway:', err);
        }

        // isSilent=false so Windows shows the installer UI, isForceRunAfter=true
        // so the app comes back up on its own.
        setImmediate(() => {
            try {
                updater.quitAndInstall(false, true);
            } catch (err) {
                log('ERROR', 'quitAndInstall failed:', err);
                app.quit();
            }
        });
        return { ok: true };
    }

    /* --- Lifecycle -------------------------------------------------------- */

    async function start() {
        enabled = await readPolicy();

        if (!target.supported) {
            log('INFO', `Auto-update is not available for this build (${target.reason}).`);
            publish({});
            return;
        }

        // Warm the module now so a missing dependency surfaces in the log at
        // startup rather than six hours later.
        getAutoUpdater();
        publish({});

        scheduleChecks();
        if (!enabled) return;

        clearTimeout(firstCheckTimer);
        firstCheckTimer = setTimeout(() => { void check({ manual: false }); }, FIRST_CHECK_DELAY_MS);
        if (typeof firstCheckTimer.unref === 'function') firstCheckTimer.unref();
    }

    function destroy() {
        destroyed = true;
        clearInterval(checkTimer);
        clearTimeout(firstCheckTimer);
        checkTimer = null;
        firstCheckTimer = null;
    }

    return {
        start,
        destroy,
        check,
        download,
        installNow,
        refreshPolicy,
        getStatus: snapshot,
        isEnabled: () => enabled,
    };
}

module.exports = { createUpdater, RELEASES_URL, CONFIG_KEY };

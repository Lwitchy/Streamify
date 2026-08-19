/**
 * Streamify Desktop — Electron main process
 * =========================================
 *
 * Architecture
 * ------------
 * This is deliberately NOT a rewrite of the web app. Streamify's backend is
 * already a Node/Express process, and Electron's main process IS Node, so the
 * desktop app simply hosts the existing server in-process and points a window
 * at it:
 *
 *     main process ──> require('../Server/server') ──> Express on 127.0.0.1:PORT
 *          │
 *          └──> BrowserWindow ──> http://127.0.0.1:PORT
 *
 * The same server keeps listening on 0.0.0.0, so phones on the LAN reach the
 * identical instance. One process, one database, three front doors.
 *
 * Why the window loads over HTTP instead of file://
 * -------------------------------------------------
 * Loading from a real origin (rather than file://) means the service worker,
 * Cache Storage, IndexedDB and cookie auth all behave exactly as they do in a
 * browser. localhost is a privileged secure context, so the desktop app gets
 * the full PWA feature set with zero degradation.
 */

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, dialog, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

/* ------------------------------------------------------------------ *
 * Paths — must be established before ANY getPath('userData') read
 * ------------------------------------------------------------------ *
 * Electron derives userData from package.json's `name` ("streamify"), which
 * would give %APPDATA%\streamify. Pinning it explicitly keeps the data folder,
 * the log folder and the tray's "Open data folder" action all pointing at the
 * same, properly capitalised location.
 */
app.setPath('userData', path.join(app.getPath('appData'), 'Streamify'));

/* ------------------------------------------------------------------ *
 * Crash / startup logging
 * ------------------------------------------------------------------ *
 * Windows Electron apps are built for the GUI subsystem, so stdout goes
 * nowhere. Without a log file a failed launch is completely silent and
 * unreportable. Everything below is written to:
 *
 *   %APPDATA%\Streamify\logs\main.log
 */
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');
const OLD_LOG_FILE = LOG_FILE.replace(/\.log$/, '.old.log');
const MAX_LOG_SIZE = 2 * 1024 * 1024;

function formatLogPart(part) {
    if (part instanceof Error) return part.stack || part.message;
    if (part && typeof part === 'object') {
        try { return JSON.stringify(part); } catch { return String(part); }
    }
    return String(part);
}

function writeLog(level, ...parts) {
    const line = `[${new Date().toISOString()}] [${level}] ` +
        parts.map(formatLogPart).join(' ');
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        // Windows will not rename over an existing file, so remove the bounded
        // backup before every rotation.
        try {
            if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
                if (fs.existsSync(OLD_LOG_FILE)) fs.unlinkSync(OLD_LOG_FILE);
                fs.renameSync(LOG_FILE, OLD_LOG_FILE);
            }
        } catch { /* non-fatal */ }
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch { /* logging must never crash the app */ }
    console.log(line);
}

/* Chromium can silently fall back to software rendering when a graphics driver
 * is blocklisted. Electron documents GPU status as valid only after this event,
 * so record it once for diagnosing first-animation jank without changing any
 * acceleration flags or user settings. */
app.once('gpu-info-update', () => {
    try {
        writeLog('INFO', 'GPU feature status:', app.getGPUFeatureStatus());
    } catch (error) {
        writeLog('WARN', 'Could not read GPU feature status:', error);
    }
    app.getGPUInfo('basic')
        .then(info => writeLog('INFO', 'GPU basic info:', info))
        .catch(error => writeLog('WARN', 'Could not read GPU basic info:', error));
});

process.on('uncaughtException', (err) => {
    writeLog('FATAL', 'Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    writeLog('FATAL', 'Unhandled rejection:', reason);
});

writeLog('INFO', `Streamify starting (electron ${process.versions.electron}, node ${process.versions.node})`);

/* ------------------------------------------------------------------ *
 * Environment must be configured BEFORE the server module is required,
 * because Server/runtime.js reads these at module-load time.
 * ------------------------------------------------------------------ */

const REPO_ROOT = path.resolve(__dirname, '..');
const CONNECT_FILE = path.join(__dirname, 'connect.html');
const CONNECT_URL = pathToFileURL(CONNECT_FILE).href;
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const SHUTDOWN_TIMEOUT_MS = 15000;

// Packaged builds must never write into the installation directory: it may be
// read-only, and an update or uninstall would destroy the user's library.
// In development we point at the repo so the desktop app and `npm start` share
// one database.
if (app.isPackaged) {
    process.env.STREAMIFY_DATA_DIR = process.env.STREAMIFY_DATA_DIR || app.getPath('userData');
} else {
    process.env.STREAMIFY_DATA_DIR = process.env.STREAMIFY_DATA_DIR || REPO_ROOT;
}

/* ------------------------------------------------------------------ *
 * Single instance
 * ------------------------------------------------------------------ *
 * Two copies would race for the same SQLite files and the same TCP port.
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
}

let mainWindow = null;
let connectWindow = null;
let tray = null;
let serverInfo = null;
let serverModule = null;
let serverOrigin = null;
let updater = null;
let isQuitting = false;
let shutdownPromise = null;
let shutdownComplete = false;
let quitContinuationScheduled = false;

function parseUrl(value) {
    if (typeof value !== 'string') return null;
    try { return new URL(value); } catch { return null; }
}

function isTrustedServerUrl(value) {
    const parsed = parseUrl(value);
    return Boolean(
        parsed &&
        serverOrigin &&
        parsed.origin === serverOrigin &&
        parsed.username === '' &&
        parsed.password === ''
    );
}

function isTrustedServerCertificateUrl(value) {
    const parsed = parseUrl(value);
    if (!parsed) return false;
    // WebSocket TLS uses the same certificate and endpoint as the HTTPS app.
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    return isTrustedServerUrl(parsed.href);
}

function isConnectPageUrl(value) {
    const parsed = parseUrl(value);
    return Boolean(parsed && parsed.href === CONNECT_URL);
}

function normalizeExternalUrl(value) {
    const parsed = parseUrl(value);
    if (!parsed || !SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    return parsed.href;
}

function describeUrl(value) {
    const parsed = parseUrl(value);
    return parsed ? `${parsed.protocol}//${parsed.host}` : '<invalid URL>';
}

async function openExternalSafely(value, source) {
    const safeUrl = normalizeExternalUrl(value);
    if (!safeUrl) {
        writeLog('WARN', `Rejected unsafe external URL from ${source}:`, describeUrl(value));
        return false;
    }

    try {
        await shell.openExternal(safeUrl);
        return true;
    } catch (err) {
        writeLog('ERROR', `Failed to open external URL from ${source}:`, err);
        return false;
    }
}

function queueExternalOpen(value, source) {
    setImmediate(() => { void openExternalSafely(value, source); });
}

/* ------------------------------------------------------------------ *
 * Server lifecycle
 * ------------------------------------------------------------------ */

async function startServer() {
    const serverPath = path.join(REPO_ROOT, 'Server', 'server.js');
    writeLog('INFO', 'Loading server from', serverPath);
    writeLog('INFO', 'Data directory:', process.env.STREAMIFY_DATA_DIR);

    // Required lazily so the env vars above are already in place.
    serverModule = require(serverPath);
    serverInfo = await serverModule.start();

    const parsedServerUrl = parseUrl(serverInfo.url);
    if (
        !parsedServerUrl ||
        !SAFE_EXTERNAL_PROTOCOLS.has(parsedServerUrl.protocol) ||
        !LOOPBACK_HOSTNAMES.has(parsedServerUrl.hostname) ||
        parsedServerUrl.protocol !== (serverInfo.secure ? 'https:' : 'http:') ||
        parsedServerUrl.username !== '' ||
        parsedServerUrl.password !== ''
    ) {
        throw new Error('Server returned an invalid local URL.');
    }
    serverOrigin = parsedServerUrl.origin;

    serverModule.httpServer.on('error', (err) => {
        writeLog('ERROR', 'Server runtime error:', err);
    });
    serverModule.httpServer.once('close', () => {
        writeLog('INFO', 'Server transport closed.');
    });

    writeLog('INFO', `Server listening on ${serverInfo.url} (secure=${serverInfo.secure})`);
    return serverInfo;
}

function trackDatabaseShutdown() {
    try {
        const database = require(path.join(REPO_ROOT, 'Server', 'database.js'));
        if (!database || typeof database.close !== 'function') return null;

        const originalClose = database.close;
        let resolveClosed;
        let rejectClosed;
        const closed = new Promise((resolve, reject) => {
            resolveClosed = resolve;
            rejectClosed = reject;
        });
        // Keep a later close failure handled even if gracefulShutdown itself
        // throws before this promise can be awaited.
        void closed.catch(() => {});
        const trackedClose = function (...args) {
            let result;
            try {
                result = originalClose.apply(this, args);
            } catch (err) {
                rejectClosed(err);
                throw err;
            }
            Promise.resolve(result).then(resolveClosed, rejectClosed);
            return result;
        };
        database.close = trackedClose;

        return {
            closed,
            restore: () => {
                if (database.close === trackedClose) database.close = originalClose;
            },
        };
    } catch (err) {
        writeLog('WARN', 'Could not track database shutdown completion:', err);
        return null;
    }
}

async function waitForShutdown(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Server shutdown timed out.')), SHUTDOWN_TIMEOUT_MS);
    });
    try {
        await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function shutdownServer() {
    if (shutdownPromise) return shutdownPromise;

    const moduleToStop = serverModule;
    shutdownPromise = (async () => {
        // Drop the Discord card before anything else. It is synchronous and
        // instant, and a card left up after the app is gone is the one failure
        // users actually notice. Runs even when the server never started.
        try {
            if (discordPresence) discordPresence.destroy();
        } catch (err) {
            writeLog('WARN', 'Discord presence teardown failed:', err);
        }

        // Stop the update timers before the database closes: a scheduled check
        // would otherwise try to read the Owner switch out of a closed handle.
        try {
            if (updater) updater.destroy();
        } catch (err) {
            writeLog('WARN', 'Updater teardown failed:', err);
        }

        if (!moduleToStop) {
            writeLog('INFO', 'No server process needed shutdown.');
            return;
        }

        writeLog('INFO', 'Graceful server shutdown starting.');
        // Server.gracefulShutdown currently schedules its database close from
        // an HTTP callback. Track that close so Electron does not exit after
        // only the scheduling promise has resolved.
        const databaseShutdown = trackDatabaseShutdown();
        try {
            await moduleToStop.gracefulShutdown({ exit: false });
            if (databaseShutdown) await waitForShutdown(databaseShutdown.closed);
            writeLog('INFO', 'Graceful server shutdown completed.');
        } catch (err) {
            writeLog('ERROR', 'Graceful server shutdown failed:', err);
        } finally {
            if (databaseShutdown) databaseShutdown.restore();
        }
    })();

    return shutdownPromise;
}

function continueQuitAfterShutdown() {
    if (quitContinuationScheduled) return;
    quitContinuationScheduled = true;

    void shutdownServer().finally(() => {
        shutdownComplete = true;
        setImmediate(() => app.quit());
    });
}

function requestQuit() {
    isQuitting = true;
    app.quit();
}

/**
 * Graceful shutdown for the update path.
 *
 * quitAndInstall() spawns the installer and then calls app.quit() itself, so
 * the database and the listening socket must already be released by the time
 * it runs. Marking the shutdown complete also lets that app.quit() through the
 * before-quit guard below instead of being deferred a second time.
 */
async function shutdownForUpdate() {
    isQuitting = true;
    quitContinuationScheduled = true;
    try {
        await shutdownServer();
    } finally {
        shutdownComplete = true;
    }
}

function handleWindowsSessionEnd(win) {
    if (process.platform !== 'win32') return;

    win.on('query-session-end', (event) => {
        if (shutdownComplete) return;
        event.preventDefault();
        isQuitting = true;
        writeLog('INFO', 'Windows session end requested; shutting down cleanly.');
        continueQuitAfterShutdown();
    });

    win.on('session-end', () => {
        isQuitting = true;
        writeLog('WARN', 'Windows session ended before graceful quit completed.');
        void shutdownServer();
    });
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

function resolveIcon() {
    const candidates = [
        path.join(REPO_ROOT, 'build', 'icon.png'),
        path.join(REPO_ROOT, 'Static', 'icon-512.png'),
        path.join(REPO_ROOT, 'Static', 'icon-192.png'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

function attachWindowLifecycleLogging(win, label) {
    const contents = win.webContents;

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
            writeLog('ERROR', `${label} failed to load (${errorCode} ${errorDescription}):`, describeUrl(validatedURL));
        }
    });
    contents.on('render-process-gone', (_event, details) => {
        writeLog('ERROR', `${label} renderer process gone:`, details);
    });
    contents.on('will-prevent-unload', (event) => {
        if (isQuitting) event.preventDefault();
    });
    win.on('unresponsive', () => writeLog('WARN', `${label} became unresponsive.`));
    win.on('responsive', () => writeLog('INFO', `${label} became responsive again.`));
    handleWindowsSessionEnd(win);
}

function denyWebViews(contents, label) {
    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        writeLog('WARN', `Blocked unexpected webview creation in ${label}.`);
    });
}

function installMainWindowSecurity(win) {
    const contents = win.webContents;

    contents.setWindowOpenHandler(({ url }) => {
        if (
            isTrustedServerUrl(contents.getURL()) &&
            !isTrustedServerUrl(url) &&
            normalizeExternalUrl(url)
        ) {
            queueExternalOpen(url, 'main-window popup');
        }
        return { action: 'deny' };
    });

    const guardNavigation = (event) => {
        if (isTrustedServerUrl(event.url)) return;

        event.preventDefault();
        writeLog('WARN', 'Blocked untrusted renderer navigation to', describeUrl(event.url));
        if (
            event.isMainFrame &&
            isTrustedServerUrl(contents.getURL()) &&
            normalizeExternalUrl(event.url)
        ) {
            queueExternalOpen(event.url, 'main-window navigation');
        }
    };

    contents.on('will-frame-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('did-navigate', (_event, url) => {
        if (!url || url === 'about:blank' || isTrustedServerUrl(url)) return;
        writeLog('ERROR', 'Destroying main window after untrusted navigation committed:', describeUrl(url));
        if (!win.isDestroyed()) win.destroy();
    });
    denyWebViews(contents, 'main window');
}

function installLockedWindowSecurity(win, isAllowedUrl, label) {
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const guardNavigation = (event) => {
        if (event.isMainFrame && isAllowedUrl(event.url)) return;
        event.preventDefault();
        writeLog('WARN', `Blocked unexpected navigation in ${label} to`, describeUrl(event.url));
    };

    contents.on('will-frame-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    denyWebViews(contents, label);
}

async function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

    const icon = resolveIcon();

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 940,
        minHeight: 600,
        show: false,
        backgroundColor: '#121212', // matches theme-color, avoids a white flash
        title: 'Streamify',
        icon,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });
    mainWindow = win;

    win.once('ready-to-show', () => {
        if (!win.isDestroyed() && isTrustedServerUrl(win.webContents.getURL())) win.show();
    });
    installMainWindowSecurity(win);
    attachWindowLifecycleLogging(win, 'Main window');

    // Closing the window keeps playback alive in the tray, which is the
    // behaviour people expect from a music player.
    win.on('close', (event) => {
        if (!isQuitting && tray) {
            event.preventDefault();
            win.hide();
        }
    });

    win.on('closed', () => {
        if (mainWindow === win) mainWindow = null;
    });

    try {
        await win.loadURL(serverInfo.url);
        if (!isTrustedServerUrl(win.webContents.getURL())) {
            throw new Error('Main window committed an untrusted URL.');
        }
        writeLog('INFO', 'Main window loaded', describeUrl(win.webContents.getURL()));
        return win;
    } catch (err) {
        writeLog('ERROR', 'Main window load failed:', err);
        if (!win.isDestroyed()) win.destroy();
        if (mainWindow === win) mainWindow = null;
        throw err;
    }
}

async function showErrorWindow(message) {
    const html = `
        <!doctype html><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        <style>
            body { background:#121212; color:#e6e6e6; font:14px/1.6 -apple-system,Segoe UI,sans-serif;
                   margin:0; padding:32px; }
            h1 { color:#1db954; font-size:19px; margin:0 0 14px; }
            pre { background:#1c1c1c; border:1px solid #2c2c2c; border-radius:8px;
                  padding:14px; white-space:pre-wrap; word-break:break-word; color:#ff8080; }
            ul { padding-left:20px; color:#b3b3b3; }
        </style>
        <h1>Streamify could not start</h1>
        <pre>${String(message).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>
        <p>Common causes:</p>
        <ul>
            <li>Another copy of Streamify is already running.</li>
            <li>The port is in use by a different program.</li>
            <li>The music or database folder is not writable.</li>
        </ul>
        <p>Set a different port with the <code>PORT</code> environment variable.</p>
    `;
    const errorUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    const win = new BrowserWindow({
        width: 640,
        height: 420,
        title: 'Streamify — Startup Failed',
        backgroundColor: '#121212',
        icon: resolveIcon(),
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });

    installLockedWindowSecurity(win, url => url === errorUrl, 'error window');
    attachWindowLifecycleLogging(win, 'Error window');

    try {
        await win.loadURL(errorUrl);
        return win;
    } catch (err) {
        writeLog('ERROR', 'Startup error window failed to load:', err);
        if (!win.isDestroyed()) win.destroy();
        throw err;
    }
}

/** Small companion window showing LAN URLs plus a scannable QR code. */
async function createConnectWindow() {
    if (connectWindow && !connectWindow.isDestroyed()) {
        connectWindow.focus();
        return connectWindow;
    }

    const win = new BrowserWindow({
        width: 520,
        height: 680,
        resizable: false,
        title: 'Connect your phone',
        backgroundColor: '#121212',
        icon: resolveIcon(),
        autoHideMenuBar: true,
        parent: mainWindow || undefined,
        webPreferences: {
            preload: path.join(__dirname, 'connect-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });
    connectWindow = win;

    installLockedWindowSecurity(win, isConnectPageUrl, 'connect window');
    attachWindowLifecycleLogging(win, 'Connect window');
    win.on('closed', () => {
        if (connectWindow === win) connectWindow = null;
    });

    try {
        await win.loadFile(CONNECT_FILE);
        if (!isConnectPageUrl(win.webContents.getURL())) {
            throw new Error('Connect window committed an unexpected URL.');
        }
        return win;
    } catch (err) {
        writeLog('ERROR', 'Connect window load failed:', err);
        if (!win.isDestroyed()) win.destroy();
        if (connectWindow === win) connectWindow = null;
        throw err;
    }
}

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */

async function showErrorWindowSafely(error) {
    try {
        await showErrorWindow(error instanceof Error ? error.message : String(error));
    } catch (windowError) {
        writeLog('FATAL', 'Could not display startup failure:', windowError);
        requestQuit();
    }
}

async function openDataFolder() {
    try {
        const error = await shell.openPath(process.env.STREAMIFY_DATA_DIR);
        if (error) writeLog('ERROR', 'Could not open data folder:', error);
    } catch (err) {
        writeLog('ERROR', 'Could not open data folder:', err);
    }
}

function createTray() {
    const iconPath = resolveIcon();
    if (!iconPath) {
        writeLog('WARN', 'Tray icon was not found; close will quit instead of hiding.');
        return;
    }

    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
        writeLog('WARN', 'Tray icon could not be loaded; close will quit instead of hiding.');
        return;
    }
    image = image.resize({ width: 16, height: 16 });

    tray = new Tray(image);
    tray.setToolTip('Streamify');

    const rebuildMenu = () => {
        const menu = Menu.buildFromTemplate([
            {
                label: 'Open Streamify',
                click: () => {
                    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
                    else void createMainWindow().catch(showErrorWindowSafely);
                },
            },
            {
                label: 'Connect your phone…',
                click: () => {
                    void createConnectWindow().catch((err) => {
                        dialog.showErrorBox('Streamify', err.message || String(err));
                    });
                },
            },
            { type: 'separator' },
            {
                label: serverInfo ? `Running on port ${serverInfo.port}` : 'Starting…',
                enabled: false,
            },
            {
                label: serverInfo && serverInfo.secure ? 'HTTPS enabled' : 'HTTP (no offline on phones)',
                enabled: false,
            },
            { type: 'separator' },
            {
                label: 'Open data folder',
                click: () => { void openDataFolder(); },
            },
            { type: 'separator' },
            { label: 'Quit Streamify', click: requestQuit },
        ]);
        tray.setContextMenu(menu);
    };

    rebuildMenu();

    tray.on('double-click', () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else void createMainWindow().catch(showErrorWindowSafely);
    });
}

/* ------------------------------------------------------------------ *
 * IPC surface exposed to the renderer via preload.js
 * ------------------------------------------------------------------ */

function getTrustedIpcSender(event) {
    try {
        const frame = event.senderFrame;
        if (!frame || frame.parent !== null || event.sender.mainFrame !== frame) return null;

        if (
            mainWindow &&
            !mainWindow.isDestroyed() &&
            event.sender === mainWindow.webContents &&
            frame.origin === serverOrigin &&
            isTrustedServerUrl(frame.url)
        ) {
            return 'main';
        }

        if (
            connectWindow &&
            !connectWindow.isDestroyed() &&
            event.sender === connectWindow.webContents &&
            isConnectPageUrl(frame.url)
        ) {
            return 'connect';
        }
    } catch {
        return null;
    }

    return null;
}

function assertIpcSender(event, allowedSenders, channel) {
    const sender = getTrustedIpcSender(event);
    if (sender && allowedSenders.includes(sender)) return sender;

    let frameUrl = '<unavailable>';
    let frameOrigin = '<unavailable>';
    try {
        frameUrl = describeUrl(event.senderFrame && event.senderFrame.url);
        frameOrigin = event.senderFrame && event.senderFrame.origin;
    } catch { /* frame may have been destroyed */ }
    writeLog('WARN', `Blocked unauthorized ${channel} IPC from`, frameOrigin, frameUrl);
    throw new Error('Unauthorized IPC sender.');
}

ipcMain.handle('streamify:getConnectionInfo', async (event) => {
    const sender = assertIpcSender(event, ['main', 'connect'], 'getConnectionInfo');

    const RT = require(path.join(REPO_ROOT, 'Server', 'runtime.js'));
    const scheme = serverInfo && serverInfo.secure ? 'https' : 'http';
    const port = serverInfo ? serverInfo.port : RT.PORT;

    const addresses = RT.getLanAddresses().map(entry => ({
        ...entry,
        url: `${scheme}://${entry.address}:${port}`,
    }));

    let qr = null;
    if (addresses.length > 0) {
        try {
            const QRCode = require('qrcode');
            qr = await QRCode.toDataURL(addresses[0].url, {
                width: 260,
                margin: 1,
                color: { dark: '#000000', light: '#ffffff' },
            });
        } catch (err) {
            writeLog('ERROR', 'QR generation failed:', err);
        }
    }

    const result = {
        addresses,
        qr,
        secure: Boolean(serverInfo && serverInfo.secure),
        port,
        localUrl: `${scheme}://localhost:${port}`,
        dataDir: process.env.STREAMIFY_DATA_DIR,
        version: app.getVersion(),
    };

    const confirmedSender = assertIpcSender(event, ['main', 'connect'], 'getConnectionInfo');
    if (sender === 'connect' && confirmedSender === 'connect') {
        return { addresses, qr, secure: result.secure };
    }
    return result;
});

ipcMain.handle('streamify:openExternal', async (event, url) => {
    assertIpcSender(event, ['main'], 'openExternal');
    return openExternalSafely(url, 'renderer IPC');
});

/* ------------------------------------------------------------------ *
 * Discord Rich Presence
 * ------------------------------------------------------------------ *
 * The renderer owns playback state, so it drives presence; the main process
 * owns the pipe, because Discord's IPC needs Node and the renderer is
 * sandboxed. These three channels are the whole surface.
 *
 * Everything is opt-in: presence stays disabled until the renderer enables it
 * from the settings pane, and disabling clears the card immediately.
 */

/** Discord application id. Public by design - it is not a secret. */
const DISCORD_CLIENT_ID = '1538257130539323513';

let discordPresence = null;

function getDiscordPresence() {
    if (!discordPresence) {
        const { DiscordPresence } = require(path.join(__dirname, 'discord-presence.js'));
        discordPresence = new DiscordPresence({
            clientId: DISCORD_CLIENT_ID,
            log: (level, ...parts) => writeLog(level, ...parts),
        });
    }
    return discordPresence;
}

ipcMain.handle('streamify:discord:setActivity', async (event, activity) => {
    assertIpcSender(event, ['main'], 'discord:setActivity');

    const presence = getDiscordPresence();
    if (activity === null || activity === undefined) {
        presence.setActivity(null);
    } else {
        presence.enable();
        presence.setActivity(activity);
    }
    return presence.status();
});

ipcMain.handle('streamify:discord:setEnabled', async (event, enabled) => {
    assertIpcSender(event, ['main'], 'discord:setEnabled');

    const presence = getDiscordPresence();
    if (enabled === true) presence.enable();
    else presence.disable();
    return presence.status();
});

ipcMain.handle('streamify:discord:getStatus', async (event) => {
    assertIpcSender(event, ['main'], 'discord:getStatus');
    return getDiscordPresence().status();
});

/* ------------------------------------------------------------------ *
 * Auto-update
 * ------------------------------------------------------------------ *
 * electron/updater.js owns the electron-updater lifecycle. This section is
 * only the seam: it creates the updater once the server (and therefore the
 * database holding the Owner switch) is up, and forwards status to whichever
 * main window is currently loaded.
 *
 * Note what is NOT exposed: there is no channel that writes the switch. It is
 * server-wide Owner state, changed through POST /api/settings/updates, which
 * is role-checked. Anything reachable here is either a read or a local action
 * on this machine.
 */

function broadcastUpdateState(status) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!isTrustedServerUrl(mainWindow.webContents.getURL())) return;
    mainWindow.webContents.send('streamify:updates:state', status);
}

/**
 * Reads a system_config row directly. The server runs in this very process, so
 * an HTTP round trip to ourselves would only add a session we do not have.
 */
async function readServerSetting(key) {
    const database = require(path.join(REPO_ROOT, 'Server', 'database.js'));
    if (!database || typeof database.getSystemConfigValue !== 'function') return null;
    return database.getSystemConfigValue(key);
}

function getUpdater() {
    if (updater) return updater;

    const { createUpdater } = require(path.join(__dirname, 'updater.js'));
    updater = createUpdater({
        log: (level, ...parts) => writeLog(level, ...parts),
        broadcast: broadcastUpdateState,
        beforeInstall: shutdownForUpdate,
        readSetting: readServerSetting,
    });
    return updater;
}

ipcMain.handle('streamify:updates:getStatus', async (event) => {
    assertIpcSender(event, ['main'], 'updates:getStatus');
    return getUpdater().getStatus();
});

ipcMain.handle('streamify:updates:check', async (event) => {
    assertIpcSender(event, ['main'], 'updates:check');
    return getUpdater().check({ manual: true });
});

ipcMain.handle('streamify:updates:download', async (event) => {
    assertIpcSender(event, ['main'], 'updates:download');
    return getUpdater().download();
});

ipcMain.handle('streamify:updates:install', async (event) => {
    assertIpcSender(event, ['main'], 'updates:install');
    return getUpdater().installNow();
});

ipcMain.handle('streamify:updates:refreshPolicy', async (event) => {
    assertIpcSender(event, ['main'], 'updates:refreshPolicy');
    return getUpdater().refreshPolicy();
});

/**
 * Native folder picker.
 * The web OOBE wizard makes the user type an absolute path by hand; on desktop
 * we can do far better. The renderer feature-detects this and falls back to the
 * text input when running in a normal browser.
 */
ipcMain.handle('streamify:pickFolder', async (event, opts = {}) => {
    assertIpcSender(event, ['main'], 'pickFolder');

    const requestedTitle = opts && typeof opts.title === 'string'
        ? opts.title.replace(/[\0\r\n]/g, ' ').trim().slice(0, 200)
        : '';
    const target = mainWindow;
    let result;
    try {
        result = await dialog.showOpenDialog(target, {
            title: requestedTitle || 'Select your music folder',
            properties: ['openDirectory', 'createDirectory'],
        });
    } catch (err) {
        writeLog('ERROR', 'Folder picker failed:', err);
        throw err;
    }

    assertIpcSender(event, ['main'], 'pickFolder');
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

function isTrustedPermissionSource(webContents, requestingUrl, requestingOrigin, isMainFrame) {
    if (!webContents || !isMainFrame) return false;

    if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        webContents === mainWindow.webContents
    ) {
        return isTrustedServerUrl(webContents.getURL()) &&
            isTrustedServerUrl(requestingUrl) &&
            (!requestingOrigin || isTrustedServerUrl(requestingOrigin));
    }

    if (
        connectWindow &&
        !connectWindow.isDestroyed() &&
        webContents === connectWindow.webContents
    ) {
        return isConnectPageUrl(webContents.getURL()) && isConnectPageUrl(requestingUrl);
    }

    return false;
}

function configureSessionPermissions() {
    const defaultSession = session.defaultSession;

    defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        const allowed = permission === 'clipboard-sanitized-write' &&
            isTrustedPermissionSource(
                webContents,
                details && details.requestingUrl,
                requestingOrigin,
                details && details.isMainFrame
            );
        if (!allowed) writeLog('WARN', `Denied permission check: ${permission}`);
        return allowed;
    });

    defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const allowed = permission === 'clipboard-sanitized-write' &&
            isTrustedPermissionSource(
                webContents,
                details && details.requestingUrl,
                null,
                details && details.isMainFrame
            );
        if (!allowed) writeLog('WARN', `Denied permission request: ${permission}`);
        callback(allowed);
    });
}

/* ------------------------------------------------------------------ *
 * App lifecycle
 * ------------------------------------------------------------------ */

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    } else if (serverInfo && !isQuitting) {
        void createMainWindow().catch(showErrorWindowSafely);
    }
});

app.on('child-process-gone', (_event, details) => {
    writeLog('ERROR', 'Electron child process gone:', details);
});

/**
 * Accept our own self-signed certificate.
 *
 * `npm run gen-cert` produces a self-signed cert so that phones on the LAN get
 * a secure context. Electron would otherwise refuse to load it. We scope the
 * exception as tightly as possible: only our own loopback HTTPS/WSS endpoint
 * on our own port. Any other certificate error is still rejected.
 */
app.on('certificate-error', (event, webContents, url, error, _certificate, callback) => {
    if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        webContents === mainWindow.webContents &&
        isTrustedServerCertificateUrl(url)
    ) {
        event.preventDefault();
        writeLog('WARN', `Accepted local server certificate (${error}).`);
        callback(true);
        return;
    }

    writeLog('WARN', `Rejected certificate exception for ${describeUrl(url)} (${error}).`);
    callback(false);
});

app.whenReady().then(async () => {
    configureSessionPermissions();

    try {
        await startServer();
    } catch (err) {
        writeLog('ERROR', 'Server failed to start:', err);
        await showErrorWindowSafely(err);
        return;
    }

    try {
        createTray();
        if (!isQuitting) await createMainWindow();
    } catch (err) {
        writeLog('ERROR', 'Window/tray creation failed:', err);
        await showErrorWindowSafely(err);
    }

    // After the window, so the first check never competes with the first
    // paint, and after the server, so the Owner switch is readable.
    try {
        if (!isQuitting) await getUpdater().start();
    } catch (err) {
        // An updater that cannot start is an inconvenience, not a failure:
        // the app itself is already running fine.
        writeLog('ERROR', 'Auto-update could not start:', err);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && serverInfo && !isQuitting) {
            void createMainWindow().catch(showErrorWindowSafely);
        }
    });
}).catch((err) => {
    writeLog('FATAL', 'Electron readiness failed:', err);
    requestQuit();
});

// The tray keeps the app alive after the last window closes; quitting is
// explicit, via the tray menu or Cmd+Q on macOS.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) requestQuit();
});

app.on('before-quit', (event) => {
    isQuitting = true;
    if (shutdownComplete) return;

    event.preventDefault();
    continueQuitAfterShutdown();
});

app.on('will-quit', () => {
    writeLog('INFO', 'Electron will quit.');
});

app.on('quit', (_event, exitCode) => {
    writeLog('INFO', `Electron quit with exit code ${exitCode}.`);
});

/**
 * Streamify Desktop — server host
 * ===============================
 *
 * Runs the Express/Socket.IO server in its own process, launched by
 * electron/main.js through Electron's utilityProcess.fork().
 *
 * Why a separate process
 * ----------------------
 * The server used to be require()d straight into the Electron main process.
 * That process also pumps the native window messages, so any time the server
 * did blocking work (tagging a large file, copying a download across drives,
 * indexing, a busy SQLite burst) Windows saw the window stop answering and
 * marked it "Not Responding". Out here, the server can be as busy as it likes
 * and the window, tray and menus stay responsive.
 *
 * Protocol (process.parentPort messages, all plain objects)
 * ---------------------------------------------------------
 *   host -> main  { type: 'ready', info: { port, host, secure, url } }
 *   host -> main  { type: 'start-failed', error: { message, stack } }
 *   host -> main  { type: 'stopped', error?: string }
 *   host -> main  { type: 'reply', id, value?, error? }
 *   main -> host  { type: 'shutdown' }
 *   main -> host  { type: 'getSetting', id, key }
 *
 * `node Server/server.js` is unaffected; this file is only the desktop seam.
 */
'use strict';

const path = require('path');

const parentPort = process.parentPort;
if (!parentPort) {
    console.error('[HOST] server-host.js must be launched with utilityProcess.fork().');
    process.exit(1);
}

const SERVER_DIR = path.join(__dirname, '..', 'Server');

let serverModule = null;
let database = null;
let shuttingDown = false;

function send(message) {
    try {
        parentPort.postMessage(message);
    } catch (err) {
        console.error('[HOST] Could not message the main process:', err);
    }
}

function serializeError(err) {
    if (err instanceof Error) return { message: err.message, stack: err.stack };
    return { message: String(err), stack: null };
}

// Same policy the main process had: log, never crash the whole server for one
// stray callback. stderr is forwarded into main.log by electron/main.js.
process.on('uncaughtException', (err) => {
    console.error('[HOST] Uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[HOST] Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});

async function boot() {
    try {
        serverModule = require(path.join(SERVER_DIR, 'server.js'));
        database = require(path.join(SERVER_DIR, 'database.js'));

        const info = await serverModule.start();

        serverModule.httpServer.on('error', (err) => {
            console.error('[HOST] Server runtime error:', err && err.stack ? err.stack : err);
        });
        serverModule.httpServer.once('close', () => {
            console.log('[HOST] Server transport closed.');
        });

        send({
            type: 'ready',
            info: {
                port: info.port,
                host: info.host,
                secure: Boolean(info.secure),
                url: info.url,
            },
        });
    } catch (err) {
        console.error('[HOST] Server failed to start:', err && err.stack ? err.stack : err);
        send({ type: 'start-failed', error: serializeError(err) });
        // Give the message a moment to cross before the process goes away.
        setTimeout(() => process.exit(1), 100);
    }
}

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    let error = null;
    try {
        // gracefulShutdown resolves only after the HTTP server has closed and
        // the database handles are released.
        if (serverModule) await serverModule.gracefulShutdown({ exit: false });
    } catch (err) {
        error = err && err.message ? err.message : String(err);
        console.error('[HOST] Graceful shutdown failed:', err);
    }

    send(error ? { type: 'stopped', error } : { type: 'stopped' });
    setTimeout(() => process.exit(error ? 1 : 0), 50);
}

async function getSetting(id, key) {
    try {
        const value = database && typeof database.getSystemConfigValue === 'function'
            ? await database.getSystemConfigValue(key)
            : null;
        send({ type: 'reply', id, value: value === undefined ? null : value });
    } catch (err) {
        send({ type: 'reply', id, error: err && err.message ? err.message : String(err) });
    }
}

parentPort.on('message', (event) => {
    const message = event && event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'shutdown') {
        void shutdown();
    } else if (message.type === 'getSetting' && typeof message.key === 'string') {
        void getSetting(message.id, message.key);
    }
});

void boot();

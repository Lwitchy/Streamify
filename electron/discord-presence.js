/**
 * Streamify Desktop - Discord Rich Presence
 *
 * Speaks Discord's local RPC protocol directly, with no dependencies.
 *
 * The protocol is small enough that a library would cost more than it saves.
 * Discord exposes a local socket - a named pipe on Windows, a unix socket
 * everywhere else - and frames every message as:
 *
 *     [ 4 bytes opcode, little endian ][ 4 bytes payload length, LE ][ JSON ]
 *
 * We only ever send two opcodes: HANDSHAKE (0) once on connect, and FRAME (1)
 * carrying SET_ACTIVITY for every presence update.
 *
 * Design rules this module follows, in rough order of importance:
 *
 *   1. Never break the app. Discord not running is the normal case, not an
 *      error. Every failure path degrades to "no presence" silently.
 *   2. Never block. Nothing here is awaited by startup or shutdown.
 *   3. Respect the rate limit. Discord allows roughly 5 activity updates per
 *      20 seconds and starts dropping frames past that, so updates are
 *      coalesced behind a minimum interval with a trailing send.
 *   4. Trust nothing from the renderer. The payload crosses an IPC boundary,
 *      so it is re-validated here rather than assumed well-formed.
 */

'use strict';

const net = require('net');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

/* --- Protocol constants --------------------------------------------------- */

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const HEADER_BYTES = 8;

/** Discord refuses payloads far smaller than this; the cap is defensive. */
const MAX_FRAME_BYTES = 64 * 1024;

/* --- Tuning --------------------------------------------------------------- */

/**
 * Minimum gap between two SET_ACTIVITY frames.
 *
 * Discord's documented budget is ~5 updates per 20s. 4s sits exactly on that
 * line, which is fine because we are not trying to animate anything: the
 * progress bar is drawn by Discord from the timestamps we send, so a track
 * change and a pause are the only events that genuinely need to land.
 */
const MIN_UPDATE_INTERVAL_MS = 4000;

/** Backoff schedule for reconnecting. Discord may simply not be installed. */
const RECONNECT_DELAYS_MS = [5000, 15000, 30000, 60000];

/** Socket indexes Discord may listen on when several clients are installed. */
const MAX_SOCKET_INDEX = 10;

/* --- Field limits, as enforced by Discord --------------------------------- */

const MAX_TEXT = 128;
/** Discord rejects 1-character `details`/`state`, so short values get padded. */
const MIN_TEXT = 2;
const MAX_URL = 2048;

/* ------------------------------------------------------------------ *
 * Socket discovery
 * ------------------------------------------------------------------ */

/**
 * Candidate socket paths, in the order Discord itself probes them.
 *
 * Windows uses named pipes. Everywhere else Discord uses a unix socket in the
 * runtime dir, and the extra sub-paths cover Flatpak and Snap installs, which
 * sandbox the socket one level deeper.
 */
function socketCandidates(index) {
    if (process.platform === 'win32') {
        return [`\\\\?\\pipe\\discord-ipc-${index}`];
    }

    const base =
        process.env.XDG_RUNTIME_DIR ||
        process.env.TMPDIR ||
        process.env.TMP ||
        process.env.TEMP ||
        os.tmpdir();

    return [
        path.join(base, `discord-ipc-${index}`),
        path.join(base, 'app', 'com.discordapp.Discord', `discord-ipc-${index}`),
        path.join(base, 'snap.discord', `discord-ipc-${index}`),
        path.join(base, '.flatpak', 'dev.vencord.Vesktop', 'xdg-run', `discord-ipc-${index}`),
    ];
}

/**
 * Resolves to a connected socket, or null when Discord is not reachable.
 *
 * `override` exists so tests can point at a mock server. Discord itself always
 * holds index 0 on a machine where it is running, which would otherwise make
 * the rate-limiting and teardown paths untestable without publishing a real
 * presence to the developer's own profile.
 */
function findSocket(override) {
    return new Promise(resolve => {
        const paths = [];
        if (override) paths.push(override);
        else for (let index = 0; index < MAX_SOCKET_INDEX; index++) paths.push(...socketCandidates(index));

        let cursor = 0;

        const tryNext = () => {
            if (cursor >= paths.length) return resolve(null);
            const target = paths[cursor++];

            const socket = new net.Socket();
            /* A stale pipe can accept and then never answer. Do not wait on it. */
            const timer = setTimeout(() => {
                socket.destroy();
                tryNext();
            }, 1500);

            const fail = () => {
                clearTimeout(timer);
                socket.removeAllListeners();
                socket.destroy();
                tryNext();
            };

            socket.once('error', fail);
            socket.once('connect', () => {
                clearTimeout(timer);
                socket.removeListener('error', fail);
                resolve(socket);
            });

            try {
                socket.connect(target);
            } catch {
                fail();
            }
        };

        tryNext();
    });
}

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

function encodeFrame(opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
    frame.writeInt32LE(opcode, 0);
    frame.writeInt32LE(body.length, 4);
    body.copy(frame, HEADER_BYTES);
    return frame;
}

/**
 * Incremental frame reader.
 *
 * TCP and named pipes both deliver bytes, not messages, so a single 'data'
 * event may hold half a frame or three of them. Buffering here keeps the
 * connection logic free of partial-read handling.
 */
function createFrameReader(onFrame, onProtocolError) {
    let buffer = Buffer.alloc(0);

    return chunk => {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= HEADER_BYTES) {
            const opcode = buffer.readInt32LE(0);
            const length = buffer.readInt32LE(4);

            if (length < 0 || length > MAX_FRAME_BYTES) {
                onProtocolError(new Error(`Discord sent an implausible frame length (${length}).`));
                return;
            }
            if (buffer.length < HEADER_BYTES + length) return; // wait for the rest

            const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
            buffer = buffer.subarray(HEADER_BYTES + length);

            let payload = null;
            if (length > 0) {
                try {
                    payload = JSON.parse(body.toString('utf8'));
                } catch {
                    onProtocolError(new Error('Discord sent a frame that was not valid JSON.'));
                    return;
                }
            }

            onFrame(opcode, payload);
        }
    };
}

/* ------------------------------------------------------------------ *
 * Activity sanitising
 * ------------------------------------------------------------------ */

/** Trims to Discord's limit and pads values too short for it to accept. */
function clampText(value, { pad = false } = {}) {
    const text = String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
    if (!text) return null;
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}\u2026` : text;
    if (clipped.length >= MIN_TEXT) return clipped;
    return pad ? `${clipped}\u2007` : null; // figure space, invisible but counted
}

/**
 * Only absolute HTTPS URLs survive.
 *
 * Discord hands image URLs to its own media proxy, so an http:// or LAN
 * address produces an empty card rather than an error. Rejecting here means a
 * bad value shows the fallback logo instead of nothing.
 */
function clampImage(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL) return null;

    /* Bare asset keys refer to art uploaded in the Discord developer portal. */
    if (/^[a-z0-9_-]{2,32}$/u.test(value)) return value;

    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed.href;
    } catch {
        return null;
    }
}

function clampTimestamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Math.floor(number);
}

/**
 * Builds the activity object Discord expects, or null if there is nothing
 * worth showing. Everything here treats its input as hostile.
 */
function buildActivity(input) {
    if (!input || typeof input !== 'object') return null;

    const details = clampText(input.details, { pad: true });
    const state = clampText(input.state, { pad: true });
    if (!details && !state) return null;

    /* type 2 is "Listening", which renders as "Listening to <app name>" and
     * gives the track a progress bar instead of an elapsed timer. */
    const activity = { type: 2 };
    if (details) activity.details = details;
    if (state) activity.state = state;

    const large = clampImage(input.largeImage);
    const largeText = clampText(input.largeText, { pad: true });
    if (large || largeText) {
        activity.assets = {};
        if (large) activity.assets.large_image = large;
        if (largeText) activity.assets.large_text = largeText;
    }

    /* Both ends present makes Discord draw a live progress bar and count down
     * on its own, which is why we do not have to stream position updates. */
    const start = clampTimestamp(input.startTimestamp);
    const end = clampTimestamp(input.endTimestamp);
    if (start && end && end > start) {
        activity.timestamps = { start, end };
    } else if (start) {
        activity.timestamps = { start };
    }

    return activity;
}

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

class DiscordPresence extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.clientId  Discord application id.
     * @param {Function} [options.log]   (level, ...args) sink; defaults to silence.
     * @param {string} [options.socketPath] Test-only override; see findSocket.
     */
    constructor({ clientId, log, socketPath } = {}) {
        super();

        this.clientId = String(clientId || '');
        this.log = typeof log === 'function' ? log : () => {};
        this.socketPath = socketPath || null;

        this.socket = null;
        this.connected = false;     // handshake acknowledged
        this.connecting = false;
        this.destroyed = false;
        this.enabled = false;       // the user opted in

        this.user = null;           // the Discord account we are attached to
        this.lastError = null;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;

        /* Coalescing. pendingActivity is the newest desired state; undefined
         * means "nothing new to send". null is meaningful - it means clear. */
        this.currentActivity = null;
        this.pendingActivity = undefined;
        this.hasPending = false;
        this.lastSentAt = 0;
        this.flushTimer = null;
    }

    /* --- Public API ------------------------------------------------------- */

    /** Opts in and starts connecting. Safe to call repeatedly. */
    enable() {
        if (this.destroyed || !this.clientId) return;
        if (this.enabled) return;
        this.enabled = true;
        this.reconnectAttempt = 0;
        this.#connect();
    }

    /** Opts out, clears the card, and drops the connection. */
    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        this.#clearNow();
        /* Give the clear frame a moment to reach Discord before tearing the
         * socket down, otherwise the card lingers until Discord notices the
         * drop on its own. */
        setTimeout(() => {
            if (!this.enabled) this.#teardown();
        }, 250);
    }

    /**
     * Queues a presence update. Pass null to clear.
     * Returns immediately; delivery is best-effort and rate limited.
     */
    setActivity(input) {
        if (this.destroyed) return;

        const activity = input === null ? null : buildActivity(input);
        this.pendingActivity = activity;
        this.hasPending = true;
        this.#scheduleFlush();
    }

    /** A snapshot for the settings UI. */
    status() {
        return {
            enabled: this.enabled,
            connected: this.connected,
            connecting: this.connecting,
            configured: Boolean(this.clientId),
            user: this.user,
            error: this.lastError,
        };
    }

    /** Irreversible. Called on app quit. */
    destroy() {
        this.enabled = false;
        /* Clear before tearing down. Discord does drop the presence when the
         * socket closes, but not instantly, and a card advertising a track
         * from an app that is no longer running is the one failure users
         * actually report. */
        this.#clearNow();
        this.destroyed = true;
        this.#teardown();
        this.removeAllListeners();
    }

    /**
     * Sends a clear immediately, bypassing the rate limiter.
     *
     * Removing the card is worth spending a frame on out of turn: the paths
     * that call this (opting out, quitting) are about to close the socket, so
     * a queued update would simply never be delivered.
     */
    #clearNow() {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.pendingActivity = undefined;
        this.hasPending = false;
        this.currentActivity = null;

        if (!this.connected) return;
        this.lastSentAt = Date.now();
        this.#write(OP_FRAME, {
            cmd: 'SET_ACTIVITY',
            args: { pid: process.pid },
            nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        });
    }

    /* --- Connection ------------------------------------------------------- */

    async #connect() {
        if (this.destroyed || !this.enabled) return;
        if (this.connecting || this.connected) return;

        this.connecting = true;
        this.emit('status', this.status());

        let socket;
        try {
            socket = await findSocket(this.socketPath);
        } catch (error) {
            socket = null;
            this.log('WARN', 'Discord socket probe failed:', error.message);
        }

        /* The user may have opted out while we were probing. */
        if (this.destroyed || !this.enabled) {
            if (socket) socket.destroy();
            this.connecting = false;
            return;
        }

        if (!socket) {
            this.connecting = false;
            this.lastError = 'Discord is not running.';
            this.emit('status', this.status());
            this.#scheduleReconnect();
            return;
        }

        this.socket = socket;

        const handleFrame = (opcode, payload) => this.#handleFrame(opcode, payload);
        const handleProtocolError = error => {
            this.log('WARN', 'Discord RPC protocol error:', error.message);
            this.#handleDisconnect('Lost sync with Discord.');
        };

        socket.on('data', createFrameReader(handleFrame, handleProtocolError));
        socket.on('error', error => {
            this.log('WARN', 'Discord RPC socket error:', error.message);
            this.#handleDisconnect('Lost the connection to Discord.');
        });
        socket.on('close', () => this.#handleDisconnect('Discord closed the connection.'));

        this.#write(OP_HANDSHAKE, { v: 1, client_id: this.clientId });
    }

    #handleFrame(opcode, payload) {
        if (opcode === OP_PING) {
            this.#write(OP_PONG, payload);
            return;
        }
        if (opcode === OP_CLOSE) {
            const reason = payload && payload.message ? String(payload.message) : 'Discord closed the connection.';
            this.#handleDisconnect(reason);
            return;
        }
        if (opcode !== OP_FRAME || !payload) return;

        if (payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
            this.connecting = false;
            this.connected = true;
            this.lastError = null;
            this.reconnectAttempt = 0;

            const user = payload.data && payload.data.user;
            this.user = user ? (user.global_name || user.username || null) : null;

            this.log('INFO', `Discord Rich Presence connected${this.user ? ` as ${this.user}` : ''}.`);
            this.emit('status', this.status());

            /* Re-send whatever we last wanted shown. On a reconnect mid-track
             * this restores the card without waiting for the next song. */
            if (!this.hasPending && this.currentActivity) {
                this.pendingActivity = this.currentActivity;
                this.hasPending = true;
            }
            this.lastSentAt = 0;
            this.#scheduleFlush();
            return;
        }

        if (payload.evt === 'ERROR') {
            const message = payload.data && payload.data.message
                ? String(payload.data.message)
                : 'Discord rejected the request.';
            this.lastError = message;
            this.log('WARN', 'Discord RPC error:', message);
            this.emit('status', this.status());
        }
    }

    #handleDisconnect(reason) {
        const wasConnected = this.connected || this.connecting;

        this.connected = false;
        this.connecting = false;
        this.user = null;

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }

        clearTimeout(this.flushTimer);
        this.flushTimer = null;

        if (wasConnected) {
            this.lastError = reason;
            this.emit('status', this.status());
        }

        this.#scheduleReconnect();
    }

    #scheduleReconnect() {
        if (this.destroyed || !this.enabled) return;
        if (this.reconnectTimer) return;

        const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        this.reconnectAttempt++;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.#connect();
        }, delay);

        /* A pending reconnect must never hold the process open at quit. */
        if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
    }

    #teardown() {
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.flushTimer);
        this.reconnectTimer = null;
        this.flushTimer = null;

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }

        this.connected = false;
        this.connecting = false;
        this.user = null;
        this.currentActivity = null;
        this.pendingActivity = undefined;
        this.hasPending = false;

        this.emit('status', this.status());
    }

    /* --- Sending ---------------------------------------------------------- */

    #scheduleFlush() {
        if (!this.connected || !this.hasPending || this.flushTimer) return;

        const wait = Math.max(0, MIN_UPDATE_INTERVAL_MS - (Date.now() - this.lastSentAt));
        if (wait === 0) {
            this.#flush();
            return;
        }

        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.#flush();
        }, wait);
        if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
    }

    #flush() {
        if (!this.connected || !this.hasPending) return;

        const activity = this.pendingActivity;
        this.pendingActivity = undefined;
        this.hasPending = false;
        this.currentActivity = activity;
        this.lastSentAt = Date.now();

        this.#write(OP_FRAME, {
            cmd: 'SET_ACTIVITY',
            args: {
                pid: process.pid,
                /* Omitting `activity` entirely is how the protocol says
                 * "remove my presence"; sending null is not equivalent. */
                ...(activity ? { activity } : {}),
            },
            nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        });
    }

    #write(opcode, payload) {
        if (!this.socket || this.socket.destroyed) return;
        try {
            this.socket.write(encodeFrame(opcode, payload));
        } catch (error) {
            this.log('WARN', 'Discord RPC write failed:', error.message);
            this.#handleDisconnect('Could not write to Discord.');
        }
    }
}

module.exports = {
    DiscordPresence,
    /* Exported for tests; not part of the supported surface. */
    _test: { buildActivity, clampText, clampImage, encodeFrame, createFrameReader, socketCandidates },
};

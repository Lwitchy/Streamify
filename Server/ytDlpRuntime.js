/**
 * yt-dlp invocation helpers
 * =========================
 *
 * Everything both yt-dlp callers (`downloads.js` and `discordArtwork.js`) must
 * agree on: the environment handed to the process, and the options that make
 * YouTube extraction actually work.
 *
 * This lives in its own module because the JavaScript runtime below fails
 * SILENTLY when it is wrong, so a second hand-rolled copy in another file is a
 * bug waiting to be written. Verified against the bundled yt-dlp 2026.10.26:
 *
 *   node:<process.execPath>              -> "JS runtimes: node-24.20.0"
 *   electron.exe (ELECTRON_RUN_AS_NODE)  -> "JS runtimes: node-24.18.1"
 *   POSIX-style path (/c/Program Files)  -> "JS runtimes: none"   (no error!)
 */

/** Credentials that must never reach a child process. */
const SECRETS_TO_STRIP = ['SLSK_USER', 'SLSK_PASS', 'ACOUSTID_CLIENT_KEY', 'TURNSTILE_SECRET_KEY'];

/**
 * Environment for a yt-dlp child process: the parent environment minus secrets.
 *
 * In a packaged Electron build `process.execPath` is electron.exe, so
 * ELECTRON_RUN_AS_NODE is what makes it usable as a JavaScript runtime for
 * signature challenges.
 */
function ytDlpEnv() {
    const env = { ...process.env };
    for (const key of SECRETS_TO_STRIP) delete env[key];
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
}

/**
 * JavaScript runtime for YouTube's signature challenges.
 *
 * Not optional in practice: yt-dlp enables ONLY `deno` by default, and with no
 * runtime available it omits the `web` and `tv_samsung` clients entirely,
 * leaving a single-client path that YouTube's anti-bot systems flag quickly.
 *
 * The path must be in the platform's native form. A forward-slash path on
 * Windows is reported as "unavailable" with NO error, which is why this is
 * normalised here rather than at each call site.
 */
function resolveJsRuntime() {
    const executable = process.execPath;
    if (!executable) return null;
    const nativePath = process.platform === 'win32' ? executable.replace(/\//g, '\\') : executable;
    return `node:${nativePath}`;
}

/**
 * Options every yt-dlp invocation must carry.
 *
 * KEY ORDER IS LOAD-BEARING. `--no-js-runtimes` CLEARS all runtimes, including
 * any supplied earlier, so `jsRuntimes` has to come after it. dargs preserves
 * object insertion order, so this function's return value must be spread
 * FIRST and never rebuilt in a different order.
 */
function ytDlpBaseOptions() {
    const options = { noJsRuntimes: true };
    const runtime = resolveJsRuntime();
    if (runtime) options.jsRuntimes = runtime;
    return options;
}

/* ------------------------------------------------------------------ *
 * Global pacing gate
 * ------------------------------------------------------------------ */

/**
 * yt-dlp invocations allowed at once, and the floor between their start times.
 *
 * Both are deliberately conservative, and both exist because YouTube rate-limits
 * per IP rather than per request: searches, metadata lookups, artwork matching
 * and downloads all spend the same allowance, so a burst anywhere is a burst
 * everywhere. Letting the download pool's four workers hit YouTube together — or
 * letting a Discord artwork lookup run alongside a search — converts a
 * parallel-acquisition feature straight into the blocking the cooldown exists
 * to avoid.
 *
 * The gate is process-wide, not per-caller, so every yt-dlp invocation in the
 * server serialises here regardless of which module starts it.
 */
const YOUTUBE_MAX_CONCURRENT = 1;
const YOUTUBE_MIN_REQUEST_INTERVAL_MS = 2500;

let youtubeInFlight = 0;
let lastYoutubeRequestAt = 0;

function delay(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * Waits for permission to start a yt-dlp request, then returns a release
 * function. Callers MUST release in a `finally`, or the gate wedges shut.
 *
 * Polls rather than queueing resolvers so a cancel can abandon the wait
 * immediately instead of holding a worker slot until its turn arrives.
 */
async function acquireYtDlpSlot(shouldCancel) {
    for (;;) {
        if (typeof shouldCancel === 'function' && shouldCancel()) throw new Error('Cancelled.');
        if (youtubeInFlight < YOUTUBE_MAX_CONCURRENT) {
            const since = Date.now() - lastYoutubeRequestAt;
            if (since >= YOUTUBE_MIN_REQUEST_INTERVAL_MS) {
                youtubeInFlight += 1;
                lastYoutubeRequestAt = Date.now();
                return () => { youtubeInFlight = Math.max(0, youtubeInFlight - 1); };
            }
            await delay(Math.min(YOUTUBE_MIN_REQUEST_INTERVAL_MS - since, 500));
            continue;
        }
        await delay(250);
    }
}

/**
 * Runs `task` under the gate, releasing the slot even if it throws.
 *
 * The preferred entry point: every call site that forgets to release wedges
 * yt-dlp permanently, so the pairing is done here rather than left to callers.
 */
async function withYtDlpSlot(task, shouldCancel) {
    const release = await acquireYtDlpSlot(shouldCancel);
    try {
        return await task();
    } finally {
        release();
    }
}

module.exports = {
    ytDlpEnv,
    ytDlpBaseOptions,
    resolveJsRuntime,
    withYtDlpSlot,
    acquireYtDlpSlot,
    SECRETS_TO_STRIP
};

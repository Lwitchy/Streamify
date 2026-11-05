/**
 * Streamify Download Engine
 * =========================
 *
 * Acquires music from Soulseek (P2P) and YouTube, and files it into the
 * Owner's real music folder so the normal library scanner picks it up.
 *
 * Design rules that shaped this module:
 *
 * 1. Downloads land in `<first configured music directory>/Streamify Downloads`.
 *    Nothing is written to MusicLibrary/uploads any more: the app indexes real
 *    folders now, so a download has to become a real file in a real folder or it
 *    does not exist as far as the rest of the app is concerned.
 *
 * 2. Artwork is embedded into the file, not stored beside it. The folder scanner
 *    already extracts embedded pictures (server.js saveEmbeddedPicture), so an
 *    embedded cover needs zero special-casing and survives the user moving,
 *    renaming or backing up the file.
 *
 * 3. The queue is persisted in SQLite. A Spotify album is 15 network
 *    transfers; a restart in the middle must resume, not lose them.
 *    `claimNextDownload`'s atomic queued->running update is what lets several
 *    workers share the queue without double-claiming a row.
 *
 * 4. A small pool of transfers, not one. A 30-track playlist is 30 sequential
 *    peers; Soulseek paces per uploader, so running transfers from DIFFERENT
 *    peers in parallel costs nothing and removes the queue-position wait that
 *    dominated wall-clock time. Two rules keep that from becoming abuse:
 *    never two transfers from the same peer at once, and never re-select a
 *    peer we just abandoned mid-transfer. Both are enforced by the peer
 *    registry below rather than by serialising everything.
 *
 * 5. Nothing here trusts a remote URL. Artwork is fetched only from an explicit
 *    host allowlist, with redirect, size and content-type limits.
 *
 * 6. A refused source is a routing problem, not a failed download. YouTube
 *    rate-limits per IP, so a block trips a cooldown and the work moves to
 *    Soulseek; retrying into a block is what turns a soft limit into a hard
 *    one. No single source being unavailable should stop a playlist.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const NodeID3 = require('node-id3');
const slsk = require('slsk-client');

const RT = require('./runtime');
const HandleDatabase = require('./database');

const ytDlpFactory = require('yt-dlp-exec');
const ffmpegPath = RT.unpackPath(require('@ffmpeg-installer/ffmpeg').path);
const ytDlpPath = RT.unpackPath(require('yt-dlp-exec/src/constants').YOUTUBE_DL_PATH);
const ytDlp = ytDlpFactory.create(ytDlpPath);

// Shared with discordArtwork.js so the yt-dlp runtime cannot drift between them.
const { ytDlpEnv, ytDlpBaseOptions, withYtDlpSlot } = require('./ytDlpRuntime');

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const DOWNLOAD_FOLDER_NAME = 'Streamify Downloads';

const SOULSEEK_INTERACTIVE_SEARCH_MS = 9000;
const SOULSEEK_AUTO_SEARCH_MS = 14000;
const SOULSEEK_DOWNLOAD_TIMEOUT_MS = 210000;
const SOULSEEK_CONNECT_TIMEOUT_MS = 20000;

const YOUTUBE_SEARCH_TIMEOUT_MS = 20000;
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 300000;
const YOUTUBE_MAX_ATTEMPTS = 3;
const YOUTUBE_MAX_DURATION_SECONDS = 15 * 60;
const YOUTUBE_SEARCH_RESULTS = 8;

/**
 * How long YouTube is left alone after it tells us to go away.
 *
 * The point of the cooldown is that a block is not a per-track failure but a
 * per-IP one, so the correct response is to stop asking rather than to retry
 * harder. Retrying while blocked is what escalates a soft rate-limit into a
 * longer one.
 */
const YOUTUBE_BLOCK_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Errors that mean "YouTube is refusing this client/IP", as opposed to "this
 * particular video is unusable". Matched case-insensitively against yt-dlp's
 * message; kept deliberately broad on the HTTP statuses and specific on the
 * sentinel strings, since a false positive only costs us a fallback to
 * Soulseek, while a false negative costs us an escalation.
 */
const YOUTUBE_BLOCK_PATTERNS = [
    /sign in to confirm/i,
    /not a bot/i,
    // yt-dlp emits a typographic apostrophe, so the patterns below must accept
    // U+2019 as well as ASCII ' — matching only the ASCII form silently never
    // fires on real yt-dlp output.
    /confirm you[‘’']?re not a bot/i,
    /http error 40[23]\b/i,
    /http error 429\b/i,
    /too many requests/i,
    // Covers both yt-dlp's message ("Login required") and the raw reason
    // string the API returns ("LOGIN_REQUIRED").
    /login[ _]required/i,
    /this content isn[‘’']?t available/i,
    /requested format is not available/i,
    /unable to extract/i,
    /failed to extract any player response/i,
    /player response/i,
    /nsig extraction failed/i,
    /unable to download (?:webpage|video data|api page)/i
];

const SPOTIFY_OEMBED_TIMEOUT_MS = 8000;

const REQUESTED_SOURCES = new Set(['auto', 'soulseek', 'youtube']);

/**
 * How a download should weigh quality against size.
 *
 *   `lossless` — prefer FLAC/WAV and treat low-bitrate MP3 as a last resort.
 *   `best`     — the default. Picks the best available but is happy with a
 *                good MP3, which matters because FLAC of a track often exists
 *                on one peer with a long queue while a 320 MP3 is free now.
 *
 * The distinction only changes RANKING, never filtering: a `lossless` request
 * still downloads an MP3 rather than failing, because a playable file beats no
 * file. It is a preference the user expresses, not a guarantee we can make —
 * we do not control what strangers share.
 */
const QUALITY_PREFERENCES = new Set(['best', 'lossless']);

/** How much a format choice changes a Soulseek candidate's rank. */
const QUALITY_SCORES = {
    // `lossless` treats an MP3 as a fallback: FLAC is far ahead, and a low
    // bitrate rip is pushed below most other candidates.
    lossless: { flac: 400, wav: 380, mp320: -100, mp256: -180, mp192: -260, mpLow: -400 },
    // `best` still ranks FLAC first — it IS the best available — but keeps a
    // good MP3 competitive, because a free 320 beats a FLAC behind a long queue.
    best: { flac: 200, wav: 180, mp320: 150, mp256: 110, mp192: 60, mpLow: -150 }
};

/**
 * Maps a candidate to its quality tier, so scoring never has to reason about
 * raw bitrate numbers again. Note the boundaries are inclusive at the top and
 * a 128 kbps file lands in `mpLow` — an earlier version used `< 128`, which
 * let exactly 128 escape the low-quality penalty entirely.
 */
function qualityTierFor(candidate) {
    if (candidate.extension === '.flac') return 'flac';
    if (candidate.extension === '.wav') return 'wav';

    const bitrate = Number(candidate.bitrate) || 0;
    if (bitrate >= 320) return 'mp320';
    if (bitrate >= 256) return 'mp256';
    if (bitrate >= 192) return 'mp192';
    if (bitrate > 0) return 'mpLow';
    // No advertised bitrate and not lossless: treat as unknown-mid rather than
    // punishing a peer that simply did not report one.
    return 'mp256';
}

/**
 * Transfers allowed to run at once across distinct peers.
 *
 * Four is chosen to be obviously polite: it is well under what a desktop
 * Soulseek client opens, and it still turns a 30-track playlist from 30
 * sequential waits into roughly eight rounds. Raising it is a one-line change,
 * but the per-peer rule below matters far more than this number does.
 */
const MAX_PARALLEL_TRANSFERS = 4;

/**
 * How long a peer stays reserved after we abandon a transfer.
 *
 * slsk-client gives us no way to close the underlying socket (see
 * soulseekDownload), so a cancelled transfer keeps draining in the background
 * until the peer finishes or drops us. Releasing the peer immediately would let
 * another worker open a SECOND connection to a peer still serving the first —
 * exactly the behaviour the per-peer rule exists to prevent. Holding the claim
 * for a bounded window keeps that promise without needing an abort we do not have.
 */
const ABANDONED_PEER_HOLD_MS = 60 * 1000;
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
const ARTWORK_REDIRECT_LIMIT = 3;
const ARTWORK_TIMEOUT_MS = 15000;
const PROGRESS_EMIT_INTERVAL_MS = 700;

/**
 * MUST stay a subset of `supportedMusicExtensions` in server.js. A container the
 * folder scanner cannot discover would be indexed once on download and then
 * flagged 'missing' by the very next library scan, so .opus and .aac are
 * deliberately excluded here.
 */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.wav', '.webm']);

/**
 * Artwork is fetched only from hosts that actually serve cover art for the
 * sources we support. An arbitrary attacker-supplied URL must never turn the
 * server into a request proxy.
 */
const ARTWORK_HOST_ALLOWLIST = new Set([
    'i.scdn.co',
    'mosaic.scdn.co',
    'lineup-images.scdn.co',
    'image-cdn-ak.spotifycdn.com',
    'image-cdn-fa.spotifycdn.com',
    'thisis-images.scdn.co',
    'is1-ssl.mzstatic.com',
    'is2-ssl.mzstatic.com',
    'is3-ssl.mzstatic.com',
    'is4-ssl.mzstatic.com',
    'is5-ssl.mzstatic.com',
    'is.gd.co',
    'i.ytimg.com',
    'i1.ytimg.com',
    'i2.ytimg.com',
    'i3.ytimg.com',
    'i4.ytimg.com',
    'i9.ytimg.com',
    'img.youtube.com',
    'yt3.ggpht.com'
]);

/**
 * True when a URL points at one of the artwork hosts above.
 *
 * These URLs outlive the Spotify-assisted download: they are recorded on the
 * song as `cover_source_url` so Discord can link the real cover.
 */
function isTrustedArtworkUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 2048) return false;
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
        return ARTWORK_HOST_ALLOWLIST.has(parsed.hostname.toLowerCase());
    } catch {
        return false;
    }
}

const ARTWORK_MIME_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
};

/* ------------------------------------------------------------------ *
 * Injected dependencies
 * ------------------------------------------------------------------ */

let deps = null;

/** Wires the engine to the server. Must run before any other export. */
function init(dependencies) {
    deps = dependencies;
    return module.exports;
}

function requireDeps() {
    if (!deps) throw new Error('Download engine used before init().');
    return deps;
}

const log = (...args) => console.log('[DOWNLOADS]', ...args);
const logError = (...args) => console.error('[DOWNLOADS]', ...args);

/* ------------------------------------------------------------------ *
 * Paths and filenames
 * ------------------------------------------------------------------ */

/**
 * Strips everything Windows, macOS and Linux disagree about, then clamps the
 * length so `Artist - Title.mp3` cannot blow past MAX_PATH on Windows.
 */
function sanitizeFilenameComponent(value, maxLength = 80) {
    const cleaned = String(value ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .replace(/[.\s]+$/, '');
    return cleaned.slice(0, maxLength).trim();
}

/** Windows refuses these names regardless of extension. */
const RESERVED_WINDOWS_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

function buildBaseFileName(artist, title) {
    const safeArtist = sanitizeFilenameComponent(artist, 60);
    const safeTitle = sanitizeFilenameComponent(title, 90);
    let base = safeArtist && safeTitle ? `${safeArtist} - ${safeTitle}` : (safeTitle || safeArtist);
    if (!base) base = 'Unknown Track';
    if (RESERVED_WINDOWS_NAMES.has(base.toUpperCase())) base = `_${base}`;
    return base;
}

/**
 * Downloads always go to the FIRST configured music directory, which is the one
 * the user picked during setup. Using anything else would scatter downloads
 * across roots depending on config ordering.
 */
function resolveDownloadRoot({ create = true } = {}) {
    const directories = requireDeps().getMusicDirectories();
    if (!Array.isArray(directories) || directories.length === 0) {
        throw new Error('No music directory is configured. Add one in Settings before downloading.');
    }

    const root = path.join(path.resolve(directories[0]), DOWNLOAD_FOLDER_NAME);
    if (create) fs.mkdirSync(root, { recursive: true });
    return root;
}

/** Appends " (2)", " (3)"... rather than silently overwriting an existing track. */
function uniqueDestination(root, base, extension) {
    let candidate = path.join(root, `${base}${extension}`);
    let counter = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(root, `${base} (${counter})${extension}`);
        counter += 1;
        if (counter > 999) throw new Error('Too many duplicate filenames for this track.');
    }
    return candidate;
}

/**
 * rename() fails with EXDEV when the temp folder and the music folder are on
 * different drives, which is the common case on Windows (app on C:, music on D:).
 *
 * Fully async: a cross-drive copy of a large lossless file used to block the
 * whole server (and, on desktop, the window) for as long as the copy took.
 */
async function moveFile(source, destination) {
    try {
        await fs.promises.rename(source, destination);
        return;
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
    }

    // Copy to a temporary name first, then rename into place. A crash midway
    // through a plain copy would otherwise leave a truncated file sitting in
    // the music folder for the scanner to index as a real track.
    const staging = `${destination}.part`;
    try {
        await fs.promises.copyFile(source, staging);
        await fs.promises.rename(staging, destination);
        await fs.promises.unlink(source);
    } catch (error) {
        try { await fs.promises.rm(staging, { force: true }); } catch { /* best effort */ }
        throw error;
    }
}

function createTempDirectory() {
    const directory = path.join(RT.paths.temp, `dl-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function removeDirectory(directory) {
    try {
        fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
        logError(`Could not clean temp directory ${directory}:`, error.message);
    }
}

/* ------------------------------------------------------------------ *
 * Soulseek credentials and connection
 * ------------------------------------------------------------------ */

const SOULSEEK_USER_KEY = 'soulseek_username';
const SOULSEEK_PASS_KEY = 'soulseek_password';

let soulseekClient = null;
let soulseekConnecting = null;
let soulseekLastError = null;
let soulseekConnectedAs = null;

function parseStoredValue(value) {
    if (value === null || value === undefined) return null;
    try { return JSON.parse(value); } catch { return value; }
}

/** Environment variables win, so a deployment can pin credentials outside the DB. */
async function readSoulseekCredentials() {
    const envUser = (process.env.SLSK_USER || '').trim();
    const envPass = process.env.SLSK_PASS || '';
    if (envUser && envPass) {
        return { username: envUser, password: envPass, fromEnvironment: true };
    }

    const storedUser = parseStoredValue(await HandleDatabase.getSystemConfigValue(SOULSEEK_USER_KEY));
    const storedPass = parseStoredValue(await HandleDatabase.getSystemConfigValue(SOULSEEK_PASS_KEY));
    const username = typeof storedUser === 'string' ? storedUser.trim() : '';
    const password = typeof storedPass === 'string' ? storedPass : '';

    if (!username || !password) return null;
    return { username, password, fromEnvironment: false };
}

function validSoulseekUsername(value) {
    return typeof value === 'string' &&
        value.trim().length >= 1 &&
        value.trim().length <= 64 &&
        !/[\u0000-\u001F\u007F]/.test(value);
}

async function saveSoulseekCredentials({ username, password }) {
    const trimmedUser = String(username || '').trim();
    if (!validSoulseekUsername(trimmedUser)) {
        throw Object.assign(new Error('Enter a Soulseek username of 1-64 characters.'), { statusCode: 400 });
    }
    if (typeof password !== 'string' || password.length < 1 || password.length > 128) {
        throw Object.assign(new Error('Enter a Soulseek password of 1-128 characters.'), { statusCode: 400 });
    }

    await HandleDatabase.updateSystemConfig(SOULSEEK_USER_KEY, JSON.stringify(trimmedUser));
    await HandleDatabase.updateSystemConfig(SOULSEEK_PASS_KEY, JSON.stringify(password));
    disconnectSoulseek();
    return { username: trimmedUser };
}

async function clearSoulseekCredentials() {
    await HandleDatabase.deleteSystemConfig(SOULSEEK_USER_KEY);
    await HandleDatabase.deleteSystemConfig(SOULSEEK_PASS_KEY);
    disconnectSoulseek();
}

function disconnectSoulseek() {
    if (soulseekClient) {
        try { soulseekClient.destroy(); } catch { /* already gone */ }
    }
    soulseekClient = null;
    soulseekConnecting = null;
    soulseekConnectedAs = null;
}

/**
 * slsk-client's connect() unconditionally does mkdirSync('/tmp/slsk') without
 * `recursive`, which throws ENOENT on a Windows machine that has no C:\tmp.
 * Creating the path up front is the least invasive way around it.
 */
function ensureSoulseekTempDirectory() {
    try {
        fs.mkdirSync(path.resolve('/tmp/slsk'), { recursive: true });
    } catch (error) {
        logError('Could not pre-create the Soulseek temp directory:', error.message);
    }
}

async function getSoulseekClient() {
    if (soulseekClient) return soulseekClient;
    if (soulseekConnecting) return soulseekConnecting;

    const credentials = await readSoulseekCredentials();
    if (!credentials) {
        soulseekLastError = 'Soulseek is not configured.';
        return null;
    }

    soulseekConnecting = new Promise(resolve => {
        ensureSoulseekTempDirectory();
        log(`Connecting to the Soulseek network as "${credentials.username}"...`);

        let settled = false;
        const finish = (client, error) => {
            if (settled) {
                // The connect timeout already fired and we moved on. A client
                // arriving late still owns a live TCP socket and an inbound
                // listener, so it must be torn down rather than dropped.
                if (client) {
                    try { client.destroy(); } catch { /* already gone */ }
                }
                return;
            }
            settled = true;
            soulseekConnecting = null;
            soulseekClient = client;
            soulseekConnectedAs = client ? credentials.username : null;
            soulseekLastError = error || null;
            if (error) logError('Soulseek connection failed:', error);
            else log('Soulseek connected.');
            resolve(client);
        };

        const timeout = setTimeout(
            () => finish(null, 'Connection timed out. Check the credentials and your network.'),
            SOULSEEK_CONNECT_TIMEOUT_MS
        );

        try {
            slsk.connect({ user: credentials.username, pass: credentials.password }, (error, client) => {
                clearTimeout(timeout);
                if (error || !client) {
                    return finish(null, error ? (error.message || String(error)) : 'Unknown connection error.');
                }
                finish(client, null);
            });
        } catch (error) {
            clearTimeout(timeout);
            finish(null, error.message || String(error));
        }
    });

    return soulseekConnecting;
}

async function soulseekStatus() {
    const credentials = await readSoulseekCredentials();
    return {
        configured: Boolean(credentials),
        username: credentials ? credentials.username : null,
        fromEnvironment: credentials ? credentials.fromEnvironment : false,
        connected: Boolean(soulseekClient),
        connectedAs: soulseekConnectedAs,
        error: soulseekClient ? null : soulseekLastError
    };
}

async function testSoulseekConnection() {
    disconnectSoulseek();
    soulseekLastError = null;
    const client = await getSoulseekClient();
    return {
        ok: Boolean(client),
        error: client ? null : (soulseekLastError || 'Could not connect to Soulseek.')
    };
}



/* ------------------------------------------------------------------ *
 * Soulseek search
 * ------------------------------------------------------------------ */

function normalizeForMatch(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Peers advertise their own speed and bitrate, so scores are heuristics rather
 * than guarantees. Ordering: can it start now, does the filename match, is the
 * quality sane, is the peer fast.
 *
 * `quality` is the caller's stated preference (see QUALITY_PREFERENCES); it
 * reweights the format/bitrate terms only.
 */
function scoreSoulseekCandidate(candidate, queryTokens, quality = 'best') {
    let score = 0;

    if (candidate.slots) score += 500;
    if (candidate.queueLength === 0) score += 100;
    else if (Number.isFinite(candidate.queueLength)) score -= Math.min(candidate.queueLength * 5, 200);

    const haystack = normalizeForMatch(candidate.filename);
    const matched = queryTokens.filter(token => haystack.includes(token)).length;
    score += queryTokens.length > 0 ? (matched / queryTokens.length) * 400 : 0;

    const weights = QUALITY_SCORES[quality] || QUALITY_SCORES.best;
    const tier = qualityTierFor(candidate);
    score += weights[tier] !== undefined ? weights[tier] : 0;

    // A lossless container keeps a small unconditional bump, since the tier
    // weights above already encode the user's preference and this is only the
    // "lossless is strictly better than lossy" half of it.
    if (tier === 'flac' || tier === 'wav') score += 60;

    score += Math.min((Number(candidate.speed) || 0) / 51200, 120);

    // Live/karaoke/instrumental versions are rarely what a plain query wants.
    if (/\b(karaoke|instrumental|ringtone|8d audio|nightcore)\b/.test(haystack)) score -= 250;

    const sizeBytes = Number(candidate.sizeBytes) || 0;
    if (sizeBytes > 0 && sizeBytes < 500 * 1024) score -= 300;

    return score;
}

function normalizeSoulseekResult(raw, query) {
    const remotePath = String(raw.file || '');
    const filename = remotePath.split(/[\\/]/).pop() || remotePath;
    const extension = path.extname(filename).toLowerCase();

    return {
        source: 'soulseek',
        user: raw.user,
        remotePath,
        filename,
        extension,
        sizeBytes: Number(raw.size) || 0,
        bitrate: Number(raw.bitrate) || null,
        speed: Number(raw.speed) || 0,
        slots: Boolean(raw.slots),
        queueLength: Number.isFinite(raw.inQueue) ? Number(raw.inQueue) : null,
        query
    };
}

/**
 * Soulseek never signals "search finished" - slsk-client just collects results
 * until its timeout expires and then fires the callback once.
 */
async function soulseekSearch(query, { timeout = SOULSEEK_INTERACTIVE_SEARCH_MS, limit = 60, quality = 'best' } = {}) {
    const client = await getSoulseekClient();
    if (!client) return { available: false, results: [], error: soulseekLastError };

    const raw = await new Promise(resolve => {
        let settled = false;
        const guard = setTimeout(() => {
            if (!settled) { settled = true; resolve([]); }
        }, timeout + 5000);

        try {
            client.search({ req: query, timeout }, (error, results) => {
                clearTimeout(guard);
                if (settled) return;
                settled = true;
                if (error) {
                    logError('Soulseek search error:', error.message || error);
                    return resolve([]);
                }
                resolve(Array.isArray(results) ? results : []);
            });
        } catch (error) {
            clearTimeout(guard);
            logError('Soulseek search threw:', error.message || error);
            if (!settled) { settled = true; resolve([]); }
        }
    });

    const queryTokens = normalizeForMatch(query).split(' ').filter(Boolean);
    const seen = new Set();
    const results = raw
        .filter(entry => entry && entry.file)
        .map(entry => normalizeSoulseekResult(entry, query))
        .filter(entry => AUDIO_EXTENSIONS.has(entry.extension))
        .filter(entry => {
            const key = `${entry.user}:${entry.remotePath}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map(entry => ({ ...entry, score: scoreSoulseekCandidate(entry, queryTokens, quality) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return { available: true, results, error: null };
}

/**
 * Peers are only reachable while slsk-client still holds the connection opened
 * during a search. A queued item may run minutes later, so re-run the search and
 * match the same user+path before giving up.
 */
async function refreshSoulseekCandidate(candidate) {
    const query = candidate.query || candidate.filename;
    const { results } = await soulseekSearch(query, { timeout: SOULSEEK_AUTO_SEARCH_MS, limit: 60 });

    const exact = results.find(entry => entry.user === candidate.user && entry.remotePath === candidate.remotePath);
    if (exact) return exact;

    const sameFile = results.find(entry => entry.filename === candidate.filename);
    return sameFile || results[0] || null;
}

/**
 * Transfers one file from a peer.
 *
 * No byte-level progress is reported, and that is a limitation of slsk-client
 * rather than an oversight: download-peer-file.js accumulates the whole
 * transfer in a memory Buffer and calls fs.writeFile exactly once, on socket
 * close. The destination therefore does not exist until the transfer is already
 * finished, so polling its size can only ever report 0. The UI shows an
 * indeterminate bar for this stage instead of inventing a percentage.
 *
 * A truncated transfer reaches the callback looking like a success (the partial
 * buffer is written), so the result is size-checked against what the peer
 * advertised before it is accepted.
 */
function soulseekDownload(client, candidate, destination, reportProgress, { shouldCancel } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            clearInterval(cancelPoller);
            clearTimeout(hardTimeout);
        };

        const fail = message => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(message));
        };

        // Cancellation is cooperative: slsk-client exposes no per-transfer
        // abort, so the promise rejects and the orphaned socket is left to the
        // hard timeout. Nothing downstream touches the temp file after this.
        const cancelPoller = setInterval(() => {
            if (!settled && typeof shouldCancel === 'function' && shouldCancel()) {
                fail('Cancelled.');
            }
        }, 500);

        const hardTimeout = setTimeout(
            () => fail('Soulseek transfer timed out.'),
            SOULSEEK_DOWNLOAD_TIMEOUT_MS
        );

        const file = {
            user: candidate.user,
            file: candidate.remotePath,
            size: candidate.sizeBytes,
            slots: candidate.slots,
            bitrate: candidate.bitrate,
            speed: candidate.speed
        };

        try {
            client.downloadStream({ file }, (error, stream) => {
                if (error) {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    return reject(new Error(error.message || String(error)));
                }

                const advertised = Number(candidate.sizeBytes) || 0;
                let received = 0;
                const startTime = Date.now();
                let lastReportTime = startTime;

                const fileStream = fs.createWriteStream(destination);
                stream.on('data', chunk => {
                    received += chunk.length;
                    const now = Date.now();
                    
                    if (typeof reportProgress === 'function' && advertised > 0) {
                        // Report progress if we hit a chunk boundary or every 500ms
                        if (received === advertised || now - lastReportTime > 500) {
                            lastReportTime = now;
                            const elapsedSec = (now - startTime) / 1000;
                            let etaSeconds = null;
                            if (elapsedSec > 1 && received > 0) {
                                const bytesPerSec = received / elapsedSec;
                                const remainingBytes = advertised - received;
                                etaSeconds = remainingBytes / bytesPerSec;
                            }
                            reportProgress({ 
                                transferred: received, 
                                progress: received / advertised,
                                etaSeconds
                            });
                        }
                    }
                });

                stream.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    if (settled) return;
                    settled = true;
                    cleanup();

                    if (received === 0) return reject(new Error('The peer returned an empty file.'));

                    if (advertised > 0 && received < advertised * 0.98) {
                        return reject(new Error(
                            `The transfer was cut short (${Math.round(received / 1024)} KB of ${Math.round(advertised / 1024)} KB).`
                        ));
                    }

                    resolve({ filePath: destination, bitrate: candidate.bitrate });
                });

                fileStream.on('error', err => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new Error(`File write error: ${err.message}`));
                });
            });
        } catch (error) {
            cleanup();
            if (!settled) {
                settled = true;
                reject(new Error(error.message || String(error)));
            }
        }
    });
}


/* ------------------------------------------------------------------ *
 * YouTube audio download (via native local yt-dlp)
 * ------------------------------------------------------------------ */

const YOUTUBE_URL_PATTERN = /^https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:youtube\.com\/(?:watch|shorts|playlist|live|embed)|youtu\.be\/)/i;

function extractYoutubeVideoId(url) {
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (parsed.hostname.toLowerCase().endsWith('youtu.be')) {
            const id = parsed.pathname.slice(1).split('/')[0];
            return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
        if (parsed.searchParams.has('v')) {
            const id = parsed.searchParams.get('v');
            return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
        }
        const match = parsed.pathname.match(/\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})/i);
        return match ? match[1] : null;
    } catch {
        const match = url.match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([a-zA-Z0-9_-]{11})/i);
        return match ? match[1] : null;
    }
}

function canonicalYoutubeUrl(url) {
    const videoId = extractYoutubeVideoId(url);
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : (typeof url === 'string' ? url.trim() : url);
}

function cleanYoutubeTitle(value) {
    return String(value || '')
        .replace(/\s*[[(][^\])]*?(?:official|music\s+video|video\s+clip|lyrics?|audio|visuali[sz]er|remaster|hd|\d+k|mv)[^\])]*?[)\]]\s*/giu, ' ')
        .replace(/\s{2,}/gu, ' ')
        .trim();
}

function splitYoutubeTitle(rawTitle, uploader) {
    const cleaned = cleanYoutubeTitle(rawTitle);
    const separator = cleaned.match(/^(.{1,100}?)\s+[-\u2013\u2014]\s+(.{1,180})$/u);
    if (separator) return { artist: separator[1].trim(), title: separator[2].trim() };
    const cleanedUploader = String(uploader || '').replace(/\s*-\s*Topic$/iu, '').replace(/VEVO$/iu, '').trim();
    return {
        artist: cleanedUploader || null,
        title: cleaned || 'Unknown Title'
    };
}

function isYoutubeUrl(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (Boolean(extractYoutubeVideoId(trimmed))) return true;
    return /^(https?:\/\/)?([a-zA-Z0-9-]+\.)?(youtube\.com|youtu\.be)\//i.test(trimmed);
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function youtubeWebpageUrl(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.webpage_url && isYoutubeUrl(entry.webpage_url) && extractYoutubeVideoId(entry.webpage_url)) {
        return canonicalYoutubeUrl(entry.webpage_url);
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(String(entry.id || ''))
        ? `https://www.youtube.com/watch?v=${entry.id}`
        : null;
}

function normalizeYoutubeResult(entry) {
    const url = youtubeWebpageUrl(entry);
    if (!url) return null;

    const id = extractYoutubeVideoId(url);
    const duration = Number(entry.duration) || null;
    const metadata = entry.track && entry.artist
        ? { artist: cleanYoutubeTitle(entry.artist), title: cleanYoutubeTitle(entry.track) }
        : splitYoutubeTitle(entry.title, entry.artist || entry.uploader || entry.channel);
    const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
    const thumbnail = entry.thumbnail || (thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : null);

    return {
        id: `youtube:${id}`,
        source: 'youtube',
        title: metadata.title || 'Unknown Title',
        artist: metadata.artist || null,
        user: entry.uploader || entry.channel || 'YouTube',
        extension: 'MP3',
        bitrate: 320,
        duration,
        thumbnail: thumbnail || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
        payload: { url }
    };
}

/* ------------------------------------------------------------------ *
 * YouTube circuit breaker
 * ------------------------------------------------------------------ */

/** Epoch ms until which YouTube is skipped. 0 means "not blocked". */
let youtubeBlockedUntil = 0;
let youtubeBlockReason = null;

/** True when a yt-dlp failure looks like an IP/client-level refusal. */
function isYoutubeBlockError(error) {
    const message = String((error && (error.message || error.shortMessage)) || error || '');
    if (!message) return false;
    return YOUTUBE_BLOCK_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Records a block and opens the cooldown. Deliberately NOT persisted: a restart
 * is exactly when a second opinion is worth having, and the failure mode of a
 * stale on-disk cooldown (skipping a source that has recovered) is worse than
 * one extra probe.
 */
function tripYoutubeBreaker(error) {
    const message = String((error && (error.message || error.shortMessage)) || error || '').slice(0, 300);
    const wasBlocked = youtubeBlockedUntil > Date.now();
    youtubeBlockedUntil = Date.now() + YOUTUBE_BLOCK_COOLDOWN_MS;
    youtubeBlockReason = message || 'YouTube refused the request.';

    if (!wasBlocked) {
        const minutes = Math.round(YOUTUBE_BLOCK_COOLDOWN_MS / 60000);
        logError(`YouTube is rate-limiting this connection; pausing YouTube for ${minutes} minutes. Reason: ${youtubeBlockReason}`);
        emit('downloads:source-blocked', {
            source: 'youtube',
            retryAt: youtubeBlockedUntil,
            reason: youtubeBlockReason
        });
    }
}

/** Clears the cooldown after a success, so recovery needs no restart. */
function resetYoutubeBreaker() {
    if (youtubeBlockedUntil === 0) return;
    log('YouTube is responding again; resuming YouTube downloads.');
    youtubeBlockedUntil = 0;
    youtubeBlockReason = null;
    emit('downloads:source-available', { source: 'youtube' });
}

/** True when YouTube should be skipped in favour of another source. */
function isYoutubeBlocked() {
    return youtubeBlockedUntil > Date.now();
}

function youtubeBreakerStatus() {
    const blocked = isYoutubeBlocked();
    return {
        blocked,
        retryAt: blocked ? new Date(youtubeBlockedUntil).toISOString() : null,
        reason: blocked ? youtubeBlockReason : null
    };
}

/**
 * Metadata is read before downloading, but a cancelled search must not leave
 * yt-dlp running for the rest of its timeout.
 *
 * `flat` selects the cheap extraction path. A `ytsearch` resolves each result
 * fully by default, which for 3 results measured ~767 KB of JSON and over 20
 * seconds — longer than YOUTUBE_SEARCH_TIMEOUT_MS, so searches were timing out
 * with zero results and no block to blame. Flat mode returns the fields the
 * scorer actually reads (id, title, duration, uploader/channel) in ~3 seconds.
 * Thumbnails fall back to the `i.ytimg.com` URL the video id already implies.
 *
 * Only safe for SEARCH: a single-video lookup still needs the full extraction,
 * because that is what fills in the audio formats used for the download.
 */
async function youtubeMetadata(target, { shouldCancel, timeout = YOUTUBE_SEARCH_TIMEOUT_MS, flat = false } = {}) {
    // Paced here rather than at each caller: this is the single funnel for every
    // search and metadata lookup, including the ones behind `ytsearch`.
    return withYtDlpSlot(() => runYoutubeMetadata(target, { shouldCancel, timeout, flat }), shouldCancel);
}

function runYoutubeMetadata(target, { shouldCancel, timeout, flat = false }) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = ytDlp.exec(target, {
                ...ytDlpBaseOptions(),
                dumpSingleJson: true,
                noWarnings: true,
                noPlaylist: true,
                skipDownload: true,
                ...(flat ? { flatPlaylist: true } : {})
            }, { env: ytDlpEnv(), timeout });
        } catch (error) {
            reject(error);
            return;
        }

        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearInterval(cancelPoller);
            if (error && child) {
                try { child.kill('SIGTERM', { forceKillAfterTimeout: 2000 }); } catch { /* already gone */ }
            }
            if (error) reject(error);
            else resolve(result);
        };
        const cancelPoller = setInterval(() => {
            if (typeof shouldCancel === 'function' && shouldCancel()) finish(new Error('Cancelled.'));
        }, 200);
        child.then(result => {
            try { finish(null, JSON.parse(result.stdout)); }
            catch (error) { finish(error); }
        }, finish);
    });
}

function scoreYoutubeResult(result, query, expectedDuration) {
    const haystack = normalizeForMatch(`${result.artist || ''} ${result.title} ${result.user}`);
    const tokens = normalizeForMatch(query).split(' ').filter(token => token && token !== 'audio');
    const matched = tokens.filter(token => haystack.includes(token)).length;
    let score = tokens.length > 0 ? (matched / tokens.length) * 150 : 0;
    if (/\b(official|topic)\b/.test(normalizeForMatch(result.user))) score += 30;
    if (/\b(karaoke|ringtone|8d audio|nightcore)\b/.test(haystack)) score -= 180;

    if (expectedDuration && result.duration) {
        const difference = Math.abs(expectedDuration - result.duration);
        score += Math.max(0, 80 - difference * 3);
        if (difference > 60) score -= 150;
    }
    return score;
}

function youtubeQuery(item) {
    const base = buildSearchQuery(item);
    return `${base} audio`;
}

async function youtubeSearch(query, { limit = 5, shouldCancel, expectedDuration } = {}) {
    // A search costs the same request budget as a download, so it is gated by
    // the same breaker. Without this, `auto` mode would keep probing.
    if (isYoutubeBlocked()) {
        throw new Error('YouTube is paused after rate-limiting this connection.');
    }

    let info;
    try {
        // flat: true — a search only needs id/title/duration/uploader to rank
        // candidates; the chosen one is fully extracted at download time.
        info = await youtubeMetadata(`ytsearch${YOUTUBE_SEARCH_RESULTS}:${query}`, {
            shouldCancel,
            flat: true
        });
    } catch (error) {
        if (isYoutubeBlockError(error)) tripYoutubeBreaker(error);
        throw error;
    }
    resetYoutubeBreaker();
    const entries = info && Array.isArray(info.entries) ? info.entries : (info ? [info] : []);
    const seen = new Set();
    return entries
        .map(normalizeYoutubeResult)
        .filter(Boolean)
        .filter(entry => !entry.duration || entry.duration <= YOUTUBE_MAX_DURATION_SECONDS)
        .filter(entry => {
            if (seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
        })
        .map(entry => ({ ...entry, score: scoreYoutubeResult(entry, query, expectedDuration) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

async function youtubeDownload(sourceUrl, destination, reportProgress, { shouldCancel } = {}) {
    // Never spawn yt-dlp while the breaker is open. The point is to stop making
    // requests, so the check has to happen before the process exists.
    if (isYoutubeBlocked()) {
        throw new Error(`YouTube is paused after rate-limiting this connection until ${new Date(youtubeBlockedUntil).toLocaleTimeString()}.`);
    }

    await reportProgress({ stage: 'connecting', resolved_source: 'youtube' });

    return new Promise((resolve, reject) => {
        let settled = false;
        let activeChild = null;

        const cleanup = () => {
            clearInterval(cancelPoller);
        };

        const fail = message => {
            if (settled) return;
            settled = true;
            cleanup();
            if (activeChild) {
                try { activeChild.kill('SIGTERM', { forceKillAfterTimeout: 2000 }); } catch {}
            }
            reject(new Error(message));
        };

        const cancelPoller = setInterval(() => {
            if (!settled && typeof shouldCancel === 'function' && shouldCancel()) {
                fail('Cancelled.');
            }
        }, 500);

        const targetUrl = canonicalYoutubeUrl(sourceUrl);
        const outTemplate = destination.replace(/\.[^.]+$/, '') + '.%(ext)s';

        // Metadata is NOT fetched with --print in the same run: --print implies
        // --quiet in yt-dlp, which suppresses the [download] lines the progress
        // parser below needs. The search/resolve step already captured real
        // metadata, so this run only downloads and reports progress.
        const args = {
            ...ytDlpBaseOptions(),
            ffmpegLocation: ffmpegPath,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            output: outTemplate,
            noWarnings: true,
            noPlaylist: true,
            noSimulate: true
        };

        try {
            const child = ytDlp.exec(targetUrl, args, { env: ytDlpEnv(), timeout: YOUTUBE_DOWNLOAD_TIMEOUT_MS });
            activeChild = child;

            let totalBytes = 0;
            let transferred = 0;
            // yt-dlp prints many progress lines a second; each report is a DB
            // write plus a socket push, so keep it to a couple per second.
            let lastProgressReport = 0;

            if (child.stdout) {
                child.stdout.on('data', chunk => {
                    // yt-dlp rewrites one progress line with \r, so a single
                    // chunk can carry a whole burst of updates. Parse every
                    // line and let reportProgress's DB throttle smooth them.
                    const lines = chunk.toString().split(/[\r\n]+/);
                    for (const line of lines) {
                        const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+(?:~?\s*([\d.]+)\s*(KiB|MiB|GiB|B))?(?:\s+at\s+([\d.]+)\s*(KiB|MiB|GiB|B)\/s)?(?:\s+ETA\s+(\d+:\d+))?/i);
                        if (!progressMatch) continue;
                        const pct = parseFloat(progressMatch[1]) / 100;
                        const progressNow = Date.now();
                        if (pct < 1 && progressNow - lastProgressReport < 500) continue;
                        lastProgressReport = progressNow;
                        if (progressMatch[2] && progressMatch[3]) {
                            const val = parseFloat(progressMatch[2]);
                            const unit = progressMatch[3].toUpperCase();
                            let mult = 1;
                            if (unit === 'KIB') mult = 1024;
                            else if (unit === 'MIB') mult = 1024 * 1024;
                            else if (unit === 'GIB') mult = 1024 * 1024 * 1024;
                            totalBytes = Math.round(val * mult);
                            transferred = Math.round(totalBytes * pct);
                        }
                        let etaSeconds = null;
                        if (progressMatch[5]) {
                            const parts = progressMatch[5].split(':').map(Number);
                            if (parts.length === 2) etaSeconds = parts[0] * 60 + parts[1];
                            else if (parts.length === 3) etaSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
                        }
                        reportProgress({
                            stage: 'downloading',
                            resolved_source: 'youtube',
                            progress: pct,
                            transferred,
                            total_bytes: totalBytes,
                            etaSeconds
                        });
                    }
                });
            }

            child.then(async () => {
                if (settled) return;
                settled = true;
                cleanup();

                let finalFilePath = destination;
                if (!fs.existsSync(destination)) {
                    const dir = path.dirname(destination);
                    const base = path.basename(destination, path.extname(destination));
                    const files = fs.readdirSync(dir);
                    const found = files.find(f => f.startsWith(base) && AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
                    if (found) {
                        finalFilePath = path.join(dir, found);
                    } else {
                        return reject(new Error('Audio file was not produced by yt-dlp.'));
                    }
                }

                // The search/resolve step already captured real metadata; this
                // is only a safety net for direct URL downloads. Read it from
                // the produced file; anything missing stays null and the queue
                // row's own title/artist win.
                let downloadedMetadata = null;
                try {
                    const tags = await NodeID3.Promise.read(finalFilePath);
                    if (tags && (tags.title || tags.artist)) {
                        const videoId = extractYoutubeVideoId(targetUrl);
                        downloadedMetadata = {
                            title: tags.title || null,
                            artist: tags.artist || null,
                            uploader: tags.artist || null,
                            thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null
                        };
                    }
                } catch { /* tags are optional */ }

                resetYoutubeBreaker();
                resolve({ filePath: finalFilePath, source: 'youtube', bitrate: 320, metadata: downloadedMetadata });
            }).catch(err => {
                if (settled) return;
                settled = true;
                cleanup();
                const message = err.shortMessage || err.message || String(err);
                if (isYoutubeBlockError(message)) tripYoutubeBreaker(message);
                reject(new Error(message));
            });
        } catch (err) {
            cleanup();
            reject(err);
        }
    });
}
/* ------------------------------------------------------------------ *
 * Spotify tracklist resolution
 * ------------------------------------------------------------------ */

const SPOTIFY_URL_PATTERN = /^https?:\/\/(?:open\.)?spotify\.com\//i;

function isSpotifyUrl(value) {
    return SPOTIFY_URL_PATTERN.test(String(value || '').trim());
}

/* ------------------------------------------------------------------ *
 * Spotify resolution
 * ------------------------------------------------------------------ */

/**
 * Spotify is a tracklist source only - no audio is ever taken from Spotify.
 * Each resolved track is queued and acquired automatically from the available sources.
 */
/**
 * Reads an album's real title and cover from Spotify's public oEmbed endpoint.
 *
 * This exists because `spotify-url-info`'s getTracks() does NOT return the album
 * at all — its objects carry only {artist, duration, name, previewUrl, uri}. So
 * every imported track used to queue with `album: null`, and because applyTags
 * uses NodeID3.update (which PRESERVES existing tags), each Soulseek peer's own
 * album tag survived untouched. One album import therefore produced as many
 * "albums" in the library as there were distinct peers: a compilation name here,
 * "Midnights (The Til Dawn edition)" there, "Unknown Album" for peers with no
 * tag. oEmbed returns exactly the two fields needed, with no auth.
 *
 * Never throws: a failed lookup leaves the album null, which is the old
 * behaviour and is recoverable, whereas failing the whole import is not.
 */
async function fetchSpotifyAlbumMetadata(url) {
    try {
        const parsed = new URL(url);
        // Only albums have a single canonical title. A playlist link has its own
        // name, and a track link has none — using either as the album would be
        // worse than leaving it empty.
        if (!/\/album\//i.test(parsed.pathname)) return null;

        const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
        const response = await fetch(endpoint, {
            signal: AbortSignal.timeout(SPOTIFY_OEMBED_TIMEOUT_MS),
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) {
            log(`Spotify oEmbed returned ${response.status}; importing without album metadata.`);
            return null;
        }

        const data = await response.json();
        const title = typeof data?.title === 'string' ? data.title.trim() : '';
        const cover = typeof data?.thumbnail_url === 'string' ? data.thumbnail_url.trim() : '';
        if (!title && !cover) return null;

        return {
            album: title || null,
            // Allowlisted like every other artwork URL, so a surprising host is
            // dropped here rather than silently becoming a fetch target later.
            artworkUrl: isTrustedArtworkUrl(cover) ? cover : null
        };
    } catch (error) {
        log(`Spotify oEmbed lookup failed (${error.name === 'TimeoutError' ? 'timeout' : error.message}); importing without album metadata.`);
        return null;
    }
}

/**
 * Normalised "artist title" key used to spot tracks already in the library.
 *
 * Deliberately generous: stripping parentheticals means "Anti-Hero" matches
 * "Anti-Hero (feat. X)", because the goal is to warn about a re-download, not
 * to make a precise identity claim. A false positive only pre-unticks a
 * checkbox the user can re-tick; a false negative silently re-downloads.
 */
function libraryMatchKey(artist, title) {
    const clean = value => normalizeForMatch(String(value || '')
        .replace(/\((?:feat|ft|with)[^)]*\)/gi, ' ')
        .replace(/\[[^\]]*\]/g, ' '));
    const normalizedTitle = clean(title);
    if (!normalizedTitle) return null;
    return `${clean(artist)}|${normalizedTitle}`;
}

/**
 * Marks which of the resolved tracks are already in the library.
 *
 * Never throws and never blocks an import: if the library cannot be read, the
 * tracks simply come back unmarked, which is the old behaviour.
 */
async function markTracksAlreadyOwned(tracks) {
    try {
        const { getSongsForMatch } = requireDeps();
        if (typeof getSongsForMatch !== 'function') return tracks;

        const songs = await getSongsForMatch();
        const owned = new Set();
        for (const song of songs || []) {
            const key = libraryMatchKey(song.artist, song.songname || song.title);
            if (key) owned.add(key);
        }

        return tracks.map(track => {
            const key = libraryMatchKey(track.artist, track.title);
            return key && owned.has(key) ? { ...track, inLibrary: true } : track;
        });
    } catch (error) {
        logError('Could not check the library for existing tracks:', error.message);
        return tracks;
    }
}

async function resolveSpotifyUrl(url) {
    const { getSpotifyTracks } = requireDeps();

    // Album metadata and the tracklist are independent; fetch them together.
    const [albumMetadata, tracks] = await Promise.all([
        fetchSpotifyAlbumMetadata(url),
        (async () => {
            try {
                return await getSpotifyTracks(url);
            } catch (error) {
                logError('Spotify resolution failed:', error.message);
                throw Object.assign(
                    new Error('Could not read that Spotify link. Public playlists, albums and tracks are supported.'),
                    { statusCode: 400 }
                );
            }
        })()
    ]);

    if (!Array.isArray(tracks) || tracks.length === 0) {
        throw Object.assign(new Error('That Spotify link contains no tracks, or it is private.'), { statusCode: 404 });
    }

    const resolved = tracks.map(track => ({
        title: track.name || 'Unknown Title',
        artist: track.artist || track.artists || 'Unknown Artist',
        // The album title from oEmbed wins over anything on the track object,
        // because a per-track value is exactly what produced the split albums.
        album: albumMetadata?.album || track.album || null,
        duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : null,
        artworkUrl: track.cover
            || (Array.isArray(track.images) && track.images[0] ? track.images[0].url : null)
            || albumMetadata?.artworkUrl
            || null
    }));

    return await markTracksAlreadyOwned(resolved);
}

/* ------------------------------------------------------------------ *
 * Artwork
 * ------------------------------------------------------------------ */

/**
 * Hardened image fetch: allowlisted host, capped redirects, capped size, and a
 * content-type check. Returns null instead of throwing - artwork is optional.
 */
function fetchArtwork(rawUrl, redirectsLeft = ARTWORK_REDIRECT_LIMIT) {
    return new Promise(resolve => {
        let target;
        try {
            target = new URL(String(rawUrl));
        } catch {
            return resolve(null);
        }

        if (target.protocol !== 'https:' && target.protocol !== 'http:') return resolve(null);
        if (!ARTWORK_HOST_ALLOWLIST.has(target.hostname.toLowerCase())) {
            log(`Ignoring artwork from a non-allowlisted host: ${target.hostname}`);
            return resolve(null);
        }

        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.get(target, { timeout: ARTWORK_TIMEOUT_MS }, response => {
            const status = response.statusCode || 0;

            if (status >= 300 && status < 400 && response.headers.location) {
                response.resume();
                if (redirectsLeft <= 0) return resolve(null);
                const next = new URL(response.headers.location, target).toString();
                return resolve(fetchArtwork(next, redirectsLeft - 1));
            }

            if (status !== 200) {
                response.resume();
                return resolve(null);
            }

            const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!ARTWORK_MIME_EXTENSIONS[contentType]) {
                response.resume();
                return resolve(null);
            }

            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTWORK_BYTES) {
                response.resume();
                return resolve(null);
            }

            const chunks = [];
            let received = 0;
            response.on('data', chunk => {
                received += chunk.length;
                if (received > MAX_ARTWORK_BYTES) {
                    request.destroy();
                    return resolve(null);
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({ buffer: Buffer.concat(chunks), mime: contentType }));
            response.on('error', () => resolve(null));
        });

        request.on('timeout', () => { request.destroy(); resolve(null); });
        request.on('error', () => resolve(null));
    });
}

/* ------------------------------------------------------------------ *
 * Tagging
 * ------------------------------------------------------------------ */

/*
 * Tag reads and writes go through NodeID3.Promise: the synchronous API reads
 * and rewrites the entire audio file on the event loop, which froze the server
 * for every downloaded track.
 */
async function hasEmbeddedArtwork(filePath) {
    try {
        const tags = await NodeID3.Promise.read(filePath);
        return Boolean(tags && tags.image);
    } catch {
        return false;
    }
}

/**
 * Writes tags with NodeID3.update so anything already correct in the file
 * survives. Only MP3 carries ID3; other containers keep whatever the source
 * embedded, and the scanner falls back to a cover file for those.
 */
async function applyTags(filePath, metadata, artwork) {
    if (path.extname(filePath).toLowerCase() !== '.mp3') return false;

    const tags = {};
    if (metadata.title) tags.title = metadata.title;
    if (metadata.artist) tags.artist = metadata.artist;
    if (metadata.album) tags.album = metadata.album;
    if (metadata.year) tags.year = String(metadata.year);

    if (artwork && artwork.buffer) {
        tags.image = {
            mime: artwork.mime,
            type: { id: 3, name: 'front cover' },
            description: 'Cover',
            imageBuffer: artwork.buffer
        };
    }

    if (Object.keys(tags).length === 0) return false;

    try {
        // Resolves on success and rejects on failure (handled below).
        await NodeID3.Promise.update(tags, filePath);
        return true;
    } catch (error) {
        logError(`Tagging failed for ${path.basename(filePath)}:`, error.message);
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * Progress reporting
 * ------------------------------------------------------------------ */

function emit(event, payload) {
    const { io } = requireDeps();
    if (!io) return;
    io.to('role:owner').emit(event, payload);
}

function serializeItem(row) {
    if (!row) return null;
    return {
        id: row.id,
        uid: row.queue_uid,
        batchUid: row.batch_uid,
        batchLabel: row.batch_label,
        status: row.status,
        stage: row.stage,
        requestedSource: row.requested_source,
        resolvedSource: row.resolved_source,
        quality: row.quality || 'best',
        title: row.title,
        artist: row.artist,
        album: row.album,
        duration: row.duration_seconds,
        progress: Number(row.progress) || 0,
        etaSeconds: row.eta_seconds,
        transferredBytes: Number(row.transferred_bytes) || 0,
        totalBytes: Number(row.total_bytes) || 0,
        attempts: Number(row.attempts) || 0,
        songId: row.song_id,
        error: row.error,
        requestedBy: row.requested_by,
        createdAt: row.created_at,
        completedAt: row.completed_at
    };
}

function emitQueueChanged() {
    emit('downloads:changed', { at: Date.now() });
}

function emitItemProgress(row) {
    emit('downloads:progress', { item: serializeItem(row) });
}

/* ------------------------------------------------------------------ *
 * Queue worker
 * ------------------------------------------------------------------ */

/** How many worker loops are live right now; the pool never exceeds the cap. */
let activeWorkerCount = 0;
let workerStopped = false;

/**
 * Every in-flight transfer, keyed by queue row id.
 *
 * This replaces the old single `activeTransfer` singleton. Cancellation is now
 * per-transfer, which is what makes a parallel pool correct: cancelling one row
 * must not disturb its neighbours in the pool.
 */
const activeTransfers = new Map();

/**
 * Soulseek usernames currently serving us a file, mapped to the transfer token
 * holding them.
 *
 * Tokens rather than row ids: a row can be retried while its previous transfer
 * is still unwinding, and keying on the row would let the old transfer release
 * a claim belonging to the new one. See endTransfer.
 *
 * Two workers must never pull from the same peer simultaneously. Soulseek
 * grants one upload slot per peer, so a second request either queues behind the
 * first (no faster) or looks like abuse (worse). Per-peer serialisation is what
 * makes the pool width safe rather than merely tolerated.
 */
const busyPeers = new Map();

/**
 * Peers abandoned mid-transfer, by username.
 *
 * A peer that timed out or stalled once is a poor bet for the next attempt, and
 * re-selecting it usually just re-queues behind the same problem. Deprioritised
 * rather than banned, because a peer with a bad moment is not necessarily a bad
 * peer; entries expire so the library does not accumulate permanent grudges.
 */
const discouragedPeers = new Map();
const DISCOURAGED_PEER_TTL_MS = 10 * 60 * 1000;

/** Monotonic id, so two transfers for the same row are never confused. */
let transferSequence = 0;

function beginTransfer(itemId) {
    const transfer = {
        itemId,
        token: ++transferSequence,
        cancelled: false,
        peer: null
    };
    activeTransfers.set(itemId, transfer);
    return transfer;
}

/**
 * Retires a transfer, but ONLY if it is still the current one for that row.
 *
 * The identity guard is the load-bearing part. A row can be retried while its
 * previous transfer is still unwinding — a failed row is retryable the moment
 * its status lands ('failed'), which processItem writes before this runs. The
 * retry claims the row and calls beginTransfer, replacing the map entry, so a
 * plain delete-by-id here would evict the NEW transfer and make it
 * uncancellable. One retry click is enough to hit this.
 *
 * The token check below is a second, narrower guard: `trySoulseek` clears
 * `transfer.peer` in its own finally, so in practice this branch only ever runs
 * for the `holdAbandonedPeer` case, where a cancelled transfer has already
 * released the peer field. Tokens (not row ids) keep that claim bound to the
 * transfer that took it rather than to a row that may since have been retried.
 */
function endTransfer(transfer) {
    if (activeTransfers.get(transfer.itemId) !== transfer) return;

    if (transfer.peer && busyPeers.get(transfer.peer) === transfer.token) {
        if (transfer.cancelled) holdAbandonedPeer(transfer.peer, transfer.token);
        else busyPeers.delete(transfer.peer);
    }
    activeTransfers.delete(transfer.itemId);
}

function cancelTransfer(itemId) {
    const transfer = activeTransfers.get(itemId);
    if (!transfer) return false;
    transfer.cancelled = true;
    return true;
}

/**
 * Keeps a peer reserved after its transfer was abandoned, then expires the
 * claim. See ABANDONED_PEER_HOLD_MS for why the reservation outlives the
 * transfer rather than being released with it.
 */
function holdAbandonedPeer(user, token) {
    const timer = setTimeout(() => {
        if (busyPeers.get(user) === token) busyPeers.delete(user);
    }, ABANDONED_PEER_HOLD_MS);
    // Never let a cleanup timer hold the process open at shutdown.
    if (typeof timer.unref === 'function') timer.unref();
}

/** Marks a peer as having just failed us, so the next attempt prefers another. */
function discouragePeer(user) {
    if (!user) return;
    discouragedPeers.set(user, Date.now());
}

function isPeerDiscouraged(user) {
    const at = discouragedPeers.get(user);
    if (!at) return false;
    if (Date.now() - at > DISCOURAGED_PEER_TTL_MS) {
        discouragedPeers.delete(user);
        return false;
    }
    return true;
}

/**
 * Pacing is handled process-wide by withYtDlpSlot in ytDlpRuntime, not here:
 * searches, metadata, artwork and downloads all spend the same per-IP
 * allowance, so a per-module gate would only pace each caller against itself.
 */
function delay(ms) {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}

function buildSearchQuery(item) {
    if (item.search_query) return item.search_query;
    return [item.artist, item.title].filter(Boolean).join(' ').trim() || item.title;
}

/**
 * Picks the best candidate from a peer that is not already serving us.
 *
 * Busy peers are dropped outright rather than merely deprioritised: a second
 * request to a peer holding our upload slot would queue behind the first and
 * finish no sooner, so waiting on it is pure delay. `null` therefore means
 * "every candidate is busy", which the caller treats as a signal to fall
 * through to the next source rather than to wait.
 *
 * Candidates from discouraged peers are deprioritised but kept, so a track only
 * one peer has still resolves.
 */
function selectSoulseekCandidate(candidates) {
    const available = candidates.filter(candidate => !busyPeers.has(candidate.user));
    if (available.length === 0) return null;

    return available
        .map((candidate, index) => ({
            candidate,
            index,
            penalty: isPeerDiscouraged(candidate.user) ? 1 : 0
        }))
        .sort((a, b) => (a.penalty - b.penalty) || (a.index - b.index))[0].candidate;
}

/**
 * Resolves the audio for one queue row and returns the temp file it produced.
 *
 * Ordering note: `auto` tries Soulseek FIRST. Soulseek has no anti-bot system,
 * is not rate-limited per IP, and frequently serves lossless where YouTube
 * yields a 128 kbps transcode — so it is both the better source and the one
 * that does not punish us for using it. YouTube remains the fallback, which is
 * also why the breaker only ever costs us a source and never the download.
 */
async function acquireAudio(item, temporaryDirectory, reportProgress, transfer) {
    const requestedSource = item.requested_source || 'auto';
    const payload = item.source_payload ? JSON.parse(item.source_payload) : null;
    const query = buildSearchQuery(item);
    // Stored per row, so a restarted download keeps the quality the user chose
    // rather than silently reverting to the default.
    const quality = QUALITY_PREFERENCES.has(item.quality) ? item.quality : 'best';
    const failures = [];
    const shouldCancel = () => transfer.cancelled;

    const tryYoutube = async url => {
        const destination = path.join(temporaryDirectory, 'audio.mp3');
        // Paced by the shared gate, so a download cannot run alongside a search
        // or a Discord artwork lookup and double the request rate.
        return withYtDlpSlot(
            () => youtubeDownload(url, destination, reportProgress, { shouldCancel }),
            shouldCancel
        );
    };

    const trySoulseek = async candidate => {
        const client = await getSoulseekClient();
        if (!client) throw new Error(soulseekLastError || 'Soulseek is not connected.');

        // Claim the peer for the duration of the transfer. This is what keeps a
        // second worker from queueing behind us on the same upload slot.
        const peer = candidate.user;
        transfer.peer = peer;
        busyPeers.set(peer, transfer.token);

        try {
            await reportProgress({ stage: 'connecting', resolved_source: 'soulseek' });
            const live = await refreshSoulseekCandidate(candidate);
            if (!live) throw new Error('The peer is no longer sharing that file.');

            const destination = path.join(temporaryDirectory, `audio${live.extension || '.mp3'}`);
            await reportProgress({
                stage: 'downloading',
                resolved_source: 'soulseek',
                total_bytes: Number(live.sizeBytes) || 0
            });

            const result = await soulseekDownload(client, live, destination, reportProgress, {
                shouldCancel
            });
            return { ...result, source: 'soulseek', bitrate: live.bitrate };
        } catch (error) {
            // A peer that stalled or dropped us is a poor bet for the retry.
            if (error.message !== 'Cancelled.') discouragePeer(peer);
            throw error;
        } finally {
            if (busyPeers.get(peer) === transfer.token) {
                if (transfer.cancelled) {
                    // The socket is still draining; see ABANDONED_PEER_HOLD_MS.
                    holdAbandonedPeer(peer, transfer.token);
                } else {
                    busyPeers.delete(peer);
                }
            }
            transfer.peer = null;
        }
    };

    // An explicitly picked search result. Honoured before anything else so a
    // hand-chosen lossless file is never silently swapped for another source.
    if (requestedSource === 'soulseek' && payload) {
        return await trySoulseek(payload);
    }

    // Soulseek first for `auto` and explicit soulseek. See the ordering note in
    // this function's doc comment for why it leads rather than follows.
    if (requestedSource === 'auto' || requestedSource === 'soulseek') {
        try {
            await reportProgress({ stage: 'searching', resolved_source: 'soulseek' });
            const { available, results } = await soulseekSearch(query, {
                timeout: SOULSEEK_AUTO_SEARCH_MS,
                limit: 10,
                quality
            });

            // Up to six distinct peers are tried, against the old fixed three:
            // with several workers live, the best-scoring peers are legitimately
            // busy, and giving up when the top few are taken is what made
            // playlists crawl.
            //
            // The `break` on "no candidate left" is load-bearing, not a
            // shortcut. Waiting for a busy peer instead would let workers block
            // on peers held by each other — A waiting on Y while B holds Y and
            // waits on X — so the fall-through to YouTube is what keeps the pool
            // deadlock-free.
            if (available && results.length > 0) {
                const ordered = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));
                const attempts = requestedSource === 'soulseek' ? 4 : 6;
                for (let attempt = 0; attempt < attempts; attempt += 1) {
                    const candidate = selectSoulseekCandidate(ordered);
                    if (!candidate) break;
                    if (transfer.cancelled) throw new Error('Cancelled.');
                    try {
                        return await trySoulseek({ ...candidate, query });
                    } catch (error) {
                        if (error.message === 'Cancelled.') throw error;
                        failures.push(`Soulseek (${candidate.user}): ${error.message}`);
                        // Remove the failed peer from consideration so the next
                        // iteration picks a different one rather than looping.
                        const index = ordered.indexOf(candidate);
                        if (index >= 0) ordered.splice(index, 1);
                    }
                }
            } else if (!available) {
                failures.push('Soulseek is unavailable.');
            } else {
                failures.push('No Soulseek results.');
            }
        } catch (error) {
            if (error.message === 'Cancelled.') throw error;
            failures.push(`Soulseek: ${error.message}`);
        }
    }

    // YouTube as the fallback for `auto`, and the only path for an explicit
    // youtube request. Skipped outright while the breaker is open, so a block
    // costs one source rather than the download.
    const youtubeWanted = requestedSource === 'youtube' || requestedSource === 'auto';
    if (youtubeWanted && !isYoutubeBlocked()) {
        if (requestedSource === 'youtube') {
            try {
                return await tryYoutube(item.source_url);
            } catch (error) {
                if (error.message === 'Cancelled.') throw error;
                failures.push(`YouTube: ${error.message}`);
            }
        } else {
            try {
                await reportProgress({ stage: 'searching', resolved_source: 'youtube' });
                const results = await youtubeSearch(youtubeQuery(item), {
                    limit: YOUTUBE_MAX_ATTEMPTS,
                    expectedDuration: item.duration_seconds,
                    shouldCancel
                });

                for (const candidate of results) {
                    if (transfer.cancelled) throw new Error('Cancelled.');
                    try {
                        return await tryYoutube(candidate.payload.url);
                    } catch (error) {
                        if (error.message === 'Cancelled.') throw error;
                        failures.push(`YouTube: ${error.message}`);
                        // A block invalidates every remaining candidate: they
                        // share one IP and one client identity, so continuing
                        // would only deepen the rate-limit we just hit.
                        if (isYoutubeBlockError(error)) break;
                    }
                }
                if (results.length === 0) failures.push('YouTube: No matching videos.');
            } catch (error) {
                if (error.message === 'Cancelled.') throw error;
                if (!failures.some(failure => failure.startsWith('YouTube:'))) {
                    failures.push(`YouTube: ${error.message}`);
                }
            }
        }
    } else if (youtubeWanted && isYoutubeBlocked()) {
        failures.push('YouTube is paused after rate-limiting this connection.');
    }

    throw new Error(failures.join(' | ') || 'Could not provide this track.');
}

async function processItem(item, transfer) {
    const temporaryDirectory = createTempDirectory();
    let lastEmit = 0;

    const reportProgress = async (updates = {}) => {
        const columns = {};
        if (updates.stage) columns.stage = updates.stage;
        if (updates.resolved_source) columns.resolved_source = updates.resolved_source;
        if (Number.isFinite(updates.progress)) columns.progress = Math.max(0, Math.min(updates.progress, 1));
        if (Number.isFinite(updates.transferred)) columns.transferred_bytes = Math.round(updates.transferred);
        if (Number.isFinite(updates.total) && updates.total > 0) columns.total_bytes = Math.round(updates.total);
        if (Number.isFinite(updates.total_bytes)) columns.total_bytes = Math.round(updates.total_bytes);
        if ('etaSeconds' in updates) {
            columns.eta_seconds = Number.isFinite(updates.etaSeconds) ? Math.round(updates.etaSeconds) : null;
        }

        // Keeps the early return reachable: a stage-only ping still writes, but
        // an empty update must not cost a serialised UPDATE + SELECT.
        if (Object.keys(columns).length === 0) return;

        const updated = await HandleDatabase.updateDownloadItem(item.id, columns);
        const now = Date.now();
        // Throttle the socket chatter; the DB row is always current.
        if (updated && (now - lastEmit > PROGRESS_EMIT_INTERVAL_MS || updates.stage)) {
            lastEmit = now;
            emitItemProgress(updated);
        }
    };

    try {
        const downloadRoot = resolveDownloadRoot();
        const acquired = await acquireAudio(item, temporaryDirectory, reportProgress, transfer);
        if (transfer.cancelled) throw new Error('Cancelled.');

        await reportProgress({ stage: 'tagging', progress: 0.96 });

        const isGenericTitle = !item.title ||
            /^(?:youtube audio|web audio download|unknown title|unknown track)$/i.test(item.title.trim());

        let resolvedTitle = item.title;
        let resolvedArtist = item.artist || null;

        if (isGenericTitle && acquired.metadata && acquired.metadata.title) {
            resolvedTitle = acquired.metadata.title;
        }
        if (!resolvedArtist && acquired.metadata && acquired.metadata.artist) {
            resolvedArtist = acquired.metadata.artist;
        }

        // If title or artist were promoted from the download metadata, persist back to the queue row
        if (resolvedTitle !== item.title || resolvedArtist !== item.artist) {
            await HandleDatabase.updateDownloadItem(item.id, {
                title: resolvedTitle,
                artist: resolvedArtist
            });
            item.title = resolvedTitle;
            item.artist = resolvedArtist;
        }

        let artwork = null;
        const explicitArtworkUrl = item.artwork_url;
        const fallbackArtworkUrl = acquired.metadata ? acquired.metadata.thumbnail : null;
        const artworkUrlToFetch = explicitArtworkUrl || fallbackArtworkUrl;
        
        // Prioritize explicit artwork (from Spotify/iTunes) over whatever the peer embedded.
        if (artworkUrlToFetch) {
            if (explicitArtworkUrl || !(await hasEmbeddedArtwork(acquired.filePath))) {
                artwork = await fetchArtwork(artworkUrlToFetch);
            }
        }

        const shouldTagMetadata = Boolean(item.artist || acquired.source === 'youtube' || (resolvedTitle && !isGenericTitle));
        const tagsUpdated = await applyTags(
            acquired.filePath,
            shouldTagMetadata
                ? { title: resolvedTitle, artist: resolvedArtist, album: item.album }
                : {},
            artwork
        );
        let artworkApplied = Boolean(artwork && tagsUpdated);

        await reportProgress({ stage: 'saving', progress: 0.98 });

        // A cancel issued while this row sat in the queue can land after the
        // worker already claimed it. Re-read the authoritative status before
        // anything touches the user's music folder.
        const current = await HandleDatabase.getDownloadItem(item.id);
        if (!current || current.status !== 'running') throw new Error('Cancelled.');

        const extension = path.extname(acquired.filePath).toLowerCase() || '.mp3';
        const base = buildBaseFileName(resolvedArtist, resolvedTitle);
        const destination = uniqueDestination(downloadRoot, base, extension);
        await moveFile(acquired.filePath, destination);
        log(`Saved ${path.basename(destination)} from ${acquired.source}`);

        await reportProgress({ stage: 'indexing', progress: 0.99 });
        const song = await requireDeps().indexMusicFile(destination);

        // The scanner reads embedded art. If the file had none and we fetched a
        // thumbnail we could not embed (non-MP3), persist it as the song cover.
        if (song && artwork && !song.cover_path) {
            try {
                const coverExtension = ARTWORK_MIME_EXTENSIONS[artwork.mime] || '.jpg';
                const coverName = `${song.song_uid}${coverExtension}`;
                fs.mkdirSync(RT.paths.covers, { recursive: true });
                fs.writeFileSync(path.join(RT.paths.covers, coverName), artwork.buffer);
                await HandleDatabase.updateSong(song.id, { cover_path: `/Static/covers/${coverName}` });
                artworkApplied = true;
            } catch (error) {
                logError('Could not persist the fallback cover:', error.message);
            }
        }

        // Remember the public URL the cover came from. /Static/covers/... only
        // resolves on the LAN, so Discord Rich Presence needs the original
        // Spotify CDN address to show the same image.
        //
        // Gated on `artworkApplied` rather than on `artworkUrl`: it proves we
        // fetched this URL and made it the cover, either in the audio tags or
        // as the scanner's fallback cover file.
        if (song && artworkApplied && isTrustedArtworkUrl(artworkUrlToFetch)) {
            try {
                await HandleDatabase.setSongCoverSourceUrl(song.id, artworkUrlToFetch);
            } catch (error) {
                logError('Could not record the cover source URL:', error.message);
            }
        }

        const finished = await HandleDatabase.finishDownloadItem(item.id, {
            status: 'completed',
            filePath: destination,
            songId: song ? song.id : null,
            resolvedSource: acquired.source
        });
        emitItemProgress(finished);
        emit('downloads:completed', { item: serializeItem(finished) });
    } catch (error) {
        const cancelled = transfer.cancelled || error.message === 'Cancelled.';
        const finished = await HandleDatabase.finishDownloadItem(item.id, {
            status: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? null : String(error.message || error).slice(0, 500)
        });
        if (!cancelled) logError(`"${item.title}" failed:`, error.message);
        emitItemProgress(finished);
    } finally {
        removeDirectory(temporaryDirectory);
    }
}

/**
 * One worker loop: claims rows and processes them until the queue runs dry.
 *
 * `claimNextDownload` remains the single source of truth for what is claimable
 * — its `WHERE status = 'queued'` guard was written for exactly this, so
 * several loops racing for work cannot double-claim a row.
 *
 * A worker exits only when there is genuinely nothing left to claim, which is
 * what makes the pool self-draining: the loops stay alive through the whole
 * batch and only wind down once the queue is empty.
 */
async function runWorkerLoop() {
    while (!workerStopped) {
        const item = await HandleDatabase.claimNextDownload();
        if (!item) return;

        const transfer = beginTransfer(item.id);
        emitQueueChanged();
        try {
            await processItem(item, transfer);
        } catch (error) {
            logError('Unhandled worker error:', error);
            await HandleDatabase.finishDownloadItem(item.id, {
                status: 'failed',
                error: String(error.message || error).slice(0, 500)
            });
        } finally {
            endTransfer(transfer);
        }
        emitQueueChanged();
    }
}

/**
 * Tops the pool back up to its configured width.
 *
 * Safe to call whenever work is added: the guard means an extra call while the
 * pool is already full starts nothing, and because workers drain the queue
 * themselves this never needs to know how much work there is.
 */
function pumpQueue() {
    if (workerStopped) return;

    while (activeWorkerCount < MAX_PARALLEL_TRANSFERS) {
        activeWorkerCount += 1;
        runWorkerLoop()
            .catch(error => logError('Queue worker failed:', error))
            .finally(() => {
                activeWorkerCount -= 1;

                // A worker can run dry at the exact moment new work lands, while
                // the count is still at the cap — so the enqueue's own pumpQueue
                // call saw a full pool and started nothing. Only the last worker
                // to exit needs to re-check: while any other loop is alive it
                // will claim the new row itself.
                //
                // Gated on `countClaimableDownloads` rather than
                // `countPendingDownloads`: the latter also counts `running`
                // rows, which no worker can claim. With rows still running and
                // nothing queued, this would spawn a worker that immediately
                // exits, re-check, and spawn again — an endless spin instead of
                // an idle pool.
                if (!workerStopped && activeWorkerCount === 0) {
                    HandleDatabase.countClaimableDownloads()
                        .then(claimable => { if (claimable > 0 && !workerStopped) pumpQueue(); })
                        .catch(error => logError('Queue re-check failed:', error.message));
                }
            });
    }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function dedupeKeyFor(item) {
    if (item.sourceUrl) return `url:${normalizeForMatch(item.sourceUrl)}`;
    if (item.sourcePayload && item.sourcePayload.remotePath) {
        return `slsk:${item.sourcePayload.user}:${normalizeForMatch(item.sourcePayload.remotePath)}`;
    }
    const key = normalizeForMatch(`${item.artist || ''} ${item.title || ''}`);
    return key ? `track:${key}` : null;
}

/**
 * Parses common P2P filename patterns to extract artist and title.
 */
function parseFilename(filename) {
    let base = String(filename || '').replace(/\.[^.]+$/, '');
    
    // Strip common tags
    base = base.replace(/[\[\(\{].*?(?:kbps|official|audio|video|lyric|flac|mp3|remastered|remix|hd).*?[\]\)\}]/gi, '');
    
    // Remove track numbers: "01.", "01-", "01 - "
    base = base.replace(/^\s*\d{1,3}[\.\-]?\s+/, '');
    
    let artist = null;
    let title = base;
    
    // Look for typical "Artist - Title" split
    const parts = base.split(/\s+(?:-|_)\s+/);
    if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
    }
    
    return {
        artist: artist || null,
        title: title.trim() || 'Unknown Title'
    };
}

/**
 * Searches the iTunes API for cover art matching an artist and title.
 */
function fetchItunesArtwork(artist, title) {
    return new Promise(resolve => {
        if (!title) return resolve(null);
        
        const term = encodeURIComponent(`${artist ? artist + ' ' : ''}${title}`);
        const url = `https://itunes.apple.com/search?term=${term}&media=music&limit=1`;
        
        const req = https.get(url, { timeout: 3500 }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.results && parsed.results[0] && parsed.results[0].artworkUrl100) {
                        return resolve(parsed.results[0].artworkUrl100.replace('100x100bb', '600x600bb'));
                    }
                    resolve(null);
                } catch {
                    resolve(null);
                }
            });
        });
        
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

/** Search the requested sources for the Downloads page. */
async function search(query, { sources = ['youtube'], limit = 40, quality = 'best' } = {}) {
    const trimmed = String(query || '').trim();
    if (trimmed.length < 2) {
        throw Object.assign(new Error('Enter at least two characters to search.'), { statusCode: 400 });
    }
    if (trimmed.length > 200) {
        throw Object.assign(new Error('That search query is too long.'), { statusCode: 400 });
    }

    const wantSoulseek = sources.includes('soulseek');
    const wantYoutube = sources.includes('youtube');
    const [soulseekResult, youtubeResult] = await Promise.all([
        wantSoulseek ? soulseekSearch(trimmed, { limit, quality }).catch(error => ({
            available: false, results: [], error: error.message
        })) : Promise.resolve({ available: false, results: [], error: null }),
        wantYoutube ? youtubeSearch(`${trimmed} audio`, { limit: Math.min(limit, 10) })
            .then(results => ({ available: true, results, error: null }))
            .catch(error => ({ available: false, results: [], error: error.message }))
            : Promise.resolve({ available: false, results: [], error: null })
    ]);
    const results = wantYoutube && !wantSoulseek ? youtubeResult.results : soulseekResult.results;

    // Group unique parsed names to minimize iTunes lookups
    const artworkCache = new Map();
    const mappedResults = results.map(entry => {
        const parsed = entry.source === 'youtube' ? entry : parseFilename(entry.filename);
        return {
            id: entry.source === 'youtube' ? entry.id : `slsk:${entry.user}:${entry.remotePath}`,
            source: entry.source,
            title: parsed.title,
            artist: parsed.artist,
            user: entry.user,
            duration: entry.duration || null,
            thumbnail: entry.thumbnail || null,
            extension: entry.extension.replace('.', '').toUpperCase(),
            bitrate: entry.bitrate,
            sizeBytes: entry.sizeBytes,
            slots: entry.slots,
            queueLength: entry.queueLength,
            rawFilename: entry.filename || null,
            query: trimmed,
            payload: entry.source === 'youtube' ? entry.payload : {
                user: entry.user,
                remotePath: entry.remotePath,
                filename: entry.filename,
                extension: entry.extension,
                sizeBytes: entry.sizeBytes,
                bitrate: entry.bitrate,
                speed: entry.speed,
                slots: entry.slots,
                query: trimmed
            }
        };
    });

    // Concurrently fetch artwork for unique (artist + title) combinations
    await Promise.all(mappedResults.map(async entry => {
        if (entry.source === 'youtube') {
            entry.thumbnail = entry.thumbnail || null;
            return;
        }
        const cacheKey = `${entry.artist || ''} - ${entry.title}`.toLowerCase();
        if (!artworkCache.has(cacheKey)) {
            artworkCache.set(cacheKey, fetchItunesArtwork(entry.artist, entry.title));
        }
        entry.thumbnail = await artworkCache.get(cacheKey);
    }));

    return {
        query: trimmed,
        source: wantYoutube && !wantSoulseek ? 'youtube' : 'soulseek',
        results: mappedResults,
        soulseek: {
            available: soulseekResult.available,
            error: soulseekResult.error,
            results: wantYoutube ? [] : mappedResults
        },
        youtube: {
            available: youtubeResult.available,
            error: youtubeResult.error,
            results: wantYoutube ? mappedResults : []
        }
    };
}

/** Turns a pasted Spotify link into queue-ready items. */
async function resolveLink(url) {
    const trimmed = String(url || '').trim();

    if (isSpotifyUrl(trimmed)) {
        const tracks = await resolveSpotifyUrl(trimmed);
        return {
            kind: 'spotify',
            label: tracks[0] && tracks[0].album ? tracks[0].album : 'Spotify import',
            tracks: tracks.map(track => ({ ...track, requestedSource: 'auto' }))
        };
    }

    if (isYoutubeUrl(trimmed)) {
        const canonicalUrl = canonicalYoutubeUrl(trimmed);
        const videoId = extractYoutubeVideoId(trimmed);
        let meta = null;
        try {
            // Paced like every other lookup: pasting a playlist of links is a
            // burst of resolveLink calls, and they share the per-IP allowance.
            meta = await withYtDlpSlot(async () => {
                const child = ytDlp.exec(canonicalUrl, {
                    ...ytDlpBaseOptions(),
                    dumpSingleJson: true,
                    noWarnings: true,
                    noPlaylist: true,
                    skipDownload: true
                }, { env: ytDlpEnv(), timeout: 15000 });
                const result = await child;
                return JSON.parse(result.stdout);
            });
        } catch (err) {
            logError('yt-dlp metadata extraction failed during resolveLink:', err.message || err);
            meta = null;
        }

        let artist = null;
        let title = null;
        const uploader = meta && (meta.artist || meta.uploader || meta.channel);

        if (meta && meta.track && meta.artist) {
            artist = cleanYoutubeTitle(meta.artist);
            title = cleanYoutubeTitle(meta.track);
        } else if (meta && meta.title) {
            const splitted = splitYoutubeTitle(meta.title, uploader);
            artist = splitted.artist;
            title = splitted.title;
        } else {
            title = 'YouTube Audio';
            artist = null;
        }

        const thumbnail = (meta && meta.thumbnail)
            ? meta.thumbnail
            : (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

        return {
            kind: 'youtube',
            label: 'YouTube',
            tracks: [{
                requestedSource: 'youtube',
                sourceUrl: canonicalUrl,
                title: title || 'YouTube Audio',
                artist: artist || null,
                album: meta && meta.album ? meta.album : null,
                duration: meta && meta.duration ? Math.round(meta.duration) : null,
                thumbnail,
                artworkUrl: thumbnail
            }]
        };
    }

    throw Object.assign(
        new Error('Paste a valid Spotify or YouTube link.'),
        { statusCode: 400 }
    );
}

/** Adds items to the persistent queue and kicks the worker. */
async function enqueue(items, requestedBy, { batchLabel = null } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
        throw Object.assign(new Error('Nothing to download.'), { statusCode: 400 });
    }
    if (items.length > 200) {
        throw Object.assign(new Error('That is more than 200 tracks. Split the import.'), { statusCode: 400 });
    }
    for (const item of items) {
        // An unrecognised source would silently fall through to a plain search
        // instead of honouring what the caller asked for.
        if (item.requestedSource && !REQUESTED_SOURCES.has(item.requestedSource)) {
            throw Object.assign(new Error(`Unknown download source "${item.requestedSource}".`), { statusCode: 400 });
        }
    }
    if (items.some(item => item.requestedSource === 'soulseek') && !await readSoulseekCredentials()) {
        throw Object.assign(new Error('Connect Soulseek to download a specific peer file.'), { statusCode: 409 });
    }

    // Fail fast with a clear message rather than after the first transfer.
    resolveDownloadRoot();

    const batchUid = items.length > 1 ? crypto.randomUUID() : null;
    const prepared = items.map(item => ({
        batchUid,
        batchLabel: items.length > 1 ? batchLabel : null,
        requestedSource: item.requestedSource || 'auto',
        quality: QUALITY_PREFERENCES.has(item.quality) ? item.quality : 'best',
        title: String(item.title || '').trim().slice(0, 300) || 'Unknown Title',
        artist: item.artist ? String(item.artist).trim().slice(0, 300) : null,
        album: item.album ? String(item.album).trim().slice(0, 300) : null,
        durationSeconds: Number(item.duration) || null,
        searchQuery: item.searchQuery ? String(item.searchQuery).slice(0, 300) : null,
        sourceUrl: item.sourceUrl ? String(item.sourceUrl).slice(0, 1000) : null,
        sourcePayload: item.sourcePayload || null,
        artworkUrl: item.artworkUrl ? String(item.artworkUrl).slice(0, 1000) : null,
        dedupeKey: dedupeKeyFor(item)
    }));

    const result = await HandleDatabase.enqueueDownloads(prepared, requestedBy);
    emitQueueChanged();
    pumpQueue();

    return {
        queued: result.accepted.length,
        skipped: result.skipped,
        items: result.accepted.map(serializeItem)
    };
}

async function getQueue() {
    const rows = await HandleDatabase.getDownloadQueue({ limit: 200 });
    // Sorted by row id so `activeId` means "the oldest running download", which
    // is what a single-value reader would expect. Map insertion order is claim
    // order, which is not the same thing once workers race.
    const activeIds = [...activeTransfers.keys()].sort((a, b) => a - b);
    return {
        items: rows.map(serializeItem),
        // `activeId` keeps the single-value shape for older clients; `activeIds`
        // is the honest answer now that several transfers run at once.
        activeId: activeIds.length > 0 ? activeIds[0] : null,
        activeIds,
        youtube: youtubeBreakerStatus(),
        downloadFolder: (() => {
            try { return resolveDownloadRoot({ create: false }); } catch { return null; }
        })()
    };
}

async function cancelItem(id) {
    const item = await HandleDatabase.getDownloadItem(id);
    if (!item) throw Object.assign(new Error('That download is no longer in the queue.'), { statusCode: 404 });

    cancelTransfer(item.id);
    const cancelled = await HandleDatabase.cancelDownloadItem(item.id);
    emitQueueChanged();
    return cancelled;
}

async function cancelBatch(batchUid) {
    const cancelled = await HandleDatabase.cancelDownloadBatch(batchUid);
    // A batch can now span several in-flight transfers, so every matching one
    // is signalled rather than just the oldest.
    for (const transfer of activeTransfers.values()) {
        const active = await HandleDatabase.getDownloadItem(transfer.itemId);
        if (active && active.batch_uid === batchUid) cancelTransfer(active.id);
    }
    emitQueueChanged();
    return cancelled;
}

async function cancelAll() {
    for (const itemId of [...activeTransfers.keys()]) cancelTransfer(itemId);
    const cancelled = await HandleDatabase.cancelAllPendingDownloads();
    emitQueueChanged();
    return cancelled;
}

async function retryItem(id) {
    const item = await HandleDatabase.getDownloadItem(id);
    if (!item) throw Object.assign(new Error('That download is no longer in the queue.'), { statusCode: 404 });
    if ((item.requested_source === 'youtube' || item.resolved_source === 'youtube') && !item.source_url) {
        throw Object.assign(new Error('Legacy YouTube downloads without a URL cannot be retried.'), { statusCode: 409 });
    }

    const retried = await HandleDatabase.retryDownloadItem(item.id);
    if (!retried) throw Object.assign(new Error('Only failed or cancelled downloads can be retried.'), { statusCode: 409 });

    emitQueueChanged();
    pumpQueue();
    return serializeItem(retried);
}

async function clearFinished() {
    const removed = await HandleDatabase.clearFinishedDownloads();
    emitQueueChanged();
    return removed;
}

/**
 * Temp directories are removed in processItem's finally block, which a crash or
 * SIGKILL skips. Without this sweep a hard stop mid-transfer leaks a partial
 * audio file into MusicLibrary/Temp on every restart.
 */
function sweepOrphanedTempDirectories() {
    try {
        if (!fs.existsSync(RT.paths.temp)) return;
        let removed = 0;
        for (const entry of fs.readdirSync(RT.paths.temp)) {
            if (!entry.startsWith('dl-')) continue;
            fs.rmSync(path.join(RT.paths.temp, entry), { recursive: true, force: true });
            removed += 1;
        }
        if (removed > 0) log(`Cleaned up ${removed} orphaned temp folder(s).`);
    } catch (error) {
        logError('Temp folder sweep failed:', error.message);
    }
}

/** Requeues rows orphaned by a crash, then resumes the worker. */
async function resume() {
    workerStopped = false;
    sweepOrphanedTempDirectories();
    const recovered = await HandleDatabase.recoverDownloadQueue();
    if (recovered > 0) log(`Recovered ${recovered} interrupted download(s).`);

    const pending = await HandleDatabase.countPendingDownloads();
    if (pending > 0) {
        log(`Resuming ${pending} pending download(s).`);
        pumpQueue();
    }
}

function shutdown() {
    workerStopped = true;
    for (const itemId of [...activeTransfers.keys()]) cancelTransfer(itemId);
    disconnectSoulseek();
}

module.exports = {
    init,
    DOWNLOAD_FOLDER_NAME,
    resolveDownloadRoot,
    search,
    resolveLink,
    enqueue,
    getQueue,
    cancelItem,
    cancelBatch,
    cancelAll,
    retryItem,
    clearFinished,
    resume,
    shutdown,
    soulseekStatus,
    saveSoulseekCredentials,
    clearSoulseekCredentials,
    testSoulseekConnection,
    isSpotifyUrl,
    isYoutubeUrl,
    youtubeBreakerStatus,
    isYoutubeBlockError,
    extractYoutubeVideoId,
    canonicalYoutubeUrl,
    cleanYoutubeTitle,
    splitYoutubeTitle,
    isTrustedArtworkUrl,

    /**
     * Test-only surface for the transfer registry.
     *
     * These back a race that is invisible in normal use — a retry landing while
     * the previous transfer unwinds — so it would otherwise only be caught by
     * hand. Kept deliberately small and named to discourage production use.
     */
    __testing: {
        beginTransfer,
        endTransfer,
        cancelTransfer,
        isPeerBusy: user => busyPeers.has(user),
        fetchSpotifyAlbumMetadata,
        scoreSoulseekCandidate,
        qualityTierFor,
        claimPeer: (user, transfer) => busyPeers.set(user, transfer.token),
        activeTransferCount: () => activeTransfers.size,
        reset: () => {
            activeTransfers.clear();
            busyPeers.clear();
            discouragedPeers.clear();
        }
    }
};

/**
 * Streamify Download Engine
 * =========================
 *
 * Acquires music from Soulseek (P2P) and files it into the
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
 * 3. The queue is persisted in SQLite. A Spotify album is 15 sequential
 *    network transfers; a restart in the middle must resume, not lose them.
 *
 * 4. One transfer at a time. Soulseek peers respond badly to parallel
 *    hammering, and a single worker makes cancellation unambiguous.
 *
 * 5. Nothing here trusts a remote URL. Artwork is fetched only from an explicit
 *    host allowlist, with redirect, size and content-type limits.
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

const SECRETS_TO_STRIP = ['SLSK_USER', 'SLSK_PASS', 'ACOUSTID_CLIENT_KEY', 'TURNSTILE_SECRET_KEY'];

function ytDlpEnv() {
    const env = { ...process.env };
    for (const key of SECRETS_TO_STRIP) delete env[key];
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const DOWNLOAD_FOLDER_NAME = 'Streamify Downloads';

const SOULSEEK_INTERACTIVE_SEARCH_MS = 9000;
const SOULSEEK_AUTO_SEARCH_MS = 14000;
const SOULSEEK_DOWNLOAD_TIMEOUT_MS = 210000;
const SOULSEEK_CONNECT_TIMEOUT_MS = 20000;

const REQUESTED_SOURCES = new Set(['auto', 'soulseek', 'youtube']);
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
 */
function moveFile(source, destination) {
    try {
        fs.renameSync(source, destination);
        return;
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
    }

    // Copy to a temporary name first, then rename into place. A crash midway
    // through a plain copy would otherwise leave a truncated file sitting in
    // the music folder for the scanner to index as a real track.
    const staging = `${destination}.part`;
    try {
        fs.copyFileSync(source, staging);
        fs.renameSync(staging, destination);
        fs.unlinkSync(source);
    } catch (error) {
        try { fs.rmSync(staging, { force: true }); } catch { /* best effort */ }
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
 */
function scoreSoulseekCandidate(candidate, queryTokens) {
    let score = 0;

    if (candidate.slots) score += 500;
    if (candidate.queueLength === 0) score += 100;
    else if (Number.isFinite(candidate.queueLength)) score -= Math.min(candidate.queueLength * 5, 200);

    const haystack = normalizeForMatch(candidate.filename);
    const matched = queryTokens.filter(token => haystack.includes(token)).length;
    score += queryTokens.length > 0 ? (matched / queryTokens.length) * 400 : 0;

    if (candidate.extension === '.flac') score += 120;
    else if (candidate.extension === '.mp3') score += 80;

    const bitrate = Number(candidate.bitrate) || 0;
    if (bitrate >= 320) score += 90;
    else if (bitrate >= 256) score += 60;
    else if (bitrate >= 192) score += 30;
    else if (bitrate > 0 && bitrate < 128) score -= 120;

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
async function soulseekSearch(query, { timeout = SOULSEEK_INTERACTIVE_SEARCH_MS, limit = 60 } = {}) {
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
        .map(entry => ({ ...entry, score: scoreSoulseekCandidate(entry, queryTokens) }))
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

async function youtubeDownload(sourceUrl, destination, reportProgress, { shouldCancel } = {}) {
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

        const args = {
            ffmpegLocation: ffmpegPath,
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: '0',
            output: outTemplate,
            noWarnings: true,
            noPlaylist: true,
            noSimulate: true,
            print: 'STREAMIFY_META\t%(title)s\t%(artist)s\t%(track)s\t%(uploader)s\t%(thumbnail)s',
            newline: true
        };

        try {
            const child = ytDlp.exec(targetUrl, args, { env: ytDlpEnv(), timeout: 300000 });
            activeChild = child;

            let totalBytes = 0;
            let transferred = 0;
            let capturedMeta = null;

            if (child.stdout) {
                child.stdout.on('data', chunk => {
                    const text = chunk.toString();
                    if (!capturedMeta) {
                        for (const line of text.split(/\r?\n/)) {
                            if (line.startsWith('STREAMIFY_META\t')) {
                                capturedMeta = line;
                                break;
                            }
                        }
                    }
                    const progressMatch = text.match(/\[download\]\s+([\d.]+)%\s+of\s+(?:~?\s*([\d.]+)\s*(KiB|MiB|GiB|B))?(?:\s+at\s+([\d.]+)\s*(KiB|MiB|GiB|B)\/s)?(?:\s+ETA\s+(\d+:\d+))?/i);
                    if (progressMatch) {
                        const pct = parseFloat(progressMatch[1]) / 100;
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

            child.then(() => {
                if (settled) return;
                settled = true;
                cleanup();

                let downloadedMetadata = null;
                if (capturedMeta) {
                    const parts = capturedMeta.split('\t');
                    const rawTitle = parts[1] && parts[1] !== 'NA' ? parts[1].trim() : null;
                    const rawArtist = parts[2] && parts[2] !== 'NA' ? parts[2].trim() : null;
                    const rawTrack = parts[3] && parts[3] !== 'NA' ? parts[3].trim() : null;
                    const rawUploader = parts[4] && parts[4] !== 'NA' ? parts[4].trim() : null;
                    const rawThumb = parts[5] && parts[5] !== 'NA' ? parts[5].trim() : null;

                    let title = rawTitle;
                    let artist = rawArtist;

                    if (rawTrack && rawArtist) {
                        title = cleanYoutubeTitle(rawTrack);
                        artist = cleanYoutubeTitle(rawArtist);
                    } else if (rawTitle) {
                        const splitted = splitYoutubeTitle(rawTitle, rawArtist || rawUploader);
                        title = splitted.title;
                        artist = splitted.artist;
                    }

                    const videoId = extractYoutubeVideoId(targetUrl);
                    const thumbnail = rawThumb || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

                    downloadedMetadata = {
                        title: title || 'Unknown Title',
                        artist: artist || null,
                        uploader: rawUploader,
                        thumbnail
                    };
                }

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

                resolve({ filePath: finalFilePath, source: 'youtube', bitrate: 320, metadata: downloadedMetadata });
            }).catch(err => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(err.shortMessage || err.message || String(err)));
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
 * Each resolved track is queued and then acquired from Soulseek.
 */
async function resolveSpotifyUrl(url) {
    const { getSpotifyTracks } = requireDeps();

    let tracks;
    try {
        tracks = await getSpotifyTracks(url);
    } catch (error) {
        logError('Spotify resolution failed:', error.message);
        throw Object.assign(
            new Error('Could not read that Spotify link. Public playlists, albums and tracks are supported.'),
            { statusCode: 400 }
        );
    }

    if (!Array.isArray(tracks) || tracks.length === 0) {
        throw Object.assign(new Error('That Spotify link contains no tracks, or it is private.'), { statusCode: 404 });
    }

    return tracks.map(track => ({
        title: track.name || 'Unknown Title',
        artist: track.artist || track.artists || 'Unknown Artist',
        album: track.album || null,
        duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : null,
        artworkUrl: track.cover || (Array.isArray(track.images) && track.images[0] ? track.images[0].url : null)
    }));
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

function hasEmbeddedArtwork(filePath) {
    try {
        const tags = NodeID3.read(filePath);
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
function applyTags(filePath, metadata, artwork) {
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
        const result = NodeID3.update(tags, filePath);
        if (result !== true) logError(`Tagging returned ${result} for ${path.basename(filePath)}`);
        return result === true;
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

let workerRunning = false;
let workerStopped = false;
const activeTransfer = { itemId: null, cancelled: false };

function cancelActiveTransfer(itemId) {
    if (activeTransfer.itemId !== itemId) return false;
    activeTransfer.cancelled = true;
    return true;
}

function buildSearchQuery(item) {
    if (item.search_query) return item.search_query;
    return [item.artist, item.title].filter(Boolean).join(' ').trim() || item.title;
}

/**
 * Resolves the audio for one queue row and returns the temp file it produced.
 */
async function acquireAudio(item, temporaryDirectory, reportProgress) {
    const requestedSource = item.requested_source || 'auto';
    const payload = item.source_payload ? JSON.parse(item.source_payload) : null;
    const query = buildSearchQuery(item);
    const failures = [];

    if (requestedSource === 'youtube') {
        try {
            const destination = path.join(temporaryDirectory, 'audio.mp3');
            return await youtubeDownload(item.source_url, destination, reportProgress, {
                shouldCancel: () => activeTransfer.cancelled
            });
        } catch (error) {
            if (error.message === 'Cancelled.') throw error;
            throw new Error(`YouTube: ${error.message}`);
        }
    }

    const trySoulseek = async candidate => {
        const client = await getSoulseekClient();
        if (!client) throw new Error(soulseekLastError || 'Soulseek is not connected.');

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
            shouldCancel: () => activeTransfer.cancelled
        });
        return { ...result, source: 'soulseek', bitrate: live.bitrate };
    };

    // An explicitly picked search result.
    if (requestedSource === 'soulseek' && payload) {
        return await trySoulseek(payload);
    }
    // Automatic mode searches Soulseek for Spotify tracklists and legacy rows.
    if (requestedSource === 'auto' || requestedSource === 'soulseek') {
        try {
            await reportProgress({ stage: 'searching', resolved_source: 'soulseek' });
            const { available, results } = await soulseekSearch(query, {
                timeout: SOULSEEK_AUTO_SEARCH_MS,
                limit: 10
            });

            if (available && results.length > 0) {
                for (const candidate of results.slice(0, 3)) {
                    if (activeTransfer.cancelled) throw new Error('Cancelled.');
                    try {
                        return await trySoulseek({ ...candidate, query });
                    } catch (error) {
                        failures.push(`Soulseek (${candidate.user}): ${error.message}`);
                        if (error.message === 'Cancelled.') throw error;
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

        // Secondary fallback for automatic mode: search YouTube directly via native yt-dlp
        if (requestedSource === 'auto') {
            try {
                await reportProgress({ stage: 'searching', resolved_source: 'youtube' });
                const searchChild = ytDlp.exec(`ytsearch1:${query}`, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    noPlaylist: true,
                    skipDownload: true
                }, { env: ytDlpEnv(), timeout: 15000 });
                const searchRes = await searchChild;
                const info = JSON.parse(searchRes.stdout);
                const entry = (info && Array.isArray(info.entries)) ? info.entries[0] : info;
                if (entry && (entry.url || entry.id || entry.webpage_url)) {
                    const targetUrl = entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url);
                    const destination = path.join(temporaryDirectory, 'audio.mp3');
                    return await youtubeDownload(targetUrl, destination, reportProgress, {
                        shouldCancel: () => activeTransfer.cancelled
                    });
                }
            } catch (error) {
                if (error.message === 'Cancelled.') throw error;
                failures.push(`YouTube fallback: ${error.message}`);
            }
        }
    }

    throw new Error(failures.join(' | ') || 'Could not provide this track.');
}

async function processItem(item) {
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
        const acquired = await acquireAudio(item, temporaryDirectory, reportProgress);
        if (activeTransfer.cancelled) throw new Error('Cancelled.');

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
            if (explicitArtworkUrl || !hasEmbeddedArtwork(acquired.filePath)) {
                artwork = await fetchArtwork(artworkUrlToFetch);
            }
        }

        const shouldTagMetadata = Boolean(item.artist || acquired.source === 'youtube' || (resolvedTitle && !isGenericTitle));
        const tagsUpdated = applyTags(
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
        moveFile(acquired.filePath, destination);
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
        const cancelled = activeTransfer.cancelled || error.message === 'Cancelled.';
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
 * Single-flight queue pump. Safe to call whenever work is added; a second call
 * while running is a no-op because the loop drains everything.
 */
async function pumpQueue() {
    if (workerRunning || workerStopped) return;
    workerRunning = true;

    try {
        while (!workerStopped) {
            const item = await HandleDatabase.claimNextDownload();
            if (!item) break;

            activeTransfer.itemId = item.id;
            activeTransfer.cancelled = false;

            emitQueueChanged();
            try {
                await processItem(item);
            } catch (error) {
                logError('Unhandled worker error:', error);
                await HandleDatabase.finishDownloadItem(item.id, {
                    status: 'failed',
                    error: String(error.message || error).slice(0, 500)
                });
            } finally {
                activeTransfer.itemId = null;
                activeTransfer.cancelled = false;
            }
            emitQueueChanged();
        }
    } finally {
        workerRunning = false;
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

/** Soulseek search for the Downloads page. */
async function search(query, { sources = ['soulseek'], limit = 40 } = {}) {
    const trimmed = String(query || '').trim();
    if (trimmed.length < 2) {
        throw Object.assign(new Error('Enter at least two characters to search.'), { statusCode: 400 });
    }
    if (trimmed.length > 200) {
        throw Object.assign(new Error('That search query is too long.'), { statusCode: 400 });
    }

    const wantSoulseek = sources.includes('soulseek');
    const soulseekResult = wantSoulseek ? await soulseekSearch(trimmed, { limit }).catch(error => ({
        available: false, results: [], error: error.message
    })) : { available: false, results: [], error: null };

    // Group unique parsed names to minimize iTunes lookups
    const artworkCache = new Map();
    const mappedResults = soulseekResult.results.map(entry => {
        const parsed = parseFilename(entry.filename);
        return {
            id: `slsk:${entry.user}:${entry.remotePath}`,
            source: 'soulseek',
            title: parsed.title,
            artist: parsed.artist,
            user: entry.user,
            extension: entry.extension.replace('.', '').toUpperCase(),
            bitrate: entry.bitrate,
            sizeBytes: entry.sizeBytes,
            slots: entry.slots,
            queueLength: entry.queueLength,
            rawFilename: entry.filename,
            payload: {
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
        const cacheKey = `${entry.artist || ''} - ${entry.title}`.toLowerCase();
        if (!artworkCache.has(cacheKey)) {
            artworkCache.set(cacheKey, fetchItunesArtwork(entry.artist, entry.title));
        }
        entry.thumbnail = await artworkCache.get(cacheKey);
    }));

    return {
        query: trimmed,
        soulseek: {
            available: soulseekResult.available,
            error: soulseekResult.error,
            results: mappedResults
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
            tracks: tracks.map(track => ({ ...track, requestedSource: 'soulseek' }))
        };
    }

    if (isYoutubeUrl(trimmed)) {
        const canonicalUrl = canonicalYoutubeUrl(trimmed);
        const videoId = extractYoutubeVideoId(trimmed);
        let meta = null;
        try {
            const child = ytDlp.exec(canonicalUrl, {
                dumpSingleJson: true,
                noWarnings: true,
                noPlaylist: true,
                skipDownload: true
            }, { env: ytDlpEnv(), timeout: 15000 });
            const result = await child;
            meta = JSON.parse(result.stdout);
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
    const needsSoulseek = items.some(item => (item.requestedSource || 'auto') !== 'youtube');
    if (needsSoulseek && !await readSoulseekCredentials()) {
        throw Object.assign(new Error('Set up Soulseek before queueing downloads.'), { statusCode: 409 });
    }

    // Fail fast with a clear message rather than after the first transfer.
    resolveDownloadRoot();

    const batchUid = items.length > 1 ? crypto.randomUUID() : null;
    const prepared = items.map(item => ({
        batchUid,
        batchLabel: items.length > 1 ? batchLabel : null,
        requestedSource: item.requestedSource || 'auto',
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
    pumpQueue().catch(error => logError('Queue pump failed:', error));

    return {
        queued: result.accepted.length,
        skipped: result.skipped,
        items: result.accepted.map(serializeItem)
    };
}

async function getQueue() {
    const rows = await HandleDatabase.getDownloadQueue({ limit: 200 });
    return {
        items: rows.map(serializeItem),
        activeId: activeTransfer.itemId,
        downloadFolder: (() => {
            try { return resolveDownloadRoot({ create: false }); } catch { return null; }
        })()
    };
}

async function cancelItem(id) {
    const item = await HandleDatabase.getDownloadItem(id);
    if (!item) throw Object.assign(new Error('That download is no longer in the queue.'), { statusCode: 404 });

    cancelActiveTransfer(item.id);
    const cancelled = await HandleDatabase.cancelDownloadItem(item.id);
    emitQueueChanged();
    return cancelled;
}

async function cancelBatch(batchUid) {
    const cancelled = await HandleDatabase.cancelDownloadBatch(batchUid);
    if (activeTransfer.itemId) {
        const active = await HandleDatabase.getDownloadItem(activeTransfer.itemId);
        if (active && active.batch_uid === batchUid) cancelActiveTransfer(active.id);
    }
    emitQueueChanged();
    return cancelled;
}

async function cancelAll() {
    if (activeTransfer.itemId) cancelActiveTransfer(activeTransfer.itemId);
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
    pumpQueue().catch(error => logError('Queue pump failed:', error));
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
        pumpQueue().catch(error => logError('Queue pump failed:', error));
    }
}

function shutdown() {
    workerStopped = true;
    if (activeTransfer.itemId) cancelActiveTransfer(activeTransfer.itemId);
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
    extractYoutubeVideoId,
    canonicalYoutubeUrl,
    cleanYoutubeTitle,
    splitYoutubeTitle,
    isTrustedArtworkUrl
};

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

const HandleDatabase = require('./database');
const Media = require('./media');
const AIMetadata = require('./aiMetadata');
const Fingerprint = require('./fingerprint');
const Auth = require('./auth');
const RT = require('./runtime');
const ffmpegPath = RT.unpackPath(require('@ffmpeg-installer/ffmpeg').path);
const { Jimp } = require('jimp');
const mm = require('music-metadata');
const Moderation = require('./moderation');
const ytDlpFactory = require('yt-dlp-exec');
const ytDlp = ytDlpFactory.create(RT.unpackPath(require('yt-dlp-exec/src/constants').YOUTUBE_DL_PATH));

// Config is loaded through the runtime module rather than require()'d directly.
// This lets the packaged desktop app keep a writable config outside the asar,
// and seeds a fresh config.json from config.example.json on first run.
RT.ensureDirectories();
const config = RT.loadConfig();
const { getTracks } = require('spotify-url-info')(fetch);
const slsk = require('slsk-client');
const NodeID3 = require('node-id3');

// Map to track active Soulseek downloads for manual skipping/cancellation
// Key: "username:query"
const activeSoulseekDownloads = new Map();
const activeImports = new Map(); // Track overall active imports for cancellation
const activeEnrichmentWorkers = new Map();

// Persistent Soulseek Client to avoid rate-limits
let globalSlskClient = null;
let isSlskConnecting = false;

async function getSoulseekClient() {
    if (globalSlskClient && globalSlskClient.search) return globalSlskClient;
    if (isSlskConnecting) {
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (globalSlskClient) { clearInterval(check); resolve(globalSlskClient); }
            }, 500);
        });
    }

    isSlskConnecting = true;
    return new Promise((resolve) => {
        console.log("[SOULSEEK] Connecting to P2P network...");
        slsk.connect({
            user: process.env.SLSK_USER,
            pass: process.env.SLSK_PASS
        }, (err, client) => {
            isSlskConnecting = false;
            if (err) {
                console.error("[SOULSEEK] Connection failed:", err);
                return resolve(null);
            }
            console.log("[SOULSEEK] Connected successfully.");
            globalSlskClient = client;
            resolve(client);
        });
    });
}

const app = express();
const port = RT.PORT;
const host = RT.HOST;
const musicDirectory = path.isAbsolute(config.music_directory || '')
    ? config.music_directory
    : path.resolve(RT.DATA_ROOT, (config.music_directory || '../MusicLibrary/uploads').replace(/^\.\.[\\/]/, ''));
const musicLibraryOwner = config.music_library_owner || 'Shared Library';
const supportedMusicExtensions = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm']);
const METADATA_PIPELINE_VERSION = 'folder-scanner-v1';
const METADATA_LOOKUP_MODES = new Set(['local_only', 'text_only', 'acoustic_with_text_fallback']);
const DEFAULT_METADATA_LOOKUP_MODE = 'local_only';
const MAX_ACOUSTID_KEY_LENGTH = 128;

/* --- Transport: HTTP by default, HTTPS when certificates are present --- */
// Browsers only expose service workers, Cache Storage, Wake Lock and the PWA
// install prompt on a "secure context". localhost always qualifies, so the
// desktop app is never degraded, but a phone hitting http://192.168.x.x is.
// Dropping a keypair into SSL/ upgrades every LAN client to the full feature
// set. See runtime.detectSsl() for the accepted filenames.
const sslConfig = RT.detectSsl();
let httpServer;

if (sslConfig.enabled) {
    try {
        httpServer = https.createServer({
            key: fs.readFileSync(sslConfig.key),
            cert: fs.readFileSync(sslConfig.cert),
        }, app);
        console.log(`[TLS] HTTPS enabled using certificates from ${sslConfig.source}.`);
    } catch (err) {
        console.error('[TLS] Failed to load certificates, falling back to HTTP:', err.message);
        httpServer = http.createServer(app);
        sslConfig.enabled = false;
        sslConfig.reason = `certificate load error: ${err.message}`;
    }
} else {
    httpServer = http.createServer(app);
}

const isSecureTransport = sslConfig.enabled;
const { Server } = require("socket.io");
const io = new Server(httpServer, {
    cors: {
        // Mirrors the Express CORS policy below (isTrustedOrigin). Socket.IO is
        // additionally gated by the session-cookie check in io.use().
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            return callback(null, isTrustedOrigin(origin));
        },
        credentials: true
    }
});
app.set('io', io);

/* --- Socket.io Cookie Parser Helper --- */
function parseCookies(cookieString) {
    const list = {};
    if (!cookieString) return list;
    cookieString.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        if (parts.length > 1) {
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        }
    });
    return list;
}

// --- Socket.io Authentication Middleware ---
io.use(async (socket, next) => {
    try {
        const cookies = parseCookies(socket.handshake.headers.cookie);
        const sessionId = cookies.session_id;

        if (!sessionId) {
            return next(new Error("Authentication error: No session ID"));
        }

        const username = await Auth.getSessionUser(sessionId);
        if (!username) {
            return next(new Error("Authentication error: Invalid session"));
        }

        // Attach username to socket for later use
        socket.username = username;
        next();
    } catch (err) {
        console.error("[SOCKET AUTH]", err);
        next(new Error("Internal Server Error"));
    }
});

io.on('connection', (socket) => {
    // Automatically join the user's private notification room
    if (socket.username) {
        socket.join(`user:${socket.username}`);
        console.log(`[SOCKET] User connected & joined: user:${socket.username}`);
    }

    // --- WebSocket Rate Limiting ---
    let packetCount = 0;
    const packetLimit = 50; // Max events per second
    let lastReset = Date.now();

    socket.use((packet, next) => {
        const now = Date.now();
        if (now - lastReset > 1000) {
            packetCount = 0;
            lastReset = now;
        }

        packetCount++;
        if (packetCount > packetLimit) {
            console.warn(`[SOCKET DOS] User '${socket.username}' exceeded rate limit. Disconnecting.`);
            return socket.disconnect(true);
        }
        next();
    });

    socket.on('disconnect', () => {
        // Log clean-up if needed
    });

    // Handle manual skipping of Soulseek downloads
    socket.on('skip_soulseek', (data) => {
        if (!socket.username || !data.song) return;
        const downloadId = `${socket.username}:${data.song}`;
        const download = activeSoulseekDownloads.get(downloadId);
        if (download) {
            console.log(`[SOULSEEK] Manual skip requested by ${socket.username} for: ${data.song}`);
            download.skipped = true; // Mark for search-phase skip if applicable
            if (download.resolve) download.resolve({ success: false });
            activeSoulseekDownloads.delete(downloadId);
        } else {
            // Mark as skipped even if not downloading yet (for search phase)
            activeSoulseekDownloads.set(downloadId, { skipped: true });
            setTimeout(() => activeSoulseekDownloads.delete(downloadId), 30000);
        }
    });

    socket.on('skip_all_soulseek', () => {
        if (!socket.username) return;
        const imp = activeImports.get(socket.username);
        if (imp) {
            imp.skipSoulseek = true;
            console.log(`[IMPORT] ${socket.username} requested skipping Soulseek for all remaining tracks.`);
            // Also skip current one
            for (const [key, dl] of activeSoulseekDownloads.entries()) {
                if (key.startsWith(`${socket.username}:`)) {
                    dl.resolve({ success: false });
                    activeSoulseekDownloads.delete(key);
                }
            }
        }
    });

    socket.on('stop_import', () => {
        if (!socket.username) return;
        const imp = activeImports.get(socket.username);
        if (imp) {
            imp.cancelled = true;
            console.log(`[IMPORT] ${socket.username} requested stopping the entire import.`);
            // Also kill current download
            for (const [key, dl] of activeSoulseekDownloads.entries()) {
                if (key.startsWith(`${socket.username}:`)) {
                    dl.resolve({ success: false });
                    activeSoulseekDownloads.delete(key);
                }
            }
        }
    });
});

// Direct LAN clients must not be able to spoof their address with
// X-Forwarded-For. Deployments behind a known reverse proxy can opt in with a
// hop count or an Express-compatible subnet/IP list.
const trustedProxy = (process.env.STREAMIFY_TRUST_PROXY || '').trim();
if (trustedProxy) {
    app.set('trust proxy', /^\d+$/.test(trustedProxy)
        ? Number(trustedProxy)
        : trustedProxy.split(',').map(value => value.trim()).filter(Boolean));
}

/* --- Cover art download helper --- */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        proto.get(url, response => {
            if (response.statusCode !== 200) {
                file.close();
                fs.unlink(dest, () => { });
                return reject(new Error(`HTTP ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', err => { fs.unlink(dest, () => { }); reject(err); });
        }).on('error', err => { fs.unlink(dest, () => { }); reject(err); });
    });
}

// --- Initialize Database ---
let initializationPromise = null;

function initializeServer() {
    if (!initializationPromise) {
        initializationPromise = (async () => {
            await HandleDatabase.createUsersTable();
            await HandleDatabase.createSongsTable();
            await HandleDatabase.createMetadataTables();
            await HandleDatabase.createSessionsTable();
            await HandleDatabase.createTelemetryTable();
            await HandleDatabase.createPlaylistsTable();
            await HandleDatabase.createPlaylistSongsTable();
            await HandleDatabase.createSystemLogsTable();
            await HandleDatabase.createSystemConfigTable();
            await HandleDatabase.createLyricsTable();

            // Configuration and scans can rely on every table being ready here.
            await initializeConfig();
            console.log("[INIT] Config sync complete.");
            await syncMusicDirectory();
            await HandleDatabase.recalculateAllStorageUsed();
            await HandleDatabase.migrateLyrics();
            const resumableJobs = await HandleDatabase.recoverEnrichmentJobs();
            resumableJobs.forEach(job => startEnrichmentWorker(job.id));
            console.log("[INIT] Database initialization complete.");
        })();
    }
    return initializationPromise;
}

// --- Automated Maintenance ---
let maintenanceScheduled = false;
let initialBackupTimer = null;
let backupInterval = null;
function scheduleAutomatedMaintenance() {
    if (maintenanceScheduled) return;
    maintenanceScheduled = true;

    // Initial backup on startup (wait 3s for DB to settle)
    initialBackupTimer = setTimeout(() => {
        HandleDatabase.backupDatabase().catch(err => console.error('[DB] Initial backup failed:', err));
    }, 3000);

    // Day-cycle backup every 24 hours
    backupInterval = setInterval(() => {
        HandleDatabase.backupDatabase().catch(err => console.error('[DB] Scheduled backup failed:', err));
    }, 24 * 60 * 60 * 1000);
}

// --- Middleware ---
/* --- CORS ---
 * Streamify serves its own frontend, so normal traffic is same-origin and CORS
 * never applies. The policy below exists for the cases that AREN'T same-origin:
 * a phone on the LAN, a Tailscale address, or a Cloudflare Tunnel hostname.
 *
 * We deliberately do NOT use `origin: true` (reflect anything). Because
 * credentials are enabled, reflecting arbitrary origins would let any website
 * the user visits make authenticated requests to their Streamify instance if it
 * could guess the LAN address. Instead we allow loopback, private LAN ranges,
 * and any hostname explicitly listed in FRONTEND_URL.
 */
const EXTRA_ORIGINS = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

function isTrustedOrigin(origin) {
    if (EXTRA_ORIGINS.includes(origin.replace(/\/$/, ''))) return true;

    let hostname;
    try {
        hostname = new URL(origin).hostname;
    } catch {
        return false;
    }

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname.endsWith('.local')) return true;                 // mDNS / Bonjour
    if (/^10\./.test(hostname)) return true;                      // private class A
    if (/^192\.168\./.test(hostname)) return true;                // private class C
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // private class B
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return true; // CGNAT (Tailscale)

    return false;
}

function isAllowedHttpOrigin(origin, req) {
    if (!origin) return true;
    const normalizedOrigin = origin.replace(/\/$/, '');
    if (EXTRA_ORIGINS.includes(normalizedOrigin)) return true;

    try {
        const requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
        return new URL(origin).origin === requestOrigin;
    } catch {
        return false;
    }
}

app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !isAllowedHttpOrigin(origin, req)) {
        return res.status(403).json({ error: 'Origin not allowed' });
    }
    next();
});
app.use(cors({ origin: true, credentials: true }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(compression({
    threshold: 1024,
    filter: (req, res) => !req.headers.range && compression.filter(req, res)
}));
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
});

// Rate Limiters
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: (req) => app.locals.config.ratelimits.api || 200,
    message: { error: "Too Many Requests. Slow down!" }
});

// Stricter limit for social actions (likes)
const socialLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: (req) => app.locals.config.ratelimits.social || 20,
    message: { error: "You're liking too fast! Slow down." }
});

const commentLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: (req) => app.locals.config.ratelimits.comment || 10,
    message: { error: "You're commenting too fast! Please wait a moment." }
});

const postLimiter = rateLimit({
    windowMs: 15 * 1000,
    limit: (req) => app.locals.config.ratelimits.post || 1,
    message: { error: "You're posting too fast! There is a 15-second cooldown between posts." }
});

const profileUpdateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 2,
    message: { error: "You're updating your profile too frequently. Please wait a minute." }
});

const avatarUploadLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 1,
    message: { error: "You're uploading avatars too frequently. Please wait a minute." }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many login/registration attempts. Please try again in 15 minutes." }
});

// Limit for Widget updates
const widgetLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    message: { error: "Too many widget updates. Please slow down." }
});

const dmRequestLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    message: { error: "Too many DM requests. Please wait a moment." }
});

const dmMessageLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    message: { error: "You're sending messages too fast. Please slow down." }
});

const youtubeDownloadLimiter = rateLimit({
    windowMs: parseInt(process.env.YOUTUBE_LIMIT_WINDOW_MS) || (5 * 60 * 1000),
    limit: (req) => app.locals.config.ratelimits.youtube_max || 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: `YouTube limit reached. Please wait some time before downloading another song.` }
});

const youtubeMetadataLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    standardHeaders: false,
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait a minute." }
});

// --- YouTube Stealth & Global Sync ---
let lastYoutubeRequestTime = 0;
const YOUTUBE_GLOBAL_COOLDOWN_MS = 5000; // 5 seconds between ANY two YouTube requests

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function extractYoutubeId(url) {
    const regex = /(?:v=|be\/|embed\/|v\/|watch\?v=|&v=)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

async function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function getMusicFiles(directory) {
    if (!fs.existsSync(directory)) return [];

    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...getMusicFiles(entryPath));
        } else if (supportedMusicExtensions.has(path.extname(entry.name).toLowerCase())) {
            files.push(entryPath);
        }
    }
    return files;
}

function getMusicDirectories() {
    let dirs = app.locals.config ? app.locals.config.music_directories : null;
    if (!Array.isArray(dirs) || dirs.length === 0) {
        dirs = Array.isArray(config.music_directories) && config.music_directories.length > 0
            ? config.music_directories
            : [config.music_directory || '../MusicLibrary/uploads'];
    }
    // Relative entries are historically written as "../MusicLibrary/uploads"
    // (relative to Server/). Normalise them against the data root so packaged
    // installs and clones both resolve to the right place.
    return dirs.map(d => path.isAbsolute(d)
        ? d
        : path.resolve(RT.DATA_ROOT, d.replace(/^\.\.[\\/]/, '')));
}

function toStoredMusicPath(filePath) {
    const absolutePath = path.resolve(filePath);
    const relativePath = path.relative(RT.DATA_ROOT, absolutePath);
    const isInsideDataRoot = relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath);
    return (isInsideDataRoot ? relativePath : absolutePath).replace(/\\/g, '/');
}

function isPathInside(root, candidate) {
    const relativePath = path.relative(root, candidate);
    return relativePath === '' || (
        relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath)
    );
}

const musicPathKey = value => HandleDatabase.getSongPathKey(value);
let musicScanPromise = null;

function metadataValues(value) {
    const values = Array.isArray(value) ? value : [value];
    return values
        .flatMap(item => Array.isArray(item) ? item : [item])
        .map(item => typeof item === 'string' ? item.trim() : item)
        .filter(item => item !== null && item !== undefined && item !== '');
}

function metadataYear(common) {
    const directYear = Number(common.year);
    if (Number.isInteger(directYear) && directYear >= 1000 && directYear <= 9999) return directYear;
    for (const value of [common.date, common.releasedate, common.originaldate]) {
        const match = /(?:^|\D)(\d{4})(?:\D|$)/.exec(String(value || ''));
        if (match) return Number(match[1]);
    }
    return null;
}

function embeddedMetadataEvidence(common, format, durationMs) {
    const provenance = {};
    const add = (field, value) => {
        if (value === null || value === undefined || value === '') return;
        if (Array.isArray(value) && value.length === 0) return;
        provenance[field] = value;
    };

    add('title', common.title);
    add('artist', common.artist);
    add('artists', metadataValues(common.artists));
    add('album', common.album);
    add('album_artist', common.albumartist);
    add('genres', metadataValues(common.genre));
    add('year', metadataYear(common));
    add('date', common.date);
    add('release_date', common.releasedate);
    add('original_date', common.originaldate);
    add('track_number', common.track && common.track.no);
    add('track_total', common.track && common.track.of);
    add('disc_number', common.disk && common.disk.no);
    add('disc_total', common.disk && common.disk.of);
    add('composer', metadataValues(common.composer));
    add('conductor', metadataValues(common.conductor));
    add('lyricist', metadataValues(common.lyricist));
    add('remixer', metadataValues(common.remixer));
    add('label', metadataValues(common.label));
    add('catalog_number', metadataValues(common.catalogno));
    add('barcode', common.barcode);
    add('release_country', common.releasecountry);
    add('isrc', metadataValues(common.isrc));
    add('acoustid_fingerprint', common.acoustid_fingerprint);
    add('duration_ms', durationMs);
    add('bitrate', format.bitrate || null);
    add('codec', format.codec);
    add('container', format.container);

    const identifiers = [];
    const addIdentifiers = (type, value) => {
        for (const identifier of metadataValues(value)) {
            identifiers.push({ type, value: String(identifier) });
        }
    };
    addIdentifiers('isrc', common.isrc);
    addIdentifiers('musicbrainz_recording', common.musicbrainz_recordingid);
    addIdentifiers('musicbrainz_release_track', common.musicbrainz_trackid);
    addIdentifiers('musicbrainz_release', common.musicbrainz_albumid);
    addIdentifiers('musicbrainz_release_group', common.musicbrainz_releasegroupid);
    addIdentifiers('musicbrainz_artist', common.musicbrainz_artistid);
    addIdentifiers('musicbrainz_album_artist', common.musicbrainz_albumartistid);
    addIdentifiers('musicbrainz_work', common.musicbrainz_workid);
    addIdentifiers('acoustid', common.acoustid_id);

    return { provenance, identifiers };
}

function findExistingSongCover(song) {
    const candidates = [];
    if (song && typeof song.cover_path === 'string' && song.cover_path.trim()) {
        candidates.push(path.basename(song.cover_path.split('?')[0]));
    }
    if (song && song.filepath) {
        const baseName = path.basename(song.filepath, path.extname(song.filepath));
        for (const extension of ['.jpg', '.jpeg', '.png', '.webp']) {
            candidates.push(`${baseName}${extension}`);
        }
    }
    for (const filename of candidates) {
        if (!/\.(?:jpe?g|png|webp)$/i.test(filename)) continue;
        if (fs.existsSync(path.join(RT.paths.covers, filename))) {
            return `/Static/covers/${filename}`;
        }
    }
    return null;
}

function saveEmbeddedPicture(picture, songUid) {
    if (!picture || !picture.data || !songUid) return null;
    const extensions = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp'
    };
    const extension = extensions[String(picture.format || '').toLowerCase()];
    if (!extension) return null;
    if (!fs.existsSync(RT.paths.covers)) fs.mkdirSync(RT.paths.covers, { recursive: true });
    const filename = `${songUid}${extension}`;
    const destination = path.join(RT.paths.covers, filename);
    if (!fs.existsSync(destination)) fs.writeFileSync(destination, picture.data);
    return `/Static/covers/${filename}`;
}

function syncMusicDirectory() {
    if (musicScanPromise) return musicScanPromise;

    const scan = performMusicDirectorySync();
    musicScanPromise = scan;
    scan.then(
        () => { if (musicScanPromise === scan) musicScanPromise = null; },
        () => { if (musicScanPromise === scan) musicScanPromise = null; }
    );
    return scan;
}

async function performMusicDirectorySync() {
    // Song filepaths are stored relative to the data root when they live inside
    // it, and absolute otherwise. Keeps the DB portable across installs.
    const targetDirs = getMusicDirectories().map(dir => path.resolve(dir));
    if (targetDirs.length === 0) {
        console.warn('[MUSIC SCAN] No music directories are configured; skipping scan and cleanup.');
        return 0;
    }
    const successfulDirs = new Set();
    const discoveredFiles = new Map();

    for (const dir of targetDirs) {
        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const files = getMusicFiles(dir);
            successfulDirs.add(musicPathKey(dir));
            for (const file of files) {
                const resolvedFile = path.resolve(file);
                discoveredFiles.set(musicPathKey(resolvedFile), resolvedFile);
            }
        } catch (err) {
            console.error(`[MUSIC SCAN] Directory access error for ${dir}:`, err.message);
        }
    }

    const allFiles = Array.from(discoveredFiles.values());
    const indexedPaths = new Set(allFiles.map(filePath => musicPathKey(toStoredMusicPath(filePath))));
    const indexedSongs = await HandleDatabase.getAllSongs({ includeUnavailable: true });
    const missingSongIds = new Set();
    for (const song of indexedSongs) {
        const indexedPathKey = song.path_key || musicPathKey(song.filepath);
        if (song.source !== 'folder' || song.availability === 'removed' || indexedPaths.has(indexedPathKey)) continue;

        const absoluteSongPath = path.isAbsolute(song.filepath)
            ? path.resolve(song.filepath)
            : path.resolve(RT.DATA_ROOT, song.filepath);
        const matchingRoots = targetDirs.filter(dir => isPathInside(dir, absoluteSongPath));
        const rootWasRemoved = matchingRoots.length === 0;
        const rootScannedSuccessfully = matchingRoots.some(dir => successfulDirs.has(musicPathKey(dir)));
        if (rootWasRemoved || rootScannedSuccessfully) missingSongIds.add(song.id);
    }
    const missingCandidatesByHash = new Map();
    for (const song of indexedSongs) {
        if (!missingSongIds.has(song.id) || !song.file_hash) continue;
        const candidates = missingCandidatesByHash.get(song.file_hash) || [];
        candidates.push(song);
        missingCandidatesByHash.set(song.file_hash, candidates);
    }

    let synced = 0;
    for (const filePath of allFiles) {
        try {
            const stats = fs.statSync(filePath);
            if (!stats.isFile()) continue;
            const filepath = toStoredMusicPath(filePath);
            const pathKey = musicPathKey(filepath);
            const fileMtimeMs = Math.trunc(stats.mtimeMs);
            let existing = await HandleDatabase.getSongByPathKey(pathKey);
            let precomputedHash = null;
            const hasCanonicalIdentity = Boolean(existing && (
                existing.recording_uid || existing.identification_method ||
                existing.metadata_status === 'identified' || existing.ai_enriched === 1
            ));

            if (existing && existing.file_hash &&
                Number(existing.file_size_bytes) === stats.size &&
                Number(existing.file_mtime_ms) === fileMtimeMs) {
                if (hasCanonicalIdentity) {
                    precomputedHash = await getFileHash(filePath);
                    if (precomputedHash !== existing.file_hash) {
                        // Continue through full parsing and identity invalidation.
                    } else {
                        await HandleDatabase.updateSongScanEvidence(existing.id, {
                            filepath,
                            path_key: pathKey,
                            uploaded_by: musicLibraryOwner,
                            is_private: 'public',
                            source: 'folder',
                            availability: 'available'
                        });
                        synced++;
                        continue;
                    }
                } else {
                    await HandleDatabase.updateSongScanEvidence(existing.id, {
                        filepath,
                        path_key: pathKey,
                        uploaded_by: musicLibraryOwner,
                        is_private: 'public',
                        source: 'folder',
                        availability: 'available'
                    });
                    synced++;
                    continue;
                }
            }

            // duration:true asks parsers that need a full scan to calculate the
            // precise duration. Embedded artwork comes from this same parse.
            const parsed = await mm.parseFile(filePath, { duration: true });
            const common = parsed.common || {};
            const format = parsed.format || {};
            const fileHash = precomputedHash || await getFileHash(filePath);
            const durationMs = Number.isFinite(format.duration) ? Math.max(0, Math.round(format.duration * 1000)) : 0;
            const rawBitrate = Number(format.bitrate) || 0;
            const songBitrate = rawBitrate > 1000 ? Math.round(rawBitrate / 1000) : (Math.round(rawBitrate) || 128);
            const evidence = embeddedMetadataEvidence(common, format, durationMs);

            if (!existing) {
                const moveCandidates = (missingCandidatesByHash.get(fileHash) || [])
                    .filter(candidate => missingSongIds.has(candidate.id));
                if (moveCandidates.length === 1) {
                    existing = moveCandidates[0];
                    missingSongIds.delete(existing.id);
                }
            }

            let song;
            let embeddedEvidencePersisted = false;
            if (!existing) {
                const songUid = crypto.randomUUID();
                const coverPath = saveEmbeddedPicture(common.picture && common.picture[0], songUid);
                const title = common.title || path.parse(filePath).name;
                const artists = metadataValues(common.artists);
                const artist = common.artist || artists.join(', ') || 'Unknown Artist';
                const genres = metadataValues(common.genre);
                const hasEmbeddedIdentity = Boolean(common.title || common.artist || artists.length > 0);
                await HandleDatabase.insertSong(
                    title,
                    artist,
                    common.album || 'Unknown Album',
                    genres[0] || 'Unknown Genre',
                    Math.round(durationMs / 1000),
                    filepath,
                    musicLibraryOwner,
                    'public',
                    null,
                    fileHash,
                    songBitrate,
                    'folder',
                    metadataYear(common),
                    0,
                    coverPath,
                    {
                        song_uid: songUid,
                        path_key: pathKey,
                        duration_ms: durationMs,
                        file_size_bytes: stats.size,
                        file_mtime_ms: fileMtimeMs,
                        availability: 'available',
                        metadata_status: hasEmbeddedIdentity ? 'unreviewed' : 'unknown',
                        metadata_pipeline_version: METADATA_PIPELINE_VERSION,
                        metadata_source: hasEmbeddedIdentity ? 'embedded' : 'filename'
                    }
                );
                song = await HandleDatabase.getSongByPathKey(pathKey);
            } else {
                const hashChanged = existing.file_hash
                    ? existing.file_hash !== fileHash
                    : hasCanonicalIdentity;
                // A matching content hash means metadata evidence is unchanged;
                // size/mtime differences alone should not force another review.
                const scanEvidenceChanged = false;
                const updates = {
                    filepath,
                    path_key: pathKey,
                    duration: Math.round(durationMs / 1000),
                    duration_ms: durationMs,
                    file_hash: fileHash,
                    file_size_bytes: stats.size,
                    file_mtime_ms: fileMtimeMs,
                    bitrate: songBitrate,
                    uploaded_by: musicLibraryOwner,
                    is_private: 'public',
                    source: 'folder',
                    availability: 'available'
                };

                const existingCover = findExistingSongCover(existing);
                const preservedCover = existingCover ||
                    saveEmbeddedPicture(common.picture && common.picture[0], existing.song_uid);
                if (preservedCover && (!existing.cover_path || !existingCover)) updates.cover_path = preservedCover;
                if (hashChanged) {
                    const invalidation = await HandleDatabase.invalidateSongIdentityForFileReplacement(
                        existing.id,
                        updates,
                        {
                            previousFileHash: existing.file_hash,
                            embeddedProvenance: evidence.provenance,
                            embeddedIdentifiers: evidence.identifiers
                        }
                    );
                    if (!invalidation.invalidated) {
                        throw new Error('Song identity changed concurrently during file replacement');
                    }
                    embeddedEvidencePersisted = true;
                    song = {
                        ...existing,
                        ...updates,
                        recording_uid: null,
                        identified_release_uid: null,
                        identified_release_track_uid: null,
                        identity_artist_credit_json: null,
                        identification_method: null,
                        identification_source: null,
                        identification_confidence: null,
                        ai_enriched: 0,
                        metadata_status: 'conflict',
                        metadata_revision: invalidation.metadataRevision
                    };
                } else {
                    await HandleDatabase.updateSongScanEvidence(existing.id, updates, {
                        evidenceChanged: scanEvidenceChanged
                    });
                    song = {
                        ...existing,
                        ...updates,
                        ...(scanEvidenceChanged ? {
                            metadata_status: existing.metadata_status === 'conflict' ? 'conflict' : 'review',
                            metadata_revision: (Number(existing.metadata_revision) || 0) + 1
                        } : {})
                    };
                }
            }

            if (!song) throw new Error('Song row was not created');
            if (!embeddedEvidencePersisted) {
                await HandleDatabase.replaceMetadataProvenance(song.id, evidence.provenance, 'embedded');
                await HandleDatabase.replaceExternalIdentifiers(song.id, evidence.identifiers, 'embedded');
            }
            synced++;
        } catch (err) {
            console.error(`[MUSIC SCAN] Failed to index ${filePath}:`, err.message);
        }
    }

    // Publish missing state only after same-hash move reconciliation completes.
    await HandleDatabase.setSongsAvailability([...missingSongIds], 'missing');

    console.log(`[MUSIC SCAN] Indexed ${synced} file(s) across ${targetDirs.length} directory/directories`);
    return synced;
}

async function ensureYoutubeCooldown() {
    const now = Date.now();
    const elapsed = now - lastYoutubeRequestTime;
    if (elapsed < YOUTUBE_GLOBAL_COOLDOWN_MS) {
        const waitTime = YOUTUBE_GLOBAL_COOLDOWN_MS - elapsed;
        console.log(`[YOUTUBE COOLDOWN] Queuing request... waiting ${waitTime}ms to respect global limit.`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastYoutubeRequestTime = Date.now();
}

app.use('/api/', (req, res, next) => {
    // Audio players can issue many Range requests while seeking. Keep those
    // outside the general JSON API budget so valid playback cannot become a
    // JSON 429 response mid-track.
    if (req.path.startsWith('/stream/')) return next();
    return apiLimiter(req, res, next);
});

// --- Static Serves ---
// /Static is layered: user-generated media (covers, avatars, banners) lives in
// the writable data directory, while the app's own HTML/CSS/JS ships read-only
// with the install. Express tries each handler in order, so the data directory
// is checked first and falls through to the bundled assets.
// When DATA_ROOT === REPO_ROOT (a normal git clone) both point at the same
// place and this behaves exactly as it did before.
if (RT.DATA_ROOT !== RT.REPO_ROOT) {
    app.use('/Static', express.static(path.join(RT.DATA_ROOT, 'Static')));
}
app.use('/Static', express.static(RT.paths.static));
app.use('/banners', express.static(RT.paths.banners)); // Quick access to banners
app.use('/special/', express.static(path.join(RT.paths.static, 'home', 'special'))); // Special assets for 404 page

// --- Multer Configuration ---
const uploadSongStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempDir = RT.paths.temp;
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
    },
    filename: (req, file, cb) => {
        // Keep it clean without timestamps here, we use hashes for the final storage anyway
        cb(null, file.originalname);
    }
});
const uploadSong = multer({
    storage: uploadSongStorage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.mp3', '.wav', '.m4a', '.flac', '.ogg'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only audio files are allowed (.mp3, .wav, .m4a, .flac, .ogg)"));
        }
    }
});

const uploadAvatarStorage = multer.memoryStorage();
const uploadAvatar = multer({
    storage: uploadAvatarStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed (.jpg, .jpeg, .png, .webp)"));
        }
    }
});

const uploadBanner = multer({
    storage: uploadAvatarStorage, // reuse memory storage
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB limit for banners
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed (.jpg, .jpeg, .png, .webp)"));
        }
    }
});

const uploadFeedImage = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

const uploadCover = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});

// --- Auth Helper ---
const getCurrentUser = async (req) => {
    if (req.cookies && req.cookies.session_id) {
        return await Auth.getSessionUser(req.cookies.session_id);
    }
    return null;
};

const canAccessSong = (song, username) => Boolean(song) && (
    !song.availability || song.availability === 'available'
) && (
    song.source === 'folder' ||
    song.is_private === 'public' ||
    (username && song.uploaded_by === username)
);

const songIdentityContract = (song) => {
    let artistCredits = [];
    try {
        const parsed = typeof song.identity_artist_credit_json === 'string'
            ? JSON.parse(song.identity_artist_credit_json)
            : song.identity_artist_credit_json;
        if (Array.isArray(parsed)) artistCredits = parsed;
    } catch { /* malformed legacy identity data is omitted */ }
    return {
        uid: song.song_uid || null,
        recording_uid: song.recording_uid || null,
        release_uid: song.identified_release_uid || null,
        release_track_uid: song.identified_release_track_uid || null,
        artist_uids: artistCredits.map(credit => credit && credit.artist_uid).filter(Boolean),
        artist_credits: artistCredits,
        identification_method: song.identification_method || null,
        identification_source: song.identification_source || null,
        identification_confidence: song.identification_confidence !== null && song.identification_confidence !== undefined &&
            Number.isFinite(Number(song.identification_confidence))
            ? Number(song.identification_confidence)
            : null,
        duration_ms: song.duration_ms === null || song.duration_ms === undefined
            ? Math.max(0, Math.round((Number(song.duration) || 0) * 1000))
            : Number(song.duration_ms),
        metadata_status: song.metadata_status || 'unreviewed',
        genre: song.genre || null,
        year: song.year || null,
        source: song.source || 'upload'
    };
};

const resolveSongCover = (song) => {
    if (song && typeof song.cover_path === 'string' && song.cover_path.trim()) {
        const filename = path.basename(song.cover_path.trim());
        if (/\.(?:jpe?g|png|webp)$/i.test(filename)) {
            const fullPath = path.join(RT.paths.covers, filename);
            if (fs.existsSync(fullPath)) {
                const version = Math.floor(fs.statSync(fullPath).mtimeMs);
                return `/Static/covers/${encodeURIComponent(filename)}?v=${version}`;
            }
        }
    }

    const filepath = song && song.filepath ? song.filepath : '';
    const baseName = filepath
        ? path.basename(filepath, path.extname(filepath))
        : String((song && (song.songname || song.id)) || 'cover');
    return Media.resolveCover(baseName);
};

const requireRole = (allowedRoles) => {
    return async (req, res, next) => {
        const user = await getCurrentUser(req);
        if (!user) {
            // Redirect HTML requests to login (only for non-API routes), JSON to 401
            if (req.accepts('html') && !req.originalUrl.startsWith('/api/')) {
                return res.redirect('/login');
            }
            return res.status(401).json({ error: "Unauthorized" });
        }

        const userRow = await HandleDatabase.getUser(user);
        if (!userRow) return res.status(401).json({ error: "User not found" });

        // Check if banned
        if (userRow.is_banned) return res.status(403).json({ error: "Your account is banned." });

        // Check timeout
        if (userRow.timeout_until && new Date(userRow.timeout_until) > new Date()) {
            return res.status(403).json({ error: `You are timed out until ${new Date(userRow.timeout_until).toLocaleString()}` });
        }

        if (allowedRoles.includes(userRow.role)) {
            req.user = user;
            req.userRow = userRow;
            next();
        } else {
            res.status(403).json({ error: "Forbidden: Insufficient permissions" });
        }
    };
};

// Compatibility wrapper for routes that just need any logged-in user
const requireLogin = requireRole(['Owner', 'Admin', 'Moderator', 'User']);

// --- Maintenance Middleware ---
const maintenanceMiddleware = async (req, res, next) => {
    // Reload config every time or keep in memory? 
    // Usually keep in memory is faster. We can update the memory when the config API is called.
    if (app.locals.config && app.locals.config.maintenance_mode) {
        // Exclude /maintenance page, /api/me (to check role), and static assets for maintenance.
        // /Static/vendor must be excluded too: the icon font, web font and
        // cropper library are served locally (previously they came from CDNs),
        // so without this the maintenance and login pages lose their styling.
        const excludedPaths = [
            '/maintenance', '/api/config/public', '/api/me', '/login', '/loginrequest',
            '/sw.js', '/manifest.json', '/favicon.ico', '/Static/icon-',
            '/Static/maintenance', '/Static/loginpage', '/Static/vendor'
        ];
        const isExcluded = excludedPaths.some(path => req.originalUrl.startsWith(path));

        if (!isExcluded) {
            const user = await getCurrentUser(req);
            const userRow = user ? await HandleDatabase.getUser(user) : null;
            const isAllowed = userRow && app.locals.config?.maintenance_allowed_roles?.includes(userRow.role);

            if (!isAllowed) {
                if (req.accepts('html') && !req.originalUrl.startsWith('/api/')) {
                    return res.redirect('/maintenance');
                }
                return res.status(503).json({ error: app.locals.config.maintenance_message });
            }
        }
    }
    next();
};


async function initializeConfig() {
    try {
        const dbConfig = await HandleDatabase.getSystemConfig();
        const configMap = {};
        dbConfig.forEach(row => {
            try {
                configMap[row.key] = JSON.parse(row.value);
            } catch {
                configMap[row.key] = row.value;
            }
        });

        // Migration from config.json if DB is empty
        if (dbConfig.length === 0) {
            console.log("[CONFIG] First run: Migrating config.json to database...");
            const initialConfig = {
                maintenance_mode: config.maintenance_mode || false,
                maintenance_allowed_roles: config.maintenance_allowed_roles || ["Owner", "Admin"],
                maintenance_message: config.maintenance_message || "Site is currently undergoing maintenance. Please check back later!",
                allow_registration: config.allow_registration ?? false,
                lockdown_new_posts: false,
                oobe_completed: false,
                metadata_lookup_mode: DEFAULT_METADATA_LOOKUP_MODE,
                acoustid_client_key: '',
                ratelimits: {
                    api: 200,
                    social: 20,
                    comment: 10,
                    post: 1,
                    youtube_max: 2,
                    youtube_duration: 600
                }
            };

            for (const [key, val] of Object.entries(initialConfig)) {
                await HandleDatabase.updateSystemConfig(key, JSON.stringify(val));
                configMap[key] = val;
            }
        } else {
            // Ensure essential keys exist
            if (!configMap.ratelimits) {
                configMap.ratelimits = { api: 200, social: 20, comment: 10, post: 1, youtube_max: 2, youtube_duration: 600 };
                await HandleDatabase.updateSystemConfig('ratelimits', JSON.stringify(configMap.ratelimits));
            }
            if (configMap.lockdown_new_posts === undefined) {
                configMap.lockdown_new_posts = false;
                await HandleDatabase.updateSystemConfig('lockdown_new_posts', JSON.stringify(configMap.lockdown_new_posts));
            }
            if (configMap.allow_registration === undefined) {
                configMap.allow_registration = false;
                await HandleDatabase.updateSystemConfig('allow_registration', JSON.stringify(false));
            }
            if (configMap.oobe_completed === undefined) {
                configMap.oobe_completed = false;
                await HandleDatabase.updateSystemConfig('oobe_completed', JSON.stringify(false));
            }
        }

        if (!METADATA_LOOKUP_MODES.has(configMap.metadata_lookup_mode)) {
            configMap.metadata_lookup_mode = DEFAULT_METADATA_LOOKUP_MODE;
            await HandleDatabase.updateSystemConfig('metadata_lookup_mode', JSON.stringify(DEFAULT_METADATA_LOOKUP_MODE));
        }
        if (configMap.acoustid_client_key === undefined || configMap.acoustid_client_key === null ||
            (configMap.acoustid_client_key !== '' && !validAcoustidKey(configMap.acoustid_client_key))) {
            configMap.acoustid_client_key = '';
            await HandleDatabase.updateSystemConfig('acoustid_client_key', JSON.stringify(''));
        }

        // Merge DB settings into existing config (don't overwrite whole object)
        const publicConfigMap = { ...configMap };
        delete publicConfigMap.acoustid_client_key;
        app.locals.config = { ...app.locals.config, ...publicConfigMap };
        console.log("[CONFIG] System settings loaded from database.");
    } catch (err) {
        console.error("[CONFIG] Critical Error loading configuration:", err);
        throw err;
    }
}

// Initialize config local cache with safe defaults
app.locals.config = {
    maintenance_mode: false,
    maintenance_allowed_roles: ["Owner", "Admin"],
    maintenance_message: "Site is currently undergoing maintenance.",
    allow_registration: false,
    lockdown_new_posts: false,
    metadata_lookup_mode: DEFAULT_METADATA_LOOKUP_MODE,
    ratelimits: { api: 200, social: 20, comment: 10, post: 1, youtube_max: 2, youtube_duration: 600 }
};

function parseStoredConfigValue(value) {
    if (value === null || value === undefined) return null;
    try { return JSON.parse(value); } catch { return value; }
}

function validAcoustidKey(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ACOUSTID_KEY_LENGTH &&
        value === value.trim() && !/[\u0000-\u001F\u007F]/u.test(value);
}

async function storedAcoustidKey() {
    const value = parseStoredConfigValue(await HandleDatabase.getSystemConfigValue('acoustid_client_key'));
    return validAcoustidKey(value) ? value : null;
}

async function effectiveAcoustidKey(storedOverride) {
    const environmentKey = process.env.ACOUSTID_CLIENT_KEY;
    if (validAcoustidKey(environmentKey)) return environmentKey;
    if (storedOverride !== undefined) return validAcoustidKey(storedOverride) ? storedOverride : null;
    return await storedAcoustidKey();
}

let fpcalcProbeCache = null;
async function probeFpcalc() {
    if (fpcalcProbeCache && fpcalcProbeCache.expiresAt > Date.now()) return fpcalcProbeCache.value;
    const resolved = Fingerprint.resolveFpcalc();
    const value = await new Promise(resolve => {
        if (!resolved || !resolved.executable) {
            resolve({ fpcalc_available: false, fpcalc_source: null });
            return;
        }
        let settled = false;
        let child;
        let timer = null;
        const finish = available => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({
                fpcalc_available: available,
                fpcalc_source: available ? resolved.source : null
            });
        };
        try {
            child = spawn(resolved.executable, ['-version'], {
                shell: false,
                windowsHide: true,
                stdio: 'ignore'
            });
        } catch {
            finish(false);
            return;
        }
        timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* process already exited */ }
            finish(false);
        }, 2000);
        timer.unref?.();
        child.once('error', () => finish(false));
        child.once('close', code => finish(code === 0));
    });
    fpcalcProbeCache = { value, expiresAt: Date.now() + 30_000 };
    return value;
}

function currentMetadataLookupMode() {
    const mode = app.locals.config && app.locals.config.metadata_lookup_mode;
    return METADATA_LOOKUP_MODES.has(mode) ? mode : DEFAULT_METADATA_LOOKUP_MODE;
}

function safeSystemConfigResponse() {
    const safe = { ...(app.locals.config || {}) };
    delete safe.acoustid_client_key;
    return safe;
}

async function metadataSettingsContract() {
    const [storedKey, fpcalc] = await Promise.all([storedAcoustidKey(), probeFpcalc()]);
    const environmentKey = validAcoustidKey(process.env.ACOUSTID_CLIENT_KEY)
        ? process.env.ACOUSTID_CLIENT_KEY
        : null;
    const key = environmentKey || storedKey;
    return {
        mode: currentMetadataLookupMode(),
        acoustid_configured: Boolean(key),
        acoustid_key_source: environmentKey ? 'environment' : (storedKey ? 'stored' : null),
        fpcalc_available: fpcalc.fpcalc_available,
        fpcalc_source: fpcalc.fpcalc_source
    };
}

// Register maintenance middleware SYNC before any routes
app.use(maintenanceMiddleware);



// --- Endpoints ---

// HTML Pages
app.get('/', (req, res) => res.redirect('/home'));

// PWA assets
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(RT.paths.static, 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(RT.paths.static, 'manifest.json'));
});
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(RT.paths.static, 'icon-192.png'));
});

app.get('/home', requireRole(['Owner', 'Admin', 'Moderator', 'User']), (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(RT.paths.static, 'home', 'home.html'));
});

app.get('/profile/:username', requireRole(['Owner', 'Admin', 'Moderator', 'User']), (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(RT.paths.static, 'home', 'home.html'));
});

app.get('/maintenance', (req, res) => {
    res.sendFile(path.join(RT.paths.static, 'maintenance', 'maintenance.html'));
});

app.get('/admin', requireRole(['Owner', 'Admin']), (req, res) => {
    // this shit still lives? LOL
    res.sendFile(path.join(RT.paths.static, 'home', 'special404.html'));
});


app.get('/login', async (req, res) => {
    const user = await getCurrentUser(req);
    if (user) return res.redirect('/home');

    const ip = req.ip;

    if (Auth.isBlocked(ip)) {
        if (req.query.blocked !== 'true') return res.redirect('/login?blocked=true');
    } else {
        const attempts = Auth.getAttempts(ip);
        if (!req.query.failed && !req.query.registered && !req.query.reg_failed && !req.query.blocked) {
            return res.redirect(`/login?failed=false&count=${attempts}`);
        }
    }

    try {
        const filePath = path.join(RT.paths.static, 'loginpage', 'login.html');
        let content = fs.readFileSync(filePath, 'utf-8');

        res.set('Content-Type', 'text/html');
        // Prevent caching of the login page to ensure latest JS/CSS are always linked
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.send(content);
    } catch (err) {
        console.error("Error serving login.html:", err);
        res.status(500).send("Server Error");
    }
});

// Login
function sessionCookieOptions(req, extra = {}) {
    const secure = Boolean(req.secure || isSecureTransport);
    let isCrossSite = false;
    const origin = req.get('Origin');
    if (origin) {
        try {
            const requestOrigin = new URL(`${req.protocol}://${req.get('host')}`).origin;
            isCrossSite = new URL(origin).origin !== requestOrigin;
        } catch { /* malformed origins are rejected by the origin middleware */ }
    }
    return {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: isCrossSite && secure ? 'none' : 'lax',
        ...extra
    };
}

function isLoopbackRequest(req) {
    const address = String(req.ip || req.socket.remoteAddress || '').toLowerCase();
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

app.post('/loginrequest', authLimiter, async (req, res) => {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];

    if (Auth.isBlocked(ip)) {
        return res.status(429).json({ error: "Too many failed attempts. Try again later." });
    }

    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' ||
        username.length > 32 || password.length > 128) {
        Auth.addAttempt(ip);
        return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = await HandleDatabase.getUser(username);

    if (user && await Auth.comparePassword(password, user.password)) {
        // Success
        Auth.resetAttempts(ip);
        const sessionId = await Auth.createSession(username, userAgent, ip);

        res.cookie('session_id', sessionId, sessionCookieOptions(req, {
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        }));

        return res.json({ success: true, message: "Logged in" });
    } else {
        Auth.addAttempt(ip);
        return res.status(401).json({ error: "Invalid credentials" });
    }
});

// Register
app.post('/register', authLimiter, async (req, res) => {
    const { username, password, email, confirm_password } = req.body;

    if (typeof username !== 'string' || typeof password !== 'string' || password !== confirm_password) {
        return res.status(400).json({ error: "Invalid inputs" });
    }

    if (username !== username.trim() || !/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
        return res.status(400).json({ error: "Username must be 3-32 characters using only letters, numbers, underscores, or hyphens." });
    }

    if (password.length < 6 || password.length > 128 || password.includes(" ") ||
        password.toLowerCase().includes(username.toLowerCase())) {
        return res.status(400).json({ error: "Weak password" });
    }

    const users = await HandleDatabase.getAllUsers();
    if (users.length === 0 && !isLoopbackRequest(req)) {
        return res.status(403).json({
            error: 'The Owner account must be created from this server using localhost.'
        });
    }
    if (users.length > 0 && app.locals.config.allow_registration !== true) {
        return res.status(403).json({ error: "Registration is disabled by the server owner." });
    }

    try {
        const hash = await Auth.hashPassword(password);
        const registration = await HandleDatabase.registerUser(
            username,
            hash,
            typeof email === 'string' ? email.trim() : '',
            app.locals.config.allow_registration === true
        );

        if (registration.status === 'registration_disabled') {
            return res.status(403).json({ error: "Registration is disabled by the server owner." });
        }
        if (registration.status === 'username_taken') {
            return res.status(409).json({ error: "Username taken" });
        }

        if (registration.isFirstAccount) {
            app.locals.config.allow_registration = false;
            console.log(`[REGISTER] Owner account registered: ${username}. Registration is now locked by default.`);
        } else {
            console.log(`[REGISTER] User account registered: ${username}`);
        }

        // Automatically log in the user upon registration
        const userAgent = req.headers['user-agent'] || "";
        const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const sessionId = await Auth.createSession(username, userAgent, ip);

        res.cookie('session_id', sessionId, sessionCookieOptions(req, {
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        }));

        return res.json({ success: true, message: "Registered", auto_logged_in: true });
    } catch (err) {
        console.error('[REGISTER]', err);
        return res.status(500).json({ error: "Registration failed" });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    const sessionId = req.cookies.session_id;
    if (sessionId) {
        await Auth.removeSession(sessionId);
    }
    res.cookie('session_id', '', sessionCookieOptions(req, { expires: new Date(0) }));
    return res.json({ success: true });
});

// API: public config
app.get('/api/config/public', async (req, res) => {
    const users = await HandleDatabase.getAllUsers();
    const isFreshInstall = users.length === 0;
    res.json({
        is_fresh_install: isFreshInstall,
        user_count: users.length,
        youtube_max: app.locals.config.ratelimits.youtube_max,
        youtube_duration: app.locals.config.ratelimits.youtube_duration,
        allow_registration: isFreshInstall || app.locals.config.allow_registration === true,
        setup_requires_localhost: isFreshInstall,
        maintenance_mode: app.locals.config.maintenance_mode,
        maintenance_message: app.locals.config.maintenance_message,
        oobe_completed: app.locals.config.oobe_completed === true
    });
});

app.post('/api/settings/registration', requireRole(['Owner']), async (req, res) => {
    const enabled = req.body.enabled === true;
    app.locals.config.allow_registration = enabled;
    await HandleDatabase.updateSystemConfig('allow_registration', JSON.stringify(enabled));
    res.json({ success: true, allow_registration: enabled });
});

app.get('/api/settings/metadata', requireRole(['Owner']), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await metadataSettingsContract());
});

app.post('/api/settings/metadata', requireRole(['Owner']), async (req, res) => {
    const mode = req.body && req.body.mode;
    if (typeof mode !== 'string' || mode.length > 64 || !METADATA_LOOKUP_MODES.has(mode)) {
        return res.status(400).json({ error: 'Invalid metadata lookup mode' });
    }

    const hasKey = Object.prototype.hasOwnProperty.call(req.body || {}, 'acoustid_client_key');
    const suppliedKey = hasKey ? req.body.acoustid_client_key : undefined;
    if (hasKey && !validAcoustidKey(suppliedKey)) {
        return res.status(400).json({ error: `AcoustID client key must be 1-${MAX_ACOUSTID_KEY_LENGTH} characters` });
    }
    const effectiveKey = await effectiveAcoustidKey(hasKey ? suppliedKey : undefined);
    if (mode === 'acoustic_with_text_fallback' && !effectiveKey) {
        return res.status(400).json({ error: 'An AcoustID client key is required for acoustic lookup' });
    }

    if (hasKey) {
        await HandleDatabase.updateSystemConfig('acoustid_client_key', JSON.stringify(suppliedKey));
    }
    await HandleDatabase.updateSystemConfig('metadata_lookup_mode', JSON.stringify(mode));
    app.locals.config.metadata_lookup_mode = mode;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...await metadataSettingsContract() });
});

app.delete('/api/settings/metadata/acoustid-key', requireRole(['Owner']), async (req, res) => {
    await HandleDatabase.updateSystemConfig('acoustid_client_key', JSON.stringify(''));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...await metadataSettingsContract() });
});

app.post('/api/config/oobe', requireRole(['Owner', 'Admin']), async (req, res) => {
    const completed = req.body.completed !== false;
    app.locals.config.oobe_completed = completed;
    await HandleDatabase.updateSystemConfig('oobe_completed', JSON.stringify(completed));
    res.json({ success: true, oobe_completed: completed });
});

// API: me
app.get('/api/me', requireLogin, async (req, res) => {
    const username = req.user;
    const userRow = await HandleDatabase.getUser(username);

    const avatarUrl = Media.resolveAvatar(username);

    res.json({
        username: username,
        display_name: userRow.display_name || username,
        bio: userRow.bio || "",
        avatar: avatarUrl,
        email: userRow.email || "nothing",
        storage_used: userRow.storage_used || 0,
        storage_limit: 314572800, // 300 MB
        likes_count: userRow.total_likes || 0,
        role: userRow.role || 'User',
        is_banned: userRow.is_banned || 0,
        timeout_until: userRow.timeout_until || null,
        banner: Media.resolveUserBanner(username),
        allow_analytics: userRow.allow_analytics === 1,
        allow_registration: app.locals.config.allow_registration === true,
        oobe_completed: app.locals.config.oobe_completed === true
    });
});

// API: update profile
app.post('/api/user/update-profile', requireLogin, profileUpdateLimiter, async (req, res) => {
    const { display_name, bio } = req.body;

    if (display_name && display_name.length > 30) {
        return res.status(400).json({ error: "Display name too long (max 30 chars)" });
    }
    if (bio && bio.length > 300) {
        return res.status(400).json({ error: "Bio too long (max 300 chars)" });
    }

    try {
        if (display_name !== undefined) {
            const isFlagged = await Moderation.isFlagged(display_name);
            if (!isFlagged) {
                await HandleDatabase.updateUser(req.user, "display_name", display_name);
            }
        }
        if (bio !== undefined) {
            const isFlagged = await Moderation.isFlagged(bio);
            if (!isFlagged) {
                await HandleDatabase.updateUser(req.user, "bio", bio);
            }
        }
        res.json({ success: true, message: "Profile updated" });
    } catch (err) {
        console.error('[PROFILE UPDATE]', err);
        res.status(500).json({ error: "Failed to update profile" });
    }
});

// API: change password
app.post('/api/user/change-password', requireLogin, async (req, res) => {
    const { old_password, new_password } = req.body;
    if (typeof old_password !== 'string' || typeof new_password !== 'string') {
        return res.status(400).json({ error: "Missing fields" });
    }
    if (new_password.length < 6 || new_password.length > 128 || new_password.includes(' ') ||
        new_password.toLowerCase().includes(String(req.user).toLowerCase())) {
        return res.status(400).json({ error: "Weak password" });
    }

    try {
        const user = await HandleDatabase.getUser(req.user);
        if (!await Auth.comparePassword(old_password, user.password)) {
            return res.status(401).json({ error: "Incorrect old password" });
        }

        const newHash = await Auth.hashPassword(new_password);
        await HandleDatabase.updateUser(req.user, "password", newHash);

        // Security: Invalidate all other sessions on password change
        const currentSessionId = req.cookies.session_id;
        await Auth.invalidateOtherSessions(req.user, currentSessionId);

        console.log(`[PASSWORD CHANGE] User '${req.user}' updated password. Other sessions invalidated.`);
        res.json({ success: true, message: "Password updated. Other devices have been logged out." });
    } catch (err) {
        console.error('[PASSWORD CHANGE]', err);
        res.status(500).json({ error: "Failed to change password" });
    }
});

// API: logout other devices
app.post('/api/user/logout-others', requireLogin, async (req, res) => {
    try {
        const currentSessionId = req.cookies.session_id;
        await Auth.invalidateOtherSessions(req.user, currentSessionId);

        console.log(`[LOGOUT OTHERS] User '${req.user}' logged out from other devices.`);
        res.json({ success: true, message: "Logged out from all other devices." });
    } catch (err) {
        console.error('[LOGOUT OTHERS]', err);
        res.status(500).json({ error: "Failed to logout from other devices" });
    }
});

// API: Privacy Settings
app.post('/api/settings/privacy/analytics', requireLogin, async (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') return res.status(400).json({ error: "Invalid setting" });
        await HandleDatabase.updateUser(req.user, "allow_analytics", enabled ? 1 : 0);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update privacy settings" });
    }
});

// API: Telemetry Export
app.get('/api/settings/privacy/export', requireLogin, async (req, res) => {
    try {
        const rawTelemetry = await HandleDatabase.getAllUserTelemetry(req.user);
        const stats = await HandleDatabase.getUserTelemetryStats(req.user);

        const payload = {
            username: req.user,
            exported_at: new Date().toISOString(),
            stats: stats,
            telemetry: rawTelemetry
        };

        res.setHeader('Content-disposition', 'attachment; filename=streamify_telemetry_export.json');
        res.setHeader('Content-type', 'application/json');
        res.send(JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('[EXPORT DATA]', err);
        res.status(500).json({ error: "Failed to export data" });
    }
});

// API: Telemetry Update
app.post('/api/telemetry/listen', requireLogin, async (req, res) => {
    try {
        const { song_id, listen_duration } = req.body;
        if (!song_id || !Number.isFinite(listen_duration) || listen_duration <= 0 || listen_duration > 60) {
            return res.status(400).json({ error: "Invalid data" });
        }

        const song = await HandleDatabase.getSong(song_id);
        if (!song) return res.status(404).json({ error: "Song not found" });
        if (!canAccessSong(song, req.user)) return res.status(403).json({ error: "Access Denied" });

        const userRow = await HandleDatabase.getUser(req.user);
        if (userRow.allow_analytics === 0) {
            // Silently ignore if opted out
            return res.json({ success: true, ignored: true });
        }

        let playCountDelta = 0;
        // Count as a play if they listened to at least 30 seconds in this chunk
        // Alternatively we can trust the client to just send listen_duration, and backend tallies plays.
        // Actually since we get chunks, it's safer to only increment play count if the chunk is >= 30,
        // or we can let the client explicitly signal "count_play" boolean when they cross the 30s mark.
        // For simplicity and resilience, we'll let the client pass play_count_delta: 0 or 1.
        if (req.body.play_count_delta === 1) {
            playCountDelta = 1;
        }

        await HandleDatabase.updateUserTelemetry(req.user, song_id, listen_duration, playCountDelta);
        res.json({ success: true });
    } catch (err) {
        console.error('[TELEMETRY]', err);
        res.status(500).json({ error: "Failed to update telemetry" });
    }
});

// API: Now Playing (for iOS Widget)
app.post('/api/widget/now-playing', widgetLimiter, async (req, res) => {
    // Accept session_id from header (iOS widget can't use cookies)
    const sessionId = req.cookies.session_id || req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: "Unauthorized" });

    const username = await Auth.getSessionUser(sessionId);
    if (!username) return res.status(401).json({ error: "Invalid session" });

    const { trackName, artist, albumArt, isPlaying, progress } = req.body;

    // Store it in memory (or your DB if you prefer persistence)
    app.locals.nowPlaying = app.locals.nowPlaying || {};
    app.locals.nowPlaying[username] = { trackName, artist, albumArt, isPlaying, progress };

    res.json({ success: true });
});

app.get('/api/widget/now-playing', async (req, res) => {
    const sessionId = req.cookies.session_id || req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: "Unauthorized" });

    const username = await Auth.getSessionUser(sessionId);
    if (!username) return res.status(401).json({ error: "Invalid session" });

    const data = (app.locals.nowPlaying || {})[username];
    if (!data) return res.json({ isPlaying: false });

    res.json(data);
});

// API: get active sessions
app.get('/api/user/sessions', requireLogin, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const sessions = await Auth.getUserSessions(req.user);
        res.json(sessions);
    } catch (err) {
        console.error('[GET SESSIONS]', err);
        res.status(500).json({ error: "Failed to fetch active sessions" });
    }
});

// API: revoke specific session
app.delete('/api/user/sessions/:id', requireLogin, async (req, res) => {
    const sessionId = req.params.id;
    try {
        const currentSessionId = req.cookies.session_id;
        if (sessionId === currentSessionId) {
            return res.status(400).json({ error: "You cannot revoke your current session here. Use logout instead." });
        }

        // Ensure the session belongs to the user
        const session = await HandleDatabase.getSession(sessionId);
        if (!session || session.username !== req.user) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        await Auth.removeSession(sessionId);
        console.log(`[REVOKE SESSION] User '${req.user}' revoked session: ${sessionId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[REVOKE SESSION]', err);
        res.status(500).json({ error: "Failed to revoke session" });
    }
});

// API: get lyrics
app.get('/api/lyrics/:songId', requireLogin, async (req, res) => {
    try {
        const songData = await HandleDatabase.getSong(req.params.songId);
        if (!songData) return res.status(404).json({ error: "Song not found" });

        if (!canAccessSong(songData, req.user)) {
            return res.status(403).json({ error: "Access Denied" });
        }

        const preferUser = req.query.prefer;
        let lyrics = null;

        // 1. Check preferred user (e.g. Playlist Owner)
        if (preferUser) {
            lyrics = await HandleDatabase.getLyricsBySongId(req.params.songId, preferUser);
        }

        // 2. Check requester's own lyrics
        if (!lyrics) {
            lyrics = await HandleDatabase.getLyricsBySongId(req.params.songId, req.user);
        }

        // 3. Fallback to uploader's lyrics
        if (!lyrics && songData.uploaded_by && songData.uploaded_by !== req.user && songData.uploaded_by !== preferUser) {
            lyrics = await HandleDatabase.getLyricsBySongId(req.params.songId, songData.uploaded_by);
        }

        // 4. MIGRATION FALLBACK: Orphaned lyrics
        if (!lyrics) {
            lyrics = await HandleDatabase.getLyricsBySongId(req.params.songId, ''); // Check for migrated-empty rows
            if (!lyrics) {
                lyrics = await HandleDatabase.getLyricsBySongId(req.params.songId, null); // Check for true NULLs
            }

            // If we found orphaned lyrics and the requester is the uploader, auto-migrate them now!
            if (lyrics && songData.uploaded_by === req.user) {
                console.log(`[AUTO-MIGRATION] Assigning lyrics for song ${req.params.songId} to uploader ${req.user}`);
                await HandleDatabase.saveLyrics(req.params.songId, req.user, lyrics.lyrics, lyrics.is_synced);
                await HandleDatabase.deleteLyrics(req.params.songId, '');
            }
        }

        if (lyrics) {
            res.json(lyrics);
        } else {
            res.status(404).json({ error: "Lyrics not found" });
        }
    } catch (err) {
        console.error('[LYRICS GET]', err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: save lyrics
app.post('/api/lyrics/:songId', requireLogin, async (req, res) => {
    const { lyrics, is_synced } = req.body;
    if (!lyrics) return res.status(400).json({ error: "Missing lyrics" });

    try {
        const songData = await HandleDatabase.getSong(req.params.songId);
        if (!songData) return res.status(404).json({ error: "Song not found" });

        // Anyone can save their own version of lyrics if they can access the song.
        if (canAccessSong(songData, req.user)) {
            await HandleDatabase.saveLyrics(req.params.songId, req.user, lyrics, is_synced);
            res.json({ success: true, message: "Lyrics saved" });
        } else {
            res.status(403).json({ error: "Forbidden" });
        }
    } catch (err) {
        console.error('[LYRICS SAVE]', err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// API: delete lyrics
app.delete('/api/lyrics/:songId', requireLogin, async (req, res) => {
    try {
        await HandleDatabase.deleteLyrics(req.params.songId, req.user);
        res.json({ success: true, message: "Lyrics deleted" });
    } catch (err) {
        console.error('[LYRICS DELETE]', err);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.use('/api/users', (req, res) => {
    res.status(404).json({ error: 'Social features are no longer available.' });
});

// API: users (retired)
app.get('/api/users', requireLogin, async (req, res) => {
    const users = await HandleDatabase.getAllUsers();
    const result = users.map(u => {
        return {
            id: u.id,
            username: u.username,
            display_name: u.display_name || u.username,
            bio: u.bio || "",
            avatar: Media.resolveAvatar(u.username),
            songs_count: u.uploaded_songs_count,
            likes_count: u.total_likes,
            role: u.role || 'User'
        }
    });
    res.json(result);
});

// API: search
app.get('/api/search', requireLogin, async (req, res) => {
    const queryStr = (req.query.q || '').toLowerCase();
    if (!queryStr) return res.json({ users: [], songs: [] });

    // Songs
    const allSongs = await HandleDatabase.getAllSongs();
    const matchingSongs = allSongs.filter(s => {
        if (s.hidden_from_library) return false;
        if (!canAccessSong(s, req.user)) return false;
        return String(s.songname || '').toLowerCase().includes(queryStr) ||
            String(s.artist || '').toLowerCase().includes(queryStr) ||
            String(s.album || '').toLowerCase().includes(queryStr);
    }).map(s => {
        const filePath = s.filepath || '';
        return {
            id: s.id,
            ...songIdentityContract(s),
            name: s.songname || 'Unknown Track',
            artist: s.artist || 'Unknown Artist',
            album: s.album || 'Single',
            duration: Media.formatDuration(s.duration),
            cover: resolveSongCover(s),
            uploaded_by: s.uploaded_by,
            is_private: s.is_private === 'public' ? 'public' : 'private',
            bitrate: s.bitrate,
            extension: path.extname(filePath).toLowerCase()
        }
    });

    res.json({ users: [], songs: matchingSongs });
});

// API: search mentions (lightweight)
app.get('/api/users/search-mentions', requireLogin, async (req, res) => {
    const queryStr = (req.query.q || '').toLowerCase();

    try {
        const allUsers = await HandleDatabase.getAllUsers();
        // Return only username, display_name and avatar for suggestions
        const suggestions = allUsers
            .filter(u => u.username.toLowerCase().startsWith(queryStr) || (u.display_name && u.display_name.toLowerCase().includes(queryStr)))
            .slice(0, 8)
            .map(u => ({
                username: u.username,
                display_name: u.display_name || u.username,
                avatar: Media.resolveAvatar(u.username)
            }));

        res.json(suggestions);
    } catch (err) {
        console.error('[SEARCH MENTIONS]', err);
        res.status(500).json({ error: "Failed to fetch suggestions" });
    }
});

// API: library rescan
app.post('/api/library/rescan', requireRole(['Owner']), async (req, res) => {
    try {
        const synced = await syncMusicDirectory();
        res.json({ success: true, syncedCount: synced });
    } catch (err) {
        console.error("[LIBRARY RESCAN ERROR]", err);
        res.status(500).json({ error: "Failed to rescan music library." });
    }
});

// API: GET music-directories
app.get('/api/config/music-directories', requireRole(['Owner']), async (req, res) => {
    let dirs = app.locals.config ? app.locals.config.music_directories : null;
    if (!Array.isArray(dirs) || dirs.length === 0) {
        dirs = Array.isArray(config.music_directories) && config.music_directories.length > 0
            ? config.music_directories
            : [config.music_directory || '../MusicLibrary/uploads'];
    }
    res.json({ directories: dirs });
});

// API: POST music-directories
app.post('/api/config/music-directories', requireRole(['Owner']), async (req, res) => {
    const { directories } = req.body;
    if (!Array.isArray(directories) || directories.length === 0) {
        return res.status(400).json({ error: "At least one valid directory path must be provided." });
    }
    const cleanDirs = directories.map(d => String(d).trim()).filter(d => d.length > 0);
    if (cleanDirs.length === 0) {
        return res.status(400).json({ error: "No valid directories provided." });
    }

    // Save to config.json file
    try {
        const configPath = RT.paths.config;
        let fileContent = {};
        if (fs.existsSync(configPath)) {
            fileContent = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        fileContent.music_directories = cleanDirs;
        fs.writeFileSync(configPath, JSON.stringify(fileContent, null, 4), 'utf8');
    } catch (err) {
        console.error("[CONFIG UPDATE] Failed to save config.json:", err);
        return res.status(500).json({ error: "Failed to save music directories." });
    }

    if (!app.locals.config) app.locals.config = {};
    app.locals.config.music_directories = cleanDirs;

    // Trigger immediate background rescan
    const synced = await syncMusicDirectory();
    res.json({ success: true, directories: cleanDirs, syncedCount: synced });
});

// API: library
app.get('/api/library', requireLogin, async (req, res) => {
    const allSongs = await HandleDatabase.getAllSongs();
    const library = allSongs.filter(s => !s.hidden_from_library && canAccessSong(s, req.user)).map(s => {
        return {
            id: s.id,
            ...songIdentityContract(s),
            name: s.songname,
            artist: s.artist,
            album: s.album,
            duration: Media.formatDuration(s.duration),
            cover: resolveSongCover(s),
            uploaded_by: s.uploaded_by,
            is_private: s.is_private === 'public' ? 'public' : 'private',
            bitrate: s.bitrate,
            extension: path.extname(s.filepath).toLowerCase()
        }
    });
    res.json(library);
});

// API: trending
app.get('/api/trending', requireLogin, async (req, res) => {
    const allSongs = await HandleDatabase.getAllSongs();
    const trending = allSongs.filter(s => s.is_private === "public").map(s => {
        return {
            id: s.id,
            name: s.songname,
            artist: s.artist,
            album: s.album,
            duration: Media.formatDuration(s.duration),
            cover: resolveSongCover(s),
            uploaded_by: s.uploaded_by,
            is_private: s.is_private === 'public' ? 'public' : 'private',
            bitrate: s.bitrate,
            extension: path.extname(s.filepath).toLowerCase()
        }
    });
    res.json(trending);
});

function parseSingleByteRange(rangeHeader, fileSize) {
    if (typeof rangeHeader !== 'string' || rangeHeader.includes(',') || fileSize <= 0) return null;

    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) return null;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        start = Number(match[1]);
        if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize) return null;

        if (match[2]) {
            end = Number(match[2]);
            if (!Number.isSafeInteger(end) || end < start) return null;
            end = Math.min(end, fileSize - 1);
        } else {
            end = fileSize - 1;
        }
    }

    return { start, end };
}

function sendAudioStream(res, fullPath, statusCode, headers, options = undefined) {
    const file = fs.createReadStream(fullPath, options);

    file.once('open', () => {
        if (res.destroyed) {
            file.destroy();
            return;
        }
        res.writeHead(statusCode, headers);
        file.pipe(res);
    });
    file.on('error', (err) => {
        console.error(`[STREAM ERROR] Failed while reading ${fullPath}:`, err);
        if (!res.headersSent && !res.writableEnded) {
            res.status(500).json({ error: "Failed to stream audio file" });
        } else if (!res.destroyed) {
            res.destroy();
        }
    });
    res.once('close', () => {
        if (!file.destroyed) file.destroy();
    });
}

// API: stream audio file
app.get('/api/stream/:id', requireLogin, async (req, res) => {
    try {
        const songData = await HandleDatabase.getSong(req.params.id);
        if (!songData) return res.status(404).json({ error: "Song not found" });

        if (!canAccessSong(songData, req.user)) {
            return res.status(403).json({ error: "Access Denied" });
        }

        let fullPath = songData.filepath;
        if (!path.isAbsolute(fullPath)) {
            fullPath = path.resolve(RT.DATA_ROOT, songData.filepath);
        }

        if (!fs.existsSync(fullPath)) {
            console.error(`[STREAM ERROR] File not found on disk: ${fullPath}`);
            return res.status(404).json({ error: "Audio file not found on server disk" });
        }

        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
            return res.status(404).json({ error: "Audio file not found on server disk" });
        }
        const fileSize = stat.size;
        const range = req.headers.range;
        const ext = path.extname(fullPath).toLowerCase();

        const mimeTypes = {
            '.mp3': 'audio/mpeg',
            '.flac': 'audio/flac',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.ogg': 'audio/ogg',
            '.webm': 'audio/webm'
        };
        const contentType = mimeTypes[ext] || 'audio/mpeg';

        if (range) {
            const parsedRange = parseSingleByteRange(range, fileSize);
            if (!parsedRange) {
                res.set({
                    'Content-Range': `bytes */${fileSize}`,
                    'Accept-Ranges': 'bytes'
                });
                return res.status(416).end();
            }

            const { start, end } = parsedRange;
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': (end - start) + 1,
                'Content-Type': contentType,
            };
            if (req.method === 'HEAD') {
                res.writeHead(206, head);
                return res.end();
            }
            return sendAudioStream(res, fullPath, 206, head, { start, end });
        } else {
            const head = {
                'Accept-Ranges': 'bytes',
                'Content-Length': fileSize,
                'Content-Type': contentType,
            };
            if (req.method === 'HEAD') {
                res.writeHead(200, head);
                return res.end();
            }
            return sendAudioStream(res, fullPath, 200, head);
        }
    } catch (err) {
        console.error('[STREAM ERROR]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream audio file" });
        } else {
            res.destroy();
        }
    }
});

// API: play
app.get('/api/play/:identifier', requireLogin, async (req, res) => {
    const identifier = decodeURIComponent(req.params.identifier);
    const songData = await HandleDatabase.getSong(identifier);

    if (!songData) return res.status(404).json({ error: "Song not found" });

    if (!canAccessSong(songData, req.user)) {
        return res.status(403).json({ error: "Access Denied" });
    }

    res.json({
        id: songData.id,
        ...songIdentityContract(songData),
        name: songData.songname,
        artist: songData.artist,
        album: songData.album,
        genre: songData.genre,
        duration: Media.formatDuration(songData.duration),
        url: `/api/stream/${songData.id}`,
        cover: resolveSongCover(songData),
        is_private: songData.is_private === 'public' ? 'public' : 'private',
        bitrate: songData.bitrate,
        extension: path.extname(songData.filepath).toLowerCase()
    });
});

app.use([
    '/upload-song',
    '/api/import',
    '/api/youtube-ratelimit-status',
    '/api/youtube-metadata',
    '/api/youtube-download'
], (req, res) => {
    res.status(410).json({ error: 'Music is loaded from the configured local directory.' });
});

// Legacy upload route (retired)
app.post('/upload-song', requireLogin, uploadSong.array('song_file', 5), async (req, res) => {
    // Increase timeout for long FFmpeg batches
    req.setTimeout(0);

    const files = req.files;
    if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded." });
    }

    // Check Per-User Storage Limit (300 MB)
    const storageUsed = req.userRow.storage_used || 0;
    const storageLimit = 314572800; // 300 MB
    console.log(`[DEBUG] User '${req.user}' current storage used: ${storageUsed} bytes`);

    if (storageUsed >= storageLimit) {
        console.warn(`[UPLOAD REJECTED] User '${req.user}' reached their 300MB storage limit.`);
        return res.status(403).json({ error: "Your 300MB storage limit has been reached. Please delete some of your songs to upload more." });
    }

    const { compression } = req.body;
    const compress = compression === 'true';

    const results = [];
    const errors = [];

    for (const file of files) {
        try {
            // Fix encoding: Multer parses originalname as latin1, but it's usually sent as UTF-8
            const utf8Name = Buffer.from(file.originalname, 'latin1').toString('utf8');
            console.log(`[UPLOAD] User '${req.user}' uploaded '${utf8Name}' (Batch Processing)`);

            // Duplicate detection: SHA-256 Hash
            const fileHash = await getFileHash(file.path);
            const existing = await HandleDatabase.getSongByMetadata(req.user, { file_hash: fileHash });
            if (existing) {
                console.warn(`[UPLOAD REJECTED] Duplicate file detected for user '${req.user}': ${utf8Name}`);
                errors.push({ name: file.originalname, error: 'Song already exists in your library' });
                if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                continue;
            }

            const finalPath = await Media.saveSong(file.path, "../MusicLibrary/", req.user, compress, 'private', utf8Name, null, { file_hash: fileHash });

            if (finalPath) {
                // Cover extraction
                const fullFinalPath = path.join(RT.DATA_ROOT, finalPath);
                const baseName = path.basename(fullFinalPath, path.extname(fullFinalPath));
                const coverOutPath = path.join(RT.paths.covers, baseName);

                console.log(`[DEBUG] Extracting cover art for: ${fullFinalPath}`);
                await Media.extractCoverArt(fullFinalPath, coverOutPath);
                results.push({ name: file.originalname, status: 'success' });
            } else {
                console.error(`[UPLOAD FAILED] Media.saveSong returned null for: ${file.originalname}`);
                errors.push({ name: file.originalname, error: 'Processing failed' });
                if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            }
        } catch (err) {
            console.error(`[UPLOAD EXCEPTION] Error processing ${file.originalname}:`, err);
            errors.push({ name: file.originalname, error: err.message });
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }
    }
    console.log(`[UPLOAD BATCH FINISHED] Success: ${results.length}, Failed: ${errors.length}`);

    if (results.length > 0) {
        return res.json({
            success: true,
            message: `${results.length} songs uploaded successfully.`,
            errors: errors.length > 0 ? errors : null
        });
    } else {
        return res.status(500).json({
            error: "All uploads failed.",
            details: errors
        });
    }
});

// API: upload-avatar
app.post('/api/upload-avatar', requireLogin, avatarUploadLimiter, uploadAvatar.single('avatar_file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file." });

    // Check type
    const head = req.file.buffer.subarray(0, 8);
    const isJPEG = head[0] === 0xff && head[1] === 0xd8;
    const isPNG = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e;

    if (!isJPEG && !isPNG) {
        return res.status(400).json({ error: "Unsupported file type. Only JPG/PNG allowed." });
    }

    const savedUrl = await Media.processAvatarUpload(req.file.buffer, req.user);
    if (!savedUrl) {
        return res.status(500).json({ error: "Failed to process image." });
    }

    return res.json({ success: true, avatar: Media.resolveAvatar(req.user) });
});

// API: upload-banner
app.post('/api/upload-banner', requireLogin, avatarUploadLimiter, uploadBanner.single('banner_file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file." });

    const savedUrl = await Media.processUserBannerUpload(req.file.buffer, req.user);
    if (!savedUrl) {
        return res.status(500).json({ error: "Failed to process banner." });
    }

    return res.json({ success: true, banner: Media.resolveUserBanner(req.user) });
});

// API: youtube-ratelimit-status (Check status without consuming a download)
app.get('/api/youtube-ratelimit-status', requireLogin, async (req, res) => {
    try {
        const key = req.ip;
        // In express-rate-limit v7+, getStore().get(key) is also possible, 
        // but getKey() is a built-in helper that should work.
        const status = await youtubeDownloadLimiter.getKey(key);

        const limit = app.locals.config.ratelimits.youtube_max || 2;
        let remaining = limit;
        let resetSeconds = 0;

        if (status) {
            remaining = Math.max(0, limit - (status.totalHits || 0));
            if (status.resetTime) {
                const diff = new Date(status.resetTime) - Date.now();
                resetSeconds = Math.ceil(diff / 1000);

                // CRITICAL FIX: If reset time has passed, explicitly return full quota
                // This prevents "stuck at 0" issues caused by minor server/client clock desync
                if (resetSeconds <= 0) {
                    remaining = limit;
                    resetSeconds = 0;
                }
            }
        }

        return res.json({
            success: true,
            remaining: remaining,
            resetSeconds: Math.max(0, resetSeconds),
            limit: limit
        });
    } catch (err) {
        console.error("[YOUTUBE RATELIMIT STATUS ERROR]", err);
        // Fail-safe: return default limit
        return res.json({ success: true, remaining: 2, limit: 2, resetSeconds: 0 });
    }
});

// API: youtube-metadata
app.post('/api/youtube-metadata', requireLogin, youtubeMetadataLimiter, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Missing YouTube URL." });

    try {
        await ensureYoutubeCooldown();
        const userAgent = getRandomUserAgent();
        const info = await ytDlp(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            ffmpegLocation: ffmpegPath,
            userAgent: userAgent
        });

        const maxDuration = app.locals.config.ratelimits.youtube_duration || 600;
        if (info.duration > maxDuration) {
            return res.status(400).json({ error: `Video is too long (${Math.floor(info.duration / 60)}m). Music imports are limited to ${Math.floor(maxDuration / 60)} minutes.` });
        }

        return res.json({
            success: true,
            title: info.title,
            artist: info.uploader || "Unknown YouTube Artist",
            duration: info.duration,
            thumbnail: info.thumbnail
        });
    } catch (err) {
        console.error(`[YOUTUBE METADATA ERROR]`, err);
        return res.status(500).json({ error: "Failed to fetch metadata: " + err.message });
    }
});

// API: youtube-download
app.post('/api/youtube-download', requireLogin, youtubeDownloadLimiter, async (req, res) => {
    const { url, compress } = req.body;
    if (!url) return res.status(400).json({ error: "Missing YouTube URL." });

    const shouldCompress = !!compress;

    // 1. Check Per-User Storage Limit (300 MB)
    if (!req.userRow) return res.status(401).json({ error: "User session lost. Please log in again." });
    const storageUsed = req.userRow.storage_used || 0;
    const storageLimit = 314572800; // 300 MB
    if (storageUsed >= storageLimit) {
        return res.status(403).json({ error: "Your 300MB storage limit has been reached. Please delete some of your songs to upload more." });
    }

    console.log(`[YOUTUBE] User '${req.user}' requested download: ${url}`);

    const youtubeId = extractYoutubeId(url);
    if (youtubeId) {
        const existing = await HandleDatabase.getSongByMetadata(req.user, { youtube_id: youtubeId });
        if (existing) {
            console.warn(`[YOUTUBE REJECTED] Duplicate import for user '${req.user}': ${youtubeId}`);
            return res.status(409).json({ error: "This YouTube song already exists in your library." });
        }
    }

    const tempAudioPath = path.join(RT.paths.temp, `yt-${crypto.randomBytes(6).toString('hex')}.m4a`);
    const tempDir = path.dirname(tempAudioPath);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    try {
        await ensureYoutubeCooldown();
        const userAgent = getRandomUserAgent();

        // 2. Fetch metadata
        const info = await ytDlp(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            ffmpegLocation: ffmpegPath,
            userAgent: userAgent
        });

        const title = info.title;
        const artist = info.uploader || "Unknown YouTube Artist";
        const duration = info.duration;
        const thumbnail = info.thumbnail;

        // Final check on metadata duration (redundant check for safety)
        const maxDuration = app.locals.config.ratelimits.youtube_duration || 600;
        if (duration > maxDuration) {
            throw new Error(`Video is too long (${Math.floor(duration / 60)}m). Max allowed is ${Math.floor(maxDuration / 60)} minutes.`);
        }

        console.log(`[YOUTUBE] Metadata - Title: ${title}, Artist: ${artist}, Duration: ${duration}s`);

        // 3. Download Audio
        // We'll use yt-dlp to download the best audio available
        // --extract-audio and --audio-format m4a ensures we get a consistent format for Media.saveSong
        await ytDlp(url, {
            output: tempAudioPath,
            extractAudio: true,
            audioFormat: 'm4a',
            noCheckCertificates: true,
            noWarnings: true,
            ffmpegLocation: ffmpegPath,
            userAgent: userAgent
        });

        if (!fs.existsSync(tempAudioPath)) {
            // Fallback: check if it was saved with a different extension by mistake
            const files = fs.readdirSync(tempDir);
            const found = files.find(f => f.startsWith(path.basename(tempAudioPath, '.m4a')));
            if (found) {
                fs.renameSync(path.join(tempDir, found), tempAudioPath);
            } else {
                throw new Error("Failed to download audio stream.");
            }
        }

        // 4. Save Song using existing Media logic
        // If shouldCompress is true, it re-encodes to MP3 128k (slow). Else, rename (instant).
        const metaOverride = { title, artist, duration };
        const fingerprint = { youtube_id: youtubeId };
        const finalPath = await Media.saveSong(tempAudioPath, "../MusicLibrary/", req.user, shouldCompress, 'private', title, metaOverride, fingerprint);

        if (finalPath) {
            const baseName = path.basename(finalPath, path.extname(finalPath));

            // 5. Handle Thumbnail/Cover
            if (thumbnail) {
                const coverDir = RT.paths.covers;
                if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
                const coverPath = path.join(coverDir, `${baseName}.jpg`);

                try {
                    await downloadFile(thumbnail, coverPath);
                    console.log(`[YOUTUBE] Saved cover art: ${coverPath}`);
                } catch (thumbErr) {
                    console.error(`[YOUTUBE] Failed to download thumbnail: ${thumbErr.message}`);
                }
            }

            return res.json({ success: true, message: "YouTube song imported successfully!" });
        } else {
            throw new Error("Media processing failed.");
        }

    } catch (err) {
        console.error(`[YOUTUBE ERROR]`, err);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        return res.status(500).json({ error: "Failed to download or process YouTube song: " + err.message });
    }
});

// --- Cover Art Helper ---
async function fetchAndSaveCover(artist, title, baseName, album = "", directUrl = null) {
    try {
        const coversDir = RT.paths.covers;
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
        const savePath = path.join(coversDir, `${baseName}.jpg`);

        // Retired import code may persist artwork supplied by its source, but
        // must not perform a second unreviewed registry guess.
        if (!directUrl) return;
        await downloadFile(directUrl, savePath);
        console.log(`[COVER] Saved from direct URL: ${baseName}.jpg`);
    } catch (e) {
        console.error(`[COVER] Failed for ${artist} - ${title}:`, e.message);
    }
}

// --- Soulseek Helper ---
function trySoulseek(query, socketInfo = null, songName = null) {
    return new Promise(async (resolve) => {
        const client = await getSoulseekClient();
        if (!client) {
            console.error("[SOULSEEK] No client available for search.");
            return resolve({ success: false });
        }

        client.search({ req: query, timeout: 15000 }, (err, res) => {
            // Check if user skipped/cancelled DURING the search
            const stillActive = activeImports.get(socketInfo?.user);
            const searchId = `${socketInfo?.user}:${query}`;
            if (!stillActive || stillActive.cancelled || (activeSoulseekDownloads.get(searchId)?.skipped)) {
                activeSoulseekDownloads.delete(searchId);
                return resolve({ success: false });
            }

            if (err || !res || res.length === 0) {
                console.log(`[SOULSEEK] No results found or search error for: ${query} (err: ${err})`);
                return resolve({ success: false });
            }

            // Filter for audio files, good bitrate, and decent speed
            const candidates = res
                .filter(peer => {
                    if (!peer.file) return false;
                    const ext = path.extname(peer.file).toLowerCase();
                    const isAudio = ['.mp3', '.m4a', '.wav', '.ogg'].includes(ext);
                    // Be flexible with bitrate
                    const isGoodBitrate = (peer.bitrate >= 192 && peer.bitrate <= 450);
                    // Minimum speed floor: 100KB/s (102400 bytes/s)
                    const isFastEnough = (peer.speed || 0) >= 102400;
                    return isAudio && isGoodBitrate && isFastEnough;
                })
                .sort((a, b) => {
                    // 1. Prefer free slots
                    if (a.slots !== b.slots) return a.slots ? -1 : 1;

                    // 2. Prefer lower queue
                    const qA = a.inQueue ?? 999;
                    const qB = b.inQueue ?? 999;
                    if (qA !== qB) return qA - qB;

                    // 3. Prefer significantly higher speed (tiered)
                    const speedTierA = Math.floor((a.speed || 0) / 1048576); // 1MB/s tiers
                    const speedTierB = Math.floor((b.speed || 0) / 1048576);
                    if (speedTierA !== speedTierB) return speedTierB - speedTierA;

                    // 4. Prefer higher bitrate
                    if ((b.bitrate || 0) !== (a.bitrate || 0)) {
                        return (b.bitrate || 0) - (a.bitrate || 0);
                    }

                    // 5. Tie-break with raw speed
                    return (b.speed || 0) - (a.speed || 0);
                });

            const bestFile = candidates[0];
            if (!bestFile) {
                console.log(`[SOULSEEK] No suitable candidates found for: ${query} (out of ${res.length} results)`);
                return resolve({ success: false });
            }

            const fileExt = path.extname(bestFile.file).toLowerCase() || '.mp3';
            const tempPath = path.join(RT.paths.temp, `slsk-${crypto.randomBytes(6).toString('hex')}${fileExt}`);

            // Calculate ETA: Convert speed bits->bytes and add 5s for handshake/connection overhead
            const rawSize = bestFile.size || 0;
            const rawSpeed = bestFile.speed || 1;
            const etaSeconds = Math.max(5, Math.ceil(rawSize / (rawSpeed / 8)) + 5);

            if (socketInfo) {
                socketInfo.io.to(`user:${socketInfo.user}`).emit('import_progress', {
                    song: songName || query,
                    status: 'downloading',
                    source: 'soulseek',
                    eta: etaSeconds
                });
            }

            // Real-time Progress Tracking
            let lastSize = 0;
            const progressInterval = setInterval(() => {
                try {
                    if (fs.existsSync(tempPath)) {
                        const stats = fs.statSync(tempPath);
                        const currentSize = stats.size;
                        const totalSize = bestFile.size || 1;
                        const bytesGained = currentSize - lastSize;
                        lastSize = currentSize;
                        if (socketInfo) {
                            // Calculate speed per second (interval is now 1000ms = 1s)
                            const bytesPerSecond = bytesGained;
                            if (bytesPerSecond > 0) {
                                const realEta = Math.ceil((totalSize - currentSize) / bytesPerSecond);
                                socketInfo.io.to(`user:${socketInfo.user}`).emit('import_progress', {
                                    song: songName || query,
                                    status: 'downloading',
                                    source: 'soulseek',
                                    eta: realEta
                                });
                            } else if (currentSize < totalSize) {
                                // If stalled, send a 'stalled' status or just keep same ETA
                                socketInfo.io.to(`user:${socketInfo.user}`).emit('import_progress', {
                                    song: songName || query,
                                    status: 'downloading',
                                    source: 'soulseek',
                                    eta: 'Stalled'
                                });
                            }
                        }
                    }
                } catch (e) { }
            }, 1000);

            console.log(`[SOULSEEK] Downloading: ${bestFile.file} from ${bestFile.user} (${bestFile.bitrate}kbps)`);

            const downloadId = socketInfo ? `${socketInfo.user}:${query}` : null;
            if (downloadId) {
                activeSoulseekDownloads.set(downloadId, { resolve, tempPath });
            }

            let downloadTimeout = setTimeout(() => {
                clearInterval(progressInterval);
                if (downloadId) activeSoulseekDownloads.delete(downloadId);
                console.log(`[SOULSEEK] Download timed out for: ${bestFile.file}`);
                // Tell UI we are moving on to YouTube
                if (socketInfo) {
                    socketInfo.io.to(`user:${socketInfo.user}`).emit('import_progress', {
                        song: songName || query,
                        status: 'searching_yt',
                        message: `Soulseek timed out, trying YouTube...`
                    });
                }
                resolve({ success: false });
            }, 120000); // 120-second (2 min) patience limit for download

            client.download({ file: bestFile, path: tempPath }, (err, data) => {
                clearInterval(progressInterval);
                clearTimeout(downloadTimeout);
                if (downloadId) activeSoulseekDownloads.delete(downloadId);

                if (err) {
                    console.error(`[SOULSEEK DOWNLOAD ERROR]`, err);
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                    // Tell UI we are moving on to YouTube
                    if (socketInfo) {
                        socketInfo.io.to(`user:${socketInfo.user}`).emit('import_progress', {
                            song: songName || query,
                            status: 'searching_yt',
                            message: `Soulseek failed, trying YouTube...`
                        });
                    }
                    return resolve({ success: false });
                }
                resolve({ success: true, filePath: tempPath, bitrate: bestFile.bitrate });
            });
        });
    });
}

// API: spotify-import
app.post('/api/import/spotify', requireLogin, async (req, res) => {
    const { url, playlistName, useSoulseek } = req.body;
    if (!url || !url.includes('spotify.com')) {
        return res.status(400).json({ error: "Invalid Spotify URL." });
    }

    try {
        const storageUsed = req.userRow.storage_used || 0;
        const storageLimit = 314572800; // 300 MB
        if (storageUsed >= storageLimit) {
            return res.status(403).json({ error: "Your 300MB storage limit has been reached. Please delete some of your songs to import more." });
        }

        let tracks;
        try {
            tracks = await getTracks(url);
        } catch (err) {
            console.error(`[SPOTIFY GET TRACKS ERROR]`, err.message);
            return res.status(404).json({ error: "Spotify playlist not found or is private. Make sure the URL is correct and the playlist is public." });
        }

        if (!tracks || tracks.length === 0) {
            return res.status(404).json({ error: "No tracks found or playlist is private." });
        }

        const actualPlaylistName = playlistName || tracks[0]?.album || "Spotify Import";
        const result = await HandleDatabase.insertPlaylist(actualPlaylistName, req.user);
        const playlistId = result.lastID;

        // Track import state
        activeImports.set(req.user, { cancelled: false, skipSoulseek: false });

        // Respond immediately, process in background
        res.json({ success: true, totalTracks: tracks.length, message: `Importing ${tracks.length} tracks in the background. Check your library soon.` });

        let songPosition = 0;

        for (const track of tracks) {
            try {
                // Check for manual cancellation
                const impState = activeImports.get(req.user);
                if (!impState || impState.cancelled) {
                    console.log(`[SPOTIFY IMPORT] Import for ${req.user} cancelled.`);
                    activeImports.delete(req.user);
                    req.app.get('io').to(`user:${req.user}`).emit('import_cancelled');
                    break;
                }

                // Flex quota check inside the loop
                const currentUser = await HandleDatabase.getUser(req.user);
                if (currentUser.storage_used >= storageLimit) {
                    req.app.get('io').to(`user:${req.user}`).emit('import_error', { message: "Storage limit reached. Import paused." });
                    activeImports.delete(req.user);
                    break;
                }

                const query = `${track.artist} ${track.name}`;
                console.log(`[SPOTIFY IMPORT] Processing: ${query}`);

                let finalAudioPath = null;
                let downloadedBitrate = 128;
                let sourceUsed = 'unknown';

                // 1. Try Soulseek (if enabled AND not skipped globally)
                if (useSoulseek !== false && !impState.skipSoulseek) {
                    req.app.get('io').to(`user:${req.user}`).emit('import_progress', { song: track.name, status: 'searching_slsk' });
                    console.log(`[SPOTIFY IMPORT] Trying Soulseek: ${query}`);
                    const soulseekResult = await trySoulseek(query, { io: req.app.get('io'), user: req.user }, track.name);
                    if (soulseekResult.success) {
                        finalAudioPath = soulseekResult.filePath;
                        downloadedBitrate = soulseekResult.bitrate || 320;
                        sourceUsed = 'soulseek';
                        console.log(`[SPOTIFY IMPORT] Downloaded from Soulseek: ${query}`);
                    }
                }

                // 2. Fallback to yt-dlp (SoundCloud then YouTube)
                if (!finalAudioPath) {
                    // Check cancellation again before YouTube fallback
                    const impCheck = activeImports.get(req.user);
                    if (!impCheck || impCheck.cancelled) {
                        console.log(`[SPOTIFY IMPORT] Import for ${req.user} stopped before YouTube fallback.`);
                        req.app.get('io').to(`user:${req.user}`).emit('import_cancelled');
                        break;
                    }

                    req.app.get('io').to(`user:${req.user}`).emit('import_progress', { song: track.name, status: 'downloading', source: 'youtube' });

                    await ensureYoutubeCooldown();
                    const tempAudioPath = path.join(RT.paths.temp, `yt-${crypto.randomBytes(6).toString('hex')}.m4a`);
                    const fallbacks = [
                        `ytsearch1:${query} official audio`,
                        `scsearch1:${query}`,
                        `ytsearch1:${query}`
                    ];

                    for (const fallback of fallbacks) {
                        try {
                            console.log(`[SPOTIFY IMPORT] Trying fallback: ${fallback}`);
                            await ytDlp(fallback, {
                                output: tempAudioPath,
                                extractAudio: true,
                                audioFormat: 'm4a',
                                noCheckCertificates: true,
                                noWarnings: true,
                                ffmpegLocation: ffmpegPath,
                                userAgent: getRandomUserAgent()
                            });

                            if (fs.existsSync(tempAudioPath)) {
                                finalAudioPath = tempAudioPath;
                                downloadedBitrate = 128; // Standard yt-dlp audio format estimation
                                sourceUsed = fallback.includes('scsearch') ? 'soundcloud' : 'youtube';
                                break;
                            }
                        } catch (e) {
                            console.log(`[SPOTIFY IMPORT] Fallback ${fallback} failed.`);
                        }
                    }
                }

                if (finalAudioPath) {
                    // Tag with node-id3 (MP3 only; ID3 tags corrupt M4A containers)
                    if (finalAudioPath.toLowerCase().endsWith('.mp3')) {
                        const tags = {
                            title: track.name,
                            artist: track.artist,
                            album: track.album || "Single"
                        };
                        NodeID3.write(tags, finalAudioPath);
                    }

                    const metaOverride = {
                        title: track.name,
                        artist: track.artist,
                        album: track.album,
                        duration: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined
                    };

                    const fingerprint = {
                        bitrate: downloadedBitrate,
                        source: sourceUsed
                    };

                    const dbPath = await Media.saveSong(finalAudioPath, "../MusicLibrary/", req.user, false, 'private', track.name, metaOverride, fingerprint);

                    if (dbPath) {
                        const songData = await HandleDatabase.getSongByFilepath(dbPath);
                        if (songData) {
                            await HandleDatabase.addSongToPlaylist(playlistId, songData.id, songPosition++);
                            // Use direct Spotify cover if available, otherwise accurate iTunes search
                            const baseName = path.basename(dbPath, path.extname(dbPath));
                            const spotifyCover = track.cover || (track.images && track.images[0]?.url);
                            fetchAndSaveCover(track.artist, track.name, baseName, track.album, spotifyCover).catch(() => { });
                        }

                        req.app.get('io').to(`user:${req.user}`).emit('import_progress', { song: track.name, status: 'done', source: sourceUsed, songId: songData.id });
                        req.app.get('io').to(`user:${req.user}`).emit('storage_update');
                    }
                } else {
                    req.app.get('io').to(`user:${req.user}`).emit('import_progress', { song: track.name, status: 'failed' });
                }
            } catch (err) {
                console.error(`[SPOTIFY IMPORT ERROR] Failed track ${track.name}:`, err);
                req.app.get('io').to(`user:${req.user}`).emit('import_progress', { song: track.name, status: 'failed' });
            }
        }

    } catch (err) {
        console.error(`[SPOTIFY IMPORT ENDPOINT ERROR]`, err);
        return res.status(500).json({ error: "Failed to process Spotify URL." });
    }
});

// API: get dynamic profile data
app.get('/api/profile/:username', requireLogin, async (req, res) => {
    const targetUsername = req.params.username;
    const userRow = await HandleDatabase.getUser(targetUsername);

    if (!userRow) return res.status(404).json({ error: "User not found" });

    res.json({
        user: {
            username: targetUsername,
            display_name: userRow.display_name || targetUsername,
            bio: userRow.bio || "",
            avatar: Media.resolveAvatar(targetUsername),
            banner: Media.resolveUserBanner(targetUsername),
            role: userRow.role,
            created_at: userRow.created_at
        }
    });
});

/* ==========================================================
 * POST /api/save-cover
 * Downloads a fetched iTunes cover URL and saves it to
 * Static/covers/ so future song loads skip the iTunes API.
 * ========================================================== */
app.post('/api/save-cover', requireLogin, async (req, res) => {
    const { songId, songname, coverUrl } = req.body;
    const songIdentifier = songId || songname;
    if (!songIdentifier || !coverUrl) return res.status(400).json({ error: 'Missing params' });

    /* Only allow HTTPS Apple CDN URLs; suffixes must end on a DNS boundary. */
    let parsedCoverUrl;
    try { parsedCoverUrl = new URL(coverUrl); }
    catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const urlHost = parsedCoverUrl.hostname.toLowerCase();
    const isAppleHost = urlHost === 'mzstatic.com' || urlHost.endsWith('.mzstatic.com') ||
        urlHost === 'itunes.apple.com' || urlHost.endsWith('.itunes.apple.com');
    if (parsedCoverUrl.protocol !== 'https:' || !isAppleHost) {
        return res.status(400).json({ error: 'Cover URL must come from Apple CDN' });
    }

    try {
        const songData = await HandleDatabase.getSong(songIdentifier);
        if (!songData) return res.status(404).json({ error: 'Song not found' });
        if (req.userRow.role !== 'Owner' && songData.uploaded_by !== req.user) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const baseName = path.basename(songData.filepath, path.extname(songData.filepath));
        const coversDir = RT.paths.covers;
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

        const savePath = path.join(coversDir, `${baseName}.jpg`);

        /* Skip download if the cover already exists on disk */
        if (!fs.existsSync(savePath)) {
            const downloaded = await AIMetadata.downloadFile(parsedCoverUrl.href, savePath);
            if (!downloaded) throw new Error('Cover download failed');
            console.log(`[COVER] Saved: ${baseName}.jpg`);
        }

        return res.json({ success: true, cover: Media.resolveCover(baseName) });
    } catch (err) {
        console.error('[COVER]', err.message);
        return res.status(500).json({ error: 'Failed to save cover' });
    }
});

// Social features were retired for the personal music player.
app.use(['/api/posts', '/api/comments', '/api/notifications', '/api/dm', '/api/users', '/api/admin/post'], (req, res) => {
    res.status(404).json({ error: 'Social features are no longer available.' });
});

// --- Retired Posts API ---

app.get('/api/posts', requireLogin, async (req, res) => {
    try {
        const { sortBy = 'newest', limit = 10, page = 1 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const options = {
            sortBy: sortBy,
            limit: parseInt(limit),
            offset: offset
        };

        const isModPlus = ['Owner', 'Admin', 'Moderator'].includes(req.userRow.role);
        const posts = await HandleDatabase.getPosts(options, req.user, isModPlus);

        // Enhance with user avatars
        const enhancedPosts = await Promise.all(posts.map(async (post) => {
            const avatarUrl = Media.resolveAvatar(post.username);

            // Get user info for admin badge check
            const userRow = await HandleDatabase.getUser(post.username);
            const userRole = userRow ? userRow.role : 'User';

            return {
                ...post,
                display_name: userRow ? userRow.display_name : post.username,
                bio: userRow ? userRow.bio : "",
                avatar: avatarUrl,
                role: userRole,
                image_url: post.image_url ? post.image_url.replace(/\\/g, '/') : null
            };
        }));

        res.json(enhancedPosts);
    } catch (err) {
        console.error('[POSTS GET]', err);
        res.status(500).json({ error: "Failed to fetch posts" });
    }
});

app.get('/api/posts/:id', requireLogin, async (req, res) => {
    const postId = req.params.id;
    try {
        const isModPlus = ['Owner', 'Admin', 'Moderator'].includes(req.userRow.role);
        const post = await HandleDatabase.getPost(postId, req.user, isModPlus);
        if (!post) return res.status(404).json({ error: "Post not found" });

        const userRow = await HandleDatabase.getUser(post.username);
        const enhancedPost = {
            ...post,
            display_name: userRow ? userRow.display_name : post.username,
            avatar: Media.resolveAvatar(post.username),
            role: userRow ? userRow.role : 'User',
            image_url: post.image_url ? post.image_url.replace(/\\/g, '/') : null
        };

        res.json(enhancedPost);
    } catch (err) {
        console.error('[GET SINGLE POST]', err);
        res.status(500).json({ error: "Failed to fetch post" });
    }
});

app.post('/api/posts/:id/like', requireLogin, socialLimiter, async (req, res) => {
    const postId = req.params.id;
    try {
        const result = await HandleDatabase.toggleLike(postId, req.user);
        const post = await HandleDatabase.getPost(postId);
        if (post) {
            req.app.get('io').emit('update_likes', { postId, likes: post.likes });
            if (result.liked && post.username !== req.user) {
                await HandleDatabase.addNotification(post.username, req.user, 'like', postId);
                req.app.get('io').to(`user:${post.username}`).emit('new_notification');
            }
        }
        res.json({ ...result, likes: post ? post.likes : 0 });
    } catch (err) {
        console.error('[LIKE POST]', err);
        res.status(500).json({ error: "Failed to toggle like" });
    }
});

app.get('/api/posts/:id/comments', requireLogin, async (req, res) => {
    const postId = req.params.id;
    try {
        const isModPlus = ['Owner', 'Admin', 'Moderator'].includes(req.userRow.role);
        const comments = await HandleDatabase.getComments(postId, req.user, isModPlus);
        // Enhance comments with avatars
        const enhancedComments = await Promise.all(comments.map(async (c) => {
            const avatarUrl = Media.resolveAvatar(c.username);

            const userRow = await HandleDatabase.getUser(c.username);
            return {
                ...c,
                display_name: userRow ? userRow.display_name : c.username,
                avatar: avatarUrl
            };
        }));

        res.json(enhancedComments);
    } catch (err) {
        console.error('[GET COMMENTS]', err);
        res.status(500).json({ error: "Failed to fetch comments" });
    }
});

app.post('/api/posts/:id/comments', requireLogin, commentLimiter, async (req, res) => {
    const postId = req.params.id;
    const { body } = req.body;
    if (!body || body.trim() === '') {
        return res.status(400).json({ error: "Comment cannot be empty" });
    }
    if (body.length > 400) {
        return res.status(400).json({ error: "Comment too long (max 400 chars)" });
    }
    try {
        const isFlagged = await Moderation.isFlagged(body);
        await HandleDatabase.addComment(postId, req.user, body, isFlagged ? 1 : 0);

        // Skip mentions/notifications if flagged
        if (isFlagged) {
            return res.json({ success: true, comments: 0 }); // Silent block
        }
        const mentions = [...new Set(body.match(/@(\w+)/g))];
        if (mentions.length > 0) {
            for (let mention of mentions) {
                const username = mention.substring(1);
                const targetUser = await HandleDatabase.getUser(username);
                if (targetUser && username !== req.user) {
                    // Using post_id as target_id for comment mentions to link back to the post
                    await HandleDatabase.insertMention(req.user, postId, 'comment', username);
                    await HandleDatabase.addNotification(username, req.user, 'mention', postId);
                    req.app.get('io').to(`user:${username}`).emit('new_notification');
                }
            }
        }

        const post = await HandleDatabase.getPost(postId);
        if (post) {
            req.app.get('io').emit('new_comment', { postId, comments: post.comments });
            if (post.username !== req.user) {
                await HandleDatabase.addNotification(post.username, req.user, 'comment', postId);
                req.app.get('io').to(`user:${post.username}`).emit('new_notification');
            }
        }
        res.json({ success: true, comments: post ? post.comments : 0 });
    } catch (err) {
        console.error('[ADD COMMENT]', err);
        res.status(500).json({ error: "Failed to add comment" });
    }
});

app.post('/api/posts', requireLogin, postLimiter, async (req, res) => {
    const { body } = req.body;
    if (!body || body.trim() === '') {
        return res.status(400).json({ error: "Post body cannot be empty" });
    }
    if (body.length > 1000) {
        return res.status(400).json({ error: "Post too long (max 1000 chars)" });
    }

    try {
        const isFlagged = (await Moderation.isFlagged(body)) || app.locals.config.lockdown_new_posts;
        const result = await HandleDatabase.insertPost(req.user, body, 'text', null, isFlagged ? 1 : 0);
        const postId = result.lastID;

        // Skip mentions/notifications if flagged
        if (isFlagged) {
            return res.json({ success: true, postId }); // Silent block
        }
        const mentions = [...new Set(body.match(/@(\w+)/g))];
        if (mentions.length > 0) {
            for (let mention of mentions) {
                const username = mention.substring(1);
                const targetUser = await HandleDatabase.getUser(username);
                if (targetUser && username !== req.user) {
                    await HandleDatabase.insertMention(req.user, postId, 'post', username);
                    await HandleDatabase.addNotification(username, req.user, 'mention', postId);
                    req.app.get('io').to(`user:${username}`).emit('new_notification');
                }
            }
        }

        req.app.get('io').emit('new_post');
        res.json({ success: true, postId });
    } catch (err) {
        console.error('[POSTS POST]', err);
        res.status(500).json({ error: "Failed to create post" });
    }
});

app.post('/api/posts/photo', requireLogin, postLimiter, uploadFeedImage.single('photo'), async (req, res) => {
    const { body } = req.body;
    if (!req.file) {
        return res.status(400).json({ error: "No image provided" });
    }

    // Body is optional for photo posts, but can't be too long if provided
    if (body && body.length > 1000) {
        return res.status(400).json({ error: "Post too long (max 1000 chars)" });
    }

    try {
        // Resize image if too large
        const imagePath = req.file.path;
        const image = await Jimp.read(imagePath);

        // Max width 1600px, keep aspect ratio
        if (image.width > 1600) {
            image.resize({ w: 1600 });
            await image.write(imagePath);
        }

        const imageUrl = `/Static/uploads/feed/${req.file.filename}`;
        const isFlagged = (await Moderation.isFlagged(body || "")) || app.locals.config.lockdown_new_posts;
        const result = await HandleDatabase.insertPost(req.user, body || "", 'photo', imageUrl, isFlagged ? 1 : 0);
        const postId = result.lastID;

        // Skip mentions/notifications if flagged
        if (isFlagged) {
            return res.json({ success: true, image_url: imageUrl, postId }); // Silent block
        }

        // Parse Mentions in Photo Post
        if (body) {
            const mentions = [...new Set(body.match(/@(\w+)/g))];
            if (mentions.length > 0) {
                for (let mention of mentions) {
                    const username = mention.substring(1);
                    const targetUser = await HandleDatabase.getUser(username);
                    if (targetUser && username !== req.user) {
                        await HandleDatabase.insertMention(req.user, postId, 'post', username);
                        await HandleDatabase.addNotification(username, req.user, 'mention', postId);
                        req.app.get('io').to(`user:${username}`).emit('new_notification');
                    }
                }
            }
        }

        req.app.get('io').emit('new_post');
        res.json({ success: true, image_url: imageUrl, postId });
    } catch (err) {
        console.error('[POSTS PHOTO]', err);
        res.status(500).json({ error: "Failed to create photo post" });
    }
});

// --- Playlist Endpoints ---

// Create playlist
app.post('/api/playlists', requireLogin, async (req, res) => {
    const { name } = req.body;
    if (!name || name.trim() === '') return res.status(400).json({ error: "Playlist name is required" });
    if (name.length > 60) return res.status(400).json({ error: "Playlist name too long (max 60 chars)" });

    const userPlaylists = await HandleDatabase.getPlaylistsByUser(req.user);
    if (userPlaylists.length >= 20) return res.status(400).json({ error: "Maximum 20 playlists allowed" });

    try {
        const result = await HandleDatabase.insertPlaylist(name.trim(), req.user);
        res.json({ success: true, playlist: { id: result.lastID, name: name.trim(), owner: req.user } });
    } catch (err) {
        console.error('[CREATE PLAYLIST]', err);
        res.status(500).json({ error: "Failed to create playlist" });
    }
});

// Get user's playlists
app.get('/api/playlists', requireLogin, async (req, res) => {
    try {
        const playlists = await HandleDatabase.getPlaylistsByUser(req.user);
        const enhanced = await Promise.all(playlists.map(async p => {
            const songCount = await HandleDatabase.getPlaylistSongCount(p.id);
            return {
                ...p,
                song_count: songCount,
                cover_url: Media.resolveCover('playlist_' + p.id)
            };
        }));
        res.json(enhanced);
    } catch (err) {
        console.error('[GET PLAYLISTS]', err);
        res.status(500).json({ error: "Failed to fetch playlists" });
    }
});

// Update playlist metadata
app.patch('/api/playlists/:id', requireLogin, async (req, res) => {
    const playlistId = req.params.id;
    const { name, bio, is_private } = req.body;
    if (!name || name.trim() === '') return res.status(400).json({ error: "Playlist name is required" });
    if (name.length > 60) return res.status(400).json({ error: "Playlist name too long (max 60 chars)" });
    if (bio && bio.length > 300) return res.status(400).json({ error: "Playlist bio too long (max 300 chars)" });

    const playlist = await HandleDatabase.getPlaylistById(playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    if (playlist.owner !== req.user) return res.status(403).json({ error: "Forbidden" });

    try {
        await HandleDatabase.updatePlaylistMetadata(playlistId, name.trim(), bio || '', is_private || playlist.is_private);
        res.json({ success: true });
    } catch (err) {
        console.error('[UPDATE PLAYLIST]', err);
        res.status(500).json({ error: "Failed to update playlist" });
    }
});

// Delete playlist
app.delete('/api/playlists/:id', requireLogin, async (req, res) => {
    const playlistId = req.params.id;
    const playlist = await HandleDatabase.getPlaylistById(playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    if (playlist.owner !== req.user) return res.status(403).json({ error: "Forbidden" });

    try {
        await HandleDatabase.deletePlaylist(playlistId);
        res.json({ success: true });
    } catch (err) {
        console.error('[DELETE PLAYLIST]', err);
        res.status(500).json({ error: "Failed to delete playlist" });
    }
});

// Clone Shared Playlist
app.post('/api/playlists/share/:shareId/clone', requireLogin, async (req, res) => {
    const shareId = req.params.shareId;
    try {
        const original = await HandleDatabase.getPlaylistByShareId(shareId);
        if (!original) return res.status(404).json({ error: "Shared playlist not found" });
        if (original.is_private === 'private' && original.owner !== req.user) {
            return res.status(403).json({ error: "This playlist is private." });
        }

        const userPlaylists = await HandleDatabase.getPlaylistsByUser(req.user);
        if (userPlaylists.length >= 20) return res.status(400).json({ error: "Maximum 20 playlists allowed" });

        // Create new playlist with original metadata
        const result = await HandleDatabase.insertPlaylist(original.name, req.user, original.original_owner || original.owner);
        const newPlaylistId = result.lastID;

        // Duplicate cover photo physically if it exists
        const originalCoverPattern = `playlist_${original.id}`;
        const coversDir = RT.paths.covers;
        const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        let originalCoverPath = null;
        let originalExt = null;

        // Try to find the file even if cover_path is null in DB (standard naming pattern)
        for (const ext of exts) {
            const p = path.join(coversDir, `${originalCoverPattern}${ext}`);
            if (fs.existsSync(p)) {
                originalCoverPath = p;
                originalExt = ext;
                break;
            }
        }

        // Fallback to cover_path if it's set explicitly but doesn't follow the pattern
        if (!originalCoverPath && original.cover_path) {
            const p = path.join(RT.DATA_ROOT, 'Static', original.cover_path);
            if (fs.existsSync(p)) {
                originalCoverPath = p;
                originalExt = path.extname(original.cover_path);
            }
        }

        let newCoverPath = null;
        if (originalCoverPath) {
            try {
                // Save using the standard pattern for the new playlist
                const newCoverFileName = `playlist_${newPlaylistId}${originalExt}`;
                const newCoverFullPath = path.join(coversDir, newCoverFileName);
                fs.copyFileSync(originalCoverPath, newCoverFullPath);
                newCoverPath = `/Static/covers/${newCoverFileName}`;
            } catch (err) {
                console.error('[CLONE COVER ERROR]', err);
            }
        }

        // Update metadata (bio and new cover)
        await HandleDatabase.updatePlaylist(newPlaylistId, {
            bio: original.bio || "",
            cover_path: newCoverPath
        });

        // Copy songs and their lyrics
        const songs = (await HandleDatabase.getPlaylistSongs(original.id))
            .filter(song => canAccessSong(song, req.user));
        for (let i = 0; i < songs.length; i++) {
            const songId = songs[i].song_id;
            await HandleDatabase.addSongToPlaylist(newPlaylistId, songId, i);

            // CLONE LYRICS: Try to get original owner's lyrics and copy them to the new user
            try {
                let originalLyrics = await HandleDatabase.getLyricsBySongId(songId, original.owner);

                // Fallback to orphaned/migrated lyrics if owner hasn't customized them
                if (!originalLyrics) {
                    originalLyrics = await HandleDatabase.getLyricsBySongId(songId, '');
                    if (!originalLyrics) originalLyrics = await HandleDatabase.getLyricsBySongId(songId, null);
                }

                if (originalLyrics) {
                    // Save a fresh copy for the new user (per-user storage)
                    await HandleDatabase.saveLyrics(songId, req.user, originalLyrics.lyrics, originalLyrics.is_synced);
                }
            } catch (lyrErr) {
                console.warn(`[CLONE LYRICS WARNING] Failed for song ${songId}:`, lyrErr.message);
            }
        }

        res.json({ success: true, playlistId: newPlaylistId, name: original.name });
    } catch (err) {
        console.error('[CLONE PLAYLIST]', err);
        res.status(500).json({ error: "Failed to clone playlist" });
    }
});

// Add song to playlist
app.post('/api/playlists/:id/songs', requireLogin, async (req, res) => {
    const playlistId = req.params.id;
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ error: "Song ID is required" });

    const playlist = await HandleDatabase.getPlaylist(playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    if (playlist.owner !== req.user) return res.status(403).json({ error: "Forbidden" });

    const songCount = await HandleDatabase.getPlaylistSongCount(playlistId);
    if (songCount >= 100) return res.status(400).json({ error: "Playlist is full (max 100 songs)" });

    const song = await HandleDatabase.getSong(songId);
    if (!song) return res.status(404).json({ error: "Song not found" });
    if (!canAccessSong(song, req.user)) {
        return res.status(403).json({ error: "You do not have access to this song" });
    }

    try {
        await HandleDatabase.addSongToPlaylist(playlistId, songId, songCount);
        res.json({ success: true });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: "Song already in playlist" });
        }
        console.error('[ADD SONG TO PLAYLIST]', err);
        res.status(500).json({ error: "Failed to add song to playlist" });
    }
});

// Remove song from playlist
app.delete('/api/playlists/:id/songs/:songId', requireLogin, async (req, res) => {
    const playlistId = req.params.id;
    const songId = req.params.songId;

    const playlist = await HandleDatabase.getPlaylist(playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    if (playlist.owner !== req.user) return res.status(403).json({ error: "Forbidden" });

    try {
        await HandleDatabase.removeSongFromPlaylist(playlistId, songId);
        res.json({ success: true });
    } catch (err) {
        console.error('[REMOVE SONG FROM PLAYLIST]', err);
        res.status(500).json({ error: "Failed to remove song from playlist" });
    }
});

// Get playlist songs (Strict Ownership for private playlists)
app.get('/api/playlists/:id/songs', requireLogin, async (req, res) => {
    const playlistId = req.params.id;
    const playlist = await HandleDatabase.getPlaylistById(playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });

    // Access control: only owner can access via numeric ID if it's private
    if (playlist.is_private === 'private' && playlist.owner !== req.user) {
        return res.status(403).json({ error: "This playlist is private." });
    }

    try {
        const songs = (await HandleDatabase.getPlaylistSongs(playlistId))
            .filter(song => canAccessSong(song, req.user));
        let totalSeconds = 0;
        const result = songs.map(s => {
            totalSeconds += parseFloat(s.duration || 0);
            return {
                id: s.song_id,
                ...songIdentityContract(s),
                name: s.songname,
                artist: s.artist,
                album: s.album,
                duration: Media.formatDuration(s.duration),
                cover: resolveSongCover(s),
                uploaded_by: s.uploaded_by,
                added_at: s.added_at,
                bitrate: s.bitrate,
                extension: path.extname(s.filepath).toLowerCase()
            };
        });
        const total_duration_formatted = Media.formatDuration(totalSeconds);
        res.json({
            playlist: {
                id: playlist.id,
                name: playlist.name,
                owner: playlist.owner,
                bio: playlist.bio,
                is_private: playlist.is_private,
                share_id: playlist.share_id,
                cover_url: Media.resolveCover('playlist_' + playlist.id)
            },
            total_duration_formatted,
            songs: result
        });
    } catch (err) {
        console.error('[GET PLAYLIST SONGS]', err);
        res.status(500).json({ error: "Failed to fetch playlist songs" });
    }
});

// Get playlist by Share ID (Public Access via Hashed Link)
app.get('/api/playlists/share/:shareId', async (req, res) => {
    const shareId = req.params.shareId;
    if (!shareId) return res.status(400).json({ error: "Share ID is required" });

    try {
        const playlist = await HandleDatabase.getPlaylistByShareId(shareId);
        if (!playlist) return res.status(404).json({ error: "Playlist not found" });

        const user = await getCurrentUser(req);

        if (playlist.is_private === 'private') {
            if (!user || user !== playlist.owner) {
                return res.status(403).json({ error: "This playlist is private." });
            }
        }

        const songs = (await HandleDatabase.getPlaylistSongs(playlist.id))
            .filter(song => canAccessSong(song, user));
        let totalSeconds = 0;
        const result = songs.map(s => {
            totalSeconds += parseFloat(s.duration || 0);
            return {
                id: s.song_id,
                ...songIdentityContract(s),
                name: s.songname,
                artist: s.artist,
                album: s.album,
                duration: Media.formatDuration(s.duration),
                cover: resolveSongCover(s),
                uploaded_by: s.uploaded_by,
                added_at: s.added_at,
                bitrate: s.bitrate,
                extension: path.extname(s.filepath).toLowerCase()
            };
        });

        const total_duration_formatted = Media.formatDuration(totalSeconds);
        res.json({
            playlist: {
                id: playlist.id,
                name: playlist.name,
                owner: playlist.owner,
                bio: playlist.bio,
                is_private: playlist.is_private,
                share_id: playlist.share_id,
                cover_url: Media.resolveCover('playlist_' + playlist.id)
            },
            total_duration_formatted,
            songs: result
        });
    } catch (err) {
        console.error('[GET SHARED PLAYLIST]', err);
        res.status(500).json({ error: "Failed to fetch shared playlist" });
    }
});

// Upload Cover for Playlist
app.post('/api/playlists/:id/cover', requireLogin, uploadCover.single('cover_file'), async (req, res) => {
    const playlistId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "No file" });

    const playlist = await HandleDatabase.getPlaylist(playlistId);
    if (!playlist) return res.status(404).json({ error: "Playlist not found" });
    if (playlist.owner !== req.user) return res.status(403).json({ error: "Forbidden" });

    try {
        const coversDir = RT.paths.covers;
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

        const savePath = path.join(coversDir, `playlist_${playlist.id}.jpg`);
        fs.writeFileSync(savePath, req.file.buffer);

        res.json({ success: true, cover: Media.resolveCover(`playlist_${playlist.id}`) });
    } catch (err) {
        console.error('[PLAYLIST COVER UPLOAD]', err);
        res.status(500).json({ error: "Failed to upload playlist cover" });
    }
});

// --- Admin/Moderation Endpoints ---

// Promote/Update Role
app.post('/api/admin/promote', requireRole(['Owner', 'Admin']), async (req, res) => {
    const { username, role } = req.body;
    const targetUser = await HandleDatabase.getUser(username);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    // Hierarchy check
    if (req.userRow.role === 'Admin') {
        if (role === 'Owner' || role === 'Admin') return res.status(403).json({ error: "Admins cannot promote to Admin/Owner" });
        if (targetUser.role === 'Owner' || targetUser.role === 'Admin') return res.status(403).json({ error: "Admins cannot demote/change higher roles" });
    }

    if (role === 'Owner') return res.status(403).json({ error: "Ownership cannot be transferred" });

    await HandleDatabase.updateUserRole(username, role);
    await HandleDatabase.insertSystemLog(req.user, 'promote', `Promoted ${username} to ${role}`);
    res.json({ success: true, message: `User ${username} promoted to ${role}` });
});

// Ban User
app.post('/api/admin/ban', requireRole(['Owner', 'Admin']), async (req, res) => {
    const { username } = req.body;
    const targetUser = await HandleDatabase.getUser(username);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    if (targetUser.role === 'Owner') return res.status(403).json({ error: "Cannot ban Owner" });
    if (req.userRow.role === 'Admin' && targetUser.role === 'Admin') return res.status(403).json({ error: "Admins cannot ban other Admins" });

    await HandleDatabase.banUser(username, 1);
    await HandleDatabase.insertSystemLog(req.user, 'ban', `Banned user: ${username}`);
    res.json({ success: true, message: `User ${username} banned` });
});

// Unban User
app.post('/api/admin/unban', requireRole(['Owner', 'Admin']), async (req, res) => {
    const { username } = req.body;
    await HandleDatabase.banUser(username, 0);
    await HandleDatabase.insertSystemLog(req.user, 'unban', `Unbanned user: ${username}`);
    res.json({ success: true, message: `User ${username} unbanned` });
});

// Timeout User
app.post('/api/admin/timeout', requireRole(['Owner', 'Admin', 'Moderator']), async (req, res) => {
    const { username, durationMinutes } = req.body;
    const targetUser = await HandleDatabase.getUser(username);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    if (targetUser.role === 'Owner') return res.status(403).json({ error: "Cannot timeout Owner" });
    if (req.userRow.role !== 'Owner' && (targetUser.role === 'Admin' || targetUser.role === 'Owner')) return res.status(403).json({ error: "Insufficient permissions" });

    const until = new Date(Date.now() + durationMinutes * 60000).toISOString();
    await HandleDatabase.timeoutUser(username, until);
    await HandleDatabase.insertSystemLog(req.user, 'timeout', `Timed out ${username} until ${until}`);
    res.json({ success: true, message: `User ${username} timed out until ${until}` });
});

// Delete Post
app.delete('/api/posts/:id', requireRole(['Owner', 'Admin', 'Moderator', 'User']), async (req, res) => {
    const postId = req.params.id;
    const post = await HandleDatabase.getPost(postId, req.user, true);
    if (!post) return res.status(404).json({ error: "Post not found" });

    const isModeratorPlus = ['Owner', 'Admin', 'Moderator'].includes(req.userRow.role);
    const isOwner = post.username === req.user;

    if (isModeratorPlus || isOwner) {
        await HandleDatabase.deletePost(postId);
        req.app.get('io').emit('post_deleted', { postId });
        return res.json({ success: true, message: "Post deleted" });
    } else {
        return res.status(403).json({ error: "You don't have permission to delete this post" });
    }
});

// Admin: Toggle Shadow Ban on Post
app.post('/api/admin/post/shadow-ban', requireLogin, async (req, res) => {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: "Post ID is required." });

    // Check if user is Admin or Owner
    if (req.userRow.role !== 'Admin' && req.userRow.role !== 'Owner') {
        return res.status(403).json({ error: "Only admins or owners can shadow ban posts." });
    }

    try {
        const post = await HandleDatabase.getPost(postId, req.user, true); // true to show flagged
        if (!post) return res.status(404).json({ error: "Post not found." });

        const newFlagged = post.is_flagged ? 0 : 1;
        await HandleDatabase.updatePostFlag(postId, newFlagged);

        res.json({ success: true, is_shadow_banned: !!newFlagged, message: newFlagged ? "Post shadow banned." : "Post un-shadow banned." });
    } catch (err) {
        console.error("[ADMIN SHADOW BAN ERROR]", err);
        res.status(500).json({ error: "Failed to toggle shadow ban." });
    }
});

// Delete Comment
app.delete('/api/comments/:id', requireRole(['Owner', 'Admin', 'Moderator', 'User']), async (req, res) => {
    const commentId = req.params.id;
    const comment = await HandleDatabase.getComment(commentId);
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    const isModeratorPlus = ['Owner', 'Admin', 'Moderator'].includes(req.userRow.role);
    const isOwner = comment.username === req.user;

    if (isModeratorPlus || isOwner) {
        const postId = comment.post_id;
        await HandleDatabase.deleteComment(commentId);
        const post = await HandleDatabase.getPost(postId);
        if (post) req.app.get('io').emit('comment_deleted', { commentId, postId, comments: post.comments });
        return res.json({ success: true, message: "Comment deleted", comments: post ? post.comments : 0 });
    } else {
        return res.status(403).json({ error: "You don't have permission to delete this comment" });
    }
});

// Delete Song (Safe Deletion)
app.delete('/api/songs/:id', requireLogin, async (req, res) => {
    const songId = req.params.id;
    const song = await HandleDatabase.getSong(songId);
    if (!song) return res.status(404).json({ error: "Song not found" });
    if (song.source === 'folder') {
        return res.status(409).json({ error: "Folder-managed songs must be removed from the source folder and rescanned." });
    }

    const isOwnerRole = req.userRow.role === 'Owner';
    const isUploader = song.uploaded_by === req.user;

    if (isOwnerRole || isUploader) {
        try {
            // Check if others are using this song in their playlists
            const usageCount = await HandleDatabase.getPlaylistUsageCount(song.id, req.user);

            // Physical file cleanup only if NO ONE else is using it
            if (usageCount === 0) {
                const fullPath = path.join(RT.DATA_ROOT, song.filepath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    fs.unlinkSync(fullPath);
                    // Decrement storage quota
                    await HandleDatabase.decrementStorageUsed(song.uploaded_by, stats.size);
                    console.log(`[CLEANUP] Deleted physical file: ${fullPath} (-${stats.size} bytes)`);

                    // Clean up cover
                    const baseName = path.basename(song.filepath, path.extname(song.filepath));
                    const coverExts = ['.jpg', '.jpeg', '.png', '.webp'];
                    for (const ext of coverExts) {
                        const cp = path.join(RT.paths.covers, baseName + ext);
                        if (fs.existsSync(cp)) fs.unlinkSync(cp);
                    }
                }
                await HandleDatabase.deleteSong(song.id);
            } else {
                // Someone else is using it! Just hide it from the uploader and clear their quota
                console.log(`[SAFE DELETE] Song ${song.id} is in use by ${usageCount} other playlists. Keeping file.`);
                const fullPath = path.join(RT.DATA_ROOT, song.filepath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    await HandleDatabase.decrementStorageUsed(song.uploaded_by, stats.size);
                }
                await HandleDatabase.hideSongFromUploader(song.id);
            }

            await HandleDatabase.removeSongFromUserPlaylists(song.id, req.user);
            return res.json({ success: true, message: usageCount > 0 ? "Song removed from your library" : "Song deleted" });
        } catch (err) {
            console.error('[DELETE SONG]', err);
            res.status(500).json({ error: "Internal server error" });
        }
    } else {
        return res.status(403).json({ error: "Forbidden" });
    }
});

// Update Song Metadata
app.patch('/api/songs/:id', requireLogin, async (req, res) => {
    const songId = req.params.id;
    const { songname, artist, album, genre, year, is_private } = req.body;

    const song = await HandleDatabase.getSong(songId);
    if (!song) return res.status(404).json({ error: "Song not found" });

    const isOwnerRole = req.userRow.role === 'Owner';
    const isUploader = song.uploaded_by === req.user;

    if (isOwnerRole || isUploader) {
        const metadataUpdates = {};
        if (songname !== undefined) metadataUpdates.songname = songname;
        if (artist !== undefined) metadataUpdates.artist = artist;
        if (album !== undefined) metadataUpdates.album = album;
        if (genre !== undefined) metadataUpdates.genre = genre;
        if (year !== undefined) {
            const parsedYear = year === '' || year === null ? null : (/^\d{4}$/.test(String(year).trim()) ? Number(year) : NaN);
            if (parsedYear !== null && (!Number.isInteger(parsedYear) || parsedYear < 1000 || parsedYear > 9999)) {
                return res.status(400).json({ error: 'Year must be a four-digit year' });
            }
            metadataUpdates.year = parsedYear;
        }

        if (Object.keys(metadataUpdates).length > 0) {
            await HandleDatabase.updateSongMetadata(song.id, metadataUpdates, {
                status: 'identified',
                source: 'manual',
                pipelineVersion: 'manual-v1',
                lockFields: true
            });
        }
        if (is_private !== undefined) await HandleDatabase.updateSong(song.id, { is_private });
        res.json({ success: true, message: "Song updated" });
    } else {
        res.status(403).json({ error: "Forbidden" });
    }
});

function absoluteSongPath(song) {
    if (!song || !song.filepath) return null;
    return path.isAbsolute(song.filepath)
        ? path.resolve(song.filepath)
        : path.resolve(RT.DATA_ROOT, song.filepath);
}

async function enrichSongWithLookupMode(song, mode, { signal } = {}) {
    const lookupMode = METADATA_LOOKUP_MODES.has(mode) ? mode : DEFAULT_METADATA_LOOKUP_MODE;
    const options = {
        mode: lookupMode,
        signal,
        filepath: absoluteSongPath(song)
    };
    if (lookupMode === 'acoustic_with_text_fallback') {
        const key = await effectiveAcoustidKey();
        if (key) options.acoustidKey = key;
    } else if (lookupMode === 'local_only') {
        options.requestJson = async () => ({
            status: 'no_match',
            detail: 'local_only',
            cached: false,
            attempts: 0
        });
    }
    return await AIMetadata.enrichSong(song, options);
}

function normalizeEnrichmentField(field) {
    const value = String(field || '').trim();
    if (value === 'title') return 'songname';
    if (['cover', 'cover_url', 'cover_path'].includes(value)) return 'coverUrl';
    return value;
}

function isPlaceholderMetadata(field, value) {
    if (value === null || value === undefined || String(value).trim() === '') return true;
    if (field === 'year') return !Number.isInteger(Number(value)) || Number(value) <= 0;
    const normalized = String(value).trim().toLowerCase();
    if (['unknown', 'n/a', 'none', 'null', 'not available', 'untitled', 'untitled track'].includes(normalized)) return true;
    if (field === 'songname') return normalized === 'unknown title' || normalized === 'unknown track';
    if (field === 'artist') return normalized === 'unknown artist';
    if (field === 'album') return normalized === 'unknown album' || normalized === 'unknown release';
    if (field === 'genre') return normalized === 'unknown genre';
    return false;
}

function validateEnrichmentUpdates(value, { allowCover = true } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'Updates must be an object' };
    }
    const allowed = new Set(['songname', 'artist', 'album', 'genre', 'year', ...(allowCover ? ['coverUrl'] : [])]);
    const limits = { songname: 300, artist: 300, album: 300, genre: 120 };
    const updates = {};
    for (const [rawField, rawValue] of Object.entries(value)) {
        const field = normalizeEnrichmentField(rawField);
        if (!allowed.has(field) || Object.prototype.hasOwnProperty.call(updates, field)) {
            return { error: `Unsupported metadata field: ${rawField}` };
        }
        if (field === 'year') {
            const year = typeof rawValue === 'string' && /^\d{4}$/u.test(rawValue.trim())
                ? Number(rawValue.trim())
                : rawValue;
            if (!Number.isInteger(year) || year < 1000 || year > 9999) return { error: 'Year must be a four-digit year' };
            updates.year = year;
            continue;
        }
        if (field === 'coverUrl') {
            if (typeof rawValue !== 'string' || rawValue.length > 2048 || !AIMetadata.isTrustedCoverUrl(rawValue)) {
                return { error: 'Unsupported cover source' };
            }
            updates.coverUrl = rawValue;
            continue;
        }
        if (typeof rawValue !== 'string' || rawValue !== rawValue.trim() || rawValue.length < 1 ||
            rawValue.length > limits[field] || /[\u0000-\u001F\u007F]/u.test(rawValue)) {
            return { error: `Invalid ${field} value` };
        }
        updates[field] = rawValue;
    }
    return { updates };
}

function candidateFieldValue(candidate, field) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (field === 'songname') return candidate.songname ?? candidate.title ?? candidate.name ?? null;
    if (field === 'artist') {
        const value = candidate.artist ?? candidate.artistName ?? candidate.artists;
        return Array.isArray(value) ? value.map(entry => typeof entry === 'object' ? entry.name : entry).filter(Boolean).join(', ') : value;
    }
    if (field === 'album') return candidate.album ?? candidate.albumName ?? candidate.releaseTitle ?? null;
    if (field === 'genre') return candidate.genre ?? candidate.primaryGenre ?? null;
    if (field === 'year') {
        const value = candidate.year ?? candidate.releaseYear ?? candidate.releaseDate ?? candidate.date;
        const match = /^(\d{4})/u.exec(String(value || '').trim());
        return match ? Number(match[1]) : null;
    }
    if (field === 'coverUrl') return candidate.coverUrl ?? candidate.cover_url ?? candidate.artworkUrl ?? null;
    return null;
}

function candidateValueMatches(candidate, field, value) {
    const candidateValue = candidateFieldValue(candidate, field);
    if (field === 'year') return Number(candidateValue) === Number(value);
    return candidateValue !== null && candidateValue !== undefined && String(candidateValue).trim() === String(value).trim();
}

function externalIdentifiersForCandidate(candidate) {
    const identifiers = [];
    const seen = new Set();
    const add = (type, value) => {
        for (const entry of Array.isArray(value) ? value : [value]) {
            const clean = String(entry === null || entry === undefined ? '' : entry).trim();
            if (!clean) continue;
            const key = `${type}\u0000${clean.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            identifiers.push({ type, value: clean });
        }
    };
    const ids = candidate && candidate.externalIds || {};
    const mappings = {
        musicbrainzRecording: 'musicbrainz_recording',
        musicbrainzReleases: 'musicbrainz_release',
        musicbrainzReleaseGroups: 'musicbrainz_release_group',
        musicbrainzArtists: 'musicbrainz_artist',
        isrcs: 'isrc',
        acoustid: 'acoustid',
        appleTrack: 'apple_track',
        appleCollection: 'apple_collection',
        appleArtist: 'apple_artist'
    };
    Object.entries(mappings).forEach(([key, type]) => add(type, ids[key]));
    for (const credit of Array.isArray(candidate && candidate.artistCredits) ? candidate.artistCredits : []) {
        const artistId = credit && (credit.id || credit.artist && credit.artist.id);
        if (!artistId) continue;
        add(/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(String(artistId)) ? 'musicbrainz_artist' : 'provider_artist', artistId);
    }
    if (candidate && candidate.recordingId) {
        const provider = String(candidate.provider || candidate.source || '').toLowerCase();
        if (provider === 'musicbrainz' || /^[0-9a-f-]{36}$/iu.test(String(candidate.recordingId))) {
            add('musicbrainz_recording', candidate.recordingId);
        } else if (provider === 'apple') {
            add('apple_track', candidate.recordingId);
        }
    }
    if (candidate && candidate._selectedReleaseId) {
        const provider = String(candidate._selectedReleaseProvider || candidate.provider || '').toLowerCase();
        add(provider === 'apple' ? 'apple_collection' : 'musicbrainz_release', candidate._selectedReleaseId);
    }
    if (candidate && candidate.releaseTrackId) add('provider_release_track', candidate.releaseTrackId);
    return identifiers;
}

function providerFailurePresent(result) {
    const failures = new Set(['offline', 'rate_limited', 'invalid_key', 'provider_error']);
    return Array.isArray(result && result.providers) && result.providers.some(provider => failures.has(provider.status));
}

function automaticCandidateUpdates(song, candidate, lockedFields) {
    const updates = {};
    const locked = new Set((lockedFields || []).map(normalizeEnrichmentField));
    const safety = candidate && candidate.fieldSafety || {};
    for (const field of ['songname', 'artist', 'album', 'genre', 'year']) {
        const safe = safety[field] === true || (field === 'songname' && safety.title === true);
        const value = candidateFieldValue(candidate, field);
        if (!safe || value === null || value === undefined || value === '' || locked.has(field)) continue;
        if (isPlaceholderMetadata(field, song[field])) updates[field] = value;
    }
    return updates;
}

function candidateNeedsReview(song, candidate, automaticUpdates) {
    for (const field of ['songname', 'artist', 'album', 'genre', 'year']) {
        const value = candidateFieldValue(candidate, field);
        if (value === null || value === undefined || value === '') continue;
        const same = field === 'year'
            ? Number(song[field]) === Number(value)
            : String(song[field] || '').trim().toLowerCase() === String(value).trim().toLowerCase();
        if (!same && !Object.prototype.hasOwnProperty.call(automaticUpdates, field)) return true;
    }
    return Boolean(candidateFieldValue(candidate, 'coverUrl'));
}

async function stageEnrichmentCover(song, coverUrl) {
    const safeSongUid = String(song.song_uid || song.id).replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 80);
    const filename = `smart_cover_${safeSongUid}_${crypto.randomUUID()}.jpg`;
    const destination = path.join(RT.paths.covers, filename);
    const downloaded = await AIMetadata.downloadFile(coverUrl, destination);
    if (!downloaded) return null;
    return { destination, coverPath: `/Static/covers/${filename}` };
}

function removeStagedCover(staged) {
    if (!staged || !staged.destination) return;
    try { if (fs.existsSync(staged.destination)) fs.unlinkSync(staged.destination); } catch { /* best-effort cleanup */ }
}

async function processEnrichmentJobItem(item, signal) {
    const song = await HandleDatabase.getSong(item.song_id, { includeUnavailable: true });
    if (!song || song.availability !== 'available') {
        await HandleDatabase.storeEnrichmentItemResult(item.id, {
            result: {
                original: song ? { title: song.songname, songname: song.songname, artist: song.artist, album: song.album, genre: song.genre, year: song.year } : {},
                candidates: [],
                providers: [{ name: 'local_file', status: 'provider_error', detail: 'file_unavailable' }],
                evidence: [],
                outcome: 'provider_error',
                stage: 'provider_error',
                pipelineVersion: AIMetadata.PIPELINE_VERSION
            },
            status: 'error',
            error: 'file_unavailable',
            songStatus: song ? 'error' : null
        });
        return;
    }

    const configuredMode = item.options && item.options.lookupMode;
    const mode = METADATA_LOOKUP_MODES.has(configuredMode) ? configuredMode : currentMetadataLookupMode();
    const result = await enrichSongWithLookupMode(song, mode, { signal });
    if (signal.aborted) return;
    const candidates = Array.isArray(result && result.candidates) ? result.candidates : [];
    const top = candidates[0] || null;

    if (!top) {
        const failed = providerFailurePresent(result) || !result;
        await HandleDatabase.storeEnrichmentItemResult(item.id, {
            result,
            candidates,
            status: failed ? 'error' : 'unidentified',
            error: failed ? 'provider_failure' : null,
            songStatus: failed ? 'error' : 'unknown'
        });
        return;
    }

    if (mode !== 'acoustic_with_text_fallback' || top.safeToApply !== true) {
        await HandleDatabase.storeEnrichmentItemResult(item.id, {
            result,
            candidates,
            status: 'review',
            songStatus: 'review'
        });
        return;
    }

    const lockedFields = await HandleDatabase.getLockedMetadataFields(song.id);
    const proposedUpdates = automaticCandidateUpdates(song, top, lockedFields);
    const automaticValidation = validateEnrichmentUpdates(proposedUpdates, { allowCover: false });
    const updates = automaticValidation.error ? {} : automaticValidation.updates;
    const coverWouldAutoApply = top.fieldSafety && top.fieldSafety.coverUrl === true &&
        isPlaceholderMetadata('coverUrl', song.cover_path);
    if (coverWouldAutoApply) {
        await HandleDatabase.storeEnrichmentItemResult(item.id, {
            result,
            candidates,
            status: 'review',
            songStatus: 'review'
        });
        return;
    }
    const needsReview = candidateNeedsReview(song, top, updates);
    await HandleDatabase.storeEnrichmentItemResult(item.id, {
        result,
        candidates,
        status: needsReview ? 'review' : 'applied',
        songStatus: needsReview ? 'review' : 'identified',
        automatic: {
            updates,
            identifiers: externalIdentifiersForCandidate(top),
            candidate: top,
            method: 'strict_automatic',
            identitySource: Array.isArray(top.providers) && top.providers.length
                ? top.providers.join('+')
                : (top.provider || top.source || 'registry'),
            confidence: top.confidence,
            source: 'smart-auto-enrich',
            pipelineVersion: result.pipelineVersion || AIMetadata.PIPELINE_VERSION
        }
    });
}

async function runEnrichmentWorker(jobId, controller) {
    while (!controller.signal.aborted && !isShuttingDown) {
        const job = await HandleDatabase.getEnrichmentJob(jobId);
        if (!job || !['queued', 'running'].includes(job.status)) return;
        const item = await HandleDatabase.claimNextEnrichmentJobItem(job.id);
        if (!item) {
            await HandleDatabase.syncEnrichmentJobState(job.id);
            return;
        }
        try {
            await processEnrichmentJobItem(item, controller.signal);
        } catch {
            if (!controller.signal.aborted) {
                await HandleDatabase.storeEnrichmentItemResult(item.id, {
                    result: {
                        original: {},
                        candidates: [],
                        providers: [{ name: 'metadata_lookup', status: 'provider_error', detail: 'lookup_failed' }],
                        evidence: [],
                        outcome: 'provider_error',
                        stage: 'provider_error',
                        pipelineVersion: AIMetadata.PIPELINE_VERSION
                    },
                    status: 'error',
                    error: 'lookup_failed',
                    songStatus: 'error'
                });
            }
        }
        if (controller.signal.aborted || isShuttingDown) {
            const currentJob = await HandleDatabase.getEnrichmentJob(job.id);
            await HandleDatabase.requeueEnrichmentJobItem(item.id, { cancelled: currentJob && currentJob.status === 'cancelled' });
            await HandleDatabase.syncEnrichmentJobState(job.id);
            return;
        }
        await HandleDatabase.syncEnrichmentJobState(job.id);
    }
}

function startEnrichmentWorker(jobId) {
    const key = String(jobId);
    const existing = activeEnrichmentWorkers.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const entry = { controller, promise: null };
    entry.promise = runEnrichmentWorker(jobId, controller)
        .catch(async error => {
            console.error('[ENRICHMENT JOB] Worker stopped unexpectedly:', error);
            try {
                const processingItems = await HandleDatabase.getEnrichmentJobItems(jobId, { status: 'processing' });
                for (const item of processingItems) {
                    await HandleDatabase.requeueEnrichmentJobItem(item.id);
                }
                await HandleDatabase.updateEnrichmentJob(jobId, {
                    status: 'paused',
                    error: 'worker_failure'
                });
            } catch (recoveryError) {
                console.error('[ENRICHMENT JOB] Worker recovery failed:', recoveryError);
            }
        })
        .finally(() => {
            if (activeEnrichmentWorkers.get(key) === entry) activeEnrichmentWorkers.delete(key);
        });
    activeEnrichmentWorkers.set(key, entry);
    return entry.promise;
}

async function stopEnrichmentWorker(jobId) {
    const entry = activeEnrichmentWorkers.get(String(jobId));
    if (!entry) return;
    entry.controller.abort();
    await entry.promise;
}

async function stopAllEnrichmentWorkers() {
    const entries = Array.from(activeEnrichmentWorkers.values());
    entries.forEach(entry => entry.controller.abort());
    await Promise.allSettled(entries.map(entry => entry.promise));
}

function safeSongForEnrichment(song) {
    return {
        id: song.id,
        ...songIdentityContract(song),
        songname: song.songname,
        title: song.songname,
        artist: song.artist,
        album: song.album,
        genre: song.genre || null,
        year: song.year || null,
        duration: song.duration,
        duration_ms: song.duration_ms,
        cover: resolveSongCover(song),
        cover_path: song.cover_path || null,
        metadata_revision: Number(song.metadata_revision) || 0,
        uploaded_by: song.uploaded_by
    };
}

async function formatEnrichmentItem(item) {
    if (!item) return null;
    const [song, rows, lockedFields] = await Promise.all([
        HandleDatabase.getSong(item.song_id, { includeUnavailable: true }),
        HandleDatabase.getEnrichmentCandidates(item.id),
        HandleDatabase.getLockedMetadataFields(item.song_id)
    ]);
    if (!song) return null;
    const result = item.result && typeof item.result === 'object' ? item.result : {};
    const candidates = rows.map(row => ({
        ...(row.payload && typeof row.payload === 'object' ? row.payload : {}),
        engineCandidateId: row.payload && (row.payload.candidateId || row.payload.id) || null,
        candidateId: row.id,
        id: row.id,
        persistedCandidateId: row.id
    }));
    const stage = item.status === 'error'
        ? 'provider_error'
        : (item.status === 'unidentified' ? 'unidentified' : 'needs_review');
    const originalSong = safeSongForEnrichment(song);
    const top = candidates[0] || null;
    return {
        itemId: item.id,
        item_id: item.id,
        songId: song.id,
        song_id: song.id,
        song: originalSong,
        original: { ...(result.original || {}), ...originalSong },
        candidates,
        providers: Array.isArray(result.providers) ? result.providers : [],
        evidence: Array.isArray(result.evidence) ? result.evidence : [],
        conflicts: result.conflicts || top && top.conflicts || [],
        ambiguousFields: result.ambiguousFields || top && top.ambiguousFields || [],
        safeToApply: result.safeToApply === true,
        fieldSafety: top && top.fieldSafety || {},
        lockedFields,
        metadataRevision: Number(item.metadata_revision) || 0,
        metadata_revision: Number(item.metadata_revision) || 0,
        outcome: result.outcome || item.status,
        pipelineVersion: result.pipelineVersion || item.job_pipeline_version || null,
        stage,
        status: item.status,
        error: item.error || ''
    };
}

function aggregateJobProviders(items) {
    const providers = new Map();
    for (const item of items) {
        const result = parseStoredConfigValue(item.result_json);
        for (const provider of Array.isArray(result && result.providers) ? result.providers : []) {
            const name = String(provider.name || provider.provider || 'Metadata source');
            providers.set(name.toLowerCase(), {
                name,
                provider: provider.provider || name,
                status: provider.status || 'unknown',
                detail: provider.detail || ''
            });
        }
    }
    return Array.from(providers.values());
}

async function enrichmentJobContract(job, { includeItem = true } = {}) {
    const current = await HandleDatabase.syncEnrichmentJobState(job.id) || job;
    const items = await HandleDatabase.getEnrichmentJobItems(current.id);
    const counts = {};
    items.forEach(item => { counts[item.status] = (counts[item.status] || 0) + 1; });
    const total = items.length;
    const processed = total - (counts.queued || 0) - (counts.processing || 0);
    const matched = counts.applied || 0;
    const review = counts.review || 0;
    const unidentified = counts.unidentified || 0;
    const errors = counts.error || 0;
    let stage;
    let message = '';
    if (current.status === 'paused') stage = 'paused';
    else if (current.status === 'cancelled') {
        stage = 'completed';
        message = 'The enrichment job was cancelled.';
    } else if (current.status === 'completed') stage = 'completed';
    else if (review > 0) stage = 'needs_review';
    else if (unidentified > 0) stage = 'unidentified';
    else if (errors > 0) stage = 'provider_error';
    else if ((counts.processing || 0) > 0 || (counts.queued || 0) > 0) {
        const options = parseStoredConfigValue(current.options_json) || {};
        stage = options.lookupMode === 'local_only' ? 'local_analysis' : 'registry_lookup';
    } else stage = 'preparing';
    const next = includeItem && ['needs_review', 'unidentified', 'provider_error'].includes(stage)
        ? await HandleDatabase.getNextEnrichmentReviewItem(current.id)
        : null;
    const item = next ? await formatEnrichmentItem(next) : null;
    const percent = total > 0 ? Math.round((processed / total) * 10000) / 100 : (stage === 'completed' ? 100 : 0);
    return {
        id: current.job_uid,
        jobId: current.job_uid,
        mode: current.mode,
        status: current.status,
        stage,
        cancelled: current.status === 'cancelled',
        total,
        processed,
        matched,
        needsReview: review,
        unidentified,
        errors,
        percent,
        progress: { total, processed, matched, needsReview: review, unidentified, errors, percent },
        providers: aggregateJobProviders(items),
        item,
        message,
        createdAt: current.created_at,
        startedAt: current.started_at,
        completedAt: current.completed_at
    };
}

async function ownedEnrichmentJob(identifier, username) {
    if (typeof identifier !== 'string' || identifier.length < 1 || identifier.length > 100) return null;
    const job = await HandleDatabase.getEnrichmentJob(identifier);
    if (!job) return null;
    return { job, owned: job.requested_by === username };
}

function resolvePersistedCandidate(rows, candidateId) {
    const requested = String(candidateId === null || candidateId === undefined ? '' : candidateId);
    const composite = /^(.*?)::release::(.+)$/u.exec(requested);
    for (const row of rows) {
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
        const parentIds = new Set([
            String(row.id),
            String(payload.candidateId ?? ''),
            String(payload.id ?? '')
        ]);
        if (composite && !parentIds.has(composite[1])) continue;
        if (String(row.id) === requested) return { candidate: payload, persistedCandidateId: row.id, selectedCandidateId: requested };
        for (const release of Array.isArray(payload.releaseCandidates) ? payload.releaseCandidates : []) {
            const selectedReleaseId = composite ? composite[2] : requested;
            if (String(release.id) !== selectedReleaseId) continue;
            return {
                candidate: {
                    ...payload,
                    ...release,
                    album: release.album || release.title || payload.album,
                    coverUrl: release.coverUrl || payload.coverUrl,
                    _selectedReleaseId: release.id,
                    _selectedReleaseProvider: release.provider
                },
                persistedCandidateId: row.id,
                selectedCandidateId: requested
            };
        }
    }
    return null;
}

app.post('/api/enrichment/jobs', requireRole(['Owner']), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.mode !== 'review') return res.status(400).json({ error: "mode must be 'review'" });
    if (!['song', 'library', 'unresolved', 'all'].includes(body.scope)) {
        return res.status(400).json({ error: "scope must be 'song', 'library', 'unresolved', or 'all'" });
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
        return res.status(400).json({ error: 'force must be a boolean' });
    }

    const activeJob = await HandleDatabase.getActiveEnrichmentJobForRequester(req.user);
    if (activeJob) {
        const activeContract = await enrichmentJobContract(activeJob);
        if (['queued', 'running', 'paused', 'awaiting_review'].includes(activeContract.status)) {
            return res.status(409).json({
                success: false,
                error: 'An enrichment job is already active',
                job: activeContract
            });
        }
    }

    const allSongs = await HandleDatabase.getAllSongs();
    const visibleSongs = allSongs.filter(song => !song.hidden_from_library && canAccessSong(song, req.user));
    const includeAll = body.force === true || body.scope === 'all';
    const unresolvedStatuses = new Set(['unreviewed', 'review', 'unknown', 'conflict', 'error']);
    let selectedSongs;
    if (body.scope === 'song') {
        if (!Number.isInteger(Number(body.songId)) || Number(body.songId) <= 0) {
            return res.status(400).json({ error: 'songId is required for song scope' });
        }
        const selectedSong = visibleSongs.find(song => song.id === Number(body.songId));
        if (!selectedSong) return res.status(404).json({ error: 'Song not found' });
        selectedSongs = [selectedSong];
    } else {
        selectedSongs = includeAll
            ? visibleSongs
            : visibleSongs.filter(song => unresolvedStatuses.has(song.metadata_status || 'unreviewed'));
    }
    const lookupMode = currentMetadataLookupMode();
    const job = await HandleDatabase.createEnrichmentJob({
        requestedBy: req.user,
        mode: 'review',
        options: { scope: body.scope, force: includeAll, lookupMode },
        songIds: selectedSongs.map(song => song.id),
        pipelineVersion: AIMetadata.PIPELINE_VERSION
    });
    if (job.existing) {
        return res.status(409).json({
            success: false,
            error: 'An enrichment job is already active',
            job: await enrichmentJobContract(job)
        });
    }
    const current = await HandleDatabase.syncEnrichmentJobState(job.id);
    if (current.status === 'running' || current.status === 'queued') startEnrichmentWorker(current.id);
    res.status(202).json({ success: true, job: await enrichmentJobContract(current) });
});

app.get('/api/enrichment/jobs/:id', requireRole(['Owner']), async (req, res) => {
    const lookup = await ownedEnrichmentJob(req.params.id, req.user);
    if (!lookup) return res.status(404).json({ error: 'Enrichment job not found' });
    if (!lookup.owned) return res.status(403).json({ error: 'Forbidden' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, job: await enrichmentJobContract(lookup.job) });
});

app.post('/api/enrichment/jobs/:id/pause', requireRole(['Owner']), async (req, res) => {
    const lookup = await ownedEnrichmentJob(req.params.id, req.user);
    if (!lookup) return res.status(404).json({ error: 'Enrichment job not found' });
    if (!lookup.owned) return res.status(403).json({ error: 'Forbidden' });
    if (['completed', 'cancelled'].includes(lookup.job.status)) {
        return res.status(409).json({ error: 'Completed jobs cannot be paused' });
    }
    await HandleDatabase.pauseEnrichmentJob(lookup.job.id);
    await stopEnrichmentWorker(lookup.job.id);
    const current = await HandleDatabase.syncEnrichmentJobState(lookup.job.id);
    res.json({ success: true, job: await enrichmentJobContract(current) });
});

app.post('/api/enrichment/jobs/:id/resume', requireRole(['Owner']), async (req, res) => {
    const lookup = await ownedEnrichmentJob(req.params.id, req.user);
    if (!lookup) return res.status(404).json({ error: 'Enrichment job not found' });
    if (!lookup.owned) return res.status(403).json({ error: 'Forbidden' });
    if (['completed', 'cancelled'].includes(lookup.job.status)) {
        return res.status(409).json({ error: 'Completed jobs cannot be resumed' });
    }
    const current = await HandleDatabase.resumeEnrichmentJob(lookup.job.id);
    if (current.status === 'running' || current.status === 'queued') startEnrichmentWorker(current.id);
    res.json({ success: true, job: await enrichmentJobContract(current) });
});

app.post('/api/enrichment/jobs/:id/cancel', requireRole(['Owner']), async (req, res) => {
    const lookup = await ownedEnrichmentJob(req.params.id, req.user);
    if (!lookup) return res.status(404).json({ error: 'Enrichment job not found' });
    if (!lookup.owned) return res.status(403).json({ error: 'Forbidden' });
    if (lookup.job.status === 'completed') return res.status(409).json({ error: 'Completed jobs cannot be cancelled' });
    await HandleDatabase.cancelEnrichmentJob(lookup.job.id);
    await stopEnrichmentWorker(lookup.job.id);
    const current = await HandleDatabase.syncEnrichmentJobState(lookup.job.id);
    res.json({ success: true, job: await enrichmentJobContract(current, { includeItem: false }) });
});

app.get('/api/enrichment/jobs/:id/items/next', requireRole(['Owner']), async (req, res) => {
    const lookup = await ownedEnrichmentJob(req.params.id, req.user);
    if (!lookup) return res.status(404).json({ error: 'Enrichment job not found' });
    if (!lookup.owned) return res.status(403).json({ error: 'Forbidden' });
    if (lookup.job.status === 'paused') return res.status(409).json({ error: 'Enrichment job is paused' });
    if (lookup.job.status === 'cancelled') return res.status(204).end();
    const item = await HandleDatabase.getNextEnrichmentReviewItem(lookup.job.id);
    if (!item) return res.status(204).end();
    const formatted = await formatEnrichmentItem(item);
    if (!formatted) return res.status(204).end();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, item: formatted });
});

app.post('/api/enrichment/items/:id/decision', requireRole(['Owner']), async (req, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'Invalid enrichment item id' });
    const item = await HandleDatabase.getEnrichmentJobItem(itemId);
    if (!item) return res.status(404).json({ error: 'Enrichment item not found' });
    if (item.requested_by !== req.user) return res.status(403).json({ error: 'Forbidden' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const decision = body.decision;
    if (!['apply', 'skip', 'mark_unknown'].includes(decision)) {
        return res.status(400).json({ error: "decision must be 'apply', 'skip', or 'mark_unknown'" });
    }
    if (body.expectedRevision !== undefined && (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0)) {
        return res.status(400).json({ error: 'expectedRevision must be a non-negative integer' });
    }

    let normalizedUpdates = {};
    let selected = null;
    let fields = [];
    if (decision === 'apply') {
        if (!Array.isArray(body.fields) || body.fields.length < 1 || body.fields.length > 6 ||
            body.fields.some(field => typeof field !== 'string' || field.length > 40)) {
            return res.status(400).json({ error: 'fields must list 1-6 supported metadata fields' });
        }
        const normalizedFields = body.fields.map(normalizeEnrichmentField);
        if (new Set(normalizedFields).size !== normalizedFields.length) {
            return res.status(400).json({ error: 'fields contains duplicates' });
        }
        const validation = validateEnrichmentUpdates(body.updates || {});
        if (validation.error) return res.status(400).json({ error: validation.error });
        normalizedUpdates = validation.updates;
        fields = Object.keys(normalizedUpdates).sort();
        if (fields.length !== normalizedFields.length || fields.some(field => !normalizedFields.includes(field))) {
            return res.status(400).json({ error: 'fields must exactly match updates' });
        }
        if (body.candidateId === undefined || body.candidateId === null || String(body.candidateId).length > 200) {
            return res.status(400).json({ error: 'candidateId is required' });
        }
        const candidates = await HandleDatabase.getEnrichmentCandidates(item.id);
        selected = resolvePersistedCandidate(candidates, body.candidateId);
        if (!selected) return res.status(400).json({ error: 'Candidate does not belong to this enrichment item' });
        for (const [field, value] of Object.entries(normalizedUpdates)) {
            if (!candidateValueMatches(selected.candidate, field, value)) {
                return res.status(400).json({ error: `${field} does not match the selected candidate` });
            }
        }
    } else {
        const hasFields = Array.isArray(body.fields) && body.fields.length > 0;
        const hasUpdates = body.updates && typeof body.updates === 'object' && Object.keys(body.updates).length > 0;
        if (hasFields || hasUpdates) return res.status(400).json({ error: `${decision} does not accept metadata updates` });
    }

    const canonicalUpdates = {};
    fields.forEach(field => { canonicalUpdates[field] = normalizedUpdates[field]; });
    const decisionData = {
        decision,
        candidateId: selected ? String(selected.selectedCandidateId) : null,
        fields,
        updates: canonicalUpdates
    };
    if (item.decision) {
        const idempotent = item.decision === decision && JSON.stringify(item.decisionData) === JSON.stringify(decisionData);
        if (!idempotent) return res.status(409).json({ error: 'A different decision was already recorded' });
        const [job, identity] = await Promise.all([
            HandleDatabase.getEnrichmentJob(item.job_id),
            HandleDatabase.getSongIdentification(item.song_id)
        ]);
        return res.json({
            success: true,
            idempotent: true,
            recording_uid: identity && identity.recording_uid || null,
            release_uid: identity && identity.release_uid || null,
            release_track_uid: identity && identity.release_track_uid || null,
            artists: identity && identity.artists || [],
            identity,
            job: await enrichmentJobContract(job)
        });
    }
    const song = await HandleDatabase.getSong(item.song_id, { includeUnavailable: true });
    if (!song) return res.status(404).json({ error: 'Song not found' });
    let stagedCover = null;
    const databaseUpdates = { ...normalizedUpdates };
    delete databaseUpdates.coverUrl;
    if (normalizedUpdates.coverUrl) {
        stagedCover = await stageEnrichmentCover(song, normalizedUpdates.coverUrl);
        if (!stagedCover) {
            return res.status(502).json({
                error: 'The selected cover could not be downloaded',
                cover: { applied: false, error: 'download_failed' }
            });
        }
        databaseUpdates.cover_path = stagedCover.coverPath;
    }

    let result;
    try {
        result = await HandleDatabase.decideEnrichmentJobItem(item.id, {
            decision,
            decisionData,
            selectedCandidateId: selected && selected.selectedCandidateId,
            persistedCandidateId: selected && selected.persistedCandidateId,
            decidedBy: req.user,
            updates: databaseUpdates,
            identifiers: selected ? externalIdentifiersForCandidate(selected.candidate) : [],
            candidate: selected ? selected.candidate : null,
            method: 'owner_decision',
            identitySource: selected
                ? (Array.isArray(selected.candidate.providers) && selected.candidate.providers.length
                    ? selected.candidate.providers.join('+')
                    : (selected.candidate.provider || selected.candidate.source || 'registry'))
                : null,
            source: 'smart-auto-enrich',
            pipelineVersion: item.result && item.result.pipelineVersion || item.job_pipeline_version || AIMetadata.PIPELINE_VERSION,
            confidence: selected && Number.isFinite(selected.candidate.confidence) ? selected.candidate.confidence : null,
            expectedRevision: body.expectedRevision === undefined ? item.metadata_revision : body.expectedRevision
        });
    } catch {
        removeStagedCover(stagedCover);
        return res.status(500).json({ error: 'Decision could not be recorded' });
    }
    if (!result.decided) {
        removeStagedCover(stagedCover);
        if (result.lockedFields) return res.status(409).json({ error: 'Selected fields are locked', lockedFields: result.lockedFields });
        if (result.conflict) {
            return res.status(409).json({
                error: 'Song metadata changed after this item was prepared',
                currentRevision: result.currentRevision
            });
        }
        return res.status(result.notFound ? 404 : 409).json({ error: result.notFound ? 'Enrichment item not found' : 'Decision could not be recorded' });
    }
    if (result.idempotent) {
        removeStagedCover(stagedCover);
        stagedCover = null;
    }

    const currentJob = await HandleDatabase.syncEnrichmentJobState(item.job_id);
    const jobContract = await enrichmentJobContract(currentJob);
    const nextItem = await HandleDatabase.getNextEnrichmentReviewItem(item.job_id);
    const identity = await HandleDatabase.getSongIdentification(item.song_id);
    res.json({
        success: true,
        idempotent: result.idempotent === true,
        decision,
        metadataRevision: result.metadataRevision ?? item.metadata_revision,
        recording_uid: identity && identity.recording_uid || null,
        release_uid: identity && identity.release_uid || null,
        release_track_uid: identity && identity.release_track_uid || null,
        artists: identity && identity.artists || [],
        identity,
        cover: stagedCover ? stagedCover.coverPath : undefined,
        coverResult: normalizedUpdates.coverUrl ? { applied: true, error: null } : { applied: false, error: null },
        job: jobContract,
        nextItem: nextItem ? await formatEnrichmentItem(nextItem) : null
    });
});

// Single Song Smart Metadata Enrichment (User-approved fields only)
app.post('/api/songs/:id/enrich-metadata', requireRole(['Owner']), async (req, res) => {
    return res.status(410).json({
        error: 'Direct enrichment apply has been replaced by review jobs.',
        job_endpoint: '/api/enrichment/jobs'
    });

    /* Legacy implementation retained temporarily for migration reference. */
    try {
        const song = await HandleDatabase.getSong(req.params.id);
        if (!song) return res.status(404).json({ error: "Song not found" });

        const isOwnerRole = req.userRow.role === 'Owner';
        const isUploader = song.uploaded_by === req.user;
        if (!isOwnerRole && !isUploader) return res.status(403).json({ error: "Forbidden" });

        const allowedBodyFields = new Set(['songname', 'artist', 'album', 'genre', 'year', 'coverUrl', 'expectedRevision']);
        const unsupportedField = Object.keys(req.body || {}).find(field => !allowedBodyFields.has(field));
        if (unsupportedField) return res.status(400).json({ error: `Unsupported field: ${unsupportedField}` });
        if (req.body.expectedRevision !== undefined && (!Number.isInteger(req.body.expectedRevision) || req.body.expectedRevision < 0)) {
            return res.status(400).json({ error: 'expectedRevision must be a non-negative integer' });
        }
        const requested = {};
        for (const field of ['songname', 'artist', 'album', 'genre', 'year', 'coverUrl']) {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) requested[field] = req.body[field];
        }
        const validation = validateEnrichmentUpdates(requested);
        if (validation.error) return res.status(400).json({ error: validation.error });
        if (Object.keys(validation.updates).length === 0) return res.status(400).json({ error: 'Select at least one metadata field' });

        const locked = new Set((await HandleDatabase.getLockedMetadataFields(song.id)).map(normalizeEnrichmentField));
        const lockedFields = Object.keys(validation.updates).filter(field => locked.has(field));
        if (lockedFields.length) return res.status(409).json({ error: 'Selected fields are locked', lockedFields });

        let stagedCover = null;
        const updates = { ...validation.updates, ai_enriched: 1 };
        delete updates.coverUrl;
        if (validation.updates.coverUrl) {
            stagedCover = await stageEnrichmentCover(song, validation.updates.coverUrl);
            if (!stagedCover) {
                return res.status(502).json({
                    error: 'The selected cover could not be downloaded',
                    cover: { applied: false, error: 'download_failed' }
                });
            }
            updates.cover_path = stagedCover.coverPath;
        }

        let update;
        try {
            update = await HandleDatabase.updateSongMetadata(song.id, updates, {
                status: 'identified',
                source: 'smart-auto-enrich',
                pipelineVersion: AIMetadata.PIPELINE_VERSION,
                lockFields: true,
                rejectLocked: true,
                expectedRevision: req.body.expectedRevision === undefined
                    ? Number(song.metadata_revision) || 0
                    : req.body.expectedRevision
            });
        } catch (error) {
            removeStagedCover(stagedCover);
            throw error;
        }
        if (!update.updated) {
            removeStagedCover(stagedCover);
            if (update.lockedFields) return res.status(409).json({ error: 'Selected fields are locked', lockedFields: update.lockedFields });
            if (update.conflict) {
                return res.status(409).json({ error: 'Song metadata changed before the update was applied', currentRevision: update.currentRevision });
            }
            return res.status(404).json({ error: 'Song not found' });
        }

        res.json({
            success: true,
            message: "Metadata updated with your selections",
            metadataRevision: Number(update.song.metadata_revision) || 0,
            cover: stagedCover ? stagedCover.coverPath : undefined,
            coverResult: validation.updates.coverUrl ? { applied: true, error: null } : { applied: false, error: null }
        });
    } catch (err) {
        console.error("[SERVER] Enrich metadata error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Smart Metadata Lookup (Preview - does NOT save anything)
app.post('/api/songs/:id/preview-ai-metadata', requireRole(['Owner']), async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abortOnDisconnect);
    try {
        const song = await HandleDatabase.getSong(req.params.id);
        if (!song) return res.status(404).json({ error: "Song not found" });

        const isOwnerRole = req.userRow.role === 'Owner';
        if (!isOwnerRole && song.uploaded_by !== req.user) return res.status(403).json({ error: 'Forbidden' });

        const result = await enrichSongWithLookupMode(song, currentMetadataLookupMode(), { signal: controller.signal });
        if (controller.signal.aborted || res.headersSent) return;
        res.json({
            success: true,
            data: result,
            metadataRevision: Number(song.metadata_revision) || 0
        });
    } catch (err) {
        if (!controller.signal.aborted && !res.headersSent) {
            console.error("[SERVER] Preview metadata error:", err);
            res.status(500).json({ error: "Internal server error" });
        }
    } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abortOnDisconnect);
    }
});

// Fetch Queue of songs needing Smart Metadata Enrichment
app.get('/api/songs/enrichment-queue', requireRole(['Owner']), async (req, res) => {
    try {
        const songs = req.userRow.role === 'Owner'
            ? (await HandleDatabase.getAllSongs()).filter(song => !song.hidden_from_library && canAccessSong(song, req.user))
            : (await HandleDatabase.getSongsByUser(req.user)).filter(song => !song.hidden_from_library);
        const queue = songs.map(song => song.id);

        res.json({ success: true, queue });
    } catch (err) {
        console.error("[SERVER] Fetch enrichment queue error:", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// The legacy batch endpoint used a weak text threshold and is intentionally retired.
app.post('/api/songs/enrich-batch', requireLogin, async (req, res) => {
    res.status(410).json({
        error: 'Legacy batch enrichment has been removed. Use POST /api/enrichment/jobs.',
        job_endpoint: '/api/enrichment/jobs'
    });
});

// Bulk Delete Songs
app.post('/api/songs/bulk-delete', requireLogin, async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Invalid IDs" });

    const allSongs = await HandleDatabase.getAllSongs();
    const results = { success: [], failed: [] };

    for (const id of ids) {
        const song = allSongs.find(s => s.id == id);
        if (!song) {
            results.failed.push({ id, error: "Not found" });
            continue;
        }
        if (song.source === 'folder') {
            results.failed.push({ id, error: "Folder-managed songs cannot be deleted from Streamify" });
            continue;
        }

        const isOwnerRole = req.userRow.role === 'Owner';
        const isUploader = song.uploaded_by === req.user;

        if (isOwnerRole || isUploader) {
            const usageCount = await HandleDatabase.getPlaylistUsageCount(id, req.user);
            if (usageCount === 0) {
                const fullPath = path.join(RT.DATA_ROOT, song.filepath);
                if (fs.existsSync(fullPath)) {
                    try {
                        const stats = fs.statSync(fullPath);
                        fs.unlinkSync(fullPath);
                        await HandleDatabase.decrementStorageUsed(song.uploaded_by, stats.size);

                        const baseName = path.basename(song.filepath, path.extname(song.filepath));
                        const coverExts = ['.jpg', '.jpeg', '.png', '.webp'];
                        for (const ext of coverExts) {
                            const cp = path.join(RT.paths.covers, baseName + ext);
                            if (fs.existsSync(cp)) fs.unlinkSync(cp);
                        }
                    } catch (err) { console.error(err); }
                }
                await HandleDatabase.deleteSong(id);
            } else {
                const fullPath = path.join(RT.DATA_ROOT, song.filepath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    await HandleDatabase.decrementStorageUsed(song.uploaded_by, stats.size);
                }
                await HandleDatabase.hideSongFromUploader(id);
            }
            await HandleDatabase.removeSongFromUserPlaylists(id, req.user);
            results.success.push(id);
        } else {
            results.failed.push({ id, error: "Forbidden" });
        }
    }

    res.json(results);
});

// Upload Cover for Song
app.post('/api/songs/:id/cover', requireLogin, uploadCover.single('cover_file'), async (req, res) => {
    const songId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "No file" });

    const song = await HandleDatabase.getSong(songId);
    if (!song) return res.status(404).json({ error: "Song not found" });

    const isOwnerRole = req.userRow.role === 'Owner';
    const isUploader = song.uploaded_by === req.user;

    if (isOwnerRole || isUploader) {
        try {
            const baseName = path.basename(song.filepath, path.extname(song.filepath));
            const coversDir = RT.paths.covers;
            if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

            const savePath = path.join(coversDir, `${baseName}.jpg`);
            const tempPath = path.join(coversDir, `.song-cover-${songId}-${crypto.randomUUID()}.jpg`);
            const image = await Jimp.read(req.file.buffer);
            const width = image.bitmap?.width || image.width;
            const height = image.bitmap?.height || image.height;
            if (!width || !height || width * height > 25_000_000) {
                return res.status(400).json({ error: "Image dimensions are too large" });
            }
            await image.write(tempPath);
            const backupPath = `${savePath}.backup`;
            try {
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
                if (fs.existsSync(savePath)) fs.renameSync(savePath, backupPath);
                fs.renameSync(tempPath, savePath);
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
            } catch (error) {
                if (!fs.existsSync(savePath) && fs.existsSync(backupPath)) {
                    fs.renameSync(backupPath, savePath);
                }
                throw error;
            } finally {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            }

            res.json({ success: true, cover: Media.resolveCover(baseName) });
        } catch (err) {
            console.error('[COVER UPLOAD]', err);
            res.status(500).json({ error: "Failed to upload cover" });
        }
    } else {
        res.status(403).json({ error: "Forbidden" });
    }
});

// Delete Profile (Owner Only)
app.delete('/api/admin/users/:username', requireRole(['Owner']), async (req, res) => {
    const targetUsername = req.params.username;
    const targetUser = await HandleDatabase.getUser(targetUsername);
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    if (targetUser.role === 'Owner') return res.status(403).json({ error: "Cannot delete Owner profile" });

    try {
        await Auth.invalidateAllSessions(targetUsername);
        await HandleDatabase.deleteUserData(targetUsername);
        await HandleDatabase.deleteUser(targetUsername);
        res.json({ success: true, message: `Profile ${targetUsername} deleted` });
    } catch (err) {
        console.error('[DELETE USER]', err);
        res.status(500).json({ error: "Failed to delete user" });
    }
});

// --- Notifications ---
app.get('/api/notifications', requireLogin, async (req, res) => {
    try {
        const offset = parseInt(req.query.offset) || 0;
        const limit = 20;
        const list = await HandleDatabase.getNotifications(req.user, offset, limit);
        const enhancedList = list.map(n => ({
            ...n,
            avatar: Media.resolveAvatar(n.actor_username)
        }));
        res.json(enhancedList);
    } catch (err) {
        console.error('[GET NOTIFS]', err);
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});

app.post('/api/notifications/mark-read', requireLogin, async (req, res) => {
    try {
        await HandleDatabase.markNotificationsAsRead(req.user);
        res.json({ success: true });
    } catch (err) {
        console.error('[MARK READ]', err);
        res.status(500).json({ error: "Failed to mark notifications read" });
    }
});

// ============================================================
// DM (Direct Messages) Routes
// ============================================================

// Send a DM request
app.post('/api/dm/request', requireLogin, dmRequestLimiter, async (req, res) => {
    try {
        const { to_username } = req.body;
        if (!to_username) return res.status(400).json({ error: "Username is required" });

        const from = req.user;
        const to = to_username.trim();

        if (from.toLowerCase() === to.toLowerCase()) return res.status(400).json({ error: "You cannot message yourself" });

        // Check target user exists (case-insensitive)
        const targetUser = await HandleDatabase.getUserCaseInsensitive(to);
        if (!targetUser) return res.status(404).json({ error: "User not found" });

        const actualTo = targetUser.username;

        // Check for existing request (pending or accepted) in either direction
        const existing = await HandleDatabase.getDmRequestBetween(from, actualTo);
        if (existing) {
            if (existing.status === 'pending') return res.status(400).json({ error: "A pending request already exists" });
            if (existing.status === 'accepted') return res.status(400).json({ error: "You already have a conversation with this user" });
        }

        const result = await HandleDatabase.sendDmRequest(from, actualTo);

        // Notify recipient via socket
        const io = req.app.get('io');
        if (io) io.to(`user:${actualTo}`).emit('dm_request', { from_username: from, id: result.lastID });

        res.json({ success: true, id: result.lastID });
    } catch (err) {
        console.error('[DM REQUEST]', err);
        res.status(500).json({ error: "Failed to send DM request" });
    }
});

// Get pending DM requests (received)
app.get('/api/dm/requests', requireLogin, async (req, res) => {
    try {
        const requests = await HandleDatabase.getPendingDmRequests(req.user);
        // Resolve avatars for each requester
        const enriched = await Promise.all(requests.map(async (r) => {
            const avatarPath = await Media.resolveAvatar(r.from_username);
            return { ...r, avatar: avatarPath };
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[DM REQUESTS]', err);
        res.status(500).json({ error: "Failed to fetch DM requests" });
    }
});

// Get sent DM requests
app.get('/api/dm/requests/sent', requireLogin, async (req, res) => {
    try {
        const requests = await HandleDatabase.getSentDmRequests(req.user);
        const enriched = await Promise.all(requests.map(async (r) => {
            const avatarPath = await Media.resolveAvatar(r.to_username);
            return { ...r, avatar: avatarPath };
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[DM SENT REQUESTS]', err);
        res.status(500).json({ error: "Failed to fetch sent DM requests" });
    }
});

// Accept or reject a DM request
app.post('/api/dm/request/:id/respond', requireLogin, dmRequestLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: "Invalid status" });

        const request = await HandleDatabase.getDmRequest(id);
        if (!request) return res.status(404).json({ error: "Request not found" });
        if (request.to_username !== req.user) return res.status(403).json({ error: "Not authorized" });
        if (request.status !== 'pending') return res.status(400).json({ error: "Request already responded to" });

        await HandleDatabase.updateDmRequestStatus(id, status);

        if (status === 'accepted') {
            await HandleDatabase.createDmConversation(request.from_username, request.to_username);
        }

        // Notify the original sender
        const io = req.app.get('io');
        if (io) io.to(`user:${request.from_username}`).emit('dm_request_responded', { status, by_username: req.user });

        res.json({ success: true });
    } catch (err) {
        console.error('[DM RESPOND]', err);
        res.status(500).json({ error: "Failed to respond to DM request" });
    }
});

// Get DM contacts (conversations)
app.get('/api/dm/contacts', requireLogin, async (req, res) => {
    try {
        const contacts = await HandleDatabase.getDmContacts(req.user);
        // Enrich with avatar and display name for the other user
        const enriched = await Promise.all(contacts.map(async (c) => {
            const otherUser = c.user1 === req.user ? c.user2 : c.user1;
            const avatarPath = await Media.resolveAvatar(otherUser);
            const userRow = await HandleDatabase.getUser(otherUser);
            return {
                ...c,
                other_username: otherUser,
                other_display_name: userRow ? (userRow.display_name || otherUser) : otherUser,
                other_avatar: avatarPath
            };
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[DM CONTACTS]', err);
        res.status(500).json({ error: "Failed to fetch DM contacts" });
    }
});

// Get messages for a conversation
app.get('/api/dm/conversation/:id/messages', requireLogin, async (req, res) => {
    try {
        const { id } = req.params;
        const limit = parseInt(req.query.limit) || 30;
        const offset = parseInt(req.query.offset) || 0;
        const conversation = await HandleDatabase.getDmConversationById(id);
        if (!conversation) return res.status(404).json({ error: "Conversation not found" });
        if (conversation.user1 !== req.user && conversation.user2 !== req.user) return res.status(403).json({ error: "Not authorized" });

        const messages = await HandleDatabase.getDmMessages(id, limit, offset);

        // Mark messages as read (only on first load / offset 0)
        if (offset === 0) await HandleDatabase.markDmMessagesRead(id, req.user);

        res.json(messages);
    } catch (err) {
        console.error('[DM MESSAGES]', err);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});

// Send a message in a conversation
app.post('/api/dm/conversation/:id/messages', requireLogin, dmMessageLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        const { body } = req.body;

        if (!body || !body.trim()) return res.status(400).json({ error: "Message cannot be empty" });
        if (body.length > 1000) return res.status(400).json({ error: "Message too long (max 1000 chars)" });

        const conversation = await HandleDatabase.getDmConversationById(id);
        if (!conversation) return res.status(404).json({ error: "Conversation not found" });
        if (conversation.user1 !== req.user && conversation.user2 !== req.user) return res.status(403).json({ error: "Not authorized" });

        // Verify accepted DM request exists between these users
        const otherUser = conversation.user1 === req.user ? conversation.user2 : conversation.user1;
        const dmRequest = await HandleDatabase.getDmRequestBetween(req.user, otherUser);
        if (!dmRequest || dmRequest.status !== 'accepted') return res.status(403).json({ error: "No accepted DM request with this user" });

        // Profanity check
        const flagged = await Moderation.isFlagged(body);
        if (flagged) return res.status(400).json({ error: "Message contains inappropriate content" });

        const result = await HandleDatabase.insertDmMessage(id, req.user, body.trim());

        const message = {
            id: result.lastID,
            conversation_id: id,
            sender_username: req.user,
            body: body.trim(),
            created_at: new Date().toISOString()
        };

        // Emit to recipient via socket
        const io = req.app.get('io');
        if (io) io.to(`user:${otherUser}`).emit('dm_message', message);

        // Also add a general notification for DMs
        await HandleDatabase.addNotification(otherUser, req.user, 'dm', null);
        if (io) io.to(`user:${otherUser}`).emit('new_notification');

        res.json({ success: true, message });
    } catch (err) {
        console.error('[DM SEND]', err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

// Get unread DM count
app.get('/api/dm/unread-count', requireLogin, async (req, res) => {
    try {
        const count = await HandleDatabase.getDmUnreadCount(req.user);
        res.json({ count });
    } catch (err) {
        console.error('[DM UNREAD]', err);
        res.status(500).json({ error: "Failed to fetch unread count" });
    }
});

// --- Admin API ---

app.get('/api/admin/stats', requireRole(['Owner', 'Admin']), async (req, res) => {
    try {
        const userCount = (await HandleDatabase.getAllUsers()).length;
        const songCount = await HandleDatabase.getSongsCount();

        // Count active sessions
        const sessionCountQuery = await HandleDatabase.allQuery('users', "SELECT COUNT(*) as count FROM sessions");
        const sessionCount = sessionCountQuery[0].count;

        res.json({
            users: userCount,
            songs: songCount,
            posts: 0,
            sessions: sessionCount,
            uptime: process.uptime(),
            node_version: process.version,
            platform: process.platform
        });
    } catch (err) {
        console.error('[ADMIN STATS]', err);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.get('/api/admin/config', requireRole(['Owner', 'Admin']), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(safeSystemConfigResponse());
});

app.post('/api/admin/config', requireRole(['Owner', 'Admin']), async (req, res) => {
    const { maintenance_mode, maintenance_message, lockdown_new_posts, ratelimits } = req.body;
    let changes = [];

    if (maintenance_mode !== undefined) {
        const oldVal = app.locals.config.maintenance_mode;
        app.locals.config.maintenance_mode = !!maintenance_mode;
        if (oldVal !== app.locals.config.maintenance_mode) {
            changes.push(`Maintenance Mode: ${app.locals.config.maintenance_mode ? 'Enabled' : 'Disabled'}`);
        }
    }
    if (maintenance_message !== undefined) {
        app.locals.config.maintenance_message = maintenance_message;
        changes.push(`Maintenance Message updated`);
    }
    if (lockdown_new_posts !== undefined) {
        const oldVal = app.locals.config.lockdown_new_posts;
        app.locals.config.lockdown_new_posts = !!lockdown_new_posts;
        if (oldVal !== app.locals.config.lockdown_new_posts) {
            changes.push(`Lockdown New Posts: ${app.locals.config.lockdown_new_posts ? 'Enabled' : 'Disabled'}`);
        }
    }
    if (ratelimits !== undefined) {
        app.locals.config.ratelimits = { ...app.locals.config.ratelimits, ...ratelimits };
        changes.push(`Rate Limits updated: ${JSON.stringify(ratelimits)}`);
    }

    try {
        if (maintenance_mode !== undefined) await HandleDatabase.updateSystemConfig('maintenance_mode', JSON.stringify(app.locals.config.maintenance_mode));
        if (maintenance_message !== undefined) await HandleDatabase.updateSystemConfig('maintenance_message', JSON.stringify(app.locals.config.maintenance_message));
        if (lockdown_new_posts !== undefined) await HandleDatabase.updateSystemConfig('lockdown_new_posts', JSON.stringify(app.locals.config.lockdown_new_posts));
        if (ratelimits !== undefined) await HandleDatabase.updateSystemConfig('ratelimits', JSON.stringify(app.locals.config.ratelimits));

        if (changes.length > 0) {
            await HandleDatabase.insertSystemLog(req.user, 'config_update', changes.join(', '));
        }
        res.json({ success: true, config: safeSystemConfigResponse() });
    } catch (err) {
        console.error('[ADMIN CONFIG SAVE]', err);
        res.status(500).json({ error: "Failed to save config to database" });
    }
});

app.get('/api/admin/db/tables', requireRole(['Owner', 'Admin']), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        users: ['users'],
        music: ['songs', 'playlists', 'playlist_songs']
    });
});

app.get('/api/admin/db/data/:table', requireRole(['Owner', 'Admin']), async (req, res) => {
    const table = req.params.table;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    res.set('Cache-Control', 'no-store');
    if (table === 'sessions') {
        return res.status(403).json({ error: "Session records are not available through the database browser." });
    }

    // Define which DB each table belongs to
    const dbMap = {
        users: 'users', system_logs: 'users',
        songs: 'music', playlists: 'music', playlist_songs: 'music'
    };

    const dbName = dbMap[table];
    if (!dbName) return res.status(400).json({ error: "Invalid table" });

    // Role-based table protection
    if (table === 'system_logs' && !['Owner', 'Admin'].includes(req.userRow.role)) {
        return res.status(403).json({ error: "Forbidden: This table is restricted to Owners and Admins." });
    }

    try {
        const rows = await HandleDatabase.allQuery(dbName, `SELECT * FROM ${table} LIMIT ? OFFSET ?`, [limit, offset]);

        // Security filter: Remove sensitive fields
        const filteredRows = rows.map(row => {
            const safeRow = { ...row };
            delete safeRow.password; // Never expose passwords
            // delete safeRow.email; // Maybe keep email for admin but mask it? Let's keep it for now as per user request "strict sensitive data like passwords won't be exposed"
            return safeRow;
        });

        res.json(filteredRows);
    } catch (err) {
        console.error(`[ADMIN DB DATA] ${table}`, err);
        res.status(500).json({ error: "Failed to fetch table data" });
    }
});

// --- Global Error Handler ---

app.use((err, req, res, next) => {
    console.error('[GLOBAL ERROR]', err);
    if (res.headersSent) return next(err);

    // Multer specific errors (like file size)
    if (err.code === 'LIMIT_FILE_SIZE') {
        let limit = "10MB";
        if (req.path.includes('/api/songs')) limit = "20MB";
        if (req.path.includes('/api/upload-avatar')) limit = "5MB";
        if (req.path.includes('/api/upload-banner')) limit = "8MB";
        return res.status(400).json({ error: `File too large. Maximum size for this type of upload is ${limit}.` });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: "Unexpected file or field in upload." });
    }

    if (req.originalUrl.startsWith('/api/')) {
        const body = { error: "Internal Server Error" };
        if (process.env.NODE_ENV === 'development') body.message = err.message;
        return res.status(500).json(body);
    }
    return res.status(500).send('<html><body><h1>Internal Server Error</h1></body></html>');
});

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ *
 * The server no longer listens as a side effect of being require()'d.
 * The Electron main process needs to import this module, wait for the port to
 * be bound, and learn the resolved URL before opening a window — so startup is
 * exposed as a promise-returning function instead.
 *
 * Running `node server.js` directly still starts everything automatically via
 * the require.main check at the bottom of this file.
 */

/** Prints the LAN URLs a phone can use, plus the secure-context caveat. */
function logAccessBanner(activePort = port) {
    const scheme = isSecureTransport ? 'https' : 'http';
    console.log('');
    console.log('  Streamify is running');
    console.log(`  ├─ On this device : ${scheme}://localhost:${activePort}`);

    const lan = RT.getLanAddresses();
    if (lan.length === 0) {
        console.log('  └─ On your network: no external network interface detected');
    } else {
        lan.forEach((entry, i) => {
            const last = i === lan.length - 1;
            console.log(`  ${last ? '└─' : '├─'} On your network: ${scheme}://${entry.address}:${activePort}  (${entry.interface})`);
        });
    }

    if (!isSecureTransport) {
        console.log('');
        console.log('  [!] Serving over plain HTTP.');
        console.log('      Phones can stream normally, but offline downloads and');
        console.log('      "Add to Home Screen" require a secure context.');
        console.log('      Run `npm run gen-cert` to enable HTTPS on your LAN.');
    }
    console.log('');
}

let isShuttingDown = false;
let shutdownPromise = null;

/**
 * Binds the HTTP(S) server.
 * @returns {Promise<{port:number, host:string, secure:boolean, url:string}>}
 */
async function start({ port: overridePort = port, host: overrideHost = host } = {}) {
    await initializeServer();

    return new Promise((resolve, reject) => {
        const onError = (err) => {
            httpServer.removeListener('error', onError);
            if (err.code === 'EADDRINUSE') {
                return reject(new Error(
                    `Port ${overridePort} is already in use. ` +
                    `Set the PORT environment variable to choose another one.`
                ));
            }
            if (err.code === 'EACCES') {
                return reject(new Error(
                    `Permission denied binding port ${overridePort}. ` +
                    `Ports below 1024 require elevated privileges.`
                ));
            }
            reject(err);
        };

        httpServer.once('error', onError);
        httpServer.listen(overridePort, overrideHost, () => {
            httpServer.removeListener('error', onError);
            scheduleAutomatedMaintenance();
            logAccessBanner(overridePort);
            resolve({
                port: overridePort,
                host: overrideHost,
                secure: isSecureTransport,
                url: RT.buildUrl('localhost', sslConfig, overridePort),
            });
        });
    });
}

// --- Graceful Shutdown ---
const gracefulShutdown = ({ exit = true } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    console.log("\n[SERVER] Shutting down gracefully...");

    shutdownPromise = new Promise((resolve, reject) => {
        let settled = false;
        let timeout = null;

        const finish = async () => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (initialBackupTimer) clearTimeout(initialBackupTimer);
            if (backupInterval) clearInterval(backupInterval);
            let shutdownError = null;
            try {
                if (initializationPromise) await initializationPromise;
            } catch (error) {
                shutdownError = error;
                console.error('[SERVER] Initialization did not finish cleanly before shutdown:', error);
            }
            try {
                await stopAllEnrichmentWorkers();
            } catch (error) {
                shutdownError = shutdownError
                    ? new AggregateError([shutdownError, error], 'Initialization and enrichment worker shutdown failed')
                    : error;
                console.error('[SERVER] Enrichment workers did not stop cleanly:', error);
            }
            try {
                await HandleDatabase.close();
                console.log("[SERVER] Shutdown complete. See you next time!");
            } catch (error) {
                shutdownError = shutdownError
                    ? new AggregateError([shutdownError, error], 'Initialization and database shutdown failed')
                    : error;
                console.error('[SERVER] Database shutdown failed:', error);
            } finally {
                if (shutdownError) reject(shutdownError);
                else resolve();
                if (exit) process.exit(shutdownError ? 1 : 0);
            }
        };

        if (!httpServer.listening) {
            void finish();
            return;
        }

        httpServer.close(() => {
            console.log("[SERVER] HTTP and WebSocket server closed.");
            void finish();
        });

        timeout = setTimeout(() => {
            console.warn("[SERVER] Shutdown timed out; closing remaining connections.");
            if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
            void finish();
        }, 5000);
    });

    return shutdownPromise;
};

// Catch SIGINT (Ctrl+C) and SIGTERM (Kill signal).
// Electron manages its own lifecycle and calls gracefulShutdown() directly.
if (require.main === module) {
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

module.exports = {
    app,
    io,
    httpServer,
    start,
    gracefulShutdown,
    runtime: RT,
    isSecureTransport,
    getLanAddresses: RT.getLanAddresses,
    get port() { return port; },
};

// Direct execution: `node server.js`
if (require.main === module) {
    start().catch((err) => {
        console.error('[SERVER] Failed to start:', err.message);
        process.exit(1);
    });
}

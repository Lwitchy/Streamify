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
const rateLimit = require('express-rate-limit');

const HandleDatabase = require('./database');
const Media = require('./media');
const Auth = require('./auth');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { Jimp } = require('jimp');
const Moderation = require('./moderation');
const ytDlp = require('yt-dlp-exec');
const config = require('./config.json');
const { getTracks } = require('spotify-url-info')(fetch);
const slsk = require('slsk-client');
const NodeID3 = require('node-id3');

// Map to track active Soulseek downloads for manual skipping/cancellation
// Key: "username:query"
const activeSoulseekDownloads = new Map();
const activeImports = new Map(); // Track overall active imports for cancellation

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
const port = 4443;

const httpServer = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(httpServer, {
    cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:5500',
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

    // --- DM Typing Events ---
    socket.on('dm_typing', (data) => {
        if (!socket.username || !data.conversation_id) return;
        HandleDatabase.getDmConversationById(data.conversation_id).then(conv => {
            if (!conv) return;
            if (conv.user1 !== socket.username && conv.user2 !== socket.username) return;
            const other = conv.user1 === socket.username ? conv.user2 : conv.user1;
            io.to(`user:${other}`).emit('dm_typing', { conversation_id: data.conversation_id, username: socket.username });
        });
    });

    socket.on('dm_stop_typing', (data) => {
        if (!socket.username || !data.conversation_id) return;
        HandleDatabase.getDmConversationById(data.conversation_id).then(conv => {
            if (!conv) return;
            if (conv.user1 !== socket.username && conv.user2 !== socket.username) return;
            const other = conv.user1 === socket.username ? conv.user2 : conv.user1;
            io.to(`user:${other}`).emit('dm_stop_typing', { conversation_id: data.conversation_id, username: socket.username });
        });
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

// Trust the first proxy (e.g. Cloudflare, Nginx) for rate-limiting and cookies
app.set('trust proxy', 1);

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
(async () => {
    try {
        await HandleDatabase.createUsersTable();
        await HandleDatabase.createSongsTable();
        await HandleDatabase.createSessionsTable();
        await HandleDatabase.createTelemetryTable();
        await HandleDatabase.createPostsTable();
        await HandleDatabase.createPostLikesTable();
        await HandleDatabase.createPostCommentsTable();
        await HandleDatabase.createPlaylistsTable();
        await HandleDatabase.createPlaylistSongsTable();
        await HandleDatabase.createNotificationsTable();
        await HandleDatabase.createMentionsTable();
        await HandleDatabase.createDmRequestsTable();
        await HandleDatabase.createDmConversationsTable();
        await HandleDatabase.createDmMessagesTable();
        await HandleDatabase.createSystemLogsTable();
        await HandleDatabase.createSystemConfigTable();
        await HandleDatabase.createLyricsTable();
        await HandleDatabase.createSocialTriggers();
        await HandleDatabase.recalculateLikes();
        await HandleDatabase.recalculateAllStorageUsed();
    } catch (err) {
        console.error("Database initialization failed:", err);
    }
})();

// --- Automated Maintenance ---
// Initial backup on startup (wait 3s for DB to settle)
setTimeout(() => {
    HandleDatabase.backupDatabase();
}, 3000);

// Day-cycle backup every 24 hours
setInterval(() => {
    HandleDatabase.backupDatabase();
}, 24 * 60 * 60 * 1000);

// --- Middleware ---
// CORS for Github Pages
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5500'; // Defaulting to local live server
app.use(cors({
    origin: ALLOWED_ORIGIN,
    credentials: true // extremely important for cookies
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

app.use('/api/', apiLimiter);

// --- Static Serves ---
app.use('/Static', express.static(path.join(__dirname, '../Static')));
app.use('/MusicLibrary', express.static(path.join(__dirname, '../MusicLibrary')));
app.use('/banners', express.static(path.join(__dirname, '../Static/banners'))); // Quick access to banners

// --- Multer Configuration ---
const uploadSongStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const tempDir = path.join(__dirname, '../MusicLibrary/Temp');
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

const uploadFeedImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const feedDir = path.join(__dirname, '../Static/uploads/feed');
        if (!fs.existsSync(feedDir)) fs.mkdirSync(feedDir, { recursive: true });
        cb(null, feedDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomBytes(8).toString('hex');
        cb(null, 'feed-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadFeedImage = multer({
    storage: uploadFeedImageStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        const allowedMimetypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

        const ext = path.extname(file.originalname).toLowerCase();
        const mime = file.mimetype;

        if (allowedExtensions.includes(ext) || allowedMimetypes.includes(mime)) {
            cb(null, true);
        } else {
            cb(new Error("Only images are allowed (.jpg, .jpeg, .png, .webp, .gif)"));
        }
    }
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
        // Exclude /maintenance page, /api/me (to check role), and static assets for maintenance
        const excludedPaths = ['/maintenance', '/api/config/public', '/api/me', '/login', '/loginrequest', '/Static/maintenance', '/Static/loginpage'];
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
                lockdown_new_posts: false,
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
        }

        // Merge DB settings into existing config (don't overwrite whole object)
        app.locals.config = { ...app.locals.config, ...configMap };
        console.log("[CONFIG] System settings loaded from database.");
    } catch (err) {
        console.error("[CONFIG] Critical Error loading configuration:", err);
        // Emergency fallback to file if DB fails
        app.locals.config = config;
    }
}

// Initialize config local cache with safe defaults
app.locals.config = {
    maintenance_mode: false,
    maintenance_allowed_roles: ["Owner", "Admin"],
    maintenance_message: "Site is currently undergoing maintenance.",
    lockdown_new_posts: false,
    ratelimits: { api: 200, social: 20, comment: 10, post: 1, youtube_max: 2, youtube_duration: 600 }
};

// Register maintenance middleware SYNC before any routes
app.use(maintenanceMiddleware);

// Kick off async DB load (will update app.locals.config once done)
initializeConfig().then(() => {
    console.log("[INIT] Config sync complete.");
    HandleDatabase.migrateLyrics();
});



// --- Endpoints ---

// HTML Pages
app.get('/', (req, res) => res.redirect('/home'));

// PWA assets
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, '../Static/sw.js'));
});
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, '../Static/manifest.json'));
});
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, '../Static/icon-192.png'));
});

app.get('/home', requireRole(['Owner', 'Admin', 'Moderator', 'User']), (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, '../Static/home/home.html'));
});

app.get('/profile/:username', requireRole(['Owner', 'Admin', 'Moderator', 'User']), (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(path.join(__dirname, '../Static/home/home.html'));
});

app.get('/maintenance', (req, res) => {
    res.sendFile(path.join(__dirname, '../Static/maintenance/maintenance.html'));
});

app.get('/admin', requireRole(['Owner', 'Admin']), (req, res) => {
    res.sendFile(path.join(__dirname, '../Static/home/admin.html'));
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
        const filePath = path.join(__dirname, '../Static/loginpage/login.html');
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
app.post('/loginrequest', authLimiter, async (req, res) => {
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];

    if (Auth.isBlocked(ip)) {
        return res.status(429).json({ error: "Too many failed attempts. Try again later." });
    }

    const { username, password } = req.body;

    const user = await HandleDatabase.getUser(username);

    if (user && Auth.comparePassword(password, user.password)) {
        // Success
        Auth.resetAttempts(ip);
        const sessionId = await Auth.createSession(username, userAgent, ip);

        res.cookie('session_id', sessionId, {
            path: '/',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        });

        return res.json({ success: true, message: "Logged in" });
    } else {
        Auth.addAttempt(ip);
        return res.status(401).json({ error: "Invalid credentials" });
    }
});

// Register
app.post('/register', authLimiter, async (req, res) => {
    const { username, password, email, confirm_password } = req.body;

    if (!username || !password || password !== confirm_password) {
        return res.status(400).json({ error: "Invalid inputs" });
    }

    if (password.length < 6 || password.includes(" ") || password.includes(username)) {
        return res.status(400).json({ error: "Weak password" });
    }

    const existingUser = await HandleDatabase.getUser(username);
    if (existingUser) {
        return res.status(409).json({ error: "Username taken" });
    }

    const hash = Auth.hashPassword(password);
    await HandleDatabase.insertUser(username, hash, email);

    console.log(`[REGISTER] New user registered: ${username}`);
    return res.json({ success: true, message: "Registered" });
});

// Logout
app.post('/logout', async (req, res) => {
    const sessionId = req.cookies.session_id;
    if (sessionId) {
        await Auth.removeSession(sessionId);
    }
    res.cookie('session_id', '', { expires: new Date(0), path: '/' });
    return res.json({ success: true });
});

// API: public config
app.get('/api/config/public', (req, res) => {
    res.json({
        youtube_max: app.locals.config.ratelimits.youtube_max,
        youtube_duration: app.locals.config.ratelimits.youtube_duration,
        maintenance_mode: app.locals.config.maintenance_mode,
        maintenance_message: app.locals.config.maintenance_message
    });
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
        allow_analytics: userRow.allow_analytics === 1
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
    if (!old_password || !new_password) return res.status(400).json({ error: "Missing fields" });

    try {
        const user = await HandleDatabase.getUser(req.user);
        if (!Auth.comparePassword(old_password, user.password)) {
            return res.status(401).json({ error: "Incorrect old password" });
        }

        const newHash = Auth.hashPassword(new_password);
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
        if (!song_id || typeof listen_duration !== 'number') return res.status(400).json({ error: "Invalid data" });

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

        // Access check: Public OR Uploader OR in User's Playlist
        const hasAccess = songData.is_private === "public" ||
            songData.uploaded_by === req.user ||
            await HandleDatabase.isSongInUserPlaylist(req.params.songId, req.user);

        if (!hasAccess) {
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

        // Anyone can save their own version of lyrics if they can access the song
        const hasAccess = songData.is_private === "public" ||
            songData.uploaded_by === req.user ||
            await HandleDatabase.isSongInUserPlaylist(req.params.songId, req.user);

        if (hasAccess) {
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

// API: users
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

    // Users
    const allUsers = await HandleDatabase.getAllUsers();
    const matchingUsers = allUsers.filter(u => u.username.toLowerCase().includes(queryStr)).map(u => {
        return {
            id: u.id,
            username: u.username,
            display_name: u.display_name || u.username,
            bio: u.bio || "",
            avatar: Media.resolveAvatar(u.username),
            songs_count: u.uploaded_songs_count || 0,
            likes_count: u.total_likes || 0
        };
    });

    // Songs
    const allSongs = await HandleDatabase.getAllSongs();
    const matchingSongs = allSongs.filter(s => {
        if (s.hidden_from_library) return false;
        if (s.is_private !== "public" && s.uploaded_by !== req.user) return false;
        return s.songname.toLowerCase().includes(queryStr) ||
            s.artist.toLowerCase().includes(queryStr) ||
            s.album.toLowerCase().includes(queryStr);
    }).map(s => {
        const baseName = path.basename(s.filepath, path.extname(s.filepath));
        return {
            id: s.id,
            name: s.songname,
            artist: s.artist,
            album: s.album,
            duration: Media.formatDuration(s.duration),
            cover: Media.resolveCover(baseName),
            uploaded_by: s.uploaded_by,
            is_private: s.is_private === 'public' ? 'public' : 'private',
            bitrate: s.bitrate,
            extension: path.extname(s.filepath).toLowerCase()
        }
    });

    res.json({ users: matchingUsers, songs: matchingSongs });
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

// API: library
app.get('/api/library', requireLogin, async (req, res) => {
    const allSongs = await HandleDatabase.getAllSongs();
    const library = allSongs.filter(s => s.uploaded_by === req.user && !s.hidden_from_library).map(s => {
        const baseName = path.basename(s.filepath, path.extname(s.filepath));
        return {
            id: s.id,
            name: s.songname,
            artist: s.artist,
            album: s.album,
            duration: Media.formatDuration(s.duration),
            cover: Media.resolveCover(baseName),
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
        const baseName = path.basename(s.filepath, path.extname(s.filepath));
        return {
            id: s.id,
            name: s.songname,
            artist: s.artist,
            album: s.album,
            duration: Media.formatDuration(s.duration),
            cover: Media.resolveCover(baseName),
            uploaded_by: s.uploaded_by,
            is_private: s.is_private === 'public' ? 'public' : 'private',
            bitrate: s.bitrate,
            extension: path.extname(s.filepath).toLowerCase()
        }
    });
    res.json(trending);
});

// API: play
app.get('/api/play/:identifier', requireLogin, async (req, res) => {
    const identifier = decodeURIComponent(req.params.identifier);
    const songData = await HandleDatabase.getSong(identifier);

    if (!songData) return res.status(404).json({ error: "Song not found" });

    // Privacy check
    const isPublic = songData.is_private === "public";
    const isOwner = songData.uploaded_by === req.user;
    const inPublicPlaylist = await HandleDatabase.isSongInPublicPlaylist(songData.id);

    if (!isPublic && !isOwner && !inPublicPlaylist) {
        return res.status(403).json({ error: "Access Denied" });
    }

    let url = songData.filepath.replace(/\\/g, '/');
    if (!url.startsWith('/')) url = '/' + url;

    const baseName = path.basename(songData.filepath, path.extname(songData.filepath));

    res.json({
        id: songData.id,
        name: songData.songname,
        artist: songData.artist,
        album: songData.album,
        genre: songData.genre,
        duration: Media.formatDuration(songData.duration),
        url: url,
        cover: Media.resolveCover(baseName),
        is_private: songData.is_private === 'public' ? 'public' : 'private',
        bitrate: songData.bitrate,
        extension: path.extname(songData.filepath).toLowerCase()
    });
});

// API: upload song (POST) — Batch Support (Limit 5)
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
                const fullFinalPath = path.join(__dirname, '../', finalPath);
                const baseName = path.basename(fullFinalPath, path.extname(fullFinalPath));
                const coverOutPath = path.join(__dirname, '../Static/covers', baseName);

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

    const tempAudioPath = path.join(__dirname, `../MusicLibrary/Temp/yt-${crypto.randomBytes(6).toString('hex')}.m4a`);
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
                const coverDir = path.join(__dirname, '../Static/covers');
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
        const coversDir = path.join(__dirname, '../Static/covers');
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
        const savePath = path.join(coversDir, `${baseName}.jpg`);

        // If we have a direct URL (e.g. from Spotify), use it immediately
        if (directUrl) {
            await downloadFile(directUrl, savePath);
            console.log(`[COVER] Saved from direct URL: ${baseName}.jpg`);
            return;
        }

        // Otherwise, search iTunes with Artist + Title + Album for maximum accuracy
        const searchQuery = `${artist} ${title} ${album}`.trim();
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(searchQuery)}&media=music&limit=1`;

        const data = await new Promise((resolve, reject) => {
            https.get(url, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });

        if (!data.resultCount) {
            // Fallback: try without album if it failed
            if (album) return fetchAndSaveCover(artist, title, baseName);
            return;
        }

        const artwork = data.results[0].artworkUrl100;
        if (!artwork) return;
        const hdArtwork = artwork.replace('100x100bb', '600x600bb');

        if (!fs.existsSync(savePath)) {
            await downloadFile(hdArtwork, savePath);
            console.log(`[COVER] Saved from iTunes: ${baseName}.jpg`);
        }
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
            const tempPath = path.join(__dirname, `../MusicLibrary/Temp/slsk-${crypto.randomBytes(6).toString('hex')}${fileExt}`);

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
                    const tempAudioPath = path.join(__dirname, `../MusicLibrary/Temp/yt-${crypto.randomBytes(6).toString('hex')}.m4a`);
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
                    // Tag with node-id3 (MP3 only — ID3 tags corrupt M4A containers)
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

    // Fetch posts by this user
    const { sortBy = 'newest', limit = 10, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const options = { sortBy, limit: parseInt(limit), offset };

    const isModPlus = ['Owner', 'Admin', 'Moderator'].includes(req.userRow.role);
    const posts = await HandleDatabase.getPostsByUser(targetUsername, req.user, options, isModPlus);
    const enhancedPosts = posts.map(post => ({
        ...post,
        display_name: userRow.display_name || targetUsername,
        avatar: Media.resolveAvatar(targetUsername),
        role: userRow.role,
        image_url: post.image_url ? post.image_url.replace(/\\/g, '/') : null
    }));

    // Fetch public playlists by this user
    const userPlaylists = await HandleDatabase.getPlaylistsByUser(targetUsername);
    const isOwner = targetUsername === req.user;

    const visiblePlaylists = userPlaylists.filter(p => isOwner || p.is_private !== 'private');

    const enhancedPlaylists = await Promise.all(visiblePlaylists.map(async p => {
        const songCount = await HandleDatabase.getPlaylistSongCount(p.id);
        return {
            id: p.id,
            name: p.name,
            owner: p.owner,
            bio: p.bio || "",
            is_private: p.is_private,
            share_id: p.share_id,
            song_count: songCount,
            cover_url: Media.resolveCover('playlist_' + p.id)
        };
    }));

    res.json({
        user: {
            username: targetUsername,
            display_name: userRow.display_name || targetUsername,
            bio: userRow.bio || "",
            avatar: Media.resolveAvatar(targetUsername),
            banner: Media.resolveUserBanner(targetUsername),
            role: userRow.role,
            created_at: userRow.created_at,
            playlists_count: enhancedPlaylists.length
        },
        posts: enhancedPosts,
        playlists: enhancedPlaylists
    });
});

/* ==========================================================
 * POST /api/save-cover
 * Downloads a fetched iTunes cover URL and saves it to
 * Static/covers/ so future song loads skip the iTunes API.
 * ========================================================== */
app.post('/api/save-cover', requireLogin, async (req, res) => {
    const { songname, coverUrl } = req.body;
    if (!songname || !coverUrl) return res.status(400).json({ error: 'Missing params' });

    /* Only allow Apple CDN URLs — prevents SSRF misuse */
    let urlHost;
    try { urlHost = new URL(coverUrl).hostname; }
    catch { return res.status(400).json({ error: 'Invalid URL' }); }

    if (!urlHost.endsWith('mzstatic.com') && !urlHost.endsWith('itunes.apple.com')) {
        return res.status(400).json({ error: 'Cover URL must come from Apple CDN' });
    }

    try {
        const songData = await HandleDatabase.getSong(songname);
        if (!songData) return res.status(404).json({ error: 'Song not found' });
        if (songData.uploaded_by !== req.user) return res.status(403).json({ error: 'Forbidden' });

        const baseName = path.basename(songData.filepath, path.extname(songData.filepath));
        const coversDir = path.join(__dirname, '../Static/covers');
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

        const savePath = path.join(coversDir, `${baseName}.jpg`);

        /* Skip download if the cover already exists on disk */
        if (!fs.existsSync(savePath)) {
            await downloadFile(coverUrl, savePath);
            console.log(`[COVER] Saved: ${baseName}.jpg`);
        }

        return res.json({ success: true, cover: Media.resolveCover(baseName) });
    } catch (err) {
        console.error('[COVER]', err.message);
        return res.status(500).json({ error: 'Failed to save cover' });
    }
});

// --- Posts API ---

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

        const userPlaylists = await HandleDatabase.getPlaylistsByUser(req.user);
        if (userPlaylists.length >= 20) return res.status(400).json({ error: "Maximum 20 playlists allowed" });

        // Create new playlist with original metadata
        const result = await HandleDatabase.insertPlaylist(original.name, req.user, original.original_owner || original.owner);
        const newPlaylistId = result.lastID;

        // Duplicate cover photo physically if it exists
        const originalCoverPattern = `playlist_${original.id}`;
        const coversDir = path.join(__dirname, '../Static/covers');
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
            const p = path.join(__dirname, '../Static', original.cover_path);
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
        const songs = await HandleDatabase.getPlaylistSongs(original.id);
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
        const songs = await HandleDatabase.getPlaylistSongs(playlistId);
        let totalSeconds = 0;
        const result = songs.map(s => {
            const baseName = path.basename(s.filepath, path.extname(s.filepath));
            totalSeconds += parseFloat(s.duration || 0);
            return {
                id: s.song_id,
                name: s.songname,
                artist: s.artist,
                album: s.album,
                duration: Media.formatDuration(s.duration),
                cover: Media.resolveCover(baseName),
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

        if (playlist.is_private === 'private') {
            const user = await getCurrentUser(req);
            if (!user || user !== playlist.owner) {
                return res.status(403).json({ error: "This playlist is private." });
            }
        }

        const songs = await HandleDatabase.getPlaylistSongs(playlist.id);
        let totalSeconds = 0;
        const result = songs.map(s => {
            const baseName = path.basename(s.filepath, path.extname(s.filepath));
            totalSeconds += parseFloat(s.duration || 0);
            return {
                id: s.song_id,
                name: s.songname,
                artist: s.artist,
                album: s.album,
                duration: Media.formatDuration(s.duration),
                cover: Media.resolveCover(baseName),
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
        const coversDir = path.join(__dirname, '../Static/covers');
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
app.delete('/api/songs/:id', requireRole(['Owner', 'User']), async (req, res) => {
    const songId = req.params.id;
    const allSongs = await HandleDatabase.getAllSongs();
    const song = allSongs.find(s => s.id == songId);
    if (!song) return res.status(404).json({ error: "Song not found" });

    const isOwnerRole = req.userRow.role === 'Owner';
    const isUploader = song.uploaded_by === req.user;

    if (isOwnerRole || isUploader) {
        try {
            // Check if others are using this song in their playlists
            const usageCount = await HandleDatabase.getPlaylistUsageCount(songId, req.user);

            // Physical file cleanup only if NO ONE else is using it
            if (usageCount === 0) {
                const fullPath = path.join(__dirname, '../', song.filepath);
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
                        const cp = path.join(__dirname, '../Static/covers', baseName + ext);
                        if (fs.existsSync(cp)) fs.unlinkSync(cp);
                    }
                }
                await HandleDatabase.deleteSong(songId);
            } else {
                // Someone else is using it! Just hide it from the uploader and clear their quota
                console.log(`[SAFE DELETE] Song ${songId} is in use by ${usageCount} other playlists. Keeping file.`);
                const fullPath = path.join(__dirname, '../', song.filepath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    await HandleDatabase.decrementStorageUsed(song.uploaded_by, stats.size);
                }
                await HandleDatabase.hideSongFromUploader(songId);
            }

            await HandleDatabase.removeSongFromUserPlaylists(songId, req.user);
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
app.patch('/api/songs/:id', requireRole(['Owner', 'User']), async (req, res) => {
    const songId = req.params.id;
    const { songname, artist, album, is_private } = req.body;

    const allSongs = await HandleDatabase.getAllSongs();
    const song = allSongs.find(s => s.id == songId);
    if (!song) return res.status(404).json({ error: "Song not found" });

    const isOwnerRole = req.userRow.role === 'Owner';
    const isUploader = song.uploaded_by === req.user;

    if (isOwnerRole || isUploader) {
        const updates = {};
        if (songname !== undefined) updates.songname = songname;
        if (artist !== undefined) updates.artist = artist;
        if (album !== undefined) updates.album = album;
        if (is_private !== undefined) updates.is_private = is_private;

        if (Object.keys(updates).length > 0) {
            await HandleDatabase.updateSong(songId, updates);
        }
        res.json({ success: true, message: "Song updated" });
    } else {
        res.status(403).json({ error: "Forbidden" });
    }
});

// Bulk Delete Songs
app.post('/api/songs/bulk-delete', requireRole(['Owner', 'User']), async (req, res) => {
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

        const isOwnerRole = req.userRow.role === 'Owner';
        const isUploader = song.uploaded_by === req.user;

        if (isOwnerRole || isUploader) {
            const usageCount = await HandleDatabase.getPlaylistUsageCount(id, req.user);
            if (usageCount === 0) {
                const fullPath = path.join(__dirname, '../', song.filepath);
                if (fs.existsSync(fullPath)) {
                    try {
                        const stats = fs.statSync(fullPath);
                        fs.unlinkSync(fullPath);
                        await HandleDatabase.decrementStorageUsed(song.uploaded_by, stats.size);

                        const baseName = path.basename(song.filepath, path.extname(song.filepath));
                        const coverExts = ['.jpg', '.jpeg', '.png', '.webp'];
                        for (const ext of coverExts) {
                            const cp = path.join(__dirname, '../Static/covers', baseName + ext);
                            if (fs.existsSync(cp)) fs.unlinkSync(cp);
                        }
                    } catch (err) { console.error(err); }
                }
                await HandleDatabase.deleteSong(id);
            } else {
                const fullPath = path.join(__dirname, '../', song.filepath);
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
app.post('/api/songs/:id/cover', requireRole(['Owner', 'User']), uploadCover.single('cover_file'), async (req, res) => {
    const songId = req.params.id;
    if (!req.file) return res.status(400).json({ error: "No file" });

    const allSongs = await HandleDatabase.getAllSongs();
    const song = allSongs.find(s => s.id == songId);
    if (!song) return res.status(404).json({ error: "Song not found" });

    const isOwnerRole = req.userRow.role === 'Owner';
    const isUploader = song.uploaded_by === req.user;

    if (isOwnerRole || isUploader) {
        try {
            const baseName = path.basename(song.filepath, path.extname(song.filepath));
            const coversDir = path.join(__dirname, '../Static/covers');
            if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

            const savePath = path.join(coversDir, `${baseName}.jpg`);

            // Re-use Jimp from Media or just write buffer
            // For simplicity and speed, let's just write the buffer if it's an image
            fs.writeFileSync(savePath, req.file.buffer);

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

    await HandleDatabase.deleteUser(targetUsername);
    res.json({ success: true, message: `Profile ${targetUsername} deleted` });
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
        const postCount = await HandleDatabase.getPostsCount();

        // Count active sessions
        const sessionCountQuery = await HandleDatabase.allQuery('users', "SELECT COUNT(*) as count FROM sessions");
        const sessionCount = sessionCountQuery[0].count;

        res.json({
            users: userCount,
            songs: songCount,
            posts: postCount,
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
    res.json(app.locals.config);
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
        res.json({ success: true, config: app.locals.config });
    } catch (err) {
        console.error('[ADMIN CONFIG SAVE]', err);
        res.status(500).json({ error: "Failed to save config to database" });
    }
});

app.get('/api/admin/db/tables', requireRole(['Owner', 'Admin']), async (req, res) => {
    res.json({
        users: ['users', 'sessions'],
        music: ['songs', 'playlists', 'playlist_songs'],
        social: ['posts', 'post_likes', 'post_comments', 'notifications', 'mentions', 'dm_requests', 'dm_conversations', 'dm_messages']
    });
});

app.get('/api/admin/db/data/:table', requireRole(['Owner', 'Admin']), async (req, res) => {
    const table = req.params.table;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    // Define which DB each table belongs to
    const dbMap = {
        users: 'users', sessions: 'users', system_logs: 'users',
        songs: 'music', playlists: 'music', playlist_songs: 'music',
        posts: 'social', post_likes: 'social', post_comments: 'social',
        notifications: 'social', mentions: 'social',
        dm_requests: 'social', dm_conversations: 'social', dm_messages: 'social'
    };

    const dbName = dbMap[table];
    if (!dbName) return res.status(400).json({ error: "Invalid table" });

    // Role-based table protection
    if (table === 'dm_messages' && req.userRow.role !== 'Owner') {
        return res.status(403).json({ error: "Forbidden: This table is restricted to the Owner." });
    }
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
    console.error(`[CRITICAL ERROR] ${err.stack}`);

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

    res.status(500).json({
        error: "Internal Server Error",
        message: err.message,
        debug: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('[GLOBAL ERROR]', err);
    if (res.headersSent) return next(err);

    if (req.originalUrl.startsWith('/api/')) {
        return res.status(500).json({ error: "Internal Server Error: " + err.message });
    }
    // Default HTML error page
    res.status(500).send("<html><body><h1>Internal Server Error</h1><p>" + err.message + "</p></body></html>");
});

httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Streamify Dev Server running on https://localhost:${port}`);
});
// --- Graceful Shutdown ---
const gracefulShutdown = async () => {
    console.log("\n[SERVER] Shutting down gracefully (Ctrl+C detected)...");

    // Stop accepting new connections
    httpServer.close(async () => {
        console.log("[SERVER] HTTP and WebSocket server closed.");

        // Properly close database connections to merge WAL logs
        await HandleDatabase.close();

        console.log("[SERVER] Shutdown complete. See you next time!");
        process.exit(0);
    });

    // Safety fallback: If connections (like WebSockets) are still active after 5s,
    // we save the DB and force the exit anyway.
    setTimeout(async () => {
        console.warn("[SERVER] Shutdown timed out (active connections). Saving DB and exiting.");
        await HandleDatabase.close();
        process.exit(0);
    }, 5000);
};

// Catch SIGINT (Ctrl+C) and SIGTERM (Kill signal)
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

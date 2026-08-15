/**
 * Streamify Runtime Environment
 * ------------------------------
 * Single source of truth for everything that differs between the three ways
 * Streamify can run:
 *
 *   1. `node server.js` from a git clone   (repo-relative paths, HTTP)
 *   2. Packaged Electron desktop app       (userData paths, asar-unpacked binaries)
 *   3. Any of the above behind TLS         (certs dropped into SSL/)
 *
 * Nothing here has side effects beyond creating writable directories, so it is
 * safe to require from both the Express server and the Electron main process.
 *
 * Design rule: when no environment variables are set, this module must resolve
 * to EXACTLY the paths the project used before it existed. Backwards
 * compatibility for existing installs is not negotiable.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * asar handling
 * ------------------------------------------------------------------ */

/**
 * Rewrites a path that points inside an Electron asar archive so it points at
 * the unpacked mirror instead.
 *
 * Native executables (ffmpeg, yt-dlp) cannot be spawned from inside app.asar
 * because the OS cannot exec a file that only exists inside a virtual archive.
 * electron-builder's `asarUnpack` copies them to `app.asar.unpacked/`, but the
 * `require()`d path still says `app.asar` — so callers must rewrite it.
 *
 * No-op when not running from an asar, which keeps `node server.js` working.
 */
function unpackPath(p) {
    if (typeof p !== 'string' || !p.includes('app.asar')) return p;
    return p.replace(/app\.asar(?![\w.])/, 'app.asar.unpacked');
}

/** True when running inside a packaged Electron build. */
const isPackaged = __dirname.includes('app.asar');

/* ------------------------------------------------------------------ *
 * Writable data root
 * ------------------------------------------------------------------ */

/**
 * Where user data lives (databases, music uploads, covers, avatars, banners).
 *
 * Defaults to the repo root so existing clones keep using ./Database,
 * ./MusicLibrary and ./Static exactly as before. Electron overrides this with
 * app.getPath('userData') because the app directory is read-only once packaged.
 */
const DATA_ROOT = process.env.STREAMIFY_DATA_DIR
    ? path.resolve(process.env.STREAMIFY_DATA_DIR)
    : REPO_ROOT;

const paths = {
    repoRoot: REPO_ROOT,
    dataRoot: DATA_ROOT,

    // Databases
    usersDb: path.join(DATA_ROOT, 'Database', 'Dev', 'Users'),
    musicDb: path.join(DATA_ROOT, 'Database', 'Dev', 'Music'),
    backups: path.join(DATA_ROOT, 'Database', 'Backups'),

    // User generated media
    uploads: path.join(DATA_ROOT, 'MusicLibrary', 'uploads'),
    temp: path.join(DATA_ROOT, 'MusicLibrary', 'Temp'),
    covers: path.join(DATA_ROOT, 'Static', 'covers'),
    avatars: path.join(DATA_ROOT, 'Static', 'avatars'),
    banners: path.join(DATA_ROOT, 'Static', 'banners'),

    // Read-only application assets always ship with the app, never in DATA_ROOT
    static: path.join(REPO_ROOT, 'Static'),

    // Runtime config file. Kept beside the data, not inside the read-only asar,
    // so the OOBE wizard and admin panel can persist changes.
    config: process.env.STREAMIFY_CONFIG
        ? path.resolve(process.env.STREAMIFY_CONFIG)
        : path.join(isPackaged ? DATA_ROOT : __dirname, 'config.json'),

    ssl: process.env.STREAMIFY_SSL_DIR
        ? path.resolve(process.env.STREAMIFY_SSL_DIR)
        : path.join(DATA_ROOT, 'SSL'),
};

/** Creates every writable directory Streamify expects to exist. */
function ensureDirectories() {
    const required = [
        paths.usersDb, paths.musicDb, paths.backups,
        paths.uploads, paths.temp, paths.covers, paths.avatars, paths.banners,
    ];
    for (const dir of required) {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            console.error(`[RUNTIME] Could not create directory ${dir}:`, err.message);
        }
    }
}

/* ------------------------------------------------------------------ *
 * Config file
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
    maintenance_mode: false,
    maintenance_allowed_roles: ['Owner', 'Admin'],
    music_directory: '../MusicLibrary/uploads',
    music_directories: [],
    music_library_owner: null,
    maintenance_message: 'Site is currently undergoing maintenance. Please check back later!',
    ratelimits: {
        api: 200, social: 20, comment: 5, post: 1,
        youtube_max: 5, youtube_duration: 600,
    },
};

/**
 * Loads config.json, seeding it from config.example.json (or built-in defaults)
 * on first run. A fresh clone or a fresh desktop install therefore boots
 * without the user having to create anything by hand.
 */
function loadConfig() {
    try {
        if (!fs.existsSync(paths.config)) {
            const example = path.join(__dirname, 'config.example.json');
            const seed = fs.existsSync(example)
                ? JSON.parse(fs.readFileSync(example, 'utf8'))
                : DEFAULT_CONFIG;

            fs.mkdirSync(path.dirname(paths.config), { recursive: true });
            fs.writeFileSync(paths.config, JSON.stringify(seed, null, 4));
            console.log(`[RUNTIME] Created default config at ${paths.config}`);
            return { ...DEFAULT_CONFIG, ...seed };
        }
        const parsed = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
        return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
        console.error('[RUNTIME] config.json unreadable, falling back to defaults:', err.message);
        return { ...DEFAULT_CONFIG };
    }
}

/** Persists config back to disk. Returns false instead of throwing. */
function saveConfig(config) {
    try {
        fs.writeFileSync(paths.config, JSON.stringify(config, null, 4));
        return true;
    } catch (err) {
        console.error('[RUNTIME] Failed to save config:', err.message);
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

const PORT = Number(
    process.env.PORT || process.env.STREAMIFY_PORT || 4443
);

// 0.0.0.0 keeps phones on the LAN able to reach the server. Set
// STREAMIFY_HOST=127.0.0.1 to make the instance desktop-only.
const HOST = process.env.HOST || process.env.STREAMIFY_HOST || '0.0.0.0';

/**
 * Detects a TLS keypair in the SSL directory.
 *
 * This is what upgrades a LAN install from "degraded HTTP" to a full secure
 * context (service worker, offline downloads, installable PWA, wake lock).
 * Presence of the files is the only opt-in required.
 */
function detectSsl() {
    if (process.env.STREAMIFY_DISABLE_HTTPS === '1') {
        return { enabled: false, reason: 'disabled via STREAMIFY_DISABLE_HTTPS' };
    }

    // Explicit override wins over auto-detection.
    if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
        const key = path.resolve(process.env.SSL_KEY_PATH);
        const cert = path.resolve(process.env.SSL_CERT_PATH);
        if (fs.existsSync(key) && fs.existsSync(cert)) {
            return { enabled: true, key, cert, source: 'env' };
        }
        return { enabled: false, reason: 'SSL_KEY_PATH/SSL_CERT_PATH set but files missing' };
    }

    if (!fs.existsSync(paths.ssl)) {
        return { enabled: false, reason: 'no SSL directory' };
    }

    // Support the naming conventions people actually end up with, depending on
    // whether they used mkcert, openssl, certbot or Cloudflare origin certs.
    const candidates = [
        ['key.pem', 'cert.pem'],
        ['privkey.pem', 'fullchain.pem'],
        ['server.key', 'server.crt'],
        ['streamify.key', 'streamify.crt'],
    ];

    for (const [keyName, certName] of candidates) {
        const key = path.join(paths.ssl, keyName);
        const cert = path.join(paths.ssl, certName);
        if (fs.existsSync(key) && fs.existsSync(cert)) {
            return { enabled: true, key, cert, source: path.basename(paths.ssl) };
        }
    }

    return { enabled: false, reason: 'no keypair found in SSL directory' };
}

/**
 * Every LAN address a phone could use to reach this server.
 * Powers the desktop app's "Connect your phone" QR panel.
 */
function getLanAddresses() {
    const results = [];
    const interfaces = os.networkInterfaces();

    for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
            // Node <18 reports family as 'IPv4', >=18 as 4. Accept both.
            const isIPv4 = addr.family === 'IPv4' || addr.family === 4;
            if (!isIPv4 || addr.internal) continue;

            // Skip virtual adapters (VirtualBox, WSL, Docker, Hyper-V) which
            // advertise addresses no phone can actually route to.
            if (/^(vEthernet|VirtualBox|Loopback|Docker|WSL|Hyper-V)/i.test(name)) continue;
            if (addr.address.startsWith('169.254.')) continue; // link-local, no DHCP

            results.push({ interface: name, address: addr.address });
        }
    }
    return results;
}

/** The URL to show the user, given the active protocol and a host. */
function buildUrl(host, ssl = detectSsl(), targetPort = PORT) {
    const protocol = ssl.enabled ? 'https' : 'http';
    const isDefaultPort =
        (protocol === 'https' && targetPort === 443) || (protocol === 'http' && targetPort === 80);
    return `${protocol}://${host}${isDefaultPort ? '' : `:${targetPort}`}`;
}

module.exports = {
    REPO_ROOT,
    DATA_ROOT,
    isPackaged,
    paths,
    PORT,
    HOST,
    unpackPath,
    ensureDirectories,
    loadConfig,
    saveConfig,
    detectSsl,
    getLanAddresses,
    buildUrl,
    DEFAULT_CONFIG,
};

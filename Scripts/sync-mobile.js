const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'Static');
const MOBILE_DIR = path.join(ROOT, 'mobile');
const MOBILE_STATIC = path.join(MOBILE_DIR, 'Static');
const MOBILE_SOCKET_IO = path.join(MOBILE_DIR, 'socket.io');

console.log('[MOBILE SYNC] Bundling Streamify app shell into mobile directory...');

// Ensure target directories exist
if (!fs.existsSync(MOBILE_DIR)) fs.mkdirSync(MOBILE_DIR, { recursive: true });
if (!fs.existsSync(MOBILE_STATIC)) fs.mkdirSync(MOBILE_STATIC, { recursive: true });
if (!fs.existsSync(MOBILE_SOCKET_IO)) fs.mkdirSync(MOBILE_SOCKET_IO, { recursive: true });

// Copy Static assets (home UI, CSS, JS, vendor fonts)
// Exclude uploaded user media (covers, avatars, banners) to keep app bundle small
fs.cpSync(STATIC_DIR, MOBILE_STATIC, {
    recursive: true,
    filter: (source) => {
        const rel = path.relative(STATIC_DIR, source);
        if (rel.startsWith('covers') || rel.startsWith('avatars') || rel.startsWith('banners')) {
            // Keep folder itself, skip user uploaded media
            if (rel === 'covers' || rel === 'avatars' || rel === 'banners') return true;
            return false;
        }
        return true;
    }
});

// Copy socket.io client runtime so local shell has no missing script errors
const socketIoSource = path.join(ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
if (fs.existsSync(socketIoSource)) {
    fs.copyFileSync(socketIoSource, path.join(MOBILE_SOCKET_IO, 'socket.io.js'));
    console.log('[MOBILE SYNC] Copied socket.io client bundle.');
}

console.log('[MOBILE SYNC] Mobile bundle prepared successfully.');

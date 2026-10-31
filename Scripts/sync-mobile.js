/*
 * Mirrors the web app (Static/) into the Capacitor bundle (mobile/Static/).
 *
 * The iOS app ships whatever is in mobile/ (capacitor.config.json -> webDir),
 * so if this isn't run the IPA keeps an old copy of the UI. It is a true
 * mirror: files that no longer exist in Static/ are removed from the bundle
 * too, so stale scripts can't linger.
 *
 *   npm run mobile:sync      (mirror + npx cap sync ios)
 *   node Scripts/sync-mobile.js --check   (exit 1 if the bundle is out of date)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'Static');
const MOBILE_DIR = path.join(ROOT, 'mobile');
const MOBILE_STATIC = path.join(MOBILE_DIR, 'Static');
const MOBILE_SOCKET_IO = path.join(MOBILE_DIR, 'socket.io');
const CHECK_ONLY = process.argv.includes('--check');

// User-uploaded media lives on the server, never in the app bundle.
const MEDIA_DIRS = ['covers', 'avatars', 'banners', 'artists'];

function isExcluded(rel) {
    const top = rel.split(path.sep)[0];
    return MEDIA_DIRS.includes(top) && rel !== top; // keep the empty folder itself
}

function walk(dir, base = dir, out = new Map()) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(base, abs);
        if (isExcluded(rel)) continue;
        if (entry.isDirectory()) {
            out.set(rel, 'dir');
            walk(abs, base, out);
        } else if (entry.isFile()) {
            out.set(rel, 'file');
        }
    }
    return out;
}

function sameFile(a, b) {
    try {
        const sa = fs.statSync(a);
        const sb = fs.statSync(b);
        if (sa.size !== sb.size) return false;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch {
        return false;
    }
}

const source = walk(STATIC_DIR);
const target = walk(MOBILE_STATIC);
let copied = 0;
let removed = 0;
const changes = [];

// Copy new / changed files
for (const [rel, kind] of source) {
    const from = path.join(STATIC_DIR, rel);
    const to = path.join(MOBILE_STATIC, rel);
    if (kind === 'dir') {
        if (!CHECK_ONLY) fs.mkdirSync(to, { recursive: true });
        continue;
    }
    if (target.get(rel) === 'file' && sameFile(from, to)) continue;
    changes.push(`+ ${rel}`);
    if (!CHECK_ONLY) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    }
    copied++;
}

// Remove files that were deleted from Static/ (deepest first)
const stale = [...target.keys()].filter(rel => !source.has(rel)).sort((a, b) => b.length - a.length);
for (const rel of stale) {
    changes.push(`- ${rel}`);
    if (!CHECK_ONLY) fs.rmSync(path.join(MOBILE_STATIC, rel), { recursive: true, force: true });
    removed++;
}

if (CHECK_ONLY) {
    if (changes.length) {
        console.log(`[MOBILE SYNC] Bundle is out of date (${changes.length} difference(s)):`);
        changes.slice(0, 40).forEach(line => console.log('  ' + line));
        if (changes.length > 40) console.log(`  ...and ${changes.length - 40} more`);
        console.log('[MOBILE SYNC] Run: npm run mobile:sync');
        process.exit(1);
    }
    console.log('[MOBILE SYNC] Bundle is up to date.');
    process.exit(0);
}

for (const dir of MEDIA_DIRS) fs.mkdirSync(path.join(MOBILE_STATIC, dir), { recursive: true });

// Socket.IO client runtime so the local shell has no missing script errors
fs.mkdirSync(MOBILE_SOCKET_IO, { recursive: true });
const socketIoSource = path.join(ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
if (fs.existsSync(socketIoSource)) {
    fs.copyFileSync(socketIoSource, path.join(MOBILE_SOCKET_IO, 'socket.io.js'));
}

console.log(`[MOBILE SYNC] Done: ${copied} file(s) updated, ${removed} stale file(s) removed.`);

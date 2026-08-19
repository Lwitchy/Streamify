/**
 * Static wiring check: every getElementById() target used by the page scripts
 * must actually exist in home.html, and every asset home.html loads must exist
 * on disk and be listed in the service worker's APP_SHELL.
 *
 * Catches the classic silent failure where a renamed id leaves a button dead.
 *
 *     node Tests/domWiring.check.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(REPO, relative), 'utf8');

const html = read('Static/home/home.html');
const sw = read('Static/sw.js');

const scripts = [
    'Static/home/js/downloads.js',
    'Static/home/js/ui.js',
    'Static/home/js/updates.js'
];

let failures = 0;
const fail = message => { console.log(`  FAIL  ${message}`); failures += 1; };
const warn = message => console.log(`  WARN  ${message}`);

/**
 * ui.js still probes ids belonging to features whose markup was removed long
 * before this check existed (the social feed, DMs, the retired uploader, the
 * old top-bar links). Every call site is null-guarded, so they are inert.
 * Reported as a warning so genuinely new breakage is not buried, without
 * failing the build on pre-existing debt.
 */
const KNOWN_LEGACY_IDS = new Set([
    'notification-menu', 'home-link', 'people-link', 'upload-link',
    'post-btn', 'compose-textarea', 'add-photo-btn', 'feed-photo-upload',
    'compose-photo-preview', 'compose-photo-img', 'remove-photo-btn',
    'feed-crop-modal', 'feed-crop-image', 'save-feed-crop-btn',
    'cancel-feed-crop-btn', 'close-feed-crop-btn', 'filter-dropdown-btn',
    'filter-dropdown-menu', 'current-filter', 'load-more-btn',
    'open-dm-btn', 'dm-close-btn', 'dm-chat-empty', 'dm-chat-active',
    'dm-contacts-list', 'dm-contacts-search', 'dm-new-btn', 'dm-requests-btn',
    'dm-requests-modal', 'close-dm-requests-modal', 'dm-message-input',
    'dm-send-btn', 'dm-back-contacts-btn'
]);

/* --- 1. getElementById targets exist --------------------------------- */

const ids = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]));

for (const relative of scripts) {
    const source = read(relative);
    const missing = new Set();
    const legacy = new Set();
    for (const match of source.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (ids.has(match[1])) continue;
        (KNOWN_LEGACY_IDS.has(match[1]) ? legacy : missing).add(match[1]);
    }

    if (missing.size > 0) fail(`${relative} references unknown ids: ${[...missing].join(', ')}`);
    else console.log(`  OK    ${relative}: all getElementById targets resolve`);

    if (legacy.size > 0) warn(`${relative}: ${legacy.size} inert reference(s) to removed features`);
}

/* --- 2. assets referenced by home.html exist on disk ------------------ */

const assetRefs = new Set();
for (const match of html.matchAll(/(?:src|href)=["'](\/Static\/[^"'?]+)(\?[^"']*)?["']/g)) {
    assetRefs.add(match[1]);
}
const missingAssets = [...assetRefs].filter(ref => !fs.existsSync(path.join(REPO, ref.replace(/^\//, ''))));
if (missingAssets.length > 0) fail(`home.html references missing files: ${missingAssets.join(', ')}`);
else console.log(`  OK    all ${assetRefs.size} /Static assets referenced by home.html exist`);

/* --- 3. versioned css/js in home.html are cached by the service worker - */

const shellBlock = sw.slice(sw.indexOf('const APP_SHELL'), sw.indexOf('];', sw.indexOf('const APP_SHELL')));
const shellEntries = new Set([...shellBlock.matchAll(/'([^']+)'/g)].map(m => m[1]));

const versioned = [...html.matchAll(/(?:src|href)=["'](\/Static\/home\/(?:css|js)\/[^"']+)["']/g)].map(m => m[1]);
const notCached = versioned.filter(entry => !shellEntries.has(entry));
if (notCached.length > 0) {
    fail(`these are loaded by home.html but missing from sw.js APP_SHELL (stale-cache risk): ${notCached.join(', ')}`);
} else {
    console.log(`  OK    all ${versioned.length} versioned css/js entries are in APP_SHELL`);
}

/* --- 4. APP_SHELL does not list files that no longer exist ------------ */

const staleShell = [...shellEntries]
    .filter(entry => entry.startsWith('/Static/'))
    .map(entry => entry.split('?')[0])
    .filter(entry => !fs.existsSync(path.join(REPO, entry.replace(/^\//, ''))));
if (staleShell.length > 0) fail(`APP_SHELL lists missing files (install would fail): ${staleShell.join(', ')}`);
else console.log('  OK    APP_SHELL contains no dangling paths');

/* --- 5. download engine extensions are a subset of the scanner's ------ */

const downloads = read('Server/downloads.js');
const server = read('Server/server.js');
const parseSet = (source, marker) => {
    const line = source.slice(source.indexOf(marker));
    const list = line.slice(line.indexOf('['), line.indexOf(']') + 1);
    return new Set(JSON.parse(list.replace(/'/g, '"')));
};
const engineExts = parseSet(downloads, 'const AUDIO_EXTENSIONS');
const scannerExts = parseSet(server, 'const supportedMusicExtensions');
const unscannable = [...engineExts].filter(ext => !scannerExts.has(ext));
if (unscannable.length > 0) {
    fail(`downloads.js accepts ${unscannable.join(', ')} which server.js cannot scan; such files would be flagged 'missing' on the next scan`);
} else {
    console.log('  OK    every downloadable extension is scannable');
}

console.log(failures === 0 ? '\nDOM wiring checks passed.\n' : `\n${failures} wiring check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Renders the Get Music page in a minimal DOM and asserts the behaviour the
 * markup alone cannot prove:
 *
 *   - YouTube search works with no Soulseek setup at all
 *   - the Soulseek tab only surfaces its notice when selected
 *   - clicking Download asks for confirmation instead of queueing
 *   - cancelling the dialog queues nothing and restores the button
 *
 *     node Tests/downloadsUi.check.js
 *
 * Uses a hand-rolled DOM stub rather than a jsdom dependency, since the page
 * only touches a small, well-defined slice of the DOM API.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'Static/home/home.html'), 'utf8');

/* ------------------------------------------------------------------ *
 * Minimal DOM
 * ------------------------------------------------------------------ */

class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...names) { names.forEach(n => n && this.set.add(n)); }
    remove(...names) { names.forEach(n => this.set.delete(n)); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : Boolean(force);
        if (on) this.set.add(name); else this.set.delete(name);
        return on;
    }
    get value() { return [...this.set].join(' '); }
}

class Element {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parent = null;
        this.classList = new ClassList(this);
        this.style = {};
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this._text = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.checked = false;
    }
    /*
     * Assigning `.type` or `.checked` on a real <input> is reflected in the
     * DOM, so the stub mirrors that onto attributes. Selector matching and
     * production code both read them back, and a silent no-op here would make
     * `input[type="checkbox"]` never match.
     */
    set type(v) { this.attributes.type = String(v); }
    get type() { return this.attributes.type || ''; }
    set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return this.classList.value; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map(c => c.textContent).join('');
    }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    replaceChildren(...nodes) {
        this.children = [];
        this._text = '';
        nodes.forEach(n => this.appendChild(n));
    }
    replaceWith(node) {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children[i] = node;
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    focus() {}
    click() { (this.listeners.click || []).forEach(fn => fn({ preventDefault() {}, target: this })); }
    closest(selector) {
        const want = selector.replace(/^\./, '').split('.');
        let node = this;
        while (node) {
            if (want.every(c => node.classList.contains(c))) return node;
            node = node.parent;
        }
        return null;
    }
    /**
     * Minimal but REAL selector matching, so tests exercise the same lookups
     * production uses. Only the shapes this app actually queries are supported:
     * `.class`, `tag`, `[attr]`, `[attr="value"]`, and `a b` descendant chains.
     */
    querySelectorAll(selector) {
        return matchesAll(this, selector);
    }
    querySelector(selector) {
        return matchesAll(this, selector)[0] || null;
    }
    get offsetWidth() { return 0; }
}

/** Splits a descendant selector on whitespace, ignoring whitespace in brackets. */
function splitSelector(selector) {
    const parts = [];
    let current = '';
    let bracketDepth = 0;
    for (const char of String(selector)) {
        if (char === '[') bracketDepth += 1;
        if (char === ']') bracketDepth -= 1;
        if (/\s/.test(char) && bracketDepth === 0) {
            if (current) { parts.push(current); current = ''; }
            continue;
        }
        current += char;
    }
    if (current) parts.push(current);
    return parts;
}

/** Reads an attribute, including the data-* names mirrored onto dataset. */
function readAttribute(node, name) {
    if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return node.dataset[key];
    }
    return node.attributes[name];
}

/** True when `node` satisfies a single compound selector like `input.x[y="z"]`. */
function matchesCompound(node, compound) {
    let rest = compound;
    const attrs = [];
    rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => { attrs.push(inner); return ''; });

    const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
    if (tagMatch && node.tagName !== tagMatch[0].toUpperCase()) return false;

    for (const className of rest.match(/\.([\w-]+)/g) || []) {
        if (!node.classList.contains(className.slice(1))) return false;
    }

    for (const attr of attrs) {
        const eq = /^([\w-]+)\s*=\s*["']?([^"']*)["']?$/.exec(attr);
        if (eq) {
            const [, name, value] = eq;
            if (String(readAttribute(node, name)) !== value) return false;
        } else {
            // Presence test: [data-index] matches only when the value is set.
            // Note the name is the FULL attribute here (data-index), which is
            // why it must go through readAttribute rather than indexing
            // dataset directly with the prefixed name.
            const value = readAttribute(node, attr);
            if (value === undefined || value === null || value === '') return false;
        }
    }

    return true;
}

/** Walks descendants, honouring descendant combinators in `selector`. */
function matchesAll(root, selector) {
    const parts = splitSelector(selector);
    if (parts.length === 0) return [];

    const found = [];
    const visit = (node, index) => {
        if (matchesCompound(node, parts[index])) {
            if (index === parts.length - 1) found.push(node);
            else node.children.forEach(child => visit(child, index + 1));
        }
        // A descendant match may start at any depth, so keep descending.
        node.children.forEach(child => visit(child, index));
    };
    root.children.forEach(child => visit(child, 0));
    return found;
}

// Parse ids + classes out of the real home.html so the stub mirrors it.
const registry = new Map();
for (const match of html.matchAll(/<(\w+)([^>]*\sid=["']([^"']+)["'][^>]*)>/g)) {
    const [, tag, attrs, id] = match;
    const el = new Element(tag);
    const cls = /class=["']([^"']*)["']/.exec(attrs);
    if (cls) el.className = cls[1];
    if (/\shidden(?=[\s>])/.test(attrs)) el.hidden = true;
    registry.set(id, el);
}

const document = {
    readyState: 'complete',
    body: new Element('body'),
    documentElement: new Element('html'),
    createElement: tag => new Element(tag),
    getElementById: id => registry.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

const fetchCalls = [];
let soulseekState = { configured: false, username: null, connected: false, error: null };
let queueItems = [];
// Reported by /api/downloads/status; null means the breaker is closed.
let youtubeState = null;

const context = {
    document,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => fn(),
    toasts: [],
    async fetch(url, options = {}) {
        const body = options.body ? JSON.parse(options.body) : null;
        fetchCalls.push({ url, method: options.method || 'GET', body });

        if (url.endsWith('/api/downloads/status')) {
            return jsonResponse({
                success: true,
                items: queueItems,
                downloadFolder: 'C:/Music/Streamify Downloads',
                soulseek: soulseekState,
                youtube: youtubeState
            });
        }
        if (url.endsWith('/api/downloads/search')) {
            const source = body && body.sources && body.sources[0];
            if (source === 'soulseek') {
                return jsonResponse({
                    success: true,
                    source: 'soulseek',
                    results: [soulseekResult],
                    soulseek: { available: true, error: null, results: [soulseekResult] },
                    youtube: { available: false, error: null, results: [] }
                });
            }
            return jsonResponse({
                success: true,
                source: 'youtube',
                results: [youtubeResult],
                soulseek: { available: false, error: null, results: [] },
                youtube: { available: true, error: null, results: [youtubeResult] }
            });
        }
        if (url.endsWith('/api/downloads/enqueue')) {
            queueItems = body.items.map((it, i) => ({ id: i + 1, title: it.title, status: 'queued' }));
            return jsonResponse({ success: true, queued: body.items.length, skipped: [], items: queueItems });
        }
        if (url.endsWith('/api/downloads/resolve')) {
            // A three-track album where the middle one is already owned, so the
            // unticking behaviour has something to act on.
            return jsonResponse({
                success: true,
                kind: 'spotify',
                label: 'Test Album',
                tracks: [
                    { title: 'First Track', artist: 'Test Artist', album: 'Test Album' },
                    { title: 'Owned Track', artist: 'Test Artist', album: 'Test Album', inLibrary: true },
                    { title: 'Third Track', artist: 'Test Artist', album: 'Test Album' }
                ]
            });
        }
        return jsonResponse({ success: true });
    }
};
context.window = context;
context.showToast = (m, t) => context.toasts.push({ m, t });

function jsonResponse(payload) {
    return { ok: true, status: 200, json: async () => payload };
}

const soulseekResult = {
    id: 'slsk:bob:/music/song.flac', source: 'soulseek', title: 'song', user: 'bob',
    extension: 'FLAC', bitrate: 900, sizeBytes: 30000000, slots: true, queueLength: 0,
    payload: { user: 'bob', remotePath: '/music/song.flac' }
};

const youtubeResult = {
    id: 'youtube:dQw4w9WgXcQ', source: 'youtube', title: 'song', artist: 'some artist',
    user: 'SomeVEVO', extension: 'MP3', bitrate: 320, duration: 213,
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    payload: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
};
/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const vm = require('vm');
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(REPO, 'Static/home/js/downloads.js'), 'utf8'), context);

const api = context.window.StreamifyDownloads;
assert.ok(api && typeof api.open === 'function', 'StreamifyDownloads.open must be exported');

const el = id => document.getElementById(id);
const textOf = id => (el(id) ? el(id).textContent : '');
let failures = 0;
const check = (label, fn) => {
    try { fn(); console.log(`  OK    ${label}`); }
    catch (error) { console.log(`  FAIL  ${label}\n          ${error.message}`); failures += 1; }
};

(async () => {
    /* --- Nothing set up: YouTube must work immediately --------------- */
    soulseekState = { configured: false, username: null, connected: false, error: null };
    api.open();
    await new Promise(r => setTimeout(r, 30));

    check('no status dots are rendered', () => {
        const dump = JSON.stringify([...registry.values()].map(e => e.className));
        assert.ok(!dump.includes('source-dot'), 'a source-dot element still exists');
        assert.ok(!dump.includes('source-chip'), 'a source-chip element still exists');
    });

    check('no notice is shown while YouTube (the default) is selected', () => {
        assert.strictEqual(el('downloads-source-notice').children.length, 0,
            `a notice is shown without any source trouble: ${textOf('downloads-source-notice')}`);
    });

    // Drive a YouTube search through the form handler with no Soulseek account.
    el('downloads-search-input').value = 'daft punk';
    (el('downloads-search-form').listeners.submit || []).forEach(fn => fn({ preventDefault() {} }));
    await new Promise(r => setTimeout(r, 40));

    check('YouTube search works without Soulseek setup', () => {
        const searches = fetchCalls.filter(c => c.url.endsWith('/api/downloads/search'));
        assert.strictEqual(searches.length, 1, 'the YouTube search did not reach the server');
        assert.deepStrictEqual(searches[0].body.sources, ['youtube']);
        assert.ok(!context.toasts.some(entry => /Set up Soulseek/i.test(entry.m)), 'a setup toast blocked the search');
    });

    check('YouTube results are rendered with artwork', () => {
        const panel = el('downloads-panel-results');
        assert.ok(panel.children.length > 0, 'no results rendered');
        assert.ok(panel.textContent.includes('song'), `missing the title: ${panel.textContent}`);
        const images = [];
        const walk = node => {
            if (node.tagName === 'IMG') images.push(node);
            (node.children || []).forEach(walk);
        };
        panel.children.forEach(walk);
        assert.ok(images.length > 0, 'no result thumbnails rendered');
        assert.ok(images[0].src.includes('i.ytimg.com'), `thumbnail URL is wrong: ${images[0].src}`);
    });

    // A YouTube item in the connecting stage must not claim a "peer".
    queueItems = [{ id: 99, title: 'x', status: 'running', stage: 'connecting', resolvedSource: 'youtube' }];
    await context.window.StreamifyDownloads.refresh();
    check('queue stage labels follow the resolved source', () => {
        const text = el('downloads-queue-list').textContent;
        assert.ok(!text.includes('Connecting to peer'), 'a YouTube download claims a Soulseek peer');
        assert.ok(text.includes('Starting download'), 'missing the YouTube connecting label');
    });
    queueItems = [];
    await context.window.StreamifyDownloads.refresh();

    /* --- Switching to Soulseek without setup surfaces the notice ---- */
    el('downloads-source-soulseek').click();
    check('the Soulseek notice appears only once its tab is selected', () => {
        const notice = el('downloads-source-notice');
        assert.ok(notice.textContent.includes('Soulseek is not set up'), 'missing the setup prompt');
        const button = notice.children[0].children.find(c => c.classList.contains('btn'));
        assert.ok(button, 'the notice should use the app-standard .btn');
        assert.strictEqual(button.textContent, 'Add account');
    });

    check('Soulseek notice animates only on the first Get Music visit', () => {
        const card = el('downloads-source-notice').children[0];
        assert.ok(card.classList.contains('downloads-notice--enter'), 'the first notice has no entrance animation');
    });

    await context.window.StreamifyDownloads.refresh();
    check('Soulseek notice does not animate again after refresh', () => {
        const card = el('downloads-source-notice').children[0];
        assert.ok(!card.classList.contains('downloads-notice--enter'), 'the entrance animation replayed');
    });

    (el('downloads-search-form').listeners.submit || []).forEach(fn => fn({ preventDefault() {} }));
    await new Promise(r => setTimeout(r, 40));

    check('Soulseek search is blocked while unconfigured', () => {
        const searches = fetchCalls.filter(c => c.url.endsWith('/api/downloads/search'));
        assert.strictEqual(searches.length, 1, 'an unavailable Soulseek search reached the server');
        assert.ok(context.toasts.some(entry => /Set up Soulseek/i.test(entry.m)), 'missing setup toast');
    });

    check('results panel is empty after switching to an unusable source', () => {
        assert.strictEqual(el('downloads-panel-results').children.length, 0, 'the results panel has content');
    });

    /* --- Back to YouTube, configured Soulseek stays silent ---------- */
    soulseekState = { configured: true, username: 'me', connected: true, error: null };
    el('downloads-source-youtube').click();
    await context.window.StreamifyDownloads.refresh();
    await new Promise(r => setTimeout(r, 20));

    check('the notice disappears when back on YouTube with a working Soulseek', () => {
        assert.strictEqual(el('downloads-source-notice').children.length, 0,
            `a notice is still shown: ${textOf('downloads-source-notice')}`);
    });

    el('downloads-search-input').value = 'daft punk';
    (el('downloads-search-form').listeners.submit || []).forEach(fn => fn({ preventDefault() {} }));
    await new Promise(r => setTimeout(r, 40));

    check('search requests the selected source only', () => {
        const search = fetchCalls.filter(c => c.url.endsWith('/api/downloads/search')).pop();
        assert.ok(search, 'no search request was made');
        assert.deepStrictEqual(search.body.sources, ['youtube']);
    });

    /* --- Confirmation before download ------------------------------- */
    const enqueuesBefore = fetchCalls.filter(c => c.url.endsWith('/api/downloads/enqueue')).length;
    const firstGroup = el('downloads-panel-results').children[0];
    const rowList = firstGroup && firstGroup.children[1] ? firstGroup.children[1] : firstGroup;
    const row = rowList.children[0];
    const button = row.children[row.children.length - 1];
    button.click();
    await new Promise(r => setTimeout(r, 20));

    check('clicking Download opens a confirmation instead of queueing', () => {
        assert.ok(!el('downloads-confirm-modal').classList.contains('hidden'),
            'the confirmation dialog did not open');
        const after = fetchCalls.filter(c => c.url.endsWith('/api/downloads/enqueue')).length;
        assert.strictEqual(after, enqueuesBefore, 'the track was queued without asking');
    });

    check('the dialog previews the track', () => {
        const summary = el('downloads-confirm-single').textContent;
        assert.ok(summary.includes('song'), `missing the title: ${summary}`);
        assert.ok(summary.includes('From YouTube'), `missing the source label: ${summary}`);
        assert.ok(summary.includes('MP3'), `missing the format tag: ${summary}`);
    });

    check('cancelling queues nothing and restores the button', () => {
        el('downloads-confirm-cancel').click();
        assert.ok(el('downloads-confirm-modal').classList.contains('hidden'), 'the dialog stayed open');
        const after = fetchCalls.filter(c => c.url.endsWith('/api/downloads/enqueue')).length;
        assert.strictEqual(after, enqueuesBefore, 'cancelling still queued the track');
        assert.strictEqual(button.disabled, false, 'the Download button stayed disabled');
        assert.ok(button.textContent.includes('Download'), `button text is "${button.textContent}"`);
    });

    await (async () => {
        button.click();
        await new Promise(r => setTimeout(r, 10));
        el('downloads-confirm-accept').click();
        await new Promise(r => setTimeout(r, 40));
    })();

    check('confirming queues exactly one track', () => {
        const enqueues = fetchCalls.filter(c => c.url.endsWith('/api/downloads/enqueue'));
        assert.strictEqual(enqueues.length, enqueuesBefore + 1, 'expected exactly one enqueue');
        assert.strictEqual(enqueues[enqueues.length - 1].body.items.length, 1);
        assert.strictEqual(enqueues[enqueues.length - 1].body.items[0].requestedSource, 'youtube');
        assert.strictEqual(enqueues[enqueues.length - 1].body.items[0].sourceUrl,
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    });

    /*
     * The cooldown notice is the only YouTube notice that exists, and it must
     * appear for every source selection: when YouTube is paused the downloads
     * silently come from elsewhere, which without a notice reads as a bug.
     */
    await (async () => {
        youtubeState = {
            blocked: true,
            retryAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
            reason: 'Sign in to confirm you are not a bot'
        };
        await context.window.StreamifyDownloads.refresh();
    })();

    check('a YouTube cooldown is surfaced while YouTube is selected', () => {
        const text = textOf('downloads-source-notice');
        assert.ok(/YouTube is paused/i.test(text), `no cooldown notice rendered: ${text}`);
        assert.ok(/Soulseek only/i.test(text), `the notice does not explain the fallback: ${text}`);
    });

    await (async () => {
        youtubeState = null;
        await context.window.StreamifyDownloads.refresh();
    })();

    check('the cooldown notice clears once YouTube recovers', () => {
        const text = textOf('downloads-source-notice');
        assert.ok(!/YouTube is paused/i.test(text), `the cooldown notice outlived the block: ${text}`);
    });

    /*
     * Album imports must be selectable. The old dialog rendered a read-only
     * list, so an album you already partly owned arrived in full a second time
     * with " (2)" suffixes — there was no way to skip a track.
     */
    const enqueuesBeforeImport = () => fetchCalls.filter(c => c.url.endsWith('/api/downloads/enqueue')).length;

    await (async () => {
        el('downloads-search-input').value = 'https://open.spotify.com/album/testalbum';
        (el('downloads-search-form').listeners.submit || []).forEach(fn => fn({ preventDefault() {} }));
        await new Promise(r => setTimeout(r, 40));
    })();

    check('an album import lists its tracks with checkboxes', () => {
        const boxes = el('downloads-confirm-list').querySelectorAll('input[type="checkbox"][data-index]');
        assert.strictEqual(boxes.length, 3, `expected 3 track checkboxes, found ${boxes.length}`);
    });

    check('tracks already in the library start unticked', () => {
        const boxes = el('downloads-confirm-list').querySelectorAll('input[type="checkbox"][data-index]');
        const byIndex = id => boxes.find(box => box.dataset.index === String(id));
        assert.strictEqual(byIndex(0).checked, true, 'an unowned track was unticked');
        assert.strictEqual(byIndex(1).checked, false, 'an owned track was pre-ticked');
        assert.strictEqual(byIndex(2).checked, true, 'an unowned track was unticked');

        const text = el('downloads-confirm-list').textContent;
        assert.ok(/In library/i.test(text), 'the owned track is not labelled');
        assert.ok(/1 track is already in your library/i.test(text), `missing the owned-count hint: ${text}`);
    });

    check('the accept button counts only the ticked tracks', () => {
        const label = el('downloads-confirm-accept').textContent;
        assert.ok(/Download 2/i.test(label), `the button should offer 2 tracks, got "${label}"`);
    });

    check('a quality preference is offered for imports', () => {
        const quality = el('downloads-confirm-quality');
        assert.ok(!quality.classList.contains('hidden'), 'the quality picker is hidden for an import');
        const options = el('downloads-confirm-quality-options').querySelectorAll('.resolve-quality-option');
        assert.strictEqual(options.length, 2, `expected 2 quality options, got ${options.length}`);
    });

    await (async () => {
        // Prefer lossless, then accept.
        const options = el('downloads-confirm-quality-options').querySelectorAll('.resolve-quality-option');
        const lossless = options.find(option => option.dataset.value === 'lossless');
        lossless.click();
        el('downloads-confirm-accept').click();
        await new Promise(r => setTimeout(r, 40));
    })();

    check('only the ticked tracks are queued, carrying the chosen quality', () => {
        const enqueues = fetchCalls.filter(c => c.url.endsWith('/api/downloads/enqueue'));
        assert.strictEqual(enqueues.length, enqueuesBeforeImport() , 'expected exactly one enqueue');
        const items = enqueues[enqueues.length - 1].body.items;
        assert.strictEqual(items.length, 2, `expected 2 items queued, got ${items.length}`);
        const titles = items.map(item => item.title);
        assert.ok(!titles.includes('Owned Track'), 'the already-owned track was queued anyway');
        assert.deepStrictEqual(titles, ['First Track', 'Third Track']);
        assert.ok(items.every(item => item.quality === 'lossless'),
            `the chosen quality was not applied: ${JSON.stringify(items.map(i => i.quality))}`);
    });

    console.log(failures === 0 ? '\nGet Music UI checks passed.\n' : `\n${failures} UI check(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
})();

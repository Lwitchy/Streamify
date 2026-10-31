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
    }
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
    querySelector() { return null; }
    querySelectorAll() { return []; }
    get offsetWidth() { return 0; }
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
            return jsonResponse({ success: true, items: queueItems, downloadFolder: 'C:/Music/Streamify Downloads', soulseek: soulseekState });
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

    console.log(failures === 0 ? '\nGet Music UI checks passed.\n' : `\n${failures} UI check(s) failed.\n`);
    process.exit(failures === 0 ? 0 : 1);
})();

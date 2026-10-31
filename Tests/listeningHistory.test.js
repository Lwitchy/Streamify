const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ListeningHistory = require('../Server/listeningHistory');

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const baseReport = (overrides = {}) => ({
    play_id: '3f1c2a9e-1b2c-4d5e-8f90-123456789abc',
    song_id: 42,
    ms_played: 15000,
    duration_ms: 200000,
    started_at: NOW - 16000,
    source_type: 'playlist',
    source_id: '7',
    device: 'desktop',
    ended: false,
    ...overrides
});

/* --- Server rules -------------------------------------------------------- */

test('a valid heartbeat normalizes cleanly', () => {
    const { value, error } = ListeningHistory.normalizePlaybackReport(baseReport(), NOW);
    assert.equal(error, undefined);
    assert.equal(value.songId, 42);
    assert.equal(value.sourceType, 'playlist');
    assert.equal(value.sourceId, '7');
    assert.equal(value.ended, false);
    assert.equal(value.endReason, null);
});

test('malformed identifiers are rejected', () => {
    assert.ok(ListeningHistory.normalizePlaybackReport(baseReport({ play_id: 'x' }), NOW).error);
    assert.ok(ListeningHistory.normalizePlaybackReport(baseReport({ play_id: '../../etc' }), NOW).error);
    assert.ok(ListeningHistory.normalizePlaybackReport(baseReport({ song_id: 'abc' }), NOW).error);
    assert.ok(ListeningHistory.normalizePlaybackReport(baseReport({ ms_played: -1 }), NOW).error);
});

test('unknown enum values fall back instead of failing', () => {
    const { value } = ListeningHistory.normalizePlaybackReport(baseReport({
        source_type: 'radio', device: 'toaster', ended: true, end_reason: 'bored', source_id: 'drop table;'
    }), NOW);
    assert.equal(value.sourceType, 'unknown');
    assert.equal(value.device, 'web');
    assert.equal(value.endReason, 'closed');
    assert.equal(value.sourceId, null);
});

test('future start times are pulled to now; very old reports are dropped', () => {
    const future = ListeningHistory.normalizePlaybackReport(baseReport({ started_at: NOW + 3600000 }), NOW);
    assert.equal(future.value.startedAt, NOW);
    const old = ListeningHistory.normalizePlaybackReport(
        baseReport({ started_at: NOW - ListeningHistory.MAX_REPORT_AGE_MS - 1 }), NOW);
    assert.ok(old.error);
});

test('first report cannot claim more than the time since the play started', () => {
    const { value } = ListeningHistory.normalizePlaybackReport(baseReport({ ms_played: 3600000, started_at: NOW - 10000 }), NOW);
    assert.equal(ListeningHistory.resolveMsPlayed(null, value, NOW), 10000 + ListeningHistory.PROGRESS_SLACK_MS);
});

test('progress never goes backwards and growth is bounded by wall time', () => {
    const existing = { ms_played: 30000, updated_at: new Date(NOW - 15000).toISOString() };
    const stale = ListeningHistory.normalizePlaybackReport(baseReport({ ms_played: 10000 }), NOW).value;
    assert.equal(ListeningHistory.resolveMsPlayed(existing, stale, NOW), 30000);

    const inflated = ListeningHistory.normalizePlaybackReport(baseReport({ ms_played: 900000 }), NOW).value;
    assert.equal(ListeningHistory.resolveMsPlayed(existing, inflated, NOW), 30000 + 15000 + ListeningHistory.PROGRESS_SLACK_MS);

    const normal = ListeningHistory.normalizePlaybackReport(baseReport({ ms_played: 45000 }), NOW).value;
    assert.equal(ListeningHistory.resolveMsPlayed(existing, normal, NOW), 45000);
});

test('a play counts at 30 seconds, or half of a short track', () => {
    assert.equal(ListeningHistory.isCountedPlay(29999, 200000), false);
    assert.equal(ListeningHistory.isCountedPlay(30000, 200000), true);
    assert.equal(ListeningHistory.isCountedPlay(20000, 40000), true);
    assert.equal(ListeningHistory.isCountedPlay(19999, 40000), false);
    assert.equal(ListeningHistory.isCountedPlay(30000, null), true);
});

/* --- Client tracker ------------------------------------------------------ */

function createClient({ online = true, user = { username: 'alice', allow_analytics: true } } = {}) {
    const storage = new Map();
    const requests = [];
    const listeners = new Map();
    let respond = () => ({ ok: true, status: 200 });
    const window = {
        API_BASE_URL: '',
        crypto: { randomUUID: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() },
        addEventListener(type, handler) { listeners.set(type, handler); },
        StreamifyEnv: { isDesktop: true }
    };
    const context = {
        window,
        navigator: { onLine: online, userAgent: 'test' },
        localStorage: {
            getItem: key => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: key => storage.delete(key)
        },
        appCache: { user },
        fetch: async (url, options) => {
            requests.push({ url, body: JSON.parse(options.body), keepalive: options.keepalive });
            return respond();
        },
        setTimeout: () => 0,
        Uint8Array,
        JSON,
        Date,
        Number,
        Math,
        Array,
        Boolean,
        String
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../Static/home/js/telemetry.js'), 'utf8'), context);
    return {
        api: window.StreamifyListening,
        requests,
        storage,
        listeners,
        navigator: context.navigator,
        setResponse: fn => { respond = fn; }
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const finals = requests => requests.filter(r => r.body.ended);

test('heartbeats are sent every 15 seconds of listening with cumulative time', async () => {
    const client = createClient();
    client.api.start(42, { type: 'playlist', id: 7 });
    client.api.setDuration(200);
    for (let i = 0; i < 31; i++) client.api.addPlayed(1);
    await settle();
    const beats = client.requests.filter(r => !r.body.ended);
    assert.deepEqual(beats.map(r => r.body.ms_played), [15000, 30000]);
    assert.equal(beats[0].body.source_type, 'playlist');
    assert.equal(beats[0].body.source_id, '7');
    assert.equal(beats[0].body.device, 'desktop');
    assert.equal(beats[0].body.duration_ms, 200000);
});

test('starting a new song ends the previous one with the given reason', async () => {
    const client = createClient();
    client.api.start(1, { type: 'library' });
    client.api.addPlayed(5);
    client.api.start(2, { type: 'library' }, 'next');
    await settle();
    const [final] = finals(client.requests);
    assert.equal(final.body.song_id, 1);
    assert.equal(final.body.end_reason, 'next');
    assert.equal(final.body.ms_played, 5000);
    assert.equal(final.keepalive, true);
});

test('playbacks under a second are not reported', async () => {
    const client = createClient();
    client.api.start(1, { type: 'library' });
    client.api.addPlayed(0.4);
    client.api.end('next');
    await settle();
    assert.equal(client.requests.length, 0);
});

test('final reports made offline wait in the outbox and are delivered later', async () => {
    const client = createClient({ online: false });
    client.api.start(9, { type: 'offline' });
    client.api.addPlayed(40);
    client.api.end('completed');
    await settle();
    assert.equal(client.requests.length, 0);
    assert.equal(JSON.parse(client.storage.get('streamify:listening-outbox:v1')).length, 1);

    client.navigator.onLine = true;
    await client.api.flushOutbox();
    assert.equal(finals(client.requests).length, 1);
    assert.equal(client.storage.has('streamify:listening-outbox:v1'), false);
});

test('a failed final report stays queued for retry', async () => {
    const client = createClient();
    client.setResponse(() => ({ ok: false, status: 503 }));
    client.api.start(9, { type: 'library' });
    client.api.addPlayed(3);
    client.api.end('completed');
    await settle();
    assert.equal(JSON.parse(client.storage.get('streamify:listening-outbox:v1')).length, 1);
});

test('repeat-one starts a fresh playback of the same song', async () => {
    const client = createClient();
    client.api.start(5, { type: 'album', id: 'a1' });
    client.api.setDuration(120);
    client.api.addPlayed(10);
    client.api.restart('completed');
    client.api.addPlayed(10);
    client.api.end('closed');
    await settle();
    const ended = finals(client.requests);
    assert.equal(ended.length, 2);
    assert.notEqual(ended[0].body.play_id, ended[1].body.play_id);
    assert.equal(ended[1].body.song_id, 5);
    assert.equal(ended[1].body.source_type, 'album');
    assert.equal(ended[1].body.duration_ms, 120000);
});

test('nothing is sent when the user has opted out of analytics', async () => {
    const client = createClient({ user: { username: 'alice', allow_analytics: false } });
    client.api.start(1, { type: 'library' });
    client.api.addPlayed(40);
    client.api.end('completed');
    await settle();
    assert.equal(client.requests.length, 0);
});

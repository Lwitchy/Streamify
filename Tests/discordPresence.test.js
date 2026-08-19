/**
 * Discord Rich Presence protocol tests.
 *
 * electron/discord-presence.js speaks Discord's RPC wire format by hand, so
 * nothing else in the stack would catch a framing, coalescing or teardown
 * regression. These tests stand up a mock Discord IPC server and drive the
 * real client against it.
 *
 * The client normally probes discord-ipc-0..9, which on a developer machine
 * finds the actual Discord client. Tests pass an explicit `socketPath` so they
 * never touch it, and never publish a presence to anyone's real profile.
 *
 * Run: npm run test:discord
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { DiscordPresence, _test } = require('../electron/discord-presence.js');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Windows needs a named pipe; everywhere else a unix socket in tmp works. */
function testSocketPath() {
    const id = crypto.randomBytes(6).toString('hex');
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\streamify-rpc-test-${id}`
        : path.join(os.tmpdir(), `streamify-rpc-test-${id}`);
}

function encodeFrame(opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.allocUnsafe(8 + body.length);
    frame.writeInt32LE(opcode, 0);
    frame.writeInt32LE(body.length, 4);
    body.copy(frame, 8);
    return frame;
}

/**
 * A mock Discord. Answers the handshake with READY and records every frame.
 */
function startMockDiscord() {
    const socketPath = testSocketPath();
    const frames = [];

    const server = net.createServer(socket => {
        let buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 8) {
                const opcode = buffer.readInt32LE(0);
                const length = buffer.readInt32LE(4);
                if (buffer.length < 8 + length) break;

                const payload = length ? JSON.parse(buffer.subarray(8, 8 + length).toString('utf8')) : null;
                buffer = buffer.subarray(8 + length);
                frames.push({ opcode, payload });

                if (opcode === OP_HANDSHAKE) {
                    socket.write(encodeFrame(OP_FRAME, {
                        cmd: 'DISPATCH',
                        evt: 'READY',
                        data: { user: { username: 'tester', global_name: 'Tester' } }
                    }));
                }
            }
        });
        socket.on('error', () => { /* the client tears down mid-test by design */ });
    });

    return new Promise(resolve => {
        server.listen(socketPath, () => resolve({
            socketPath,
            frames,
            activities: () => frames.filter(f => f.opcode === OP_FRAME),
            close: () => new Promise(done => server.close(done))
        }));
    });
}

/** Connects a client and waits for READY. */
async function connectedClient(mock, overrides = {}) {
    const presence = new DiscordPresence({
        clientId: '1538257130539323513',
        socketPath: mock.socketPath,
        log: () => {},
        ...overrides
    });
    presence.enable();

    for (let i = 0; i < 60 && !presence.status().connected; i++) await sleep(50);
    return presence;
}

/* ------------------------------------------------------------------ *
 * Payload construction
 * ------------------------------------------------------------------ */

test('activity uses type 2 so Discord renders "Listening to"', () => {
    const activity = _test.buildActivity({ details: 'Song', state: 'Artist' });
    assert.strictEqual(activity.type, 2);
});

test('an activity with no text at all is dropped rather than sent empty', () => {
    assert.strictEqual(_test.buildActivity({}), null);
    assert.strictEqual(_test.buildActivity(null), null);
    assert.strictEqual(_test.buildActivity({ largeImage: 'streamify' }), null);
});

test('text is clamped to 128 characters', () => {
    const activity = _test.buildActivity({ details: 'x'.repeat(400), state: 'Artist' });
    assert.strictEqual(activity.details.length, 128);
});

test('single-character text is padded, because Discord rejects it', () => {
    // A track literally named "4" is not hypothetical.
    const activity = _test.buildActivity({ details: '4', state: 'Artist' });
    assert.ok(activity.details.length >= 2, 'details must reach Discord\'s 2-character minimum');
    assert.ok(activity.details.startsWith('4'));
});

test('both timestamps produce a progress bar; a lone start is still allowed', () => {
    const start = Date.now();
    const withBoth = _test.buildActivity({ details: 'S', state: 'A', startTimestamp: start, endTimestamp: start + 1000 });
    assert.deepStrictEqual(withBoth.timestamps, { start, end: start + 1000 });

    const startOnly = _test.buildActivity({ details: 'S', state: 'A', startTimestamp: start });
    assert.deepStrictEqual(startOnly.timestamps, { start });
});

test('an end before the start is discarded instead of producing a broken bar', () => {
    const start = Date.now();
    const activity = _test.buildActivity({ details: 'S', state: 'A', startTimestamp: start, endTimestamp: start - 5000 });
    assert.deepStrictEqual(activity.timestamps, { start });
});

/* ------------------------------------------------------------------ *
 * Image validation - the renderer supplies these across an IPC boundary
 * ------------------------------------------------------------------ */

test('only https image URLs and bare asset keys survive validation', () => {
    assert.strictEqual(_test.clampImage('https://is1-ssl.mzstatic.com/a/600x600bb.jpg'),
        'https://is1-ssl.mzstatic.com/a/600x600bb.jpg');
    assert.strictEqual(_test.clampImage('streamify'), 'streamify');

    assert.strictEqual(_test.clampImage('http://example.com/a.jpg'), null, 'http must be rejected');
    assert.strictEqual(_test.clampImage('https://user:pw@example.com/a.jpg'), null, 'credentials must be rejected');
    assert.strictEqual(_test.clampImage('file:///etc/passwd'), null);
    assert.strictEqual(_test.clampImage('javascript:alert(1)'), null);
    assert.strictEqual(_test.clampImage(''), null);
    assert.strictEqual(_test.clampImage({}), null);
    assert.strictEqual(_test.clampImage('https://x.com/' + 'a'.repeat(4000)), null, 'oversized URL must be rejected');
});

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

test('frames are little-endian opcode + length + JSON', () => {
    const frame = _test.encodeFrame(OP_HANDSHAKE, { v: 1 });
    assert.strictEqual(frame.readInt32LE(0), OP_HANDSHAKE);
    assert.strictEqual(frame.readInt32LE(4), frame.length - 8);
    assert.deepStrictEqual(JSON.parse(frame.subarray(8).toString('utf8')), { v: 1 });
});

test('the reader reassembles frames split across chunks', () => {
    const seen = [];
    const read = _test.createFrameReader((op, payload) => seen.push({ op, payload }), () => {
        assert.fail('a valid split frame must not raise a protocol error');
    });

    const frame = _test.encodeFrame(OP_FRAME, { cmd: 'X' });
    // Deliver one byte at a time - the pathological case for a naive reader.
    for (const byte of frame) read(Buffer.from([byte]));

    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0], { op: OP_FRAME, payload: { cmd: 'X' } });
});

test('the reader splits multiple frames delivered in one chunk', () => {
    const seen = [];
    const read = _test.createFrameReader((op, payload) => seen.push(payload.cmd), () => {});
    read(Buffer.concat([
        _test.encodeFrame(OP_FRAME, { cmd: 'A' }),
        _test.encodeFrame(OP_FRAME, { cmd: 'B' }),
        _test.encodeFrame(OP_FRAME, { cmd: 'C' })
    ]));
    assert.deepStrictEqual(seen, ['A', 'B', 'C']);
});

test('an implausible frame length is reported instead of allocated', () => {
    let error = null;
    const read = _test.createFrameReader(() => assert.fail('must not emit a frame'), e => { error = e; });

    const header = Buffer.allocUnsafe(8);
    header.writeInt32LE(OP_FRAME, 0);
    header.writeInt32LE(500 * 1024 * 1024, 4);
    read(header);

    assert.ok(error, 'an oversized length must raise a protocol error');
});

/* ------------------------------------------------------------------ *
 * Live protocol against a mock Discord
 * ------------------------------------------------------------------ */

test('handshake announces v1 and the client id, and READY reports the user', async () => {
    const mock = await startMockDiscord();
    const presence = await connectedClient(mock);
    try {
        assert.strictEqual(mock.frames[0].opcode, OP_HANDSHAKE);
        assert.deepStrictEqual(mock.frames[0].payload, { v: 1, client_id: '1538257130539323513' });

        const status = presence.status();
        assert.strictEqual(status.connected, true);
        assert.strictEqual(status.user, 'Tester');
        assert.strictEqual(status.error, null);
    } finally {
        presence.destroy();
        await mock.close();
    }
});

test('rapid updates are coalesced to a single trailing frame with the newest state', async () => {
    const mock = await startMockDiscord();
    const presence = await connectedClient(mock);
    try {
        presence.setActivity({ details: 'First', state: 'Artist' });
        await sleep(200);
        assert.strictEqual(mock.activities().length, 1, 'the first update goes out immediately');

        presence.setActivity({ details: 'Track A', state: 'Artist' });
        presence.setActivity({ details: 'Track B', state: 'Artist' });
        presence.setActivity({ details: 'Track C', state: 'Artist' });
        await sleep(200);
        assert.strictEqual(mock.activities().length, 1, 'a burst must not exceed the rate limit');

        await sleep(4500);
        const activities = mock.activities();
        assert.strictEqual(activities.length, 2, 'the burst collapses into exactly one trailing frame');
        assert.strictEqual(activities[1].payload.args.activity.details, 'Track C',
            'intermediate states are discarded, not queued');
    } finally {
        presence.destroy();
        await mock.close();
    }
});

test('disable() clears immediately instead of waiting out the rate limit', async () => {
    // Regression guard: the clear used to be queued behind the 4s interval
    // while teardown ran after 250ms, so the frame was never delivered and the
    // card lingered on the user's profile.
    const mock = await startMockDiscord();
    const presence = await connectedClient(mock);
    try {
        presence.setActivity({ details: 'Something', state: 'Artist' });
        await sleep(200);
        const before = mock.activities().length;

        presence.disable();
        await sleep(200);

        const activities = mock.activities();
        assert.strictEqual(activities.length, before + 1, 'the clear must bypass the rate limiter');

        const last = activities[activities.length - 1].payload;
        assert.strictEqual(last.cmd, 'SET_ACTIVITY');
        assert.ok(!('activity' in last.args),
            'clearing omits the activity key entirely; sending null is not equivalent');
    } finally {
        presence.destroy();
        await mock.close();
    }
});

test('a clear is sent on destroy so quitting removes the card at once', async () => {
    const mock = await startMockDiscord();
    const presence = await connectedClient(mock);
    try {
        presence.setActivity({ details: 'Something', state: 'Artist' });
        await sleep(200);
        const before = mock.activities().length;

        presence.destroy();
        await sleep(200);

        const activities = mock.activities();
        assert.strictEqual(activities.length, before + 1);
        assert.ok(!('activity' in activities[activities.length - 1].payload.args));
    } finally {
        await mock.close();
    }
});

test('Discord being unreachable is a silent no-op, not a failure', async () => {
    const presence = new DiscordPresence({
        clientId: 'x',
        socketPath: testSocketPath(), // nothing is listening
        log: () => {}
    });

    presence.enable();
    presence.setActivity({ details: 'Song', state: 'Artist' });
    await sleep(2500);

    const status = presence.status();
    assert.strictEqual(status.connected, false);
    assert.strictEqual(status.enabled, true, 'it stays enabled and keeps retrying');
    assert.ok(status.error, 'the reason is surfaced for the settings pane');

    presence.destroy();
});

test('a missing client id keeps the client inert', () => {
    const presence = new DiscordPresence({ clientId: '', log: () => {} });
    presence.enable();

    const status = presence.status();
    assert.strictEqual(status.configured, false);
    assert.strictEqual(status.enabled, false, 'enable() must not arm a client that cannot connect');

    presence.destroy();
});

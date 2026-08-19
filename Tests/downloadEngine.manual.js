/**
 * Manual end-to-end check for the Soulseek download engine.
 *
 * Requires SLSK_USER and SLSK_PASS. It performs a real peer search and transfer,
 * so it is intentionally excluded from the regular test suite.
 *
 *     node Tests/downloadEngine.manual.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

if (!process.env.SLSK_USER || !process.env.SLSK_PASS) {
    console.error('Set SLSK_USER and SLSK_PASS before running this manual test.');
    process.exit(2);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'streamify-dl-'));
process.env.STREAMIFY_DATA_DIR = sandbox;
process.env.STREAMIFY_CONFIG = path.join(sandbox, 'config.json');
process.env.STREAMIFY_DISABLE_HTTPS = '1';
process.env.PORT = '4531';

const musicDir = path.join(sandbox, 'Music');
fs.mkdirSync(musicDir, { recursive: true });
fs.writeFileSync(process.env.STREAMIFY_CONFIG, JSON.stringify({
    music_directories: [musicDir],
    music_library_owner: 'test'
}, null, 4));

const Downloads = require('../Server/downloads');
const TEST_QUERY = process.env.STREAMIFY_TEST_QUERY || 'test music mp3';
const step = message => console.log(`\n=== ${message}`);

(async () => {
    step('Booting the server');
    const server = require('../Server/server');
    await server.start();

    try {
        const root = Downloads.resolveDownloadRoot();
        assert.strictEqual(root, path.join(musicDir, 'Streamify Downloads'));

        step('Confirming YouTube acquisition is rejected');
        await assert.rejects(
            Downloads.enqueue([{
                requestedSource: 'youtube',
                title: 'legacy request',
                sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk'
            }], 'test'),
            /Unknown download source/
        );

        step(`Searching Soulseek for "${TEST_QUERY}"`);
        const results = await Downloads.search(TEST_QUERY, { sources: ['soulseek'], limit: 10 });
        assert.ok(results.soulseek.available, `Soulseek unavailable: ${results.soulseek.error}`);
        assert.ok(results.soulseek.results.length > 0, 'Soulseek returned no downloadable files');
        const pick = results.soulseek.results.find(item => item.slots) || results.soulseek.results[0];
        console.log(`    picking ${pick.title} from ${pick.user}`);

        const track = {
            requestedSource: 'soulseek',
            title: pick.title,
            searchQuery: TEST_QUERY,
            sourcePayload: pick.payload
        };
        const enqueued = await Downloads.enqueue([track], 'test');
        assert.strictEqual(enqueued.queued, 1);
        const itemId = enqueued.items[0].id;

        const duplicate = await Downloads.enqueue([track], 'test');
        assert.strictEqual(duplicate.queued, 0, 'Duplicate protection failed');

        step('Waiting for the transfer (up to four minutes)');
        const deadline = Date.now() + 240000;
        let finished = null;
        while (Date.now() < deadline) {
            const { items } = await Downloads.getQueue();
            const item = items.find(entry => entry.id === itemId);
            if (item && ['completed', 'failed', 'cancelled'].includes(item.status)) {
                finished = item;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        assert.ok(finished, 'The download timed out');
        assert.strictEqual(finished.status, 'completed', `Download failed: ${finished.error}`);
        assert.strictEqual(finished.resolvedSource, 'soulseek');
        assert.ok(finished.songId, 'The library scanner did not create a song row');

        const files = fs.readdirSync(root).map(name => path.join(root, name));
        assert.strictEqual(files.length, 1, `Expected one file, found ${files.length}`);
        assert.ok(fs.statSync(files[0]).size > 100 * 1024, 'Downloaded file is suspiciously small');
        console.log(`    saved ${path.basename(files[0])}`);
        console.log('\nAll Soulseek download checks passed.\n');
    } finally {
        await server.gracefulShutdown({ exit: false }).catch(() => {});
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
    }
})().catch(error => {
    console.error('\nFAILED:', error && error.message);
    process.exitCode = 1;
});

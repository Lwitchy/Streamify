'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Downloads = require('../Server/downloads');

test('the download engine exposes YouTube URL handling', () => {
    assert.equal(typeof Downloads.isYoutubeUrl, 'function');
    assert.equal(Downloads.isYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(Downloads.isYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1'), true);
    assert.equal(Downloads.isYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
    assert.equal(Downloads.isYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), true);
    assert.equal(Downloads.isYoutubeUrl('https://example.com/other'), false);
});

test('canonicalizes YouTube URLs and extracts video IDs', () => {
    assert.equal(Downloads.extractYoutubeVideoId('https://www.youtube.com/watch?v=oiKj0Z_Xnjc&list=RDoiKj0Z_Xnjc'), 'oiKj0Z_Xnjc');
    assert.equal(Downloads.extractYoutubeVideoId('https://youtu.be/oiKj0Z_Xnjc?t=10'), 'oiKj0Z_Xnjc');
    assert.equal(Downloads.canonicalYoutubeUrl('https://www.youtube.com/watch?v=oiKj0Z_Xnjc&list=RDoiKj0Z_Xnjc'), 'https://www.youtube.com/watch?v=oiKj0Z_Xnjc');
});

test('cleans and splits YouTube titles cleanly', () => {
    assert.deepEqual(
        Downloads.splitYoutubeTitle('Stromae - papaoutai (Official Video)', 'StromaeVEVO'),
        { artist: 'Stromae', title: 'papaoutai' }
    );
    assert.deepEqual(
        Downloads.splitYoutubeTitle('Never Gonna Give You Up [4K Remaster]', 'Rick Astley - Topic'),
        { artist: 'Rick Astley', title: 'Never Gonna Give You Up' }
    );
});

test('invalid download sources are rejected', async () => {
    Downloads.init({ getActiveDirectories: () => ['C:\\fake'] });
    await assert.rejects(
        Downloads.enqueue([{
            requestedSource: 'unknown_source',
            title: 'Blocked request',
            sourceUrl: 'https://example.com/song.mp3'
        }], 'test'),
        /Unknown download source "unknown_source"/
    );
});

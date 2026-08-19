'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Downloads = require('../Server/downloads');

test('YouTube cannot be queued as an acquisition source', async () => {
    await assert.rejects(
        Downloads.enqueue([{
            requestedSource: 'youtube',
            title: 'Blocked request',
            sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk'
        }], 'test'),
        /Unknown download source "youtube"/
    );
});

test('YouTube links are not resolved by Get Music', async () => {
    await assert.rejects(
        Downloads.resolveLink('https://www.youtube.com/watch?v=abcdefghijk'),
        /Paste a Spotify link/
    );
});

test('the download engine no longer exposes YouTube URL handling', () => {
    assert.equal(Downloads.isYoutubeUrl, undefined);
});

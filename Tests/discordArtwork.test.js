'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Artwork = require('../Server/discordArtwork');

const song = {
    songname: 'Midnight Drive (Nova Remix)',
    artist: 'Glass City',
    duration: 213
};

function candidate(overrides = {}) {
    return {
        id: 'abcdefghijk',
        title: 'Glass City - Midnight Drive (Nova Remix) [Official Audio]',
        uploader: 'Glass City',
        duration: 214,
        thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
        ...overrides
    };
}

test('Discord artwork accepts an exact title, version, artist and duration match', () => {
    const match = Artwork._test.scoreCandidate(song, candidate());
    assert.ok(match);
    assert.equal(match.videoId, 'abcdefghijk');
    assert.equal(match.durationDelta, 1);
    assert.ok(match.score >= 0.84);
});

test('Discord artwork rejects a conflicting version identity', () => {
    const match = Artwork._test.scoreCandidate(song, candidate({
        title: 'Glass City - Midnight Drive (Live)',
        duration: 213
    }));
    assert.equal(match, null);
});

test('Discord artwork rejects a materially different duration', () => {
    const match = Artwork._test.scoreCandidate(song, candidate({ duration: 245 }));
    assert.equal(match, null);
});

test('Discord artwork recovers artist and title from an imported filename-style title', () => {
    const match = Artwork._test.scoreCandidate({
        songname: 'Glass City - Midnight Drive (Nova Remix)',
        artist: 'Unknown Artist',
        duration: 213
    }, candidate());
    assert.ok(match);
});

test('Discord artwork rejects untrusted or insecure thumbnails', () => {
    assert.equal(Artwork._test.scoreCandidate(song, candidate({ id: '', thumbnail: 'http://i.ytimg.com/image.jpg' })), null);
    assert.equal(Artwork._test.scoreCandidate(song, candidate({ id: '', thumbnail: 'https://example.com/image.jpg' })), null);
});

test('Discord artwork modes fail closed', () => {
    assert.equal(Artwork.validArtworkMode('app_logo'), 'app_logo');
    assert.equal(Artwork.validArtworkMode('best_effort'), 'best_effort');
    assert.equal(Artwork.validArtworkMode('youtube_exact'), 'youtube_exact');
    assert.equal(Artwork.validArtworkMode('apple_only'), 'apple_only');
    assert.equal(Artwork.validArtworkMode('anything-else'), 'stored_only');
});

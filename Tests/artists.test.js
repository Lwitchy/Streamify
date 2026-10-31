const assert = require('node:assert/strict');
const test = require('node:test');

const Artists = require('../Server/artists');

test('artist uid is stable across spelling differences and well-formed', () => {
    const a = Artists.artistUidFor('Beyoncé');
    assert.equal(a, Artists.artistUidFor('beyonce'));
    assert.match(a, Artists.ARTIST_UID_PATTERN);
    assert.notEqual(a, Artists.artistUidFor('Beyoncé Knowles'));
    assert.equal(Artists.artistUidFor('  '), null);
});

test('placeholder names never get an artist page', () => {
    assert.equal(Artists.isPlaceholderArtist('Unknown Artist'), true);
    assert.equal(Artists.isPlaceholderArtist('Various Artists'), true);
    assert.equal(Artists.isPlaceholderArtist(''), true);
    assert.equal(Artists.isPlaceholderArtist('Daft Punk'), false);
});

const picture = hash => `https://e-cdns-images.dzcdn.net/images/artist/${hash}/1000x1000-000000-80-0-0.jpg`;

test('Deezer match requires the same name and prefers the most followed', () => {
    const response = {
        data: [
            { id: 1, name: 'Drake Bell', nb_fan: 999999, picture_xl: picture('aaa') },
            { id: 2, name: 'Drake', nb_fan: 100, picture_xl: picture('bbb') },
            { id: 3, name: 'DRAKE', nb_fan: 5000, picture_xl: picture('ccc') }
        ]
    };
    const match = Artists.pickDeezerArtist(response, 'Drake');
    assert.equal(match.id, 3);
    assert.equal(match.pictureUrl, picture('ccc'));
});

test('Deezer placeholder silhouettes and foreign hosts are rejected', () => {
    assert.equal(Artists.isUsableDeezerPicture('https://e-cdns-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg'), false);
    assert.equal(Artists.isUsableDeezerPicture('https://evil.example.com/images/artist/abc/1.jpg'), false);
    assert.equal(Artists.isUsableDeezerPicture('http://e-cdns-images.dzcdn.net/images/artist/abc/1.jpg'), false);
    assert.equal(Artists.isUsableDeezerPicture(picture('abc')), true);
    assert.equal(Artists.pickDeezerArtist({ data: [{ id: 1, name: 'Drake', picture_xl: 'https://e-cdns-images.dzcdn.net/images/artist//x.jpg' }] }, 'Drake'), null);
    assert.equal(Artists.pickDeezerArtist(null, 'Drake'), null);
});

test('uploads are kept; empty lookups are retried after the retry window', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    assert.equal(Artists.needsImageLookup(null, now), true);
    assert.equal(Artists.needsImageLookup({ source: 'upload', image_file: 'x.jpg' }, now), false);
    assert.equal(Artists.needsImageLookup({ source: 'deezer', image_file: 'x.jpg' }, now), false);
    assert.equal(Artists.needsImageLookup({ source: 'none', checked_at: '2026-10-30T00:00:00Z' }, now), false);
    assert.equal(Artists.needsImageLookup({ source: 'none', checked_at: '2026-09-01T00:00:00Z' }, now), true);
});

test('popular tracks rank by the listener\'s plays, then time, then newest', () => {
    const tracks = [
        { id: 1, songname: 'Old hit', year: 2001 },
        { id: 2, songname: 'New song', year: 2020 },
        { id: 3, songname: 'Favourite', year: 2010 },
        { id: 4, songname: 'Background', year: 2010 }
    ];
    const stats = new Map([
        [3, { play_count: 12, listen_time: 2000 }],
        [4, { play_count: 1, listen_time: 900 }],
        [1, { play_count: 1, listen_time: 100 }]
    ]);
    assert.deepEqual(Artists.rankPopularTracks(tracks, stats).map(t => t.id), [3, 4, 1, 2]);
    assert.deepEqual(Artists.rankPopularTracks(tracks, new Map()).map(t => t.id), [2, 4, 3, 1]);
});

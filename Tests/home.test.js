const assert = require('node:assert/strict');
const test = require('node:test');

const Home = require('../Server/home');

const NOW = Date.parse('2026-10-31T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(NOW - days * DAY).toISOString();

function library() {
    const songs = new Map([
        [1, { id: 1, album_uid: 'aaaaaaaaaaaaaaaaaaaa', artist_uid: 'artist-daft', created_at: ago(300) }],
        [2, { id: 2, album_uid: 'aaaaaaaaaaaaaaaaaaaa', artist_uid: 'artist-daft', created_at: ago(300) }],
        [3, { id: 3, album_uid: 'bbbbbbbbbbbbbbbbbbbb', artist_uid: 'artist-other', created_at: ago(5) }],
        [4, { id: 4, album_uid: null, artist_uid: 'artist-other', created_at: ago(1) }],
        [5, { id: 5, album_uid: 'cccccccccccccccccccc', artist_uid: 'artist-third', created_at: ago(200) }]
    ]);
    const albums = new Map([
        ['aaaaaaaaaaaaaaaaaaaa', { album_uid: 'aaaaaaaaaaaaaaaaaaaa', added_at: ago(300) }],
        ['bbbbbbbbbbbbbbbbbbbb', { album_uid: 'bbbbbbbbbbbbbbbbbbbb', added_at: ago(5) }],
        ['cccccccccccccccccccc', { album_uid: 'cccccccccccccccccccc', added_at: ago(200) }]
    ]);
    return { songs, albums, artists: new Set(['artist-daft', 'artist-other', 'artist-third']) };
}

const section = (result, id) => result.sections.find(s => s.id === id);

test('a brand-new account still gets a useful Home', () => {
    const { songs, albums, artists } = library();
    const result = Home.buildHomeSections({ now: NOW, events: [], totals: new Map(), songs, albums, artists, likedSongIds: [], playlists: new Map() });
    assert.equal(result.has_history, false);
    assert.deepEqual(result.sections.map(s => s.id), ['jump_back_in', 'recently_added', 'explore']);
    assert.equal(section(result, 'recently_added').items[0], 'bbbbbbbbbbbbbbbbbbbb');
    assert.equal(section(result, 'explore').title, 'Albums to start with');
});

test('history fills recently played, top artists, on repeat and jump back in', () => {
    const { songs, albums, artists } = library();
    const events = [
        { song_id: 3, started_at: ago(0.1), ms_played: 60000, counted: 1, source_type: 'search', source_id: null },
        { song_id: 1, started_at: ago(0.2), ms_played: 200000, counted: 1, source_type: 'album', source_id: 'aaaaaaaaaaaaaaaaaaaa' },
        { song_id: 1, started_at: ago(1), ms_played: 200000, counted: 1, source_type: 'album', source_id: 'aaaaaaaaaaaaaaaaaaaa' },
        { song_id: 2, started_at: ago(2), ms_played: 5000, counted: 0, source_type: 'playlist', source_id: '7' },
        { song_id: 99, started_at: ago(2), ms_played: 500000, counted: 1, source_type: 'library', source_id: null }
    ];
    const result = Home.buildHomeSections({
        now: NOW, events, totals: new Map(), songs, albums, artists,
        likedSongIds: [4], playlists: new Map([['7', { id: 7 }]])
    });
    assert.equal(result.has_history, true);
    assert.deepEqual(section(result, 'recently_played').items, [3, 1, 2]);
    assert.deepEqual(section(result, 'top_artists').items, ['artist-daft', 'artist-other']);
    assert.equal(section(result, 'top_artists').subtitle, 'Last 30 days');
    assert.deepEqual(section(result, 'on_repeat').items, [1]);
    assert.deepEqual(section(result, 'jump_back_in').items.slice(0, 3), [
        { kind: 'album', id: 'bbbbbbbbbbbbbbbbbbbb' },
        { kind: 'album', id: 'aaaaaaaaaaaaaaaaaaaa' },
        { kind: 'playlist', id: '7' }
    ]);
    assert.ok(section(result, 'jump_back_in').items.some(tile => tile.kind === 'liked'));
    assert.deepEqual(section(result, 'liked').items, [4]);
    assert.ok(!section(result, 'explore').items.includes('aaaaaaaaaaaaaaaaaaaa'), 'played albums are not suggested');
});

test('rediscover picks old favourites only', () => {
    const { songs, albums, artists } = library();
    const totals = new Map([
        [5, { play_count: 9, listen_time: 2000, last_listened_at: ago(120) }],
        [2, { play_count: 9, listen_time: 2000, last_listened_at: ago(10) }],
        [3, { play_count: 1, listen_time: 100, last_listened_at: ago(120) }]
    ]);
    const result = Home.buildHomeSections({ now: NOW, events: [], totals, songs, albums, artists, likedSongIds: [], playlists: new Map() });
    assert.deepEqual(section(result, 'rediscover').items, [5]);
    assert.equal(section(result, 'top_artists').subtitle, 'All time');
});

test('the explore shuffle is stable within a day', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(Home.seededShuffle(items, 42), Home.seededShuffle(items, 42));
    assert.notDeepEqual(Home.seededShuffle(items, 42), Home.seededShuffle(items, 43));
    assert.deepEqual([...Home.seededShuffle(items, 7)].sort((a, b) => a - b), items);
});

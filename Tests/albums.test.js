const assert = require('node:assert/strict');
const test = require('node:test');

const Albums = require('../Server/albums');

let nextId = 1;
const song = (overrides = {}) => ({
    id: nextId++,
    album: 'Discovery',
    artist: 'Daft Punk',
    source: 'folder',
    filepath: 'C:/Music/Daft Punk/Discovery/01.flac',
    year: 2001,
    created_at: '2026-10-01T00:00:00.000Z',
    albumArtistTag: null,
    trackNumber: null,
    discNumber: null,
    releaseYear: null,
    compilationTag: false,
    ...overrides
});

const albumOf = (result, s) => result.assignments.get(s.id);

test('tracks of one album group together with numbers and year', () => {
    const a = song({ trackNumber: 1 });
    const b = song({ trackNumber: 2, filepath: 'C:/Music/Daft Punk/Discovery/02.flac' });
    const result = Albums.groupAlbums([a, b]);
    assert.equal(result.albums.size, 1);
    const [album] = result.albums.values();
    assert.equal(album.title, 'Discovery');
    assert.equal(album.album_artist, 'Daft Punk');
    assert.equal(album.year, 2001);
    assert.equal(album.song_count, 2);
    assert.equal(albumOf(result, a).album_uid, albumOf(result, b).album_uid);
    assert.equal(albumOf(result, b).track_number, 2);
});

test('unknown or blank album titles get no album', () => {
    const result = Albums.groupAlbums([
        song({ album: 'Unknown Album' }), song({ album: '' }), song({ album: 'Single' })
    ]);
    assert.equal(result.albums.size, 0);
    assert.equal(result.assignments.size, 0);
});

test('a compilation in one folder stays together as Various Artists', () => {
    const dir = 'C:/Music/Compilations/Now 100/';
    const result = Albums.groupAlbums([
        song({ album: 'Now 100', artist: 'Artist A', filepath: dir + '1.mp3' }),
        song({ album: 'Now 100', artist: 'Artist B', filepath: dir + '2.mp3' }),
        song({ album: 'Now 100', artist: 'Artist C', filepath: dir + '3.mp3' })
    ]);
    assert.equal(result.albums.size, 1);
    const [album] = result.albums.values();
    assert.equal(album.album_artist, Albums.VARIOUS_ARTISTS);
    assert.equal(album.is_compilation, 1);
});

test('featured artists do not split an album', () => {
    const dir = 'C:/Music/Drake/Views/';
    const result = Albums.groupAlbums([
        song({ album: 'Views', artist: 'Drake', filepath: dir + '1.mp3' }),
        song({ album: 'Views', artist: 'Drake feat. Rihanna', filepath: dir + '2.mp3' }),
        song({ album: 'Views', artist: 'Drake (ft. Future)', filepath: dir + '3.mp3' })
    ]);
    const [album] = result.albums.values();
    assert.equal(result.albums.size, 1);
    assert.equal(album.album_artist, 'Drake');
});

test('album artist tags win and merge with untagged tracks of the same album', () => {
    const tagged = song({ album: 'Abbey Road', artist: 'The Beatles', albumArtistTag: 'The Beatles', filepath: 'C:/a/1.mp3' });
    const untagged = song({ album: 'Abbey Road', artist: 'The Beatles', source: 'upload', filepath: 'uploads/x.mp3' });
    const result = Albums.groupAlbums([tagged, untagged]);
    assert.equal(result.albums.size, 1);
    assert.equal(albumOf(result, tagged).album_uid, albumOf(result, untagged).album_uid);
});

test('same title by different artists stays separate', () => {
    const result = Albums.groupAlbums([
        song({ album: 'Greatest Hits', artist: 'Queen', source: 'upload' }),
        song({ album: 'Greatest Hits', artist: 'ABBA', source: 'upload' })
    ]);
    assert.equal(result.albums.size, 2);
});

test('matching ignores case, accents and punctuation; uid is stable', () => {
    const one = Albums.groupAlbums([song({ album: 'Café Del Mar', artist: 'Various', source: 'upload' })]);
    const two = Albums.groupAlbums([song({ album: 'cafe del mar!', artist: 'VARIOUS', source: 'upload' })]);
    assert.deepEqual([...one.albums.keys()], [...two.albums.keys()]);
    assert.match([...one.albums.keys()][0], /^[a-f0-9]{20}$/);
});

test('"Simon & Garfunkel" is one artist, not two', () => {
    assert.equal(Albums.primaryArtist('Simon & Garfunkel'), 'Simon & Garfunkel');
    assert.equal(Albums.primaryArtist('Tyler, The Creator'), 'Tyler, The Creator');
    assert.equal(Albums.primaryArtist('A featuring B'), 'A');
});

test('tracks sort by disc, track number, then title', () => {
    const tracks = [
        { songname: 'c', disc_number: 2, track_number: 1 },
        { songname: 'b', disc_number: 1, track_number: null },
        { songname: 'a', disc_number: 1, track_number: 2 },
        { songname: 'z', disc_number: null, track_number: 1 }
    ].sort(Albums.compareAlbumTracks);
    assert.deepEqual(tracks.map(t => t.songname), ['z', 'a', 'b', 'c']);
});

test('tag evidence keeps only valid values', () => {
    assert.deepEqual(Albums.albumTagEvidence({
        albumartist: ' Daft Punk ', track: { no: 3, of: 14 }, disk: { no: 0, of: null }, compilation: false
    }), { album_artist: 'Daft Punk', track_number: 3, track_total: 14 });
    assert.deepEqual(Albums.albumTagEvidence(null), {});
});

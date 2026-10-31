/**
 * Album grouping.
 *
 * Albums are derived from songs; nobody edits an album directly. Changing a
 * song's album title, its tags, or its Smart Auto Enrich identity changes the
 * album it belongs to on the next rebuild (HandleDatabase.rebuildAlbums).
 *
 * Grouping rules, in order:
 *   1. Songs with no usable album title ("Unknown Album", blank) get no album.
 *   2. A song with an album artist tag groups by (album artist, title).
 *   3. A folder song without one groups by (its folder, title), so a
 *      compilation in one folder stays together even when every track has a
 *      different artist. Its album artist is the artist on most of its tracks,
 *      or "Various Artists" when no artist covers half of them.
 *   4. Other songs group by (primary artist, title).
 *   Finally, groups whose resolved (album artist, title) match are merged, so
 *   tagged and untagged tracks of one album end up together.
 *
 * The album UID is a hash of the final (album artist, title) key: it is
 * stable across rebuilds and restarts, and URLs (#album-<uid>) keep working.
 * Renaming an album gives it a new UID, which is the expected outcome.
 *
 * This module is pure so it can be unit tested without a database.
 */

const crypto = require('crypto');
const path = require('path');

const VARIOUS_ARTISTS = 'Various Artists';
const NO_ALBUM_TITLES = new Set(['', 'unknown album', 'unknown', 'single', 'singles', '[non-album tracks]', 'non-album tracks']);

function normalizeKey(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(Array.isArray(value) ? value[0] : value).trim();
}

function isUsableAlbumTitle(title) {
    return !NO_ALBUM_TITLES.has(normalizeKey(title)) && normalizeKey(title) !== '';
}

/**
 * The lead artist of a credit: "A feat. B" -> "A", "A (ft. B)" -> "A".
 * Deliberately does not split on "&" or "," because those are part of many
 * real artist names ("Simon & Garfunkel", "Tyler, The Creator").
 */
function primaryArtist(artist) {
    const text = cleanText(artist);
    if (!text) return '';
    const stripped = text
        .replace(/\s*[([]\s*(feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]\s*$/i, '')
        .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
        .trim();
    return stripped || text;
}

function isVariousArtists(name) {
    const key = normalizeKey(name);
    return key === 'various artists' || key === 'various' || key === 'va';
}

function positiveInteger(value) {
    const number = Number(Array.isArray(value) ? value[0] : value);
    return Number.isInteger(number) && number > 0 && number < 10000 ? number : null;
}

function albumUidFor(finalKey) {
    return crypto.createHash('sha1').update(finalKey).digest('hex').slice(0, 20);
}

function mostCommon(values) {
    const counts = new Map();
    let best = null;
    let bestCount = 0;
    for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const count = (counts.get(value) || 0) + 1;
        counts.set(value, count);
        if (count > bestCount) { best = value; bestCount = count; }
    }
    return { value: best, count: bestCount };
}

/**
 * @param {Array<object>} songs rows with at least:
 *   id, album, artist, source, filepath, year, created_at, and the resolved
 *   tag/identity fields albumArtistTag, trackNumber, discNumber,
 *   releaseYear, compilationTag (any may be null).
 * @returns {{ assignments: Map<id, {album_uid, album_artist, track_number, disc_number}>,
 *             albums: Map<album_uid, object> }}
 */
function groupAlbums(songs) {
    const provisional = new Map();

    for (const song of songs || []) {
        const title = cleanText(song.album);
        if (!isUsableAlbumTitle(title)) continue;
        const titleKey = normalizeKey(title);
        const tagArtist = cleanText(song.albumArtistTag);
        const lead = primaryArtist(song.artist);

        let key;
        if (tagArtist) {
            key = `a:${normalizeKey(tagArtist)}|${titleKey}`;
        } else if (song.source === 'folder' && song.filepath) {
            const folder = normalizeKey(path.dirname(String(song.filepath).replace(/\\/g, '/')));
            key = `d:${folder}|${titleKey}`;
        } else {
            key = `p:${normalizeKey(lead)}|${titleKey}`;
        }

        if (!provisional.has(key)) provisional.set(key, { kind: key[0], titleKey, songs: [] });
        provisional.get(key).songs.push({ song, title, tagArtist, lead });
    }

    const merged = new Map();
    for (const group of provisional.values()) {
        let albumArtist;
        let isCompilation = group.songs.some(entry => entry.song.compilationTag === true);

        if (group.kind === 'a') {
            albumArtist = mostCommon(group.songs.map(entry => entry.tagArtist)).value;
        } else {
            const leads = mostCommon(group.songs.map(entry => entry.lead));
            if (group.kind === 'd' && group.songs.length > 1 && leads.count * 2 < group.songs.length) {
                albumArtist = VARIOUS_ARTISTS;
            } else {
                albumArtist = leads.value || 'Unknown Artist';
            }
        }
        if (isVariousArtists(albumArtist)) {
            albumArtist = VARIOUS_ARTISTS;
            isCompilation = true;
        }

        const finalKey = `${normalizeKey(albumArtist)}|${group.titleKey}`;
        if (!merged.has(finalKey)) {
            merged.set(finalKey, { finalKey, artistVotes: [], entries: [], isCompilation: false });
        }
        const target = merged.get(finalKey);
        target.entries.push(...group.songs);
        target.artistVotes.push(...group.songs.map(() => albumArtist));
        target.isCompilation = target.isCompilation || isCompilation;
    }

    const assignments = new Map();
    const albums = new Map();
    for (const group of merged.values()) {
        const uid = albumUidFor(group.finalKey);
        const albumArtist = mostCommon(group.artistVotes).value;
        const title = mostCommon(group.entries.map(entry => entry.title)).value;
        const year = mostCommon(group.entries.map(entry =>
            positiveInteger(entry.song.releaseYear) || positiveInteger(entry.song.year))).value;
        const createdAt = group.entries
            .map(entry => entry.song.created_at)
            .filter(Boolean)
            .sort()[0] || null;

        albums.set(uid, {
            album_uid: uid,
            title,
            album_artist: albumArtist,
            year: year || null,
            is_compilation: group.isCompilation ? 1 : 0,
            song_count: group.entries.length,
            created_at: createdAt
        });

        for (const entry of group.entries) {
            assignments.set(entry.song.id, {
                album_uid: uid,
                album_artist: albumArtist,
                track_number: positiveInteger(entry.song.trackNumber),
                disc_number: positiveInteger(entry.song.discNumber)
            });
        }
    }

    return { assignments, albums };
}

/** Album track order: disc, then track number, then title. */
function compareAlbumTracks(a, b) {
    const discA = a.disc_number || 1;
    const discB = b.disc_number || 1;
    if (discA !== discB) return discA - discB;
    const trackA = a.track_number || Number.MAX_SAFE_INTEGER;
    const trackB = b.track_number || Number.MAX_SAFE_INTEGER;
    if (trackA !== trackB) return trackA - trackB;
    return String(a.songname || a.name || '').localeCompare(String(b.songname || b.name || ''), undefined, { sensitivity: 'base' });
}

/** Tag fields that album grouping needs, from a music-metadata `common` object. */
function albumTagEvidence(common) {
    const evidence = {};
    if (!common) return evidence;
    const albumArtist = cleanText(common.albumartist);
    if (albumArtist) evidence.album_artist = albumArtist;
    if (common.track && positiveInteger(common.track.no)) evidence.track_number = common.track.no;
    if (common.track && positiveInteger(common.track.of)) evidence.track_total = common.track.of;
    if (common.disk && positiveInteger(common.disk.no)) evidence.disc_number = common.disk.no;
    if (common.disk && positiveInteger(common.disk.of)) evidence.disc_total = common.disk.of;
    if (common.compilation === true) evidence.compilation = true;
    return evidence;
}

module.exports = {
    VARIOUS_ARTISTS,
    normalizeKey,
    primaryArtist,
    isUsableAlbumTitle,
    groupAlbums,
    compareAlbumTracks,
    albumTagEvidence,
    albumUidFor
};

/**
 * Artists.
 *
 * Like albums, artists are derived from songs: a song belongs to the artist
 * returned by Albums.primaryArtist() (its lead artist, with "feat." credits
 * removed), and an album belongs to its album artist. The artist UID is a hash
 * of the normalized name, so it stays the same across rebuilds and can be
 * used in URLs (#artist-<uid>).
 *
 * Artist photos come from, in order:
 *   1. an image the Owner or an Admin uploaded on the artist page;
 *   2. Deezer's public artist search (no account or key), when the Owner
 *      allows online artist photos. Only the artist name is sent. The
 *      result, including "nothing found", is cached in artist_images;
 *   3. the client's fallback: a mosaic of the artist's album covers.
 *
 * This module holds the pure parts so they can be unit tested.
 */

const crypto = require('crypto');
const Albums = require('./albums');

const ARTIST_UID_PATTERN = /^[a-f0-9]{20}$/;
// A failed or empty lookup is retried after this long.
const IMAGE_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

function artistUidFor(name) {
    const key = Albums.normalizeKey(name);
    if (!key) return null;
    return crypto.createHash('sha1').update(`artist|${key}`).digest('hex').slice(0, 20);
}

/** True for names that are not a real artist page ("Unknown Artist", "Various Artists"). */
function isPlaceholderArtist(name) {
    const key = Albums.normalizeKey(name);
    return !key || key === 'unknown artist' || key === 'unknown' ||
        key === 'various artists' || key === 'various' || key === 'va';
}

/** Deezer returns this when an artist has no photo; it is a generic silhouette. */
function isUsableDeezerPicture(url) {
    if (typeof url !== 'string' || !url.startsWith('https://')) return false;
    if (/\/images\/artist\/\//.test(url)) return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'dzcdn.net' || host.endsWith('.dzcdn.net');
    } catch {
        return false;
    }
}

/**
 * Pick the Deezer search result that is this artist: the name must match
 * after normalization (so "Beyoncé" matches "Beyonce" but "Drake Bell" never
 * matches "Drake"); among exact matches the most-followed one wins.
 */
function pickDeezerArtist(response, name) {
    const wanted = Albums.normalizeKey(name);
    const results = response && Array.isArray(response.data) ? response.data : [];
    const matches = results.filter(entry =>
        entry && Albums.normalizeKey(entry.name) === wanted &&
        isUsableDeezerPicture(entry.picture_xl || entry.picture_big));
    if (matches.length === 0) return null;
    matches.sort((a, b) => (Number(b.nb_fan) || 0) - (Number(a.nb_fan) || 0));
    const best = matches[0];
    return {
        id: best.id,
        name: best.name,
        pictureUrl: isUsableDeezerPicture(best.picture_xl) ? best.picture_xl : best.picture_big
    };
}

function needsImageLookup(record, now = Date.now()) {
    if (!record) return true;
    if (record.source === 'upload' || record.image_file) return false;
    const checked = Date.parse(record.checked_at || '');
    return !Number.isFinite(checked) || now - checked > IMAGE_RETRY_MS;
}

/**
 * Order an artist's tracks for "Popular": most counted plays first, then
 * most listening time, then newest album, then title. `stats` maps song id
 * to { play_count, listen_time } for the current user.
 */
function rankPopularTracks(tracks, stats) {
    const statFor = track => (stats && stats.get(track.id)) || { play_count: 0, listen_time: 0 };
    return [...tracks].sort((a, b) => {
        const sa = statFor(a);
        const sb = statFor(b);
        return (sb.play_count - sa.play_count) ||
            (sb.listen_time - sa.listen_time) ||
            ((Number(b.year) || 0) - (Number(a.year) || 0)) ||
            String(a.songname || '').localeCompare(String(b.songname || ''), undefined, { sensitivity: 'base' });
    });
}

module.exports = {
    ARTIST_UID_PATTERN,
    IMAGE_RETRY_MS,
    artistUidFor,
    isPlaceholderArtist,
    isUsableDeezerPicture,
    pickDeezerArtist,
    needsImageLookup,
    rankPopularTracks
};

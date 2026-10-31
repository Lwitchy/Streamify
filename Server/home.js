/**
 * Home page sections.
 *
 * Home is personal: every section comes from the signed-in user's own
 * listening history (listening_events), lifetime totals (listening_telemetry),
 * likes and library. Nothing is shared across accounts.
 *
 * buildHomeSections() is pure. It returns sections that reference songs,
 * albums, artists and playlists by ID; server.js turns them into payloads.
 * A section with no items is left out.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const LIMITS = Object.freeze({
    jumpBackIn: 8,
    jumpBackInMinimum: 6,
    recentlyPlayed: 20,
    topArtists: 10,
    onRepeat: 20,
    topAlbums: 10,
    liked: 15,
    rediscover: 15,
    recentlyAdded: 12,
    explore: 10
});

function timeOf(value) {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
}

function addTo(map, key, amount) {
    map.set(key, (map.get(key) || 0) + amount);
}

function topKeys(map, limit, tieBreak = () => 0) {
    return [...map.entries()]
        .filter(([, value]) => value > 0)
        .sort((a, b) => (b[1] - a[1]) || tieBreak(a[0], b[0]))
        .slice(0, limit)
        .map(([key]) => key);
}

/** Small deterministic shuffle so "Albums to explore" changes daily, not on every refresh. */
function seededShuffle(items, seed) {
    const result = [...items];
    let state = seed >>> 0 || 1;
    for (let i = result.length - 1; i > 0; i--) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const j = state % (i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/**
 * @param {object} input
 * @param {number} input.now
 * @param {Array}  input.events     listening events, newest first: { song_id, started_at, ms_played, counted, source_type, source_id }
 * @param {Map}    input.totals     song_id -> { play_count, listen_time, last_listened_at }
 * @param {Map}    input.songs      accessible song rows by id (album_uid, artist_uid, created_at)
 * @param {Map}    input.albums     accessible album summaries by album_uid (added_at)
 * @param {Set}    input.artists    artist_uids that have an artist page for this user
 * @param {Array}  input.likedSongIds  newest like first
 * @param {Map}    input.playlists  the user's playlists by String(id)
 * @param {string} [input.username] used only to vary the daily shuffle per user
 */
function buildHomeSections(input) {
    const now = input.now || Date.now();
    const events = (input.events || []).filter(event => input.songs.has(event.song_id));
    const totals = input.totals || new Map();
    const songs = input.songs;
    const albums = input.albums;
    const artists = input.artists || new Set();
    const playlists = input.playlists || new Map();
    const likedSongIds = (input.likedSongIds || []).filter(id => songs.has(id));
    const hasHistory = events.length > 0 || [...totals.values()].some(t => (t.play_count || 0) > 0);
    const sections = [];
    const push = section => { if (section.items.length > 0) sections.push(section); };

    // --- Jump back in: the places you were last listening from.
    const tiles = [];
    const seen = new Set();
    const addTile = (kind, id) => {
        const key = `${kind}:${id === undefined ? '' : id}`;
        if (seen.has(key) || tiles.length >= LIMITS.jumpBackIn) return;
        seen.add(key);
        tiles.push(id === undefined ? { kind } : { kind, id });
    };
    for (const event of events) {
        if (tiles.length >= LIMITS.jumpBackIn) break;
        const song = songs.get(event.song_id);
        const sourceId = event.source_id === null || event.source_id === undefined ? null : String(event.source_id);
        if (event.source_type === 'album' && sourceId && albums.has(sourceId)) addTile('album', sourceId);
        else if (event.source_type === 'artist' && sourceId && artists.has(sourceId)) addTile('artist', sourceId);
        else if (event.source_type === 'playlist' && sourceId && playlists.has(sourceId)) addTile('playlist', sourceId);
        else if (event.source_type === 'liked' && likedSongIds.length > 0) addTile('liked');
        else if (song && song.album_uid && albums.has(song.album_uid)) addTile('album', song.album_uid);
    }
    if (tiles.length < LIMITS.jumpBackInMinimum) {
        if (likedSongIds.length > 0) addTile('liked');
        for (const playlistId of playlists.keys()) {
            if (tiles.length >= LIMITS.jumpBackInMinimum) break;
            addTile('playlist', playlistId);
        }
        const newest = [...albums.values()].sort((a, b) => timeOf(b.added_at) - timeOf(a.added_at));
        for (const album of newest) {
            if (tiles.length >= LIMITS.jumpBackInMinimum) break;
            addTile('album', album.album_uid);
        }
    }
    push({ id: 'jump_back_in', title: 'Jump back in', type: 'tiles', items: tiles });

    // --- Recently played songs.
    const recent = [];
    const recentSeen = new Set();
    for (const event of events) {
        if (recent.length >= LIMITS.recentlyPlayed) break;
        if (recentSeen.has(event.song_id)) continue;
        recentSeen.add(event.song_id);
        recent.push(event.song_id);
    }
    push({ id: 'recently_played', title: 'Recently played', type: 'songs', items: recent });

    // --- Top artists: last 30 days of listening, or all-time when the window is empty.
    const artistTime = new Map();
    for (const event of events) {
        if (timeOf(event.started_at) < now - 30 * DAY_MS) continue;
        const song = songs.get(event.song_id);
        if (song && song.artist_uid && artists.has(song.artist_uid)) addTo(artistTime, song.artist_uid, Number(event.ms_played) || 0);
    }
    let artistsSubtitle = 'Last 30 days';
    if (artistTime.size === 0) {
        artistsSubtitle = 'All time';
        for (const [songId, total] of totals) {
            const song = songs.get(songId);
            if (song && song.artist_uid && artists.has(song.artist_uid)) addTo(artistTime, song.artist_uid, Number(total.listen_time) || 0);
        }
    }
    push({ id: 'top_artists', title: 'Your top artists', subtitle: artistsSubtitle, type: 'artists', items: topKeys(artistTime, LIMITS.topArtists) });

    // --- On repeat: songs played at least twice in the last 14 days.
    const repeatCounts = new Map();
    const lastPlayed = new Map();
    for (const event of events) {
        const time = timeOf(event.started_at);
        if (time < now - 14 * DAY_MS || !event.counted) continue;
        addTo(repeatCounts, event.song_id, 1);
        lastPlayed.set(event.song_id, Math.max(lastPlayed.get(event.song_id) || 0, time));
    }
    for (const [songId, count] of repeatCounts) if (count < 2) repeatCounts.delete(songId);
    push({
        id: 'on_repeat', title: 'On repeat', subtitle: 'Your most-played songs from the last two weeks', type: 'songs',
        items: topKeys(repeatCounts, LIMITS.onRepeat, (a, b) => (lastPlayed.get(b) || 0) - (lastPlayed.get(a) || 0))
    });

    // --- Top albums: last 90 days.
    const albumTime = new Map();
    for (const event of events) {
        if (timeOf(event.started_at) < now - 90 * DAY_MS) continue;
        const song = songs.get(event.song_id);
        if (song && song.album_uid && albums.has(song.album_uid)) addTo(albumTime, song.album_uid, Number(event.ms_played) || 0);
    }
    push({ id: 'top_albums', title: 'Your top albums', subtitle: 'Last 90 days', type: 'albums', items: topKeys(albumTime, LIMITS.topAlbums) });

    // --- Liked Songs preview.
    push({ id: 'liked', title: 'From your Liked Songs', type: 'songs', link: 'liked', items: likedSongIds.slice(0, LIMITS.liked) });

    // --- Rediscover: songs you played a lot but not in the last 60 days.
    const playedRecently = new Set(events
        .filter(event => timeOf(event.started_at) >= now - 60 * DAY_MS)
        .map(event => event.song_id));
    const rediscover = [...totals.entries()]
        .filter(([songId, total]) => songs.has(songId) && !playedRecently.has(songId) &&
            (Number(total.play_count) || 0) >= 3 &&
            timeOf(total.last_listened_at) > 0 && timeOf(total.last_listened_at) < now - 60 * DAY_MS)
        .sort((a, b) => (Number(b[1].play_count) || 0) - (Number(a[1].play_count) || 0))
        .slice(0, LIMITS.rediscover)
        .map(([songId]) => songId);
    push({ id: 'rediscover', title: 'Rediscover', subtitle: 'Favourites you haven’t played in a while', type: 'songs', items: rediscover });

    // --- Recently added: albums, or songs when the library has no albums yet.
    const newestAlbums = [...albums.values()]
        .sort((a, b) => timeOf(b.added_at) - timeOf(a.added_at))
        .slice(0, LIMITS.recentlyAdded)
        .map(album => album.album_uid);
    if (newestAlbums.length > 0) {
        push({ id: 'recently_added', title: 'Recently added', type: 'albums', items: newestAlbums });
    } else {
        const newestSongs = [...songs.values()]
            .sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at))
            .slice(0, LIMITS.recentlyAdded)
            .map(song => song.id);
        push({ id: 'recently_added', title: 'Recently added', type: 'songs', items: newestSongs });
    }

    // --- Albums to explore: ones you have not played, reshuffled daily.
    const playedAlbums = new Set();
    for (const songId of totals.keys()) {
        const song = songs.get(songId);
        if (song && song.album_uid) playedAlbums.add(song.album_uid);
    }
    for (const event of events) {
        const song = songs.get(event.song_id);
        if (song && song.album_uid) playedAlbums.add(song.album_uid);
    }
    let seed = Math.floor(now / DAY_MS);
    for (const char of String(input.username || '')) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
    const unplayedAll = [...albums.keys()].filter(uid => !playedAlbums.has(uid));
    // Avoid repeating the first "Recently added" cards, unless that would
    // leave a small library with almost nothing to suggest.
    const notJustAdded = unplayedAll.filter(uid => !newestAlbums.slice(0, 6).includes(uid));
    const unplayed = notJustAdded.length >= 4 ? notJustAdded : unplayedAll;
    push({
        id: 'explore', title: hasHistory ? 'Albums you haven’t played yet' : 'Albums to start with', type: 'albums',
        items: seededShuffle(unplayed, seed).slice(0, LIMITS.explore)
    });

    return { has_history: hasHistory, sections };
}

module.exports = { LIMITS, buildHomeSections, seededShuffle };

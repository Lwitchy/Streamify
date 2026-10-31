# Albums, Artists, Liked Songs and Home

Status: Phases 1-3 implemented (2026-10-31). Phase 4 planned.

This update ships as a main release, not behind an experiment switch. Home
is personal: every section is computed from the signed-in user's own
listening only, with no cross-user "popular on this server" data.

## Starting point

- `songs.album` is free text. Album artist, track and disc numbers were read
  from tags (`embeddedMetadataEvidence`) but only stored in
  `metadata_provenance`. `releases` / `release_tracks` exist only for songs
  identified by Smart Auto Enrich.
- No artist pages. `songs.is_favorite` is one flag shared by all users, so
  there were no per-user likes.
- `listening_telemetry` held one cumulative row per (user, song). With no
  timeline it could not answer "recently played", "this week", "on repeat"
  or "skipped".

## Phase 1 - Listening history (telemetry v2) - DONE

- `listening_events` (users.db): one row per playback, unique on
  `(username, play_id)`. Columns: `song_id`, `song_uid`, `started_at`,
  `updated_at`, `ended_at`, `ms_played`, `duration_ms`, `end_reason`,
  `source_type`, `source_id`, `device`, `counted`.
- Rules in `Server/listeningHistory.js` (unit tested):
  - a play counts at 30 s, or half a track shorter than 60 s;
  - `ms_played` is cumulative and never decreases; growth per report is capped
    by wall time since the previous report plus 20 s slack;
  - an ended playback is immutable, so retried finals are no-ops;
  - reports older than 30 days are dropped.
- `HandleDatabase.recordPlaybackProgress` upserts the event and rolls the
  delta into `listening_telemetry` in one `BEGIN IMMEDIATE` transaction.
- Client: `Static/home/js/telemetry.js` (`window.StreamifyListening`).
  Heartbeat every 15 s of heard audio, final report on end. Finals go to a
  localStorage outbox first and are removed once delivered (offline plays,
  app closed mid-track). `keepalive` fetch goes through the existing auth
  fetch wrapper, so it works for the Capacitor shell too.
- Source context: `currentPlaybackContext` (config.js) is set by each view;
  `playSongAtIndex` snapshots it into `activePlaybackContext`. New views
  (album, artist, Home, Liked Songs) must set it.
- Privacy: `allow_analytics` still gates collection (server and client);
  export includes events; **Clear Listening History** deletes both tables.

### Manual verification

1. Play a song for over 30 s, press Next. In `listening_events` the row
   has `end_reason = 'next'`, `counted = 1`, and the right `source_type`.
2. Let a track end naturally (`completed`). Turn on repeat-one, and each loop
   becomes a separate row.
3. Close the desktop app mid-track and reopen it. The row gets `end_reason = 'closed'`.
4. Play a downloaded song in offline mode, then reconnect. The row appears.
5. Turn off analytics, play, and check that no rows are added. Clear history and
   check that both tables are empty for the user.

## Phase 2 - Albums - DONE

- `songs` gained derived columns `album_uid`, `album_artist`, `track_number`,
  `disc_number`; a derived `albums` table (`album_uid`, title, album artist,
  year, compilation flag, song count, first-added time) sits beside them.
  Nothing edits these directly. Edit the song (title, album, tags) instead.
- Grouping rules live in `Server/albums.js` (unit tested):
  - no album for blank, "Unknown Album" or "Single";
  - album artist tag → group by (album artist, title);
  - folder songs without one → group by (folder, title). Album artist is the
    lead artist of at least half the tracks, otherwise "Various Artists";
  - everything else → (lead artist, title). "feat./ft." credits are stripped,
    but "&" and "," are not, so "Simon & Garfunkel" stays one artist;
  - groups that resolve to the same (album artist, title) merge;
  - `album_uid` = SHA-1 of that final key (20 hex chars), so it is stable
    across rebuilds and can be used in URLs.
- Track and disc numbers prefer the Smart Auto Enrich release, then tags
  (`metadata_provenance`: locked > manual > smart-auto > embedded > album-tags).
  Year prefers the identified release year.
- Freshness: any write to `songs`, `metadata_provenance`,
  `song_identifications`, `releases` or `release_tracks` marks the index dirty
  inside `runQuery`. Readers call `HandleDatabase.ensureAlbumsFresh()`, which
  rebuilds once (single-flight) and writes only rows that changed. No code path
  needs to remember to refresh albums.
- Tags for older songs: `backfillAlbumTagEvidence()` runs once in the
  background after start-up (`system_config.album_tag_backfill_v1`). Folder songs
  get full `embedded` evidence, as a rescan would record; uploads get an
  `album-tags` source. New uploads record `album-tags` at upload time.
- API: `GET /api/albums`, `GET /api/albums/:uid`, and `albums` in
  `GET /api/search`. Library, search and playlist song payloads include
  `album_uid`. Counts, duration and cover are per user: only tracks that
  `canAccessSong` allows are included, and an album with none returns 404.
- UI (`Static/home/js/albums.js`): Songs / Albums tabs in Your Library (the
  chosen tab is remembered per device), album grid with hover play, album page
  (`#album-<uid>`) with Play, Shuffle and Download, multi-disc track labels
  (`2-05`). Album names in every song row link to the album. Search shows
  matching albums. Album playback reports `source_type = 'album'`.

### Manual verification

1. Open Your Library → Albums. Tagged folders appear once each; a mixed-artist
   folder shows as "Various Artists" with the Compilation label.
2. Open an album: tracks are in disc/track order, Play starts track 1, and
   Shuffle turns shuffle on and starts a random track.
3. Click an album name in a song row (library, search, playlist). The album opens,
   and Back returns to where you came from.
4. Edit a song's album name, then reload Albums. It moves to the new album.
5. Phone width: two-column grid, centred album header, play buttons visible.

## Phase 3 - Artists and Liked Songs - DONE

### Liked Songs

- `song_likes(username, song_id, liked_at)` in music.db (cascade on song
  delete; removed with the user's other data). `songs.is_favorite` was never
  read and is now officially unused.
- `GET /api/likes` (newest first), `GET /api/likes/ids`,
  `PUT|DELETE /api/likes/:songId` (PUT checks `canAccessSong`).
- Client `Static/home/js/likes.js`: an in-memory ID set drives every heart
  (`data-like-song` on rows, `data-like-current` in the mini and full-screen
  players). Changes show immediately and roll back if the server refuses. The
  Liked Songs page is `#liked`, with the sidebar entry under Your Library, and
  reports `source_type = 'liked'`. On phones, row hearts are hidden to keep a
  single action per row, and liking happens from the player.

### Artists

- Rules in `Server/artists.js` (unit tested). A song's artist is its lead
  artist (`Albums.primaryArtist`, with "feat." credits removed);
  `artist_uid` = SHA-1 of the normalized name (20 hex chars).
  "Unknown/Various Artists" never get a page.
- Derived columns: `songs.artist_uid`, `albums.album_artist_uid`, both set
  by `rebuildAlbums` (same dirty tracking as albums).
- `GET /api/artists` and `GET /api/artists/:uid`. The detail response has:
  - tracks ranked by the user's own plays, then listening time, then the newest
    album (the page shows the top 5 with "Show all");
  - albums where they are the album artist;
  - "Appears On" albums where they lead a track but are not the album artist.
- Artist photos (`artist_images` table, files in `<data>/Static/artists/`):
  1. Owner/Admin upload (`POST|DELETE /api/artists/:uid/image`, JPG/PNG,
     cropped to 800x800). Uploads are never replaced automatically.
  2. Deezer artist search (public API, no key; only the name is sent). It
     needs an exact normalized name match, and the most-followed match wins.
     Deezer's blank silhouette is ignored. The image is downloaded through
     `AIMetadata.downloadFile` (`*.dzcdn.net` added to the trusted hosts).
     "Nothing found" is cached for 30 days, and network errors back off for 1 hour.
     The list endpoint queues lookups in the background. A first visit to an
     artist page waits up to 6 s for one.
  3. Client fallback: a 2x2 mosaic of the artist's album covers, or initials.
- Owner switch: Settings → Metadata → **Download artist photos**
  (`system_config.artist_images_online`, default on).
- Client `Static/home/js/artists.js`: Artists tab in Your Library, artist
  page `#artist-<uid>` with a blurred photo backdrop, Play/Shuffle
  (`source_type = 'artist'`). Artist names in song rows and album headers
  link to the artist.
- Back buttons on album, artist and Liked Songs pages share one origin stack
  (`window.StreamifyNav`), so album → artist → album → Back → Back retraces
  the path. Opening Your Library clears it.

### Manual verification

1. Like songs from rows and from the player. Liked Songs lists them newest first,
   and unliking removes them.
2. Your Library → Artists. Photos appear after a few seconds, if online photos
   are on. Artists without a photo show their album covers.
3. Open an artist: Songs/Popular, Albums and Appears On are filled in, and
   Change photo works for the Owner.
4. Turn off Download artist photos. New artists stay on the cover mosaic.

## Phase 4 - Home

- Sidebar entry above Your Library; `#home` becomes the default route.
- `GET /api/home` returns `{ sections: [{ id, title, type, items }] }`,
  cached about 60 s per user; the client renders sections generically.
- Sections (hidden when empty): Jump back in, Your top artists (30 days),
  On repeat (14 days), Recently played, Recently added, Your top albums,
  Liked Songs, Rediscover (heavily played, not in 60+ days).
- New accounts: Recently added + random albums. Offline: downloaded only.
  Mobile: horizontally scrolling rows.

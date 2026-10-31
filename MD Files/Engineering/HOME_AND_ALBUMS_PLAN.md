# Albums, Artists, Liked Songs and Home

Status: Phase 1 implemented (2026-10-31). Phases 2-4 planned.

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

## Phase 2 - Albums

- Add `album_artist`, `track_number`, `disc_number`, `album_uid` to `songs`;
  backfill from `metadata_provenance` embedded evidence; write directly on
  scan/upload from then on.
- Derived `albums` table (`album_uid`, title, album artist, year, cover,
  track count, total duration), rebuilt after scans and metadata edits.
  Grouping: same `release_uid` when identified, else normalized
  (album artist || artist) + album title. "Unknown Album" never groups;
  "Various Artists" / compilation tag marks compilations.
- `GET /api/albums`, `GET /api/albums/:uid` (disc, track, title order;
  `canAccessSong` applies).
- Library gets Songs / Albums tabs; album page reuses the playlist layout;
  album names in song rows link to the album; Download album.

## Phase 3 - Artists and Liked Songs

- Artist pages with an artist image: header image, top tracks (from the
  user's history), albums, appears-on. Image source order: owner upload, then
  a provider image fetched once and cached under `Static/artists/`, then a
  fallback built from album covers.
- `user_likes` (per user, per song) and a Liked Songs collection with its
  own `source_type = 'liked'`. Retire the shared `songs.is_favorite`.

## Phase 4 - Home

- Sidebar entry above Your Library; `#home` becomes the default route.
- `GET /api/home` returns `{ sections: [{ id, title, type, items }] }`,
  cached about 60 s per user; the client renders sections generically.
- Sections (hidden when empty): Jump back in, Your top artists (30 days),
  On repeat (14 days), Recently played, Recently added, Your top albums,
  Liked Songs, Rediscover (heavily played, not in 60+ days).
- New accounts: Recently added + random albums. Offline: downloaded only.
  Mobile: horizontally scrolling rows.

# Backend Performance Audit

Date: 2026-10-31

Status: analysis complete; **no code changes applied**. This document is the
record of that analysis and a starting point for future work.

Scope: the Node.js backend (`Server/`) only. Frontend and iOS findings are
recorded where they affect backend behaviour, but this is not a client audit.

---

## 1. Purpose

Streamify's backend is one Express server over three SQLite databases, serving
a desktop window, a LAN browser and an iOS WebView from the same code and the
same API. The question this audit answered was:

> Which backend changes would measurably improve performance, without changing
> behaviour that any client can observe?

That last clause matters more than the first. The web app, the packaged
desktop app and the iOS app are all clients of the same API, so "faster" is
only worth having if the response bodies stay identical.

**Nothing in this document has been implemented.** Findings are recorded with
the evidence used to establish them so they can be re-verified later, because
line numbers and assumptions drift.

---

## 2. Method, and what the numbers mean

Three kinds of evidence are used, and they are not equivalent:

| Evidence | Confidence | Used for |
|---|---|---|
| `EXPLAIN QUERY PLAN` on the real schema | High — the planner's actual choice | Index and scan findings |
| Micro-benchmarks on synthetic data | Directional — real ratios, synthetic scale | Cover lookup, index gain, prepare cost |
| Code reading | High for "what runs", medium for "how much it costs" | Startup ordering, N+1 writes, cache invalidation surface |

**Important limitation:** `Database/Dev/Music/music.db` contained **9 songs**
at the time of measurement. No end-to-end request timings were taken. The
query-plan findings are scale-independent (a `SCAN` is a `SCAN` regardless of
row count), and the micro-benchmarks show ratios on synthetic libraries, but
**nothing here proves a latency improvement on your actual library.** Section
8 has the commands to measure that.

Reference state when this was written:

- Branch `mainline`
- `Server/server.js` ~6.3k lines, `Server/database.js` ~4.8k lines
- SQLite (bundled with `sqlite3@6`) reports **3.52.0**
- `mobile/Static/` is a **byte-identical mirror** of `Static/` (verified with
  `diff -q`). iOS ships `mobile/`. Any client-side finding below requires
  `npm run mobile:sync` or the IPA keeps the old file.

---

## 3. Summary of findings

Ordered by (confidence × payoff) ÷ risk. "Status" is relative to the code as
it existed on 2026-10-31.

| # | Finding | Type | Status |
|---|---|---|---|
| 1 | `COALESCE(availability,...)` defeats the availability index | DB | Open |
| 2 | Cover-art resolution does 2–6 sync `fs` calls **per song** | I/O | Open |
| 3 | Auth runs two `SELECT *` per request, including the password hash | DB | Open |
| 4 | Five endpoints recompute the same library snapshot independently | Architecture | Open |
| 5 | `listen()` is blocked behind a synchronous full-library scan | Startup | Open |
| 6 | `rebuildAlbums` does one awaited `UPDATE` per changed song | DB | Open |
| 7 | No prepared-statement reuse (smaller than expected) | DB | Open, low value |
| 8 | SQLite pragmas are minimal | DB | Open, low risk |
| 9 | Download progress = `UPDATE` + `SELECT` on the library connection | DB | Open |
| 10 | `VACUUM INTO` backup runs 3 s after boot, through the same queue | Startup/DB | Open |
| 11 | `getSong(name)` uses `uid OR songname` → full scan + temp B-tree | DB | Open |
| 12 | `/api/search` filters the whole library in JS | Architecture | Open, low priority |
| 13 | Expired sessions are never pruned | DB | Open, trivial |
| 14 | `listening_events` is unbounded; `/api/home` reads 5 000 rows/cold | DB | Open |
| 15 | `/Static` had no cache headers | HTTP | **Already fixed** (see 5.15) |

---

## 4. Withdrawn recommendation (read this first)

During the analysis I recommended dropping the `COALESCE` wrapper:

```sql
-- Don't do this without a backfill.
WHERE COALESCE(availability, 'available') = 'available'
  ->  WHERE availability = 'available'
```

The reasoning was that the column is declared `NOT NULL DEFAULT 'available'`.
That reasoning was **wrong**, and the test that disproved it is worth keeping:

```js
const d = new (require('sqlite3').Database)(':memory:');
d.serialize(() => {
  d.run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  d.run("ALTER TABLE t ADD COLUMN availability TEXT DEFAULT 'available'");
});
// PRAGMA table_info(t)  ->  availability:TEXT:nn=0:dflt='available'
```

Adding a column with `ALTER TABLE ... DEFAULT` does **not** apply `NOT NULL`.
`PRAGMA table_info` reports `notnull=0`. Rows written with an explicit `NULL`
stay `NULL`. The fresh-install path (`Server/database.js:1047`) does declare
`NOT NULL DEFAULT 'available' CHECK (...)`; the migration path
(`Server/database.js:1073`, applied at `:1096`) does not.

The one-time repair at `Server/database.js:1138` only runs during that same
migration, so a partially-migrated or hand-touched database can hold `NULL` in
a migrated install.

**Consequence if `COALESCE` is dropped:** those rows silently vanish from every
library view — a data-visibility regression, not a crash. This is exactly the
class of bug that is invisible in testing and shows up months later.

**What to do instead:** see finding 5.1. An expression index gets the index
seek without touching a single query string, so `COALESCE` semantics (and
`NULL` rows) are preserved exactly.

---

## 5. Findings in detail

### 5.1 `COALESCE(availability,...)` defeats the availability index

**Where:** `Server/database.js` — `getSong:1267`, `:1276`, `:1293`, `:1304`;
`getAlbumSongs:1514`; `getLikedSongs:1577`; `getSongsWithoutTagEvidence:1590`;
`getAllSongs:1599`; `getSongsCount:1613`; `getSongsByUser:1619`.

**Measured query plan** (`Database/Dev/Music/music.db`, read-only):

```
EXPLAIN QUERY PLAN
  SELECT s.*, si.release_uid
  FROM songs s
  LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
  WHERE COALESCE(s.availability, 'available') = 'available'

-> SCAN s | SEARCH si USING INDEX idx_song_identifications_current (song_id=?) LEFT-JOIN
```

The join side is indexed; the **driving table is a full scan**. The index
`idx_songs_availability` (`Server/database.js:1190`) cannot be used because the
indexed expression is the bare column, not `COALESCE(column, ...)`.

**Benchmark** (10 000 synthetic songs, same query shape):

| | Time |
|---|---:|
| Current query (SCAN) | 219.93 ms |
| With expression index | **28.04 ms** |
| Gain | **7.8×** |

**Fix — add an expression index; change no query text:**

```sql
CREATE INDEX IF NOT EXISTS idx_songs_availability_norm
  ON songs(COALESCE(availability, 'available'));
```

Verified that SQLite matches this index across all three spellings currently in
the codebase:

```
COALESCE(availability,'available')='available'      -> SEARCH USING COVERING INDEX
COALESCE(s.availability,'available')='available'    -> SEARCH USING INDEX   (alias-qualified)
COALESCE(availability, 'available') = 'available'   -> SEARCH USING INDEX   (different spacing)
```

SQLite normalises the expression, so quoting/spacing/aliasing do not matter —
but keep the definition textually consistent anyway for readability.

**Semantics:** identical. A `NULL` availability row still matches
`'available'`, exactly as today. Verified:

```js
// rows inserted: (1,'available'), (2,'missing'), (3,NULL)
SELECT id FROM songs WHERE COALESCE(availability,'available')='available'
-> [{id:1}, {id:3}]
```

**Blast radius:** no query change, no response change, both clients unaffected.
Cost is index maintenance on writes to `songs` (`setSongsAvailability`,
`rebuildAlbums`, scan evidence updates). On a local SQLite file this is
negligible relative to the read savings.

**Do not** drop the `COALESCE` instead — see section 4.

---

### 5.2 Cover-art resolution does 2–6 synchronous `fs` calls per song

**Where:** `Server/server.js:1431` `resolveSongCover()` and
`Server/media.js:59` `Media.resolveCover()`.

`resolveCover` probes five extensions with `fs.existsSync` + `fs.statSync`.
`resolveSongCover` probes the DB `cover_path` first, then falls back to
`resolveCover`, so a song without artwork costs up to 5–6 blocking syscalls.

Every list endpoint calls it **once per row**: `librarySongPayload:659`,
`/api/library:2881`, `/api/albums:2896`, `/api/home:2917`,
`/api/artists:2934`, `/api/trending:3138`, playlist and album detail.

**Benchmark** (5 000 real cover files, 7 500 lookups — 5 000 hits + 2 500 misses,
i.e. a library where some tracks have no art):

| Approach | Time |
|---|---:|
| Current: per-song `existsSync` + `statSync` loop | 463.1 ms |
| `readdir` once + in-memory `Map` | **9.4 ms** |
| Gain | **49.5× (~60 ms per 1 000 songs)** |

This blocks the event loop, so it also delays audio streaming and socket
emits while a large library renders.

**Fix:** build `Map<basename, { url, version }>` from one
`readdirSync(RT.paths.covers, { withFileTypes: true })`, serve lookups from it,
rebuild on invalidation.

**Correctness is the whole risk — the cache invalidation surface is exactly
these sites.** All of them must invalidate (or the cover keeps a stale `?v=`
until restart, which shows an old image, never a broken one):

| Site | What it does |
|---|---|
| `Server/server.js:603` `saveEmbeddedPicture` (called at `:1141`, `:1200`) | writes `<songUid>.<ext>` |
| `Server/server.js:3670` `/api/save-cover` | writes `<base>.jpg` |
| `Server/server.js:4295` playlist cover upload | writes `playlist_<id>.jpg` |
| `Server/server.js:5642` `/api/songs/:id/cover` | temp file + `renameSync` |
| `Server/server.js:4457` and `:5615` bulk delete | `unlinkSync` of cover files |
| `Server/downloads.js:1452` | writes downloaded artwork |
| `Server/media.js:144` `extractCoverArt` | writes extracted artwork |

Simplest safe implementation: a `invalidateCoverCache()` call at each site
above, plus a rebuild if the directory's own mtime changed (covers the
`Smart Auto Enrich` writers if one is ever added). Do **not** rely on a TTL
alone — the version query param is what busts browser caches.

**Note:** URL strings are unchanged (`/Static/covers/<name>?v=<mtime>`), so
no client change and no API contract change.

---

### 5.3 Auth runs two `SELECT *` per request, including the password hash

**Where:** `Server/auth.js:53` `getSessionUser` → `Server/database.js` `getSession`
(`SELECT * FROM sessions`); then `Server/server.js:1461` inside `requireRole` →
`HandleDatabase.getUser()` (`Server/database.js:775`), which is
`SELECT * FROM users`.

Every authenticated API request therefore loads the full user row — including
`password` (bcrypt hash), `settings`, `notifications`, `playlists`, `favorites`
— purely so the middleware can check `role`, `is_banned`, `timeout_until`.

This is on the hottest path in the app, and `/api/stream/:id` fires repeatedly
during seeking (`Server/server.js:3211`).

**Session lookup plan** (confirmed indexed, this part is fine):

```
EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE id = ?
-> SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (id=?)
```

**Fix, in increasing order of risk:**

1. Narrow the middleware query to an explicit column list. Every field read
   from `req.userRow` across the whole backend is exactly:
   `role, is_banned, timeout_until, allow_analytics, storage_used, total_likes,
   display_name, bio, email, created_at, username`.
   Nothing reads `password` from `req.userRow` — login fetches the row
   separately.
2. Collapse the two queries into one JOIN on `sessions.id`, filtered by
   `sessions.expires`, selecting only the columns above.
3. Optional: a short-TTL in-memory cache keyed by session id, invalidated on
   logout / role change / ban. Only worth it because of Range requests.

**Blast radius:** `/api/me` (`Server/server.js:2088`) reads `req.userRow`
directly and needs `display_name, bio, email, storage_used, total_likes,
role, is_banned, timeout_until, allow_analytics` — all present in the list
above, so behaviour is preserved. **Keep `getUser()` as `SELECT *`** for the
login path and define the narrow list as one exported constant so a future
route cannot silently receive `undefined`.

---

### 5.4 Five endpoints recompute the same library snapshot independently

**Where:** `/api/library:2881`, `/api/albums:2896`, `/api/artists:2934`,
`/api/home:2917`, `/api/search:2766`.

Each of these calls `getAllSongs()` (`Server/database.js:1599`) — a JOIN over
`songs` + `song_identifications` — and then rebuilds album summaries and the
artist index in JS (`summarizeAlbumsForUser:679`, `loadArtistIndex:866`,
`buildArtistIndex:832`). `/api/search` re-filters the entire library per query.

Only Home has a cache (`homeCache`, `Server/server.js:881`, 20 s TTL).

**The pattern already exists in the codebase:** `albumIndexDirty` +
`ensureAlbumsFresh()` (`Server/database.js:92-102`, `:1485`) is a
dirty-flag/rebuild cache done correctly, driven by a write hook
(`noteAlbumSourceWrite:99`).

**Fix:** extend that pattern to a versioned snapshot (songs, album summaries,
artist index) read by all five endpoints, invalidated by the same write hook.

**Why it is listed after the cheaper items:** this is the one change that can
introduce cross-endpoint staleness bugs. Do findings 5.1 and 5.2 first; if the
numbers are fine afterwards, this may not be needed at all.

---

### 5.5 `listen()` is blocked behind a synchronous full-library scan

**Where:** `Server/server.js:6153` `start()` → `await initializeServer()`
(`:237`), which awaits in order:

```
create*Table() ...  initializeConfig()  syncMusicDirectory()  (:257)
recalculateAllStorageUsed()  migrateLyrics()  recoverEnrichmentJobs()
Downloads.resume()  ensureAlbumsFresh()
```

`syncMusicDirectory` → `getMusicFiles:457` — a **recursive
`fs.readdirSync`** — then `indexMusicFile:1082`, which does `fs.statSync` per
file. The HTTP server does not bind until all of it finishes, so on a large
library the app is unreachable and the desktop window shows nothing.

**Two separable fixes:**

1. **Bind first, scan after.** The database already holds the previous scan's
   rows, so `/api/library` can serve correct-but-slightly-stale data
   immediately; the post-scan state is exactly what a rescan produces today.
   **Ordering constraint:** `initializeConfig()` / `app.locals.config` must run
   *before* `listen()` — the rate limiters (`Server/server.js` rate-limit block)
   and `maintenanceMiddleware` read `app.locals.config`.
2. **Async fs in the scanner.** `fs.promises.readdir` / `stat` instead of the
   sync variants. The tag backfill at `Server/server.js:624`
   (`backfillAlbumTagEvidence`) already yields correctly with `setImmediate`
   (`:649`) — copy that pattern.

**Related (subtle):** `updateSongScanEvidence` is an `UPDATE songs`, which
matches `ALBUM_SOURCE_WRITE` (`Server/database.js:95`) and marks the album
index dirty. Every cold start that touches evidence rows therefore forces a
full `rebuildAlbums`. The existing `albumRebuildContext` mechanism can suppress
this for evidence-only writes.
---

### 5.6 `rebuildAlbums` does one awaited `UPDATE` per changed song

**Where:** `Server/database.js` `rebuildAlbums`, inside the `BEGIN IMMEDIATE`
block, looping `await runQuery(musicDb, 'UPDATE songs SET ... WHERE id = ?')`
per changed row.

Each `runQuery` compiles and finalizes a statement and occupies the per-
connection FIFO queue (`Server/database.js:65-86`), so readers queue behind it.
A scan or enrichment job can stall `/api/stream` auth for seconds.

**Fix without changing semantics:** prepare the `UPDATE` once and reuse it in
the loop. Keep the existing "skip unchanged rows" comparison — that part is
already correct and is what keeps the loop small in steady state.

---

### 5.7 No prepared-statement reuse — lower value than it looks

**Where:** `Server/database.js:105-133` — `runQuery` / `getQuery` / `allQuery`
compile and finalize SQL on every call.

**Benchmark** (500 trivial reads):

| | Time |
|---|---:|
| Per-call prepare | 19.93 ms |
| Prepared + reused | 12.85 ms |
| Gain | 1.55× … but only **~14 µs per query** |

**Honest conclusion: this is <0.2 ms on a typical request and is not worth a
standalone task.** Do it only if already editing those helpers.

---

### 5.8 SQLite pragmas are minimal

**Where:** `Server/database.js` `configureDatabase()` — currently
`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
That is a sound baseline.

Candidates, all safe on a self-hosted single-process server:

```sql
PRAGMA cache_size = -16000;      -- 16 MB page cache
PRAGMA temp_store = MEMORY;      -- the temp B-tree in 5.11 lives in RAM
PRAGMA mmap_size = 268435456;    -- 256 MB memory-mapped I/O
```

Plus `PRAGMA optimize;` on shutdown. Measure before/after; on small libraries
this is noise.

---

### 5.9 Download progress writes twice per update

**Where:** `Server/downloads.js:1351` `reportProgress` → `Server/database.js:4581`
`updateDownloadItem`, which does `UPDATE download_queue ...` then
`SELECT * FROM download_queue WHERE id = ?`.

Progress is reported every ≤500 ms; socket emits are throttled to 700 ms
(`PROGRESS_EMIT_INTERVAL_MS`, `downloads.js:77`) but the **DB write is not**.
Both writes are on `musicDb` — the same connection the library reads use.

**Fix:** `UPDATE ... RETURNING *` (SQLite 3.52 supports it, halving the work),
and separate the DB write cadence from the socket emit cadence.

---

### 5.10 `VACUUM INTO` backup stalls the database

**Where:** `Server/database.js:3900` `backupDatabase` runs `VACUUM INTO` through
the same FIFO queue for all three databases; scheduled 3 s after boot
(`Server/server.js:287`) and every 24 h.

`VACUUM INTO` rewrites the whole database and holds the queue, so every query
waits. The 3 s-after-boot schedule coincides with the startup scan from 5.5.

**Fix:** use the online backup API (`Database#backup` / `db.backup()`) which
does not take an exclusive lock, or move the initial backup out of the startup
window.

---

### 5.11 `getSong(name)` uses `uid OR songname` → full scan + temp B-tree

**Where:** `Server/database.js:1304`.

```
EXPLAIN QUERY PLAN
  SELECT s.* FROM songs s WHERE (s.song_uid = ? OR s.songname = ?)
  ORDER BY CASE WHEN s.song_uid = ? THEN 0 ELSE 1 END LIMIT 1

-> SCAN s | USE TEMP B-TREE FOR ORDER BY
```

Numeric identifiers are fine (`SEARCH s USING INTEGER PRIMARY KEY (rowid=?)`).
The name path is a full scan on every play-by-name.

**Fix:** either a `songname` index, or (better) split into two queries —
`getSongByUid` first, then a name lookup with `LIMIT 1` — which also removes
the temp B-tree.

---

### 5.12 `/api/search` filters the whole library in JS

**Where:** `Server/server.js:2766`. Fetches every song, then `.filter()` with
`String(...).toLowerCase().includes(query)`.

O(n) per keystroke; masked by the 500 ms client debounce
(`Static/home/js/ui.js` search handler). Low priority unless the library is
large — at which point SQL `LIKE` with an index (`COLLATE NOCASE`) is the
natural step, and finding 5.4's snapshot makes it O(1) cache lookups.

---

### 5.13 Expired sessions are never pruned

Sessions expire after 30 days but rows are only deleted when *touched*
(`Auth.getSessionUser` deletes an expired session it happens to hit). There is
no `DELETE FROM sessions WHERE expires < ?` anywhere.

**Fix:** one line on the existing daily maintenance timer.
`idx_sessions_expires` (created at `Server/database.js:688`) already exists.

---

### 5.14 `listening_events` is unbounded

**Where:** `Server/database.js:4246` `getUserListeningEvents`; `/api/home`
(`Server/server.js:915` `buildHomePayload`) reads up to **5 000 rows** per
cache miss (20 s TTL).

Every playback writes a row and nothing prunes them. Over years this grows
without bound.

**Fix:** retention window (e.g. 12 months) on the daily maintenance timer, or
an aggregate table. Note Home already pulls only a 120-day window
(`since` in `buildHomePayload`), so a retention longer than that is invisible
to the product.

---

### 5.15 `/Static` cache headers — **already fixed during this session**

Originally recorded as a finding: `express.static` defaulted to `max-age=0`,
so versioned assets were revalidated on every load.

While this audit was being written, `Server/server.js:1269-1305` gained a
`setMediaCacheHeaders` policy: versioned / content-named media gets
`max-age=31536000, immutable`; reused-filename media (`avatars/<user>.jpg`,
`covers/playlist_<id>.jpg`, banners) gets `max-age=3600` + ETag.

**Left as a record** because the remaining question is worth a later check:
app JS/CSS is described in the comment as "unaffected (versioned with `?v=` in
home.html)", but they are served by the plain `staticOptions` handler, so they
still revalidate. They are `?v=`-versioned, so `immutable` would be safe there
too. Not verified in a browser.

---

## 6. Explicitly *not* recommended

| Idea | Why not |
|---|---|
| Replace `COALESCE` with plain equality | Section 4 — migrated tables can hold `NULL`; rows would disappear |
| Cache album summaries by TTL only | Content is derived from writes; TTL gives stale albums after enrichment. Use the dirty-flag pattern |
| Cache user rows without invalidation | Ban / timeout / role changes must take effect immediately |
| Cache by `req.user` alone in `homeCache` | Idempotent today (per-user), but any future shared/compiled data must be keyed by the snapshot version, not the user |
| Convert to a sync SQLite driver or add a thread pool | SQLite here is local-file I/O; the measured costs are scans and syscalls, both fixed by 5.1/5.2 without a rewrite |

---

## 7. Client / iOS impact assessment

All three clients share one server; `mobile/Static/` is a byte-identical copy of
`Static/`, so the iOS app runs the same JS against the same HTTP API.

For findings 5.1, 5.2, 5.6–5.14 the API contract is **unchanged**: same routes,
same JSON shapes, same URL strings. The only observable difference is latency.

For 5.3 (auth query), the change is internal to middleware; response bodies are
produced from the same fields (enumerated in 5.3).

Two client-side interactions to keep in mind:

1. **`/api/library` client timeout is 2 000 ms** (`Static/home/js/api_v2.js` —
   `setTimeout(() => controller.abort(), 2000)`). If the abort fires the client
   silently falls back to offline data — the symptom is *wrong* (offline
   banner, missing songs), not merely slow. This is the user-visible bug that
   findings 5.1/5.2 would prevent on large libraries.
2. **No client reads the `availability` field** (grepped `Static/` and
   `mobile/Static/`), so index work is invisible to both.

**Not verified:** no iOS build was run, and no browser profiling was done. The
statements above are about bundle parity and API contract, not runtime
behaviour on device.

**Reminder:** any client-side change must be followed by
`npm run mobile:sync`, or `npm run mobile:check` will report drift.

---

## 8. How to re-measure (copy-paste ready)

All three snippets below were executed as written on 2026-10-31 and produced
the quoted output. Absolute timings vary run to run and with machine load —
the **ratios** are the stable, meaningful part, and even those shifted
slightly on re-runs (7.8×→8.9× for the index, 49.5×→46.5× for covers). Treat
them as "large", not as precise. Run from the repository root.

### 8.1 Query plans (fast, no data needed)

```bash
node -e "
const s=require('sqlite3');
const q=(label,sql)=>{const d=new s.Database('Database/Dev/Music/music.db',s.OPEN_READONLY);
  d.all(sql,(e,r)=>{console.log(label+': '+(e?e.message:r.map(x=>x.detail).join(' | ')));d.close();});};
q('library join', \"EXPLAIN QUERY PLAN SELECT s.*, si.release_uid FROM songs s LEFT JOIN song_identifications si ON si.song_id=s.id AND si.is_current=1 WHERE COALESCE(s.availability,'available')='available'\");
q('song by uid/name', \"EXPLAIN QUERY PLAN SELECT s.* FROM songs s WHERE (s.song_uid=? OR s.songname=?) ORDER BY CASE WHEN s.song_uid=? THEN 0 ELSE 1 END LIMIT 1\");
"
```

Expect `SCAN s` before the fix and `SEARCH s USING INDEX idx_songs_availability_norm` after.

### 8.2 Expression-index benchmark (shows the 7.8× ratio)

```bash
node -e "
const s=require('sqlite3');const d=new s.Database(':memory:');
const N=10000;
d.serialize(()=>{
  d.run(\"CREATE TABLE songs (id INTEGER PRIMARY KEY, songname TEXT, artist TEXT, album TEXT, availability TEXT NOT NULL DEFAULT 'available', filepath TEXT)\");
  d.run('CREATE TABLE song_identifications (id INTEGER PRIMARY KEY, song_id INTEGER, release_uid TEXT, release_track_uid TEXT, artist_credit_json TEXT, method TEXT, source TEXT, confidence REAL, is_current INTEGER)');
  d.run(\"CREATE UNIQUE INDEX idx_i ON song_identifications(song_id) WHERE is_current=1\");
  const st=d.prepare('INSERT INTO songs (songname,artist,album,availability,filepath) VALUES (?,?,?,?,?)');
  for(let i=0;i<N;i++) st.run('Song '+i,'Artist '+(i%200),'Album '+(i%500), i%10===0?'missing':'available','/m/f'+i+'.flac');
  st.finalize();
  d.run('CREATE INDEX idx_songs_availability ON songs(availability)');
  const q=\"SELECT s.*, si.release_uid FROM songs s LEFT JOIN song_identifications si ON si.song_id=s.id AND si.is_current=1 WHERE COALESCE(s.availability,'available')='available'\";
  const time=(label,cb)=>{const t=process.hrtime.bigint();d.all(q,()=>{console.log(label,(Number(process.hrtime.bigint()-t)/1e6).toFixed(2),'ms');cb&&cb();});};
  time('scan(COALESCE)',()=>d.run(\"CREATE INDEX idx_avail_norm ON songs(COALESCE(availability,'available'))\",()=>time('expression index',()=>d.close())));
});
"
```

### 8.3 Cover lookup benchmark (shows the 49.5× ratio)

```bash
node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cov-'));const N=5000;
for(let i=0;i<N;i++) fs.writeFileSync(path.join(dir,'song'+i+'.jpg'),'x');
const exts=['.jpg','.jpeg','.png','.webp','.gif'];const names=[];
for(let i=0;i<N;i++) names.push('song'+i);
for(let i=0;i<N/2;i++) names.push('absent'+i);
let t=process.hrtime.bigint();
for(const n of names) for(const e of exts){const p=path.join(dir,n+e); if(fs.existsSync(p)){fs.statSync(p);break;}}
const a=Number(process.hrtime.bigint()-t)/1e6;
t=process.hrtime.bigint();
const m=new Map();for(const en of fs.readdirSync(dir,{withFileTypes:true})){const e=path.extname(en.name).toLowerCase();if(exts.includes(e))m.set(path.basename(en.name,e),en.name);}
for(const n of names) void m.get(n);
const b=Number(process.hrtime.bigint()-t)/1e6;
console.log('per-song fs:',a.toFixed(1),'ms | readdir+map:',b.toFixed(1),'ms | speedup',(a/b).toFixed(1)+'x');
fs.rmSync(dir,{recursive:true,force:true});
"
```

### 8.4 End-to-end (the one that actually matters)

The micro-benchmarks above are synthetic. To decide whether any of this is
worth doing, measure the real thing:

1. Point `Server/config.json` `music_directories` at the real library.
2. Start the server, sign in, capture a session cookie.
3. Time the endpoints that matter:

```bash
# repeat 5x cold (restart between) and 5x warm; watch for the 2 s client abort
curl -s -o /dev/null -w 'library  %{time_total}s\n' -b "session_id=$SID" http://localhost:4443/api/library
curl -s -o /dev/null -w 'home     %{time_total}s\n' -b "session_id=$SID" http://localhost:4443/api/home
curl -s -o /dev/null -w 'albums   %{time_total}s\n' -b "session_id=$SID" http://localhost:4443/api/albums
curl -s -o /dev/null -w 'artists  %{time_total}s\n' -b "session_id=$SID" http://localhost:4443/api/artists
curl -s -o /dev/null -w 'search   %{time_total}s\n' -b "session_id=$SID" 'http://localhost:4443/api/search?q=a'
```

4. Time a seek sequence (`/api/stream/:id` with `Range: bytes=...`) — this is
   the path that compounds auth cost (5.3).
5. Time **cold start to first successful `/api/library`** — the metric for 5.5.

Decision rule suggested by the measurements: under ~1 000 songs, only 5.5
(startup) is likely to be felt. Above that, 5.1 and 5.2 are the best
risk-adjusted wins.

---

## 9. Suggested implementation order

1. **Measure** using 8.4 against the real library.
2. **5.1 + 5.2 together** — expression index and cover map. Best
   risk-adjusted gain, no response changes. Wire all seven invalidation sites.
3. **5.5** — listen before scanning. Biggest *felt* improvement, but respect
   the `app.locals.config`-before-`listen` ordering constraint.
4. **5.3** — narrow auth columns (+ JOIN). Small per request, but it is on
   every Range request, so it compounds.
5. **5.6, 5.9, 5.10, 5.13, 5.14** — maintenance hygiene; low risk, do together.
6. **5.4** — shared snapshot cache. Only if steps 2–4 leave numbers that
   justify it; it is the only item with a real staleness-bug risk.
7. **5.7, 5.8, 5.11, 5.12** — opportunistic; fold into other work.

---

## 10. Caveat on line numbers

`Server/server.js` grew from ~6 256 to ~6 300 lines during the analysis, so
earlier notes in this session carried different numbers. **Every reference in
this document was re-verified against the tree as of 2026-10-31** (a few are
marked `~` where the surrounding block shifted). If lines drift again, search
by the named function or symbol (all are quoted above) rather than by number.

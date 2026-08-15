# Streamify Polishing Update

Date: 2026-08-15

Status: implementation complete, manual runtime verification pending

This document records the stability, security, offline, performance, and
platform work completed before the next major product update. The application
was not launched during this pass because verification was explicitly reserved
for manual testing and startup modifies databases, caches, and the music index.

## 1. Scope And Guardrails

- Preserve the existing visual design and active user-facing behavior.
- Fix unintended security, privacy, race, offline, and state-management bugs.
- Make music-directory configuration and rescanning Owner-only.
- Keep current multi-account functionality during this polishing release.
- Treat a clean/fresh schema as the supported baseline.
- Require Node.js 22.12 or newer.
- Remove or stop loading only features already retired and unreachable.
- Defer the Owner/Member household model changes to a later product update.

The later household update remains separate because invitations, timed
registration, removing playlist sharing, and simplifying roles are deliberate
functionality changes rather than polishing fixes.

## 2. Backend Security

### Media And Library Authorization

- Removed the unauthenticated `/MusicLibrary` static mount. Audio is served
  through authenticated `/api/stream/:id` requests.
- Added one song-access policy used by search, library, playback, streaming,
  playlist insertion, playlist reads, and playlist cloning.
- Prevented private songs from being inserted into another user's playlist and
  exposed by publishing that playlist.
- Filtered private song metadata from users who do not own it.
- Kept folder-managed songs shared with all approved accounts.
- Represented folder-managed songs as shared-library/public records instead of
  attributing them to the hardcoded `lwitchy` username.
- Prevented Streamify deletion endpoints from deleting folder-managed source
  files. Those files must be removed from their source folder and rescanned.
- Restricted music-directory reads, writes, and rescans to the Owner role.
- Hid folder configuration and rescan controls from non-Owners.

### Accounts And Sessions

- Serialized first-account registration with an immediate SQLite transaction.
- Added case-insensitive unique usernames for fresh schemas.
- Added server and client username validation: 3-32 letters, numbers,
  underscores, or hyphens.
- Restricted first-Owner creation to loopback/localhost to prevent LAN setup
  claiming.
- Automatically disables registration after the first Owner is created.
- Reserved deleted usernames so a newly created account cannot inherit old
  sessions, private records, or browser offline caches.
- Invalidated sessions and account-owned personal data when deleting a user.
- Removed session tables from the generic admin database browser and marked
  database-browser responses as non-cacheable.
- Made bcrypt hashing and comparison asynchronous to avoid blocking the Node
  event loop.
- Applied the registration password policy to password changes and bounded
  password input length.
- Reset expired in-memory login blocks instead of immediately re-blocking the
  next failed attempt.
- Derived cookie security from the actual trusted transport. Same-origin
  sessions use `SameSite=Lax`; explicitly approved HTTPS cross-origin clients
  use `SameSite=None; Secure`.

### Request And Electron Boundaries

- Disabled implicit proxy trust. Reverse proxies must be configured explicitly
  with `STREAMIFY_TRUST_PROXY`.
- Rejected browser origins unless they exactly match the current request origin
  or an explicit `FRONTEND_URL` entry.
- Added baseline MIME sniffing, frame, referrer, and permissions headers.
- Retired remaining YouTube downloader endpoints with HTTP 410 responses.
- Restricted remote cover downloads to bounded HTTPS hosts, redirects, content
  types, response sizes, and timeouts.
- Re-encoded uploaded song covers instead of publishing arbitrary bytes with a
  `.jpg` extension.
- Decode, validate, stage, and atomically replace avatars and profile banners so
  a malformed upload does not delete the previous image.
- Electron now compares parsed origins exactly rather than using URL prefixes.
- Electron rejects unexpected navigation, popups, webviews, protocols,
  permissions, and unauthorized IPC senders.
- The phone-connect window now uses a smaller dedicated preload bridge.

## 3. Backend Reliability And Data

- Database initialization, configuration loading, migrations, initial music
  synchronization, storage recalculation, and lyrics migration now complete
  before the HTTP server reports readiness.
- Initialization failures now fail startup instead of leaving a partially ready
  server.
- Music scans are single-flight, preventing overlapping scans in one process.
- Added unique filepath protection and supporting query indexes.
- Failed/unavailable roots are no longer treated as empty roots during cleanup.
- Empty directory configuration can no longer delete every folder song.
- Enabled SQLite foreign keys, WAL, normal synchronization, and a busy timeout
  on every connection.
- Fixed the SQLite playlist `share_id` upgrade sequence by adding the column,
  filling values, and creating a unique index separately.
- Added standards-safe single byte-range handling, `416` responses, clamping,
  stream errors, and disconnect cleanup.
- Removed audio range requests from the generic JSON API rate-limit budget.
- Added `year` to library/playback metadata so unrelated edits do not erase it.
- Added a shared cover resolver that respects AI-selected `cover_path` values.
- Made maintenance-mode PWA assets available and removed the normal-user
  maintenance redirect loop.
- Consolidated duplicate global error handlers and stopped returning production
  exception details.
- Corrected custom-port startup URLs and banners.
- Graceful shutdown is now one idempotent promise, waits for initialization,
  clears maintenance timers, closes active connections, checkpoints all
  databases, attempts every close even after checkpoint failure, and reports
  aggregate failures.
- Electron now routes tray, normal app quit, and operating-system quit through
  the same shutdown path.

## 4. Frontend Stability And Security

- Replaced unsafe lyrics and smart-metadata HTML insertion with text/DOM
  construction and validated image URLs.
- Added stale request cancellation or sequence guards for rapid playback,
  search, lyrics search/selection, cover lookup, profile loading, edit-song
  loading, AI review, and playlist detail requests.
- Fixed direct `/profile/:username` and `?playlist=` navigation being replaced
  by the default library route.
- Fixed stale search results replacing the active library playback context.
- Cleared playlist songs, actions, owner state, shuffle state, and download
  actions before loading another playlist or showing an error/empty state.
- Used canonical numeric playlist IDs for mutations opened from share links.
- Reused one current-user promise and waited for account-scoped offline storage
  before ownership-sensitive startup routing.
- Restored toast notifications by creating the existing toast host on demand.
- Prevented OOBE from advancing or reporting success after failed writes.
- Limited OOBE filesystem setup to the Owner.
- Unified avatar/banner cropper ownership and teardown.
- Fixed playback controls being updated before the media element actually
  played or paused.
- Handled rejected play promises, media errors, and end-of-queue state.
- Fixed zero volume restoring as 70 percent.
- Separated telemetry reporting intervals from the 30-second play threshold.
- Released lyrics wake locks on every player exit and page hide.
- Preserved the current song when shuffle state changes or lists rerender.
- Corrected lyrics edit/search state, playlist owner propagation, and Unicode
  metadata cleaning.
- Finalized batch playlist controls after partial request failures.
- Reverted analytics UI/cache state when its server update fails.
- Fixed profile fallback routing, profile render tokens, malformed markup, and
  the special 404 page loading incompatible application code.
- Added local keyboard semantics and labels to selected controls without
  changing their visual presentation.

## 5. Offline And PWA

- Moved `/api/stream/:id` handling before generic API passthrough in the service
  worker.
- Served valid single Range requests directly from downloaded full responses,
  including large media, without buffering the complete file for every seek.
- Completed the app-shell precache with active home styles, scripts, fonts,
  icons, and vendor assets.
- Added offline navigation fallback for profile/deep-link routes.
- Bound runtime cache writes to the service-worker event lifetime.
- Updated the shell cache to `streamify-app-shell-v49` and changed frontend
  script query markers to `4.20`.
- Replaced the obsolete avatar cache name.
- Removed the unscoped legacy media cache instead of assigning it to whichever
  account signs in first.
- Namespaced IndexedDB records and media caches by normalized username.
- Prevented deleted usernames from being reused, preserving cache isolation.
- Waited for IndexedDB transaction completion and surfaced transaction, quota,
  blocked-upgrade, and storage failures.
- Memoized database initialization.
- Added direct single-song lookup/deletion rather than reading every offline
  record.
- Rolled back cached media when cover or metadata persistence fails.
- Waited for offline account state to clear before redirecting on logout.

## 6. Performance

- Added gzip/Brotli-capable Express compression for text and JSON responses.
- Replaced per-row IndexedDB transactions with one downloaded-ID snapshot per
  library or playlist render.
- Added lazy loading and asynchronous decoding to song-row artwork.
- Cancelled stale lyrics, cover, search, and playback network work.
- Removed the repeating no-op logo timer and forced layout.
- Limited lyrics interaction timers to the lyrics scroller.
- Animation-frame throttled desktop artwork tilt and cached its layout bounds.
- Cleaned cropper instances and retained image sources.
- Stopped loading the retired upload client at home startup.
- Removed the broken retired Upload PWA shortcut.
- Changed the special 404 page to fetch only its selected random image rather
  than all eight images.
- Added database indexes for usernames, sessions, song ownership/source,
  filepath, and playlist-song lookups.

## 7. Packaging And Configuration

- Added `compression` as a runtime dependency.
- Declared Node.js `>=22.12.0` in package metadata.
- Enforced Node.js 22.12 in desktop, server, and installer batch launchers.
- Removed the unconditional Electron-builder `postinstall`; native rebuilds are
  explicit through `npm run rebuild`.
- Aligned `package.json` with the repository MIT license and included LICENSE in
  the packaged application.
- Updated reverse-proxy, CORS, first-Owner, and Node requirements in public
  documentation.
- Kept installer signing, updater delivery, and Electron fuse hardening outside
  this behavior-preserving pass.

## 8. Static Verification Completed

The following non-runtime checks were completed successfully:

- `node --check` for modified server modules.
- `node --check` for modified home, login, service-worker, and Electron scripts.
- JSON parsing for package manifests, PWA manifest, and example configuration.
- `npm ls --depth=0` dependency-tree validation.
- `npm install --package-lock-only --ignore-scripts` lockfile synchronization.
- npm dependency audit reported zero known vulnerabilities.
- Service-worker app-shell references and versioned home assets were checked.
- `git diff --check` completed without whitespace errors; Git only reported the
  repository's existing LF-to-CRLF checkout warnings.

## 9. Required Manual Verification

### Fresh Setup And Accounts

- Start with an isolated empty data directory.
- Confirm remote LAN Owner registration is rejected.
- Create the first Owner through localhost/Electron.
- Confirm registration closes after Owner creation.
- Open registration and create two normal users.
- Confirm deleted usernames cannot be registered again.
- Test login, logout, password change, session revocation, and user deletion.

### Library And Privacy

- Configure one and multiple music roots as Owner.
- Confirm non-Owners cannot view/change roots or invoke rescans.
- Temporarily make one root unavailable and confirm its songs are not pruned.
- Confirm folder songs appear shared to all approved users.
- Confirm private legacy songs remain visible/streamable only to their owner.
- Attempt to add an inaccessible song ID to a playlist and expect rejection.
- Confirm direct `/MusicLibrary/...` URLs no longer expose files.

### Playback And Frontend

- Test MP3, FLAC, WAV, M4A, OGG, and WebM playback where available.
- Test no Range, open-ended Range, suffix Range, seeking, malformed Range, and
  beyond-end Range behavior.
- Rapidly select songs, search and clear, switch views, open profiles, and open
  metadata/lyrics modals; stale results must not replace current state.
- Test play rejection, pause, queue end, shuffle, repeat, volume zero, EQ,
  MediaSession controls, telemetry, and lyrics wake-lock release.
- Verify desktop and mobile screenshots against the pre-update design.

### PWA And Offline

- Clear site data, load once, install the worker, close, go offline, and reopen.
- Download MP3 and large FLAC tracks, then play and seek while the server is
  unavailable.
- Interrupt a download and simulate low quota; no success state or orphan cache
  entry should remain.
- Log out from account A, log in as account B, and confirm A's downloads,
  profile, and playlists are unavailable.
- Test worker upgrade from the previous cache and verify shell version 49.

### Electron And Deployment

- Test normal window close-to-tray, tray Quit, normal app Quit, and OS shutdown.
- Test startup failure, port conflict, renderer crash logging, and reopen.
- Test rejected remote/prefix/user-info/custom-protocol navigation.
- Test the folder picker only from the trusted main window.
- Test direct LAN HTTP, LAN HTTPS, and a configured reverse proxy/tunnel.
- Build from a clean clone and inspect the packaged LICENSE, preload files,
  native modules, static assets, and writable data paths.

## 10. Deferred Work And Residual Risks

- Runtime and device verification remains manual and is not claimed complete.
- Legacy databases containing duplicate case-insensitive usernames or duplicate
  song filepaths are not automatically reconciled. A clean schema is the
  supported baseline for this update.
- Retired social/import implementations still exist physically in some server
  and client files, but their routes are tombstoned and the upload client is no
  longer loaded. Full deletion should be a separate reviewed cleanup.
- Socket.IO remains installed even though the active home client does not load
  it.
- Folder covers still use basename fallback and can collide when different
  directories contain identically named audio files without explicit
  `cover_path` metadata.
- Very large collection virtualization and GPU/backdrop changes were not made
  because they require profiling and could alter scrolling or appearance.
- CSP remains deferred because the current HTML contains inline handlers and
  styles. Baseline security headers are active.
- Installer signing, automatic updates, and Electron fuse hardening remain
  release-engineering tasks.
- The future household model will introduce Owner/Member roles, one-use
  invitations, a 15-minute registration window, private per-account playlists,
  and removal of playlist sharing as a separate product update.

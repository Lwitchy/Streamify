# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - YouTube Acquisition Removal - 2026-08-17

### Changed

- Get Music now acquires audio exclusively through Soulseek. Spotify remains a
  tracklist source and resolves each item through Soulseek.
- Discord Rich Presence now offers five artwork policies: always use the app
  logo, stored/public only, exact YouTube title/version/duration matching,
  Apple Music only, and exact YouTube with an Apple fallback. Successful matches
  are cached for 30 days and uncertain matches use the Streamify logo.
- The Owner can continue to provide a public HTTPS Streamify URL so Discord can
  display exact embedded and uploaded covers without an online lookup.

### Removed

- Removed YouTube search and download from Get Music, including pasted YouTube
  links, cookie authentication, media extraction, MP3 conversion and fallback
  acquisition for Spotify imports.
- Unfinished legacy YouTube queue rows are retired on startup and cannot be
  retried. Completed songs, historical queue records and trusted thumbnail URLs
  remain available.

## [Unreleased] - Desktop Auto-Update - 2026-08-16

### Added

- The desktop app now checks its GitHub releases for a newer version, downloads
  it in the background and installs it the next time Streamify quits. A
  **Restart and install** button applies it immediately.
- Added **Settings → Updates** (desktop only): installed version, check status,
  download progress, release notes, and a manual **Check now**.
- Added an Owner-only switch for automatic checks. It is server-wide rather than
  per-device, because the Owner is the only person on a self-hosted box who can
  actually apply an update. Stored as `system_config.auto_update_enabled` and
  changed through `POST /api/settings/updates`; existing installs default to on.
- Added `npm run release` / `npm run release:linux`, which upload the installer
  together with the `latest.yml` manifest that installed clients read. The
  release is created as a draft; press **Publish release** on GitHub once every
  asset has finished uploading.

### Changed

- Builds that cannot replace themselves now say so instead of failing a check:
  deb and tar.gz are left to the package manager, the portable exe has no
  install root, and macOS builds are unsigned.

### Removed

- Removed the **Beta Info** page and its sidebar entry. It carried a hardcoded
  version string that had been wrong since 0.2.0; `/home#about` now falls back
  to the library.

## [Unreleased] - Player Motion Performance - 2026-08-16

Detailed engineering notes and the manual verification checklist are available
in [`MD Files/Engineering/PLAYER_TRANSITION_PERFORMANCE.md`](MD%20Files/Engineering/PLAYER_TRANSITION_PERFORMANCE.md).

### Performance

- Kept the desktop dedicated player mounted as a retained fixed compositor layer,
  trading a bounded amount of GPU memory for smooth repeated open/Back transitions.
- Preserved the existing 500ms section entrance, 800ms blur entrance, 300ms shell
  motion, routed-page return animations, and lyric spring timing.
- Replaced per-frame sidebar margin and top-bar width animation with one layout
  commit followed by FLIP transforms and opacity.
- Kept the routed library/playlist/profile/search section mounted and inert beneath
  the player so Back no longer rebuilds its visual layers.
- Replaced continuous desktop lyric polling with next-line scheduling and skipped
  filtered rasterization for lyrics outside the visible depth stack.
- Added library render batching, offscreen row containment, cover decode/tint
  prewarming, deferred non-critical startup work, and GPU feature diagnostics.
- Added a first-library paint gate that builds rows while hidden, decodes
  first-viewport covers, and primes retained layers before resuming the original
  entrance animations. Remaining rows and background services start after that
  motion, so cold-start work stays bounded as libraries grow.
- Avoided hashing unchanged audio files and recalculating normal storage totals from
  filesystem stats on every launch.

### Fixed

- Removed the large blank band above the first desktop lyric lines while preserving
  centered spring scrolling once enough preceding lyrics exist.
- Removed repeated first/reopen hitches caused by destroying the player, blurred
  footer, and routed-page layers with `display:none`.

### Branding

- Standardized the Streamify wordmark on home, startup, login, locked-login,
  admin, maintenance, diagnostics, and special-error pages using the bundled
  Plus Jakarta Sans variable font, with context-specific sizing and tracking.
- Matched the cold-start splash to the login intro: centered animated-gradient
  wordmark with the same one-second upward blur and scale transition.

## [Unreleased] - Get Music Update - 2026-08-15

### Get Music (Owner only)

- Added a **Get Music** page that searches Soulseek and YouTube side by side and
  downloads straight into the configured music library.
- Added Soulseek (P2P) search with quality-aware ranking across free slots, queue
  length, filename relevance, container, bitrate and peer speed.
- Added YouTube search and download through yt-dlp, converted to MP3 with the
  thumbnail and metadata embedded in a single pass.
- Added pasted-link support for YouTube tracks and for Spotify playlists, albums
  and tracks. Spotify is used as a tracklist only; no audio comes from Spotify.
- Added a persistent, resumable download queue with per-item stages, cancel,
  retry, cancel-all and clear. Transfers interrupted by a crash or restart are
  requeued instead of lost.
- Added live queue progress over Socket.IO, with polling as a fallback when the
  socket cannot connect.
- Downloads are saved to `Streamify Downloads` inside the first configured music
  directory, then indexed by the normal library scanner.
- Cover art is embedded into the file itself, so artwork survives moving,
  renaming or backing up the track, and needs no scanner special-casing.
- Nothing is ever queued without confirmation. Picking a search result, pasting a
  YouTube link or importing a Spotify album all open a confirmation dialog first,
  previewing the track (or tracklist) and its quality before anything downloads.
- Source status is shown only when it needs attention: a single card prompting
  for a Soulseek account, and nothing at all once it works. The Soulseek tab,
  panel and search request are dropped entirely when no account is configured,
  rather than presenting a source that cannot return anything.
- Added a **Downloads** tab in Owner Settings for the Soulseek account, with a
  connection test and an explanation of what connecting to the P2P network
  actually does.
- Added `npm run test:downloads`, `test:downloads-ui`, `test:downloads-security`
  and `test:wiring`.

### Fixed

- YouTube downloads failed with `HTTP 403: Forbidden`. yt-dlp now receives the
  running Node interpreter for JavaScript challenges, no longer gets a forced
  User-Agent that breaks its client pairing, and retries extraction with a fresh
  signed media URL when a rotating public IP invalidates the first one. Searches,
  metadata, and transfers also share the same request cooldown, and AAC/M4A is
  preferred before falling back to another available audio representation.
- Electron now trusts the app's own self-signed certificate for its matching
  `wss://` endpoint as well as HTTPS, restoring Socket.IO without weakening the
  certificate exception for any other host or port.
- YouTube downloads now retain the exact public thumbnail applied to the file,
  so Discord Rich Presence can show it without access to Streamify's LAN URL.
  Trusted thumbnails are also recovered for downloads completed before the fix.
- Extracted single-file indexing out of the library scan loop so a finished
  download joins the library immediately instead of forcing a full rescan.

### Security

- Soulseek credentials are excluded from every configuration API response.
  `initializeConfig()` bulk-loads all `system_config` rows into
  `app.locals.config`, which `GET /api/admin/config` returns to Admins, so any
  new secret stored there was exposed by default. Secret keys are now stripped
  centrally in both `initializeConfig()` and `safeSystemConfigResponse()`.
- All download and download-settings routes are Owner-only, matching the existing
  restriction on music directories and rescans.
- Download progress is broadcast to a role-scoped socket room resolved from the
  database at handshake, never from client-supplied data.
- Only YouTube URLs are passed to yt-dlp. An unvalidated queue entry could
  otherwise have reached the generic extractor and been used to probe internal
  addresses or ingest local files.
- Artwork is fetched only from an allowlist of YouTube and Spotify image hosts,
  with the allowlist re-checked on every redirect, plus size, redirect-depth and
  content-type limits.
- Certificate verification is enabled for all yt-dlp traffic.
- Streamify's own secrets are stripped from the environment passed to yt-dlp.
- The Soulseek password is never returned to the browser.

### Removed

- Retired the superseded uploader-era downloader: the old Soulseek helper, the
  `/api/youtube-*` handlers and the `/api/import/spotify` background importer.
  They wrote into `MusicLibrary/uploads` under per-user storage quotas, which no
  longer matches the folder-library model, and their second Soulseek client
  would have fought the new one over `slsk-client`'s module-level singletons.
  The retired endpoints continue to return HTTP 410.

## [Unreleased] - Polishing Update - 2026-08-15

Detailed engineering notes and the manual verification checklist are available
in [`MD Files/Engineering/POLISHING_UPDATE.md`](MD%20Files/Engineering/POLISHING_UPDATE.md).

### Smart Auto Enrich

- Replaced the old single-score matcher with Unicode-aware title, artist-credit,
  featured-artist, duration, version, album-context and provider-agreement evidence.
- Added strict handling for live, remix, edit, acoustic, instrumental, demo,
  remaster, sped-up and slowed versions.
- Added optional Owner-configured Chromaprint/AcoustID identification with
  MusicBrainz and Apple text fallback.
- Added OOBE and Owner Settings choices for local-only, text-only, or acoustic
  identification. Source audio is never uploaded or modified.
- Added pinned `fpcalc` builds for Windows, Linux and macOS with checksum-based
  retrieval, ASAR unpacking and runtime override support.
- Added stable song/recording/release/artist identities, metadata provenance,
  external identifiers, field locks, revisions and soft file availability.
- Added persisted, resumable Owner-only enrichment jobs with pause, cancel,
  idempotent decisions and optimistic conflict protection.
- Redesigned the review popup with evidence, provider status, per-field safety,
  release alternatives, cover staging and explicit unknown/error states.
- Kept ambiguous album/year/cover values unchecked by default while allowing an
  explicit Owner choice; selecting a Release card also records its canonical ID.
- Changed metadata locks to protect against automatic overwrite without blocking
  explicit Owner-approved corrections.
- Removed unreviewed browser/server iTunes cover guessing and retired unsafe
  direct/batch enrichment application routes.
- Added 24 deterministic metadata/fingerprint/provider tests.

Full details: [`SMART_AUTO_ENRICH_UPDATE.md`](MD%20Files/Engineering/SMART_AUTO_ENRICH_UPDATE.md).

### Added

- Account-scoped offline metadata and media caches.
- Offline Range streaming for downloaded MP3/FLAC and other supported audio.
- Response compression for HTML, CSS, JavaScript, and JSON.
- Explicit Node.js 22.12 minimum and launcher checks.
- Baseline security headers and explicit reverse-proxy trust configuration.

### Fixed

- Private-song access through public playlists and direct static music paths.
- Concurrent first registration, duplicate usernames, and remote LAN Owner claiming.
- Startup readiness, overlapping music scans, failed-root pruning, and shutdown completion.
- Malformed and unsatisfiable audio Range requests.
- Direct profile/playlist routing and stale playback, search, lyrics, profile, AI, and modal requests.
- Player play/pause state, queue end, shuffle, zero volume, telemetry thresholds, and lyrics wake locks.
- Empty/error playlist state retaining actions or songs from a previous view.
- Offline downloads reporting success before IndexedDB transactions committed.
- Offline account data being visible after switching users.
- Maintenance mode intercepting PWA assets and redirecting normal users in a loop.
- AI-selected covers being saved but ignored by library/playback responses.
- Avatar, banner, and cover replacement deleting valid files before replacement validation.

### Security

- Music directories and rescans are now Owner-only.
- Admin database browsing no longer exposes live session tokens.
- Lyrics and smart-metadata DOM injection paths were removed.
- Electron navigation and IPC now require exact trusted origins.
- Browser origins are same-origin by default or must be listed explicitly in `FRONTEND_URL`.
- Deleted usernames are reserved to prevent account/session/offline-data inheritance.
- Retired downloader endpoints now return HTTP 410.

### Performance

- Download status uses one IndexedDB read per rendered collection instead of per row.
- Song artwork uses lazy loading and asynchronous decoding.
- Stale cover, search, lyrics, and playback requests are cancelled.
- Removed a no-op forced-layout timer and animation-frame throttled artwork tilt.
- The retired upload client is no longer loaded at startup.
- The special 404 page downloads only its selected image.

### Changed

- Folder-managed songs are represented as one shared library rather than being attributed to a hardcoded user.
- Folder-managed source files cannot be deleted through Streamify APIs.
- The retired Upload PWA shortcut was removed.
- Native Electron dependency rebuilding is explicit through `npm run rebuild` instead of an install-time hook.
- Project package metadata now matches the MIT license.

### Verification

- Static JavaScript syntax, JSON manifests, direct dependencies, lock metadata, and app-shell references passed.
- npm reported zero known dependency vulnerabilities.
- Runtime, browser, device, offline, and packaged-app verification remains manual by request.


## [0.2.1] - Feature Updates - 2026-04-19

### Added
- Playlists, Lyrics
- Added PWA Back
- Ability to download tracks from YouTube, Import Playlists from other Services
- Downloads using Soulseek


### Fixed
- UI Bugs

## [0.2.0] — Backend Migration & Client Refactor — 2026-04-17

### Added
- Node.js backend migration using Express, fluent-ffmpeg, and sqlite3.
- Client-side JavaScript split into five focused modules loaded in order:
  - `config.js` — shared state, cache store, and constants
  - `player.js` — full audio engine (playback, seek, volume, MediaSession)
  - `api.js` — all `fetch` network calls and DOM render helpers
  - `upload.js` — upload form interception, confirmation modal, XHR progress
  - `ui.js` — DOMContentLoaded init, sidebar nav, modals, search, and logout
- One-shot morphing logo reveal: sidebar brand name materialises from a blurred state using a pure CSS `@keyframes morphReveal` animation, then stays permanently.
- Proper `POST /logout` handler in the client (`ui.js`) — fires `fetch POST` and redirects to `/login` on success, with a fail-safe fallback redirect.
- Notification System which uses Web Sockets
- Now Streamify uses cookies to authenticate users
- Added beta disclaimer
- Biographies
- Display usernames, Unique Usernames
- Crop feature for Avatars
- Editing song library (Cover, Track name, Artist name, Album name etc..)
- Feed Page (Now users can send posts, comment, like the posts)
- Database Backups (Automatically)

### Fixed
- **`Cannot GET /logout`**: logout link was sending a `GET` request; server only registered `POST /logout`, causing a 404. Fixed by intercepting the click and using `fetch`.
- Bunch of exploits are fixed including HTTP Injections
- Fixed the bug where settings modal wasn't scaled properly for mobile users, using Hamburger menu for mobile users
- Already Authenticated users was seeing /login page instead of redirected to /home


### Changed
- Sidebar logo replaced: removed the SVG bar-chart icon and animated text; replaced with a single gradient `morph-text` element.
- Rate limit updated to 100 API requests per minute (previously 60).
- Upload redirect now targets `/home` server route instead of a static HTML path.

### Removed
- Python backend server (`main.py`)
- Python Media / DB Logic modules
- Cloudflare Turnstile Captcha verification
- Monolithic `home-api.js` (1490 lines) — archived as `home-api.js.bak`
- E-Mail requirement when logging in

## [0.1.1] Polishing Update
### Added
- Profiles feature (You can get details of specific profile)
- Notifications feature (Not fully done yet)
- Fixed various bugs & Cleaned up codebase
- Compressions for Avatars & Songs
- Private/Public songs (User can save songs privately other people won't see it)
- Added caching system to Music Lists which fixes the bug where when you switch between (Home/Library), The songs on Library shows up on Home page for a second 
- Added caching system to Profile and People page, which reduces load on backend
- Added ratelimit for API calls, 60 API requests per Minute 


### Known Issues
- Even with caching, if caching timeout is ended and when you click Home/Library pages too fastly for a second songs get mixed up 


### Changed
- Completly rewrote the codes for uploading songs


## Removed
- PWA (for now because it was unstable)

## [0.1.0] Initial Release

### Added
- Initial project setup
- User authentication and registration
- User profile with avatar support
- Search Feature
- PWA support with offline capability
- Session management

### Known Issues
- No File Size, Extension Validation on Uploads


## How to Update

### From Command Line
```bash
git pull origin main
```

### Manual Update
1. Download the latest release
2. Backup your `Database/` directory
3. Replace the code files (keeping your Database folder intact)
4. Install Node.js 22.12 or newer and run `npm install`
5. Restart the application

## Version History

| Version | Release Date | Status | Notes |
|---------|-------------|--------|-------|
| 0.1.0 | 2025-12-07 | Beta | Initial release |
| 0.1.1 | 2025-12-17 | Beta | Polishing update |
| 0.2.0 | 2026-04-17 | Beta | Node.js Backend Migration |
| 0.2.1 | 2026-04-19 | Beta | Feature Update |

## Future Roadmap

### Planned Features
- [ ] Custom themes
- [ ] A suggestion tab



### Performance Improvements
- [X] Database query optimization
- [X] Optimizing server for weak CPUs


### Security Enhancements
- [ ] Enchanced logging
- [X] Database Backups

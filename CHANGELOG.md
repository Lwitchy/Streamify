# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

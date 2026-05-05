# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


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
4. Update Python dependencies: `pip install -r requirements.txt`
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
- [ ] Alternative to upload songs, using Youtube/Spotify links to add songs directly onto your library
- [ ] Badges when new post appears in Feed
- [ ] Catergories in feed (Top liked, Newest, Oldest)
- [ ] Hyerarchy in comments, ability to reply to comments, like comments
- [ ] Ability to edit posts, comments
- [ ] Music playlists
- [-] User statistics and analytics
- [ ] Custom themes
- [ ] Equalizer
- [ ] Tagging People in Feed
- [ ] Private DMs
- [ ] Sending GIFs on Feed
- [ ] Lyrics with LRCLIB or some other API
- [ ] Android App
- [ ] Auto moderation? (for usernames)
- [ ] A suggestion tab
- [ ] Sharing short clips of songs in the feed
- [ ] Ability to share songs with eachother



### Performance Improvements
- [X] Database query optimization
- [X] Optimizing server for weak CPUs


### Security Enhancements
- [ ] Enchanced logging
- [X] Database Backups
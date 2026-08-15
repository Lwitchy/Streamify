# Streamify Personal Music Player Migration Report

**Date:** 2026-07-22  
**Repository:** Streamify  
**Migration direction:** Social music application -> self-hosted personal music player  

---

## Executive Summary

Streamify has been converted from a social media hybrid music app into a **self-hosted personal music player**. The home experience now focuses entirely on your local music library, playlists, audio playback, synced lyrics, account settings, and personal telemetry.

Music is indexed directly from single or multiple local server directories into the SQLite songs database. This preserves track IDs, metadata, playlist memberships, lyrics, album art, and listening telemetry while making local files immediately streamable.

Authentication is retained to protect self-hosted deployments over local networks, VPNs, reverse proxies, or the internet. System ownership is assigned automatically to the first registered account, and registration locks by default to safeguard fresh installations.

---

## Work Completed From The Start

### 1. Removed Social Navigation and Active UI

The main interface shell was re-architected to hide all social features:

- **Removed/Hidden Surfaces**:
  - Feed navigation and Feed as the landing view
  - Feed post creation controls, filter tags, and pagination
  - People navigation and user listing section
  - Direct Messages navigation and chat interface
  - Notification bell, badge count, and notification dropdown
  - Post detail section and Feed photo crop modal
  - Upload link from the sidebar menu

- **Your Library** (`/home` and `/home#library`) is now the default landing view.

- **Active Surfaces Retained**:
  - Your Library
  - Playlists
  - Audio playback footer and full player screen
  - Synced & static lyrics
  - Track & artist search
  - Profile metadata & settings controls
  - Offline music library support (PWA/IndexedDB)
  - Telemetry and listening statistics

---

### 2. Disabled Social API Access

All legacy social endpoints are intercepted and blocked at the server boundary with HTTP `404`:

- `/api/posts`
- `/api/comments`
- `/api/notifications`
- `/api/dm`
- `/api/users`

Returns:
```json
{
  "error": "Social features are no longer available."
}
```

---

### 3. Removed Social Realtime Socket Behavior

- Removed Socket.IO client event listeners on the home page for new posts, likes, comments, post deletion, and notifications.
- Disabled server-side Socket.IO handlers for DM typing indicators.

---

### 4. Removed Social Stylesheets

- Removed `feed.css` and `chat.css` script links from `home.html`.
- Physically deleted obsolete files:
  - `Static/home/css/feed.css`
  - `Static/home/css/chat.css`

---

### 5. Restored Home Page Script Bundle

Restored missing client JavaScript bundle scripts in `home.html` before `</body>`:

- `config.js`
- Cropper.js
- `offline.js`
- `player.js`
- `api.js`
- `upload.js`
- `ui.js`

This resolved startup issues where the user profile remained on "Loading..." and library views failed to render.

---

### 6. Changed Default Route to Your Library

- Accessing `/home`, `/`, or `#library` opens **Your Library**.
- Legacy hashes (`#feed`, `#people`) redirect automatically to Your Library.
- Empty search queries and profile return paths lead back to Your Library.

---

### 7. Added Filesystem-Based Music Indexing

The server indexes audio files directly from local server directories.

- **Configuration** (`Server/config.json`):
  ```json
  {
    "music_directories": [
      "../MusicLibrary/uploads"
    ],
    "music_library_owner": "lwitchy"
  }
  ```

- **Supported Audio Formats**: `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.webm`.
- **Indexing Features**:
  1. Recursively scans all configured music directories.
  2. Reads embedded ID3/FLAC metadata via `music-metadata`.
  3. Calculates SHA-256 file hashes for change detection.
  4. Stores relative or absolute file paths in database.
  5. Automatically extracts embedded album cover art to `Static/covers/<basename>.jpg`.
  6. Automatically prunes database entries when physical files are deleted from disk.
  7. Runs on server startup, upon `/api/library` requests, and on-demand via the rescan API.

---

### 8. Dedicated Audio Streaming Endpoint (`GET /api/stream/:id`)

Fixed `404 Not Found` playback errors for tracks stored in custom external folders (e.g., `C:\Users\...\Music`):

- Created `/api/stream/:id` in `Server/server.js` to serve audio from any local directory on disk.
- Implemented HTTP `206 Partial Content` (Range requests) for fast seeking and buffering across MP3, FLAC, WAV, M4A, OGG, and WebM files.
- Updated `/api/play/:identifier` to return `url: "/api/stream/:id"`.

---

### 9. Shared Music Library Access Across Accounts

In a self-hosted environment, all indexed music is shared across all registered accounts on the instance:

- **`/api/library`**: Returns all non-hidden indexed local tracks (removed `uploaded_by === req.user` restriction).
- **`/api/stream/:id` & `/api/play/:identifier`**: Grants audio playback access to all folder-managed tracks (`source === 'folder'`).
- **`/api/search` & `/api/lyrics`**: Enables searching and lyric fetching/saving for all library tracks across all accounts.

---

### 10. Multi-Directory Configuration & Dynamic SPA Rescan (Phase 3)

- Supported `music_directories` array in `Server/config.json`.
- Added **Local Music Directories** path manager under **Settings -> Account**.
- Created API endpoints:
  - `GET /api/config/music-directories`
  - `POST /api/config/music-directories`
  - `POST /api/library/rescan`
- Added **Refresh Library** button (`#refresh-library-btn`) to Your Library header in `home.html` that rescans directories and updates the track list dynamically without browser page reloads.

---

### 11. Retired Upload & Import Endpoints

Ingestion routes return HTTP `410 (Gone)`:

- `/upload-song`
- `/api/youtube-ratelimit-status`
- `/api/youtube-metadata`
- `/api/youtube-download`
- `/api/import/*`

Response:
```json
{
  "error": "Music is loaded from the configured local directory."
}
```

Quietly handled HTTP `410` responses in `upload.js` to eliminate console error logs.

---

### 12. Fresh Install Bootstrap & Registration Locking

- **Fresh Installation Handling**: When zero users exist in the database, visiting the site opens the **Create Account (Registration)** page directly to set up the server Owner.
- **First-Account Owner Assignment**: The first registered user automatically gets assigned `role: 'Owner'`.
- **Automatic Lock**: Creating the Owner account automatically locks registration (`allow_registration = false`).
- **Settings Toggle**: The Owner can toggle `Enable registration` in **Settings -> Account**.
- When registration is disabled, the login page hides the Sign Up link, and `/register` returns HTTP `403`.

---

### 13. Profile Page Streamlining & Bug Fixes

- **Removed Posts and Playlists Tabs**: Simplified `/profile/:username` to display user metadata (avatar, hero banner, display name, bio) without posts or playlist grids.
- **Profile Back Button Fix**: Fixed JavaScript crash in `#back-from-profile-btn` (replaced call to non-existent `#home-link` with safe `#library-link` / `history.back()` fallback).
- **Profile Banner Fix**: Updated banner upload handler (`uploadProfileFile`) to target active profile username instead of parsing `/home` from URL pathname. Applied case-insensitive username comparison and clean CSS `backgroundImage` rendering.

---

### 14. Storage Quota Removal (Phase 3)

- Removed Storage tab and `#pane-storage` HTML from Settings.
- Cleaned up `loadStorage()` and `storage_update` socket listeners.

---

## Important Files Changed

### Server
- `Server/server.js`: Local scanner, `/api/stream/:id` endpoint, shared library access, multi-directory config routes, registration locking, social API guards, retired upload guards.
- `Server/database.js`: First-account Owner migration rule, user creation with optional role.
- `Server/config.json`: Added `music_directories` array.
- `Server/media.js`: Cover art extraction helpers.

### Client
- `Static/home/home.html`: Personal player navigation, multi-directory setting, Refresh Library button, script bundle restoration.
- `Static/home/js/api.js`: `/api/stream` mapping, shared library responses, profile back button fix, profile banner upload fix.
- `Static/home/js/ui.js`: Library-first routing, rescan button click handler, multi-directory path manager.
- `Static/home/js/upload.js`: Silent 410 ratelimit handling.
- `Static/loginpage/js/login.js`: Fresh install registration view, registration setting detection.

### Documentation
- [`README.md`](../../README.md): Updated with self-hosted music library and multi-directory setup details.
- `MIGRATION_REPORT.md`: Comprehensive log of all migration phases.

---

## Current Runtime Workflow

1. Start the server from repository root via `start_server.bat` or `node Server/server.js`.
2. Open:
   ```text
   http://localhost:4443/home
   ```
3. On a fresh database, create the first account to become `Owner`.
4. Manage music directories via **Settings -> Account -> Local Music Directories** or place files in `MusicLibrary/uploads`.
5. Click **Refresh Library** in Your Library header to sync new tracks instantly without reloading the page.
6. Click any track to play — streaming starts via `/api/stream/:id`.

---

## Verification Performed

- `node -c Server/server.js` — Syntax check passed clean with zero errors.
- Verified audio streaming route handling range requests.
- Verified SPA library rescan without page reload.
- Verified registration locking and fresh install bootstrap.
- Verified profile back button and banner image upload refresh.

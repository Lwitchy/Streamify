# Streamify Engineering Audit

Last updated: 2026-08-15

This is the current consolidated record of what was found in Streamify, what
was changed, what was verified, and what should be addressed next. It combines
the root documentation, the migration report, the desktop conversion findings,
and the iOS Safari/mobile debugging work completed afterward.

## Polishing Update Status

The 2026-08-15 stability and performance pass is implemented. It closes the
confirmed media/privacy bypasses, first-Owner race and LAN claim, Electron
origin/IPC weakness, startup/shutdown races, frontend stale-request bugs, and
offline stream/cache failures. It also adds text compression and removes major
per-row client storage work.

Runtime verification is intentionally manual and remains pending. The complete
change record and checklist are in
[`POLISHING_UPDATE.md`](POLISHING_UPDATE.md). Sections below retain architectural
and historical context; the polishing report supersedes older status text for
issues it marks complete.

The subsequent Smart Auto Enrich update added strict text/acoustic matching,
Owner-controlled AcoustID consent, canonical recording/artist/release identity,
resumable jobs and a redesigned review workspace. Its implementation and
verification record is [`SMART_AUTO_ENRICH_UPDATE.md`](SMART_AUTO_ENRICH_UPDATE.md).

## 1. Current Product Direction

Streamify is a self-hosted personal music player with three access paths:

```text
                    Node.js + Express + SQLite
                              |
             +----------------+----------------+
             |                |                |
       Electron desktop    LAN browser      HTTPS tunnel
       localhost           phone/tablet     remote access
```

The architecture intentionally uses one server, one database, and one music
library. Electron hosts the same Node server in-process rather than maintaining
a separate desktop backend.

The active product surfaces are:

- Local music library
- Multi-directory indexing
- Audio streaming and seeking
- Playlists
- Full-screen player
- Synced and static lyrics
- Search
- Authentication and owner setup
- Profiles and account settings
- Offline/PWA support where browser security rules permit it
- Local listening telemetry

The former social feed, people browser, comments, posts, notifications, and
direct-message product direction has been retired.

## 2. Major Findings

### 2.1 Architecture and Product Findings

| Finding | Impact | Current state |
|---|---|---|
| The existing Node backend could run directly inside Electron. | Avoided a second backend and duplicated data. | Adopted |
| A Tauri port would require a Node/native sidecar for SQLite, FFmpeg, yt-dlp, and existing server logic. | High implementation cost for a smaller installer. | Rejected |
| Social UI and API code remained after the project became a personal player. | Large dead-code surface and confusing maintenance. | UI/routes disabled; substantial client code remains |
| `Server/server.js` contains thousands of lines and many route domains. | Changes are risky and difficult to test. | Still unresolved |

### 2.2 Browser Security Findings

`localhost` is considered a secure context. A LAN URL such as
`http://192.168.1.50:4443` is not.

| Capability | HTTP LAN | HTTPS/localhost |
|---|:---:|:---:|
| Streaming and seeking | Yes | Yes |
| Web Audio equalizer | Yes | Yes |
| MediaSession controls | Yes | Yes |
| IndexedDB | Yes | Yes |
| Clipboard API | Restricted; fallback required | Yes |
| Service worker and Cache Storage | No | Yes |
| Offline downloads | No | Yes |
| Installable PWA | No | Yes |
| Screen Wake Lock | No | Yes |

The application now detects capabilities instead of assuming every API exists.
Deployment is documented as desktop, HTTP LAN, HTTPS LAN, and tunnel tiers.

### 2.3 Configuration and Security Findings

| Finding | Risk | Current state |
|---|---|---|
| CORS originally allowed one hardcoded origin. | Tunnels and alternate origins failed. | Fixed with exact same-origin or explicit `FRONTEND_URL` rules |
| Port `4443` was hardcoded despite documentation claiming configurability. | Deployment conflict and misleading docs. | Fixed with runtime/environment configuration |
| `Server/config.json` contained a personal absolute path and was tracked. | Private machine paths leaked into source control. | Gitignored and seeded from an example file |
| `musicLibraryOwner` defaults to `lwitchy`. | Incorrect ownership semantics for clones. | Fixed with neutral shared-library ownership |
| Security headers are incomplete. | Clickjacking, MIME sniffing, and CSP/HSTS gaps. | Baseline headers added; CSP remains staged work |
| Turnstile server code remains after the UI integration was removed. | Dead security code creates false confidence. | Still needs removal or full restoration |

Claims in historical changelog entries about fixed exploits were not treated as
a substitute for a current security audit.

### 2.4 Packaging Findings

| Finding | Failure mode | Current state |
|---|---|---|
| Writable paths were based on source directories. | Packaged writes targeted read-only `app.asar` or install files. | Fixed through `Server/runtime.js` and a user-data directory |
| FFmpeg and yt-dlp were packaged inside asar. | Native executables could not run. | Fixed with `asarUnpack` and path rewriting |
| GUI Electron builds have no useful stdout on Windows. | Packaged startup failures had no diagnostics. | Fixed with `%APPDATA%/Streamify/logs/main.log` |
| `build/` was ignored. | Fresh clones could omit installer artwork. | Fixed |
| `selfsigned` v5 is asynchronous. | Synchronous use returned missing keys. | Fixed in certificate generation |
| Installer is unsigned. | Windows SmartScreen warning. | Still needs code signing |
| No updater is configured. | Users must install every release manually. | Still needs auto-update |

### 2.5 Service Worker and Offline Findings

| Finding | Impact | Current state |
|---|---|---|
| Boxicons CSS was cached without its font files. | Offline icons appeared blank. | Fixed |
| `/Static/` was incorrectly handled as cache-first media with `ignoreSearch`. | CSS/JS became permanently stale and `?v=` could not bust it. | Fixed by narrowing media matching and using network-first app assets |
| Cached media over 10 MB falls back to the network for Range requests. | Large FLAC files cannot seek while fully offline. | Fixed with streamed cached Range responses; manual device verification pending |
| `offline.js` still references `streamify-app-shell-v1` for avatar caching. | Cache naming can drift from the active service-worker cache. | Fixed with account-scoped media caches and shared active-user state |
| Asset and service-worker versions are manually incremented. | Easy to ship mismatched HTML, CSS, JS, and cache names. | Needs build-time hashing or one shared version source |

## 3. Completed Product Migration Work

### 3.1 Social Application to Personal Player

- Removed social navigation and active feed/people/DM surfaces.
- Made Your Library the default route.
- Redirected legacy feed/people routes to the library.
- Disabled retired social API families with explicit responses.
- Removed feed/chat stylesheet loading and obsolete files.
- Removed storage-quota UI that no longer matched the local-library model.
- Simplified profiles to personal metadata rather than social posts.
- Retained authentication for self-hosted network deployments.

### 3.2 Local Library and Streaming

- Added recursive indexing for multiple configured music directories.
- Added metadata extraction for MP3, WAV, M4A, FLAC, OGG, and WebM.
- Added SHA-256 file change detection.
- Added embedded cover extraction.
- Added pruning when managed files disappear.
- Added `/api/stream/:id` with HTTP Range/206 support.
- Shared folder-managed library tracks across users on the same instance.
- Added settings APIs and UI for music-directory management.
- Added on-demand SPA library rescanning.
- Retired upload and external-import routes with HTTP 410 responses.

### 3.3 Bootstrap, Accounts, and Profiles

- The first account becomes Owner.
- Registration locks after owner creation.
- Owners can reopen registration from settings.
- Fresh installs route users to account creation.
- Profile back-navigation crashes were fixed.
- Profile banner upload targets the active profile correctly.
- Username comparisons for profile ownership are case-insensitive.

## 4. Desktop and Deployment Work

- Added Electron main/preload/connect windows.
- Added tray controls and phone QR connection flow.
- Consolidated dependencies into the root `package.json`.
- Changed the server to export lifecycle methods and avoid auto-start on import.
- Added runtime HTTP/HTTPS selection.
- Added LAN address discovery and startup connection information.
- Added self-signed LAN certificate generation with SAN entries.
- Added configurable runtime/data/config/SSL paths.
- Vendored fonts, icons, and Cropper assets for offline operation.
- Fixed maintenance middleware intercepting vendored assets.
- Added Windows installer configuration and unpack rules.
- Confirmed the SQLite N-API binary works across the selected Node and Electron runtimes.

## 5. Frontend and Player Fixes

### 5.1 General Frontend Fixes

- Restored the required script bundle order on the home page.
- Added environment capability detection.
- Added a clipboard fallback for insecure contexts.
- Gated service-worker registration and offline controls by support.
- Added local vendor assets to remove CDN dependence.
- Added iOS/PWA metadata and manifest improvements.
- Removed a stale social-user search renderer that crashed song search before
  `/api/search` was requested, and hardened legacy song metadata filtering.
- Normalized unexpectedly large bitrate values before displaying quality badges.
- Registered MediaSession handlers once instead of rebuilding them per track.
- Disabled desktop-only album-art hover/tilt behavior on touch devices.
- Hid unusable volume controls on devices where programmatic volume is locked.

### 5.2 iOS 26 Safari Findings

iOS 26 Safari changed browser chrome behavior for its Liquid Glass interface.
The final issue was not only `viewport-fit=cover` or `theme-color`.

Observed behavior:

- Safari 26 ignores `theme-color` for normal browser chrome in many cases.
- Safari samples `background-color` and effects from qualifying fixed/sticky
  elements near viewport edges.
- Hidden fixed elements can still influence chrome unless removed with
  `display: none`.
- Full-screen content can stop at the visual viewport and leave a flat lower
  strip even when a large viewport unit is used.
- Locking the root document with `overflow: hidden` prevents Safari from
  compositing real page pixels through the whole toolbar.
- A non-passive `touchmove` handler plus scroll-position fighting caused input
  latency and was removed.
- Making the visible full-player shell fixed reintroduced top and bottom black
  bars and was reverted.

Implemented solution:

1. Added `viewport-fit=cover` to pages.
2. Set explicit root/body fallback colors.
3. Restored effective large/dynamic viewport sizing where later CSS had
   accidentally overridden it with `height: 100%`.
4. Removed the hidden fixed mini-player from the render tree while the full
   player is active.
5. Kept Safari's edge-sampled fixed backdrop transparent.
6. Published cover artwork through `--player-backdrop-image`.
7. Added a 64px root scroll runway only while the dedicated player is active.
8. Painted album artwork on an absolute body pseudo-element that extends above
   and below the viewport; Safari ignores the pseudo-element for tint sampling
   but can composite its pixels through Liquid Glass.
9. Used CSS `touch-action` and nested overscroll containment instead of
   non-passive global touch handlers.
10. Kept `.lyrics-scroll-area` as the lyrics view's only vertical scroller.
11. Reset the root runway after leaving the dedicated player, including delayed
    post-layout resets for Safari.

User-confirmed results during device testing:

- Album-art background reaches through the complete bottom Safari toolbar.
- The full player no longer allows the page to be dragged into a large blank
  area.
- Lyrics remain independently scrollable.
- Removing JavaScript scroll fighting removed the touch lag.

### 5.3 Mobile Header and Scroll Architecture

The mobile top bar contains the hamburger button, search field, and user pill.
Sticky positioning was unreliable when the iOS document itself moved.

Current implementation:

- `.top-bar` is viewport-fixed on mobile, matching the fixed bottom player.
- `.content-container` is the mobile page scroll container.
- A safe-area-aware `--mobile-top-bar-height` reserves space above content.
- `window.getAppScrollContainer()` directs navigation scroll resets to
  `.content-container` on mobile and `.main-content` on desktop.
- Full-player mode hides the top bar and removes the content padding.

Latest implementation marker at the time of this audit:

- Base CSS diagnostic marker: `4.19`
- Updated frontend script query marker: `4.25`
- Service-worker cache: `streamify-app-shell-v53`

These numbers are cache-busting markers, not product release versions.

### 5.4 Lyrics Header Symmetry

The mobile lyrics panel set `min-height: 100%` while the dedicated header was a
separate flex item. Their combined height exceeded the viewport and changed the
Safari root scroll offset, pulling "NOW PLAYING" upward.

The lyrics panel now uses `min-height: 0` and consumes only the remaining flex
space below the unchanged dedicated header.

## 6. Regressions Encountered and Lessons

| Attempt | Regression | Lesson |
|---|---|---|
| Dynamic toolbar tint alone | Flat color remained below the toolbar. | Tint is only a fallback; Safari needs actual composited pixels. |
| Increasing a nested fixed backdrop | Content still stopped halfway. | The visual viewport/ancestor clipping boundary was the real limit. |
| Fixed full-player main shell | Top and bottom black bars returned. | Keep the visible app in flow while the root runway provides compositing. |
| Non-passive player `touchmove` plus scroll clamping | Touches and lyrics felt delayed. | Prefer CSS gesture policy and one nested scroll owner. |
| Mobile sticky top bar | Header moved with the iOS document. | Use a fixed top bar and an independent content scroller. |

## 7. Current Verification Status

Verified or reported working:

- Node syntax checks for modified JavaScript and service-worker files.
- HTTP and HTTPS server startup from historical conversion work.
- Range streaming route behavior from migration testing.
- Electron source and packaged startup from desktop conversion testing.
- Full iOS Safari toolbar artwork coverage through user device screenshots.
- Player panning lock and lyrics scrolling through user device testing.

Still requiring explicit validation:

- The latest fixed mobile top bar in normal Safari, standalone PWA, and
  landscape orientation.
- Root scroll restoration after repeated player open/close cycles.
- Lyrics header position across small and large iPhones.
- Android Chrome behavior after the mobile scroll-container change.
- Desktop behavior after all mobile-specific changes.
- Offline playback and seeking for large files.
- Every security, account, library, PWA, and Electron scenario in
  [`POLISHING_UPDATE.md`](POLISHING_UPDATE.md#9-required-manual-verification).

There is no automated test suite. Most browser-specific conclusions currently
depend on manual device testing.

## 8. Known Technical Debt

### High Priority

1. Add route and integration tests for authentication, library indexing,
   streaming ranges, playlists, and registration locking.
2. Add a repeatable real-device browser matrix for iOS Safari normal browsing,
   standalone PWA, landscape, and point releases.
3. Replace manually synchronized asset/cache versions with generated hashes or
   a shared build version.
4. Complete the staged CSP migration after removing inline handlers/styles.
5. Delete or isolate the remaining dead social/import implementations.
6. Split `Server/server.js` into domain routers and services after manual
   regression verification.

### Medium Priority

7. Decide whether Socket.IO is active product infrastructure. Wire the client
   for live progress or delete the unused server/client paths.
8. Add filesystem watching for automatic indexing.
9. Add code signing and Electron auto-update.
10. Add mDNS/Bonjour discovery for a stable local hostname.
11. Produce real maskable icons and PWA screenshots.
12. Add macOS, Linux, and Windows ARM build targets.
13. Validate all fixed/sticky surfaces against Safari 26 toolbar sampling.
14. Replace hardcoded mobile top/bottom spacing with measured shared layout
    variables where possible.

### Lower Priority

15. Add Windows media integration and global media keys.
16. Add a launch-on-login setting.
17. Add trusted certificate automation for domain owners.
18. Add optional on-the-fly transcoding for limited mobile bandwidth.
19. Remove or properly restore Turnstile.
20. Add custom themes only after layout behavior is stable.

## 9. Code Quality and Documentation Issues

- Historical changelog entries before 0.3.0 describe retired product behavior.
- The legacy roadmap lists features that now exist, were retired, or conflict
  with the personal-player direction.
- The migration report references `api.js` in places while the current home
  page loads `api_v2.js`.
- The older Safari section in `FINDINGS.md` describes the first safe-area fix,
  not the final scroll-runway solution. This audit supersedes it.
- Mojibake artifacts found in active source and visible login text were
  normalized during the polishing pass.
- `home.html` markup defects found during the polishing audit were corrected;
  browser-level validation remains part of the manual checklist.
- Large inline styles and handlers make CSP adoption and layout maintenance
  harder.
- The worktree has contained many concurrent/uncommitted changes. Future
  releases should separate migrations, UI fixes, and packaging work into
  reviewable commits.

## 10. Recommended Next Sequence

1. Complete the full manual checklist in `POLISHING_UPDATE.md` and record results.
2. Complete the mobile device matrix and record screenshots/results.
3. Add minimal automated smoke tests before further UI refactoring.
4. Replace manual asset/cache markers with generated revisions.
5. Clean dead social/import and Socket.IO code.
6. Split the server by domain after behavior is verified.
7. Stage CSP enforcement and configure signing/auto-update for distribution.
8. Update the root changelog for 0.3.x and remove obsolete Python guidance.

## 11. Related Documents

- [`../../README.md`](../../README.md)
- [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md)
- [`../../CHANGELOG.md`](../../CHANGELOG.md)
- [`FINDINGS.md`](FINDINGS.md)
- [`../History/MIGRATION_REPORT.md`](../History/MIGRATION_REPORT.md)

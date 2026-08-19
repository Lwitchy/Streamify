# Streamify — Desktop + Mobile Conversion: Findings & Roadmap

Written after converting Streamify into a Windows desktop application while
keeping it usable as a phone-facing website. This document records what was
found in the codebase, what was changed and why, and what is worth doing next.

---

## 1. Architecture chosen

The key realisation is that Streamify did not need porting. Its backend is
already a Node/Express process, and Electron's main process *is* Node — so the
desktop app hosts the existing server in-process rather than shipping a second
copy of anything.

```
                    Streamify server (Express + SQLite)
                       listening on 0.0.0.0:PORT
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
   Desktop window            LAN phones            Tunnel (optional)
   127.0.0.1                 192.168.x.x           music.example.com
   always secure             degraded on HTTP      always secure
```

One process, one database, one music library, three front doors.

The alternative (Tauri) was rejected: it bundles no Node runtime, so the Node
server, `sqlite3`, `ffmpeg` and `yt-dlp` would all have to ship as a Rust
sidecar with hand-rolled IPC. That trades days of plumbing for ~130 MB of
install size, which is a bad deal for a self-hosted personal app.

---

## 2. The central constraint: secure contexts

This is the single most important thing to understand about serving phones, and
it was not addressed anywhere in the original codebase.

Browsers restrict a set of APIs to *secure contexts*. `localhost` always
qualifies. **`http://192.168.1.50:4443` does not.**

| Feature | HTTP LAN | HTTPS / localhost |
|---|:--:|:--:|
| Streaming, seeking, Range requests | works | works |
| Web Audio equaliser | works | works |
| MediaSession lock-screen controls | works | works |
| IndexedDB | works | works |
| Clipboard (share buttons) | **broken** → fixed with fallback | works |
| Service worker + Cache Storage | **broken** | works |
| Offline downloads | **broken** | works |
| Add to Home Screen | **broken** | works |
| Screen Wake Lock (lyrics) | **broken** | works |

The practical consequence: a phone on plain HTTP still gets a completely usable
music player with lock-screen controls. It loses offline downloads and
installability. That is an honest, shippable default — so the app now *detects*
this and explains it, rather than failing silently.

Because the project is public on GitHub and cannot assume anyone owns a domain
or a Cloudflare account, this is structured as opt-in tiers:

- **Tier 0** — Desktop app. Always `127.0.0.1`, never degraded, zero setup.
- **Tier 1** — LAN HTTP. Works instantly for anyone who clones. Degraded, honestly.
- **Tier 2** — LAN HTTPS. `npm run gen-cert`, no accounts needed.
- **Tier 3** — Tunnel (Cloudflare / Tailscale). Zero warnings, needs an account.

---

## 3. Bugs and problems found

### 3.1 Genuine bugs

| # | Issue | Location | Status |
|---|---|---|---|
| 1 | **CORS allowed exactly one hardcoded origin**, defaulting to `http://localhost:5500` — not even the origin the app is served from. Harmless today only because all traffic is same-origin; would silently break any tunnel or cross-origin setup. | `server.js:292` | **Fixed** |
| 2 | **Port `4443` was hardcoded** with no override, while the README claimed it was configurable in `config.json` or `.env`. It was not. | `server.js:66` | **Fixed** |
| 3 | **`config.json` with personal absolute paths was committed to git** (`C:\Users\Nesib Qacizade\Music\t`). Published to GitHub as-is. | `Server/config.json` | **Fixed** — now gitignored, seeded from `config.example.json` |
| 4 | **Service worker precached the boxicons CSS but never the font files it references.** Icons rendered as blank boxes offline. A latent bug that existed before this work. | `Static/sw.js:11` | **Fixed** |
| 5 | **`maintenance.html` requested `family=Segoe+UI` from Google Fonts.** Segoe UI is not a Google font, so the request returned HTTP 400 and the *entire* stylesheet failed to load — including the Outfit font it also asked for. | `Static/maintenance/maintenance.html:7` | **Fixed** |
| 6 | **Server auto-started on `require()`**, making it impossible to embed. | `server.js:3837` | **Fixed** — exports `start()`, guarded by `require.main` |
| 7 | **Vendoring CSS/fonts locally exposed a maintenance-mode bug**: the maintenance middleware would intercept `/Static/vendor/*` and redirect stylesheet requests to `/maintenance`, breaking styling on the login and maintenance pages. Previously masked because those assets came from CDNs. | `server.js:732` | **Fixed** |
| 8 | **`build/` was gitignored** (inherited from the deleted Python tooling), which would have stripped the app icon from a fresh clone and broken `npm run build` for every contributor. | `.gitignore:66` | **Fixed** |
| 9 | **The service worker permanently froze all CSS and JS.** The media handler matched the whole of `/Static/`, routing every stylesheet and script through a *cache-first* lookup that used `{ ignoreSearch: true }`. Once cached, an asset was served forever, and because the query string was explicitly ignored, the project's `?v=` cache-busting convention could never dislodge it. Updates were unable to reach any client that had loaded the app once. Latent until HTTPS was enabled, since a service worker cannot register on a plain-HTTP origin. | `Static/sw.js:74` | **Fixed** — media handler now scoped to `/MusicLibrary/`, `/Static/{covers,avatars,banners}/` and `audio`/`video`/`image` destinations only |

### 3.1b iOS 26 Safari ("Liquid Glass") — the black band under the toolbar

The flat black strip behind Safari's floating toolbar was **not** a Safari bug and
**not** fixable with `theme-color`. Root cause:

> "Content is automatically inset within the display's safe area… **The inset
> area is filled with the page's `background-color`** (as specified on the
> `<body>` or `<html>` elements)… The default value of `viewport-fit` is `auto`,
> which results in the automatic insetting behavior… to disable that behavior
> and cause the page to lay out to the full size of the screen, you can set
> `viewport-fit` to `cover`."
> — [Designing Websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/), WebKit, 2017

Streamify shipped `width=device-width, initial-scale=1.0` with **no
`viewport-fit`**, so Safari insetted the page and filled the strip with
`--bg-color`, which was `#000`. That band *was* the page background.

Fixed by: `viewport-fit=cover` on every page, `background-color` on **both**
`html` and `body`, and `env(safe-area-inset-*)` padding on every surface that
touches a screen edge (top bar, sidebar drawer, content container, mini player,
dedicated player).

**Documentation status — worth knowing.** Apple has published *nothing* for web
developers about the Safari 26 redesign. Verified absent from: every Safari
26.0/26.1/26.2 release note, every WebKit blog post (`webkit.org/?s=Liquid+Glass`
returns "No matches"), all seven WWDC25 web sessions, and the "Adopting Liquid
Glass" guide (which is SwiftUI/UIKit only). The 2017 iPhone X post remains the
only authoritative source for `viewport-fit` and `env()`.

Two consequences:

1. **`theme-color` no longer tints Safari's browser UI.** MDN's browser-compat
   data records *"From Safari 26, the theme color is only used for installed web
   apps."* This is community-sourced, not Apple-confirmed. Streamify's
   album-art-derived `theme-color` therefore has no effect in normal browsing —
   but it **does** still apply once the site is added to the Home Screen, which
   is exactly where it matters most.
2. **The behaviour is unstable across point releases.** WebKit Bugzilla
   [#301108](https://bugs.webkit.org/show_bug.cgi?id=301108) (`REGRESSION (iOS
   26): meta viewport does not work correctly for viewport-fit=cover`) is still
   NEW and unassigned, with reporters observing the rendering change between
   26.x releases. Re-verify on device after iOS updates.

`safe-area-max-inset-*` was deliberately **not** used: it is a Google proposal,
WebKit has taken no position on it ([standards-positions#454](https://github.com/WebKit/standards-positions/issues/454)),
and it is absent from MDN BCD.

### 3.2 Dead code and vestigial artifacts

- **`openai@^6.34.0` was a declared dependency with zero usage.** No `require`,
  no `OPENAI_*` env var anywhere. Removed — `aiMetadata.js` only calls public
  HTTP APIs.
- **The Socket.IO client is completely dead.** The server side is fully wired
  (auth middleware, per-socket rate limiting, rooms — `server.js:71-180`), but
  `home.html` has no socket.io client script tag and `api_v2.js:10` declares
  `let socket;` without ever assigning it. Every call site is defensively
  guarded. Live import progress, DM updates and typing indicators are
  non-functional. **Not touched** — out of scope, but it is either ~110 lines of
  server code to delete or one script tag to add.
- **Cloudflare Turnstile is dead code.** `verifyTurnstile` exists in
  `auth.js:76`, but the login page has no widget and the CHANGELOG lists
  Turnstile as removed in 0.2.0.
- **Retired endpoints are still routed**: `/upload-song`, `/api/youtube-*`,
  `/api/import/*` return 410; `/api/posts`, `/api/comments`, `/api/dm`,
  `/api/users` return 404 with "Social features are no longer available."
- **Roughly 2,000 lines of `api_v2.js`** (feed, DMs, posts, comments — approx.
  lines 1500–3550) serve those disabled endpoints and can never execute.
- **Empty/no-op files**: `Server/t/` (empty), `.agents/` (empty),
  `Static/home/js/admin.js` (a 3-line `DOMContentLoaded` that returns `null`),
  `Static/loginpage/js/locked-lgn.js` (1 line),
  `Static/home/css/special404.css` (3 lines).
- **`musicLibraryOwner` defaults to the hardcoded username `'lwitchy'`**
  (`server.js:68`). Harmless for the author, meaningless for anyone else who
  clones the repo.

### 3.3 Packaging landmines (found and defused)

These are the classic "works in dev, broken after packaging" failures:

1. **Writable paths were all `__dirname`-relative.** ~50 sites resolved to
   `Server/../Database`, `Server/../Static/covers`, etc. Inside a packaged app
   that is `app.asar` — a **read-only virtual filesystem**. The database would
   have failed to open, and any update or uninstall would have destroyed the
   user's music library. Every path now routes through `Server/runtime.js`,
   which distinguishes read-only app assets from writable user data.

2. **`ffmpeg` and `yt-dlp` are native executables inside `node_modules`.** The
   OS cannot exec a file that exists only inside an asar archive. Both would
   have failed *silently*. Fixed with `asarUnpack` plus a path rewrite
   (`runtime.unpackPath()`, applied at `media.js:15`).

3. **Electron on Windows builds as a GUI-subsystem binary, so stdout goes
   nowhere.** The first packaged build failed and produced *no output at all*.
   Added a crash/startup log at `%APPDATA%\Streamify\logs\main.log`.

4. **`selfsigned` v5 changed to an async API** and returns a Promise. The
   documented synchronous usage silently produced `undefined` keys.

### 3.4 Pleasant surprises

- **`sqlite3` v6 uses N-API**, whose ABI is stable across both Node *and*
  Electron. Verified empirically: the same compiled `.node` binary loads under
  Node 24.18.0 and Electron 43.4.0. This means **one dependency tree serves both
  the desktop app and the plain server** — no dual builds, and no Visual Studio
  build tools required.
- **The PWA groundwork was already strong.** A 179-line service worker with
  genuinely sophisticated audio Range-request handling (`sw.js:114-178`),
  IndexedDB offline store, MediaSession, a 3-band Web Audio equaliser, and Wake
  Lock. Most of the mobile story was already built; it just needed a secure
  context to run in.

---

## 4. What changed

### New files
| File | Purpose |
|---|---|
| `Server/runtime.js` | Single source of truth for paths, port, TLS detection, LAN discovery. Defaults to previous behaviour exactly. |
| `electron/main.js` | Hosts the server, window, tray, crash log, cert exception |
| `electron/preload.js` | Sandboxed `contextBridge` API |
| `electron/connect.html` | "Connect your phone" QR window |
| `electron-builder.yml` | Packaging config incl. `asarUnpack` |
| `Scripts/generate-cert.js` | Self-signed LAN certificates with correct SANs |
| `Server/config.example.json` | Seed config, no personal paths |
| `package.json` (root) | Single dependency manifest |
| [`DEPLOYMENT.md`](../../DEPLOYMENT.md) | Deployment tiers and troubleshooting |
| `Static/vendor/**` | 11 locally hosted asset files |

### Structural changes
- **Consolidated to a single root `package.json`.** `Server/package.json` and
  its separate `node_modules` were removed. Node's upward module resolution
  means `Server/server.js` still resolves dependencies correctly, and
  electron-builder gets one tree to bundle.
- **`server.js` exports `{ app, io, httpServer, start, gracefulShutdown }`** and
  only self-starts under `require.main === module`.
- **HTTP/HTTPS is now selected at startup** by detecting a keypair in `SSL/`.
  This finally uses the `https` module that was imported at `server.js:8` and
  never referenced.
- **Startup banner** prints every reachable address plus the secure-context
  caveat.

### Frontend changes
- `window.StreamifyEnv` capability object; `window.copyToClipboard()` with an
  `execCommand` fallback; a dismissible degradation banner (`config.js`).
- Service worker registration now gated on secure context instead of throwing on
  every page load (`ui.js`).
- `OfflineStore.isSupported()` and a typed `InsecureContextError` so download
  buttons can fail with a reason instead of `caches is not defined`.
- Native folder picker for music directories, desktop-only, progressively
  enhanced (`ui.js`).
- Manifest: added `id`, `scope`, `shortcuts`, split `any`/`maskable` icon
  purposes, plus iOS `apple-touch-icon` and standalone meta tags.
- **All CDN dependencies vendored.** Streamify now makes zero external requests
  for assets and works on a fully offline network.

### Verified working
- Plain server on HTTP and HTTPS; TLS handshake and asset serving confirmed
- Desktop app from source and packaged
- Packaged app serving from inside the asar, including vendored fonts
- `Streamify-Setup-0.3.0.exe` — 140 MB, per-user, no admin rights

---

## 5. Future improvements

### High value

1. **Code signing.** The installer is unsigned, so Windows SmartScreen will warn
   every user. An OV/EV certificate (~$200–400/yr) or free
   [SignPath](https://signpath.io) for OSS would fix this. Highest-impact item
   for anyone distributing publicly.

2. ~~**Auto-update.**~~ Done. `electron-updater` is wired to GitHub Releases via
   the `publish:` block in `electron-builder.yml` and `electron/updater.js`.
   See [`RELEASING.md`](RELEASING.md) for the release procedure. Only NSIS and
   AppImage self-update — deb, tar.gz and the portable exe report why they
   cannot. The switch is Owner-level server state
   (`system_config.auto_update_enabled`), surfaced in Settings → Updates.

3. **Delete the dead social code.** ~2,000 lines in `api_v2.js` plus the
   corresponding server routes can never execute. This is the single biggest
   readability win available.

4. **Resolve the Socket.IO situation.** Either add the client script tag and get
   live import progress working, or delete ~110 lines of server code. Right now
   it is pure overhead.

5. **Split `server.js`.** At 3,900+ lines with ~120 routes in one file it is the
   main obstacle to changing anything safely. Extracting Express routers by
   domain (auth, library, playlists, admin, import) would be mechanical.

### Medium value

6. **mDNS / Bonjour discovery.** Advertising `streamify.local` would remove IP
   typing entirely and survive DHCP changes — the single biggest UX improvement
   available for phone users. `bonjour-service` is a small dependency.

7. **Proper maskable icons.** Both icons are currently declared for `any` and
   `maskable` purposes, but a real maskable icon needs ~20% safe-zone padding.
   Using the same asset for both means it renders shrunken or gets cropped
   depending on platform. Needs new art, not code.

8. **PWA `screenshots`.** Chrome shows a richer install prompt when the manifest
   includes them. Deliberately omitted rather than shipping wrong dimensions;
   needs purpose-made assets at documented sizes.

9. **Security headers.** No CSP, HSTS, `X-Content-Type-Options` or
   `X-Frame-Options`. `helmet` would cover this in a few lines, though CSP needs
   care given the inline handlers in the HTML.

10. **Filesystem watching.** Library sync is manual (`/api/library/rescan`).
    `chokidar` on the configured music directories would index new files
    automatically.

11. **The 10 MB offline seek limitation.** `sw.js` synthesises `206 Partial
    Content` for cached media under 10 MB and falls back to the network above
    it — meaning **large offline files cannot be seeked while offline**. FLAC
    files routinely exceed this. Fixable by slicing from a Blob rather than
    buffering the whole response.

12. **macOS and Linux builds.** `electron-builder.yml` is Windows-only. Adding
    `mac` (dmg) and `linux` (AppImage/deb) targets is mostly configuration,
    though macOS requires notarisation.

### Lower priority

13. **Windows media integration.** MediaSession already gives lock-screen
    controls, but Electron could add SMTC thumbnail toolbar buttons and global
    media-key shortcuts that work when the app is unfocused.
14. **Launch on login** — `app.setLoginItemSettings()`, one line, plus a
    settings toggle.
15. **Let's Encrypt DNS-01 automation** for users who own a domain, giving
    trusted certs without a tunnel.
16. **Tests.** There are currently zero. The `test` script is still the npm stub
    that exits 1. Route-level tests around auth and streaming would catch the
    most damaging regressions.
17. **arm64 builds** for Windows on ARM and Apple Silicon.
18. **Remove Turnstile dead code**, or reinstate it properly.
19. **`musicLibraryOwner` default** should be `null`, not `'lwitchy'`.
20. **On-the-fly transcoding** would let large FLAC libraries stream over
    limited mobile bandwidth. `fluent-ffmpeg` is already a dependency.

---

## 6. Notes for you specifically

- **Your machine now runs HTTPS by default.** `npm run gen-cert` was executed to
  verify the feature, so `SSL/key.pem` and `SSL/cert.pem` exist and the server
  auto-detects them. To go back to HTTP, delete those two files or set
  `STREAMIFY_DISABLE_HTTPS=1`. They are gitignored and will not be published.
  Note the origin change from `http://` to `https://` means you will need to log
  in again, since cookies are per-origin.

- **`Server/config.json` was removed from git tracking** (`git rm --cached`) but
  is untouched on disk. This is staged, not committed. It contained your
  personal absolute paths.

- **Nothing has been committed.** All changes are in the working tree for you to
  review.

- **npm blocked several install scripts** on this machine (a newer npm security
  feature). Electron's binary download had to be run manually via
  `node node_modules/electron/install.js`. If a fresh clone fails to find
  `electron.exe`, that is the cause — `npm approve-scripts` resolves it
  permanently.

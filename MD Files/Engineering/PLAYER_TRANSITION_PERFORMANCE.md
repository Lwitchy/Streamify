# Player Transition Performance

Date: 2026-08-16

## Purpose

This document records the performance work completed before the planned Liquid
Glass redesign. The requirement was explicit: improve first-load, player-open,
player-close, and lyrics smoothness without removing or simplifying Streamify's
animation design.

## Diagnosis

Electron hardware acceleration was not disabled. Runtime diagnostics from
`app.getGPUFeatureStatus()` reported GPU compositing, rasterization, multiple
raster threads, WebGL, and WebGPU as enabled.

The persistent frame drops came from rendering architecture rather than a weak
CPU:

- The dedicated player was removed with `display:none`, discarding its large
  filtered artwork and compositor layers on every close.
- Opening it recreated a 150%-sized `blur(80px)` backdrop while section and
  control blur animations were running.
- The sidebar animated `margin-left` and the top-bar logo animated `width` and
  `margin-right`, forcing layout on every frame.
- The routed page was destroyed visually and reconstructed on Back.
- Desktop lyrics originally polled every animation frame and filtered every
  line, including lines outside the visible depth stack.
- Cold launch performed avoidable full-file hashes and synchronous list work.

The i3-1215U is sufficient for this interface. More glass layers would still
expose the same architectural costs if each layer independently filtered live,
full-resolution content.

## Retained Desktop Player

At desktop widths (`min-width: 901px`), `#player-section` is moved to be a direct
child of `<body>` and remains mounted as a fixed layer.

Parked state:

- `opacity: 0`
- `translateY(40px)`
- `pointer-events: none`
- `inert` and `aria-hidden="true"`
- artwork, backdrop, and compositor hints remain allocated

Visible state:

- `opacity: 1`
- `translateY(0)`
- pointer and keyboard interaction restored
- the routed page remains mounted underneath but is inert and transparent

The player is positioned from the measured bottom of the real top bar plus the
existing 32px content inset. This preserves the previous final geometry without
depending on a transformed content-container ancestor.

## Preserved Motion Contract

The appearance and timing values remain the same:

| Motion | Duration | Timing function | Properties |
|---|---:|---|---|
| Player section entrance | 500ms | `cubic-bezier(0.25, 0.8, 0.25, 1)` | opacity, translateY(40px -> 0) |
| Standard/lyrics view entrance | 800ms | `cubic-bezier(0.16, 1, 0.3, 1)` | opacity, translateY(15px -> 0), blur(8px -> 0) |
| Sidebar/top-bar shell | 300ms | `cubic-bezier(0.25, 0.8, 0.25, 1)` | compositor transforms and opacity |
| Routed page return | Existing section CSS | Existing section easing | existing `fade-in-animate` or section override |
| Desktop lyric handoff | 400ms | `cubic-bezier(0.34, 1.56, 0.64, 1)` | translate, scale, blur, opacity, color |

The implementation changes how the pixels reach the screen, not what the user
sees. Back still removes the player immediately and replays the routed section's
existing entrance animation, matching the previous interaction.

## FLIP Shell Transition

The desktop shell still reaches the same final layout:

- sidebar at negative sidebar width and opacity zero
- main content expanded
- top-bar logo allocated and visible

The difference is that final layout is committed once. Streamify records element
positions before and after that commit, then animates the visual delta with
Web Animations API transforms:

- sidebar: inverse X translation plus opacity
- top-bar children: inverse X/Y translation
- top-bar logo: opacity reveal
- top-bar logo on Back: a short-lived visual clone preserves the original 300ms
  fade while the real zero-width layout is committed immediately

This is the FLIP pattern (First, Last, Invert, Play). It avoids 300ms of repeated
layout while retaining the original duration and easing.

## Routed Page Retention

Opening the desktop player no longer calls the generic `hideAllSections()` path.
The current library, playlist, profile, or other routed section remains mounted.
It is marked inert, hidden with opacity, and has its active entrance class parked.

On Back:

1. The retained player becomes non-interactive and returns to its parked state.
2. The final shell layout is committed and FLIP-animated.
3. The routed section is made interactive.
4. Its original `fade-in-animate` class is restored, including playlist/profile
   overrides.
5. The playing-row marker and sidebar active state are retained.

This also preserves the routed page's DOM and avoids reparsing covers or rebuilding
long song lists.

## Mobile and Breakpoints

Mobile/tablet (`max-width: 900px`) keeps the existing routed full-screen player,
including Safari toolbar handling, safe areas, mobile staggered controls, and
touch behavior.

Crossing the 901px breakpoint closes the active variant safely before moving the
player between its routed parent and retained desktop layer. This prevents an
active mobile player from leaving the previous routed page hidden after a resize.

## Lyrics Work

- Replaced continuous desktop `requestAnimationFrame` polling with a timer aimed
  at the next synchronized lyric timestamp.
- Resynchronizes on play, pause, seek, playback-rate changes, and `timeupdate`.
- Keeps only distance `-3...3` visually rasterized; farther lines retain layout
  but skip filtered text painting.
- Caps positive track translation near the first lines, avoiding the large empty
  top band caused by centering content that has no preceding lines.
- Keeps signed `data-distance` depth states and the same 400ms overshooting spring.

## Cold-Path Work

The transition change builds on these earlier fixes from the same performance
pass:

- unchanged audio files use persisted size + modification time rather than a
  full SHA-256 pass on every launch
- storage totals use persisted byte counts and only stat legacy rows
- initial library rows render in frame-sized document fragments
- offscreen library rows use `content-visibility: auto`
- avatar caching, service-worker installation, and playlist loading no longer
  lead the first library paint
- playback begins at the authenticated stream URL without a redundant metadata
  request
- dedicated artwork decoding and theme-color sampling begin when the song loads
- theme colors are cached by cover URL
- marquee measurements are read in one frame and written as one batch
- a tiny idle warm-up primes Chromium's transform/filter pipeline
- Electron records GPU feature status after `gpu-info-update`

### First-library paint gate

The home renderer now uses a static, paint-cheap startup surface instead of
letting users watch data arrive inside an animation already in progress. The
startup order is:

1. Start `/api/me` and `/api/library` in parallel.
2. Keep all existing shell/section entrance animations paused at frame zero.
3. Build the first 24 song rows inside the hidden library section.
4. Decode up to 12 first-viewport covers and wait for fonts, bounded by 700ms.
5. Mount and raster-prime the real retained desktop player under the startup
   surface.
6. Reveal the populated library and resume the unchanged entrance animations.
7. Wait until Chromium has painted one frame.
8. After the 800ms startup motion finishes, begin playlist loading, offline
   badges, OOBE checks, filter warm-up, service-worker update, and other
   non-critical work.

For large libraries, rows after the first 24 are held until startup motion ends,
then appended in 48-row frame batches. Therefore increasing a library from 5 to
50 or 500 tracks does not increase work in the critical reveal frame.

The startup surface has a 15-second fail-open timeout so a network or application
error cannot leave the UI permanently covered.

## Memory Tradeoff

Desktop keeps these layers available while the app is open:

- dedicated player surface
- decoded dedicated cover
- filtered artwork backdrop
- hidden mini-player blur surface
- current routed page DOM

This intentionally uses more GPU and renderer memory to remove repeated decode,
raster, upload, and layer-allocation work. The player remains a single retained
surface, not one retained surface per song.

## Liquid Glass Performance Contract

Future glass work should follow these rules:

1. Use one shared artwork/backdrop source per view.
2. Prefer retained layers and opacity/transform animation.
3. Do not animate layout properties (`width`, `left`, `margin`) during navigation.
4. Avoid stacking multiple full-viewport `backdrop-filter` surfaces.
5. Use low-resolution or pre-blurred artwork where fine detail is destroyed by
   blur anyway.
6. Keep hidden interactive trees inert.
7. Preserve reduced-motion behavior.
8. Profile first-open and repeated-open separately.

## Files

- `Static/home/js/player.js`: retained overlay, FLIP shell, lifecycle, artwork
  predecode/tint cache, lyrics scheduling
- `Static/home/js/ui.js`: navigation compatibility, idle warm-up, deferred startup
  work
- `Static/home/css/player.css`: retained-layer states, compositor hints, lyrics
  depth rendering
- `Static/home/css/library.css`: offscreen row containment
- `Server/server.js`: unchanged-file scan fast path and leaner current-user path
- `Server/database.js`: persisted storage-byte aggregation
- `electron/main.js`: GPU diagnostics
- `Static/sw.js` and `Static/home/home.html`: synchronized cache versions

## Verification

Automated checks:

```powershell
node --check Static/home/js/player.js
node --check Static/home/js/ui.js
npm run test:wiring
npm run test:theme
npm run test:metadata
git diff --check
```

Manual desktop checklist:

1. Restart Electron and load a large library.
2. Play a song and wait for its mini-player artwork.
3. Open the dedicated player repeatedly; verify identical timing and no blank
   frame.
4. Press Back repeatedly; verify the original routed-section entrance and scroll
   state.
5. Repeat from library, playlist, profile, and search views.
6. Open lyrics, seek forward/backward, pause, resume, and change playback rate.
7. Resize across 901px while closed and while open.
8. Check `%APPDATA%\Streamify\logs\main.log` for GPU feature status.
9. Record a Chrome Performance trace; the 300ms shell phase should show one setup
   layout followed primarily by compositor work, not layout on every frame.

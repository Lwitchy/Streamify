# Discord Rich Presence

Last reviewed: 2026-08-15

Shows the current track on the user's Discord profile as
`Listening to Streamify`, with a live progress bar and cover art.

**Desktop only. Off by default. Opt-in per device.**

---

## 1. Why it is built this way

Three constraints shaped every decision here.

**Discord's RPC needs Node.** It speaks over a local named pipe (Windows) or
unix socket (everything else). The renderer runs sandboxed with
`contextIsolation: true` and `nodeIntegration: false`, so it cannot open one.
The socket therefore lives in the Electron main process.

**Only the renderer knows what is playing.** Playback state is entirely
client-side (`Static/home/js/player.js`). The main process has no idea a song
changed. So the renderer describes, the main process publishes.

**Discord cannot see local artwork.** It does not render an image the client
already has; it hands the URL to its own media proxy, which fetches it
server-side. Every cover this app serves lives at `/Static/covers/...` on a LAN
box that Discord's servers cannot reach. Artwork is the awkward half of this
feature and section 4 is entirely about it.

A fourth constraint is worth stating because it explains the timing code:
Discord allows roughly **5 activity updates per 20 seconds** and silently drops
the rest.

## 2. Data flow

```
player.js loadSong()        -> StreamifyDiscord.trackChanged(song)
player.js syncPlaybackUI()  -> StreamifyDiscord.playbackChanged(playing, pos, dur)
player.js 'seeked'          -> StreamifyDiscord.seeked(pos, dur)      [debounced 900ms]
        |
        |  Static/home/js/discord.js
        |    - short-circuits unless desktop + opted in + playing
        |    - GET /api/discord/artwork   (resolves a public cover URL)
        v
   window.streamifyDesktop.discord.setActivity(payload)
        |
        |  electron/preload.js  (contextBridge)
        v
   IPC 'streamify:discord:setActivity'
        |
        |  electron/main.js  - assertIpcSender(event, ['main'], ...)
        v
   electron/discord-presence.js
        - re-validates the payload
        - coalesces to >= 4s between frames
        - writes to the Discord socket
```

## 3. Why updates are so sparse

We send `timestamps.start` and `timestamps.end`, and Discord draws and animates
the progress bar itself. That means playback position never has to be streamed.

Only four things change the *shape* of the card, and only those are sent:

| Event | Source | Result |
|---|---|---|
| Track changed | `loadSong()` | New card |
| Play | `syncPlaybackUI(true)` | Card with timestamps |
| Pause | `syncPlaybackUI(false)` | Card cleared |
| Seek | `'seeked'`, debounced | Timestamps recomputed |

Ordinary playback sends nothing. `timeupdate` is deliberately **not** hooked;
doing so would blow the rate limit within seconds.

### Coalescing

`DiscordPresence` keeps a single `pendingActivity` slot and a trailing timer
with a `MIN_UPDATE_INTERVAL_MS` (4s) floor. Because the slot holds only the
newest desired state, intermediate states are discarded rather than queued.

This matters more than it looks. Changing tracks mid-playback produces
`trackChanged` -> `pause` (the browser fires it when `audio.load()` aborts
playback) -> `play`. The transient "cleared" state overwrites and is then
overwritten in the slot, so it never reaches Discord and the card does not
flicker.

## 4. Artwork resolution

Resolved server-side by `GET /api/discord/artwork`, in this order:

| # | Source | Cost | Accuracy |
|---|---|---|---|
| 1 | Local cover re-pointed at a configured public HTTPS origin | none | exact, includes hand-uploaded covers |
| 2 | `songs.cover_source_url` | none | exact |
| 3 | Legacy completed YouTube queue thumbnail | none | exact for old imports |
| 4 | `discord_artwork_cache` | none until expiry | previously verified match |
| 5 | Exact YouTube title/version/duration lookup, opt-in | one paced search | strict match |
| 6 | Apple fallback in best-effort mode | one request | heuristic text match |
| 7 | `streamify` asset key uploaded in the Discord portal | none | generic logo |

In practice tier 2 covers most enriched libraries because Smart Metadata already
knows a public URL for the artwork it fetches.

### The `cover_source_url` column

This is the part that makes the feature cheap.

Smart Auto already resolves a public artwork URL - Apple CDN via
`metadataProviders.js:appleArtwork()`, or the Cover Art Archive via
`musicBrainzReleaseCandidate()` - then downloads the image and writes
`songs.cover_path`. Before this change the source URL was **discarded**; it
survived only inside `enrichment_candidates.payload_json`, which is deleted per
job item, and `song_identifications.candidate_json`, which is never parsed back.

`songs.cover_source_url` now records it. Consequences:

- Any song Smart Auto has enriched needs **zero** API calls for Discord artwork.
- The stored URL is the exact cover the user sees in Streamify.
- Tier 3 exists only for songs Smart Auto has never touched.

Legacy YouTube downloads retain their trusted thumbnail URLs and completed queue
records. New audio acquisition is Soulseek-only; yt-dlp remains solely as a
bounded metadata search for missing Discord artwork and never receives a media
download URL.

Write points:

| Where | Action |
|---|---|
| `server.js` enrichment decision (`POST /api/enrichment/items/:id/decision`) | sets it alongside `cover_path` |
| `server.js` `POST /api/save-cover` | sets it (Apple CDN URL) |
| `downloads.js` download completion | sets it when Spotify artwork was applied to a Soulseek file |
| `server.js` `GET /api/discord/artwork` | reads a retained queue thumbnail for legacy explicit YouTube downloads |
| `server.js` `POST /api/songs/:id/cover` | **clears** it - a hand-uploaded cover means the remembered URL no longer describes the artwork |
| `server.js` `GET /api/discord/artwork` tier 4 | sets it, but only when currently NULL |

The download write is gated on the artwork having actually been fetched and
applied. Existing explicit YouTube downloads can use their retained queue
thumbnail while their scanner-extracted cover is active.

### RPC artwork cache

`discord_artwork_cache` is separate from `songs.cover_source_url`: a YouTube
thumbnail can be a useful public image for Discord without being the exact local
cover displayed by Streamify. Successful matches expire after 30 days, confident
misses after 7 days, and provider failures after one hour. Editing title, artist,
duration or artwork invalidates the row immediately.

The renderer stores one of five per-device modes: `app_logo`, `stored_only`,
`youtube_exact`, `apple_only`, or `best_effort`. App-logo mode bypasses every
song artwork source. YouTube candidates must agree on normalized title, artist,
version markers and duration; ambiguous candidates are rejected. Apple-only
never starts a YouTube process.

### Two allowlists, one union

`cover_source_url` can hold a URL from either pipeline, and the two existing
allowlists are deliberately disjoint because each answers "may the server
download from here?" for its own flow:

| Predicate | Hosts | Pipeline |
|---|---|---|
| `AIMetadata.isTrustedCoverUrl` | `mzstatic.com`, `coverartarchive.org`, `archive.org` | enrichment |
| `DiscordArtwork.isTrustedRemoteArtworkUrl` | `*.ytimg.com`, `img.youtube.com`, `yt3.ggpht.com`, `*.scdn.co`, `*.spotifycdn.com` | Discord/public legacy URLs |

`server.js:isPublishableCoverUrl()` takes the union. The question it answers is
weaker - Discord does the fetching, not us - but it must still be an
allowlist, because an arbitrary URL would let whoever supplied it log a hit
from Discord's CDN every time anyone plays that song.

RPC-only matches never overwrite `cover_source_url`. Smart Metadata and the
owner therefore remain authoritative for the cover displayed inside Streamify.

### Tier 1: the public URL

Optional, Owner-only, stored in `system_config` under `discord_public_url`.

Only relevant if the server is genuinely reachable from the internet over HTTPS
(reverse proxy, Cloudflare Tunnel, etc). `validateDiscordPublicUrl()` rejects
`http://`, credentials, query strings, and every private range - loopback,
RFC1918, CGNAT, link-local, `.local`, `.internal`. A private address here is
worse than none: Discord renders an empty card with nothing to debug.

## 5. Security

The IPC surface is three `invoke`/`handle` channels, each guarded by the
existing `assertIpcSender(event, ['main'], ...)` - main frame only, exact origin
match. No `webContents.send()` push channel was added; the settings pane polls
`getStatus()` while open instead, which keeps the strict invoke-only model.

The renderer supplies the image URL, so `discord-presence.js` re-validates
everything it receives rather than trusting it:

- `clampImage()` accepts only absolute `https://` URLs or bare asset keys, and
  rejects embedded credentials.
- `clampText()` trims to Discord's 128-character limit and pads values shorter
  than 2 characters, which Discord rejects outright.
- Frame lengths are bounded before allocation.

## 6. Privacy

Rich Presence is a public broadcast of listening activity in an app that is
otherwise deliberately privacy-conscious. Hence:

- Off by default; the toggle stores `streamify_discord_rpc` in `localStorage`
  (per device - presence belongs to the machine Discord runs on, not to the
  account).
- Online cover lookups are a **separate** toggle, also off by default, because
  they send the track title and artist to Apple.
- Pausing clears the card entirely rather than leaving a stale one up.
- `pagehide` clears the card so closing the app removes it immediately instead
  of waiting for Discord to notice the dropped socket.

## 7. Failure modes

| Situation | Behaviour |
|---|---|
| Discord not running | Silent no-op. Reconnects on a 5s/15s/30s/60s backoff. Status pane says so. |
| Discord killed mid-playback | Socket close detected, reconnect scheduled, card restored on reconnect from the retained `currentActivity`. |
| Discord started later | Picked up by the next backoff tick; no user action needed. |
| Artwork lookup fails | Card publishes immediately with the fallback logo; a late result upgrades it. |
| Stale artwork response | Discarded via `artworkRequestId` if the track already changed. |
| Server-only mode (`npm start`) | Module never loads; there is no preload bridge. |
| Browser or phone client | `window.streamifyDesktop` is undefined, so `discord.js` short-circuits and the settings tab stays hidden. |

Nothing here is awaited by startup or shutdown, and reconnect/flush timers are
`unref()`ed so a pending retry cannot hold the process open at quit.

## 8. Files

**New**

| File | Role |
|---|---|
| `electron/discord-presence.js` | Zero-dependency RPC client: socket discovery, framing, handshake, coalescing, backoff, validation |
| `Static/home/js/discord.js` | Renderer bridge: opt-in gate, artwork resolution, payload construction |

**Modified**

| File | Change |
|---|---|
| `electron/main.js` | 3 IPC handlers, `DISCORD_CLIENT_ID`, teardown in `shutdownServer()` |
| `electron/preload.js` | `streamifyDesktop.discord` namespace |
| `Server/database.js` | `songs.cover_source_url` column + migration, `ENRICHMENT_METADATA_FIELDS`, `set/getSongCoverSourceUrl` |
| `Server/server.js` | `GET/POST /api/settings/discord`, `GET /api/discord/artwork`, 3 cover-source write points |
| `Static/home/js/player.js` | 3 call sites |
| `Static/home/js/ui.js` | Settings pane wiring, status polling, desktop-only gating |
| `Static/home/home.html` | Discord tab + pane, script tag |
| `Static/sw.js` | `APP_SHELL` entry, `CACHE_NAME` v59 -> v60 |

### No new dependencies

The RPC protocol is a 4-byte opcode, a 4-byte length, and JSON. A library
(`@xhayper/discord-rpc`) would have pulled `@discordjs/rest`, `ws`, and
`discord-api-types` into the main process to open one socket. Hand-rolling it
is ~450 lines including comments, adds nothing to `asarUnpack`, and matches the
vendored/minimal approach used elsewhere in this repo.

## 9. Setup

The Discord application ID is hardcoded in `electron/main.js` as
`DISCORD_CLIENT_ID`. It is a public identifier, not a secret.

The application **name** in the Discord developer portal is what renders after
"Listening to", so it must be `Streamify`.

The fallback logo must be uploaded under **Rich Presence -> Art Assets** with
the asset key `streamify`. Without it, songs with no resolvable artwork show a
card with no image rather than a broken one.

## 10. Verification

Automated:

```
npm run test:wiring        # validates ui.js getElementById targets against home.html,
                           # and that every versioned asset is in APP_SHELL
npm run test:metadata
npm run test:downloads-ui
```

Manual matrix:

- [ ] Discord closed at launch, opened later -> connects on its own
- [ ] Discord killed mid-playback -> reconnects, card returns
- [ ] Toggle off mid-playback -> card disappears immediately
- [ ] Pause -> card disappears; resume -> card returns with correct position
- [ ] Skip rapidly through 5 tracks -> no rate-limit drops, final card correct
- [ ] Seek -> progress bar re-syncs after ~1s
- [ ] Quit app -> card disappears immediately
- [ ] Song enriched by Smart Auto -> real cover, no network request
- [ ] Non-enriched song, art toggle off -> logo
- [ ] Non-enriched song, art toggle on -> cover appears, second play makes no request
- [ ] Manual cover upload -> `cover_source_url` cleared, no stale art
- [ ] Browser and phone clients -> unaffected, no Discord tab
- [ ] `npm start` (server only) -> unaffected

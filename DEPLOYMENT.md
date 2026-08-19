# Streamify Deployment Guide

Streamify is one Node server with three front doors:

```
                    Streamify server (Express + SQLite)
                    listening on 0.0.0.0:4443
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
  Desktop app             LAN (phones)            Tunnel (anywhere)
  127.0.0.1               192.168.x.x             music.example.com
  always secure           see below               always secure
```

There is only ever **one** server, **one** database and **one** music library.
The desktop app does not run a second copy — it hosts the same server in-process
and opens a window onto it.

The first Owner account must be created on the server itself through
`http://localhost:<port>` (or the Electron window). This prevents another device
on the LAN from claiming a fresh instance. Afterward, the Owner can enable
registration for other household members.

---

## 1. Windows desktop app

```bash
npm install
npm run desktop        # run from source
npm run build          # produce dist-electron/Streamify-Setup-<version>.exe
```

The installer is per-user (`%LOCALAPPDATA%\Programs\Streamify`), so it needs no
administrator rights.

**Where your data lives.** The packaged app never writes into its install
directory — an update would destroy it. Everything user-owned goes to:

```
%APPDATA%\Streamify\
├── Database\        users.db, music.db, lyrics.db + backups
├── MusicLibrary\    uploaded audio
├── Static\          covers, avatars, banners
├── SSL\             certificates (optional)
├── config.json      settings
└── logs\main.log    startup + crash log
```

Uninstalling does **not** delete this folder. Tray → *Open data folder* takes
you there.

Running from source (`npm run desktop`) instead uses the repo directory, so the
desktop app and `npm start` share one database during development.

---

## 2. Serving phones — pick a tier

This is the only genuinely tricky decision, and it comes down to one browser
rule: **several features only work in a "secure context."**

`localhost` always counts as secure. `http://192.168.1.50:4443` does **not**.

| Feature | HTTP LAN | HTTPS |
|---|:--:|:--:|
| Streaming, seeking, search, playlists | yes | yes |
| Equaliser (Web Audio) | yes | yes |
| Lock-screen / headphone controls (MediaSession) | yes | yes |
| Share buttons (clipboard) | yes\* | yes |
| **Offline downloads** | **no** | yes |
| **Add to Home Screen** (install as an app) | **no** | yes |
| **Screen wake lock on lyrics** | **no** | yes |

\* Streamify falls back to `execCommand('copy')` automatically.

So plain HTTP still gives a completely usable music player. You lose offline
downloads and installability. Streamify detects this and shows a one-time
banner explaining exactly what is unavailable, rather than failing silently.

### Tier 1 — LAN over HTTP (zero setup)

Already working. Start the server and open the address it prints:

```
  Streamify is running
  ├─ On this device : http://localhost:4443
  └─ On your network: http://192.168.1.178:4443  (Wi-Fi)
```

In the desktop app, use **Tray → Connect your phone…** for a QR code.

You may need to allow Node.js through Windows Firewall on private networks.

### Tier 2 — LAN over HTTPS (one command)

```bash
npm run gen-cert
```

This writes `SSL/key.pem` and `SSL/cert.pem` with your LAN IPs baked into the
certificate's SAN list. Restart Streamify; it detects them automatically and
every address becomes `https://`.

Because the certificate is self-signed, each device shows a warning **once**.
To remove it, install the certificate on the device:

- **Android** — copy `cert.pem` over, then *Settings → Security → Encryption &
  credentials → Install a certificate → CA certificate*
- **iOS** — AirDrop/email `cert.pem`, open it, install via *Settings → General →
  VPN & Device Management*, then **also** enable it under *Settings → General →
  About → Certificate Trust Settings* (this second step is required and easy to
  miss)

Regenerate after your LAN IP changes: `node Scripts/generate-cert.js --force`

Other certificate sources work too — drop any of these pairs into `SSL/`:
`key.pem`/`cert.pem`, `privkey.pem`/`fullchain.pem`, `server.key`/`server.crt`.
Or set `SSL_KEY_PATH` and `SSL_CERT_PATH`.

### Tier 3 — Tunnel (no warnings, works over cellular)

Best option if you want real certificates with no per-device setup, and access
from outside your home. Requires a third-party account, which is why it is not
the default.

**Cloudflare Tunnel** (free; needs a domain on Cloudflare):

```bash
cloudflared tunnel --url http://localhost:4443
```

**Tailscale** (free; private mesh, nothing exposed publicly):

```bash
tailscale serve --bg 4443
```

Tailscale issues a genuinely trusted certificate for your `*.ts.net` hostname,
so there are no warnings at all — but every device needs the Tailscale app.

With either, set your public hostname so CORS and cookies behave:

```bash
set FRONTEND_URL=https://music.example.com
set STREAMIFY_TRUST_PROXY=1
```

`STREAMIFY_TRUST_PROXY=1` trusts exactly one reverse-proxy hop for client IP and
HTTPS detection. Do not set it when clients connect directly to Streamify.

---

## 3. Installing on a phone

Once you are on HTTPS (Tier 2 or 3):

- **Android/Chrome** — menu → *Install app* / *Add to Home screen*
- **iOS/Safari** — Share → *Add to Home Screen* (Safari only; Chrome on iOS
  cannot install PWAs)

The app then opens without browser chrome and works offline for any songs you
have downloaded.

---

## 4. Configuration reference

All optional. Set as environment variables or in a `.env` file at the repo root.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4443` | Listening port |
| `HOST` | `0.0.0.0` | Bind address. `127.0.0.1` = desktop-only |
| `FRONTEND_URL` | — | Extra allowed CORS origins (comma-separated) |
| `STREAMIFY_TRUST_PROXY` | — | Trusted proxy hop count or IP/subnet list |
| `STREAMIFY_DATA_DIR` | repo root | Where databases/music/covers live |
| `STREAMIFY_CONFIG` | `Server/config.json` | Config file location |
| `STREAMIFY_SSL_DIR` | `<data>/SSL` | Certificate directory |
| `SSL_KEY_PATH` / `SSL_CERT_PATH` | — | Explicit certificate paths |
| `STREAMIFY_DISABLE_HTTPS` | — | `1` forces HTTP even if certs exist |
| `ACOUSTID_CLIENT_KEY` | — | Optional Owner AcoustID application key override |
| `FPCALC_PATH` | bundled binary | Optional absolute path to a custom `fpcalc` executable |
| `SLSK_USER` / `SLSK_PASS` | — | Soulseek credentials |

`Server/config.json` is created from `config.example.json` on first run and is
**not** tracked by git, because it contains machine-specific absolute paths.

### Smart Metadata

Chromaprint `fpcalc` binaries are bundled for Windows x64, Linux x64/ARM64 and
macOS x64/ARM64. Windows ARM64 uses the x64 build through emulation. Set
`FPCALC_PATH` only when using a custom/system build.

AcoustID is optional, free for non-commercial use and limited to three requests
per second. Streamify uses one request per second. The Owner can enter an
application client key during OOBE or Settings; `ACOUSTID_CLIENT_KEY` overrides
the stored value. Audio remains local.

### Discord Artwork

Discord Rich Presence cannot load cover files from a private LAN address. The
Owner can set a public HTTPS Streamify address under **Settings → Discord** when
the server is exposed through a reverse proxy or tunnel. Discord then uses the
exact embedded or uploaded cover.

Each desktop device can choose whether Discord always shows the Streamify logo,
uses stored/public covers only, searches YouTube by exact title/version/duration,
searches Apple Music only, or tries YouTube before Apple. These lookups never
authenticate to YouTube and never stream or download YouTube audio. Successful
results are cached for 30 days.

### CORS

Streamify serves its own frontend, so normal traffic is same-origin. Browser
requests with a different origin are rejected unless that exact origin is in
`FRONTEND_URL`. Because credentials are enabled, private-network origin ranges
are not trusted as a group.

---

## 5. Troubleshooting

**"Port 4443 is already in use"** — another copy is running, or something else
holds the port. `set PORT=8080` and retry.

**Desktop app won't start** — read `%APPDATA%\Streamify\logs\main.log`.

**Phone can't reach the server** — check both devices are on the same network,
then Windows Firewall. Guest/AP-isolated Wi-Fi blocks device-to-device traffic
entirely.

**Downloads/install unavailable on phone** — you are on HTTP. See Tier 2 or 3.

**Discord shows the Streamify logo for a song** — Discord cannot reach a local
cover. Enable an online artwork mode or configure a public HTTPS Streamify URL
under Settings → Discord. Uncertain and temporarily blocked matches deliberately
fall back to the logo.

**Icons or fonts missing** — all assets are served locally from `Static/vendor/`;
no internet needed. If they are missing, the files did not get copied.

**Native module errors after upgrading Node or Electron** — `npm run rebuild`.

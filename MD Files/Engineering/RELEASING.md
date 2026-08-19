# Releasing Streamify Desktop

How to cut a release that installed copies of the app will actually pick up.

Auto-update is implemented in [`electron/updater.js`](../../electron/updater.js)
on top of `electron-updater`, fed by the `publish:` block in
[`electron-builder.yml`](../../electron-builder.yml). This document covers the
publishing side: what has to end up on the GitHub release page, and why.

---

## 1. What an installed client actually does

Understanding this makes every rule below obvious. On each check, the app makes
exactly three requests:

```
1.  GET  https://github.com/Lwitchy/Streamify/releases/latest
         Accept: application/json
         -> reads "tag_name", e.g. "v0.4.0"

2.  GET  https://github.com/Lwitchy/Streamify/releases/download/v0.4.0/latest.yml
         -> version, installer filename, sha512, size

3.  GET  https://github.com/Lwitchy/Streamify/releases/download/v0.4.0/Streamify-Setup-0.4.0.exe
         -> verified against the sha512 from step 2, then run
```

There is no GitHub API token and no rate-limited API call in step 1 — it is the
plain `/releases/latest` redirect, which GitHub resolves to whichever release is
flagged **Latest**.

Three consequences follow directly:

- **`latest.yml` must live in the same release as the installer it describes.**
  Step 3's URL is built from the tag found in step 1 and the filename found in
  step 2. Splitting them across releases breaks the chain.
- **Drafts and pre-releases are invisible.** `/releases/latest` skips both. A
  release left as a draft, or ticked "Set as a pre-release", updates nobody.
- **The sha512 in `latest.yml` must match the uploaded binary byte for byte.**
  Rebuilding the installer without regenerating `latest.yml` produces
  `ERR_UPDATER_INVALID_FILE_CHECKSUM` on every client.

---

## 2. The normal release

```powershell
# 1. Bump the version. This is the single source of truth: it names the tag,
#    the artifacts, and the "version" field inside latest.yml. electron-updater
#    compares it against the running app's version with semver.
npm version 0.4.0 --no-git-tag-version

# 2. Build and upload. Needs a GitHub token with `repo` scope.
$env:GH_TOKEN = "ghp_..."
npm run release           # Windows: NSIS installer + latest.yml
npm run release:linux     # Linux: AppImage + latest-linux.yml (see §5)
```

`npm run release` creates a **draft** release tagged `v0.4.0` and uploads every
artifact to it.

```
3. Open the draft on GitHub, confirm all assets finished uploading,
   write the release notes, then press "Publish release".
```

The draft step is deliberate. Because `/releases/latest` ignores drafts, an
interrupted or failed upload can never leave clients pointed at a release whose
installer is missing or half-written. Nothing reaches a single user until you
press the button.

Release notes are shown verbatim in **Settings → Updates**, flattened to plain
text. Markdown headings and lists survive as text; images and links do not.

---

## 3. What ends up on the release page

For a `0.4.0` Windows release, `npm run release` uploads:

| File | Required? | Purpose |
|---|---|---|
| `Streamify-Setup-0.4.0.exe` | **Yes** | The installer clients download and run |
| `latest.yml` | **Yes** | The manifest: version, filename, sha512, size |
| `Streamify-Setup-0.4.0.exe.blockmap` | Recommended | Enables differential download — only the changed chunks are fetched instead of the full ~140 MB |

The blockmap is an optimisation, not a requirement. If it is missing,
electron-updater logs `Cannot download differentially, fallback to full
download` and fetches the whole installer. Everything still works, just slower.

You may attach anything else you like (a portable build, checksums, source
archives). Extra assets are ignored by the updater — only the filenames listed
inside `latest.yml` are ever requested.

### Uploading by hand

If you build with `npm run build` (which uses `--publish never`) and drag the
files onto the GitHub release form yourself, upload **all three** files above
from `dist-electron/`. `latest.yml` is generated there alongside the installer;
it is the file people forget, and without it every client fails with
`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`.

Do not edit `latest.yml` by hand. Its `sha512` is the integrity check for the
download, so an edited or stale manifest is worse than none at all.

---

## 4. The one-time bootstrap

**Copies of Streamify installed before this feature existed (0.3.0 and earlier)
will never auto-update.** They do not contain `electron/updater.js`, so there is
nothing in them to perform a check. Nothing you upload can change that.

The first build that ships the updater has to be installed manually, once.
Every release after that one updates itself. Worth saying explicitly in the
release notes for that version.

---

## 5. Platform coverage

| Target | Self-updates? | Why |
|---|---|---|
| Windows NSIS (`npm run release`) | Yes | The supported path |
| Linux AppImage (`npm run release:linux`) | Yes | Replaces the AppImage in place |
| Linux deb / tar.gz | No | Owned by the package manager; a silent self-swap would desync dpkg's manifest |
| Windows portable | No | No install root to write to |
| macOS | No | An updated bundle whose signature does not match is refused at launch, and this project ships no signing identity |

The app does not fail silently on the unsupported targets — **Settings →
Updates** names the reason and links to the releases page.

Linux artifacts cannot be produced from a Windows host (electron-builder needs
`dpkg`/`fakeroot`/`appimagetool`, and the native `sqlite3` binding would be the
Windows `.node`). Use `build_installer.bat linux`, which runs the official
container.

---

## 6. Checklist

Before pressing **Publish release**:

- [ ] `package.json` version bumped, and higher than the previous release
- [ ] Tag is `v<version>` and matches the version inside `latest.yml`
- [ ] `latest.yml` **and** the installer are both attached, to the same release
- [ ] Release is **not** marked as a pre-release
- [ ] The release shows as **Latest** on the repository's releases page

After publishing, verify from an actually installed older build — not from
source. A development build reports `supported: false` with reason
`development` and never checks, by design.

---

## 7. Troubleshooting

Errors surface in **Settings → Updates** and in `%APPDATA%\Streamify\logs\main.log`.

| Symptom | Cause |
|---|---|
| `ERR_UPDATER_NO_PUBLISHED_VERSIONS` | No published, non-draft, non-pre-release release exists yet |
| `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` | `latest.yml` was not uploaded, or went to a different release than the installer |
| `ERR_UPDATER_INVALID_FILE_CHECKSUM` | Installer was rebuilt or re-uploaded without its matching `latest.yml` |
| `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` | `/releases/latest` returned nothing — every release is a draft or a pre-release |
| Check succeeds but reports "up to date" | The release version is not greater than the installed version, per semver |
| Nothing happens at all | Auto-update is switched off in Settings → Updates (Owner only), or this is a build from §5 that cannot self-update |

Note that SmartScreen still warns on the downloaded installer: the build is
unsigned. Auto-update does not change that — see the code-signing item in
[`FINDINGS.md`](FINDINGS.md).

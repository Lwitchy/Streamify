# Smart Auto Enrich Update

Date: 2026-08-15

Status: implementation and static verification complete; browser/server runtime
verification remains manual

This document records the dedicated Smart Auto Enrich rewrite. The update
prioritizes correct identification and explicit uncertainty over filling every
field with a plausible but potentially incorrect value.

## 1. Product Decisions

- Smart Auto Enrich is Owner-only.
- Enrichment is Owner-triggered. The job schema leaves room for future scan and
  scheduled triggers without exposing unfinished controls.
- Accepted metadata is stored in Streamify's database. Original audio files are
  never modified.
- Automatic application is restricted to unique, validated acoustic or embedded
  identifier matches with strong supporting evidence.
- Text-only and filename-only candidates always require Owner review.
- Ambiguous songs remain unidentified instead of receiving a forced match.
- AcoustID is optional and uses an Owner-provided application client key.
- AcoustID lookup sends a Chromaprint fingerprint and duration, never audio.
- Streamify performs AcoustID lookup only. Fingerprint submission is not
  implemented.
- AcoustID's free service is for non-commercial use and is limited to three
  requests per second. Streamify uses a stricter one-request-per-second queue.

## 2. Lookup Modes And OOBE

The Owner now selects one server-wide mode during OOBE or in Settings:

1. `local_only`
   - Reads embedded tags, filenames, folders and local technical evidence.
   - Makes no metadata-provider network requests.
   - Produces reviewable local candidates where possible.
2. `text_only`
   - Queries MusicBrainz and Apple using normalized title/artist hypotheses.
   - Never fingerprints audio.
   - All matches require Owner review.
3. `acoustic_with_text_fallback`
   - Generates a local Chromaprint fingerprint.
   - Queries AcoustID and validates returned MusicBrainz recording IDs.
   - Runs text providers only when acoustic/embedded-ID evidence does not
     produce a strict safe match.

OOBE and Settings disclose what leaves the server. The stored AcoustID key is
never returned to the browser, public config, job payloads or logs. An
`ACOUSTID_CLIENT_KEY` environment value overrides the stored key; the UI reports
that source without exposing the value.

Relevant endpoints:

```text
GET    /api/settings/metadata
POST   /api/settings/metadata
DELETE /api/settings/metadata/acoustid-key
```

The GET contract is:

```json
{
  "mode": "local_only",
  "acoustid_configured": false,
  "acoustid_key_source": null,
  "fpcalc_available": true,
  "fpcalc_source": "bundled"
}
```

## 3. Scanner And Local Evidence

The folder scanner now parses each changed audio file once with precise duration
enabled. The same parse provides metadata and embedded artwork.

Captured evidence includes:

- Title and full artist lists.
- Album and album artist.
- Genres.
- Precise duration in milliseconds.
- Track/disc numbers and totals.
- Release/original dates and year.
- Composer, conductor, lyricist and remixer credits.
- Label, catalog number, barcode and release country.
- ISRC.
- Embedded MusicBrainz recording, release-track, release, release-group,
  artist, album-artist and work IDs.
- Embedded AcoustID ID/fingerprint when present.
- Codec, container and bitrate.
- File size, modification time and SHA-256.

Unchanged files use size/mtime evidence to avoid unnecessary parsing. Files with
accepted canonical identity are additionally hash-verified before the scanner
trusts the fast path.

Path identity now uses a platform-canonical `path_key`. Windows paths are
case-folded so case-only renames preserve the song row. Exact-hash moves preserve
numeric ID, stable UID, playlists and metadata identity. Missing files are
soft-marked after move reconciliation instead of being immediately deleted.

If bytes at an existing path change, accepted identity is invalidated before it
can be reused. Prior canonical rows remain historical, while the song's current
identification, accepted identifiers and locks are retired and the item becomes
`conflict` for review.

## 4. Text Matching Rewrite

The old matcher used one weighted Levenshtein score. An exact title with the
wrong artist could score 70 percent and pass the old threshold. That system has
been removed.

The new engine creates multiple non-destructive hypotheses from:

- Embedded title/artist/album data.
- Current database metadata and provenance.
- `Artist - Title` with ASCII or Unicode dash variants.
- `Title by Artist`.
- Track-numbered filenames.
- Conservative reverse interpretations.
- Parent-folder artist/album context.
- Ordered primary and featured artist credits.

Text comparison combines:

- Unicode NFKC normalization without globally removing articles.
- Code-point Levenshtein similarity.
- Token multiset Dice similarity.
- Character n-gram similarity.
- Primary artist-set similarity.
- Full artist-credit and featured-artist agreement.
- Album context.
- Duration agreement.
- Version identity.
- Provider-native score.
- Cross-provider agreement.

The parser explicitly preserves artists such as `50 Cent` and `The The`, handles
non-Latin text, and extracts featured artists independently from the core title.

Version identity includes:

- Live versions.
- Remix/mix credits.
- Radio and other edits.
- Acoustic and instrumental versions.
- Demos.
- Remasters and remaster years.
- Sped-up, slowed and reverb variants.

A material version, artist or duration conflict hard-caps the score and prevents
automatic application.

## 5. Strict Match Policy

Automatic application requires all of the following:

- Fingerprint or validated embedded-ID identity basis.
- Score at least `0.90`.
- Unique leading candidate.
- Validated identity score at least `0.90` for fingerprint results.
- Title and primary artist agreement.
- Compatible duration.
- No version, artist, featured-artist or duration conflict.
- No locked target field.
- Only missing/placeholder fields are changed automatically.

Text and local candidates are review-only regardless of score.

Field safety is independent:

- Recording evidence can establish title and artist.
- Album, year and cover remain unsafe when multiple releases disagree.
- Genre is lower-confidence supporting evidence and cannot replace a curated
  genre automatically.
- Existing populated fields are never replaced by automatic jobs.
- Owner-approved fields become manually locked provenance.

Scores are presented as ranking confidence and evidence, not probabilities.

## 6. Providers

### MusicBrainz

- Uses fielded recording/artist queries.
- Preserves full ordered artist credits and join phrases.
- Captures native score, recording duration, ISRC, genres/tags, recording ID,
  release IDs, release-group IDs and artist IDs.
- Retains multiple release candidates rather than collapsing them.
- Limited to one request per second.

### Apple

- Uses `entity=song` and a larger candidate set.
- Captures track/collection/artist IDs, duration, genre, release date, track
  number and artwork.
- Uses country-specific lookup only when configured, then retries without a
  storefront when necessary.
- Limited to one request every three seconds.

### AcoustID

- Uses HTTPS POST form data so key/fingerprint do not appear in the URL.
- Sends duration, compressed fingerprint and requested metadata fields.
- Requests recording, release, release-group, track and ISRC data.
- Correctly distinguishes invalid fingerprint and invalid client-key errors.
- Nested MusicBrainz releases and object-form dates are normalized.
- Limited to one request per second.

All providers have bounded responses, total timeouts, cancellation, retry for
temporary failures, `Retry-After` support, in-flight deduplication and bounded
TTL caching. Failure states remain distinct:

```text
no_match
offline
rate_limited
invalid_key
provider_error
cancelled
```

The previous browser-side automatic iTunes cover lookup was removed. Browsing or
playing a song no longer triggers unapproved registry requests.

## 7. Fingerprint Runtime

Streamify bundles pinned official Chromaprint `fpcalc` 1.6.1 binaries for:

- Windows x64.
- Linux x64.
- Linux ARM64.
- macOS universal, installed for x64 and ARM64 targets.

Windows ARM64 uses the official x64 build through Windows emulation when
available. `FPCALC_PATH` can override the bundled binary. A system `fpcalc` on
`PATH` is the final fallback.

Resolution order:

```text
FPCALC_PATH
bundled platform/architecture binary
Windows ARM64 x64-emulation binary
system PATH
```

The child process uses fixed arguments with `shell:false`, output limits,
timeout, cancellation and no path/fingerprint logging. Packaged binaries are
unpacked from ASAR and receive executable permissions during non-Windows builds.

`Scripts/fetch-fpcalc.js` downloads official release archives, verifies pinned
SHA-256 checksums and installs the platform files. Each target includes
`SOURCE.json`. Licensing details are in `vendor/fpcalc/NOTICE.md`.

## 8. Canonical Metadata Foundation

Existing numeric song IDs remain supported. New additive identity fields and
tables establish the foundation for telemetry and recommendations.

Song fields include:

```text
song_uid
recording_uid
path_key
duration_ms
file_size_bytes
file_mtime_ms
availability
metadata_status
metadata_revision
metadata_updated_at
metadata_pipeline_version
metadata_source
```

Canonical tables:

```text
recordings
artists
recording_artists
releases
release_tracks
song_identifications
external_identifiers
metadata_provenance
```

Accepted candidates atomically persist recording, ordered artist-credit,
release, release-track, external-ID, confidence, method, source and pipeline
data. Text candidates create canonical identity only after explicit Owner
approval.

Current API contracts retain existing keys while adding:

```text
uid
recording_uid
release_uid
release_track_uid
artist_uids
artist_credits
duration_ms
metadata_status
identification_method
identification_source
identification_confidence
```

Future telemetry can aggregate by `recording_uid` and artist UIDs instead of
mutable display strings or file paths.

## 9. Job System

The unsafe `/api/songs/enrich-batch` endpoint now returns HTTP 410. Direct legacy
apply is also retired. Both batch and single-song review use persisted jobs.

Endpoints:

```text
POST /api/enrichment/jobs
GET  /api/enrichment/jobs/:id
POST /api/enrichment/jobs/:id/pause
POST /api/enrichment/jobs/:id/resume
POST /api/enrichment/jobs/:id/cancel
GET  /api/enrichment/jobs/:id/items/next
POST /api/enrichment/items/:id/decision
```

Jobs are Owner-owned, sequential, cancellable and restart-recoverable. Only one
active job is allowed per Owner. Candidate payloads and decisions are persisted.
Transactions are serialized per SQLite database to prevent unrelated job,
scanner or account transactions from interleaving.

Item states:

```text
queued
processing
review
unidentified
error
applied
skipped
cancelled
```

Decisions are idempotent and enforce metadata revision checks. A concurrent edit
returns HTTP 409 rather than overwriting newer values. Candidate/release IDs are
validated against the persisted item. Covers are staged, normalized and removed
on pre-commit failure.

## 10. Popup Redesign

The old compact review popup was replaced with a responsive enrichment
workspace containing:

- Stage and job status.
- Progress bar and processed/matched/review/unidentified counts.
- Provider status chips.
- Current item title.
- Evidence chips.
- Field-by-field current/suggested comparison.
- Independent field confidence and ambiguity state.
- Safe checkbox defaults.
- Current/suggested cover comparison.
- Release and alternative candidate cards.
- Explicit unidentified and provider-error states.
- Pause, resume, cancel, skip and apply actions.

The dialog prevents closing, skipping or switching candidates during apply.
Single-song jobs use the same persisted decision flow as batch jobs. Closing an
active job cancels it instead of leaving an unreachable review item.

Recording-level candidates can apply title and artist directly. Ambiguous album,
year and cover values are unchecked by default but remain available for an
explicit Owner choice. Selecting a concrete card labelled `Release` additionally
records canonical release identity; manually choosing release text from a
recording card applies the display value without inventing a release ID.

Metadata locks protect fields from unattended automatic jobs. They do not block
an explicit Owner-approved review decision; a new Owner choice replaces and
re-locks the accepted value.

## 11. Verification Completed

Automated command:

```text
npm run test:metadata
```

Current result: 24 passing tests, 0 failures.

Coverage includes:

- `50 Cent`, `The The`, Unicode and non-Latin filenames.
- Unicode dash separators and track prefixes.
- `Title by Artist` and featured artists.
- Live, remix, edit, acoustic, instrumental, remaster and slowed versions.
- Exact-title/wrong-artist rejection.
- Title-only and filename-only score caps.
- Duration conflicts.
- Text-only never auto-applying.
- Strict unique fingerprint auto-application.
- Ambiguous release safety.
- MusicBrainz/Apple/AcoustID candidate merging.
- AcoustID POST encoding, error codes and request-key privacy.
- Local-only zero-network behavior.
- Acoustic success skipping text fallback.
- `fpcalc` output parsing and path resolution.

Static verification completed:

- `node --check` for all modified server, frontend, service-worker and build
  scripts.
- `git diff --check` without whitespace errors.
- npm dependency audit with zero known vulnerabilities.
- Service-worker shell references synchronized with frontend versions.

Local fingerprint verification used the sample Dua Lipa MP3. Bundled `fpcalc`
produced a valid 3,604-character fingerprint and a 230-second duration.

One live text lookup was performed for the same untagged filename. MusicBrainz
and Apple independently matched `Levitating (feat. DaBaby)` and were merged into
one cross-provider candidate with eight release choices. Streamify correctly
required review because the 230-second music-video audio conflicted with the
approximately 203-second catalogue recording.

## 12. Manual Verification Checklist

- Complete fresh OOBE in each lookup mode.
- Save, replace and clear an Owner-provided AcoustID client key.
- Verify environment-key status and non-removability.
- Run local-only and confirm no metadata-provider network traffic.
- Run text-only and inspect provider/release alternatives.
- Run acoustic mode with a valid key on tagged and untagged files.
- Test invalid key, missing fpcalc, offline, 429 and provider outage states.
- Pause, resume, cancel and reopen a persisted job.
- Close a single-song job and confirm it is cancelled.
- Apply and skip decisions; repeat requests to confirm idempotency.
- Edit metadata in another tab during review and confirm HTTP 409 conflict.
- Move and case-rename files while preserving IDs/playlists.
- Replace audio at the same path and confirm identity becomes conflict.
- Temporarily remove a root and confirm missing files retain history.
- Compare original, live, remix and compilation release candidates.
- Verify covers are staged and only committed with the selected release.
- Verify Owner-only controls and endpoint authorization.
- Test Windows x64, Windows ARM64 emulation, Linux x64/ARM64 and macOS
  x64/ARM64 fingerprint resolution.
- Build Electron and confirm `fpcalc` executes from ASAR-unpacked resources.

## 13. Deferred Work

- Automatic after-scan and scheduled enrichment triggers.
- Writing accepted tags back to source files.
- Fingerprint submission to AcoustID.
- Commercial AcoustID integration.
- Recommendation ranking and telemetry UI.
- Audio feature extraction such as BPM, key, loudness, mood or embeddings.
- A larger labelled accuracy corpus. Current strict thresholds should be
  recalibrated only against reviewed fixtures, never by reducing safeguards to
  increase fill rate.

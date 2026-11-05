# Roadmap

Where Streamify is headed next. Plans change as things get built, so treat
this as a direction, not a promise. Shipped work moves to the
[CHANGELOG](CHANGELOG.md).

## 0.6.0 - Listen anywhere

0.5.0 brought Home, Albums, Artists, Liked Songs and the first iOS app.
0.6.0 is about making Streamify something you can just leave playing, on any
device.

### Playback everywhere

- **Background playback on iOS.** Music keeps playing when the phone is
  locked or you switch apps.
- **Lock screen and Control Center controls.** Play, pause, skip and cover
  art on the lock screen, in Control Center and on headphones / car
  controls.
- **Up Next queue.** See what plays next, reorder it, and add songs to play
  next or at the end.
- **Autoplay.** When an album or playlist ends, keep going with related
  songs from your library instead of stopping.

### Your year in music

- A recap of your listening: top songs, artists and albums, minutes
  listened, and how your listening changed month by month. Built from the
  listening history added in 0.5.0, so it stays on your server like
  everything else.

### iOS app

- **Bottom tab bar** (Home, Search, Library) in place of the side menu.
- **Offline image cache**, so covers and artist photos show even when the
  server can't be reached.
- **Easier installs** through a signed build / TestFlight instead of
  sideloading.

### Get Music

Acquisition should be fast for whole playlists and unbothered by any single
source going down.

- **Parallel downloads.** Several transfers at once, never two from the same
  peer, so a 30-track playlist stops being 30 sequential waits.
- **Soulseek first, YouTube as the fallback.** Soulseek has no anti-bot
  system and often serves lossless; YouTube is the fast bulk filler.
- **Survive a YouTube block.** YouTube rate-limits by IP, so a block is
  handled as "use the other source for a while" rather than as a failed
  download. Retrying into a block is what makes it worse.
- **Keep yt-dlp current.** The binary is vendored inside the npm package and
  never updates on its own, so extractor breakage has no fix path today. A
  version check against the yt-dlp releases would at least make staleness
  visible before it becomes a download failure.
- **Consider a third source** (SoundCloud, for DJ edits and bootlegs that
  Soulseek and YouTube both handle badly). Only if that content is wanted —
  it adds a source to maintain.
- **Let MusicBrainz own the tags**, so a track's metadata no longer depends
  on which source the audio came from.

Explicitly not doing: DRM circumvention for Deezer/Qobuz/Tidal/Spotify/Apple
Music. That is a separate legal category from format-shifting a public
stream, and the keys are revoked regularly, so it would break for every user
at once. yt-dlp has no extractors for them either.

### Housekeeping

- Bring the CHANGELOG's Get Music section up to date (Soulseek with
  YouTube as a second source).
- Fix the failing Themes experiment test (`npm run test:theme`).

## Later

Ideas that are wanted but not scheduled yet:

- Song and artist radio ("play similar") from your own library
- Gapless playback and crossfade
- Sleep timer
- Last.fm scrobbling
- Android app (the Capacitor setup used for iOS makes this mostly a build
  pipeline job)

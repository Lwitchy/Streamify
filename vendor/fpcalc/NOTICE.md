# Chromaprint fpcalc Notice

Streamify distributes unmodified `fpcalc` binaries from Chromaprint 1.6.1:

https://github.com/acoustid/chromaprint/releases/tag/v1.6.1

Chromaprint's own source code is MIT licensed. The distributed fpcalc builds
include or link FFmpeg components and are distributed under the applicable
LGPL 2.1 terms. Source and build instructions are available from:

https://github.com/acoustid/chromaprint/tree/v1.6.1

https://github.com/FFmpeg/FFmpeg

License information:

https://github.com/acoustid/chromaprint/blob/v1.6.1/LICENSE.md

https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html

Each platform directory contains `SOURCE.json` with the exact release archive
URL and SHA-256 checksum used by `npm run fetch-fpcalc`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Downloads = require('../Server/downloads');
const YtDlpRuntime = require('../Server/ytDlpRuntime');

test('the download engine exposes YouTube URL handling', () => {
    assert.equal(typeof Downloads.isYoutubeUrl, 'function');
    assert.equal(Downloads.isYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(Downloads.isYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1'), true);
    assert.equal(Downloads.isYoutubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
    assert.equal(Downloads.isYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), true);
    assert.equal(Downloads.isYoutubeUrl('https://example.com/other'), false);
});

test('canonicalizes YouTube URLs and extracts video IDs', () => {
    assert.equal(Downloads.extractYoutubeVideoId('https://www.youtube.com/watch?v=oiKj0Z_Xnjc&list=RDoiKj0Z_Xnjc'), 'oiKj0Z_Xnjc');
    assert.equal(Downloads.extractYoutubeVideoId('https://youtu.be/oiKj0Z_Xnjc?t=10'), 'oiKj0Z_Xnjc');
    assert.equal(Downloads.canonicalYoutubeUrl('https://www.youtube.com/watch?v=oiKj0Z_Xnjc&list=RDoiKj0Z_Xnjc'), 'https://www.youtube.com/watch?v=oiKj0Z_Xnjc');
});

test('cleans and splits YouTube titles cleanly', () => {
    assert.deepEqual(
        Downloads.splitYoutubeTitle('Stromae - papaoutai (Official Video)', 'StromaeVEVO'),
        { artist: 'Stromae', title: 'papaoutai' }
    );
    assert.deepEqual(
        Downloads.splitYoutubeTitle('Never Gonna Give You Up [4K Remaster]', 'Rick Astley - Topic'),
        { artist: 'Rick Astley', title: 'Never Gonna Give You Up' }
    );
});

test('invalid download sources are rejected', async () => {
    Downloads.init({ getActiveDirectories: () => ['C:\\fake'] });
    await assert.rejects(
        Downloads.enqueue([{
            requestedSource: 'unknown_source',
            title: 'Blocked request',
            sourceUrl: 'https://example.com/song.mp3'
        }], 'test'),
        /Unknown download source "unknown_source"/
    );
});

/*
 * Spotify's getTracks() returns no album field at all, so an import used to
 * queue every track with album: null — and since applyTags preserves existing
 * tags, each Soulseek peer's own album name survived. One album import became
 * as many library "albums" as there were peers.
 */
test('only album links yield album metadata', async () => {
    const { fetchSpotifyAlbumMetadata } = Downloads.__testing;

    // Network-dependent, so a failed lookup (offline, rate limit) proves
    // nothing either way — but a NON-null answer for these two would be a bug.
    const track = await fetchSpotifyAlbumMetadata('https://open.spotify.com/track/1wtOxkiel43cVs0Yux5Q4h');
    assert.equal(track, null, 'a track link must not supply an album name');

    const playlist = await fetchSpotifyAlbumMetadata('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    assert.equal(playlist, null, 'a playlist name must not be used as an album');
});

/*
 * Quality preference. The old scoring hardcoded a FLAC bonus, so "lossless" as
 * a user choice did not exist. These pin the ordering both ways, because a
 * preference that silently does nothing is worse than no preference at all.
 */
test('quality tiers map bitrates correctly', () => {
    const { qualityTierFor } = Downloads.__testing;
    const at = (extension, bitrate) => qualityTierFor({ extension, bitrate });

    assert.equal(at('.flac', 0), 'flac');
    assert.equal(at('.wav', 0), 'wav');
    assert.equal(at('.mp3', 320), 'mp320');
    assert.equal(at('.mp3', 256), 'mp256');
    assert.equal(at('.mp3', 192), 'mp192');
    // 128 and 96 must both be low. An earlier version tested `< 128`, which let
    // exactly 128 kbps escape the low-quality penalty entirely.
    assert.equal(at('.mp3', 128), 'mpLow', '128 kbps was not classed as low');
    assert.equal(at('.mp3', 96), 'mpLow');
    assert.equal(at('.mp3', 0), 'mp256', 'an unreported bitrate must not be punished');
});

test('the quality preference changes ranking in the right direction', () => {
    const { scoreSoulseekCandidate: score } = Downloads.__testing;
    const tokens = ['taylor', 'swift', 'anti', 'hero'];
    const base = { slots: true, queueLength: 0, filename: 'Taylor Swift Anti-Hero', speed: 0, sizeBytes: 5_000_000 };
    const at = (extension, bitrate) => ({ ...base, extension, bitrate });
    const rank = (candidate, quality) => score(candidate, tokens, quality);

    const flac = at('.flac', 0);
    const mp320 = at('.mp3', 320);
    const mp192 = at('.mp3', 192);
    const mp128 = at('.mp3', 128);

    // `best` means best available, so lossless still leads — but a good MP3
    // stays competitive because it is often downloadable immediately.
    assert.ok(rank(flac, 'best') > rank(mp320, 'best'), 'best should prefer FLAC');
    assert.ok(rank(mp320, 'best') > rank(mp192, 'best'), 'best should prefer 320 over 192');

    // `lossless` pushes every lossy tier below FLAC and penalises low bitrates.
    assert.ok(rank(flac, 'lossless') > rank(mp320, 'lossless'), 'lossless should strongly prefer FLAC');
    assert.ok(rank(mp128, 'lossless') < rank(mp128, 'best'), 'lossless should penalise 128 kbps');

    // A preference is not a filter: a lossy file is still ordered, not dropped.
    assert.ok(rank(mp320, 'lossless') > rank(mp128, 'lossless'), 'lossless should still order lossy tiers');
    assert.equal(rank(mp128, 'lossless') > Number.NEGATIVE_INFINITY, true, 'lossy candidates must remain rankable');
});

/*
 * The JS runtime is the difference between a working YouTube extractor and a
 * silently degraded one: yt-dlp enables only `deno` by default and drops the
 * `web`/`tv_samsung` clients without a runtime. It fails with NO error, so the
 * shape of these options is worth pinning down.
 */
test('yt-dlp options clear runtimes before setting one', () => {
    const options = YtDlpRuntime.ytDlpBaseOptions();
    const keys = Object.keys(options);

    // --no-js-runtimes CLEARS all runtimes, so it must precede --js-runtimes.
    // Reversed, the runtime is wiped and the app silently degrades.
    assert.equal(keys[0], 'noJsRuntimes', 'the runtime-clearing flag must come first');
    assert.equal(keys[1], 'jsRuntimes', 'the runtime flag must come after the clear');
});

test('the JS runtime path is native, not POSIX-style', () => {
    const runtime = YtDlpRuntime.resolveJsRuntime();
    assert.equal(typeof runtime, 'string');
    assert.ok(runtime.startsWith('node:'), `expected a node: runtime, got ${runtime}`);

    if (process.platform === 'win32') {
        // yt-dlp reports a forward-slash Windows path as "unavailable" with no
        // error, so the value must use native separators.
        const value = runtime.slice('node:'.length);
        assert.ok(!value.includes('/'), `a forward slash would fail silently: ${value}`);
    }
});

test('every yt-dlp invocation path is paced by the shared gate', async () => {
    // Two acquisitions must not overlap while YOUTUBE_MAX_CONCURRENT is 1;
    // this is what keeps searches, downloads and artwork lookups from bursting
    // the per-IP allowance together.
    let concurrent = 0;
    let maxConcurrent = 0;
    const order = [];

    const task = id => async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(`start:${id}`);
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push(`end:${id}`);
        concurrent -= 1;
        return id;
    };

    await Promise.all([
        YtDlpRuntime.withYtDlpSlot(task('a')),
        YtDlpRuntime.withYtDlpSlot(task('b'))
    ]);

    assert.equal(maxConcurrent, 1, 'two yt-dlp calls ran at once');
    assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'],
        `calls interleaved instead of serialising: ${order.join(', ')}`);
});

test('the pacing gate is released when the task throws', async () => {
    await assert.rejects(
        YtDlpRuntime.withYtDlpSlot(async () => { throw new Error('boom'); }),
        /boom/
    );

    // A leaked slot would block this forever, so the assertion is that it
    // completes at all. The floor on how long it takes is the pacing interval
    // (~2.5s), not the leak — assert the upper bound well clear of that, but
    // low enough that "wedged shut" cannot pass by timing out slowly.
    const started = Date.now();
    const result = await Promise.race([
        YtDlpRuntime.withYtDlpSlot(async () => 'released'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the gate wedged shut')), 15000))
    ]);
    assert.equal(result, 'released');
    assert.ok(Date.now() - started < 15000, 'the gate took implausibly long to free');
});

/*
 * The circuit breaker decides whether a yt-dlp failure is "this video is bad"
 * or "YouTube is refusing us". Getting that classification wrong in either
 * direction is costly — a false negative retries into an escalating block, and
 * a false positive parks a working source — so both sides are pinned here.
 */
test('recognises YouTube refusals as block errors', () => {
    const blocking = [
        'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser',
        'ERROR: unable to download video data: HTTP Error 403: Forbidden',
        'ERROR: HTTP Error 429: Too Many Requests',
        'ERROR: [youtube] abc: Sign in to confirm your age',
        'ERROR: [youtube] abc: This content isn\u2019t available',
        'ERROR: [youtube] abc: Failed to extract any player response',
        'ERROR: [youtube] abc: nsig extraction failed: Some formats may be missing',
        'ERROR: unable to download webpage: HTTP Error 403: Forbidden',
        'ERROR: [youtube] abc: Login required',
        'ERROR: [youtube] abc: Requested format is not available'
    ];
    for (const message of blocking) {
        assert.equal(
            Downloads.isYoutubeBlockError(message),
            true,
            `expected a block: ${message}`
        );
    }
});

test('does not treat ordinary per-video failures as blocks', () => {
    const ordinary = [
        'ERROR: [youtube] abc: Video unavailable',
        'ERROR: [youtube] abc: Private video. Sign in if you\u2019ve been granted access',
        'Soulseek transfer timed out.',
        'The peer returned an empty file.',
        'Audio file was not produced by yt-dlp.',
        'Cancelled.',
        ''
    ];
    for (const message of ordinary) {
        assert.equal(
            Downloads.isYoutubeBlockError(message),
            false,
            `should not be a block: ${message}`
        );
    }
});

test('reads the message from an Error, a wrapped Error, or a bare string', () => {
    assert.equal(Downloads.isYoutubeBlockError(new Error('HTTP Error 403: Forbidden')), true);
    // yt-dlp-exec surfaces failures as execa errors carrying shortMessage.
    assert.equal(
        Downloads.isYoutubeBlockError({ shortMessage: 'sign in to confirm you are not a bot' }),
        true
    );
    assert.equal(Downloads.isYoutubeBlockError(null), false);
    assert.equal(Downloads.isYoutubeBlockError(undefined), false);
});

test('the breaker reports a usable status shape', () => {
    const status = Downloads.youtubeBreakerStatus();
    assert.equal(typeof status.blocked, 'boolean');
    assert.equal(typeof status.retryAt === 'string' || status.retryAt === null, true);
    assert.equal(typeof status.reason === 'string' || status.reason === null, true);
});

/*
 * A row becomes retryable the moment its status lands as 'failed', which
 * processItem writes BEFORE the worker's finally block retires the transfer.
 * So a retry can claim the same row and start a new transfer while the previous
 * one is still unwinding — and a naive delete-by-row-id would then evict the
 * NEW transfer, making it uncancellable and freeing its peer claim early
 * (which is precisely the duplicate-connection case the peer rule prevents).
 */
test('a retiring transfer does not evict a newer transfer for the same row', () => {
    const { beginTransfer, endTransfer, cancelTransfer, activeTransferCount, reset } = Downloads.__testing;
    reset();

    const first = beginTransfer(42);
    // The row is retried while `first` is still unwinding.
    const second = beginTransfer(42);

    // The stale transfer retires; the live one must be untouched.
    endTransfer(first);
    assert.equal(activeTransferCount(), 1, 'the stale transfer evicted the live one');

    // Proof the survivor is still the cancellable one.
    assert.equal(cancelTransfer(42), true, 'the live transfer is no longer cancellable');
    assert.equal(second.cancelled, true, 'cancel did not reach the live transfer');

    endTransfer(second);
    assert.equal(activeTransferCount(), 0, 'the registry leaked an entry');
});

test('retiring a transfer releases its peer claim exactly once', () => {
    const { beginTransfer, endTransfer, claimPeer, isPeerBusy, activeTransferCount, reset } = Downloads.__testing;
    reset();

    const transfer = beginTransfer(7);
    transfer.peer = 'somepeer';
    claimPeer('somepeer', transfer);
    assert.equal(isPeerBusy('somepeer'), true);

    endTransfer(transfer);
    assert.equal(isPeerBusy('somepeer'), false, 'the peer claim survived the transfer');
    assert.equal(activeTransferCount(), 0);
});

test('a stale transfer cannot release a peer claim it no longer owns', () => {
    const { beginTransfer, endTransfer, claimPeer, isPeerBusy, reset } = Downloads.__testing;
    reset();

    // Same peer, two successive transfers (a retry that re-picks the peer).
    const first = beginTransfer(9);
    first.peer = 'peerA';
    claimPeer('peerA', first);
    const second = beginTransfer(9);
    second.peer = 'peerA';
    claimPeer('peerA', second);

    endTransfer(first);
    assert.equal(isPeerBusy('peerA'), true,
        'the stale transfer released a claim now owned by the live one');

    endTransfer(second);
    assert.equal(isPeerBusy('peerA'), false);
});

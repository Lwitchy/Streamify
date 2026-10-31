/**
 * Listening history (telemetry v2) rules.
 *
 * Every playback is one row in `listening_events`, identified by a client
 * generated `play_id`. The client reports the cumulative milliseconds it has
 * played so far; heartbeats and the final report are idempotent upserts, so a
 * duplicated or reordered request can never double-count time.
 *
 * This module holds the pure rules (validation, clamping, "counts as a play")
 * so they can be unit tested without a database. Persistence lives in
 * database.js (recordPlaybackProgress).
 */

const END_REASONS = Object.freeze([
    'completed', // the track played to its natural end
    'next',      // the listener pressed Next
    'previous',  // the listener pressed Previous
    'selected',  // the listener picked a different song
    'error',     // playback failed
    'closed'     // the page or app was closed mid-track
]);

// Where a playback was started from. Home, album and artist views arrive in
// later phases; accepting them now keeps clients and server independent.
const SOURCE_TYPES = Object.freeze([
    'library', 'search', 'playlist', 'album', 'artist', 'home',
    'liked', 'offline', 'queue', 'unknown'
]);

const DEVICES = Object.freeze(['desktop', 'mobile', 'web']);

// A play counts once 30 seconds have been heard, or half the track when the
// track is shorter than a minute.
const COUNTED_PLAY_MS = 30000;

// Wall-clock slack allowed between two reports of the same playback. Playback
// rate can be raised slightly and timers drift; anything beyond this is clamped.
const PROGRESS_SLACK_MS = 20000;

// Reports queued while offline may arrive late. Older than this, they are dropped.
const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// A single playback can never exceed this, whatever the client claims.
const MAX_PLAYBACK_MS = 6 * 60 * 60 * 1000;

const PLAY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
}

function countedThresholdMs(durationMs) {
    if (Number.isFinite(durationMs) && durationMs > 0 && durationMs < COUNTED_PLAY_MS * 2) {
        return Math.max(1000, Math.floor(durationMs / 2));
    }
    return COUNTED_PLAY_MS;
}

function isCountedPlay(msPlayed, durationMs) {
    return msPlayed >= countedThresholdMs(durationMs);
}

/**
 * Validate and normalize a client report. Returns { value } or { error }.
 * `now` is injectable for tests.
 */
function normalizePlaybackReport(body, now = Date.now()) {
    if (!body || typeof body !== 'object') return { error: 'Invalid body' };

    const playId = typeof body.play_id === 'string' ? body.play_id.trim() : '';
    if (!PLAY_ID_PATTERN.test(playId)) return { error: 'Invalid play_id' };

    const songId = toInteger(body.song_id);
    if (!songId || songId <= 0) return { error: 'Invalid song_id' };

    const msPlayed = toInteger(body.ms_played);
    if (msPlayed === null || msPlayed < 0) return { error: 'Invalid ms_played' };

    let durationMs = toInteger(body.duration_ms);
    if (durationMs !== null && (durationMs <= 0 || durationMs > MAX_PLAYBACK_MS)) durationMs = null;

    let startedAt = toInteger(body.started_at);
    if (startedAt === null || startedAt > now + 60000) startedAt = now;
    if (startedAt < now - MAX_REPORT_AGE_MS) return { error: 'Report too old' };
    startedAt = Math.min(startedAt, now);

    const ended = body.ended === true;
    let endReason = null;
    if (ended) {
        endReason = END_REASONS.includes(body.end_reason) ? body.end_reason : 'closed';
    }

    const sourceType = SOURCE_TYPES.includes(body.source_type) ? body.source_type : 'unknown';
    let sourceId = null;
    if (body.source_id !== undefined && body.source_id !== null && body.source_id !== '') {
        const candidate = String(body.source_id);
        if (SOURCE_ID_PATTERN.test(candidate)) sourceId = candidate;
    }

    const device = DEVICES.includes(body.device) ? body.device : 'web';

    return {
        value: {
            playId,
            songId,
            msPlayed: Math.min(msPlayed, MAX_PLAYBACK_MS),
            durationMs,
            startedAt,
            ended,
            endReason,
            sourceType,
            sourceId,
            device
        }
    };
}

/**
 * Decide the stored ms_played for a report, given the existing row (or null).
 *
 * - Progress never goes backwards (reordered heartbeats are harmless).
 * - Growth is bounded by the wall-clock time since the previous report, so a
 *   client cannot claim an hour of listening in one request.
 * - The first report is bounded by the time since the playback started.
 */
function resolveMsPlayed(existing, report, now = Date.now()) {
    const claimed = report.msPlayed;
    if (!existing) {
        const elapsed = Math.max(0, now - report.startedAt);
        return Math.min(claimed, elapsed + PROGRESS_SLACK_MS, MAX_PLAYBACK_MS);
    }
    const previous = Number(existing.ms_played) || 0;
    if (claimed <= previous) return previous;
    const lastUpdate = Date.parse(existing.updated_at);
    const elapsed = Number.isFinite(lastUpdate) ? Math.max(0, now - lastUpdate) : 0;
    return Math.min(claimed, previous + elapsed + PROGRESS_SLACK_MS, MAX_PLAYBACK_MS);
}

module.exports = {
    END_REASONS,
    SOURCE_TYPES,
    DEVICES,
    COUNTED_PLAY_MS,
    PROGRESS_SLACK_MS,
    MAX_REPORT_AGE_MS,
    MAX_PLAYBACK_MS,
    countedThresholdMs,
    isCountedPlay,
    normalizePlaybackReport,
    resolveMsPlayed
};

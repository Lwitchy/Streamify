/**
 * ============================================================================
 * STREAMIFY - lyrics.js
 * ============================================================================
 * Lyrics lookup (LRCLIB), lyric rendering, the "Find lyrics" picker and the
 * lyrics editor ("Sync" + "Text" tabs).
 *
 * Depends on player.js globals (loaded before this file):
 *   audio, lyricsData, lyricsAreSynced, isLyricsActive, activeLyricIndex,
 *   isLyricEditMode, tempLyricsData, lyricsContent, lyricsScrollArea,
 *   btnLyrics, btnFindLyrics, playSong, togglePlay, updateActiveLyric,
 *   resetDesktopLyricsPresentation, deactivateLyricsView,
 *   startDesktopLyricsSync, stopDesktopLyricsSync, isUserScrollingLyrics
 * and config.js: escapeHTML, showToast.
 * ============================================================================
 */

/* --- DOM references --- */
const lyricsViewHeader = document.getElementById('lyrics-view-header');
const btnEditLyrics = document.getElementById('edit-lyrics-btn');
const btnReRequestLyrics = document.getElementById('re-request-lyrics-btn');
const lyricEditorEl = document.getElementById('lyric-editor');
const lyricEditorFooter = document.getElementById('lyric-editor-footer');
const lyricEditorTextarea = document.getElementById('lyric-editor-text');
const lyricEditorStatus = document.getElementById('lyric-editor-status');
const lyricEditorClock = document.getElementById('lyric-editor-clock');
const lyricEditorPlayBtn = document.getElementById('lyric-editor-play');
const lyricTapSyncBtn = document.getElementById('lyric-tap-sync');
const btnSaveLyrics = document.getElementById('save-lyrics-btn');
const btnClearLyrics = document.getElementById('clear-lyrics-btn');
const btnCancelLyrics = document.getElementById('cancel-lyric-edit-btn');

const lyricsSelectionModal = document.getElementById('lyrics-selection-modal');
const closeLyricsSelectionModal = document.getElementById('close-lyrics-selection-modal');
const lyricsSearchForm = document.getElementById('lyrics-search-form');
const lyricsSearchTitle = document.getElementById('lyrics-search-title');
const lyricsSearchArtist = document.getElementById('lyrics-search-artist');
const lyricsSelectionResults = document.getElementById('lyrics-selection-results');
const lyricsSelectionLoading = document.getElementById('lyrics-selection-loading');
const lyricsSelectionEmpty = document.getElementById('lyrics-selection-empty');
const lyricsSelectionTrack = document.getElementById('lyrics-selection-track');
const lyricsWriteOwnBtns = document.querySelectorAll('[data-lyrics-write-own]');

/* --- State --- */
let currentLyricsTrack = null; // { id, title, artist, album, duration }
let _lyricsFetchAbort = null;
let _lyricsSearchAbort = null;
let _lyricsSelectionAbort = null;

const lyricEditorState = {
    tab: 'sync',
    cursor: 0,
    dirty: false,
    playingIndex: -1,
    rafId: null,
    pendingConfirm: null, // { key, timer }
    wordIndex: 0,         // Words tab: next word the tap button sets
};

const LRCLIB_BASE = 'https://lrclib.net/api';
const LYRICS_REQUEST_TIMEOUT_MS = 8000;
const LYRICS_AUTO_ACCEPT_SCORE = 0.62;
const LYRICS_AUTO_CACHE_SCORE = 0.75;
const LYRICS_ARTIST_MIN_SIM = 0.6;

/* ============================================================================
 * 1. METADATA CLEANING
 * ========================================================================== */

// Bracketed segments containing any of these are noise: "(Official Video)",
// "[320 kbps]", "(Lyrics)", "【MV】" ...
const LYRICS_BRACKET_NOISE = new RegExp(
    String.raw`\b(?:official|music\s*video|video\s*clip|lyrics?|lyric\s*video|audio|visuali[sz]er|hd|hq|4k|8k|uhd|hdr|\d{3,4}p|\d{2,4}\s*kbps|kbps|flac|mp3|m4a|wav|alac|aac|ogg|opus|hi[-\s]?res|remaster(?:ed)?|explicit|clean\s*version|dirty|radio\s*edit|single\s*version|album\s*version|mv|m\/v|topic|vevo|premiere|exclusive|free\s*download|download|full\s*(?:song|version)|with\s*lyrics|letra|legendado|tradu[cç][aã]o|subtitulado|color\s*coded|dolby|atmos|spatial\s*audio|360\s*ra|8d|432\s*hz|bass\s*boost(?:ed)?|prod\.?(?:\s*by)?|out\s*now|new\s*song)\b`,
    'iu'
);
// Unbracketed phrases that are safe to strip anywhere (never real title words).
const LYRICS_INLINE_NOISE = /\b(?:official\s+(?:music\s+)?(?:video|audio|lyric\s+video|visuali[sz]er)|(?:official\s+)?lyrics?\s+video|music\s+video|with\s+lyrics|\d{2,4}\s*kbps|kbps|hq|hd|4k|1080p|720p|visuali[sz]er)\b/giu;
const LYRICS_FEAT = /[([]?\s*\b(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+[)\]]?/iu;
const LYRICS_VERSION_WORDS = ['remix', 'live', 'acoustic', 'slowed', 'sped', 'nightcore', 'instrumental', 'karaoke', 'cover', 'demo', 'unplugged', 'reverb'];

function lyricsStripBrackets(value) {
    return value.replace(/\s*[(\[{【「]([^)\]}】」]*)[)\]}】」]\s*/gu, (full, inner) =>
        LYRICS_BRACKET_NOISE.test(inner) ? ' ' : full
    );
}

function lyricsCleanArtist(value) {
    let artist = String(value || '').trim();
    if (!artist || /^unknown(\s+artist)?$/i.test(artist)) return '';
    artist = lyricsStripBrackets(artist)
        .replace(LYRICS_INLINE_NOISE, ' ')
        .replace(/\s*-\s*topic$/iu, '')
        .replace(/vevo$/iu, '')
        .replace(/\b(?:official|channel)\b/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return artist;
}

function lyricsPrimaryArtist(artist) {
    if (!artist) return '';
    const first = artist.split(/\s*(?:,|;|\/|\s&\s|\s+x\s+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/iu)[0];
    return (first || artist).trim();
}

/**
 * Turns raw library/YouTube metadata into a clean { title, artist } pair plus
 * alternative interpretations used as fallback queries.
 * Unicode-safe: Turkish, Cyrillic, Japanese, etc. letters are preserved.
 */
function cleanLyricsMetadata(rawTitle, rawArtist) {
    let title = String(rawTitle || '')
        .replace(/\.(?:mp3|flac|m4a|wav|ogg|opus|aac|alac)$/iu, '')
        .replace(/^\s*\d{1,3}\s*[.\-_)]\s+/u, '')
        .replace(/[‒–—]/gu, '-');
    let artist = lyricsCleanArtist(rawArtist);

    // "Title | Movie | Channel" or "Title // Extra": keep the song part.
    if (/\s(?:\||\/\/)\s/u.test(title)) {
        const parts = title.split(/\s+(?:\||\/\/)\s+/u).map(p => p.trim()).filter(Boolean);
        const artistIndex = artist ? parts.findIndex(p => lyricsSimilarity(p, artist) >= 0.7) : -1;
        if (artistIndex === 0 && parts[1]) title = parts[1];
        else if (!artist && parts.length >= 2 && !parts[0].includes(' - ')) title = `${parts[0]} - ${parts[1]}`;
        else title = parts[0];
    }

    title = lyricsStripBrackets(title).replace(LYRICS_INLINE_NOISE, ' ');
    title = title.replace(/\s+/gu, ' ').replace(/\s+-\s*$/u, '').replace(/^\s*-\s+/u, '').trim();

    const alternatives = [];

    // "Artist - Title" (or "Title - Artist") embedded in the title field.
    const dash = title.match(/^(.+?)\s+-\s+(.+)$/u);
    if (dash) {
        const left = dash[1].trim();
        const right = dash[2].trim();
        if (!artist) {
            artist = lyricsCleanArtist(left);
            title = right;
            alternatives.push({ title: left, artist: lyricsCleanArtist(right) });
        } else if (lyricsSimilarity(left, artist) >= 0.6 || lyricsSimilarity(left, lyricsPrimaryArtist(artist)) >= 0.7) {
            title = right;
        } else if (lyricsSimilarity(right, artist) >= 0.6 || lyricsSimilarity(right, lyricsPrimaryArtist(artist)) >= 0.7) {
            title = left;
        } else {
            // Unknown structure ("Song - Acoustic", "Uploader - Song"): try both halves.
            alternatives.push({ title: right, artist });
            alternatives.push({ title: left, artist });
        }
    }

    // Remove the artist name if it's still glued to the title.
    if (artist) {
        const escaped = artist.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const stripped = title.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'iu'), ' ').replace(/\s+/gu, ' ').trim();
        if (stripped.length >= 2) title = stripped;
    }

    const finalize = value => String(value || '')
        .replace(/[^\p{L}\p{M}\p{N}\s'’&.,!?+\-()]/gu, ' ')
        .replace(/\(\s*\)/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();

    title = finalize(title);
    artist = finalize(artist);
    const titleNoFeat = finalize(title.replace(LYRICS_FEAT, ' '));

    return {
        title,
        artist,
        titleNoFeat: titleNoFeat && titleNoFeat !== title ? titleNoFeat : '',
        primaryArtist: lyricsPrimaryArtist(artist),
        alternatives: alternatives
            .map(alt => ({ title: finalize(alt.title), artist: finalize(alt.artist) }))
            .filter(alt => alt.title && alt.title !== title),
    };
}

/* Kept for any external callers. */
function cleanMetadata(title, artist) {
    const cleaned = cleanLyricsMetadata(title, artist);
    return { title: cleaned.title, artist: cleaned.artist };
}

/* ============================================================================
 * 2. MATCH SCORING
 * ========================================================================== */

function lyricsNormKey(value) {
    return String(value || '')
        .toLocaleLowerCase('en-US')
        .replace(/ı/g, 'i')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/&/g, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function lyricsBigrams(value) {
    const s = value.replace(/\s+/g, ' ');
    const grams = new Map();
    for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        grams.set(g, (grams.get(g) || 0) + 1);
    }
    return grams;
}

/** 0..1 fuzzy similarity (exact > containment > bigram Dice). */
function lyricsSimilarity(a, b) {
    const x = lyricsNormKey(a);
    const y = lyricsNormKey(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const compactX = x.replace(/\s/g, '');
    const compactY = y.replace(/\s/g, '');
    if (compactX === compactY) return 0.98;
    const shorter = compactX.length < compactY.length ? compactX : compactY;
    const longer = shorter === compactX ? compactY : compactX;
    if (shorter.length >= 3 && longer.includes(shorter)) {
        return 0.75 + 0.2 * (shorter.length / longer.length);
    }
    if (x.length < 2 || y.length < 2) return 0;
    const gx = lyricsBigrams(x);
    const gy = lyricsBigrams(y);
    let overlap = 0;
    let total = 0;
    gx.forEach((count, g) => { total += count; overlap += Math.min(count, gy.get(g) || 0); });
    gy.forEach(count => { total += count; });
    return total ? (2 * overlap) / total : 0;
}

/** Artist similarity: like lyricsSimilarity but "contains" only counts whole
 *  words, so "Aries" matches "Aries & Friend" but not "Ari Es Band"/"Ariesto". */
function lyricsArtistSimilarity(a, b) {
    const x = lyricsNormKey(a);
    const y = lyricsNormKey(b);
    if (!x || !y) return 0;
    if (x === y || x.replace(/\s/g, '') === y.replace(/\s/g, '')) return 1;
    const tx = x.split(' ');
    const ty = y.split(' ');
    const [shortT, longT] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
    const longSet = new Set(longT);
    if (shortT.every(t => longSet.has(t))) return 0.9;
    // Fuzzy fallback for spelling differences only (no substring credit).
    const gx = lyricsBigrams(x);
    const gy = lyricsBigrams(y);
    let overlap = 0;
    let total = 0;
    gx.forEach((count, g) => { total += count; overlap += Math.min(count, gy.get(g) || 0); });
    gy.forEach(count => { total += count; });
    const dice = total ? (2 * overlap) / total : 0;
    return Math.abs(x.length - y.length) <= 3 ? dice : dice * 0.6;
}

function lyricsVersionTags(value) {
    const key = lyricsNormKey(value);
    return new Set(LYRICS_VERSION_WORDS.filter(word => new RegExp(`\\b${word}`).test(key)));
}

function lyricsDurationScore(trackDuration, resultDuration) {
    if (!trackDuration || !resultDuration) return { score: 0.5, diff: null };
    const diff = Math.abs(Number(resultDuration) - Number(trackDuration));
    let score = 0;
    if (diff <= 2) score = 1;
    else if (diff <= 4) score = 0.85;
    else if (diff <= 8) score = 0.55;
    else if (diff <= 15) score = 0.25;
    return { score, diff };
}

/**
 * Scores an LRCLIB result against the track. Returns 0..1 (+ small bonuses).
 * `query` = { title, artist, primaryArtist, rawTitle, duration }
 */
function scoreLyricsResult(result, query) {
    const name = result.trackName || result.name || '';
    const resultArtist = result.artistName || '';
    const nameNoFeat = name.replace(LYRICS_FEAT, ' ');

    const titleSim = Math.max(
        lyricsSimilarity(name, query.title),
        lyricsSimilarity(nameNoFeat, query.title),
        query.titleNoFeat ? lyricsSimilarity(nameNoFeat, query.titleNoFeat) : 0
    );

    let artistSim = 0.5; // unknown artist -> neutral
    if (query.artist) {
        artistSim = Math.max(
            lyricsArtistSimilarity(resultArtist, query.artist),
            lyricsArtistSimilarity(lyricsPrimaryArtist(resultArtist), query.primaryArtist || query.artist)
        );
    }

    const { score: durationScore, diff } = lyricsDurationScore(query.duration, result.duration);

    let score = titleSim * 0.45 + artistSim * 0.35 + durationScore * 0.2;

    // Different versions (live / remix / slowed ...) usually have different timings.
    const wanted = lyricsVersionTags(query.rawTitle || query.title);
    const got = lyricsVersionTags(name + ' ' + (result.albumName || ''));
    wanted.forEach(tag => { if (!got.has(tag)) score -= 0.06; });
    got.forEach(tag => { if (!wanted.has(tag)) score -= 0.08; });

    if (diff !== null && diff > 20 && result.syncedLyrics) score -= 0.12;
    if (result.syncedLyrics) score += 0.04;
    if (result.syncedLyrics && lyricsHaveWordTiming(result.syncedLyrics)) score += 0.02;
    if (!result.syncedLyrics && !result.plainLyrics && !result.instrumental) score -= 0.2;

    return {
        score: Math.max(0, Math.min(1.05, score)),
        titleSim,
        artistSim,
        durationDiff: diff,
        durationDelta: diff === null ? null : Number(result.duration) - Number(query.duration),
        artistKnown: !!query.artist,
    };
}

/**
 * Strict gate for using a result automatically. A matching title is not
 * enough: lots of different songs share a title ("Bad News"). When we know
 * the artist it must match; when we don't, the length must match closely.
 * Showing no lyrics is better than showing someone else's.
 */
function isConfidentLyricsMatch(entry, allResults = []) {
    if (!entry || !(entry.syncedLyrics || entry.plainLyrics)) return false;
    const m = entry.match;
    if (m.score < LYRICS_AUTO_ACCEPT_SCORE || m.titleSim < 0.6) return false;
    if (m.artistKnown) {
        if (m.artistSim < LYRICS_ARTIST_MIN_SIM) return false;
    } else {
        // No artist to check: only accept a near-exact length match, and only
        // if no other artist has a same-titled song of similar length.
        if (m.durationDiff === null || m.durationDiff > 1.5 || m.titleSim < 0.85) return false;
        const rivals = allResults.filter(other => other !== entry
            && (other.syncedLyrics || other.plainLyrics)
            && other.match.titleSim >= 0.85
            && other.match.durationDiff !== null && other.match.durationDiff <= 5
            && lyricsArtistSimilarity(other.artistName, entry.artistName) < LYRICS_ARTIST_MIN_SIM);
        if (rivals.length) return false;
    }
    // Same song but a clearly different length usually means another version.
    if (m.durationDiff !== null && m.durationDiff > 15) return false;
    return true;
}

/* ============================================================================
 * 3. LRCLIB LOOKUP
 * ========================================================================== */

function lyricsParseDuration(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        return value > 10000 ? value / 1000 : value; // milliseconds guard
    }
    const text = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const n = Number(text);
        return n > 10000 ? n / 1000 : n; // milliseconds guard
    }
    const parts = text.split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0) || null;
}

/** Waits briefly for the <audio> metadata so we can match by duration. */
function lyricsWaitForDuration(signal, timeoutMs = 2500) {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return Promise.resolve(audio.duration);
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            audio.removeEventListener('loadedmetadata', done);
            if (signal) signal.removeEventListener('abort', done);
            resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
        };
        const timer = setTimeout(done, timeoutMs);
        audio.addEventListener('loadedmetadata', done, { once: true });
        if (signal) signal.addEventListener('abort', done, { once: true });
    });
}

async function lrclibRequest(path, params, signal) {
    const url = new URL(`${LRCLIB_BASE}/${path}`);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
    });

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), LYRICS_REQUEST_TIMEOUT_MS);
    const onAbort = () => timeoutController.abort();
    if (signal) {
        if (signal.aborted) timeoutController.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        const response = await fetch(url, { signal: timeoutController.signal });
        if (!response.ok) return [];
        const data = await response.json();
        if (Array.isArray(data)) return data;
        return data && typeof data === 'object' && data.id ? [data] : [];
    } catch (err) {
        if (signal && signal.aborted) throw err;
        console.warn(`[LYRICS] ${path} request failed:`, err.name === 'AbortError' ? 'timeout' : err);
        return [];
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Collects, de-duplicates and ranks LRCLIB candidates for a track.
 * Stops early once a confident match is found unless `exhaustive` is set
 * (the manual picker wants the full list).
 */
async function findLyricsCandidates(track, { signal, exhaustive = false } = {}) {
    const cleaned = cleanLyricsMetadata(track.title, track.artist);
    const query = {
        ...cleaned,
        rawTitle: track.title,
        duration: track.duration || null,
    };
    const album = track.album && !/^(single|unknown( album)?)$/i.test(track.album) ? track.album : '';

    const byId = new Map();
    const add = results => {
        results.forEach(result => {
            if (!result || byId.has(result.id)) return;
            byId.set(result.id, { ...result, match: scoreLyricsResult(result, query) });
        });
    };
    const best = () => {
        let top = null;
        byId.forEach(entry => { if (!top || entry.match.score > top.match.score) top = entry; });
        return top;
    };
    const confident = () => !exhaustive && (best()?.match.score || 0) >= 0.85;

    if (!query.title) return { query, results: [] };

    // Stage 1: exact signature lookup (LRCLIB matches duration within ±2s).
    if (query.duration && query.artist) {
        const stage1 = [lrclibRequest('get', {
            track_name: query.title, artist_name: query.artist, album_name: album, duration: Math.round(query.duration),
        }, signal)];
        if (album) {
            stage1.push(lrclibRequest('get', {
                track_name: query.title, artist_name: query.artist, duration: Math.round(query.duration),
            }, signal));
        }
        (await Promise.all(stage1)).forEach(add);
        if (confident()) return { query, results: lyricsSortCandidates(byId) };
    }

    // Stage 2: structured + free-text search in parallel.
    const stage2 = [lrclibRequest('search', { q: `${query.title} ${query.artist}`.trim() }, signal)];
    if (query.artist) stage2.push(lrclibRequest('search', { track_name: query.title, artist_name: query.artist }, signal));
    if (query.primaryArtist && query.primaryArtist !== query.artist) {
        stage2.push(lrclibRequest('search', { track_name: query.title, artist_name: query.primaryArtist }, signal));
    }
    (await Promise.all(stage2)).forEach(add);
    if (confident()) return { query, results: lyricsSortCandidates(byId) };

    // Stage 3: fallbacks - title without "feat.", alternative title splits, title only.
    const stage3 = [];
    if (query.titleNoFeat) stage3.push(lrclibRequest('search', { q: `${query.titleNoFeat} ${query.primaryArtist}`.trim() }, signal));
    query.alternatives.slice(0, 2).forEach(alt => {
        stage3.push(lrclibRequest('search', { q: `${alt.title} ${alt.artist}`.trim() }, signal));
    });
    stage3.push(lrclibRequest('search', { track_name: query.titleNoFeat || query.title }, signal));
    (await Promise.all(stage3)).forEach(add);

    return { query, results: lyricsSortCandidates(byId) };
}

function lyricsSortCandidates(byId) {
    return Array.from(byId.values()).sort((a, b) => b.match.score - a.match.score);
}

/* ============================================================================
 * 4. PARSING + APPLYING LYRICS
 * ========================================================================== */

/* --- Word-level timing (Enhanced LRC / "A2" format) ---------------------
 * A line may carry per-word timestamps:
 *   [00:12.00]<00:12.00>Hello <00:12.48>bright <00:12.90>world<00:13.60>
 * A trailing tag with no word after it marks when the last word ends.
 * Lines become { time, text, words: [{ time, end, text }] }.               */
const LYRIC_WORD_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const LYRIC_WORD_TAG_TEST = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/;

function lrcPartsToSeconds(min, sec, frac) {
    const fraction = frac ? Number(frac) / Math.pow(10, frac.length) : 0;
    return Number(min) * 60 + Number(sec) + fraction;
}

function formatLrcStamp(time) {
    const totalCs = Math.round(Math.max(0, time) * 100);
    const mm = String(Math.floor(totalCs / 6000)).padStart(2, '0');
    const ss = String(Math.floor((totalCs % 6000) / 100)).padStart(2, '0');
    const cs = String(totalCs % 100).padStart(2, '0');
    return `${mm}:${ss}.${cs}`;
}

function lyricsHaveWordTiming(text) {
    return LYRIC_WORD_TAG_TEST.test(String(text || ''));
}

/** Splits a line body into plain text + optional word timings. */
function parseLyricLineBody(body, lineTime = null, offset = 0) {
    const raw = String(body || '');
    if (!LYRIC_WORD_TAG_TEST.test(raw)) return { text: raw.trim(), words: null };

    const words = [];
    let lead = '';
    let current = null;
    let last = 0;
    let match;
    LYRIC_WORD_TAG_RE.lastIndex = 0;
    while ((match = LYRIC_WORD_TAG_RE.exec(raw)) !== null) {
        const segment = raw.slice(last, match.index);
        if (current) current.text += segment; else lead += segment;
        if (current && current.text.trim()) words.push(current);
        current = { time: Math.max(0, lrcPartsToSeconds(match[1], match[2], match[3]) - offset), text: '' };
        last = LYRIC_WORD_TAG_RE.lastIndex;
    }
    if (current) current.text += raw.slice(last);
    let endTime = null;
    if (current && current.text.trim()) words.push(current);
    else if (current) endTime = current.time;

    if (lead.trim()) words.unshift({ time: lineTime ?? (words[0] ? words[0].time : 0), text: lead });
    if (!words.length) return { text: '', words: null };

    // Typos like a word stamped earlier than the one before it: keep order.
    for (let i = 1; i < words.length; i++) {
        if (words[i].time < words[i - 1].time) words[i].time = words[i - 1].time;
    }
    if (endTime !== null && endTime < words[words.length - 1].time) endTime = null;
    words.forEach((word, i) => {
        word.end = i + 1 < words.length ? words[i + 1].time : endTime;
    });
    const text = words.map(w => w.text).join('').replace(/\s+/g, ' ').trim();
    return { text, words };
}

/** Fills in missing end times for the last word of each line. */
function finalizeLyricWordEnds(lines) {
    lines.forEach((line, i) => {
        if (!line.words || !line.words.length) return;
        const lastWord = line.words[line.words.length - 1];
        if (lastWord.end !== null && lastWord.end !== undefined) return;
        const next = lines.slice(i + 1).find(l => l.time !== null && l.time !== undefined);
        const span = line.words.length > 1
            ? (lastWord.time - line.words[0].time) / (line.words.length - 1)
            : 0.6;
        const natural = lastWord.time + Math.min(2.5, Math.max(0.35, span * 1.4));
        lastWord.end = Math.round((next ? Math.min(next.time, natural) : natural) * 100) / 100;
    });
    return lines;
}

/** True when every word of a line has a timestamp (tapping can leave gaps). */
function lyricWordsComplete(line) {
    return !!(line && line.words && line.words.length
        && line.words.every(w => w.time !== null && w.time !== undefined));
}

/** Serializes one timed line, keeping word timings when present. */
function lyricLineToLrc(line) {
    const stamp = `[${formatLrcStamp(line.time)}]`;
    if (lyricWordsComplete(line)) {
        const body = line.words.map(w => `<${formatLrcStamp(w.time)}>${w.text}`).join('');
        const lastWord = line.words[line.words.length - 1];
        const end = lastWord.end !== null && lastWord.end !== undefined ? `<${formatLrcStamp(lastWord.end)}>` : '';
        return `${stamp}${body.replace(/\s+$/, '')}${end}`;
    }
    const text = line.text === '\u266a' ? '' : line.text;
    return `${stamp}${text}`;
}

/** Parses LRC text into [{time, text, words?}] (time in seconds). Handles
 *  multiple timestamps per line, [mm:ss], [mm:ss.xx], [mm:ss:xx],
 *  [offset:±ms] and Enhanced-LRC <mm:ss.xx> word timings. */
function parseLRC(lrcString) {
    const lines = [];
    let offset = 0;
    const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

    String(lrcString || '').split(/\r?\n/).forEach(rawLine => {
        const offsetMatch = rawLine.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
        if (offsetMatch) { offset = Number(offsetMatch[1]) / 1000; return; }

        const times = [];
        let match;
        let lastIndex = 0;
        tagRe.lastIndex = 0;
        while ((match = tagRe.exec(rawLine)) !== null) {
            const fraction = match[3] ? Number(match[3]) / Math.pow(10, match[3].length) : 0;
            times.push(Number(match[1]) * 60 + Number(match[2]) + fraction);
            lastIndex = tagRe.lastIndex;
        }
        if (!times.length) return;
        const body = rawLine.slice(lastIndex);
        times.forEach(time => {
            const lineTime = Math.max(0, time - offset);
            // Word timings only make sense for a line sung once.
            const parsed = parseLyricLineBody(body, lineTime, times.length === 1 ? offset : 0);
            lines.push(times.length === 1 && parsed.words
                ? { time: lineTime, text: parsed.text, words: parsed.words }
                : { time: lineTime, text: parsed.text });
        });
    });

    lines.sort((a, b) => a.time - b.time);

    // Empty timed lines are musical breaks: show one "♪" per gap, drop leading/trailing ones.
    const out = [];
    lines.forEach(line => {
        if (!line.text) {
            if (out.length && out[out.length - 1].text !== '♪') out.push({ time: line.time, text: '♪' });
        } else {
            out.push(line);
        }
    });
    while (out.length && out[out.length - 1].text === '♪') out.pop();
    return finalizeLyricWordEnds(out);
}

function plainLyricsToLines(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.trim());
    const out = [];
    lines.forEach(line => {
        if (!line && (!out.length || out[out.length - 1].text === '')) return; // collapse blank runs
        out.push({ time: null, text: line });
    });
    while (out.length && out[out.length - 1].text === '') out.pop();
    return out;
}

function lyricsTextLooksSynced(text) {
    return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(String(text || ''));
}

/** Sets the player's lyrics from stored text and renders them. */
function applyLyricsText(text, isSynced) {
    let lines = [];
    let synced = false;
    if (isSynced || lyricsTextLooksSynced(text)) {
        lines = parseLRC(text);
        synced = lines.length > 0;
    }
    if (!synced) lines = plainLyricsToLines(text);

    lyricsData = lines;
    lyricsAreSynced = synced;
    renderLyrics();
    showLyricsButton(lines.length > 0);
}

function showLyricsButton(hasLyrics) {
    if (!btnLyrics) return;
    if (hasLyrics) {
        if (btnFindLyrics) btnFindLyrics.classList.remove('show-lyrics-btn');
        btnLyrics.classList.add('show-lyrics-btn');
        btnLyrics.parentElement.classList.add('has-lyrics');
    } else if (btnFindLyrics) {
        btnLyrics.classList.remove('show-lyrics-btn');
        btnFindLyrics.classList.add('show-lyrics-btn');
        btnFindLyrics.parentElement.classList.add('has-lyrics');
    }
}

function saveLyricsForSong(songId, text, isSynced, signal) {
    return fetch(`/api/lyrics/${encodeURIComponent(songId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ lyrics: text, is_synced: !!isSynced }),
    });
}

/* ============================================================================
 * 5. AUTOMATIC FETCH (on song load)
 * ========================================================================== */

/** Called by loadSong() in player.js. */
function setCurrentLyricsTrack(song) {
    currentLyricsTrack = song ? {
        id: song.id || null,
        title: song.title || '',
        artist: song.artist || '',
        album: song.album || '',
        duration: lyricsParseDuration(song.duration),
    } : null;
}

async function fetchLyrics(title, artist, songId, preferUser = null) {
    if (_lyricsFetchAbort) _lyricsFetchAbort.abort();
    if (!title) return;
    if (songId !== window.currentlyPlayingSongId) return;

    const controller = new AbortController();
    _lyricsFetchAbort = controller;
    const stale = () => _lyricsFetchAbort !== controller || songId !== window.currentlyPlayingSongId;

    try {
        // 1. Saved lyrics on our server (user edit / earlier match).
        if (songId) {
            let lyricsUrl = `/api/lyrics/${encodeURIComponent(songId)}`;
            if (preferUser) lyricsUrl += `?prefer=${encodeURIComponent(preferUser)}`;
            try {
                const serverResponse = await fetch(lyricsUrl, { signal: controller.signal });
                if (stale()) return;
                if (serverResponse.ok) {
                    const cachedData = await serverResponse.json();
                    if (stale()) return;
                    if (cachedData && cachedData.lyrics) {
                        applyLyricsText(cachedData.lyrics, !!cachedData.is_synced);
                        return;
                    }
                }
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.warn('[LYRICS] Server lookup failed:', err);
            }
        }

        if (!navigator.onLine) { showLyricsButton(false); return; }

        // 2. LRCLIB lookup with duration-aware ranking.
        const track = currentLyricsTrack && String(currentLyricsTrack.id) === String(songId)
            ? { ...currentLyricsTrack }
            : { title, artist, album: '', duration: null };
        if (!track.duration) track.duration = await lyricsWaitForDuration(controller.signal);
        if (stale()) return;

        const { query, results } = await findLyricsCandidates(track, { signal: controller.signal });
        if (stale()) return;

        const best = results.find(entry => isConfidentLyricsMatch(entry, results)) || null;
        const accepted = !!best;
        if (!best && results.length) {
            const top = results[0];
            console.log(`[LYRICS] Rejected "${top.trackName}" by "${top.artistName}" (score ${top.match.score.toFixed(2)}, artist ${top.match.artistSim.toFixed(2)}) - not confident enough`);
        }

        console.log('[LYRICS] Lookup', {
            query: `${query.title} — ${query.artist}`,
            duration: track.duration,
            best: best ? `${best.trackName} — ${best.artistName} (${best.match.score.toFixed(2)})` : null,
            accepted: !!accepted,
        });

        if (!accepted) { showLyricsButton(false); return; }

        const text = best.syncedLyrics || best.plainLyrics;
        applyLyricsText(text, !!best.syncedLyrics);

        // Only persist confident matches, so a shaky guess never "sticks".
        if (songId && best.match.score >= LYRICS_AUTO_CACHE_SCORE) {
            saveLyricsForSong(songId, text, !!best.syncedLyrics, controller.signal)
                .catch(err => { if (err.name !== 'AbortError') console.warn('[LYRICS] Cache save failed:', err); });
        }
    } catch (err) {
        if (err.name === 'AbortError' || stale()) return;
        console.error('Failed to fetch lyrics:', err);
        showLyricsButton(false);
    } finally {
        if (_lyricsFetchAbort === controller) _lyricsFetchAbort = null;
    }
}

function resetLyrics() {
    if (_lyricsFetchAbort) _lyricsFetchAbort.abort();
    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    if (_lyricsSelectionAbort) _lyricsSelectionAbort.abort();
    _lyricsFetchAbort = null;
    _lyricsSearchAbort = null;
    _lyricsSelectionAbort = null;
    if (lyricsSelectionModal) lyricsSelectionModal.classList.add('hidden');
    if (lyricsSelectionLoading) lyricsSelectionLoading.classList.add('hidden');

    if (isLyricEditMode) {
        if (lyricEditorState.dirty) showToast('Song changed — unsaved lyric edits were discarded', 'error');
        closeLyricEditor({ render: false });
    }

    lyricsData = [];
    lyricsAreSynced = true;
    activeLyricIndex = -1;
    if (lyricsContent) {
        lyricsContent.style.removeProperty('transform');
        lyricsContent.classList.remove('lyrics-position-immediate', 'lyrics-editing', 'lyrics-unsynced');
        lyricsContent.innerHTML = '';
    }
    if (lyricsScrollArea) lyricsScrollArea.classList.remove('lyrics-editing', 'lyrics-unsynced');
    if (btnLyrics) btnLyrics.classList.remove('show-lyrics-btn');
    if (btnFindLyrics) btnFindLyrics.classList.remove('show-lyrics-btn');
    if (btnLyrics && btnLyrics.parentElement) btnLyrics.parentElement.classList.remove('has-lyrics');

    if (isLyricsActive) deactivateLyricsView();
}

/* ============================================================================
 * 6. RENDERING (view mode)
 * ========================================================================== */

function renderLyrics() {
    if (!lyricsContent) return;
    if (isLyricEditMode) { renderLyricEditorRows(); return; }

    activeLyricIndex = -1;
    resetDesktopLyricsPresentation();
    lyricsContent.classList.remove('lyrics-editing');
    lyricsContent.classList.toggle('lyrics-unsynced', !lyricsAreSynced);
    if (lyricsScrollArea) {
        lyricsScrollArea.classList.remove('lyrics-editing');
        lyricsScrollArea.classList.toggle('lyrics-unsynced', !lyricsAreSynced);
    }
    lyricsContent.innerHTML = '';

    if (!lyricsAreSynced && lyricsData.length) {
        const note = document.createElement('div');
        note.className = 'lyrics-unsynced-note';
        note.innerHTML = `<i class='bx bx-info-circle'></i><span>These lyrics aren't time-synced.</span>`;
        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.textContent = 'Sync them';
        syncBtn.addEventListener('click', () => openLyricEditor({ tab: 'sync' }));
        note.appendChild(syncBtn);
        lyricsContent.appendChild(note);
    }

    const estimateWords = lyricsExperimentEnabled('lyricsEstimatedWords');
    lyricsData.forEach((line, index) => {
        const lineEl = document.createElement('div');
        lineEl.className = 'lyric-line';
        lineEl.dataset.index = index;

        if (!line.text) {
            lineEl.classList.add('lyric-gap');
            lineEl.setAttribute('aria-hidden', 'true');
            lyricsContent.appendChild(lineEl);
            return;
        }
        if (line.text === '♪') {
            lineEl.classList.add('instrumental');
            const nextTimed = lyricsData.slice(index + 1).find(l => Number.isFinite(l.time));
            if (lyricsAreSynced && nextTimed && nextTimed.time - line.time >= LYRIC_DOTS_MIN_GAP) {
                renderLyricDots(lineEl, line, nextTimed.time);
                lineEl.dataset.time = line.time;
                lyricsContent.appendChild(lineEl);
                return;
            }
        }
        let words = lyricWordsComplete(line) ? line.words : null;
        if (!words && lyricsAreSynced && estimateWords) {
            words = estimateLyricWords(line, lyricsData.slice(index + 1).find(l => Number.isFinite(l.time)));
            if (words) lineEl.classList.add('word-estimated');
        }
        if (lyricsAreSynced && words) renderLyricWords(lineEl, { ...line, words });
        else lineEl.textContent = line.text;

        if (lyricsAreSynced) {
            lineEl.dataset.time = line.time;
            lineEl.setAttribute('role', 'button');
            lineEl.setAttribute('tabindex', '0');
            const activateLine = () => {
                if (audio && isFinite(line.time)) {
                    audio.currentTime = line.time;
                    if (typeof stopLyricsBrowsing === 'function') stopLyricsBrowsing({ recenter: false });
                    else isUserScrollingLyrics = false;
                    activeLyricIndex = -1;
                    updateActiveLyric();
                    playSong();
                }
            };
            lineEl.addEventListener('click', activateLine);
            // Touch: don't leave the tapped line focused (iOS can then show a
            // caret / selection handles on it). Keyboard focus is unaffected.
            lineEl.addEventListener('touchend', () => {
                setTimeout(() => { if (document.activeElement === lineEl) lineEl.blur(); }, 0);
            }, { passive: true });
            lineEl.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                activateLine();
            });
        }
        lyricsContent.appendChild(lineEl);
    });

    lyricsContent.classList.toggle('lyrics-word-synced', !!lyricsContent.querySelector('.lyric-line.word-synced'));

    if (isLyricsActive && lyricsAreSynced) {
        updateActiveLyric(true);
        startDesktopLyricsSync();
    }
    ensureLyricWordTicker();
}

/* --- Experimental settings --- */

function lyricsExperimentEnabled(feature) {
    return !!(window.StreamifyExperiments && window.StreamifyExperiments.isEnabled(feature));
}

/**
 * Estimated word timing for a line that only has a start time. The line's
 * singing time is guessed from its length (capped by the gap to the next
 * line), then shared across words by their letter count, so short words go
 * by quickly and long words take longer. Approximate by design.
 */
function estimateLyricWords(line, nextLine) {
    if (!line || line.time === null || line.time === undefined) return null;
    const text = String(line.text || '');
    if (!text.trim() || text === '♪') return null;
    const tokens = text.match(/\S+\s*/g);
    if (!tokens || tokens.length < 2) return null;

    const nextTime = nextLine && Number.isFinite(nextLine.time) ? nextLine.time : line.time + 5;
    const available = Math.max(0.4, nextTime - line.time);
    const letters = tokens.reduce((n, t) => n + t.trim().length, 0);
    const sung = Math.min(available * 0.9, Math.max(0.9, letters * 0.075 + tokens.length * 0.06));

    const weights = tokens.map(t => t.trim().replace(/[^\p{L}\p{N}]/gu, '').length + 1.5);
    const total = weights.reduce((a, b) => a + b, 0);
    let elapsed = 0;
    return tokens.map((token, i) => {
        const start = line.time + (elapsed / total) * sung;
        elapsed += weights[i];
        const end = line.time + (elapsed / total) * sung;
        return { time: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: token };
    });
}

/* --- Word-by-word highlighting (Apple Music style) --- */

const LYRIC_HELD_WORD_SECONDS = 0.9;   // words sung at least this long get the letter wave
const LYRIC_DOTS_MIN_GAP = 2.5;        // instrumental gaps shorter than this keep a plain ♪

/**
 * Builds word spans for a timed line. Syllables written without a space
 * between them ("<t>mid<t>night") are kept in one no-wrap group so a word
 * never breaks across lines. Long, held words are split into letters so
 * they can do the Apple-style rising wave.
 */
function renderLyricWords(lineEl, line) {
    lineEl.classList.add('word-synced');
    const spans = [];
    let group = null;
    const closeGroup = () => { group = null; };
    const openGroup = () => {
        if (!group) {
            group = document.createElement('span');
            group.className = 'lyric-word-group';
            lineEl.appendChild(group);
        }
        return group;
    };

    line.words.forEach((word, i) => {
        const match = word.text.match(/^(\s*)(.*?)(\s*)$/s);
        const [, leading, core, trailing] = match || ['', '', word.text, ''];
        if (leading) { closeGroup(); lineEl.appendChild(document.createTextNode(leading)); }
        if (core) {
            const span = document.createElement('span');
            span.className = 'lyric-word';
            const next = line.words[i + 1];
            let end = word.end ?? (next ? next.time : word.time + 0.5);
            end = Math.max(end, word.time + 0.05);
            const held = end - word.time >= LYRIC_HELD_WORD_SECONDS
                && core.length >= 2 && core.length <= 14 && /\p{L}/u.test(core);
            let letters = null;
            if (held) {
                span.classList.add('is-held');
                letters = Array.from(core).map(ch => {
                    const letter = document.createElement('span');
                    letter.className = 'lyric-letter';
                    letter.textContent = ch;
                    span.appendChild(letter);
                    return { el: letter, value: -1 };
                });
                span.setAttribute('aria-label', core);
            } else {
                span.textContent = core;
            }
            openGroup().appendChild(span);
            spans.push({ el: span, start: word.time, end, state: '', progress: -1, letters, held });
        }
        if (trailing) { closeGroup(); lineEl.appendChild(document.createTextNode(trailing)); }
    });
    // The last word of a line is where singers hold notes the longest.
    const last = spans[spans.length - 1];
    if (last) {
        last.final = true;
        last.el.classList.add('is-final');
    }
    lineEl._lyricWords = spans;
}

/** Apple-style breathing dots for an instrumental break in synced lyrics. */
function renderLyricDots(lineEl, line, nextTime) {
    lineEl.classList.add('word-synced', 'lyric-dots-line');
    lineEl.setAttribute('aria-label', 'Instrumental');
    const holder = document.createElement('span');
    holder.className = 'lyric-dots';
    const fillEnd = nextTime - 0.6;
    const step = (fillEnd - line.time) / 3;
    const spans = [];
    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'lyric-word lyric-dot';
        holder.appendChild(dot);
        spans.push({ el: dot, start: line.time + step * i, end: line.time + step * (i + 1), state: '', progress: -1, letters: null });
    }
    lineEl.appendChild(holder);
    lineEl._lyricWords = spans;
    lineEl._lyricDotsEnd = fillEnd;
    lineEl._lyricDotsStart = line.time;
    lineEl._lyricDotsNext = nextTime;
    lineEl._lyricDotsHolder = holder;
}

const LYRIC_DOTS_BREATH_SECONDS = 3.4;  // one slow in-and-out
const LYRIC_DOTS_EXIT_SECONDS = 0.7;    // settle, swell, then shrink away before the next line

/**
 * Scale and opacity of the dots, worked out from the playback time every
 * frame. Doing it here (instead of a CSS keyframe that gets switched off)
 * means the breathing settles, swells and shrinks away in one continuous
 * motion that lands exactly when the next line starts.
 */
function paintLyricDots(lineEl, time) {
    const holder = lineEl._lyricDotsHolder;
    if (!holder) return;
    const start = lineEl._lyricDotsStart;
    const next = lineEl._lyricDotsNext;
    const exitLength = Math.min(LYRIC_DOTS_EXIT_SECONDS, Math.max(0.3, (next - start) * 0.25));
    const exitStart = next - exitLength;
    const calm = document.documentElement.classList.contains('lyrics-no-motion') ||
        (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // Breathing fades out over the second before the exit so the swell
    // starts from rest instead of from the middle of a breath.
    const settle = 1 - lyricSmoothstep(Math.min(1, Math.max(0, (time - (exitStart - 1)) / 1)));
    const breathe = calm ? 1 : 1 + 0.055 * Math.sin(((time - start) / LYRIC_DOTS_BREATH_SECONDS) * Math.PI * 2) * settle;

    const e = Math.min(1, Math.max(0, (time - exitStart) / exitLength));
    let exitScale = 1;
    if (!calm) {
        exitScale = e < 0.35
            ? 1 + 0.14 * lyricSmoothstep(e / 0.35)
            : 1.14 * (1 - Math.pow((e - 0.35) / 0.65, 2.2));
    }
    const opacity = e <= 0.45 ? 1 : 1 - lyricSmoothstep((e - 0.45) / 0.55);

    const scale = Math.max(0, breathe * exitScale);
    holder.style.setProperty('--ds', scale.toFixed(4));
    holder.style.setProperty('--do', opacity.toFixed(3));
}

let lyricWordRaf = null;
let lyricWordLineEl = null;

function resetLyricWordLine(lineEl) {
    if (!lineEl || !lineEl._lyricWords) return;
    lineEl.classList.remove('is-ending');
    if (lineEl._lyricDotsHolder) {
        // A finished break stays gone while its row folds away; one that is
        // still ahead (after seeking back) returns to rest.
        const holder = lineEl._lyricDotsHolder;
        if (audio && audio.currentTime >= lineEl._lyricDotsNext - 0.05) {
            holder.style.setProperty('--ds', '0');
            holder.style.setProperty('--do', '0');
        } else {
            holder.style.removeProperty('--ds');
            holder.style.removeProperty('--do');
        }
    }
    lineEl._lyricWords.forEach(word => {
        word.el.classList.remove('is-sung', 'is-singing');
        word.el.style.removeProperty('--wp');
        word.el.style.removeProperty('--wl');
        word.state = '';
        word.progress = -1;
        if (word.letters) word.letters.forEach(letter => {
            letter.el.style.removeProperty('--lp');
            letter.el.style.removeProperty('--lb');
            letter.value = -1;
        });
    });
}

const lyricEaseOut = t => 1 - Math.pow(1 - t, 3);
const lyricSmoothstep = t => t * t * (3 - 2 * t);

function paintLyricWords(lineEl, time) {
    lineEl._lyricWords.forEach(word => {
        const raw = (time - word.start) / (word.end - word.start);
        const progress = raw <= 0 ? 0 : raw >= 1 ? 1 : Math.round(raw * 1000) / 1000;
        const state = progress >= 1 ? 'sung' : progress > 0 ? 'singing' : '';
        if (state !== word.state) {
            word.el.classList.toggle('is-sung', state === 'sung');
            word.el.classList.toggle('is-singing', state === 'singing');
            word.state = state;
        }
        if (progress !== word.progress) {
            // --wp drives the left-to-right fill, --wl the gentle lift.
            word.el.style.setProperty('--wp', progress.toFixed(3));
            word.el.style.setProperty('--wl', lyricSmoothstep(progress).toFixed(3));
            word.progress = progress;
        }
        if (word.letters) {
            // Letters rise one after another as the fill passes them and
            // swell briefly (--lb) before settling, like a held note.
            const n = word.letters.length;
            word.letters.forEach((letter, i) => {
                const local = Math.min(1, Math.max(0, progress * (n + 1.5) - i));
                const value = Math.round(local * 100) / 100;
                if (value === letter.value) return;
                letter.value = value;
                letter.el.style.setProperty('--lp', lyricEaseOut(value).toFixed(3));
                // A held final word keeps glowing until the line ends (then CSS
                // fades it out); other held words swell and settle.
                const swell = word.final ? lyricSmoothstep(Math.min(1, value * 1.6)) : Math.sin(Math.PI * value);
                letter.el.style.setProperty('--lb', swell.toFixed(3));
            });
        }
    });
    if (lineEl._lyricDotsEnd !== undefined) {
        lineEl.classList.toggle('is-ending', time >= lineEl._lyricDotsEnd);
        paintLyricDots(lineEl, time);
    }
}

function lyricWordTick() {
    lyricWordRaf = null;
    if (!isLyricsActive || isLyricEditMode || !lyricsAreSynced || !lyricsContent) {
        resetLyricWordLine(lyricWordLineEl);
        lyricWordLineEl = null;
        return;
    }
    const active = lyricsContent.querySelector('.lyric-line.active.word-synced');
    if (active !== lyricWordLineEl) {
        resetLyricWordLine(lyricWordLineEl);
        lyricWordLineEl = active;
    }
    if (active && active._lyricWords) paintLyricWords(active, audio.currentTime);
    if (!audio.paused && !document.hidden) lyricWordRaf = requestAnimationFrame(lyricWordTick);
}

function ensureLyricWordTicker() {
    if (lyricWordRaf !== null || !lyricsContent || !lyricsContent.classList.contains('lyrics-word-synced')) return;
    lyricWordRaf = requestAnimationFrame(lyricWordTick);
}

['play', 'playing', 'seeked', 'timeupdate', 'pause'].forEach(type => audio.addEventListener(type, ensureLyricWordTicker));
document.addEventListener('visibilitychange', ensureLyricWordTicker);
if (btnLyrics) btnLyrics.addEventListener('click', () => requestAnimationFrame(ensureLyricWordTicker));

/* ============================================================================
 * 7. "FIND LYRICS" PICKER
 * ========================================================================== */

function lyricsFormatDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || seconds <= 0) return '?:??';
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function openLyricsSearchModal() {
    if (!window.currentlyPlayingSongId || !lyricsSelectionModal) return;
    if (_lyricsFetchAbort) _lyricsFetchAbort.abort();
    _lyricsFetchAbort = null;

    // Read from the song object, never from the DOM (the artist element also
    // contains the quality badge, e.g. "320kbps").
    const track = currentLyricsTrack || { title: '', artist: '' };
    const cleaned = cleanLyricsMetadata(track.title, track.artist);
    lyricsSearchTitle.value = cleaned.title;
    lyricsSearchArtist.value = cleaned.artist;

    if (lyricsSelectionTrack) {
        const duration = track.duration || (Number.isFinite(audio.duration) ? audio.duration : null);
        lyricsSelectionTrack.textContent = `Now playing: ${track.title || 'Unknown'}${track.artist ? ' — ' + track.artist : ''}${duration ? ' · ' + lyricsFormatDuration(duration) : ''}`;
    }

    lyricsSelectionResults.innerHTML = '';
    lyricsSelectionLoading.classList.add('hidden');
    lyricsSelectionEmpty.classList.add('hidden');
    lyricsSelectionModal.classList.remove('hidden');
    performLyricsSearch();
    setTimeout(() => lyricsSearchTitle.focus({ preventScroll: true }), 50);
}

function closeLyricsSearchModal() {
    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    _lyricsSearchAbort = null;
    if (lyricsSelectionModal) lyricsSelectionModal.classList.add('hidden');
}

async function performLyricsSearch() {
    const title = lyricsSearchTitle.value.trim();
    const artist = lyricsSearchArtist.value.trim();
    const songId = window.currentlyPlayingSongId;
    if (!title || !songId) return;

    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    const controller = new AbortController();
    _lyricsSearchAbort = controller;
    const stale = () => _lyricsSearchAbort !== controller || songId !== window.currentlyPlayingSongId || lyricsSelectionModal.classList.contains('hidden');

    lyricsSelectionLoading.classList.remove('hidden');
    lyricsSelectionResults.innerHTML = '';
    lyricsSelectionEmpty.classList.add('hidden');

    try {
        const duration = (currentLyricsTrack && currentLyricsTrack.duration)
            || (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
        const { results } = await findLyricsCandidates(
            { title, artist, album: currentLyricsTrack?.album || '', duration },
            { signal: controller.signal, exhaustive: true }
        );
        if (stale()) return;
        lyricsSelectionLoading.classList.add('hidden');
        if (results.length) renderLyricsSelectionResults(results.slice(0, 25), songId);
        else lyricsSelectionEmpty.classList.remove('hidden');
    } catch (e) {
        if (e.name === 'AbortError' || stale()) return;
        console.error('Lyrics search failed:', e);
        lyricsSelectionLoading.classList.add('hidden');
        lyricsSelectionEmpty.classList.remove('hidden');
    } finally {
        if (_lyricsSearchAbort === controller) _lyricsSearchAbort = null;
    }
}

function renderLyricsSelectionResults(results, songId) {
    lyricsSelectionResults.innerHTML = '';

    results.forEach((result, index) => {
        const hasLyrics = !!(result.syncedLyrics || result.plainLyrics);
        const card = document.createElement('article');
        card.className = 'lyrics-result';
        if (!hasLyrics) card.classList.add('is-empty');

        const badges = [];
        if (index === 0 && isConfidentLyricsMatch(result, results)) badges.push(`<span class="lyrics-badge lyrics-badge-best"><i class='bx bxs-star'></i> Best match</span>`);
        if (result.match.artistKnown && result.match.artistSim < LYRICS_ARTIST_MIN_SIM) badges.push(`<span class="lyrics-badge lyrics-badge-none">Different artist</span>`);
        if (result.syncedLyrics && lyricsHaveWordTiming(result.syncedLyrics)) badges.push(`<span class="lyrics-badge lyrics-badge-synced"><i class='bx bx-text'></i> Word synced</span>`);
        else if (result.syncedLyrics) badges.push(`<span class="lyrics-badge lyrics-badge-synced">Synced</span>`);
        else if (result.plainLyrics) badges.push(`<span class="lyrics-badge">Plain text</span>`);
        else badges.push(`<span class="lyrics-badge lyrics-badge-none">Instrumental</span>`);

        const diff = result.match.durationDiff;
        let durationNote = '';
        if (diff !== null) {
            const cls = diff <= 3 ? 'ok' : diff <= 10 ? 'warn' : 'bad';
            const delta = result.match.durationDelta;
            const label = diff <= 1 ? 'same length' : `${Math.round(diff)}s ${delta > 0 ? 'longer' : 'shorter'}`;
            durationNote = `<span class="lyrics-duration-diff ${cls}">${label}</span>`;
        }

        const previewSource = result.plainLyrics || (result.syncedLyrics ? parseLRC(result.syncedLyrics).map(l => l.text).join('\n') : '');
        const previewLines = previewSource.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4);

        card.innerHTML = `
            <div class="lyrics-result-main">
                <div class="lyrics-result-title">${escapeHTML(result.trackName || result.name || 'Unknown title')}</div>
                <div class="lyrics-result-meta">
                    ${escapeHTML(result.artistName || 'Unknown artist')}
                    ${result.albumName ? `<span class="dot">•</span>${escapeHTML(result.albumName)}` : ''}
                    <span class="dot">•</span>${lyricsFormatDuration(result.duration)} ${durationNote}
                </div>
                <div class="lyrics-result-badges">${badges.join('')}</div>
                ${previewLines.length ? `<div class="lyrics-result-preview">${previewLines.map(l => `<span>${escapeHTML(l)}</span>`).join('')}</div>` : ''}
            </div>`;

        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'lyrics-result-use';
        useBtn.textContent = 'Use';
        useBtn.disabled = !hasLyrics;
        useBtn.addEventListener('click', () => selectLyricsResult(result, songId));
        card.appendChild(useBtn);

        lyricsSelectionResults.appendChild(card);
    });
}

function selectLyricsResult(result, expectedSongId = window.currentlyPlayingSongId) {
    const songId = window.currentlyPlayingSongId;
    if (!songId || String(songId) !== String(expectedSongId)) return;
    const text = result.syncedLyrics || result.plainLyrics;
    const isSynced = !!result.syncedLyrics;
    if (typeof text !== 'string' || !text) return;

    if (_lyricsSearchAbort) _lyricsSearchAbort.abort();
    _lyricsSearchAbort = null;
    if (_lyricsSelectionAbort) _lyricsSelectionAbort.abort();
    const controller = new AbortController();
    _lyricsSelectionAbort = controller;

    if (isLyricEditMode) closeLyricEditor({ render: false });
    applyLyricsText(text, isSynced);
    closeLyricsSearchModal();

    saveLyricsForSong(songId, text, isSynced, controller.signal).then(async response => {
        if (response.ok) {
            showToast('Lyrics saved', 'success', 2000);
        } else {
            const errData = await response.json().catch(() => ({}));
            console.error('Failed to save lyrics:', errData.error || response.status);
            showToast('Lyrics applied, but could not be saved', 'error');
        }
    }).catch(err => {
        if (err.name !== 'AbortError') console.error('Failed to save selected lyrics:', err);
    }).finally(() => {
        if (_lyricsSelectionAbort === controller) _lyricsSelectionAbort = null;
    });
}

/* ============================================================================
 * 8. LYRICS EDITOR
 * ========================================================================== */

function formatLyricsTime(time) {
    if (time === null || time === undefined || !Number.isFinite(time)) return '--:--.--';
    const totalCs = Math.round(time * 100);
    const min = Math.floor(totalCs / 6000);
    const sec = Math.floor((totalCs % 6000) / 100);
    const cs = totalCs % 100;
    return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function lyricLinesToText(lines) {
    const anyTimed = lines.some(l => l.time !== null && l.time !== undefined);
    return lines.map(line => {
        const text = line.text === '♪' ? '' : line.text;
        if (!anyTimed || line.time === null || line.time === undefined) return text;
        return lyricLineToLrc(line);
    }).join('\n');
}

/** Text tab -> lines. Keeps line order exactly as typed (no sorting). */
function lyricTextToLines(text) {
    const tagRe = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
    const out = [];
    String(text || '').replace(/\r/g, '').split('\n').forEach(raw => {
        if (/^\s*\[(?:ar|ti|al|by|offset|length|re|ve|au):/i.test(raw)) return; // LRC metadata tags
        const match = raw.match(tagRe);
        if (match) {
            const time = lrcPartsToSeconds(match[1], match[2], match[3]);
            const rest = raw.slice(match[0].length).replace(/^(\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/, '');
            const parsed = parseLyricLineBody(rest, time);
            out.push(parsed.words
                ? { time, text: parsed.text, words: parsed.words }
                : { time, text: parsed.text || '♪' });
        } else {
            const textLine = raw.trim();
            if (!textLine && (!out.length || out[out.length - 1].text === '')) return;
            out.push({ time: null, text: textLine });
        }
    });
    while (out.length && out[out.length - 1].text === '' && out[out.length - 1].time === null) out.pop();
    return finalizeLyricWordEnds(out);
}

function cloneLyricLines(lines) {
    return lines.map(line => {
        const copy = { time: line.time ?? null, text: String(line.text ?? '') };
        if (line.words && line.words.length) copy.words = line.words.map(w => ({ time: w.time, end: w.end ?? null, text: w.text }));
        return copy;
    });
}

/** Moves a line's word timings along with the line. */
function shiftLyricLineWords(line, delta) {
    if (!line.words || !delta) return;
    line.words.forEach(word => {
        word.time = Math.max(0, Math.round((word.time + delta) * 100) / 100);
        if (word.end !== null && word.end !== undefined) word.end = Math.max(0, Math.round((word.end + delta) * 100) / 100);
    });
}

function openLyricEditor({ tab = null } = {}) {
    if (!window.currentlyPlayingSongId || !lyricEditorEl) return;

    // Make sure the lyrics view is showing (editor lives inside it).
    if (!isLyricsActive && btnLyrics) btnLyrics.click();

    isLyricEditMode = true;
    stopDesktopLyricsSync();
    tempLyricsData = cloneLyricLines(lyricsData);
    lyricEditorState.dirty = false;
    lyricEditorState.playingIndex = -1;
    // Start on the first unsynced line (or the top when everything is timed).
    lyricEditorState.cursor = Math.max(0, tempLyricsData.findIndex(l => l.time === null));
    cancelLyricConfirm();

    document.body.classList.add('lyrics-editor-open');
    if (lyricsViewHeader) lyricsViewHeader.classList.add('hidden');
    lyricEditorEl.classList.remove('hidden');

    const defaultTab = tempLyricsData.length === 0 ? 'text' : 'sync';
    setLyricEditorTab(tab || defaultTab, { force: true });
    startLyricEditorClock();
}

function closeLyricEditor({ render = true } = {}) {
    isLyricEditMode = false;
    tempLyricsData = [];
    lyricEditorState.dirty = false;
    cancelLyricConfirm();
    stopLyricEditorClock();

    document.body.classList.remove('lyrics-editor-open');
    if (lyricEditorEl) lyricEditorEl.classList.add('hidden');
    if (lyricEditorFooter) lyricEditorFooter.classList.add('hidden');
    if (lyricEditorTextarea) lyricEditorTextarea.classList.add('hidden');
    if (lyricsScrollArea) lyricsScrollArea.classList.remove('hidden');
    if (lyricsViewHeader) lyricsViewHeader.classList.remove('hidden');
    if (lyricsContent) lyricsContent.classList.remove('lyrics-editing', 'lyrics-word-editing');
    if (lyricsScrollArea) lyricsScrollArea.classList.remove('lyrics-editing');
    if (lyricEditorFooter) lyricEditorFooter.classList.remove('is-words-tab');

    if (render) renderLyrics();
}

function markLyricEditorDirty() {
    lyricEditorState.dirty = true;
    updateLyricEditorStatus();
}

function setLyricEditorTab(tab, { force = false } = {}) {
    if (!force && tab === lyricEditorState.tab) return;

    // Leaving the Text tab: parse what was typed.
    if (!force && lyricEditorState.tab === 'text' && lyricEditorTextarea) {
        const parsed = lyricTextToLines(lyricEditorTextarea.value);
        if (lyricLinesToText(parsed) !== lyricLinesToText(tempLyricsData)) {
            tempLyricsData = parsed;
            lyricEditorState.dirty = true;
        }
        lyricEditorState.cursor = Math.min(lyricEditorState.cursor, Math.max(0, tempLyricsData.length - 1));
    }

    lyricEditorState.tab = tab;
    lyricEditorEl.querySelectorAll('[data-lyric-tab]').forEach(btn => {
        const selected = btn.dataset.lyricTab === tab;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
    });
    lyricEditorEl.classList.toggle('is-text-tab', tab === 'text');
    lyricEditorEl.classList.toggle('is-words-tab', tab === 'words');
    if (lyricEditorFooter) lyricEditorFooter.classList.toggle('is-words-tab', tab === 'words');
    if (tab === 'words') {
        const line = tempLyricsData[lyricEditorState.cursor];
        lyricEditorState.wordIndex = lyricFirstUntimedWord(line);
    }

    if (tab === 'text') {
        lyricEditorTextarea.value = lyricLinesToText(tempLyricsData);
        lyricEditorTextarea.classList.remove('hidden');
        lyricsScrollArea.classList.add('hidden');
        lyricEditorFooter.classList.add('hidden');
        requestAnimationFrame(() => lyricEditorTextarea.focus({ preventScroll: true }));
    } else {
        lyricEditorTextarea.classList.add('hidden');
        lyricsScrollArea.classList.remove('hidden');
        lyricEditorFooter.classList.remove('hidden');
        renderLyricEditorRows();
        scrollLyricEditorRowIntoView(lyricEditorState.cursor, true);
    }
    updateLyricEditorStatus();
}

function renderLyricEditorRows() {
    if (!lyricsContent) return;
    if (lyricEditorState.tab === 'words') { renderLyricWordRows(); return; }
    lyricsContent.classList.remove('lyrics-word-editing');
    resetDesktopLyricsPresentation();
    lyricsContent.classList.add('lyrics-editing');
    lyricsContent.classList.remove('lyrics-unsynced');
    if (lyricsScrollArea) {
        lyricsScrollArea.classList.add('lyrics-editing');
        lyricsScrollArea.classList.remove('lyrics-unsynced');
    }
    lyricsContent.innerHTML = '';

    if (!tempLyricsData.length) {
        const empty = document.createElement('div');
        empty.className = 'lyric-editor-empty';
        empty.innerHTML = `<i class='bx bx-text'></i><p>No lines yet.</p>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Paste or type lyrics';
        btn.addEventListener('click', () => setLyricEditorTab('text'));
        empty.appendChild(btn);
        lyricsContent.appendChild(empty);
        updateLyricEditorStatus();
        return;
    }

    const fragment = document.createDocumentFragment();
    tempLyricsData.forEach((line, index) => fragment.appendChild(buildLyricEditorRow(line, index)));
    lyricsContent.appendChild(fragment);
    lyricEditorState.playingIndex = -1;
    updateLyricEditorPlaying(true);
    refreshLyricEditorRowStates();
    updateLyricEditorStatus();
}

function buildLyricEditorRow(line, index) {
    const row = document.createElement('div');
    row.className = 'lyric-line editing';
    row.dataset.index = index;

    row.innerHTML = `
        <button type="button" class="lyric-time-chip" data-action="seek" title="Play from here"></button>
        <input class="lyric-edit-input" type="text" spellcheck="false" aria-label="Line ${index + 1} text">
        <div class="lyric-row-actions">
            <button type="button" class="lyric-row-btn" data-action="nudge" data-amount="-0.1" title="Earlier by 0.1s" aria-label="Earlier by 0.1 seconds"><i class='bx bx-minus'></i></button>
            <button type="button" class="lyric-row-btn" data-action="nudge" data-amount="0.1" title="Later by 0.1s" aria-label="Later by 0.1 seconds"><i class='bx bx-plus'></i></button>
            <button type="button" class="lyric-row-btn" data-action="insert" title="Insert line below" aria-label="Insert line below"><i class='bx bx-list-plus'></i></button>
            <button type="button" class="lyric-row-btn danger" data-action="delete" title="Delete line" aria-label="Delete line"><i class='bx bx-trash'></i></button>
        </div>
        <button type="button" class="lyric-sync-btn" data-action="stamp" title="Set to current time" aria-label="Set line ${index + 1} to current time"><i class='bx bx-stopwatch'></i></button>
    `;
    const input = row.querySelector('.lyric-edit-input');
    input.value = line.text === '♪' ? '' : line.text;
    input.placeholder = line.text === '♪' ? '♪ instrumental break' : 'Empty line';
    updateLyricEditorRowTime(row, line);
    return row;
}

function updateLyricEditorRowTime(row, line) {
    const chip = row.querySelector('.lyric-time-chip');
    if (chip) chip.textContent = formatLyricsTime(line.time);
    row.classList.toggle('is-unsynced', line.time === null);
    const hasWords = lyricWordsComplete(line);
    row.classList.toggle('has-words', hasWords);
    if (chip) chip.title = hasWords ? 'Word-by-word timing · play from here' : 'Play from here';
}

function lyricEditorRow(index) {
    return lyricsContent ? lyricsContent.querySelector(`.lyric-line.editing[data-index="${index}"]`) : null;
}

/** Lines that break the time order. Uses the longest non-decreasing run of
 *  timestamps, so only the line(s) actually out of place get flagged (not
 *  every line after a single mis-tap). */
function lyricOutOfOrderSet(lines) {
    const timed = [];
    lines.forEach((line, index) => { if (line.time !== null) timed.push({ index, time: line.time }); });
    const tails = [];      // tails[k] = position in `timed` of smallest tail of a run of length k+1
    const prev = new Array(timed.length).fill(-1);
    timed.forEach((item, i) => {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (timed[tails[mid]].time <= item.time + 0.005) lo = mid + 1; else hi = mid;
        }
        if (lo > 0) prev[i] = tails[lo - 1];
        tails[lo] = i;
    });
    const keep = new Set();
    for (let k = tails.length ? tails[tails.length - 1] : -1; k !== -1; k = prev[k]) keep.add(timed[k].index);
    return new Set(timed.filter(item => !keep.has(item.index)).map(item => item.index));
}

/** Cursor + out-of-order markers. */
function refreshLyricEditorRowStates() {
    const outOfOrder = lyricOutOfOrderSet(tempLyricsData);
    tempLyricsData.forEach((line, index) => {
        const row = lyricEditorRow(index);
        if (!row) return;
        row.classList.toggle('is-cursor', index === lyricEditorState.cursor);
        row.classList.toggle('is-out-of-order', outOfOrder.has(index));
        row.title = outOfOrder.has(index) ? 'This timestamp is out of order' : '';
    });
    updateLyricTapSyncLabel();
}

function updateLyricTapSyncLabel() {
    if (!lyricTapSyncBtn) return;
    if (lyricEditorState.tab === 'words') { updateLyricWordTapLabel(); return; }
    const line = tempLyricsData[lyricEditorState.cursor];
    const label = lyricTapSyncBtn.querySelector('.lyric-tap-label');
    const text = lyricTapSyncBtn.querySelector('.lyric-tap-text');
    if (!line) {
        label.textContent = 'All lines synced';
        text.textContent = 'Pick a line to re-time it';
        lyricTapSyncBtn.disabled = true;
        return;
    }
    lyricTapSyncBtn.disabled = false;
    label.textContent = `Sync line ${lyricEditorState.cursor + 1} of ${tempLyricsData.length}`;
    text.textContent = line.text && line.text !== '♪' ? line.text : '♪';
}

function updateLyricEditorStatus() {
    if (!lyricEditorStatus) return;
    const lines = lyricEditorState.tab === 'text' && lyricEditorTextarea
        ? lyricTextToLines(lyricEditorTextarea.value)
        : tempLyricsData;
    const total = lines.length;
    const timed = lines.filter(l => l.time !== null).length;
    const parts = [];
    if (!total) parts.push('No lyrics');
    else if (timed === 0) parts.push(`${total} lines · not synced`);
    else parts.push(`${timed}/${total} lines synced`);
    const worded = lines.filter(lyricWordsComplete).length;
    if (worded) parts.push(`${worded} word-timed`);
    const outOfOrder = lyricsContent ? lyricsContent.querySelectorAll('.lyric-line.is-out-of-order').length : 0;
    if (lyricEditorState.tab === 'sync' && outOfOrder) parts.push(`${outOfOrder} out of order`);
    if (lyricEditorState.dirty) parts.push('unsaved');
    lyricEditorStatus.textContent = parts.join(' · ');
    lyricEditorStatus.classList.toggle('is-dirty', lyricEditorState.dirty);
}

function setLyricEditorCursor(index, { focusInput = false, scroll = true } = {}) {
    if (!tempLyricsData.length) return;
    lyricEditorState.cursor = Math.max(0, Math.min(tempLyricsData.length, index));
    refreshLyricEditorRowStates();
    if (scroll) scrollLyricEditorRowIntoView(lyricEditorState.cursor);
    if (focusInput) {
        const input = lyricEditorRow(lyricEditorState.cursor)?.querySelector('.lyric-edit-input');
        if (input) input.focus({ preventScroll: true });
    }
}

function scrollLyricEditorRowIntoView(index, immediate = false) {
    const row = lyricEditorRow(Math.min(index, tempLyricsData.length - 1));
    if (!row || !lyricsScrollArea) return;
    const area = lyricsScrollArea.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const target = lyricsScrollArea.scrollTop + (rect.top - area.top) - (area.height / 2) + (rect.height / 2);
    lyricsScrollArea.scrollTo({ top: Math.max(0, target), behavior: immediate ? 'auto' : 'smooth' });
}

function setLyricLineTime(index, time) {
    const line = tempLyricsData[index];
    if (!line) return;
    const previous = line.time;
    line.time = time === null ? null : Math.max(0, Math.round(time * 100) / 100);
    if (previous !== null && line.time !== null) shiftLyricLineWords(line, line.time - previous);
    const row = lyricEditorRow(index);
    if (row) {
        updateLyricEditorRowTime(row, line);
        row.classList.remove('flash');
        void row.offsetWidth;
        row.classList.add('flash');
    }
    markLyricEditorDirty();
    refreshLyricEditorRowStates();
    updateLyricEditorStatus();
}

/** Main sync action: stamp the cursor line with the playback time, advance. */
function lyricTapSync() {
    if (!isLyricEditMode || lyricEditorState.tab !== 'sync') return;
    const index = lyricEditorState.cursor;
    if (!tempLyricsData[index]) return;
    setLyricLineTime(index, audio.currentTime);
    // Skip blank paragraph breaks so every tap lands on a real line.
    let next = index + 1;
    while (next < tempLyricsData.length && !tempLyricsData[next].text.trim() && tempLyricsData[next].time === null) next++;
    setLyricEditorCursor(next);
}

function shiftAllLyrics(ms) {
    if (!isLyricEditMode) return;
    const offset = ms / 1000;
    tempLyricsData.forEach((line, index) => {
        if (line.time === null) return;
        const previous = line.time;
        line.time = Math.max(0, Math.round((line.time + offset) * 100) / 100);
        shiftLyricLineWords(line, line.time - previous);
        const row = lyricEditorRow(index);
        if (row) updateLyricEditorRowTime(row, line);
    });
    if (lyricEditorState.tab === 'text') lyricEditorTextarea.value = lyricLinesToText(tempLyricsData);
    markLyricEditorDirty();
    refreshLyricEditorRowStates();
    showToast(`Shifted all lines ${ms > 0 ? 'later' : 'earlier'} by ${Math.abs(ms / 1000)}s`, 'success', 1500);
}

function updateLyricEditorPlaying(force = false) {
    if (!isLyricEditMode || lyricEditorState.tab === 'text') return;
    if (lyricEditorState.tab === 'words') updateLyricWordChipsLive();
    const t = audio.currentTime;
    let playing = -1;
    let bestTime = -Infinity;
    tempLyricsData.forEach((line, index) => {
        if (line.time !== null && line.time <= t + 0.02 && line.time >= bestTime) {
            bestTime = line.time;
            playing = index;
        }
    });
    if (!force && playing === lyricEditorState.playingIndex) return;
    lyricsContent.querySelectorAll('.lyric-line.editing.is-playing').forEach(el => el.classList.remove('is-playing'));
    const row = lyricEditorRow(playing);
    if (row) row.classList.add('is-playing');
    lyricEditorState.playingIndex = playing;
}

/* Called from player.js updateActiveLyric() while editing. */
function lyricEditorOnTimeUpdate() {
    updateLyricEditorPlaying();
}

function startLyricEditorClock() {
    stopLyricEditorClock();
    const tick = () => {
        if (!isLyricEditMode) return;
        if (lyricEditorClock) lyricEditorClock.textContent = formatLyricsTime(audio.currentTime);
        if (lyricEditorPlayBtn) {
            const icon = lyricEditorPlayBtn.querySelector('i');
            const cls = audio.paused ? 'bx bx-play' : 'bx bx-pause';
            if (icon && icon.className !== cls) icon.className = cls;
            lyricEditorPlayBtn.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
        }
        updateLyricEditorPlaying();
        lyricEditorState.rafId = requestAnimationFrame(tick);
    };
    lyricEditorState.rafId = requestAnimationFrame(tick);
}

function stopLyricEditorClock() {
    if (lyricEditorState.rafId !== null) cancelAnimationFrame(lyricEditorState.rafId);
    lyricEditorState.rafId = null;
}

function lyricEditorSeek(delta) {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration - 0.1, audio.currentTime + delta));
}

/* Two-step confirmation on a button (no blocking native dialogs). */
function requestLyricConfirm(button, key, confirmLabel, action) {
    const pending = lyricEditorState.pendingConfirm;
    if (pending && pending.key === key) {
        cancelLyricConfirm();
        action();
        return;
    }
    cancelLyricConfirm();
    const labelEl = button.querySelector('span') || button;
    const original = labelEl.textContent;
    labelEl.textContent = confirmLabel;
    button.classList.add('is-confirming');
    lyricEditorState.pendingConfirm = {
        key,
        restore: () => { labelEl.textContent = original; button.classList.remove('is-confirming'); },
        timer: setTimeout(cancelLyricConfirm, 3500),
    };
}

function cancelLyricConfirm() {
    const pending = lyricEditorState.pendingConfirm;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.restore();
    lyricEditorState.pendingConfirm = null;
}

function cancelLyricEdit() {
    if (lyricEditorState.tab === 'text' && lyricEditorTextarea) {
        // Count typing in the Text tab as a change too.
        const typed = lyricTextToLines(lyricEditorTextarea.value);
        if (lyricLinesToText(typed) !== lyricLinesToText(tempLyricsData)) lyricEditorState.dirty = true;
    }
    if (lyricEditorState.dirty) {
        requestLyricConfirm(btnCancelLyrics, 'cancel', 'Discard changes?', () => closeLyricEditor());
        return;
    }
    closeLyricEditor();
}

async function saveLyricsToServer() {
    const songId = window.currentlyPlayingSongId;
    if (!songId || !isLyricEditMode) return;

    if (lyricEditorState.tab === 'text') tempLyricsData = lyricTextToLines(lyricEditorTextarea.value);

    let droppedWordLines = 0;
    const lines = cloneLyricLines(tempLyricsData).map(l => {
        const copy = { ...l, text: l.text.trim() };
        if (copy.words && !lyricWordsComplete(copy)) { delete copy.words; droppedWordLines++; }
        return copy;
    });
    if (droppedWordLines) showToast(`${droppedWordLines} line(s) had unfinished word timing and were saved line-synced`, 'error', 3500);
    while (lines.length && !lines[0].text && lines[0].time === null) lines.shift();
    while (lines.length && !lines[lines.length - 1].text && lines[lines.length - 1].time === null) lines.pop();

    if (!lines.some(l => l.text && l.text !== '♪')) {
        showToast('There are no lyrics to save. Use "Remove saved lyrics" instead.', 'error');
        return;
    }

    const timedCount = lines.filter(l => l.time !== null).length;
    let payload;
    let isSynced;
    if (timedCount === 0) {
        payload = lines.map(l => l.text).join('\n');
        isSynced = false;
    } else {
        // Blank, untimed lines are just paragraph breaks in plain text: drop them.
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].time === null && !lines[i].text) lines.splice(i, 1);
        }
        // Other untimed lines inherit the previous line's time so nothing is lost.
        const untimed = lines.filter(l => l.time === null).length;
        let previous = 0;
        lines.forEach(line => {
            if (line.time === null) line.time = previous;
            previous = line.time;
        });
        payload = lyricLinesToText(lines);
        isSynced = true;
        if (untimed) {
            showToast(`${untimed} unsynced line(s) were given the previous line's time`, 'success', 3500);
        }
    }

    btnSaveLyrics.disabled = true;
    try {
        const res = await saveLyricsForSong(songId, payload, isSynced);
        if (String(songId) !== String(window.currentlyPlayingSongId)) return;
        if (res.ok) {
            closeLyricEditor({ render: false });
            applyLyricsText(payload, isSynced);
            showToast('Lyrics saved', 'success', 2000);
        } else {
            showToast('Failed to save lyrics', 'error');
        }
    } catch (err) {
        console.error('Save lyrics error:', err);
        showToast('Failed to save lyrics', 'error');
    } finally {
        btnSaveLyrics.disabled = false;
    }
}

async function clearLyricsFromServer() {
    const songId = window.currentlyPlayingSongId;
    if (!songId) return;
    try {
        const res = await fetch(`/api/lyrics/${encodeURIComponent(songId)}`, { method: 'DELETE' });
        if (String(songId) !== String(window.currentlyPlayingSongId)) return;
        if (!res.ok) { showToast('Failed to remove lyrics', 'error'); return; }
        showToast('Saved lyrics removed — searching again', 'success', 2500);
        const track = currentLyricsTrack;
        resetLyrics();
        fetchLyrics(track?.title || '', track?.artist || '', songId);
    } catch (err) {
        console.error('Clear lyrics error:', err);
        showToast('Failed to remove lyrics', 'error');
    }
}

/* ============================================================================
 * 9. WORD TIMING EDITOR ("Words" tab, experimental)
 *    Tap once per word while the song plays. One extra tap after the last
 *    word marks where the line ends, then the editor moves to the next line.
 * ========================================================================== */

function lyricLineIsTappable(line) {
    return !!(line && line.text && line.text.trim() && line.text !== '♪');
}

/** Words for a line, creating untimed ones from its text when needed. */
function ensureLyricLineWords(line) {
    if (!lyricLineIsTappable(line)) return null;
    const tokens = line.text.trim().match(/\S+\s*/g) || [];
    const current = line.words || [];
    const sameText = current.length === tokens.length
        && current.every((w, i) => w.text.trim() === tokens[i].trim());
    if (!sameText) line.words = tokens.map(text => ({ time: null, end: null, text }));
    return line.words;
}

function lyricFirstUntimedWord(line) {
    if (!line || !line.words) return 0;
    const index = line.words.findIndex(w => w.time === null || w.time === undefined);
    return index === -1 ? 0 : index;
}

function renderLyricWordRows() {
    resetDesktopLyricsPresentation();
    lyricsContent.classList.add('lyrics-editing', 'lyrics-word-editing');
    lyricsContent.classList.remove('lyrics-unsynced');
    if (lyricsScrollArea) lyricsScrollArea.classList.add('lyrics-editing');
    lyricsContent.innerHTML = '';

    if (!tempLyricsData.length) {
        const empty = document.createElement('div');
        empty.className = 'lyric-editor-empty';
        empty.innerHTML = `<i class='bx bx-text'></i><p>Add lyrics in the Text tab first.</p>`;
        lyricsContent.appendChild(empty);
        updateLyricEditorStatus();
        return;
    }

    const fragment = document.createDocumentFragment();
    tempLyricsData.forEach((line, index) => fragment.appendChild(buildLyricWordRow(line, index)));
    lyricsContent.appendChild(fragment);
    refreshLyricEditorRowStates();
    updateLyricEditorStatus();
}

function buildLyricWordRow(line, index) {
    const row = document.createElement('div');
    row.className = 'lyric-line editing word-row';
    row.dataset.index = index;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lyric-time-chip';
    chip.dataset.action = 'replay';
    chip.title = 'Replay this line';
    chip.textContent = formatLyricsTime(line.time);
    row.appendChild(chip);

    const wordsEl = document.createElement('div');
    wordsEl.className = 'lyric-word-chips';
    if (!lyricLineIsTappable(line)) {
        wordsEl.innerHTML = `<span class="lyric-word-chip is-break">${line.text === '♪' ? '♪ instrumental break' : 'empty line'}</span>`;
    } else {
        const words = line.words && line.words.length ? line.words : (line.text.trim().match(/\S+\s*/g) || []).map(text => ({ time: null, text }));
        words.forEach((word, wordIndex) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lyric-word-chip';
            btn.dataset.action = 'word';
            btn.dataset.word = wordIndex;
            const timed = word.time !== null && word.time !== undefined;
            btn.classList.toggle('is-timed', timed);
            btn.innerHTML = `<span class="w"></span><span class="t"></span>`;
            btn.querySelector('.w').textContent = word.text.trim();
            btn.querySelector('.t').textContent = timed ? formatLyricsTime(word.time) : '–';
            btn.title = 'Re-tap from this word';
            wordsEl.appendChild(btn);
        });
        const lastWord = words[words.length - 1];
        const endChip = document.createElement('span');
        endChip.className = 'lyric-word-chip is-end';
        endChip.dataset.word = words.length;
        endChip.classList.toggle('is-timed', !!(lastWord && lastWord.end !== null && lastWord.end !== undefined && line.words));
        endChip.innerHTML = `<span class="w">end</span><span class="t"></span>`;
        endChip.querySelector('.t').textContent = endChip.classList.contains('is-timed') ? formatLyricsTime(lastWord.end) : '–';
        wordsEl.appendChild(endChip);
    }
    row.appendChild(wordsEl);

    if (line.words && line.words.length) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'lyric-row-btn danger lyric-word-clear';
        clear.dataset.action = 'clear-words';
        clear.title = 'Remove word timing from this line';
        clear.setAttribute('aria-label', 'Remove word timing from this line');
        clear.innerHTML = `<i class='bx bx-eraser'></i>`;
        row.appendChild(clear);
    }
    return row;
}

function refreshLyricWordRow(index) {
    const old = lyricEditorRow(index);
    const line = tempLyricsData[index];
    if (!old || !line) return;
    const fresh = buildLyricWordRow(line, index);
    old.replaceWith(fresh);
    refreshLyricEditorRowStates();
    markLyricWordTarget();
}

/** Highlights the word the next tap will set. */
function markLyricWordTarget() {
    lyricsContent.querySelectorAll('.lyric-word-chip.is-target').forEach(el => el.classList.remove('is-target'));
    const row = lyricEditorRow(lyricEditorState.cursor);
    if (!row) return;
    const target = row.querySelector(`.lyric-word-chip[data-word="${lyricEditorState.wordIndex}"]`);
    if (target) target.classList.add('is-target');
}

function updateLyricWordTapLabel() {
    const label = lyricTapSyncBtn.querySelector('.lyric-tap-label');
    const text = lyricTapSyncBtn.querySelector('.lyric-tap-text');
    const line = tempLyricsData[lyricEditorState.cursor];
    markLyricWordTarget();
    if (!line) {
        label.textContent = 'All lines done';
        text.textContent = 'Pick a line to re-tap it';
        lyricTapSyncBtn.disabled = true;
        return;
    }
    lyricTapSyncBtn.disabled = false;
    if (!lyricLineIsTappable(line)) {
        label.textContent = `Line ${lyricEditorState.cursor + 1} has no words`;
        text.textContent = 'Tap to skip';
        return;
    }
    const tokens = line.text.trim().split(/\s+/);
    const i = lyricEditorState.wordIndex;
    if (i >= tokens.length) {
        label.textContent = `Line ${lyricEditorState.cursor + 1} · end of line`;
        text.textContent = 'Tap when the last word stops';
    } else {
        label.textContent = `Line ${lyricEditorState.cursor + 1} · word ${i + 1} of ${tokens.length}`;
        text.textContent = tokens[i];
    }
}

function selectLyricWordLine(index, wordIndex = null) {
    if (!tempLyricsData.length) return;
    lyricEditorState.cursor = Math.max(0, Math.min(tempLyricsData.length - 1, index));
    const line = tempLyricsData[lyricEditorState.cursor];
    lyricEditorState.wordIndex = wordIndex !== null ? wordIndex : lyricFirstUntimedWord(line);
    refreshLyricEditorRowStates();
    scrollLyricEditorRowIntoView(lyricEditorState.cursor);
}

function lyricWordTap() {
    if (!isLyricEditMode || lyricEditorState.tab !== 'words') return;
    const index = lyricEditorState.cursor;
    const line = tempLyricsData[index];
    if (!line) return;
    if (!lyricLineIsTappable(line)) { selectLyricWordLine(index + 1, 0); return; }

    const now = Math.round(audio.currentTime * 100) / 100;
    const words = ensureLyricLineWords(line);
    const i = lyricEditorState.wordIndex;

    if (i < words.length) {
        words[i].time = now;
        if (i > 0) words[i - 1].end = now;
        // Re-tapping from the middle: later words must be tapped again.
        for (let k = i + 1; k < words.length; k++) { words[k].time = null; words[k].end = null; }
        words[i].end = null;
        if (i === 0) {
            line.time = now;
            const row = lyricEditorRow(index);
            if (row) row.querySelector('.lyric-time-chip').textContent = formatLyricsTime(now);
        }
        lyricEditorState.wordIndex = i + 1;
        markLyricEditorDirty();
        refreshLyricWordRow(index);
        return;
    }

    // Extra tap after the last word = line end, then move on.
    words[words.length - 1].end = now;
    markLyricEditorDirty();
    refreshLyricWordRow(index);
    let next = index + 1;
    while (next < tempLyricsData.length && !lyricLineIsTappable(tempLyricsData[next])) next++;
    selectLyricWordLine(next, 0);
}

function lyricWordUndo() {
    if (!isLyricEditMode || lyricEditorState.tab !== 'words') return;
    let index = lyricEditorState.cursor;
    let line = tempLyricsData[index];

    // At the start of a line: step back into the previous line's end tap.
    if ((!line || !line.words || lyricEditorState.wordIndex === 0) && index > 0) {
        let prev = index - 1;
        while (prev > 0 && !lyricLineIsTappable(tempLyricsData[prev])) prev--;
        const prevLine = tempLyricsData[prev];
        if (prevLine && prevLine.words && prevLine.words.length) {
            const last = prevLine.words[prevLine.words.length - 1];
            if (last.end !== null && last.end !== undefined) {
                last.end = null;
                markLyricEditorDirty();
                refreshLyricWordRow(prev);
                selectLyricWordLine(prev, prevLine.words.length);
                return;
            }
        }
        return;
    }
    if (!line || !line.words) return;
    const i = lyricEditorState.wordIndex - 1;
    if (i < 0) return;
    line.words[i].time = null;
    line.words[i].end = null;
    if (i > 0) line.words[i - 1].end = null;
    lyricEditorState.wordIndex = i;
    if (line.words.every(w => w.time === null)) delete line.words;
    markLyricEditorDirty();
    refreshLyricWordRow(index);
}

function lyricWordReplayLine() {
    const line = tempLyricsData[lyricEditorState.cursor];
    if (!line) return;
    let start = line.time;
    if (start === null || start === undefined) {
        const prev = tempLyricsData.slice(0, lyricEditorState.cursor).reverse().find(l => l.time !== null);
        start = prev ? prev.time : 0;
    }
    audio.currentTime = Math.max(0, start - 1.5);
    if (audio.paused) playSong();
}

/** Live highlight of the word currently playing in the selected line. */
function updateLyricWordChipsLive() {
    const row = lyricEditorRow(lyricEditorState.cursor);
    const line = tempLyricsData[lyricEditorState.cursor];
    if (!row || !line || !line.words) return;
    const t = audio.currentTime;
    row.querySelectorAll('.lyric-word-chip[data-action="word"]').forEach(chip => {
        const word = line.words[Number(chip.dataset.word)];
        if (!word || word.time === null) { chip.classList.remove('is-live'); return; }
        const end = word.end ?? line.words[Number(chip.dataset.word) + 1]?.time ?? word.time + 0.6;
        chip.classList.toggle('is-live', t >= word.time && t < (end ?? word.time + 0.6));
    });
}

function handleLyricWordRowClick(event) {
    const row = event.target.closest('.lyric-line.editing');
    if (!row) return;
    const index = Number(row.dataset.index);
    const actionEl = event.target.closest('[data-action]');
    if (actionEl && actionEl.blur) actionEl.blur();
    const action = actionEl?.dataset.action;

    if (action === 'word') {
        const line = tempLyricsData[index];
        ensureLyricLineWords(line);
        selectLyricWordLine(index, Number(actionEl.dataset.word));
        return;
    }
    if (action === 'replay') {
        selectLyricWordLine(index);
        lyricWordReplayLine();
        return;
    }
    if (action === 'clear-words') {
        delete tempLyricsData[index].words;
        markLyricEditorDirty();
        refreshLyricWordRow(index);
        selectLyricWordLine(index, 0);
        return;
    }
    if (index !== lyricEditorState.cursor) selectLyricWordLine(index);
}

if (lyricEditorFooter) {
    lyricEditorFooter.addEventListener('click', event => {
        const tool = event.target.closest('[data-word-tool]');
        if (!tool) return;
        tool.blur();
        if (tool.dataset.wordTool === 'undo') lyricWordUndo();
        else lyricWordReplayLine();
    });
}

/* --- Lyrics appearance (Settings > Appearance > Lyrics) --- */

const LYRICS_APPEARANCE_KEY = 'streamify:lyrics-appearance:v1';
const LYRICS_APPEARANCE_DEFAULTS = Object.freeze({
    size: 'default',     // small | default | large | xl
    glow: 'soft',        // off | soft | strong
    bold: false,
    heldGlow: true,
    motion: true,
    font: 'default',     // default | jakarta | outfit | rounded | serif | mono | hand
    color: 'white',      // key of LYRICS_HIGHLIGHT_COLORS
    customColor: '#ff7eb6',
    align: 'left',       // left | center | right
    spacing: 'default',  // compact | default | relaxed
    textCase: 'none',    // none | upper | lower
    anim: 'spring',      // spring | smooth | snappy
    blur: 'default',     // off | light | default
});
const LYRICS_APPEARANCE_CHOICES = Object.freeze({
    size: ['small', 'default', 'large', 'xl'],
    glow: ['off', 'soft', 'strong'],
    font: ['default', 'jakarta', 'outfit', 'rounded', 'serif', 'mono', 'hand'],
    align: ['left', 'center', 'right'],
    spacing: ['compact', 'default', 'relaxed'],
    textCase: ['none', 'upper', 'lower'],
    anim: ['spring', 'smooth', 'snappy'],
    blur: ['off', 'light', 'default'],
});
// null = handled in CSS (white is the original look, theme follows the accent).
const LYRICS_HIGHLIGHT_COLORS = Object.freeze({
    white: { name: 'White', hex: null, swatch: '#ffffff' },
    theme: { name: 'Theme', hex: null, swatch: 'var(--accent)' },
    cover: { name: 'From cover', hex: null, swatch: 'rgb(var(--cover-accent-rgb, 200, 200, 210))' },
    pink: { name: 'Pink', hex: '#ff7eb6' },
    lavender: { name: 'Lavender', hex: '#c4a7ff' },
    sky: { name: 'Sky', hex: '#7cc8ff' },
    mint: { name: 'Mint', hex: '#6ff2c2' },
    gold: { name: 'Gold', hex: '#ffd36e' },
    peach: { name: 'Peach', hex: '#ffab7a' },
    custom: { name: 'Custom', hex: null },
});
// Radio group name in Settings -> preference key.
const LYRICS_RADIO_GROUPS = Object.freeze({
    'lyrics-size': 'size',
    'lyrics-glow': 'glow',
    'lyrics-font': 'font',
    'lyrics-color': 'color',
    'lyrics-align': 'align',
    'lyrics-spacing': 'spacing',
    'lyrics-case': 'textCase',
    'lyrics-anim': 'anim',
    'lyrics-blur': 'blur',
});

function readLyricsAppearance() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(LYRICS_APPEARANCE_KEY) || 'null'); } catch (e) { stored = null; }
    return normalizeLyricsAppearance(stored);
}

function normalizeLyricsAppearance(input) {
    const prefs = { ...LYRICS_APPEARANCE_DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
    Object.entries(LYRICS_APPEARANCE_CHOICES).forEach(([key, allowed]) => {
        if (!allowed.includes(prefs[key])) prefs[key] = LYRICS_APPEARANCE_DEFAULTS[key];
    });
    if (!Object.prototype.hasOwnProperty.call(LYRICS_HIGHLIGHT_COLORS, prefs.color)) prefs.color = LYRICS_APPEARANCE_DEFAULTS.color;
    if (!/^#[0-9a-f]{6}$/i.test(String(prefs.customColor || ''))) prefs.customColor = LYRICS_APPEARANCE_DEFAULTS.customColor;
    ['bold', 'heldGlow', 'motion'].forEach(key => { prefs[key] = prefs[key] === true; });
    return prefs;
}

function lyricsHexToRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

let lyricsAppearance = readLyricsAppearance();

function buildLyricsColorOptions() {
    const grid = document.getElementById('lyrics-color-grid');
    if (!grid || grid.childElementCount) return;
    Object.entries(LYRICS_HIGHLIGHT_COLORS).forEach(([key, color]) => {
        const option = document.createElement('label');
        option.className = 'theme-option lyrics-color-option';
        option.title = color.name;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'lyrics-color';
        input.value = key;
        input.setAttribute('aria-label', color.name);
        const swatch = document.createElement('span');
        swatch.className = 'theme-swatch';
        swatch.dataset.lyricsSwatch = key;
        swatch.style.background = color.hex || color.swatch || '';
        option.append(input, swatch);
        grid.append(option);
    });
}

function applyLyricsAppearance() {
    const root = document.documentElement;
    root.dataset.lyricsSize = lyricsAppearance.size;
    root.dataset.lyricsGlow = lyricsAppearance.glow;
    root.dataset.lyricsFont = lyricsAppearance.font;
    root.dataset.lyricsColor = lyricsAppearance.color;
    root.dataset.lyricsAlign = lyricsAppearance.align;
    root.dataset.lyricsSpacing = lyricsAppearance.spacing;
    root.dataset.lyricsCase = lyricsAppearance.textCase;
    root.dataset.lyricsAnim = lyricsAppearance.anim;
    root.dataset.lyricsBlur = lyricsAppearance.blur;
    root.classList.toggle('lyrics-bold', lyricsAppearance.bold);
    root.classList.toggle('lyrics-held-glow', lyricsAppearance.heldGlow);
    root.classList.toggle('lyrics-no-motion', !lyricsAppearance.motion);

    const highlight = lyricsAppearance.color === 'custom'
        ? lyricsAppearance.customColor
        : LYRICS_HIGHLIGHT_COLORS[lyricsAppearance.color].hex;
    if (highlight) {
        root.style.setProperty('--lyric-active', highlight);
        root.style.setProperty('--lyric-active-rgb', lyricsHexToRgb(highlight));
    } else {
        root.style.removeProperty('--lyric-active');
        root.style.removeProperty('--lyric-active-rgb');
    }

    buildLyricsColorOptions();
    Object.entries(LYRICS_RADIO_GROUPS).forEach(([name, key]) => {
        document.querySelectorAll(`input[name="${name}"]`).forEach(input => { input.checked = input.value === lyricsAppearance[key]; });
    });
    document.querySelectorAll('input[data-lyrics-pref]').forEach(input => { input.checked = !!lyricsAppearance[input.dataset.lyricsPref]; });
    const customInput = document.getElementById('lyrics-custom-color');
    if (customInput) customInput.value = lyricsAppearance.customColor;
    const customSwatch = document.querySelector('[data-lyrics-swatch="custom"]');
    if (customSwatch) customSwatch.style.background = lyricsAppearance.customColor;
}

function setLyricsAppearance(changes) {
    lyricsAppearance = normalizeLyricsAppearance({ ...lyricsAppearance, ...changes });
    try { localStorage.setItem(LYRICS_APPEARANCE_KEY, JSON.stringify(lyricsAppearance)); } catch (e) { /* this page only */ }
    applyLyricsAppearance();
    // Size, font and spacing changes move lines; re-center the active one.
    if (isLyricsActive && !isLyricEditMode && typeof updateActiveLyric === 'function') {
        activeLyricIndex = -1;
        requestAnimationFrame(() => updateActiveLyric(true));
    }
}

buildLyricsColorOptions();
Object.entries(LYRICS_RADIO_GROUPS).forEach(([name, key]) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
        input.addEventListener('change', () => { if (input.checked) setLyricsAppearance({ [key]: input.value }); });
    });
});
document.querySelectorAll('input[data-lyrics-pref]').forEach(input => {
    input.addEventListener('change', () => setLyricsAppearance({ [input.dataset.lyricsPref]: input.checked }));
});
const lyricsCustomColorInput = document.getElementById('lyrics-custom-color');
if (lyricsCustomColorInput) {
    // Live while dragging, saved when the picker closes.
    lyricsCustomColorInput.addEventListener('input', () => {
        lyricsAppearance = normalizeLyricsAppearance({ ...lyricsAppearance, color: 'custom', customColor: lyricsCustomColorInput.value });
        applyLyricsAppearance();
    });
    lyricsCustomColorInput.addEventListener('change', () => setLyricsAppearance({ color: 'custom', customColor: lyricsCustomColorInput.value }));
}
const lyricsResetBtn = document.getElementById('lyrics-reset-btn');
if (lyricsResetBtn) lyricsResetBtn.addEventListener('click', () => setLyricsAppearance({ ...LYRICS_APPEARANCE_DEFAULTS }));
// Fonts arrive after first paint; re-center once a newly chosen face has loaded.
if (document.fonts && typeof document.fonts.addEventListener === 'function') {
    document.fonts.addEventListener('loadingdone', () => {
        if (isLyricsActive && !isLyricEditMode && typeof updateActiveLyric === 'function') {
            activeLyricIndex = -1;
            requestAnimationFrame(() => updateActiveLyric(true));
        }
    });
}
window.addEventListener('storage', event => {
    if (event.key !== LYRICS_APPEARANCE_KEY) return;
    lyricsAppearance = readLyricsAppearance();
    applyLyricsAppearance();
});
applyLyricsAppearance();

/* --- Experimental settings wiring --- */

function syncLyricsExperimentUI() {
    const experiments = window.StreamifyExperiments;
    document.querySelectorAll('input[data-experiment]').forEach(input => {
        input.checked = !!(experiments && experiments.isEnabled(input.dataset.experiment));
        input.disabled = !experiments;
    });
    const wordsTabBtn = document.getElementById('lyric-editor-words-tab');
    const tapping = lyricsExperimentEnabled('lyricsWordTapping');
    if (wordsTabBtn) wordsTabBtn.classList.toggle('hidden', !tapping);
    if (!tapping && isLyricEditMode && lyricEditorState.tab === 'words') setLyricEditorTab('sync');
}

document.querySelectorAll('input[data-experiment]').forEach(input => {
    input.addEventListener('change', () => {
        if (window.StreamifyExperiments) window.StreamifyExperiments.setEnabled(input.dataset.experiment, input.checked);
    });
});

window.addEventListener('streamifyexperimentchange', event => {
    const feature = event.detail && event.detail.feature;
    syncLyricsExperimentUI();
    if (feature === 'lyricsEstimatedWords' && !isLyricEditMode && lyricsData.length) renderLyrics();
});
syncLyricsExperimentUI();

/* --- Editor event wiring --- */

if (lyricsContent) {
    lyricsContent.addEventListener('click', event => {
        if (!isLyricEditMode) return;
        if (lyricEditorState.tab === 'words') { handleLyricWordRowClick(event); return; }
        const row = event.target.closest('.lyric-line.editing');
        if (!row) return;
        const index = Number(row.dataset.index);
        const actionBtn = event.target.closest('[data-action]');
        const action = actionBtn?.dataset.action;
        if (actionBtn) actionBtn.blur();

        switch (action) {
            case 'seek': {
                const line = tempLyricsData[index];
                setLyricEditorCursor(index, { scroll: false });
                if (line && line.time !== null) {
                    audio.currentTime = Math.max(0, line.time - 0.5);
                    if (audio.paused) playSong();
                }
                return;
            }
            case 'stamp':
                setLyricLineTime(index, audio.currentTime);
                setLyricEditorCursor(index + 1);
                return;
            case 'nudge': {
                const line = tempLyricsData[index];
                if (!line) return;
                setLyricLineTime(index, (line.time ?? audio.currentTime) + Number(actionBtn.dataset.amount));
                return;
            }
            case 'insert': {
                tempLyricsData.splice(index + 1, 0, { time: null, text: '' });
                markLyricEditorDirty();
                renderLyricEditorRows();
                setLyricEditorCursor(index + 1, { focusInput: true });
                return;
            }
            case 'delete':
                tempLyricsData.splice(index, 1);
                markLyricEditorDirty();
                lyricEditorState.cursor = Math.min(index, Math.max(0, tempLyricsData.length - 1));
                renderLyricEditorRows();
                return;
            default:
                if (!event.target.closest('input')) setLyricEditorCursor(index, { scroll: false });
        }
    });

    lyricsContent.addEventListener('input', event => {
        if (!isLyricEditMode || !event.target.classList.contains('lyric-edit-input')) return;
        const index = Number(event.target.closest('.lyric-line').dataset.index);
        if (!tempLyricsData[index]) return;
        const editedLine = tempLyricsData[index];
        editedLine.text = event.target.value;
        if (editedLine.words) {
            // Word timings no longer match the text; keep the line timing only.
            delete editedLine.words;
            event.target.closest('.lyric-line').classList.remove('has-words');
        }
        markLyricEditorDirty();
        if (index === lyricEditorState.cursor) updateLyricTapSyncLabel();
    });

    lyricsContent.addEventListener('focusin', event => {
        if (!isLyricEditMode || !event.target.classList.contains('lyric-edit-input')) return;
        const index = Number(event.target.closest('.lyric-line').dataset.index);
        if (index !== lyricEditorState.cursor) setLyricEditorCursor(index, { scroll: false });
    });
}

if (lyricEditorEl) {
    lyricEditorEl.addEventListener('click', event => {
        const tabBtn = event.target.closest('[data-lyric-tab]');
        if (tabBtn) { setLyricEditorTab(tabBtn.dataset.lyricTab); return; }
        const seekBtn = event.target.closest('[data-lyric-seek]');
        if (seekBtn) { seekBtn.blur(); lyricEditorSeek(Number(seekBtn.dataset.lyricSeek)); return; }
        const shiftBtn = event.target.closest('[data-lyric-shift]');
        if (shiftBtn) { shiftBtn.blur(); shiftAllLyrics(Number(shiftBtn.dataset.lyricShift)); }
    });
}
if (lyricEditorPlayBtn) lyricEditorPlayBtn.addEventListener('click', () => { lyricEditorPlayBtn.blur(); togglePlay(); });
if (lyricTapSyncBtn) {
    lyricTapSyncBtn.addEventListener('click', () => {
        lyricTapSyncBtn.blur();
        if (lyricEditorState.tab === 'words') lyricWordTap();
        else lyricTapSync();
    });
}
if (lyricEditorTextarea) {
    lyricEditorTextarea.addEventListener('input', () => {
        lyricEditorState.dirty = true;
        updateLyricEditorStatus();
    });
}
if (btnEditLyrics) btnEditLyrics.addEventListener('click', () => openLyricEditor());
if (btnSaveLyrics) btnSaveLyrics.addEventListener('click', saveLyricsToServer);
if (btnCancelLyrics) btnCancelLyrics.addEventListener('click', cancelLyricEdit);
if (btnClearLyrics) {
    btnClearLyrics.addEventListener('click', () =>
        requestLyricConfirm(btnClearLyrics, 'clear', 'Click again to remove', () => {
            closeLyricEditor({ render: false });
            clearLyricsFromServer();
        })
    );
}

// Editor keyboard shortcuts. Capture phase so Escape/Space never reach the
// player's global handlers (which would close the player / be blocked).
window.addEventListener('keydown', event => {
    if (!isLyricEditMode || !isLyricsActive) return;
    if (!document.body.classList.contains('player-section-active')) return;
    if (lyricsSelectionModal && !lyricsSelectionModal.classList.contains('hidden')) return;

    const target = event.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    const handled = () => { event.preventDefault(); event.stopImmediatePropagation(); };

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        handled();
        saveLyricsToServer();
        return;
    }
    if (event.key === 'Escape') {
        handled();
        if (inField) target.blur();
        else cancelLyricEdit();
        return;
    }

    if (inField) {
        if (target.classList.contains('lyric-edit-input')) {
            const index = Number(target.closest('.lyric-line').dataset.index);
            if (event.key === 'Enter') { handled(); setLyricEditorCursor(index + 1, { focusInput: true }); }
            else if (event.key === 'ArrowDown') { handled(); setLyricEditorCursor(index + 1, { focusInput: true }); }
            else if (event.key === 'ArrowUp') { handled(); setLyricEditorCursor(index - 1, { focusInput: true }); }
        }
        return;
    }
    if (lyricEditorState.tab === 'text' || event.ctrlKey || event.metaKey || event.altKey) return;

    if (target && target.tagName === 'BUTTON') target.blur();
    if (lyricEditorState.tab === 'words') {
        switch (event.key) {
            case ' ': handled(); togglePlay(); return;
            case 'Enter': case 's': case 'S': handled(); lyricWordTap(); return;
            case 'Backspace': handled(); lyricWordUndo(); return;
            case 'r': case 'R': handled(); lyricWordReplayLine(); return;
            case 'ArrowDown': handled(); selectLyricWordLine(lyricEditorState.cursor + 1); return;
            case 'ArrowUp': handled(); selectLyricWordLine(lyricEditorState.cursor - 1); return;
            case 'ArrowLeft': handled(); lyricEditorSeek(event.shiftKey ? -5 : -2); return;
            case 'ArrowRight': handled(); lyricEditorSeek(event.shiftKey ? 5 : 2); return;
            default: return;
        }
    }
    switch (event.key) {
        case ' ':
            handled(); togglePlay(); break;
        case 'Enter':
        case 's':
        case 'S':
            handled(); lyricTapSync(); break;
        case 'ArrowDown':
            handled(); setLyricEditorCursor(lyricEditorState.cursor + 1); break;
        case 'ArrowUp':
            handled(); setLyricEditorCursor(lyricEditorState.cursor - 1); break;
        case 'ArrowLeft':
            handled(); lyricEditorSeek(event.shiftKey ? -5 : -2); break;
        case 'ArrowRight':
            handled(); lyricEditorSeek(event.shiftKey ? 5 : 2); break;
        default:
    }
}, true);

/* --- Picker wiring --- */
if (btnReRequestLyrics) btnReRequestLyrics.addEventListener('click', openLyricsSearchModal);
if (btnFindLyrics) btnFindLyrics.addEventListener('click', openLyricsSearchModal);
if (closeLyricsSelectionModal) closeLyricsSelectionModal.addEventListener('click', closeLyricsSearchModal);
if (lyricsSearchForm) {
    lyricsSearchForm.addEventListener('submit', event => {
        event.preventDefault();
        performLyricsSearch();
    });
}
if (lyricsSelectionModal) {
    lyricsSelectionModal.addEventListener('click', event => {
        if (event.target === lyricsSelectionModal) closeLyricsSearchModal();
    });
    lyricsSelectionModal.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeLyricsSearchModal();
        }
    });
}
lyricsWriteOwnBtns.forEach(btn => btn.addEventListener('click', () => {
    closeLyricsSearchModal();
    openLyricEditor({ tab: 'text' });
}));

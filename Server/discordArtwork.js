'use strict';

const Matching = require('./metadataMatching');

const ARTWORK_MODES = new Set(['app_logo', 'stored_only', 'youtube_exact', 'apple_only', 'best_effort']);
const YOUTUBE_IMAGE_HOSTS = new Set([
    'i.ytimg.com', 'i1.ytimg.com', 'i2.ytimg.com', 'i3.ytimg.com',
    'i4.ytimg.com', 'i9.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com'
]);
const LEGACY_IMAGE_HOSTS = new Set([
    'i.scdn.co', 'mosaic.scdn.co', 'lineup-images.scdn.co',
    'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com',
    'thisis-images.scdn.co'
]);
const SEARCH_LIMIT = 5;
const SEARCH_GAP_MS = 10000;
const SECRETS_TO_STRIP = ['SLSK_USER', 'SLSK_PASS', 'ACOUSTID_CLIENT_KEY', 'TURNSTILE_SECRET_KEY'];

let ytDlp = null;
let searchTail = Promise.resolve();
let lastSearchAt = 0;
let activeSearch = null;

function configure(dependencies = {}) {
    ytDlp = dependencies.ytDlp || null;
}

function shutdown() {
    if (!activeSearch) return;
    try { activeSearch.kill('SIGTERM', { forceKillAfterTimeout: 2000 }); } catch { /* already exited */ }
    activeSearch = null;
}

function validArtworkMode(value) {
    return ARTWORK_MODES.has(value) ? value : 'stored_only';
}

function isTrustedRemoteArtworkUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048) return false;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
        const host = parsed.hostname.toLowerCase();
        return YOUTUBE_IMAGE_HOSTS.has(host) || LEGACY_IMAGE_HOSTS.has(host);
    } catch {
        return false;
    }
}

function isTrustedYoutubeArtworkUrl(value) {
    if (!isTrustedRemoteArtworkUrl(value)) return false;
    return YOUTUBE_IMAGE_HOSTS.has(new URL(value).hostname.toLowerCase());
}

function pickThumbnail(entry) {
    const videoId = entry && /^[A-Za-z0-9_-]{11}$/u.test(String(entry.id || ''))
        ? String(entry.id)
        : null;
    if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    const direct = entry && typeof entry.thumbnail === 'string' ? entry.thumbnail : null;
    const candidates = entry && Array.isArray(entry.thumbnails)
        ? entry.thumbnails.filter(item => item && typeof item.url === 'string')
            .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))
        : [];
    const value = candidates[0] ? candidates[0].url : direct;
    return isTrustedYoutubeArtworkUrl(value) ? value : null;
}

function cleanYoutubeTitle(value) {
    return String(value || '')
        .replace(/\s*[[(]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visuali[sz]er|hd|4k|mv)\s*[)\]]\s*/giu, ' ')
        .replace(/\s{2,}/gu, ' ')
        .trim();
}

function splitYoutubeTitle(rawTitle, uploader) {
    const cleaned = cleanYoutubeTitle(rawTitle);
    const separator = cleaned.match(/^(.{1,100}?)\s+[-\u2013\u2014]\s+(.{1,180})$/u);
    if (separator) return { artist: separator[1].trim(), title: separator[2].trim() };
    return {
        artist: String(uploader || '').replace(/\s*-\s*Topic$/iu, '').trim(),
        title: cleaned
    };
}

function scoreCandidate(song, entry) {
    let expectedTitle = String(song.songname || song.title || '').trim();
    let expectedArtist = String(song.artist || '').trim();
    const titleParts = splitYoutubeTitle(expectedTitle, '');
    const unknownArtist = !expectedArtist || /^(?:unknown|unknown artist|n\/a)$/iu.test(expectedArtist);
    if (titleParts.artist && (unknownArtist || Matching.textSimilarity(expectedArtist, titleParts.artist) >= 0.7)) {
        expectedArtist = unknownArtist ? titleParts.artist : expectedArtist;
        expectedTitle = titleParts.title;
    }
    const expectedDuration = Number(song.duration_seconds ?? song.duration);
    const rawTitle = String(entry.title || '').trim();
    const candidate = splitYoutubeTitle(rawTitle, entry.uploader || entry.channel);
    const actualDuration = Number(entry.duration);
    const version = Matching.compareVersionIdentity(expectedTitle, candidate.title || rawTitle);
    if (!version.compatible) return null;

    const expectedCore = Matching.parseVersionIdentity(expectedTitle).coreTitle;
    const candidateCore = Matching.parseVersionIdentity(candidate.title || rawTitle).coreTitle;
    const titleScore = Matching.textSimilarity(expectedCore, candidateCore);
    const artistScore = expectedArtist
        ? Math.max(
            Matching.textSimilarity(expectedArtist, candidate.artist),
            Matching.textSimilarity(expectedArtist, entry.uploader || entry.channel || '')
        )
        : 1;
    const fullScore = Matching.textSimilarity(
        `${expectedArtist} ${expectedTitle}`,
        `${candidate.artist} ${candidate.title || rawTitle}`
    );

    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || !Number.isFinite(actualDuration) || actualDuration <= 0) {
        return null;
    }
    const durationDelta = Math.abs(expectedDuration - actualDuration);
    const durationTolerance = Math.max(3, expectedDuration * 0.02);
    if (durationDelta > durationTolerance) return null;
    if (titleScore < 0.82 || artistScore < 0.62) return null;

    const durationScore = 1 - (durationDelta / durationTolerance);
    const score = (titleScore * 0.55) + (artistScore * 0.20) + (fullScore * 0.15) + (durationScore * 0.10);
    const thumbnail = pickThumbnail(entry);
    if (!thumbnail || score < 0.84) return null;

    return {
        url: thumbnail,
        videoId: entry.id || null,
        title: rawTitle,
        duration: actualDuration,
        score: Number(score.toFixed(4)),
        titleScore,
        artistScore,
        durationDelta
    };
}

function ytDlpEnv() {
    const env = { ...process.env };
    for (const key of SECRETS_TO_STRIP) delete env[key];
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
}

async function serializeSearch(task) {
    const previous = searchTail;
    let release;
    searchTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
        const remaining = SEARCH_GAP_MS - (Date.now() - lastSearchAt);
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
        lastSearchAt = Date.now();
        return await task();
    } finally {
        release();
    }
}

async function findExactYoutubeArtwork(song) {
    if (!ytDlp) return { status: 'unavailable', reason: 'not_configured' };
    const title = String(song.songname || song.title || '').trim();
    const artist = String(song.artist || '').trim();
    if (!title || !Number(song.duration_seconds ?? song.duration)) {
        return { status: 'no_match', reason: 'insufficient_metadata' };
    }

    const query = [artist, title].filter(Boolean).join(' ');
    try {
        const info = await serializeSearch(async () => {
            const child = ytDlp.exec(`ytsearch${SEARCH_LIMIT}:${query}`, {
                noWarnings: true,
                dumpSingleJson: true,
                flatPlaylist: true,
                skipDownload: true
            }, { env: ytDlpEnv(), timeout: 20000 });
            activeSearch = child;
            try {
                const result = await child;
                return JSON.parse(result.stdout);
            } finally {
                if (activeSearch === child) activeSearch = null;
            }
        });
        const ranked = (Array.isArray(info && info.entries) ? info.entries : [])
            .map(entry => scoreCandidate(song, entry))
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
        if (ranked.length === 0) return { status: 'no_match', reason: 'no_confident_match' };
        if (ranked[1] && ranked[0].score - ranked[1].score < 0.035) {
            return { status: 'no_match', reason: 'ambiguous' };
        }
        return { status: 'match', ...ranked[0] };
    } catch (error) {
        const message = String(error.shortMessage || error.message || error);
        const blocked = /confirm you(?:'|\u2019)?re not a bot|HTTP Error (?:403|429)|too many requests/iu.test(message);
        return { status: 'unavailable', reason: blocked ? 'blocked' : 'provider_error' };
    }
}

module.exports = {
    configure,
    shutdown,
    validArtworkMode,
    isTrustedRemoteArtworkUrl,
    isTrustedYoutubeArtworkUrl,
    findExactYoutubeArtwork,
    _test: {
        cleanYoutubeTitle,
        splitYoutubeTitle,
        scoreCandidate,
        pickThumbnail
    }
};

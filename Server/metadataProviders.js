'use strict';

const crypto = require('crypto');
const https = require('https');
const {
    normalizeForMatch,
    parseVersionIdentity
} = require('./metadataMatching');

const USER_AGENT = 'Streamify/0.3.0 (https://github.com/Lwitchy/Streamify)';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 18_000;
const PROVIDER_SETTINGS = Object.freeze({
    musicbrainz: { intervalMs: 1000, attempts: 3, cacheTtlMs: 6 * 60 * 60 * 1000 },
    apple: { intervalMs: 3000, attempts: 2, cacheTtlMs: 2 * 60 * 60 * 1000 },
    acoustid: { intervalMs: 1000, attempts: 3, cacheTtlMs: 24 * 60 * 60 * 1000 }
});

function cloneJson(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

class BoundedTtlCache {
    constructor(maxEntries = 256) {
        this.maxEntries = maxEntries;
        this.entries = new Map();
    }

    get(key, now = Date.now()) {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now) {
            this.entries.delete(key);
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return cloneJson(entry.value);
    }

    set(key, value, ttlMs, now = Date.now()) {
        this.entries.delete(key);
        this.entries.set(key, { value: cloneJson(value), expiresAt: now + ttlMs });
        while (this.entries.size > this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value);
        }
    }

    clear() {
        this.entries.clear();
    }
}

function abortError() {
    const error = new Error('Operation cancelled');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function delay(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(abortError());
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

class ProviderScheduler {
    constructor(intervalMs) {
        this.intervalMs = intervalMs;
        this.nextStartAt = 0;
        this.tail = Promise.resolve();
    }

    schedule(task, options = {}) {
        const run = async () => {
            const signal = options.signal;
            if (signal && signal.aborted) throw abortError();
            const waitMs = Math.max(0, this.nextStartAt - Date.now());
            if (options.deadline && Date.now() + waitMs >= options.deadline) {
                const error = new Error('Provider request deadline exceeded');
                error.code = 'ETIMEDOUT';
                throw error;
            }
            await delay(waitMs, signal);
            this.nextStartAt = Date.now() + this.intervalMs;
            return await task();
        };
        const result = this.tail.then(run, run);
        this.tail = result.catch(() => {});
        return result;
    }
}

const cache = new BoundedTtlCache(128);
const schedulers = Object.fromEntries(
    Object.entries(PROVIDER_SETTINGS).map(([name, settings]) => [name, new ProviderScheduler(settings.intervalMs)])
);
const inFlight = new Map();

function requestBodyBuffer(body) {
    if (body === null || body === undefined || body === '') return Buffer.alloc(0);
    return Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
}

function requestKey(provider, url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const body = requestBodyBuffer(options.body);
    const bodyHash = body.length ? crypto.createHash('sha256').update(body).digest('hex') : '';
    return crypto.createHash('sha256')
        .update(`${provider}\u0000${method}\u0000${url}\u0000${bodyHash}`)
        .digest('hex');
}

function parseRetryAfter(value, now = Date.now()) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.min(date - now, 60_000)) : 0;
}

function parseJsonSafely(value) {
    try {
        return value ? JSON.parse(value) : null;
    } catch {
        return null;
    }
}

function requestOnce(url, options = {}) {
    return new Promise((resolve) => {
        const signal = options.signal;
        if (signal && signal.aborted) {
            resolve({ kind: 'cancelled' });
            return;
        }
        let settled = false;
        let received = 0;
        const chunks = [];
        let timedOut = false;
        let wallClockTimer = null;
        let onAbort = () => {};
        const finish = result => {
            if (settled) return;
            settled = true;
            if (wallClockTimer) clearTimeout(wallClockTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const parsed = new URL(url);
        const method = String(options.method || 'GET').toUpperCase();
        const body = requestBodyBuffer(options.body);
        if (!['GET', 'POST'].includes(method) || body.length > MAX_REQUEST_BODY_BYTES) {
            finish({ kind: 'provider_error', detail: body.length > MAX_REQUEST_BODY_BYTES ? 'request_too_large' : 'invalid_method' });
            return;
        }
        const headers = {
            Accept: 'application/json',
            'User-Agent': options.userAgent || USER_AGENT
        };
        if (body.length) {
            headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
            headers['Content-Length'] = String(body.length);
        }
        const timeoutMs = Math.max(500, Number(options.timeoutMs) || 7000);
        const request = https.request(parsed, {
            method,
            headers
        }, response => {
            response.on('data', chunk => {
                received += chunk.length;
                if (received > (options.maxBytes || MAX_RESPONSE_BYTES)) {
                    request.destroy(Object.assign(new Error('Response limit exceeded'), { code: 'ERESPONSETOOLARGE' }));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                finish({
                    kind: 'response',
                    statusCode: Number(response.statusCode) || 0,
                    retryAfter: response.headers['retry-after'],
                    data: parseJsonSafely(body),
                    validJson: body.length === 0 || parseJsonSafely(body) !== null
                });
            });
            response.on('error', error => finish({ kind: 'network', code: error.code || 'ERESPONSE' }));
        });
        onAbort = () => request.destroy(abortError());
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        request.on('error', error => {
            if (signal && signal.aborted) finish({ kind: 'cancelled' });
            else if (timedOut || error.code === 'ETIMEDOUT') finish({ kind: 'timeout' });
            else if (error.code === 'ERESPONSETOOLARGE') finish({ kind: 'provider_error', detail: 'response_too_large' });
            else finish({ kind: 'network', code: error.code || 'ENETWORK' });
        });
        const timeoutRequest = () => {
            timedOut = true;
            request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' }));
        };
        // request.setTimeout only measures socket inactivity and does not cover
        // DNS/TLS setup or a response that continuously trickles bytes.
        wallClockTimer = setTimeout(timeoutRequest, timeoutMs);
        wallClockTimer.unref?.();
        request.setTimeout(timeoutMs, timeoutRequest);
        request.end(body.length ? body : undefined);
    });
}

function isOfflineCode(code) {
    return new Set([
        'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETDOWN', 'ENETUNREACH',
        'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'ENETWORK'
    ]).has(code);
}

function invalidAcoustIdResponse(data) {
    if (!data || data.status !== 'error') return false;
    const code = Number(data.error && data.error.code);
    const message = String(data.error && data.error.message || '').toLowerCase();
    return code === 4 || /(?:api\s*key|client|authentication|unauthori[sz]ed)/u.test(message);
}

async function performRequest(provider, url, options = {}) {
    const settings = PROVIDER_SETTINGS[provider];
    const signal = options.signal;
    const totalTimeoutMs = Math.max(1000, Math.min(Number(options.totalTimeoutMs) || DEFAULT_TOTAL_TIMEOUT_MS, 60_000));
    const deadline = Date.now() + totalTimeoutMs;
    const attempts = Math.max(1, Math.min(Number(options.attempts) || settings.attempts, 4));
    let lastResult = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (signal && signal.aborted) return { status: 'cancelled', detail: 'cancelled', attempts: attempt - 1 };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { status: 'provider_error', detail: 'timeout', attempts: attempt - 1 };
        try {
            lastResult = await schedulers[provider].schedule(
                () => requestOnce(url, {
                    signal,
                    timeoutMs: Math.min(Number(options.requestTimeoutMs) || 7000, Math.max(500, deadline - Date.now())),
                    maxBytes: options.maxBytes,
                    userAgent: options.userAgent,
                    method: options.method,
                    body: options.body,
                    contentType: options.contentType
                }),
                { signal, deadline }
            );
        } catch (error) {
            if (error && error.name === 'AbortError') return { status: 'cancelled', detail: 'cancelled', attempts: attempt - 1 };
            return { status: 'provider_error', detail: 'timeout', attempts: attempt - 1 };
        }

        if (lastResult.kind === 'cancelled') return { status: 'cancelled', detail: 'cancelled', attempts: attempt };
        if (lastResult.kind === 'network') {
            if (attempt < attempts && Date.now() + (250 * attempt) < deadline) {
                try { await delay(250 * attempt, signal); } catch { return { status: 'cancelled', detail: 'cancelled', attempts: attempt }; }
                continue;
            }
            return {
                status: isOfflineCode(lastResult.code) ? 'offline' : 'provider_error',
                detail: isOfflineCode(lastResult.code) ? 'network_unavailable' : 'network_error',
                attempts: attempt
            };
        }
        if (lastResult.kind === 'timeout') {
            if (attempt < attempts && Date.now() + 250 < deadline) continue;
            return { status: 'provider_error', detail: 'timeout', attempts: attempt };
        }
        if (lastResult.kind === 'provider_error') return { status: 'provider_error', detail: lastResult.detail, attempts: attempt };

        const statusCode = lastResult.statusCode;
        if (statusCode >= 200 && statusCode < 300) {
            if (!lastResult.validJson) return { status: 'provider_error', detail: 'invalid_response', attempts: attempt };
            if (provider === 'acoustid' && invalidAcoustIdResponse(lastResult.data)) {
                return { status: 'invalid_key', detail: 'invalid_key', attempts: attempt };
            }
            return { status: 'ok', data: lastResult.data, attempts: attempt };
        }
        if (statusCode === 404) return { status: 'no_match', detail: 'not_found', attempts: attempt };
        if ((statusCode === 401 || statusCode === 403) && provider === 'acoustid') {
            return { status: 'invalid_key', detail: 'invalid_key', attempts: attempt };
        }
        const retryable = statusCode === 429 || statusCode === 503 || (statusCode >= 500 && statusCode <= 599);
        if (retryable && attempt < attempts) {
            const retryAfter = parseRetryAfter(lastResult.retryAfter);
            const backoff = retryAfter || Math.min(500 * (2 ** (attempt - 1)), 4000);
            if (Date.now() + backoff >= deadline) break;
            try { await delay(backoff, signal); } catch { return { status: 'cancelled', detail: 'cancelled', attempts: attempt }; }
            continue;
        }
        if (statusCode === 429) return { status: 'rate_limited', detail: 'rate_limited', attempts: attempt };
        if (provider === 'acoustid' && invalidAcoustIdResponse(lastResult.data)) {
            return { status: 'invalid_key', detail: 'invalid_key', attempts: attempt };
        }
        return { status: 'provider_error', detail: `http_${statusCode || 'error'}`, attempts: attempt };
    }

    if (lastResult && lastResult.statusCode === 429) return { status: 'rate_limited', detail: 'rate_limited', attempts };
    return { status: 'provider_error', detail: 'retry_exhausted', attempts };
}

function cacheTtlForResult(provider, result) {
    if (result.status === 'ok' || result.status === 'no_match') return PROVIDER_SETTINGS[provider].cacheTtlMs;
    if (result.status === 'invalid_key') return 60_000;
    if (result.status === 'rate_limited') return 15_000;
    if (result.status === 'offline' || result.status === 'provider_error') return 5000;
    return 0;
}

function subscribeToShared(shared, signal) {
    if (signal && signal.aborted) return Promise.resolve({ status: 'cancelled', detail: 'cancelled', cached: false });
    const token = Symbol('provider-consumer');
    shared.consumers.add(token);
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            shared.consumers.delete(token);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(cloneJson(value));
        };
        const onAbort = () => {
            finish({ status: 'cancelled', detail: 'cancelled', cached: false });
            if (shared.consumers.size === 0) shared.controller.abort();
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        shared.promise.then(finish, () => finish({ status: 'provider_error', detail: 'request_failed', cached: false }));
    });
}

function requestJson(provider, url, options = {}) {
    if (!PROVIDER_SETTINGS[provider]) return Promise.resolve({ status: 'provider_error', detail: 'unknown_provider', cached: false });
    if (options.signal && options.signal.aborted) return Promise.resolve({ status: 'cancelled', detail: 'cancelled', cached: false });
    const body = requestBodyBuffer(options.body);
    if (body.length > MAX_REQUEST_BODY_BYTES) return Promise.resolve({ status: 'provider_error', detail: 'request_too_large', cached: false });
    const requestOptions = { ...options, body: Buffer.from(body) };
    const key = requestKey(provider, url, { method: requestOptions.method, body: requestOptions.body });
    const cached = cache.get(key);
    if (cached) return Promise.resolve({ ...cached, cached: true });

    let shared = inFlight.get(key);
    if (!shared) {
        const controller = new AbortController();
        shared = { controller, consumers: new Set(), promise: null };
        shared.promise = performRequest(provider, url, { ...requestOptions, signal: controller.signal })
            .then(result => {
                const stored = { ...result, cached: false };
                const ttl = cacheTtlForResult(provider, result);
                if (ttl > 0 && result.status !== 'cancelled') cache.set(key, stored, ttl);
                return stored;
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, shared);
    }
    return subscribeToShared(shared, options.signal);
}

function cleanQueryValue(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 300);
}

function escapeLucenePhrase(value) {
    return cleanQueryValue(value).replace(/([\\"])/gu, '\\$1');
}

function buildMusicBrainzQuery(query = {}) {
    const title = escapeLucenePhrase(query.title);
    const artist = escapeLucenePhrase(query.artist);
    if (!title) return '';
    const clauses = [`recording:"${title}"`];
    if (artist) clauses.push(`artist:"${artist}"`);
    return clauses.join(' AND ');
}

function artistCreditData(credits) {
    const list = Array.isArray(credits) ? credits : [];
    let featuring = false;
    const artists = [];
    const featuredArtists = [];
    for (const credit of list) {
        if (!credit) continue;
        const name = cleanQueryValue(credit.name || (credit.artist && credit.artist.name));
        if (!name) continue;
        const artist = {
            id: credit.artist && credit.artist.id || null,
            name,
            joinPhrase: credit.joinphrase || ''
        };
        artists.push(artist);
        if (featuring) featuredArtists.push(name);
        if (/(?:feat(?:uring)?|ft)\.?/iu.test(credit.joinphrase || '')) featuring = true;
    }
    const full = artists.map((artist, index) => {
        const fallbackJoin = index < artists.length - 1 ? ', ' : '';
        return artist.name + (artist.joinPhrase || fallbackJoin);
    }).join('');
    return {
        full: full.trim(),
        artists,
        featuredArtists,
        primaryArtists: artists.map(artist => artist.name).filter(name => !featuredArtists.includes(name))
    };
}

function normalizeDate(value) {
    if (value && typeof value === 'object') {
        const year = Number(value.year);
        if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
        const month = Number(value.month);
        const day = Number(value.day);
        let result = String(year).padStart(4, '0');
        if (Number.isInteger(month) && month >= 1 && month <= 12) {
            result += `-${String(month).padStart(2, '0')}`;
            if (Number.isInteger(day) && day >= 1 && day <= 31) result += `-${String(day).padStart(2, '0')}`;
        }
        return result;
    }
    const text = String(value || '').trim();
    return text || null;
}

function yearFromDate(value) {
    const match = /^(19\d{2}|20\d{2})/u.exec(normalizeDate(value) || '');
    return match ? Number(match[1]) : null;
}

function musicBrainzReleaseCandidate(release) {
    if (!release || !release.id) return null;
    const releaseGroup = release['release-group'] || release.releaseGroup || {};
    return {
        id: release.id,
        provider: 'musicbrainz',
        album: release.title || null,
        title: release.title || null,
        date: release.date || null,
        year: yearFromDate(release.date),
        country: release.country || null,
        status: release.status || null,
        releaseGroupId: releaseGroup.id || null,
        releaseGroupType: releaseGroup['primary-type'] || releaseGroup.primaryType || null,
        trackCount: Number(release['track-count']) || null,
        coverUrl: `https://coverartarchive.org/release/${release.id}/front-500`
    };
}

function preferredRelease(releases) {
    return [...(releases || [])].sort((left, right) => {
        const leftOfficial = left.status === 'Official' ? 1 : 0;
        const rightOfficial = right.status === 'Official' ? 1 : 0;
        if (leftOfficial !== rightOfficial) return rightOfficial - leftOfficial;
        const leftWorldwide = left.country === 'XW' ? 1 : 0;
        const rightWorldwide = right.country === 'XW' ? 1 : 0;
        if (leftWorldwide !== rightWorldwide) return rightWorldwide - leftWorldwide;
        return String(left.date || '9999').localeCompare(String(right.date || '9999'));
    })[0] || null;
}

function normalizeGenres(tags, genres) {
    const values = [];
    for (const genre of genres || []) {
        if (genre && genre.name) values.push({ name: cleanQueryValue(genre.name), count: Number(genre.count) || 0 });
    }
    for (const tag of tags || []) {
        if (tag && tag.name && Number(tag.count) > 0) values.push({ name: cleanQueryValue(tag.name), count: Number(tag.count) || 0 });
    }
    const unique = new Map();
    for (const value of values) {
        const key = normalizeForMatch(value.name);
        if (!key || key === 'unknown genre') continue;
        const existing = unique.get(key);
        if (!existing || value.count > existing.count) unique.set(key, value);
    }
    return Array.from(unique.values()).sort((left, right) => right.count - left.count).map(value => value.name);
}

function mapMusicBrainzRecording(recording, options = {}) {
    if (!recording || !recording.id || !recording.title) return null;
    const credit = artistCreditData(recording['artist-credit']);
    const releaseCandidates = (recording.releases || []).map(musicBrainzReleaseCandidate).filter(Boolean);
    const release = preferredRelease(releaseCandidates);
    const genres = normalizeGenres(recording.tags, recording.genres);
    const releaseGroupIds = releaseCandidates.map(item => item.releaseGroupId).filter(Boolean);
    const artistIds = credit.artists.map(artist => artist.id).filter(Boolean);
    const isrcs = Array.isArray(recording.isrcs) ? recording.isrcs.map(cleanQueryValue).filter(Boolean) : [];
    const nativeScore = Number(recording.score);
    const matchBasis = options.matchBasis || 'text';
    return {
        id: `musicbrainz:${recording.id}`,
        candidateId: `musicbrainz:${recording.id}`,
        recordingId: recording.id,
        provider: 'musicbrainz',
        source: 'musicbrainz',
        providers: ['musicbrainz'],
        title: recording.title,
        artist: credit.full || null,
        artistCredits: credit.artists,
        primaryArtists: credit.primaryArtists,
        featuredArtists: credit.featuredArtists,
        album: release && release.album || null,
        year: yearFromDate(recording['first-release-date']) || release && release.year || null,
        date: recording['first-release-date'] || release && release.date || null,
        durationMs: Number(recording.length) > 0 ? Number(recording.length) : null,
        genre: genres[0] || null,
        genres,
        coverUrl: release && release.coverUrl || null,
        providerNativeScore: Number.isFinite(nativeScore) ? Math.max(0, Math.min(1, nativeScore / 100)) : (options.direct ? 1 : null),
        providerNativeScores: { musicbrainz: Number.isFinite(nativeScore) ? nativeScore / 100 : (options.direct ? 1 : null) },
        externalIds: {
            musicbrainzRecording: recording.id,
            musicbrainzReleases: releaseCandidates.map(item => item.id),
            musicbrainzReleaseGroups: releaseGroupIds,
            musicbrainzArtists: artistIds,
            isrcs
        },
        releaseCandidates,
        version: parseVersionIdentity(recording.title),
        matchBasis,
        identityValidated: matchBasis !== 'text' && options.direct === true,
        identityScore: matchBasis === 'embedded_id' && options.direct === true ? 1 : null
    };
}

function parseMusicBrainzSearch(data, options = {}) {
    const byRecording = new Map();
    for (const recording of data && Array.isArray(data.recordings) ? data.recordings : []) {
        const mapped = mapMusicBrainzRecording(recording, options);
        if (!mapped) continue;
        const existing = byRecording.get(mapped.recordingId);
        if (!existing) {
            byRecording.set(mapped.recordingId, mapped);
            continue;
        }
        const releases = new Map(existing.releaseCandidates.map(release => [release.id, release]));
        for (const release of mapped.releaseCandidates) releases.set(release.id, release);
        existing.releaseCandidates = Array.from(releases.values());
        existing.externalIds.musicbrainzReleases = existing.releaseCandidates.map(release => release.id);
    }
    return Array.from(byRecording.values());
}

function providerResult(name, request, candidates) {
    const usable = Array.isArray(candidates) ? candidates : [];
    const status = request.status === 'ok' ? (usable.length ? 'matched' : 'no_match') : request.status;
    return {
        provider: name,
        name,
        status,
        detail: request.status === 'ok' ? '' : (request.detail || ''),
        cached: request.cached === true,
        attempts: request.attempts || 0,
        candidateCount: usable.length,
        candidates: usable
    };
}

async function searchMusicBrainz(query, options = {}) {
    const luceneQuery = buildMusicBrainzQuery(query);
    if (!luceneQuery) return providerResult('musicbrainz', { status: 'no_match', detail: 'empty_query' }, []);
    const parameters = new URLSearchParams({ query: luceneQuery, fmt: 'json', limit: String(Math.max(1, Math.min(Number(options.limit) || 15, 25))) });
    const request = await (options.requestJson || requestJson)('musicbrainz', `https://musicbrainz.org/ws/2/recording/?${parameters.toString()}`, options);
    const candidates = request.status === 'ok' ? parseMusicBrainzSearch(request.data, { matchBasis: options.matchBasis || 'text' }) : [];
    return providerResult('musicbrainz', request, candidates);
}

function validMusicBrainzId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || ''));
}

async function lookupMusicBrainzRecording(recordingId, options = {}) {
    if (!validMusicBrainzId(recordingId)) return providerResult('musicbrainz', { status: 'provider_error', detail: 'invalid_identifier' }, []);
    const parameters = new URLSearchParams({ inc: 'artist-credits+releases+release-groups+isrcs+genres+tags', fmt: 'json' });
    const request = await (options.requestJson || requestJson)(
        'musicbrainz',
        `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recordingId)}?${parameters.toString()}`,
        options
    );
    const mapped = request.status === 'ok'
        ? mapMusicBrainzRecording(request.data, { direct: true, matchBasis: options.matchBasis || 'embedded_id' })
        : null;
    return providerResult('musicbrainz', request, mapped ? [mapped] : []);
}

async function searchMusicBrainzIdentifier(type, value, options = {}) {
    const cleanValue = cleanQueryValue(value);
    if (!cleanValue) return providerResult('musicbrainz', { status: 'no_match', detail: 'empty_identifier' }, []);
    if (type === 'musicbrainz_recording') return lookupMusicBrainzRecording(cleanValue, options);
    if (type !== 'isrc' || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/iu.test(cleanValue.replace(/[\s-]/gu, ''))) {
        return providerResult('musicbrainz', { status: 'provider_error', detail: 'invalid_identifier' }, []);
    }
    const identifier = cleanValue.replace(/[\s-]/gu, '').toUpperCase();
    const parameters = new URLSearchParams({ query: `isrc:${identifier}`, fmt: 'json', limit: '10' });
    const request = await (options.requestJson || requestJson)('musicbrainz', `https://musicbrainz.org/ws/2/recording/?${parameters.toString()}`, options);
    const candidates = request.status === 'ok'
        ? parseMusicBrainzSearch(request.data, { matchBasis: 'embedded_id' }).map(candidate => ({
            ...candidate,
            identityValidated: true,
            externalIds: {
                ...candidate.externalIds,
                isrcs: [...new Set([...(candidate.externalIds.isrcs || []), identifier])]
            }
        }))
        : [];
    return providerResult('musicbrainz', request, candidates);
}

function appleArtwork(value) {
    if (!value) return null;
    return String(value).replace(/\/\d+x\d+(?:bb)?(?=\.(?:jpg|png))/iu, '/600x600bb');
}

function mapAppleResult(track, index = 0) {
    if (!track || track.wrapperType !== 'track' || track.kind !== 'song' || !track.trackName) return null;
    const trackId = track.trackId !== undefined ? String(track.trackId) : null;
    const collectionId = track.collectionId !== undefined ? String(track.collectionId) : null;
    const artwork = appleArtwork(track.artworkUrl100 || track.artworkUrl60 || track.artworkUrl30);
    const year = yearFromDate(track.releaseDate);
    const releaseCandidates = collectionId ? [{
        id: collectionId,
        provider: 'apple',
        album: track.collectionName || null,
        title: track.collectionName || null,
        date: track.releaseDate || null,
        year,
        country: track.country || null,
        trackCount: Number(track.trackCount) || null,
        trackNumber: Number(track.trackNumber) || null,
        coverUrl: artwork
    }] : [];
    const genre = track.primaryGenreName && normalizeForMatch(track.primaryGenreName) !== 'unknown genre'
        ? track.primaryGenreName
        : null;
    return {
        id: `apple:${trackId || `${normalizeForMatch(track.artistName)}:${normalizeForMatch(track.trackName)}:${index}`}`,
        candidateId: trackId ? `apple:${trackId}` : null,
        recordingId: trackId,
        provider: 'apple',
        source: 'itunes',
        providers: ['apple'],
        title: track.trackName,
        artist: track.artistName || null,
        artistCredits: track.artistName ? [{ id: track.artistId ? String(track.artistId) : null, name: track.artistName, joinPhrase: '' }] : [],
        primaryArtists: track.artistName ? [track.artistName] : [],
        featuredArtists: [],
        album: track.collectionName || null,
        year,
        date: track.releaseDate || null,
        durationMs: Number(track.trackTimeMillis) > 0 ? Number(track.trackTimeMillis) : null,
        genre,
        genres: genre ? [genre] : [],
        coverUrl: artwork,
        providerNativeScore: null,
        providerNativeScores: { apple: null },
        externalIds: {
            appleTrack: trackId ? [trackId] : [],
            appleCollection: collectionId ? [collectionId] : [],
            appleArtist: track.artistId !== undefined ? [String(track.artistId)] : []
        },
        releaseCandidates,
        version: parseVersionIdentity(track.trackName),
        matchBasis: 'text',
        identityValidated: false
    };
}

function parseAppleSearch(data) {
    const byRecording = new Map();
    const results = data && Array.isArray(data.results) ? data.results : [];
    for (let index = 0; index < results.length; index++) {
        const candidate = mapAppleResult(results[index], index);
        if (!candidate) continue;
        const durationBucket = candidate.durationMs ? Math.round(candidate.durationMs / 2000) : '';
        const key = `${normalizeForMatch(candidate.artist)}:${normalizeForMatch(candidate.title)}:${durationBucket}`;
        const existing = byRecording.get(key);
        if (!existing) {
            byRecording.set(key, candidate);
            continue;
        }
        const releases = new Map(existing.releaseCandidates.map(release => [release.id, release]));
        for (const release of candidate.releaseCandidates) releases.set(release.id, release);
        existing.releaseCandidates = Array.from(releases.values());
        for (const externalKey of ['appleTrack', 'appleCollection', 'appleArtist']) {
            existing.externalIds[externalKey] = [...new Set([
                ...(existing.externalIds[externalKey] || []),
                ...(candidate.externalIds[externalKey] || [])
            ])];
        }
    }
    return Array.from(byRecording.values());
}

function buildAppleSearchUrl(query, options = {}, includeCountry = true) {
    const term = cleanQueryValue([query.artist, query.title].filter(Boolean).join(' '));
    if (!term) return null;
    const parameters = new URLSearchParams({
        term,
        media: 'music',
        entity: 'song',
        limit: String(Math.max(1, Math.min(Number(options.limit) || 20, 50)))
    });
    if (includeCountry && /^[A-Z]{2}$/iu.test(String(options.country || ''))) {
        parameters.set('country', String(options.country).toUpperCase());
    }
    return `https://itunes.apple.com/search?${parameters.toString()}`;
}

async function searchApple(query, options = {}) {
    const firstUrl = buildAppleSearchUrl(query, options, true);
    if (!firstUrl) return providerResult('apple', { status: 'no_match', detail: 'empty_query' }, []);
    let request = await (options.requestJson || requestJson)('apple', firstUrl, options);
    let candidates = request.status === 'ok' ? parseAppleSearch(request.data) : [];
    const usedCountry = /^[A-Z]{2}$/iu.test(String(options.country || ''));
    if (usedCountry && request.status === 'ok' && candidates.length === 0 && !(options.signal && options.signal.aborted)) {
        const fallbackUrl = buildAppleSearchUrl(query, options, false);
        request = await (options.requestJson || requestJson)('apple', fallbackUrl, options);
        candidates = request.status === 'ok' ? parseAppleSearch(request.data) : [];
    }
    return providerResult('apple', request, candidates);
}

function acoustIdArtistData(artists) {
    const list = (artists || []).map(artist => ({
        id: artist && artist.id || null,
        name: cleanQueryValue(artist && artist.name),
        joinPhrase: artist && (artist.joinphrase || artist.joinPhrase) || ''
    })).filter(artist => artist.name);
    const full = list.map((artist, index) => artist.name + (artist.joinPhrase || (index < list.length - 1 ? ', ' : ''))).join('').trim();
    return { full, list };
}

function mapAcoustIdResponse(data) {
    const candidates = [];
    for (const result of data && Array.isArray(data.results) ? data.results : []) {
        const nativeScore = Number(result.score);
        for (const recording of result.recordings || []) {
            if (!recording || !recording.id || !recording.title) continue;
            const credit = acoustIdArtistData(recording.artists);
            const releaseGroups = recording.releasegroups || recording.releaseGroups || [];
            const releases = recording.releases || [];
            const releaseCandidates = [];
            const addRelease = (release, releaseGroup = null) => {
                if (!release || !release.id) return;
                const releaseDate = normalizeDate(release.date);
                const candidate = {
                    id: release.id,
                    provider: 'musicbrainz',
                    album: release.title || null,
                    title: release.title || null,
                    date: releaseDate,
                    year: yearFromDate(releaseDate),
                    country: release.country || null,
                    status: release.status || null,
                    releaseGroupId: releaseGroup && releaseGroup.id ||
                        release.releasegroup && release.releasegroup.id ||
                        release.releaseGroup && release.releaseGroup.id || null,
                    releaseGroupType: releaseGroup && (releaseGroup.type || releaseGroup.primaryType) || null,
                    coverUrl: `https://coverartarchive.org/release/${release.id}/front-500`
                };
                const existingIndex = releaseCandidates.findIndex(item => item.id === candidate.id);
                if (existingIndex >= 0) releaseCandidates[existingIndex] = { ...releaseCandidates[existingIndex], ...candidate };
                else releaseCandidates.push(candidate);
            };
            for (const release of releases) {
                addRelease(release);
            }
            for (const group of releaseGroups) {
                if (!group || !group.id) continue;
                for (const release of group.releases || []) addRelease(release, group);
            }
            const preferred = preferredRelease(releaseCandidates);
            const preferredGroup = releaseGroups.find(group => group && group.title) || null;
            const preferredGroupDate = normalizeDate(preferredGroup && (preferredGroup.firstreleasedate || preferredGroup.firstReleaseDate));
            candidates.push({
                id: `musicbrainz:${recording.id}`,
                candidateId: `musicbrainz:${recording.id}`,
                recordingId: recording.id,
                provider: 'acoustid',
                source: 'acoustid',
                providers: ['acoustid'],
                title: recording.title,
                artist: credit.full || null,
                artistCredits: credit.list,
                primaryArtists: credit.list.map(artist => artist.name),
                featuredArtists: [],
                album: preferred && preferred.album || preferredGroup && preferredGroup.title || null,
                year: preferred && preferred.year || yearFromDate(preferredGroupDate) || null,
                date: preferred && preferred.date || preferredGroupDate,
                durationMs: Number(recording.duration) > 0 ? Math.round(Number(recording.duration) * 1000) : null,
                genre: null,
                genres: [],
                coverUrl: preferred && preferred.coverUrl || null,
                providerNativeScore: Number.isFinite(nativeScore) ? Math.max(0, Math.min(1, nativeScore)) : null,
                providerNativeScores: { acoustid: Number.isFinite(nativeScore) ? nativeScore : null },
                externalIds: {
                    acoustid: result.id ? [String(result.id)] : [],
                    musicbrainzRecording: recording.id,
                    musicbrainzReleases: releaseCandidates.map(release => release.id),
                    musicbrainzReleaseGroups: releaseGroups.map(group => group && group.id).filter(Boolean),
                    isrcs: Array.isArray(recording.isrcs) ? recording.isrcs : []
                },
                releaseCandidates,
                version: parseVersionIdentity(recording.title),
                matchBasis: 'fingerprint',
                identityValidated: Number.isFinite(nativeScore) && nativeScore >= 0.85,
                identityScore: Number.isFinite(nativeScore) ? nativeScore : null
            });
        }
    }
    return candidates;
}

async function lookupAcoustId(input = {}, options = {}) {
    const key = String(input.key || '').trim();
    const fingerprint = String(input.fingerprint || '').trim();
    const duration = Math.round(Number(input.duration));
    if (!key) return providerResult('acoustid', { status: 'invalid_key', detail: 'missing_key' }, []);
    if (!fingerprint || !(duration > 0)) return providerResult('acoustid', { status: 'no_match', detail: 'missing_fingerprint' }, []);
    if (fingerprint.length > 1024 * 1024) return providerResult('acoustid', { status: 'provider_error', detail: 'fingerprint_too_large' }, []);
    const parameters = new URLSearchParams({
        client: key,
        duration: String(duration),
        fingerprint,
        meta: 'recordings recordingids releasegroups releasegroupids releases releaseids tracks isrcs compress',
        format: 'json'
    });
    const request = await (options.requestJson || requestJson)('acoustid', 'https://api.acoustid.org/v2/lookup', {
        ...options,
        method: 'POST',
        body: parameters.toString(),
        contentType: 'application/x-www-form-urlencoded'
    });
    if (request.status === 'ok' && request.data && request.data.status === 'error') {
        const invalidKey = invalidAcoustIdResponse(request.data);
        return providerResult('acoustid', {
            status: invalidKey ? 'invalid_key' : 'provider_error',
            detail: invalidKey ? 'invalid_key' : 'lookup_error',
            cached: request.cached,
            attempts: request.attempts
        }, []);
    }
    const candidates = request.status === 'ok' ? mapAcoustIdResponse(request.data) : [];
    return providerResult('acoustid', request, candidates);
}

function providerStatusOnly(result) {
    return {
        name: result.name || result.provider,
        provider: result.provider || result.name,
        status: result.status,
        detail: result.detail || '',
        cached: result.cached === true,
        attempts: result.attempts || 0,
        candidateCount: result.candidateCount || 0
    };
}

module.exports = {
    searchMusicBrainz,
    lookupMusicBrainzRecording,
    searchMusicBrainzIdentifier,
    searchApple,
    lookupAcoustId,
    providerStatusOnly,
    _test: {
        BoundedTtlCache,
        ProviderScheduler,
        parseRetryAfter,
        parseJsonSafely,
        isOfflineCode,
        invalidAcoustIdResponse,
        cleanQueryValue,
        escapeLucenePhrase,
        buildMusicBrainzQuery,
        normalizeDate,
        artistCreditData,
        musicBrainzReleaseCandidate,
        preferredRelease,
        mapMusicBrainzRecording,
        parseMusicBrainzSearch,
        appleArtwork,
        mapAppleResult,
        parseAppleSearch,
        buildAppleSearchUrl,
        mapAcoustIdResponse,
        validMusicBrainzId,
        requestBodyBuffer,
        requestKey,
        requestOnce,
        cache,
        schedulers,
        inFlight
    }
};

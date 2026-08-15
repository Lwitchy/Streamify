'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Matching = require('./metadataMatching');
const Providers = require('./metadataProviders');
const Fingerprint = require('./fingerprint');

const PIPELINE_VERSION = 'smart-auto-enrich-v1';
const LOOKUP_MODES = new Set(['local_only', 'text_only', 'acoustic_with_text_fallback']);
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_COVER_PIXELS = 25_000_000;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

function isTrustedCoverUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
        if (parsed.port && parsed.port !== '443') return false;
        return host === 'mzstatic.com' || host.endsWith('.mzstatic.com') ||
            host === 'coverartarchive.org' || host.endsWith('.coverartarchive.org') ||
            host === 'archive.org' || host.endsWith('.archive.org');
    } catch {
        return false;
    }
}

function fetchCoverToFile(url, destination, redirectsRemaining = 3) {
    return new Promise((resolve, reject) => {
        if (!isTrustedCoverUrl(url)) {
            reject(new Error('Untrusted cover source'));
            return;
        }
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };
        const request = https.get(url, { headers: { 'User-Agent': 'Streamify/0.3.0 (https://github.com/Lwitchy/Streamify)' } }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirectsRemaining <= 0) return finish(new Error('Too many redirects'));
                let redirect;
                try { redirect = new URL(response.headers.location, url).href; }
                catch { return finish(new Error('Invalid redirect')); }
                if (!isTrustedCoverUrl(redirect)) return finish(new Error('Untrusted redirect'));
                fetchCoverToFile(redirect, destination, redirectsRemaining - 1).then(
                    value => finish(null, value),
                    error => finish(error)
                );
                return;
            }

            const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (response.statusCode !== 200 || !ALLOWED_IMAGE_TYPES.has(contentType)) {
                response.resume();
                finish(new Error('Invalid image response'));
                return;
            }
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_COVER_BYTES) {
                response.resume();
                finish(new Error('Image response too large'));
                return;
            }

            const output = fs.createWriteStream(destination, { flags: 'wx' });
            let received = 0;
            response.on('data', chunk => {
                received += chunk.length;
                if (received > MAX_COVER_BYTES) response.destroy(new Error('Image response too large'));
            });
            response.on('error', error => {
                output.destroy();
                finish(error);
            });
            output.on('error', error => {
                response.destroy();
                finish(error);
            });
            output.on('finish', () => {
                output.close(error => finish(error || null, { contentType, bytes: received }));
            });
            response.pipe(output);
        });
        request.on('error', error => finish(error));
        request.setTimeout(8000, () => request.destroy(new Error('Cover request timed out')));
    });
}

async function normalizeCoverImage(inputPath, outputPath) {
    let Jimp;
    try { ({ Jimp } = require('jimp')); }
    catch { return false; }
    try {
        const image = await Jimp.read(inputPath);
        const width = Number(image.bitmap && image.bitmap.width);
        const height = Number(image.bitmap && image.bitmap.height);
        if (!(width > 0) || !(height > 0) || width * height > MAX_COVER_PIXELS) return false;
        await image.write(outputPath);
        return true;
    } catch {
        return false;
    }
}

async function downloadFile(url, destPath) {
    if (!isTrustedCoverUrl(url) || !destPath) return false;
    const destinationExtension = path.extname(destPath).toLowerCase();
    if (!/^\.(?:jpe?g|png)$/u.test(destinationExtension)) return false;
    const directory = path.dirname(destPath);
    try {
        const stat = await fs.promises.stat(directory);
        if (!stat.isDirectory()) return false;
    } catch {
        return false;
    }

    const token = crypto.randomBytes(12).toString('hex');
    const downloadedPath = path.join(directory, `.${path.basename(destPath)}.${token}.download`);
    const extension = destinationExtension;
    const normalizedPath = path.join(directory, `.${path.basename(destPath)}.${token}.normalized${extension}`);
    const cleanup = async () => {
        await Promise.all([downloadedPath, normalizedPath].map(async file => {
            try { await fs.promises.unlink(file); } catch { /* already removed */ }
        }));
    };

    try {
        await fetchCoverToFile(url, downloadedPath, 3);
        if (!await normalizeCoverImage(downloadedPath, normalizedPath)) {
            await cleanup();
            return false;
        }
        await fs.promises.rename(normalizedPath, destPath);
        await cleanup();
        return true;
    } catch {
        await cleanup();
        return false;
    }
}

function metadataDurationMs(song) {
    const direct = Number(song && (song.duration_ms ?? song.durationMs));
    if (direct > 0) return Math.round(direct);
    const seconds = Number(song && song.duration);
    return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function normalizeIdentifierType(value) {
    const type = String(value || '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
    const aliases = {
        musicbrainz_recordingid: 'musicbrainz_recording',
        musicbrainz_recording_id: 'musicbrainz_recording',
        musicbrainzrecording: 'musicbrainz_recording',
        recording_mbid: 'musicbrainz_recording',
        mb_recording_id: 'musicbrainz_recording',
        isrcs: 'isrc',
        apple_track_id: 'apple_track',
        appletrack: 'apple_track'
    };
    return aliases[type] || type;
}

function normalizeIdentifiers(...sources) {
    const identifiers = [];
    const seen = new Set();
    const add = (type, value) => {
        const normalizedType = normalizeIdentifierType(type);
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
            const normalizedValue = String(item === null || item === undefined ? '' : item).trim();
            if (!normalizedType || !normalizedValue) continue;
            const key = `${normalizedType}\u0000${normalizedValue.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            identifiers.push({ type: normalizedType, value: normalizedValue });
        }
    };
    const consume = source => {
        if (!source) return;
        if (Array.isArray(source)) {
            for (const entry of source) {
                if (entry && typeof entry === 'object') add(entry.type || entry.identifier_type || entry.name, entry.value || entry.identifier_value || entry.id);
            }
            return;
        }
        if (typeof source === 'object') {
            for (const [type, value] of Object.entries(source)) add(type, value);
        }
    };
    for (const source of sources) consume(source);
    return identifiers;
}

function embeddedMetadataFromProvenance(rows) {
    const embedded = {};
    for (const row of rows || []) {
        if (!row || String(row.source || '').toLowerCase() !== 'embedded') continue;
        const field = String(row.field_name || row.field || '');
        if (!field) continue;
        embedded[field] = row.value !== undefined ? row.value : row.value_json;
    }
    return {
        title: embedded.title || null,
        artist: embedded.artist || null,
        artists: Array.isArray(embedded.artists) ? embedded.artists : [],
        album: embedded.album || null,
        genres: Array.isArray(embedded.genres) ? embedded.genres : [],
        isrc: embedded.isrc || []
    };
}

async function loadStoredEvidence(song, options = {}) {
    let storedIdentifiers = [];
    let provenance = [];
    if (song && song.id !== undefined && options.loadStoredEvidence !== false) {
        try {
            const database = require('./database');
            [storedIdentifiers, provenance] = await Promise.all([
                database.getExternalIdentifiers(song.id),
                database.getMetadataProvenance(song.id)
            ]);
        } catch {
            storedIdentifiers = [];
            provenance = [];
        }
    }
    const embedded = {
        ...embeddedMetadataFromProvenance(provenance),
        ...(song && song.embeddedMetadata || {}),
        ...(options.embeddedMetadata || {})
    };
    const directIdentifiers = song ? {
        musicbrainz_recording: song.musicbrainz_recordingid || song.musicbrainz_recording_id,
        isrc: song.isrc,
        apple_track: song.apple_track_id
    } : {};
    const identifiers = normalizeIdentifiers(
        storedIdentifiers,
        song && (song.externalIdentifiers || song.identifiers || song.embeddedIds),
        directIdentifiers,
        embedded.isrc ? { isrc: embedded.isrc } : null,
        options.embeddedIdentifiers || options.identifiers
    );
    return { embedded, identifiers };
}

function songFilename(song, options = {}) {
    const filepath = options.filepath || song && song.filepath;
    return filepath ? path.basename(String(filepath)) : '';
}

function parentFolder(song, options = {}) {
    const filepath = options.filepath || song && song.filepath;
    if (!filepath) return '';
    const parent = path.basename(path.dirname(String(filepath)));
    return parent === '.' ? '' : parent;
}

function buildContext(song, embedded, options = {}) {
    const title = song && (song.songname || song.title) || '';
    const artist = song && song.artist || '';
    const album = song && song.album || '';
    const input = {
        title,
        artist,
        artists: song && song.artists,
        album,
        metadataSource: song && (song.metadata_source || song.metadataSource),
        embeddedMetadata: embedded,
        filename: songFilename(song, options),
        parentFolder: parentFolder(song, options)
    };
    return {
        ...input,
        durationMs: metadataDurationMs(song),
        hypotheses: Matching.generateHypotheses(input)
    };
}

function searchHypotheses(hypotheses) {
    const ranked = [...(hypotheses || [])].sort((left, right) => {
        const leftValue = left.reliability + (left.artist ? 0.14 : 0) - (left.cautious ? 0.08 : 0);
        const rightValue = right.reliability + (right.artist ? 0.14 : 0) - (right.cautious ? 0.08 : 0);
        return rightValue - leftValue;
    });
    const unique = [];
    const seen = new Set();
    for (const hypothesis of ranked) {
        const key = `${Matching.normalizeForMatch(hypothesis.title)}\u0000${Matching.normalizeForMatch(hypothesis.artist)}`;
        if (!hypothesis.title || seen.has(key)) continue;
        seen.add(key);
        unique.push(hypothesis);
    }
    return unique;
}

function lookupMode(options = {}, fallback = 'local_only') {
    if (LOOKUP_MODES.has(options.mode)) return options.mode;
    return fallback;
}

function localCandidateRecords(context) {
    const hypotheses = (context.hypotheses || []).filter(hypothesis => hypothesis && hypothesis.title);
    const structured = hypotheses.filter(hypothesis => hypothesis.artist);
    const pool = structured.length ? structured : hypotheses;
    const prioritized = [];
    for (const source of ['embedded', 'current_metadata', 'filename', 'parent_folder']) {
        const hypothesis = pool.find(item => item.source === source);
        if (hypothesis) prioritized.push(hypothesis);
    }
    for (const hypothesis of pool) {
        if (!prioritized.includes(hypothesis)) prioritized.push(hypothesis);
    }
    const candidates = [];
    const seen = new Set();
    for (const hypothesis of prioritized) {
        const titleKey = Matching.normalizeForMatch(hypothesis.title);
        const artistKey = Matching.normalizeForMatch(hypothesis.artist);
        const key = `${titleKey}\u0000${artistKey}`;
        if (!titleKey || seen.has(key)) continue;
        seen.add(key);
        const matchBasis = hypothesis.filenameOnly || hypothesis.source === 'filename' || hypothesis.source === 'parent_folder'
            ? 'filename'
            : 'local';
        const candidateId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
        candidates.push({
            id: `local:${candidateId}`,
            candidateId: `local:${candidateId}`,
            provider: 'local',
            source: 'local',
            providers: ['local'],
            title: hypothesis.title,
            artist: hypothesis.artist || null,
            artistCredits: (hypothesis.allArtists || []).map(name => ({ id: null, name, joinPhrase: '' })),
            primaryArtists: hypothesis.primaryArtists || [],
            featuredArtists: hypothesis.featuredArtists || [],
            album: hypothesis.album || null,
            year: Matching.extractYearFromText(hypothesis.title) || Matching.extractYearFromText(hypothesis.album),
            durationMs: context.durationMs || null,
            genre: null,
            genres: [],
            coverUrl: null,
            providerNativeScore: null,
            providerNativeScores: { local: null },
            externalIds: {},
            releaseCandidates: [],
            version: hypothesis.version,
            matchBasis,
            identityValidated: false,
            identityScore: null,
            localHypothesis: {
                source: hypothesis.source,
                interpretation: hypothesis.interpretation,
                reliability: hypothesis.reliability
            }
        });
        if (candidates.length >= 6) break;
    }
    return candidates;
}

function finalizeCandidateRecords(records, context) {
    const merged = Matching.mergeRecordingCandidates(records);
    return Matching.finalizeCandidates(merged, context).map(candidate => {
        if (candidate.source !== 'local') return candidate;
        candidate.safeToApply = false;
        candidate.fieldSafety = {
            songname: false,
            title: false,
            artist: false,
            album: false,
            genre: false,
            year: false,
            coverUrl: false
        };
        candidate.evidence.unshift({
            type: 'local_parse',
            label: 'Local parse',
            value: `${candidate.localHypothesis.source}:${candidate.localHypothesis.interpretation}`
        });
        return candidate;
    });
}

function providerOptions(options) {
    return {
        signal: options.signal,
        country: options.country,
        totalTimeoutMs: options.providerTimeoutMs,
        requestTimeoutMs: options.requestTimeoutMs,
        requestJson: options.requestJson
    };
}

async function runTextProviders(hypotheses, options = {}) {
    const searches = searchHypotheses(hypotheses);
    if (searches.length === 0) return [];
    const primary = searches[0];
    const query = { title: primary.coreTitle || primary.title, artist: primary.artist, album: primary.album };
    const providerOpts = providerOptions(options);
    const [musicbrainz, apple] = await Promise.all([
        Providers.searchMusicBrainz(query, providerOpts),
        Providers.searchApple(query, providerOpts)
    ]);
    const results = [musicbrainz, apple];
    const alternate = searches.find(hypothesis => {
        return Matching.textSimilarity(hypothesis.title, primary.title) < 0.82 ||
            Matching.textSimilarity(hypothesis.artist, primary.artist) < 0.65;
    });
    if (!alternate || (options.signal && options.signal.aborted)) return results;

    const alternateQuery = { title: alternate.coreTitle || alternate.title, artist: alternate.artist, album: alternate.album };
    const fallbacks = [];
    if (musicbrainz.status === 'no_match') fallbacks.push(Providers.searchMusicBrainz(alternateQuery, providerOpts));
    if (apple.status === 'no_match') fallbacks.push(Providers.searchApple(alternateQuery, providerOpts));
    if (fallbacks.length) results.push(...await Promise.all(fallbacks));
    return results;
}

async function runIdentifierProviders(identifiers, options = {}) {
    const usable = (identifiers || []).filter(identifier => identifier.type === 'musicbrainz_recording' || identifier.type === 'isrc');
    const recordingIds = usable.filter(identifier => identifier.type === 'musicbrainz_recording').slice(0, 3);
    const selected = recordingIds.length ? recordingIds : usable.filter(identifier => identifier.type === 'isrc').slice(0, 2);
    return await Promise.all(selected.map(identifier => Providers.searchMusicBrainzIdentifier(
        identifier.type,
        identifier.value,
        { ...providerOptions(options), matchBasis: 'embedded_id' }
    )));
}

function resolveAudioPath(song, options = {}) {
    const filepath = options.filepath || song && song.filepath;
    if (!filepath) return null;
    if (path.isAbsolute(filepath)) return path.resolve(filepath);
    const dataRoot = process.env.STREAMIFY_DATA_DIR
        ? path.resolve(process.env.STREAMIFY_DATA_DIR)
        : path.resolve(__dirname, '..');
    return path.resolve(dataRoot, filepath);
}

async function fingerprintInput(song, options = {}) {
    if (!options.acoustidKey) return { status: 'unavailable', reason: 'not_configured' };
    if (typeof options.fingerprint === 'string' && options.fingerprint.trim()) {
        const duration = Number(options.fingerprintDuration || options.duration || (metadataDurationMs(song) / 1000));
        if (!(duration > 0)) return { status: 'unavailable', reason: 'missing_duration' };
        return { status: 'ok', fingerprint: options.fingerprint.trim(), duration: Math.round(duration), durationMs: Math.round(duration * 1000), source: 'provided' };
    }
    if (options.fingerprint && typeof options.fingerprint === 'object' && (options.fingerprint.fingerprint || options.fingerprint.value)) {
        const duration = Number(
            options.fingerprint.duration ||
            (Number(options.fingerprint.durationMs) > 0 ? Number(options.fingerprint.durationMs) / 1000 : 0) ||
            options.fingerprintDuration ||
            options.duration ||
            (metadataDurationMs(song) / 1000)
        );
        if (!(duration > 0)) return { status: 'unavailable', reason: 'missing_duration' };
        return {
            status: 'ok',
            fingerprint: String(options.fingerprint.fingerprint || options.fingerprint.value).trim(),
            duration: Math.round(duration),
            durationMs: Math.round(duration * 1000),
            source: 'provided'
        };
    }
    const filepath = resolveAudioPath(song, options);
    if (!filepath) return { status: 'unavailable', reason: 'file_unavailable' };
    return await Fingerprint.generateFingerprint(filepath, {
        signal: options.signal,
        timeoutMs: options.fingerprintTimeoutMs,
        sampleLengthSeconds: options.fingerprintLengthSeconds
    });
}

async function runFingerprintProvider(song, options = {}) {
    if (!String(options.acoustidKey || '').trim()) {
        return {
            fingerprint: null,
            result: {
                provider: 'acoustid',
                name: 'acoustid',
                status: 'invalid_key',
                detail: 'missing_key',
                cached: false,
                attempts: 0,
                candidateCount: 0,
                candidates: []
            },
            validationResults: []
        };
    }
    const fingerprint = await fingerprintInput(song, options);
    if (fingerprint.status !== 'ok' || !fingerprint.duration) {
        return { fingerprint, result: null, validationResults: [] };
    }
    const result = await Providers.lookupAcoustId({
        key: options.acoustidKey,
        fingerprint: fingerprint.fingerprint,
        duration: fingerprint.duration
    }, providerOptions(options));
    const ids = [...new Set((result.candidates || [])
        .sort((left, right) => (Number(right.identityScore) || 0) - (Number(left.identityScore) || 0))
        .map(candidate => candidate.externalIds && candidate.externalIds.musicbrainzRecording)
        .filter(Boolean))]
        .slice(0, 3);
    const validationResults = await Promise.all(ids.map(id => Providers.lookupMusicBrainzRecording(id, {
        ...providerOptions(options),
        matchBasis: 'fingerprint'
    })));
    return { fingerprint, result, validationResults };
}

function aggregateProviderResults(results) {
    const groups = new Map();
    for (const result of results.filter(Boolean)) {
        const name = result.provider || result.name;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(result);
    }
    const candidates = [];
    const statuses = [];
    const priority = ['matched', 'rate_limited', 'invalid_key', 'offline', 'provider_error', 'cancelled', 'no_match'];
    for (const [name, providerResults] of groups) {
        for (const result of providerResults) candidates.push(...(result.candidates || []));
        const status = priority.find(value => providerResults.some(result => result.status === value)) || 'no_match';
        const details = [...new Set(providerResults.map(result => result.detail).filter(Boolean))];
        statuses.push({
            name,
            provider: name,
            status,
            detail: details.join(', '),
            cached: providerResults.every(result => result.cached === true),
            attempts: providerResults.reduce((sum, result) => sum + (Number(result.attempts) || 0), 0),
            candidateCount: providerResults.reduce((sum, result) => sum + (result.candidates || []).length, 0)
        });
    }
    return { candidates, statuses };
}

function providerFailureWithoutCandidates(statuses) {
    const failures = new Set(['offline', 'rate_limited', 'invalid_key', 'provider_error', 'cancelled']);
    return statuses.length > 0 && statuses.every(status => failures.has(status.status));
}

function originalMetadata(song, context) {
    return {
        title: song && (song.songname || song.title) || '',
        songname: song && (song.songname || song.title) || '',
        artist: song && song.artist || '',
        artists: Array.isArray(song && song.artists) ? song.artists : [],
        album: song && song.album || '',
        genre: song && song.genre || '',
        year: song && song.year || null,
        duration: song && song.duration || null,
        durationMs: context.durationMs || null,
        cover_path: song && song.cover_path || null,
        metadataStatus: song && (song.metadata_status || song.metadataStatus) || null,
        metadataSource: song && (song.metadata_source || song.metadataSource) || null,
        filename: context.filename || ''
    };
}

function suggestionFromCandidate(candidate) {
    const confidence = candidate.safeToApply
        ? candidate.confidence
        : Math.min(candidate.confidence, Matching.LEGACY_AUTO_THRESHOLD - 0.01);
    const suggestion = {
        id: candidate.id,
        candidateId: candidate.candidateId || candidate.id,
        source: candidate.source || candidate.provider,
        provider: candidate.provider,
        confidence: Number(confidence.toFixed(4)),
        safeToApply: candidate.safeToApply,
        externalIds: candidate.externalIds,
        releaseCandidates: candidate.releaseCandidates
    };
    if (!candidate.safeToApply || candidate.fieldSafety.title) suggestion.title = candidate.title;
    if (!candidate.safeToApply || candidate.fieldSafety.artist) suggestion.artist = candidate.artist;
    if (!candidate.safeToApply || candidate.fieldSafety.album) suggestion.album = candidate.album || null;
    if ((!candidate.safeToApply && candidate.genre) || candidate.fieldSafety.genre) suggestion.genre = candidate.genre;
    if ((!candidate.safeToApply && candidate.year) || candidate.fieldSafety.year) suggestion.year = candidate.year;
    if ((!candidate.safeToApply && candidate.coverUrl) || candidate.fieldSafety.coverUrl) suggestion.coverUrl = candidate.coverUrl;
    return suggestion;
}

function parsedContract(context, song) {
    const preferred = context.hypotheses[0] || {};
    const parsedFilename = Matching.parseFilenameSituations(context.filename || song && (song.songname || song.title) || '');
    const genreEvidence = Matching.classifyGenreEvidence(
        preferred.title,
        preferred.artist,
        preferred.album,
        song && song.genre
    );
    return {
        titleHint: preferred.title || parsedFilename.titleHint || '',
        artistHint: preferred.artist || parsedFilename.artistHint || null,
        yearHint: parsedFilename.detectedYear || Matching.extractYearFromText(song && song.songname) || Matching.extractYearFromText(song && song.album),
        genreHint: genreEvidence ? genreEvidence.value : null,
        genreEvidence,
        featuredArtists: preferred.featuredArtists || parsedFilename.featuredArtists || [],
        version: preferred.version || parsedFilename.version,
        hypotheses: context.hypotheses
    };
}

function resultEvidence(context, identifiers, fingerprint, genreEvidence, mode) {
    const evidence = [];
    if (mode) evidence.push({ type: 'mode', label: 'Lookup mode', value: mode });
    for (const hypothesis of context.hypotheses.slice(0, 5)) {
        evidence.push({
            type: 'hypothesis',
            label: 'Local hypothesis',
            value: `${hypothesis.source}:${hypothesis.interpretation}`,
            reliability: hypothesis.reliability
        });
    }
    const identifierTypes = [...new Set(identifiers.map(identifier => identifier.type))];
    if (identifierTypes.length) evidence.push({ type: 'embedded_identifiers', label: 'Embedded identifier types', value: identifierTypes.join(', ') });
    if (fingerprint) evidence.push({ type: 'fingerprint', label: 'Fingerprint generation', value: fingerprint.status, detail: fingerprint.reason || fingerprint.source || '' });
    if (genreEvidence) evidence.push({ type: 'genre_hint', label: 'Low-confidence genre hint', value: genreEvidence.value, confidence: genreEvidence.confidence });
    return evidence;
}

async function searchPublicRegistry(title, artist = null, options = {}) {
    const context = buildContext({
        songname: title,
        artist: artist || '',
        album: options.album || '',
        duration_ms: options.durationMs || 0,
        metadata_source: options.metadataSource || 'manual'
    }, options.embeddedMetadata || {}, options);
    if (lookupMode(options, 'text_only') === 'local_only') {
        return finalizeCandidateRecords(localCandidateRecords(context), context).slice(0, 10).map(suggestionFromCandidate);
    }
    const providerResults = await runTextProviders(context.hypotheses, options);
    const aggregated = aggregateProviderResults(providerResults);
    const records = aggregated.candidates.length ? aggregated.candidates : localCandidateRecords(context);
    return finalizeCandidateRecords(records, context).slice(0, 10).map(suggestionFromCandidate);
}

async function enrichSong(song, options = {}) {
    if (!song) return null;
    const mode = lookupMode(options);
    const localEvidence = await loadStoredEvidence(song, options);
    const context = buildContext(song, localEvidence.embedded, options);
    let textResults = [];
    let identifierResults = [];
    let fingerprintRun = { fingerprint: null, result: null, validationResults: [] };

    if (mode === 'text_only') {
        [textResults, identifierResults] = await Promise.all([
            runTextProviders(context.hypotheses, options),
            runIdentifierProviders(localEvidence.identifiers, options)
        ]);
    } else if (mode === 'acoustic_with_text_fallback') {
        [identifierResults, fingerprintRun] = await Promise.all([
            runIdentifierProviders(localEvidence.identifiers, options),
            runFingerprintProvider(song, options)
        ]);
    }
    if (!context.durationMs && fingerprintRun.fingerprint && fingerprintRun.fingerprint.durationMs) {
        context.durationMs = fingerprintRun.fingerprint.durationMs;
    }

    const identityProviderResults = [
        ...identifierResults,
        fingerprintRun.result,
        ...fingerprintRun.validationResults
    ].filter(Boolean);
    if (mode === 'acoustic_with_text_fallback') {
        const identityAggregate = aggregateProviderResults(identityProviderResults);
        const identityCandidates = finalizeCandidateRecords(identityAggregate.candidates, context);
        if (!(identityCandidates[0] && identityCandidates[0].safeToApply) && !(options.signal && options.signal.aborted)) {
            textResults = await runTextProviders(context.hypotheses, options);
        }
    }

    const allProviderResults = [...identityProviderResults, ...textResults];
    const aggregated = aggregateProviderResults(allProviderResults);
    if (fingerprintRun.fingerprint && fingerprintRun.fingerprint.status !== 'ok') {
        aggregated.statuses.push({
            name: 'fingerprint',
            provider: 'fingerprint',
            status: fingerprintRun.fingerprint.status,
            detail: fingerprintRun.fingerprint.reason || '',
            cached: false,
            attempts: 0,
            candidateCount: 0
        });
    }

    const useLocalCandidates = mode === 'local_only' || aggregated.candidates.length === 0;
    const candidateRecords = useLocalCandidates ? localCandidateRecords(context) : aggregated.candidates;
    const candidates = finalizeCandidateRecords(candidateRecords, context).slice(0, 12);
    if (useLocalCandidates) {
        aggregated.statuses.push({
            name: 'local',
            provider: 'local',
            status: candidates.length ? 'matched' : 'no_match',
            detail: mode === 'local_only' ? 'local_only' : 'provider_fallback',
            cached: false,
            attempts: 0,
            candidateCount: candidates.length
        });
    }
    const parsed = parsedContract(context, song);
    const top = candidates[0] || null;
    let outcome;
    if (top && top.safeToApply) outcome = 'auto_matched';
    else if (top) outcome = 'needs_review';
    else if (options.signal && options.signal.aborted) outcome = 'cancelled';
    else if (providerFailureWithoutCandidates(aggregated.statuses)) outcome = 'provider_error';
    else outcome = 'no_match';
    const stage = outcome === 'no_match' ? 'unidentified' : outcome;

    return {
        original: originalMetadata(song, context),
        suggestions: candidates.map(suggestionFromCandidate),
        parsed,
        candidates,
        providers: aggregated.statuses,
        evidence: resultEvidence(context, localEvidence.identifiers, fingerprintRun.fingerprint, parsed.genreEvidence, mode),
        conflicts: top ? top.conflicts : [],
        ambiguousFields: top ? top.ambiguousFields : [],
        safeToApply: Boolean(top && top.safeToApply),
        outcome,
        stage,
        mode,
        pipelineVersion: PIPELINE_VERSION
    };
}

function classifyGenre(title, artist, album) {
    const evidence = Matching.classifyGenreEvidence(title, artist, album);
    return evidence ? evidence.value : null;
}

module.exports = {
    enrichSong,
    downloadFile,
    isTrustedCoverUrl,
    searchPublicRegistry,
    parseFilenameSituations: Matching.parseFilenameSituations,
    extractYearFromText: Matching.extractYearFromText,
    classifyGenre,
    classifyGenreEvidence: Matching.classifyGenreEvidence,
    parseVersionIdentity: Matching.parseVersionIdentity,
    generateHypotheses: Matching.generateHypotheses,
    scoreCandidate: Matching.scoreCandidate,
    generateFingerprint: Fingerprint.generateFingerprint,
    PIPELINE_VERSION,
    LOOKUP_MODES,
    _test: {
        ...Matching._test,
        providers: Providers._test,
        fingerprint: Fingerprint._test,
        normalizeIdentifierType,
        normalizeIdentifiers,
        embeddedMetadataFromProvenance,
        metadataDurationMs,
        buildContext,
        searchHypotheses,
        lookupMode,
        localCandidateRecords,
        finalizeCandidateRecords,
        aggregateProviderResults,
        suggestionFromCandidate,
        isTrustedCoverUrl
    }
};

'use strict';

const path = require('path');

const UNKNOWN_VALUES = new Set([
    '',
    'unknown',
    'unknown artist',
    'unknown album',
    'unknown genre',
    'unknown title',
    'unknown track',
    'n/a',
    'none',
    'null'
]);

const DASH_CLASS = '\\-\\u058A\\u05BE\\u1400\\u1806\\u2010-\\u2015\\u2E17\\u2E1A\\u2E3A-\\u2E3B\\u2E40\\u301C\\u3030\\u30A0\\uFE31-\\uFE32\\uFE58\\uFE63\\uFF0D';
const DASH_SEPARATOR = new RegExp(`\\s+[${DASH_CLASS}]\\s+|\\s*[\\u2012-\\u2015\\u2E3A-\\u2E3B\\uFE31-\\uFE32\\uFF0D]\\s*|\\s+\\|\\s+`, 'u');
const AUDIO_EXTENSION = /\.(?:aac|aiff?|alac|ape|flac|m4a|m4b|mp3|mp4|oga|ogg|opus|wav|wave|webm|wma)$/iu;
const GENERIC_FOLDERS = new Set(['album', 'albums', 'audio', 'downloads', 'music', 'musiclibrary', 'songs', 'tracks', 'unknown', 'uploads']);
const AUTO_THRESHOLD = 0.90;
const LEGACY_AUTO_THRESHOLD = 0.60;

const GENRE_RULES = [
    { value: 'Metal', phrases: ['black metal', 'death metal', 'heavy metal', 'nu metal', 'thrash metal', 'metalcore'] },
    { value: 'Hip-Hop / Rap', phrases: ['boom bap', 'chillhop', 'cypher', 'drill', 'freestyle', 'hip hop', 'hip-hop', 'rap', 'trap'] },
    { value: 'Electronic / EDM', phrases: ['ambient', 'chillwave', 'drum and bass', 'dnb', 'dubstep', 'edm', 'electro', 'electronic', 'house', 'synthwave', 'techno', 'trance'] },
    { value: 'R&B / Soul', phrases: ['motown', 'neo soul', 'neo-soul', 'r&b', 'rnb', 'soul'] },
    { value: 'Rock', phrases: ['alternative rock', 'grunge', 'hard rock', 'indie rock', 'psychedelic rock', 'punk rock', 'rock'] },
    { value: 'Pop', phrases: ['dance pop', 'j-pop', 'k-pop', 'pop', 'synthpop'] },
    { value: 'Jazz', phrases: ['bebop', 'big band', 'bossa nova', 'jazz', 'smooth jazz', 'swing'] },
    { value: 'Classical', phrases: ['baroque', 'classical', 'concerto', 'orchestra', 'sonata', 'symphony'] },
    { value: 'Soundtrack / Film', phrases: ['film score', 'original motion picture', 'ost', 'soundtrack'] },
    { value: 'Reggae', phrases: ['dancehall', 'reggae', 'roots reggae', 'ska'] },
    { value: 'Country / Folk', phrases: ['americana', 'bluegrass', 'country music', 'folk music'] },
    { value: 'Lo-Fi / Chill', phrases: ['lo fi', 'lo-fi', 'lofi', 'study beats'] }
];

function cleanDisplayText(value) {
    const normalized = String(value === null || value === undefined ? '' : value)
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return Array.from(normalized).slice(0, 1000).join('');
}

function normalizeForMatch(value) {
    return cleanDisplayText(value)
        .toLowerCase()
        .replace(new RegExp(`[${DASH_CLASS}]`, 'gu'), ' ')
        .replace(/&/gu, ' and ')
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function isUnknownValue(value) {
    return UNKNOWN_VALUES.has(normalizeForMatch(value));
}

function codePoints(value) {
    return Array.from(String(value || ''));
}

function levenshteinDistance(left, right) {
    const a = codePoints(left);
    const b = codePoints(right);
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (a.length > b.length) return levenshteinDistance(right, left);

    let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
    for (let row = 1; row <= b.length; row++) {
        const current = [row];
        for (let column = 1; column <= a.length; column++) {
            const substitution = previous[column - 1] + (a[column - 1] === b[row - 1] ? 0 : 1);
            current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
        }
        previous = current;
    }
    return previous[a.length];
}

function tokenMultiset(value) {
    const counts = new Map();
    for (const token of normalizeForMatch(value).split(' ').filter(Boolean)) {
        counts.set(token, (counts.get(token) || 0) + 1);
    }
    return counts;
}

function tokenDice(left, right) {
    const a = tokenMultiset(left);
    const b = tokenMultiset(right);
    const sizeA = Array.from(a.values()).reduce((sum, count) => sum + count, 0);
    const sizeB = Array.from(b.values()).reduce((sum, count) => sum + count, 0);
    if (sizeA === 0 && sizeB === 0) return 1;
    if (sizeA === 0 || sizeB === 0) return 0;
    let intersection = 0;
    for (const [token, count] of a) intersection += Math.min(count, b.get(token) || 0);
    return (2 * intersection) / (sizeA + sizeB);
}

function ngrams(value, size) {
    const chars = codePoints(normalizeForMatch(value).replace(/\s+/gu, ' '));
    if (chars.length === 0) return [];
    if (chars.length <= size) return [chars.join('')];
    const result = [];
    for (let index = 0; index <= chars.length - size; index++) {
        result.push(chars.slice(index, index + size).join(''));
    }
    return result;
}

function valueMultiset(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
}

function ngramDice(left, right) {
    const normalizedLeft = normalizeForMatch(left);
    const normalizedRight = normalizeForMatch(right);
    const size = Math.min(codePoints(normalizedLeft).length, codePoints(normalizedRight).length) < 6 ? 2 : 3;
    const a = valueMultiset(ngrams(normalizedLeft, size));
    const b = valueMultiset(ngrams(normalizedRight, size));
    let sizeA = 0;
    let sizeB = 0;
    let intersection = 0;
    for (const count of a.values()) sizeA += count;
    for (const count of b.values()) sizeB += count;
    for (const [gram, count] of a) intersection += Math.min(count, b.get(gram) || 0);
    if (sizeA === 0 && sizeB === 0) return 1;
    if (sizeA === 0 || sizeB === 0) return 0;
    return (2 * intersection) / (sizeA + sizeB);
}

function textSignals(left, right) {
    const a = normalizeForMatch(left);
    const b = normalizeForMatch(right);
    if (!a && !b) return { exact: 1, edit: 1, tokens: 1, ngrams: 1, score: 1 };
    if (!a || !b) return { exact: 0, edit: 0, tokens: 0, ngrams: 0, score: 0 };
    if (a === b) return { exact: 1, edit: 1, tokens: 1, ngrams: 1, score: 1 };

    const maximumLength = Math.max(codePoints(a).length, codePoints(b).length);
    const edit = maximumLength ? 1 - (levenshteinDistance(a, b) / maximumLength) : 1;
    const tokens = tokenDice(a, b);
    const characterNgrams = ngramDice(a, b);
    const score = Math.max(0, Math.min(1, (edit * 0.35) + (tokens * 0.35) + (characterNgrams * 0.30)));
    return {
        exact: 0,
        edit: roundScore(edit),
        tokens: roundScore(tokens),
        ngrams: roundScore(characterNgrams),
        score: roundScore(score)
    };
}

function textSimilarity(left, right) {
    return textSignals(left, right).score;
}

function roundScore(value) {
    return Number(Math.max(0, Math.min(1, Number(value) || 0)).toFixed(4));
}

function uniqueStrings(values) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
        const clean = cleanDisplayText(value && typeof value === 'object' ? (value.name || value.artist || value.value) : value);
        const key = normalizeForMatch(clean);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(clean);
    }
    return result;
}

function extractFeaturedArtists(text) {
    const input = cleanDisplayText(text);
    const featured = [];
    const expression = /(?:^|[\s([])(?:feat(?:uring)?|ft)\.?\s+([^()[\]{}|;]+)/giu;
    let match;
    while ((match = expression.exec(input)) !== null) {
        featured.push(...match[1].split(/\s*(?:,|&|\band\b|\bx\b)\s*/iu));
    }
    return uniqueStrings(featured);
}

function removeFeaturedClause(text) {
    return cleanDisplayText(text)
        .replace(/\s*[([]?\s*(?:feat(?:uring)?|ft)\.?\s+[^()[\]{}|;]+[\])]?\s*/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function artistCreditFromValues(artist, artists, title) {
    const explicitArtists = uniqueStrings(artists);
    const fullArtist = isUnknownValue(artist) ? '' : cleanDisplayText(artist);
    const featured = uniqueStrings([
        ...extractFeaturedArtists(title),
        ...extractFeaturedArtists(fullArtist)
    ]);
    const withoutFeature = removeFeaturedClause(fullArtist);
    const primaryArtists = explicitArtists.length > 0
        ? explicitArtists.filter(value => !featured.some(feature => normalizeForMatch(feature) === normalizeForMatch(value)))
        : (withoutFeature ? [withoutFeature] : []);
    return {
        fullArtist: fullArtist || explicitArtists.join(', '),
        primaryArtists: primaryArtists.length > 0 ? primaryArtists : explicitArtists.slice(0, 1),
        allArtists: explicitArtists.length > 0 ? explicitArtists : uniqueStrings([withoutFeature, ...featured]),
        featuredArtists: featured
    };
}

function broadVersionMarker(segment) {
    const value = normalizeForMatch(segment);
    if (!value) return false;
    return /(?:^|\s)live(?:$|\s+(?:version|at|in|from)\b)/iu.test(value) ||
        /\b(?:remix(?:ed)?|mix|edit(?:ed)?(?: version)?)$/iu.test(value) ||
        /\b(?:radio edit|acoustic(?: version)?|instrumental(?: version)?|demo(?: version)?)$/iu.test(value) ||
        /\b(?:(?:19\d{2}|20\d{2})\s+remaster(?:ed)?|remaster(?:ed)?(?:\s+in)?(?:\s+(?:19\d{2}|20\d{2}))?)(?:\s+version)?$/iu.test(value) ||
        /\b(?:(?:sped|speed)\s+up(?:\s+(?:and\s+)?reverb)?|slowed(?:\s+down|\s+(?:and\s+)?reverb|\s+version)?)$/iu.test(value);
}

function contextualVersionMarker(text) {
    const value = normalizeForMatch(text);
    if (!value || /^(?:the\s+)?(?:remix|mix|edit|edited|demo|acoustic|instrumental|live)$/iu.test(value)) return false;
    return broadVersionMarker(value);
}

function versionSegments(text) {
    const input = cleanDisplayText(text);
    const contextual = [];
    const bracketExpression = /[([{]([^\])}]+)[\])}]/gu;
    let match;
    while ((match = bracketExpression.exec(input)) !== null) {
        if (broadVersionMarker(match[1])) contextual.push(match[1]);
    }
    const dashParts = input.split(DASH_SEPARATOR);
    if (dashParts.length > 1 && broadVersionMarker(dashParts[dashParts.length - 1])) {
        contextual.push(dashParts[dashParts.length - 1]);
    }
    if (contextual.length === 0 && contextualVersionMarker(input)) contextual.push(input);
    return uniqueStrings(contextual);
}

function segmentHasVersionMarker(segment) {
    return broadVersionMarker(segment);
}

function parseVersionIdentity(text) {
    const input = cleanDisplayText(text);
    const relevant = versionSegments(input).filter(segmentHasVersionMarker);
    const searchable = normalizeForMatch(relevant.join(' | '));
    const remixDetails = [];
    const mixDetails = [];
    for (const segment of relevant) {
        const detailEligible = segment !== input;
        const remixMatch = /\b(.{0,48}?)\s*remix(?:ed)?\b/iu.exec(segment);
        if (detailEligible && remixMatch) {
            const detail = cleanVersionDetail(remixMatch[1]);
            if (detail) remixDetails.push(detail);
        }
        const mixMatch = /\b(.{0,48}?)\s+mix\b/iu.exec(segment);
        if (detailEligible && mixMatch && !/remix/iu.test(mixMatch[0])) {
            const detail = cleanVersionDetail(mixMatch[1]);
            if (detail) mixDetails.push(detail);
        }
    }

    const remasterMatch = /\b(?:(19\d{2}|20\d{2})\s+remaster(?:ed)?|remaster(?:ed)?(?:\s+in)?\s+(19\d{2}|20\d{2}))\b/iu.exec(searchable);
    const radioEdit = /\bradio\s+edit\b/iu.test(searchable);
    const speed = /\b(?:sped|speed)\s+up(?:\s+(?:and\s+)?reverb)?\b/iu.test(searchable)
        ? 'sped_up'
        : (/\bslowed(?:\s+down|\s+(?:and\s+)?reverb|\s+version)?\b/iu.test(searchable) ? 'slowed' : null);
    const identity = {
        live: /\blive(?:\s+(?:version|at|in|from)\b|\b)/iu.test(searchable),
        remix: /\bremix(?:ed)?\b/iu.test(searchable),
        mix: /\bmix\b/iu.test(searchable.replace(/\bremix(?:ed)?\b/giu, '')),
        edit: radioEdit || /\bedit(?:ed)?\b/iu.test(searchable),
        radioEdit,
        acoustic: /\bacoustic(?:\s+version)?\b/iu.test(searchable),
        instrumental: /\binstrumental\b/iu.test(searchable),
        demo: /\bdemo\b/iu.test(searchable),
        remaster: /\bremaster(?:ed)?\b/iu.test(searchable),
        remasterYear: remasterMatch ? Number(remasterMatch[1] || remasterMatch[2]) : null,
        speed,
        remixDetails: uniqueStrings(remixDetails),
        mixDetails: uniqueStrings(mixDetails)
    };
    identity.explicit = Boolean(
        identity.live || identity.remix || identity.mix || identity.edit || identity.acoustic ||
        identity.instrumental || identity.demo || identity.remaster || identity.speed
    );
    identity.markers = versionMarkerLabels(identity);
    identity.coreTitle = stripVersionMarkers(input);
    return identity;
}

function cleanVersionDetail(value) {
    const cleaned = cleanDisplayText(value)
        .replace(/^[([{\s\-–—]+|[\])}\s\-–—]+$/gu, '')
        .replace(/\b(?:official|original|version)\b/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return cleaned.length > 1 && cleaned.split(' ').length <= 6 ? cleaned : '';
}

function versionMarkerLabels(identity) {
    const labels = [];
    if (identity.live) labels.push('live');
    if (identity.remix) labels.push('remix');
    if (identity.mix) labels.push('mix');
    if (identity.radioEdit) labels.push('radio_edit');
    else if (identity.edit) labels.push('edit');
    if (identity.acoustic) labels.push('acoustic');
    if (identity.instrumental) labels.push('instrumental');
    if (identity.demo) labels.push('demo');
    if (identity.remaster) labels.push(identity.remasterYear ? `remaster_${identity.remasterYear}` : 'remaster');
    if (identity.speed) labels.push(identity.speed);
    return labels;
}

function stripVersionMarkers(text) {
    let value = cleanDisplayText(text);
    value = value.replace(/[([{]([^\])}]+)[\])}]/gu, (full, inner) => segmentHasVersionMarker(inner) ? ' ' : full);
    const parts = value.split(DASH_SEPARATOR);
    while (parts.length > 1 && segmentHasVersionMarker(parts[parts.length - 1])) parts.pop();
    value = parts.join(' - ')
        .replace(/\s+\b(?:acoustic version|demo version|instrumental version|live version|radio edit|edit(?:ed)?(?: version)?|remaster(?:ed)?(?:\s+in)?\s*(?:19\d{2}|20\d{2})?|sped[ -]?up(?:\s+(?:&|and|\+)\s*reverb)?|speed up(?:\s+(?:&|and|\+)\s*reverb)?|slowed(?: down| version)?|slowed\s*(?:&|and|\+)\s*reverb)\b\s*$/giu, '')
        .replace(/\s+/gu, ' ')
        .replace(/^[\s\-–—|]+|[\s\-–—|]+$/gu, '')
        .trim();
    return value || cleanDisplayText(text);
}

function compareVersionIdentity(expected, actual) {
    const source = expected && expected.coreTitle !== undefined ? expected : parseVersionIdentity(expected);
    const candidate = actual && actual.coreTitle !== undefined ? actual : parseVersionIdentity(actual);
    const conflicts = [];
    const markerKeys = ['live', 'remix', 'mix', 'edit', 'acoustic', 'instrumental', 'demo', 'remaster'];
    for (const key of markerKeys) {
        if (Boolean(source[key]) !== Boolean(candidate[key])) {
            conflicts.push({
                type: 'version',
                field: 'version',
                marker: key,
                expected: Boolean(source[key]),
                candidate: Boolean(candidate[key]),
                message: `Version marker differs: ${key}`
            });
        }
    }
    if (source.radioEdit !== candidate.radioEdit && (source.edit || candidate.edit)) {
        conflicts.push({
            type: 'version', field: 'version', marker: 'radio_edit',
            expected: source.radioEdit, candidate: candidate.radioEdit,
            message: 'Radio edit identity differs'
        });
    }
    if (source.speed !== candidate.speed) {
        if (source.speed || candidate.speed) {
            conflicts.push({
                type: 'version', field: 'version', marker: 'speed',
                expected: source.speed, candidate: candidate.speed,
                message: 'Playback-speed version differs'
            });
        }
    }
    if (source.remaster && candidate.remaster && source.remasterYear && candidate.remasterYear && source.remasterYear !== candidate.remasterYear) {
        conflicts.push({
            type: 'version', field: 'version', marker: 'remaster_year',
            expected: source.remasterYear, candidate: candidate.remasterYear,
            message: 'Remaster year differs'
        });
    }
    if (source.remix && candidate.remix && source.remixDetails.length && candidate.remixDetails.length) {
        const detailScore = Math.max(...source.remixDetails.flatMap(left => candidate.remixDetails.map(right => textSimilarity(left, right))));
        if (detailScore < 0.55) {
            conflicts.push({
                type: 'version', field: 'version', marker: 'remix_credit',
                expected: source.remixDetails, candidate: candidate.remixDetails,
                message: 'Remix identity differs'
            });
        }
    }
    if (source.mix && candidate.mix && source.mixDetails.length && candidate.mixDetails.length) {
        const detailScore = Math.max(...source.mixDetails.flatMap(left => candidate.mixDetails.map(right => textSimilarity(left, right))));
        if (detailScore < 0.55) {
            conflicts.push({
                type: 'version', field: 'version', marker: 'mix_credit',
                expected: source.mixDetails, candidate: candidate.mixDetails,
                message: 'Mix identity differs'
            });
        }
    }
    const uniqueConflicts = dedupeConflicts(conflicts);
    return {
        score: uniqueConflicts.length ? 0 : (source.explicit || candidate.explicit ? 1 : 0.95),
        compatible: uniqueConflicts.length === 0,
        conflicts: uniqueConflicts,
        expected: source,
        candidate
    };
}

function removeTrackPrefix(value) {
    let result = cleanDisplayText(value)
        .replace(/^\d{10,15}[-_\s]+/u, '')
        .replace(/^\s*(?:cd|disc)\s*\d{1,2}\s*[-_.]\s*/iu, '')
        .replace(/^\s*\d{1,2}[-.]\d{1,3}\s+/u, '')
        .replace(/^\s*0\d{1,2}\s+(?=[\p{L}\p{M}\p{N}])/u, '')
        .replace(/^\s*0\d{1,2}[-_]\s*(?=[\p{L}\p{M}\p{N}])/u, '');
    const prefix = /^\s*(\d{1,3})(\s*[.-]\s+|_\s*|[.)]\s+)(.+)$/u.exec(result);
    if (prefix) {
        const number = Number(prefix[1]);
        const zeroPadded = prefix[1].length > 1 && prefix[1].startsWith('0');
        const punctuationPrefix = /[.)]/u.test(prefix[2]);
        const remainderHasCreditSeparator = DASH_SEPARATOR.test(prefix[3]);
        if (zeroPadded || punctuationPrefix || number <= 30 || remainderHasCreditSeparator) result = prefix[3];
    }
    return result.trim();
}

function removeFilenameJunk(value) {
    let result = cleanDisplayText(value);
    result = result.replace(/[([{]([^\])}]+)[\])}]/gu, (full, inner) => {
        return /\b(?:official\s+(?:music\s+)?(?:audio|video)|lyrics?|visuali[sz]er|hd|4k|1080p|720p|320\s*kbps|download|full\s+song)\b/iu.test(inner)
            ? ' '
            : full;
    });
    result = result.replace(/\b(?:official\s+(?:music\s+)?(?:audio|video)|lyric\s+video|visuali[sz]er|320\s*kbps)\b/giu, ' ');
    return result.replace(/\s+/gu, ' ').trim();
}

function parseFilenameSituations(filename) {
    if (!filename) {
        return {
            artistHint: null,
            titleHint: '',
            featuredArtists: [],
            detectedYear: null,
            version: parseVersionIdentity(''),
            interpretations: []
        };
    }
    const baseName = path.basename(cleanDisplayText(filename)).replace(AUDIO_EXTENSION, '');
    const cleaned = removeFilenameJunk(removeTrackPrefix(baseName));
    const detectedYear = extractYearFromText(cleaned);
    const interpretations = [];
    const add = (title, artist, kind, cautious = false) => {
        const cleanTitle = cleanEdge(title);
        const cleanArtist = cleanEdge(artist);
        if (!cleanTitle) return;
        const key = `${normalizeForMatch(cleanTitle)}\u0000${normalizeForMatch(cleanArtist)}\u0000${kind}`;
        if (interpretations.some(item => item.key === key)) return;
        interpretations.push({ key, title: cleanTitle, artist: cleanArtist || null, kind, cautious });
    };

    const byMatch = /^(.*?)\s+by\s+(.+)$/iu.exec(cleaned);
    if (byMatch) add(byMatch[1], byMatch[2], 'title_by_artist');

    const parts = cleaned.split(DASH_SEPARATOR).map(cleanEdge).filter(Boolean);
    if (parts.length >= 2) {
        if (parts.length >= 3 && /^\d{1,3}$/u.test(parts[1])) {
            add(parts.slice(2).join(' - '), parts[0], 'artist_track_title');
        }
        add(parts.slice(1).join(' - '), parts[0], 'artist_title');
        if (parts.length >= 3) add(parts[parts.length - 1], parts[0], 'artist_album_title', true);
        add(parts.slice(0, -1).join(' - '), parts[parts.length - 1], 'title_artist_reverse', true);
    }

    if (parts.length === 1 && cleaned.includes('_') && !/\s/u.test(cleaned)) {
        const underscoreParts = cleaned.split(/_+/u).map(cleanEdge).filter(Boolean);
        if (underscoreParts.length >= 2) {
            const numericOrRepeatedArtist = underscoreParts.length >= 3 && (
                /^\d+$/u.test(underscoreParts[0]) ||
                normalizeForMatch(underscoreParts[0]) === normalizeForMatch(underscoreParts[1])
            );
            if (numericOrRepeatedArtist) {
                add(underscoreParts.slice(2).join(' '), underscoreParts.slice(0, 2).join(' '), 'artist_title_underscore');
            }
            add(underscoreParts.slice(1).join(' '), underscoreParts[0], 'artist_title_underscore');
            for (let splitAt = 2; splitAt < Math.min(underscoreParts.length, 4); splitAt++) {
                add(underscoreParts.slice(splitAt).join(' '), underscoreParts.slice(0, splitAt).join(' '), 'artist_title_underscore_alternate', true);
            }
            add(underscoreParts.slice(0, -1).join(' '), underscoreParts[underscoreParts.length - 1], 'title_artist_reverse', true);
        }
    }
    add(cleaned, null, 'title_only', true);

    const preferred = interpretations.find(item => !item.cautious && item.artist) || interpretations[0];
    const titleHint = preferred ? removeFeaturedClause(preferred.title) : cleaned;
    const featuredArtists = uniqueStrings([
        ...extractFeaturedArtists(preferred && preferred.title),
        ...extractFeaturedArtists(preferred && preferred.artist)
    ]);
    return {
        artistHint: preferred && preferred.artist ? removeFeaturedClause(preferred.artist) : null,
        titleHint,
        featuredArtists,
        detectedYear,
        version: parseVersionIdentity(preferred ? preferred.title : cleaned),
        interpretations: interpretations.map(({ key, ...item }) => item)
    };
}

function cleanEdge(value) {
    return cleanDisplayText(value)
        .replace(/^[\s._\-–—|]+|[\s._\-–—|]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function extractYearFromText(value) {
    if (!value) return null;
    const match = /(?:[([{]\s*(19\d{2}|20\d{2})\s*[\])}]|\b(?:released|from|in)\s+(19\d{2}|20\d{2})\b)/iu.exec(String(value));
    return match ? Number(match[1] || match[2]) : null;
}

function meaningfulFilename(value) {
    const normalized = normalizeForMatch(value);
    if (!normalized || GENERIC_FOLDERS.has(normalized)) return false;
    if (/^(?:[a-f\d]{20,}|\d{10,})$/iu.test(normalized.replace(/\s/gu, ''))) return false;
    return /[\p{L}\p{M}]/u.test(normalized) || normalized.split(' ').length > 1;
}

function generateHypotheses(input = {}) {
    const embedded = input.embeddedMetadata || {};
    const hypotheses = [];
    const add = (values) => {
        const title = cleanEdge(values.title);
        const artist = isUnknownValue(values.artist) ? '' : cleanEdge(values.artist);
        if (!title || isUnknownValue(title)) return;
        const credit = artistCreditFromValues(artist, values.artists, title);
        const version = parseVersionIdentity(title);
        const item = {
            id: `hypothesis-${hypotheses.length + 1}`,
            title,
            coreTitle: removeFeaturedClause(version.coreTitle),
            artist: credit.fullArtist,
            primaryArtists: credit.primaryArtists,
            allArtists: credit.allArtists,
            featuredArtists: uniqueStrings([...(values.featuredArtists || []), ...credit.featuredArtists]),
            album: isUnknownValue(values.album) ? '' : cleanDisplayText(values.album),
            source: values.source || 'unknown',
            interpretation: values.interpretation || 'direct',
            reliability: roundScore(values.reliability === undefined ? 0.7 : values.reliability),
            filenameOnly: values.filenameOnly === true,
            titleOnly: !credit.fullArtist,
            titleOnlyEvidence: values.titleOnlyEvidence === true,
            cautious: values.cautious === true,
            version
        };
        const key = [normalizeForMatch(item.title), normalizeForMatch(item.artist), item.source, item.interpretation].join('\u0000');
        if (hypotheses.some(existing => existing._key === key)) return;
        item._key = key;
        hypotheses.push(item);
    };

    if (embedded.title && !isUnknownValue(embedded.title)) {
        add({
            title: embedded.title,
            artist: embedded.artist,
            artists: embedded.artists,
            album: embedded.album,
            source: 'embedded',
            interpretation: 'embedded_tags',
            reliability: embedded.artist || (embedded.artists && embedded.artists.length) ? 1 : 0.88
        });
        const parsedEmbedded = parseFilenameSituations(embedded.title);
        for (const interpretation of parsedEmbedded.interpretations) {
            if (!interpretation.artist) continue;
            add({
                title: interpretation.title,
                artist: interpretation.artist,
                album: embedded.album,
                source: 'embedded',
                interpretation: interpretation.kind,
                reliability: interpretation.cautious ? 0.58 : 0.90,
                titleOnlyEvidence: !embedded.artist && !(embedded.artists && embedded.artists.length),
                cautious: interpretation.cautious
            });
        }
    }

    if (input.title && !isUnknownValue(input.title)) {
        add({
            title: input.title,
            artist: input.artist,
            artists: input.artists,
            album: input.album,
            source: input.metadataSource === 'filename' ? 'filename' : 'current_metadata',
            interpretation: 'direct',
            reliability: input.metadataSource === 'filename' ? 0.68 : 0.93,
            filenameOnly: input.metadataSource === 'filename'
        });
        const parsedTitle = parseFilenameSituations(input.title);
        for (const interpretation of parsedTitle.interpretations) {
            if (!interpretation.artist) continue;
            add({
                title: interpretation.title,
                artist: interpretation.artist,
                album: input.album,
                source: 'current_metadata',
                interpretation: interpretation.kind,
                reliability: interpretation.cautious ? 0.53 : 0.82,
                titleOnlyEvidence: isUnknownValue(input.artist) && !(input.artists && input.artists.length),
                cautious: interpretation.cautious
            });
        }
    }

    const rawFilename = input.filename ? path.basename(cleanDisplayText(input.filename)).replace(AUDIO_EXTENSION, '') : '';
    if (meaningfulFilename(rawFilename)) {
        const parsed = parseFilenameSituations(rawFilename);
        for (const interpretation of parsed.interpretations) {
            add({
                title: interpretation.title,
                artist: interpretation.artist,
                album: input.album,
                source: 'filename',
                interpretation: interpretation.kind,
                reliability: interpretation.artist ? (interpretation.cautious ? 0.48 : 0.76) : 0.52,
                filenameOnly: true,
                cautious: interpretation.cautious
            });
        }
    }

    const parentFolder = cleanEdge(input.parentFolder);
    if (meaningfulFilename(parentFolder) && !GENERIC_FOLDERS.has(normalizeForMatch(parentFolder))) {
        const filenameTitle = rawFilename && meaningfulFilename(rawFilename)
            ? parseFilenameSituations(rawFilename).titleHint
            : cleanDisplayText(input.title);
        add({
            title: filenameTitle,
            artist: parentFolder,
            album: input.album,
            source: 'parent_folder',
            interpretation: 'folder_as_artist',
            reliability: 0.55,
            filenameOnly: true,
            cautious: true
        });
        add({
            title: filenameTitle,
            artist: input.artist,
            album: parentFolder,
            source: 'parent_folder',
            interpretation: 'folder_as_album',
            reliability: input.artist && !isUnknownValue(input.artist) ? 0.65 : 0.48,
            filenameOnly: true,
            cautious: true
        });
        const parentParts = parentFolder.split(DASH_SEPARATOR).map(cleanEdge).filter(Boolean);
        if (parentParts.length >= 2) {
            add({
                title: filenameTitle,
                artist: parentParts[0],
                album: parentParts.slice(1).join(' - '),
                source: 'parent_folder',
                interpretation: 'artist_album_folder',
                reliability: 0.62,
                filenameOnly: true,
                cautious: true
            });
        }
    }

    if (hypotheses.length === 0 && rawFilename) {
        add({ title: removeTrackPrefix(rawFilename), source: 'filename', interpretation: 'title_only', reliability: 0.45, filenameOnly: true, cautious: true });
    }

    return hypotheses
        .map(({ _key, ...hypothesis }) => hypothesis)
        .sort((left, right) => right.reliability - left.reliability)
        .slice(0, 18);
}

function classifyGenreEvidence(...values) {
    const normalizedText = ` ${normalizeForMatch(values.flat().filter(Boolean).join(' '))} `;
    if (normalizedText.trim() === '') return null;
    const matches = [];
    for (const rule of GENRE_RULES) {
        for (const phrase of rule.phrases) {
            const normalizedPhrase = normalizeForMatch(phrase);
            if (normalizedPhrase && normalizedText.includes(` ${normalizedPhrase} `)) {
                matches.push({ genre: rule.value, phrase });
            }
        }
    }
    if (matches.length === 0) return null;
    const counts = new Map();
    for (const match of matches) counts.set(match.genre, (counts.get(match.genre) || 0) + 1);
    const [value, count] = Array.from(counts).sort((left, right) => right[1] - left[1])[0];
    return {
        value,
        confidence: count > 1 ? 0.28 : 0.20,
        source: 'text_rule',
        matches: matches.filter(match => match.genre === value).map(match => match.phrase)
    };
}

function artistSetSimilarity(left, right) {
    const a = uniqueStrings(left);
    const b = uniqueStrings(right);
    if (a.length === 0 && b.length === 0) return null;
    if (a.length === 0 || b.length === 0) return 0;
    const leftScores = a.map(name => Math.max(...b.map(candidate => textSimilarity(name, candidate))));
    const rightScores = b.map(name => Math.max(...a.map(candidate => textSimilarity(name, candidate))));
    return roundScore((
        leftScores.reduce((sum, score) => sum + score, 0) +
        rightScores.reduce((sum, score) => sum + score, 0)
    ) / (leftScores.length + rightScores.length));
}

function candidateArtistData(candidate) {
    const credits = Array.isArray(candidate.artistCredits) ? candidate.artistCredits : [];
    const names = uniqueStrings(credits.map(credit => credit && (credit.name || (credit.artist && credit.artist.name))));
    const featured = uniqueStrings([
        ...(candidate.featuredArtists || []),
        ...extractFeaturedArtists(candidate.title),
        ...extractFeaturedArtists(candidate.artist)
    ]);
    const primary = uniqueStrings(candidate.primaryArtists || names.filter(name => !featured.some(feature => normalizeForMatch(feature) === normalizeForMatch(name))));
    return {
        fullArtist: cleanDisplayText(candidate.artist || names.join('')),
        allArtists: names.length ? names : uniqueStrings([removeFeaturedClause(candidate.artist), ...featured]),
        primaryArtists: primary.length ? primary : uniqueStrings([removeFeaturedClause(candidate.artist)]),
        featuredArtists: featured
    };
}

function durationSignal(expectedMs, actualMs) {
    const expected = Number(expectedMs);
    const actual = Number(actualMs);
    if (!(expected > 0) || !(actual > 0)) {
        return { available: false, score: null, deltaMs: null, relativeDelta: null, compatible: false };
    }
    const deltaMs = Math.abs(expected - actual);
    const relativeDelta = deltaMs / Math.max(expected, actual);
    let score;
    if (deltaMs <= 2000) score = 1;
    else if (deltaMs <= 5000) score = 0.92;
    else if (relativeDelta <= 0.03) score = 0.82;
    else if (deltaMs <= 10000 || relativeDelta <= 0.05) score = 0.62;
    else if (deltaMs <= 20000 || relativeDelta <= 0.10) score = 0.25;
    else score = 0;
    return {
        available: true,
        score,
        deltaMs,
        relativeDelta: roundScore(relativeDelta),
        compatible: deltaMs <= Math.max(8000, expected * 0.035)
    };
}

const SIGNAL_WEIGHTS = Object.freeze({
    title: 0.34,
    primaryArtist: 0.13,
    fullArtistCredit: 0.11,
    featuredArtists: 0.06,
    duration: 0.12,
    albumContext: 0.05,
    version: 0.10,
    providerNative: 0.05,
    crossProviderAgreement: 0.04
});

function createBreakdown(score, weight, available, details) {
    return {
        score: available ? roundScore(score) : null,
        weight,
        contribution: 0,
        available: Boolean(available),
        ...(details || {})
    };
}

function scoreAgainstHypothesis(candidate, hypothesis, context, crossProviderAgreement) {
    const candidateVersion = candidate.version || parseVersionIdentity(candidate.title);
    const version = compareVersionIdentity(hypothesis.version, candidateVersion);
    const candidateArtists = candidateArtistData(candidate);
    const titleDetails = textSignals(
        hypothesis.coreTitle || removeFeaturedClause(hypothesis.title),
        removeFeaturedClause(candidateVersion.coreTitle || candidate.title)
    );
    const primaryArtist = artistSetSimilarity(hypothesis.primaryArtists, candidateArtists.primaryArtists);
    const fullArtistCredit = hypothesis.artist && candidateArtists.fullArtist
        ? Math.max(
            textSimilarity(hypothesis.artist, candidateArtists.fullArtist),
            artistSetSimilarity(hypothesis.allArtists, candidateArtists.allArtists) || 0
        )
        : null;
    const featuredArtists = (hypothesis.featuredArtists.length || candidateArtists.featuredArtists.length)
        ? artistSetSimilarity(hypothesis.featuredArtists, candidateArtists.featuredArtists)
        : null;
    const duration = durationSignal(context.durationMs, candidate.durationMs);
    const releaseAlbums = (candidate.releaseCandidates || []).map(release => release.album || release.title).filter(Boolean);
    const albumContext = hypothesis.album
        ? Math.max(0, ...uniqueStrings([candidate.album, ...releaseAlbums]).map(album => textSimilarity(hypothesis.album, album)))
        : null;
    const providerNative = Number.isFinite(candidate.providerNativeScore)
        ? Math.max(0, Math.min(1, candidate.providerNativeScore))
        : null;
    const agreement = Number.isFinite(crossProviderAgreement) ? crossProviderAgreement : null;

    const breakdown = {
        title: createBreakdown(titleDetails.score, SIGNAL_WEIGHTS.title, true, { signals: titleDetails }),
        primaryArtist: createBreakdown(primaryArtist, SIGNAL_WEIGHTS.primaryArtist, primaryArtist !== null),
        fullArtistCredit: createBreakdown(fullArtistCredit, SIGNAL_WEIGHTS.fullArtistCredit, fullArtistCredit !== null),
        featuredArtists: createBreakdown(featuredArtists, SIGNAL_WEIGHTS.featuredArtists, featuredArtists !== null),
        duration: createBreakdown(duration.score, SIGNAL_WEIGHTS.duration, duration.available, {
            deltaMs: duration.deltaMs,
            relativeDelta: duration.relativeDelta,
            compatible: duration.compatible
        }),
        albumContext: createBreakdown(albumContext, SIGNAL_WEIGHTS.albumContext, albumContext !== null),
        version: createBreakdown(version.score, SIGNAL_WEIGHTS.version, true, {
            expected: version.expected.markers,
            candidate: version.candidate.markers,
            compatible: version.compatible
        }),
        providerNative: createBreakdown(providerNative, SIGNAL_WEIGHTS.providerNative, providerNative !== null),
        crossProviderAgreement: createBreakdown(agreement, SIGNAL_WEIGHTS.crossProviderAgreement, agreement !== null)
    };
    const availableWeight = Object.values(breakdown)
        .filter(signal => signal.available)
        .reduce((sum, signal) => sum + signal.weight, 0);
    let weightedScore = 0;
    for (const signal of Object.values(breakdown)) {
        if (!signal.available || availableWeight === 0) continue;
        signal.contribution = roundScore((signal.score * signal.weight) / availableWeight);
        weightedScore += signal.contribution;
    }
    const reliabilityFactor = 0.75 + (hypothesis.reliability * 0.25);
    const rawScore = roundScore(weightedScore * reliabilityFactor);
    const conflicts = [...version.conflicts];
    if (duration.available && !duration.compatible) {
        conflicts.push({
            type: 'duration', field: 'duration', expected: Number(context.durationMs), candidate: Number(candidate.durationMs),
            message: 'Recording duration is incompatible'
        });
    }
    if (primaryArtist !== null && fullArtistCredit !== null && Math.max(primaryArtist, fullArtistCredit) < 0.28) {
        conflicts.push({ type: 'artist', field: 'artist', message: 'Artist credit strongly disagrees with local metadata' });
    }
    if (featuredArtists !== null && featuredArtists < 0.35) {
        conflicts.push({ type: 'featured_artists', field: 'artist', message: 'Featured artist credit differs' });
    }
    return { rawScore, breakdown, conflicts: dedupeConflicts(conflicts), duration, version, candidateArtists };
}

function policyAdjustedScore(rawScore, candidate, hypothesis, conflicts) {
    const caps = [];
    let score = rawScore;
    const basis = candidate.matchBasis || 'text';
    if (basis === 'text') {
        const cap = hypothesis.titleOnly || hypothesis.titleOnlyEvidence ? 0.44 : (hypothesis.filenameOnly ? 0.52 : 0.59);
        score *= cap;
        caps.push({ reason: hypothesis.titleOnly || hypothesis.titleOnlyEvidence ? 'title_only' : (hypothesis.filenameOnly ? 'filename_only' : 'text_only'), maximum: cap });
    } else if (basis === 'local' || basis === 'filename') {
        const cap = basis === 'filename' ? 0.52 : 0.59;
        score *= cap;
        caps.push({ reason: basis === 'filename' ? 'filename_only' : 'local_only', maximum: cap });
    }
    if (hypothesis.titleOnly || hypothesis.titleOnlyEvidence) {
        score = Math.min(score, 0.58);
        caps.push({ reason: 'title_only_no_auto_apply', maximum: 0.58 });
    }
    if (hypothesis.filenameOnly) {
        score = Math.min(score, 0.58);
        caps.push({ reason: 'filename_only_no_auto_apply', maximum: 0.58 });
    }
    if (hypothesis.cautious || /reverse/u.test(hypothesis.interpretation)) {
        score = Math.min(score, 0.46);
        caps.push({ reason: 'cautious_reverse_interpretation', maximum: 0.46 });
    }
    if (conflicts.some(conflict => conflict.type === 'version')) {
        score = Math.min(score, 0.49);
        caps.push({ reason: 'version_conflict', maximum: 0.49 });
    }
    if (conflicts.some(conflict => conflict.type === 'duration')) {
        score = Math.min(score, 0.55);
        caps.push({ reason: 'duration_conflict', maximum: 0.55 });
    }
    if (conflicts.some(conflict => conflict.type === 'artist' || conflict.type === 'featured_artists')) {
        score = Math.min(score, 0.54);
        caps.push({ reason: 'artist_conflict', maximum: 0.54 });
    }
    return { confidence: roundScore(score), caps };
}

function scoreCandidate(candidate, context = {}, crossProviderAgreement = null) {
    const hypotheses = Array.isArray(context.hypotheses) && context.hypotheses.length
        ? context.hypotheses
        : generateHypotheses(context);
    if (hypotheses.length === 0) return null;
    let best = null;
    for (const hypothesis of hypotheses) {
        const scored = scoreAgainstHypothesis(candidate, hypothesis, context, crossProviderAgreement);
        const adjusted = policyAdjustedScore(scored.rawScore, candidate, hypothesis, scored.conflicts);
        if (!best || adjusted.confidence > best.adjusted.confidence || (
            adjusted.confidence === best.adjusted.confidence && scored.rawScore > best.rawScore
        )) {
            best = { ...scored, hypothesis, adjusted };
        }
    }
    const adjusted = best.adjusted;
    const ambiguousFields = candidateAmbiguousFields(candidate, best);
    const providerGenre = candidate.genre && !isUnknownValue(candidate.genre);
    const artistConfidenceValues = [best.breakdown.primaryArtist, best.breakdown.fullArtistCredit]
        .filter(signal => signal.available)
        .map(signal => signal.score);
    const artistConfidence = artistConfidenceValues.length
        ? roundScore(artistConfidenceValues.reduce((sum, value) => sum + value, 0) / artistConfidenceValues.length)
        : null;
    const fieldConfidence = {
        title: best.breakdown.title.score,
        songname: best.breakdown.title.score,
        artist: artistConfidence,
        album: best.breakdown.albumContext.available ? best.breakdown.albumContext.score : null,
        genre: providerGenre ? roundScore(Math.min(0.78, 0.45 + (best.rawScore * 0.35))) : null,
        year: candidate.year ? releaseFieldConfidence(candidate, 'year') : null,
        coverUrl: candidate.coverUrl ? releaseFieldConfidence(candidate, 'coverUrl') : null,
        duration: best.duration.available ? best.duration.score : null,
        version: best.breakdown.version.score
    };
    const evidence = buildCandidateEvidence(candidate, best, crossProviderAgreement);
    return {
        ...candidate,
        version: candidate.version || parseVersionIdentity(candidate.title),
        confidence: adjusted.confidence,
        rawScore: best.rawScore,
        scoreBreakdown: best.breakdown,
        fieldConfidence,
        evidence,
        conflicts: best.conflicts,
        ambiguousFields,
        policyCaps: adjusted.caps,
        matchedHypothesis: best.hypothesis,
        durationCompatible: best.duration.compatible,
        safeToApply: false,
        fieldSafety: {
            songname: false,
            title: false,
            artist: false,
            album: false,
            genre: false,
            year: false,
            coverUrl: false
        }
    };
}

function releaseFieldConfidence(candidate, field) {
    const values = uniqueStrings((candidate.releaseCandidates || []).map(release => {
        if (field === 'coverUrl') return release.coverUrl;
        return release[field];
    }));
    if (values.length > 1) return 0.48;
    return candidate.matchBasis === 'fingerprint' || candidate.matchBasis === 'embedded_id' ? 0.82 : 0.55;
}

function candidateAmbiguousFields(candidate, scored) {
    const ambiguous = new Set(candidate.ambiguousFields || []);
    const albums = uniqueStrings((candidate.releaseCandidates || []).map(release => release.album || release.title));
    const years = uniqueStrings((candidate.releaseCandidates || []).map(release => release.year));
    const covers = uniqueStrings((candidate.releaseCandidates || []).map(release => release.coverUrl));
    if (albums.length > 1) ambiguous.add('album');
    if (years.length > 1) ambiguous.add('year');
    if (covers.length > 1) ambiguous.add('coverUrl');
    if (!(Number(candidate.durationMs) > 0)) ambiguous.add('duration');
    if (scored.breakdown.primaryArtist.available && scored.breakdown.primaryArtist.score < 0.65) ambiguous.add('artist');
    if (scored.breakdown.albumContext.available && scored.breakdown.albumContext.score < 0.6) ambiguous.add('album');
    return Array.from(ambiguous);
}

function buildCandidateEvidence(candidate, scored, agreement) {
    const evidence = [
        { type: 'title', label: 'Title match', value: scored.breakdown.title.score },
        { type: 'hypothesis', label: 'Local source', value: `${scored.hypothesis.source}:${scored.hypothesis.interpretation}` }
    ];
    if (scored.breakdown.primaryArtist.available) evidence.push({ type: 'artist', label: 'Primary artist match', value: scored.breakdown.primaryArtist.score });
    if (scored.breakdown.fullArtistCredit.available) evidence.push({ type: 'artist_credit', label: 'Full artist credit match', value: scored.breakdown.fullArtistCredit.score });
    if (scored.duration.available) evidence.push({ type: 'duration', label: 'Duration delta (ms)', value: scored.duration.deltaMs });
    if (scored.version.expected.explicit || scored.version.candidate.explicit) {
        evidence.push({ type: 'version', label: 'Version identity', value: scored.version.compatible ? 'compatible' : 'conflict' });
    }
    if (Number.isFinite(candidate.providerNativeScore)) evidence.push({ type: 'provider_score', label: 'Provider score', value: roundScore(candidate.providerNativeScore) });
    if (Number.isFinite(agreement)) evidence.push({ type: 'agreement', label: 'Cross-provider agreement', value: roundScore(agreement) });
    if (candidate.matchBasis === 'fingerprint' || candidate.matchBasis === 'embedded_id') {
        evidence.push({ type: 'identity', label: 'Identity basis', value: candidate.matchBasis });
    } else if (candidate.matchBasis === 'local' || candidate.matchBasis === 'filename') {
        evidence.push({ type: 'local_parse', label: 'Local parse basis', value: candidate.matchBasis });
    }
    return evidence;
}

function valuesFromExternalIds(externalIds, key) {
    if (!externalIds || externalIds[key] === undefined || externalIds[key] === null) return [];
    return uniqueStrings(Array.isArray(externalIds[key]) ? externalIds[key] : [externalIds[key]]);
}

function sameRecording(left, right) {
    const leftProviders = new Set(left.providers || [left.provider || left.source].filter(Boolean));
    const rightProviders = new Set(right.providers || [right.provider || right.source].filter(Boolean));
    const crossProvider = Array.from(leftProviders).some(provider => !rightProviders.has(provider)) ||
        Array.from(rightProviders).some(provider => !leftProviders.has(provider));
    const leftMb = valuesFromExternalIds(left.externalIds, 'musicbrainzRecording');
    const rightMb = valuesFromExternalIds(right.externalIds, 'musicbrainzRecording');
    if (leftMb.some(value => rightMb.includes(value))) return { same: true, strength: crossProvider ? 1 : 0, reason: crossProvider ? 'musicbrainz_recording_id' : null, crossProvider };
    const leftIsrc = valuesFromExternalIds(left.externalIds, 'isrcs');
    const rightIsrc = valuesFromExternalIds(right.externalIds, 'isrcs');
    if (leftIsrc.some(value => rightIsrc.includes(value))) return { same: true, strength: crossProvider ? 0.98 : 0, reason: crossProvider ? 'isrc' : null, crossProvider };
    if (Array.from(leftProviders).some(provider => rightProviders.has(provider))) return { same: false, strength: 0, reason: null };
    const version = compareVersionIdentity(left.version || left.title, right.version || right.title);
    if (!version.compatible) return { same: false, strength: 0, reason: null };
    const title = textSimilarity(
        removeFeaturedClause(stripVersionMarkers(left.title)),
        removeFeaturedClause(stripVersionMarkers(right.title))
    );
    const leftCredit = artistCreditFromValues(left.artist, left.primaryArtists, left.title);
    const rightCredit = artistCreditFromValues(right.artist, right.primaryArtists, right.title);
    const artist = artistSetSimilarity(leftCredit.primaryArtists, rightCredit.primaryArtists);
    const featuredArtist = artistSetSimilarity(leftCredit.featuredArtists, rightCredit.featuredArtists);
    const duration = durationSignal(left.durationMs, right.durationMs);
    const durationOkay = !duration.available || duration.deltaMs <= 6000;
    const featuredOkay = !leftCredit.featuredArtists.length || !rightCredit.featuredArtists.length || featuredArtist >= 0.8;
    if (title >= 0.94 && artist >= 0.9 && featuredOkay && durationOkay) {
        const components = [title, artist, duration.available ? duration.score : 1];
        if (leftCredit.featuredArtists.length && rightCredit.featuredArtists.length) components.push(featuredArtist);
        return {
            same: true,
            strength: roundScore(components.reduce((sum, value) => sum + value, 0) / components.length),
            reason: 'metadata_agreement',
            crossProvider: true
        };
    }
    return { same: false, strength: 0, reason: null };
}

function mergeExternalIds(left, right) {
    const result = {};
    for (const key of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
        const values = uniqueStrings([
            ...(Array.isArray(left && left[key]) ? left[key] : [left && left[key]]),
            ...(Array.isArray(right && right[key]) ? right[key] : [right && right[key]])
        ]);
        if (values.length === 1 && key === 'musicbrainzRecording') result[key] = values[0];
        else if (values.length) result[key] = values;
    }
    return result;
}

function mergeReleaseCandidates(left, right) {
    const releases = [];
    const indexes = new Map();
    for (const release of [...(left || []), ...(right || [])]) {
        if (!release || typeof release !== 'object') continue;
        const key = release.id
            ? `id:${release.id}`
            : `${release.provider || ''}:${normalizeForMatch(release.album || release.title)}:${release.country || ''}:${release.date || ''}`;
        if (indexes.has(key)) {
            const index = indexes.get(key);
            releases[index] = {
                ...release,
                ...releases[index],
                providers: uniqueStrings([
                    ...(releases[index].providers || [releases[index].provider]),
                    ...(release.providers || [release.provider])
                ])
            };
            continue;
        }
        indexes.set(key, releases.length);
        releases.push({ ...release, providers: uniqueStrings(release.providers || [release.provider]) });
    }
    return releases;
}

function basisStrength(value) {
    return { text: 0, local: 0, filename: 0, embedded_id: 1, fingerprint: 2 }[value] || 0;
}

function mergeCandidatePair(existing, incoming, agreement) {
    const existingRichness = Number(Boolean(existing.album)) + Number(Boolean(existing.coverUrl)) + Number((existing.releaseCandidates || []).length) + Number(existing.provider === 'musicbrainz');
    const incomingRichness = Number(Boolean(incoming.album)) + Number(Boolean(incoming.coverUrl)) + Number((incoming.releaseCandidates || []).length) + Number(incoming.provider === 'musicbrainz');
    const primary = incomingRichness > existingRichness ? incoming : existing;
    const secondary = primary === existing ? incoming : existing;
    const providers = uniqueStrings([
        ...(existing.providers || [existing.provider || existing.source]),
        ...(incoming.providers || [incoming.provider || incoming.source])
    ]);
    const nativeScores = {
        ...(existing.providerNativeScores || (existing.provider ? { [existing.provider]: existing.providerNativeScore } : {})),
        ...(incoming.providerNativeScores || (incoming.provider ? { [incoming.provider]: incoming.providerNativeScore } : {}))
    };
    const strongestBasis = basisStrength(existing.matchBasis) >= basisStrength(incoming.matchBasis) ? existing.matchBasis : incoming.matchBasis;
    const nativeValues = Object.values(nativeScores).filter(Number.isFinite);
    const identityValues = [existing.identityScore, incoming.identityScore].filter(Number.isFinite);
    const result = {
        ...secondary,
        ...primary,
        id: primary.id || secondary.id,
        candidateId: primary.candidateId || primary.id || secondary.candidateId || secondary.id,
        providers,
        providerNativeScores: nativeScores,
        providerNativeScore: nativeValues.length ? Math.max(...nativeValues) : null,
        externalIds: mergeExternalIds(existing.externalIds, incoming.externalIds),
        releaseCandidates: mergeReleaseCandidates(existing.releaseCandidates, incoming.releaseCandidates),
        matchBasis: strongestBasis || 'text',
        identityValidated: Boolean(existing.identityValidated || incoming.identityValidated),
        identityScore: identityValues.length ? Math.max(...identityValues) : null,
        agreement: {
            score: Math.max(existing.agreement && existing.agreement.score || 0, incoming.agreement && incoming.agreement.score || 0, agreement.crossProvider ? agreement.strength : 0) || null,
            reasons: uniqueStrings([
                ...((existing.agreement && existing.agreement.reasons) || []),
                ...((incoming.agreement && incoming.agreement.reasons) || []),
                agreement.crossProvider ? agreement.reason : null
            ])
        }
    };
    if ((!result.genre || isUnknownValue(result.genre)) && secondary.genre && !isUnknownValue(secondary.genre)) result.genre = secondary.genre;
    if (!result.coverUrl && secondary.coverUrl) result.coverUrl = secondary.coverUrl;
    if (!result.album && secondary.album) result.album = secondary.album;
    if (!result.year && secondary.year) result.year = secondary.year;
    return result;
}

function mergeRecordingCandidates(candidates) {
    const merged = [];
    for (const candidate of candidates || []) {
        if (!candidate || !candidate.title) continue;
        let matchedIndex = -1;
        let agreement = null;
        for (let index = 0; index < merged.length; index++) {
            const result = sameRecording(merged[index], candidate);
            if (result.same) {
                matchedIndex = index;
                agreement = result;
                break;
            }
        }
        if (matchedIndex === -1) {
            merged.push({
                ...candidate,
                providers: uniqueStrings(candidate.providers || [candidate.provider || candidate.source]),
                releaseCandidates: mergeReleaseCandidates([], candidate.releaseCandidates),
                agreement: candidate.agreement || { score: null, reasons: [] }
            });
        } else {
            merged[matchedIndex] = mergeCandidatePair(merged[matchedIndex], candidate, agreement);
        }
    }
    return merged;
}

function finalizeCandidates(candidates, context = {}) {
    const scored = (candidates || [])
        .map(candidate => {
            const agreement = candidate.agreement && Number.isFinite(candidate.agreement.score)
                ? candidate.agreement.score
                : ((candidate.providers || []).length > 1 ? 0.85 : null);
            return scoreCandidate(candidate, context, agreement);
        })
        .filter(candidate => candidate && (
            candidate.matchBasis === 'fingerprint' || candidate.matchBasis === 'embedded_id' ||
            (candidate.rawScore >= 0.45 && candidate.scoreBreakdown.title.score >= 0.45)
        ))
        .sort((left, right) => right.confidence - left.confidence || right.rawScore - left.rawScore);

    if (scored.length === 0) return [];
    const top = scored[0];
    const second = scored[1];
    const margin = second ? top.confidence - second.confidence : 1;
    const unique = !second || margin >= 0.08 || sameRecording(top, second).same;
    const identityBasis = top.matchBasis === 'fingerprint' || top.matchBasis === 'embedded_id';
    const identityStrong = top.matchBasis !== 'fingerprint' || (Number.isFinite(top.identityScore) && top.identityScore >= AUTO_THRESHOLD);
    const strong = top.confidence >= AUTO_THRESHOLD && top.rawScore >= AUTO_THRESHOLD;
    const conflictFree = top.conflicts.length === 0;
    const durationCompatible = top.scoreBreakdown.duration.available && top.durationCompatible;
    const titleCompatible = top.fieldConfidence.title !== null && top.fieldConfidence.title >= AUTO_THRESHOLD;
    const artistCompatible = top.fieldConfidence.artist !== null && top.fieldConfidence.artist >= 0.85;
    const safe = Boolean(
        identityBasis && identityStrong && top.identityValidated && unique && strong &&
        titleCompatible && artistCompatible && durationCompatible && conflictFree
    );
    top.safeToApply = safe;
    top.uniqueMatch = unique;
    top.fieldSafety = {
        songname: safe && top.fieldConfidence.title >= AUTO_THRESHOLD,
        title: safe && top.fieldConfidence.title >= AUTO_THRESHOLD,
        artist: safe && top.fieldConfidence.artist !== null && top.fieldConfidence.artist >= 0.85,
        album: safe && !top.ambiguousFields.includes('album') && top.fieldConfidence.album !== null && top.fieldConfidence.album >= 0.72,
        genre: safe && Boolean(top.genre) && top.fieldConfidence.genre !== null && top.fieldConfidence.genre >= 0.65,
        year: safe && Boolean(top.year) && !top.ambiguousFields.includes('year'),
        coverUrl: safe && Boolean(top.coverUrl) && !top.ambiguousFields.includes('coverUrl')
    };
    if (!unique) {
        for (const field of ['title', 'artist', 'album']) {
            if (!top.ambiguousFields.includes(field)) top.ambiguousFields.push(field);
        }
    }
    return scored;
}

function dedupeConflicts(conflicts) {
    const seen = new Set();
    return (conflicts || []).filter(conflict => {
        const key = `${conflict.type || ''}:${conflict.marker || ''}:${conflict.message || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

module.exports = {
    AUTO_THRESHOLD,
    LEGACY_AUTO_THRESHOLD,
    normalizeForMatch,
    textSimilarity,
    parseVersionIdentity,
    compareVersionIdentity,
    parseFilenameSituations,
    generateHypotheses,
    classifyGenreEvidence,
    extractYearFromText,
    mergeRecordingCandidates,
    scoreCandidate,
    finalizeCandidates,
    _test: {
        cleanDisplayText,
        normalizeForMatch,
        isUnknownValue,
        levenshteinDistance,
        textSignals,
        textSimilarity,
        tokenDice,
        ngramDice,
        extractFeaturedArtists,
        artistCreditFromValues,
        parseVersionIdentity,
        stripVersionMarkers,
        compareVersionIdentity,
        removeTrackPrefix,
        parseFilenameSituations,
        generateHypotheses,
        classifyGenreEvidence,
        artistSetSimilarity,
        durationSignal,
        scoreCandidate,
        sameRecording,
        mergeRecordingCandidates,
        finalizeCandidates
    }
};

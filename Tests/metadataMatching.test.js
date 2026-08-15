'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Matching = require('../Server/metadataMatching');

const {
    parseFilenameSituations,
    parseVersionIdentity,
    compareVersionIdentity,
    generateHypotheses,
    finalizeCandidates,
    mergeRecordingCandidates
} = Matching._test;

const RECORDING_ID = '026fa041-3917-4c73-9079-ed16e36f20f8';

function context(overrides = {}) {
    const input = {
        title: 'Exact Title',
        artist: 'Correct Artist',
        album: 'Album',
        ...overrides
    };
    return {
        ...input,
        durationMs: overrides.durationMs === undefined ? 180000 : overrides.durationMs,
        hypotheses: generateHypotheses(input)
    };
}

function identityCandidate(overrides = {}) {
    const artist = overrides.artist || 'Correct Artist';
    return {
        id: `musicbrainz:${RECORDING_ID}`,
        candidateId: `musicbrainz:${RECORDING_ID}`,
        title: 'Exact Title',
        artist,
        artistCredits: [{ id: 'artist-id', name: artist, joinPhrase: '' }],
        primaryArtists: [artist],
        featuredArtists: [],
        album: 'Album',
        year: 2020,
        coverUrl: 'https://coverartarchive.org/release/release-a/front-500',
        durationMs: 180000,
        provider: 'musicbrainz',
        source: 'musicbrainz',
        providers: ['musicbrainz'],
        providerNativeScore: 1,
        providerNativeScores: { musicbrainz: 1 },
        matchBasis: 'fingerprint',
        identityValidated: true,
        identityScore: 0.99,
        externalIds: { musicbrainzRecording: RECORDING_ID },
        releaseCandidates: [],
        ...overrides
    };
}

test('filename parsing preserves numeric and global-article artist names', () => {
    const fiftyCent = parseFilenameSituations('50 Cent - In Da Club.mp3');
    assert.equal(fiftyCent.artistHint, '50 Cent');
    assert.equal(fiftyCent.titleHint, 'In Da Club');

    const theThe = parseFilenameSituations('The The - This Is the Day.flac');
    assert.equal(theThe.artistHint, 'The The');
    assert.equal(theThe.titleHint, 'This Is the Day');
});

test('filename parsing handles Unicode dashes and non-Latin artist names', () => {
    const parsed = parseFilenameSituations('宇多田ヒカル — First Love.m4a');
    assert.equal(parsed.artistHint, '宇多田ヒカル');
    assert.equal(parsed.titleHint, 'First Love');
    assert.equal(Matching.normalizeForMatch('Beyoncé 東京'), 'beyoncé 東京');
});

test('filename parsing handles Title by Artist and track-number prefixes', () => {
    const byArtist = parseFilenameSituations('Title by Artist.mp3');
    assert.equal(byArtist.artistHint, 'Artist');
    assert.equal(byArtist.titleHint, 'Title');

    const numbered = parseFilenameSituations('01 - Artist - Title.mp3');
    assert.equal(numbered.artistHint, 'Artist');
    assert.equal(numbered.titleHint, 'Title');
});

test('filename parsing extracts featured artists independently from title', () => {
    const parsed = parseFilenameSituations('Artist - Song (feat. Guest).mp3');
    assert.equal(parsed.artistHint, 'Artist');
    assert.equal(parsed.titleHint, 'Song');
    assert.deepEqual(parsed.featuredArtists, ['Guest']);
});

test('version parser recognizes required version identities', () => {
    const cases = [
        ['Song (Live)', 'live', true],
        ['Song (DJ Remix)', 'remix', true],
        ['Song (Radio Edit)', 'radioEdit', true],
        ['Song (Acoustic Version)', 'acoustic', true],
        ['Song (Instrumental)', 'instrumental', true],
        ['Song (2020 Remaster)', 'remasterYear', 2020],
        ['Song (Slowed & Reverb)', 'speed', 'slowed']
    ];

    for (const [title, field, expected] of cases) {
        assert.equal(parseVersionIdentity(title)[field], expected, title);
    }
});

test('live and remix identities conflict and remain below automatic confidence', () => {
    const comparison = compareVersionIdentity('Song (Live)', 'Song (DJ Remix)');
    assert.equal(comparison.compatible, false);
    assert.ok(comparison.conflicts.some(conflict => conflict.type === 'version'));

    const candidate = identityCandidate({ title: 'Song (DJ Remix)' });
    const result = finalizeCandidates([candidate], context({ title: 'Song (Live)' }))[0];
    assert.equal(result.safeToApply, false);
    assert.ok(result.confidence <= 0.49);
});

test('an exact title with the wrong artist cannot auto apply', () => {
    const candidate = identityCandidate({
        artist: 'Artist B',
        artistCredits: [{ id: 'artist-b', name: 'Artist B', joinPhrase: '' }],
        primaryArtists: ['Artist B']
    });
    const result = finalizeCandidates([candidate], context({ artist: 'Artist A' }))[0];

    assert.equal(result.scoreBreakdown.title.score, 1);
    assert.ok(result.fieldConfidence.artist < 0.85);
    assert.equal(result.safeToApply, false);
});

test('title-only and filename-only evidence retain hard caps', () => {
    const candidate = identityCandidate();
    const titleOnly = finalizeCandidates([candidate], context({ artist: '', album: '' }))[0];
    assert.equal(titleOnly.safeToApply, false);
    assert.ok(titleOnly.confidence <= 0.58);
    assert.ok(titleOnly.policyCaps.some(cap => cap.reason === 'title_only_no_auto_apply'));

    const filenameOnly = finalizeCandidates([candidate], context({ metadataSource: 'filename' }))[0];
    assert.equal(filenameOnly.safeToApply, false);
    assert.ok(filenameOnly.confidence <= 0.58);
    assert.ok(filenameOnly.policyCaps.some(cap => cap.reason === 'filename_only_no_auto_apply'));
});

test('duration conflicts cap confidence and prevent automatic application', () => {
    const candidate = identityCandidate({ durationMs: 240000 });
    const result = finalizeCandidates([candidate], context())[0];

    assert.equal(result.safeToApply, false);
    assert.ok(result.conflicts.some(conflict => conflict.type === 'duration'));
    assert.ok(result.confidence <= 0.55);
});

test('text-only candidates are never safe to apply', () => {
    const candidate = identityCandidate({
        matchBasis: 'text',
        identityValidated: false,
        identityScore: null
    });
    const result = finalizeCandidates([candidate], context())[0];

    assert.equal(result.safeToApply, false);
    assert.ok(result.confidence < Matching.LEGACY_AUTO_THRESHOLD);
});

test('a unique validated fingerprint match can auto apply at the strict threshold', () => {
    const result = finalizeCandidates([identityCandidate()], context())[0];

    assert.equal(result.uniqueMatch, true);
    assert.equal(result.safeToApply, true);
    assert.ok(result.confidence >= Matching.AUTO_THRESHOLD);
});

test('ambiguous releases keep album, year, and cover fields unsafe', () => {
    const candidate = identityCandidate({
        releaseCandidates: [
            {
                id: 'release-a', provider: 'musicbrainz', album: 'Album', year: 2020,
                coverUrl: 'https://coverartarchive.org/release/release-a/front-500'
            },
            {
                id: 'release-b', provider: 'musicbrainz', album: 'Other Album', year: 2021,
                coverUrl: 'https://coverartarchive.org/release/release-b/front-500'
            }
        ]
    });
    const result = finalizeCandidates([candidate], context())[0];

    assert.ok(result.ambiguousFields.includes('album'));
    assert.ok(result.ambiguousFields.includes('year'));
    assert.ok(result.ambiguousFields.includes('coverUrl'));
    assert.equal(result.fieldSafety.album, false);
    assert.equal(result.fieldSafety.year, false);
    assert.equal(result.fieldSafety.coverUrl, false);
});

test('cross-provider candidates merge by MusicBrainz recording ID and preserve releases', () => {
    const musicBrainz = identityCandidate({
        provider: 'musicbrainz',
        source: 'musicbrainz',
        providers: ['musicbrainz'],
        matchBasis: 'text',
        identityValidated: false,
        identityScore: null,
        releaseCandidates: [{ id: 'release-a', provider: 'musicbrainz', album: 'Album A' }]
    });
    const acoustId = identityCandidate({
        provider: 'acoustid',
        source: 'acoustid',
        providers: ['acoustid'],
        releaseCandidates: [{ id: 'release-b', provider: 'acoustid', album: 'Album B' }]
    });

    const merged = mergeRecordingCandidates([musicBrainz, acoustId]);
    assert.equal(merged.length, 1);
    assert.deepEqual(new Set(merged[0].providers), new Set(['musicbrainz', 'acoustid']));
    assert.deepEqual(new Set(merged[0].releaseCandidates.map(release => release.id)), new Set(['release-a', 'release-b']));
    assert.equal(merged[0].externalIds.musicbrainzRecording, RECORDING_ID);
});

test('cross-provider text candidates merge split featured-artist credits', () => {
    const apple = {
        ...identityCandidate(),
        id: 'apple:1',
        candidateId: 'apple:1',
        title: 'Levitating (feat. DaBaby)',
        artist: 'Dua Lipa',
        primaryArtists: ['Dua Lipa'],
        featuredArtists: [],
        durationMs: 203064,
        provider: 'apple',
        source: 'itunes',
        providers: ['apple'],
        matchBasis: 'text',
        identityValidated: false,
        identityScore: null,
        externalIds: { appleTrack: ['1'] }
    };
    const musicBrainz = {
        ...identityCandidate(),
        id: 'musicbrainz:2',
        candidateId: 'musicbrainz:2',
        title: 'Levitating',
        artist: 'Dua Lipa feat. DaBaby',
        primaryArtists: ['Dua Lipa'],
        featuredArtists: ['DaBaby'],
        durationMs: 203000,
        provider: 'musicbrainz',
        source: 'musicbrainz',
        providers: ['musicbrainz'],
        matchBasis: 'text',
        identityValidated: false,
        identityScore: null,
        externalIds: { musicbrainzRecording: 'recording-2' }
    };

    const merged = mergeRecordingCandidates([apple, musicBrainz]);
    assert.equal(merged.length, 1);
    assert.deepEqual(new Set(merged[0].providers), new Set(['apple', 'musicbrainz']));
});

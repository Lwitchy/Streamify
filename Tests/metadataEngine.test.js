'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIMetadata = require('../Server/aiMetadata');

const RECORDING_ID = '026fa041-3917-4c73-9079-ed16e36f20f8';

function musicBrainzRecording() {
    return {
        id: RECORDING_ID,
        score: 100,
        title: 'Café del Mar',
        length: 420000,
        'artist-credit': [{
            name: 'Energy 52',
            artist: { id: 'artist-id', name: 'Energy 52' }
        }],
        releases: [],
        isrcs: ['DEABC1234567']
    };
}

test('local_only makes zero provider calls and returns reviewable local parsing', async () => {
    let requestCount = 0;
    const result = await AIMetadata.enrichSong({
        songname: 'Artist - Title',
        artist: 'Unknown Artist',
        album: 'Unknown Album',
        duration_ms: 180000,
        filepath: '01 - Artist - Title.mp3'
    }, {
        mode: 'local_only',
        loadStoredEvidence: false,
        requestJson: async () => {
            requestCount++;
            throw new Error('local_only called a provider');
        }
    });

    assert.equal(requestCount, 0);
    assert.equal(result.mode, 'local_only');
    assert.equal(result.outcome, 'needs_review');
    const candidate = result.candidates.find(item => item.title === 'Title' && item.artist === 'Artist');
    assert.ok(candidate);
    assert.equal(candidate.source, 'local');
    assert.ok(['local', 'filename'].includes(candidate.matchBasis));
    assert.equal(candidate.safeToApply, false);
    assert.ok(candidate.confidence < 0.90);
    assert.ok(Object.values(candidate.fieldSafety).every(value => value === false));
    assert.ok(result.providers.some(provider => provider.name === 'local' && provider.status === 'matched'));
});

test('text_only exact registry result remains review-only and never calls AcoustID', async () => {
    const calls = [];
    const result = await AIMetadata.enrichSong({
        songname: 'Café del Mar',
        artist: 'Energy 52',
        duration_ms: 420000
    }, {
        mode: 'text_only',
        loadStoredEvidence: false,
        acoustidKey: 'unused-key',
        fingerprint: 'unused-fingerprint',
        fingerprintDuration: 420,
        requestJson: async (provider) => {
            calls.push(provider);
            if (provider === 'musicbrainz') {
                return { status: 'ok', data: { recordings: [musicBrainzRecording()] }, attempts: 1, cached: false };
            }
            if (provider === 'apple') {
                return { status: 'ok', data: { results: [] }, attempts: 1, cached: false };
            }
            throw new Error(`unexpected provider: ${provider}`);
        }
    });

    assert.ok(calls.includes('musicbrainz'));
    assert.ok(calls.includes('apple'));
    assert.ok(!calls.includes('acoustid'));
    assert.equal(result.outcome, 'needs_review');
    assert.equal(result.safeToApply, false);
    assert.equal(result.candidates[0].matchBasis, 'text');
    assert.equal(result.candidates[0].safeToApply, false);
});

test('a strong acoustic match skips all text-search provider calls', async () => {
    const calls = [];
    const recording = musicBrainzRecording();
    const result = await AIMetadata.enrichSong({
        songname: 'Café del Mar',
        artist: 'Energy 52',
        duration_ms: 420000
    }, {
        mode: 'acoustic_with_text_fallback',
        loadStoredEvidence: false,
        acoustidKey: 'client-key',
        fingerprint: 'fingerprint',
        fingerprintDuration: 420,
        requestJson: async (provider, url, options = {}) => {
            calls.push({ provider, url, method: options.method || 'GET' });
            if (provider === 'acoustid') {
                return {
                    status: 'ok',
                    data: {
                        status: 'ok',
                        results: [{
                            id: 'acoustid-id',
                            score: 0.98,
                            recordings: [{
                                id: RECORDING_ID,
                                title: 'Café del Mar',
                                duration: 420,
                                artists: [{ name: 'Energy 52' }],
                                releasegroups: []
                            }]
                        }]
                    },
                    attempts: 1,
                    cached: false
                };
            }
            if (provider === 'musicbrainz' && url.includes(`/recording/${RECORDING_ID}`)) {
                return { status: 'ok', data: recording, attempts: 1, cached: false };
            }
            throw new Error(`unexpected text-provider call: ${provider} ${url}`);
        }
    });

    assert.equal(result.outcome, 'auto_matched');
    assert.equal(result.safeToApply, true);
    assert.ok(result.candidates[0].confidence >= 0.90);
    assert.equal(calls.filter(call => call.provider === 'apple').length, 0);
    assert.equal(calls.filter(call => call.provider === 'musicbrainz' && call.url.includes('/recording/?')).length, 0);
    assert.equal(calls.find(call => call.provider === 'acoustid').method, 'POST');
});

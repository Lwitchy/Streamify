'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');
const Providers = require('../Server/metadataProviders');

test('provider request has an absolute wall-clock timeout', async () => {
    const originalRequest = https.request;
    class HangingRequest extends EventEmitter {
        setTimeout() {}
        end() {}
        destroy(error) { queueMicrotask(() => this.emit('error', error)); }
    }
    https.request = () => new HangingRequest();
    try {
        const startedAt = Date.now();
        const result = await Providers._test.requestOnce('https://example.test', { timeoutMs: 500 });
        assert.equal(result.kind, 'timeout');
        assert.ok(Date.now() - startedAt < 1500);
    } finally {
        https.request = originalRequest;
    }
});

test('AcoustID lookup uses POST form data with correctly encoded space-separated meta', async () => {
    let request;
    const result = await Providers.lookupAcoustId({
        key: 'client-key',
        fingerprint: 'fingerprint +/=',
        duration: 180
    }, {
        requestJson: async (provider, url, options) => {
            request = { provider, url, options };
            return { status: 'ok', data: { status: 'ok', results: [] }, attempts: 1, cached: false };
        }
    });

    assert.equal(result.status, 'no_match');
    assert.equal(request.provider, 'acoustid');
    assert.equal(request.url, 'https://api.acoustid.org/v2/lookup');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.contentType, 'application/x-www-form-urlencoded');
    assert.ok(!request.url.includes('client-key'));
    assert.ok(!request.url.includes('fingerprint'));

    const body = String(request.options.body);
    const form = new URLSearchParams(body);
    const expectedMeta = 'recordings recordingids releasegroups releasegroupids releases releaseids tracks isrcs compress';
    assert.equal(form.get('client'), 'client-key');
    assert.equal(form.get('fingerprint'), 'fingerprint +/=');
    assert.equal(form.get('duration'), '180');
    assert.equal(form.get('meta'), expectedMeta);
    assert.ok(body.includes('meta=recordings+recordingids+releasegroups'));
    assert.ok(!body.includes('recordings%2Brecordingids'));
});

test('AcoustID error code 3 is not an invalid key and code 4 is', async () => {
    assert.equal(Providers._test.invalidAcoustIdResponse({
        status: 'error', error: { code: 3, message: 'invalid fingerprint' }
    }), false);
    assert.equal(Providers._test.invalidAcoustIdResponse({
        status: 'error', error: { code: 4, message: 'invalid client key' }
    }), true);

    const lookupForCode = code => Providers.lookupAcoustId({
        key: 'client-key', fingerprint: 'fingerprint', duration: 180
    }, {
        requestJson: async () => ({
            status: 'ok', data: { status: 'error', error: { code, message: code === 4 ? 'invalid client key' : 'invalid fingerprint' } },
            attempts: 1, cached: false
        })
    });

    assert.equal((await lookupForCode(3)).status, 'provider_error');
    assert.equal((await lookupForCode(4)).status, 'invalid_key');
});

test('POST cache keys hash request bodies without exposing credentials', () => {
    const url = 'https://api.acoustid.org/v2/lookup';
    const body = 'client=secret&fingerprint=sensitive';
    const key = Providers._test.requestKey('acoustid', url, { method: 'POST', body });

    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(key, Providers._test.requestKey('acoustid', url, { method: 'POST', body }));
    assert.notEqual(key, Providers._test.requestKey('acoustid', url, { method: 'POST', body: `${body}x` }));
    assert.ok(!key.includes('secret'));
    assert.ok(!key.includes('sensitive'));
});

test('AcoustID date objects and nested MusicBrainz releases are normalized', () => {
    assert.equal(Providers._test.normalizeDate({ year: 2020, month: 10, day: 1 }), '2020-10-01');
    const candidates = Providers._test.mapAcoustIdResponse({
        results: [{
            id: 'acoustid-1',
            score: 0.98,
            recordings: [{
                id: 'recording-1',
                title: 'Track',
                duration: 180,
                artists: [{ id: 'artist-1', name: 'Artist' }],
                releasegroups: [{
                    id: 'group-1',
                    title: 'Album',
                    firstreleasedate: { year: 2020, month: 10, day: 1 },
                    releases: [{
                        id: 'release-1',
                        title: 'Album',
                        date: { year: 2020, month: 10, day: 2 },
                        country: 'XW'
                    }]
                }]
            }]
        }]
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].year, 2020);
    assert.equal(candidates[0].date, '2020-10-02');
    assert.equal(candidates[0].releaseCandidates[0].provider, 'musicbrainz');
    assert.equal(candidates[0].releaseCandidates[0].releaseGroupId, 'group-1');
    assert.equal(candidates[0].externalIds.musicbrainzReleases[0], 'release-1');
});

'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Fingerprint = require('../Server/fingerprint')._test;

test('fpcalc JSON and key-value output parsing is deterministic', () => {
    assert.deepEqual(Fingerprint.parseFpcalcOutput(JSON.stringify({
        duration: 123.4,
        fingerprint: 'AQAA-test'
    })), {
        fingerprint: 'AQAA-test',
        duration: 123
    });

    assert.deepEqual(Fingerprint.parseFpcalcOutput('DURATION=181\nFINGERPRINT=AQBB-test\n'), {
        fingerprint: 'AQBB-test',
        duration: 181
    });
    assert.equal(Fingerprint.parseFpcalcOutput('not fpcalc output'), null);
});

test('fpcalc path candidates follow override, bundled, then PATH order without execution', () => {
    const moduleDirectory = path.resolve('fixture-app', 'Server');
    const override = path.resolve('fixture-bin', 'fpcalc-custom');
    const candidates = Fingerprint.fpcalcCandidates({
        env: { FPCALC_PATH: override },
        platform: 'linux',
        arch: 'x64',
        moduleDirectory
    });

    assert.deepEqual(candidates.map(candidate => candidate.source), ['environment', 'bundled', 'path']);
    assert.equal(candidates[0].executable, override);
    assert.equal(
        candidates[1].executable,
        path.resolve(moduleDirectory, '..', 'vendor', 'fpcalc', 'linux-x64', 'fpcalc')
    );
    assert.equal(candidates[2].executable, 'fpcalc');
});

test('packaged fpcalc paths are rewritten to the unpacked application tree', () => {
    const packed = path.join('root', 'app.asar', 'vendor', 'fpcalc');
    const unpacked = Fingerprint.unpackedPath(packed);
    assert.ok(unpacked.includes('app.asar.unpacked'));
    assert.ok(!unpacked.includes(`${path.sep}app.asar${path.sep}`));
});

'use strict';

/*
 * Deletion rules for library songs.
 *
 * The rule being pinned: a song Streamify downloaded can be deleted without any
 * ceremony (removing it is housekeeping), while a file that arrived some other
 * way needs an explicit confirmation because the real file leaves the disk.
 *
 * These import the SAME module the route uses, deliberately. An earlier version
 * of this file re-implemented the rule locally and passed against a server.js
 * that had the old refusal restored — it tested a copy, not the code that runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteVerdict } = require('../Server/deleteRules');

test('a downloaded folder song deletes without confirmation', () => {
    // This is the case that used to be impossible: the download lands in a real
    // folder, gets indexed as source 'folder', and the old guard then refused it
    // forever.
    const verdict = deleteVerdict({
        song: { id: 1, source: 'folder' },
        downloaded: true,
        confirmed: false
    });
    assert.equal(verdict.ok, true, 'a Streamify download should be deletable directly');
});

test('a hand-added folder song asks first, then proceeds once confirmed', () => {
    const song = { id: 2, source: 'folder' };

    const first = deleteVerdict({ song, downloaded: false, confirmed: false });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'needs_confirmation', 'the user must be warned the real file goes');

    const second = deleteVerdict({ song, downloaded: false, confirmed: true });
    assert.equal(second.ok, true, 'confirming must let the delete through');
});

test('the confirmation only applies to files that are not ours to remove', () => {
    // A non-folder source (a legacy upload) is unaffected by the folder rule.
    const upload = deleteVerdict({ song: { id: 3, source: 'upload' }, downloaded: false, confirmed: false });
    assert.equal(upload.ok, true, 'an upload was already deletable and must stay so');
});

test('a missing song is reported as not found, never silently skipped', () => {
    const verdict = deleteVerdict({ song: null, downloaded: false, confirmed: false });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.error, 'Not found');
});

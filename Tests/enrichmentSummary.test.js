'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    summarizeEnrichmentItems,
    lookupModeAfterKeyRemoval
} = require('../Server/enrichmentSummary');

test('enrichment summary separates scanning from review outcomes', () => {
    const summary = summarizeEnrichmentItems([
        { status: 'queued' },
        { status: 'processing' },
        { status: 'cancelled' },
        { status: 'applied', decision: null, result_json: JSON.stringify({ outcome: 'auto_matched' }) },
        { status: 'applied', decision: 'apply', result_json: JSON.stringify({ outcome: 'needs_review' }) },
        { status: 'review' },
        { status: 'skipped', decision: 'skip', result_json: JSON.stringify({ outcome: 'needs_review' }) },
        { status: 'skipped', decision: 'skip', result_json: JSON.stringify({ outcome: 'no_match' }) },
        { status: 'error', result_json: JSON.stringify({ outcome: 'provider_error' }) }
    ]);

    assert.equal(summary.total, 9);
    assert.equal(summary.scanned, 6);
    assert.equal(summary.automatic, 1);
    assert.equal(summary.approved, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.pendingDecisions, 2);
    assert.equal(summary.decisionsCompleted, 3);
    assert.equal(summary.noMatch, 1);
    assert.equal(summary.sourceErrors, 1);
    assert.equal(summary.scanPercent, 66.67);
});

test('removing the only AcoustID key falls back to text lookup', () => {
    assert.equal(
        lookupModeAfterKeyRemoval('acoustic_with_text_fallback', false),
        'text_only'
    );
    assert.equal(
        lookupModeAfterKeyRemoval('acoustic_with_text_fallback', true),
        'acoustic_with_text_fallback'
    );
    assert.equal(lookupModeAfterKeyRemoval('local_only', false), 'local_only');
});

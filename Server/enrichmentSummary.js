'use strict';

const ACOUSTIC_LOOKUP_MODE = 'acoustic_with_text_fallback';
const TEXT_LOOKUP_MODE = 'text_only';

function parseResult(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function summarizeEnrichmentItems(items = []) {
    const statusCounts = {};
    const classifiedItems = items.map(item => ({
        item,
        outcome: parseResult(item.result_json || item.result).outcome
    }));
    items.forEach(item => {
        statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
    });

    const total = items.length;
    const queued = statusCounts.queued || 0;
    const processing = statusCounts.processing || 0;
    const cancelled = statusCounts.cancelled || 0;
    const scanned = total - queued - processing - cancelled;
    const automatic = items.filter(item => item.status === 'applied' && !item.decision).length;
    const approved = items.filter(item => item.status === 'applied' && item.decision === 'apply').length;
    const skipDecisions = items.filter(item => item.decision === 'skip').length;
    const markedUnknown = items.filter(item => item.decision === 'mark_unknown').length;
    const needsReview = statusCounts.review || 0;
    const unidentified = statusCounts.unidentified || 0;
    const errors = statusCounts.error || 0;
    const pendingDecisions = needsReview + unidentified + errors;
    const decisionsCompleted = approved + skipDecisions + markedUnknown;
    const noMatch = classifiedItems.filter(({ item, outcome }) => {
        return item.status === 'unidentified' || item.decision === 'mark_unknown' || outcome === 'no_match' || outcome === 'unidentified';
    }).length;
    const sourceErrors = classifiedItems.filter(({ item, outcome }) => {
        return item.status === 'error' || outcome === 'provider_error';
    }).length;
    const skipped = classifiedItems.filter(({ item, outcome }) => {
        return item.decision === 'skip' && !['no_match', 'unidentified', 'provider_error'].includes(outcome);
    }).length;
    const scanPercent = total > 0 ? Math.round((scanned / total) * 10000) / 100 : 0;

    return {
        total,
        queued,
        processing,
        scanned,
        automatic,
        approved,
        skipped,
        markedUnknown,
        needsReview,
        unidentified,
        errors,
        pendingDecisions,
        decisionsCompleted,
        noMatch,
        sourceErrors,
        cancelled,
        matched: automatic + approved,
        scanPercent
    };
}

function lookupModeAfterKeyRemoval(currentMode, environmentKeyConfigured) {
    return currentMode === ACOUSTIC_LOOKUP_MODE && !environmentKeyConfigured
        ? TEXT_LOOKUP_MODE
        : currentMode;
}

module.exports = {
    summarizeEnrichmentItems,
    lookupModeAfterKeyRemoval
};

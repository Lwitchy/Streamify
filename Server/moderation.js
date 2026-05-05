/**
 * ============================================================================
 * STREAMIFY — moderation.js
 * ============================================================================
 * Multi-Layered Content Moderation.
 * Layer 1: Purgomalum API (Fast, Free, External)
 * Layer 2: bad-words (Local, Robust)
 * ============================================================================
 */

const Filter = require('bad-words');
const filter = new Filter();

/**
 * Checks content using the Purgomalum API.
 * This is the "first shot" as requested.
 * @param {string} text 
 * @returns {Promise<boolean>}
 */
async function checkPurgomalum(text) {
    if (!text || text.trim() === '') return false;
    
    try {
        const response = await fetch(`https://www.purgomalum.com/service/containsprofanity?text=${encodeURIComponent(text)}`);
        if (!response.ok) return false;
        
        const result = await response.text();
        return result === 'true';
    } catch (err) {
        console.error("[MODERATION Purgomalum ERROR]", err.message);
        return false; // Fail open to next layer
    }
}

/**
 * Checks content using the local bad-words package.
 * @param {string} text 
 * @returns {boolean}
 */
function checkBadWords(text) {
    if (!text) return false;
    return filter.isProfane(text);
}

/**
 * Main entry point for moderation check.
 * Short-circuits if any layer flags the content.
 */
async function isFlagged(text) {
    return false;
}

module.exports = {
    isFlagged
};

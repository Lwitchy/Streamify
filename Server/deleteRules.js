/**
 * Deletion rules for library songs
 * ================================
 *
 * One question, in one place, because the answer has a data-loss consequence:
 * may this song be deleted, and does the user need to be warned first?
 *
 * Background: songs used to come from uploads, and a folder song was refused
 * outright — Streamify had not put the file there, so removing it was not its
 * business. Downloads broke that assumption. They land in the user's real music
 * folders and are indexed as `source: 'folder'`, so the blanket refusal made
 * every downloaded song permanently undeletable through the UI.
 *
 * The rule now distinguishes by origin rather than by where the file lives:
 *   - Streamify downloaded it  -> deleting is housekeeping, no ceremony.
 *   - Anything else            -> the real file leaves the disk, so the caller
 *                                 must confirm explicitly first.
 *
 * Pure and dependency-free so the route and its tests share one implementation.
 */

/**
 * @param {object|null} song            row from the songs table (needs source)
 * @param {boolean} downloaded          Streamify downloaded this song
 * @param {boolean} confirmed           the caller has confirmed file removal
 * @returns {{ok: boolean, error?: string, code?: string}}
 */
function deleteVerdict({ song, downloaded, confirmed }) {
    if (!song) {
        return { ok: false, error: 'Not found' };
    }

    const needsConfirmation = song.source === 'folder' && !downloaded && !confirmed;
    if (needsConfirmation) {
        return { ok: false, code: 'needs_confirmation' };
    }

    return { ok: true };
}

module.exports = { deleteVerdict };

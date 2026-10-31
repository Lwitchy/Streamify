/* ==========================================================================
 * Listening history (telemetry v2) - client side.
 *
 * One playback = one play_id. While a track plays, the player feeds heard
 * seconds into the tracker; every HEARTBEAT_MS of new listening a cumulative
 * report goes to POST /api/telemetry/playback, and a final report (ended=true,
 * with an end reason) is sent when the playback ends.
 *
 * Final reports are written to a small localStorage outbox before they are
 * sent and removed once the server answers, so plays made offline or cut off
 * by closing the app are delivered on the next launch. The server treats every
 * report as an idempotent upsert, so resending is always safe.
 * ======================================================================== */

(function initStreamifyListening() {
    'use strict';

    const ENDPOINT = '/api/telemetry/playback';
    const OUTBOX_KEY = 'streamify:listening-outbox:v1';
    const HEARTBEAT_MS = 15000;
    const MIN_REPORTED_MS = 1000;   // shorter playbacks are not history
    const OUTBOX_LIMIT = 200;
    const FLUSH_BATCH = 25;

    let current = null;      // the playback in progress
    let flushing = false;
    const inFlight = new Set(); // final reports currently being sent

    function createPlayId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        const bytes = new Uint8Array(16);
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    }

    function detectDevice() {
        if (window.StreamifyEnv && window.StreamifyEnv.isDesktop) return 'desktop';
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' &&
            window.Capacitor.isNativePlatform()) return 'mobile';
        if (/Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '')) return 'mobile';
        return 'web';
    }

    function currentUser() {
        try {
            return (typeof appCache !== 'undefined' && appCache.user && appCache.user.username) || null;
        } catch (e) {
            return null;
        }
    }

    function analyticsDisabled() {
        try {
            return typeof appCache !== 'undefined' && appCache.user && appCache.user.allow_analytics === false;
        } catch (e) {
            return false;
        }
    }

    function isOffline() {
        return !navigator.onLine ||
            Boolean(window.StreamifyOfflineMode) ||
            Boolean(window.StreamifyNetwork && window.StreamifyNetwork.isServerReachable === false);
    }

    /* --- Outbox ---------------------------------------------------------- */

    function readOutbox() {
        try {
            const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function writeOutbox(entries) {
        try {
            if (entries.length === 0) localStorage.removeItem(OUTBOX_KEY);
            else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(-OUTBOX_LIMIT)));
        } catch (e) {
            // Storage full or blocked: the report is simply sent once, best effort.
        }
    }

    function putInOutbox(report) {
        const entries = readOutbox().filter(entry => entry.report.play_id !== report.play_id);
        entries.push({ user: currentUser(), report });
        writeOutbox(entries);
    }

    function removeFromOutbox(playId) {
        writeOutbox(readOutbox().filter(entry => entry.report.play_id !== playId));
    }

    /* --- Transport ------------------------------------------------------- */

    // Resolves 'ok' (delivered or permanently rejected) or 'retry'.
    async function send(report) {
        try {
            const response = await fetch((window.API_BASE_URL || '') + ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(report),
                // Lets the final report of a closing page still reach the server.
                keepalive: true
            });
            if (response.ok) return 'ok';
            // 4xx other than auth/rate-limit means the report itself is unusable.
            if (response.status >= 400 && response.status < 500 &&
                response.status !== 401 && response.status !== 429) return 'ok';
            return 'retry';
        } catch (e) {
            return 'retry';
        }
    }

    async function flushOutbox() {
        if (flushing || isOffline()) return;
        const user = currentUser();
        if (!user) return;
        flushing = true;
        try {
            const pending = readOutbox()
                .filter(entry => (!entry.user || entry.user === user) && !inFlight.has(entry.report.play_id))
                .slice(0, FLUSH_BATCH);
            for (const entry of pending) {
                const playId = entry.report.play_id;
                inFlight.add(playId);
                const result = await send(entry.report);
                inFlight.delete(playId);
                if (result !== 'ok') break;
                removeFromOutbox(playId);
            }
        } finally {
            flushing = false;
        }
    }

    /* --- Playback lifecycle --------------------------------------------- */

    function buildReport(play, ended, endReason) {
        const report = {
            play_id: play.playId,
            song_id: play.songId,
            ms_played: Math.round(play.msPlayed),
            duration_ms: play.durationMs,
            started_at: play.startedAt,
            source_type: play.sourceType,
            source_id: play.sourceId,
            device: play.device,
            ended
        };
        if (ended) report.end_reason = endReason;
        return report;
    }

    function sendHeartbeat(play) {
        if (analyticsDisabled() || isOffline()) return;
        play.lastSentMs = play.msPlayed;
        play.everSent = true;
        send(buildReport(play, false));
    }

    /**
     * Finish the playback in progress. `reason` is one of: completed, next,
     * previous, selected, error, closed.
     */
    function end(reason = 'selected') {
        const play = current;
        current = null;
        if (!play) return;
        if (analyticsDisabled()) return;
        if (play.msPlayed < MIN_REPORTED_MS && !play.everSent) return;

        const report = buildReport(play, true, reason);
        putInOutbox(report);
        if (isOffline()) return;
        inFlight.add(report.play_id);
        send(report).then(result => {
            inFlight.delete(report.play_id);
            if (result === 'ok') {
                removeFromOutbox(report.play_id);
                flushOutbox();
            }
        });
    }

    /**
     * Begin a new playback. Ends the previous one with `previousEndReason`.
     * `context` is { type, id } describing where playback was started.
     */
    function start(songId, context, previousEndReason = 'selected') {
        end(previousEndReason);
        if (songId === undefined || songId === null || songId === '') return;
        const numericId = Number(songId);
        if (!Number.isInteger(numericId) || numericId <= 0) return;

        current = {
            playId: createPlayId(),
            songId: numericId,
            startedAt: Date.now(),
            msPlayed: 0,
            lastSentMs: 0,
            everSent: false,
            durationMs: null,
            sourceType: (context && context.type) || 'unknown',
            sourceId: context && context.id !== undefined && context.id !== null ? String(context.id) : null,
            device: detectDevice()
        };
        flushOutbox();
    }

    /** Begin the same song again (repeat-one), keeping its source. */
    function restart(previousEndReason = 'completed') {
        if (!current) return;
        const { songId, sourceType, sourceId, durationMs } = current;
        start(songId, { type: sourceType, id: sourceId }, previousEndReason);
        // The media element does not reload metadata when it loops in place.
        if (current) current.durationMs = durationMs;
    }

    /** Add heard time, in seconds of normal-speed forward playback. */
    function addPlayed(seconds) {
        if (!current || !(seconds > 0)) return;
        current.msPlayed += seconds * 1000;
        if (current.msPlayed - current.lastSentMs >= HEARTBEAT_MS) sendHeartbeat(current);
    }

    function setDuration(seconds) {
        if (!current || !Number.isFinite(seconds) || seconds <= 0) return;
        current.durationMs = Math.round(seconds * 1000);
    }

    function currentSongId() {
        return current ? current.songId : null;
    }

    window.addEventListener('online', () => { flushOutbox(); });
    window.addEventListener('pagehide', () => { end('closed'); });
    window.addEventListener('beforeunload', () => { end('closed'); });

    // Deliver anything left from an earlier session once the user is known.
    setTimeout(flushOutbox, 5000);

    window.StreamifyListening = Object.freeze({
        start,
        restart,
        end,
        addPlayed,
        setDuration,
        currentSongId,
        flushOutbox
    });
})();

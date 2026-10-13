/* =========================================================================
 * Streamify — Discord Rich Presence (renderer side)
 * =========================================================================
 *
 * Playback state lives here, in the page. Discord's socket lives in the
 * Electron main process. This file is the seam between the two.
 *
 * It is deliberately inert unless three things are all true:
 *
 *   1. we are running inside the desktop app (window.streamifyDesktop exists),
 *   2. the user turned the feature on in Settings → Discord, and
 *   3. something is actually playing.
 *
 * In a browser or on a phone the whole module short-circuits at load, so
 * player.js can call into it unconditionally.
 *
 * WHY THE UPDATES ARE SO SPARSE
 * -----------------------------
 * Discord allows roughly 5 activity updates per 20 seconds. We stay far under
 * that by sending timestamps instead of positions: given a start and an end,
 * Discord draws and animates the progress bar itself. So the only events worth
 * sending are the ones that change the *shape* of the card — a new track, a
 * play, a pause, or a seek. Ordinary playback sends nothing at all.
 * ========================================================================= */

window.StreamifyDiscord = (function () {
    'use strict';

    const STORAGE_KEY = 'streamify_discord_rpc';
    const STORAGE_KEY_ART = 'streamify_discord_rpc_art';
    const STORAGE_KEY_ART_MODE = 'streamify_discord_rpc_art_mode';
    const ARTWORK_MODES = new Set(['app_logo', 'stored_only', 'youtube_exact', 'apple_only', 'best_effort']);

    /** Asset key uploaded in the Discord developer portal; the last resort. */
    const FALLBACK_IMAGE = 'streamify';

    /** A seek fires a burst of events; only the settled position matters. */
    const SEEK_DEBOUNCE_MS = 900;

    const bridge = (window.streamifyDesktop && window.streamifyDesktop.discord) || null;
    const supported = Boolean(bridge);

    /* Last state we were told about, so a settings change or an artwork
     * arrival can rebuild the card without waiting for the next song. */
    let lastTrack = null;      // { songId, title, artist, album, duration }
    let lastPlaying = false;
    let lastPosition = 0;

    /* songId -> resolved public artwork URL, or null when we know there is
     * none. Scoped to the page: the server caches the expensive part. */
    const artworkCache = new Map();
    let artworkRequestId = 0;

    let seekTimer = null;

    /* --- Preferences ------------------------------------------------------ */

    function readFlag(key) {
        try {
            return localStorage.getItem(key) === '1';
        } catch (e) {
            return false; // private mode: treat as off rather than throwing
        }
    }

    function writeFlag(key, value) {
        try {
            localStorage.setItem(key, value ? '1' : '0');
        } catch (e) { /* private mode; the toggle just will not persist */ }
    }

    const isEnabled = () => supported && readFlag(STORAGE_KEY);
    const artworkMode = () => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY_ART_MODE);
            if (ARTWORK_MODES.has(stored)) return stored;
        } catch (e) { /* private mode */ }
        return readFlag(STORAGE_KEY_ART) ? 'best_effort' : 'stored_only';
    };
    const allowsExternalArt = () => ['youtube_exact', 'apple_only', 'best_effort'].includes(artworkMode());

    /* --- Artwork ---------------------------------------------------------- */

    /**
     * Resolves a cover URL Discord can actually load.
     *
     * Local covers are served from a LAN address that Discord's media proxy
     * cannot reach, so the server does the work: it prefers a public origin if
     * one is configured, then the provider URL Smart Auto already stored, then
     * the selected per-device missing-cover policy.
     *
     * Resolves to null when nothing is available, and the caller falls back to
     * the static logo. Never rejects.
     */
    async function resolveArtwork(songId) {
        if (!songId) return null;
        if (artworkCache.has(songId)) return artworkCache.get(songId);

        const query = new URLSearchParams({ songId: String(songId) });
        query.set('mode', artworkMode());

        try {
            const res = await fetch(`${window.API_BASE_URL || ''}/api/discord/artwork?${query}`, {
                credentials: 'include'
            });
            if (!res.ok) {
                /* Do not cache a transient failure as "no artwork". */
                return null;
            }
            const data = await res.json();
            const url = data && typeof data.url === 'string' && data.url ? data.url : null;
            artworkCache.set(songId, url);
            return url;
        } catch (err) {
            console.warn('[DISCORD] Artwork lookup failed:', err);
            return null;
        }
    }

    /* --- Publishing ------------------------------------------------------- */

    function push(activity) {
        if (!bridge) return;
        Promise.resolve(bridge.setActivity(activity)).catch(err => {
            console.warn('[DISCORD] Presence update failed:', err);
        });
    }

    function clear() {
        push(null);
    }

    /**
     * Builds and sends the card for the state we currently believe in.
     *
     * `artwork` is passed in rather than awaited here so the common path — a
     * cache hit — stays synchronous and the card appears instantly.
     */
    function publish(artwork) {
        if (!isEnabled() || !lastPlaying || !lastTrack) {
            clear();
            return;
        }

        const activity = {
            details: lastTrack.title,
            state: lastTrack.artist,
            largeImage: artwork || FALLBACK_IMAGE,
            largeText: lastTrack.album || 'Streamify'
        };

        /* Sending both ends makes Discord render a real progress bar and count
         * down on its own. Without a known duration we send neither, because a
         * lone start timestamp reads as "elapsed", which would keep ticking
         * even while the track is paused. */
        const duration = Number(lastTrack.duration);
        if (Number.isFinite(duration) && duration > 0) {
            const start = Date.now() - Math.max(0, lastPosition) * 1000;
            activity.startTimestamp = start;
            activity.endTimestamp = start + duration * 1000;
        }

        push(activity);
    }

    /** Publishes now with whatever artwork we have, then again if a lookup lands. */
    function publishWithArtwork() {
        if (!isEnabled() || !lastPlaying || !lastTrack) {
            clear();
            return;
        }

        const songId = lastTrack.songId;
        if (artworkCache.has(songId)) {
            publish(artworkCache.get(songId));
            return;
        }

        /* Show the card immediately with the logo; upgrade it when the real
         * cover resolves. Waiting on the network first would leave the card
         * blank for as long as the lookup takes. */
        publish(null);

        const requestId = ++artworkRequestId;
        resolveArtwork(songId).then(url => {
            /* Ignore a slow response for a track we already moved on from. */
            if (requestId !== artworkRequestId) return;
            if (!url || !lastTrack || lastTrack.songId !== songId) return;
            publish(url);
        });
    }

    /* --- Events from player.js -------------------------------------------- */

    const api = {
        /** True only in the desktop app. The settings pane hides itself otherwise. */
        isSupported: () => supported,

        isEnabled,
        allowsExternalArt,
        artworkMode,

        /**
         * Turns presence on or off. Returns a status object, or null when the
         * desktop bridge is absent.
         */
        async setEnabled(enabled) {
            if (!supported) return null;
            writeFlag(STORAGE_KEY, enabled);

            try {
                const status = await bridge.setEnabled(enabled);
                if (enabled) publishWithArtwork();
                return status;
            } catch (err) {
                console.warn('[DISCORD] Could not change the presence state:', err);
                return null;
            }
        },

        /**
         * Consent for internet artwork lookups. Turning it off does not remove
         * covers already resolved this session; turning it on re-checks the
         * current track straight away.
         */
        setArtworkMode(mode) {
            const nextMode = ARTWORK_MODES.has(mode) ? mode : 'stored_only';
            try { localStorage.setItem(STORAGE_KEY_ART_MODE, nextMode); } catch (e) { /* private mode */ }
            writeFlag(STORAGE_KEY_ART, nextMode !== 'stored_only');
            if (lastTrack) artworkCache.delete(lastTrack.songId);
            publishWithArtwork();
        },

        async refreshArtwork() {
            if (!lastTrack || !lastTrack.songId) return false;
            artworkCache.delete(lastTrack.songId);
            try {
                const res = await fetch(`${window.API_BASE_URL || ''}/api/discord/artwork/refresh`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ songId: lastTrack.songId })
                });
                if (!res.ok) return false;
                publishWithArtwork();
                return true;
            } catch (error) {
                return false;
            }
        },

        async getStatus() {
            if (!supported) return null;
            try {
                return await bridge.getStatus();
            } catch (err) {
                return null;
            }
        },

        /** A different song loaded. Called from player.js loadSong(). */
        trackChanged(song) {
            if (!supported || !song) return;

            lastTrack = {
                songId: song.id || null,
                title: song.title || 'Unknown title',
                artist: song.artist || 'Unknown artist',
                album: song.album || '',
                duration: Number(song.duration) || 0
            };
            lastPosition = 0;

            /* loadSong runs before playback starts, so do not claim we are
             * playing yet — the 'play' event will say so a moment later. */
            if (isEnabled() && lastPlaying) publishWithArtwork();
        },

        /**
         * Playback started or stopped, or the position moved.
         * Called from player.js syncPlaybackUI() and after a seek.
         */
        playbackChanged(playing, position, duration) {
            if (!supported) return;

            lastPlaying = Boolean(playing);
            if (Number.isFinite(position)) lastPosition = Math.max(0, position);
            if (Number.isFinite(duration) && duration > 0 && lastTrack) {
                /* Duration is only known once metadata loads, which is usually
                 * after loadSong has already run. */
                lastTrack.duration = duration;
            }

            if (!isEnabled()) return;
            if (!lastPlaying) {
                clear();
                return;
            }
            publishWithArtwork();
        },

        /** The user dragged the progress bar. Debounced: seeks arrive in bursts. */
        seeked(position, duration) {
            if (!supported || !isEnabled()) return;

            clearTimeout(seekTimer);
            seekTimer = setTimeout(() => {
                api.playbackChanged(lastPlaying, position, duration);
            }, SEEK_DEBOUNCE_MS);
        },

        /** Playback ended with nothing queued, or the user logged out. */
        stopped() {
            if (!supported) return;
            lastPlaying = false;
            clear();
        }
    };

    /* Nothing is published until the user opts in, but if they already did on a
     * previous run we reconnect now so the card is ready for the first track. */
    if (supported && readFlag(STORAGE_KEY)) {
        Promise.resolve(bridge.setEnabled(true)).catch(() => { /* Discord may be closed */ });
    }

    /* Closing the app leaves the card up until Discord notices the dropped
     * socket. Clearing on unload makes it disappear immediately. */
    if (supported) {
        window.addEventListener('pagehide', () => {
            if (isEnabled()) clear();
        });
    }

    return api;
})();

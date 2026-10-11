/**
 * ============================================================================
 * STREAMIFY — config.js
 * ============================================================================
 * Shared globals: API base, app-level state, and cache store.
 * Must be loaded FIRST before any other module.
 * ============================================================================
 */

/* --- API Base --- */
window.API_BASE_URL = window.API_BASE_URL || '';

window.getAppScrollContainer = () => {
    const mainContent = document.querySelector('.main-content');
    if (window.matchMedia('(max-width: 768px)').matches) {
        return document.querySelector('.content-container') || mainContent;
    }
    return mainContent;
};

/* ============================================================================
 * ENVIRONMENT CAPABILITIES
 * ============================================================================
 * Streamify runs in three quite different places, and they do NOT have the same
 * browser features available:
 *
 *   1. Desktop app        -> loads from localhost, always a secure context
 *   2. Phone over HTTPS   -> secure context, everything works
 *   3. Phone over HTTP    -> NOT a secure context (this is the tricky one)
 *
 * Browsers restrict a specific set of APIs to secure contexts. `localhost` is
 * always considered secure, but a LAN address such as http://192.168.1.50:4443
 * is not. On such an origin the following silently fail:
 *
 *   - navigator.serviceWorker  -> undefined  (no offline app shell)
 *   - window.caches            -> undefined  (no downloaded songs)
 *   - navigator.wakeLock       -> undefined  (screen sleeps on lyrics view)
 *   - navigator.clipboard      -> undefined  (share buttons break)
 *   - beforeinstallprompt      -> never fires (cannot install as an app)
 *
 * Crucially, playback itself is NOT affected: streaming, seeking, the Web Audio
 * equaliser, IndexedDB and MediaSession lock-screen controls all work fine over
 * plain HTTP. So we degrade honestly rather than pretending things are broken.
 * ========================================================================= */

window.StreamifyEnv = (function () {
    const secure = window.isSecureContext === true;

    const env = {
        /** True on https:// or on localhost/127.0.0.1. */
        isSecure: secure,

        /** True when running inside the Electron desktop shell. */
        isDesktop: typeof window.streamifyDesktop !== 'undefined',

        /** Service workers require a secure context. */
        canUseServiceWorker: secure && 'serviceWorker' in navigator,

        /** Offline downloads need both the Cache Storage API and a worker. */
        canDownloadOffline: secure && 'caches' in window && 'serviceWorker' in navigator,

        /** Screen Wake Lock, used by the lyrics view. */
        canWakeLock: secure && 'wakeLock' in navigator,

        /** Async clipboard. We provide a fallback, so this is informational. */
        canUseAsyncClipboard: secure && !!(navigator.clipboard && navigator.clipboard.writeText),

        /** Installability ("Add to Home Screen") requires a secure context. */
        canInstall: secure,

        /**
         * Whether the page can actually change playback volume.
         *
         * iOS reserves volume for the hardware buttons, so assignments to
         * HTMLMediaElement.volume have no audible effect. An on-screen volume
         * slider is therefore dead UI on every iPhone and iPad.
         *
         * NOTE: the widely-cited feature test (assign 0.5, read it back) is
         * NOT reliable on current iOS — the property retains the value it was
         * given even though nothing happens to playback. So platform detection
         * is the authoritative signal here, with the probe kept only as a
         * secondary check for other locked-down environments.
         *
         * iPadOS reports itself as "MacIntel", hence the touch-point check.
         */
        canControlVolume: (function () {
            const ua = navigator.userAgent || '';
            const isIOS =
                /iPad|iPhone|iPod/.test(ua) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
                (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

            if (isIOS) return false;

            try {
                const probe = document.createElement('audio');
                probe.volume = 0.5;
                return probe.volume === 0.5;
            } catch (e) {
                return false;
            }
        })(),
    };

    // Platform detection for targeted iOS & standalone optimizations
    const ua = navigator.userAgent || '';
    const isIOS =
        /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
        (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

    const isStandalone = !!(
        window.Capacitor ||
        window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    );

    if (document.documentElement) {
        if (!env.canControlVolume) {
            document.documentElement.classList.add('no-volume-control');
        }
        if (isIOS) {
            document.documentElement.classList.add('is-ios');
        }
        if (isStandalone) {
            document.documentElement.classList.add('is-standalone');
            if (isIOS) document.documentElement.classList.add('is-standalone-ios');
        }
        if (window.Capacitor) {
            document.documentElement.classList.add('is-capacitor');
            if (isIOS) document.documentElement.classList.add('is-capacitor-ios');
        }
    }

    /** Human-readable list of what is unavailable, for UI messaging. */
    env.missingFeatures = function () {
        const missing = [];
        if (!env.canDownloadOffline) missing.push('Offline downloads');
        if (!env.canInstall) missing.push('Installing to your home screen');
        if (!env.canWakeLock) missing.push('Keeping the screen awake for lyrics');
        return missing;
    };

    return env;
})();

/* --- Clipboard with an insecure-context fallback ---------------------------
 * navigator.clipboard is unavailable over plain HTTP, which breaks every share
 * button on a phone. The legacy execCommand('copy') path still works there, so
 * we transparently fall back to it instead of failing.
 * Returns a Promise<boolean>. ------------------------------------------------ */
window.copyToClipboard = async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            /* fall through to the legacy path */
        }
    }

    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        // Keep it off-screen and non-disruptive; iOS needs it focusable.
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);

        ta.select();
        ta.setSelectionRange(0, ta.value.length); // iOS Safari
        const ok = document.execCommand('copy');

        document.body.removeChild(ta);
        return ok;
    } catch (err) {
        console.warn('[CLIPBOARD] Copy failed:', err);
        return false;
    }
};

/* --- Insecure-context notice ----------------------------------------------
 * Shown once (dismissible, remembered) when the user is on a LAN HTTP origin.
 * Silent on the desktop app and on HTTPS. The goal is that a missing feature is
 * never mysterious — the user is told exactly why and how to fix it. --------- */
window.initInsecureContextNotice = function initInsecureContextNotice() {
    const env = window.StreamifyEnv;
    if (env.isSecure || env.isDesktop) return;
    try {
        if (localStorage.getItem('streamify_insecure_notice_dismissed') === '1') return;
    } catch (e) { /* private mode */ }

    const banner = document.createElement('div');
    banner.id = 'insecure-context-banner';
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:99999',
        'background:#2a2113', 'border-top:1px solid rgba(240,160,32,.45)',
        'color:#f5c877', 'padding:11px 16px',
        'font:13px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif',
        'display:flex', 'gap:12px', 'align-items:flex-start',
        'box-shadow:0 -4px 18px rgba(0,0,0,.4)',
    ].join(';');

    const missing = env.missingFeatures();
    banner.innerHTML =
        '<div style="flex:1">' +
            '<strong style="color:#ffce7a">Limited mode &mdash; insecure connection</strong><br>' +
            'Music plays normally, but your browser disables these over plain HTTP:' +
            '<br>&bull; ' + missing.join('<br>&bull; ') +
            '<br><span style="opacity:.85">Ask the server owner to enable HTTPS to unlock them.</span>' +
        '</div>' +
        '<button type="button" style="background:transparent;border:1px solid rgba(245,200,119,.5);' +
        'color:#f5c877;border-radius:6px;padding:5px 11px;cursor:pointer;flex-shrink:0">Got it</button>';

    banner.querySelector('button').addEventListener('click', () => {
        try { localStorage.setItem('streamify_insecure_notice_dismissed', '1'); } catch (e) {}
        banner.remove();
    });

    document.body.appendChild(banner);
};

/* --- Playback State --- */
let isPlaying = false;   // Current playback status
let currentPlaylist = [];      // Array of song objects in current view
let shuffledPlaylist = [];      // Shuffled index order
let currentIndex = -1;      // Current position in the playlist
let activePlaylist = [];       // Frozen snapshot of the playlist being actively played (survives view changes)
let activeShuffledPlaylist = []; // Shuffled order for the active playlist snapshot
let isShuffle = false;   // Shuffle mode toggle
let repeatMode = 0;       // 0: Off | 1: Repeat All | 2: Repeat One
let currentActiveView = 'library'; // Active view (library | upload)

/* --- In-Memory Cache --- */
const appCache = {
    trending: null,
    library: null,
    user: null,
    playlists: null,
    playlistDetails: {},
    playlistDetailsTime: {},
    trendingTime: 0,
    libraryTime: 0,
    userTime: 0,
    playlistsTime: 0,
};

const CACHE_DURATION = 120 * 1000; // 2 minutes

/* --- Toast Notification System --- */
function showToast(message, type = 'error', duration = 3500) {
    let container = document.getElementById('toast-container');
    if (!container && document.body) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
    }
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
window.showToast = showToast;

/* --- Cover Art Fallback --- */
/* Inline gradient SVG shown while cover lookup runs. It follows the selected
   palette without making another network request. */
function createCoverPlaceholder() {
    const styles = getComputedStyle(document.documentElement);
    const gradient1 = styles.getPropertyValue('--gradient-1').trim() || '#4169e1';
    const gradient2 = styles.getPropertyValue('--gradient-2').trim() || '#8164d7';
    const foreground = styles.getPropertyValue('--on-gradient').trim() || '#ffffff';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${gradient1}"/><stop offset="1" stop-color="${gradient2}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><text x="100" y="125" font-size="80" text-anchor="middle" fill="${foreground}" fill-opacity="0.42">&#9834;</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let COVER_PLACEHOLDER = createCoverPlaceholder();

window.addEventListener('streamifythemechange', () => {
    const previousPlaceholder = COVER_PLACEHOLDER;
    COVER_PLACEHOLDER = createCoverPlaceholder();
    document.querySelectorAll('img').forEach(image => {
        if (image.src === previousPlaceholder || image.getAttribute('src') === previousPlaceholder) {
            image.src = COVER_PLACEHOLDER;
        }
    });
});

function safeImageURL(value, fallback = '') {
    if (value === COVER_PLACEHOLDER) return value;
    if (typeof value !== 'string' || !value.trim()) return fallback;

    try {
        const parsed = new URL(value, window.location.origin);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : fallback;
    } catch (err) {
        return fallback;
    }
}
window.safeImageURL = safeImageURL;

/* --- Shared Helpers --- */
function escapeHTML(str) {
    if (!str) return "";
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getQualityBadgeHTML(song) {
    if (!song) return '';
    let bitrate = Number(song.bitrate);
    if (!Number.isFinite(bitrate) || bitrate <= 0) bitrate = 0;
    if (bitrate && bitrate > 1000) {
        bitrate = Math.round(bitrate / 1000);
    }
    let extension = typeof song.extension === 'string' ? song.extension : '';
    
    if (!bitrate && !extension.toLowerCase().includes('flac')) {
        bitrate = 128; 
    }
    
    const isFlac = (extension && extension.toLowerCase().includes('flac'));
    const label = isFlac ? 'FLAC' : `${bitrate}kbps`;
    
    return `<span class="artist-separator"></span><span class="quality-badge">${label}</span>`;
}

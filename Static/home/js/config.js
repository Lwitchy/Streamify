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

/* --- App Limits --- */
window.YOUTUBE_LIMIT_MAX = 2; // Default fallback
window.YOUTUBE_LIMIT_DURATION = 600; // Default fallback

/* --- Configuration Sync --- */
/**
 * Safely syncs frontend limits with the server's config.json.
 * This is called by modules like upload.js or admin.js after initial load.
 */
window.syncConfigWithServer = async () => {
    try {
        const res = await fetch('/api/config/public');
        const cfg = await res.json();
        if (cfg.youtube_max) window.YOUTUBE_LIMIT_MAX = cfg.youtube_max;
        if (cfg.youtube_duration) window.YOUTUBE_LIMIT_DURATION = cfg.youtube_duration;
        console.log('[CONFIG] Synchronized with server:', cfg);
    } catch (err) {
        console.warn('[CONFIG] Failed to sync with server, using defaults.', err);
    }
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
let currentActiveView = 'feed'; // Active view (feed | library | people | upload)

/* --- In-Memory Cache --- */
const appCache = {
    trending: null,
    library: null,
    user: null,
    people: null,
    playlists: null,
    playlistDetails: {},
    playlistDetailsTime: {},
    dmContacts: null,
    dmUnreadCount: 0,
    trendingTime: 0,
    libraryTime: 0,
    userTime: 0,
    peopleTime: 0,
    playlistsTime: 0,
    dmContactsTime: 0
};

const CACHE_DURATION = 120 * 1000; // 2 minutes

/* --- Toast Notification System --- */
function showToast(message, type = 'error', duration = 3500) {
    const container = document.getElementById('toast-container');
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
/* Inline gradient SVG — shown instantly while iTunes lookup runs (no external request) */
const COVER_PLACEHOLDER = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234169e1'/%3E%3Cstop offset='1' stop-color='%238b5cf6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='200' height='200' fill='url(%23g)'/%3E%3Ctext x='100' y='125' font-size='80' text-anchor='middle' fill='rgba(255,255,255,0.35)'%3E%E2%99%AA%3C/text%3E%3C/svg%3E`;

/* --- Shared Helpers --- */
function escapeHTML(str) {
    if (!str) return "";
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getQualityBadgeHTML(song) {
    if (!song) return '';
    let bitrate = song.bitrate;
    let extension = song.extension || '';
    
    if (!bitrate && !extension.toLowerCase().includes('flac')) {
        bitrate = 128; 
    }
    
    const isFlac = (extension && extension.toLowerCase().includes('flac'));
    const label = isFlac ? 'FLAC' : `${bitrate}kbps`;
    
    return `<span class="artist-separator"></span><span class="quality-badge">${label}</span>`;
}

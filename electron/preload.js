/**
 * Streamify Desktop — preload bridge
 *
 * Runs with contextIsolation enabled, so the page cannot reach Node. Only the
 * handful of functions below are exposed, on `window.streamifyDesktop`.
 *
 * The web frontend must treat this object as OPTIONAL — it is undefined in a
 * normal browser and on phones. Feature-detect, never assume:
 *
 *     if (window.streamifyDesktop) { ... }
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('streamifyDesktop', {
    /** Marker for feature detection. */
    isDesktop: true,

    /** Electron app version. */
    version: () => ipcRenderer.invoke('streamify:getConnectionInfo').then(i => i.version),

    /**
     * LAN URLs, QR code data URL, and whether the transport is secure.
     * Used by the "Connect your phone" window.
     */
    getConnectionInfo: () => ipcRenderer.invoke('streamify:getConnectionInfo'),

    /**
     * Opens a native directory picker and resolves to the chosen absolute path,
     * or null if the user cancelled. Used to replace the OOBE wizard's
     * type-the-path-by-hand input when running on desktop.
     */
    pickFolder: (opts) => ipcRenderer.invoke('streamify:pickFolder', opts),

    /** Opens a URL in the system browser. */
    openExternal: (url) => ipcRenderer.invoke('streamify:openExternal', url),

    /**
     * Discord Rich Presence.
     *
     * Only reachable from the desktop app: Discord's RPC runs over a local
     * socket that needs Node, which the sandboxed renderer does not have. The
     * page therefore describes what is playing and the main process decides
     * whether and how to publish it.
     *
     * Every call resolves to a status object:
     *   { enabled, connected, connecting, configured, user, error }
     */
    discord: {
        /**
         * Publishes what is playing, or clears the card when passed null.
         * Shape: { details, state, largeImage, largeText,
         *          startTimestamp, endTimestamp }
         */
        setActivity: (activity) => ipcRenderer.invoke('streamify:discord:setActivity', activity),

        /** Opts in or out. Disabling clears the card and drops the socket. */
        setEnabled: (enabled) => ipcRenderer.invoke('streamify:discord:setEnabled', enabled === true),

        /** Polled by the settings pane so a silent failure stays visible. */
        getStatus: () => ipcRenderer.invoke('streamify:discord:getStatus'),
    },

    /**
     * Auto-update.
     *
     * Reads and actions only. The on/off switch itself is server state that
     * only the Owner may change, so it is written through
     * POST /api/settings/updates and never through this bridge — otherwise any
     * logged-in user on this machine could flip a server-wide setting.
     * refreshPolicy() merely re-reads what the server already stored.
     *
     * Every call resolves to a status object:
     *   { supported, unsupportedReason, enabled, currentVersion, state,
     *     latestVersion, releaseNotes, releaseUrl, releasesUrl, percent,
     *     error, lastCheckedAt }
     */
    updates: {
        /** Current status, safe to call in a browser-shaped code path. */
        getStatus: () => ipcRenderer.invoke('streamify:updates:getStatus'),

        /** Asks GitHub now. Never downloads unless auto-update is enabled. */
        check: () => ipcRenderer.invoke('streamify:updates:check'),

        /** Downloads an already-detected update on demand. */
        download: () => ipcRenderer.invoke('streamify:updates:download'),

        /** Shuts the server down, then runs the installer and restarts. */
        install: () => ipcRenderer.invoke('streamify:updates:install'),

        /** Re-reads the Owner switch after the settings pane changed it. */
        refreshPolicy: () => ipcRenderer.invoke('streamify:updates:refreshPolicy'),

        /**
         * Subscribes to pushed status changes (download progress, and the
         * moment an update becomes ready to install).
         * Returns an unsubscribe function.
         */
        onState: (callback) => {
            if (typeof callback !== 'function') return () => {};
            // The Electron event object is deliberately not forwarded: it
            // carries a live sender reference that must not reach the page.
            const listener = (_event, status) => callback(status);
            ipcRenderer.on('streamify:updates:state', listener);
            return () => ipcRenderer.removeListener('streamify:updates:state', listener);
        },
    },
});

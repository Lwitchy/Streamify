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
});

const { contextBridge, ipcRenderer } = require('electron');

// The companion window only needs connection details; filesystem and shell
// capabilities remain exclusive to the trusted main application window.
contextBridge.exposeInMainWorld('streamifyDesktop', {
    getConnectionInfo: () => ipcRenderer.invoke('streamify:getConnectionInfo'),
});

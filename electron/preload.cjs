// Context-isolated bridge: exposes a tiny, safe API to the renderer (window.electron).
// The renderer can ask the main process to open a native file dialog and gets back the
// chosen absolute path — which it feeds into window.pepResolveNativeFilePath().
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  showOpenDialog: () => ipcRenderer.invoke('dialog:openVideo'),
});

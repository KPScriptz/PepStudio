// Context-isolated bridge: exposes a tiny, safe API to the renderer (window.electron).
// The renderer can ask the main process to open a native file dialog and gets back the
// chosen absolute path — which it feeds into window.pepResolveNativeFilePath().
//
// Everything here is a NARROW, named channel. The renderer never gets ipcRenderer itself, so a
// compromised page can't invoke arbitrary main-process handlers.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  showOpenDialog: () => ipcRenderer.invoke('dialog:openVideo'),

  // Native desktop integration. Each resolves to a harmless default off-platform, so the renderer
  // can call them unconditionally and never needs to branch on the OS itself.
  platform: () => ipcRenderer.invoke('sys:platform'),
  accentColor: () => ipcRenderer.invoke('sys:accent'),
  // 0..1 to show determinate progress on the Dock/taskbar, -1 to clear.
  setProgress: (v) => ipcRenderer.invoke('sys:progress', v),
  notify: (title, body) => ipcRenderer.invoke('sys:notify', { title, body }),

  // Confessional Booth. openBooth() raises the recorder window (asking macOS for camera/mic
  // access first); sendToStudio() hands a finished take to the editor window, opening one if the
  // app was launched booth-only.
  openBooth: () => ipcRenderer.invoke('booth:open'),
  sendToStudio: (filePath) => ipcRenderer.invoke('booth:send', filePath),
});

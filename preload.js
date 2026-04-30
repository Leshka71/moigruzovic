const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  load:          ()  => ipcRenderer.invoke('load'),
  save:          (d) => ipcRenderer.invoke('save', d),
  reset:         ()  => ipcRenderer.invoke('reset'),
  minimize:      ()  => ipcRenderer.send('win-minimize'),
  maximize:      ()  => ipcRenderer.send('win-maximize'),
  close:         ()  => ipcRenderer.send('win-close'),
  startDownload: ()  => ipcRenderer.send('start-download'),
  installUpdate: ()  => ipcRenderer.send('install-update'),
  setAutotrip:   (d) => ipcRenderer.invoke('set-autotrip', d),
  getAutotrip:   ()  => ipcRenderer.invoke('get-autotrip'),
  onAutoTrip:    (cb) => ipcRenderer.on('auto-trip',    (_, d) => cb(d)),
  onAutoExpense: (cb) => ipcRenderer.on('auto-expense', (_, d) => cb(d)),
  onConfigLoaded:(cb) => ipcRenderer.on('config-loaded',(_, d) => cb(d)),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available',  (_, i) => cb(i)),
  onDownloadProgress:(cb) => ipcRenderer.on('download-progress', (_, p) => cb(p)),
  onUpdateDownloaded:(cb) => ipcRenderer.on('update-downloaded', () => cb()),
});

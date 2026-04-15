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
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, info) => cb(info)),
  onDownloadProgress:(cb) => ipcRenderer.on('download-progress', (_, pct) => cb(pct)),
  onUpdateDownloaded:(cb) => ipcRenderer.on('update-downloaded', () => cb()),
});

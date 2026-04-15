const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const DATA_DIR = path.join(app.getPath('userData'), 'truckdata');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile() { return path.join(DATA_DIR, 'default.json'); }

let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 540, height: 860,
    minWidth: 420, minHeight: 640,
    frame: false,
    backgroundColor: '#0d0d11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin.loadFile('index.html');

  ipcMain.on('win-minimize', () => mainWin.minimize());
  ipcMain.on('win-maximize', () => mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
  ipcMain.on('win-close', () => mainWin.close());
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall());

  // Check for updates after window loads
  mainWin.webContents.on('did-finish-load', () => {
    autoUpdater.checkForUpdates().catch(() => {});
  });
}

// Auto updater events
autoUpdater.autoDownload = false;

autoUpdater.on('update-available', (info) => {
  if (mainWin) {
    mainWin.webContents.send('update-available', info);
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWin) {
    mainWin.webContents.send('download-progress', Math.round(progress.percent));
  }
});

autoUpdater.on('update-downloaded', () => {
  if (mainWin) {
    mainWin.webContents.send('update-downloaded');
  }
});

ipcMain.on('start-download', () => {
  autoUpdater.downloadUpdate();
});

ipcMain.handle('load', () => {
  const df = dataFile();
  const data = fs.existsSync(df) ? JSON.parse(fs.readFileSync(df, 'utf8')) : { trips: [], expenses: [] };
  return { ok: true, data };
});

ipcMain.handle('save', (_, { data }) => {
  fs.writeFileSync(dataFile(), JSON.stringify(data), 'utf8');
  return { ok: true };
});

ipcMain.handle('reset', () => {
  fs.writeFileSync(dataFile(), JSON.stringify({ trips: [], expenses: [] }), 'utf8');
  return { ok: true };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

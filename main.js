const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const iconv = require('iconv-lite');

const DATA_DIR = path.join(app.getPath('userData'), 'truckdata');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile()    { return path.join(DATA_DIR, 'default.json'); }
function configFile()  { return path.join(DATA_DIR, 'config.json'); }

let mainWin = null;
let chatWatcher = null;
let chatLastSize = 0;
let autoTripEnabled = false;
let chatlogPath = '';

// Auto-detect chatlog path
function detectChatlogPath() {
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(userProfile, 'Documents', 'RADMIR CRMP User Files', 'SAMP', 'chatlog.txt'),
    path.join(userProfile, 'Documents', 'GTA San Andreas User Files', 'SAMP', 'chatlog.txt'),
    path.join(userProfile, 'Documents', 'SAMP', 'chatlog.txt'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

// ── config helpers ──────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(configFile())) return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch(e) {}
  return { chatlogPath: '', autoTripEnabled: false };
}
function saveConfig(cfg) {
  fs.writeFileSync(configFile(), JSON.stringify(cfg), 'utf8');
}

// ── chatlog parser ──────────────────────────────────────────────────────────
// Strips SAMP color codes like {FF0000}
function stripColors(s) { return s.replace(/\{[0-9a-fA-F]{6}\}/g, ''); }

// Parse new bytes appended to chatlog
// Collect pending lines by timestamp to match delivery + commission
const pendingLines = {};

function parseNewLines(newText) {
  const lines = newText.split('\n');
  for (const raw of lines) {
    const line = stripColors(raw).replace(/\r/g, '').trim();
    if (!line) continue;

    // Extract timestamp
    const mTime = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
    if (!mTime) continue;
    const time = mTime[1];
    const body = mTime[2];

    // Commission line - store it
    const mCom = body.match(/Комиссия.*?:\s*([\d\s]+)\s*руб/);
    if (mCom) {
      if (!pendingLines[time]) pendingLines[time] = {};
      pendingLines[time].commission = parseInt(mCom[1].replace(/\s/g,''), 10);
      tryEmit(time);
      continue;
    }

    // Delivery line - all variants:
    // 1. "доставили X ед. товара предприятию «Name», и получили Y руб."
    // 2. "доставили X ед. материалов стройке, и получили за работу Y руб."
    // 3. "доставили X л. топлива заводу, и получили за работу Y руб."
    // 4. "доставили X ед. нефти ..., и получили Y руб."
    const mDel = body.match(/доставил[иа].*?(?:получили?(?:\s+за\s+работу)?)\s+([\d\s]+)\s*руб/);
    if (mDel) {
      const pay = parseInt(mDel[1].replace(/\s/g,''), 10);
      if (!pay || pay <= 0) continue;

      // Extract note
      let note = '';
      const mEnt = body.match(/предприятию\s+.([^,]+?).,/);
      if (mEnt) note = mEnt[1];
      else if (body.includes('стройке')) note = 'Стройка';
      else if (body.includes('заводу')) note = 'Завод';
      else if (body.includes('нефт')) note = 'Нефть';
      else if (body.includes('топлив')) note = 'Топливо';

      if (!pendingLines[time]) pendingLines[time] = {};
      pendingLines[time].pay  = pay;
      pendingLines[time].note = note;
      pendingLines[time].time = time;
      tryEmit(time);
    }
  }
}

function tryEmit(time) {
  const p = pendingLines[time];
  if (!p || !p.pay) return; // wait for delivery line
  const commission = p.commission || 0;
  const net = p.pay - commission;
  const now = new Date();
  const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  if (mainWin) {
    mainWin.webContents.send('auto-trip', { pay: net, time: p.time||time, date, note: p.note||'', commission });
  }
  delete pendingLines[time];
}

// Start watching chatlog
function startChatWatch(filePath) {
  if (chatWatcher) { chatWatcher.close(); chatWatcher = null; }
  if (!filePath || !fs.existsSync(filePath)) return;

  chatLastSize = fs.statSync(filePath).size;

  chatWatcher = fs.watch(filePath, { persistent: true }, (event) => {
    if (event !== 'change') return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= chatLastSize) return;
      const buf = Buffer.alloc(stat.size - chatLastSize);
      const fd  = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, chatLastSize);
      fs.closeSync(fd);
      chatLastSize = stat.size;
      const text = iconv.decode(buf, 'cp1251');
      parseNewLines(text);
    } catch(e) {}
  });
}

function stopChatWatch() {
  if (chatWatcher) { chatWatcher.close(); chatWatcher = null; }
}

// ── window ──────────────────────────────────────────────────────────────────
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
  ipcMain.on('win-close',    () => mainWin.close());
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall());
  ipcMain.on('start-download', () => autoUpdater.downloadUpdate());

  mainWin.webContents.on('did-finish-load', () => {
    autoUpdater.checkForUpdates().catch(() => {});
    // send saved config to renderer
    const cfg = loadConfig();
    mainWin.webContents.send('config-loaded', cfg);
    if (cfg.autoTripEnabled) {
      autoTripEnabled = true;
      chatlogPath = cfg.chatlogPath || detectChatlogPath();
      if (chatlogPath) startChatWatch(chatlogPath);
    }
  });
}

// ── IPC: auto-trip settings ─────────────────────────────────────────────────
ipcMain.handle('pick-chatlog', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWin, {
    title: 'Выбери chatlog.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { ok: false };
  return { ok: true, path: filePaths[0] };
});

ipcMain.handle('set-autotrip', (_, { enabled, filePath }) => {
  autoTripEnabled = enabled;
  chatlogPath = filePath || detectChatlogPath();
  const cfg = loadConfig();
  cfg.autoTripEnabled  = enabled;
  cfg.chatlogPath      = chatlogPath;
  saveConfig(cfg);
  if (enabled && chatlogPath) startChatWatch(chatlogPath);
  else stopChatWatch();
  return { ok: true };
});

ipcMain.handle('get-autotrip', () => {
  const cfg = loadConfig();
  return { enabled: cfg.autoTripEnabled, filePath: cfg.chatlogPath };
});

// ── IPC: data ───────────────────────────────────────────────────────────────
ipcMain.handle('load', () => {
  const df   = dataFile();
  const data = fs.existsSync(df) ? JSON.parse(fs.readFileSync(df, 'utf8')) : { trips: [], expenses: [] };
  return { ok: true, data };
});
ipcMain.handle('save',  (_, { data }) => { fs.writeFileSync(dataFile(), JSON.stringify(data), 'utf8'); return { ok: true }; });
ipcMain.handle('reset', () => { fs.writeFileSync(dataFile(), JSON.stringify({ trips: [], expenses: [] }), 'utf8'); return { ok: true }; });

// ── auto-updater ─────────────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.on('update-available',  (info)     => mainWin && mainWin.webContents.send('update-available',  info));
autoUpdater.on('download-progress', (progress) => mainWin && mainWin.webContents.send('download-progress', Math.round(progress.percent)));
autoUpdater.on('update-downloaded', ()         => mainWin && mainWin.webContents.send('update-downloaded'));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

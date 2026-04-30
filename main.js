const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const iconv = require('iconv-lite');

const DATA_DIR = path.join(app.getPath('userData'), 'truckdata');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile()   { return path.join(DATA_DIR, 'default.json'); }
function configFile() { return path.join(DATA_DIR, 'config.json'); }

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

// Config
function loadConfig() {
  try { if (fs.existsSync(configFile())) return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch(e) {}
  return { chatlogPath: '', autoTripEnabled: false };
}
function saveConfig(cfg) { fs.writeFileSync(configFile(), JSON.stringify(cfg), 'utf8'); }

// Strip SAMP color codes
function stripColors(s) { return s.replace(/\{[0-9a-fA-F]{6}\}/g, ''); }

// Deduplication - remember last 100 emitted events
const emittedKeys = new Set();
function isDuplicate(key) {
  if (emittedKeys.has(key)) return true;
  emittedKeys.add(key);
  if (emittedKeys.size > 100) {
    const first = emittedKeys.values().next().value;
    emittedKeys.delete(first);
  }
  return false;
}

// Pending lines for trip+commission matching
const pendingLines = {};

function parseNewLines(newText) {
  const lines = newText.split('\n');
  for (const raw of lines) {
    const line = stripColors(raw).replace(/\r/g, '').trim();
    if (!line) continue;

    const mTime = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
    if (!mTime) continue;
    const time = mTime[1];
    const body = mTime[2];

    // Fuel start - could trigger fuel watch in future
    if (body.includes('Заправка начата')) continue;

    // Commission line
    const mCom = body.match(/Комиссия.*?:\s*([\d\s]+)\s*руб/);
    if (mCom) {
      if (!pendingLines[time]) pendingLines[time] = {};
      pendingLines[time].commission = parseInt(mCom[1].replace(/\s/g,''), 10);
      tryEmit(time);
      continue;
    }

    // Delivery line - pay already excludes commission
    const mDel = body.match(/доставил[иа].*?(?:получили?(?:\s+за\s+работу)?)\s+([\d\s]+)\s*руб/);
    if (mDel) {
      const pay = parseInt(mDel[1].replace(/\s/g,''), 10);
      if (!pay || pay <= 0) continue;
      let note = '';
      const mEnt = body.match(/предприятию\s+.([^»'"]+?)[»'"]/);
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
      continue;
    }

    // Tire replacement: "заменил вам [позиция] шину за NNNN руб"
    const mTire = body.match(/заменил вам (.+?)шину за ([\d\s]+)\s*руб(?!\. Сезон)/i);
    if (mTire) {
      const pos = mTire[1].trim();
      const amount = parseInt(mTire[2].replace(/\s/g,''), 10);
      if (amount > 0 && mainWin) {
        const now = new Date();
        const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
        const key = 'tire:' + date + ':' + amount + ':' + pos;
        if (!isDuplicate(key)) mainWin.webContents.send('auto-expense', { amount, date, time, desc: 'СТО — Шина ' + pos, cat: '⚙️ СТО' });
      }
      continue;
    }

    // Oil/filter: "Автомеханик заменил моторное масло/воздушный фильтр ... за NNNN руб"
    const mOil = body.match(/заменил\s+(моторное масло|воздушный фильтр).+?за\s+([\d\s]+)\s*руб/i);
    if (mOil) {
      const item = mOil[1].toLowerCase().includes('масло') ? 'Замена масла' : 'Замена фильтра';
      const amount = parseInt(mOil[2].replace(/\s/g,''), 10);
      if (amount > 0 && mainWin) {
        const now = new Date();
        const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
        const key = 'oil:' + date + ':' + amount + ':' + item;
        if (!isDuplicate(key)) mainWin.webContents.send('auto-expense', { amount, date, time, desc: 'СТО — ' + item, cat: '⚙️ СТО' });
      }
      continue;
    }

    // Wear removal: "убрал N процентов износа ... за NNNN руб"
    const mWear = body.match(/убрал\s+(\d+)\s+процент.*?износа.+?за\s+([\d\s]+)\s*руб/i);
    if (mWear) {
      const pct = mWear[1];
      const amount = parseInt(mWear[2].replace(/\s/g,''), 10);
      if (amount > 0 && mainWin) {
        const now = new Date();
        const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
        const key = 'wear:' + date + ':' + amount + ':' + pct;
        if (!isDuplicate(key)) mainWin.webContents.send('auto-expense', { amount, date, time, desc: 'СТО — износ -' + pct + '%', cat: '⚙️ СТО' });
      }
      continue;
    }

    // TK repair: "отремонтировал N% компонента 'Y' за NNNN руб"
    const mRepair = body.match(/отремонтировал\s+(\d+)%\s+компонента\s+'(.+?)'\s+за\s+([\d\s]+)\s*руб/i);
    if (mRepair) {
      const pct = mRepair[1];
      const component = mRepair[2];
      const amount = parseInt(mRepair[3].replace(/\s/g,''), 10);
      if (amount > 0 && mainWin) {
        const now = new Date();
        const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
        const key = 'repair:' + date + ':' + amount + ':' + component;
        if (!isDuplicate(key)) mainWin.webContents.send('auto-expense', { amount, date, time, desc: 'ТК — ' + component + ' +' + pct + '%', cat: '🏢 ТК' });
      }
      continue;
    }

    // Fine: "оплатили все свои штрафы на сумму NNNN руб"
    const mFine = body.match(/оплатили все свои штрафы на сумму\s+([\d\s]+)\s*руб/);
    if (mFine) {
      const amount = parseInt(mFine[1].replace(/\s/g,''), 10);
      if (amount > 0 && mainWin) {
        const now = new Date();
        const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
        const key = 'fine:' + date + ':' + time + ':' + amount;
        if (!isDuplicate(key)) mainWin.webContents.send('auto-expense', { amount, date, time, desc: 'Штрафы', cat: '💳 Штраф' });
      }
      continue;
    }
  }
}

function tryEmit(time) {
  const p = pendingLines[time];
  if (!p || !p.pay) return;
  // pay already excludes commission - record as is
  const pay = p.pay;
  const now = new Date();
  const date = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  const key = 'trip:' + date + ':' + pay + ':' + (p.note||'');
  if (!isDuplicate(key) && mainWin) {
    mainWin.webContents.send('auto-trip', { pay, time: p.time||time, date, note: p.note||'' });
  }
  delete pendingLines[time];
}

function startChatWatch(filePath) {
  if (chatWatcher) { chatWatcher.close(); chatWatcher = null; }
  if (!filePath || !fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  // Read last 5KB to catch recent events
  const lookback = Math.min(5000, stat.size);
  if (lookback > 0) {
    const buf = Buffer.alloc(lookback);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, lookback, stat.size - lookback);
    fs.closeSync(fd);
    parseNewLines(iconv.decode(buf, 'cp1251'));
  }
  chatLastSize = stat.size;

  function readNewChunk() {
    try {
      const s = fs.statSync(filePath);
      if (s.size <= chatLastSize) return;
      const buf = Buffer.alloc(s.size - chatLastSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, chatLastSize);
      fs.closeSync(fd);
      chatLastSize = s.size;
      parseNewLines(iconv.decode(buf, 'cp1251'));
    } catch(e) {}
  }

  let readTimer = null;
  chatWatcher = fs.watch(filePath, { persistent: true }, (event) => {
    if (event !== 'change') return;
    if (readTimer) clearTimeout(readTimer);
    readTimer = setTimeout(readNewChunk, 5000);
  });

  // Fallback: check every 10 seconds in case fs.watch misses events
  const fallbackInterval = setInterval(readNewChunk, 10000);
  chatWatcher._fallback = fallbackInterval;
}

function stopChatWatch() {
  if (chatWatcher) {
    if (chatWatcher._fallback) clearInterval(chatWatcher._fallback);
    chatWatcher.close();
    chatWatcher = null;
  }
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 540, height: 860, minWidth: 420, minHeight: 640,
    frame: false, backgroundColor: '#0d0d11',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWin.loadFile('index.html');
  ipcMain.on('win-minimize', () => mainWin.minimize());
  ipcMain.on('win-maximize', () => mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
  ipcMain.on('win-close',    () => mainWin.close());
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall());
  ipcMain.on('start-download', () => autoUpdater.downloadUpdate());
  mainWin.webContents.on('did-finish-load', () => {
    autoUpdater.checkForUpdates().catch(() => {});
    const cfg = loadConfig();
    mainWin.webContents.send('config-loaded', cfg);
    // Always start chatlog watch if path found
    autoTripEnabled = cfg.autoTripEnabled || false;
    chatlogPath = cfg.chatlogPath || detectChatlogPath();
    if (chatlogPath) startChatWatch(chatlogPath);
  });
}

ipcMain.handle('set-autotrip', (_, { enabled, filePath }) => {
  autoTripEnabled = enabled;
  chatlogPath = filePath || detectChatlogPath();
  const cfg = loadConfig();
  cfg.autoTripEnabled = enabled;
  cfg.chatlogPath = chatlogPath;
  saveConfig(cfg);
  if (enabled && chatlogPath) startChatWatch(chatlogPath);
  else stopChatWatch();
  return { ok: true };
});
ipcMain.handle('get-autotrip', () => { const cfg = loadConfig(); return { enabled: cfg.autoTripEnabled, filePath: cfg.chatlogPath }; });
ipcMain.handle('load', () => { const df = dataFile(); return { ok: true, data: fs.existsSync(df) ? JSON.parse(fs.readFileSync(df,'utf8')) : {trips:[],expenses:[]} }; });
ipcMain.handle('save', (_, { data }) => { fs.writeFileSync(dataFile(), JSON.stringify(data), 'utf8'); return { ok: true }; });
ipcMain.handle('reset', () => { fs.writeFileSync(dataFile(), JSON.stringify({trips:[],expenses:[]}), 'utf8'); return { ok: true }; });

autoUpdater.autoDownload = false;
autoUpdater.on('update-available',  (info) => mainWin && mainWin.webContents.send('update-available', info));
autoUpdater.on('download-progress', (p)    => mainWin && mainWin.webContents.send('download-progress', Math.round(p.percent)));
autoUpdater.on('update-downloaded', ()     => mainWin && mainWin.webContents.send('update-downloaded'));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

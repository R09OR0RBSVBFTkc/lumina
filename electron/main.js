/* Lumina Electron 主进程 */
const { app, BrowserWindow, ipcMain, dialog, screen, clipboard, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow = null;
let stageWindow = null;

// 若环境里设了 ELECTRON_RUN_AS_NODE，Electron 会退化成纯 Node，require('electron') 不再返回 API，
// 表现为"双击后窗口一闪即退"。这里给出明确原因，避免变成难以定位的 TypeError。
if (!app || typeof app.whenReady !== 'function') {
  console.error('[Lumina] 检测到 ELECTRON_RUN_AS_NODE 环境变量：Electron API 不可用。请清除该变量后再启动。');
  process.exit(1);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0b1020',
    title: 'Lumina',
    autoHideMenuBar: true,   // 不显示 File/Edit/View 菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (mainWindow.setMenuBarVisibility) mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // 彻底移除应用菜单（否则 Windows 左上角会出现 File / Edit / View …）
  try { Menu.setApplicationMenu(null); } catch (e) {}
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* 打开 HTML 文件 */
ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '打开 HTML 幻灯片',
    filters: [{ name: 'HTML 文件', extensions: ['html', 'htm'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { content: fs.readFileSync(p, 'utf-8'), name: path.basename(p) };
});

/* 保存 HTML 文件 */
ipcMain.handle('save-file', async (e, html, name) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '保存 HTML 幻灯片',
    defaultPath: name || 'slides.html',
    filters: [{ name: 'HTML 文件', extensions: ['html'] }]
  });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, html, 'utf-8');
  return true;
});

/* 读取剪贴板文本（用于"粘贴 HTML"） */
ipcMain.handle('read-clipboard', () => clipboard.readText());

/* 读取内置示例 */
ipcMain.handle('read-sample', (evt, name) => {
  // 只允许字母数字、下划线与连字符，避免路径穿越
  const safe = String(name || 'tour').replace(/[^a-z0-9_-]/gi, '') || 'tour';
  const file = path.join(__dirname, '..', 'sample', safe + '.html');
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { return ''; }
});

/* 打开投影窗口：优先投到「外接显示器（副屏）」并全屏；只有一个屏幕时全屏在主屏（与 PPT 一致）。
   返回目标显示器信息，控制台会据此提示"已投到哪块屏"，让讲者能确认。 */
ipcMain.handle('open-stage', () => {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  // 用 id 判定主/副屏（不能用坐标：主屏不一定在原点，副屏也可能在左侧出现负坐标）
  const external = displays.find((d) => d.id !== primary.id) || null;
  const target = external || primary;
  const info = {
    display: target.label || ('显示器 ' + (displays.indexOf(target) + 1)),
    external: !!external,
    count: displays.length,
    size: target.bounds.width + '×' + target.bounds.height
  };

  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.setBounds(target.bounds);
    stageWindow.setFullScreen(true);
    stageWindow.show();
    stageWindow.focus();
    return info;
  }

  stageWindow = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    backgroundColor: '#000',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  stageWindow.setMenuBarVisibility(false);
  stageWindow.loadFile(path.join(__dirname, '..', 'index.html'), { query: { view: 'stage' } });
  stageWindow.once('ready-to-show', () => {
    if (!stageWindow || stageWindow.isDestroyed()) return;
    stageWindow.setBounds(target.bounds); // 保险：确保窗口落在目标显示器上
    stageWindow.setFullScreen(true);
    stageWindow.show();
    stageWindow.focus();
  });
  stageWindow.on('closed', () => { stageWindow = null; });
  return info;
});

ipcMain.handle('close-stage', () => {
  if (stageWindow && !stageWindow.isDestroyed()) { stageWindow.close(); }
  stageWindow = null;
  return true;
});

/* 跨窗口同步中继：把消息转发给其它所有窗口 */
ipcMain.on('hsp-sync', (e, msg) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.webContents !== e.sender) {
      try { w.webContents.send('hsp-sync', msg); } catch (err) {}
    }
  });
});

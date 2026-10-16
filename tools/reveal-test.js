/* Reveal.js 格式兼容测试 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const root = path.join(__dirname, '..');
const sample = fs.readFileSync(path.join(root, 'sample', 'sample-reveal.html'), 'utf-8');
const out = path.join(__dirname, 'reveal-result.txt');
fs.writeFileSync(out, '');
function log(s) { fs.appendFileSync(out, s + '\n', 'utf-8'); }

setTimeout(() => { log('TIMEOUT'); app.exit(1); }, 40000);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { preload: path.join(root, 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    await win.loadFile(path.join(root, 'index.html'));
    await new Promise((r) => setTimeout(r, 400));

    const r1 = await win.webContents.executeJavaScript(`
      Promise.race([
        HSP.player.load(${JSON.stringify(sample)}, 'reveal').then(() => ({ type: HSP.state.deckType, total: HSP.state.total })),
        new Promise(res => setTimeout(() => res('TIMEOUT'), 25000))
      ])`, true);
    log('load: ' + JSON.stringify(r1));

    if (r1 && r1.type) {
      // 等待 CDN 的 Reveal 完全就绪后再校验
      await new Promise((r) => setTimeout(r, 3500));
      const r2 = await win.webContents.executeJavaScript('({ type: HSP.state.deckType, total: HSP.state.total })', true);
      log('after-wait: ' + JSON.stringify(r2));
      const nav = await win.webContents.executeJavaScript('(function(){ HSP.player.go(1); return HSP.state.current; })()', true);
      log('nav: ' + nav);
      const notes = await win.webContents.executeJavaScript('HSP.player.getNotes(0)', true);
      log('notes: ' + (notes && notes.length > 0 ? 'OK(' + notes.length + ')' : 'EMPTY'));
    }
    log('done');
    app.exit(0);
  } catch (e) {
    log('EXC: ' + (e && e.message ? e.message : e));
    app.exit(1);
  }
});

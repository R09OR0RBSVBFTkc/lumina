/* Electron 冒烟测试：分步记录进度，30 秒看门狗兜底。 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const root = path.join(__dirname, '..');
const logPath = path.join(__dirname, 'smoke-result.txt');
const sample = fs.readFileSync(path.join(root, 'sample', 'sample-deck.html'), 'utf-8');

let step = 'init';
function log(s) {
  try { fs.appendFileSync(logPath, s + '\n', 'utf-8'); } catch (e) {}
}
function fail(s) { log('FAIL ' + s); }

fs.writeFileSync(logPath, '');

setTimeout(() => { log('TIMEOUT at step: ' + step); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  try {
    step = 'create-window';
    const win = new BrowserWindow({
      show: false, width: 1280, height: 720,
      webPreferences: { preload: path.join(root, 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });

    step = 'load-file';
    await win.loadFile(path.join(root, 'index.html'));
    log('OK load-file');

    await new Promise((r) => setTimeout(r, 500));
    step = 'check-hsp-ready';
    const ready = await win.webContents.executeJavaScript('(typeof HSP === "object" && typeof HSP.player === "object" && HSP.app !== undefined)', true);
    log((ready ? 'OK' : 'FAIL') + ' app-globals-ready :: ' + ready);

    step = 'load-sample';
    const load = await win.webContents.executeJavaScript(
      'new Promise(res => HSP.player.load(' + JSON.stringify(sample) + ', "test").then(() => res({ total: HSP.state.total, deckType: HSP.state.deckType, current: HSP.state.current })))', true);
    log((load.total >= 7 ? 'OK' : 'FAIL') + ' load-detect :: total=' + load.total + ' type=' + load.deckType);

    step = 'nav';
    const nav = await win.webContents.executeJavaScript('(function(){ HSP.player.go(3); return HSP.state.current; })()', true);
    log((nav === 3 ? 'OK' : 'FAIL') + ' nav :: current=' + nav);

    step = 'notes';
    const notes = await win.webContents.executeJavaScript('HSP.player.getNotes(0)', true);
    log((notes && notes.length > 0 ? 'OK' : 'FAIL') + ' notes :: ' + (notes ? notes.slice(0, 20) : '(空)'));

    step = 'annotate';
    const ann = await win.webContents.executeJavaScript('(function(){ HSP.annotate.setTool("pen"); return (typeof HSP.annotate.addSurface === "function" && typeof HSP.annotate.render === "function"); })()', true);
    log((ann === true ? 'OK' : 'FAIL') + ' annotate-engine');

    step = 'editor-add';
    const edit = await win.webContents.executeJavaScript('(function(){ var b = HSP.state.total; HSP.editor.addSlide(); return { before: b, after: HSP.state.total }; })()', true);
    log((edit.after === edit.before + 1 ? 'OK' : 'FAIL') + ' editor-addSlide :: ' + JSON.stringify(edit));

    step = 'serialize';
    const ser = await win.webContents.executeJavaScript('(HSP.player.serialize().length > 1000)', true);
    log((ser === true ? 'OK' : 'FAIL') + ' serialize');

    step = 'sync-api';
    const sync = await win.webContents.executeJavaScript('(typeof window.hsp.postSync === "function")', true);
    log((sync ? 'OK' : 'FAIL') + ' electron-sync-api');

    step = 'done';
    log('SMOKE OK');
    app.exit(0);
  } catch (e) {
    fail('exception at ' + step + ' :: ' + (e && e.message ? e.message : String(e)));
    app.exit(1);
  }
});

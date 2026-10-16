/* Lumina 预加载脚本：向渲染进程暴露安全 API */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hsp', {
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (html, name) => ipcRenderer.invoke('save-file', html, name),
  openStage: () => ipcRenderer.invoke('open-stage'),
  closeStage: () => ipcRenderer.invoke('close-stage'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  readSample: (name) => ipcRenderer.invoke('read-sample', name),
  postSync: (msg) => ipcRenderer.send('hsp-sync', msg),
  onSync: (cb) => ipcRenderer.on('hsp-sync', (e, msg) => cb(msg))
});

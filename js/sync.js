/* 跨窗口同步：Electron 用 IPC 中继（最可靠），浏览器用 BroadcastChannel + localStorage 兜底。
   消息带 id 去重，避免多通道重复投递。 */
window.HSP = window.HSP || {};
HSP.sync = (function () {
  var handlers = [];
  var seq = 0, seen = [];
  var mode = 'web';
  var bc = null;

  function dedupe(m) {
    if (m && m.id) {
      if (seen.indexOf(m.id) !== -1) return false;
      seen.push(m.id);
      if (seen.length > 300) seen.shift();
    }
    return true;
  }
  function deliver(m) {
    if (!dedupe(m)) return;
    handlers.forEach(function (h) { try { h(m); } catch (e) {} });
  }
  function post(msg) {
    if (!msg || typeof msg !== 'object') return;
    msg.id = Date.now().toString(36) + '-' + (seq++);
    msg.t = Date.now();
    if (mode === 'electron') {
      try { window.hsp.postSync(msg); } catch (e) {}
      return;
    }
    try { if (bc) bc.postMessage(msg); } catch (e) {}
    try { localStorage.setItem('hsp-last', JSON.stringify(msg)); } catch (e) {}
  }

  if (window.hsp && window.hsp.postSync && window.hsp.onSync) {
    mode = 'electron';
    try { window.hsp.onSync(deliver); } catch (e) {}
  } else {
    try { bc = new BroadcastChannel('hsp-sync-v1'); } catch (e) { bc = null; }
    if (bc) bc.onmessage = function (e) { deliver(e.data); };
    window.addEventListener('storage', function (e) {
      if (e.key === 'hsp-last' && e.newValue) {
        try { deliver(JSON.parse(e.newValue)); } catch (err) {}
      }
    });
  }

  return {
    post: post,
    on: function (fn) { handlers.push(fn); }
  };
})();

/* 轻量事件总线：模块间解耦，避免底层引擎直接调用上层模块（依赖倒置）。
   用法：HSP.events.on('slidechange', fn) / HSP.events.emit('slidechange', index) */
window.HSP = window.HSP || {};
HSP.events = (function () {
  var map = {};
  function on(name, fn) { (map[name] = map[name] || []).push(fn); }
  function off(name, fn) {
    var a = map[name];
    if (a) { var i = a.indexOf(fn); if (i !== -1) a.splice(i, 1); }
  }
  function emit(name, data) {
    var a = map[name];
    if (a) a.slice().forEach(function (fn) { try { fn(data); } catch (e) {} });
  }
  return { on: on, off: off, emit: emit };
})();

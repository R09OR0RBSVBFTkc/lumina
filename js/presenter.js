/* 演讲者模式（对齐 PPT 演示者视图）
   控制台（你的屏幕）：当前页大预览 · 下一页 · 备注大字 · 计时（可暂停/归零）· 缩略图条 · 标注工具 · 黑屏/白屏
   投影（stage）：只放正片，鼠标移入才出现迷你条，支持黑屏/白屏
   两个窗口通过 HSP.sync 双向同步：nav / state / draw / annot-sync / laser / tool / blank / stop */
window.HSP = window.HSP || {};
HSP.presenter = (function () {
  function el(id) { return document.getElementById(id); }
  var startTime = 0, timerId = null, pausedMs = 0, pausedAt = 0;
  var lastConsoleIndex = -1, surfaceAdded = false;
  var notesSize = 19, blankMode = null;

  /* ---------- 计时（可暂停 / 归零） ---------- */
  function elapsedMs() {
    if (pausedAt) return pausedAt - startTime - pausedMs;
    return Date.now() - startTime - pausedMs;
  }
  function renderTimer() {
    var t = el('pc-timer'); if (!t) return;
    var s = Math.max(0, Math.floor(elapsedMs() / 1000));
    t.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function startTimer() {
    startTime = Date.now(); pausedMs = 0; pausedAt = 0;
    var btn = el('pc-timer-toggle');
    if (btn) btn.title = '暂停计时';
    clearInterval(timerId);
    timerId = setInterval(renderTimer, 500);
    renderTimer();
  }
  function toggleTimer() {
    if (pausedAt) { pausedMs += Date.now() - pausedAt; pausedAt = 0; }
    else pausedAt = Date.now();
    var btn = el('pc-timer-toggle');
    if (btn) btn.title = pausedAt ? '继续计时' : '暂停计时';
    renderTimer();
  }

  /* ---------- 黑屏 / 白屏（PPT 的 B / W） ---------- */
  function setBlank(mode) {
    blankMode = mode || null;
    applyBlank();
    HSP.sync.post({ type: 'blank', mode: blankMode });
  }
  function applyBlank() {
    if (HSP.state.role === 'stage') {
      var b = el('stage-blank');
      if (b) b.className = blankMode || 'hidden';
      var bar = el('stage-mini-bar');
      if (bar) bar.classList.toggle('mini-hidden', !!blankMode);
    } else {
      var bb = el('pc-black'), wb = el('pc-white');
      if (bb) bb.classList.toggle('active', blankMode === 'black');
      if (wb) wb.classList.toggle('active', blankMode === 'white');
    }
  }

  /* ---------- 预览等比缩放 ----------
     幻灯片是按 100vh 满屏渲染的，直接塞进小窗会溢出/变形。
     正解：iframe 固定 1280×720（16:9），再用 transform 等比缩放到容器里，居中显示。 */
  var PV_W = 1280, PV_H = 720, fitTimer = null;
  function fitPreview(box) {
    if (!box) return;
    var ifr = box.querySelector('iframe');
    if (!ifr) return;
    var cw = box.clientWidth, ch = box.clientHeight;
    if (!cw || !ch) return;
    var s = Math.min(cw / PV_W, ch / PV_H);
    ifr.style.width = PV_W + 'px';
    ifr.style.height = PV_H + 'px';
    ifr.style.transformOrigin = '0 0';
    ifr.style.transform = 'scale(' + s + ')';
    ifr.style.left = Math.round((cw - PV_W * s) / 2) + 'px';
    ifr.style.top = Math.round((ch - PV_H * s) / 2) + 'px';
    box.__pvScale = s;
  }
  function fitPreviews() {
    var a = el('pc-cur'), b = el('pc-next');
    if (a) fitPreview(a.parentElement);
    if (b) fitPreview(b.parentElement);
  }
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitPreviews, 60);
    if (window.requestAnimationFrame) window.requestAnimationFrame(fitPreviews);
  }

  /* ---------- 投影目标提示（让讲者确认正片投到了哪块屏） ---------- */
  function showProjectionHint(info) {
    var box = el('pc-projection');
    if (!box) return;
    var txt = '', cls = 'ok';
    if (info && info.fallback) {
      txt = '已在浏览器新窗口打开正片 —— 请把该窗口拖到投影屏并全屏';
      cls = 'warn';
    } else if (info && info.external) {
      txt = '正片已投到外接显示器：' + info.display + '（' + info.size + '，全屏）';
    } else if (info) {
      txt = '未检测到外接显示器 · 正片全屏在本机（' + info.display + '）—— 按 Alt+Tab 切回本控制台';
      cls = 'warn';
    } else {
      txt = '投影窗口已打开';
      cls = 'warn';
    }
    box.textContent = txt;
    box.className = 'pc-projection ' + cls;
    box.classList.remove('hidden');
  }

  /* ---------- 备注字号 ---------- */
  function setNotesSize(v) {
    notesSize = Math.max(13, Math.min(40, v));
    var n = el('pc-notes');
    if (n) n.style.fontSize = notesSize + 'px';
  }

  /* ---------- 起止 ---------- */
  function start() {
    if (!HSP.state.loaded) { if (HSP.toast) HSP.toast('请先打开一份幻灯片'); return; }
    HSP.state.presenterActive = true;
    try {
      localStorage.setItem('hsp-html', HSP.state.html);
      localStorage.setItem('hsp-current', String(HSP.state.current));
      localStorage.setItem('hsp-annotations', JSON.stringify(HSP.state.annotations || {}));
    } catch (e) {}
    var url = location.origin + location.pathname + '?view=stage';
    if (window.hsp && window.hsp.openStage) {
      try {
        Promise.resolve(window.hsp.openStage()).then(showProjectionHint).catch(function () { showProjectionHint(null); });
      } catch (e) { showProjectionHint(null); }
    } else {
      try { window.open(url, 'hsp-stage'); } catch (e) {}
      showProjectionHint({ fallback: true });
    }
    showConsole();
  }

  function showConsole() {
    el('presenter-console').classList.remove('hidden');
    el('controlbar').classList.add('hidden');
    el('toolbar').classList.add('hidden');
    el('sidebar').classList.add('hidden');
    HSP.state.role = 'console';
    if (!surfaceAdded) {
      HSP.annotate.addSurface('pc', el('pc-cur-canvas'));
      surfaceAdded = true;
    }
    buildThumbs();
    lastConsoleIndex = -1;
    goConsole(HSP.state.current);
    startTimer();
    setNotesSize(notesSize);
    applyBlank();
    scheduleFit();
  }

  function stop() {
    HSP.state.presenterActive = false;
    clearInterval(timerId);
    HSP.sync.post({ type: 'stop' });
    el('presenter-console').classList.add('hidden');
    el('toolbar').classList.remove('hidden');
    el('controlbar').classList.remove('hidden');
    HSP.state.role = 'app';
    blankMode = null;
    if (window.hsp && window.hsp.closeStage) window.hsp.closeStage();
  }

  /* ---------- 预览（只加载一次 HTML，翻页仅滚动，避免小窗跳动） ---------- */
  function loadPreview(iframe, index) {
    return new Promise(function (res) {
      if (!iframe) { res(); return; }
      var nav = function () {
        try {
          var w = iframe.contentWindow, d = iframe.contentDocument;
          var r = HSP.player._detectIn(w, d);
          var els = r.slides.map(function (s) { return s.el; });
          HSP.player._navIn(w, d, els, r.type, index, false);
          // 图片/字体加载后页高会变，稍后二次校正，避免"半截上一页半截下一页"
          clearTimeout(iframe.__fixT);
          iframe.__fixT = setTimeout(function () {
            try { HSP.player._navIn(w, d, els, r.type, index, false); } catch (e) {}
          }, 600);
        } catch (e) {}
        scheduleFit();
        res();
      };
      if (iframe.__hspLoaded) { nav(); return; }
      iframe.srcdoc = HSP.state.html;
      iframe.addEventListener('load', function h() {
        iframe.removeEventListener('load', h);
        iframe.__hspLoaded = true;
        setTimeout(nav, 400);
      });
    });
  }

  function goConsole(i) {
    var n = HSP.state.total;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    if (i === lastConsoleIndex) return;
    lastConsoleIndex = i;
    HSP.state.current = i;
    loadPreview(el('pc-cur'), i);
    loadPreview(el('pc-next'), Math.min(i + 1, n - 1));
    updateNotes(i);
    updateLabels();
    updateThumbActive();
    if (HSP.annotate && HSP.annotate.render) HSP.annotate.render();
    HSP.sync.post({ type: 'nav', index: i });
    scheduleFit();
  }

  function updateNotes(i) {
    var n = el('pc-notes'); if (!n) return;
    var t = HSP.player.getNotes(i);
    n.textContent = t || '（本页没有备注）';
    n.scrollTop = 0;
  }
  function updateLabels() {
    var i = HSP.state.current, n = HSP.state.total;
    var idx = el('pc-index'); if (idx) idx.textContent = (i + 1) + ' / ' + n;
    var ttl = el('pc-title');
    if (ttl) {
      var s = HSP.state.slides[i];
      ttl.textContent = (s && s.title) ? s.title : '';
    }
    var nl = el('pc-next-label');
    if (nl) nl.textContent = (Math.min(i + 1, n - 1) + 1) + ' / ' + n;
  }
  function buildThumbs() {
    var box = el('pc-thumbs'); if (!box) return;
    box.innerHTML = '';
    HSP.state.slides.forEach(function (s, i) {
      var div = document.createElement('div');
      div.className = 'pc-thumb' + (i === HSP.state.current ? ' active' : '');
      div.title = s.title || '';
      var num = document.createElement('span'); num.className = 'num'; num.textContent = (i + 1);
      var t = document.createElement('span'); t.textContent = s.title || ('第 ' + (i + 1) + ' 页');
      div.appendChild(num); div.appendChild(t);
      div.addEventListener('click', function () { goConsole(i); });
      box.appendChild(div);
    });
  }
  function updateThumbActive() {
    var box = el('pc-thumbs'); if (!box) return;
    var kids = box.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('active', i === HSP.state.current);
    if (kids[HSP.state.current] && kids[HSP.state.current].scrollIntoView) {
      try { kids[HSP.state.current].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    }
  }

  /* ---------- 通道 ---------- */
  function onChannel(m) {
    if (m.type === 'nav') {
      if (HSP.state.role === 'stage') HSP.player.go(m.index, false, true); // 静默导航，避免回发 state
      else if (HSP.state.role === 'console') goConsole(m.index);
    } else if (m.type === 'state') {
      if (HSP.state.role === 'console') goConsole(m.current);
    } else if (m.type === 'draw') {
      HSP.annotate.remoteDraw(m);
    } else if (m.type === 'annot-sync') {
      HSP.annotate.remoteSync(m);
    } else if (m.type === 'laser') {
      HSP.annotate.remoteLaser(m);
    } else if (m.type === 'tool') {
      applyTool(m);
    } else if (m.type === 'blank') {
      blankMode = m.mode || null;
      applyBlank();
    } else if (m.type === 'stop') {
      if (HSP.state.role === 'stage') stageStopped();
      else if (HSP.state.role === 'console') stop();
    }
  }

  function applyTool(m) {
    HSP.annotate.setTool(m.tool); HSP.annotate.setColor(m.color); HSP.annotate.setSize(m.size);
    HSP.state.tool = m.tool; HSP.state.color = m.color; HSP.state.size = m.size;
  }

  function stageStopped() {
    try { window.close(); } catch (e) {}
    document.body.innerHTML = '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#8b95c9;font-size:20px;">演示已结束，可关闭此窗口</div>';
  }

  function setTool(t, c, s) {
    HSP.state.tool = t;
    if (c != null) HSP.state.color = c;
    if (s != null) HSP.state.size = s;
    HSP.annotate.setTool(t);
    HSP.annotate.setColor(HSP.state.color);
    HSP.annotate.setSize(HSP.state.size);
    HSP.sync.post({ type: 'tool', tool: t, color: HSP.state.color, size: HSP.state.size });
  }

  /* ---------- 键盘：控制台翻页/黑屏；投影端只处理黑屏（翻页交给播放引擎，避免双重翻页） ---------- */
  function onKey(e) {
    var role = HSP.state.role;
    if (role !== 'console' && role !== 'stage') return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(e.target.tagName) !== -1) return;
    var k = e.key;
    if (k === 'b' || k === 'B') { e.preventDefault(); e.stopPropagation(); setBlank(blankMode === 'black' ? null : 'black'); return; }
    if (k === 'w' || k === 'W') { e.preventDefault(); e.stopPropagation(); setBlank(blankMode === 'white' ? null : 'white'); return; }
    if (role === 'stage') return; // 投影端翻页交给 player 全局导航
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'Enter') {
      e.preventDefault(); e.stopPropagation(); goConsole(HSP.state.current + 1);
    } else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') {
      e.preventDefault(); e.stopPropagation(); goConsole(HSP.state.current - 1);
    } else if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation(); stop();
    }
  }

  /* ---------- 初始化：绑定控制台/投影的新控件 ---------- */
  function init() {
    var bb = el('pc-black');
    if (bb) bb.addEventListener('click', function () { setBlank(blankMode === 'black' ? null : 'black'); });
    var wb = el('pc-white');
    if (wb) wb.addEventListener('click', function () { setBlank(blankMode === 'white' ? null : 'white'); });
    var tt = el('pc-timer-toggle');
    if (tt) tt.addEventListener('click', toggleTimer);
    var tr = el('pc-timer-reset');
    if (tr) tr.addEventListener('click', startTimer);
    var fu = el('pc-fs-up');
    if (fu) fu.addEventListener('click', function () { setNotesSize(notesSize + 2); });
    var fd = el('pc-fs-down');
    if (fd) fd.addEventListener('click', function () { setNotesSize(notesSize - 2); });
    var sb = el('stage-blank-btn');
    if (sb) sb.addEventListener('click', function () { setBlank(blankMode ? null : 'black'); });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', scheduleFit);
  }
  init();

  return {
    start: start, stop: stop, showConsole: showConsole, goConsole: goConsole,
    onChannel: onChannel, setTool: setTool, buildThumbs: buildThumbs,
    setBlank: setBlank, toggleTimer: toggleTimer, resetTimer: startTimer, setNotesSize: setNotesSize,
    fitPreviews: fitPreviews, scheduleFit: scheduleFit,
    blankState: function () { return blankMode; }
  };
})();

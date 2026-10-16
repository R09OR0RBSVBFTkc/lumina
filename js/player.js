/* 播放引擎：iframe 加载 + 幻灯片识别 + 翻页导航。
   兼容两种主流 AI HTML 形态：Reveal.js（<section>）与普通 .slide / 全屏 section。 */
window.HSP = window.HSP || {};

HSP.state = {
  html: '', sourceName: '', loaded: false,
  deckType: 'sections',   // 'reveal' | 'sections'
  slides: [], total: 0, current: 0,
  mode: 'view',           // 'view' | 'edit'
  tool: 'cursor', color: '#ff2d55', size: 4,
  clickNav: true,         // 单击翻页开关
  wheelNav: true,         // 滚轮翻页开关
  barAutoHide: true,      // 全屏时控制条自动隐藏
  role: 'app',            // 'app' | 'console' | 'stage'
  presenterActive: false,
  annotations: {}         // slideIndex -> strokes[]
};

HSP.player = (function () {
  var iframe = document.getElementById('deck');
  var state = HSP.state;
  var current = 0;
  var wheelLock = 0;
  var loadGen = 0; // 载入代际：旧文档的定时器/回调过期即忽略，避免竞态
  var programmaticScroll = false; // 程序触发的滚动（忽略，避免与滚动反向同步打架）
  var scrollSyncTimer = null;
  var resizeRelocateTimer = null;
  var userScrollingUntil = 0;     // 用户滚动后的抑制窗口：期间不做自动重定位，避免抢走用户的滚动

  function doc() { return iframe.contentDocument; }
  function win() { return iframe.contentWindow; }

  /* ---------- 幻灯片识别（纯函数，预览 iframe 也复用） ---------- */
  function _detectIn(w, d) {
    var type = 'sections', slideEls = [];
    if (w && w.Reveal && typeof w.Reveal.getSlides === 'function') {
      try {
        var s = w.Reveal.getSlides();
        if (s && s.length) { slideEls = Array.prototype.slice.call(s); type = 'reveal'; }
      } catch (e) {}
    }
    if (!slideEls.length) {
      // 常见分页写法：.slide / data-slide / .page / .frame / .screen / Reveal 结构等
      var q = 'section.slide, .slide, [data-slide], [data-page], article.slide, section[data-auto-animate], ' +
              '.reveal .slides > section, .deck > section, body > .page, body > .frame, body > .screen';
      var all = Array.prototype.slice.call(d.querySelectorAll(q));
      all = all.filter(function (el) { return !all.some(function (o) { return o !== el && o.contains(el); }); });
      slideEls = all;
    }
    if (!slideEls.length) {
      slideEls = Array.prototype.slice.call(d.querySelectorAll('body > section, body > article'));
    }
    if (!slideEls.length) {
      // CSS 滚动吸附分页（scroll-snap）
      slideEls = Array.prototype.slice.call(d.querySelectorAll('[class*="snap"]')).filter(function (el) {
        return el.parentElement === d.body || el.parentElement === d.body.firstElementChild;
      });
    }
    if (!slideEls.length) {
      slideEls = Array.prototype.slice.call(d.body.children).filter(function (e) {
        return ['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'BASE'].indexOf(e.tagName) === -1;
      });
    }
    var slides = slideEls.map(function (el, i) {
      el.__hspIdx = i;
      return { el: el, index: i, title: _title(el), notes: _notes(el) };
    });
    return { type: type, slideEls: slideEls, slides: slides };
  }

  function _title(el) {
    if (el.getAttribute && el.getAttribute('data-title')) return el.getAttribute('data-title');
    var h = el.querySelector && el.querySelector('h1,h2,h3');
    if (h) return h.textContent.trim().slice(0, 40);
    var t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 40) || ('第 ' + ((el.__hspIdx || 0) + 1) + ' 页');
  }
  function _notes(el) {
    if (el.getAttribute && el.getAttribute('data-notes')) return el.getAttribute('data-notes').trim();
    var a = el.querySelector && el.querySelector('aside.notes, .notes, [data-notes]');
    if (a) return (a.getAttribute('data-notes') || a.textContent || '').trim();
    return '';
  }

  function _navIn(w, d, slideEls, type, index, smooth) {
    if (!slideEls.length) return 0;
    index = Math.max(0, Math.min(slideEls.length - 1, index));
    if (type === 'reveal' && w.Reveal) {
      try { w.Reveal.slide(index, 0, 0); } catch (e) { try { w.Reveal.slideTo(index); } catch (e2) {} }
    } else {
      var el = slideEls[index];
      if (el) {
        // 显式设置滚动位置：同时设 body 与 scrollingElement，兼容 overflow:hidden 的滚动容器
        var cur = (d.scrollingElement && d.scrollingElement.scrollTop) || (d.body && d.body.scrollTop) || 0;
        var top = el.getBoundingClientRect().top + cur;
        programmaticScroll = true; // 标记为程序滚动，滚动反向同步将忽略这次变化
        if (d.body) { try { d.body.scrollTop = top; } catch (e) {} }
        if (d.scrollingElement) { try { d.scrollingElement.scrollTop = top; } catch (e2) {} }
        // 兜底：瞬时 scrollIntoView（兼容嵌套滚动容器）
        try { el.scrollIntoView({ behavior: 'auto', block: 'start' }); } catch (e3) { try { el.scrollIntoView(); } catch (e4) {} }
        clearTimeout(_progScrollTimer);
        _progScrollTimer = setTimeout(function () { programmaticScroll = false; }, 220);
      }
    }
    return index;
  }
  var _progScrollTimer = null;

  /* ---------- 滚动位置 → 当前页（采纳用户实际滚动到的地方） ---------- */
  function _bestSlideFromScroll() {
    var d = doc();
    if (!d || !state.slides.length) return -1;
    var best = -1, bestDist = Infinity;
    state.slides.forEach(function (s, i) {
      if (!s.el) return;
      var dist = Math.abs(s.el.getBoundingClientRect().top);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }
  /* 把 current 校正为滚动位置对应的页；返回是否有变化 */
  function adoptScrollPosition() {
    var best = _bestSlideFromScroll();
    if (best < 0 || best === state.current) return false;
    current = best;
    state.current = best;
    HSP.events.emit('slidechange', best);
    HSP.sync.post({ type: 'state', current: best });
    return true;
  }

  /* ---------- 滚动 → 页码 反向同步（用户滚动时左侧缩略图跟随） ---------- */
  var _lastScrollSync = 0;
  function _onFrameScroll() {
    if (programmaticScroll) return;
    if (!state.loaded || !state.total) return;
    if (state.deckType === 'reveal') return; // Reveal 有自己的 slidechanged 事件
    var now = Date.now();
    if (now - _lastScrollSync < 50) return;  // 多路监听去重
    _lastScrollSync = now;
    userScrollingUntil = now + 450;          // 用户正在滚动：暂缓自动重定位
    adoptScrollPosition();
  }

  /* ---------- iframe 尺寸变化 → 自动重新定位（sidebar 切换/全屏/窗口缩放都覆盖） ---------- */
  function _scheduleRelocate() {
    clearTimeout(resizeRelocateTimer);
    resizeRelocateTimer = setTimeout(function () { relocate(); }, 70);
  }
  if (typeof ResizeObserver !== 'undefined' && iframe) {
    try { new ResizeObserver(function () { _scheduleRelocate(); }).observe(iframe); } catch (e) {}
  }

  /* ---------- 主流程 ---------- */
  function load(html, sourceName) {
    var gen = ++loadGen;
    return new Promise(function (resolve, reject) {
      state.html = html;
      state.sourceName = sourceName || '';
      // 注：标注清空由 openFromText 在"打开新文件"时处理；
      // 此处不清空，避免舞台窗口从 localStorage 恢复标注 / 撤销时丢失标注
      function onload() {
        if (gen !== loadGen) return; // 已被更新的载入取代
        iframe.removeEventListener('load', onload);
        _waitReady().then(function () {
          if (gen !== loadGen) return;
          try {
            _applyDetect();
            state.loaded = true;
            _attachFrameNav();
            if (state.deckType === 'reveal') _hookReveal();
            current = _currentFromDeck();
            state.current = current;
            go(0, false);
            HSP.events.emit('deckloaded', state);
            resolve(state);
            // 内容（图片/字体）加载后页高会变，延迟重新定位，避免显示半截
            setTimeout(function () { if (gen === loadGen) relocate(); }, 800);
            setTimeout(function () { if (gen === loadGen) relocate(); }, 2200);
            // 兜底：CDN 的 Reveal 加载较慢时，稍后再识别一次
            setTimeout(function () {
              if (gen !== loadGen) return;
              if (state.deckType !== 'reveal' && win() && win().Reveal) {
                _applyDetect();
                _hookReveal();
                current = _currentFromDeck();
                state.current = current;
                go(current, false);
                HSP.events.emit('deckloaded', state);
              }
            }, 2200);
          } catch (e) { reject(e); }
        });
      }
      iframe.addEventListener('load', onload);
      iframe.srcdoc = html;
    });
  }

  function _applyDetect() {
    var r = _detectIn(win(), doc());
    state.deckType = r.type;
    state.slides = r.slides;
    state.total = r.slides.length;
  }

  function _waitReady() {
    return new Promise(function (res) {
      var start = Date.now();
      (function poll() {
        var w = win();
        var waited = Date.now() - start;
        if (w && w.Reveal) {
          if (w.Reveal.isReady ? w.Reveal.isReady() : true) return res();
          if (waited > 4000) return res();
          return setTimeout(poll, 100);
        }
        if (waited >= 600) return res();
        setTimeout(poll, 50);
      })();
    });
  }

  function _currentFromDeck() {
    if (state.deckType === 'reveal' && win() && win().Reveal) {
      try { var st = win().Reveal.getState(); return st.indexh || 0; } catch (e) {}
    }
    return 0;
  }

  function _attachFrameNav() {
    var w = win(), d = doc();
    if (!w) return;
    // 用户滚动 → 反向同步页码（左侧缩略图跟随）；多路绑定，兼容各种滚动容器
    try { d.addEventListener('scroll', _onFrameScroll, true); } catch (e0) {}
    w.addEventListener('scroll', _onFrameScroll, true);
    try { if (d.scrollingElement) d.scrollingElement.addEventListener('scroll', _onFrameScroll, true); } catch (e1) {}
    try { if (d.body) d.body.addEventListener('scroll', _onFrameScroll, true); } catch (e2) {}
    if (state.deckType !== 'reveal') {
      w.addEventListener('keydown', function (e) {
        if (state.mode === 'edit') return;
        if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].indexOf(e.key) !== -1) { e.preventDefault(); next(); }
        else if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(e.key) !== -1) { e.preventDefault(); prev(); }
        else if (e.key === 'Home') { go(0); }
        else if (e.key === 'End') { go(state.total - 1); }
      });
    }
    w.addEventListener('wheel', function (e) {
      if (state.mode === 'edit') return;
      if (state.wheelNav === false) return;
      var now = Date.now();
      if (now - wheelLock < 500) return;
      if (Math.abs(e.deltaY) < 12) return;
      wheelLock = now;
      if (e.deltaY > 0) next(); else prev();
    }, { passive: true });
    // 单击翻页：点中链接/按钮/输入框等交互元素时不翻页；双击第二击不翻（避免连翻两页）
    var lastClickT = 0;
    w.addEventListener('click', function (e) {
      var t = e.target;
      // 关键：阻止链接默认导航——srcdoc iframe 的基准 URL 是父页面，
      // 点击 href="#" 等相对链接会把 iframe 导航到 file:// 父文件，毁掉播放器
      if (t && t.closest) {
        var link = t.closest('a');
        if (link) { e.preventDefault(); }
      }
      if (state.mode === 'edit') return;
      if (!state.clickNav) return;
      if (t && t.closest && t.closest('a,button,input,textarea,select,label,summary,[contenteditable],[onclick],[data-href],iframe,video,audio')) return;
      var now = Date.now();
      if (now - lastClickT < 320) { lastClickT = now; return; }
      lastClickT = now;
      next();
    });
    // 禁止浏览器原生拖拽（图片/链接/文本）：否则拖动图片会出现"复制光标"并把 iframe 导航走
    w.addEventListener('dragstart', function (e) { e.preventDefault(); });
    // 拖拽 .html 文件到 iframe 上时转发给父窗口打开
    w.addEventListener('dragover', function (e) { e.preventDefault(); });
    w.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var rd = new w.FileReader();
      rd.onload = function () {
        try {
          if (window.parent && window.parent.HSP && window.parent.HSP.openFromText) {
            window.parent.HSP.openFromText(String(rd.result), f.name);
          }
        } catch (err) {}
      };
      rd.readAsText(f, 'utf-8');
    });
    // iframe 内粘贴 HTML 时转发给父窗口
    w.addEventListener('paste', function (e) {
      var t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (t && /<(!doctype|html|section|body|head)/i.test(t)) {
        e.preventDefault();
        try {
          if (window.parent && window.parent.HSP && window.parent.HSP.openFromText) {
            window.parent.HSP.openFromText(t, '粘贴的幻灯片.html');
          }
        } catch (err) {}
      }
    });
  }

  function _hookReveal() {
    var R = win().Reveal;
    if (!R) return;
    try {
      R.on('slidechanged', function (ev) {
        current = ev.indexh;
        onSlideChange(current);
      });
    } catch (e) {}
  }

  function go(i, smooth, silent) {
    if (!state.loaded || !state.total) return;
    var target = Math.max(0, Math.min(state.total - 1, i));
    _navIn(win(), doc(), state.slides.map(function (s) { return s.el; }), state.deckType, target, smooth !== false);
    current = target;
    state.current = target;
    onSlideChange(target, silent);
  }
  function next() { go(current + 1); }
  function prev() { go(current - 1); }

  function getNotes(i) { var s = state.slides[i]; return s ? s.notes : ''; }

  /* 重新定位当前页：窗口尺寸/全屏变化后 iframe 视口变了，重新滚动到当前页 */
  function relocate() {
    if (!state.loaded || !state.total) return;
    if (Date.now() < userScrollingUntil) return; // 用户正在滚动，不要抢走他的滚动位置
    adoptScrollPosition(); // 先采纳用户实际滚动到的页，再对齐，避免把画面滚回过期页码
    _navIn(win(), doc(), state.slides.map(function (s) { return s.el; }), state.deckType, current, false);
  }

  function serialize() {
    var d = doc();
    if (!d || !d.documentElement) return state.html;
    // 字符串级过滤注入层与光标类（不克隆 DOM，性能高、无副作用）
    var html = d.documentElement.outerHTML;
    html = html.replace(/<style[^>]*id="__hsp_style"[\s\S]*?<\/style>/g, '');
    html = html.replace(/\s*__hsp_moving\b/g, '').replace(/class="\s*"/g, '');
    return '<!DOCTYPE html>\n' + html;
  }
  function syncFromDOM() { state.html = serialize(); }
  function redetect() { _applyDetect(); }

  function onSlideChange(i, silent) {
    HSP.events.emit('slidechange', i);
    if (!silent) HSP.sync.post({ type: 'state', current: i });
  }

  /* 父窗口全局键盘/滚轮：工具激活时画布拦截了指针，需在父层翻页 */
  function attachGlobalNav() {
    window.addEventListener('keydown', function (e) {
      // 全局快捷键（不受模式限制）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); HSP.events.emit('save-shortcut'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); HSP.events.emit('open-shortcut'); return; }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); HSP.events.emit('fullscreen-shortcut'); return; }
      if (state.role === 'console') return; // 演讲者控制台由 presenter 自己处理键盘，避免双重翻页
      if (state.mode === 'edit' || !state.loaded) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].indexOf(e.key) !== -1) { e.preventDefault(); next(); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(e.key) !== -1) { e.preventDefault(); prev(); }
      else if (e.key === 'Home') { go(0); }
      else if (e.key === 'End') { go(state.total - 1); }
    });
    window.addEventListener('wheel', function (e) {
      if (state.mode === 'edit' || !state.loaded) return;
      if (state.wheelNav === false) return;
      var now = Date.now();
      if (now - wheelLock < 400) return;
      if (Math.abs(e.deltaY) < 20) return;
      wheelLock = now;
      if (e.deltaY > 0) next(); else prev();
    }, { passive: true });
  }

  return {
    load: load, go: go, next: next, prev: prev, relocate: relocate,
    getNotes: getNotes, serialize: serialize, syncFromDOM: syncFromDOM,
    redetect: redetect, attachGlobalNav: attachGlobalNav,
    doc: doc, win: win,
    adoptScrollPosition: adoptScrollPosition,
    _detectIn: _detectIn, _navIn: _navIn
  };
})();

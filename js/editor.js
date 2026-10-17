/* 编辑模块（按 HTML 元素编辑，参照 PPT/Figma 的交互）。
   架构：编辑 UI（选中框/工具条/缩放手柄）位于**主窗口**，与被编辑文档完全隔离——
   不会被文档 CSS 污染，工具条按钮永远不会被"选中/改字号"。
   iframe 内仅注入一条 cursor:move 规则（序列化时已过滤）。 */
window.HSP = window.HSP || {};
HSP.editor = (function () {
  var selEl = null;        // 主选中元素（iframe 内）
  var selEls = [];         // 全部选中元素（支持多选）
  var editingEl = null;    // 正在改文字的元素
  var bound = false;       // 事件是否已绑定到当前 iframe document
  var dragging = false;
  var dragData = null;     // {type:'move'|'resize', ...}
  var nudgeTimer = null;   // 方向键微调防抖
  var history = [];        // 编辑历史（撤销用，最多 30 步）
  var lastCommitted = null; // 最近一次 commit 后的干净快照

  function doc() { return HSP.player.doc(); }
  function win() { return HSP.player.win(); }
  function $parent(id) { return document.getElementById(id); }
  function frameRect() {
    var f = document.getElementById('deck');
    return f ? f.getBoundingClientRect() : { left: 0, top: 0 };
  }

  var TEXT_TOOLS = ['bold', 'italic', 'underline', 'up', 'down', 'color']; // 仅在文本元素上出现（背景色对所有元素都有意义）
  var MEDIA = ['IMG', 'VIDEO', 'SVG', 'CANVAS', 'IFRAME', 'AUDIO'];

  /* ---------- 主窗口编辑 UI（一次性构建，样式在 app.css，隔离文档影响） ---------- */
  function ensureUI() {
    if (document.getElementById('hsp-sel')) return;
    var sel = document.createElement('div');
    sel.id = 'hsp-sel';
    var dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    dirs.forEach(function (dir) {
      var h = document.createElement('div');
      h.className = 'hsp-h';
      h.setAttribute('data-h', dir);
      h.addEventListener('pointerdown', function (e) { startResize(dir, e); });
      sel.appendChild(h);
    });
    document.body.appendChild(sel);

    var tb = document.createElement('div');
    tb.id = 'hsp-tb';
    var defs = [
      ['bold', 'btn', 'B', '加粗'],
      ['italic', 'btn', 'I', '斜体'],
      ['underline', 'btn', 'U', '下划线'],
      ['up', 'btn', 'A+', '字号增大'],
      ['down', 'btn', 'A−', '字号减小'],
      ['color', 'color', '#ffffff', '文字颜色'],
      ['bg', 'color', '#0b1020', '背景颜色'],
      ['dup', 'btn', '#i-copy', '复制元素'],
      ['front', 'btn', '#i-layer-up', '上移一层'],
      ['back', 'btn', '#i-layer-down', '下移一层'],
      ['del', 'btn', '#i-trash', '删除元素']
    ];
    var html = '';
    defs.forEach(function (b) {
      if (b[1] === 'color') {
        html += '<input type="color" data-a="' + b[0] + '" title="' + b[3] + '" value="' + b[2] + '">';
      } else if (typeof b[2] === 'string' && b[2].charAt(0) === '#') {
        // 图标按钮（复用主窗口的 SVG 图标集，避免 emoji）
        html += '<button data-a="' + b[0] + '" title="' + b[3] + '"><svg class="ico"><use href="' + b[2] + '"/></svg></button>';
      } else {
        html += '<button data-a="' + b[0] + '" title="' + b[3] + '">' + b[2] + '</button>';
      }
    });
    tb.innerHTML = html;
    document.body.appendChild(tb);
    tb.addEventListener('click', onToolbarClick);
    tb.addEventListener('input', onToolbarInput);
    tb.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); // 不冒泡到主窗口其它逻辑

    // 多选辅助框容器（主窗口绘制，不进文档）
    var mb = document.createElement('div');
    mb.id = 'hsp-multi';
    document.body.appendChild(mb);
    // 对齐参考线容器
    var gd = document.createElement('div');
    gd.id = 'hsp-guides';
    document.body.appendChild(gd);
    // 属性面板（对标 PPT 格式面板）
    ensureInspector();
  }

  function onToolbarClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
    if (!b) return;
    var a = b.getAttribute('data-a');
    if (a === 'color' || a === 'bg') return; // 颜色输入交给 input 事件
    e.preventDefault(); e.stopPropagation();
    if (a === 'del') delSelected();
    else if (a === 'dup') dupSelected();
    else if (a === 'bold') toggleBold();
    else if (a === 'italic') toggleItalic();
    else if (a === 'underline') toggleUnderline();
    else if (a === 'up') changeFontSize(1);
    else if (a === 'down') changeFontSize(-1);
    else if (a === 'front') bringFront();
    else if (a === 'back') sendBack();
  }
  /* 颜色修改必须应付"复杂颜色"：
     ① 渐变/图片背景：只改 background-color 会被上层渐变盖住 → 用 background 简写清掉背景图
     ② 渐变文字（background-clip:text + color:transparent）：改 color 完全无效 → 先转回纯色文字
     ③ 作者样式带 !important 时普通内联样式压不过 → 一律用 !important 写入 */
  function setTextColor(el, color) {
    var cs = getComputedStyle(el);
    var clip = (cs.webkitBackgroundClip || cs.backgroundClip || '');
    if (clip === 'text') {
      el.style.setProperty('background-image', 'none', 'important');
      el.style.setProperty('-webkit-background-clip', 'border-box', 'important');
      el.style.setProperty('background-clip', 'border-box', 'important');
      // 同时清掉可能存在的文字填充色（-webkit-text-fill-color 会盖住 color）
      el.style.setProperty('-webkit-text-fill-color', color, 'important');
    }
    el.style.setProperty('color', color, 'important');
  }
  function setBgColor(el, color) {
    el.style.setProperty('background', color, 'important'); // background 简写会清掉 background-image（渐变/图片）
  }
  function onToolbarInput(e) {
    if (!selEl) return;
    var a = e.target.getAttribute('data-a');
    if (a === 'color') { setTextColor(selEl, e.target.value); commit(); }
    if (a === 'bg') { setBgColor(selEl, e.target.value); commit(); }
  }

  /* ---------- 选中（iframe 内元素） ---------- */
  function isSelectable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'BR', 'HTML', 'BODY'].indexOf(el.tagName) !== -1) return false;
    if (el.classList && (el.classList.contains('slide') || el.classList.contains('slides'))) return false;
    return true;
  }
  function pickTarget(el) {
    while (el && !isSelectable(el)) el = el.parentElement;
    return (el && isSelectable(el)) ? el : null;
  }
  /* ---------- 选中集合的"存活校验" ----------
     文档会被整体重载（撤销、AI 改稿、切页），旧的选中元素随之失效。
     若继续对游离节点操作，会出现"框画在角落""改了没反应""报错"等不稳定现象。
     所以：所有批量操作都先经过 liveSel() 剔除失效元素。 */
  function isLive(el) {
    if (!el || el.nodeType !== 1) return false;
    var d = doc();
    return !!(d && d.contains(el));
  }
  function pruneSelection() {
    if (!selEls.length && !selEl) return false;
    var dead = selEls.filter(function (x) { return !isLive(x); });
    if (dead.length) {
      dead.forEach(function (x) { try { x.classList.remove('__hsp_moving'); } catch (e0) {} });
      selEls = selEls.filter(isLive);
    }
    if (selEl && !isLive(selEl)) selEl = selEls.length ? selEls[selEls.length - 1] : null;
    if (!selEl) { selEls = []; clearSelection(); return false; }
    return true;
  }
  /* 取"当前仍有效的"选中元素；调用即自动清理失效项 */
  function liveSel() {
    pruneSelection();
    return selEls;
  }

  /* 选中：additive=true 时加选/减选（Shift、Ctrl/Cmd 点击） */
  function select(el, additive) {
    if (!el) { if (!additive) clearSelection(); return; }
    if (additive) {
      var i = selEls.indexOf(el);
      if (i >= 0) {
        selEls.splice(i, 1);
        try { el.classList.remove('__hsp_moving'); } catch (e0) {}
        if (!selEls.length) { clearSelection(); return; }
        selEl = selEls[selEls.length - 1];
      } else {
        selEls.push(el);
        selEl = el;
        el.classList.add('__hsp_moving');
      }
    } else {
      selEls.forEach(function (x) { try { x.classList.remove('__hsp_moving'); } catch (e1) {} });
      selEls = [el];
      selEl = el;
      el.classList.add('__hsp_moving');
    }
    updateSelBox();
    updateToolbarFor(selEl);
    syncColorInputs(selEl);
    renderMultiBoxes();
    refreshInspector(true); // 选中变化必须立即刷新（拖拽过程才节流）
  }
  function clearSelection() {
    selEls.forEach(function (x) { try { x.classList.remove('__hsp_moving'); } catch (e2) {} });
    selEls = [];
    selEl = null;
    var sel = $parent('hsp-sel'), tb = $parent('hsp-tb'), mb = $parent('hsp-multi'), insp = $parent('inspector');
    if (sel) sel.style.display = 'none';
    if (tb) tb.style.display = 'none';
    if (mb) mb.style.display = 'none';
    if (insp) insp.classList.add('hidden');
  }
  /* 多选时：除主选中外，其余元素各画一个细框（主窗口绘制，不进文档） */
  function renderMultiBoxes() {
    var box = $parent('hsp-multi');
    if (!box) return;
    box.innerHTML = '';
    if (selEls.length <= 1) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    var fr = frameRect();
    liveSel().forEach(function (el) {
      if (el === selEl) return; // 主选中已有带手柄的框
      var r = el.getBoundingClientRect();
      var d = document.createElement('div');
      d.className = 'hsp-mbox';
      d.style.left = (r.left + fr.left) + 'px';
      d.style.top = (r.top + fr.top) + 'px';
      d.style.width = Math.max(2, r.width) + 'px';
      d.style.height = Math.max(2, r.height) + 'px';
      box.appendChild(d);
    });
  }

  /* ================= 属性面板（对标 PPT / Keynote 的格式面板） ================= */
  function ibtn(a, icon, title) {
    return '<button data-ia="' + a + '" title="' + title + '"><svg class="ico"><use href="#' + icon + '"/></svg></button>';
  }
  /* ================= 元素类型判定：不同元素给不同的可编辑项（像 PPT） ================= */
  function hasDirectText(el) {
    var n = el.childNodes;
    for (var i = 0; i < n.length; i++) {
      if (n[i].nodeType === 3 && String(n[i].textContent).trim()) return true;
    }
    return false;
  }
  var INLINE_TAGS = ['SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'BR', 'SMALL', 'MARK', 'SUP', 'SUB', 'CODE', 'ABBR', 'TIME', 'SPAN'];
  /* 是否"文本元素"：有直接文字，或子元素全是行内标签（如 h1 里包着逐字 span） */
  function isTextish(el) {
    if (hasDirectText(el)) return true;
    var kids = el.children;
    if (!kids || !kids.length) return false;
    for (var i = 0; i < kids.length; i++) {
      if (INLINE_TAGS.indexOf(kids[i].tagName) === -1) return false;
    }
    return !!(el.textContent || '').trim();
  }
  /* elKind 会被高频调用（工具条与属性面板刷新），缓存上一次结果，避免反复触发样式计算 */
  var _kEl = null, _kV = '';
  function elKind(el) {
    if (el && el === _kEl && _kV) return _kV;
    _kV = _elKind(el);
    _kEl = el;
    return _kV;
  }
  function _elKind(el) {
    if (!el || !el.tagName) return 'other';
    var tag = String(el.tagName).toUpperCase(); // 注意：SVG 元素的 tagName 是小写
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE' || tag === 'IFRAME') return 'media';
    if (tag === 'SVG' || el.ownerSVGElement) return 'svg';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (isTextish(el)) return 'text';
    var cs = getComputedStyle(el);
    var hasBox = cs.backgroundImage !== 'none' ||
      (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
      (parseFloat(cs.borderTopWidth) || 0) > 0;
    return hasBox ? 'shape' : 'other';
  }
  var KIND_LABEL = { text: '文本', media: '图片 / 媒体', svg: '矢量图形', list: '列表', shape: '形状 / 容器', other: '元素' };

  function ensureInspector() {
    if ($parent('inspector')) return;
    var p = document.createElement('aside');
    p.id = 'inspector';
    p.className = 'hidden';
    p.innerHTML = [
      '<div class="insp-title">属性 <span id="insp-kind" class="insp-kind">元素</span></div>',

      /* ① 位置与大小 —— 所有元素 */
      '<div class="insp-group" data-for="all"><div class="insp-label">位置与大小</div><div class="insp-grid">',
      '<label>X<input id="insp-x" type="number"></label>',
      '<label>Y<input id="insp-y" type="number"></label>',
      '<label>宽<input id="insp-w" type="number" min="1"></label>',
      '<label>高<input id="insp-h" type="number" min="1"></label>',
      '<label>旋转<input id="insp-rot" type="number" step="1"></label>',
      '<label>透明 %<input id="insp-op" type="number" min="0" max="100" step="5"></label>',
      '</div></div>',

      /* ② 文本 —— 仅"文本"元素 */
      '<div class="insp-group" data-for="text"><div class="insp-label">文本</div>',
      '<div class="insp-row"><span>字体</span><select id="insp-font">',
      '<option value="">跟随文档</option>',
      '<option value="-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif">无衬线（现代）</option>',
      '<option value="Georgia,\'Songti SC\',\'SimSun\',serif">衬线（正式）</option>',
      '<option value="ui-monospace,Menlo,Consolas,monospace">等宽（代码）</option>',
      '<option value="\'PingFang SC\',\'Microsoft YaHei\',sans-serif">黑体</option>',
      '<option value="\'Songti SC\',\'SimSun\',serif">宋体</option>',
      '<option value="\'Kaiti SC\',\'KaiTi\',serif">楷体</option>',
      '</select></div>',
      '<div class="insp-grid">',
      '<label>字号<input id="insp-fs" type="number" min="6"></label>',
      '<label>行高<input id="insp-lh" type="number" step="0.1" min="0.5"></label>',
      '<label>字距<input id="insp-ls" type="number" step="0.5"></label>',
      '<label>字色<input id="insp-color" type="color" value="#ffffff"></label>',
      '</div>',
      '<div class="insp-btns">',
      '<button data-ia="bold" title="加粗">B</button>',
      '<button data-ia="italic" title="斜体">I</button>',
      '<button data-ia="underline" title="下划线">U</button>',
      '<button data-ia="text-shadow" title="文字阴影">影</button>',
      ibtn('text-left', 'i-text-left', '左对齐'), ibtn('text-center', 'i-text-center', '居中'), ibtn('text-right', 'i-text-right', '右对齐'),
      '</div></div>',

      /* ③ 图片与图形 —— 媒体 / SVG */
      '<div class="insp-group" data-for="media svg"><div class="insp-label">图片与图形</div>',
      '<div class="insp-row"><span>适应</span><select id="insp-fit">',
      '<option value="">默认</option><option value="cover">裁切填满</option><option value="contain">完整显示</option>',
      '<option value="fill">拉伸铺满</option><option value="none">原始大小</option>',
      '</select></div>',
      '<div class="insp-row"><span>滤镜</span><select id="insp-filter">',
      '<option value="">无</option><option value="grayscale(1)">黑白</option><option value="blur(3px)">模糊</option>',
      '<option value="brightness(1.3)">提亮</option><option value="contrast(1.3)">增强对比</option><option value="saturate(1.6)">鲜艳</option>',
      '</select></div>',
      '<div class="insp-row"><span>图片</span><button data-ia="img-src" class="insp-wide">替换图片…</button></div>',
      '<div class="insp-row"><span>描边色</span><input id="insp-stroke" type="color" value="#ffffff"></div>',
      '</div>',

      /* ④ 填充与外观 —— 所有元素（形状最常用） */
      '<div class="insp-group" data-for="all"><div class="insp-label">填充与外观</div><div class="insp-grid">',
      '<label>填充<input id="insp-bg" type="color" value="#ffffff"></label>',
      '<label>圆角<input id="insp-radius" type="number" min="0"></label>',
      '<label>边框<input id="insp-bw" type="number" min="0"></label>',
      '<label>边框色<input id="insp-bc" type="color" value="#ffffff"></label>',
      '</div>',
      '<div class="insp-row"><span>渐变</span><span class="insp-inline">',
      '<button data-ia="grad" class="insp-wide">套用</button><button data-ia="grad-clear" class="insp-wide">清除</button>',
      '</span></div>',
      '<div class="insp-row"><span>阴影</span><select id="insp-shadow">',
      '<option value="">无</option><option value="sm">小</option><option value="md">中</option><option value="lg">大</option>',
      '</select></div>',
      '<div class="insp-row"><span>内边距</span><input id="insp-pad" type="number" min="0" class="insp-num-sm"></div>',
      '</div>',

      /* ⑤ 对齐 / 分布 / 层级 / 元素操作 —— 所有元素 */
      '<div class="insp-group" data-for="all"><div class="insp-label">对齐（单选对页面 / 多选对选区）</div><div class="insp-btns">',
      ibtn('align-left', 'i-align-left', '左对齐'), ibtn('align-hcenter', 'i-align-hcenter', '水平居中'), ibtn('align-right', 'i-align-right', '右对齐'),
      ibtn('align-top', 'i-align-top', '顶对齐'), ibtn('align-vcenter', 'i-align-vcenter', '垂直居中'), ibtn('align-bottom', 'i-align-bottom', '底对齐'),
      '</div></div>',
      '<div class="insp-group" data-for="all"><div class="insp-label">分布与层级</div><div class="insp-btns">',
      ibtn('dist-h', 'i-dist-h', '水平等距'), ibtn('dist-v', 'i-dist-v', '垂直等距'),
      ibtn('layer-front', 'i-layer-front', '置顶'), ibtn('layer-up', 'i-layer-up', '上移一层'),
      ibtn('layer-down', 'i-layer-down', '下移一层'), ibtn('layer-back', 'i-layer-back', '置底'),
      '</div></div>',
      '<div class="insp-group" data-for="all"><div class="insp-label">元素</div><div class="insp-btns">',
      '<button data-ia="dup" title="复制元素"><svg class="ico"><use href="#i-copy"/></svg></button>',
      '<button data-ia="del" title="删除元素"><svg class="ico"><use href="#i-trash"/></svg></button>',
      '</div></div>',

      '<div class="insp-hint">Shift / Ctrl 点击可多选 · Ctrl+A 全选 · Ctrl+C/V 复制粘贴 · Ctrl+D 复制元素 · 双击改文字</div>',
      '<input type="file" id="insp-img-file" accept="image/*" hidden>'
    ].join('');
    document.body.appendChild(p);
    p.addEventListener('click', onInspectorClick);
    p.addEventListener('change', onInspectorChange);
    p.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'insp-fs') return; // 数字框输入不即时提交，避免每键入一次都入历史
    });
    p.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    $parent('insp-img-file').addEventListener('change', onPickImageFile);
  }
  function setVal(id, v) {
    var el = $parent(id);
    if (el && document.activeElement !== el) el.value = v;
  }
  /* 计算元素当前旋转角（度） */
  function currentRotation(el) {
    var tr = getComputedStyle(el).transform;
    if (!tr || tr === 'none') return 0;
    var m = tr.match(/matrix\(([^)]+)\)/);
    if (!m) return 0;
    var p = m[1].split(',').map(parseFloat);
    return Math.round(Math.atan2(p[1], p[0]) * 180 / Math.PI);
  }
  /* 属性面板刷新：拖拽/缩放时高频触发，做 30ms 节流，避免边拖边卡 */
  var _inspAt = 0, _inspTimer2 = 0;
  function refreshInspector(immediate) {
    if (immediate) { _inspAt = Date.now(); doRefreshInspector(); return; }
    var now = Date.now();
    if (now - _inspAt >= 30) { _inspAt = now; doRefreshInspector(); return; }
    if (_inspTimer2) return;
    _inspTimer2 = setTimeout(function () { _inspTimer2 = 0; _inspAt = Date.now(); doRefreshInspector(); }, 30);
  }
  function doRefreshInspector() {
    var p = $parent('inspector');
    if (!p) return;
    if (!selEl) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden');
    var cs = getComputedStyle(selEl);
    var r = selEl.getBoundingClientRect();
    var slide = HSP.state.slides[HSP.state.current];
    var sr = (slide && slide.el) ? slide.el.getBoundingClientRect() : { left: 0, top: 0 };

    /* ① 按元素类型显示/隐藏分区 —— 这就是"不同元素可编辑项不同" */
    var kind = elKind(selEl);
    var kEl = $parent('insp-kind');
    if (kEl) kEl.textContent = (liveSel().length > 1) ? ('已选 ' + liveSel().length + ' 个') : (KIND_LABEL[kind] || '元素');
    Array.prototype.forEach.call(p.querySelectorAll('.insp-group[data-for]'), function (g) {
      var types = String(g.getAttribute('data-for')).split(/\s+/);
      var show = types.indexOf('all') >= 0 || types.indexOf(kind) >= 0;
      g.style.display = show ? '' : 'none';
    });

    /* ② 位置与大小 */
    setVal('insp-x', Math.round(r.left - sr.left));
    setVal('insp-y', Math.round(r.top - sr.top));
    setVal('insp-w', Math.round(r.width));
    setVal('insp-h', Math.round(r.height));
    setVal('insp-rot', currentRotation(selEl));
    setVal('insp-op', Math.round((cs.opacity === '' ? 1 : parseFloat(cs.opacity)) * 100));

    /* ③ 文本 */
    var fs = parseFloat(cs.fontSize) || 16;
    setVal('insp-fs', Math.round(fs));
    var lh = parseFloat(cs.lineHeight);
    setVal('insp-lh', isNaN(lh) ? '1.4' : (lh / fs).toFixed(2));
    setVal('insp-ls', Math.round((parseFloat(cs.letterSpacing) || 0) * 10) / 10);
    var cEl = $parent('insp-color'); if (cEl) cEl.value = rgbToHex(cs.color);
    var fEl = $parent('insp-font');
    if (fEl) {
      var fam = cs.fontFamily || '', hit = '';
      Array.prototype.forEach.call(fEl.options, function (o) {
        if (!o.value) return;
        var key = o.value.split(',')[0].replace(/['"]/g, '').trim();
        if (key && fam.toLowerCase().indexOf(key.toLowerCase()) >= 0) hit = o.value;
      });
      fEl.value = hit;
    }

    /* ④ 图片与图形 */
    var fitEl = $parent('insp-fit');
    if (fitEl) fitEl.value = (cs.objectFit && cs.objectFit !== 'fill') ? cs.objectFit : '';
    var fltEl = $parent('insp-filter');
    if (fltEl) fltEl.value = (cs.filter && cs.filter !== 'none') ? cs.filter : '';
    var stEl = $parent('insp-stroke');
    if (stEl) stEl.value = rgbToHex((cs.stroke && cs.stroke !== 'none') ? cs.stroke : cs.color);

    /* ⑤ 填充与外观 */
    var bgEl = $parent('insp-bg'); if (bgEl) bgEl.value = rgbToHex(cs.backgroundColor);
    setVal('insp-radius', Math.round(parseFloat(cs.borderTopLeftRadius) || 0));
    setVal('insp-bw', Math.round(parseFloat(cs.borderTopWidth) || 0));
    var bcEl = $parent('insp-bc'); if (bcEl) bcEl.value = rgbToHex(cs.borderTopColor);
    var shEl = $parent('insp-shadow');
    if (shEl) shEl.value = (cs.boxShadow && cs.boxShadow !== 'none') ? (shEl.value || 'md') : '';
    setVal('insp-pad', Math.round(parseFloat(cs.paddingTop) || 0));

    /* ⑥ 分布按钮：不足 3 个时禁用 */
    var few = liveSel().length < 3;
    ['dist-h', 'dist-v'].forEach(function (a) {
      var b = p.querySelector('[data-ia="' + a + '"]');
      if (b) { b.disabled = few; b.style.opacity = few ? '.35' : ''; }
    });
  }

  /* ---------- 对齐基准：单选 = 所在页，多选 = 选区包围盒 ---------- */
  function alignBase() {
    if (liveSel().length > 1) {
      var rs = liveSel().map(function (el) { return el.getBoundingClientRect(); });
      return {
        left: Math.min.apply(null, rs.map(function (r) { return r.left; })),
        top: Math.min.apply(null, rs.map(function (r) { return r.top; })),
        right: Math.max.apply(null, rs.map(function (r) { return r.right; })),
        bottom: Math.max.apply(null, rs.map(function (r) { return r.bottom; }))
      };
    }
    var slide = HSP.state.slides[HSP.state.current];
    if (!slide || !slide.el) return null;
    var r2 = slide.el.getBoundingClientRect();
    return { left: r2.left, top: r2.top, right: r2.right, bottom: r2.bottom };
  }
  /* ---------- 智能参考线：拖动时吸附到页面 / 同级元素的对齐线（按住 Alt 临时关闭） ---------- */
  var SNAP_PX = 6;
  var dragBaseRect = null;
  function snapTargets(items) {
    var slide = HSP.state.slides[HSP.state.current];
    var xs = [], ys = [];
    if (slide && slide.el) {
      var sr = slide.el.getBoundingClientRect();
      xs.push(sr.left, sr.left + sr.width / 2, sr.right);
      ys.push(sr.top, sr.top + sr.height / 2, sr.bottom);
    }
    var main = items[0] && items[0].el;
    var parent = main && main.parentElement;
    if (parent) {
      var sibs = Array.prototype.slice.call(parent.children, 0, 40);
      sibs.forEach(function (el) {
        if (el === main) return;
        if (main && main.contains(el)) return;
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        xs.push(r.left, r.left + r.width / 2, r.right);
        ys.push(r.top, r.top + r.height / 2, r.bottom);
      });
    }
    return { xs: xs, ys: ys };
  }
  function nearestDelta(cands, targets) {
    var bestD = SNAP_PX + 1, bestShift = 0, bestLine = null;
    cands.forEach(function (cv) {
      targets.forEach(function (tv) {
        var dd = Math.abs(cv - tv);
        if (dd < bestD) { bestD = dd; bestShift = tv - cv; bestLine = tv; }
      });
    });
    return bestD <= SNAP_PX ? { shift: bestShift, line: bestLine } : null;
  }
  function snapDelta(items, dx, dy) {
    var guides = [];
    if (!dragBaseRect) return { dx: dx, dy: dy, guides: guides };
    var t = snapTargets(items);
    var r = dragBaseRect;
    var hx = nearestDelta([r.left + dx, (r.left + r.right) / 2 + dx, r.right + dx], t.xs);
    if (hx) { dx += hx.shift; guides.push({ dir: 'v', at: hx.line }); }
    var hy = nearestDelta([r.top + dy, (r.top + r.bottom) / 2 + dy, r.bottom + dy], t.ys);
    if (hy) { dy += hy.shift; guides.push({ dir: 'h', at: hy.line }); }
    return { dx: dx, dy: dy, guides: guides };
  }
  function showGuides(guides) {
    var box = $parent('hsp-guides');
    if (!box) return;
    box.innerHTML = '';
    if (!guides || !guides.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    var fr = frameRect();
    guides.forEach(function (g) {
      var d = document.createElement('div');
      d.className = 'hsp-guide ' + (g.dir === 'v' ? 'v' : 'h');
      if (g.dir === 'v') d.style.left = (g.at + fr.left) + 'px';
      else d.style.top = (g.at + fr.top) + 'px';
      box.appendChild(d);
    });
  }

  /* 位移：static 元素转 relative；绝对定位元素以 computed left/top 为基准（否则会跳到左上角） */
  function moveElBy(el, dx, dy) {
    if (!dx && !dy) return;
    var cs = getComputedStyle(el);
    var wasStatic = cs.position === 'static';
    if (wasStatic) el.style.position = 'relative';
    var baseL = 0, baseT = 0;
    if (!wasStatic) {
      var op = el.offsetParent || doc().body;
      var r = el.getBoundingClientRect();
      var opR = op.getBoundingClientRect();
      baseL = Math.round(r.left - opR.left);
      baseT = Math.round(r.top - opR.top);
    }
    el.style.left = (baseL + dx) + 'px';
    el.style.top = (baseT + dy) + 'px';
  }
  function doAlign(kind) {
    if (!liveSel().length) return;
    var base = alignBase();
    if (!base) return;
    // 先固化 transform 再快照全部位置，避免逐个应用时互相影响
    var snap = liveSel().map(function (el) {
      normalizeTransform(el);
      return { el: el, r: el.getBoundingClientRect() };
    });
    if (kind === 'dist-h' || kind === 'dist-v') { doDistribute(kind, snap); updateSelBox(); refreshInspector(true); commit(); return; }
    var bw = base.right - base.left, bh = base.bottom - base.top;
    var deltas = snap.map(function (it) {
      var r = it.r, dx = 0, dy = 0;
      if (kind === 'left') dx = base.left - r.left;
      else if (kind === 'hcenter') dx = (base.left + bw / 2) - (r.left + r.width / 2);
      else if (kind === 'right') dx = base.right - r.right;
      else if (kind === 'top') dy = base.top - r.top;
      else if (kind === 'vcenter') dy = (base.top + bh / 2) - (r.top + r.height / 2);
      else if (kind === 'bottom') dy = base.bottom - r.bottom;
      return { el: it.el, dx: Math.round(dx), dy: Math.round(dy) };
    });
    deltas.forEach(function (d) { moveElBy(d.el, d.dx, d.dy); });
    updateSelBox();
    refreshInspector(true);
    commit();
  }
  function doDistribute(kind, snap) {
    if (snap.length < 3) return;
    var horiz = kind === 'dist-h';
    var sorted = snap.slice().sort(function (a, b) {
      return horiz ? (a.r.left - b.r.left) : (a.r.top - b.r.top);
    });
    var first = sorted[0].r, last = sorted[sorted.length - 1].r;
    var span = horiz ? (last.left - first.left) : (last.top - first.top);
    var sum = sorted.reduce(function (s, it) { return s + (horiz ? it.r.width : it.r.height); }, 0);
    var gap = (span - sum) / (sorted.length - 1);
    var pos = horiz ? first.left : first.top;
    sorted.forEach(function (it, i) {
      if (i > 0) {
        if (horiz) moveElBy(it.el, Math.round(pos - it.r.left), 0);
        else moveElBy(it.el, 0, Math.round(pos - it.r.top));
      }
      pos += (horiz ? it.r.width : it.r.height) + gap;
    });
  }
  /* ---------- 层级 ---------- */
  function layerOp(kind) {
    if (!liveSel().length) return;
    liveSel().forEach(function (el) {
      var p = el.parentElement;
      if (!p) return;
      el.style.zIndex = ''; // 层级统一走 DOM 顺序，清掉 z-index 避免两套机制打架
      if (kind === 'front') p.appendChild(el);
      else if (kind === 'back') p.insertBefore(el, p.firstChild);
      else if (kind === 'up' && el.nextElementSibling) p.insertBefore(el.nextElementSibling, el);
      else if (kind === 'down' && el.previousElementSibling) p.insertBefore(el, el.previousElementSibling);
    });
    updateSelBox();
    commit();
  }
  /* ---------- 外观 / 文本 / 几何 ---------- */
  function setRadius(v) {
    liveSel().forEach(function (el) { el.style.setProperty('border-radius', Math.max(0, v) + 'px', 'important'); });
    commit();
  }
  function setBorder(w, color) {
    liveSel().forEach(function (el) {
      if (w > 0) el.style.setProperty('border', w + 'px solid ' + (color || '#ffffff'), 'important');
      else el.style.setProperty('border', 'none', 'important');
    });
    commit();
  }
  var SHADOWS = { '': 'none', sm: '0 1px 3px rgba(0,0,0,.25)', md: '0 6px 20px rgba(0,0,0,.35)', lg: '0 18px 50px rgba(0,0,0,.45)' };
  function setShadow(level) {
    liveSel().forEach(function (el) { el.style.setProperty('box-shadow', SHADOWS[level] || 'none', 'important'); });
    commit();
  }
  function setTextAlign(v) {
    liveSel().forEach(function (el) { el.style.setProperty('text-align', v, 'important'); });
    commit();
  }
  /* ---------- 文本进阶 ---------- */
  function setFontFamily(v) {
    liveSel().forEach(function (el) { el.style.setProperty('font-family', v, 'important'); });
    commit();
  }
  function setFontSizePx(v) {
    if (isNaN(v)) return;
    liveSel().forEach(function (el) { el.style.setProperty('font-size', Math.max(6, Math.round(v)) + 'px', 'important'); });
    commit();
  }
  function setLineHeight(v) {
    if (isNaN(v) || v <= 0) return;
    liveSel().forEach(function (el) { el.style.setProperty('line-height', String(v), 'important'); });
    commit();
  }
  function setLetterSpacing(v) {
    if (isNaN(v)) return;
    liveSel().forEach(function (el) { el.style.setProperty('letter-spacing', v + 'px', 'important'); });
    commit();
  }
  function toggleUnderline() {
    liveSel().forEach(function (el) {
      var on = (getComputedStyle(el).textDecorationLine || '').indexOf('underline') >= 0;
      el.style.setProperty('text-decoration', on ? 'none' : 'underline', 'important');
    });
    commit();
  }
  function toggleTextShadow() {
    liveSel().forEach(function (el) {
      var ts = getComputedStyle(el).textShadow;
      var on = ts && ts !== 'none';
      el.style.setProperty('text-shadow', on ? 'none' : '0 2px 12px rgba(0,0,0,.45)', 'important');
    });
    commit();
  }
  /* ---------- 图片 / 图形进阶 ---------- */
  function setObjectFit(v) {
    liveSel().forEach(function (el) { el.style.setProperty('object-fit', v || 'fill', 'important'); });
    commit();
  }
  function setFilter(v) {
    liveSel().forEach(function (el) { el.style.setProperty('filter', v || 'none', 'important'); });
    commit();
  }
  function setStroke(color) {
    liveSel().forEach(function (el) {
      var tag = String(el.tagName || '').toUpperCase();
      if (tag === 'SVG') {
        el.style.setProperty('stroke', color, 'important');
        Array.prototype.forEach.call(el.querySelectorAll('path,circle,line,rect,polyline,polygon,ellipse'), function (c) {
          c.style.setProperty('stroke', color, 'important');
        });
      } else if (el.ownerSVGElement) {
        el.style.setProperty('stroke', color, 'important');
      }
    });
    commit();
  }
  /* 替换图片：本地文件 → dataURL（IMG 换 src，其它元素换成背景图） */
  function pickImage() {
    var f = $parent('insp-img-file');
    if (f) { f.value = ''; f.click(); }
  }
  function onPickImageFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file || !selEl) return;
    var rd = new FileReader();
    rd.onload = function () {
      var url = String(rd.result);
      if (String(selEl.tagName).toUpperCase() === 'IMG') selEl.setAttribute('src', url);
      else selEl.style.setProperty('background-image', 'url("' + url + '")', 'important');
      selEl.style.setProperty('background-size', 'cover', 'important');
      commit();
      updateSelBox();
      if (HSP.toast) HSP.toast('已替换图片');
    };
    rd.readAsDataURL(file);
  }
  /* ---------- 填充进阶 ---------- */
  function setBackgroundColor(color) {
    liveSel().forEach(function (el) { el.style.setProperty('background', color, 'important'); });
    commit();
  }
  function applyGradient() {
    liveSel().forEach(function (el) {
      el.style.setProperty('background', 'linear-gradient(135deg, #4d8dff 0%, #a78bfa 100%)', 'important');
    });
    commit();
    refreshInspector(true);
  }
  function clearGradient() {
    liveSel().forEach(function (el) {
      var c = getComputedStyle(el).backgroundColor;
      el.style.setProperty('background-image', 'none', 'important');
      if (!c || c === 'rgba(0, 0, 0, 0)') el.style.setProperty('background-color', 'transparent', 'important');
    });
    commit();
    refreshInspector(true);
  }
  function setPadding(v) {
    if (isNaN(v)) return;
    liveSel().forEach(function (el) { el.style.setProperty('padding', Math.max(0, Math.round(v)) + 'px', 'important'); });
    commit();
  }
  function setOpacity(pct) {
    var v = Math.max(0, Math.min(100, pct)) / 100;
    liveSel().forEach(function (el) { el.style.setProperty('opacity', String(v), 'important'); });
    commit();
  }
  function setRotation(deg) {
    liveSel().forEach(function (el) {
      normalizeTransform(el); // 先把平移固化成 left/top，避免叠加跳位
      el.style.setProperty('transform', deg ? ('rotate(' + deg + 'deg)') : 'none', 'important');
    });
    updateSelBox();
    commit();
  }
  function applyGeom(id, val) {
    if (!liveSel().length || !selEl || isNaN(val)) return;
    if (id === 'insp-x' || id === 'insp-y') {
      var slide = HSP.state.slides[HSP.state.current];
      var sr = (slide && slide.el) ? slide.el.getBoundingClientRect() : { left: 0, top: 0 };
      var r = selEl.getBoundingClientRect();
      if (id === 'insp-x') moveElBy(selEl, Math.round(val - (r.left - sr.left)), 0);
      else moveElBy(selEl, 0, Math.round(val - (r.top - sr.top)));
    } else if (id === 'insp-w') {
      selEl.style.setProperty('width', Math.max(1, Math.round(val)) + 'px', 'important');
      selEl.style.setProperty('max-width', 'none', 'important');
    } else if (id === 'insp-h') {
      selEl.style.setProperty('height', Math.max(1, Math.round(val)) + 'px', 'important');
      selEl.style.setProperty('max-height', 'none', 'important');
    } else if (id === 'insp-rot') setRotation(val);
    else if (id === 'insp-op') setOpacity(val);
    else if (id === 'insp-radius') setRadius(val);
    updateSelBox();
    refreshInspector(true);
    commit();
  }
  function onInspectorClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ia]') : null;
    if (!b || b.disabled) return;
    e.preventDefault(); e.stopPropagation();
    var a = b.getAttribute('data-ia');
    if (a.indexOf('align-') === 0) doAlign(a.slice(6));
    else if (a === 'dist-h' || a === 'dist-v') doAlign(a);
    else if (a.indexOf('layer-') === 0) layerOp(a.slice(6));
    else if (a === 'text-shadow') toggleTextShadow();
    else if (a.indexOf('text-') === 0) setTextAlign(a.slice(5));
    else if (a === 'bold') toggleBold();
    else if (a === 'italic') toggleItalic();
    else if (a === 'underline') toggleUnderline();
    else if (a === 'grad') applyGradient();
    else if (a === 'grad-clear') clearGradient();
    else if (a === 'img-src') pickImage();
    else if (a === 'dup') dupSelected();
    else if (a === 'del') delSelected();
  }
  function onInspectorChange(e) {
    var id = e.target && e.target.id;
    if (!id || id.indexOf('insp-') !== 0) return;
    if (id === 'insp-shadow') { setShadow(e.target.value); return; }
    if (id === 'insp-bc') { setBorder(parseFloat(($parent('insp-bw') || {}).value) || 1, e.target.value); return; }
    if (id === 'insp-bw') { setBorder(parseFloat(e.target.value) || 0, ($parent('insp-bc') || {}).value); return; }
    if (id === 'insp-font') { setFontFamily(e.target.value); return; }
    if (id === 'insp-fs') { setFontSizePx(parseFloat(e.target.value)); return; }
    if (id === 'insp-lh') { setLineHeight(parseFloat(e.target.value)); return; }
    if (id === 'insp-ls') { setLetterSpacing(parseFloat(e.target.value)); return; }
    if (id === 'insp-color') {
      liveSel().forEach(function (el) { setTextColor(el, e.target.value); });
      commit(); return;
    }
    if (id === 'insp-bg') { setBackgroundColor(e.target.value); return; }
    if (id === 'insp-pad') { setPadding(parseFloat(e.target.value)); return; }
    if (id === 'insp-fit') { setObjectFit(e.target.value); return; }
    if (id === 'insp-filter') { setFilter(e.target.value); return; }
    if (id === 'insp-stroke') { setStroke(e.target.value); return; }
    applyGeom(id, parseFloat(e.target.value));
  }
  /* ---------- 全选 / 复制 / 粘贴 ---------- */
  function selectAll() {
    var slide = HSP.state.slides[HSP.state.current];
    if (!slide || !slide.el) return;
    var kids = Array.prototype.filter.call(slide.el.children, isSelectable);
    if (!kids.length) return;
    selEls.forEach(function (x) { try { x.classList.remove('__hsp_moving'); } catch (e0) {} });
    selEls = kids;
    kids.forEach(function (el) { el.classList.add('__hsp_moving'); });
    selEl = kids[kids.length - 1];
    updateSelBox(); updateToolbarFor(selEl); syncColorInputs(selEl); renderMultiBoxes(); refreshInspector(true);
  }
  var clipboard = [];
  function copySel() {
    if (!liveSel().length) return;
    clipboard = liveSel().map(function (el) { return el.cloneNode(true); });
    if (HSP.toast) HSP.toast('已复制 ' + clipboard.length + ' 个元素');
  }
  function pasteSel() {
    var slide = HSP.state.slides[HSP.state.current];
    if (!slide || !slide.el || !clipboard.length) return;
    var news = [];
    clipboard.forEach(function (c) {
      var n = c.cloneNode(true);
      if (getComputedStyle(n).position === 'static') n.style.position = 'relative';
      n.style.left = ((parseFloat(n.style.left) || 0) + 18) + 'px';
      n.style.top = ((parseFloat(n.style.top) || 0) + 18) + 'px';
      n.classList.remove('__hsp_moving');
      slide.el.appendChild(n);
      news.push(n);
    });
    clipboard = news.map(function (n) { return n.cloneNode(true); }); // 连续粘贴逐次错开
    selEls = news;
    selEl = news[news.length - 1];
    news.forEach(function (n) { n.classList.add('__hsp_moving'); });
    updateSelBox(); updateToolbarFor(selEl); syncColorInputs(selEl); renderMultiBoxes(); refreshInspector(true);
    if (HSP.toast) HSP.toast('已粘贴 ' + news.length + ' 个元素');
    commit();
  }
  /* 选中框/工具条用主窗口坐标（iframe 视口坐标 + iframe 在窗口中的偏移），并钳制在视口内。
     节流：16ms 内合并高频调用（拖拽/缩放），首次同步执行保证即时显示。 */
  var lastSelBox = 0, selBoxTimer = 0;
  function updateSelBox() {
    var now = Date.now();
    if (now - lastSelBox >= 16) {
      lastSelBox = now;
      doUpdateSelBox();
      return;
    }
    if (selBoxTimer) return;
    selBoxTimer = setTimeout(function () {
      selBoxTimer = 0;
      lastSelBox = Date.now();
      doUpdateSelBox();
    }, 16);
  }
  function doUpdateSelBox() {
    var sel = $parent('hsp-sel'), tb = $parent('hsp-tb');
    if (!sel || !tb || !selEl) return;
    var r = selEl.getBoundingClientRect();
    var fr = frameRect();
    var vw = document.documentElement.clientWidth || 800;
    var vh = document.documentElement.clientHeight || 600;
    var x = r.left + fr.left, y = r.top + fr.top;
    sel.style.display = 'block';
    sel.style.left = x + 'px';
    sel.style.top = y + 'px';
    sel.style.width = Math.max(2, r.width) + 'px';
    sel.style.height = Math.max(2, r.height) + 'px';
    tb.style.display = 'flex';
    var tbW = tb.offsetWidth || 220;
    var tbLeft = Math.min(Math.max(4, x), Math.max(4, vw - tbW - 4));
    var tbTop = y - 38;
    if (tbTop < 4) tbTop = y + r.height + 6;
    if (tbTop + 36 > vh) tbTop = Math.max(4, y - 38);
    tb.style.left = tbLeft + 'px';
    tb.style.top = tbTop + 'px';
    renderMultiBoxes();
  }
  /* 工具条按元素类型裁剪：文本类工具只在文本/列表元素上出现 */
  function updateToolbarFor(el) {
    var tb = $parent('hsp-tb');
    if (!tb) return;
    var kind = elKind(el);
    var textish = (kind === 'text' || kind === 'list');
    var kids = tb.querySelectorAll('[data-a]');
    for (var i = 0; i < kids.length; i++) {
      var a = kids[i].getAttribute('data-a');
      kids[i].style.display = (TEXT_TOOLS.indexOf(a) !== -1 && !textish) ? 'none' : '';
    }
  }
  function rgbToHex(c) {
    var m = c && c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return '#ffffff';
    // 全透明（如渐变文字 color:transparent）→ 给拾色器一个可读初值，避免显示成黑色
    if (m[4] !== undefined && parseFloat(m[4]) < 0.05) return '#ffffff';
    var to2 = function (n) { var s = (+n).toString(16); return s.length === 1 ? '0' + s : s; };
    return '#' + to2(m[1]) + to2(m[2]) + to2(m[3]);
  }
  function syncColorInputs(el) {
    var tb = $parent('hsp-tb');
    if (!tb || !el) return;
    var cInp = tb.querySelector('[data-a="color"]');
    var bInp = tb.querySelector('[data-a="bg"]');
    if (!el) return;
    var cs = getComputedStyle(el);
    if (cInp) cInp.value = rgbToHex(cs.color);
    if (bInp) bInp.value = rgbToHex(cs.backgroundColor);
  }

  /* ---------- iframe 内文档事件 ---------- */
  function onDocClick(e) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(e.target.tagName) !== -1) return; // 放行表单
    if (editingEl && e.target === editingEl) return;
    if (editingEl && editingEl !== e.target) endTextEdit();
    var el = pickTarget(e.target);
    if (!el) { clearSelection(); return; }
    e.preventDefault();
    // Shift / Ctrl / Cmd 点击 = 加选、减选
    select(el, !!(e.shiftKey || e.ctrlKey || e.metaKey));
  }
  function onDocDblClick(e) {
    var el = pickTarget(e.target);
    if (!el) return;
    e.preventDefault();
    select(el);
    if (MEDIA.indexOf(el.tagName) === -1) startTextEdit(el); // 媒体元素双击仅选中
  }
  /* 把元素的 transform 固化为 left/top，避免移动/缩放时叠加跳位 */
  function parseMatrix(tr) {
    var m = tr && tr.match(/matrix\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(',').map(parseFloat);
    if (p[1] === 0 && p[2] === 0 && p[0] === 1 && p[3] === 1) return { translate: true, tx: p[4], ty: p[5], a: 1, b: 0, c: 0, d: 1 };
    return { translate: false, a: p[0], b: p[1], c: p[2], d: p[3], tx: p[4], ty: p[5] };
  }
  /* 把元素的 transform 固化为 left/top（拖动/缩放更准），但保留旋转与缩放 —— 否则一拖就把旋转弄丢 */
  function normalizeTransform(el) {
    var d2 = doc();
    if (!el || !d2) return;
    var cs = getComputedStyle(el);
    var tr = cs.transform;
    if (!tr || tr === 'none') return;
    var m = parseMatrix(tr);
    if (!m || m.a === undefined) return;
    var op = (el.offsetParent || d2.body).getBoundingClientRect();
    var rr = el.getBoundingClientRect();
    // 保留旋转/缩放部分；平移一律转成 left/top
    el.style.transform = (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1)
      ? 'none'
      : ('matrix(' + m.a + ',' + m.b + ',' + m.c + ',' + m.d + ',0,0)');
    if (cs.position === 'static' || cs.position === 'relative') {
      if (cs.position === 'static') el.style.position = 'relative';
      el.style.left = Math.round((parseFloat(el.style.left) || 0) + m.tx) + 'px';
      el.style.top = Math.round((parseFloat(el.style.top) || 0) + m.ty) + 'px';
    } else {
      el.style.left = Math.round(rr.left - m.tx - op.left) + 'px';
      el.style.top = Math.round(rr.top - m.ty - op.top) + 'px';
    }
  }

  function attachParentMoveUp() {
    document.addEventListener('pointermove', onDocPointerMove, true);
    document.addEventListener('pointerup', onDocPointerUp, true);
  }
  function onDocPointerDown(e) {
    if (!selEl || editingEl || dragging) return;
    if (e.button !== 0) return;
    // 交互控件优先响应自身：一旦选中了它们的容器（例如点过交互区域），
    // 若不排除就会把"拖动滑块"当成"移动元素"并 preventDefault，控件会完全没反应。
    var t0 = e.target;
    if (t0 && t0.closest && t0.closest('input,textarea,select,button,a,label,summary,video,audio,[contenteditable]')) return;
    var inside = (e.target === selEl || selEl.contains(e.target));
    if (!inside) return;
    // 多选时整体拖动；先固化 transform，移动才不跳位
    var moves = selEls.length ? liveSel().slice() : [selEl];
    moves.forEach(function (el) { normalizeTransform(el); });
    dragBaseRect = moves[0].getBoundingClientRect();
    dragging = true;
    dragData = {
      type: 'move',
      startX: e.clientX, startY: e.clientY,
      items: moves.map(function (el) {
        // 用实际像素位置做起点：left/top 可能是 %/em/vh/auto，parseFloat 会丢单位导致拖动跳位
        var cs = getComputedStyle(el);
        var wasStatic = cs.position === 'static';
        var origLeft = 0, origTop = 0;
        if (!wasStatic) {
          var op = el.offsetParent || doc().body;
          var r = el.getBoundingClientRect();
          var opR = op.getBoundingClientRect();
          origLeft = Math.round(r.left - opR.left);
          origTop = Math.round(r.top - opR.top);
        }
        return { el: el, origLeft: origLeft, origTop: origTop, wasStatic: wasStatic };
      })
    };
    attachParentMoveUp(); // 指针拖出 iframe 时也能继续移动
    e.preventDefault();
  }
  function onDocPointerMove(e) {
    if (!dragging || !dragData) return;
    if (dragData.type === 'resize') { resizeMove(e); return; }
    var dx = e.clientX - dragData.startX;
    var dy = e.clientY - dragData.startY;
    // 智能参考线吸附（按住 Alt 可临时关闭）
    if (!e.altKey) {
      var sn = snapDelta(dragData.items, dx, dy);
      dx = sn.dx; dy = sn.dy;
      showGuides(sn.guides);
    } else {
      showGuides(null);
    }
    dragData.items.forEach(function (it) {
      if (it.wasStatic) it.el.style.position = 'relative';
      it.el.style.left = Math.round(it.origLeft + dx) + 'px';
      it.el.style.top = Math.round(it.origTop + dy) + 'px';
    });
    updateSelBox();
  }
  function onDocPointerUp() {
    if (dragging) {
      dragging = false;
      document.removeEventListener('pointermove', onDocPointerMove, true);
      document.removeEventListener('pointerup', onDocPointerUp, true);
      showGuides(null);
      dragBaseRect = null;
      commit();
    }
  }
  function onDocKey(e) {
    // 快捷键（不拦截文字编辑中的 Ctrl+Z，保留原生撤销）
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (editingEl) return;
      e.preventDefault(); undoEdit(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      if (editingEl) return;
      e.preventDefault(); dupSelected(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      if (editingEl) return;
      e.preventDefault(); selectAll(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      if (editingEl) return;
      e.preventDefault(); copySel(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      if (editingEl) return;
      e.preventDefault(); pasteSel(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); HSP.events.emit('save-shortcut'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); HSP.events.emit('open-shortcut'); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); HSP.events.emit('fullscreen-shortcut'); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editingEl) return;
      if (selEl) { e.preventDefault(); delSelected(); }
    } else if (e.key === 'Escape') {
      if (editingEl) endTextEdit();
      else if (selEl) clearSelection();
      else HSP.events.emit('esc-edit'); // 无选中时退出编辑模式
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) !== -1) {
      if (editingEl || !selEl) return;
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1;
      var dx = e.key === 'ArrowLeft' ? -step : (e.key === 'ArrowRight' ? step : 0);
      var dy = e.key === 'ArrowUp' ? -step : (e.key === 'ArrowDown' ? step : 0);
      (liveSel().length ? liveSel() : [selEl]).forEach(function (el) {
        normalizeTransform(el);
        moveElBy(el, dx, dy);
      });
      updateSelBox();
      refreshInspector();
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(commit, 180); // 防抖，避免按住时每步全量序列化
    }
  }

  /* ---------- 缩放（8 手柄：角等比、边单轴） ---------- */
  function startResize(dir, e) {
    if (!selEl) return;
    normalizeTransform(selEl);
    selEl.style.maxWidth = 'none';
    selEl.style.maxHeight = 'none';
    dragging = true;
    var r = selEl.getBoundingClientRect();
    dragData = {
      type: 'resize', dir: dir,
      startX: e.clientX, startY: e.clientY,
      origW: r.width, origH: r.height,
      origLeft: parseFloat(selEl.style.left) || 0,
      origTop: parseFloat(selEl.style.top) || 0,
      wasStatic: getComputedStyle(selEl).position === 'static',
      ratio: r.width / r.height
    };
    attachParentMoveUp();
    e.preventDefault(); e.stopPropagation();
  }
  function resizeMove(e) {
    var dx = e.clientX - dragData.startX;
    var dy = e.clientY - dragData.startY;
    var dir = dragData.dir;
    var w = dragData.origW, h = dragData.origH;
    var left = dragData.origLeft, top = dragData.origTop;
    if (dir.length === 2) {
      var rawW = dir.indexOf('e') !== -1 ? dragData.origW + dx : dragData.origW - dx;
      var scale = Math.max(0.05, rawW / dragData.origW);
      w = dragData.origW * scale;
      h = w / dragData.ratio;
      if (dir.indexOf('w') !== -1) left = dragData.origLeft + (dragData.origW - w);
      if (dir.indexOf('n') !== -1) top = dragData.origTop + (dragData.origH - h);
    } else {
      if (dir === 'e') { w = dragData.origW + dx; }
      if (dir === 'w') { w = dragData.origW - dx; left = dragData.origLeft + (dragData.origW - w); }
      if (dir === 's') { h = dragData.origH + dy; }
      if (dir === 'n') { h = dragData.origH - dy; top = dragData.origTop + (dragData.origH - h); }
    }
    w = Math.max(8, w); h = Math.max(8, h);
    if (dragData.wasStatic) selEl.style.position = 'relative';
    selEl.style.width = Math.round(w) + 'px';
    selEl.style.height = Math.round(h) + 'px';
    if (dir.indexOf('w') !== -1) selEl.style.left = Math.round(left) + 'px';
    if (dir.indexOf('n') !== -1) selEl.style.top = Math.round(top) + 'px';
    updateSelBox();
  }

  /* ---------- 文字编辑（双击进入） ---------- */
  function startTextEdit(el) {
    editingEl = el;
    el.classList.remove('__hsp_moving');
    el.contentEditable = 'true';
    el.focus();
    // 改字时收起工具条，避免遮挡
    var tb = $parent('hsp-tb');
    if (tb) tb.style.display = 'none';
    el.addEventListener('blur', endTextEdit);
    el.addEventListener('keydown', onEditKey);
  }
  function endTextEdit() {
    if (!editingEl) return;
    var el = editingEl;
    editingEl = null;
    el.contentEditable = 'false';
    el.removeEventListener('blur', endTextEdit);
    el.removeEventListener('keydown', onEditKey);
    if (selEl === el) el.classList.add('__hsp_moving');
    commit();
    updateSelBox();
  }
  function onEditKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); endTextEdit(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'DIV' && e.target.tagName !== 'P') {
      e.preventDefault(); endTextEdit();
    }
  }

  /* ---------- 元素操作 ---------- */
  function delSelected() {
    if (!selEl || !selEl.parentNode) return;
    selEl.parentNode.removeChild(selEl);
    clearSelection();
    commit();
  }
  function dupSelected() {
    if (!selEl || !selEl.parentNode) return;
    normalizeTransform(selEl);
    var wasStatic = getComputedStyle(selEl).position === 'static';
    var clone = selEl.cloneNode(true);
    clone.classList.remove('__hsp_moving');
    selEl.parentNode.insertBefore(clone, selEl.nextSibling);
    if (wasStatic) clone.style.position = 'relative';
    clone.style.left = ((parseFloat(selEl.style.left) || 0) + 18) + 'px';
    clone.style.top = ((parseFloat(selEl.style.top) || 0) + 18) + 'px';
    clearSelection();
    commit();
    select(clone);
  }
  /* 置顶 / 置底：与 layerOp 统一走 DOM 顺序（清除 z-index 由 layerOp 处理） */
  function bringFront() { layerOp('front'); }
  function sendBack() { layerOp('back'); }
  function toggleBold() {
    if (!selEl) return;
    var cur = getComputedStyle(selEl).fontWeight;
    if (parseInt(cur, 10) >= 600) {
      selEl.style.setProperty('font-weight', selEl.__origWeight || 'normal', 'important');
    } else {
      selEl.__origWeight = selEl.style.fontWeight || cur;
      selEl.style.setProperty('font-weight', '700', 'important');
    }
    commit();
  }
  function toggleItalic() {
    if (!selEl) return;
    var cur = getComputedStyle(selEl).fontStyle;
    selEl.style.setProperty('font-style', cur === 'italic' ? 'normal' : 'italic', 'important');
    commit();
  }
  function changeFontSize(dir) {
    if (!selEl) return;
    var cur = parseFloat(getComputedStyle(selEl).fontSize) || 16;
    var next = dir > 0 ? cur * 1.15 : cur / 1.15;
    selEl.style.setProperty('font-size', Math.max(6, Math.round(next)) + 'px', 'important');
    commit();
  }
  function commit() {
    _kEl = null; // 元素类型可能因样式变化而改变（例如加了背景就成为形状）
    // 记录修改前的快照，供 Ctrl+Z 撤销
    if (lastCommitted != null) {
      history.push(lastCommitted);
      if (history.length > 20) history.shift();
    }
    var moving = selEl && selEl.classList.contains('__hsp_moving');
    if (selEl) selEl.classList.remove('__hsp_moving');
    HSP.player.syncFromDOM();
    if (moving && selEl) selEl.classList.add('__hsp_moving');
    HSP.player.redetect();
    lastCommitted = HSP.player.serialize();
    HSP.events.emit('docschange');
  }
  /* Ctrl+Z：恢复上一步之前的状态（重新载入文档） */
  function undoEdit() {
    var html = history.pop();
    if (html == null) return;
    lastCommitted = history.length ? history[history.length - 1] : null;
    if (window.HSP && HSP.openFromText) HSP.openFromText(html, HSP.state.sourceName || '', { keepAnnotations: true, keepMode: true }); // 保留标注与当前模式
  }

  /* ---------- 绑定 / 解绑（iframe 重新加载后需重绑） ---------- */
  function bindDoc() {
    var d = doc();
    if (!d || bound) return;
    d.addEventListener('click', onDocClick, true);
    d.addEventListener('dblclick', onDocDblClick, true);
    d.addEventListener('pointerdown', onDocPointerDown, true);
    d.addEventListener('pointermove', onDocPointerMove, true);
    d.addEventListener('pointerup', onDocPointerUp, true);
    d.addEventListener('keydown', onDocKey, true);
    bound = true;
  }
  function unbindDoc() {
    var d = doc();
    if (!d) return;
    d.removeEventListener('click', onDocClick, true);
    d.removeEventListener('dblclick', onDocDblClick, true);
    d.removeEventListener('pointerdown', onDocPointerDown, true);
    d.removeEventListener('pointermove', onDocPointerMove, true);
    d.removeEventListener('pointerup', onDocPointerUp, true);
    d.removeEventListener('keydown', onDocKey, true);
    bound = false;
  }
  function enter() {
    HSP.state.mode = 'edit';
    ensureUI();
    injectCursorRule();
    forceAnimEnd();
    if (!bound) bindDoc();
  }
  /* 编辑模式：把入场动画直接推到结束态（加 .in），元素位置才是它设计时的位置。
     注意：不再用 CSS 覆盖 transform —— 那会破坏用 transform 定位的元素（如 translate(-50%,-50%) 居中）。 */
  function forceAnimEnd() {
    var d = doc();
    if (!d) return;
    Array.prototype.forEach.call(d.querySelectorAll('.slide'), function (s) {
      try { s.classList.add('in'); } catch (e) {}
    });
  }
  function exit() {
    HSP.state.mode = 'view';
    endTextEdit();
    clearSelection();
    if (bound) unbindDoc();
  }
  /* iframe 内注入编辑期样式（序列化时会过滤）：
     暂停入场动画，保证元素可见、可选中；⑥ transform 不动，交给 normalizeTransform 在操作时固化 */
  function injectCursorRule() {
    var d = doc();
    if (!d || !d.head || d.getElementById('__hsp_style')) return;
    var st = d.createElement('style');
    st.id = '__hsp_style';
    st.textContent = [
      '.__hsp_moving{cursor:move!important}',
      'body.anim [data-anim],body.anim .w{opacity:1!important;transition:none!important;animation:none!important;}',
      'body.anim .glow{display:none!important;}',
      'body.anim .draw path,body.anim .draw line,body.anim .draw circle,body.anim .draw rect,body.anim .draw polyline{stroke-dashoffset:0!important;transition:none!important;}',
      'body.anim .bar i{width:var(--w,60%)!important;transition:none!important;}'
    ].join('');
    d.head.appendChild(st);
  }
  function reloadBinding() {
    selEl = null; selEls = []; editingEl = null; dragging = false; dragData = null;
    bound = false; // iframe 文档已替换，旧事件绑定失效，必须重绑
    if (HSP.state.mode === 'edit') {
      injectCursorRule();
      forceAnimEnd();
      bindDoc();
    }
  }

  /* ---------- 页面级结构编辑 ---------- */
  function curSlideEl() {
    var s = HSP.state.slides[HSP.state.current];
    return s ? s.el : null;
  }
  function _reload() {
    HSP.player.syncFromDOM();
    HSP.player.redetect();
    var R = win() && win().Reveal;
    if (R && R.sync) { try { R.sync(); } catch (e) {} }
    HSP.events.emit('docschange');
    clearSelection();
  }
  function blankSlideHTML() {
    return '<h2 style="margin:0 0 2vh;font-size:6vh;">新页面</h2>' +
           '<p style="font-size:3vh;color:#b9c3f0;">单击选中、双击改字、拖动移动、手柄缩放</p>';
  }
  function addSlide() {
    var cur = curSlideEl(), d = doc();
    if (!d || !cur) {
      // 还没有任何演示文稿：从零新建一份空白演示，再继续加页
      if (HSP.newBlankDeck) HSP.newBlankDeck();
      return;
    }
    var clone = cur.cloneNode(false);
    clone.innerHTML = blankSlideHTML();
    clone.removeAttribute('data-title');
    clone.removeAttribute('data-notes');
    cur.parentNode.insertBefore(clone, cur.nextSibling);
    _reload();
    HSP.player.go(HSP.state.current + 1);
  }
  function dupSlide(i) {
    var d = doc(); var s = HSP.state.slides[i];
    if (!d || !s) return;
    var clone = s.el.cloneNode(true);
    s.el.parentNode.insertBefore(clone, s.el.nextSibling);
    _reload();
  }
  function delSlide(i) {
    var d = doc(); var s = HSP.state.slides[i];
    if (!d || !s || HSP.state.total <= 1) return;
    s.el.parentNode.removeChild(s.el);
    _reload();
    HSP.player.go(Math.min(i, HSP.state.total - 1));
  }
  function moveSlide(from, to) {
    var d = doc(); if (!d) return;
    var s = HSP.state.slides;
    if (from < 0 || to < 0 || from >= s.length || to >= s.length || from === to) return;
    var el = s[from].el, ref = s[to].el;
    if (from < to) ref.parentNode.insertBefore(el, ref.nextSibling);
    else ref.parentNode.insertBefore(el, ref);
    _reload();
  }
  function setBackground(color) {
    var cur = curSlideEl(); if (!cur) return;
    // background 简写：清掉页面上可能的渐变/背景图，保证底色真正生效；重要级压过作者 !important
    cur.style.setProperty('background', color, 'important');
    HSP.player.syncFromDOM();
  }
  function addTextBox() {
    endTextEdit(); // 先结束可能残留的文字编辑，否则 editingEl 会拦下新建文本框的拖动
    var cur = curSlideEl(); if (!cur) return;
    var div = doc().createElement('div');
    div.className = 'hsp-textbox';
    div.textContent = '双击编辑文字';
    div.style.cssText = 'position:absolute;left:15%;top:15%;width:70%;padding:2vh 3vw;font-size:4vh;color:#eef2ff;background:rgba(0,0,0,.25);border-radius:1.5vh;';
    if (getComputedStyle(cur).position === 'static') cur.style.position = 'relative';
    cur.appendChild(div);
    _reload();
    select(div);
  }
  function addImage(url) {
    endTextEdit();
    var cur = curSlideEl(); if (!cur || !url) return;
    var img = doc().createElement('img');
    img.setAttribute('draggable', 'false');
    img.style.cssText = 'position:absolute;visibility:hidden;border-radius:1.5vh;';
    if (getComputedStyle(cur).position === 'static') cur.style.position = 'relative';
    cur.appendChild(img);
    img.src = url;
    var placed = false;
    function place() {
      if (placed || !img.parentNode) return;
      var pr = cur.getBoundingClientRect();
      var ir = img.getBoundingClientRect();
      if (ir.width <= 0) { setTimeout(place, 60); return; }
      placed = true;
      var maxW = pr.width * 0.6, maxH = pr.height * 0.6;
      var scale = Math.min(1, maxW / ir.width, maxH / ir.height);
      var w = Math.max(8, Math.round(ir.width * scale));
      var h = Math.max(8, Math.round(ir.height * scale));
      img.style.width = w + 'px';
      img.style.height = h + 'px';
      img.style.left = Math.max(0, Math.round((pr.width - w) / 2)) + 'px';
      img.style.top = Math.max(0, Math.round((pr.height - h) / 2)) + 'px';
      img.style.visibility = '';
      _reload();
      select(img);
    }
    img.addEventListener('load', place);
    if (img.complete) setTimeout(place, 0);
    setTimeout(place, 120);
    _reload();
  }

  // 翻页后取消选中，避免选中框停留在错误页面
  HSP.events.on('slidechange', function () { clearSelection(); });
  // 新文档载入时清空撤销历史
  HSP.events.on('deckloaded', function () {
    history = [];
    lastCommitted = null;
    clearSelection();
  });

  /* 切页/滚动同步导致页码变化时清空选中：元素已不在视口，留着框会造成错觉与误操作 */
  HSP.events.on('slidechange', function () {
    if (HSP.state.mode === 'edit') clearSelection();
  });

  return {
    enter: enter, exit: exit, reloadBinding: reloadBinding,
    clearSelection: clearSelection,
    addSlide: addSlide, dupSlide: dupSlide, delSlide: delSlide, moveSlide: moveSlide,
    setBackground: setBackground, addTextBox: addTextBox, addImage: addImage
  };
})();

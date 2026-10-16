/* 主控制器：串联 UI 与各引擎，处理打开/保存/全屏/模式切换/演讲者模式。 */
(function () {
  var state = HSP.state;
  var stageWrap = document.getElementById('stage-wrap');
  var annotCanvas = document.getElementById('annot-canvas');
  var laserCanvas = document.getElementById('laser-canvas');
  var laserDot = document.getElementById('laser-dot');

  function $(id) { return document.getElementById(id); }
  function role() {
    var v = new URLSearchParams(location.search).get('view');
    return v === 'stage' ? 'stage' : 'app';
  }

  /* ================= 错误上报（不再静默吞错） ================= */
  var lastErrToast = 0;
  HSP.logError = function (msg) {
    try { console.error('[Lumina]', msg); } catch (e) {}
    var now = Date.now();
    if (now - lastErrToast > 3000) {
      lastErrToast = now;
      try { toast('发生错误：' + String(msg).slice(0, 100)); } catch (e2) {}
    }
  };
  window.addEventListener('error', function (e) {
    HSP.logError((e.message || '未知错误') + ' @' + (e.filename || '').split(/[\\/]/).pop() + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    HSP.logError('未处理异常：' + (r && (r.message || r)));
  });

  /* ================= 打开 / 载入 ================= */
  /* 打开 HTML。opts: { keepAnnotations, keepMode, forceMode, gotoPage } —— 供撤销/AI 改稿/新建等场景 */
  function openFromText(html, name, opts) {
    opts = opts || {};
    state.html = html;
    state.sourceName = name || '';
    if (!opts.keepAnnotations) state.annotations = {}; // 打开新文件才清空旧标注（撤销/舞台恢复保留）
    HSP.player.load(html, name).then(function () {
      if (opts.gotoPage != null) HSP.player.go(opts.gotoPage, false); // 改稿后回到原来那一页，而不是跳回第 1 页
      if (opts.forceMode) { setMode(opts.forceMode); return; }
      if (opts.keepMode) return; // 撤销/恢复：保留当前模式，不打断编辑
      // 打开新文件后按设置进入默认模式
      var s = loadSettings();
      setMode(s.defaultMode === 'edit' ? 'edit' : 'view');
    }).catch(function (e) {
      alert('载入失败：' + (e && e.message ? e.message : e));
    });
  }

  /* 从零新建一份空白演示 —— 让"还没导入/生成任何东西"时也能直接开始做 */
  function blankDeckHtml() {
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>未命名演示</title><style>' +
      '*{margin:0;padding:0;box-sizing:border-box}' +
      'html,body{height:100%}' +
      'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#0b1020;color:#e8ecf6;overflow-x:hidden}' +
      '.slide{width:100%;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:8vh 8vw;box-sizing:border-box;position:relative}' +
      '.inner{width:100%;max-width:1000px}' +
      'h1{font-size:clamp(38px,6vw,68px);font-weight:700;line-height:1.1;letter-spacing:-.02em;margin-bottom:22px}' +
      'p{font-size:clamp(15px,1.7vw,20px);line-height:1.75;color:#a7b3cb}' +
      '</style></head><body>' +
      '<section class="slide" data-title="封面"><div class="inner"><h1>点击这里编辑标题</h1>' +
      '<p>双击文字直接修改，拖动元素移动位置；左侧可新增页面、插入文本框或图片。</p></div></section>' +
      '</body></html>';
  }
  function newBlankDeck() {
    openFromText(blankDeckHtml(), '未命名演示.html', { keepMode: true, gotoPage: 0, forceMode: 'edit' });
    toast('已新建空白演示 · 开始编辑吧');
  }

  /* 载入内置示例（多套，按领域）。name 省略时用「Lumina 使用指引」 */
  var SAMPLE_LABEL = {
    tour: 'Lumina 使用指引.html',
    physics: '物理教学演示.html',
    math: '数学教学演示.html',
    business: '商务数据演示.html'
  };
  function loadSampleFile(name) {
    var deck = SAMPLE_LABEL[name] ? name : 'tour';
    var label = SAMPLE_LABEL[deck];
    // Electron 用 IPC 读内置示例（file:// 下最可靠）；浏览器用隐藏 iframe
    if (window.hsp && window.hsp.readSample) {
      window.hsp.readSample(deck).then(function (t) {
        if (t) openFromText(t, label); else fallbackLoadSample(deck, label);
      }).catch(function () { fallbackLoadSample(deck, label); });
    } else {
      fallbackLoadSample(deck, label);
    }
  }
  function loadSample() { loadSampleFile('tour'); }
  function fallbackLoadSample(deck, label) {
    var f = document.createElement('iframe');
    f.style.display = 'none';
    f.onload = function () {
      try {
        var html = '<!DOCTYPE html>\n' + f.contentDocument.documentElement.outerHTML;
        f.remove();
        openFromText(html, label);
      } catch (e) {
        f.remove();
        alert('读取示例失败：' + e.message);
      }
    };
    f.src = 'sample/' + (deck || 'tour') + '.html';
    document.body.appendChild(f);
  }

  /* ---------- 首次启动：选择行业（同时是使用指引的入口） ---------- */
  var ONBOARD_KEY = 'hsp-onboarded';
  function maybeShowOnboard() {
    try { if (localStorage.getItem(ONBOARD_KEY)) return; } catch (e) { return; }
    var o = $('onboard');
    if (o) o.classList.remove('hidden');
  }
  function closeOnboard() {
    var o = $('onboard');
    if (o) o.classList.add('hidden');
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
  }

  /* 粘贴剪贴板里的 HTML 打开 */
  function pasteHtml() {
    if (window.hsp && window.hsp.readClipboard) {
      window.hsp.readClipboard().then(function (t) {
        if (t && /<(!doctype|html|section|body|head)/i.test(t)) openFromText(t, '粘贴的幻灯片.html');
        else toast('剪贴板里没有 HTML 内容');
      }).catch(function () { toast('读取剪贴板失败'); });
    } else if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) {
        if (t && /<(!doctype|html|section|body|head)/i.test(t)) openFromText(t, '粘贴的幻灯片.html');
        else toast('剪贴板里没有 HTML 内容');
      }, function () { toast('读取剪贴板失败（浏览器需授权）'); });
    } else {
      toast('当前环境不支持读取剪贴板，请直接拖入文件');
    }
  }

  function openFile() {
    if (window.hsp && window.hsp.openFile) {
      window.hsp.openFile().then(function (r) {
        if (r && r.content) openFromText(r.content, r.name);
      }).catch(function (e) { /* 取消 */ });
    } else {
      $('file-input').click();
    }
  }
  function onFileInput(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { openFromText(String(reader.result), file.name); };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  function saveFile() {
    if (!state.loaded) return;
    var html = HSP.player.serialize();
    if (window.hsp && window.hsp.saveFile) {
      window.hsp.saveFile(html, state.sourceName || 'slides.html');
    } else {
      var blob = new Blob([html], { type: 'text/html' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.sourceName || 'slides.html').replace(/\.html?$/i, '') + '-已编辑.html';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }
  }

  function exportPDF() {
    if (!state.loaded) return;
    var html = HSP.player.serialize();
    var printCss = '<style>@media print{.slide,section.slide,article.slide,[data-slide]{page-break-after:always;break-after:page;}body{margin:0;}}</style>';
    var script = '<script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>';
    var inject = printCss + script;
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, inject + '</head>');
    else html = inject + html;
    var blob = new Blob([html], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
  }

  /* ================= UI 状态 ================= */
  function onLoaded() {
    $('welcome').classList.add('hidden');
    $('controlbar').classList.remove('hidden');
    $('src-name').textContent = state.sourceName || '';
    renderThumbs();
    onSlideChange(state.current);
    // iframe 重新加载后，编辑层需要重新绑定到新文档
    if (HSP.editor && HSP.editor.reloadBinding) HSP.editor.reloadBinding();
  }
  function onSlideChange(i) {
    $('counter').textContent = (i + 1) + ' / ' + state.total;
    $('stage-counter').textContent = (i + 1) + ' / ' + state.total;
    var pct = state.total > 1 ? (i / (state.total - 1)) * 100 : 0;
    $('progress-fill').style.width = pct + '%';
    highlightThumb(i);
  }

  function renderThumbs() {
    var list = $('slide-list');
    list.innerHTML = '';
    var dragIndex = null;
    state.slides.forEach(function (s, i) {
      var div = document.createElement('div');
      div.className = 'thumb' + (i === state.current ? ' active' : '');
      div.draggable = true;
      var num = document.createElement('span'); num.className = 'num'; num.textContent = (i + 1);
      var ttl = document.createElement('span'); ttl.className = 'ttl'; ttl.textContent = s.title || '';
      var ops = document.createElement('span'); ops.className = 'ops';
      ops.innerHTML = '<button title="复制" data-op="dup"><svg class="ico"><use href="#i-copy"/></svg></button><button title="删除" data-op="del"><svg class="ico"><use href="#i-x"/></svg></button>';
      div.appendChild(num); div.appendChild(ttl); div.appendChild(ops);
      div.addEventListener('click', function (e) {
        if (e.target.closest('.ops')) return;
        HSP.player.go(i);
      });
      div.addEventListener('dragstart', function () { dragIndex = i; div.classList.add('dragging'); });
      div.addEventListener('dragend', function () { div.classList.remove('dragging'); });
      div.addEventListener('dragover', function (e) { e.preventDefault(); });
      div.addEventListener('drop', function (e) {
        e.preventDefault();
        if (dragIndex != null) HSP.editor.moveSlide(dragIndex, i);
        dragIndex = null;
      });
      ops.querySelector('[data-op="dup"]').addEventListener('click', function (e) { e.stopPropagation(); HSP.editor.dupSlide(i); });
      ops.querySelector('[data-op="del"]').addEventListener('click', function (e) { e.stopPropagation(); HSP.editor.delSlide(i); });
      list.appendChild(div);
    });
  }
  function highlightThumb(i) {
    var kids = $('slide-list').children;
    for (var k = 0; k < kids.length; k++) kids[k].classList.toggle('active', k === i);
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === 'edit') {
      setToolUI('cursor'); // 重置工具，避免标注画布挡住文字编辑
      HSP.editor.enter();
      $('sidebar').classList.remove('hidden');
      $('controlbar').classList.add('hidden');
      renderThumbs();
    } else {
      HSP.editor.exit();
      $('sidebar').classList.add('hidden');
      $('controlbar').classList.remove('hidden');
    }
    $('btn-mode-view').classList.toggle('active', mode === 'view');
    $('btn-mode-edit').classList.toggle('active', mode === 'edit');
    // 侧栏显隐会改变 iframe 尺寸，等布局稳定后重新定位当前页（否则会卡在两页中间）
    setTimeout(function () { if (HSP.player && HSP.player.relocate) HSP.player.relocate(); }, 80);
    setTimeout(function () { if (HSP.player && HSP.player.relocate) HSP.player.relocate(); }, 260);
  }

  /* ================= 标注工具（播放模式） ================= */
  function setToolUI(t) {
    state.tool = t;
    HSP.annotate.setTool(t);
    document.querySelectorAll('#controlbar .tool').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tool') === t);
    });
    stageWrap.classList.toggle('tool-active', t !== 'cursor');
    if (t !== 'laser') laserDot.classList.add('hidden');
  }

  function setColor(c) {
    state.color = c; HSP.annotate.setColor(c);
  }
  function setSize(z) {
    state.size = z; HSP.annotate.setSize(z);
  }

  var hideBarTimer = null;
  function toggleFullscreen() {
    if (!state.loaded) { toast('请先打开一份幻灯片'); return; }
    if (!document.fullscreenElement) {
      var p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () {});
      document.body.classList.add('theater');
      setupBarAutoHide();
    } else {
      document.exitFullscreen();
      document.body.classList.remove('theater');
      clearBarAutoHide();
      $('controlbar').classList.remove('collapsed');
    }
  }
  /* 全屏时控制条自动收起：无操作 3 秒收起，鼠标移到屏幕底部展开；用笔时不收起 */
  function setupBarAutoHide() {
    clearBarAutoHide();
    window.addEventListener('mousemove', onTheaterMove);
  }
  function clearBarAutoHide() {
    window.removeEventListener('mousemove', onTheaterMove);
    clearTimeout(hideBarTimer);
  }
  function onTheaterMove(e) {
    if (!document.fullscreenElement) return;
    if (state.barAutoHide === false) { $('controlbar').classList.remove('collapsed'); return; }
    var bar = $('controlbar');
    if (state.tool !== 'cursor') { bar.classList.remove('collapsed'); return; }
    if (e.clientY > window.innerHeight - 70) {
      bar.classList.remove('collapsed');
      return;
    }
    clearTimeout(hideBarTimer);
    hideBarTimer = setTimeout(function () { bar.classList.add('collapsed'); }, 3000);
  }

  /* ================= 图片对话框 ================= */
  function openImageDialog() {
    $('img-dialog').classList.remove('hidden');
    $('img-url').focus();
  }
  function closeImageDialog() { $('img-dialog').classList.add('hidden'); }
  function confirmImage() {
    var url = $('img-url').value.trim();
    closeImageDialog();
    if (url) HSP.editor.addImage(url);
  }
  function onImageFile(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { closeImageDialog(); HSP.editor.addImage(String(r.result)); };
    r.readAsDataURL(f);
    e.target.value = '';
  }

  /* ================= AI 助手（三模式上下文感知） ================= */
  var aiMaterials = []; // {kind:'image'|'text', name, data, mime}
  var aiMode = 'new';   // 'new' 从零生成 | 'page' 改这一页 | 'all' 改整个演示

  /* 服务商：只需选服务 + 填 Key，接口地址自动确定；模型下拉可选，也可从接口自动获取 */
  var PROVIDERS = {
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'], vision: false },
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'], vision: true },
    moonshot: { label: 'Kimi', base: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], vision: true },
    qwen: { label: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-max'], vision: true },
    zhipu: { label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'], vision: true },
    custom: { label: '自定义', base: '', models: [], vision: true }
  };

  /* ---- 多模型存储：每个模型的配置只填一次，之后只在下拉里选 ---- */
  function loadModels() {
    try { return JSON.parse(localStorage.getItem('hsp-ai-models') || '[]'); } catch (e) { return []; }
  }
  function saveModels(arr) {
    try { localStorage.setItem('hsp-ai-models', JSON.stringify(arr)); } catch (e) {}
  }
  function activeModel() {
    var arr = loadModels();
    var id = localStorage.getItem('hsp-ai-active');
    var m = null;
    arr.forEach(function (x) { if (x.id === id) m = x; });
    return m || arr[0] || null;
  }
  function setActiveModel(id) {
    try { localStorage.setItem('hsp-ai-active', id); } catch (e) {}
  }
  function readAiConfig() {
    var m = activeModel();
    if (!m) return { baseURL: '', apiKey: '', model: '', vision: true };
    return { baseURL: m.baseURL, apiKey: m.apiKey, model: m.model, vision: m.vision !== false };
  }
  function renderModelSelect() {
    var sel = $('ai-model-select');
    var arr = loadModels();
    var act = activeModel();
    sel.innerHTML = '';
    if (!arr.length) {
      var o = document.createElement('option');
      o.value = '';
      o.textContent = '尚未添加模型 —— 点右侧「添加」';
      sel.appendChild(o);
    } else {
      arr.forEach(function (m) {
        var op = document.createElement('option');
        op.value = m.id;
        op.textContent = (PROVIDERS[m.provider] ? PROVIDERS[m.provider].label : m.provider) + ' · ' + m.model;
        sel.appendChild(op);
      });
      if (act) sel.value = act.id;
    }
    $('ai-del-model').disabled = !arr.length;
  }
  function showModelForm(show) {
    $('ai-model-form').classList.toggle('hidden', !show);
    if (show) {
      fillProviderModels($('ai-preset').value || 'deepseek');
      $('ai-base-url').value = '';
      $('ai-key').value = '';
      $('ai-model-hint').textContent = '';
    }
  }
  /* 模型下拉：必须用真正的 <select> —— 原来的 <input list=datalist> 在输入框已有值时
     会按当前输入过滤候选，导致"获取到 2 个却只显示 1 个" */
  function fillModelSelect(models) {
    var sel = $('ai-model');
    if (!sel) return;
    var prev = sel.value && sel.value !== '__custom__' ? sel.value : '';
    sel.innerHTML = '';
    (models || []).forEach(function (mid) {
      var o = document.createElement('option');
      o.value = mid;
      o.textContent = mid;
      sel.appendChild(o);
    });
    var cust = document.createElement('option');
    cust.value = '__custom__';
    cust.textContent = '自定义（手动输入）…';
    sel.appendChild(cust);
    if (prev && models && models.indexOf(prev) >= 0) sel.value = prev;
    else if (models && models.length) sel.value = models[0];
    else sel.value = '__custom__';
    syncCustomModelInput();
  }
  function syncCustomModelInput() {
    var sel = $('ai-model'), inp = $('ai-model-custom');
    if (!sel || !inp) return;
    var custom = sel.value === '__custom__';
    inp.classList.toggle('hidden', !custom);
    if (custom) { try { inp.focus(); } catch (e) {} }
  }
  function currentModelValue() {
    var sel = $('ai-model');
    if (!sel) return '';
    if (sel.value === '__custom__') return ($('ai-model-custom').value || '').trim();
    return (sel.value || '').trim();
  }
  function fillProviderModels(pid) {
    var p = PROVIDERS[pid] || PROVIDERS.custom;
    fillModelSelect(p.models || []);
    $('ai-vision').value = p.vision ? '1' : '0';
    Array.prototype.forEach.call(document.querySelectorAll('.custom-only'), function (el) {
      el.classList.toggle('hidden', pid !== 'custom');
    });
  }
  /* 填完 Key 自动拉取该服务商的真实模型列表（含 DeepSeek 的 chat/reasoner 等），用户不必手输 */
  var _autoFetching = false;
  async function autoFetchModels() {
    var pid = $('ai-preset').value || 'deepseek';
    if (pid === 'custom') return;
    var key = ($('ai-key').value || '').trim();
    var p = PROVIDERS[pid] || {};
    if (!key || !p.base || _autoFetching) return;
    _autoFetching = true;
    $('ai-model-hint').textContent = '正在获取可用模型…';
    try {
      var ids = await HSP.ai.listModels({ baseURL: p.base, apiKey: key });
      if (ids && ids.length) {
        fillModelSelect(ids);
        $('ai-model-hint').textContent = '已获取 ' + ids.length + ' 个可用模型，可在下拉中选择';
      } else {
        $('ai-model-hint').textContent = '未获取到模型列表，可手动填写';
      }
    } catch (e) {
      $('ai-model-hint').textContent = '自动获取失败（可手动填写，或点「获取」）';
    } finally {
      _autoFetching = false;
    }
  }
  function saveNewModel() {
    var pid = $('ai-preset').value || 'deepseek';
    var p = PROVIDERS[pid] || PROVIDERS.custom;
    var key = $('ai-key').value.trim();
    var model = currentModelValue();
    var base = pid === 'custom' ? $('ai-base-url').value.trim() : p.base;
    if (!key) { $('ai-model-hint').textContent = '请填写 API Key'; return; }
    if (!base) { $('ai-model-hint').textContent = '请填写接口地址'; return; }
    if (!model) { $('ai-model-hint').textContent = '请选择或输入模型名'; return; }
    var arr = loadModels();
    var dup = arr.some(function (x) { return x.provider === pid && x.model === model && x.baseURL === base; });
    if (dup) { $('ai-model-hint').textContent = '该模型已添加过了'; return; }
    var id = 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
    arr.push({ id: id, provider: pid, baseURL: base, apiKey: key, model: model, vision: $('ai-vision').value !== '0' });
    saveModels(arr);
    setActiveModel(id);
    renderModelSelect();
    showModelForm(false);
    setAiStatus('已添加模型：' + model, 'ok');
  }
  function delActiveModel() {
    var act = activeModel();
    if (!act) return;
    var arr = loadModels().filter(function (m) { return m.id !== act.id; });
    saveModels(arr);
    if (arr.length) setActiveModel(arr[0].id);
    else { try { localStorage.removeItem('hsp-ai-active'); } catch (e) {} }
    renderModelSelect();
  }
  async function fetchModelList() {
    var pid = $('ai-preset').value || 'deepseek';
    var p = PROVIDERS[pid] || PROVIDERS.custom;
    var cfg = {
      baseURL: pid === 'custom' ? $('ai-base-url').value.trim() : p.base,
      apiKey: $('ai-key').value.trim()
    };
    if (!cfg.apiKey) { $('ai-model-hint').textContent = '请先填写 API Key'; return; }
    if (!cfg.baseURL) { $('ai-model-hint').textContent = '请先填写接口地址'; return; }
    $('ai-model-hint').textContent = '正在获取模型列表…';
    try {
      var ids = await HSP.ai.listModels(cfg);
      if (!ids.length) { $('ai-model-hint').textContent = '未获取到模型'; return; }
      fillModelSelect(ids);
      $('ai-model-hint').textContent = '已获取 ' + ids.length + ' 个模型，可下拉选择';
    } catch (e) {
      $('ai-model-hint').textContent = '获取失败：' + (e && e.message ? e.message : e);
    }
  }
  function openAi() {
    renderAiMaterials();
    updateAiCurrentLabel();
    if (!HSP.state.loaded) aiModeIs('new');
    else updateAiContext();
    if (!$('ai-status').textContent) setAiStatus('描述你的需求，或上传素材后点「生成」');
    $('ai-dialog').classList.remove('hidden');
  }
  function closeAi() { $('ai-dialog').classList.add('hidden'); }
  function updateAiCurrentLabel() {
    var el = $('ai-current-model');
    if (!el) return;
    var m = activeModel();
    el.textContent = m
      ? ((PROVIDERS[m.provider] ? PROVIDERS[m.provider].label : m.provider) + ' · ' + m.model)
      : '未配置模型 —— 请到设置里添加';
  }

  /* ================= 设置 ================= */
  var SETTINGS_KEY = 'hsp-settings';
  var SETTING_DEFAULTS = {
    theme: 'light', clickNav: true, wheelNav: true,
    defaultMode: 'view', barAutoHide: true, penColor: '#ff2d55', penSize: 4
  };
  function loadSettings() {
    var raw = {};
    try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    var out = {};
    Object.keys(SETTING_DEFAULTS).forEach(function (k) {
      out[k] = (raw[k] === undefined || raw[k] === null) ? SETTING_DEFAULTS[k] : raw[k];
    });
    return out;
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function applyTheme(theme) {
    var dark = (theme === 'dark');
    if (theme === 'system' && window.matchMedia) dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('theme-dark', !!dark);
  }
  function applySettings(s) {
    state.clickNav = s.clickNav !== false;
    state.wheelNav = s.wheelNav !== false;
    state.barAutoHide = s.barAutoHide !== false;
    applyTheme(s.theme);
    state.color = s.penColor;
    state.size = s.penSize;
    if ($('color-picker')) $('color-picker').value = s.penColor;
    if ($('size-picker')) $('size-picker').value = s.penSize;
    if (HSP.annotate) { HSP.annotate.setColor(s.penColor); HSP.annotate.setSize(s.penSize); }
  }
  /* AI 提示词编辑 */
  function loadPromptIntoForm() {
    var ta = $('set-ai-prompt');
    if (!ta) return;
    ta.value = (HSP.ai && HSP.ai.activePrompt) ? HSP.ai.activePrompt() : '';
    var hint = $('set-prompt-hint');
    if (hint) hint.textContent = (HSP.ai && HSP.ai.savedPrompt && HSP.ai.savedPrompt().trim()) ? '当前：自定义提示词' : '当前：默认提示词';
  }
  function savePrompt() {
    var ta = $('set-ai-prompt');
    if (!ta || !HSP.ai) return;
    var text = ta.value.trim();
    if (!text) { $('set-prompt-hint').textContent = '内容为空，已恢复默认'; HSP.ai.setPrompt(''); loadPromptIntoForm(); return; }
    HSP.ai.setPrompt(text);
    $('set-prompt-hint').textContent = '已保存 · 下次生成/修改时生效';
    toast('提示词已保存');
  }
  function resetPrompt() {
    if (!HSP.ai) return;
    HSP.ai.setPrompt('');
    loadPromptIntoForm();
    $('set-prompt-hint').textContent = '已恢复默认提示词';
  }
  function openSettings() {
    var s = loadSettings();
    $('set-theme').value = s.theme;
    $('set-clicknav').checked = s.clickNav !== false;
    $('set-wheelnav').checked = s.wheelNav !== false;
    $('set-defaultmode').value = s.defaultMode || 'view';
    $('set-barhide').checked = s.barAutoHide !== false;
    $('set-pencolor').value = s.penColor;
    $('set-pensize').value = s.penSize;
    loadPromptIntoForm();
    renderModelSelect();
    showModelForm(false);
    $('settings-dialog').classList.remove('hidden');
  }
  function closeSettings() { $('settings-dialog').classList.add('hidden'); }
  function onSettingChange() {
    var s = loadSettings();
    s.theme = $('set-theme').value;
    s.clickNav = $('set-clicknav').checked;
    s.wheelNav = $('set-wheelnav').checked;
    s.defaultMode = $('set-defaultmode').value;
    s.barAutoHide = $('set-barhide').checked;
    s.penColor = $('set-pencolor').value;
    s.penSize = parseInt($('set-pensize').value, 10) || 4;
    saveSettings(s);
    applySettings(s);
    if (HSP.annotate) HSP.annotate.render();
  }
  function setAiStatus(msg, cls) {
    var s = $('ai-status');
    s.textContent = msg || '';
    s.className = 'ai-status' + (cls ? ' ' + cls : '');
  }
  function renderAiMaterials() {
    var box = $('ai-materials');
    box.innerHTML = '';
    aiMaterials.forEach(function (m, idx) {
      var chip = document.createElement('div');
      chip.className = 'ai-chip';
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = m.kind === 'image' ? '图' : '文';
      var nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = m.name;
      nm.title = m.name;
      var rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '×';
      rm.title = '移除';
      rm.addEventListener('click', function () { aiMaterials.splice(idx, 1); renderAiMaterials(); });
      chip.appendChild(tag); chip.appendChild(nm); chip.appendChild(rm);
      box.appendChild(chip);
    });
  }
  function addAiImageFiles(files) {
    Array.prototype.forEach.call(files || [], function (f) {
      var rd = new FileReader();
      rd.onload = function () {
        aiMaterials.push({ kind: 'image', name: f.name, data: rd.result, mime: f.type });
        renderAiMaterials();
      };
      rd.readAsDataURL(f);
    });
  }
  function addAiTextFiles(files) {
    Array.prototype.forEach.call(files || [], function (f) {
      var rd = new FileReader();
      rd.onload = function () {
        aiMaterials.push({ kind: 'text', name: f.name, data: String(rd.result) });
        renderAiMaterials();
      };
      rd.readAsText(f, 'utf-8');
    });
  }
  function aiModeIs(m) {
    aiMode = m;
    $('ai-mode-new').classList.toggle('active', m === 'new');
    $('ai-mode-page').classList.toggle('active', m === 'page');
    $('ai-mode-all').classList.toggle('active', m === 'all');
    updateAiContext();
  }
  function updateAiContext() {
    var c = $('ai-context');
    var loaded = HSP.state.loaded;
    $('ai-mode-page').disabled = !loaded;
    $('ai-mode-all').disabled = !loaded;
    var ico = function (id) { return '<svg class="ico"><use href="#i-' + id + '"/></svg> '; };
    if (aiMode === 'new') {
      c.innerHTML = ico('sparkles') + '目标：从零生成一份新演示文稿';
    } else if (aiMode === 'page') {
      if (!loaded) { c.innerHTML = ico('pen') + '目标：修改某一页（请先打开演示文稿）'; return; }
      var i = HSP.state.current, n = HSP.state.total;
      var s = HSP.state.slides[i];
      var title = s ? s.title : '';
      c.innerHTML = ico('pen') + '目标：修改第 ' + (i + 1) + ' 页（共 ' + n + ' 页）' + (title ? ' · ' + title : '');
    } else {
      if (!loaded) { c.innerHTML = ico('file') + '目标：修改整个演示文稿（请先打开演示文稿）'; return; }
      c.innerHTML = ico('file') + '目标：修改整个演示文稿（共 ' + HSP.state.total + ' 页）';
    }
  }
  function buildAiCtx(mode) {
    if (mode === 'page') {
      var i = HSP.state.current;
      var s = HSP.state.slides[i];
      return { pageIndex: i, pageCount: HSP.state.total, pageTitle: s ? s.title : '', pageHtml: s ? s.el.outerHTML : '' };
    }
    if (mode === 'all') return { fullHtml: HSP.player.serialize() };
    return {};
  }
  function applyPageHtml(pageHtml) {
    var s = HSP.state.slides[HSP.state.current];
    if (!s || !s.el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = pageHtml;
    var newEl = tmp.querySelector('section.slide, section');
    if (newEl) s.el.replaceWith(newEl);
    else s.el.innerHTML = pageHtml;
    HSP.player.syncFromDOM();
    HSP.player.redetect();
    HSP.events.emit('docschange');
  }
  async function runAi() {
    var desc = $('ai-prompt').value.trim();
    var mode = aiMode;
    if (!activeModel()) { setAiStatus('请先添加一个模型（点右侧「添加」）', 'err'); return; }
    if (mode !== 'new' && !HSP.state.loaded) { setAiStatus('请先打开一份幻灯片再修改', 'err'); return; }
    if (!desc && mode === 'new') { setAiStatus('请描述你想要的内容', 'err'); return; }
    var btn = $('ai-go');
    btn.disabled = true;
    setAiStatus('正在调用 AI，请稍候…');
    try {
      var result = await HSP.ai.generate(desc, mode, buildAiCtx(mode), aiMaterials, readAiConfig());
      if (mode === 'page') {
        applyPageHtml(result);
        setAiStatus('已修改第 ' + (HSP.state.current + 1) + ' 页', 'ok');
        closeAi();
        toast('AI 已修改当前页');
      } else {
        // 改整个演示：保留原有标注，并回到用户刚才看的那一页（否则会莫名跳回封面）
        var isAll = (mode === 'all');
        var keepPage = HSP.state.current;
        openFromText(result, 'AI 生成的幻灯片.html', { keepAnnotations: isAll, gotoPage: isAll ? keepPage : 0 });
        setAiStatus(isAll ? '已修改全部页面' : ('已生成 ' + HSP.state.total + ' 页'), 'ok');
        closeAi();
        toast(isAll ? '已按你的要求修改全部页面' : ('已生成 ' + HSP.state.total + ' 页 · 可再次打开 AI 助手继续调整'));
      }
    } catch (e) {
      setAiStatus('失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      btn.disabled = false;
    }
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t.__t);
    t.__t = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  /* ================= 单击翻页（默认开启，无按钮） ================= */

  /* ================= 演讲者模式 ================= */
  function wirePresenterUI() {
    document.querySelectorAll('.pc-tool').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-tool');
        document.querySelectorAll('.pc-tool').forEach(function (x) { x.classList.toggle('active', x === b); });
        HSP.presenter.setTool(t, state.color, state.size);
      });
    });
    $('pc-color').addEventListener('input', function (e) {
      state.color = e.target.value; HSP.presenter.setTool(state.tool, state.color, state.size);
    });
    $('pc-size').addEventListener('input', function (e) {
      state.size = parseInt(e.target.value, 10) || 4; HSP.presenter.setTool(state.tool, state.color, state.size);
    });
    $('pc-prev').addEventListener('click', function () { HSP.presenter.goConsole(state.current - 1); });
    $('pc-next-btn').addEventListener('click', function () { HSP.presenter.goConsole(state.current + 1); });
    $('pc-undo').addEventListener('click', function () { HSP.annotate.undo(); });
    $('pc-clear').addEventListener('click', function () { HSP.annotate.clear(); });
    $('btn-stop-present').addEventListener('click', function () { HSP.presenter.stop(); });
  }

  /* ================= 初始化 ================= */
  function initStage() {
    state.role = 'stage';
    $('toolbar').classList.add('hidden');
    $('controlbar').classList.add('hidden');
    $('sidebar').classList.add('hidden');
    $('welcome').classList.add('hidden');
    // 舞台迷你条：翻页 + 结束（可退出）；2 秒无操作自动淡出
    $('stage-mini-bar').classList.remove('hidden');
    $('stage-prev').addEventListener('click', function () { HSP.player.prev(); });
    $('stage-next').addEventListener('click', function () { HSP.player.next(); });
    $('stage-stop').addEventListener('click', function () {
      HSP.sync.post({ type: 'stop' });
      try { window.close(); } catch (e) {}
    });
    var miniTimer = null;
    function miniPoke() {
      $('stage-mini-bar').classList.remove('mini-hidden');
      clearTimeout(miniTimer);
      miniTimer = setTimeout(function () { $('stage-mini-bar').classList.add('mini-hidden'); }, 2000);
    }
    document.addEventListener('mousemove', miniPoke);
    miniPoke();
    HSP.annotate.addSurface('stage', annotCanvas, laserCanvas, laserDot);
    HSP.player.attachGlobalNav();
    HSP.sync.on(HSP.presenter.onChannel);
    var html = localStorage.getItem('hsp-html') || '';
    var cur = parseInt(localStorage.getItem('hsp-current') || '0', 10) || 0;
    try { state.annotations = JSON.parse(localStorage.getItem('hsp-annotations') || '{}'); } catch (e) {}
    HSP.player.load(html, '演示').then(function () {
      HSP.player.go(cur, false);
      var p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () {});
    });
  }

  function initApp() {
    state.role = 'app';
    HSP.annotate.addSurface('stage', annotCanvas, laserCanvas, laserDot);
    HSP.player.attachGlobalNav();
    HSP.sync.on(HSP.presenter.onChannel);
    wirePresenterUI();

    // 工具栏
    $('btn-open').addEventListener('click', openFile);
    $('welcome-open').addEventListener('click', openFile);
    // 首启引导：选择领域后加载对应示例（同时是使用指引）
    Array.prototype.forEach.call(document.querySelectorAll('.ob-card'), function (b) {
      b.addEventListener('click', function () {
        var deck = b.getAttribute('data-deck') || 'tour';
        closeOnboard();
        loadSampleFile(deck);
      });
    });
    $('ob-skip').addEventListener('click', closeOnboard);
    maybeShowOnboard();

    // 欢迎页直接进入选择领域引导（比藏在设置里好找），并清掉已看过标记
    $('welcome-onboard').addEventListener('click', function () {
      try { localStorage.removeItem(ONBOARD_KEY); } catch (e) {}
      var ob = $('onboard');
      if (ob) ob.classList.remove('hidden');
    });
    $('welcome-blank').addEventListener('click', newBlankDeck);
    $('welcome-sample').addEventListener('click', loadSample);
    $('welcome-paste').addEventListener('click', pasteHtml);
    $('file-input').addEventListener('change', onFileInput);
    $('btn-mode-view').addEventListener('click', function () { setMode('view'); });
    $('btn-mode-edit').addEventListener('click', function () { setMode('edit'); });
    $('btn-present').addEventListener('click', function () { HSP.presenter.start(); });
    $('btn-save').addEventListener('click', saveFile);
    $('btn-export-pdf').addEventListener('click', exportPDF);
    $('btn-fullscreen').addEventListener('click', toggleFullscreen);

    // 播放控制
    $('btn-prev').addEventListener('click', function () { HSP.player.prev(); });
    $('btn-next').addEventListener('click', function () { HSP.player.next(); });
    // 点击进度条跳页
    $('progress').addEventListener('click', function (e) {
      if (!state.loaded || !state.total) return;
      var r = this.getBoundingClientRect();
      var ratio = (e.clientX - r.left) / r.width;
      HSP.player.go(Math.round(ratio * (state.total - 1)));
    });
    document.querySelectorAll('#controlbar .tool').forEach(function (b) {
      b.addEventListener('click', function () { setToolUI(b.getAttribute('data-tool')); });
    });
    $('color-picker').addEventListener('input', function (e) { setColor(e.target.value); });
    $('size-picker').addEventListener('input', function (e) { setSize(parseInt(e.target.value, 10) || 4); });
    $('btn-undo').addEventListener('click', function () { HSP.annotate.undo(); });
    $('btn-clear').addEventListener('click', function () { HSP.annotate.clear(); });

    // 编辑侧栏
    $('btn-add-slide').addEventListener('click', function () { HSP.editor.addSlide(); });
    $('bg-color').addEventListener('input', function (e) { HSP.editor.setBackground(e.target.value); });
    $('btn-add-text').addEventListener('click', function () { HSP.editor.addTextBox(); });
    $('btn-add-image').addEventListener('click', openImageDialog);

    // 图片对话框
    $('img-ok').addEventListener('click', confirmImage);
    $('img-cancel').addEventListener('click', closeImageDialog);
    $('img-choose').addEventListener('click', function () { $('img-file').click(); });
    $('img-file').addEventListener('change', onImageFile);
    $('img-url').addEventListener('keydown', function (e) { if (e.key === 'Enter') confirmImage(); });

    // AI 助手
    $('btn-ai').addEventListener('click', openAi);
    $('welcome-ai').addEventListener('click', openAi);
    $('ai-cancel').addEventListener('click', closeAi);
    $('ai-go').addEventListener('click', runAi);
    $('ai-add-image').addEventListener('click', function () { $('ai-img-file').click(); });
    $('ai-add-text').addEventListener('click', function () { $('ai-text-file').click(); });
    $('ai-img-file').addEventListener('change', function (e) { addAiImageFiles(e.target.files); e.target.value = ''; });
    $('ai-text-file').addEventListener('change', function (e) { addAiTextFiles(e.target.files); e.target.value = ''; });
    $('ai-mode-new').addEventListener('click', function () { aiModeIs('new'); });
    $('ai-mode-page').addEventListener('click', function () { aiModeIs('page'); });
    $('ai-mode-all').addEventListener('click', function () { aiModeIs('all'); });
    // 多模型管理：记住配置，之后只在下拉里选
    $('ai-model-select').addEventListener('change', function () { if (this.value) setActiveModel(this.value); });
    $('ai-add-model').addEventListener('click', function () { showModelForm(true); });
    $('ai-cancel-model').addEventListener('click', function () { showModelForm(false); });
    $('ai-save-model').addEventListener('click', saveNewModel);
    $('ai-del-model').addEventListener('click', delActiveModel);
    $('ai-fetch-models').addEventListener('click', fetchModelList);
    $('ai-preset').addEventListener('change', function () { fillProviderModels(this.value); });
    $('ai-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveNewModel(); });
    $('ai-key').addEventListener('change', function () { autoFetchModels(); });
    $('ai-model').addEventListener('change', syncCustomModelInput);
    $('ai-key').addEventListener('blur', function () { autoFetchModels(); });
    $('ai-dialog').addEventListener('click', function (e) { if (e.target === this) closeAi(); });

    // 设置
    $('btn-settings').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', closeSettings);
    $('settings-dialog').addEventListener('click', function (e) { if (e.target === this) closeSettings(); });
    $('ai-open-settings').addEventListener('click', function () { closeAi(); openSettings(); });
    ['set-theme', 'set-clicknav', 'set-wheelnav', 'set-defaultmode', 'set-barhide', 'set-pencolor', 'set-pensize'].forEach(function (id) {
      $(id).addEventListener('change', onSettingChange);
      if (id === 'set-pencolor' || id === 'set-pensize') $(id).addEventListener('input', onSettingChange);
    });
    $('set-prompt-save').addEventListener('click', savePrompt);
    $('set-prompt-reset').addEventListener('click', resetPrompt);
    $('set-ai-prompt').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); savePrompt(); }
    });
    // 重新回到「选择领域」引导（工具栏的载入示例按钮已移除，这里保留入口）
    $('set-onboard').addEventListener('click', function () {
      try { localStorage.removeItem(ONBOARD_KEY); } catch (e) {}
      closeSettings();
      var o = $('onboard');
      if (o) o.classList.remove('hidden');
    });
    $('set-reset').addEventListener('click', function () {
      saveSettings(JSON.parse(JSON.stringify(SETTING_DEFAULTS)));
      applySettings(loadSettings());
      openSettings();
      toast('已恢复默认设置');
    });

    // 控制条收起（单击翻页默认开启，不再需要按钮）
    $('btn-collapse-bar').addEventListener('click', function () {
      $('controlbar').classList.toggle('collapsed');
    });

    // 拖拽打开 / 粘贴 HTML
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.html?$/i.test(f.name)) {
        var r = new FileReader();
        r.onload = function () { openFromText(String(r.result), f.name); };
        r.readAsText(f, 'utf-8');
      }
    });
    window.addEventListener('paste', function (e) {
      var t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
      if (t && (/<(!doctype|html|section|body|head)/i.test(t))) {
        openFromText(t, '粘贴的幻灯片.html');
      }
    });

    // 触摸滑动翻页（指针模式下）
    var touchStartX = null;
    stageWrap.addEventListener('touchstart', function (e) {
      if (state.tool !== 'cursor') return;
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    stageWrap.addEventListener('touchend', function (e) {
      if (state.tool !== 'cursor' || touchStartX == null) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) { if (dx < 0) HSP.player.next(); else HSP.player.prev(); }
      touchStartX = null;
    }, { passive: true });

    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement) document.body.classList.remove('theater');
      // 视口变化后重新定位当前页，避免全屏时显示不全
      setTimeout(function () { if (HSP.player && HSP.player.relocate) HSP.player.relocate(); }, 150);
    });
    var relocateTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(relocateTimer);
      relocateTimer = setTimeout(function () {
        if (HSP.player && HSP.player.relocate) HSP.player.relocate();
      }, 200);
    });

    // 应用已保存的设置（主题 / 翻页方式 / 默认模式 / 标注默认值）
    applySettings(loadSettings());
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
          if (loadSettings().theme === 'system') applyTheme('system');
        });
      } catch (e) {}
    }

    setMode('view');
  }

  // 供 iframe 内拖拽/粘贴转发调用
  HSP.openFromText = openFromText;
  HSP.toast = toast;
  HSP.newBlankDeck = newBlankDeck;
  HSP.loadSampleFile = loadSampleFile;

  /* 事件订阅（app 与 stage 角色都订阅；替代旧 HSP.app 回调，避免依赖倒置） */
  HSP.events.on('deckloaded', onLoaded);
  HSP.events.on('slidechange', onSlideChange);
  HSP.events.on('docschange', function () {
    renderThumbs();
    onSlideChange(HSP.state.current);
  });
  // 快捷键
  HSP.events.on('save-shortcut', function () { saveFile(); });
  HSP.events.on('open-shortcut', function () { openFile(); });
  HSP.events.on('fullscreen-shortcut', function () { toggleFullscreen(); });
  HSP.events.on('esc-edit', function () {
    if (state.mode === 'edit') setMode('view');
  });

  document.addEventListener('DOMContentLoaded', function () {
    if (role() === 'stage') initStage(); else initApp();
  });
})();

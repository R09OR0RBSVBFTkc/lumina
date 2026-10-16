/* AI 助手模块：直接调用 OpenAI 兼容接口（OpenAI/DeepSeek/Kimi/Moonshot/通义/智谱…）。
   三种模式，让 AI 明确感知自己在做什么：
   - 'new'  从零生成一份全新演示文稿（返回完整 HTML 文档）
   - 'page' 修改当前某一页（只返回单页 <section class="slide">，token 省、精确）
   - 'all'  修改整个演示（返回完整 HTML 文档） */
window.HSP = window.HSP || {};
HSP.ai = (function () {
  var DEFAULT_BASE = 'https://api.openai.com/v1';
  var DEFAULT_MODEL = 'gpt-4o';

  /* ---------- 设计风格池：用户不指定时随机取一个，从根上避免"每次生成都一个样" ---------- */
  var STYLE_POOL = [
    { id: 'minimal', name: '极简留白', desc: '大面积白/浅灰底，细无衬线字，极细分割线，留白占一半以上，几乎不用彩色，靠字重与间距建立层级。' },
    { id: 'darktech', name: '科技暗色', desc: '近黑或深蓝底，青色/紫色霓虹强调，细边框卡片，发光质感，局部等宽字体。' },
    { id: 'corp', name: '商务稳重', desc: '白或浅米底，深蓝主色配金色点缀，严谨栅格，数据卡片与表格为主，标题可用衬线体。' },
    { id: 'magazine', name: '杂志排版', desc: '大号衬线标题、多栏文字、超大图片与色块穿插、页码与栏线，强编辑感。' },
    { id: 'sketch', name: '手绘笔记', desc: '米黄纸张底，手写感标题，马克笔高亮，手绘箭头与方框，线条略不规则。' },
    { id: 'chinese', name: '新中式', desc: '宣纸白与墨色，朱红点缀，竖排或书法标题，大留白，圆形与印章元素。' },
    { id: 'bold', name: '大胆撞色', desc: '高饱和成对撞色（洋红+柠檬黄、电光蓝+橙），超大字号，几何色块切割版面。' },
    { id: 'glass', name: '玻璃拟态', desc: '彩色渐变背景 + 毛玻璃半透明卡片 + 柔和大圆角 + 细微高光。' },
    { id: 'dash', name: '数据仪表盘', desc: '深或浅底皆可，大量图表（折线/柱状/环形/进度环）+ 等宽数字 + 网格布局，信息密度高。' },
    { id: 'pastel', name: '柔和渐变', desc: '低饱和马卡龙色渐变背景，圆润大圆角，柔和阴影，亲和力强。' },
    { id: 'mono', name: '黑白灰+单强调色', desc: '全篇只用黑白灰，单一强调色点睛，克制的现代感。' },
    { id: 'print', name: '复古印刷', desc: '做旧米色纸感，衬线体，双色油墨套印（如墨绿+砖红），网格与拓印纹理。' }
  ];
  function pickRandomStyle() { return STYLE_POOL[Math.floor(Math.random() * STYLE_POOL.length)]; }
  function findStyle(id) {
    for (var i = 0; i < STYLE_POOL.length; i++) if (STYLE_POOL[i].id === id) return STYLE_POOL[i];
    return null;
  }
  var lastUsedStyle = null;

  /* ---------- 提示词 ---------- */
  function commonRules() {
    return [
      '你是一位顶尖的演示文稿（PPT）HTML 设计专家，作品水准对标 Apple Keynote 与一流设计工作室。',
      '',
      '【第一优先：忠实执行用户要求】',
      '· 用户要求的页数必须严格满足（说"8 页"就必须正好 8 页）。',
      '· 用户没指定页数时，按内容需要生成 8~12 页的完整叙事：封面 → 概览/目录 → 分节内容（多页）→ 数据或案例 → 结语。',
      '· 用户对风格、配色、气质的描述必须严格执行，不要强加你自己的偏好。',
      '· 用户没指定风格时：先判断主题气质，再主动选择匹配的设计语言；不要每次都套用同一套，尤其别反复用「深色底 + 蓝紫渐变」。',
      '',
      '【内容质量：详实、有信息量】',
      '· 每一页都要有实质内容：3~5 个要点、数据、步骤或案例，禁止只有一句空洞标题的页面。',
      '· 数据尽量具体（数字、百分比、对比），适合的用数据卡片 / 表格式排版 / 图表呈现。',
      '· 优先采用用户提供的素材（真实数据/图片/文字）；用户没给的不要编造具体数字，可用定性描述或占位。',
      '',
      '【视觉质量：每页都要有设计感】',
      '· 建立统一视觉系统：主色 + 强调色 + 中性色；标题/副标题/正文有清晰的字号层级。',
      '· 不要整页只有文字：用卡片、分割线、序号、内联 SVG 图标、数据大字、进度条、图形等组织信息。',
      '· 留白充分、对齐整齐；全篇的间距、圆角、阴影风格保持一致。',
      '',
      '【技术规范】',
      '· 只输出一个完整、自包含的 HTML 文件（从 <!DOCTYPE html> 开始），不要解释、前言或 markdown 代码围栏。',
      '· 样式内联在 <style> 标签或 style 属性里；不依赖任何外部 CSS/JS 框架；图标用内联 SVG 或 Unicode；图片用内联 SVG 或 base64。',
      '· 每页用 <section class="slide"> 直接放在 <body> 下；.slide{width:100%;min-height:100vh;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:8vh 8vw;}，页与页纵向排列。',
      '· 每页加 data-title="页面标题"（用于缩略图）；演讲者备注写 data-notes="..."。',
      '· 【必须输出全部页面】严禁出现 "..."、"（此处省略）"、"<!-- 其余页面 -->"、"TODO" 等省略写法；宁可每页精简，也必须把每一页完整写完，并以 </html> 结束。',
      '',
      '【动效：HTML 相比普通 PPT 的核心优势，必做】',
      '· 每页进入视口时元素依次浮现：用 IntersectionObserver 给当前页加 .in 类 + CSS transition，配合 --i 做阶梯延迟。',
      '· 建议再配合：逐字/逐行浮现、数字增长（count-up）、SVG 路径逐步绘制（stroke-dashoffset）、进度条生长、鼠标跟随光晕、卡片 hover 微倾斜。',
      '· 硬性要求：① 只用 transform/opacity 等不触发布局的属性；② 内容默认可见，只有 JS 成功初始化后才启用动画初始态（给 body 加 class），保证脚本失败时内容照常显示；③ 尊重 @media (prefers-reduced-motion: reduce)；④ 动效克制，不要干扰阅读。',
      '· 约定：需要入场的元素统一加 data-anim 属性；逐字标题用 data-split 属性标记。',
      '',
      '用中文（除非用户要求其他语言）。'
    ];
  }
  /* ---------- 提示词：用户可在「设置」里编辑 ----------
     可编辑的是"内容与设计规范"（commonRules）；"输出格式"要求由软件固定在 buildSystem 里追加，
     因为一旦格式要求被改坏，模型可能返回无法解析的文本，生成就会失败。 */
  var PROMPT_KEY = 'hsp-ai-prompt';
  function defaultPrompt() { return commonRules().join('\n'); }
  function savedPrompt() {
    try { return localStorage.getItem(PROMPT_KEY) || ''; } catch (e) { return ''; }
  }
  function setPrompt(text) {
    try {
      var t = String(text == null ? '' : text);
      if (t.trim()) localStorage.setItem(PROMPT_KEY, t);
      else localStorage.removeItem(PROMPT_KEY);
    } catch (e) {}
  }
  function activePrompt() {
    var c = savedPrompt();
    return c.trim() ? c : defaultPrompt();
  }
  function buildSystem(mode, style) {
    var rules = [activePrompt()];
    if (style && style.desc) {
      rules.push('');
      rules.push('【本次指定的设计风格：' + style.name + '】');
      rules.push(style.desc);
      rules.push('整份演示必须统一贯彻这个风格：配色、字体气质、图形语言、版式节奏都要贴合。');
    }
    if (mode === 'page') {
      rules.push('当前任务：修改一份现有演示文稿的「某一页」。');
      rules.push('你只需输出这一页的 HTML —— 单个 <section class="slide"> ... </section>。');
      rules.push('不要输出 <!DOCTYPE>、<html>、<head>、<body> 或任何解释；所有样式内联在 style 属性或子元素的 style 属性里（不要 <style> 标签）。');
      rules.push('保留该页原有的信息量与设计水准，不要因为"只改一点"就把内容砍掉。');
    } else {
      rules.push((mode === 'new') ? '当前任务：从零生成一份全新的演示文稿。' : '当前任务：修改一份现有演示文稿的「全部页面」。');
      rules.push('只输出一个完整、自包含的 HTML 文件（从 <!DOCTYPE html> 开始），不要任何解释、前言或 markdown 代码围栏。');
      rules.push('所有样式内联在 <style> 标签里。');
      if (mode === 'all') {
        rules.push('【改动范围】只改用户要求改的部分，其余页面的文案、结构与视觉必须原样保留（包括每页的 data-title / data-notes / 动效脚本）。');
        rules.push('【数量不变】除非用户明确要求增删页面，否则页数必须与原文一致，不许"顺手精简"。');
      }
    }
    return rules.join('\n');
  }

  function textMaterialsBlock(texts) {
    if (!texts || !texts.length) return '';
    var out = '\n\n—— 用户提供的素材（真实内容，请优先采用）——\n';
    texts.forEach(function (t) { out += '\n【' + t.name + '】\n' + t.data + '\n'; });
    return out;
  }

  function buildUser(desc, mode, ctx, materials, vision) {
    var texts = (materials || []).filter(function (m) { return m.kind === 'text'; });
    var images = (materials || []).filter(function (m) { return m.kind === 'image'; });
    var textPart = (desc || '') + textMaterialsBlock(texts);
    ctx = ctx || {};

    if (mode === 'page') {
      textPart += '\n\n—— 你正在修改的页面 ——';
      textPart += '\n这是第 ' + (ctx.pageIndex + 1) + ' 页，共 ' + ctx.pageCount + ' 页。';
      if (ctx.pageTitle) textPart += ' 本页标题：' + ctx.pageTitle + '。';
      textPart += '\n\n—— 本页 HTML ——\n' + (ctx.pageHtml || '') + '\n—— 本页 HTML 结束 ——';
      textPart += '\n\n请按用户要求修改这一页，输出修改后的【单个 <section class="slide"> ... </section>】。';
      if (images.length && !vision) textPart += '\n（用户上传了 ' + images.length + ' 张图片，但当前为纯文本模式，请在页面中为图片预留位置）';
      return { role: 'user', content: textPart };
    }

    if (mode === 'all') {
      textPart += '\n\n—— 当前演示文稿完整 HTML 开始 ——\n' + (ctx.fullHtml || '') + '\n—— 完整 HTML 结束 ——';
      textPart += '\n\n请按用户要求修改整个演示，返回修改后的【完整 HTML 文件】。';
      if (images.length && !vision) textPart += '\n（用户上传了 ' + images.length + ' 张图片，但当前为纯文本模式，请为图片预留位置）';
      return { role: 'user', content: textPart };
    }

    // new：从零生成
    if (images.length && vision) {
      var parts = [{ type: 'text', text: textPart || '请根据素材生成一份结构清晰的演示文稿。' }];
      images.forEach(function (im) { parts.push({ type: 'image_url', image_url: { url: im.data } }); });
      return { role: 'user', content: parts };
    }
    if (images.length && !vision) {
      textPart += '\n\n（用户上传了 ' + images.length + ' 张图片，但当前为纯文本模式，请在幻灯片中为图片预留位置并注明）';
    }
    return { role: 'user', content: textPart || '请生成一份演示文稿。' };
  }

  /* ---------- 提取 ---------- */
  function stripFence(text) {
    var t = String(text || '');
    var m = t.match(/```(?:html|HTML)?\s*([\s\S]*?)```/);
    return m ? m[1] : t;
  }
  /* 提取完整 HTML 文档 */
  function extractHtml(text) {
    var t = stripFence(text);
    var i = t.search(/<!DOCTYPE|<html/i);
    if (i >= 0) t = t.slice(i);
    var lower = t.toLowerCase();
    var j = lower.lastIndexOf('</html>');
    if (j >= 0) t = t.slice(0, j + 7);
    t = t.trim();
    if (!/<html/i.test(t)) return '';
    // 必须是完整文档，否则视为被截断（交给 generate 自动续写，避免"只生成两三页"）
    if (lower.indexOf('</html>') < 0 && lower.indexOf('</body>') < 0) return '';
    return t;
  }
  /* 提取单页 <section> */
  function extractPageHtml(text) {
    var t = stripFence(text);
    var i = t.search(/<section[\s>]/i);
    if (i < 0) return '';
    t = t.slice(i);
    var j = t.toLowerCase().lastIndexOf('</section>');
    if (j >= 0) t = t.slice(0, j + 10);
    return t.trim();
  }

  /* ---------- 调用 ---------- */
  async function chatOnce(messages, cfg, timeoutMs, maxTokens) {
    if (!cfg.apiKey) throw new Error('请先填写 API Key');
    var base = (cfg.baseURL || DEFAULT_BASE).replace(/\/+$/, '');
    var ctrl = new AbortController();
    var ms = timeoutMs || 300000;
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    try {
      var resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model || DEFAULT_MODEL,
          messages: messages,
          temperature: (cfg.temperature != null ? cfg.temperature : 0.85),
          max_tokens: maxTokens
        }),
        signal: ctrl.signal
      });
      if (!resp.ok) {
        var et = ''; try { et = await resp.text(); } catch (e) {}
        var err = new Error('API 返回 ' + resp.status + (et ? '：' + et.slice(0, 400) : ''));
        try { err.status = resp.status; } catch (x) {}
        throw err;
      }
      var data = await resp.json();
      var choice = data && data.choices && data.choices[0];
      var msg = choice && choice.message;
      var content = msg && msg.content;
      if (content && typeof content !== 'string') {
        content = content.map(function (p) { return p && p.text ? p.text : ''; }).join('');
      }
      var reason = choice && choice.finish_reason;
      if (!content) {
        var err;
        if (msg && msg.reasoning_content) {
          err = new Error('模型把 token 都用在了思考（reasoning）上、没输出正文。请换用非推理模型（如 deepseek-chat 而不是 deepseek-reasoner），或把需求写简单些。');
        } else if (reason === 'length') {
          err = new Error('输出被截断（finish_reason=length）且没有正文。请把需求写简单些、减少页数，或换非推理模型。');
        } else {
          err = new Error('AI 未返回内容（finish_reason=' + reason + '）。常见原因：模型名不对、该模型不兼容 /chat/completions，或 token 全花在了思考上。');
        }
        try { err.status = 200; err.emptyContent = true; } catch (x) {}
        throw err;
      }
      return content;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('请求超时（' + Math.round(ms / 1000) + ' 秒没响应）。整份演示生成较慢，可稍后重试；若一直超时，先把需求写简单些，或检查网络与代理。');
      }
      if (!e.status && /Failed to fetch|NetworkError|net::|ERR_/i.test(String(e && e.message))) {
        throw new Error('网络连接失败：访问不到 ' + base + '。若该服务在境外（如 OpenAI），请在「设置 → 网络代理」里填代理地址。');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  /* 部分模型 max_tokens 上限只有 4096，传 8192 会被拒（HTTP 400）→ 自动降级重试 */
  async function chat(messages, cfg, timeoutMs) {
    if (!cfg.apiKey) throw new Error('请先填写 API Key');
    var want = cfg.maxTokens || 8192;
    var tries = [want];
    [4096, 2048].forEach(function (v) { if (v < want && tries.indexOf(v) < 0) tries.push(v); });
    var lastErr = null;
    for (var i = 0; i < tries.length; i++) {
      var mt = tries[i];
      for (var attempt = 0; attempt < 2; attempt++) {
        try { return await chatOnce(messages, cfg, timeoutMs, mt); }
        catch (e) {
          lastErr = e;
          if (e && e.emptyContent && attempt === 0) continue;   // 空内容：立即再试一次（偶发一次就成功）
          var m = String((e && e.message) || '');
          var downgrade = (e && e.status === 400) && /max_?tokens|maximum context|too large|invalid_request|exceed/i.test(m);
          if (downgrade) break;                                  // 换更小的 max_tokens 档位
          throw e;
        }
      }
    }
    throw lastErr;
  }

  /* ---------- 从服务端自动获取可用模型列表（OpenAI 兼容 /models） ---------- */
  async function listModels(cfg) {
    if (!cfg.apiKey) throw new Error('请先填写 API Key');
    var base = (cfg.baseURL || DEFAULT_BASE).replace(/\/+$/, '');
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 30000);
    try {
      var resp = await fetch(base + '/models', {
        headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error('获取失败（HTTP ' + resp.status + '）');
      var data = await resp.json();
      var arr = (data && data.data) || [];
      var ids = arr.map(function (m) { return m && m.id; }).filter(Boolean);
      // 常见排序：把 chat / 通用模型排前面
      ids.sort();
      return ids;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('获取超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 主入口 ---------- */
  async function generate(desc, mode, ctx, materials, cfg) {
    // 用户没选风格时随机挑一种，避免"每次生成都一个样"
    var style = findStyle(cfg.style) || pickRandomStyle();
    lastUsedStyle = style;
    var system = buildSystem(mode, style);
    var user = buildUser(desc, mode, ctx, materials, cfg.vision !== false);
    var messages = [{ role: 'system', content: system }, user];
    var content = await chat(messages, cfg, 300000);
    if (mode === 'page') {
      var page = extractPageHtml(content);
      if (!page) throw new Error('AI 未返回有效的页面 HTML，请重试');
      return page;
    }
    var html = extractHtml(content);
    // 输出被截断时自动续写：长文档最容易在这里"丢页"（只生成两三页就是这个原因）
    for (var i = 0; i < 2 && !html; i++) {
      try {
        var more = await chat(messages.concat([
          { role: 'assistant', content: content },
          { role: 'user', content: '上面的输出被截断了（HTML 没有正常结束）。请严格从中断处继续输出剩余内容，不要重复已输出的部分，不要任何解释或代码围栏，直到 </html> 结束。' }
        ]), cfg, 300000);
        if (!more || !more.trim()) break;
        content = content + '\n' + more;
        html = extractHtml(content);
      } catch (e) { break; }
    }
    if (!html) throw new Error('AI 未返回有效 HTML（输出可能被截断），请重试或把需求拆小一点');
    return html;
  }

  return {
    generate: generate,
    listModels: listModels,
    defaultPrompt: defaultPrompt, activePrompt: activePrompt, setPrompt: setPrompt, savedPrompt: savedPrompt, buildSystem: buildSystem,
    extractHtml: extractHtml,
    extractPageHtml: extractPageHtml,
    styles: STYLE_POOL, pickRandomStyle: pickRandomStyle, findStyle: findStyle,
    lastStyle: function () { return lastUsedStyle; },
    defaults: { base: DEFAULT_BASE, model: DEFAULT_MODEL }
  };
})();

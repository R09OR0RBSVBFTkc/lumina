/* 全功能逐项测试 v4：覆盖欢迎页/粘贴/缩放/光标/层级/微调/复制/预览缓存/舞台迷你条/链接防护等 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const root = path.join(__dirname, '..');
const sample = fs.readFileSync(path.join(root, 'sample', 'sample-deck.html'), 'utf-8');
const pasteHtml = '<!DOCTYPE html><html><head></head><body><section class="slide"><h1>粘贴页1</h1></section><section class="slide"><h1>粘贴页2</h1></section></body></html>';
const out = path.join(__dirname, 'full-result.txt');
fs.writeFileSync(out, '');

let results = [];
function check(name, ok, extra) {
  const line = (ok ? 'PASS' : 'FAIL') + '  ' + name + (extra != null ? '  :: ' + extra : '');
  results.push(line);
  fs.appendFileSync(out, line + '\n', 'utf-8');
}
function log(s) { fs.appendFileSync(out, s + '\n', 'utf-8'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(() => { log('TIMEOUT'); app.exit(1); }, 240000);

let stageWindow = null;
ipcMain.handle('open-stage', () => {
  stageWindow = new BrowserWindow({
    x: 0, y: 0, width: 1024, height: 768, show: false,
    webPreferences: { preload: path.join(root, 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  stageWindow.loadFile(path.join(root, 'index.html'), { query: { view: 'stage' } });
  return { display: 'TestDisplay-2', external: true, count: 2, size: '1920×1080' };
});
ipcMain.handle('close-stage', () => { if (stageWindow && !stageWindow.isDestroyed()) { stageWindow.close(); stageWindow = null; } return true; });
ipcMain.handle('read-clipboard', () => pasteHtml);
ipcMain.handle('read-sample', (evt, name) => {
  const safe = String(name || 'tour').replace(/[^a-z0-9_-]/gi, '') || 'tour';
  try { return fs.readFileSync(path.join(root, 'sample', safe + '.html'), 'utf8'); } catch (e) { return ''; }
});

/* 跨窗口同步中继：转发给除发送者以外的所有窗口（演讲者模式依赖它） */
ipcMain.on('hsp-sync', (evt, msg) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.webContents !== evt.sender) w.webContents.send('hsp-sync', msg);
  });
});

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false, width: 1280, height: 720,
      webPreferences: { preload: path.join(root, 'electron', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    await win.loadFile(path.join(root, 'index.html'));
    await sleep(400);
    const js = (code) => win.webContents.executeJavaScript(code, true);

    /* ===== 1. 欢迎页（z-index 遮挡修复 + 粘贴打开） ===== */
    // 首启引导层会盖住欢迎页：先隐藏，最后再单独验证它
    await js(`(function(){ var o=document.getElementById('onboard'); if(o) o.classList.add('hidden'); })()`);
    let r = await js(`(function(){ var b=document.getElementById('welcome-sample'); var r=b.getBoundingClientRect(); var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return el === b || b.contains(el); })()`);
    check('欢迎页-按钮可点(未被遮挡)', r === true);
    // 软件名已更名为 Lumina
    r = await js(`({ title: document.title, brand: document.querySelector('.brand-name').textContent })`);
    check('软件名-Lumina', /Lumina/.test(r.title) && r.brand === 'Lumina', JSON.stringify(r));
    const mainSrc2 = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
    check('窗口-已移除默认菜单栏(File/Edit/View)', /setApplicationMenu\(null\)/.test(mainSrc2) && /autoHideMenuBar/.test(mainSrc2) && /setMenuBarVisibility\(false\)/.test(mainSrc2), 'menu config');
    r = await js(`(function(){ var w=document.getElementById('welcome'); var d=document.getElementById('deck'); return parseFloat(getComputedStyle(w).zIndex) > parseFloat(getComputedStyle(d).zIndex); })()`);
    check('欢迎页-z-index高于iframe', r === true);
    await js(`document.getElementById('welcome-paste').click()`);
    await sleep(900);
    r = await js(`({ total:HSP.state.total, welcome: document.getElementById('welcome').classList.contains('hidden') })`);
    check('粘贴HTML-打开剪贴板内容', r.total === 2 && r.welcome === true, 'total=' + r.total);

    /* ===== 2. 示例载入 ===== */
    await js(`HSP.loadSampleFile('tour')`);
    await sleep(900);
    r = await js(`({ total:HSP.state.total, counter: document.getElementById('counter').textContent })`);
    check('载入示例-识别页数', r.total === 9, 'total=' + r.total);
    check('载入示例-计数器', r.counter === '1 / 9', r.counter);
    // 示例自带动效引擎（JS 就绪标记 + 各类动效元素）
    r = await js(`(function(){ var d=HSP.player.doc(); return { anim: d.body.classList.contains('anim'), animEls: d.querySelectorAll('[data-anim]').length, split: d.querySelectorAll('.w').length, draw: d.querySelectorAll('.draw path, .draw polyline').length, count: d.querySelectorAll('[data-count]').length, tilt: d.querySelectorAll('.tilt').length }; })()`);
    check('示例动效-引擎就绪', r.anim === true && r.animEls >= 10 && r.split >= 6 && r.draw >= 2 && r.count >= 2 && r.tilt >= 6, JSON.stringify(r));
    // 重新载入会清空旧标注（可能残留惰性空数组，但不应有非空笔迹）
    await js(`(function(){ HSP.state.annotations[0]=[{tool:'pen'}]; HSP.state.annotations['9']=[{tool:'pen'}]; HSP.loadSampleFile('tour'); })()`);
    await sleep(900);
    r = await js(`(function(){ var a=HSP.state.annotations; return !Object.keys(a).some(function(k){ return (a[k]||[]).length > 0; }); })()`);
    check('载入-清空旧标注', r === true);

    /* ===== 3. 翻页 ===== */
    await js(`document.getElementById('btn-next').click()`);
    await sleep(300);
    r = await js(`(function(){ var d=HSP.player.doc(); var s2=d.querySelectorAll('section.slide')[1]; return { cur:HSP.state.current, top: Math.round(s2.getBoundingClientRect().top) }; })()`);
    check('翻页-下一页按钮', r.cur === 1, 'cur=' + r.cur);
    check('翻页-实际视觉滚动', Math.abs(r.top) < 120, '第2页top=' + r.top);
    await js(`document.getElementById('btn-prev').click()`);
    r = await js(`HSP.state.current`);
    check('翻页-上一页按钮', r === 0, 'cur=' + r);

    /* ===== 4. 键盘 + 单击翻页 + 链接防护 ===== */
    await js(`(function(){ HSP.player.win().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})); })()`);
    await sleep(150);
    r = await js(`HSP.state.current`);
    check('键盘翻页-→键', r === 1, 'cur=' + r);
    await js(`(function(){ HSP.player.doc().querySelector('section.slide h1').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    await sleep(150);
    r = await js(`HSP.state.current`);
    check('单击翻页-点内容翻页', r === 2, 'cur=' + r);
    // 双击不连翻两页（第二击忽略）；先等待避开上一次单击的防连翻窗口
    await sleep(400);
    await js(`(function(){ var el=HSP.player.doc().querySelector('section.slide h1'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    await sleep(150);
    r = await js(`HSP.state.current`);
    check('单击翻页-双击不连翻两页', r === 3, 'cur=' + r);
    // 点击进度条跳页（8 页 50% → round(0.5*7)=4 → 第 5 页）
    await js(`(function(){ var p=document.getElementById('progress'); var r=p.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('click',{clientX:r.left + r.width*0.5, clientY:r.top+2, bubbles:true,cancelable:true})); })()`);
    await sleep(150);
    r = await js(`HSP.state.current`);
    check('进度条-点击跳页', r === 4, 'cur=' + r);
    r = await js(`document.getElementById('btn-clicknav') === null`);
    check('单击翻页-按钮已移除', r === true);
    // 点击链接：不翻页 + iframe 不被导航走（修复 srcdoc iframe 链接导航 bug）
    await js(`(function(){ var d=HSP.player.doc(); var a=d.createElement('a'); a.href='#'; a.textContent='链接'; d.querySelector('section.slide').appendChild(a); a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    await sleep(400);
    r = await js(`(function(){ var d=HSP.player.doc(); return { cur: HSP.state.current, slides: d.querySelectorAll('section.slide').length, title: d.title }; })()`);
    check('单击翻页-链接不翻页', r.cur === 4, 'cur=' + r.cur);
    check('链接防护-iframe未被导航走', r.slides === 9 && r.title.length > 0 && r.title !== 'Lumina · AI HTML 幻灯片', 'slides=' + r.slides + ' title=' + r.title.slice(0, 14));

    /* ===== 5. 工具/光点/标注 ===== */
    const tools = ['cursor', 'pen', 'highlighter', 'laser', 'eraser'];
    let ok = true;
    for (const t of tools) {
      await js(`document.querySelector('#controlbar .tool[data-tool="${t}"]').click()`);
      r = await js(`({ tool:HSP.state.tool, active: document.getElementById('stage-wrap').classList.contains('tool-active') })`);
      if (r.tool !== t || r.active !== (t !== 'cursor')) ok = false;
    }
    check('工具选择-5种', ok);
    await js(`document.querySelector('#controlbar .tool[data-tool="pen"]').click()`);
    await js(`(function(){ var c=document.getElementById('annot-canvas'); var r=c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+300,clientY:r.top+200,pointerId:5,bubbles:true})); })()`);
    r = await js(`(function(){ var d=document.getElementById('laser-dot'); return { hidden: d.classList.contains('hidden'), left: d.style.left }; })()`);
    check('落笔光点-画笔显示', r.hidden === false && r.left !== '', JSON.stringify(r));
    await js(`document.querySelector('#controlbar .tool[data-tool="cursor"]').click()`);
    r = await js(`document.getElementById('laser-dot').classList.contains('hidden')`);
    check('落笔光点-指针模式隐藏', r === true);
    await js(`document.querySelector('#controlbar .tool[data-tool="pen"]').click()`);
    await js(`(function(){ var c=document.getElementById('annot-canvas'); var r=c.getBoundingClientRect(); function pe(t,x,y){ c.dispatchEvent(new PointerEvent(t,{clientX:r.left+x,clientY:r.top+y,pointerId:9,bubbles:true,cancelable:true})); } pe('pointerdown',100,100); pe('pointermove',200,150); pe('pointerup',200,150); })()`);
    r = await js(`(HSP.state.annotations[HSP.state.current] || []).length`);
    check('画笔-产生笔迹', r >= 1, 'strokes=' + r);
    let before = await js(`(HSP.state.annotations[HSP.state.current] || []).length`);
    await js(`document.getElementById('btn-undo').click()`);
    r = await js(`(HSP.state.annotations[HSP.state.current] || []).length`);
    check('撤销-减少一笔', r === before - 1, 'before=' + before + ' after=' + r);
    await js(`document.getElementById('btn-clear').click()`);
    r = await js(`(HSP.state.annotations[HSP.state.current] || []).length`);
    check('清空-笔迹清零', r === 0, 'strokes=' + r);

    /* ===== 6. 编辑模式 ===== */
    await js(`document.getElementById('btn-mode-edit').click()`);
    r = await js(`({ mode:HSP.state.mode, sidebar: !document.getElementById('sidebar').classList.contains('hidden'), tool:HSP.state.tool, toolActive: document.getElementById('stage-wrap').classList.contains('tool-active') })`);
    check('编辑模式-切换', r.mode === 'edit' && r.sidebar === true, JSON.stringify(r));
    check('编辑模式-工具重置为指针', r.tool === 'cursor' && r.toolActive === false, 'tool=' + r.tool);
    // 编辑模式动效暂停：带动效的元素必须可见可选中
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide [data-anim]'); var cs=el?getComputedStyle(el):null; var hasStyle=!!d.getElementById('__hsp_style'); var rule=(d.getElementById('__hsp_style')||{}).textContent||''; return { hasStyle: hasStyle, opacity: cs?cs.opacity:null, animOff: rule.indexOf('data-anim') > -1, splitOff: rule.indexOf('.w') > -1 }; })()`);
    check('编辑模式-动效暂停(元素可见)', r.hasStyle === true && r.animOff === true && r.splitOff === true && parseFloat(r.opacity) > 0.9, JSON.stringify(r));
    await js(`HSP.player.go(0)`);
    await sleep(200);

    /* ===== 7. 元素选中 + move 光标 + 8 手柄 ===== */
    await js(`(function(){ HSP.player.doc().querySelector('section.slide h1').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    r = await js(`(function(){ var el=HSP.player.doc().querySelector('section.slide h1'); return { sel: document.getElementById('hsp-sel').style.display, handles: document.querySelectorAll('#hsp-sel .hsp-h').length, moving: el.classList.contains('__hsp_moving') }; })()`);
    check('元素编辑-选中+工具条', r.sel === 'block', JSON.stringify(r));
    check('元素编辑-8个缩放手柄', r.handles === 8, 'handles=' + r.handles);
    check('元素编辑-move光标类', r.moving === true);

    /* ===== 8. 缩放（se 角=等比） ===== */
    r = await js(`(function(){ var el=HSP.player.doc().querySelector('section.slide h1'); var r0=el.getBoundingClientRect(); var h=document.querySelector('#hsp-sel [data-h="se"]'); h.dispatchEvent(new PointerEvent('pointerdown',{clientX:r0.right,clientY:r0.bottom,pointerId:30,button:0,buttons:1,bubbles:true,cancelable:true})); document.dispatchEvent(new PointerEvent('pointermove',{clientX:r0.right+60,clientY:r0.bottom+60,pointerId:30,bubbles:true})); document.dispatchEvent(new PointerEvent('pointerup',{pointerId:30,bubbles:true})); return { w: parseFloat(el.style.width), h: parseFloat(el.style.height), ratio: (parseFloat(el.style.width)/parseFloat(el.style.height)).toFixed(2), origRatio: (r0.width/r0.height).toFixed(2) }; })()`);
    check('元素编辑-角手柄等比缩放', r.w > 0 && r.h > 0 && Math.abs(parseFloat(r.ratio) - parseFloat(r.origRatio)) < 0.15, JSON.stringify(r));

    /* ===== 9. 方向键微调 ===== */
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide h1'); var l0=parseFloat(el.style.left)||0; d.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})); return { before:l0, after: parseFloat(el.style.left)||0 }; })()`);
    check('元素编辑-方向键微调', r.after === r.before + 1, JSON.stringify(r));

    /* ===== 10. 复制元素 ===== */
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide .badge'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var cnt0=d.querySelectorAll('section.slide .badge').length; document.querySelector('#hsp-tb [data-a="dup"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var clones=d.querySelectorAll('section.slide .badge'); var last=clones[clones.length-1]; return { before:cnt0, after: clones.length, pos: last.style.position, left: last.style.left }; })()`);
    check('元素编辑-复制元素', r.after === r.before + 1, JSON.stringify(r));
    check('复制-静态元素带偏移', r.pos === 'relative' && parseFloat(r.left) > 0, JSON.stringify(r));
    // 复制快捷键 Ctrl+D
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide .badge'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var cnt0=d.querySelectorAll('section.slide .badge').length; d.dispatchEvent(new KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true,cancelable:true})); return { before:cnt0, after: d.querySelectorAll('section.slide .badge').length }; })()`);
    check('复制-快捷键Ctrl+D', r.after === r.before + 1, JSON.stringify(r));

    /* ===== 11. 层级 z-index（不会消失） ===== */
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide .badge'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); document.querySelector('#hsp-tb [data-a="front"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var z1=parseFloat(el.style.zIndex); document.querySelector('#hsp-tb [data-a="back"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var z2=parseFloat(el.style.zIndex); document.querySelector('#hsp-tb [data-a="back"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var z3=parseFloat(el.style.zIndex); return { z1:z1, z2:z2, z3:z3, exists: d.querySelector('section.slide .badge') != null }; })()`);
    check('层级-上移一层增加', r.z1 > 0, JSON.stringify(r));
    check('层级-下移不会消失(≥1)', r.z2 >= 1 && r.z3 >= 1 && r.exists === true, JSON.stringify(r));

    /* ===== 11b. 拖动带 transform 元素：固化为 left/top 不跳位 ===== */
    await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide .badge'); el.removeAttribute('data-anim'); el.style.transform='translate(10px,10px)'; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var r=el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+5,clientY:r.top+5,pointerId:40,button:0,buttons:1,bubbles:true,cancelable:true})); el.dispatchEvent(new PointerEvent('pointerup',{pointerId:40,bubbles:true})); })()`);
    r = await js(`(function(){ var el=HSP.player.doc().querySelector('section.slide .badge'); return { transform: el.style.transform, left: el.style.left, top: el.style.top }; })()`);
    check('拖动-transform固化不跳位', r.transform === 'none' && r.left === '10px' && r.top === '10px', JSON.stringify(r));

    /* ===== 11c. 文字颜色调节（拾色器不被 pointerdown 拦截） ===== */
    await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide h1'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var inp=document.querySelector('#hsp-tb [data-a="color"]'); inp.value='#ff8800'; inp.dispatchEvent(new Event('input',{bubbles:true})); return el.style.color; })()`);
    r = await js(`HSP.player.doc().querySelector('section.slide h1').style.color`);
    check('编辑-文字颜色调节', r === 'rgb(255, 136, 0)' || r === '#ff8800', 'color=' + r);
    /* ===== 11c2. 复杂颜色：渐变背景 / 渐变文字改色必须真正生效 ===== */
    await js(`HSP.player.go(1)`);
    await sleep(300);
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide .col.new') || d.querySelector('section.slide .col'); if(!el) return { missing:true }; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var inp=document.querySelector('#hsp-tb [data-a="bg"]'); inp.value='#112233'; inp.dispatchEvent(new Event('input',{bubbles:true})); var cs=getComputedStyle(el); return { bg: cs.backgroundColor, img: cs.backgroundImage }; })()`);
    check('编辑-渐变背景改底色生效', r.missing !== true && r.img === 'none' && /17,\s*34,\s*51/.test(r.bg), JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelector('section.slide .eyebrow'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var inp=document.querySelector('#hsp-tb [data-a="color"]'); inp.value='#ff8800'; inp.dispatchEvent(new Event('input',{bubbles:true})); var cs=getComputedStyle(el); return { color: cs.color, img: cs.backgroundImage }; })()`);
    check('编辑-渐变文字改色生效', /255,\s*136,\s*0/.test(r.color) && r.img === 'none', JSON.stringify(r));
    await js(`HSP.player.go(0)`);
    await sleep(250);
    /* ===== 11c3. 多选 / 对齐 / 分布 / 属性面板（对标 PPT） ===== */
    await js(`HSP.player.go(2)`);
    await sleep(320);
    r = await js(`(function(){ var p=document.getElementById('inspector'); return { exists: !!p, x: !!document.getElementById('insp-x'), rot: !!document.getElementById('insp-rot'), op: !!document.getElementById('insp-op'), align: !!p.querySelector('[data-ia="align-left"]'), dist: !!p.querySelector('[data-ia="dist-h"]'), radius: !!document.getElementById('insp-radius'), shadow: !!document.getElementById('insp-shadow'), text: !!p.querySelector('[data-ia="text-center"]') }; })()`);
    check('属性面板-元素齐全', r.exists && r.x && r.rot && r.op && r.align && r.dist && r.radius && r.shadow && r.text, JSON.stringify(r));
    // Shift 加选两个卡片 → 出现多选框、属性面板可见
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[2]; var cards=cs.querySelectorAll('.card'); if(cards.length<2) return { skip:true }; cards[0].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); cards[1].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:true})); return { boxes: document.querySelectorAll('#hsp-multi .hsp-mbox').length, insp: !document.getElementById('inspector').classList.contains('hidden') }; })()`);
    check('编辑-Shift加选多选生效', r.skip !== true && r.boxes >= 1 && r.insp === true, JSON.stringify(r));
    // 左对齐（相对选区）
    r = await js(`(function(){ var d=HSP.player.doc(); document.querySelector('#inspector [data-ia="align-left"]').click(); var cs=d.querySelectorAll('section.slide')[2]; var cards=cs.querySelectorAll('.card'); return { d: Math.round(Math.abs(cards[0].getBoundingClientRect().left - cards[1].getBoundingClientRect().left)) }; })()`);
    check('编辑-左对齐生效', r.d <= 2, JSON.stringify(r));
    // 全选 (Ctrl+A)
    await js(`(function(){ HSP.player.doc().dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true})); })()`);
    await sleep(180);
    r = await js(`HSP.player.doc().querySelectorAll('.__hsp_moving').length`);
    check('编辑-全选(Ctrl+A)生效', r >= 2, 'selected=' + r);
    // 水平等距分布（3 个卡片）
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[2]; var cards=Array.prototype.slice.call(cs.querySelectorAll('.card')); if(cards.length<3) return { skip:true }; cards.forEach(function(c){ c.style.left=''; c.style.top=''; c.style.position=''; c.style.transform=''; }); cards.forEach(function(c,i){ c.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:i>0})); }); document.querySelector('#inspector [data-ia="dist-h"]').click(); var a=cards[0].getBoundingClientRect(), b=cards[1].getBoundingClientRect(), c=cards[2].getBoundingClientRect(); return { g1: Math.round(b.left-a.right), g2: Math.round(c.left-b.right) }; })()`);
    check('编辑-水平等距分布', r.skip !== true && Math.abs(r.g1 - r.g2) <= 3, JSON.stringify(r));
    // 透明度 / 圆角 / 旋转 / 文本对齐
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelectorAll('section.slide')[2].querySelector('.card'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var set=function(id,v){ var i=document.getElementById(id); i.value=v; i.dispatchEvent(new Event('change',{bubbles:true})); }; set('insp-op', 60); set('insp-radius', 20); var g=getComputedStyle(el); return { op: g.opacity, rad: Math.round(parseFloat(g.borderTopLeftRadius)||0) }; })()`);
    check('编辑-透明度与圆角生效', Math.abs(parseFloat(r.op) - 0.6) < 0.06 && r.rad >= 18, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelectorAll('section.slide')[2].querySelector('.card'); var i=document.getElementById('insp-rot'); i.value=15; i.dispatchEvent(new Event('change',{bubbles:true})); return getComputedStyle(el).transform; })()`);
    check('编辑-旋转生效', /matrix/.test(r), 'tr=' + r);
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelectorAll('section.slide')[2].querySelector('.card'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); document.querySelector('#inspector [data-ia="text-center"]').click(); return getComputedStyle(el).textAlign; })()`);
    check('编辑-文本对齐生效', r === 'center', 'align=' + r);
    // 置顶 + 复制粘贴
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[2]; var el=cs.querySelector('.card'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); document.querySelector('#inspector [data-ia="layer-front"]').click(); return { isLast: el.parentElement.lastElementChild === el, n: cs.children.length }; })()`);
    check('编辑-置顶生效', r.isLast === true, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[2]; var before=cs.children.length; var el=cs.querySelector('.card'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); d.dispatchEvent(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,bubbles:true,cancelable:true})); d.dispatchEvent(new KeyboardEvent('keydown',{key:'v',ctrlKey:true,bubbles:true,cancelable:true})); return { before: before, after: cs.children.length }; })()`);
    check('编辑-复制粘贴元素', r.after === r.before + 1, JSON.stringify(r));
    // 清理：去掉测试复制出来的卡片，避免影响后续断言
    await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[2]; Array.prototype.slice.call(cs.children).forEach(function(c){ if(c.classList && c.classList.contains('card')) c.remove(); }); })()`);
    await js(`HSP.player.go(0)`);
    await sleep(250);

    /* ===== 11c4. 按元素类型的差异菜单（像 PPT：不同元素给不同编辑项） ===== */
    await js(`HSP.player.go(0)`);
    await sleep(300);
    r = await js(`(function(){ var d=HSP.player.doc(); var h=d.querySelectorAll('section.slide')[0].querySelector('h1'); h.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var p=document.getElementById('inspector');
      function vis(sel){ var g=p.querySelector(sel); return g ? getComputedStyle(g).display !== 'none' : null; }
      return { kind: document.getElementById('insp-kind').textContent, textVis: vis('.insp-group[data-for="text"]'), mediaVis: vis('.insp-group[data-for="media svg"]'), font: !!document.getElementById('insp-font'), lh: !!document.getElementById('insp-lh') }; })()`);
    check('类型菜单-文本元素显示文本项', r.kind === '文本' && r.textVis === true && r.mediaVis === false && r.font && r.lh, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[1]; var el=cs.querySelector('.col.new')||cs.querySelector('.col'); if(!el) return { skip:true }; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var p=document.getElementById('inspector');
      function vis(sel){ var g=p.querySelector(sel); return g ? getComputedStyle(g).display !== 'none' : null; }
      return { kind: document.getElementById('insp-kind').textContent, textVis: vis('.insp-group[data-for="text"]'), fill: !!document.getElementById('insp-bg'), grad: !!p.querySelector('[data-ia="grad"]') }; })()`);
    check('类型菜单-形状元素显示填充项', r.skip !== true && r.textVis === false && r.fill === true && r.grad === true, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelectorAll('section.slide')[5].querySelector('svg.draw'); if(!el) return { skip:true }; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var p=document.getElementById('inspector');
      function vis(sel){ var g=p.querySelector(sel); return g ? getComputedStyle(g).display !== 'none' : null; }
      return { kind: document.getElementById('insp-kind').textContent, mediaVis: vis('.insp-group[data-for="media svg"]'), stroke: !!document.getElementById('insp-stroke'), fit: !!document.getElementById('insp-fit') }; })()`);
    check('类型菜单-SVG显示图形项', r.skip !== true && /矢量/.test(r.kind) && r.mediaVis === true && r.stroke === true && r.fit === true, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[1]; var el=cs.querySelector('.col')||cs.querySelector('.col.new'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var tb=document.getElementById('hsp-tb'); return { boldHidden: getComputedStyle(tb.querySelector('[data-a="bold"]')).display === 'none', bgShown: getComputedStyle(tb.querySelector('[data-a="bg"]')).display !== 'none' }; })()`);
    check('工具条-形状元素隐藏文本工具', r.boldHidden === true && r.bgShown === true, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var h=d.querySelectorAll('section.slide')[0].querySelector('h1'); h.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var tb=document.getElementById('hsp-tb'); return { boldShown: getComputedStyle(tb.querySelector('[data-a="bold"]')).display !== 'none', u: !!tb.querySelector('[data-a="underline"]') }; })()`);
    check('工具条-文本元素显示文本工具', r.boldShown === true && r.u === true, JSON.stringify(r));
    /* ===== 11c5. 新增编辑能力：字体/行高/字距/下划线/阴影/渐变/内边距/滤镜 ===== */
    r = await js(`(function(){ var d=HSP.player.doc(); var h=d.querySelectorAll('section.slide')[0].querySelector('h1'); h.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      var set=function(id,v){ var i=document.getElementById(id); i.value=v; i.dispatchEvent(new Event('change',{bubbles:true})); };
      set('insp-lh', 2.2); set('insp-ls', 3); set('insp-fs', 40);
      document.querySelector('#inspector [data-ia="underline"]').click();
      document.querySelector('#inspector [data-ia="text-shadow"]').click();
      var g=getComputedStyle(h);
      return { ls: g.letterSpacing, fs: g.fontSize, deco: g.textDecorationLine, shadow: (g.textShadow && g.textShadow !== 'none') }; })()`);
    check('文本进阶-行高/字距/字号/下划线/阴影', r.ls === '3px' && r.fs === '40px' && /underline/.test(r.deco) && r.shadow === true, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var h=d.querySelectorAll('section.slide')[0].querySelector('h1'); h.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var f=document.getElementById('insp-font'); f.value=f.options[2].value; f.dispatchEvent(new Event('change',{bubbles:true})); return h.style.fontFamily; })()`);
    check('文本进阶-字体族生效', /Georgia|serif/i.test(r || ''), 'fam=' + r);
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[1]; var el=cs.querySelector('.col.new')||cs.querySelector('.col'); if(!el) return { skip:true }; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      document.querySelector('#inspector [data-ia="grad"]').click();
      var g1=getComputedStyle(el).backgroundImage;
      document.querySelector('#inspector [data-ia="grad-clear"]').click();
      var g2=getComputedStyle(el).backgroundImage;
      var pad=document.getElementById('insp-pad'); pad.value=24; pad.dispatchEvent(new Event('change',{bubbles:true}));
      return { grad: /gradient/.test(g1), cleared: !/gradient/.test(g2), pad: Math.round(parseFloat(getComputedStyle(el).paddingTop)||0) }; })()`);
    check('填充进阶-渐变套用/清除/内边距', r.skip !== true && r.grad === true && r.cleared === true && Math.abs(r.pad - 24) < 1, JSON.stringify(r));
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[1]; var el=cs.querySelector('.col')||cs.querySelector('.col.new'); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var f=document.getElementById('insp-filter'); f.value='grayscale(1)'; f.dispatchEvent(new Event('change',{bubbles:true})); return getComputedStyle(el).filter; })()`);
    check('图片进阶-滤镜生效', /grayscale/.test(r), 'filter=' + r);
    // 还原测试造成的样式改动，避免影响后续断言
    await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[1]; var col=cs.querySelector('.col'); if(col){ col.style.cssText=''; } var h=d.querySelectorAll('section.slide')[0].querySelector('h1'); h.removeAttribute('style'); })()`);
    await js(`HSP.player.go(0)`);
    await sleep(250);
    /* ===== 11d. 加粗按数值判断（800 的标题点 B 应取消加粗而不是变细） ===== */
    await js(`(function(){ var d=HSP.player.doc(); d.querySelector('section.slide h1').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    await js(`(function(){ document.querySelector('#hsp-tb [data-a="bold"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    r = await js(`HSP.player.doc().querySelector('section.slide h1').style.fontWeight`);
    check('加粗-800标题点B取消加粗', r === 'normal', 'weight=' + r);
    await js(`(function(){ document.querySelector('#hsp-tb [data-a="bold"]').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    r = await js(`HSP.player.doc().querySelector('section.slide h1').style.fontWeight`);
    check('加粗-再点变700', r === '700', 'weight=' + r);

    /* ===== 11e. 字号按比例增减 + 按钮自身不变 ===== */
    r = await js(`(function(){ var el=HSP.player.doc().querySelector('section.slide h1'); var before=parseFloat(getComputedStyle(el).fontSize); var btn=document.querySelector('#hsp-tb [data-a="up"]'); var btnBefore=parseFloat(getComputedStyle(btn).fontSize); btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); var after=parseFloat(getComputedStyle(el).fontSize); var btnAfter=parseFloat(getComputedStyle(btn).fontSize); return { before:Math.round(before), after:Math.round(after), btnBefore:btnBefore, btnAfter:btnAfter }; })()`);
    check('字号-A+按比例增大', r.after > r.before * 1.1, JSON.stringify(r));
    check('字号按钮-自身不被改变', r.btnBefore === r.btnAfter, JSON.stringify(r));
    // Ctrl+Z 撤销（恢复到字号修改前：内联 font-size 被移除；标注应保留）
    await js(`(function(){ HSP.state.annotations[0] = [{tool:'pen', points:[{x:0.1,y:0.1}]}]; HSP.player.doc().dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true})); })()`);
    await sleep(1200);
    r = await js(`(function(){ var h1=HSP.player.doc().querySelector('section.slide h1'); return { cleared: h1.style.fontSize === '', keepAnnot: (HSP.state.annotations[0]||[]).length === 1 }; })()`);
    check('撤销-Ctrl+Z恢复字号', r.cleared === true, 'inline fontSize cleared');
    check('撤销-保留标注', r.keepAnnot === true, JSON.stringify(r));

    /* ===== 12. 双击改文字 ===== */
    await js(`(function(){ HSP.player.doc().querySelector('section.slide h1').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); })()`);
    r = await js(`(function(){ var el=HSP.player.doc().querySelector('section.slide h1'); return { editable: el.contentEditable, tb: document.getElementById('hsp-tb').style.display }; })()`);
    check('元素编辑-双击进入文字编辑', r.editable === 'true', 'contentEditable=' + r.editable);
    check('编辑文字-工具条自动收起', r.tb === 'none', 'tb=' + r.tb);
    await js(`(function(){ var h=HSP.player.doc().querySelector('section.slide h1'); h.textContent='测试标题X'; h.blur(); })()`);
    await sleep(150);
    r = await js(`HSP.player.serialize().indexOf('测试标题X') > -1`);
    check('元素编辑-文字改动写入序列化', r === true);

    /* ===== 13. 图片：工具条定制 + 缩放 ===== */
    await js(`HSP.editor.addImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=')`);
    await sleep(150);
    r = await js(`(function(){ var img=HSP.player.doc().querySelector('img[src^="data:image"]'); var cs=getComputedStyle(img); return { csTransform: cs.transform, left: img.style.left, top: img.style.top }; })()`);
    check('图片-像素定位无transform(不跳位)', r.csTransform === 'none' && /px$/.test(r.left) && /px$/.test(r.top), JSON.stringify(r));
    r = await js(`(function(){ var tb=document.getElementById('hsp-tb'); return { bold: tb.querySelector('[data-a="bold"]').style.display, color: tb.querySelector('[data-a="color"]').style.display, del: tb.querySelector('[data-a="del"]').style.display, dup: tb.querySelector('[data-a="dup"]').style.display }; })()`);
    check('图片-工具条隐藏文字类工具', r.bold === 'none' && r.color === 'none', JSON.stringify(r));
    check('图片-保留复制/删除', r.del === '' && r.dup === '', JSON.stringify(r));
    r = await js(`(function(){ var el=HSP.player.doc().querySelector('img[src^="data:image"]'); var r0=el.getBoundingClientRect(); var h=document.querySelector('#hsp-sel [data-h="se"]'); h.dispatchEvent(new PointerEvent('pointerdown',{clientX:r0.right,clientY:r0.bottom,pointerId:31,button:0,buttons:1,bubbles:true,cancelable:true})); document.dispatchEvent(new PointerEvent('pointermove',{clientX:r0.right+80,clientY:r0.bottom+80,pointerId:31,bubbles:true})); document.dispatchEvent(new PointerEvent('pointerup',{pointerId:31,bubbles:true})); return { w: parseFloat(el.style.width), before: r0.width, maxW: el.style.maxWidth }; })()`);
    check('图片-手柄缩放', r.w > r.before + 30, JSON.stringify(r));
    check('图片-缩放解除max限制', r.maxW === 'none', 'maxWidth=' + r.maxW);
    // 双击图片不进入文字编辑
    r = await js(`(function(){ var img=HSP.player.doc().querySelector('img[src^="data:image"]'); img.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true})); return img.contentEditable; })()`);
    check('图片-双击不进入文字编辑', r !== 'true', 'contentEditable=' + r);
    // 编辑模式放行表单元素（不被选中拦截）
    await js(`(function(){ var d=HSP.player.doc(); var inp=d.createElement('input'); inp.type='text'; d.querySelector('section.slide').appendChild(inp); inp.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); })()`);
    r = await js(`HSP.player.doc().querySelector('section.slide input').classList.contains('__hsp_moving')`);
    check('编辑-表单元素不被选中拦截', r === false);
    // 工具条在视口内（fixed 定位，菜单不会跑丢）
    r = await js(`(function(){ var tb=document.getElementById('hsp-tb'); var vw=document.documentElement.clientWidth; var vh=document.documentElement.clientHeight; var l=parseFloat(tb.style.left)||0, t=parseFloat(tb.style.top)||0; return { tbInView: l >= -1 && t >= -1 && l < vw && t < vh, left: l, top: t, vw: vw, vh: vh }; })()`);
    check('编辑工具条-位于视口内', r.tbInView === true, JSON.stringify(r));
    // 图片禁止原生拖拽（draggable=false + dragstart 拦截）
    r = await js(`(function(){ var d=HSP.player.doc(); var img=d.querySelector('img[src^="data:image"]'); var ev=new DragEvent('dragstart',{bubbles:true,cancelable:true}); img.dispatchEvent(ev); return { draggable: img.draggable, prevented: ev.defaultPrevented }; })()`);
    check('图片-禁止原生拖拽', r.draggable === false && r.prevented === true, JSON.stringify(r));

    /* ===== 14. 新增/复制/删除页 + 换背景 + 文本框 ===== */
    let tot = await js(`HSP.state.total`);
    await js(`document.getElementById('btn-add-slide').click()`);
    await sleep(150);
    r = await js(`HSP.state.total`);
    check('新增页', r === tot + 1, 'total=' + r);
    tot = await js(`HSP.state.total`);
    await js(`document.querySelector('#slide-list .thumb:nth-child(2) .ops [data-op="dup"]').click()`);
    await sleep(150);
    r = await js(`HSP.state.total`);
    check('复制页', r === tot + 1, 'total=' + r);
    tot = await js(`HSP.state.total`);
    await js(`document.querySelector('#slide-list .thumb:last-child .ops [data-op="del"]').click()`);
    await sleep(150);
    r = await js(`HSP.state.total`);
    check('删除页', r === tot - 1, 'total=' + r);
    await js(`(function(){ var c=document.getElementById('bg-color'); c.value='#123456'; c.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    r = await js(`HSP.state.slides[HSP.state.current].el.style.backgroundColor`);
    check('换背景-UI按钮', r === 'rgb(18, 52, 86)' || r === '#123456', String(r));
    await js(`document.getElementById('btn-add-text').click()`);
    await sleep(100);
    r = await js(`HSP.player.doc().querySelector('.hsp-textbox') != null`);
    check('加文本框-UI按钮', r === true);

    /* ===== 15. 图片对话框 / AI助手 / 序列化 ===== */
    await js(`document.getElementById('btn-add-image').click()`);
    r = await js(`!document.getElementById('img-dialog').classList.contains('hidden')`);
    check('图片-对话框打开', r === true);
    await js(`(function(){ document.getElementById('img-url').value='data:image/gif;base64,R0lGODlhAQABAAAAACw='; document.getElementById('img-ok').click(); })()`);
    await sleep(150);
    r = await js(`HSP.player.doc().querySelectorAll('img[src^="data:image"]').length >= 2`);
    check('图片-URL添加成功', r === true);
    // ===== 设置页（含 AI 模型管理） =====
    await js(`localStorage.removeItem('hsp-ai-models'); localStorage.removeItem('hsp-ai-active'); localStorage.removeItem('hsp-settings');`);
    r = await js(`(function(){ var b=document.getElementById('btn-ai'); b.click(); return { shown: !document.getElementById('ai-dialog').classList.contains('hidden'), prompt: !!document.getElementById('ai-prompt'), go: !!document.getElementById('ai-go'), label: document.getElementById('ai-current-model').textContent, modeNew: document.getElementById('ai-mode-new').classList.contains('active') }; })()`);
    check('AI助手-按钮打开面板', r.shown && r.prompt && r.go, JSON.stringify(r));
    check('AI助手-未配置模型时提示', /未配置/.test(r.label), 'label=' + r.label);
    check('AI助手-默认生成模式', r.modeNew === true, JSON.stringify(r));
    // 三模式
    await js(`document.getElementById('ai-mode-page').click()`);
    r = await js(`(function(){ var c=document.getElementById('ai-context'); return { pageActive: document.getElementById('ai-mode-page').classList.contains('active'), allExists: !!document.getElementById('ai-mode-all'), ctx: c.textContent }; })()`);
    check('AI助手-改这一页模式', r.pageActive && r.allExists, JSON.stringify(r));
    check('AI助手-上下文显示页号', /第 \d+ 页/.test(r.ctx), 'ctx=' + r.ctx);
    await js(`document.getElementById('ai-mode-all').click()`);
    r = await js(`document.getElementById('ai-context').textContent.indexOf('整个演示文稿') > -1`);
    check('AI助手-改整个演示模式', r === true);
    // AI 生成：输出被截断时自动续写（只生成两三页的根因之一）
    r = await js(`(async function(){
      var orig = window.fetch, calls = 0;
      window.fetch = async function(url, opt){
        calls++;
        var body = JSON.parse(opt.body);
        var isCont = body.messages.some(function(m){ return /被截断了/.test(m.content || ''); });
        var content = isCont
          ? '<section class="slide"><h1>第二页</h1></section></body></html>'
          : '<!DOCTYPE html><html><head><style>.slide{min-height:100vh}</style></head><body><section class="slide"><h1>第一页</h1>';
        return { ok:true, json: async function(){ return { choices:[{ message:{ content: content } }] }; } };
      };
      try {
        var html = await HSP.ai.generate('测试', 'new', {}, [], { apiKey:'x', baseURL:'https://example.com/v1', model:'m' });
        return { calls: calls, complete: /<\\/html>/.test(html), sections: (html.match(/<section/g) || []).length };
      } finally { window.fetch = orig; }
    })()`);
    check('AI-截断自动续写', r.calls >= 2 && r.complete === true && r.sections >= 2, JSON.stringify(r));
    await js(`document.getElementById('ai-cancel').click()`);
    // 设置页
    r = await js(`(function(){ document.getElementById('btn-settings').click(); return { shown: !document.getElementById('settings-dialog').classList.contains('hidden'), theme: !!document.getElementById('set-theme'), click: !!document.getElementById('set-clicknav'), wheel: !!document.getElementById('set-wheelnav'), dm: !!document.getElementById('set-defaultmode'), bar: !!document.getElementById('set-barhide'), pen: !!document.getElementById('set-pencolor'), sel: !!document.getElementById('ai-model-select') }; })()`);
    check('设置-打开且元素齐全', r.shown && r.theme && r.click && r.wheel && r.dm && r.bar && r.pen && r.sel, JSON.stringify(r));
    // 圆角对称：滚动必须发生在内层，外层只负责圆角与裁剪
    r = await js(`(function(){ var box=document.querySelector('.settings-box'); var body=document.querySelector('.settings-body'); var cb=getComputedStyle(box), cbody=getComputedStyle(body); return { l: cb.borderTopLeftRadius, rt: cb.borderTopRightRadius, lb: cb.borderBottomLeftRadius, rb: cb.borderBottomRightRadius, overflowY: cb.overflowY, overflowX: cb.overflowX, bodyOverflowY: cbody.overflowY }; })()`);
    check('设置框-四角圆角一致', r.l === r.rt && r.l === r.lb && r.l === r.rb && r.l === '16px', JSON.stringify(r));
    check('设置框-滚动在内层(不切圆角)', r.overflowY === 'hidden' && r.overflowX === 'hidden' && r.bodyOverflowY === 'auto', JSON.stringify(r));
    // 主题切换
    r = await js(`(function(){ var t=document.getElementById('set-theme'); t.value='dark'; t.dispatchEvent(new Event('change',{bubbles:true})); var d1=document.body.classList.contains('theme-dark'); t.value='light'; t.dispatchEvent(new Event('change',{bubbles:true})); return { dark: d1, light: document.body.classList.contains('theme-dark') }; })()`);
    check('设置-深色/浅色主题切换', r.dark === true && r.light === false, JSON.stringify(r));
    // 播放设置生效并持久化
    r = await js(`(function(){ var c=document.getElementById('set-clicknav'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true})); var s=JSON.parse(localStorage.getItem('hsp-settings')||'{}'); var out={ nav:HSP.state.clickNav, saved:s.clickNav }; c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})); return out; })()`);
    check('设置-单击翻页开关生效并持久化', r.nav === false && r.saved === false, JSON.stringify(r));
    // 标注默认值同步
    r = await js(`(function(){ var p=document.getElementById('set-pencolor'); p.value='#00ff00'; p.dispatchEvent(new Event('input',{bubbles:true})); var out={ color:HSP.state.color, picker:document.getElementById('color-picker').value }; p.value='#ff2d55'; p.dispatchEvent(new Event('input',{bubbles:true})); return out; })()`);
    check('设置-标注默认颜色同步', r.color === '#00ff00' && r.picker === '#00ff00', JSON.stringify(r));
    /* ===== 设置-提示词可编辑（内容可改，输出格式由软件锁定） ===== */
    await js(`localStorage.removeItem('hsp-ai-prompt')`);
    await js(`(function(){ document.getElementById('settings-close').click(); document.getElementById('btn-settings').click(); })()`);
    r = await js(`(function(){ var ta=document.getElementById('set-ai-prompt'); return { has: !!ta, len: ta ? ta.value.length : 0, save: !!document.getElementById('set-prompt-save'), reset: !!document.getElementById('set-prompt-reset'), hint: (document.getElementById('set-prompt-hint')||{}).textContent }; })()`);
    check('提示词编辑-设置页有编辑框(默认已填充)', r.has && r.len > 200 && r.save && r.reset, JSON.stringify(r));
    r = await js(`(function(){ var ta=document.getElementById('set-ai-prompt'); ta.value='【自定义】你是极简风格设计师，严格控制每页不超过 20 字。'; document.getElementById('set-prompt-save').click(); return { saved: localStorage.getItem('hsp-ai-prompt'), active: HSP.ai.activePrompt() }; })()`);
    check('提示词编辑-保存生效', /极简风格/.test(r.saved || '') && /极简风格/.test(r.active), 'saved=' + (r.saved ? 'yes' : 'no'));
    r = await js(`(function(){ var s = HSP.ai.buildSystem('new'); return { custom: s.indexOf('极简风格') >= 0, formatLocked: s.indexOf('只输出一个完整') >= 0, noExplain: s.indexOf('不要任何解释') >= 0, len: s.length }; })()`);
    check('提示词编辑-自定义内容进入系统提示', r.custom === true, JSON.stringify(r));
    check('提示词编辑-输出格式仍被软件锁定(改不坏)', r.formatLocked === true && r.noExplain === true, JSON.stringify(r));
    r = await js(`(function(){ document.getElementById('set-prompt-reset').click(); return { saved: localStorage.getItem('hsp-ai-prompt'), isDefault: HSP.ai.activePrompt() === HSP.ai.defaultPrompt() }; })()`);
    check('提示词编辑-可恢复默认', r.saved === null && r.isDefault === true, JSON.stringify(r));
    await js(`localStorage.removeItem('hsp-ai-prompt')`);
    // AI 模型：只填 Key 即可（URL 自动）
    r = await js(`(function(){ document.getElementById('ai-add-model').click(); var shown=!document.getElementById('ai-model-form').classList.contains('hidden'); var p=document.getElementById('ai-preset'); p.value='deepseek'; p.dispatchEvent(new Event('change',{bubbles:true})); var model=document.getElementById('ai-model').value; var vision=document.getElementById('ai-vision').value; var baseHidden=document.querySelector('.custom-only').classList.contains('hidden'); document.getElementById('ai-key').value='sk-test-key'; document.getElementById('ai-save-model').click(); var arr=JSON.parse(localStorage.getItem('hsp-ai-models')||'[]'); return { formShown:shown, model:model, vision:vision, baseHidden:baseHidden, saved:arr.length, key:arr[0]&&arr[0].apiKey, base:arr[0]&&arr[0].baseURL }; })()`);
    check('设置-添加模型表单可展开', r.formShown === true, JSON.stringify(r));
    check('设置-选服务自动带出模型', r.model === 'deepseek-chat' && r.vision === '0', JSON.stringify(r));
    check('设置-无需填接口地址', r.baseHidden === true, JSON.stringify(r));
    check('设置-只填Key即保存(URL自动)', r.saved === 1 && r.key === 'sk-test-key' && r.base === 'https://api.deepseek.com', JSON.stringify(r));
    /* ===== 模型下拉：获取到几个就必须能选几个（原 datalist 会被输入过滤） ===== */
    r = await js(`(function(){ document.getElementById('ai-add-model').click(); var p=document.getElementById('ai-preset'); p.value='deepseek'; p.dispatchEvent(new Event('change',{bubbles:true})); var sel=document.getElementById('ai-model'); var opts=Array.prototype.map.call(sel.options, function(o){return o.value;}); return { tag: sel.tagName, count: sel.options.length, hasReasoner: opts.indexOf('deepseek-reasoner') >= 0, hasCustom: opts.indexOf('__custom__') >= 0 }; })()`);
    check('模型下拉-内置模型全部可见', r.tag === 'SELECT' && r.hasReasoner === true && r.hasCustom === true && r.count >= 3, JSON.stringify(r));
    // 模拟服务端返回 2 个模型 → 下拉里两个都要能选
    await js(`(function(){ window.__origFetch = window.fetch; window.fetch = async function(){ return { ok:true, json: async function(){ return { data:[{id:'model-a'},{id:'model-b'}] }; } }; }; document.getElementById('ai-key').value='sk-test'; document.getElementById('ai-model-hint').textContent=''; document.getElementById('ai-fetch-models').click(); })()`);
    await sleep(700);
    r = await js(`(function(){ var sel=document.getElementById('ai-model'); var vals=Array.prototype.map.call(sel.options, function(o){return o.value;}); var hint=document.getElementById('ai-model-hint').textContent; if (window.__origFetch) window.fetch = window.__origFetch; return { vals: vals, hint: hint }; })()`);
    check('模型获取-两个都能选(不再只剩一个)', r.vals.indexOf('model-a') >= 0 && r.vals.indexOf('model-b') >= 0 && /2 个/.test(r.hint), JSON.stringify(r));
    check('模型获取-提示数量与选项一致', r.vals.filter(function(v){ return v !== '__custom__'; }).length === 2, JSON.stringify(r.vals));
    await js(`document.getElementById('settings-close').click()`);
    // 关闭设置后，AI 面板显示已配置模型
    await js(`document.getElementById('btn-ai').click()`);
    r = await js(`document.getElementById('ai-current-model').textContent`);
    check('AI助手-显示已配置模型', /DeepSeek/.test(r) && /deepseek-chat/.test(r), 'label=' + r);
    await js(`document.getElementById('ai-cancel').click()`);
    await js(`localStorage.removeItem('hsp-ai-models'); localStorage.removeItem('hsp-ai-active'); localStorage.removeItem('hsp-settings');`);
    r = await js(`HSP.player.serialize().length > 1000`);
    check('序列化', r === true);
    // 保存的 HTML 不应包含编辑注入层残留
    r = await js(`(function(){ var html=HSP.player.serialize(); return { noSel: html.indexOf('__hsp_sel') === -1, noTb: html.indexOf('__hsp_tb') === -1, noStyle: html.indexOf('__hsp_style') === -1, noMoving: html.indexOf('__hsp_moving') === -1 }; })()`);
    check('序列化-无编辑层残留', r.noSel && r.noTb && r.noStyle && r.noMoving, JSON.stringify(r));
    // 图标有效性：关键 SVG 图标必须有非零绘制区域（自动发现畸形路径）
    r = await js(`(function(){ var NS='http://www.w3.org/2000/svg'; var ids=['i-cursor','i-brush','i-highlighter','i-laser','i-eraser','i-pen','i-copy','i-layer-up','i-layer-down','i-trash','i-sparkles','i-folder']; var bad=[]; ids.forEach(function(id){ var svg=document.createElementNS(NS,'svg'); svg.setAttribute('class','ico'); svg.style.cssText='position:fixed;left:-9999px;top:0'; var u=document.createElementNS(NS,'use'); u.setAttribute('href','#'+id); svg.appendChild(u); document.body.appendChild(svg); var b=svg.getBBox(); if(!b || b.width<4 || b.height<4) bad.push(id); document.body.removeChild(svg); }); return bad; })()`);
    check('图标-SVG渲染有效', r.length === 0, 'bad=' + JSON.stringify(r));
    // 工具栏"播放/编辑"相对整个工具栏真正居中
    r = await js(`(function(){ var s=document.getElementById('mode-group'); var b=s.getBoundingClientRect(); return { c: Math.round(b.left+b.width/2), v: Math.round(window.innerWidth/2) }; })()`);
    check('工具栏-模式按钮居中', Math.abs(r.c - r.v) < 12, JSON.stringify(r));
    // ===== 修复①：滚动 → 页码反向同步（左侧缩略图跟随） =====
    await js(`HSP.player.go(0)`);
    await sleep(400);
    await js(`(function(){ var d=HSP.player.doc(); d.querySelectorAll('section.slide')[2].scrollIntoView({block:'start'}); })()`);
    // 轮询等待同步收敛（不依赖固定延时，避免偶发时序抖动）
    let synced = false;
    for (let t = 0; t < 15; t++) {
      r = await js(`(function(){ var d=HSP.player.doc(); var act=document.querySelector('#slide-list .thumb.active'); return { cur:HSP.state.current, num: act?act.querySelector('.num').textContent:null, scrollTop: Math.round(d.documentElement.scrollTop||0) }; })()`);
      if (r.cur === 2) { synced = true; break; }
      await sleep(100);
    }
    check('滚动-页码反向同步(缩略图跟随)', synced && r.num === '3' && r.scrollTop > 100, JSON.stringify(r));
    // ===== 修复②：切换模式后重新定位（不卡在两页中间） =====
    await js(`HSP.player.go(2)`);
    await sleep(320);
    await js(`document.getElementById('btn-mode-view').click()`);
    await sleep(700);
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelectorAll('section.slide')[HSP.state.current]; return { cur:HSP.state.current, top:Math.abs(Math.round(el.getBoundingClientRect().top)) }; })()`);
    check('模式切换-切到播放不卡在两页中间', r.top < 120, JSON.stringify(r));
    await js(`document.getElementById('btn-mode-edit').click()`);
    await sleep(700);
    r = await js(`(function(){ var d=HSP.player.doc(); var el=d.querySelectorAll('section.slide')[HSP.state.current]; return Math.abs(Math.round(el.getBoundingClientRect().top)); })()`);
    check('模式切换-切到编辑同样对齐', r < 120, 'top=' + r);

    /* ===== 16. 控制条布局 / 切回播放 / relocate ===== */
    r = await js(`getComputedStyle(document.getElementById('controlbar')).flexWrap`);
    check('控制条-不换行', r === 'nowrap', 'flexWrap=' + r);
    // 编辑模式无选中时 Esc 退出编辑模式
    await js(`(function(){ var d=HSP.player.doc(); d.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})); d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); })()`);
    r = await js(`HSP.state.mode`);
    check('编辑-Esc退出编辑模式', r === 'view', 'mode=' + r);
    await js(`document.getElementById('btn-mode-view').click()`);
    r = await js(`({ mode:HSP.state.mode, bar: !document.getElementById('controlbar').classList.contains('hidden') })`);
    check('切回播放模式', r.mode === 'view' && r.bar === true, JSON.stringify(r));
    r = await js(`(function(){ var c=HSP.state.current; HSP.player.relocate(); return HSP.state.current === c; })()`);
    check('relocate-重新定位不改变页码', r === true);

    /* ===== 17. 演讲者模式 ===== */
    await js(`HSP.presenter.start()`);
    await sleep(2200);
    let wins = BrowserWindow.getAllWindows();
    check('演讲者模式-打开舞台窗口', wins.length === 2, 'windows=' + wins.length);
    r = await js(`({ consoleShown: !document.getElementById('presenter-console').classList.contains('hidden'), thumbs: document.getElementById('pc-thumbs').children.length })`);
    check('演讲者模式-控制台显示', r.consoleShown === true);
    let r2 = await js(`(function(){ var c=document.getElementById('presenter-console'); return {
      idx: !!document.getElementById('pc-index'), title: !!document.getElementById('pc-title'),
      timer: !!document.getElementById('pc-timer'), tToggle: !!document.getElementById('pc-timer-toggle'), tReset: !!document.getElementById('pc-timer-reset'),
      black: !!document.getElementById('pc-black'), white: !!document.getElementById('pc-white'),
      fsUp: !!document.getElementById('pc-fs-up'), fsDown: !!document.getElementById('pc-fs-down'),
      navhint: !!c.querySelector('.pc-navhint'), tools: c.querySelectorAll('.pc-tool').length,
      notes: !!document.getElementById('pc-notes') }; })()`);
    check('演讲者-控制台元素齐全(PPT式布局)', r2.idx && r2.title && r2.timer && r2.tToggle && r2.tReset && r2.black && r2.white && r2.fsUp && r2.fsDown && r2.navhint && r2.tools >= 5 && r2.notes, JSON.stringify(r2));
    // 预览等比缩放：iframe 固定 1280×720 再 scale，避免小窗里内容溢出/变形
    let r3 = await js(`(function(){ var ifr=document.getElementById('pc-next'); if(!ifr) return { skip:true }; var box=ifr.parentElement; var tr=getComputedStyle(ifr).transform; var sc = 1; if (tr && tr !== 'none' && tr.indexOf('(') > 0) { var nums = tr.slice(tr.indexOf('(')+1).replace(/[^0-9.,-]/g,' ').trim().split(/[,\s]+/).map(Number); if (nums[0]) sc = nums[0]; } return { boxW:box.clientWidth, boxH:box.clientHeight, ifrW:ifr.offsetWidth, ifrH:ifr.offsetHeight, sc:sc, hasScale:tr!=='none', tr:tr.slice(0,24) }; })()`);
    check('演讲者-预览等比缩放(不再被压扁)', r3.skip !== true && r3.ifrW === 1280 && r3.ifrH === 720 && r3.hasScale === true && r3.sc > 0 && r3.sc < 1, JSON.stringify(r3));
    // 投影目标回执：告诉讲者正片投到了哪块屏
    let r4 = await js(`(function(){ var b=document.getElementById('pc-projection'); return b ? { text:b.textContent, hidden:b.classList.contains('hidden') } : null; })()`);
    check('演讲者-显示投影目标(副屏回执)', r4 && r4.hidden === false && /外接显示器/.test(r4.text) && /TestDisplay-2/.test(r4.text), JSON.stringify(r4));
    const pcTotal = await js(`HSP.state.total`);
    check('演讲者模式-缩略图', r.thumbs === pcTotal, 'thumbs=' + r.thumbs + ' total=' + pcTotal);
    r = await stageWindow.webContents.executeJavaScript('!document.getElementById("stage-mini-bar").classList.contains("hidden") && document.getElementById("stage-stop") != null', true);
    check('演讲者模式-舞台迷你条', r === true);

    await js(`HSP.presenter.goConsole(3)`);
    await sleep(1000);
    const stageCur = await stageWindow.webContents.executeJavaScript('HSP.state.current', true);
    check('演讲者模式-舞台同步翻页', stageCur === 3, 'stage=' + stageCur);
    r = await js(`(function(){ var f=document.getElementById('pc-cur'); var s1=f.srcdoc; HSP.presenter.goConsole(4); return { loaded: f.__hspLoaded === true, same: f.srcdoc === s1 }; })()`);
    check('演讲者模式-预览不重载(不跳动)', r.loaded === true && r.same === true, JSON.stringify(r));
    await sleep(800);
    if (stageWindow && !stageWindow.isDestroyed()) {
      await stageWindow.webContents.executeJavaScript('HSP.player.go(1)', true);
      await sleep(1000);
      r = await js(`HSP.state.current`);
      check('演讲者模式-控制台跟随舞台翻页', r === 1, 'console=' + r);
    }
    // 黑屏广播到投影窗口
    await js(`document.getElementById('pc-black').click()`);
    await sleep(800);
    let sb1 = await stageWindow.webContents.executeJavaScript(`(function(){ var b=document.getElementById('stage-blank'); return b ? b.className : null; })()`, true);
    check('演讲者-黑屏广播到投影', sb1 === 'black', 'stageBlank=' + sb1);
    await js(`document.getElementById('pc-black').click()`);
    await sleep(700);
    let sb2 = await stageWindow.webContents.executeJavaScript(`(function(){ var b=document.getElementById('stage-blank'); return b ? b.className : null; })()`, true);
    check('演讲者-再点取消黑屏', sb2 === 'hidden', 'stageBlank=' + sb2);
    // 白屏
    await js(`document.getElementById('pc-white').click()`);
    await sleep(700);
    let sb3 = await stageWindow.webContents.executeJavaScript(`(function(){ var b=document.getElementById('stage-blank'); return b ? b.className : null; })()`, true);
    check('演讲者-白屏广播到投影', sb3 === 'white', 'stageBlank=' + sb3);
    await js(`document.getElementById('pc-white').click()`);
    await sleep(400);
    // 备注字号可调
    r = await js(`(function(){ var n=document.getElementById('pc-notes'); var b=parseFloat(getComputedStyle(n).fontSize); document.getElementById('pc-fs-up').click(); return { before:b, after:parseFloat(getComputedStyle(n).fontSize) }; })()`);
    check('演讲者-备注字号可调', r.after > r.before, JSON.stringify(r));
    // 计时暂停：暂停后数值不再增长
    r = await js(`(function(){ document.getElementById('pc-timer-toggle').click(); var t1=document.getElementById('pc-timer').textContent; return { t1:t1 }; })()`);
    await sleep(1200);
    const t2 = await js(`document.getElementById('pc-timer').textContent`);
    check('演讲者-计时可暂停', r.t1 === t2, 't1=' + r.t1 + ' t2=' + t2);
    await js(`document.getElementById('pc-timer-reset').click()`);
    r = await js(`document.getElementById('pc-timer').textContent`);
    check('演讲者-计时归零', r === '00:00', 't=' + r);
    // 控制台键盘翻页
    r = await js(`(function(){ var before=HSP.state.current; document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})); return { before:before, after:HSP.state.current }; })()`);
    check('演讲者-键盘翻页(→)', r.after === r.before + 1, JSON.stringify(r));
    r = await js(`(function(){ var before=HSP.state.current; document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true,cancelable:true})); var bs=HSP.presenter.blankState(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true,cancelable:true})); return { bs:bs, after:HSP.presenter.blankState() }; })()`);
    check('演讲者-B键黑屏并可取消', r.bs === 'black' && r.after === null, JSON.stringify(r));

    if (stageWindow && !stageWindow.isDestroyed()) {
      await stageWindow.webContents.executeJavaScript('HSP.sync.post({ type: "stop" })', true);
      await sleep(800);
      r = await js(`({ consoleHidden: document.getElementById('presenter-console').classList.contains('hidden'), toolbarShown: !document.getElementById('toolbar').classList.contains('hidden') })`);
      check('演讲者模式-舞台结束→控制台恢复', r.consoleHidden === true && r.toolbarShown === true, JSON.stringify(r));
    }
    await js(`HSP.presenter.stop()`);
    await sleep(500);
    check('演讲者模式-结束', true);

    /* ===== 18. 改整个文档：不跳回封面、保留标注（用户反馈的 bug） ===== */
    await js(`(function(){ HSP.state.annotations[0] = [{c:'#ff0000',w:3,p:[[0,0],[0.5,0.5]]}]; HSP.state.annotations[1] = [{c:'#00ff00',w:2,p:[[0,0],[0.2,0.2]]}]; })()`);
    await js(`(function(){ HSP.openFromText('<!DOCTYPE html><html><head><style>.slide{width:100%;min-height:100vh;display:flex;align-items:center;justify-content:center}</style></head><body><section class="slide"><h1>A</h1></section><section class="slide"><h1>B</h1></section><section class="slide"><h1>C</h1></section></body></html>', 'test.html', { gotoPage: 1, keepAnnotations: true }); })()`);
    await sleep(1500);
    r = await js(`(function(){ var a=HSP.state.annotations||{}; var s=0; Object.keys(a).forEach(function(k){ s += (a[k]||[]).length; }); return { cur:HSP.state.current, total:HSP.state.total, strokes:s }; })()`);
    check('改整文档-保留页码不跳回封面', r.cur === 1 && r.total === 3, JSON.stringify(r));
    check('改整文档-保留原有标注', r.strokes >= 2, JSON.stringify(r));
    // 对照：打开全新文件应清空标注并回到第 1 页
    await js(`(function(){ HSP.openFromText('<!DOCTYPE html><html><head><style>.slide{width:100%;min-height:100vh}</style></head><body><section class="slide">X</section><section class="slide">Y</section></body></html>', 'test2.html'); })()`);
    await sleep(1300);
    r = await js(`(function(){ var a=HSP.state.annotations||{}; var s=0; Object.keys(a).forEach(function(k){ s += (a[k]||[]).length; }); return { cur:HSP.state.current, total:HSP.state.total, strokes:s }; })()`);
    check('打开新文件-清空标注回首页', r.cur === 0 && r.strokes === 0 && r.total === 2, JSON.stringify(r));

    /* ===== 19. 从零新建演示 + 插入页面可用（用户反馈的 bug） ===== */
    await js(`(function(){ HSP.newBlankDeck(); })()`);
    await sleep(1600);
    r = await js(`({ total: HSP.state.total, mode: HSP.state.mode, hasTitle: !!HSP.player.doc().querySelector('section.slide h1') })`);
    check('新建空白演示-可直接开始编辑', r.total === 1 && r.mode === 'edit' && r.hasTitle === true, JSON.stringify(r));
    await js(`(function(){ HSP.editor.addSlide(); })()`);
    await sleep(800);
    r = await js(`HSP.state.total`);
    check('新建空白演示-继续插入页面可用', r === 2, 'total=' + r);

    /* ===== 20. 拖动智能吸附与参考线 ===== */
    await js(`HSP.loadSampleFile('tour')`);
    await sleep(2200);
    await js(`document.getElementById('btn-mode-edit').click()`);
    await sleep(800);
    await js(`HSP.player.go(2)`);
    await sleep(500);
    r = await js(`(function(){ var d=HSP.player.doc(); var cs=d.querySelectorAll('section.slide')[2]; var cards=cs.querySelectorAll('.card'); if(cards.length<2) return { skip:true };
      var a=cards[0], b=cards[1];
      a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      var dx=rb.left-ra.left;
      a.dispatchEvent(new PointerEvent('pointerdown',{clientX:200,clientY:200,pointerId:70,button:0,buttons:1,bubbles:true,cancelable:true}));
      document.dispatchEvent(new PointerEvent('pointermove',{clientX:200+dx+3,clientY:200,pointerId:70,button:0,buttons:1,bubbles:true,cancelable:true}));
      var guides=document.querySelectorAll('#hsp-guides .hsp-guide').length;
      document.dispatchEvent(new PointerEvent('pointerup',{pointerId:70,bubbles:true,cancelable:true}));
      var ra2=a.getBoundingClientRect();
      return { guides: guides, diff: Math.round(Math.abs(ra2.left-rb.left)) }; })()`);
    check('拖动吸附-显示参考线并对齐同级', r.skip !== true && r.guides >= 1 && r.diff <= 3, JSON.stringify(r));

    /* ===== 21. 编辑模式下交互控件不被编辑器吞掉（选中容器后仍能拖滑块） ===== */
    await js(`HSP.loadSampleFile('physics')`);
    await sleep(2400);
    await js(`document.getElementById('btn-mode-edit').click()`);
    await sleep(800);
    await js(`HSP.player.go(2)`);
    await sleep(1300);
    // 选中包含滑块的容器：模拟用户在编辑模式下点过交互区域
    const labPt = await js(`(function(){
      var f = document.getElementById('deck'), fr = f.getBoundingClientRect(), d = f.contentDocument;
      var p = d.querySelector('.lab-panel'), r = p.getBoundingClientRect();
      return { x: Math.round(fr.left + r.left + 6), y: Math.round(fr.top + r.top + 6) };
    })()`);
    await win.webContents.sendInputEvent({ type: 'mouseDown', x: labPt.x, y: labPt.y, button: 'left', clickCount: 1 });
    await win.webContents.sendInputEvent({ type: 'mouseUp', x: labPt.x, y: labPt.y, button: 'left', clickCount: 1 });
    await sleep(700);
    r = await js(`({ inspShown: !document.getElementById('inspector').classList.contains('hidden'), mode: HSP.state.mode })`);
    check('编辑模式-已选中交互区域容器(前置条件)', r.inspShown === true && r.mode === 'edit', JSON.stringify(r));
    // 双向验证：滑块按下不被吞，普通元素按下仍被编辑器接管（可拖动元素）
    r = await js(`(function(){
      var d = document.getElementById('deck').contentDocument;
      var s = d.getElementById('p-v0');
      var plain = d.querySelector('.lab-panel .readout');
      var mk = function(){ return new d.defaultView.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }); };
      var e1 = mk(); s.dispatchEvent(e1);
      var e2 = mk(); plain.dispatchEvent(e2);
      return { sliderPrevented: e1.defaultPrevented, plainPrevented: e2.defaultPrevented };
    })()`);
    check('编辑模式-滑块可交互(不再被吞)', r.sliderPrevented === false, JSON.stringify(r));
    check('编辑模式-普通元素仍可拖动编辑', r.plainPrevented === true, JSON.stringify(r));
    await js(`document.getElementById('btn-mode-view').click()`);
    await sleep(400);
    /* ===== 22. 物理演示：弹道等比缩放 + 先调参后发射 + 干涉衍射 ===== */
    await js(`HSP.loadSampleFile('physics')`);
    await sleep(2400);
    r = await js(`(function(){ var p=document.getElementById('proj-path'), b=document.getElementById('proj-ball');
      var doc=document.getElementById('deck').contentDocument;
      var p2=doc.getElementById('proj-path'), b2=doc.getElementById('proj-ball');
      return { total: HSP.state.total, sliders: doc.querySelectorAll('input[type=range]').length,
        ptsLen: (p2.getAttribute('points')||'').length, pathOp: p2.getAttribute('opacity'), ballOp: b2.getAttribute('opacity') }; })()`);
    check('物理演示-8页且含9个滑块(抛体/干涉/衍射)', r.total === 8 && r.sliders === 9, JSON.stringify({ total: r.total, sliders: r.sliders }));
    check('物理演示-首次不显示弹道(点发射才生成)', r.ptsLen === 0 && r.pathOp === '0' && r.ballOp === '0', JSON.stringify(r));
    // 干涉与衍射画布确实有图样，且随参数变化
    r = await js(`(function(){ function stat(id){ var c=document.getElementById('deck').contentDocument.getElementById(id); var x=c.getContext('2d'); var d=x.getImageData(0,0,c.width,c.height).data; var s=0,mx=0; for(var i=0;i<d.length;i+=4){var v=d[i]+d[i+1]+d[i+2]; s+=v; if(v>mx)mx=v;} return { avg:Math.round(s/(d.length/4)/3), max:Math.round(mx/3) }; } return { int: stat('int-canvas'), dif: stat('dif-canvas') }; })()`);
    check('物理演示-干涉图样已绘制', r.int.avg > 40 && r.int.max > 120, JSON.stringify(r.int));
    check('物理演示-衍射图样已绘制', r.dif.max > 100, JSON.stringify(r.dif));
    /* ===== 20. 工具栏精简 & 交互控件可用性 ===== */
    r = await js(`({ sampleBtn: !!document.getElementById('btn-sample'), onboardBtn: !!document.getElementById('set-onboard') })`);
    check('工具栏-已移除「载入示例」按钮', r.sampleBtn === false, JSON.stringify(r));
    check('设置-保留「重新选择领域」入口', r.onboardBtn === true, JSON.stringify(r));
    await js(`HSP.loadSampleFile('physics')`);
    await sleep(2400);
    r = await js(`(function(){ var d=document.getElementById('deck').contentDocument; var s=d.getElementById('p-v0'); if(!s) return {err:true}; return { h: Math.round(s.getBoundingClientRect().height), css: d.defaultView.getComputedStyle(s).height, sliders: d.querySelectorAll('input[type=range]').length }; })()`);
    check('交互示例-滑块热区已加大(≥24px 易抓取)', r.h >= 24 && r.sliders >= 3, JSON.stringify(r));
    /* ===== 23. 物理演示：多轨迹留痕 + 衍射散/聚 ===== */
    await js(`HSP.loadSampleFile('physics')`);
    await sleep(2400);
    // 连续三次不同角度发射 → 轨迹应逐次累加（同坐标系可直接对比）
    const trailCounts = [];
    for (const th of [25, 45, 70]) {
      await js(`(function(){ var d=document.getElementById('deck').contentDocument; var s=d.getElementById('p-th'); s.value='${th}'; s.dispatchEvent(new Event('input',{bubbles:true})); d.getElementById('p-launch').click(); })()`);
      await sleep(1700);
      trailCounts.push(await js(`document.getElementById('deck').contentDocument.querySelectorAll('#proj-trails polyline').length`));
    }
    check('物理演示-每抛一次留下一条轨迹', trailCounts[1] > trailCounts[0] && trailCounts[2] > trailCounts[1], JSON.stringify(trailCounts));
    r = await js(`(function(){ var d=document.getElementById('deck').contentDocument; var ls=d.querySelectorAll('#proj-trails polyline'); var out=[];
      for (var i=0;i<ls.length;i++){ var pts=(ls[i].getAttribute('points')||'').split(' ').filter(Boolean); if(!pts.length) continue;
        var ys=pts.map(function(s){return parseFloat(s.split(',')[1]);});
        out.push({ pts: pts.length, topY: Math.round(Math.min.apply(null,ys)), endX: Math.round(parseFloat(pts[pts.length-1].split(',')[0])) }); }
      var full = out.filter(function(o){ return o.pts > 20; });
      return { n: out.length, withPts: full.length, first: full[0]||null, last: full[full.length-1]||null }; })()`);
    check('物理演示-轨迹已实际绘出曲线(非空壳)', r.withPts >= 2, JSON.stringify({ n: r.n, withPts: r.withPts }));
    check('物理演示-同坐标系轨迹形状各异', r.first && r.last && (r.first.endX !== r.last.endX || r.first.topY !== r.last.topY), JSON.stringify({ n: r.n, withPts: r.withPts, first: r.first, last: r.last }));
    await js(`(function(){ var d=document.getElementById('deck').contentDocument; d.getElementById('p-clear').click(); })()`);
    await sleep(500);
    r = await js(`document.getElementById('deck').contentDocument.querySelectorAll('#proj-trails polyline').length`);
    check('物理演示-可清空轨迹', r === 0, 'trails=' + r);
    // 衍射：a/λ 小 → 主瓣宽（发散）；a/λ 大 → 主瓣窄（集中）
    await js(`(function(){ var d=document.getElementById('deck').contentDocument; d.querySelectorAll('.slide')[6].scrollIntoView({block:'start'}); })()`);
    await sleep(1200);
    const diff = {};
    for (const cfg of [[30, 6, 'wide'], [12, 90, 'narrow']]) {
      await js(`(function(){ var d=document.getElementById('deck').contentDocument;
        var l=d.getElementById('d-lam'); l.value='${cfg[0]}'; l.dispatchEvent(new Event('input',{bubbles:true}));
        var q=d.getElementById('d-a'); q.value='${cfg[1]}'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(900);
      diff[cfg[2]] = await js(`(function(){ var d=document.getElementById('deck').contentDocument; return { w: d.getElementById('d-width').textContent, lv: d.getElementById('d-level').textContent }; })()`);
    }
    check('物理演示-衍射区分「发散」与「集中」', parseFloat(diff.wide.w) > parseFloat(diff.narrow.w) * 3 && /发散|扩散/.test(diff.wide.lv) && /直线/.test(diff.narrow.lv), JSON.stringify(diff));
    // 页面顺序：力学 → 数据 → 单摆 → 波
    r = await js(`(function(){ var d=document.getElementById('deck').contentDocument; return Array.prototype.map.call(d.querySelectorAll('.slide'), function(s){ return s.getAttribute('data-title')||''; }); })()`);
    check('物理演示-页面顺序(力学→数据→单摆→波)', r.length === 8 && /分解/.test(r[1]) && /实验室/.test(r[2]) && /数据/.test(r[3]) && /单摆/.test(r[4]) && /干涉/.test(r[5]) && /衍射/.test(r[6]) && /结语/.test(r[7]), JSON.stringify(r.map(function(s){return s.slice(0,4);})));
    /* ===== 24. 欢迎页可直接回到「选择领域」引导 ===== */
    r = await js(`(function(){ var b=document.getElementById('welcome-onboard'); return { exists: !!b, text: b ? b.textContent.trim() : null }; })()`);
    check('欢迎页-有「选择领域」入口', r.exists === true && /领域/.test(r.text || ''), JSON.stringify(r));
    r = await js(`(function(){ try { localStorage.setItem('hsp-onboarded','1'); } catch(e) {}
      document.getElementById('welcome-onboard').click();
      var o = document.getElementById('onboard');
      return { shown: !o.classList.contains('hidden'), mark: String(localStorage.getItem('hsp-onboarded')) }; })()`);
    check('欢迎页-点击后重新进入引导并清除已看过标记', r.shown === true && r.mark === 'null', JSON.stringify(r));
    await js(`(function(){ var o=document.getElementById('onboard'); if (o) o.classList.add('hidden'); })()`);
    await js(`localStorage.removeItem('hsp-onboarded')`);
    r = await js(`(function(){ var d = HSP.ai; var sel = document.getElementById('set-maxtokens'); return { sel: !!sel, opts: sel ? sel.options.length : 0, dv: sel && sel.value }; })()`);
    check('AI-max_tokens 选项存在(默认16384)', r.sel && r.opts === 3 && r.dv === '16384', JSON.stringify(r));
    r = await js(`(function(){ try { var s = JSON.parse(localStorage.getItem('hsp-settings') || '{}'); return { has: ('maxTokens' in s), v: s.maxTokens }; } catch(e){ return { err: e.message }; } })()`);
    check('AI-max_tokens 默认写入设置', r.has === false || r.v === 16384, JSON.stringify(r));
    /* ===== 25. AI：风格池 + 调用可靠性 ===== */
    r = await js(`(function(){ var s = HSP.ai && HSP.ai.styles; return { n: s ? s.length : 0, rnd: !!(HSP.ai && HSP.ai.pickRandomStyle), find: !!(HSP.ai && HSP.ai.findStyle) }; })()`);
    check('AI-风格池存在(≥8种 + 随机选择)', r.n >= 8 && r.rnd && r.find, JSON.stringify(r));
    r = await js(`(function(){ var sys = HSP.ai.buildSystem('new', { id: 'minimal', name: '极简留白', desc: '大面积白底' }); return { hasName: sys.indexOf('极简留白') >= 0, hasDesc: sys.indexOf('大面积白底') >= 0 }; })()`);
    check('AI-指定风格会注入系统提示词', r.hasName && r.hasDesc, JSON.stringify(r));
    r = await js(`(function(){ var sel = document.getElementById('ai-style'); return { exists: !!sel, opts: sel ? sel.options.length : 0 }; })()`);
    check('AI-风格下拉已填充(≥9 个选项)', r.exists && r.opts >= 9, JSON.stringify(r));
    r = await js(`(function(){ return { p: !!document.getElementById('set-proxy'), save: !!document.getElementById('set-proxy-save') }; })()`);
    check('AI-网络代理设置入口存在', r.p && r.save, JSON.stringify(r));
    /* ===== 19. 首启引导（选择行业）与多套示例 ===== */
    await js(`(function(){ var o=document.getElementById('onboard'); o.classList.remove('hidden'); })()`);
    await js(`localStorage.removeItem('hsp-onboarded')`);
    r = await js(`(function(){ var o=document.getElementById('onboard'); return { exists:!!o, cards:document.querySelectorAll('.ob-card').length, decks:Array.prototype.map.call(document.querySelectorAll('.ob-card'), function(b){return b.getAttribute('data-deck');}), skip:!!document.getElementById('ob-skip') }; })()`);
    check('首启引导-行业选择存在', r.exists && r.cards === 4 && r.decks.join(',') === 'physics,math,business,tour' && r.skip, JSON.stringify(r));
    await js(`document.querySelector('.ob-card[data-deck="physics"]').click()`);
    await sleep(2400);
    r = await js(`(function(){ var d=HSP.player.doc(); return { total:HSP.state.total, title:d.title, notes:HSP.player.getNotes(1)||'', hidden:document.getElementById('onboard').classList.contains('hidden'), marked:localStorage.getItem('hsp-onboarded') }; })()`);
    check('首启引导-选物理后加载对应演示', r.hidden === true && r.marked === '1' && r.total === 8, JSON.stringify({ total: r.total, title: r.title, marked: r.marked }));
    check('示例-演讲者备注可读', (r.notes || '').length > 8, 'notes=' + (r.notes || '').slice(0, 18));
    // 四套示例都能加载（页数符合预期）
    const decks = { math: 6, business: 6, tour: 9 };
    for (const dk of Object.keys(decks)) {
      await js(`(function(){ HSP.loadSampleFile('${dk}'); })()`);
      await sleep(2400);
      r = await js(`({ total: HSP.state.total, title: HSP.player.doc().title, notes: (HSP.player.getNotes(0)||'').length })`);
      check('示例-' + dk + ' 可加载', r.total === decks[dk] && r.notes > 5, JSON.stringify({ total: r.total, expect: decks[dk], title: r.title }));
    }
    // 界面图标已同步为应用图标
    r = await js(`(function(){ var b=document.querySelector('.brand-mark img'), w=document.querySelector('.welcome-logo img'); return { brand: b?b.getAttribute('src'):null, welcome: w?w.getAttribute('src'):null, loaded: b? (b.complete && b.naturalWidth>0) : false }; })()`);
    check('界面图标-已同步为应用图标', /icons\/icon-/.test(r.brand || '') && /icons\/icon-/.test(r.welcome || '') && r.loaded === true, JSON.stringify(r));
    const fails = results.filter((x) => x.startsWith('FAIL')).length;
    log('=== 结果: ' + (results.length - fails) + '/' + results.length + ' 通过 ===');
    app.exit(fails ? 1 : 0);
  } catch (e) {
    log('EXC: ' + (e && e.stack ? e.stack : e));
    app.exit(1);
  }
});

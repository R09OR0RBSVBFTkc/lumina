/* 标注引擎：画笔 / 荧光笔 / 激光笔 / 橡皮擦 / 撤销 / 清空。
   笔迹以「归一化坐标(0~1)」存储，可在不同窗口(控制台/投影)间一致缩放。 */
window.HSP = window.HSP || {};
HSP.annotate = (function () {
  var surfaces = [];                 // {name, canvas, laserCanvas, dot, laser:{trail:[],down:false,running:false}}
  var active = {};                   // pid -> stroke
  var tool = 'cursor', color = '#ff2d55', size = 4;

  function addSurface(name, canvas, laserCanvas, dot) {
    var s = { name: name, canvas: canvas, laserCanvas: laserCanvas, dot: dot, laser: { trail: [], down: false, running: false } };
    surfaces.push(s);
    bind(s);
    return s;
  }
  function setTool(t) {
    tool = t;
    if (t === 'cursor') surfaces.forEach(hideDot);
  }
  function setColor(c) { color = c; }
  function setSize(z) { size = z; }
  function cur() { return HSP.state.current | 0; }
  function strokes() {
    var a = HSP.state.annotations;
    if (!a[cur()]) a[cur()] = [];
    return a[cur()];
  }

  function npos(surface, e) {
    var r = surface.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  function bind(surface) {
    var c = surface.canvas;
    if (!c) return;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', function (e) {
      if (tool === 'cursor') return;
      try { c.setPointerCapture(e.pointerId); } catch (err) {}
      updateDot(surface, e);
      down(surface, e);
    });
    c.addEventListener('pointermove', function (e) { updateDot(surface, e); move(surface, e); });
    c.addEventListener('pointerup', function (e) { up(surface, e); });
    c.addEventListener('pointercancel', function (e) { up(surface, e); });
    c.addEventListener('pointerenter', function (e) { if (tool !== 'cursor') updateDot(surface, e); });
    c.addEventListener('pointerleave', function () { if (!surface.laser.down) hideDot(surface); });
  }

  /* 落笔位置光点：画笔/荧光笔/橡皮显示当前颜色光点，激光笔显示红色光点 */
  function updateDot(surface, e) {
    if (tool === 'cursor') { hideDot(surface); return; }
    var p = npos(surface, e);
    showDotAt(surface, p.x, p.y, false);
  }
  function showDotAt(surface, x, y, asLaser) {
    var dot = surface.dot;
    if (!dot) return;
    dot.classList.remove('hidden');
    dot.style.left = (x * 100) + '%';
    dot.style.top = (y * 100) + '%';
    if (asLaser || tool === 'laser') {
      dot.style.width = '18px'; dot.style.height = '18px';
      dot.style.background = 'radial-gradient(circle,#fff 0%,#ff2d55 45%,rgba(255,45,85,0) 70%)';
      dot.style.boxShadow = '0 0 18px 6px rgba(255,45,85,.8)';
    } else {
      var dd = Math.max(6, Math.min(44, size * 2));
      var col = tool === 'eraser' ? '#ffffff' : color;
      dot.style.width = dd + 'px'; dot.style.height = dd + 'px';
      dot.style.background = 'radial-gradient(circle,#fff 0%,' + col + ' 60%,rgba(0,0,0,0) 78%)';
      dot.style.boxShadow = '0 0 10px 2px rgba(255,255,255,.45)';
    }
  }

  function down(surface, e) {
    if (tool === 'laser') { laserDown(surface, e); return; }
    var p = npos(surface, e);
    var st = { tool: tool, color: color, size: size, points: [p], pid: e.pointerId };
    active[e.pointerId] = st;
    strokes().push(st);
    render();
    HSP.sync.post({ type: 'draw', action: 'down', x: p.x, y: p.y, pid: e.pointerId, tool: tool, color: color, size: size, slide: cur() });
  }
  function move(surface, e) {
    if (tool === 'laser') { laserMove(surface, e); return; }
    var st = active[e.pointerId]; if (!st) return;
    var p = npos(surface, e);
    st.points.push(p);
    render();
    HSP.sync.post({ type: 'draw', action: 'move', x: p.x, y: p.y, pid: e.pointerId, slide: cur() });
  }
  function up(surface, e) {
    if (tool === 'laser') { laserUp(surface, e); return; }
    var st = active[e.pointerId]; if (!st) return;
    delete active[e.pointerId];
    HSP.sync.post({ type: 'draw', action: 'up', pid: e.pointerId, slide: cur() });
    HSP.sync.post({ type: 'annot-sync', slide: cur(), strokes: strokes() });
  }

  /* 远程绘制（接收方）：把广播来的点应用到本地模型并重绘 */
  function remoteDraw(msg) {
    var k = msg.pid + ':' + msg.slide;
    if (msg.action === 'down') {
      var st = { tool: msg.tool, color: msg.color, size: msg.size, points: [{ x: msg.x, y: msg.y }], pid: k };
      active[k] = st;
      if (!HSP.state.annotations[msg.slide]) HSP.state.annotations[msg.slide] = [];
      HSP.state.annotations[msg.slide].push(st);
      render();
    } else if (msg.action === 'move') {
      var st2 = active[k];
      if (st2) { st2.points.push({ x: msg.x, y: msg.y }); render(); }
    } else if (msg.action === 'up') {
      delete active[k];
    }
  }
  function remoteSync(msg) {
    if (msg.slide != null) {
      HSP.state.annotations[msg.slide] = msg.strokes || [];
      if (msg.slide === cur()) render();
    }
  }

  /* ---------- 渲染（节流：16ms 内合并高频重绘，首次同步执行） ---------- */
  var lastRender = 0, renderTimer = 0;
  function render() {
    var now = Date.now();
    if (now - lastRender >= 16) {
      lastRender = now;
      surfaces.forEach(drawSurface);
      return;
    }
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = 0;
      lastRender = Date.now();
      surfaces.forEach(drawSurface);
    }, 16);
  }
  function drawSurface(s) {
    if (!s.canvas) return;
    var c = s.canvas, ctx = c.getContext('2d');
    var w = c.clientWidth || c.width, h = c.clientHeight || c.height;
    var dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    strokes().forEach(function (st) { drawStroke(ctx, st, w, h); });
  }
  function drawStroke(ctx, st, w, h) {
    if (!st.points || !st.points.length) return;
    ctx.save();
    ctx.globalCompositeOperation = st.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = st.tool === 'highlighter' ? 0.33 : 1;
    ctx.strokeStyle = st.color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = st.tool === 'highlighter' ? (st.size * 3) : st.tool === 'eraser' ? (st.size * 4) : st.size;
    ctx.beginPath();
    st.points.forEach(function (p, i) {
      var x = p.x * w, y = p.y * h;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  function undo() {
    var s = strokes(); s.pop(); render();
    HSP.sync.post({ type: 'annot-sync', slide: cur(), strokes: s });
  }
  function clear() {
    HSP.state.annotations[cur()] = [];
    render();
    HSP.sync.post({ type: 'annot-sync', slide: cur(), strokes: [] });
  }
  function onSlideChange() { render(); }

  /* ---------- 激光笔（荧光轨迹，自动淡出） ---------- */
  function laserDown(surface, e) {
    var p = npos(surface, e);
    surface.laser.down = true;
    laserPoint(surface, p.x, p.y);
    HSP.sync.post({ type: 'laser', x: p.x, y: p.y, down: true });
  }
  function laserMove(surface, e) {
    if (!surface.laser.down) return;
    var p = npos(surface, e);
    laserPoint(surface, p.x, p.y);
    HSP.sync.post({ type: 'laser', x: p.x, y: p.y, down: true });
  }
  function laserUp(surface) {
    surface.laser.down = false;
    hideDot(surface);
    HSP.sync.post({ type: 'laser', off: true });
  }
  function laserPoint(surface, x, y) {
    showDotAt(surface, x, y, true);
    if (surface.laserCanvas) {
      surface.laser.trail.push({ x: x, y: y, t: Date.now() });
      surface.laser.trail = surface.laser.trail.filter(function (p) { return Date.now() - p.t < 1200; });
      startLaserLoop(surface);
    }
  }
  function hideDot(surface) { if (surface.dot) surface.dot.classList.add('hidden'); }

  function startLaserLoop(surface) {
    if (surface.laser.running) return;
    surface.laser.running = true;
    (function loop() {
      var lc = surface.laserCanvas;
      if (!lc) { surface.laser.running = false; return; }
      var ctx = lc.getContext('2d');
      var w = lc.clientWidth || lc.width, h = lc.clientHeight || lc.height;
      var dpr = window.devicePixelRatio || 1;
      if (lc.width !== Math.round(w * dpr) || lc.height !== Math.round(h * dpr)) {
        lc.width = Math.round(w * dpr); lc.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var now = Date.now();
      surface.laser.trail = surface.laser.trail.filter(function (p) { return now - p.t < 1200; });
      if (surface.laser.trail.length > 1) {
        for (var i = 1; i < surface.laser.trail.length; i++) {
          var p0 = surface.laser.trail[i - 1], p1 = surface.laser.trail[i];
          var age = 1 - (now - p1.t) / 1200;
          if (age <= 0) continue;
          ctx.globalAlpha = Math.max(0, age);
          ctx.strokeStyle = '#ff2d55';
          ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 5;
          ctx.shadowColor = 'rgba(255,45,85,0.9)'; ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.moveTo(p0.x * w, p0.y * h);
          ctx.lineTo(p1.x * w, p1.y * h);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        requestAnimationFrame(loop);
      } else {
        ctx.clearRect(0, 0, w, h);
        surface.laser.running = false;
        if (!surface.laser.down) hideDot(surface);
      }
    })();
  }

  function remoteLaser(msg) {
    var surface = surfaces[0];
    if (!surface) return;
    if (msg.off) { hideDot(surface); return; }
    laserPoint(surface, msg.x, msg.y);
  }

  window.addEventListener('resize', function () { render(); });
  // 翻页时重新渲染当前页的笔迹
  HSP.events.on('slidechange', function () { render(); });

  return {
    addSurface: addSurface, setTool: setTool, setColor: setColor, setSize: setSize,
    undo: undo, clear: clear, onSlideChange: onSlideChange, render: render,
    remoteDraw: remoteDraw, remoteSync: remoteSync, remoteLaser: remoteLaser
  };
})();

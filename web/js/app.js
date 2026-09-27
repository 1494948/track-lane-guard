/*
 * app.js —— 相机采集、状态机、界面渲染
 */
(function (global) {
  'use strict';

  var TLG = global.TLG;
  var cv = TLG.cv;
  var fb = TLG.feedback;

  var DEFAULTS = {
    hueCenter: 4,        // 跑道红色色相中心（OpenCV 尺度 0-180）
    hueWidth: 16,        // 色相容差
    satMin: 55,          // 最小饱和度
    valMin: 45,          // 最小亮度
    lineSatMax: 80,      // 分道线：最大饱和度
    lineValMin: 170,     // 分道线：最小亮度
    bandTop: 0.50,       // 检测带上边界（画面高度比例）
    bandBottom: 0.92,    // 检测带下边界
    minCoverage: 0.06,   // 低于该红色占比判定为"未检测到跑道"
    caution: 0.18,       // 注意阈值 |p-0.5|
    danger: 0.34,        // 警告阈值 |p-0.5|
    fps: 20,
    volume: 0.8,
    tts: true,
    vibrate: true,
    mirror: false,
    debug: false
  };

  var cfg = loadCfg();
  var running = false;
  var stream = null;
  var video = null;
  var workCanvas, workCtx, viewCanvas, viewCtx, maskCanvas, maskCtx;
  var lastTs = 0, acc = 0;
  var pSmooth = 0.5;
  var level = 0, dir = 0;
  var lostFrames = 0, okFrames = 0;
  var detected = false;
  var fpsMeter = 0, fpsCount = 0, fpsShown = 0;
  var fpsText = '待启动', infoExtra = '';
  var lastResult = null;
  var wakeLock = null;
  var pulsePhase = 0;

  /* ---------- 配置持久化 ---------- */

  function loadCfg() {
    var c = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) c[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem('tlg.settings');
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in saved) if (saved.hasOwnProperty(j)) c[j] = saved[j];
      }
    } catch (e) { /* 忽略 */ }
    return c;
  }

  function saveCfg() {
    try { localStorage.setItem('tlg.settings', JSON.stringify(cfg)); } catch (e) { /* 忽略 */ }
  }

  function applyCfg() {
    fb.setConfig({ volume: cfg.volume, ttsEnabled: cfg.tts, vibrateEnabled: cfg.vibrate });
  }

  /* ---------- DOM ---------- */

  var el = {};
  function $(id) { return document.getElementById(id); }

  function initDom() {
    el.video = $('video');
    el.view = $('view');
    el.mask = $('mask');
    el.maskWrap = $('maskWrap');
    el.status = $('status');
    el.state = $('stateText');
    el.meta = $('meta');
    el.btnStart = $('btnStart');
    el.btnStop = $('btnStop');
    el.btnSettings = $('btnSettings');
    el.btnCalib = $('btnCalib');
    el.panel = $('panel');
    el.btnClosePanel = $('btnClosePanel');
    el.btnReset = $('btnReset');
    el.btnTestL = $('btnTestL');
    el.btnTestR = $('btnTestR');
    el.stage = $('stage');
    el.hint = $('hint');
    el.calibTip = $('calibTip');
    el.settingsBody = $('settingsBody');

    workCanvas = document.createElement('canvas');
    workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    viewCanvas = el.view;
    viewCtx = viewCanvas.getContext('2d');
    maskCanvas = el.mask;
    maskCtx = maskCanvas.getContext('2d');
  }

  /* ---------- 设置面板 ---------- */

  var SLIDERS = [
    { key: 'hueCenter', label: '跑道色相中心', min: 0, max: 179, step: 1 },
    { key: 'hueWidth', label: '色相容差', min: 5, max: 45, step: 1 },
    { key: 'satMin', label: '最小饱和度', min: 0, max: 200, step: 5 },
    { key: 'valMin', label: '最小亮度', min: 0, max: 200, step: 5 },
    { key: 'lineSatMax', label: '分道线最大饱和度', min: 20, max: 140, step: 5 },
    { key: 'lineValMin', label: '分道线最小亮度', min: 100, max: 255, step: 5 },
    { key: 'bandTop', label: '检测带上边界', min: 0.20, max: 0.85, step: 0.02, fmt: pct },
    { key: 'bandBottom', label: '检测带下边界', min: 0.35, max: 1.00, step: 0.02, fmt: pct },
    { key: 'caution', label: '「注意」阈值', min: 0.08, max: 0.40, step: 0.01, fmt: pct },
    { key: 'danger', label: '「警告」阈值', min: 0.15, max: 0.50, step: 0.01, fmt: pct },
    { key: 'fps', label: '处理帧率', min: 5, max: 30, step: 1, suffix: ' fps' },
    { key: 'volume', label: '提示音量', min: 0, max: 1, step: 0.05, fmt: pct }
  ];

  var TOGGLES = [
    { key: 'tts', label: '语音播报「往左/往右」' },
    { key: 'vibrate', label: '震动提醒' },
    { key: 'mirror', label: '画面左右镜像' },
    { key: 'debug', label: '显示识别调试图' }
  ];

  function pct(v) { return Math.round(v * 100) + '%'; }

  function buildSettings() {
    var html = '';
    SLIDERS.forEach(function (s) {
      html += '<div class="row"><div class="rowHead"><span>' + s.label +
        '</span><b id="val_' + s.key + '"></b></div>' +
        '<input type="range" data-key="' + s.key + '" min="' + s.min + '" max="' + s.max +
        '" step="' + s.step + '" value="' + cfg[s.key] + '"></div>';
    });
    TOGGLES.forEach(function (t) {
      html += '<label class="chk"><input type="checkbox" data-key="' + t.key + '"' +
        (cfg[t.key] ? ' checked' : '') + '><span>' + t.label + '</span></label>';
    });
    el.settingsBody.innerHTML = html;

    function refresh(key) {
      var s = null;
      for (var i = 0; i < SLIDERS.length; i++) if (SLIDERS[i].key === key) s = SLIDERS[i];
      if (!s) return;
      var node = $('val_' + key);
      if (node) {
        node.textContent = s.fmt ? s.fmt(cfg[key]) : (cfg[key] + (s.suffix || ''));
      }
    }
    SLIDERS.forEach(function (s) { refresh(s.key); });

    el.settingsBody.querySelectorAll('input[type=range]').forEach(function (input) {
      input.addEventListener('input', function () {
        cfg[input.dataset.key] = parseFloat(input.value);
        refresh(input.dataset.key);
        applyCfg();
        saveCfg();
        syncDebugVisibility();
      });
    });
    el.settingsBody.querySelectorAll('input[type=checkbox]').forEach(function (input) {
      input.addEventListener('change', function () {
        cfg[input.dataset.key] = input.checked;
        applyCfg();
        saveCfg();
        syncDebugVisibility();
      });
    });
  }

  function syncDebugVisibility() {
    el.maskWrap.style.display = cfg.debug ? 'block' : 'none';
  }

  /* ---------- 相机 ---------- */

  async function start() {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setHint('当前环境不支持相机访问。Android App 内可用；浏览器需通过 HTTPS 打开。');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (e) {
      setHint('无法打开相机：' + (e && e.name ? e.name : e) +
        '。请确认已授予相机权限，并在 HTTPS 环境下使用。');
      return;
    }

    video = el.video;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* 部分环境需要用户手势 */ }

    await new Promise(function (res) {
      if (video.videoWidth) return res();
      video.onloadedmetadata = function () { res(); };
    });

    var vw = video.videoWidth || 1280;
    var vh = video.videoHeight || 720;
    viewCanvas.width = 640;
    viewCanvas.height = Math.round(640 * vh / vw);
    workCanvas.width = 192;
    workCanvas.height = Math.round(192 * vh / vw);
    maskCanvas.width = 192;
    maskCanvas.height = Math.round(192 * vh / vw);

    fb.init({ volume: cfg.volume, ttsEnabled: cfg.tts, vibrateEnabled: cfg.vibrate });
    fb.chirp(true);

    running = true;
    detected = false;
    lostFrames = 0;
    okFrames = 0;
    pSmooth = 0.5;
    level = 0;
    dir = 0;

    el.btnStart.disabled = true;
    el.btnStop.disabled = false;
    el.hint.style.display = 'none';
    requestWakeLock();
    syncDebugVisibility();
    requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    detected = false;
    pSmooth = 0.5;
    level = 0;
    dir = 0;
    fpsText = '待启动';
    infoExtra = '';
    fb.stop();
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
    setStatus(0, 0, null);
    releaseWakeLock();
  }

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* 不支持则忽略，App 内已用 FLAG_KEEP_SCREEN_ON 兜底 */ }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* noop */ }
    wakeLock = null;
  }

  /* ---------- 主循环 ---------- */

  function loop(ts) {
    if (!running) return;
    requestAnimationFrame(loop);

    if (!lastTs) lastTs = ts;
    var dt = ts - lastTs;
    lastTs = ts;
    acc += dt;
    var interval = 1000 / cfg.fps;
    if (acc < interval) return;
    acc = Math.min(acc - interval, interval * 3);

    var t0 = performance.now();
    step();
    var cost = performance.now() - t0;

    fpsCount++;
    if (ts - fpsMeter > 1000) {
      fpsShown = Math.round(fpsCount * 1000 / (ts - fpsMeter));
      fpsMeter = ts;
      fpsCount = 0;
    }
    fpsText = '处理 ' + fpsShown + ' fps · 单帧 ' + cost.toFixed(1) + ' ms';
    updateMeta();
  }

  function updateMeta() {
    el.meta.textContent = fpsText + infoExtra;
  }

  function step() {
    var W = workCanvas.width, H = workCanvas.height;

    workCtx.save();
    if (cfg.mirror) {
      workCtx.translate(W, 0);
      workCtx.scale(-1, 1);
    }
    workCtx.drawImage(video, 0, 0, W, H);
    workCtx.restore();

    var imgData;
    try {
      imgData = workCtx.getImageData(0, 0, W, H);
    } catch (e) {
      return; // 极端情况下画布被污染
    }

    var res = cv.analyze(imgData, cfg);
    lastResult = res;

    // --- 检测稳定性 ---
    if (res.ok) { okFrames++; lostFrames = 0; } else { lostFrames++; okFrames = 0; }
    if (okFrames >= 3) detected = true;
    if (lostFrames >= 6) detected = false;

    // --- 位置平滑与状态判定（含迟滞，防止抖动误报）---
    if (res.ok) {
      pSmooth = pSmooth * 0.6 + res.p * 0.4;
    }
    var d = pSmooth - 0.5;
    var ad = Math.abs(d);

    var newLevel = 0, newDir = 0;
    if (detected) {
      var cThr = level >= 1 ? cfg.caution - 0.04 : cfg.caution;
      var dThr = level >= 2 ? cfg.danger - 0.06 : cfg.danger;
      if (ad >= dThr) newLevel = 2;
      else if (ad >= cThr) newLevel = 1;
      if (newLevel > 0) newDir = d > 0 ? -1 : 1; // p 偏右 => 应往左
    }
    level = newLevel;
    dir = newDir;
    fb.setState(level, dir);

    setStatus(level, dir, res);
    render(res);
    if (cfg.debug) cv.renderMaskImage(maskCtx, res);
  }

  /* ---------- 渲染 ---------- */

  function render(res) {
    var W = viewCanvas.width, H = viewCanvas.height;
    var ctx = viewCtx;

    ctx.save();
    if (cfg.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();

    var wW = workCanvas.width, wH = workCanvas.height;
    var sx = W / wW, sy = H / wH;

    pulsePhase = (pulsePhase + 0.12) % (Math.PI * 2);

    if (res && res.ok) {
      var y0 = res.bandY0 * sy, y1 = res.bandY1 * sy;
      var lx = res.left * sx, rx = res.right * sx;
      var cx = (res.left + res.right) / 2 * sx;

      // 走廊
      ctx.fillStyle = 'rgba(80, 220, 140, 0.16)';
      ctx.fillRect(lx, y0, rx - lx, y1 - y0);

      // 边界线
      ctx.strokeStyle = 'rgba(90, 240, 160, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(lx, y0); ctx.lineTo(lx, y1);
      ctx.moveTo(rx, y0); ctx.lineTo(rx, y1);
      ctx.stroke();

      // 跑道中心
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, y0); ctx.lineTo(cx, y1);
      ctx.stroke();
      ctx.setLineDash([]);

      // 检测带提示框
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, y0, W, y1 - y0);
    }

    // 画面中心（使用者朝向）
    ctx.strokeStyle = 'rgba(255,214,0,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2, H * 0.42);
    ctx.lineTo(W / 2, H * 0.98);
    ctx.stroke();

    // 位置条
    var barW = W * 0.62, barX = (W - barW) / 2, barY = H - 26, barH = 10;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = 'rgba(80,220,140,0.55)';
    ctx.fillRect(barX + barW * 0.2, barY, barW * 0.6, barH);
    var px = barX + Math.max(0, Math.min(1, pSmooth)) * barW;
    ctx.fillStyle = level === 2 ? '#ff3b30' : (level === 1 ? '#ffb020' : '#ffffff');
    ctx.fillRect(px - 3, barY - 4, 6, barH + 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.strokeRect(barX, barY, barW, barH);

    // 方向指示（大字 + 箭头）
    if (level > 0) {
      var alpha = 0.55 + 0.45 * Math.abs(Math.sin(pulsePhase));
      var color = level === 2 ? '255,59,48' : '255,176,32';
      var cxp = W / 2, cyp = H * 0.30;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(' + color + ',0.22)';
      if (dir < 0) ctx.fillRect(0, 0, W * 0.30, H);
      else ctx.fillRect(W * 0.70, 0, W * 0.30, H);

      ctx.translate(cxp, cyp);
      ctx.fillStyle = 'rgb(' + color + ')';
      ctx.beginPath();
      var s = Math.min(W, H) * 0.30;
      if (dir < 0) { // 向左箭头
        ctx.moveTo(-s * 0.55, 0);
        ctx.lineTo(s * 0.15, -s * 0.55);
        ctx.lineTo(s * 0.15, -s * 0.20);
        ctx.lineTo(s * 0.75, -s * 0.20);
        ctx.lineTo(s * 0.75, s * 0.20);
        ctx.lineTo(s * 0.15, s * 0.20);
        ctx.lineTo(s * 0.15, s * 0.55);
      } else {
        ctx.moveTo(s * 0.55, 0);
        ctx.lineTo(-s * 0.15, -s * 0.55);
        ctx.lineTo(-s * 0.15, -s * 0.20);
        ctx.lineTo(-s * 0.75, -s * 0.20);
        ctx.lineTo(-s * 0.75, s * 0.20);
        ctx.lineTo(-s * 0.15, s * 0.20);
        ctx.lineTo(-s * 0.15, s * 0.55);
      }
      ctx.closePath();
      ctx.fill();

      ctx.font = 'bold ' + Math.round(Math.min(W, H) * 0.20) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(dir < 0 ? '往左' : '往右', 0, s * 0.95);
      ctx.restore();
    }
  }

  function setStatus(level, dir, res) {
    var cls = 'ok', text = '安全';
    if (!detected) { cls = 'lost'; text = '未检测到跑道'; }
    else if (level === 2) { cls = 'danger'; text = '即将跑出 · ' + (dir < 0 ? '往左' : '往右'); }
    else if (level === 1) { cls = 'warn'; text = '注意偏出 · ' + (dir < 0 ? '往左' : '往右'); }

    el.status.className = 'status ' + cls;
    el.state.textContent = text;

    infoExtra = '';
    if (res) {
      infoExtra = ' · ' + (res.mode === 'lines' ? '分道线锁定' : (res.mode === 'edges' ? '跑道边界' : '无')) +
        ' · 偏离 ' + ((pSmooth - 0.5) * 200).toFixed(0) + '%' +
        ' · 红色占比 ' + (res.coverage * 100).toFixed(0) + '%';
    }
    updateMeta();
    el.status.dataset.level = String(level);
    document.body.dataset.level = detected ? String(level) : 'lost';
  }

  function setHint(msg) {
    el.hint.textContent = msg;
    el.hint.style.display = 'block';
  }

  /* ---------- 标定 ---------- */

  function calibrateAt(clientX, clientY) {
    if (!running) {
      setHint('请先点「开始检测」，让画面出现跑道后再标定。');
      return;
    }
    var rect = viewCanvas.getBoundingClientRect();
    var nx = (clientX - rect.left) / rect.width;
    var ny = (clientY - rect.top) / rect.height;
    if (cfg.mirror) nx = 1 - nx;
    var px = Math.round(nx * workCanvas.width);
    var py = Math.round(ny * workCanvas.height);

    var W = workCanvas.width, H = workCanvas.height;
    var d = workCtx.getImageData(0, 0, W, H).data;
    var hues = [], sats = [], vals = [];
    var rad = Math.max(3, Math.round(W * 0.02));
    for (var y = py - rad; y <= py + rad; y++) {
      for (var x = px - rad; x <= px + rad; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        var i = (y * W + x) * 4;
        var r = d[i], g = d[i + 1], b = d[i + 2];
        if (r < 40) continue;
        var hsv = cv.rgbToHsv(r, g, b);
        hues.push(hsv[0]); sats.push(hsv[1]); vals.push(hsv[2]);
      }
    }
    if (hues.length < 5) {
      setHint('取样点颜色过暗，请点击跑道上明亮的位置重新标定。');
      return;
    }
    hues.sort(function (a, b) { return a - b; });
    sats.sort(function (a, b) { return a - b; });
    vals.sort(function (a, b) { return a - b; });
    function median(arr) { return arr[Math.floor(arr.length / 2)]; }

    var mh = median(hues), ms = median(sats), mv = median(vals);
    cfg.hueCenter = Math.round(mh);
    cfg.hueWidth = 18;
    cfg.satMin = Math.max(20, Math.min(150, Math.round(ms * 0.6)));
    cfg.valMin = Math.max(20, Math.min(150, Math.round(mv * 0.5)));
    saveCfg();
    buildSettings();
    setHint('已标定：色相 ' + cfg.hueCenter + ' / 饱和度下限 ' + cfg.satMin +
      ' / 亮度下限 ' + cfg.valMin + '。如仍识别不稳，可在设置里微调。');
  }

  /* ---------- 事件绑定 ---------- */

  function bind() {
    el.btnStart.addEventListener('click', start);
    el.btnStop.addEventListener('click', stop);
    el.btnSettings.addEventListener('click', function () {
      el.panel.classList.toggle('open');
    });
    el.btnClosePanel.addEventListener('click', function () {
      el.panel.classList.remove('open');
    });
    el.btnReset.addEventListener('click', function () {
      cfg = {};
      for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) cfg[k] = DEFAULTS[k];
      saveCfg();
      applyCfg();
      buildSettings();
      syncDebugVisibility();
    });
    el.btnTestL.addEventListener('click', function () { fb.init({ volume: cfg.volume }); fb.test(-1); });
    el.btnTestR.addEventListener('click', function () { fb.init({ volume: cfg.volume }); fb.test(1); });

    el.btnCalib.addEventListener('click', function () {
      el.calibTip.classList.toggle('show');
      el.btnCalib.classList.toggle('active');
    });

    el.view.addEventListener('click', function (e) {
      if (!el.calibTip.classList.contains('show')) return;
      calibrateAt(e.clientX, e.clientY);
      el.calibTip.classList.remove('show');
      el.btnCalib.classList.remove('active');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden && running) { fb.stop(); }
      else if (!document.hidden && running) { requestWakeLock(); }
    });

    window.addEventListener('orientationchange', function () {
      setTimeout(function () { if (running && video && video.videoWidth) { /* 尺寸保持，无需处理 */ } }, 300);
    });
  }

  /* ---------- 启动 ---------- */

  function boot() {
    initDom();
    buildSettings();
    bind();
    applyCfg();
    syncDebugVisibility();
    fpsText = '待启动';
    setStatus(0, 0, null);

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 忽略 */ });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

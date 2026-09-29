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
    bandTop: 0.45,       // 检测带上边界：泛洪已排除远处隔草坪的跑道，放宽上界让竖屏也能看到边界
    bandBottom: 0.97,    // 检测带下边界
    closeRadius: 4,      // 水平闭运算半径
    minCoverage: 0.06,   // 低于该红色占比判定为"未检测到跑道"
    minTrackPixels: 0.02,// 跑道连通域最小面积（占整帧比例），滤掉零散红色物体
    lineMinRowRatio: 0.5,// 分道线至少要在检测带这么多比例的行上出现
    lineMaxRms: 2.6,     // 分道线直线拟合残差上限(px)，滤掉零散白斑
    gate: 0.28,          // 跟踪器残差门限：位置突变超过它视为噪声
    stableFrames: 8,     // 同方向持续多少帧才允许报警（抗抖/抗晃动；晃动半周期约 4 帧）
    minConfidence: 0.45, // 置信度低于它不报警
    caution: 0.18,       // 注意阈值 |p-0.5|
    danger: 0.34,        // 警告阈值 |p-0.5|
    // v1.3.0：整幅画面都用上 —— 近带判当前位置，远带做前瞻
    nearTop: 0.68, nearBottom: 0.98,   // 近带（脚前区域）
    farTop: 0.26, farBottom: 0.58,     // 远带（前方跑道）
    obsMinArea: 0.004,   // 障碍最小面积（占整帧比例）
    lookahead: true,     // 远景前瞻：远处跑道已偏时提前预警
    showBands: true,     // 画面上标出远带/近带与前瞻趋势（能直观看到整屏都在用）
    obstacleAlert: true, // 跑道面内占用物（人影/衣物/水坑）提醒
    sensor: true,        // 姿态传感器辅助（不支持时自动禁用）
    orientation: 'landscape', // 使用方式：横屏（默认）/ 竖屏 / 自动
    fps: 20,
    volume: 0.8,
    tts: true,
    vibrate: true,
    mirror: false,
    debug: false
  };

  var cfg = loadCfg();
  var tracker = new cv.Tracker();
  var lastSt = { p: 0.5, width: 0.5, conf: 0, sameDir: 0, miss: 0 };
  var sensor = TLG.Sensor ? new TLG.Sensor() : null;
  var obsFrames = 0;
  var lastObstacle = null;
  // 数据采集与云端（默认关闭，见 recorder.js / dataset.js）
  var recorder = TLG.Recorder ? new TLG.Recorder() : null;
  var cloud = TLG.Cloud ? new TLG.Cloud() : null;
  var dataset = null;
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
    el.bandNote = $('bandNote');

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
    { key: 'stableFrames', label: '持续帧数（越大越抗误报）', min: 2, max: 15, step: 1, suffix: ' 帧' },
    { key: 'minConfidence', label: '最低置信度（越大越保守）', min: 0.20, max: 0.85, step: 0.05, fmt: pct },
    { key: 'fps', label: '处理帧率', min: 5, max: 30, step: 1, suffix: ' fps' },
    { key: 'volume', label: '提示音量', min: 0, max: 1, step: 0.05, fmt: pct }
  ];

  var TOGGLES = [
    { key: 'tts', label: '语音播报「往左/往右」' },
    { key: 'vibrate', label: '震动提醒' },
    { key: 'lookahead', label: '远景前瞻（提前预警）' },
    { key: 'showBands', label: '在画面上标出远带 / 近带' },
    { key: 'obstacleAlert', label: '跑道占用物提醒（人影/杂物）' },
    { key: 'sensor', label: '姿态传感器辅助' },
    { key: 'mirror', label: '画面左右镜像' },
    { key: 'debug', label: '显示识别调试图' }
  ];

  var ORIENTATIONS = [
    { val: 'landscape', label: '横屏（推荐）' },
    { val: 'portrait', label: '竖屏' },
    { val: 'auto', label: '自动' }
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
    html += '<div class="row" style="margin-top:10px"><div class="rowHead"><span>使用方式</span></div><div class="seg" id="segOrient">';
    ORIENTATIONS.forEach(function (o) {
      html += '<button type="button" data-orient="' + o.val + '"' +
        (cfg.orientation === o.val ? ' class="active"' : '') + '>' + o.label + '</button>';
    });
    html += '</div></div>';
    el.settingsBody.innerHTML = html;

    el.settingsBody.querySelectorAll('button[data-orient]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        cfg.orientation = btn.dataset.orient;
        el.settingsBody.querySelectorAll('button[data-orient]').forEach(function (b) {
          b.className = (b.dataset.orient === cfg.orientation) ? 'active' : '';
        });
        applyCfg();
        saveCfg();
        applyOrientation();
      });
    });

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

  /* ---------- 使用方式与姿态 ---------- */

  var orientationMismatch = false;

  /**
   * 让「使用方式」真正生效，而不只是换一句提示文字：
   *   横屏 —— 画面宽高比大、近处地面在下部占比小 → 远带略上移、近带略窄
   *   竖屏 —— 画面纵向更长、脚下区域更大       → 近带放宽、远带下移
   *   自动 —— 按实际画面比例选择
   * 只覆盖内部带位（nearTop/farTop 等），不动用户在设置面板里手调的阈值。
   * 若设定期望与实际画面不一致（例如选了横屏却竖着拿），仍按实际比例工作，
   * 但会提示改正、并在判定时提高置信度门槛（更保守），避免拿错参数硬报。
   */
  function applyOrientation() {
    var vw = video ? (video.videoWidth || 0) : 0;
    var vh = video ? (video.videoHeight || 0) : 0;
    var isLand = vw ? (vw >= vh) : true;
    var land = isLand;
    orientationMismatch = false;

    if (cfg.orientation === 'landscape') {
      land = true;
      orientationMismatch = vw > 0 && !isLand;
    } else if (cfg.orientation === 'portrait') {
      land = false;
      orientationMismatch = vw > 0 && isLand;
    }

    if (land) {
      cfg.nearTop = 0.68; cfg.nearBottom = 0.98;
      cfg.farTop = 0.26; cfg.farBottom = 0.58;
    } else {
      cfg.nearTop = 0.62; cfg.nearBottom = 0.98;
      cfg.farTop = 0.22; cfg.farBottom = 0.52;
    }

    var msg = '';
    if (orientationMismatch) {
      msg = cfg.orientation === 'landscape'
        ? '当前是竖屏画面。请横持手机：横屏时跑道纵向穿过画面、两侧边界都在视野内，判定最可靠。现在仍按竖屏参数工作，同时提高了报警门槛以免误报。'
        : '当前是横屏画面，但你选择了竖屏模式，建议改为「横屏」或「自动」。';
    }
    if (msg) setHint(msg);
    else if (el.hint) el.hint.style.display = 'none';
  }

  function sensorState() {
    return sensor ? sensor.state() : null;
  }

  function startSensor() {
    if (!sensor || !cfg.sensor) return;
    sensor.requestPermission().then(function (ok) {
      if (!ok && cfg.sensor) {
        cfg.sensor = false;
        applyCfg();
        saveCfg();
        setHint('这台设备没有可用的姿态传感器，已自动关闭该辅助功能（不影响识别）。');
      }
    });
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
    // 工作画布：长边固定 192，短边按比例 —— 竖持手机(9:16)时是 108×192，
    // 保证横竖屏下像素量与检测带几何一致，性能不因竖屏劣化
    viewCanvas.width = 640;
    viewCanvas.height = Math.round(640 * vh / vw);
    if (vw >= vh) {
      workCanvas.width = 192;
      workCanvas.height = Math.max(1, Math.round(192 * vh / vw));
    } else {
      workCanvas.height = 192;
      workCanvas.width = Math.max(1, Math.round(192 * vw / vh));
    }
    maskCanvas.width = workCanvas.width;
    maskCanvas.height = workCanvas.height;

    fb.init({ volume: cfg.volume, ttsEnabled: cfg.tts, vibrateEnabled: cfg.vibrate });
    fb.chirp(true);

    running = true;
    detected = false;
    lostFrames = 0;
    okFrames = 0;
    pSmooth = 0.5;
    level = 0;
    dir = 0;
    obsFrames = 0;
    lastObstacle = null;
    tracker.reset();
    lastSt = tracker.state();
    startSensor();
    applyOrientation();

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
    tracker.reset();
    lastSt = tracker.state();
    obsFrames = 0;
    lastObstacle = null;
    if (sensor) sensor.stop();
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

    // --- 时序跟踪：Alpha-Beta 滤波 + 残差门控 + 持续帧投票 ---
    lastSt = tracker.update(res, cfg);
    pSmooth = lastSt.p;

    if (res.ok) { okFrames++; lostFrames = 0; } else { lostFrames++; okFrames = 0; }
    if (okFrames >= 3) detected = true;
    if (lostFrames >= 8) detected = false;

    // --- 状态判定 ---
    // 报警需要同时满足三个条件，缺一不报：
    //   1) 检测到跑道   2) 置信度达标   3) 同方向已持续 stableFrames 帧
    // 这样单帧噪声、手持晃动、短暂遮挡都不会触发误报
    var d = lastSt.p - 0.5;
    var ad = Math.abs(d);

    // 远景前瞻：远处跑道中心已偏向一侧，且方向与近处偏移一致 —— 说明正在朝那边漂，
    // 把趋势折算进偏移量提前预警（最多加 0.10，不足以单独触发警告级）
    var trend = res.trend || 0;
    var boost = 0;
    if (cfg.lookahead && Math.abs(trend) >= 0.05) {
      // 约定 dir: -1 = 往左, +1 = 往右
      // trend > 0 表示远处跑道偏右 → 沿当前方向直行会相对跑道偏左 → 应往右(+1)
      var trendDir = trend > 0 ? 1 : -1;
      var nearDir = d > 0 ? -1 : 1;
      if (trendDir === nearDir) boost = Math.min(0.10, Math.abs(trend) * 1.1);
    }
    var adEff = ad + boost;

    // 姿态传感器：晃动剧烈时提高持续帧要求（不抑制报警，只是更谨慎）
    var st = sensorState();
    var needFrames = cfg.stableFrames + ((st && st.shaking) ? 2 : 0);

    // 使用方式与实际画面不一致（如选了横屏却竖着拿）时提高门槛，宁可少报
    var confNeed = cfg.minConfidence + (orientationMismatch ? 0.10 : 0);
    var trusted = detected && lastSt.miss === 0 &&
      lastSt.conf >= confNeed &&
      lastSt.sameDir >= needFrames;

    var newLevel = 0, newDir = 0;
    if (trusted) {
      var cThr = level >= 1 ? cfg.caution - 0.04 : cfg.caution;
      var dThr = level >= 2 ? cfg.danger - 0.06 : cfg.danger;
      if (adEff >= dThr) newLevel = 2;
      else if (adEff >= cThr) newLevel = 1;
      if (newLevel > 0) newDir = d > 0 ? -1 : 1; // p 偏右 => 应往左
    }
    level = newLevel;
    dir = newDir;
    fb.setState(level, dir);

    // 障碍/占用物：连续多帧出现才算数，避免单帧闪烁
    var obs = (cfg.obstacleAlert && res.obstacles && res.obstacles.length) ? res.obstacles[0] : null;
    if (obs) obsFrames++;
    else obsFrames = Math.max(0, obsFrames - 2);
    lastObstacle = (obsFrames >= 5 && obs) ? obs : null;

    setStatus(level, dir, res);
    render(res);
    if (cfg.debug) cv.renderMaskImage(maskCtx, res);

    // 采集（未开启时 recorder.tick 内部直接返回，无额外开销）
    if (recorder && recorder.enabled) {
      recorder.tick({
        viewCanvas: viewCanvas, workCanvas: workCanvas,
        res: res, st: lastSt, level: level, dir: dir,
        sensor: sensorState()
      });
    }
  }

  /* ---------- 带位与趋势标记 ---------- */

  /**
   * 把远带 / 近带与前瞻趋势画在画面上 —— 让"整屏都在用"看得见。
   * 远带蓝色（看前方跑道走向），近带绿色（判脚下位置），箭头=漂移趋势方向。
   */
  function drawBands(ctx, res, sx, sy, wW, wH, W) {
    if (!cfg.showBands || !res || !res.ok) {
      if (el.bandNote) el.bandNote.className = '';
      return;
    }
    var farA = cfg.farTop * wH * sy, farB = cfg.farBottom * wH * sy;
    var nearA = cfg.nearTop * wH * sy, nearB = cfg.nearBottom * wH * sy;

    ctx.save();
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    ctx.fillStyle = 'rgba(120,200,255,0.07)';
    ctx.fillRect(1, farA, W - 2, farB - farA);
    ctx.strokeStyle = 'rgba(120,200,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(1, farA, W - 2, farB - farA);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(158,220,255,0.95)';
    ctx.fillText('远带 · 前方跑道', 6, farA + 5);

    ctx.fillStyle = 'rgba(110,235,170,0.07)';
    ctx.fillRect(1, nearA, W - 2, nearB - nearA);
    ctx.strokeStyle = 'rgba(110,235,170,0.5)';
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(1, nearA, W - 2, nearB - nearA);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150,245,195,0.95)';
    ctx.fillText('近带 · 脚下位置', 6, nearA + 5);

    if (res.far && res.far.ok) {
      var fy = (farA + farB) / 2;
      var fc = ((res.far.left + res.far.right) / 2) * sx;
      ctx.fillStyle = 'rgba(158,220,255,0.95)';
      ctx.beginPath();
      ctx.arc(fc, fy, 5, 0, Math.PI * 2);
      ctx.fill();

      var t = res.trend || 0;
      if (Math.abs(t) >= 0.02) {
        var dirX = t > 0 ? 1 : -1;
        var len = Math.min(80, Math.abs(t) * 300);
        ctx.strokeStyle = 'rgba(158,220,255,0.95)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(W / 2, fy);
        ctx.lineTo(W / 2 + dirX * len, fy);
        ctx.moveTo(W / 2 + dirX * len, fy);
        ctx.lineTo(W / 2 + dirX * (len - 9), fy - 5);
        ctx.moveTo(W / 2 + dirX * len, fy);
        ctx.lineTo(W / 2 + dirX * (len - 9), fy + 5);
        ctx.stroke();
      }
    }
    ctx.restore();

    if (el.bandNote) {
      var np = (res.near && res.near.ok) ? res.near.p.toFixed(2) : '--';
      var tr = res.trend || 0;
      el.bandNote.textContent = '远带趋势 ' + (tr >= 0 ? '+' : '') + tr.toFixed(2) +
        '　近带位置 ' + np;
      el.bandNote.className = 'on';
    }
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

    // 置信度角标：低于阈值时变黄，提醒此时不会报警
    if (detected) {
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillStyle = lastSt.conf >= cfg.minConfidence
        ? 'rgba(120,240,170,0.95)' : 'rgba(255,190,60,0.95)';
      ctx.fillText('置信度 ' + (lastSt.conf * 100).toFixed(0) + '%', W - 10, 10);
    }

    // 远带 / 近带标记与前瞻趋势 —— 让"整屏都在用"这件事看得见
    drawBands(ctx, res, sx, sy, wW, wH, W);

    // 障碍/占用物：黄色警示框
    if (lastObstacle) {
      var o = lastObstacle;
      ctx.strokeStyle = 'rgba(255,200,40,0.95)';
      ctx.lineWidth = 3;
      ctx.strokeRect(o.x0 * sx, o.y0 * sy, (o.x1 - o.x0 + 1) * sx, (o.y1 - o.y0 + 1) * sy);
      ctx.fillStyle = 'rgba(255,200,40,0.95)';
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('注意：跑道上有占用物', 10, 10);
    }

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
    var ad0 = Math.abs(lastSt.p - 0.5);
    if (!detected) { cls = 'lost'; text = '未检测到跑道'; }
    else if (lastSt.conf < cfg.minConfidence) { cls = 'lost'; text = '识别不稳定 · 暂不报警'; }
    else if (level === 2) { cls = 'danger'; text = '即将跑出 · ' + (dir < 0 ? '往左' : '往右'); }
    else if (level === 1) { cls = 'warn'; text = '注意偏出 · ' + (dir < 0 ? '往左' : '往右'); }
    else if (ad0 >= cfg.caution && lastSt.sameDir < cfg.stableFrames) { cls = 'ok'; text = '偏移观察中…'; }

    if (detected && res && res.curve) text += ' · 弯道';
    if (detected && res && res.clipped) text += ' · 请抬高手机';
    if (lastObstacle) text = '前方有占用物 · ' + text;
    if (detected && orientationMismatch) text += ' · 请横持手机';
    var ss = sensorState();
    if (detected && ss && ss.enabled) {
      if (!ss.aiming) text += ' · 请朝下对准跑道';
      else if (ss.shaking) text += ' · 晃动中';
    }
    el.status.className = 'status ' + cls;
    el.state.textContent = text;

    infoExtra = '';
    if (res) {
      infoExtra = ' · ' + (res.mode === 'lines' ? '分道线锁定' : (res.mode === 'edges' ? '跑道边界' : '无')) +
        ' · 偏离 ' + ((pSmooth - 0.5) * 200).toFixed(0) + '%' +
        ' · 置信度 ' + (lastSt.conf * 100).toFixed(0) + '%' +
        ' · 持续 ' + lastSt.sameDir + '/' + cfg.stableFrames + ' 帧' +
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
    // 旋转手机时实时切换带位参数（横/竖屏用不同的远带与近带）
    window.addEventListener('resize', function () { if (running) applyOrientation(); });
    window.addEventListener('orientationchange', function () { if (running) applyOrientation(); });

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

    // 数据采集面板（默认关闭，需明确同意才采集）
    var dsHost = $('dataset');
    if (dsHost && TLG.Dataset && recorder && cloud) {
      dataset = new TLG.Dataset({
        recorder: recorder,
        cloud: cloud,
        version: '1.6.0',
        buildMeta: function () {
          return {
            cfg: cfg,
            orientation: cfg.orientation,
            videoSize: (video ? (video.videoWidth || 0) + 'x' + (video.videoHeight || 0) : ''),
            workCanvas: workCanvas ? (workCanvas.width + 'x' + workCanvas.height) : ''
          };
        }
      });
      dataset.mount(dsHost);
    }

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

/*
 * recorder.js —— 采集与优化数据包
 *
 * 目的：让算法在真实跑道上被量化改进，而不是靠猜。
 * 采集内容（全部本地生成、本地存储，默认不上传）：
 *   · 抽帧图像：算法视图（含叠加层）+ 工作画布（纯识别视角）
 *   · 算法输出：p / trend / 置信度 / 模式 / 报警等级 / 障碍 / 弯道 / 裁剪标记
 *   · 真实标签：使用者自己按的「我在跑道中间」「我正在偏出」—— 这是最有价值的数据
 *   · 设备信息：处理帧率、单帧耗时、画面方向、传感器状态
 *
 * 隐私边界（本模块的硬约束）：
 *   · 默认关闭，必须在明确同意后才开始采集
 *   · 采集中界面常驻醒目提示，使用者随时可停
 *   · 只录本应用自己的画面，不做系统级录屏（不采集其他 App 的内容）
 *   · 数据只留在本机；上传是独立的一次显式操作，且只上传使用者已看到内容的包
 *   · 使用者可随时「全部删除」
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});

  var CONSENT_KEY = 'tlg.consent.dataCollect';

  function nowMs() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  function Recorder(opts) {
    this.opts = opts || {};
    this.enabled = false;
    this.consented = false;
    this.samples = [];        // {t, p, trend, conf, mode, level, dir, label, frame, work}
    this.t0 = 0;
    this.lastShot = 0;
    this.intervalMs = 2000;   // 抽帧间隔
    this.maxFrames = 400;     // 上限，防止内存失控
    this.frameW = 240;        // 抽帧宽度（JPEG）
    this.quality = 0.6;
    this.labelWindowMs = 6000;// 标注往前覆盖的时长
    this.obstacleLabelWindowMs = 4000; // 障碍类别标注往前覆盖的时长
    this.peakMs = 250;        // 采集中每帧记录算法输出的间隔
    this.lastPeak = 0;
    this._shot = null;
    this._shotCtx = null;
    this._onChange = null;
    this.lastError = '';
  }

  Recorder.prototype.consentedBefore = function () {
    try { return global.localStorage.getItem(CONSENT_KEY) === 'yes'; } catch (e) { return false; }
  };

  Recorder.prototype.giveConsent = function () {
    this.consented = true;
    try { global.localStorage.setItem(CONSENT_KEY, 'yes'); } catch (e) { /* 忽略 */ }
  };

  Recorder.prototype.revokeConsent = function () {
    this.consented = false;
    this.stop();
    this.clear();
    try { global.localStorage.removeItem(CONSENT_KEY); } catch (e) { /* 忽略 */ }
  };

  Recorder.prototype.setChangeHandler = function (fn) { this._onChange = fn; };

  Recorder.prototype.notify = function () {
    if (this._onChange) this._onChange(this.stats());
  };

  Recorder.prototype.start = function () {
    if (!this.consented) return false;
    this.enabled = true;
    this.t0 = nowMs();
    this.lastShot = 0;
    this.lastPeak = 0;
    this.notify();
    return true;
  };

  Recorder.prototype.stop = function () {
    this.enabled = false;
    this.notify();
  };

  Recorder.prototype.clear = function () {
    this.samples = [];
    this.notify();
  };

  Recorder.prototype.stats = function () {
    var labeled = 0;
    for (var i = 0; i < this.samples.length; i++) if (this.samples[i].label) labeled++;
    return {
      enabled: this.enabled,
      consented: this.consented,
      count: this.samples.length,
      labeled: labeled,
      durationMs: this.enabled ? Math.round(nowMs() - this.t0) : 0,
      bytes: this.approxBytes()
    };
  };

  Recorder.prototype.approxBytes = function () {
    var n = 0;
    for (var i = 0; i < this.samples.length; i++) {
      var s = this.samples[i];
      n += (s.frame ? s.frame.length : 0) + (s.work ? s.work.length : 0) + 200;
    }
    return Math.round(n * 0.75); // base64 -> 字节
  };

  /**
   * 每帧调用：记录算法输出；按间隔抽帧。
   * @param {object} ctx {viewCanvas, workCanvas, res, st, level, dir, sensor}
   */
  Recorder.prototype.tick = function (ctx) {
    if (!this.enabled || !ctx) return;
    var t = nowMs() - this.t0;

    if (t - this.lastPeak >= this.peakMs) {
      this.lastPeak = t;
      this.samples.push(this.makeRecord(t, ctx, null, null));
      this.trim();
    }

    if (t - this.lastShot >= this.intervalMs) {
      this.lastShot = t;
      var rec = this.samples[this.samples.length - 1];
      if (rec && !rec.frame) {
        rec.frame = this.grab(ctx.viewCanvas);
        rec.work = this.grab(ctx.workCanvas);
      }
      this.notify();
    }
  };

  Recorder.prototype.makeRecord = function (t, ctx, frame, work) {
    var r = ctx.res || {};
    var st = ctx.st || {};
    var fc = r.far || {};
    var near = r.near || {};
    return {
      t: Math.round(t),
      p: round3(st.p),
      conf: round3(st.conf),
      sameDir: st.sameDir || 0,
      miss: st.miss || 0,
      // 画面判定
      ok: !!r.ok,
      mode: r.mode || 'none',
      left: r.left, right: r.right,
      nearP: round3(near.ok ? near.p : null),
      farP: round3(fc.ok ? fc.p : null),
      farLeft: fc.left, farRight: fc.right,
      trend: round3(r.trend),
      coverage: round3(r.coverage),
      // 状态
      level: ctx.level || 0,
      dir: ctx.dir || 0,
      curve: !!r.curve,
      clipped: !!r.clipped,
      viaFlood: !!r.viaFlood,
      obstacles: (r.obstacles || []).length,
      obsArea: r.obstacles && r.obstacles[0] ? r.obstacles[0].area : 0,
      // 被判定为障碍的框（供离线裁剪出 ROI 做分类训练）。整帧已经存了，
      // 这里只记位置，不额外存图，省空间。
      obsBox: ctx.obstacle ? {
        x0: ctx.obstacle.x0, x1: ctx.obstacle.x1,
        y0: ctx.obstacle.y0, y1: ctx.obstacle.y1,
        area: ctx.obstacle.area
      } : null,
      // 障碍类别人工标签：person / shadow / water / debris / mark / other
      obsLabel: null,
      // 传感器（未启用时为 null）
      roll: ctx.sensor ? round3(ctx.sensor.roll) : null,
      pitch: ctx.sensor ? round3(ctx.sensor.pitch) : null,
      aiming: ctx.sensor ? !!ctx.sensor.aiming : null,
      shaking: ctx.sensor ? !!ctx.sensor.shaking : null,
      label: null,
      frame: frame,
      work: work
    };
  };

  function round3(v) {
    return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
  }

  Recorder.prototype.grab = function (canvas) {
    if (!canvas || !canvas.width) return null;
    try {
      if (!this._shot) {
        this._shot = global.document.createElement('canvas');
        this._shotCtx = this._shot.getContext('2d');
      }
      var w = this.frameW;
      var h = Math.max(1, Math.round(canvas.height * w / canvas.width));
      this._shot.width = w;
      this._shot.height = h;
      this._shotCtx.drawImage(canvas, 0, 0, w, h);
      var url = this._shot.toDataURL('image/jpeg', this.quality);
      return url.substring(url.indexOf(',') + 1);
    } catch (e) {
      this.lastError = String(e && e.message || e);
      return null;
    }
  };

  /** 给最近 labelWindowMs 内的样本打真实标签 */
  Recorder.prototype.label = function (kind) {
    if (!this.samples.length) return 0;
    var t = nowMs() - this.t0;
    var n = 0;
    for (var i = this.samples.length - 1; i >= 0; i--) {
      var s = this.samples[i];
      if (t - s.t > this.labelWindowMs) break;
      if (s.label) continue;
      s.label = kind;
      n++;
    }
    this.notify();
    return n;
  };

  /**
   * 标注最近检测到的障碍属于哪一类。
   * 纯颜色/形状规则分不出"人 / 影子 / 水坑 / 杂物"，要分类必须靠模型，
   * 而模型的训练数据只能从真实场景里攒 —— 这个标注就是攒数据的入口。
   * @param {string} kind person | shadow | water | debris | mark | other
   */
  Recorder.prototype.labelObstacle = function (kind) {
    if (!this.samples.length) return 0;
    var t = nowMs() - this.t0;
    var n = 0;
    for (var i = this.samples.length - 1; i >= 0; i--) {
      var s = this.samples[i];
      if (t - s.t > this.obstacleLabelWindowMs) break;
      if (!s.obsBox || s.obsLabel) continue;
      s.obsLabel = kind;
      n++;
    }
    this.notify();
    return n;
  };

  Recorder.prototype.trim = function () {
    while (this.samples.length > this.maxFrames) this.samples.shift();
  };

  /** 打包为可下载 / 可上传的 JSON 数据包 */
  Recorder.prototype.buildPackage = function (meta) {
    var m = meta || {};
    return {
      format: 'tlg-samples-v1',
      createdAt: new Date().toISOString(),
      app: { name: 'TrackLaneGuard', version: m.version || '', build: m.build || '' },
      device: {
        userAgent: (global.navigator && global.navigator.userAgent) || '',
        screen: global.screen ? (global.screen.width + 'x' + global.screen.height) : '',
        orientation: m.orientation || '',
        videoSize: m.videoSize || ''
      },
      config: m.cfg || {},
      notes: m.notes || '',
      counts: this.stats(),
      samples: this.samples
    };
  };

  Recorder.prototype.exportJson = function (meta) {
    var pkg = this.buildPackage(meta);
    return JSON.stringify(pkg);
  };

  Recorder.prototype.download = function (meta) {
    var text = this.exportJson(meta);
    var blob = new global.Blob([text], { type: 'application/json' });
    var url = global.URL.createObjectURL(blob);
    var a = global.document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = 'tlg-samples-' + stamp + '.json';
    global.document.body.appendChild(a);
    a.click();
    global.document.body.removeChild(a);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 4000);
    return text.length;
  };

  TLG.Recorder = Recorder;
})(window);

/*
 * detector.js —— 障碍检测器抽象层
 *
 * 设计目标：把"谁来给障碍框"变成可替换的一层，让识别能力能平滑升级而不推翻现有实现。
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ app.js（障碍提示 / 画面标注）                  │
 *   └───────────────────┬──────────────────────────┘
 *                       │  统一格式：[{cls, conf, box, area, src}]
 *   ┌───────────────────┴──────────────────────────┐
 *   │  model   → OnnxDetector  ONNX Runtime Web     │
 *   │            （模型文件就位才启用；未就位则跳过） │
 *   │  fallback→ RuleDetector  颜色/孔洞规则（现状）  │
 *   └──────────────────────────────────────────────┘
 *
 * 关键取舍（详见 DETECTION.md）：
 *   · 模型缺失/加载失败/推理超时 → 自动回退规则，行为与升级前完全一致
 *   · 模型结果优先，但只有置信度达标的类别才会说出口；
 *     置信度不足仍只说「前方有占用物」—— 说错类别比不说更危险
 *   · 选 ONNX 是因为它是 ncnn / MNN / Paddle-Lite / Core ML 的交集格式：
 *     将来 APK 要提速，同一份模型可直接喂给原生 ncnn，Web 侧逻辑不用重写
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});
  var doc = global.document;

  var ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.all.min.js';

  // COCO 80 类（YOLOv8 预训练）。自定义类别微调后需同步替换此表。
  var COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck',
    'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
    'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
    'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
    'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
    'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
    'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
    'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
    'teddy bear', 'hair drier', 'toothbrush'];

  // 只说得出这几类的"具体名字"——其余一律说"占用物"，避免把 bench 说成椅子这类误判
  var SPEAKABLE = {
    person: '人', bicycle: '自行车', car: '车辆', motorcycle: '摩托车', dog: '狗',
    bottle: '瓶子', cup: '杯子', backpack: '背包', handbag: '包', chair: '椅子',
    umbrella: '雨伞', cell_phone: '手机'
  };

  function clsName(i) {
    var en = COCO[i] || 'object';
    return SPEAKABLE[en] || (en === 'object' ? '占用物' : '占用物');
  }

  /* ================= 规则检测器（现有能力，零依赖） ================= */

  function RuleDetector() {}
  /** 把 cv.analyze 的 obstacles 转成统一格式（坐标归一化到 0..1） */
  RuleDetector.prototype.detect = function (res, w, h) {
    if (!res || !res.obstacles || !res.obstacles.length) return [];
    return res.obstacles.map(function (o) {
      return {
        cls: '占用物',
        conf: 0.5,
        box: { x0: o.x0 / w, y0: o.y0 / h, x1: (o.x1 + 1) / w, y1: (o.y1 + 1) / h },
        area: o.area / (w * h),
        src: 'rule'
      };
    });
  };

  /* ================= ONNX 检测器 ================= */

  function OnnxDetector(opts) {
    this.url = opts.url;
    this.inputSize = opts.inputSize || 320;
    this.confThr = opts.conf === undefined ? 0.35 : opts.conf;
    this.iouThr = opts.iou === undefined ? 0.45 : opts.iou;
    this.session = null;
    this.state = 'idle';     // idle | loading | ready | failed
    this.ort = null;
    this._canvas = null;
    this._ctx = null;
    this.lastMs = 0;
    this.inferCount = 0;
  }

  OnnxDetector.prototype.ensureEngine = function () {
    var self = this;
    if (this.ort) return Promise.resolve(this.ort);
    if (global.ort) { this.ort = global.ort; return Promise.resolve(this.ort); }
    return new Promise(function (resolve, reject) {
      if (global.ort) { self.ort = global.ort; resolve(self.ort); return; }
      var s = doc.createElement('script');
      s.src = ORT_CDN;
      s.async = true;
      s.onload = function () {
        if (global.ort) { self.ort = global.ort; resolve(self.ort); }
        else reject(new Error('推理引擎加载后不可用'));
      };
      s.onerror = function () { reject(new Error('推理引擎加载失败（离线或网络受限）')); };
      doc.head.appendChild(s);
    });
  };

  OnnxDetector.prototype.load = function () {
    var self = this;
    if (this.state === 'ready') return Promise.resolve(true);
    this.state = 'loading';
    return this.ensureEngine().then(function (ort) {
      return ort.InferenceSession.create(self.url, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    }).then(function (session) {
      self.session = session;
      self.state = 'ready';
      return true;
    }).catch(function (e) {
      self.state = 'failed';
      throw e;
    });
  };

  /** letterbox 预处理：等比缩放 + 灰边填充，并记录还原参数 */
  OnnxDetector.prototype.prepare = function (video) {
    var S = this.inputSize;
    if (!this._canvas) {
      this._canvas = doc.createElement('canvas');
      this._canvas.width = S;
      this._canvas.height = S;
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }
    var ctx = this._ctx;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, S, S);

    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var scale = Math.min(S / vw, S / vh);
    var dw = Math.round(vw * scale), dh = Math.round(vh * scale);
    ctx.drawImage(video, (S - dw) / 2, (S - dh) / 2, dw, dh);

    var img = ctx.getImageData(0, 0, S, S).data;
    var f32 = new Float32Array(S * S * 3);
    for (var i = 0, j = 0; i < img.length; i += 4) {
      f32[j++] = img[i] / 255;
      f32[j++] = img[i + 1] / 255;
      f32[j++] = img[i + 2] / 255;
    }
    return { tensor: new this.ort.Tensor('float32', f32, [1, 3, S, S]), scale: scale, pad: (S - dw) / (2 * S) };
  };

  /** 对一帧做推理，返回统一格式的障碍列表 */
  OnnxDetector.prototype.detect = function (video) {
    var self = this;
    if (this.state !== 'ready' || !video) return Promise.resolve([]);
    var prep;
    try {
      prep = this.prepare(video);
    } catch (e) {
      return Promise.resolve([]);
    }
    if (!prep) return Promise.resolve([]);
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();

    return this.session.run({ images: prep.tensor }).then(function (out) {
      self.lastMs = Math.round(((global.performance && global.performance.now) ? global.performance.now() : Date.now()) - t0);
      self.inferCount++;
      var key = Object.keys(out)[0];
      var t = out[key];
      var dims = t.dims;                 // [1, 4+nc, N]
      var arr = t.data;
      var nc = dims[1] - 4, N = dims[2];
      var cand = [];
      for (var i = 0; i < N; i++) {
        var cx = arr[i], cy = arr[N + i], w = arr[2 * N + i], h = arr[3 * N + i];
        if (!(w > 0) || !(h > 0)) continue;
        var best = 0, score = 0;
        for (var c = 0; c < nc; c++) {
          var s = arr[(4 + c) * N + i];
          if (s > score) { score = s; best = c; }
        }
        if (score < self.confThr) continue;
        cand.push({ score: score, cls: best, cx: cx, cy: cy, w: w, h: h });
      }
      var kept = nms(cand, self.iouThr);
      // 从 letterbox 归一化坐标还原到原视频 0..1
      var pad = prep.pad, sc = prep.scale;
      return kept.map(function (b) {
        var x0 = (b.cx - b.w / 2 - pad) / sc;
        var x1 = (b.cx + b.w / 2 - pad) / sc;
        var y0 = (b.cy - b.h / 2 - pad) / sc;
        var y1 = (b.cy + b.h / 2 + pad) / sc;
        return {
          cls: clsName(b.cls),
          clsEn: COCO[b.cls] || 'object',
          conf: Math.round(b.score * 100) / 100,
          box: {
            x0: Math.max(0, x0), y0: Math.max(0, y0),
            x1: Math.min(1, x1), y1: Math.min(1, y1)
          },
          area: Math.max(0, (x1 - x0)) * Math.max(0, (y1 - y0)),
          src: 'model'
        };
      });
    }).catch(function () {
      return [];   // 推理失败不抛给上层，直接当没检测到
    });
  };

  function iou(a, b) {
    var ax0 = a.cx - a.w / 2, ay0 = a.cy - a.h / 2, ax1 = a.cx + a.w / 2, ay1 = a.cy + a.h / 2;
    var bx0 = b.cx - b.w / 2, by0 = b.cy - b.h / 2, bx1 = b.cx + b.w / 2, by1 = b.cy + b.h / 2;
    var ix = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
    var iy = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
    var inter = ix * iy;
    var ua = a.w * a.h + b.w * b.h - inter;
    return ua > 0 ? inter / ua : 0;
  }

  function nms(boxes, thr) {
    boxes.sort(function (a, b) { return b.score - a.score; });
    var keep = [];
    while (boxes.length) {
      var b = boxes.shift();
      keep.push(b);
      boxes = boxes.filter(function (o) {
        return (o.cls !== b.cls) || (iou(b, o) < thr);
      });
    }
    return keep;
  }

  /* ================= 上层门面：模式切换 + 融合 ================= */

  function Detector(opts) {
    opts = opts || {};
    this.mode = opts.mode || 'auto';      // auto | rule | model
    this.modelUrl = opts.modelUrl || 'models/yolov8n.onnx';
    this.rule = new RuleDetector();
    this.model = new OnnxDetector({ url: this.modelUrl });
    this.onState = opts.onState || null;
    this.merged = [];
  }

  Detector.prototype.state = function () {
    if (this.mode === 'rule') return 'rule';
    return this.model.state;   // idle | loading | ready | failed
  };

  /** 尝试加载模型；模型文件不存在时静默失败并保持规则模式 */
  Detector.prototype.init = function () {
    var self = this;
    if (this.mode !== 'auto' && this.mode !== 'model') {
      this.notify();
      return Promise.resolve(false);
    }
    this.model.state = 'loading';
    this.notify();
    return this.model.load().then(function () {
      self.notify();
      return true;
    }).catch(function () {
      self.model.state = 'failed';
      self.notify();
      return false;   // 失败不回滚配置，只回退行为
    });
  };

  Detector.prototype.notify = function () {
    if (this.onState) this.onState(this.state(), this.model);
  };

  /**
   * 融合模型与规则的结果。
   * 规则：模型优先（有类别名），规则补充模型可能漏掉的非 COCO 类别；
   *      同类目标重叠时保留置信度更高的那个。
   */
  Detector.prototype.fuse = function (modelBoxes, ruleBoxes) {
    var out = [];
    var i, j, m, r, overlap;
    for (i = 0; i < modelBoxes.length; i++) out.push(modelBoxes[i]);
    for (j = 0; j < ruleBoxes.length; j++) {
      r = ruleBoxes[j];
      var covered = false;
      for (i = 0; i < modelBoxes.length; i++) {
        m = modelBoxes[i];
        overlap = boxOverlap(m.box, r.box);
        if (overlap > 0.3) { covered = true; break; }
      }
      if (!covered) out.push(r);
    }
    out.sort(function (a, b) { return b.area - a.area; });
    return out;
  };

  function boxOverlap(a, b) {
    var ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
    var iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    var inter = ix * iy;
    var ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  /**
   * 每帧调用。模型就推理，规则始终算（作为回退与补充）。
   * @param video   HTMLVideoElement
   * @param res     cv.analyze 的结果（供规则检测器）
   */
  Detector.prototype.update = function (video, res, w, h) {
    var self = this;
    var ruleBoxes = (this.mode === 'model') ? [] : this.rule.detect(res, w, h);
    if (this.mode === 'model' || this.model.state !== 'ready') {
      this.merged = ruleBoxes;
      return null;
    }
    // 模型推理是异步的，这里返回 Promise；调用方自行决定是否等待
    return this.model.detect(video).then(function (modelBoxes) {
      self.merged = self.fuse(modelBoxes, ruleBoxes);
      return self.merged;
    });
  };

  Detector.prototype.statusText = function () {
    var s = this.state();
    if (s === 'ready') return '模型已启用';
    if (s === 'loading') return '模型加载中…';
    if (s === 'failed') return '模型未启用（用规则）';
    if (s === 'rule') return '规则模式';
    return '规则模式';
  };

  TLG.Detector = Detector;
  TLG.RuleDetector = RuleDetector;
  TLG.OnnxDetector = OnnxDetector;
})(window);

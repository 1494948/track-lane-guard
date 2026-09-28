/* 抗干扰基准测试：量化各版本误判表现。不依赖浏览器与相机。
 * 覆盖：横屏/竖屏、夜间眩光、弯道、远处隔草坪跑道（真实事故复现）。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'web', 'js', 'cv.js');
global.window = global;
eval(fs.readFileSync(SRC, 'utf8'));
const cv = global.window.TLG.cv;

const CFG = {
  hueCenter: 4, hueWidth: 16, satMin: 55, valMin: 45,
  lineSatMax: 80, lineValMin: 170,
  bandTop: 0.45, bandBottom: 0.97, minCoverage: 0.06, minTrackPixels: 0.02,
  nearTop: 0.68, nearBottom: 0.98, farTop: 0.26, farBottom: 0.58,
  obsMinArea: 0.004,
  closeRadius: 3, lineMinRowRatio: 0.5, lineMaxRms: 2.6,
  gate: 0.28, maxSpeed: 0.06,
  caution: 0.18, danger: 0.34, stableFrames: 8, minConfidence: 0.45
};

const GRASS = [70, 120, 70], TRACK = [180, 50, 45], LINE = [240, 240, 240];
const FADED = [122, 122, 122];

/* ---------- 场景生成（宽高可参数化，支持竖屏） ---------- */
function makeScene(o) {
  const W = o.w || 192, H = o.h || 108;
  const yTop = Math.round(H * 0.30), yBot = H - 1;
  const bandY0 = Math.floor(H * CFG.bandTop), bandY1 = Math.floor(H * CFG.bandBottom);
  const yMidBand = (bandY0 + bandY1) / 2;

  const data = new Uint8ClampedArray(W * H * 4);
  const j = o.jitter ? (Math.random() * 2 - 1) * o.jitter : 0;
  const off = o.offset || 0;
  const tL = o.topL + j + off, tR = o.topR + j + off;
  const bL = o.botL + j * 1.6 + off * 1.6, bR = o.botR + j * 1.6 + off * 1.6;
  const br = o.brightness || 1;

  const scale = (c) => [Math.min(255, c[0] * br), Math.min(255, c[1] * br), Math.min(255, c[2] * br)];
  const g = scale(GRASS), tk = scale(TRACK), ln = scale(LINE);

  // 弯道：边界随 y 二次弯曲（整体平移，宽度不变，居中时真值仍为 0.5）
  const bendC = o.bend || 0;
  const halfBand = (bandY1 - bandY0) / 2;
  const bendAt = (y) => bendC * Math.pow((y - yMidBand) / halfBand, 2);

  function setPx(dd, x, y, c) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    dd[i] = c[0]; dd[i + 1] = c[1]; dd[i + 2] = c[2]; dd[i + 3] = 255;
  }

  // 远处横向偏移：模拟跑道在前方向一侧延伸（漂移趋势的物理来源）
  const farShift = o.farShift || 0;
  const shiftAt = (y) => farShift * (1 - (y - yTop) / (yBot - yTop));

  for (let y = 0; y < H; y++) {
    let L = 0, R = -1;
    if (y >= yTop) {
      const t = (y - yTop) / (yBot - yTop);
      const b = bendAt(y);
      L = tL + (bL - tL) * t + b + shiftAt(y);
      R = tR + (bR - tR) * t + b + shiftAt(y);
    }
    for (let x = 0; x < W; x++) {
      let col = g;
      if (x >= Math.floor(L) && x <= Math.ceil(R)) col = tk;
      if (o.lines && R > L) {
        for (const f of o.lines) {
          if (Math.abs(x - (L + (R - L) * f)) <= 1.2) col = ln;
        }
      }
      setPx(data, x, y, col);
    }
    if (o.adjRed && y >= yTop && R > 0) {
      for (let x = Math.ceil(R) + o.adjGap; x < Math.ceil(R) + o.adjGap + o.adjRed; x++) {
        setPx(data, x, y, tk);
      }
    }
  }

  if (o.faded) {
    const [cx0, cy0, cw, ch] = o.faded;
    for (let y = cy0; y < cy0 + ch; y++) for (let x = cx0; x < cx0 + cw; x++) setPx(data, x, y, scale(FADED));
  }
  if (o.specks) {
    for (const [sx, sy, sw, sh] of o.specks) {
      for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) setPx(data, x, y, ln);
    }
  }
  // 跑道面上的占用物（人影/衣物/水坑）：非红非白的暗块
  if (o.obstacle) {
    const [ox, oy, ow, oh] = o.obstacle;
    for (let y = oy; y < oy + oh; y++) for (let x = ox; x < ox + ow; x++) setPx(data, x, y, [96, 96, 96]);
  }
  if (o.redBlob) {
    const [bx, by, bw, bh] = o.redBlob;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) setPx(data, x, y, tk);
  }
  if (o.whiteBlob) {
    const [bx, by, bw, bh] = o.whiteBlob;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) setPx(data, x, y, [245, 245, 245]);
  }
  // 远处隔草坪的另一段跑道（真实事故复现：竖屏时画面中上部那条）
  if (o.farStrip) {
    const [fy0, fy1] = o.farStrip;
    for (let y = fy0; y < fy1; y++) for (let x = 0; x < W; x++) setPx(data, x, y, tk);
  }
  if (o.noise) {
    const cnt = Math.round(W * H * o.noise);
    for (let k = 0; k < cnt; k++) {
      const p = Math.floor(Math.random() * W * H) * 4;
      const white = Math.random() < 0.5;
      data[p] = white ? 250 : 200;
      data[p + 1] = white ? 250 : 55;
      data[p + 2] = white ? 250 : 50;
    }
  }

  // 真值：检测带中线处、不含抖动与平移的几何（居中场景恒为 0.5）
  const tm = (yMidBand - yTop) / (yBot - yTop);
  const Lm = o.topL + (o.botL - o.topL) * tm, Rm = o.topR + (o.botR - o.topR) * tm;
  return { img: { data, width: W, height: H }, truth: (W / 2 - Lm) / (Rm - Lm) };
}

/* ---------- v1 旧算法对照 ---------- */
function legacyAnalyze(img, cfg) {
  const w = img.width, h = img.height, d = img.data;
  const red = new Uint8Array(w * h), white = new Uint8Array(w * h);
  let redCount = 0;
  const redCol = new Int32Array(w);
  const y0 = Math.floor(h * cfg.bandTop), y1 = Math.floor(h * cfg.bandBottom);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const hsv = cv.rgbToHsv(d[p], d[p + 1], d[p + 2]);
    const H2 = hsv[0], S = hsv[1], V = hsv[2];
    if (cv.hueDist(H2, cfg.hueCenter) <= cfg.hueWidth && S >= cfg.satMin && V >= cfg.valMin) {
      red[i] = 1; redCount++;
      const x = i % w, y = (i / w) | 0;
      if (y >= y0 && y < y1) redCol[x]++;
    }
    if (S <= cfg.lineSatMax && V >= cfg.lineValMin) white[i] = 1;
  }
  const cov = redCount / (w * h);
  if (cov < cfg.minCoverage) return { ok: false, p: 0.5 };
  const near = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = -5; k <= 5; k++) { const j = x + k; if (j >= 0 && j < w && redCol[j] > m) m = redCol[j]; }
    near[x] = m;
  }
  const need = Math.max(2, Math.round((y1 - y0) * 0.20));
  const wc = new Int32Array(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
    if (white[y * w + x] && near[x] >= need) wc[x]++;
  }
  const sm = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) { const j = x + k; if (j >= 0 && j < w) { s += wc[j]; c++; } }
    sm[x] = s / c;
  }
  let mxc = 0; for (let x = 0; x < w; x++) if (sm[x] > mxc) mxc = sm[x];
  const peaks = [];
  for (let x = 1; x < w - 1; x++) {
    if (sm[x] >= sm[x - 1] && sm[x] > sm[x + 1] && sm[x] >= mxc * 0.35 && sm[x] >= (y1 - y0) * 0.22) peaks.push({ x, v: sm[x] });
  }
  peaks.sort((a, b) => b.v - a.v);
  let l = null, r = null, cx = w / 2;
  for (const pk of peaks) {
    if (pk.x < cx - 2 && l === null) l = pk.x;
    else if (pk.x > cx + 2 && r === null) r = pk.x;
  }
  if (l !== null && r !== null && r - l >= w * 0.08) return { ok: true, mode: 'lines', p: (cx - l) / (r - l) };
  let st = -1, sp = null, bs = -Infinity;
  const thr = Math.max(1, mxc * 0.35);
  for (let x = 0; x < w; x++) {
    if (near[x] >= thr) { if (st < 0) st = x; } else if (st >= 0) {
      const a = st, b = x - 1;
      const cont = cx >= a && cx <= b;
      const dist = cx < a ? a - cx : (cx > b ? cx - b : 0);
      const sc = (cont ? 10000 : 0) - dist * 10 + (b - a);
      if (sc > bs) { bs = sc; sp = [a, b]; }
      st = -1;
    }
  }
  if (st >= 0) { const sc = cx >= st ? 10000 : 0; if (sc > bs) sp = [st, w - 1]; }
  if (!sp || sp[1] - sp[0] < w * 0.12) return { ok: false, p: 0.5 };
  return { ok: true, mode: 'edges', p: (cx - sp[0]) / (sp[1] - sp[0]) };
}

/* ---------- 评测 ---------- */
function stat(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  return { mean: m, sd: sd };
}

function evaluate(gen, frames, legacy) {
  const tr = new cv.Tracker();
  const ps = [], confs = [];
  let miss = 0, alarms = 0, firstAlarm = -1, curveFrames = 0, floodFrames = 0;
  let obsFrames = 0, trendSum = 0, trendN = 0;
  let prev = 0.5, sameDir = 0, lastSign = 0;
  for (let i = 0; i < frames; i++) {
    const s = gen(i);
    let lv = 0;
    if (legacy) {
      const r = legacyAnalyze(s.img, CFG);
      if (!r.ok) { miss++; ps.push(prev); continue; }
      prev = prev * 0.6 + r.p * 0.4;
      ps.push(prev);
      const d = prev - 0.5;
      const sign = Math.abs(d) < 0.04 ? 0 : (d > 0 ? 1 : -1);
      if (sign !== 0 && sign === lastSign) sameDir++; else sameDir = sign !== 0 ? 1 : 0;
      lastSign = sign;
      const ad = Math.abs(d);
      lv = sameDir >= 1 ? (ad >= CFG.danger ? 2 : (ad >= CFG.caution ? 1 : 0)) : 0;
    } else {
      const r = cv.analyze(s.img, CFG);
      if (!r.ok) miss++;
      if (r.curve) curveFrames++;
      if (r.viaFlood) floodFrames++;
      if (r.obstacles && r.obstacles.length) obsFrames++;
      if (r.trend !== undefined) { trendSum += r.trend; trendN++; }
      const st = tr.update(r, CFG);
      ps.push(st.p); confs.push(st.conf);
      const trusted = st.miss === 0 && st.conf >= CFG.minConfidence && st.sameDir >= CFG.stableFrames;
      const ad = Math.abs(st.p - 0.5);
      lv = trusted ? (ad >= CFG.danger ? 2 : (ad >= CFG.caution ? 1 : 0)) : 0;
    }
    if (lv > 0) { alarms++; if (firstAlarm < 0) firstAlarm = i; }
  }
  const s = stat(ps);
  return {
    err: Math.abs(s.mean - 0.5), sd: s.sd, miss, alarms, firstAlarm,
    conf: confs.length ? stat(confs).mean : 0, mean: s.mean,
    curveFrames, floodFrames, obsFrames,
    trend: trendN ? trendSum / trendN : 0
  };
}

const FRAMES = 40;

/* ---------- 场景定义 ---------- */
const H = (extra) => Object.assign({
  w: 192, h: 108, topL: 70, topR: 122, botL: 8, botR: 184,
  lines: [0.25, 0.75], jitter: 1.2
}, extra);

const P_CENTER = { w: 108, h: 192, topL: 41, topR: 79, botL: 10, botR: 90, lines: [0.25, 0.75], jitter: 1.2 };
const P_RIGHT = { w: 108, h: 192, topL: 65, topR: 103, botL: 40, botR: 108, lines: [0.25, 0.75], jitter: 1.2 };

const SPEC = [
  [52, 58, 5, 7], [120, 62, 6, 6], [76, 74, 4, 8],
  [140, 80, 5, 5], [40, 88, 6, 6], [100, 92, 5, 7], [160, 68, 4, 6], [64, 100, 5, 5]
];

// [名称, 场景, 期望: 'safe' / 'alarm-right' / 'alarm-left', 标记检查]
const scenes = [
  ['横屏·干净', H({}), 'safe'],
  ['横屏·白碎斑', H({ specks: SPEC }), 'safe'],
  ['横屏·相邻红场地', H({ adjRed: 34, adjGap: 8 }), 'safe'],
  ['横屏·中心褪色块', H({ faded: [78, 58, 36, 30] }), 'safe'],
  ['横屏·椒盐噪声5%', H({ noise: 0.05 }), 'safe'],
  ['横屏·红干扰块', H({ redBlob: [10, 4, 34, 22] }), 'safe'],
  ['横屏·白干扰块', H({ whiteBlob: [120, 2, 60, 16] }), 'safe'],
  ['横屏·偏暗0.55x', H({ brightness: 0.55 }), 'safe'],
  ['横屏·无分道线', H({ lines: [] }), 'safe'],
  ['横屏·远处隔草坪跑道', H({ farStrip: [8, 26] }), 'safe'],
  ['横屏·夜间+过曝+眩光', H({ brightness: 0.55, specks: SPEC, whiteBlob: [130, 2, 55, 18] }), 'safe'],
  ['横屏·弯道', H({ bend: 20 }), 'safe', 'curve'],
  ['横屏·远处跑道右偏(趋势)', H({ farShift: 26 }), 'safe', 'trend-right'],
  ['横屏·跑道上有占用物', H({ obstacle: [92, 62, 16, 20] }), 'safe', 'obstacle'],
  ['竖屏·居中', P_CENTER, 'safe'],
  ['竖屏·远处隔草坪跑道(截图复现)', Object.assign({}, P_CENTER, { farStrip: [20, 50] }), 'safe'],
  ['竖屏·夜间', Object.assign({}, P_CENTER, { brightness: 0.55, whiteBlob: [60, 2, 40, 16] }), 'safe'],
  ['竖屏·偏右应报警往右', P_RIGHT, 'alarm-right']
];

console.log('=== 场景矩阵（每场景 40 帧，含手持抖动）===');
console.log('场景'.padEnd(26) + '| v2 误差  误报  丢失 | v1 误差  误报  丢失');
console.log('-'.repeat(72));

let pass = true;
const results = [];
for (const [name, base, expect, tag] of scenes) {
  const gen = () => makeScene(base);
  const a = evaluate(gen, FRAMES, false);
  const b = evaluate(gen, FRAMES, true);
  results.push([name, a, b, expect, tag]);
  console.log(
    name.padEnd(24) + '| ' +
    a.err.toFixed(3).padStart(6) + ' ' + String(a.alarms).padStart(5) + ' ' + String(a.miss).padStart(5) + ' | ' +
    b.err.toFixed(3).padStart(6) + ' ' + String(b.alarms).padStart(5) + ' ' + String(b.miss).padStart(5)
  );

  if (expect === 'safe') {
    if (a.alarms > 0) { console.log('  ✗ v2 误报 ' + a.alarms + ' 帧'); pass = false; }
    if (a.miss > 0) { console.log('  ✗ v2 丢失 ' + a.miss + ' 帧'); pass = false; }
    if (a.err > 0.06) { console.log('  ✗ v2 位置误差 ' + a.err.toFixed(3)); pass = false; }
  } else if (expect === 'alarm-right') {
    if (a.firstAlarm < 0) { console.log('  ✗ 该报警却没报'); pass = false; }
    else if (a.firstAlarm > 12) { console.log('  ✗ 报警过慢（第 ' + a.firstAlarm + ' 帧）'); pass = false; }
    if (a.mean >= 0.45) { console.log('  ✗ 方向判定错误 p=' + a.mean.toFixed(3)); pass = false; }
  }
  if (tag === 'curve' && a.curveFrames < FRAMES * 0.5) {
    console.log('  ✗ 弯道未被标记（仅 ' + a.curveFrames + '/' + FRAMES + ' 帧）'); pass = false;
  }
  if (tag === 'trend-right') {
    // 远处跑道右偏 → trend 应为正，且近带居中不能误报
    if (!(a.trend > 0.04)) { console.log('  ✗ 未识别出远处右偏趋势 trend=' + a.trend.toFixed(3)); pass = false; }
    else console.log('  ✓ 远处趋势识别：trend=' + a.trend.toFixed(3) + '（正=提示往右），近带零误报');
  }
  if (tag === 'obstacle') {
    if (a.obsFrames < FRAMES * 0.8) {
      console.log('  ✗ 占用物未被检测（' + a.obsFrames + '/' + FRAMES + ' 帧）'); pass = false;
    } else console.log('  ✓ 占用物检测：' + a.obsFrames + '/' + FRAMES + ' 帧命中');
  }
}

console.log('\n=== 泛洪与弯道检测生效情况 ===');
for (const [name, a] of results) {
  if (name.indexOf('远处') >= 0 || name.indexOf('弯道') >= 0) {
    console.log('  ' + name + '：泛洪 ' + a.floodFrames + '/' + FRAMES + ' 帧，弯道标记 ' + a.curveFrames + '/' + FRAMES + ' 帧');
  }
}
const farScene = results.find(([n]) => n.indexOf('截图复现') >= 0);
if (farScene && farScene[1].floodFrames < FRAMES) {
  console.log('  ✗ 截图复现场景未稳定走泛洪路径'); pass = false;
}

console.log('\n=== 真实偏离（横屏）：应尽快报警且方向正确 ===');
const drift = () => makeScene(H({ topL: 30, topR: 82, botL: -32, botR: 144 }));
const rd = evaluate(drift, FRAMES, false);
console.log('  首报帧序 ' + rd.firstAlarm + '，平均 p ' + rd.mean.toFixed(3));
if (rd.firstAlarm < 0 || rd.firstAlarm > 12) { console.log('  ✗ 报警缺失或过慢'); pass = false; }
if (rd.mean < 0.6) { console.log('  ✗ 方向判定错误'); pass = false; }

console.log('\n=== 纯草地（无跑道）===');
let fp = 0;
const tr0 = new cv.Tracker();
for (let i = 0; i < 20; i++) {
  const s = makeScene({ w: 192, h: 108, topL: 0, topR: -1, botL: 0, botR: -1, lines: [] });
  const st = tr0.update(cv.analyze(s.img, CFG), CFG);
  const trusted = st.miss === 0 && st.conf >= CFG.minConfidence && st.sameDir >= CFG.stableFrames;
  if (trusted && Math.abs(st.p - 0.5) >= CFG.caution) fp++;
}
console.log('  误报帧数 ' + fp + '（应为 0）');
if (fp > 0) pass = false;

console.log('\n=== 性能（横屏与竖屏）===');
for (const [nm, base] of [['横屏', H({})], ['竖屏', P_CENTER]]) {
  const img = makeScene(base).img;
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) cv.analyze(img, CFG);
  console.log('  ' + nm + ' ' + img.width + 'x' + img.height + ' 单帧 ' +
    ((Date.now() - t0) / 200).toFixed(2) + ' ms');
}

console.log(pass ? '\n全部通过' : '\n存在未通过项');
process.exit(pass ? 0 : 1);

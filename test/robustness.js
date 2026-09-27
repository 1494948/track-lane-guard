/* 抗干扰基准测试：量化 v2 相对 v1 的误判改善。不依赖浏览器与相机。 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'web', 'js', 'cv.js');
global.window = global;
eval(fs.readFileSync(SRC, 'utf8'));
const cv = global.window.TLG.cv;

const W = 192, H = 108;
const CFG = {
  hueCenter: 4, hueWidth: 16, satMin: 55, valMin: 45,
  lineSatMax: 80, lineValMin: 170,
  bandTop: 0.50, bandBottom: 0.92, minCoverage: 0.06, minTrackPixels: 0.02,
  closeRadius: 3, lineMinRowRatio: 0.5, lineMaxRms: 2.6,
  gate: 0.28, maxSpeed: 0.06,
  caution: 0.18, danger: 0.34, stableFrames: 8, minDrift: 0.12, minConfidence: 0.45
};

const GRASS = [70, 120, 70], TRACK = [180, 50, 45], LINE = [240, 240, 240];
const FADED = [122, 122, 122];       // 褪色/水渍：既不是红也不是白
const yTop = Math.round(H * 0.30), yBot = H - 1;
const yMid = (CFG.bandTop + CFG.bandBottom) / 2 * H;

function setPx(data, x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
}

/* ---------- 场景生成 ---------- */
function makeScene(o) {
  const data = new Uint8ClampedArray(W * H * 4);
  const j = o.jitter ? (Math.random() * 2 - 1) * o.jitter : 0;
  const off = o.offset || 0;                       // 整体平移：模拟手持晃动
  const tL = o.topL + j + off, tR = o.topR + j + off, bL = o.botL + j * 1.6 + off * 1.6, bR = o.botR + j * 1.6 + off * 1.6;
  const br = o.brightness || 1;

  const scale = (c) => [Math.min(255, c[0] * br), Math.min(255, c[1] * br), Math.min(255, c[2] * br)];
  const g = scale(GRASS), tk = scale(TRACK), ln = scale(LINE);

  for (let y = 0; y < H; y++) {
    let L = 0, R = -1;
    if (y >= yTop) {
      const t = (y - yTop) / (yBot - yTop);
      L = tL + (bL - tL) * t;
      R = tR + (bR - tR) * t;
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
    // 紧贴跑道右侧的另一块红色场地（间隔 o.adjGap 像素）
    if (o.adjRed && y >= yTop && R > 0) {
      for (let x = Math.ceil(R) + o.adjGap; x < Math.ceil(R) + o.adjGap + o.adjRed; x++) setPx(data, x, y, tk);
    }
  }

  // 跑道内的褪色/水渍块：盖住画面中心区域
  if (o.faded) {
    const [cx0, cy0, cw, ch] = o.faded;
    for (let y = cy0; y < cy0 + ch; y++) {
      for (let x = cx0; x < cx0 + cw; x++) setPx(data, x, y, scale(FADED));
    }
  }
  // 跑道内的白色碎斑（污渍、光斑），刻意不在一条直线上
  if (o.specks) {
    for (const [sx, sy, sw, sh] of o.specks) {
      for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) setPx(data, x, y, ln);
    }
  }
  if (o.redBlob) {
    const [bx, by, bw, bh] = o.redBlob;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) setPx(data, x, y, tk);
  }
  if (o.whiteBlob) {
    const [bx, by, bw, bh] = o.whiteBlob;
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) setPx(data, x, y, [245, 245, 245]);
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

  // 真值用「不含抖动与平移」的几何：人始终在跑道正中，真值恒为 0.5
  const tm = (yMid - yTop) / (yBot - yTop);
  const Lm = o.topL + (o.botL - o.topL) * tm, Rm = o.topR + (o.botR - o.topR) * tm;
  return {
    img: { data, width: W, height: H },
    truth: (W / 2 - Lm) / (Rm - Lm)
  };
}

/* ---------- v1 旧算法（对照用：列直方图 + 膨胀，无连通域/无拟合/无置信度） ---------- */
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
  if (st >= 0) { const a = st, b = w - 1; const sc = (cx >= a ? 10000 : 0); if (sc > bs) sp = [a, b]; }
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
  let miss = 0, alarms = 0, firstAlarm = -1;
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
      const st = tr.update(r, CFG);
      ps.push(st.p); confs.push(st.conf);
      const trusted = st.miss === 0 && st.conf >= CFG.minConfidence &&
        st.sameDir >= CFG.stableFrames;
      const ad = Math.abs(st.p - 0.5);
      lv = trusted ? (ad >= CFG.danger ? 2 : (ad >= CFG.caution ? 1 : 0)) : 0;
    }
    if (lv > 0) { alarms++; if (firstAlarm < 0) firstAlarm = i; }
  }
  const s = stat(ps);
  return {
    err: Math.abs(s.mean - 0.5), sd: s.sd, miss, alarms, firstAlarm,
    conf: confs.length ? stat(confs).mean : 0, mean: s.mean
  };
}

const FRAMES = 40;
const BASE = { topL: 70, topR: 122, botL: 8, botR: 184, lines: [0.25, 0.75], jitter: 1.2 };

const SPEC = [
  [52, 58, 5, 7], [120, 62, 6, 6], [76, 74, 4, 8],
  [140, 80, 5, 5], [40, 88, 6, 6], [100, 92, 5, 7], [160, 68, 4, 6], [64, 100, 5, 5]
];

const scenes = [
  ['干净跑道', {}],
  ['跑道内白碎斑', { specks: SPEC }],
  ['相邻红场地', { adjRed: 34, adjGap: 8 }],
  ['中心褪色块', { faded: [78, 58, 36, 30] }],
  ['椒盐噪声2%', { noise: 0.02 }],
  ['红色干扰块', { redBlob: [10, 4, 34, 22] }],
  ['白色干扰块', { whiteBlob: [120, 2, 60, 16] }],
  ['偏暗0.65x', { brightness: 0.65 }],
  ['无分道线', { lines: [] }]
];

console.log('=== 居中场景：位置误差 / 抖动 / 误报（40 帧，含手持抖动）===');
console.log('场景'.padEnd(14) + '| v2 误差  v2抖动σ  v2误报 | v1 误差  v1抖动σ  v1误报');
console.log('-'.repeat(72));

let pass = true;
const rows = [];
for (const [name, extra] of scenes) {
  const gen = () => makeScene(Object.assign({}, BASE, extra));
  const a = evaluate(gen, FRAMES, false);
  const b = evaluate(gen, FRAMES, true);
  rows.push([name, a, b]);
  console.log(
    name.padEnd(12) + '| ' +
    a.err.toFixed(3).padStart(7) + '  ' + a.sd.toFixed(4).padStart(6) + '  ' + String(a.alarms).padStart(5) + ' | ' +
    b.err.toFixed(3).padStart(7) + '  ' + b.sd.toFixed(4).padStart(6) + '  ' + String(b.alarms).padStart(5)
  );
}

console.log('\n=== v2 自身硬性要求 ===');
for (const [name, a] of rows) {
  if (name === '中心褪色块') {
    // 褪色块刻意盖住中心，允许识别降级，但不许乱报警
    if (a.alarms > 0) { console.log('  ✗ ' + name + ' 出现误报 ' + a.alarms); pass = false; }
    else console.log('  ✓ ' + name + '：识别降级且不误报（置信度 ' + (a.conf * 100).toFixed(0) + '%）');
    continue;
  }
  if (a.miss > 0) { console.log('  ✗ ' + name + ' 丢失 ' + a.miss + ' 帧'); pass = false; }
  if (a.err > 0.06) { console.log('  ✗ ' + name + ' 位置误差过大 ' + a.err.toFixed(3)); pass = false; }
  if (a.sd > 0.02) { console.log('  ✗ ' + name + ' 抖动过大 ' + a.sd.toFixed(4)); pass = false; }
  if (a.alarms > 0) { console.log('  ✗ ' + name + ' 误报 ' + a.alarms + ' 帧'); pass = false; }
}
if (pass) console.log('  ✓ 全部场景零误报、零丢失、误差 < 0.06、抖动 σ < 0.02');

const v1Bad = rows.filter(([n, a, b]) => b.err > 0.06 || b.alarms > 0 || b.miss > 0);
console.log('\n=== v1 在 ' + v1Bad.length + ' / ' + rows.length + ' 个场景上出现误差/误报/丢失 ===');
for (const [n, a, b] of v1Bad) {
  console.log('  · ' + n + '：误差 ' + b.err.toFixed(3) + '，误报 ' + b.alarms + '，丢失 ' + b.miss);
}

console.log('\n=== 手持晃动：人没偏，只是镜头在晃（误判的主要来源）===');
const sway = (i) => makeScene(Object.assign({}, BASE, { offset: 48 * Math.sin(i * 0.8), jitter: 0 }));
const sw = evaluate(sway, FRAMES, false);
const swLegacy = evaluate(sway, FRAMES, true);
console.log('  v2 误报帧数 ' + sw.alarms + ' / 40　　v1 误报帧数 ' + swLegacy.alarms + ' / 40');
if (sw.alarms > 0) { console.log('  ✗ v2 在纯晃动下误报'); pass = false; }

console.log('\n=== 消融实验：逐项关掉改进，看误报如何回来 ===');
const variants = [
  ['全量 v2', {}],
  ['关掉闭运算', { closeRadius: 0 }],
  ['关掉置信度门控', { minConfidence: 0 }],
  ['关掉持续帧投票', { stableFrames: 1, minDrift: 0 }],
  ['关掉跟踪器门控', { gate: 99 }],
  ['关掉白点腐蚀', { erodeWhite: false }],
  ['同时关掉闭运算+腐蚀', { closeRadius: 0, erodeWhite: false }]
];
const ablScenes = [
  ['强噪声5%', () => makeScene(Object.assign({}, BASE, { noise: 0.05 }))],
  ['手持晃动', sway]
];
console.log('  变体'.padEnd(18) + '噪声抖动σ   噪声误报   晃动误报');
for (const [vn, vc] of variants) {
  const save = Object.assign({}, CFG);
  Object.assign(CFG, vc);
  const r1 = evaluate(ablScenes[0][1], FRAMES, false);
  const r2 = evaluate(ablScenes[1][1], FRAMES, false);
  console.log('  ' + vn.padEnd(16) + r1.sd.toFixed(4).padStart(8) +
    String(r1.alarms).padStart(11) + String(r2.alarms).padStart(11));
  Object.assign(CFG, save);
}

console.log('\n=== 真实偏离：应尽快报警且方向正确 ===');
const drift = () => makeScene({ topL: 30, topR: 82, botL: -32, botR: 144, lines: [0.25, 0.75], jitter: 1.0 });
const rd = evaluate(drift, FRAMES, false);
console.log('  首报帧序 ' + rd.firstAlarm + '，报警帧数 ' + rd.alarms + '，平均 p ' + rd.mean.toFixed(3));
if (rd.firstAlarm < 0) { console.log('  ✗ 漏报'); pass = false; }
if (rd.firstAlarm > 12) { console.log('  ✗ 报警过慢'); pass = false; }
if (rd.mean < 0.6) { console.log('  ✗ 方向判定错误'); pass = false; }

console.log('\n=== 纯草地（无跑道）===');
let fp = 0;
const tr0 = new cv.Tracker();
for (let i = 0; i < 20; i++) {
  const s = makeScene({ topL: 0, topR: -1, botL: 0, botR: -1, lines: [] });
  const st = tr0.update(cv.analyze(s.img, CFG), CFG);
  const trusted = st.miss === 0 && st.conf >= CFG.minConfidence &&
    st.sameDir >= CFG.stableFrames;
  if (trusted && Math.abs(st.p - 0.5) >= CFG.caution) fp++;
}
console.log('  误报帧数 ' + fp + '（应为 0）');
if (fp > 0) pass = false;

console.log('\n=== 性能 ===');
const img = makeScene(BASE).img;
const t0 = Date.now();
for (let i = 0; i < 300; i++) cv.analyze(img, CFG);
const per = (Date.now() - t0) / 300;
console.log('  v2 单帧 ' + per.toFixed(2) + ' ms');
if (per > 8) { console.log('  ✗ 单帧过慢'); pass = false; }

console.log(pass ? '\n全部通过' : '\n存在未通过项');
process.exit(pass ? 0 : 1);

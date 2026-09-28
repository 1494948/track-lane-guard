/* 采集器离线测试：不依赖浏览器、不联网。
 * 覆盖：同意流程、采集开关、记录结构、标注窗口、上限裁剪、打包结构、隐私默认值。
 * 特别注意断言「未同意时绝不采集」「默认不上传」这两条隐私底线。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = true;
function ok(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) pass = false;
}

/* ---------- 极简浏览器环境 ---------- */
const LS = {};
const sandbox = {
  console,
  Date,
  Math,
  JSON,
  isFinite,
  Promise,
  setTimeout,
  Blob: function (parts) { this.size = parts && parts[0] ? parts[0].length : 0; },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  localStorage: {
    getItem: (k) => (k in LS ? LS[k] : null),
    setItem: (k, v) => { LS[k] = String(v); },
    removeItem: (k) => { delete LS[k]; }
  },
  screen: { width: 1080, height: 2340 },
  navigator: { userAgent: 'node-test' },
  performance: { now: () => Date.now() },
  fetchCalls: 0
};
sandbox.window = sandbox;
sandbox.global = sandbox;

// 假 canvas：抽帧路径可跑通，但产物是固定的假 base64
sandbox.document = {
  createElement: function (tag) {
    if (tag !== 'canvas') return { style: {} };
    return {
      width: 0, height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => 'data:image/jpeg;base64,' + 'A'.repeat(1200)
    };
  },
  body: { appendChild: () => {}, removeChild: () => {} }
};
sandbox.fetch = function () { sandbox.fetchCalls++; return Promise.reject(new Error('测试环境禁止联网')); };

vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'recorder.js'), 'utf8');
vm.runInContext(src, sandbox);

const Recorder = sandbox.window.TLG.Recorder;
const r = new Recorder();

/* ---------- 初始状态 ---------- */
console.log('=== 初始状态与隐私底线 ===');
ok(!r.consented && !r.enabled, '默认既未同意也未采集');
ok(!r.consentedBefore(), '本机没有历史同意记录');
ok(r.start() === false, '未同意时 start() 被拒绝');
ok(r.samples.length === 0, '未同意时没有任何采样');

/* ---------- 同意流程 ---------- */
console.log('=== 同意流程 ===');
r.giveConsent();
ok(r.consentedBefore(), '同意后写入 localStorage');
ok(r.start() === true, '同意后可以开始采集');

/* ---------- 记录与标注 ---------- */
console.log('=== 记录、抽帧与标注 ===');
const fakeCtx = (p, trend, conf) => ({
  viewCanvas: { width: 640, height: 360 },
  workCanvas: { width: 192, height: 108 },
  res: {
    ok: true, mode: 'edges', left: 30, right: 160, p: p, trend: trend,
    coverage: 0.4, confidence: conf, curve: false, clipped: false, viaFlood: true,
    far: { ok: true, left: 40, right: 150, p: 0.52 },
    near: { ok: true, left: 30, right: 160, p: p },
    obstacles: []
  },
  st: { p: p, conf: conf, sameDir: 3, miss: 0 },
  level: 0, dir: 0,
  sensor: { roll: 2, pitch: 40, aiming: true, shaking: false }
});

// 抽帧间隔 2000ms、峰值间隔 250ms：用假时钟推进
let clock = 0;
sandbox.performance.now = () => clock;
r.t0 = 0; r.lastShot = 0; r.lastPeak = 0;

for (let i = 0; i < 12; i++) {
  clock += 300;
  r.tick(fakeCtx(0.5 + i * 0.01, 0.05, 0.8));
}
ok(r.samples.length >= 10, '记录条数随帧推进增长（' + r.samples.length + ' 条）');
const framed = r.samples.filter((s) => s.frame);
ok(framed.length >= 1, '按间隔抽到帧（' + framed.length + ' 帧）');
ok(framed[0] && framed[0].work, '抽到帧的记录同时保留算法视图与工作画布两路');
ok(r.samples[0].frame === null || !r.samples[0].frame, '未到抽帧间隔的记录不重复占空间');
ok(typeof r.samples[0].p === 'number' && typeof r.samples[0].trend === 'number',
  '记录里含位置 p 与远景趋势 trend');
ok(r.samples[0].roll === 2 && r.samples[0].pitch === 40, '记录里含传感器姿态');

// 标注只覆盖最近窗口：先把时间推进到窗口之外，再标注
const beforeLabel = r.samples.length;
clock += r.labelWindowMs + 2000;
for (let i = 0; i < 3; i++) { clock += 300; r.tick(fakeCtx(0.6, -0.08, 0.75)); }
const labeled = r.label('center');
ok(labeled > 0 && labeled < r.samples.length,
  '标注只覆盖最近 ' + r.labelWindowMs + 'ms 内的 ' + labeled + ' 条（共 ' + r.samples.length + ' 条）');
ok(r.samples[r.samples.length - 1].label === 'center', '最新一条已标注');
ok(r.samples[0].label === null, '窗口之外的旧记录（第 1 条，共 ' + beforeLabel + ' 条之前）不被误标');
ok(r.label('off') === 0, '已标注的记录不会被第二次标注覆盖');

/* ---------- 上限裁剪 ---------- */
console.log('=== 上限裁剪 ===');
r.maxFrames = 20;
for (let i = 0; i < 40; i++) { clock += 300; r.tick(fakeCtx(0.5, 0, 0.8)); }
ok(r.samples.length <= 20, '超过上限后自动裁剪（当前 ' + r.samples.length + ' 条）');

/* ---------- 打包结构 ---------- */
console.log('=== 数据包结构 ===');
const pkg = r.buildPackage({ version: '1.4.0', cfg: { stableFrames: 8 }, orientation: 'landscape' });
ok(pkg.format === 'tlg-samples-v1', '包含格式标识');
ok(pkg.app && pkg.app.name === 'TrackLaneGuard' && pkg.app.version === '1.4.0', '包含应用与版本');
ok(pkg.device && typeof pkg.device.userAgent === 'string', '包含设备信息');
ok(pkg.config && pkg.config.stableFrames === 8, '包含当时的算法参数');
ok(pkg.counts && pkg.counts.count === r.samples.length, '包含统计（条数一致）');
ok(pkg.samples.length === r.samples.length, '包含全部样本');
ok(typeof pkg.createdAt === 'string' && pkg.createdAt.indexOf('T') > 0, '包含带时区的创建时间');

const text = r.exportJson({ version: '1.4.0' });
ok(text.length > 1000, '可序列化为 JSON 文本（' + text.length + ' 字符）');
ok(JSON.parse(text).format === 'tlg-samples-v1', '序列化结果可被解析回来');

/* ---------- 隐私：不得自动上传 ---------- */
console.log('=== 隐私底线 ===');
ok(sandbox.fetchCalls === 0, '整个采集流程没有发生任何网络请求');
ok(!r.uploaded, '采集器本身没有上传字段（上传由用户显式触发）');

/* ---------- 停止与删除 ---------- */
console.log('=== 停止与删除 ===');
r.stop();
ok(!r.enabled, '停止后不再采集');
const before = r.samples.length;
clock += 5000;
r.tick(fakeCtx(0.5, 0, 0.8));
ok(r.samples.length === before, '停止后 tick 不再追加记录');

r.revokeConsent();
ok(!r.consented && r.samples.length === 0, '撤回同意会清空数据并重置同意状态');
ok(!r.consentedBefore(), '撤回后本机不再保留同意记录');

console.log(pass ? '\n全部通过' : '\n存在未通过项');
process.exit(pass ? 0 : 1);

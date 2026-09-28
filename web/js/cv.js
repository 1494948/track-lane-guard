/*
 * cv.js v2 —— 跑道识别核心算法（纯自研实现，无任何第三方源码拷贝）
 *
 * 相比 v1 的抗误判改造（v1 只用列直方图，红色杂物 / 白色杂物 / 零散噪声都会被误判）：
 *
 *   1. 连通域：红色掩膜取「最大 8-邻域连通域」作为跑道，
 *      零散红色物体（衣服、标志牌、场地外的红砖）面积小，直接被剔除
 *   2. 形状校验：真实跑道在画面里「近宽远窄、延伸到画面底部、贯穿检测带」，
 *      不满足的连通域降低置信度，而不是硬报错
 *   3. 分道线：候选列必须满足「行连续性」（检测带内 ≥50% 的行都有白像素）
 *      且能拟合出残差很小的直线 —— 零散白斑、云、白墙会被剔除
 *   4. 多证据融合置信度：覆盖率 + 形状分 + 分道线分，供上层决定是否报警
 *   5. 跟踪器 Tracker：Alpha-Beta 滤波 + 残差门控 + 持续帧投票，
 *      解决抖动误报与手持晃动误报
 *
 * 参考的公开算法思想（仅思想，未复用任何代码）：
 *   - HSV 颜色阈值分割（经典计算机视觉方法）
 *   - 车道线列直方图峰值检测（Murtaza's Workshop 系列教程思路）
 *   - 连通域标记（经典 BFS 图遍历）
 *   - 最小二乘直线拟合 + 残差剔除（线少，无需 RANSAC 随机采样）
 *   - Alpha-Beta 滤波（Kalman 的两参数简化，雷达跟踪常用）
 *   详见仓库根目录 THIRD-PARTY-NOTICES.md
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});

  /* ================= 工具 ================= */

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // RGB(0-255) -> HSV，返回 [H(0-180), S(0-255), V(0-255)]
  function rgbToHsv(r, g, b) {
    var rn = r / 255, gn = g / 255, bn = b / 255;
    var max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    var min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    var d = max - min;
    var h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    var s = max === 0 ? 0 : (d / max) * 255;
    return [h * 0.5, s, max * 255];
  }

  // 色相环形距离（H 范围 0-180，半圈为 90）
  function hueDist(a, b) {
    var d = Math.abs(a - b);
    if (d > 90) d = 180 - d;
    return d;
  }

  /* ================= 掩膜 ================= */

  /**
   * 一趟扫描生成：红色跑道掩膜、白色分道线掩膜。
   * 白线饱和度≈0，不可能落入红色掩膜，必须独立统计。
   */
  function buildMasks(data, w, h, cfg) {
    var n = w * h;
    var red = new Uint8Array(n);
    var white = new Uint8Array(n);
    var redCount = 0;
    var hc = cfg.hueCenter, hw = cfg.hueWidth;
    var sMin = cfg.satMin, vMin = cfg.valMin;
    var lineSatMax = cfg.lineSatMax, lineValMin = cfg.lineValMin;

    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var hsv = rgbToHsv(data[p], data[p + 1], data[p + 2]);
      var H = hsv[0], S = hsv[1], V = hsv[2];
      if (hueDist(H, hc) <= hw && S >= sMin && V >= vMin) {
        red[i] = 1;
        redCount++;
      }
      if (S <= lineSatMax && V >= lineValMin) white[i] = 1;
    }
    return { red: red, white: white, redCount: redCount };
  }

  /* ================= 形态学 ================= */

  /**
   * 水平方向闭运算（先膨胀后腐蚀）：填平分道线造成的缝隙。
   *
   * 关键问题：分道线是白色，不属于红色掩膜，会把跑道连通域切成多条；
   * 一旦线被磨损、污渍或噪点打断，相邻车道就会连通，
   * 连通域在「一个车道 / 两个车道」之间跳变，边界随之大幅抖动。
   * 先在水平方向闭运算把线填平，跑道就连成一整片。
   * 零散干扰物间距远大于 2r，不会被误连。
   */
  function closeHorizontal(mask, w, h, r) {
    var n = w * h;
    var dil = new Uint8Array(n);
    var out = new Uint8Array(n);

    for (var y = 0; y < h; y++) {
      var base = y * w;
      for (var x = 0; x < w; x++) {
        var hit = 0;
        for (var k = -r; k <= r; k++) {
          var xx = x + k;
          if (xx >= 0 && xx < w && mask[base + xx]) { hit = 1; break; }
        }
        if (hit) dil[base + x] = 1;
      }
      for (var x2 = 0; x2 < w; x2++) {
        var all = 1;
        for (var k2 = -r; k2 <= r; k2++) {
          var xx2 = x2 + k2;
          if (xx2 < 0 || xx2 >= w || !dil[base + xx2]) { all = 0; break; }
        }
        if (all) out[base + x2] = 1;
      }
    }
    return out;
  }

  /**
   * 白色掩膜腐蚀：去掉孤立白点（相机噪声、跑道颗粒反光），
   * 避免它们被当成零星分道线。保留自身 + 至少一个 4-邻域白邻居的像素。
   */
  function erodeWhite(white, w, h) {
    var n = w * h;
    var out = new Uint8Array(n);
    for (var y = 0; y < h; y++) {
      var base = y * w;
      for (var x = 0; x < w; x++) {
        var i = base + x;
        if (!white[i]) continue;
        var cnt = 0;
        if (x > 0 && white[i - 1]) cnt++;
        if (x < w - 1 && white[i + 1]) cnt++;
        if (y > 0 && white[i - w]) cnt++;
        if (y < h - 1 && white[i + w]) cnt++;
        if (cnt >= 2) out[i] = 1;
      }
    }
    return out;
  }

  /* ================= 连通域 ================= */

  /**
   * 从画面底部中央向上泛洪，提取「人脚下的跑道」。
   *
   * 为什么不用最大连通域：真实场景（用户竖持手机）里，画面中上部常能看到
   * 隔着草坪的另一段跑道，它的透视面积可能比脚下的更大，最大连通域会选错，
   * 行边界随之全错。从脚底泛洪保证只统计「与人脚下连通」的红色区域。
   *
   * 种子：底边中间 36% 区域，向上最多找到画面 85% 高度处。
   * 脚前没有红色（不在跑道上 / 镜头没对准）时返回 null，由调用方退回最大连通域。
   */
  function floodFromBottom(mask, w, h) {
    var n = w * h;
    var label = new Uint8Array(n);
    var stack = new Int32Array(n);
    var sp = 0;
    var x0 = Math.floor(w * 0.32), x1 = Math.ceil(w * 0.68);

    var seedY = -1;
    for (var y = h - 1; y >= Math.floor(h * 0.85); y--) {
      var base = y * w, has = false;
      for (var x = x0; x <= x1; x++) {
        if (mask[base + x]) { has = true; break; }
      }
      if (has) { seedY = y; break; }
    }
    if (seedY < 0) return null;

    for (var sx = x0; sx <= x1; sx++) {
      var q = seedY * w + sx;
      if (mask[q] && !label[q]) { label[q] = 1; stack[sp++] = q; }
    }
    if (sp === 0) return null;

    var area = 0, minX = w, maxX = -1, minY = h, maxY = -1;
    while (sp > 0) {
      var p = stack[--sp];
      area++;
      var px = p % w, py = (p / w) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      for (var dy = -1; dy <= 1; dy++) {
        var ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        var rowBase = ny * w;
        for (var dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          var nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          var qq = rowBase + nx;
          if (mask[qq] && !label[qq]) { label[qq] = 1; stack[sp++] = qq; }
        }
      }
    }
    if (area < 50) return null;

    var comp = new Uint8Array(n);
    for (var i = 0; i < n; i++) if (label[i] === 1) comp[i] = 1;
    return { mask: comp, area: area, minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }


  /**
   * 取最大 8-邻域连通域（迭代 BFS；第一遍求面积与包围盒，第二遍生成掩膜）
   * @returns {null|{mask:Uint8Array, area:number, minX,maxX,minY,maxY}}
   */
  function largestComponent(mask, w, h) {
    var n = w * h;
    var label = new Int32Array(n);
    var stack = new Int32Array(n);
    var bestId = 0, bestArea = 0;
    var bestMinX = 0, bestMaxX = 0, bestMinY = 0, bestMaxY = 0;
    var id = 0;

    for (var s = 0; s < n; s++) {
      if (!mask[s] || label[s]) continue;
      id++;
      var sp = 0;
      stack[sp++] = s;
      label[s] = id;
      var area = 0, minX = w, maxX = -1, minY = h, maxY = -1;

      while (sp > 0) {
        var p = stack[--sp];
        area++;
        var x = p % w, y = (p / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          var rowBase = ny * w;
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var q = rowBase + nx;
            if (mask[q] && !label[q]) {
              label[q] = id;
              stack[sp++] = q;
            }
          }
        }
      }

      if (area > bestArea) {
        bestArea = area; bestId = id;
        bestMinX = minX; bestMaxX = maxX; bestMinY = minY; bestMaxY = maxY;
      }
    }

    if (!bestId) return null;

    var comp = new Uint8Array(n);
    for (var i = 0; i < n; i++) if (label[i] === bestId) comp[i] = 1;

    return {
      mask: comp, area: bestArea,
      minX: bestMinX, maxX: bestMaxX, minY: bestMinY, maxY: bestMaxY
    };
  }

  /* ================= 分区与障碍 ================= */

  /**
   * 列出所有面积 ≥ minArea 的 8-邻域连通域（按面积降序，最多 maxCount 个）。
   * 用于障碍检测：跑道面内的非跑道色块。
   */
  function findComponents(mask, w, h, minArea, maxCount) {
    var n = w * h;
    var label = new Int32Array(n);
    var stack = new Int32Array(n);
    var out = [];
    var id = 0;

    for (var s = 0; s < n; s++) {
      if (!mask[s] || label[s]) continue;
      id++;
      var sp = 0;
      stack[sp++] = s;
      label[s] = id;
      var area = 0, minX = w, maxX = -1, minY = h, maxY = -1;

      while (sp > 0) {
        var p = stack[--sp];
        area++;
        var x = p % w, y = (p / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          var rowBase = ny * w;
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var q = rowBase + nx;
            if (mask[q] && !label[q]) { label[q] = id; stack[sp++] = q; }
          }
        }
      }
      if (area >= minArea) out.push({ id: id, area: area, minX: minX, maxX: maxX, minY: minY, maxY: maxY });
    }
    out.sort(function (a, b) { return b.area - a.area; });
    return out.slice(0, maxCount || 3);
  }

  /**
   * 取指定横向带内跑道左右边界的中位数。
   * 'near' = 脚前（判断当前位置），'far' = 远处（判断漂移趋势）。
   * 边界被画面裁剪的行会被排除；排除后不足 3 行则判定该带不可知。
   */
  function bandEdges(rowL, rowR, w, h, cfg, which) {
    var yA, yB;
    if (which === 'far') {
      yA = Math.floor(h * (cfg.farTop === undefined ? 0.28 : cfg.farTop));
      yB = Math.floor(h * (cfg.farBottom === undefined ? 0.55 : cfg.farBottom));
    } else {
      yA = Math.floor(h * (cfg.nearTop === undefined ? 0.70 : cfg.nearTop));
      yB = Math.floor(h * (cfg.nearBottom === undefined ? 0.98 : cfg.nearBottom));
    }
    var ls = [], rs = [], lsIn = [], rsIn = [];
    for (var y = yA; y < yB; y++) {
      if (rowL[y] < 0) continue;
      ls.push(rowL[y]); rs.push(rowR[y]);
      if (rowL[y] > 1 && rowR[y] < w - 2) { lsIn.push(rowL[y]); rsIn.push(rowR[y]); }
    }
    var useL = lsIn.length >= 3 ? lsIn : ls;
    var useR = lsIn.length >= 3 ? rsIn : rs;
    if (useL.length < 3) return { ok: false, L: 0, R: w - 1, clipped: true };
    useL.sort(function (a, b) { return a - b; });
    useR.sort(function (a, b) { return a - b; });
    return {
      ok: true,
      L: useL[useL.length >> 1],
      R: useR[useR.length >> 1],
      clipped: lsIn.length < 3
    };
  }

  /**
   * 障碍检测：跑道面内（行边界之内、离边界 2px 以上）的非跑道色连通块。
   * 能覆盖：人影、衣物、水坑、跑道上的杂物。
   * 不能区分类型，也不能测距 —— 只提示"前方有占用物"。
   */
  function findHoles(redUnion, rowL, rowR, w, h, cfg) {
    var yA = Math.floor(h * (cfg.obsTop === undefined ? 0.30 : cfg.obsTop));
    var yB = Math.floor(h * (cfg.obsBottom === undefined ? 0.98 : cfg.obsBottom));
    var minArea = Math.max(12, Math.round(w * h * (cfg.obsMinArea === undefined ? 0.004 : cfg.obsMinArea)));
    var hole = new Uint8Array(w * h);

    for (var y = yA; y < yB; y++) {
      if (rowL[y] < 0) continue;
      var base = y * w;
      var from = rowL[y] + 2, to = rowR[y] - 2;
      for (var x = from; x <= to; x++) {
        if (!redUnion[base + x]) hole[base + x] = 1;
      }
    }
    var comps = findComponents(hole, w, h, minArea, 3);
    var out = [];
    for (var i = 0; i < comps.length; i++) {
      var c = comps[i];
      out.push({
        area: c.area,
        cx: (c.minX + c.maxX) / 2,
        cy: (c.minY + c.maxY) / 2,
        x0: c.minX, x1: c.maxX, y0: c.minY, y1: c.maxY
      });
    }
    return out;
  }

  /* ================= 一维滤波 ================= */

  function smooth(arr, radius) {
    var n = arr.length;
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var sum = 0, cnt = 0;
      for (var k = -radius; k <= radius; k++) {
        var j = i + k;
        if (j >= 0 && j < n) { sum += arr[j]; cnt++; }
      }
      out[i] = sum / cnt;
    }
    return out;
  }

  function findPeaks(hist, minAbs, minRel) {
    var n = hist.length;
    var maxVal = 0;
    for (var i = 0; i < n; i++) if (hist[i] > maxVal) maxVal = hist[i];
    if (maxVal < minAbs) return [];

    var peaks = [];
    for (var x = 1; x < n - 1; x++) {
      var v = hist[x];
      if (v >= hist[x - 1] && v > hist[x + 1] && v >= maxVal * minRel) {
        peaks.push({ x: x, value: v });
      }
    }
    var merged = [];
    for (var p = 0; p < peaks.length; p++) {
      var last = merged[merged.length - 1];
      if (last && peaks[p].x - last.x <= 4) {
        if (peaks[p].value > last.value) merged[merged.length - 1] = peaks[p];
      } else {
        merged.push(peaks[p]);
      }
    }
    merged.sort(function (a, b) { return b.value - a.value; });
    return merged;
  }

  /* ================= 直线拟合 ================= */

  /**
   * 最小二乘拟合 x = a*y + b，返回 {a, b, rms, n}；残差由调用方判定是否接受
   */
  function fitLine(pts) {
    var n = pts.length;
    if (n < 3) return null;
    var sy = 0, sx = 0, syy = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      var y = pts[i][0], x = pts[i][1];
      sy += y; sx += x; syy += y * y; sxy += y * x;
    }
    var den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-6) return null;
    var a = (n * sxy - sy * sx) / den;
    var b = (sx - a * sy) / n;

    var se = 0;
    for (var j = 0; j < n; j++) {
      var e = pts[j][1] - (a * pts[j][0] + b);
      se += e * e;
    }
    return { a: a, b: b, rms: Math.sqrt(se / n), n: n };
  }

  /* ================= 主分析 ================= */

  function analyze(imgData, cfg) {
    var w = imgData.width, h = imgData.height;
    var data = imgData.data;
    var centerX = w / 2;

    var y0 = Math.max(0, Math.floor(h * cfg.bandTop));
    var y1 = Math.min(h, Math.floor(h * cfg.bandBottom));
    var bandRows = Math.max(1, y1 - y0);

    var m = buildMasks(data, w, h, cfg);
    // 去孤立白点（相机噪声/颗粒反光）；cfg.erodeWhite 供消融测试关闭
    var whiteE = cfg.erodeWhite === false ? m.white : erodeWhite(m.white, w, h);
    var coverage = m.redCount / (w * h);

    var result = {
      ok: false, mode: 'none',
      coverage: coverage, p: 0.5, left: 0, right: 0,
      confidence: 0, centerX: centerX,
      bandY0: y0, bandY1: y1, width: w, height: h,
      red: m.red, white: m.white, track: null,
      lines: [], rowL: null, rowR: null, curve: false, viaFlood: false, clipped: false,
      trend: 0, obstacles: [], near: null, far: null,
      diag: { area: 0, bandCoverage: 0, widen: 0, shape: 0, lineScore: 0, edgeRms: 0 }
    };

    if (coverage < cfg.minCoverage) return result;

    /* ---- 1. 跑道区域：优先「从脚底向上泛洪」，失败再退回最大连通域 ---- */
    // 夜间泛光灯下跑道局部过曝变白、白色分道线本身也是白的：
    // 把白色像素并入跑道掩膜，避免跑道被过曝带拦腰切断。
    // 云、白墙若不与脚下跑道连通，泛洪不会波及。
    var n2 = w * h;
    var redUnion = new Uint8Array(n2);
    for (var i2 = 0; i2 < n2; i2++) redUnion[i2] = m.red[i2] | m.white[i2];

    var rad = (cfg.closeRadius === undefined) ? 3 : cfg.closeRadius;
    var closed = rad > 0 ? closeHorizontal(redUnion, w, h, rad) : redUnion;
    var viaFlood = false;
    var comp = floodFromBottom(closed, w, h);
    if (comp) viaFlood = true;
    else comp = largestComponent(closed, w, h);
    result.viaFlood = viaFlood;
    if (!comp) return result;

    var minPixels = Math.max(200, (w * h) * (cfg.minTrackPixels || 0.02));
    if (comp.area < minPixels) return result;

    result.track = comp;
    result.diag.area = comp.area;

    /* ---- 2. 每行左右边界 ---- */
    var rowL = new Int32Array(h), rowR = new Int32Array(h);
    rowL.fill(-1); rowR.fill(-1);
    for (var y = 0; y < h; y++) {
      var base = y * w, l = -1, r = -1;
      for (var x = 0; x < w; x++) {
        if (comp.mask[base + x]) { if (l < 0) l = x; r = x; }
      }
      rowL[y] = l; rowR[y] = r;
    }
    result.rowL = rowL; result.rowR = rowR;

    /* ---- 3. 形状校验 ---- */
    var rowsWithTrack = 0, sumW = 0;
    for (var yy = y0; yy < y1; yy++) {
      if (rowL[yy] >= 0) { rowsWithTrack++; sumW += (rowR[yy] - rowL[yy] + 1); }
    }
    var bandCov = rowsWithTrack / bandRows;
    var topW = rowL[y0] >= 0 ? (rowR[y0] - rowL[y0] + 1) : 0;
    var botW = rowL[y1 - 1] >= 0 ? (rowR[y1 - 1] - rowL[y1 - 1] + 1) : 0;
    var widen = botW / Math.max(1, topW);
    var touchBottom = comp.maxY >= h - Math.max(2, Math.round(h * 0.04));

    var sCover = clamp01(bandCov / 0.85);
    var sWiden = clamp01((widen - 0.8) / 0.6);
    var sTouch = touchBottom ? 1 : 0.4;
    var shape = 0.45 * sCover + 0.30 * sWiden + 0.25 * sTouch;

    // 跑道必须延伸到画面下方 1/4 区域：人在跑道上时，脚前必然是跑道。
    // 若红色只出现在画面中上部（远处跑道），说明近前没有跑道 —— 极不可信。
    var deepEnough = comp.maxY >= h * 0.75;

    result.diag.bandCoverage = bandCov;
    result.diag.widen = widen;
    result.diag.shape = shape;

    /* ---- 4. 分道线：只认「跑道行区间内、行连续、能拟合成直线」的白像素 ---- */
    var tol = Math.max(2, Math.round(w * 0.015));
    var rowsWhite = new Array(bandRows);
    var whiteCol = new Int32Array(w);

    for (var yb = 0; yb < bandRows; yb++) {
      var yr = y0 + yb;
      if (rowL[yr] < 0) { rowsWhite[yb] = null; continue; }
      var rb = yr * w;
      var xs = [];
      var from = Math.max(0, rowL[yr] - tol);
      var to = Math.min(w - 1, rowR[yr] + tol);
      for (var xx = from; xx <= to; xx++) {
        if (whiteE[rb + xx]) { xs.push(xx); whiteCol[xx]++; }
      }
      rowsWhite[yb] = xs;
    }

    var whiteSmooth = smooth(whiteCol, 2);
    var peaks = findPeaks(whiteSmooth, bandRows * 0.18, 0.30);

    var maxDrift = Math.max(3, Math.round(w * 0.06));
    var candidates = [];
    for (var pi = 0; pi < peaks.length && candidates.length < 8; pi++) {
      var cx = peaks[pi].x;
      var pts = [];
      var hitRows = 0;
      for (var k2 = 0; k2 < bandRows; k2++) {
        var arr = rowsWhite[k2];
        if (!arr || !arr.length) continue;
        var bestD = 1e9, bestX = -1;
        for (var t = 0; t < arr.length; t++) {
          var dd = Math.abs(arr[t] - cx);
          if (dd < bestD) { bestD = dd; bestX = arr[t]; }
        }
        if (bestX >= 0 && bestD <= maxDrift) {
          pts.push([y0 + k2, bestX]);
          hitRows++;
        }
      }
      if (!pts.length) continue;
      var ratio = hitRows / bandRows;
      if (ratio < (cfg.lineMinRowRatio || 0.5)) continue;

      var fit = fitLine(pts);
      if (!fit) continue;
      if (fit.rms > (cfg.lineMaxRms || 2.6)) continue;

      candidates.push({
        a: fit.a, b: fit.b, rms: fit.rms,
        ratio: ratio, hits: hitRows, strength: ratio * hitRows
      });
    }

    // 去重：同一条线可能被相邻峰值列重复检出
    var yMid = (y0 + y1) / 2;
    candidates.sort(function (p1, p2) { return p2.strength - p1.strength; });
    var lines = [];
    for (var ci = 0; ci < candidates.length; ci++) {
      var c = candidates[ci];
      var xm = c.a * yMid + c.b;
      var dup = false;
      for (var li = 0; li < lines.length; li++) {
        if (Math.abs(lines[li].xm - xm) <= Math.max(3, w * 0.03)) { dup = true; break; }
      }
      if (!dup) { c.xm = xm; lines.push(c); }
    }
    result.lines = lines;

    /* ---- 5. 走廊 ---- */
    var left = null, right = null;
    for (var q2 = 0; q2 < lines.length; q2++) {
      var ln = lines[q2];
      if (ln.xm < centerX - 2 && left === null) left = ln;
      else if (ln.xm > centerX + 2 && right === null) right = ln;
    }

    var minSpan = w * 0.08;
    result.diag.lineScore = (left && right) ? 1 : ((left || right) ? 0.6 : 0.35);

    if (left && right && (right.xm - left.xm) >= minSpan) {
      result.ok = true;
      result.mode = 'lines';
      result.left = left.xm;
      result.right = right.xm;
      result.p = (centerX - left.xm) / (right.xm - left.xm);
    } else if (left && right) {
      // 两条线过于靠近，不可信 —— 落到边界方案
      result.diag.lineScore = 0.5;
    }

    if (!result.ok) {
      // 退化：用近带（脚前）的行边界。
      // rowL=0 / rowR=w-1 的行说明该侧边界已跑出画面，把裁剪边界当真边界会
      // 得出完全错误的位置（真实事故来源）；带内不可知时直接不判定。
      var nb = bandEdges(rowL, rowR, w, h, cfg, 'near');
      result.clipped = nb.clipped;
      if (nb.ok && (nb.R - nb.L) >= minSpan) {
        result.ok = true;
        result.mode = 'edges';
        result.left = nb.L;
        result.right = nb.R;
        result.p = (centerX - nb.L) / (nb.R - nb.L);
      }
    }
    if (!result.ok) return result;

    /* ---- 5b. 整幅画面都用上：近带定位 + 远带前瞻 ---- */
    var nearB = bandEdges(rowL, rowR, w, h, cfg, 'near');
    var farB = bandEdges(rowL, rowR, w, h, cfg, 'far');
    result.near = {
      ok: nearB.ok, left: nearB.L, right: nearB.R, clipped: nearB.clipped,
      p: nearB.ok ? (centerX - nearB.L) / (nearB.R - nearB.L) : 0.5
    };
    result.far = {
      ok: farB.ok, left: farB.L, right: farB.R, clipped: farB.clipped,
      p: farB.ok ? (centerX - farB.L) / (farB.R - farB.L) : 0.5,
      centerOffset: 0
    };

    // 前瞻趋势：远处跑道中心相对画面中心的横向偏移率（归一化到画面宽度）。
    // 远处跑道偏右 → 沿当前方向直行会相对跑道偏左 → 提示往右。
    if (farB.ok) {
      var farC = (farB.L + farB.R) / 2;
      result.trend = (farC - centerX) / w;
      result.far.centerOffset = result.trend;
    }

    /* ---- 5c. 障碍检测：跑道面内的非跑道色连通块 ---- */
    result.obstacles = cfg.obstacleDetect === false
      ? [] : findHoles(redUnion, rowL, rowR, w, h, cfg);

    /* ---- 6. 弯道检测（信息提示，不改变方向判定）---- */
    // 用整个检测带：弯道的弯曲在上部（远处）更明显，下半段近似直线。
    var ptsL = [], ptsR = [];
    for (var yc = y0; yc < y1; yc++) {
      if (rowL[yc] > 1 && rowR[yc] < w - 2) { ptsL.push([yc, rowL[yc]]); ptsR.push([yc, rowR[yc]]); }
    }
    var fitEdgeL = ptsL.length >= 5 ? fitLine(ptsL) : null;
    var fitEdgeR = ptsR.length >= 5 ? fitLine(ptsR) : null;
    var edgeRms = Math.max(fitEdgeL ? fitEdgeL.rms : 0, fitEdgeR ? fitEdgeR.rms : 0);
    result.curve = edgeRms > 3.0;
    result.diag.edgeRms = edgeRms;

    /* ---- 7. 置信度 ---- */
    var covScore = clamp01(coverage / 0.35);
    var conf = 0.30 * covScore + 0.40 * shape + 0.30 * result.diag.lineScore;
    if (!deepEnough) conf *= 0.35;      // 红色只出现在画面中上部：人多半已不在跑道上
    if (coverage > 0.85) conf *= 0.5;   // 几乎全屏红：镜头被遮挡或贴地，不可信
    if (result.clipped) conf *= 0.6;    // 边界被画面裁剪：位置估计先天不可靠
    result.confidence = clamp01(conf);

    // p 允许超出 [0,1]，由上层判断危险程度
    return result;
  }

  /* ================= 跟踪器 ================= */

  /**
   * Alpha-Beta 滤波 + 残差门控 + 持续帧投票。
   * 目的：单帧噪声、手持晃动、短暂遮挡都不会触发报警。
   */
  function Tracker() {
    this.reset();
  }

  Tracker.prototype.reset = function () {
    this.p = 0.5;
    this.vp = 0;
    this.width = 0.5;
    this.ready = false;
    this.conf = 0;
    this.sameDir = 0;
    this.lastSign = 0;
    this.dirStartP = 0.5;   // 本次同方向运动开始时的位置，用于算净位移
    this.anomaly = 0;
    this.miss = 0;
  };

  /**
   * @param {object} res analyze() 的结果
   * @param {object} cfg 需含 gate(残差门限) / maxSpeed
   */
  Tracker.prototype.update = function (res, cfg) {
    var gate = cfg.gate || 0.28;
    var maxSpeed = cfg.maxSpeed || 0.06;

    if (!res.ok) {
      this.miss++;
      this.conf *= 0.82;
      this.p += this.vp;   // 短暂丢失时按速度外推
      this.sameDir = 0;
      this.lastSign = 0;
      if (this.miss > 12) this.ready = false;
      return this.state();
    }

    this.miss = 0;
    var z = res.p;
    var zw = (res.right - res.left) / res.width;

    if (!this.ready) {
      this.p = z; this.width = zw; this.vp = 0;
      this.conf = res.confidence;
      this.ready = true;
    } else {
      var pred = this.p + this.vp;
      var r = z - pred;
      if (Math.abs(r) > gate) {
        // 跳变过大：视为噪声，不修正；连续三次则重新锁定
        this.anomaly++;
        if (this.anomaly >= 3) { this.p = z; this.vp = 0; this.anomaly = 0; }
      } else {
        this.anomaly = 0;
        var alpha = 0.35, beta = 0.06;
        this.p = pred + alpha * r;
        this.vp += beta * r;
        if (this.vp > maxSpeed) this.vp = maxSpeed;
        if (this.vp < -maxSpeed) this.vp = -maxSpeed;
      }
      this.width = this.width * 0.7 + zw * 0.3;
      this.conf = this.conf * 0.6 + res.confidence * 0.4;
    }

    // 速度外推期间不参与方向统计，避免把"跟丢"当成偏移
    var d = this.p - 0.5;
    var sign = Math.abs(d) < 0.04 ? 0 : (d > 0 ? 1 : -1);
    if (sign !== 0 && sign === this.lastSign) {
      this.sameDir++;
    } else {
      this.sameDir = sign !== 0 ? 1 : 0;
      this.dirStartP = this.p;   // 方向变了，重新开始累计净位移
    }
    this.lastSign = sign;

    return this.state();
  };

  Tracker.prototype.state = function () {
    return {
      p: this.p, width: this.width, vp: this.vp,
      conf: this.conf, sameDir: this.sameDir, miss: this.miss,
      drift: Math.abs(this.p - this.dirStartP)
    };
  };

  /* ================= 调试渲染 ================= */

  function renderMaskImage(ctx, result) {
    if (!result || !result.red) return;
    var w = result.width, h = result.height;
    var out = ctx.createImageData(w, h);
    var d = out.data;
    var red = result.red, white = result.white, track = result.track;

    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      if (white[i]) { d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = 255; }
      else if (track && track.mask[i]) { d[p] = 255; d[p + 1] = 40; d[p + 2] = 60; d[p + 3] = 255; }
      else if (red[i]) { d[p] = 120; d[p + 1] = 30; d[p + 2] = 34; d[p + 3] = 255; }
      else { d[p] = 18; d[p + 1] = 20; d[p + 2] = 26; d[p + 3] = 255; }
    }
    ctx.putImageData(out, 0, 0);
  }

  TLG.cv = {
    rgbToHsv: rgbToHsv,
    hueDist: hueDist,
    analyze: analyze,
    renderMaskImage: renderMaskImage,
    Tracker: Tracker,
    _internal: {
      largestComponent: largestComponent, fitLine: fitLine,
      floodFromBottom: floodFromBottom, findComponents: findComponents,
      bandEdges: bandEdges, findHoles: findHoles
    }
  };
})(window);

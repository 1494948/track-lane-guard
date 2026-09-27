/*
 * cv.js —— 跑道识别核心算法（纯自研实现，无任何第三方源码拷贝）
 *
 * 算法流程（每帧）：
 *   1. 降采样到低分辨率工作画布（默认 192x108），降低算力消耗
 *   2. RGB -> HSV（采用 OpenCV 惯例：H∈[0,180), S∈[0,255], V∈[0,255]）
 *   3. 色相环形距离阈值分割，提取"红色跑道面"掩膜
 *   4. 独立提取"白色分道线"掩膜（低饱和 + 高亮）
 *      —— 注意：白线饱和度为 0，不会落入红色掩膜，必须独立统计，
 *         再用"该列附近存在跑道"约束掉画面里的其它白色物体
 *   5. 近景带内做列直方图，峰值检测得到左右两条分道线
 *      若分道线不可见（磨损/逆光），退化为跑道面左右边界
 *   6. 计算使用者在跑道内的相对位置 p，p=0.5 为居中
 *
 * 参考的公开算法思想（仅思想，未复用任何代码）：
 *   - HSV 颜色阈值分割（经典计算机视觉方法）
 *   - 车道线列直方图峰值检测（Murtaza's Workshop 系列教程中的思路）
 *   - 以列直方图峰值替代 Hough 直线变换，算力更低，适合手机 WebView
 *   详见仓库根目录 THIRD-PARTY-NOTICES.md
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});

  /* ---------- 颜色空间 ---------- */

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

  /* ---------- 掩膜生成 ---------- */

  /**
   * 一趟扫描生成三个产物：
   *   red[]     跑道面掩膜
   *   white[]   分道线掩膜（与 red 独立，否则白线因饱和度为 0 会被漏掉）
   *   redCol[]  检测带内每列的跑道像素数
   */
  function buildMasks(data, w, h, cfg, y0, y1) {
    var n = w * h;
    var red = new Uint8Array(n);
    var white = new Uint8Array(n);
    var redCol = new Int32Array(w);
    var redCount = 0;

    var hc = cfg.hueCenter;
    var hw = cfg.hueWidth;
    var sMin = cfg.satMin;
    var vMin = cfg.valMin;
    var lineSatMax = cfg.lineSatMax;
    var lineValMin = cfg.lineValMin;

    for (var y = 0; y < h; y++) {
      var rowOff = y * w;
      var inBand = (y >= y0 && y < y1);
      for (var x = 0; x < w; x++) {
        var i = rowOff + x;
        var p = i * 4;
        var hsv = rgbToHsv(data[p], data[p + 1], data[p + 2]);
        var H = hsv[0], S = hsv[1], V = hsv[2];

        if (hueDist(H, hc) <= hw && S >= sMin && V >= vMin) {
          red[i] = 1;
          redCount++;
          if (inBand) redCol[x]++;
        }
        // 分道线：低饱和 + 高亮（不要求它落在红色掩膜内）
        if (S <= lineSatMax && V >= lineValMin) white[i] = 1;
      }
    }
    return { red: red, white: white, redCol: redCol, redCount: redCount };
  }

  /* ---------- 一维滤波 ---------- */

  // 盒式均值平滑
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

  // 最大值滤波（膨胀）：填掉分道线造成的列统计空洞
  function dilate(arr, radius) {
    var n = arr.length;
    var out = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      var m = 0;
      for (var k = -radius; k <= radius; k++) {
        var j = i + k;
        if (j >= 0 && j < n && arr[j] > m) m = arr[j];
      }
      out[i] = m;
    }
    return out;
  }

  /**
   * 峰值检测：返回按峰值强度降序排列的候选 {x, value}
   */
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
    // 合并距离过近的峰（同一条线的抖动）
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

  /**
   * 从跑道列直方图中找出包含（或最接近）画面中心的连续跑道段
   */
  function findTrackSpan(redSpanHist, w, centerX) {
    var maxVal = 0;
    for (var i = 0; i < w; i++) if (redSpanHist[i] > maxVal) maxVal = redSpanHist[i];
    var thr = Math.max(1, maxVal * 0.35);

    var spans = [], start = -1;
    for (var x = 0; x < w; x++) {
      if (redSpanHist[x] >= thr) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        spans.push([start, x - 1]);
        start = -1;
      }
    }
    if (start >= 0) spans.push([start, w - 1]);
    if (!spans.length) return null;

    // 优先覆盖画面中心的段；否则选离中心最近且最宽的段
    var best = null, bestScore = -Infinity;
    for (var s = 0; s < spans.length; s++) {
      var a = spans[s][0], b = spans[s][1];
      var contains = centerX >= a && centerX <= b;
      var dist = centerX < a ? a - centerX : (centerX > b ? centerX - b : 0);
      var score = (contains ? 10000 : 0) - dist * 10 + (b - a);
      if (score > bestScore) { bestScore = score; best = spans[s]; }
    }
    return best;
  }

  /* ---------- 主分析 ---------- */

  /**
   * 分析一帧
   * @param {ImageData} imgData 已降采样的 RGBA 数据
   * @param {object} cfg 配置
   * @returns {object} 分析结果
   */
  function analyze(imgData, cfg) {
    var w = imgData.width, h = imgData.height;
    var data = imgData.data;
    var centerX = w / 2;

    // 检测带：默认取画面 50%~92% 高度（近景带，分道线最清晰）
    var y0 = Math.max(0, Math.floor(h * cfg.bandTop));
    var y1 = Math.min(h, Math.floor(h * cfg.bandBottom));
    var bandRows = Math.max(1, y1 - y0);

    var masks = buildMasks(data, w, h, cfg, y0, y1);
    var coverage = masks.redCount / (w * h);

    var result = {
      ok: false,
      mode: 'none',
      coverage: coverage,
      p: 0.5,
      left: 0,
      right: 0,
      centerX: centerX,
      bandY0: y0,
      bandY1: y1,
      width: w,
      height: h,
      red: masks.red,
      white: masks.white
    };

    if (coverage < cfg.minCoverage) return result; // 未检测到跑道

    // --- 方案 A：白色分道线 ---
    // 只统计"附近确实有跑道"的白色列，避免把天空/衣服/跑道外的白物当成分道线
    var redNear = dilate(masks.redCol, 5);
    var need = Math.max(2, Math.round(bandRows * 0.20));
    var whiteCol = new Int32Array(w);
    for (var y = y0; y < y1; y++) {
      var rowOff = y * w;
      for (var x = 0; x < w; x++) {
        if (masks.white[rowOff + x] && redNear[x] >= need) whiteCol[x]++;
      }
    }

    var whiteSmooth = smooth(whiteCol, 2);
    var peaks = findPeaks(whiteSmooth, bandRows * 0.22, 0.35);

    var leftLine = null, rightLine = null;
    for (var i = 0; i < peaks.length && (leftLine === null || rightLine === null); i++) {
      var px = peaks[i].x;
      if (px < centerX - 2 && leftLine === null) leftLine = px;
      else if (px > centerX + 2 && rightLine === null) rightLine = px;
    }

    if (leftLine !== null && rightLine !== null && rightLine - leftLine >= w * 0.08) {
      result.ok = true;
      result.mode = 'lines';
      result.left = leftLine;
      result.right = rightLine;
      result.p = (centerX - leftLine) / (rightLine - leftLine);
      return result;
    }

    // --- 方案 B：退化到跑道面左右边界 ---
    // 用膨胀后的列直方图，避免分道线把跑道切碎
    var span = findTrackSpan(redNear, w, centerX);
    if (!span) return result;

    var a = span[0], b = span[1];
    if (b - a < w * 0.12) return result; // 跑道太窄，判定不可靠

    result.ok = true;
    result.mode = 'edges';
    result.left = a;
    result.right = b;
    result.p = (centerX - a) / (b - a);
    return result;
  }

  /**
   * 生成调试用掩膜图（红=跑道面，白=分道线，其余暗色）
   */
  function renderMaskImage(ctx, result) {
    if (!result || !result.red) return;
    var w = result.width, h = result.height;
    var out = ctx.createImageData(w, h);
    var d = out.data;
    var red = result.red, white = result.white;
    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      if (white[i]) { d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = 255; }
      else if (red[i]) { d[p] = 255; d[p + 1] = 40; d[p + 2] = 60; d[p + 3] = 255; }
      else { d[p] = 18; d[p + 1] = 20; d[p + 2] = 26; d[p + 3] = 255; }
    }
    ctx.putImageData(out, 0, 0);
  }

  TLG.cv = {
    rgbToHsv: rgbToHsv,
    hueDist: hueDist,
    analyze: analyze,
    renderMaskImage: renderMaskImage
  };
})(window);

// 跑道颜色规则通路 —— 从 web/js/cv.js 的原生移植
//
// 保留它的理由：分割模型需要像素级标注数据，数据未到位前，
// 这条已在 18 个合成场景验证过的通路必须继续可用（见 NATIVE-ANDROID.md 任务一）。
//
// 流程：RGB → HSV 掩膜 → 水平闭运算 → 从底部泛洪取跑道域 → 每行左右边界
//       → 近带/远带中心 → 位置 p 与漂移趋势 trend
#include "track_rules.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace tlg {

static inline void rgb2hsv(unsigned char r, unsigned char g, unsigned char b,
                           float& h, float& s, float& v) {
  const float rf = r / 255.f, gf = g / 255.f, bf = b / 255.f;
  const float mx = std::max({rf, gf, bf});
  const float mn = std::min({rf, gf, bf});
  const float d = mx - mn;
  v = mx;
  s = mx > 0.f ? d / mx : 0.f;
  if (d <= 1e-6f) { h = 0.f; return; }
  if (mx == rf) h = 60.f * std::fmod((gf - bf) / d + 6.f, 6.f);
  else if (mx == gf) h = 60.f * ((bf - rf) / d + 2.f);
  else h = 60.f * ((rf - gf) / d + 4.f);
}

struct BandResult {
  bool ok = false;
  float left = 0, right = 0;    // 归一化 0..1
  float p = 0.5f;               // 0=在最左，1=在最右
};

static BandResult bandEdges(const std::vector<int>& rowL, const std::vector<int>& rowR,
                            int w, int h, float top, float bottom) {
  BandResult r;
  int y0 = (int)(h * top), y1 = (int)(h * bottom);
  std::vector<int> ls, rs, lsIn, rsIn;
  for (int y = y0; y < y1 && y < h; y++) {
    if (rowL[y] < 0) continue;
    ls.push_back(rowL[y]);
    rs.push_back(rowR[y]);
    if (rowL[y] > 1 && rowR[y] < w - 2) { lsIn.push_back(rowL[y]); rsIn.push_back(rowR[y]); }
  }
  std::vector<int>& useL = lsIn.size() >= 3 ? lsIn : ls;
  std::vector<int>& useR = rsIn.size() >= 3 ? rsIn : rs;
  if (useL.size() < 3) return r;
  std::sort(useL.begin(), useL.end());
  std::sort(useR.begin(), useR.end());
  r.ok = true;
  r.left = useL[useL.size() >> 1] / (float)w;
  r.right = useR[useR.size() >> 1] / (float)w;
  const float span = r.right - r.left;
  r.p = span > 0.02f ? (0.5f - r.left) / span : 0.5f;
  return r;
}

TrackState analyzeTrack(const unsigned char* rgb, int w, int h, const TrackConfig& cfg) {
  TrackState st;
  const size_t n = (size_t)w * h;

  // 1) HSV 掩膜：跑道红（色相中心 ± 容差，环形）+ 饱和度/亮度下限
  std::vector<unsigned char> mask(n, 0);
  const float hw = cfg.hue_width;
  const float satMin = cfg.sat_min / 255.f;
  const float valMin = cfg.val_min / 255.f;
  int redCount = 0;
  for (size_t i = 0; i < n; i++) {
    float hh, ss, vv;
    rgb2hsv(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], hh, ss, vv);
    float dh = std::fabs(hh - cfg.hue_center);
    if (dh > 180.f) dh = 360.f - dh;
    if (dh <= hw && ss >= satMin && vv >= valMin) {
      mask[i] = 1;
      redCount++;
    }
  }
  st.coverage = redCount / (float)n;
  if (st.coverage < cfg.min_coverage) return st;

  // 2) 水平闭运算（半径 close_radius）：连通被分道线/过曝切断的跑道
  if (cfg.close_radius > 0) {
    std::vector<unsigned char> tmp(n);
    const int R = cfg.close_radius;
    for (int y = 0; y < h; y++) {
      const unsigned char* row = &mask[(size_t)y * w];
      unsigned char* out = &tmp[(size_t)y * w];
      for (int x = 0; x < w; x++) {
        int lo = std::max(0, x - R), hi = std::min(w - 1, x + R);
        unsigned char v = 0;
        for (int k = lo; k <= hi; k++) v |= row[k];
        out[x] = v;
      }
    }
    mask.swap(tmp);
  }

  // 3) 从画面底部向上泛洪，取与脚下相连的跑道域（排除远处隔草坪的跑道）
  std::vector<unsigned char> track(n, 0);
  std::vector<int> stack;
  stack.reserve(n / 8);
  const int lastRow = h - 1;
  for (int x = 0; x < w; x++) {
    size_t idx = (size_t)lastRow * w + x;
    if (mask[idx] && !track[idx]) {
      track[idx] = 1;
      stack.push_back((int)idx);
    }
  }
  while (!stack.empty()) {
    int p = stack.back();
    stack.pop_back();
    int x = p % w, y = p / w;
    for (int dy = -1; dy <= 1; dy++) {
      int ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (int dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        int nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        size_t q = (size_t)ny * w + nx;
        if (mask[q] && !track[q]) { track[q] = 1; stack.push_back((int)q); }
      }
    }
  }

  // 4) 每行左右边界
  std::vector<int> rowL(h, -1), rowR(h, -1);
  for (int y = 0; y < h; y++) {
    const unsigned char* row = &track[(size_t)y * w];
    int l = -1, r = -1;
    for (int x = 0; x < w; x++) if (row[x]) { if (l < 0) l = x; r = x; }
    rowL[y] = l; rowR[y] = r;
  }

  // 5) 近带（脚下）与远带（前方）
  const BandResult near = bandEdges(rowL, rowR, w, h, cfg.near_top, cfg.near_bottom);
  const BandResult far = bandEdges(rowL, rowR, w, h, cfg.far_top, cfg.far_bottom);
  st.near_ok = near.ok;
  st.far_ok = far.ok;
  st.near_p = near.p;
  st.far_p = far.p;
  st.near_left = near.left;
  st.near_right = near.right;
  st.far_left = far.left;
  st.far_right = far.right;

  if (far.ok) {
    const float far_c = (far.left + far.right) * 0.5f;
    st.trend = (far_c - 0.5f);          // >0 表示前方跑道偏右 → 应往右
  }
  st.ok = near.ok;
  st.p = near.p;
  st.left = near.left;
  st.right = near.right;
  return st;
}

}  // namespace tlg

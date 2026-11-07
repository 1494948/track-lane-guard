// 跑道颜色规则通路（web/js/cv.js 的原生移植）
#pragma once

namespace tlg {

struct TrackConfig {
  int hue_center = 4;       // 跑道红色色相中心（OpenCV 尺度 0-180，此处用 0-360 度）
  int hue_width = 16;       // 色相容差（度）
  int sat_min = 55;         // 最小饱和度 0-255
  int val_min = 45;         // 最小亮度 0-255
  int close_radius = 4;     // 水平闭运算半径
  float min_coverage = 0.06f;
  float near_top = 0.68f, near_bottom = 0.98f;   // 近带（脚下）
  float far_top = 0.26f, far_bottom = 0.58f;     // 远带（前方）
};

struct TrackState {
  bool ok = false;
  float coverage = 0;
  float p = 0.5f;             // 0=跑道在最左，1=在最右；0.5=居中
  float left = 0, right = 0;
  float trend = 0;            // 远带中心相对画面中心的偏移；>0 表示前方偏右
  bool near_ok = false, far_ok = false;
  float near_p = 0.5f, far_p = 0.5f;
  float near_left = 0, near_right = 0;
  float far_left = 0, far_right = 0;
};

// rgb：RGB888，w*h*3 连续
TrackState analyzeTrack(const unsigned char* rgb, int w, int h, const TrackConfig& cfg);

}  // namespace tlg

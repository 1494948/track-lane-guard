// YOLO11 检测实现。要点：
//   1. letterbox 前处理在 C++ 侧完成，零拷贝构造 ncnn::Mat（不经过 Java Bitmap）
//   2. 输出解析兼容 Ultralytics 导出的 [1, 4+nc, N] 布局（已归一化）
//   3. NMS 后把坐标从 letterbox 空间还原到原图 0..1
#include "yolo11.h"

#include <net.h>
#include <gpu.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <sstream>

namespace tlg {

struct Yolo11::Impl {
  ncnn::Net net;
  ncnn::VulkanDevice* gpu = nullptr;
  int num_classes = 80;
  std::vector<std::string> names;
};

Yolo11::~Yolo11() {
  delete impl_;
  impl_ = nullptr;
}

bool Yolo11::load(const std::string& param_path, const std::string& bin_path,
                  const DetectConfig& cfg) {
  cfg_ = cfg;
  delete impl_;
  impl_ = new Impl();

  impl_->net.opt.use_vulkan_compute = cfg.use_gpu;
  impl_->net.opt.use_fp16_packed = true;
  impl_->net.opt.use_fp16_storage = false;
  impl_->net.opt.num_threads = cfg.threads;
  impl_->net.opt.lightmode = true;

  if (cfg.use_gpu) {
    impl_->gpu = ncnn::get_gpu_device();
    impl_->net.set_vulkan_device(impl_->gpu);
  }

  if (impl_->net.load_param(param_path.c_str()) != 0) return false;
  if (impl_->net.load_model(bin_path.c_str()) != 0) return false;

  // 类别数从 param 推断：output0 的通道数是 4+nc；这里直接跑一次前向更可靠，
  // 但为省一次推理开销，用 param 里 out 层的 bottom 参数不可得，改为首次推理时确定。
  impl_->num_classes = 80;

  if (!cfg.names.empty()) {
    std::string token;
    std::stringstream ss(cfg.names);
    while (std::getline(ss, token, ',')) {
      if (!token.empty()) impl_->names.push_back(token);
    }
  }
  if (impl_->names.empty()) {
    for (int i = 0; i < 80; i++) impl_->names.push_back(kCocoNames[i]);
  }
  return true;
}

static inline float sigmoid(float x) {
  return 1.f / (1.f + std::exp(-x));
}

std::vector<Box> Yolo11::detect(const unsigned char* rgb, int w, int h) {
  if (!impl_ || !rgb || w <= 0 || h <= 0) return {};

  const int S = cfg_.input_size;
  const float scale = std::min(S / (float)w, S / (float)h);
  const int nw = (int)std::lround(w * scale);
  const int nh = (int)(h * scale);
  const int pad_x = (S - nw) / 2;
  const int pad_y = (S - nh) / 2;

  // letterbox：等比缩放 + 灰边填充（114 是 Ultralytics 的 pad 值）
  ncnn::Mat in = ncnn::Mat(S, S, 3, (size_t)3u);
  in.fill(114.f);
  {
    // 最近邻缩放（YOLO 对缩放算法不敏感，且比双线性快）
    for (int y = 0; y < nh; y++) {
      const unsigned char* src_row = rgb + (size_t)(y / scale) * w * 3;
      float* dst = in.channel(0).row<float>(y + pad_y) + (pad_x * 3);
      for (int x = 0; x < nw; x++) {
        const unsigned char* p = src_row + (size_t)(x / scale) * 3;
        dst[x * 3 + 0] = p[0];
        dst[x * 3 + 1] = p[1];
        dst[x * 3 + 2] = p[2];
      }
    }
  }

  const float norm[3] = {1 / 255.f, 1 / 255.f, 1 / 255.f};
  in.substract_mean_normalize(nullptr, norm);

  ncnn::Extractor ex = impl_->net.create_extractor();
  ex.input("images", in);

  ncnn::Mat out;
  ex.extract("output0", out);

  // Ultralytics 导出布局：[1, 4+nc, N]，每列 [cx,cy,w,h,cls...]
  const int C = out.c;          // 4 + nc
  const int N = out.h;          // 锚点数
  const int nc = C - 4;
  impl_->num_classes = nc;

  struct Cand { float cx, cy, bw, bh, score; int cls; };
  std::vector<Cand> cands;
  cands.reserve(256);

  // ncnn::Mat 是 c*h*w 连续排布，channel(c) 返回该通道起始指针
  const float* p_cx = out.channel(0);
  const float* p_cy = out.channel(1);
  const float* p_bw = out.channel(2);
  const float* p_bh = out.channel(3);

  for (int i = 0; i < N; i++) {
    float best = 0.f;
    int best_c = 0;
    for (int c = 0; c < nc; c++) {
      float s = out.channel(4 + c)[i];
      if (s > best) { best = s; best_c = c; }
    }
    if (best < cfg_.conf_thr) continue;
    Cand c;
    c.cx = p_cx[i];
    c.cy = p_cy[i];
    c.bw = p_bw[i];
    c.bh = p_bh[i];
    c.score = best;
    c.cls = best_c;
    if (c.bw > 0 && c.bh > 0) cands.push_back(c);
  }

  std::sort(cands.begin(), cands.end(),
            [](const Cand& a, const Cand& b) { return a.score > b.score; });

  std::vector<Box> boxes;
  std::vector<bool> removed(cands.size(), false);
  for (size_t i = 0; i < cands.size(); i++) {
    if (removed[i]) continue;
    const Cand& a = cands[i];
    float ax0 = a.cx - a.bw / 2, ay0 = a.cy - a.bh / 2;
    float ax1 = a.cx + a.bw / 2, ay1 = a.cy + a.bh / 2;
    for (size_t j = i + 1; j < cands.size(); j++) {
      if (removed[j]) continue;
      const Cand& b = cands[j];
      if (b.cls != a.cls) continue;
      float bx0 = b.cx - b.bw / 2, by0 = b.cy - b.bh / 2;
      float bx1 = b.cx + b.bw / 2, by1 = b.cy + b.bh / 2;
      float ix = std::max(0.f, std::min(ax1, bx1) - std::max(ax0, bx0));
      float iy = std::max(0.f, std::min(ay1, by1) - std::max(ay0, by0));
      float inter = ix * iy;
      float uni = a.bw * a.bh + b.bw * b.bh - inter;
      if (uni > 0 && inter / uni > cfg_.iou_thr) removed[j] = true;
    }
    Box box;
    // 从 letterbox 归一化坐标还原到原图 0..1
    box.x0 = std::max(0.f, (a.cx - a.bw / 2 - pad_x / (float)S) / scale);
    box.x1 = std::min(1.f, (a.cx + a.bw / 2 - pad_x / (float)S) / scale);
    box.y0 = std::max(0.f, (a.cy - a.bh / 2 - pad_y / (float)S) / scale);
    box.y1 = std::min(1.f, (a.cy + a.bh / 2 + pad_y / (float)S) / scale);
    box.score = a.score;
    box.cls = a.cls;
    boxes.push_back(box);
  }
  return boxes;
}

}  // namespace tlg

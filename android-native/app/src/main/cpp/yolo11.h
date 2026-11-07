// YOLO11 / YOLOv8 检测器（ncnn 实现）
// 输入输出与 Ultralytics 导出的 ONNX 一致：
//   输入：images [1,3,H,W] float32，RGB，0~1
//   输出：output0 [1, 4+nc, N] float32，已按输入尺寸归一化
//        每列 = [cx, cy, w, h, cls0..clsN-1]
//
// 后处理在本文件内完成：阈值过滤 → NMS → 坐标从 letterbox 空间还原到原图 0..1
#pragma once
#include <string>
#include <vector>
#include <memory>

namespace tlg {

struct Box {
  float x0, y0, x1, y1;   // 归一化到 0..1（相对原图）
  float score;            // 最高类别得分
  int cls;                // 类别下标
};

struct DetectConfig {
  int input_size = 320;
  float conf_thr = 0.35f;
  float iou_thr = 0.45f;
  bool use_gpu = true;    // Vulkan，失败时自动降级 CPU
  int threads = 4;
  std::string names;      // 类别名，逗号或分号分隔；空则用内置 COCO 前 80 类
};

class Yolo11 {
public:
  ~Yolo11();

  // param/bin 路径来自 assets（先复制到可读路径再加载）
  bool load(const std::string& param_path, const std::string& bin_path,
            const DetectConfig& cfg);

  // img：RGB888，w x h 步长由调用方保证连续
  // 返回检测框（已还原到 0..1 坐标）
  std::vector<Box> detect(const unsigned char* rgb, int w, int h);

  const DetectConfig& config() const { return cfg_; }
  int last_ms() const { return last_ms_; }

private:
  struct Impl;
  Impl* impl_ = nullptr;
  DetectConfig cfg_;
  int last_ms_ = 0;
};

// COCO 80 类名，与 detector.js 中的表保持一致
const char* const kCocoNames[80] = {
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush"};

}  // namespace tlg

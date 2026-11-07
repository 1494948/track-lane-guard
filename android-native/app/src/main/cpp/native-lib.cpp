// JNI 入口：把 ncnn 推理与颜色规则通路暴露给 Kotlin
//
// 数据流（关键设计，见 NATIVE-ANDROID.md）：
//   CameraX ImageProxy(YUV_420_888) → Kotlin 取 DirectBuffer 指针
//     → 本文件做 YUV→RGB（零拷贝，不经过 Java Bitmap）
//     → 可选：规则通路（track_rules） + 模型通路（yolo11）
//     → 结果回传 Kotlin（纯数值，无像素）
#include <jni.h>
#include <android/log.h>

#include <vector>
#include <string>
#include <mutex>

#include "yolo11.h"
#include "track_rules.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "tlg-native", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "tlg-native", __VA_ARGS__)

namespace {
std::mutex g_mu;
tlg::Yolo11* g_yolo = nullptr;
tlg::DetectConfig g_detect_cfg;
tlg::TrackConfig g_track_cfg;
bool g_model_loaded = false;
int g_last_infer_ms = 0;
int g_last_track_ms = 0;
}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_xuzf_tlg_core_detect_NativeBridge_loadModel(
    JNIEnv* env, jobject /*thiz*/, jstring paramPath, jstring binPath,
    jint inputSize, jfloat confThr, jfloat iouThr, jboolean useGpu, jint threads) {
  const char* p = env->GetStringUTFChars(paramPath, nullptr);
  const char* b = env->GetStringUTFChars(binPath, nullptr);
  std::string param(p), bin(b);
  env->ReleaseStringUTFChars(paramPath, p);
  env->ReleaseStringUTFChars(binPath, b);

  std::lock_guard<std::mutex> lk(g_mu);
  delete g_yolo;
  g_yolo = new tlg::Yolo11();
  g_detect_cfg = tlg::DetectConfig{};
  g_detect_cfg.input_size = inputSize;
  g_detect_cfg.conf_thr = confThr;
  g_detect_cfg.iou_thr = iouThr;
  g_detect_cfg.use_gpu = useGpu;
  g_detect_cfg.threads = threads;

  const bool ok = g_yolo->load(param, bin, g_detect_cfg);
  if (!ok) {
    LOGE("模型加载失败: %s", param.c_str());
    delete g_yolo;
    g_yolo = nullptr;
    g_model_loaded = false;
    return JNI_FALSE;
  }
  g_model_loaded = true;
  LOGI("模型已加载，输入 %d，GPU=%d，线程 %d", inputSize, (int)useGpu, threads);
  return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_cn_xuzf_tlg_core_detect_NativeBridge_setTrackConfig(
    JNIEnv* env, jobject, jint hueCenter, jint hueWidth, jint satMin, jint valMin,
    jint closeRadius, jfloat minCoverage, jfloat nearTop, jfloat nearBottom,
    jfloat farTop, jfloat farBottom) {
  std::lock_guard<std::mutex> lk(g_mu);
  g_track_cfg = tlg::TrackConfig{};
  g_track_cfg.hue_center = hueCenter;
  g_track_cfg.hue_width = hueWidth;
  g_track_cfg.sat_min = satMin;
  g_track_cfg.val_min = valMin;
  g_track_cfg.close_radius = closeRadius;
  g_track_cfg.min_coverage = minCoverage;
  g_track_cfg.near_top = nearTop;
  g_track_cfg.near_bottom = nearBottom;
  g_track_cfg.far_top = farTop;
  g_track_cfg.far_bottom = farBottom;
}

extern "C" JNIEXPORT void JNICALL
Java_cn_xuzf_tlg_core_detect_NativeBridge_releaseModel(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lk(g_mu);
  delete g_yolo;
  g_yolo = nullptr;
  g_model_loaded = false;
}

// YUV_420_888（semi-planar / planar 均可）→ RGB888
static void yuvToRgb(const unsigned char* y, const unsigned char* u, const unsigned char* v,
                     int yRow, int uRow, int vRow, int w, int h,
                     int uPix, int vPix, unsigned char* rgb) {
  for (int j = 0; j < h; j++) {
    const unsigned char* yr = y + (size_t)j * yRow;
    const unsigned char* ur = u + (size_t)(j / 2) * uRow;
    const unsigned char* vr = v + (size_t)(j / 2) * vRow;
    unsigned char* out = rgb + (size_t)j * w * 3;
    for (int i = 0; i < w; i++) {
      int Y = yr[i] - 16;
      int U = ur[i / 2] - 128;
      int V = vr[i / 2] - 128;
      int R = (298 * Y + 409 * V + 128) >> 8;
      int G = (298 * Y - 100 * U - 208 * V + 128) >> 8;
      int B = (298 * Y + 516 * U + 128) >> 8;
      out[i * 3 + 0] = (unsigned char)std::min(255, std::max(0, R));
      out[i * 3 + 1] = (unsigned char)std::min(255, std::max(0, G));
      out[i * 3 + 2] = (unsigned char)std::min(255, std::max(0, B));
    }
  }
}

/**
 * 完整一帧处理。rgb 由 Kotlin 侧准备好的 RGB888 缓冲（已做 YUV→RGB）。
 * 之所以让 Kotlin 准备 RGB：CameraX 的 ImageProxy 平面指针只在 Java 侧可取，
 * 且各设备的 plane 排布差异大；取一次指针、在 native 里转一次最稳。
 * 返回 float[8]：
 *   [0] 模型是否产出框数量   [1..4] 主框 x0,y0,x1,y1  [5] 主框 score  [6] 主框 cls
 *   [7] 规则通路 p
 */
extern "C" JNIEXPORT jfloatArray JNICALL
Java_cn_xuzf_tlg_core_detect_NativeBridge_process(
    JNIEnv* env, jobject, jbyteArray rgbArray, jint w, jint h) {
  jbyte* buf = env->GetByteArrayElements(rgbArray, nullptr);
  const auto* rgb = reinterpret_cast<const unsigned char*>(buf);

  jfloatArray out = env->NewFloatArray(8);
  float res[8] = {0, 0, 0, 0, 0, 0, -1, 0.5f};

  {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_yolo && g_model_loaded) {
      auto t0 = std::chrono::steady_clock::now();
      auto boxes = g_yolo->detect(rgb, w, h);
      auto t1 = std::chrono::steady_clock::now();
      g_last_infer_ms = (int)std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
      if (!boxes.empty()) {
        const auto& b = boxes[0];
        res[0] = (float)boxes.size();
        res[1] = b.x0; res[2] = b.y0; res[3] = b.x1; res[4] = b.y1;
        res[5] = b.score; res[6] = (float)b.cls;
      }
    }
    auto s0 = std::chrono::steady_clock::now();
    tlg::TrackState st = tlg::analyzeTrack(rgb, w, h, g_track_cfg);
    auto s1 = std::chrono::steady_clock::now();
    g_last_track_ms = (int)std::chrono::duration_cast<std::chrono::milliseconds>(s1 - s0).count();
    res[7] = st.ok ? st.p : 0.5f;
  }

  env->ReleaseByteArrayElements(rgbArray, buf, JNI_ABORT);
  env->SetFloatArrayRegion(out, 0, 8, res);
  return out;
}

extern "C" JNIEXPORT jint JNICALL
Java_cn_xuzf_tlg_core_detect_NativeBridge_lastInferMs(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lk(g_mu);
  return g_last_infer_ms;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_xuzf_tlg_core_detect_NativeBridge_isModelLoaded(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> lk(g_mu);
  return g_model_loaded ? JNI_TRUE : JNI_FALSE;
}

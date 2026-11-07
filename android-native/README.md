# TrackLaneGuard 原生版（android-native）

纯原生 Android 实现：Kotlin + Jetpack Compose + NDK/C++（ncnn 推理）。
**不用 WebView、不联网、无任何 Web 资源。**

设计依据见仓库根目录 [`NATIVE-ANDROID.md`](../NATIVE-ANDROID.md)。

## 与 WebView 版的关系

| | WebView 版（仓库根） | 原生版（本目录） |
|---|---|---|
| 定位 | 在线演示 + **数据采集标注工具** | 正式使用的检测应用 |
| 技术 | Canvas + JS + ONNX Runtime Web | Kotlin + Compose + ncnn |
| 数据/模型规范 | `DATASET.md` / `DETECTION.md` | 共用同一套（不重复维护） |

两版共用同一份模型文件与数据规范，所以采集的数据能直接喂给原生版训练。

## 从零构建

```bat
REM 1. 装 NDK 与 CMake（只需一次）
tools\download_ndk.bat

REM 2. 拉取 ncnn 预编译库（约 20 MB，解压到 third_party/）
tools\download_ncnn.bat

REM 3. 构建 Debug APK
gradlew assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`（约 20 MB）。

### 本机（工作台）构建命令

本机 SDK/NDK/Gradle 在 `C:\AI Document\playground\android-toolchain`，已写进
`local.properties`（该文件已被 gitignore）。构建：

```bat
"C:\AI Document\playground\tlg-native-build\build.bat"
```

## 模型

把模型放到 `app/src/main/assets/models/`：

| 文件 | 说明 |
|---|---|
| `yolo11m.ncnn.param` + `.bin` | YOLO11m 检测模型（约 40 MB，包体不设限时用精度换体积） |

**没有模型也能运行** —— 会自动回退到颜色规则通路（跑道位置判定照常）。

转换模型见 `tools/convert_model.py`：

```bash
pip install ultralytics pnnx
python tools/convert_model.py yolo11m.pt
```

## 代码结构

```
app/src/main/
├── java/cn/xuzf/tlg/core/
│   ├── MainActivity.kt        Compose UI：相机预览 + 叠加层 + 设置
│   ├── camera/FrameAnalyzer.kt  CameraX 帧分析（丢帧策略、YUV→RGB）
│   ├── detect/NativeBridge.kt   JNI 桥接 + assets 模型落地
│   ├── alert/AlertManager.kt    AudioTrack 左右声像 + 震动
│   └── ui/Params.kt             参数体系（每项含中文说明）
└── cpp/
    ├── native-lib.cpp          JNI 入口、YUV→RGB、流程编排
    ├── yolo11.cpp/.h           YOLO11 检测（ncnn）
    └── track_rules.cpp/.h      跑道颜色规则（cv.js 原生移植）
```

## 关键设计

| 设计 | 原因 |
|---|---|
| YUV→RGB 在 native 侧完成 | 不在 Java 层建 Bitmap，省掉每帧大对象分配 |
| 推理与相机解耦，慢时丢帧 | 延迟不累积；`STRATEGY_KEEP_ONLY_LATEST` |
| 只出 `arm64-v8a` | 现代 Android 机均为 arm64，体积省约 60% |
| Vulkan 优先、CPU 兜底 | 老机型/驱动异常自动降级 |
| 模型缺失自动回退规则 | 没有模型文件时功能不残废 |
| 规则通路保留 | 分割模型数据未到位前，跑道判定仍可用 |

## 参数体系

设置里每个参数都是一张卡片，包含四行说明：

- **是什么**：这个参数控制什么
- **调大 →**：调大会发生什么
- **调小 →**：调小会发生什么
- **什么时候调**：遇到什么现象时该动它

另有「恢复推荐值」一键复位。

## 已知限制

- **未测距**：单目摄像头无法可靠判断距离，提示只说「前方有」
- **不能替代盲杖**：仅作辅助提示
- 模型类别为 COCO 80 类；影子/积水等需用 `DATASET.md` 的数据微调
- 本版未在真机验证（无设备）；构建与 APK 结构已验证

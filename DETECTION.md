# 识别方案升级 · 技术方案

> 结论先行：**跑道面用颜色规则继续跑，障碍物改用目标检测模型（YOLOv8n → ONNX → ONNX Runtime Web）**。
> 一个模型同时解决"有人"这个最迫切的需求，且模型缺失时自动回退现有规则，零风险。

## 一、运行环境约束（决定选型）

本项目前端同时跑在两个环境：**Android WebView**（APK）与**手机浏览器**（在线版）。
用户列的推理引擎按可用性分三类：

| 项目 | 形态 | 本项目可用性 |
|---|---|---|
| Ultralytics YOLOv5/YOLOv8 | 训练框架（Python） | **不直接部署**，但负责产出模型；可导出 ONNX / TFLite |
| TensorFlow Lite Model Garden | TFLite 预训练模型 | 可转 TF.js 或原生 TFLite，Web 侧需转换，体积偏大 |
| **ncnn**（腾讯） | C++ 推理引擎 | 有 Web/WASM 分支；APK 可走原生 JNI（需 NDK 构建） |
| **ONNX Runtime Mobile / Web** | 跨平台推理 | **Web 侧直接用**，是目前 WebView 里最省事的路径 |
| Core ML Tools | Apple 生态 | 不适用（本项目只发 Android/Web） |
| MNN（阿里） | C++ 推理引擎 | 有 Web/WASM 版，需自行编译，资料比 ONNX Runtime 少 |
| Paddle-Lite（百度） | C++ 移动端推理 | APK 可走原生；Web 无官方支持 |

**判断依据**：WebView 内没有 CUDA/OpenCL，只有 WASM（与较新设备的 WebGPU）。
所以模型必须选 **ONNX 格式 + ONNX Runtime Web**（后端可选 wasm 或 webgpu），
这是唯一"写一次、两端都能跑"的组合。ncnn/Paddle-Lite 的优势在 APK 原生侧，
但那要引入 NDK 与 JNI，构建复杂度陡增，留作后续 APK 专项优化，不在本版范围。

## 二、两个问题分开看（不要用一个模型硬扛）

本项目实际有两个独立的识别任务，混在一起谈会失焦：

### 任务一：跑道面在哪 —— 继续用颜色规则（本版不改）

| 方案 | 评价 |
|---|---|
| 现状（HSV 红色范围 + 连通域 + 近/远带） | 18 场景基准零误报零丢失，单帧 2.3 ms |
| 换分割模型（YOLOv8n-seg） | 理论上更抗光照与跑道颜色差异 |

**为什么本版不换**：分割模型需要**标注过的跑道图像**（跑道像素级掩膜），
而目前一份都没有。在拿到数据前换模型，等于用一个没验证过的东西替换一个已验证过的东西。
颜色规则的唯一短板是"非红色跑道"，而这个问题的真实频率需要用数据说话——
这正是 `DATASET.md` 让用户采跑道视频的原因。

**数据齐了之后的分割路线**（已写进路线图）：YOLOv8n-seg 微调 → ONNX → 同一套推理管线替换。

### 任务二：跑道上有什么 —— 改用目标检测模型（本版接入）

这是用户最想要的能力："有人/影子/水坑"。

**选 YOLOv8n（nano）的理由**：

| 维度 | YOLOv8n | EfficientDet-Lite0 | MobileNet SSD v2 |
|---|---|---|---|
| 参数量 | 3.2 M | 4.2 M | 4.1 M |
| ONNX 体积 | **~12 MB**（可再裁剪） | ~13 MB | ~14 MB |
| 单帧（手机 CPU，WASM） | 60~120 ms | 80~140 ms | 70~130 ms |
| COCO 预训练即含 `person` | ✅ | ✅ | ✅ |
| 自定义类别微调 | 文档最全 | 一般 | 一般 |

**关键点：COCO 预训练模型已经认识 `person`。**
也就是说**不需要任何训练数据，"前面有人"立刻可用**——
这比等数据攒够再动手有价值得多。自定义类别（影子/积水/杂物）等 `DATASET.md` 的数据到位后再微调。

**为什么不选 ncnn/MNN**：它们更快，但要么只服务 APK 原生（要 NDK），
要么 Web 侧需自行编译 WASM。先用 ONNX Runtime Web 把链路与融合逻辑跑通，
将来若要提速，**同一份 ONNX 模型可以直接喂给 ncnn**（ncnn 支持 ONNX 导入），
到时只需在 APK 侧加一层原生推理，Web 侧逻辑不用重写。这是选 ONNX 的核心原因：
**它是所有引擎的交集格式。**

## 三、架构：检测器抽象层

新增 `web/js/detector.js`，把"谁来给障碍框"抽象成可替换的一层：

```
        ┌──────────────────────────┐
        │   app.js（障碍提示逻辑）   │
        └────────────┬─────────────┘
                     │ 统一的障碍列表 [{cls, conf, box}]
        ┌────────────┴─────────────┐
        │      detector.js         │
        ├──────────────────────────┤
        │ model  : OnnxDetector    │ → ONNX Runtime Web（模型就位才启用）
        │ fallback: RuleDetector   │ → 现有颜色/孔洞规则（现状，零依赖）
        └──────────────────────────┘
```

**融合策略**（重要，避免模型与规则互相打架）：

1. 模型未加载 / 加载失败 / 推理超时 → **自动回退规则**，行为与现在完全一致
2. 模型加载成功 → 模型的障碍结果**优先**；规则结果作为补充（模型可能漏掉水坑这类非 COCO 类别）
3. 只有**置信度 ≥ 阈值**的模型结果才会变成"有人"这类具体类别提示；
   置信度不足时仍只说「前方有占用物」——**说错类别比不说更危险**
4. 模型与规则结果都出现时取**面积更大**的那个（近处目标更危险）

## 四、模型怎么来（三种途径，从易到难）

### 途径一：COCO 预训练 YOLOv8n（零数据，立刻可用）

```bash
pip install ultralytics
python -c "from ultralytics import YOLO; YOLO('yolov8n.pt').export(format='onnx', opset=12)"
# 得到 yolov8n.onnx，放进 web/models/
```

放进去后刷新页面，检测器会自动加载并在状态栏显示「模型已启用」。
此时 `person` / `backpack` / `bottle` / `chair` 等 80 类直接可用，
提示会从「前方有占用物」升级为「前方有人」。

### 途径二：用 DATASET.md 的数据微调（拿到真实数据后）

```bash
yolo detect train data=track-obstacles.yaml model=yolov8n.pt epochs=100 imgsz=320
yolo export model=runs/detect/train/weights/best.pt format=onnx
```

类别表：`person / shadow / water / debris / mark`。
`mark`（跑道自身痕迹）单独一类，让模型学会"这个不该报"。

### 途径三：分割模型换掉颜色规则（需要跑道标注数据）

```bash
yolo segment train data=track-seg.yaml model=yolov8n-seg.pt epochs=100 imgsz=320
```

路线图里标注为 **Phase 2**，等 `DATASET.md` 的视频数据到位再做。

## 五、代价与边界（必须说清）

| 项 | 影响 |
|---|---|
| APK 体积 | 550 KB → **约 13 MB**（模型进 assets；Web 版改为按需下载后缓存） |
| 首帧延迟 | 需下载/初始化模型（Web 版首次约 1-3 秒，之后走缓存） |
| 电量 | 每帧推理显著高于颜色规则；APK 上预计续航下降 30~50% |
| 帧率 | WASM 后端约 8~15 fps；WebGPU 后端可到 20+ fps |
| 低端机 | 老机型可能只能跑到 5 fps，届时自动降频或关闭模型 |

**结论**：模型是**可选的增强，不是替代**。默认配置为「模型存在才用，否则纯规则」，
使用者在设置里也能强制关掉。

## 六、本版实际交付

1. `web/js/detector.js` —— 检测器抽象层（ONNX 通路 + 规则回退 + 融合策略）
2. `web/models/` —— 模型放置目录，含 README 说明获取方式
3. 设置面板新增「识别引擎」：`自动` / `仅规则` / `仅模型`（自动=模型就位就用）
4. 状态栏在模型启用时显示「模型已启用」，加载中显示「模型加载中…」

**未交付（需要数据或额外构建）**：
- 模型文件本身（按上面途径一/二获取）
- APK 原生 ncnn 加速（需 NDK，留作后续专项）

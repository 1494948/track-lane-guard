# 模型放置目录

把检测模型放到这里，应用会自动启用；没有模型时**自动使用颜色规则**，功能不受影响。

## 快速开始（零数据，立刻能用）

```bash
pip install ultralytics
python -c "from ultralytics import YOLO; YOLO('yolov8n.pt').export(format='onnx', opset=12)"
cp yolov8n.onnx models/
```

刷新页面，状态栏会显示「模型已启用」。此时 `person`（人）、`backpack`、`bottle`
等 80 个 COCO 类别直接可用，障碍提示会从「前方有占用物」升级为「前方有人」。

## 命名要求

| 文件名 | 输入尺寸 | 说明 |
|---|---|---|
| `yolov8n.onnx` | 320×320 | YOLOv8 nano，约 12 MB，默认路径 |
| `yolov8n-640.onnx` | 640×640 | 精度更高、更慢，需在设置里改输入尺寸 |

模型必须是 **YOLOv8 导出格式**（输出 `[1, 4+类别数, 锚点数]`，已归一化）。
其它格式（TFLite、Paddle、ncnn 的 param/bin）本版不支持。

## 用真实数据训练自己的模型

采集数据的方式见根目录 [`DATASET.md`](../DATASET.md)。数据齐了之后：

```bash
yolo detect train data=track-obstacles.yaml model=yolov8n.pt epochs=100 imgsz=320
yolo export model=runs/detect/train/weights/best.pt format=onnx opset=12
cp runs/detect/train/weights/best.onnx models/yolov8n.onnx
```

训练后请同步修改 `web/js/detector.js` 里的 `COCO` 类别表为你自己的类别。

## 体积与性能参考

| 项 | 数值 |
|---|---|
| 模型体积 | 约 12 MB（进 APK 后总体积约 13 MB） |
| WASM 后端单帧 | 约 60~120 ms（8~15 fps） |
| WebGPU 后端单帧 | 约 20~40 ms（20+ fps，需较新设备） |
| 首帧前耗时 | Web 版首次需下载模型（1~3 秒），之后走缓存 |

不想用模型时，在设置里把「识别引擎」切到「仅规则」即可，行为与升级前完全一致。

## 为什么选 ONNX

ONNX 是 ncnn / MNN / Paddle-Lite / Core ML 都认的**交集格式**。
将来若要在 APK 里用原生 ncnn 提速，**同一份 `.onnx` 文件可以直接导入**，
Web 侧的逻辑不用重写。选型对比见 [`DETECTION.md`](../DETECTION.md)。

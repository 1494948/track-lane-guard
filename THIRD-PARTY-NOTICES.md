# 第三方与授权说明

## 结论先行

**本项目的识别算法为完全自研实现，没有复制、粘贴、改编任何第三方仓库的源代码。**
所有第三方成分只出现在「构建期依赖」和「参考过的公开算法思想」两类，且全部为 permissive 许可，
可自由用于本项目（包括闭源与商业分发）。

## 一、源码授权

| 文件 | 来源 | 许可 |
|---|---|---|
| `web/js/cv.js` | 自研 | MIT（本项目） |
| `web/js/audio.js` | 自研 | MIT（本项目） |
| `web/js/app.js` | 自研 | MIT（本项目） |
| `web/index.html`、`web/css/style.css`、`web/sw.js`、`web/manifest.webmanifest` | 自研 | MIT（本项目） |
| `android/app/src/main/java/cn/xuzf/tlg/MainActivity.java` | 自研 | MIT（本项目） |
| `web/icons/*`、`android/.../mipmap-*/ic_launcher.png` | 自研（脚本绘制） | MIT（本项目） |

未使用任何第三方字体、图标库、UI 框架或 JS 库；未引入 OpenCV.js 等运行时二进制，
以避免体积与许可合规复杂度——所需的 HSV 分割与直方图运算均为几十行量级的原生实现。

## 二、参考过的公开算法思想（仅思想，未复用代码）

算法思想本身不受版权保护；以下仓库仅用于确认工程实践中的参数经验，本项目未取用其任何代码：

| 参考对象 | 许可 | 借鉴内容 |
|---|---|---|
| 车道线检测的经典 OpenCV 流程（Canny + ROI + Hough） | 通用公开方法 | ROI 与近景带取法 |
| `Abhi-899/Lane-Detection`（阈值 → 透视变换 → 列直方图 → 平均 → 显示） | MIT | 「列直方图峰值定位车道线」的思路 |
| `RishabhSingh0907/LaneDetection` | MIT | HSV 阈值 + Hough 的组合方式参考 |
| `adithyapranav/Road-Lane-Detection` | MIT | 低算力设备上做实时车道检测的取舍 |

本项目与这些实现的关键差异：

1. 不做 Canny / Hough，改用**列直方图峰值**，算力从 ~10 ms 级降到 ~1 ms 级，适配手机 WebView；
2. 不做透视变换（需要标定相机内参与安装角度），改用**近景带 + 相对位置 p** 的免标定方案；
3. 增加了**分道线不可见时退化到跑道面边界**的兜底路径。

## 三、构建期依赖（不随 APK 分发，仅在本机编译时使用）

| 依赖 | 版本 | 许可 |
|---|---|---|
| Android Gradle Plugin | 8.5.2 | Apache-2.0（含 Google 附加条款，仅约束 Google Play 服务） |
| androidx.webkit:webkit | 1.8.0 | Apache-2.0（**随 APK 分发**，已在此声明） |
| Gradle | 8.7 | Apache-2.0 |
| Azul Zulu JDK | 17.0.11 | GPLv2 + Classpath Exception（仅编译期使用，不打包进 APK） |
| Android SDK Platform / Build-Tools | 34 / 34.0.0 | Android SDK 许可协议 |

`androidx.webkit:webkit` 是本 APK 中**唯一**被打包进产物的第三方代码（AAR），采用 Apache-2.0，
允许商业使用，使用时需在分发说明中保留许可声明——本文件即为该声明。

## 四、需要用户在意的合规点

- 若日后上架应用商店，建议把本文件一并放入「开源许可」页面。
- 若要改用自己的签名证书分发，替换 `android/app/build.gradle` 中的 `signingConfigs.release`。
- 本项目使用摄像头，仅在设备本地做实时分析：**不采集、不上传、不存储任何画面**。

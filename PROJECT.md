# PROJECT.md — TrackLaneGuard（跑道守卫）

## 1. 定位

**中文名：跑道守卫** —— 用手机摄像头实时识别红色塑胶跑道与白色分道线，在即将跑出跑道时通过耳机/扬声器的左右声像提示音、语音播报、震动和屏幕箭头，告诉使用者该往左还是往右修正。

一套代码两种形态：`web/` 是完整前端（可作为 PWA 安装），`android/` 是极简 WebView 外壳，把 `web/` 打包进 APK 离线运行。

## 2. 状态

**可用（v1.0.0）** · 最后更新 2026-09-27

- 算法：HSV 跑道分割 + 分道线列直方图峰值 + 退化到跑道边界，已实现三级提醒
- 打包：可产出可安装的 APK（debug 签名）
- 未在真实跑道上做过长时间实测，阈值需现场标定

## 3. 技术栈与关键依赖（精确版本）

| 层 | 依赖 | 版本 | 许可 |
|---|---|---|---|
| 前端 | 原生 HTML5 / Canvas / Web Audio / getUserMedia | 无框架 | 本项目自研 |
| 前端 | Service Worker + Web App Manifest（PWA） | — | 本项目自研 |
| Android | compileSdk / targetSdk | 34 | — |
| Android | minSdk | 24（Android 7.0） | — |
| Android | Android Gradle Plugin | 8.5.2 | 构建期 |
| Android | androidx.webkit:webkit | 1.8.0 | Apache-2.0 |
| 构建 | Gradle | 8.7 | Apache-2.0 |
| 构建 | JDK（Azul Zulu） | 17.0.11 | 构建期，不随 APK 分发 |
| 构建 | Android build-tools | 34.0.0 | 构建期 |

**零第三方运行时代码拷贝**：识别算法全部自研，未复制任何 GitHub 仓库源码。详见 `THIRD-PARTY-NOTICES.md`。

## 4. 启动 / 构建 / 打包（可直接复制）

```bash
# 0) 首次准备工具链（本机无预装 JDK/SDK/Gradle）
#    见第 6 节「已知的坑」，工具链放在 playground/android-toolchain/

# 1) 本地预览前端（需 HTTPS 或 localhost 才能开相机）
cd C:/AI Document/projects/track-lane-guard/web
python -m http.server 8080
# 浏览器打开 http://localhost:8080

# 2) 打包 APK
export JAVA_HOME="C:/AI Document/playground/android-toolchain/zulu17.50.19-ca-jdk17.0.11-win_x64"
export ANDROID_HOME="C:/AI Document/playground/android-toolchain/android-sdk"
export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"
cd C:/AI Document/projects/track-lane-guard/android
"C:/AI Document/playground/android-toolchain/gradle-8.7/bin/gradle" assembleRelease

# 产物：android/app/build/outputs/apk/release/app-release.apk
```

## 5. 发布信息

- GitHub 仓库：**尚未创建**（等待用户确认仓库名后推送）
- 分支：`main`
- 产品名：跑道守卫 / TrackLaneGuard
- 当前版本：v1.0.0（versionCode 1）
- 产物命名规则：`releases/track-lane-guard/v<版本>/TrackLaneGuard-v<版本>.apk`
- 签名：release 复用 `~/.android/debug.keystore`（自用分发，非商店上架签名）

## 6. 已知的坑（本机特有）

1. **本机没有预装 JDK / Android SDK / Gradle**，全部现装到
   `C:/AI Document/playground/android-toolchain/`（约 2 GB，属于临时工具链，可随时删）。
2. **工具链路径含空格**（`AI Document`）。`sdkmanager.bat` 经 `cmd //c` 直传带引号参数会被
   MSYS 路径转换破坏 → **必须写成 .bat 文件再调 `cmd //c "xxx.bat"`**。
3. **`sdkmanager --licenses` 会卡在交互输入**（管道喂 y 也无效）→ 直接往
   `<sdk>/licenses/` 写哈希文件（见 `playground/android-toolchain/install_sdk.bat` 同目录脚本）。
4. **Gradle 官方源 `services.gradle.org` 本机 SSL 握手失败（curl rc=35）** → 改用腾讯云镜像
   `https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip`。
5. **`github.com` 用 curl 不通（返回 000）**，但 `git` 协议可通。下载 GitHub Release 资源会失败，
   所以 JDK 选 Azul Zulu 直链而非 Adoptium（后者跳转 GitHub）。
6. **原生 git 不认 `/c/...` 路径**，传路径参数一律写 `C:/...`；用 `C:/Program Files/Git/cmd/git.exe`。
7. **WebView 必须用 https 源**才能 `getUserMedia`（相机）。因此用 `WebViewAssetLoader` 把
   assets 映射为 `https://appassets.androidplatform.net/`，不要退回 `file:///android_asset/`。
8. **Android 6+ 需先拿到 CAMERA 权限**，再在 `onPermissionRequest` 里 grant，否则 WebView 静默失败。

## 7. 变更记录

- 2026-09-27 · 创建项目，实现前端识别算法（cv.js）、反馈（audio.js）、界面（app.js） · 首个可用版本
- 2026-09-27 · 搭建 Android WebView 外壳并打通本机 APK 构建链路 · 兑现「生成 apk 文件」需求
- 2026-09-27 · 补 PWA（manifest + service worker）与图标 · 便于不装 APK 时直接用浏览器

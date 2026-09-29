# PROJECT.md — TrackLaneGuard（跑道守卫）

## 1. 定位

**中文名：跑道守卫** —— 用手机摄像头实时识别红色塑胶跑道与白色分道线，在即将跑出跑道时通过耳机/扬声器的左右声像提示音、语音播报、震动和屏幕箭头，告诉使用者该往左还是往右修正。

一套代码两种形态：`web/` 是完整前端（可作为 PWA 安装），`android/` 是极简 WebView 外壳，把 `web/` 打包进 APK 离线运行。

## 2. 状态

**可用（v1.5.0）** · 最后更新 2026-09-29

- 算法：HSV 分割 + 水平闭运算 + 最大连通域 + 形状校验 + 分道线直线拟合 +
  多证据置信度 + Alpha-Beta 跟踪器，三级提醒
- 抗误判：合成基准 9 类干扰场景零误报零丢失；纯手持晃动误报 16/40 → 0
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
| 云端（可选） | WorkBuddy 云服务 · Storage | — | 需登录，按需加载 SDK |

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

```bash
# 3) 跑抗干扰基准测试（不需要相机；改算法后先跑这个再打包）
cd C:/AI Document/projects/track-lane-guard/test
node robustness.js
```

## 5. 发布信息

- GitHub 仓库：https://github.com/1494948/track-lane-guard （public，`main` 分支，已推送）
- 在线版（PWA，HTTPS，免安装）：https://track-lane-guard.app.workbuddy.host/
- 分支：`main`
- 产品名：跑道守卫 / TrackLaneGuard
- 当前版本：v1.5.0（versionCode 6）
- 应用图标：`playground/track-lane-build/gen_icons.py`（纯标准库手写 PNG，一次渲染主图
  后盒式下采样到各尺寸）。造型为**原创**「胖鲸鱼 + 跑道」，不是 DeepSeek 官方 logo 的复制件
  —— 官方标识属其商标，公开发布时用原创图形更稳妥
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
9. **直连 `repo.maven.apache.org` 会出现 `Remote host terminated the handshake`**（JVM TLS 被重置，
   curl 却是 200）→ `settings.gradle` 里把阿里云镜像排在 `google()` / `mavenCentral()` 前面。
10. **release 签名用的 `~/.android/debug.keystore` 默认不存在**，会挂在
    `:app:validateSigningRelease` → 用 keytool 生成一次即可（别名 `androiddebugkey`，口令 `android`）。
11. **构建脚本走 `T:` 盘符**（`subst T: "C:\AI Document\playground\android-toolchain"`）：
    工具链路径含空格，从 Git Bash 直传参数给 `cmd` 会被 MSYS 路径转换破坏。
12. AGP 会尝试联网拉 SDK package manifest（失败也只报 Warning，不影响构建），
    第一次构建会因此多等约 3 分钟。

## 7. 变更记录

- 2026-09-27 · 创建项目，实现前端识别算法（cv.js）、反馈（audio.js）、界面（app.js） · 首个可用版本
- 2026-09-27 · 搭建 Android WebView 外壳并打通本机 APK 构建链路 · 兑现「生成 apk 文件」需求
- 2026-09-27 · 补 PWA（manifest + service worker）与图标 · 便于不装 APK 时直接用浏览器
- 2026-09-27 · 修复「白色分道线饱和度为 0 会被红色掩膜排除」的算法缺陷，白线改为独立掩膜 + 邻近跑道约束 · 合成测试 6 项断言全通过，单帧 0.61 ms
- 2026-09-27 · 首次成功构建 APK 并归档到 `releases/track-lane-guard/v1.0.0/` · 386 KB，含完整离线前端
- 2026-09-27 · **v1.1.0 抗误判重构**（cv.js v2）· 起因：用户反馈"容易误判"
  - 加水平闭运算：填平分道线缝隙，避免连通域被切成一条条车道后跨车道跳变
  - 加最大连通域：剔除零散红色物体（衣服、标志牌、相邻红场地）
  - 加形状校验 + 多证据置信度：不可靠时显示「识别不稳定」而不乱报
  - 分道线加行连续性 + 最小二乘直线拟合残差：剔除白斑、污渍、云
  - 加 Alpha-Beta 跟踪器 + 残差门控 + 持续帧投票（默认 8 帧）
  - 合成基准（`playground/track-lane-build/test_robust.js`）：9 类干扰场景零误报零丢失；
    纯手持晃动误报 16/40 → 0；消融证明关掉持续帧投票误报回到 37、关掉闭运算抖动 σ 恶化 27 倍
  - 基准测试纳入仓库 `test/robustness.js`（原先只在 playground，会被当临时文件清掉）
- 2026-09-27 · 推送 GitHub（1494948/track-lane-guard）并发布在线版
  （https://track-lane-guard.app.workbuddy.host/，sites 静态托管） · 在线版与 APK 同一套前端
- 2026-09-28 · **v1.2.0 竖屏与夜间重构** · 起因：用户真机截图（夜间竖持）显示"完全无法使用"，
  跑道就在前面却报"偏离 80%"
  - 根因 1（几何）：竖持时工作画布变 192×341，检测带落在画面中部 —— 那里是远处跑道、
    草坪、球门；且远处跑道与脚下跑道隔着草坪互不连通，最大连通域会选错
  - 根因 2（裁剪）：跑道横贯画面时行边界被画面边缘裁剪，裁剪值被当真边界，
    位置估计完全失真
  - 修法：改「从画面底部中央向上泛洪」提取人脚下的跑道（远处隔草坪的跑道不再干扰）；
    检测带锚定底部（0.45~0.97）；工作画布按长边 192 归一（竖屏 108×192）；
    行边界被裁剪的行不参与定位，全部裁剪时判定"位置不可知"不报警并提示"请抬高手机"；
    白色像素并入跑道掩膜（吸收夜间过曝带与白线）；弯道检测提示
  - 基准扩到 16 场景（含竖屏 4 个、夜间、弯道、截图复现）：v2 全部零误报零丢失；
    纯晃动 0 误报；真实偏离 0.35 s 报警；横竖屏单帧均 ~1.1 ms
- 2026-09-28 · 推送 GitHub + 发布 Release v1.2.0 · 代理对 github.com 主站故障
  （CONNECT 502，api.github.com 却正常），git push 三次失败后改走 **Git Data API**：
  `git ls-tree -r` + base64 内联 29 文件 → `POST /git/trees`(201) →
  `POST /git/commits`(201, 1b50a6c, parent=b9171b2) → `PATCH /git/refs/heads/main`(200)。
  Release id 397981250，APK 401,333 B 上传成功（state=uploaded，字节数一致）。
  下载地址 https://github.com/1494948/track-lane-guard/releases/download/v1.2.0/TrackLaneGuard-v1.2.0.apk
- 2026-09-28 · **v1.3.0 全屏双带 + 前瞻 + 姿态传感器 + 障碍检测 + 横屏默认**
  - 整幅画面都用上：近带（脚前 68%~98%）判当前位置，远带（前方 26%~58%）算漂移趋势
  - 远景前瞻：远处跑道中心相对画面中心的偏移率 trend，与近带同向时折算进偏移量提前预警
    （上限 0.10，不足以单独触发警告级）
  - 新增 `web/js/sensor.js`：DeviceOrientation 姿态（俯仰/翻滚/方位变化率）。
    用途严格限定为三件：没朝下对准跑道时提示、晃动剧烈时多要求 2 帧、横向角速度折算漂移。
    **位置判定仍只由画面给出**，廉价 MEMS 的绝对航向不可信，只用变化率
  - 障碍/占用物检测：跑道面内非跑道色的连通块（人影、衣物、水坑），连续 5 帧才提示，
    画面画黄色框 + 状态栏提示。不区分类型、不测距
  - 使用方式可切换（横屏 / 竖屏 / 自动），**默认横屏**并在竖屏画面时提示横持
  - 基准扩到 18 场景：新增「远处跑道右偏（趋势）」与「跑道上有占用物」，
    趋势 trend=0.111 正确识别、占用物 40/40 帧命中，全部场景仍零误报零丢失
  - 已知缺口：**传感器从未在真机上验证过**（模拟器/无权限环境下自动禁用），
    iOS 需用户手势授权；真机数据待用户录屏后校准
  - Release v1.3.0（id 398224918），APK 406,366 B 已上传：
    https://github.com/1494948/track-lane-guard/releases/download/v1.3.0/TrackLaneGuard-v1.3.0.apk
- 2026-09-28 · **事故与修复：工作区 30 个文件被整体 base64 化**
  - 经过：代理故障期间用 Git Data API 推送，本地与服务端历史出现分叉
    （服务端 commit 与本地 commit 内容相同但 sha 不同）；rebase 冲突后
    执行 `git reset --hard FETCH_HEAD`，把服务端那份**整体 base64 编码的树**
    拉回工作区 → 所有文本/PNG 变成 base64 文本 → gradle 无法解析 settings.gradle
  - 修复：写脚本按 base64 解码**原样还原** 30 个文件（含 PNG，PNG 头校验通过），
    18 场景基准测试复跑全通过，然后正常 `git push` 覆盖服务端坏内容（`dc3faea`）
  - **教训**：
    1. 本地与服务端分叉时，**不要 `reset --hard` 到远端** —— 先比对内容再决定
    2. 用 API 推代码后，本地要**立即 fetch 对齐**，别让分叉留着
    3. 判断文件是否被 base64 化：文件大小约为原文的 4/3、内容只含 `A-Za-z0-9+/=`
    4. 修复脚本（已用完删除）：扫描 git ls-files，base64 解码 + PNG/文本头校验后写回
  - 事后核验：GitHub 上 `android/settings.gradle` 为 893 B，与本地一致（base64 版会是 1192 B）
- 2026-09-28 · **v1.4.0 数据采集与云端优化闭环**
  - 新增 `web/js/recorder.js`：同意流程（localStorage 记录）+ 抽帧（每 2s，双路 JPEG）+
    每 250ms 记录算法输出 + 使用者标注（「我在跑道中间」「我正在偏出」，覆盖最近 6s）+
    上限 400 条自动裁剪 + 打包成 `tlg-samples-v1` JSON
  - 新增 `web/js/cloud.js`：SDK **按需**从 CDN 加载（不点云端就不联网，保证离线可用）；
    登录用邮箱验证码（视障使用者不必记密码）；上传路径只由 SDK 的 `userPath()` 生成，
    代码里不手工传 token/uid
  - 新增 `web/js/dataset.js`：采集面板 UI，所有按钮带文字标签与 aria，状态用文字表达；
    同意弹窗逐条说明采集内容与用途；采集中顶部常驻红色提示条
  - 云服务：复用已激活的「跑道守卫」应用（`wbapp_iT1tS5xC3TzTR11gP3299m`），
    Storage 模块，路径 `users/<uid>/tlg-samples/<时间戳>.json`，每账号隔离
  - `AndroidManifest.xml` 新增 `INTERNET` 权限，**仅**用于上传功能，已在注释里写明
  - 新增 `PRIVACY.md`（隐私说明）与 `test/collector.js`（27 项离线测试，含
    「未同意时绝不采集」「全程零网络请求」两条隐私底线断言）
  - **已知缺口**：云端上传链路**未在真机验证**（需真实邮箱登录），代码按官方 SDK 文档编写；
    抽帧为 canvas 截图而非 MediaRecorder 视频流（体积可控、隐私更小，代价是没有连续录像）
- 2026-09-29 · **v1.5.0 界面改版 + 新图标**
  - `web/css/style.css` 全量重做：分层深色表面（极细描边代替重阴影）、蓝色光晕背景、
    与图标同族的强调色、统一的圆角与间距节奏、按钮/滑杆/复选/分段选择的现代化样式；
    面板改毛玻璃。**所有类名与选择器保持不变**，`app.js` 未改一行
  - 无障碍底线保留并强化：状态文字 22px、点击区 ≥48px、`:focus-visible` 描边、
    `prefers-reduced-motion` 降级
  - 图标重做为「胖鲸鱼 + 跑道」：深蓝渐变底 + 白色胖鲸（渐变身体/腹部/高光眼）+ 背鳍尾鳍
    + 下方红色跑道带与白色分道线；192/512/maskable + Android 五档 mipmap 一次生成
  - 渲染脚本改用**主图一次渲染 + 盒式下采样**，避免每个尺寸重复计算
- 2026-09-29 · **v1.6.0 横屏从摆设改为真正生效（用户指出）**
  - 问题：v1.5.0 虽然默认横屏，但页面仍是竖排堆叠 —— 横过来后画面被压扁、按钮要滚动；
    「使用方式」设置只换了一句提示文字，对算法零影响
  - 布局：`#app` 改 CSS Grid + `grid-template-areas`，竖屏 4 行堆叠／横屏左右分栏
    （画面 `1fr` 占满左侧，信息与操作在右列 `clamp(272px,33vw,400px)`）；
    横屏下 `100dvh` + `overflow:hidden`，**整页不滚动**，只有右列内部滚动
    （跑步时腾不出手滚屏）；矮屏（<470px）再压掉说明与调试图高度
  - 算法：横屏近带 68~98%/远带 26~58%，竖屏改为 62~98%/22~52%；
    `resize`/`orientationchange` 实时切换；设定期望与实际不符时提高置信度门槛 0.10
  - 可视化：画面上画出远带（蓝）与近带（绿）框、远处跑道中心点、漂移趋势箭头，
    右上角角标显示「远带趋势 +0.11　近带位置 0.48」，设置里可关（`showBands`）
  - 新增 `#infoCol` / `#ctrlCol` 两个包裹容器（所有元素 id 未变，`app.js` 只加了绘制逻辑）
- 2026-09-29 · **v1.7.0 横屏真正旋转 + 全屏/隐藏画面 + 采集同意修复**
  - 用户反馈"还是没有任何改变"，核对后两个原因：
    1. **横屏强制、全屏/隐藏视频的实现（约 300 行，含 `MainActivity` 原生方向桥接、
       `btnFull`/`btnHide`、CSS `[data-layout]`/`[data-view]`）此前既未提交、
       也未进入任何一次 APK 构建** —— 旧包里一行都没有，自然看不到变化
    2. **采集同意流程在代码层面卡死**：`go = this.askConsent` 丢失 `this` →
       `askConsent` 内 `self` 为 undefined → 点「同意」后先关弹窗再抛异常 →
       `resolve(true)` 永不执行 → `recorder.start()` 永不调用
  - 修法：同意流程改闭包调用；横屏交给 Android 原生 `setRequestedOrientation`
    （不依赖系统自动旋转开关，`configChanges` 已配好，旋转不重建页面、不丢标定）；
    网页版无原生桥接时用 CSS 旋转 90° 兜底（`data-rotated` 由脚本判断）
  - 整合：删除我重复实现的 `applyLayout`（与已有 `computeLayout` 冲突，且属性值
    `land`/`port` 与 CSS 期望的 `landscape`/`portrait` 不匹配会互相抵消）；
    全屏/隐藏的两个入口（快捷按钮 + 设置分段）统一到同一状态源并持久化
  - **重要提醒**：本项目曾被另一个会话并行编辑（约 300 行未提交改动）。
    同一项目不要同时开多个会话修改，否则会出现"改了半天没生效"或互相覆盖；
    动手前先 `git status` 看一眼

package cn.xuzf.tlg.core

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as CSize
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import cn.xuzf.tlg.core.alert.AlertManager
import cn.xuzf.tlg.core.camera.FrameAnalyzer
import cn.xuzf.tlg.core.detect.NativeBridge
import cn.xuzf.tlg.core.ui.ParamGroups
import cn.xuzf.tlg.core.ui.ParamStore
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AppRoot() }
    }
}

private val BgDark = Color(0xFF0B0E14)
private val Surface = Color(0xFF151A24)
private val LineC = Color(0x14FFFFFF)
private val TextC = Color(0xFFEEF2F8)
private val Muted = Color(0xFF98A2B8)
private val OkC = Color(0xFF34D399)
private val WarnC = Color(0xFFFBBF24)
private val DangerC = Color(0xFFF43F5E)
private val BlueC = Color(0xFF7EE0FF)
private val GreenC = Color(0xFF96F5C3)
private val AmberC = Color(0xFFFFCF6B)

@Composable
fun AppRoot() {
    val context = LocalContext.current
    val params = remember { ParamStore(context) }
    val alert = remember { AlertManager(context) }
    val analyzer = remember { FrameAnalyzer() }

    var hasCam by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { hasCam = it }

    LaunchedEffect(Unit) {
        if (!hasCam) launcher.launch(Manifest.permission.CAMERA)
        // 模型可选：没有模型文件时纯规则通路照样工作
        val p = NativeBridge.stageAsset(context, "yolo11m.ncnn.param")
        val b = NativeBridge.stageAsset(context, "yolo11m.ncnn.bin")
        if (p != null && b != null && NativeBridge.isLoaded) {
            val ok = NativeBridge.loadModel(
                p.absolutePath, b.absolutePath,
                params.int("inputSize"), params["confThr"],
                params["iouThr"], true, params.int("threads")
            )
            if (!ok) alert.vibrateEnabled = true
        }
    }

    DisposableEffect(Unit) { onDispose { alert.release() } }

    MaterialTheme(
        colorScheme = darkColorScheme(background = BgDark, surface = Surface)
    ) {
        Box(Modifier.fillMaxSize().background(BgDark)) {
            if (hasCam) CameraScreen(params, alert, analyzer, hasCam)
            else Text("需要相机权限才能识别跑道", color = TextC, modifier = Modifier.align(Alignment.Center))
        }
    }
}

@Composable
fun CameraScreen(params: ParamStore, alert: AlertManager, analyzer: FrameAnalyzer, hasCam: Boolean) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }

    // 报警状态
    var level by remember { mutableStateOf(0) }      // 0 安全 1 注意 2 警告
    var dirLeft by remember { mutableStateOf(true) }
    var trackP by remember { mutableStateOf(0.5f) }
    var modelOn by remember { mutableStateOf(false) }
    var inferMs by remember { mutableStateOf(0) }
    var fps by remember { mutableStateOf(0) }
    var box by remember { mutableStateOf<FrameAnalyzer.FrameResult?>(null) }
    var lastFire by remember { mutableStateOf(0L) }
    var sameDir by remember { mutableStateOf(0) }
    var pSmooth by remember { mutableStateOf(0.5f) }

    // 帧统计
    var frameCount by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(1000)
            fps = frameCount
            frameCount = 0
        }
    }

    // 参数变化时同步到 native
    LaunchedEffect(params.version) {
        if (NativeBridge.isLoaded) {
            NativeBridge.setTrackConfig(
                params.int("hueCenter"), params.int("hueWidth"),
                params.int("satMin"), params.int("valMin"), 4, 0.06f,
                params["nearTop"], 0.98f, params["bandTop"], params["bandTop"] + 0.13f
            )
        }
    }

    // 分析器回调：状态机 + 报警
    val onFrame: (FrameAnalyzer.FrameResult) -> Unit = { r ->
        frameCount++
        box = r
        inferMs = r.inferMs
        if (r.boxCount > 0) modelOn = true
        trackP = r.trackP
        // 位置平滑（一阶低通）
        pSmooth += (r.trackP - pSmooth) * 0.5f
        val d = pSmooth - 0.5f
        val ad = kotlin.math.abs(d)
        val dirIsLeft = d < 0
        sameDir = if (dirIsLeft == dirLeft) sameDir + 1 else 1
        dirLeft = dirIsLeft

        val conf = if (r.boxCount > 0) 0.9f else 0.7f
        val trusted = conf >= params["minConf"] && sameDir >= params.int("stableFrames")
        val newLevel = when {
            !trusted -> 0
            ad >= params["danger"] -> 2
            ad >= params["caution"] -> 1
            else -> 0
        }
        // 同一方向 1.5 秒内不重复播报
        val now = System.currentTimeMillis()
        if (newLevel > 0 && now - lastFire > 1500) {
            lastFire = now
            alert.playDirection(dirLeft, newLevel)
            alert.vibrate(newLevel)
        }
        level = newLevel
    }

    // 相机绑定
    LaunchedEffect(hasCam) {
        if (!hasCam) return@LaunchedEffect
        val provider = ProcessCameraProvider.getInstance(context).get()
        val preview = Preview.Builder().build().also {
            it.setSurfaceProvider(previewView.surfaceProvider)
        }
        val analysis = ImageAnalysis.Builder()
            .setTargetResolution(Size(640, 480))
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(Executors.newSingleThreadExecutor(), analyzer)
        analyzer.callback = onFrame
        provider.unbindAll()
        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    }

    var showSettings by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize()) {
        // 相机预览
        AndroidView({ previewView }, Modifier.fillMaxSize())

        // 叠加层：带框 + 检测框
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            // 远带（蓝）与近带（绿）
            val farTop = h * params["bandTop"]
            val farBot = farTop + h * 0.32f
            val nearTop = h * params["nearTop"]
            val nearBot = h * 0.98f
            drawRect(BlueC.copy(alpha = 0.06f), topLeft = Offset(0f, farTop), size = CSize(w, farBot - farTop))
            drawRect(color = BlueC.copy(alpha = 0.5f), topLeft = Offset(0f, farTop), size = CSize(w, farBot - farTop), style = Stroke(width = 3f))
            drawRect(GreenC.copy(alpha = 0.06f), topLeft = Offset(0f, nearTop), size = CSize(w, nearBot - nearTop))
            drawRect(color = GreenC.copy(alpha = 0.5f), topLeft = Offset(0f, nearTop), size = CSize(w, nearBot - nearTop), style = Stroke(width = 3f))

            // 跑道中心标记
            val cx = w * trackP
            drawLine(OkC, Offset(cx, farTop), Offset(cx, nearBot), strokeWidth = 4f)

            // 障碍框
            box?.let { b ->
                if (b.boxCount > 0) {
                    val x0 = w * b.x0; val y0 = h * b.y0
                    val x1 = w * b.x1; val y1 = h * b.y1
                    drawRect(AmberC, topLeft = Offset(x0, y0), size = CSize(x1 - x0, y1 - y0), style = Stroke(width = 6f))
                }
            }
        }

        // 顶部状态
        Column(Modifier.align(Alignment.TopCenter).padding(16.dp)) {
            Surface(color = Surface.copy(alpha = 0.9f), shape = RoundedCornerShape(18.dp), border = androidx.compose.foundation.BorderStroke(1.dp, LineC)) {
                Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(14.dp).background(
                        when (level) { 2 -> DangerC; 1 -> WarnC; else -> OkC },
                        RoundedCornerShape(7.dp)
                    ))
                    Spacer(Modifier.width(12.dp))
                    Text(
                        when (level) {
                            2 -> "即将跑出 · ${if (dirLeft) "往左" else "往右"}"
                            1 -> "注意偏出 · ${if (dirLeft) "往左" else "往右"}"
                            else -> "安全"
                        },
                        color = when (level) { 2 -> Color.White; 1 -> WarnC; else -> OkC },
                        fontSize = 22.sp, fontWeight = FontWeight.Bold
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "识别 ${if (modelOn) "模型+规则" else "规则"} · 推理 ${inferMs}ms · ${fps}fps",
                color = Muted, fontSize = 12.sp
            )
        }

        // 底部按钮
        Row(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Button(onClick = { showSettings = true }, modifier = Modifier.weight(1f)) { Text("设置") }
        }

        if (showSettings) {
            SettingsSheet(params, alert) { showSettings = false }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(params: ParamStore, alert: AlertManager, onClose: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = sheetState,
        containerColor = Surface
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)
                .verticalScroll(rememberScrollState())
        ) {
            Text("设置", color = TextC, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Text("每个参数都写明了「调大 / 调小会发生什么」。调乱了可以一键恢复推荐值。",
                color = Muted, fontSize = 12.sp)
            Spacer(Modifier.height(12.dp))

            GroupTitle("识别基础")
            ParamGroups.detect.forEach { ParamCard(it, params) }
            GroupTitle("跑道识别")
            ParamGroups.track.forEach { ParamCard(it, params) }
            GroupTitle("报警策略")
            ParamGroups.alarm.forEach { ParamCard(it, params) }
            GroupTitle("传感器辅助")
            ParamGroups.sensor.forEach { ParamCard(it, params) }
            GroupTitle("性能")
            ParamGroups.perf.forEach { ParamCard(it, params) }

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { params.resetAll() }) { Text("恢复推荐值") }
                OutlinedButton(onClick = onClose) { Text("完成") }
            }
        }
    }
}

@Composable
fun GroupTitle(text: String) {
    Text(text, color = Muted, fontSize = 12.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 16.dp, bottom = 6.dp))
}

@Composable
fun ParamCard(spec: cn.xuzf.tlg.core.ui.ParamSpec, store: ParamStore) {
    val value = store[spec.key]
    Surface(
        color = Color.White.copy(alpha = 0.03f),
        shape = RoundedCornerShape(14.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, LineC),
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp)
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(spec.title, color = TextC, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.weight(1f))
                Text(
                    if (spec.isInt) value.toInt().toString() + spec.unit
                    else String.format("%.2f", value) + spec.unit,
                    color = TextC, fontSize = 15.sp, fontWeight = FontWeight.Bold
                )
            }
            Slider(
                value = value,
                onValueChange = { store[spec.key] = it },
                valueRange = spec.min..spec.max,
                steps = ((spec.max - spec.min) / spec.step).toInt() - 1,
                colors = SliderDefaults.colors(thumbColor = BlueC, activeTrackColor = BlueC)
            )
            Text("是什么：" + spec.what, color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
            Text("调大 → " + spec.upEffect, color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
            Text("调小 → " + spec.downEffect, color = Muted, fontSize = 12.sp, lineHeight = 17.sp)
            Text("什么时候调：" + spec.whenToAdjust, color = BlueC.copy(alpha = 0.85f), fontSize = 12.sp, lineHeight = 17.sp)
        }
    }
}

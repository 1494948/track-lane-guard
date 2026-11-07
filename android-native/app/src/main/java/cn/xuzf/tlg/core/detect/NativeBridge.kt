package cn.xuzf.tlg.core.detect

import java.io.File

/**
 * JNI 桥接。所有推理与规则分析都在 native 侧完成，Kotlin 只传像素与配置、拿回数值。
 *
 * 坐标约定：所有框都是**归一化到 0..1** 的相对坐标（相对原图），
 * 这样 UI 层与画面分辨率、旋转角度解耦。
 */
object NativeBridge {

    private var loaded = false

    val isLoaded: Boolean get() = loaded

    init {
        runCatching {
            System.loadLibrary("tlg-native")
            loaded = true
        }
    }

    /** 模型加载。param/bin 需为可读路径（assets 要先复制到 cache） */
    external fun loadModel(
        paramPath: String,
        binPath: String,
        inputSize: Int,
        confThr: Float,
        iouThr: Float,
        useGpu: Boolean,
        threads: Int
    ): Boolean

    external fun setTrackConfig(
        hueCenter: Int, hueWidth: Int, satMin: Int, valMin: Int,
        closeRadius: Int, minCoverage: Float,
        nearTop: Float, nearBottom: Float, farTop: Float, farBottom: Float
    )

    external fun releaseModel()

    /**
     * 处理一帧 RGB888。
     * @return float[8]： [0]=框数 [1..4]=主框x0,y0,x1,y1 [5]=score [6]=cls [7]=规则通路p
     */
    external fun process(rgbArray: ByteArray, w: Int, h: Int): FloatArray

    external fun lastInferMs(): Int

    external fun isModelLoaded(): Boolean

    /** 把 assets 里的模型复制到 cache，返回可读路径 */
    fun stageAsset(context: android.content.Context, assetName: String): File? {
        return runCatching {
            val out = File(context.cacheDir, assetName)
            if (!out.exists()) {
                context.assets.open("models/$assetName").use { input ->
                    out.outputStream().use { output -> input.copyTo(output) }
                }
            }
            out
        }.getOrNull()
    }
}

package cn.xuzf.tlg.core.camera

import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import cn.xuzf.tlg.core.detect.NativeBridge
import java.io.ByteArrayOutputStream

/**
 * CameraX 帧分析器。
 *
 * 关键点（性能设计，见 NATIVE-ANDROID.md）：
 *  1. 只取 YUV_420_888 的 Y/U/V 三个平面，**不经过 Bitmap 中转**即转 RGB
 *     —— WebView 版每帧在 JS 里建 ImageData 是主要开销，这里直接算
 *  2. 推理慢时**丢帧**而非排队：busy 为真就 close 当前帧，延迟不累积
 *  3. RGB 转换在 native 侧做（process() 内只收 RGB888）
 */
class FrameAnalyzer : ImageAnalysis.Analyzer {

    /** 帧结果回调。可在绑定相机时设置。 */
    var callback: ((FrameResult) -> Unit)? = null

    @Volatile var busy = false

    data class FrameResult(
        val boxCount: Int,
        val x0: Float, val y0: Float, val x1: Float, val y1: Float,
        val score: Float, val cls: Int,
        val trackP: Float,
        val inferMs: Int
    )

    override fun analyze(image: ImageProxy) {
        if (busy) {
            image.close()
            return
        }
        busy = true
        try {
            val w = image.width
            val h = image.height
            val rgb = yuvToRgb(image) ?: run {
                image.close(); busy = false; return
            }
            val out = NativeBridge.process(rgb, w, h)
            callback?.invoke(
                FrameResult(
                    boxCount = out[0].toInt(),
                    x0 = out[1], y0 = out[2], x1 = out[3], y1 = out[4],
                    score = out[5], cls = out[6].toInt(),
                    trackP = out[7],
                    inferMs = NativeBridge.lastInferMs()
                )
            )
        } finally {
            image.close()
            busy = false
        }
    }

    /**
     * YUV_420_888 → RGB888。
     * 用 YuvImage 压 JPEG 再解码会比手写慢，所以这里按平面直接算；
     * 同时处理 pixelStride != 1 的情况（部分机型 U/V 有间隔）。
     */
    private fun yuvToRgb(image: ImageProxy): ByteArray? {
        if (image.format != ImageFormat.YUV_420_888) return null
        val w = image.width
        val h = image.height
        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]

        val yBuf = yPlane.buffer
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer

        val yRow = yPlane.rowStride
        val uRow = uPlane.rowStride
        val vRow = vPlane.rowStride
        val uPix = uPlane.pixelStride
        val vPix = vPlane.pixelStride

        val yBytes = ByteArray(yBuf.remaining()).also { yBuf.get(it); yBuf.rewind() }
        val uBytes = ByteArray(uBuf.remaining()).also { uBuf.get(it); uBuf.rewind() }
        val vBytes = ByteArray(vBuf.remaining()).also { vBuf.get(it); vBuf.rewind() }

        val out = ByteArray(w * h * 3)
        for (j in 0 until h) {
            val yOff = j * yRow
            val uvRow = (j / 2) * uRow
            val vvRow = (j / 2) * vRow
            var o = j * w * 3
            for (i in 0 until w) {
                val y = (yBytes[yOff + i].toInt() and 0xFF) - 16
                val uIdx = uvRow + (i / 2) * uPix
                val vIdx = vvRow + (i / 2) * vPix
                val u = (uBytes[uIdx].toInt() and 0xFF) - 128
                val v = (vBytes[vIdx].toInt() and 0xFF) - 128
                var r = (298 * y + 409 * v + 128) shr 8
                var g = (298 * y - 100 * u - 208 * v + 128) shr 8
                var b = (298 * y + 516 * u + 128) shr 8
                if (r < 0) r = 0 else if (r > 255) r = 255
                if (g < 0) g = 0 else if (g > 255) g = 255
                if (b < 0) b = 0 else if (b > 255) b = 255
                out[o++] = r.toByte()
                out[o++] = g.toByte()
                out[o++] = b.toByte()
            }
        }
        return out
    }
}

package cn.xuzf.tlg.core.alert

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import kotlin.math.PI
import kotlin.math.sin

/**
 * 提示输出：双声道声像（左右耳区分方向）+ 震动 + 语音。
 *
 * 用 AudioTrack 直接生成正弦音而非播放音频文件，好处是零延迟、无需资源文件、
 * 且能精确控制左右声道音量比（声像）。
 */
class AlertManager(private val context: Context) {

    private var track: AudioTrack? = null
    private val sampleRate = 44100
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    var volume: Float = 0.8f
    var vibrateEnabled: Boolean = true

    private fun ensureTrack(): AudioTrack? {
        if (track != null) return track
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_STEREO,
            AudioFormat.ENCODING_PCM_FLOAT
        )
        if (minBuf <= 0) return null
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build()
            )
            .setBufferSizeInBytes(minBuf)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        return track
    }

    /**
     * 播一声"往左"或"往右"。
     * 用 880Hz 短音（左）/660Hz（右）区分，配合声像，双保险。
     */
    fun playDirection(dirLeft: Boolean, level: Int) {
        val durMs = if (level >= 2) 220L else 140L
        val freq = if (dirLeft) 880f else 660f
        val n = (sampleRate * durMs / 1000).toInt()
        val data = FloatArray(n * 2)
        val pan = if (dirLeft) 0f else 1f     // 0=全左，1=全右
        val lGain = (1f - pan) * volume
        val rGain = pan * volume
        var phase = 0.0
        val inc = 2.0 * PI * freq / sampleRate
        for (i in 0 until n) {
            val s = (sin(phase) * 0.6).toFloat()
            phase += inc
            // 轻微淡出，避免爆音
            val fade = 1f - (i.toFloat() / n) * 0.5f
            data[i * 2] = s * lGain * fade
            data[i * 2 + 1] = s * rGain * fade
        }
        runCatching {
            val t = ensureTrack() ?: return
            t.stop()
            t.write(data, 0, data.size, AudioTrack.WRITE_BLOCKING)
            t.play()
        }
    }

    fun vibrate(level: Int) {
        if (!vibrateEnabled) return
        val ms = if (level >= 2) 180L else 90L
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(ms)
            }
        }
    }

    fun release() {
        runCatching { track?.stop(); track?.release() }
        track = null
    }
}

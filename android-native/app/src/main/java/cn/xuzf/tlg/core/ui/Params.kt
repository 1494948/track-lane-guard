package cn.xuzf.tlg.core.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 参数体系。
 *
 * 设计要求（用户明确强调）：**每个可调参数都必须回答三个问题** ——
 * 它是什么、调大调小会发生什么、什么时候该动它。
 * 所以每个参数是一整张卡片，而不是光秃秃一个滑块。
 *
 * @param what      这是什么（一句话）
 * @param upEffect  调大会发生什么
 * @param downEffect 调小会发生什么
 * @param when      什么时候该调它
 */
data class ParamSpec(
    val key: String,
    val title: String,
    val unit: String,
    val min: Float,
    val max: Float,
    val step: Float,
    val default: Float,
    val isInt: Boolean = false,
    val what: String,
    val upEffect: String,
    val downEffect: String,
    val whenToAdjust: String
)

object ParamGroups {
    val detect = listOf(
        ParamSpec(
            "inputSize", "模型输入尺寸", "px", 192f, 640f, 32f, 320f, true,
            what = "送进神经网络的图片被缩放到多大。越大看得越清楚，算得越慢。",
            upEffect = "远处的小目标更容易被发现，但每帧更慢、更耗电、手机更烫。",
            downEffect = "帧率更高、更省电，但远处的人和物可能被漏掉。",
            whenToAdjust = "远处有人却提示不到 → 调大；手机卡顿或发烫 → 调小。"
        ),
        ParamSpec(
            "confThr", "置信度阈值", "", 0.15f, 0.75f, 0.05f, 0.35f,
            what = "网络要有多确定，才算「这里真的有个东西」。",
            upEffect = "误报明显变少，但远处、被遮挡一半的目标可能被漏掉。",
            downEffect = "更容易发现远处和模糊的目标，但空旷处可能乱报。",
            whenToAdjust = "空旷跑道乱报「有人」→ 调大；有人走过却提示不到 → 调小。"
        ),
        ParamSpec(
            "iouThr", "重复框合并阈值", "", 0.25f, 0.7f, 0.05f, 0.45f,
            what = "两个框重叠多少比例，就当成是同一个东西。",
            upEffect = "同一目标只报一次，但挨得很近的两件事会被并成一件。",
            downEffect = "能分辨相邻目标，但同一个目标可能被报两次。",
            whenToAdjust = "两个人并肩跑被报成一个人 → 调小；同一个人被报两次 → 调大。"
        ),
        ParamSpec(
            "threads", "计算线程数", "个", 1f, 8f, 1f, 4f, true,
            what = "同时用几个 CPU 核心来做推理。",
            upEffect = "更快，但更耗电、更容易发热。",
            downEffect = "慢一些，但手机冷静、续航更久。",
            whenToAdjust = "连续跑一会儿就发烫掉帧 → 调到 2。"
        )
    )

    val track = listOf(
        ParamSpec(
            "hueCenter", "跑道色相中心", "度", 0f, 360f, 2f, 4f, true,
            what = "你认为「跑道红」对应的色相值。红色在 0 度附近。",
            upEffect = "偏向橙、黄方向的颜色也会被当成跑道。",
            downEffect = "偏向紫、品红方向的颜色也会被当成跑道。",
            whenToAdjust = "换了颜色不同的跑道（偏橙或偏紫）时微调。"
        ),
        ParamSpec(
            "hueWidth", "跑道色相容差", "度", 5f, 60f, 1f, 16f, true,
            what = "允许颜色偏离「标准跑道红」多少。",
            upEffect = "褪色、阴影里的跑道也能认出来，但红色衣物、红色塑料凳也可能被当跑道。",
            downEffect = "只认很纯的跑道红，判错少，但颜色稍有偏差就整段丢失。",
            whenToAdjust = "换了一条颜色不同的跑道就调大；把红色异物当跑道就调小。"
        ),
        ParamSpec(
            "satMin", "最小饱和度", "", 0f, 200f, 5f, 55f,
            what = "颜色要多鲜艳才算跑道。灰色路面饱和度很低。",
            upEffect = "灰色水泥路、沥青路不会被误认成跑道。",
            downEffect = "阴天、逆光下发灰的跑道也能认出来，但噪声变多。",
            whenToAdjust = "把灰色马路当跑道 → 调大；阴天识别不到跑道 → 调小。"
        ),
        ParamSpec(
            "valMin", "最小亮度", "", 0f, 200f, 5f, 45f,
            what = "要多亮才算跑道。很暗的地方亮度低。",
            upEffect = "暗处、阴影里不会被误认，判错少。",
            downEffect = "夜间、树荫下也能认出来，但暗部噪声变多。",
            whenToAdjust = "晚上或树荫下识别不到跑道 → 调小；暗处乱报 → 调大。"
        ),
        ParamSpec(
            "bandTop", "检测带上边界", "%", 20f, 85f, 0.02f, 0.45f,
            what = "从画面多高的位置开始分析。",
            upEffect = "只看更近的地面，更稳，但看不到前方走向。",
            downEffect = "能分析更远的跑道，更早发现前方偏出，但天空和背景干扰变多。",
            whenToAdjust = "希望更早知道「前面在往左/右偏」→ 调小。"
        ),
        ParamSpec(
            "nearTop", "近带起始位置", "%", 40f, 90f, 0.02f, 0.68f,
            what = "从画面多低开始算「我现在站在哪」。",
            upEffect = "只看很靠近脚下一小片，判断准但采样少。",
            downEffect = "用更大范围判断当前位置，更稳。",
            whenToAdjust = "几乎不用动；站在跑道边缘时判断飘忽再调。"
        )
    )

    val alarm = listOf(
        ParamSpec(
            "caution", "「注意」阈值", "%", 8f, 40f, 0.01f, 0.18f,
            what = "偏离跑道中心多少，开始提醒「注意」。",
            upEffect = "更晚才提醒，打扰更少，但留给反应的时间更短。",
            downEffect = "更早就提醒，但可能过于敏感、听着烦。",
            whenToAdjust = "觉得「总是提醒、很烦」→ 调大；希望早点知道 → 调小。"
        ),
        ParamSpec(
            "danger", "「警告」阈值", "%", 15f, 50f, 0.01f, 0.34f,
            what = "偏离多少算「快要跑出去了」。",
            upEffect = "只在非常接近边缘时才给最急的警告。",
            downEffect = "稍微偏一点就给出最急的警告。",
            whenToAdjust = "希望更早听到最急的提示 → 调小；觉得警告太频繁 → 调大。"
        ),
        ParamSpec(
            "stableFrames", "持续帧数", "帧", 2f, 15f, 1f, 8f, true,
            what = "同一个方向要连续出现多少帧，才真正报警。",
            upEffect = "抗晃动、抗误报很强，但反应会慢半拍。",
            downEffect = "反应很快，但手抖、单帧误判都可能触发。",
            whenToAdjust = "跑步时误报多 → 调大；觉得反应慢 → 调小。"
        ),
        ParamSpec(
            "minConf", "最低置信度", "%", 20f, 85f, 0.05f, 0.45f,
            what = "画面本身要多「确定是跑道」，才允许报警。",
            upEffect = "拿不准的时候干脆不报，误报少。",
            downEffect = "拿不准也尽量报，提醒多。",
            whenToAdjust = "经常「无故报警」→ 调大；该报的时候不报 → 调小。"
        )
    )

    val sensor = listOf(
        ParamSpec(
            "shakeThr", "晃动判定阈值", "度/秒", 20f, 120f, 5f, 55f,
            what = "手机转多快算「手在抖」。抖的时候会更谨慎。",
            upEffect = "更不容易判定为晃动，更信任画面。",
            downEffect = "更容易判定为晃动，那时会多等几帧再报。",
            whenToAdjust = "跑步时提示音忽左忽右跳 → 调小。"
        ),
        ParamSpec(
            "driftWeight", "传感器漂移权重", "", 0f, 1f, 0.05f, 0.3f,
            what = "多参考「手机正在转向」来提前预警。",
            upEffect = "更早预警，但手机航向漂移也会把提示带偏。",
            downEffect = "几乎只信画面判断，不受手机朝向影响。",
            whenToAdjust = "明明直着跑却被提示 → 调小。"
        )
    )

    val perf = listOf(
        ParamSpec(
            "targetFps", "目标帧率", "fps", 5f, 30f, 1f, 20f, true,
            what = "一秒钟算几帧。",
            upEffect = "更流畅、反应更快，但更耗电、更烫。",
            downEffect = "省电、冷静，但反应变慢。",
            whenToAdjust = "手机发烫或掉电快 → 调到 10。"
        )
    )

    val all: List<ParamSpec> = detect + track + alarm + sensor + perf

    fun byKey(key: String): ParamSpec? = all.firstOrNull { it.key == key }
}

/** 参数值的运行时存储（Compose 可观察） */
class ParamStore(context: Context) {
    private val prefs = context.getSharedPreferences("tlg_params", Context.MODE_PRIVATE)
    private val values = mutableStateMapOf<String, Float>()
    private val _map = mutableStateOf(0)

    val version: Int get() = _map.value

    init {
        ParamGroups.all.forEach { spec ->
            val saved = prefs.getFloat(spec.key, spec.default)
            values[spec.key] = saved
        }
    }

    operator fun get(key: String): Float = values[key] ?: ParamGroups.byKey(key)?.default ?: 0f

    fun int(key: String): Int = get(key).toInt()

    operator fun set(key: String, v: Float) {
        val spec = ParamGroups.byKey(key) ?: return
        val clamped = v.coerceIn(spec.min, spec.max)
        val stepped = if (spec.isInt) clamped.toInt().toFloat()
        else Math.round(clamped / spec.step) * spec.step
        values[key] = stepped
        prefs.edit().putFloat(key, stepped).apply()
        _map.value++
    }

    fun resetAll() {
        ParamGroups.all.forEach { values[it.key] = it.default }
        prefs.edit().clear().apply()
        _map.value++
    }
}

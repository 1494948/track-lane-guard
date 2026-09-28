/*
 * sensor.js —— 手机姿态传感器（陀螺仪 / 加速度计）辅助
 *
 * 用途（辅助，不替代视觉判定）：
 *   1. 姿态提示：手机是否朝下方对着跑道，没对准时提醒使用者
 *   2. 晃动识别：翻滚角速度过大时标记为"晃动中"，用于解释为什么判定会迟疑
 *   3. 前瞻预测：把横向角速度折算成短期漂移趋势，与画面前瞻合并后提前预警
 *
 * 边界（必须说清）：
 *   - 廉价 MEMS 陀螺仪有漂移，航向角(alpha)绝对不可靠，只使用其**变化率**
 *   - 不能凭传感器判断"人在哪里"，位置判定仍然只由画面给出
 *   - iOS 13+ 需要用户手势里调用 requestPermission()，没授权就自动禁用
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});

  function Sensor() {
    this.enabled = false;
    this.supported = typeof global.DeviceOrientationEvent !== 'undefined';
    this.roll = 0;      // 左右倾斜（度）
    this.pitch = 0;     // 前后倾斜（度）
    this.yaw = 0;       // 方位（度，绝对不可靠，只做变化率）
    this.yawRate = 0;   // 方位变化率（度/秒），平滑
    this.rollRate = 0;
    this.lastYaw = 0;
    this.lastTs = 0;
    this.shaking = false;
    this.aiming = true; // 手机是否朝向地面
    this._onOrient = null;
  }

  function ema(prev, next, a) { return prev * (1 - a) + next * a; }

  Sensor.prototype.start = function () {
    var self = this;
    if (!this.supported || this.enabled) return false;
    this._onOrient = function (e) {
      if (e.gamma === null && e.beta === null) return;
      var now = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      // 屏幕方向：横屏时 gamma/beta 的语义会交换，按 screen.orientation 校正
      var angle = 0;
      if (global.screen && global.screen.orientation && typeof global.screen.orientation.angle === 'number') {
        angle = global.screen.orientation.angle;
      }
      var g = e.gamma || 0;   // 左右倾斜 -90..90
      var b = e.beta || 0;    // 前后倾斜 -180..180
      var a = e.alpha || 0;   // 方位 0..360

      if (angle === 90) { var t1 = g; g = -b; b = t1; }
      else if (angle === 270 || angle === -90) { var t2 = g; g = b; b = -t2; }

      self.roll = ema(self.roll, g, 0.25);
      self.pitch = ema(self.pitch, b, 0.25);

      if (self.lastTs) {
        var dt = Math.max(0.016, (now - self.lastTs) / 1000);
        var dYaw = a - self.lastYaw;
        if (dYaw > 180) dYaw -= 360;
        if (dYaw < -180) dYaw += 360;
        self.yawRate = ema(self.yawRate, dYaw / dt, 0.2);
        self.rollRate = ema(self.rollRate, (g - self.roll) / dt, 0.2);
      }
      self.yaw = a;
      self.lastYaw = a;
      self.lastTs = now;

      // 晃动：翻滚或方位变化率过大
      self.shaking = Math.abs(self.rollRate) > 55 || Math.abs(self.yawRate) > 90;
      // 瞄准：横持朝前下方时 pitch 通常落在 20~75 度（俯视地面）
      self.aiming = self.pitch > 15 && self.pitch < 85;
    };
    global.addEventListener('deviceorientation', this._onOrient, true);
    this.enabled = true;
    return true;
  };

  /** iOS 13+ 需要用户手势内授权；其它平台直接返回 true */
  Sensor.prototype.requestPermission = function () {
    var DOE = global.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      var self = this;
      return DOE.requestPermission().then(function (r) {
        return r === 'granted' && self.start();
      }).catch(function () { return false; });
    }
    return Promise.resolve(this.start());
  };

  Sensor.prototype.stop = function () {
    if (this._onOrient) {
      global.removeEventListener('deviceorientation', this._onOrient, true);
      this._onOrient = null;
    }
    this.enabled = false;
  };

  Sensor.prototype.state = function () {
    return {
      enabled: this.enabled,
      supported: this.supported,
      roll: this.roll,
      pitch: this.pitch,
      yawRate: this.yawRate,
      rollRate: this.rollRate,
      shaking: this.shaking,
      aiming: this.aiming,
      // 横向角速度折算成漂移趋势（很保守：满量程约 ±0.35）
      drift: Math.max(-0.35, Math.min(0.35, this.yawRate / 260))
    };
  };

  TLG.Sensor = Sensor;
})(window);

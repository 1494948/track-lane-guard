/*
 * audio.js —— 听觉 / 触觉反馈
 *
 * 设计要点：
 *   1. 双通道编码方向，避免单声道扬声器下无法分辨：
 *        - 立体声声像（StereoPanner）：往左修正 -> 左耳；往右修正 -> 右耳
 *        - 音高差异：往左 = 低频 620Hz，往右 = 高频 930Hz
 *   2. 三级强度：安全(静默/可选心跳) / 注意(单声) / 警告(急促双声 + 震动 + 语音)
 *   3. 语音播报"往左""往右"做最终兜底，防止听错方向
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});

  var ctx = null;
  var masterGain = null;
  var timer = null;
  var ttsTimer = null;
  var cfg = {
    volume: 0.8,
    ttsEnabled: true,
    vibrateEnabled: true,
    heartbeat: false
  };
  var state = { level: 0, dir: 0 };
  var lastTtsAt = 0;

  function ensureCtx() {
    if (!ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      masterGain.gain.value = cfg.volume;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /**
   * 单次脉冲音
   * @param {number} pan -1(左) ~ 1(右)
   * @param {number} freq 频率
   * @param {number} dur 时长(秒)
   */
  function pulse(pan, freq, dur, peak) {
    if (!ensureCtx()) return;
    var t0 = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak || 0.5, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var out = gain;
    if (ctx.createStereoPanner) {
      var panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      out = panner;
    }
    out.connect(masterGain);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function dirText(dir) {
    return dir < 0 ? '往左' : '往右';
  }

  function speak(dir) {
    if (!cfg.ttsEnabled || !global.speechSynthesis) return;
    var now = Date.now();
    if (now - lastTtsAt < 2200) return;
    lastTtsAt = now;
    try {
      global.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(dirText(dir) + '，' + dirText(dir));
      u.lang = 'zh-CN';
      u.rate = 1.5;
      u.pitch = 1.2;
      u.volume = 1;
      global.speechSynthesis.speak(u);
    } catch (e) { /* 忽略不支持语音的环境 */ }
  }

  function vibrate(dir) {
    if (!cfg.vibrateEnabled || !navigator.vibrate) return;
    // 左侧修正 = 短-长；右侧修正 = 长-短（触觉也能分辨方向）
    try {
      navigator.vibrate(dir < 0 ? [60, 90, 160] : [160, 90, 60]);
    } catch (e) { /* noop */ }
  }

  function tick() {
    var level = state.level, dir = state.dir;
    if (level === 0 || dir === 0) return;
    var pan = dir < 0 ? -0.85 : 0.85;
    var freq = dir < 0 ? 620 : 930;

    if (level === 1) {
      pulse(pan, freq, 0.12, 0.28);
    } else if (level === 2) {
      pulse(pan, freq, 0.09, 0.55);
      setTimeout(function () { pulse(pan, freq, 0.09, 0.55); }, 130);
      vibrate(dir);
      speak(dir);
    }
  }

  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (state.level === 0 || state.dir === 0) return;
    var period = state.level === 2 ? 700 : 1200;
    tick(); // 立即反馈一次
    timer = setInterval(tick, period);
  }

  var Feedback = {
    init: function (conf) {
      if (conf) {
        for (var k in conf) if (conf.hasOwnProperty(k)) cfg[k] = conf[k];
      }
      ensureCtx();
      if (masterGain) masterGain.gain.value = cfg.volume;
    },
    setConfig: function (conf) {
      for (var k in conf) if (conf.hasOwnProperty(k)) cfg[k] = conf[k];
      if (masterGain) masterGain.gain.value = cfg.volume;
      if (!cfg.ttsEnabled && global.speechSynthesis) {
        try { global.speechSynthesis.cancel(); } catch (e) { /* noop */ }
      }
    },
    /**
     * @param {number} level 0 安全 / 1 注意 / 2 警告
     * @param {number} dir  -1 应往左 / +1 应往右 / 0 无
     */
    setState: function (level, dir) {
      if (level === state.level && dir === state.dir) return;
      state.level = level;
      state.dir = dir;
      restartTimer();
    },
    stop: function () {
      state.level = 0;
      state.dir = 0;
      if (timer) { clearInterval(timer); timer = null; }
      if (global.speechSynthesis) { try { global.speechSynthesis.cancel(); } catch (e) { /* noop */ } }
    },
    /** 试听：传入 -1 或 +1 */
    test: function (dir) {
      var pan = dir < 0 ? -0.85 : 0.85;
      var freq = dir < 0 ? 620 : 930;
      pulse(pan, freq, 0.16, 0.5);
      speak(dir);
      vibrate(dir);
    },
    /** 提示音：启动 / 丢失跑道 */
    chirp: function (up) {
      ensureCtx();
      pulse(0, up ? 880 : 300, 0.18, 0.35);
    }
  };

  TLG.feedback = Feedback;
})(window);

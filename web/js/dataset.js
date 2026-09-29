/*
 * dataset.js —— 「数据采集与优化」面板
 *
 * 这是把真实跑道数据变成算法改进的入口。设计原则（面向视障使用者）：
 *   · 默认关闭；开启前必须读完一段说明并明确同意
 *   · 所有按钮都有文字标签与 aria 描述，读屏可用；状态用文字表达，不只靠颜色
 *   · 采集中界面常驻醒目提示，任何时候都能一键停止与删除
 *   · 标注只需两次点击（「我在跑道中间」「我正在偏出」），是整套流程里最有价值的数据
 *   · 先本地、后云端：云端是独立的一次显式操作，且必须先登录
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});
  var doc = global.document;

  var CONSENT_TEXT = [
    '开启后，应用会在你跑步时做两件事：',
    '1）每隔约 2 秒保存一帧画面（比正常播放小很多），并记录算法当时的判断结果；',
    '2）你按下的「我在跑道中间」「我正在偏出」会作为真实答案一起记录。',
    '',
    '这些数据只保存在这台手机上，不会自动上传。你可以随时停止、随时删除。',
    '只有当你自己点「上传到云端」并登录之后，才会把数据包发出去，用于改进识别算法。',
    '',
    '请注意：画面里可能拍到其他人。如果你不希望拍到他人，请在使用前选择人少的时段与场地。',
    '应用只录制本软件自己的画面，不会录制手机上的其他内容。'
  ].join('\n');

  function Dataset(opts) {
    this.opts = opts || {};
    this.recorder = opts.recorder;
    this.cloud = opts.cloud;
    this.version = opts.version || '';
    this.buildMeta = opts.buildMeta || function () { return {}; };
    this.root = null;
    this.msg = '';
    this.cloudMsg = '';
  }

  Dataset.prototype.mount = function (container) {
    var self = this;
    this.root = container;
    container.innerHTML =
      '<h3>数据采集与优化</h3>' +
      '<p class="dsNote" id="dsConsentNote">默认关闭。开启后本机保存抽帧画面与算法判断，' +
      '你按的「跑道中间／正在偏出」会作为真实答案一起记录，用于改进识别准确率。' +
      '数据只在这台手机上；上传云端需要你另行点击并登录。</p>' +
      '<div class="dsRow">' +
      '  <button type="button" id="dsToggle" aria-label="开始或停止采集">开始采集</button>' +
      '  <button type="button" id="dsLabelCenter" aria-label="记录：我现在在跑道中间">我在跑道中间</button>' +
      '  <button type="button" id="dsLabelOff" aria-label="记录：我正在偏出跑道">我正在偏出</button>' +
      '</div>' +
      '<div class="dsRow">' +
      '  <button type="button" id="dsExport" aria-label="把采集数据导出到手机">导出到手机</button>' +
      '  <button type="button" id="dsUpload" aria-label="把采集数据上传到云端">上传到云端</button>' +
      '  <button type="button" id="dsClear" aria-label="删除本机全部采集数据">全部删除</button>' +
      '</div>' +
      '<p class="dsStat" id="dsStat" role="status" aria-live="polite">尚未采集</p>' +
      '<p class="dsStat" id="dsMsg" role="status" aria-live="polite"></p>' +
      '<div class="dsCloud" id="dsCloud"></div>';

    this.el = {
      toggle: doc.getElementById('dsToggle'),
      center: doc.getElementById('dsLabelCenter'),
      off: doc.getElementById('dsLabelOff'),
      export: doc.getElementById('dsExport'),
      upload: doc.getElementById('dsUpload'),
      clear: doc.getElementById('dsClear'),
      stat: doc.getElementById('dsStat'),
      msg: doc.getElementById('dsMsg'),
      cloud: doc.getElementById('dsCloud')
    };

    this.el.toggle.addEventListener('click', function () { self.toggleCollect(); });
    this.el.center.addEventListener('click', function () { self.mark('center'); });
    this.el.off.addEventListener('click', function () { self.mark('off'); });
    this.el.export.addEventListener('click', function () { self.exportLocal(); });
    this.el.upload.addEventListener('click', function () { self.uploadCloud(); });
    this.el.clear.addEventListener('click', function () { self.clearAll(); });

    this.recorder.setChangeHandler(function () { self.refresh(); });
    this.refresh();
    this.renderCloud();
  };

  Dataset.prototype.say = function (text) {
    this.msg = text || '';
    if (this.el && this.el.msg) this.el.msg.textContent = this.msg;
  };

  Dataset.prototype.sayCloud = function (text) {
    this.cloudMsg = text || '';
    this.renderCloud();
  };

  /* ---------- 同意与开关 ---------- */

  Dataset.prototype.askConsent = function () {
    var self = this;
    return new Promise(function (resolve) {
      var wrap = doc.createElement('div');
      wrap.className = 'dsOverlay';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-label', '数据采集说明与同意');
      wrap.innerHTML =
        '<div class="dsDialog">' +
        '<h3>开启数据采集前，请先阅读</h3>' +
        '<pre class="dsConsentText"></pre>' +
        '<div class="dsRow">' +
        '  <button type="button" id="dsAgree">同意并开启</button>' +
        '  <button type="button" id="dsCancel">暂不开启</button>' +
        '</div></div>';
      wrap.querySelector('.dsConsentText').textContent = CONSENT_TEXT;
      doc.body.appendChild(wrap);
      wrap.querySelector('#dsAgree').focus();
      wrap.querySelector('#dsAgree').addEventListener('click', function () {
        doc.body.removeChild(wrap);
        self.recorder.giveConsent();
        resolve(true);
      });
      wrap.querySelector('#dsCancel').addEventListener('click', function () {
        doc.body.removeChild(wrap);
        resolve(false);
      });
    });
  };

  Dataset.prototype.toggleCollect = function () {
    var self = this;
    if (this.recorder.enabled) {
      this.recorder.stop();
      this.say('已停止采集。数据仍保存在本机，可随时导出或删除。');
      return;
    }
    // 注意：必须用闭包包一层。直接写 `go = this.askConsent` 会在调用时丢掉 this，
    // askConsent 内部的 self 变成 undefined，点「同意」后抛异常 → resolve 永不执行
    // → 采集永远启动不了（这就是「点了开始采集没反应」的根因）。
    var go = function () { return Promise.resolve(true); };
    if (!this.recorder.consented) go = function () { return self.askConsent(); };
    go().then(function (ok) {
      if (!ok) { self.say('未开启采集。'); return; }
      self.recorder.start();
      self.say('采集中：正在本机保存抽帧与判断结果。跑动中可按「我在跑道中间」「我正在偏出」。');
    });
  };

  Dataset.prototype.mark = function (kind) {
    if (!this.recorder.enabled) {
      this.say('请先点「开始采集」，标注才会生效。');
      return;
    }
    var n = this.recorder.label(kind);
    this.say(n > 0
      ? '已标注最近约 6 秒的 ' + n + ' 条记录为「' + (kind === 'center' ? '在跑道中间' : '正在偏出') + '」。'
      : '这段时间没有可标注的记录，请稍后再试。');
    this.refresh();
  };

  /* ---------- 导出 / 上传 / 删除 ---------- */

  Dataset.prototype.exportLocal = function () {
    if (!this.recorder.stats().count) { this.say('还没有采集到数据。'); return; }
    var size = this.recorder.download(this.meta());
    this.say('已导出到手机下载目录（约 ' + mb(size) + '）。你可以把它发给我用于改进算法。');
  };

  Dataset.prototype.meta = function () {
    var m = this.buildMeta() || {};
    m.version = this.version;
    return m;
  };

  Dataset.prototype.uploadCloud = function () {
    var self = this;
    var st = this.recorder.stats();
    if (!st.count) { this.say('还没有采集到数据。'); return; }
    if (!this.cloud.signedIn()) {
      this.sayCloud('上传前需要先登录：填写邮箱 → 获取验证码 → 输入验证码。');
      this.lastPendingUpload = true;
      return;
    }
    var text;
    try {
      text = this.recorder.exportJson(this.meta());
    } catch (e) {
      this.say('数据打包失败：' + (e && e.message || e));
      return;
    }
    this.say('正在上传（约 ' + mb(text.length) + '）…');
    var name = 'tlg-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    this.cloud.uploadSamples(text, name).then(function (r) {
      self.say('上传成功，云端已收到 ' + mb(r.bytes) + '。感谢你帮助改进识别准确率。');
      self.renderCloud();
    }).catch(function (e) {
      self.say('上传失败：' + (e && e.message || e));
    });
  };

  Dataset.prototype.clearAll = function () {
    var self = this;
    var st = this.recorder.stats();
    if (!st.count) { this.say('本机没有采集数据。'); return; }
    var ok = global.confirm('确定删除本机保存的 ' + st.count + ' 条采集记录吗？云端已上传的数据不受影响，删除后无法恢复。');
    if (!ok) return;
    this.recorder.clear();
    this.say('本机采集数据已全部删除。');
    if (this.recorder.consented) {
      this.recorder.revokeConsent();
    }
  };

  /* ---------- 状态与云端面板 ---------- */

  Dataset.prototype.refresh = function () {
    if (!this.el) return;
    var st = this.recorder.stats();
    this.el.toggle.textContent = st.enabled ? '停止采集' : '开始采集';
    this.el.toggle.className = st.enabled ? 'active' : '';
    this.el.stat.textContent = st.count
      ? ('已采集 ' + st.count + ' 条记录，其中已标注 ' + st.labeled + ' 条，约 ' + mb(st.bytes) +
         (st.enabled ? '，采集中已持续 ' + Math.round(st.durationMs / 1000) + ' 秒' : '（已停止）'))
      : '尚未采集';
    var body = doc.body;
    if (body) body.setAttribute('data-collecting', st.enabled ? 'on' : 'off');
  };

  Dataset.prototype.renderCloud = function () {
    var self = this;
    if (!this.el) return;
    var box = this.el.cloud;

    if (this.cloud.signedIn()) {
      box.innerHTML =
        '<p class="dsStat">已登录：' + esc(this.cloud.email()) + '</p>' +
        '<div class="dsRow"><button type="button" id="dsSignOut">退出登录</button>' +
        '<button type="button" id="dsList">查看云端已上传</button></div>' +
        '<p class="dsStat" id="dsCloudMsg" role="status" aria-live="polite"></p>';
      box.querySelector('#dsSignOut').addEventListener('click', function () {
        self.cloud.signOut().then(function () { self.sayCloud('已退出登录。'); });
      });
      box.querySelector('#dsList').addEventListener('click', function () {
        self.sayCloud('正在查询…');
        self.cloud.listSamples().then(function (r) {
          self.sayCloud('云端已收到 ' + r.count + ' 个数据包，共 ' + mb(r.bytes) + '。');
        }).catch(function (e) { self.sayCloud('查询失败：' + (e && e.message || e)); });
      });
    } else {
      box.innerHTML =
        '<p class="dsStat">云端上传用于把多人的真实数据汇总起来改进算法。需要先用邮箱登录（不用记密码）。</p>' +
        '<div class="dsRow">' +
        '  <input type="email" id="dsEmail" placeholder="邮箱" aria-label="登录邮箱" autocomplete="email">' +
        '  <button type="button" id="dsSend">获取验证码</button>' +
        '</div>' +
        '<div class="dsRow">' +
        '  <input type="text" id="dsCode" placeholder="6 位验证码" aria-label="邮箱验证码" inputmode="numeric">' +
        '  <button type="button" id="dsVerify">登录</button>' +
        '</div>' +
        '<p class="dsStat" id="dsCloudMsg" role="status" aria-live="polite"></p>';
      box.querySelector('#dsSend').addEventListener('click', function () {
        var email = (box.querySelector('#dsEmail').value || '').trim();
        if (!email) { self.sayCloud('请先填写邮箱。'); return; }
        self.sayCloud('正在发送验证码…');
        self.cloud.sendCode(email).then(function () {
          self.sayCloud('验证码已发到 ' + email + '，请查收后在下面输入。');
        }).catch(function (e) { self.sayCloud('发送失败：' + (e && e.message || e)); });
      });
      box.querySelector('#dsVerify').addEventListener('click', function () {
        var code = (box.querySelector('#dsCode').value || '').trim();
        if (!code) { self.sayCloud('请输入收到的验证码。'); return; }
        self.sayCloud('正在登录…');
        self.cloud.verifyCode(code).then(function () {
          self.sayCloud('登录成功。');
          self.renderCloud();
          if (self.lastPendingUpload) { self.lastPendingUpload = false; self.uploadCloud(); }
        }).catch(function (e) { self.sayCloud('登录失败：' + (e && e.message || e)); });
      });
    }
    var m = box.querySelector('#dsCloudMsg');
    if (m && this.cloudMsg) m.textContent = this.cloudMsg;
  };

  function mb(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' 字节';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1048576).toFixed(1) + ' MB';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  TLG.Dataset = Dataset;
})(window);

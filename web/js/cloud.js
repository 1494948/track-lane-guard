/*
 * cloud.js —— 云端能力封装（登录 / 上传采集包）
 *
 * 设计取舍（面向视障使用者）：
 *   1. SDK 按需加载：只有用户主动使用云端功能时才从 CDN 拉 SDK，
 *      保证 APK 离线时完全不依赖网络
 *   2. 登录用「邮箱验证码」而不是密码：视障使用者不必记密码，
 *      邮箱可以用读屏朗读，也是 SDK 支持的最简流程
 *   3. 上传是独立的一次显式操作，且只上传使用者刚刚自己导出过的那个数据包
 *   4. 未登录时所有云端入口只显示说明，不做任何隐式请求
 *
 * 安全边界（遵循云服务规范）：
 *   · endpoint 与 publishableKey 来自公开配置，二者都不带权限
 *   · 身份由 SDK 自动附加，代码里**不手工传 token / uid**
 *   · 上传路径只由 SDK 的 userPath() 生成，不接受外部拼接
 */
(function (global) {
  'use strict';

  var TLG = global.TLG || (global.TLG = {});

  // 公开配置（来自应用激活时返回的 publicConfig，可安全放在前端）
  var PUBLIC_CONFIG = {
    endpoint: 'https://track-lane-guard.app.workbuddy.host',
    publishableKey: 'wbpk_iT1tS5xC3TzTR11gP3299m_PZ7KCwd0c4JOluJgReioTfUDNo81NUkx'
  };

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';

  function Cloud() {
    this.client = null;
    this.session = null;
    this.loading = null;
    this.lastError = '';
    this.pending = null;   // 邮箱验证码流程的中间态
  }

  /** 按需注入 SDK；重复调用复用同一个 Promise */
  Cloud.prototype.ensureSdk = function () {
    var self = this;
    if (this.client) return Promise.resolve(this.client);
    if (this.loading) return this.loading;

    this.loading = new Promise(function (resolve, reject) {
      if (global.WorkBuddyCloud && global.WorkBuddyCloud.createWorkBuddyCloud) {
        resolve();
        return;
      }
      var s = global.document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('云端组件加载失败，请检查网络')); };
      global.document.head.appendChild(s);
    }).then(function () {
      if (!global.WorkBuddyCloud || !global.WorkBuddyCloud.createWorkBuddyCloud) {
        throw new Error('云端组件不可用');
      }
      self.client = global.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: PUBLIC_CONFIG.endpoint,
        publishableKey: PUBLIC_CONFIG.publishableKey
      });
      return self.client;
    }).catch(function (e) {
      self.loading = null;
      self.lastError = String(e && e.message || e);
      throw e;
    });

    return this.loading;
  };

  Cloud.prototype.refreshSession = function () {
    var self = this;
    return this.ensureSdk().then(function (client) {
      return client.auth.getSession();
    }).then(function (res) {
      var session = res && res.data ? res.data : null;
      self.session = session || null;
      return self.session;
    }).catch(function () {
      self.session = null;
      return null;
    });
  };

  Cloud.prototype.signedIn = function () { return !!this.session; };

  Cloud.prototype.email = function () {
    return (this.session && this.session.user && this.session.user.email) || '';
  };

  /** 发送邮箱验证码 */
  Cloud.prototype.sendCode = function (email) {
    var self = this;
    return this.ensureSdk().then(function (client) {
      return client.auth.signInWithOtp({ email: email });
    }).then(function (res) {
      if (res && res.error) throw new Error(res.error.message || '验证码发送失败');
      self.pending = res && res.data ? res.data : null;
      return true;
    });
  };

  /** 用验证码完成登录 */
  Cloud.prototype.verifyCode = function (code) {
    var self = this;
    if (!this.pending) return Promise.reject(new Error('请先获取验证码'));
    return this.ensureSdk().then(function (client) {
      var ch = self.pending;
      if (ch && typeof ch.verify === 'function') {
        return ch.verify({ token: code });
      }
      return client.auth.verifyOtp({ token: code });
    }).then(function (res) {
      if (res && res.error) throw new Error(res.error.message || '验证码不正确或已过期');
      self.pending = null;
      return self.refreshSession().then(function () {
        if (!self.session) throw new Error('登录未完成');
        return self.session;
      });
    });
  };

  Cloud.prototype.signOut = function () {
    var self = this;
    return this.ensureSdk().then(function (client) {
      return client.auth.signOut();
    }).then(function () {
      self.session = null;
      self.pending = null;
    }).catch(function () {
      self.session = null;
    });
  };

  /** 上传采集包（文本 JSON） */
  Cloud.prototype.uploadSamples = function (text, fileName) {
    var self = this;
    return this.refreshSession().then(function (session) {
      if (!session) throw new Error('需要先登录才能上传');
      var uid = session.user && session.user.id;
      if (!uid) throw new Error('登录信息不完整');
      var path = self.client.storage.userPath(uid, 'tlg-samples/' + fileName);
      var blob = new global.Blob([text], { type: 'application/json' });
      return self.client.storage.upload(path, blob, {
        contentType: 'application/json',
        metadata: { purpose: 'track-lane-guard-samples' }
      }).then(function (res) {
        if (res && res.error) throw new Error(res.error.message || '上传失败');
        return { path: path, bytes: blob.size };
      });
    });
  };

  /** 已上传的采集包数量与体积（只读自己的目录） */
  Cloud.prototype.listSamples = function () {
    var self = this;
    return this.refreshSession().then(function (session) {
      if (!session) throw new Error('需要先登录');
      var uid = session.user && session.user.id;
      return self.client.storage.list('users/' + uid + '/tlg-samples', { limit: 200 });
    }).then(function (res) {
      if (res && res.error) throw new Error(res.error.message || '读取失败');
      var items = (res && res.data) || [];
      var bytes = 0;
      for (var i = 0; i < items.length; i++) {
        bytes += (items[i].metadata && items[i].metadata.size) || items[i].size || 0;
      }
      return { count: items.length, bytes: bytes, items: items };
    });
  };

  TLG.Cloud = Cloud;
  TLG.cloudPublicConfig = PUBLIC_CONFIG;
})(window);

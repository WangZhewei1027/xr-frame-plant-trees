import { CONFIG, supabaseRpc } from "../../utils/supabase";

interface LocationData {
  latitude: number;
  longitude: number;
  altitude: number;
  latStr: string;
  lngStr: string;
  accuracyStr: string;
  altitudeStr: string;
}

Page({
  data: {
    width: 300,
    height: 300,
    renderWidth: 300,
    renderHeight: 300,
    textContent: "",
    location: null as LocationData | null,
    isSubmitting: false,
    canSubmit: false,
    showShopPanel: false,
    shopCheckinEnabled: false,
    footerEnabled: false,
    compassHeading: 0,
    showGpsDebug: false,
  },

  onLoad(_options: Record<string, string | undefined>) {
    // CONFIG 已由 index.ts 的 setConfig 设置（扫码 → Storage → 模块初始化）；
    // ar.ts 始终由 goToAR() 跳转进入，不应在此持久化 URL 参数，
    // 否则微信「最近使用」场景下的过期 URL 会覆盖更新的 Storage 扫码结果。
    const {
      windowWidth: width,
      windowHeight: height,
      pixelRatio: dpi,
    } = wx.getSystemInfoSync();
    // 渲染分辨率降采样：GPU 像素量随系数平方下降（0.5 → 75% 省），
    // AR 相机背景本身有噪点，观感几乎无损；卡顿/发热时可再降，画质不满时上调。
    const RENDER_SCALE = 0.5;
    this.setData({
      width,
      height,
      renderWidth: Math.round(width * dpi * RENDER_SCALE),
      renderHeight: Math.round(height * dpi * RENDER_SCALE),
    });
    this.getLocation();
    // 持续定位：使用 startLocationUpdate + onLocationChange，被动接收 GPS 更新，
    // 比 setInterval(getLocation, 5000) 更省电、回调更新更平滑（不会与 XR 渲染帧争用主线程）
    if (wx.startLocationUpdate) {
      wx.startLocationUpdate({
        success: () => {
          (this as any)._locationListener = (
            res: WechatMiniprogram.OnLocationChangeCallbackResult,
          ) => {
            this.setData({
              location: this._buildLocation(res),
              canSubmit: this.data.textContent.trim().length > 0,
            });
          };
          wx.onLocationChange((this as any)._locationListener);
        },
        // 失败时退化为低频轮询（10s 一次，足够标记位置使用，且不阻塞渲染）
        fail: () => {
          (this as any)._locationTimer = setInterval(
            () => this.getLocation(),
            10000,
          );
        },
      });
    } else {
      (this as any)._locationTimer = setInterval(
        () => this.getLocation(),
        10000,
      );
    }
    // 罗盘订阅
    this._startCompassWatch();
  },

  onUnload() {
    if ((this as any)._locationTimer) {
      clearInterval((this as any)._locationTimer);
      (this as any)._locationTimer = null;
    }
    if ((this as any)._locationListener && wx.offLocationChange) {
      try {
        wx.offLocationChange((this as any)._locationListener);
      } catch (_) {}
      (this as any)._locationListener = null;
    }
    if (wx.stopLocationUpdate) {
      try {
        wx.stopLocationUpdate();
      } catch (_) {}
    }
    this._stopCompassWatch();
  },

  onTextInput(e: WechatMiniprogram.Input) {
    const textContent = e.detail.value;
    this.setData({
      textContent,
      canSubmit: textContent.trim().length > 0 && this.data.location !== null,
    });
  },

  /** 把 wx.getLocation / onLocationChange 的结果统一成页面用的 LocationData */
  _buildLocation(res: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    altitude?: number;
  }): LocationData {
    const accuracy = res.accuracy;
    const altitude = res.altitude;
    return {
      latitude: res.latitude,
      longitude: res.longitude,
      altitude: altitude ?? 0,
      latStr: res.latitude.toFixed(6),
      lngStr: res.longitude.toFixed(6),
      accuracyStr:
        typeof accuracy === "number" ? `±${accuracy.toFixed(1)}m` : "--",
      altitudeStr:
        typeof altitude === "number" ? `${altitude.toFixed(1)}m` : "--",
    };
  },

  getLocation() {
    wx.getLocation({
      type: "wgs84",
      success: (res) => {
        this.setData({
          location: this._buildLocation(res),
          canSubmit: this.data.textContent.trim().length > 0,
        });
      },
      fail: () => {
        this.setData({ location: null, canSubmit: false });
      },
    });
  },

  /** 点击 GPS 灯泡：开关调试小窗；打开时拉一次高精度定位（带海拔）刷新数据 */
  toggleGpsDebug() {
    const show = !this.data.showGpsDebug;
    this.setData({ showGpsDebug: show });
    if (!show) return;
    wx.getLocation({
      type: "wgs84",
      altitude: true,
      isHighAccuracy: true,
      highAccuracyExpireTime: 3500,
      success: (res) => {
        // 弹窗可能在回调前已被关掉，数据照常更新即可
        this.setData({
          location: this._buildLocation(res),
          canSubmit: this.data.textContent.trim().length > 0,
        });
      },
    });
  },

  async submitText() {
    const { textContent, location } = this.data;
    if (!textContent.trim() || !location) {
      wx.showToast({ title: "请填写内容", icon: "none" });
      return;
    }

    const sendText = textContent.trim();
    this.setData({ textContent: "", canSubmit: false });
    const xrComp = this.selectComponent("#main-frame");
    if (xrComp) {
      xrComp.showDanmakuInXR(sendText);
    }

    this.setData({ isSubmitting: true });
    try {
      const { statusCode } = await supabaseRpc("upload_text_asset", {
        user_lat: location.latitude,
        user_lng: location.longitude,
        p_workspace_id: CONFIG.workspaceId,
        p_organization_id: CONFIG.organizationId,
        content: sendText,
      });

      if (statusCode !== 200) {
        throw new Error(`上传失败: ${statusCode}`);
      }
    } catch (err) {
      console.error("[上传] 错误:", err);
      wx.showToast({ title: "发送失败", icon: "error" });
    } finally {
      this.setData({ isSubmitting: false });
    }
  },

  toggleShopPanel() {
    this.setData({ showShopPanel: !this.data.showShopPanel });
  },

  onOrgConfigLoad(e: WechatMiniprogram.CustomEvent) {
    const { shopCheckinEnabled, footerEnabled } = e.detail;
    this.setData({
      shopCheckinEnabled: shopCheckinEnabled === true,
      footerEnabled: !!footerEnabled,
    });
  },

  /** 店铺导航目标变更时，同步到 XR 组件 */
  onShopNavChange(e: WechatMiniprogram.CustomEvent) {
    const { shop } = e.detail;
    const xrComp = this.selectComponent("#main-frame") as any;
    if (xrComp) xrComp.setNavigationTarget(shop);
  },

  // ========== 罗盘 ==========

  _startCompassWatch() {
    wx.startCompass({
      success: () => {
        // 罗盘传感器 10-60Hz，每 tick setData+selectComponent 会与 XR 渲染争用主线程。
        // 节流：变化 <2° 或距上次 <200ms 时跳过；组件引用只解析一次。
        let lastHeading = -Infinity;
        let lastTime = 0;
        let xrComp: any = null;
        wx.onCompassChange((res: any) => {
          const heading: number = res.direction ?? res.heading ?? 0;
          const now = Date.now();
          let delta = Math.abs(heading - lastHeading);
          if (delta > 180) delta = 360 - delta; // 跨 0°/360° 边界
          if (delta < 2 || now - lastTime < 200) return;
          lastHeading = heading;
          lastTime = now;
          this.setData({ compassHeading: heading });
          if (!xrComp) xrComp = this.selectComponent("#main-frame");
          if (xrComp) xrComp.updateCompassHeading(heading);
        });
      },
    });
  },

  _stopCompassWatch() {
    wx.stopCompass({});
  },
});

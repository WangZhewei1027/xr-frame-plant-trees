import { CONFIG, supabaseRpc, setConfig } from "../../utils/supabase";

interface LocationData {
  latitude: number;
  longitude: number;
  altitude: number;
  latStr: string;
  lngStr: string;
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
    compassHeading: 0,
  },

  onLoad(options: Record<string, string | undefined>) {
    setConfig({
      organizationId: options.organizationId,
      workspaceId: options.workspaceId,
    });
    const {
      windowWidth: width,
      windowHeight: height,
      pixelRatio: dpi,
    } = wx.getSystemInfoSync();
    this.setData({
      width,
      height,
      renderWidth: width * dpi,
      renderHeight: height * dpi,
    });
    this.getLocation();
    // 持续定位
    (this as any)._locationTimer = setInterval(() => this.getLocation(), 5000);
    // 罗盘订阅
    this._startCompassWatch();
  },

  onUnload() {
    if ((this as any)._locationTimer) {
      clearInterval((this as any)._locationTimer);
      (this as any)._locationTimer = null;
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

  getLocation() {
    wx.getLocation({
      type: "wgs84",
      success: (res) => {
        this.setData({
          location: {
            latitude: res.latitude,
            longitude: res.longitude,
            altitude: res.altitude ?? 0,
            latStr: res.latitude.toFixed(6),
            lngStr: res.longitude.toFixed(6),
          },
          canSubmit: this.data.textContent.trim().length > 0,
        });
      },
      fail: () => {
        this.setData({ location: null, canSubmit: false });
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
        wx.onCompassChange((res: any) => {
          const heading: number = res.direction ?? res.heading ?? 0;
          this.setData({ compassHeading: heading });
          const xrComp = this.selectComponent("#main-frame") as any;
          if (xrComp) xrComp.updateCompassHeading(heading);
        });
      },
    });
  },

  _stopCompassWatch() {
    wx.stopCompass({});
  },
});

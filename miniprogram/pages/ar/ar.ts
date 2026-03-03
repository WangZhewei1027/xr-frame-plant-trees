import { CONFIG, supabaseRpc } from "../../utils/supabase";

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
  },

  onLoad() {
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

    this.setData({ isSubmitting: true });
    try {
      const { statusCode } = await supabaseRpc("upload_text_asset", {
        user_lat: location.latitude,
        user_lng: location.longitude,
        p_workspace_id: CONFIG.workspaceId,
        p_organization_id: CONFIG.organizationId,
        content: textContent.trim(),
      });

      if (statusCode === 200) {
        wx.showToast({ title: "上传成功", icon: "success" });
        this.setData({ textContent: "", canSubmit: false });
      } else {
        throw new Error(`上传失败: ${statusCode}`);
      }
    } catch (err) {
      console.error("[上传] 错误:", err);
      wx.showToast({ title: "上传失败", icon: "error" });
    } finally {
      this.setData({ isSubmitting: false });
    }
  },
});

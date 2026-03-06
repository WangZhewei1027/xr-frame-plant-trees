import { CONFIG, supabaseRpc } from "../../utils/supabase";

interface LocationData {
  latitude: number;
  longitude: number;
  altitude: number;
  latStr: string;
  lngStr: string;
}

interface ShopItem {
  id: string;
  name: string;
  file_url: string;
  text_content: string;
  anchor_id: string;
  tag_ids: string[];
  metadata: { checkin_url?: string; [k: string]: any };
  longitude: number;
  latitude: number;
  create_at: string;
  distance?: number;
  canCheckin?: boolean;
}

/** Haversine 公式计算两点间距离（米） */
function getDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    // 店铺列表
    showShopPanel: false,
    shops: [] as ShopItem[],
    shopsLoading: false,
    // 打卡弹窗
    showCheckinModal: false,
    checkinImageUrl: "",
    checkinShopName: "",
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
    // 持续定位，用于距离判断
    (this as any)._locationTimer = setInterval(() => this.getLocation(), 5000);
  },

  onUnload() {
    if ((this as any)._locationTimer) {
      clearInterval((this as any)._locationTimer);
      (this as any)._locationTimer = null;
    }
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
        // 位置变化后刷新店铺距离
        if (this.data.showShopPanel) {
          this.refreshShopDistances();
        }
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

    // 立即在 XR 空间中发射弹幕
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

  // ========== 店铺相关 ==========

  async toggleShopPanel() {
    const show = !this.data.showShopPanel;
    this.setData({ showShopPanel: show });
    if (show && this.data.shops.length === 0) {
      await this.loadShops();
    } else if (show) {
      this.refreshShopDistances();
    }
  },

  async loadShops() {
    this.setData({ shopsLoading: true });
    try {
      const { statusCode, data } = await supabaseRpc<ShopItem[]>(
        "get_shop_assets",
        {
          p_workspace_id: CONFIG.workspaceId,
          p_organization_id: CONFIG.organizationId,
        },
      );
      if (statusCode !== 200 || !Array.isArray(data)) {
        throw new Error(`获取店铺失败: ${statusCode}`);
      }
      const shops = this.computeDistances(data);
      this.setData({ shops });
    } catch (err) {
      console.error("[店铺] 加载错误:", err);
      wx.showToast({ title: "加载店铺失败", icon: "error" });
    } finally {
      this.setData({ shopsLoading: false });
    }
  },

  /** 计算每个店铺与当前位置的距离 */
  computeDistances(shops: ShopItem[]): ShopItem[] {
    const loc = this.data.location;
    if (!loc)
      return shops.map((s) => ({
        ...s,
        distance: undefined,
        canCheckin: false,
      }));
    return shops.map((s) => {
      const dist = getDistanceMeters(
        loc.latitude,
        loc.longitude,
        s.latitude,
        s.longitude,
      );
      return { ...s, distance: Math.round(dist), canCheckin: dist <= 50 };
    });
  },

  /** 位置更新后刷新距离 */
  refreshShopDistances() {
    if (this.data.shops.length === 0) return;
    const shops = this.computeDistances(this.data.shops);
    this.setData({ shops });
  },

  /** 点击打卡按钮 */
  onCheckin(e: WechatMiniprogram.BaseEvent) {
    const idx = e.currentTarget.dataset.idx as number;
    const shop = this.data.shops[idx];
    if (!shop || !shop.canCheckin) {
      wx.showToast({ title: "距离店铺太远，请靠近后再试", icon: "none" });
      return;
    }
    const checkinUrl = shop.metadata?.checkin_url;
    if (!checkinUrl) {
      wx.showToast({ title: "该店铺暂无打卡图", icon: "none" });
      return;
    }
    this.setData({
      showCheckinModal: true,
      checkinImageUrl: checkinUrl,
      checkinShopName: shop.name,
    });
  },

  closeCheckinModal() {
    this.setData({
      showCheckinModal: false,
      checkinImageUrl: "",
      checkinShopName: "",
    });
  },

  /** 保存打卡图到相册 */
  saveCheckinImage() {
    const url = this.data.checkinImageUrl;
    if (!url) return;
    wx.showLoading({ title: "保存中…" });
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode !== 200) {
          wx.hideLoading();
          wx.showToast({ title: "下载失败", icon: "error" });
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.hideLoading();
            wx.showToast({ title: "已保存到相册", icon: "success" });
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: "保存失败，请授权相册权限", icon: "none" });
          },
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "下载失败", icon: "error" });
      },
    });
  },

  closeShopPanel() {
    this.setData({ showShopPanel: false });
  },
});

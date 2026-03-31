import { CONFIG, supabaseRpc, setConfig } from "../../utils/supabase";

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

/** Haversine 方位角：从 (lat1,lng1) 到 (lat2,lng2)，正北=0，顺时针，度 */
function getBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
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
    selectedShopIdx: 0,
    // 打卡弹窗
    showCheckinModal: false,
    checkinImageUrl: "",
    checkinShopName: "",
    // 导航视图
    isNavigating: false,
    navShopName: "",
    navDistance: "",
    navRelAngle: 0, // 目标相对设备朝向的角度[-180,180]，用于 UI 箭头旋转
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
    // 持续定位，用于距离判断
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
      // 自动导航到第一个店铺
      if (shops.length > 0) {
        this._activateNavigation(shops[0]);
      }
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
    // 同步更新导航 UI 距离
    this._refreshNavUI();
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
    // 用 getImageInfo 获取网络图片的本地临时路径
    wx.getImageInfo({
      src: url,
      success: (imgRes) => {
        wx.saveImageToPhotosAlbum({
          filePath: imgRes.path,
          success: () => {
            wx.hideLoading();
            wx.showToast({ title: "已保存到相册", icon: "success" });
          },
          fail: (err) => {
            wx.hideLoading();
            // 用户拒绝授权时引导开启
            if (/auth|deny|authorize/i.test(String(err?.errMsg))) {
              wx.showModal({
                title: "需要相册权限",
                content: "请在设置中开启相册权限以保存图片",
                confirmText: "去设置",
                success: (modalRes) => {
                  if (modalRes.confirm) {
                    wx.openSetting({});
                  }
                },
              });
            } else {
              wx.showToast({ title: "保存失败", icon: "error" });
            }
          },
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: "图片加载失败", icon: "error" });
      },
    });
  },

  closeShopPanel() {
    this.setData({ showShopPanel: false });
  },

  /** swiper 切换时更新选中索引 */
  onSwiperChange(e: WechatMiniprogram.SwiperChange) {
    const idx = e.detail.current;
    this.setData({ selectedShopIdx: idx });
    // 切换店铺就更新导航目标
    const shop = this.data.shops[idx];
    if (shop) this._activateNavigation(shop);
  },

  // ========== 罗盘 / 导航 ==========

  _startCompassWatch() {
    wx.startCompass({
      success: () => {
        wx.onCompassChange((res: any) => {
          const heading: number = res.direction ?? res.heading ?? 0;
          (this as any)._compassHeading = heading;
          // 将最新航向推送到 XR 组件
          const xrComp = this.selectComponent("#main-frame") as any;
          if (xrComp) xrComp.updateCompassHeading(heading);
          // 更新 UI 跦向负荷
          this._refreshNavUI();
        });
      },
    });
  },

  _stopCompassWatch() {
    wx.stopCompass({});
  },

  /** 激活指定店铺的导航 */
  _activateNavigation(shop: ShopItem) {
    const xrComp = this.selectComponent("#main-frame") as any;
    if (xrComp) xrComp.setNavigationTarget(shop);
    this.setData({
      isNavigating: true,
      navShopName: shop.name,
      navDistance: shop.distance != null ? `${shop.distance}m` : "",
    });
    this._refreshNavUI();
  },

  /** 根据最新 GPS + 罗盘计算 UI 跦向角 */
  _refreshNavUI() {
    if (!this.data.isNavigating) return;
    const loc = this.data.location;
    const shops = this.data.shops;
    const idx = this.data.selectedShopIdx;
    const shop = shops[idx];
    if (!loc || !shop) return;

    const bearing = getBearing(
      loc.latitude,
      loc.longitude,
      shop.latitude,
      shop.longitude,
    );
    const compass = (this as any)._compassHeading ?? 0;
    let relAngle = bearing - compass;
    relAngle = ((relAngle + 540) % 360) - 180;

    const dist = getDistanceMeters(
      loc.latitude,
      loc.longitude,
      shop.latitude,
      shop.longitude,
    );
    this.setData({
      navRelAngle: Math.round(relAngle),
      navDistance: `${Math.round(dist)}m`,
    });
  },
});

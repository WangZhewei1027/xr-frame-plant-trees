import { CONFIG, supabaseRpc } from "../../utils/supabase";

/** Haversine 公式计算两点间距离（米） */
function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Haversine 方位角：正北=0，顺时针，度 */
function getBearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

Component({
  properties: {
    /** 当前 GPS 位置，由父页面传入 { latitude, longitude } */
    location: {
      type: Object,
      value: null,
    },
    /** 面板是否可见 */
    visible: {
      type: Boolean,
      value: false,
    },
    /** 罗盘航向角（度），由父页面传入 */
    compassHeading: {
      type: Number,
      value: 0,
    },
  },

  data: {
    shops: [],
    shopsLoading: false,
    selectedShopIdx: 0,
    // 打卡弹窗
    showCheckinModal: false,
    checkinImageUrl: "",
    checkinShopName: "",
    // 已打卡记录（持久化到 storage）
    checkedInShopIds: {},
    // 导航 UI
    isNavigating: false,
    navShopName: "",
    navDistance: "",
    navRelAngle: 0,
  },

  lifetimes: {
    attached() {
      // 从 storage 恢复打卡记录
      try {
        const saved = wx.getStorageSync("checkedInShopIds");
        if (saved && typeof saved === "object") {
          this.setData({ checkedInShopIds: saved });
        }
      } catch (e) {
        console.error("[打卡] 读取缓存失败:", e);
      }
    },
  },

  observers: {
    /** visible 变为 true 时自动加载店铺 */
    visible(val) {
      if (val && this.data.shops.length === 0) {
        this.loadShops();
      } else if (val) {
        this._refreshDistances();
      }
      if (!val) {
        this.setData({ isNavigating: false });
      }
    },
    /** location 变化时刷新距离 */
    location() {
      if (this.data.visible && this.data.shops.length > 0) {
        this._refreshDistances();
      }
    },
    /** compassHeading 变化时刷新导航 UI */
    compassHeading() {
      this._refreshNavUI();
    },
  },

  methods: {
    // ========== 店铺加载 ==========

    async loadShops() {
      this.setData({ shopsLoading: true });
      try {
        const { statusCode, data } = await supabaseRpc("get_shop_assets", {
          p_workspace_id: CONFIG.workspaceId,
          p_organization_id: CONFIG.organizationId,
        });
        if (statusCode !== 200 || !Array.isArray(data)) {
          throw new Error(`获取店铺失败: ${statusCode}`);
        }
        const shops = this._computeDistances(data);
        this.setData({ shops });
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

    // ========== 距离计算 ==========

    _computeDistances(shops) {
      const loc = this.properties.location;
      if (!loc) {
        return shops.map((s) => ({
          ...s,
          distance: undefined,
          canCheckin: false,
        }));
      }
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

    _refreshDistances() {
      if (this.data.shops.length === 0) return;
      const shops = this._computeDistances(this.data.shops);
      this.setData({ shops });
      this._refreshNavUI();
    },

    // ========== 打卡 ==========

    onCheckin(e) {
      const idx = e.currentTarget.dataset.idx;
      const shop = this.data.shops[idx];
      if (!shop) return;

      const checkinUrl = shop.metadata && shop.metadata.checkin_url;
      if (!checkinUrl) {
        wx.showToast({ title: "该店铺暂无打卡图", icon: "none" });
        return;
      }

      const alreadyCheckedIn = !!this.data.checkedInShopIds[shop.id];
      if (!alreadyCheckedIn && !shop.canCheckin) {
        wx.showToast({ title: "距离店铺太远，请靠近后再试", icon: "none" });
        return;
      }

      // 首次打卡：持久化记录
      if (!alreadyCheckedIn) {
        const updated = Object.assign({}, this.data.checkedInShopIds, {
          [shop.id]: true,
        });
        this.setData({ checkedInShopIds: updated });
        try {
          wx.setStorageSync("checkedInShopIds", updated);
        } catch (err) {
          console.error("[打卡] 写入缓存失败:", err);
        }
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

    saveCheckinImage() {
      const url = this.data.checkinImageUrl;
      if (!url) return;
      wx.showLoading({ title: "保存中…" });
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
              if (/auth|deny|authorize/i.test(String(err && err.errMsg))) {
                wx.showModal({
                  title: "需要相册权限",
                  content: "请在设置中开启相册权限以保存图片",
                  confirmText: "去设置",
                  success: (modalRes) => {
                    if (modalRes.confirm) wx.openSetting({});
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

    // ========== Swiper ==========

    onSwiperChange(e) {
      const idx = e.detail.current;
      this.setData({ selectedShopIdx: idx });
      const shop = this.data.shops[idx];
      if (shop) this._activateNavigation(shop);
    },

    // ========== 导航 ==========

    _activateNavigation(shop) {
      this.setData({
        isNavigating: true,
        navShopName: shop.name,
        navDistance: shop.distance != null ? `${shop.distance}m` : "",
      });
      this._refreshNavUI();
      // 通知父页面导航目标变更
      this.triggerEvent("navchange", { shop });
    },

    _refreshNavUI() {
      if (!this.data.isNavigating) return;
      const loc = this.properties.location;
      const shop = this.data.shops[this.data.selectedShopIdx];
      if (!loc || !shop) return;

      const bearing = getBearing(
        loc.latitude,
        loc.longitude,
        shop.latitude,
        shop.longitude,
      );
      const compass = this.properties.compassHeading || 0;
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
  },
});

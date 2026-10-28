import { CONFIG, fetchActivities, submitActivityRecord } from "../../utils/backend";
import {
  acceptActivityDiscovery, activityParticipantId, activityRequestKey, danmakuMaxLength, nextActivityDiscoverySequence, parseActivityPlacements, withinActivityScope,
  type ActivityPlacement, type ActivitySubmission,
} from "../../utils/activity-state";

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
    shopActivities: [] as ActivityPlacement[],
    danmakuActivities: [] as ActivityPlacement[],
    activeDanmaku: null as ActivityPlacement | null,
    selectedDanmakuIdx: 0,
    danmakuLimit: 200,
    danmakuInRange: false,
    activitiesLoading: false,
    activitiesError: "",
    footerEnabled: false,
    compassHeading: 0,
    showGpsDebug: false,
    retrievalMode: "gps",
    recognitionStatus: "等待 AR 相机就绪",
    recognitionFramePath: "",
    recognitionFrameInfo: "",
    recognitionFrameRequest: "",
    showRecognitionPreview: false,
  },

  onRetrievalModeChange(event: WechatMiniprogram.TouchEvent) {
    const mode = event.currentTarget.dataset.mode;
    if (
      (mode !== "gps" && mode !== "anchor") ||
      mode === this.data.retrievalMode
    )
      return;
    this.setData({
      retrievalMode: mode,
      recognitionStatus: "等待 AR 相机就绪",
    });
    this.selectComponent("#main-frame")?.setRetrievalMode(mode);
    this.refreshCanSubmit();
  },

  onAssetError(event: WechatMiniprogram.CustomEvent) {
    const message = event.detail?.message || "素材加载失败";
    const now = Date.now();
    if (now - ((this as any)._lastAssetErrorAt || 0) < 5000) return;
    (this as any)._lastAssetErrorAt = now;
    wx.showToast({ title: String(message).slice(0, 50), icon: "none", duration: 3000 });
  },

  onRecognitionStatus(event: WechatMiniprogram.CustomEvent) {
    if (event.detail.mode === this.data.retrievalMode) {
      this.setData({ recognitionStatus: event.detail.message });
    }
  },

  onRecognitionFrame(event: WechatMiniprogram.CustomEvent) {
    const frame = event.detail;
    const score = typeof frame.bestSimilarity === "number" ? frame.bestSimilarity.toFixed(3) : "未提供";
    const threshold = typeof frame.threshold === "number" ? frame.threshold.toFixed(2) : "未提供";
    this.setData({
      recognitionFramePath: typeof frame.path === "string" ? frame.path : "",
      recognitionFrameInfo: frame.path
        ? `${frame.width || "?"} × ${frame.height || "?"} · 旋转 ${frame.rotation || 0}° · 相似度 ${score} / 阈值 ${threshold}`
        : "",
      recognitionFrameRequest: frame.requestId || "",
    });
  },

  onPreviewRecognitionFrame() {
    if (!this.data.recognitionFramePath || this.data.retrievalMode !== "anchor") return;
    this.selectComponent("#main-frame")?.pauseRetrieval();
    this.setData({ showRecognitionPreview: true });
  },

  onCloseRecognitionPreview() {
    this.setData({ showRecognitionPreview: false });
    this.selectComponent("#main-frame")?.resumeRetrieval();
  },

  onRecognitionPreviewError() {
    this.setData({ recognitionFrameInfo: "图片已失效，请关闭后重新识别一次" });
  },

  onHide() {
    (this as any)._activityVisible = false;
    (this as any)._activityRequest = ((this as any)._activityRequest || 0) + 1;
    this.selectComponent("#main-frame")?.pauseRetrieval();
  },

  onShow() {
    (this as any)._activityVisible = true;
    void this.refreshActivities();
    if (!this.data.showRecognitionPreview) this.selectComponent("#main-frame")?.resumeRetrieval();
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
            });
            this.refreshCanSubmit();
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
    (this as any)._unloaded = true;
    (this as any)._activityVisible = false;
    (this as any)._activityRequest = ((this as any)._activityRequest || 0) + 1;
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
    if (this.data.isSubmitting) return;
    const textContent = e.detail.value;
    if (textContent !== this.data.textContent) (this as any)._danmakuIntent = null;
    this.setData({ textContent });
    this.refreshCanSubmit();
  },

  async refreshActivities() {
    const requestId = ((this as any)._activityRequest || 0) + 1;
    (this as any)._activityRequest = requestId;
    const workspaceId = CONFIG.workspaceId;
    const organizationId = CONFIG.organizationId;
    if (!organizationId || CONFIG.sceneId) {
      this.setData({ shopActivities: [], danmakuActivities: [], activeDanmaku: null, shopCheckinEnabled: false, showShopPanel: false, canSubmit: false, activitiesLoading: false, activitiesError: "" });
      return;
    }
    this.setData({ activitiesLoading: true, activitiesError: "" });
    const discoverySequence = nextActivityDiscoverySequence();
    try {
      const response = await fetchActivities(workspaceId, organizationId);
      if (response.statusCode !== 200) throw new Error("活动加载失败");
      const activities = parseActivityPlacements(response.data, !workspaceId);
      if ((this as any)._unloaded || requestId !== (this as any)._activityRequest) return;
      this.applyActivities(activities, discoverySequence);
    } catch (error) {
      if ((this as any)._unloaded || requestId !== (this as any)._activityRequest) return;
      if (!this.applyActivities([], discoverySequence)) return;
      console.error("[活动] 加载失败:", error);
      this.setData({ shopActivities: [], danmakuActivities: [], activeDanmaku: null, shopCheckinEnabled: false, showShopPanel: false, canSubmit: false, activitiesError: "活动加载失败，点击重试" });
      this.selectComponent("#main-frame")?.setNavigationTarget(null);
    } finally {
      if (!(this as any)._unloaded && requestId === (this as any)._activityRequest) this.setData({ activitiesLoading: false });
    }
  },

  onActivitiesLoad(event: WechatMiniprogram.CustomEvent) {
    if ((this as any)._unloaded || (this as any)._activityVisible === false) return;
    // The XR module validates the discovery response before emitting it.
    if (!Number.isInteger(event.detail.discoverySequence)) return;
    if (this.applyActivities(event.detail.activities, event.detail.discoverySequence)) {
      this.setData({ activitiesError: event.detail.error ? "活动加载失败，点击重试" : "" });
    }
  },

  applyActivities(activities: ActivityPlacement[], discoverySequence: number): boolean {
    if (discoverySequence < ((this as any)._appliedActivityDiscovery || 0)) return false;
    if (!acceptActivityDiscovery(discoverySequence)) return false;
    (this as any)._appliedActivityDiscovery = discoverySequence;
    const shopActivities = activities.filter((activity) => activity.type === "shop_checkin");
    const danmakuActivities = activities.filter((activity) => activity.type === "danmaku");
    const selected = Math.max(0, danmakuActivities.findIndex((activity) => activity.id === this.data.activeDanmaku?.id));
    const activeDanmaku = danmakuActivities[selected] || null;
    this.setData({ shopActivities, danmakuActivities, activeDanmaku, selectedDanmakuIdx: selected, danmakuLimit: danmakuMaxLength(activeDanmaku),
      shopCheckinEnabled: shopActivities.length > 0, showShopPanel: shopActivities.length > 0 && this.data.showShopPanel });
    this.selectComponent("#main-frame")?.applyActivityAvailability?.(activities, discoverySequence);
    if (!shopActivities.length) this.selectComponent("#main-frame")?.setNavigationTarget(null);
    this.refreshCanSubmit();
    return true;
  },

  onDanmakuActivityChange(event: WechatMiniprogram.PickerChange) {
    if (this.data.isSubmitting) return;
    const selectedDanmakuIdx = Number(event.detail.value);
    const activeDanmaku = this.data.danmakuActivities[selectedDanmakuIdx];
    if (!activeDanmaku) return;
    (this as any)._danmakuIntent = null;
    this.setData({ selectedDanmakuIdx, activeDanmaku, danmakuLimit: danmakuMaxLength(activeDanmaku) });
    this.refreshCanSubmit();
  },

  refreshCanSubmit() {
    const text = this.data.textContent.trim();
    const danmakuInRange = withinActivityScope(this.data.activeDanmaku, this.data.location);
    this.setData({ danmakuInRange, canSubmit: !!text && text.length <= this.data.danmakuLimit && danmakuInRange && !this.data.isSubmitting && this.data.retrievalMode === "gps" });
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
        });
        this.refreshCanSubmit();
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
        });
        this.refreshCanSubmit();
      },
    });
  },

  async submitText() {
    if (this.data.isSubmitting) return;
    this.refreshCanSubmit();
    const { textContent, location, activeDanmaku } = this.data;
    if (!this.data.canSubmit || !location || !activeDanmaku) {
      wx.showToast({ title: !activeDanmaku ? "当前没有留言活动" : !location ? "请等待定位" : !this.data.danmakuInRange ? "请进入活动范围" : this.data.retrievalMode !== "gps" ? "请切换到 GPS 模式" : "请检查留言内容", icon: "none" });
      return;
    }
    const sendText = textContent.trim();
    let intent = (this as any)._danmakuIntent as ActivitySubmission | null;
    if (!intent || intent.placement_id !== activeDanmaku.id || intent.content !== sendText) {
      intent = { placement_id: activeDanmaku.id, kind: "danmaku", content: sendText, user_lat: location.latitude, user_lng: location.longitude,
        participant_id: activityParticipantId(), idempotency_key: activityRequestKey() };
      (this as any)._danmakuIntent = intent;
    }
    this.setData({ isSubmitting: true, canSubmit: false });
    try {
      const response = await submitActivityRecord(intent);
      if (response.statusCode !== 200 || typeof response.data?.id !== "string") {
        if (response.statusCode >= 400 && response.statusCode < 500) (this as any)._danmakuIntent = null;
        throw new Error(response.data?.error || "发送失败，请重试");
      }
      (this as any)._danmakuIntent = null;
      if ((this as any)._unloaded) return;
      if (this.data.textContent === textContent) this.setData({ textContent: "" });
      if ((this as any)._activityVisible !== false && this.data.activeDanmaku?.id === intent.placement_id) this.selectComponent("#main-frame")?.showDanmakuInXR(sendText, response.data);
    } catch (err) {
      console.error("[活动留言] 发送失败:", err);
      if (!(this as any)._unloaded) wx.showToast({ title: "发送失败，内容已保留", icon: "none" });
    } finally {
      if (!(this as any)._unloaded) {
        this.setData({ isSubmitting: false });
        this.refreshCanSubmit();
      }
    }
  },

  toggleShopPanel() {
    this.setData({ showShopPanel: !this.data.showShopPanel });
  },

  onOrgConfigLoad(e: WechatMiniprogram.CustomEvent) {
    const { footerEnabled } = e.detail;
    this.setData({
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

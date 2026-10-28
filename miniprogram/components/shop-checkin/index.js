import { fetchActivityProgress, submitActivityRecord } from "../../utils/backend";
import { activityDistance, activityParticipantId, activityRequestKey, validActivityLocation, withinActivityScope } from "../../utils/activity-state";

/** Haversine bearing: north = 0, clockwise, degrees. */
function getBearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

Component({
  properties: {
    activities: { type: Array, value: [] },
    location: { type: Object, value: null },
    visible: { type: Boolean, value: false },
    compassHeading: { type: Number, value: 0 },
  },

  data: {
    activeActivity: null,
    selectedActivityIdx: 0,
    shops: [],
    shopsLoading: false,
    progressError: "",
    selectedShopIdx: 0,
    showCheckinModal: false,
    checkinImageUrl: "",
    checkinShopName: "",
    checkedPointIds: {},
    submittingPointId: "",
    isNavigating: false,
    navShopName: "",
    navDistance: "",
    navRelAngle: 0,
    checkedInCount: 0,
  },

  lifetimes: {
    attached() { this._detached = false; this._selectActivity(); },
    detached() { this._detached = true; this._progressRequest = (this._progressRequest || 0) + 1; },
  },

  observers: {
    activities() { this._selectActivity(); },
    visible(value) {
      if (value) { this._refreshDistances(); void this.loadProgress(); }
      else { this.setData({ isNavigating: false }); this.triggerEvent("navchange", { shop: null }); }
    },
    location() { this._refreshDistances(); },
    compassHeading() { this._refreshNavUI(); },
  },

  methods: {
    _selectActivity(index) {
      const activities = this.properties.activities || [];
      if (index === undefined) index = Math.max(0, activities.findIndex((activity) => activity.id === this.data.activeActivity?.id));
      const activeActivity = activities[index] || null;
      const sameActivity = activeActivity && activeActivity.id === this.data.activeActivity?.id;
      const selectedPointId = sameActivity ? this.data.shops[this.data.selectedShopIdx]?.point_id : null;
      const selectedShopIdx = Math.max(0, (activeActivity?.points || []).findIndex((point) => point.point_id === selectedPointId));
      const wasNavigating = sameActivity && this.data.isNavigating;
      this._progressRequest = (this._progressRequest || 0) + 1;
      if (!sameActivity) this._serverPointIds = [];
      this.setData({ activeActivity, selectedActivityIdx: index, selectedShopIdx, shopsLoading: false, progressError: "", isNavigating: false,
        shops: this._computeDistances(activeActivity?.points || [], activeActivity), checkedPointIds: {}, checkedInCount: 0 });
      this._applyProgress();
      if (wasNavigating && this.data.shops[selectedShopIdx]) this._activateNavigation(this.data.shops[selectedShopIdx]);
      else this.triggerEvent("navchange", { shop: null });
      if (this.properties.visible) void this.loadProgress();
    },

    onActivityChange(event) {
      if (this.data.submittingPointId) return;
      const index = Number(event.detail.value);
      if (this.properties.activities[index]) this._selectActivity(index);
    },

    _applyProgress() {
      const server = new Set(this._serverPointIds || []);
      const checkedPointIds = {};
      let checkedInCount = 0;
      for (const point of this.data.shops) {
        if (server.has(point.point_id)) checkedPointIds[point.point_id] = true;
        if (checkedPointIds[point.point_id]) checkedInCount++;
      }
      this.setData({ checkedPointIds, checkedInCount });
    },

    async loadProgress() {
      const activity = this.data.activeActivity;
      if (!activity) return;
      const requestId = (this._progressRequest || 0) + 1;
      this._progressRequest = requestId;
      this.setData({ shopsLoading: true, progressError: "" });
      try {
        const response = await fetchActivityProgress(activity.id, activityParticipantId());
        if (response.statusCode !== 200 || !Array.isArray(response.data?.point_ids) || response.data.point_ids.some((id) => typeof id !== "string")) throw new Error("打卡进度加载失败");
        if (this._detached || requestId !== this._progressRequest) return;
        this._serverPointIds = response.data.point_ids;
        this._applyProgress();
        const point = this.data.shops[this.data.selectedShopIdx];
        if (this.properties.visible && point) this._activateNavigation(point);
      } catch (error) {
        if (this._detached || requestId !== this._progressRequest) return;
        console.error("[活动打卡] 进度加载失败:", error);
        this.setData({ progressError: "打卡进度加载失败，点击重试" });
      } finally {
        if (!this._detached && requestId === this._progressRequest) this.setData({ shopsLoading: false });
      }
    },

    _computeDistances(points, activity = this.data.activeActivity) {
      const location = this.properties.location;
      const inScope = withinActivityScope(activity, location);
      return points.map((point) => {
        const distance = activityDistance(location, point);
        return { ...point, distance: distance === null ? undefined : Math.round(distance),
          hasLocation: validActivityLocation(point),
          canCheckin: inScope && distance !== null && distance <= (activity?.config.checkinRadiusMeters || 50) };
      });
    },

    _refreshDistances() {
      if (!this.data.activeActivity) return;
      this.setData({ shops: this._computeDistances(this.data.shops) });
      this._refreshNavUI();
    },

    async onCheckin(event) {
      if (this.data.submittingPointId) return;
      const point = this.data.shops[event.currentTarget.dataset.idx];
      const activity = this.data.activeActivity;
      if (!point || !activity) return;
      const previous = this.data.checkedPointIds[point.point_id];
      if (previous) { this._showReward(point); return; }
      const location = this.properties.location;
      // Re-evaluate current GPS at submission; distance is only a UI hint, server verifies again.
      const distance = activityDistance(location, point);
      if (!withinActivityScope(activity, location) || distance === null || distance > (activity.config.checkinRadiusMeters || 50)) {
        wx.showToast({ title: !point.hasLocation ? "此打卡点尚未设置位置" : "请靠近打卡点后再试", icon: "none" });
        return;
      }
      const intentKey = `${activity.id}:${point.point_id}`;
      this._checkinIntents = this._checkinIntents || {};
      let intent = this._checkinIntents[intentKey];
      if (!intent) {
        intent = { placement_id: activity.id, point_id: point.point_id, kind: "checkin", user_lat: location.latitude, user_lng: location.longitude,
          participant_id: activityParticipantId(), idempotency_key: activityRequestKey() };
        this._checkinIntents[intentKey] = intent;
      }
      this.setData({ submittingPointId: point.id });
      // A progress response started before this write must not undo its confirmation.
      this._progressRequest = (this._progressRequest || 0) + 1;
      try {
        const response = await submitActivityRecord(intent);
        if (response.statusCode !== 200 || typeof response.data?.id !== "string") {
          if (response.statusCode >= 400 && response.statusCode < 500) delete this._checkinIntents[intentKey];
          throw new Error(response.data?.error || "打卡失败");
        }
        delete this._checkinIntents[intentKey];
        if (this._detached || this.data.activeActivity?.id !== activity.id) return;
        this._progressRequest = (this._progressRequest || 0) + 1;
        this._serverPointIds = [...new Set([...(this._serverPointIds || []), point.point_id])];
        this._applyProgress();
        this._showReward(point);
      } catch (error) {
        console.error("[活动打卡] 提交失败:", error);
        if (!this._detached) wx.showToast({ title: "打卡失败，请重试", icon: "none" });
      } finally {
        if (!this._detached) this.setData({ submittingPointId: "", shopsLoading: false });
      }
    },

    _showReward(point) {
      this.setData({ showCheckinModal: true, checkinImageUrl: point.reward_url || "", checkinShopName: point.name });
    },

    closeCheckinModal() {
      this.setData({ showCheckinModal: false, checkinImageUrl: "", checkinShopName: "" });
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
      if (!validActivityLocation(shop)) {
        this.setData({ isNavigating: false });
        this.triggerEvent("navchange", { shop: null });
        return;
      }
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
      if (!validActivityLocation(loc) || !validActivityLocation(shop)) return;

      const bearing = getBearing(
        loc.latitude,
        loc.longitude,
        shop.latitude,
        shop.longitude,
      );
      const compass = this.properties.compassHeading || 0;
      let relAngle = bearing - compass;
      relAngle = ((relAngle + 540) % 360) - 180;

      const dist = activityDistance(loc, shop);
      this.setData({
        navRelAngle: Math.round(relAngle),
        navDistance: `${Math.round(dist)}m`,
      });
    },
  },
});

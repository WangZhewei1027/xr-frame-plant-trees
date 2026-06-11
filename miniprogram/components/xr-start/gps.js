/** GPS 定位相关方法 */
module.exports = {
  updateGPS({ latitude, longitude, accuracy }) {
    const isFirst = !this.gpsReady;
    this.currentGPS = { latitude, longitude, accuracy };
    this.gpsReady = true;
    if (isFirst && !this.firstFetchDone) {
      this.firstFetchDone = true;
      // 不在此直接拉取：首批放置依赖 AR 相机位姿，需等 ar-ready + 稳定延迟。
      // 由 GPS 与 AR 两侧共同触发，谁后就绪谁启动（见 _maybeStartFirstFetch）。
      this._maybeStartFirstFetch();
    }
  },

  /**
   * 首批拉取启动闸门：必须 GPS 与 AR 同时就绪才触发，且仅触发一次。
   * AR 就绪后额外等待 firstFetchDelayMs，让相机 VIO 位姿收敛，
   * 避免首批素材因相机 worldMatrix 未稳定（forward 退化为世界 +Z）而落到身后。
   */
  _maybeStartFirstFetch() {
    if (this._firstFetchStarted) return;
    if (!this.gpsReady || !this._arReady) return;
    this._firstFetchStarted = true;
    const delay =
      (require("./config").firstFetchDelayMs != null
        ? require("./config").firstFetchDelayMs
        : 1000) | 0;
    this._firstFetchTimer = setTimeout(() => {
      this.fetchNearbyAssets();
      this.fetchHugeAssets();
    }, delay);
  },

  startGPSWatch() {
    wx.startLocationUpdate({
      type: "wgs84",
      success: () => {
        wx.onLocationChange((res) => this.updateGPS(res));
        this.locationWatchId = true;
      },
      fail: () => this.getLocationOnce(),
    });
  },

  getLocationOnce() {
    wx.getLocation({
      type: "wgs84",
      isHighAccuracy: true,
      highAccuracyExpireTime: 3000,
      success: (res) => this.updateGPS(res),
      fail: (err) => console.error("[GPS] 定位失败", err),
    });
  },
};

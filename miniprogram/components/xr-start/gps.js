/** GPS 定位相关方法 */
module.exports = {
  updateGPS({ latitude, longitude, accuracy }) {
    const isFirst = !this.gpsReady;
    this.currentGPS = { latitude, longitude, accuracy };
    this.gpsReady = true;
    if (isFirst && !this.firstFetchDone) {
      this.firstFetchDone = true;
      this.fetchNearbyAssets();
    }
  },

  startGPSWatch() {
    wx.startLocationUpdate({
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
      success: (res) => this.updateGPS(res),
      fail: (err) => console.error("[GPS] 定位失败", err),
    });
  },
};

/** 导航状态存根 — XR 3D 效果已移除，仅保留状态接收接口 */
module.exports = {
  setNavigationTarget(shop) {
    this._navTarget = shop || null;
  },

  updateCompassHeading(heading) {
    this._compassHeading = heading;
  },
};

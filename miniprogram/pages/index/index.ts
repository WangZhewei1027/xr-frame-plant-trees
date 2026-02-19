Page({
  data: {},

  onLoad() {},

  goToAR() {
    wx.navigateTo({
      url: "/pages/ar/ar",
    });
  },

  goToUpload() {
    wx.navigateTo({
      url: "/pages/upload/upload",
    });
  },
});

import { CONFIG, isSceneConfig } from "../../utils/backend";
Page({
  data: { sceneId: "", organizationId: "", width: 0, height: 0, renderWidth: 0, renderHeight: 0, state: "loading", playback: "paused", message: "正在启动 AR 相机…", invalid: false },
  onLoad(options: Record<string, string>) {
    const entry = options.sceneId || options.organizationId ? options : CONFIG;
    if (!isSceneConfig(entry)) {
      this.setData({ invalid: true, state: "error", message: "场景二维码无效，请重新扫码" });
      wx.showToast({ title: this.data.message, icon: "none" }); return;
    }
    const { windowWidth, windowHeight, pixelRatio } = wx.getSystemInfoSync();
    const height = Math.max(1, windowHeight);
    this.setData({ sceneId: entry.sceneId, organizationId: entry.organizationId, width: windowWidth, height,
      renderWidth: Math.round(windowWidth * pixelRatio * 0.5), renderHeight: Math.round(height * pixelRatio * 0.5) });
  },
  onSceneStatus(event: WechatMiniprogram.CustomEvent<{ state: string; message: string }>) {
    this.setData(event.detail);
    if (event.detail.state === "error" || event.detail.state === "empty")
      wx.showToast({ title: event.detail.message, icon: "none", duration: 3000 });
  },
  onRenderStatus(event: WechatMiniprogram.CustomEvent<{ state: string; message: string }>) {
    this.setData(event.detail.state === "error"
      ? { state: "error", message: event.detail.message || "AR 启动失败，请重试" }
      : { state: "loading", message: "正在启动 AR 相机…" });
    if (event.detail.state === "error") wx.showToast({ title: this.data.message, icon: "none", duration: 3000 });
  },
  onScenePlayback(event: WechatMiniprogram.CustomEvent<{ state: string }>) {
    this.setData({ playback: event.detail.state });
  },
  togglePlayback() { this.selectComponent("#preview")?.toggleScenePreviewPlayback(); },
  restart() { this.selectComponent("#preview")?.restartScenePreviewPlayback(); },
  retry() { this.selectComponent("#preview")?.retryScenePreview(); },
  place() {
    if (this.data.state === "error" || this.data.state === "empty") this.retry();
    else if (this.data.state === "placeable") this.selectComponent("#preview")?.placeScenePreview();
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
Page({
  data: { sceneId: "", organizationId: "", width: 0, height: 0, renderWidth: 0, renderHeight: 0, state: "loading", message: "正在启动 AR 相机…", invalid: false },
  onLoad(options: Record<string, string>) {
    if (!UUID.test(options.sceneId || "") || !UUID.test(options.organizationId || "")) {
      this.setData({ invalid: true, state: "error", message: "场景二维码无效，请重新扫码" }); return;
    }
    const { windowWidth, windowHeight, pixelRatio } = wx.getSystemInfoSync();
    const height = Math.max(1, windowHeight - 120);
    this.setData({ sceneId: options.sceneId, organizationId: options.organizationId, width: windowWidth, height,
      renderWidth: Math.round(windowWidth * pixelRatio * 0.5), renderHeight: Math.round(height * pixelRatio * 0.5) });
  },
  onSceneStatus(event: WechatMiniprogram.CustomEvent<{ state: string; message: string }>) { this.setData(event.detail); },
  onRenderStatus(event: WechatMiniprogram.CustomEvent<{ state: string; message: string }>) {
    this.setData(event.detail.state === "error"
      ? { state: "error", message: event.detail.message || "AR 启动失败，请重试" }
      : { state: "loading", message: "正在启动 AR 相机…" });
  },
  retry() { this.selectComponent("#preview")?.retryScenePreview(); },
});

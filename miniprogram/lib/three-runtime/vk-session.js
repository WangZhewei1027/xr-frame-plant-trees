// Owns exactly one native session. Generation guards make late start/RAF callbacks
// harmless after hide, retry, or unload. No fallback to v1's non-metric tracking.
class VKSessionController {
  constructor({
    api,
    gl,
    size,
    onFrame,
    onState,
    onAnchors,
    now = Date.now,
    maxFps = 30,
  }) {
    Object.assign(this, { api, gl, size, onFrame, onState, onAnchors, now });
    // The lab keeps its sampling cap; production follows every native RAF.
    this.frameIntervalMs = maxFps > 0 ? 1000 / maxFps : 0;
    this.generation = 0;
    this.running = false;
  }
  start() {
    this.stop();
    const generation = this.generation;
    const current = () => generation === this.generation;
    try {
      if (typeof this.api.createVKSession !== "function")
        throw new Error("当前环境没有 VisionKit，请用支持 AR 的真机");
      if (this.api.isVKSupport && !this.api.isVKSupport("v2"))
        throw new Error("当前设备不支持 VisionKit v2，不能进行米制空间追踪");
      const session = (this.session = this.api.createVKSession({
        version: "v2",
        track: { plane: { mode: 1 } },
        gl: this.gl,
      }));
      if (!session) throw new Error("VisionKit 未返回会话");
      this.listeners = ["addAnchors", "updateAnchors", "removeAnchors"].map(
        (name) => {
          const handler = (anchors) => {
            if (current()) this.onAnchors?.(name, anchors);
          };
          session.on(name, handler);
          return [name, handler];
        },
      );
      this.onState("starting");
      this.timer = setTimeout(() => {
        if (current())
          this.fail(
            new Error("VisionKit 启动超过 15 秒，请检查相机权限并重试"),
          );
      }, 15000);
      session.start((error) => {
        if (!current()) return;
        clearTimeout(this.timer);
        if (error) {
          this.fail(new Error(describeStartError(error)));
          return;
        }
        this.running = true;
        this.lastFrameAt = null;
        this.onState("running");
        const tick = () => {
          if (!current() || !this.running) return;
          this.raf = null;
          try {
            const now = this.now();
            const interval = this.frameIntervalMs;
            if (
              interval === 0 ||
              this.lastFrameAt == null ||
              now - this.lastFrameAt >= interval
            ) {
              const delta =
                this.lastFrameAt == null ? interval : now - this.lastFrameAt;
              this.lastFrameAt =
                interval === 0 ? now : now - (delta % interval);
              const { width, height } = this.size();
              const start = this.now();
              const frame = session.getVKFrame(width, height);
              // Process native textures immediately; never retain a VKFrame across ticks.
              this.onFrame(frame, { now, acquireMs: this.now() - start });
            }
          } catch (error) {
            this.fail(error);
            return;
          }
          if (current() && this.running)
            this.raf = session.requestAnimationFrame(tick);
        };
        this.raf = session.requestAnimationFrame(tick);
      });
    } catch (error) {
      this.fail(error);
    }
  }
  fail(error) {
    this.stop();
    this.onState("error", error.message || String(error));
  }
  hitTest(x = 0.5, y = 0.5) {
    if (!this.running) return [];
    return this.session.hitTest(x, y) || [];
  }
  stop() {
    this.generation++;
    this.running = false;
    clearTimeout(this.timer);
    const session = this.session;
    this.session = null;
    if (session) {
      if (this.raf != null) {
        try {
          session.cancelAnimationFrame(this.raf);
        } catch (_) {}
      }
      for (const [name, handler] of this.listeners || []) {
        try {
          session.off(name, handler);
        } catch (_) {}
      }
      try {
        session.stop();
      } catch (_) {}
      try {
        session.destroy();
      } catch (_) {}
    }
    this.raf = null;
    this.listeners = [];
  }
}
function describeStartError(error) {
  const code =
    typeof error === "number" ? error : (error.errCode ?? error.code);
  const messages = {
    104: "用户取消相机授权",
    112: "请在微信小程序隐私协议中声明相机接口",
    2000002: "设备不支持 VisionKit v2",
    2000003: "系统不支持 VisionKit v2",
    2000004: "设备不支持 VisionKit v2",
    2003000: "AR 会话不可用",
    2003001: "请开启微信的系统相机权限",
    2003002: "请开启小程序的相机权限",
  };
  return `${messages[code] || error.errMsg || "VisionKit 启动失败"} (${code ?? JSON.stringify(error)})`;
}
module.exports = { VKSessionController, describeStartError };

const { THREE, probeWebGL2, createCanvasFacade } = require("./runtime");
const { VKSessionController } = require("./vk-session");
const {
  syncVKCamera,
  createCameraBackground,
  applyHitMatrix,
} = require("./vk-renderer");
const { disposeTree, loadGLTF } = require("./resources");
const RETICLE_MODEL_PATH = "assets/ar-plane-marker.glb";
class ARRuntime {
  constructor(
    canvas,
    { width, height, onReady, onTick, onState, onReticleError },
  ) {
    this.canvas = canvas;
    this.onReady = onReady;
    this.onTick = onTick;
    this.onState = onState;
    this.onReticleError = onReticleError;
    try {
      const gl = (this.gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
      }));
      console.log("[ThreeAR][webgl2]", probeWebGL2(gl));
      this.facade = createCanvasFacade(canvas, gl, width, height);
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.facade,
        context: gl,
        alpha: false,
        antialias: false,
      });
      this.renderer.autoClear = false;
      this.renderer.setClearColor(0x14202b, 1);
      this.renderer.debug.onShaderError = (context, program) => {
        this.shaderError =
          context.getProgramInfoLog(program) || "Three shader 编译失败";
      };
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera();
      this.content = new THREE.Group();
      this.scene.add(this.content);
      this.scene.add(new THREE.AmbientLight(0xffffff, 3));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(0, 3, 2);
      this.scene.add(light);
      // Preserve the old xr-ar-tracker's GLB, scale and materials.
      // Keep its visual child separate from the hit-test placement transform.
      this.reticle = new THREE.Group();
      this.reticleReady = false;
      this.reticle.visible = false;
      this.scene.add(this.reticle);
      this.background = createCameraBackground(gl);
      this.renderer.resetState();
      this.resize(width, height);
      this.scene.requestCameraFrame = (callback) =>
        this.requestCameraFrame(callback);
      this.session = new VKSessionController({
        api: wx,
        gl,
        maxFps: 0,
        size: () => ({ width: canvas.width, height: canvas.height }),
        onFrame: (frame, timing) => this.frame(frame, timing),
        onState: (state, message) => {
          if (state === "error") {
            this.ready = false;
            this.reticle.visible = false;
            this.rejectCapture(message || "AR 已停止");
          }
          this.onState(state, message);
        },
      });
      this.reticleLoad = this.loadReticleModel();
    } catch (error) {
      disposeTree(this.scene);
      this.background?.dispose();
      this.renderer?.dispose();
      throw error;
    }
  }
  async loadReticleModel() {
    try {
      const gltf = await loadGLTF(this.canvas, RETICLE_MODEL_PATH);
      if (this.disposed) {
        disposeTree(gltf.scene);
        return;
      }
      this.reticle.add(gltf.scene);
      this.reticleReady = true;
    } catch (error) {
      if (!this.disposed) {
        console.warn("[ThreeAR][reticle]", error);
        this.onReticleError?.(new Error("光标模型加载失败，请重新进入 AR"));
      }
    }
  }
  updateReticle(enabled) {
    this.reticleHitTestMs = 0;
    if (!enabled || !this.reticleReady) {
      this.reticle.visible = false;
      return;
    }
    const started = Date.now();
    const hit = this.session.hitTest(0.5, 0.5)[0];
    this.reticle.visible = !!hit && applyHitMatrix(this.reticle, hit.transform);
    this.reticleHitTestMs = Date.now() - started;
  }
  resize(width, height) {
    this.renderer.setSize(Math.max(16, width), Math.max(16, height), false);
  }
  start() {
    this.ready = false;
    this.shaderError = null;
    this.frames = 0;
    this.reportAt = null;
    this.startedAt = Date.now();
    this.lastFrameAt = null;
    this.validFrameAt = null;
    this.session.start();
  }
  stop() {
    this.ready = false;
    this.reticle.visible = false;
    this.session.stop();
    this.rejectCapture("相机会话已停止");
  }
  frame(frame, { now, acquireMs }) {
    const start = Date.now();
    if (!frame?.camera) {
      if (start - (this.validFrameAt || this.startedAt) > 10000)
        throw new Error("未取得相机帧，请检查设备兼容性和权限");
      return;
    }
    if (!syncVKCamera(this.camera, frame.camera, 0.01, 300)) {
      if (start - (this.validFrameAt || this.startedAt) > 10000)
        throw new Error("相机位姿持续无效，请重新启动空间追踪");
      return;
    }
    const matrixMs = Date.now() - start;
    const request = this.capture;
    if (request) {
      this.capture = null;
      clearTimeout(request.timer);
      try {
        Promise.resolve(
          request.callback(frame, this.canvas.width, this.canvas.height),
        ).then(request.resolve, request.reject);
      } catch (error) {
        request.reject(error);
      }
      this.renderer.resetState();
    }
    const backgroundAt = Date.now();
    if (
      !this.background.draw(
        frame,
        this.renderer,
        this.canvas.width,
        this.canvas.height,
      )
    ) {
      if (start - (this.validFrameAt || this.startedAt) > 10000)
        throw new Error("无法获取相机纹理，请检查 VisionKit/WebGL2 兼容性");
      return;
    }
    this.validFrameAt = start;
    const backgroundMs = Date.now() - backgroundAt;
    if (!this.ready) {
      this.ready = true;
      this.onReady();
    }
    const dt =
      this.lastFrameAt == null
        ? 0
        : Math.min(0.1, Math.max(0, (now - this.lastFrameAt) / 1000));
    this.lastFrameAt = now;
    const businessAt = Date.now();
    this.onTick(dt);
    const businessMs = Date.now() - businessAt,
      renderAt = Date.now();
    this.renderer.render(this.scene, this.camera);
    if (this.shaderError) throw new Error(this.shaderError);
    this.frames = (this.frames || 0) + 1;
    if (!this.reportAt) this.reportAt = now;
    if (now - this.reportAt >= 2000) {
      console.log(
        "[ThreeAR][timings]",
        JSON.stringify({
          fps: +((this.frames * 1000) / (now - this.reportAt)).toFixed(1),
          acquireMs,
          matrixMs,
          backgroundSubmitMs: backgroundMs,
          businessMs,
          reticleHitTestMs: this.reticleHitTestMs || 0,
          threeSubmitMs: Date.now() - renderAt,
          frameWorkMs: Date.now() - start + acquireMs,
          drawCalls: this.renderer.info.render.calls,
          geometries: this.renderer.info.memory.geometries,
          textures: this.renderer.info.memory.textures,
          note: "JS/API submission time; GPU completion not measured",
        }),
      );
      this.frames = 0;
      this.reportAt = now;
    }
  }
  requestCameraFrame(callback) {
    if (!this.ready || this.capture)
      return Promise.reject(new Error("相机未就绪或已有取图任务"));
    return new Promise((resolve, reject) => {
      const request = { callback, resolve, reject };
      request.timer = setTimeout(() => {
        if (this.capture === request) this.capture = null;
        reject(new Error("等待相机帧超时"));
      }, 3000);
      this.capture = request;
    });
  }
  rejectCapture(message) {
    if (this.capture) {
      clearTimeout(this.capture.timer);
      this.capture.reject(new Error(message));
      this.capture = null;
    }
  }
  dispose() {
    this.disposed = true;
    this.stop();
    disposeTree(this.scene);
    this.background.dispose();
    this.renderer.dispose();
    this.scene.requestCameraFrame = null;
  }
}
module.exports = { ARRuntime, RETICLE_MODEL_PATH };

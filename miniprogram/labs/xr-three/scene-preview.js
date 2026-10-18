const { THREE, probeWebGL2, createCanvasFacade } = require("../../lib/three-runtime/runtime");
const { ModelCache, disposeTree } = require("../../lib/three-runtime/resources");
const { createCompositionPlayer } = require("../../lib/scene-runtime/composition");
const { fetchScenePreview } = require("../../utils/backend");
const { verifyScenePlayer } = require("./scene-checks");

Page({
  data: { enabled: false, sceneId: "", organizationId: "", busy: false, loaded: false, status: "初始化…", report: "", playback: "" },
  onLoad(options) {
    this._generation = 0;
    this._active = true;
    this._enabled = wx.getAccountInfoSync().miniProgram.envVersion === "develop";
    this.setData({ enabled: this._enabled, sceneId: options.sceneId || "", organizationId: options.organizationId || "",
      status: this._enabled ? "等待 WebGL2" : "此页面仅允许开发版使用" });
  },
  onReady() {
    if (!this._enabled) return;
    this.createSelectorQuery().select("#scene-canvas").fields({ node: true, size: true }).exec((result) => {
      if (this._dead) return;
      try {
        const { node: canvas, width, height } = result[0];
        const gl = canvas.getContext("webgl2", { antialias: false });
        probeWebGL2(gl);
        this._canvas = canvas;
        this._renderer = new THREE.WebGLRenderer({ canvas: createCanvasFacade(canvas, gl, width, height), context: gl });
        this._renderer.setSize(width, height, false);
        this._renderer.setClearColor(0x18212b);
        this._renderer.debug.onShaderError = () => { this._shaderError = "模型着色器编译失败"; };
        this._scene = new THREE.Scene();
        this._scene.add(new THREE.AmbientLight(0xffffff, 3));
        const light = new THREE.DirectionalLight(0xffffff, 3);
        light.position.set(0, 3, 2);
        this._scene.add(light);
        this._camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 2000);
        this._camera.position.set(5, 3, 7);
        this._camera.lookAt(0, 0, 0);
        this._cache = new ModelCache(canvas);
        this.setData({ status: `Three.js r${THREE.REVISION} 就绪` });
        this.startFrames();
        if (this.data.sceneId && this.data.organizationId) this.loadScene();
      } catch (error) { this.fail(error); }
    });
  },
  onSceneInput(event) { this.setData({ sceneId: event.detail.value.trim() }); },
  onOrganizationInput(event) { this.setData({ organizationId: event.detail.value.trim() }); },
  async loadScene() {
    if (!this._enabled || !this._cache || this.data.busy || !this._active) return;
    const { sceneId, organizationId } = this.data;
    if (![sceneId, organizationId].every((id) => /^[0-9a-f-]{36}$/i.test(id))) {
      this.setData({ status: "请填写场景和工作空间 UUID" }); return;
    }
    this.clearScene();
    const generation = this._generation;
    this.setData({ busy: true, status: "读取本地后端并加载真实 GLB…", report: "" });
    try {
      const response = await fetchScenePreview(sceneId, organizationId);
      if (this._dead || generation !== this._generation) return;
      if (response.statusCode !== 200) throw new Error(response.data?.error || "场景接口失败");
      const manifest = response.data;
      if (manifest.assetId !== sceneId || !manifest.content?.instances?.length) throw new Error("场景为空或返回了错误的素材");
      const player = this._player = createCompositionPlayer(manifest, { modelCache: this._cache });
      await player.load();
      if (this._dead || generation !== this._generation) { player.dispose(); return; }
      if (player.state !== "ready") throw new Error(player.diagnostics?.message || "GLB 加载失败");
      const checks = verifyScenePlayer(player, manifest, this._cache);
      // Reload after disposal check to leave a real, interactive render for inspection.
      const preview = this._player = createCompositionPlayer(manifest, { modelCache: this._cache });
      await preview.load();
      if (this._dead || generation !== this._generation) { preview.dispose(); return; }
      if (preview.state !== "ready") throw new Error(preview.diagnostics?.message || "重载失败");
      this._scene.add(preview.root);
      const box = new THREE.Box3().setFromObject(preview.root);
      const center = box.getCenter(new THREE.Vector3());
      const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
      this._camera.position.copy(center).add(new THREE.Vector3(0.8, 0.5, 1.4).multiplyScalar(size));
      this._camera.lookAt(center);
      this._renderer.render(this._scene, this._camera);
      if (this._shaderError) throw new Error(this._shaderError);
      if (!this._renderer.info.render.triangles) throw new Error("画面没有提交模型三角形");
      checks.push(`真实 WebGL2 渲染：${this._renderer.info.render.triangles} 个三角形`);
      preview.play();
      this.setData({ busy: false, loaded: true, status: `PASS · ${checks.length} 项检查通过`, report: checks.map((name) => `✓ ${name}`).join("\n") });
      console.log("[ScenePreview] PASS", { sceneId, organizationId, checks, schemaVersion: manifest.schemaVersion });
    } catch (error) { if (!this._dead && generation === this._generation) { this.clearScene(); this.fail(error); } }
  },
  startFrames() {
    if (!this._canvas || this._raf != null || !this._active || this._dead) return;
    this._lastFrame = null;
    const frame = (time) => {
      this._raf = null;
      if (!this._active || this._dead) return;
      const dt = this._lastFrame == null ? 0 : Math.min((time - this._lastFrame) / 1000, 0.1);
      this._lastFrame = time;
      if (!this.data.busy) this._player?.update(dt);
      this._renderer.render(this._scene, this._camera);
      if (time - (this._lastStatus || 0) > 250) {
        this._lastStatus = time;
        this.setData({ playback: this._player ? `${this._player.state} · ${this._player.time.toFixed(2)}s · ${this._player.instances.length} 个实例` : "" });
      }
      this._raf = this._canvas.requestAnimationFrame(frame);
    };
    this._raf = this._canvas.requestAnimationFrame(frame);
  },
  stopFrames() { if (this._raf != null) this._canvas.cancelAnimationFrame(this._raf); this._raf = null; },
  togglePlayback() {
    if (this.data.busy) return;
    const player = this._player;
    if (player?.state === "playing") player.pause();
    else if (player?.state === "ended") player.restart();
    else player?.play();
  },
  restart() { if (!this.data.busy) this._player?.restart(); },
  clearScene() {
    this._generation++;
    if (this._player) { this._scene?.remove(this._player.root); this._player.dispose(); this._player = null; }
    if (!this._dead) this.setData({ loaded: false, busy: false, playback: "", status: "已清场，可重新加载验证" });
  },
  fail(error) { this.setData({ busy: false, status: `FAIL · ${error.message}` }); console.error("[ScenePreview] FAIL", error); },
  onContextLost() { this.stopFrames(); this.clearScene(); this.fail(new Error("WebGL 上下文丢失，请重新编译")); },
  onHide() { this._active = false; this.stopFrames(); this.clearScene(); },
  onShow() { this._active = true; this.startFrames(); },
  onUnload() {
    this._dead = true; this._active = false; this.stopFrames(); this.clearScene();
    this._cache?.dispose(); disposeTree(this._scene); this._renderer?.dispose();
  },
});

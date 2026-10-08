const { THREE, createAnimationRig, probeWebGL2, createCanvasFacade, createFixtureGLB } = require('./runtime');
const { VKSessionController } = require('./vk-session');
const { syncVKCamera, applyHitMatrix, createCameraBackground } = require('./vk-renderer');
const build = require('./vendor/build-info');

Page({
  data: { revision: THREE.REVISION, gpuReady: false, arRunning: false, starting: false, playing: true,
    placed: false, canPlace: false, planeCount: 0, playhead: 0, uvPacking: 'ra',
    viewWidth: 300, viewHeight: 400, status: '初始化 Three.js…',
    summary: '', logText: '', showDiagnostics: false },
  onLoad() {
    this._active = true; this._dead = false; this._seconds = 0; this._events = []; this._samples = [];
    this._planes = new Set(); this._stats = {};
    const perf = wx.getPerformance?.();
    this._now = () => perf ? perf.now() : Date.now();
    const info = wx.getSystemInfoSync();
    this._environment = { platform: info.platform, system: info.system, model: info.model, SDKVersion: info.SDKVersion, version: info.version, pixelRatio: info.pixelRatio };
    this.updateDimensions(info);
    this.log('environment', { ...this._environment, three: build.version, architecture: 'VisionKit v2 + Three / one WebGL2 context' });
  },
  updateDimensions(info) {
    this._dpr = Math.min(info.pixelRatio || this._dpr || 1, 2);
    const width = Math.max(200, info.windowWidth - 32);
    const height = Math.round(Math.min(width * 4 / 3, info.windowHeight * 0.62));
    this.setData({ viewWidth: width, viewHeight: height }, () => {
      if (!this._renderer || this._dead) return;
      this._renderer.setSize(Math.round(width * this._dpr), Math.round(height * this._dpr), false);
      this._previewCamera.aspect = width / height; this._previewCamera.updateProjectionMatrix();
      this._facade.clientWidth = width; this._facade.clientHeight = height;
    });
  },
  onReady() {
    this.createSelectorQuery().select('#three-canvas').fields({ node: true, size: true }).exec(result => {
      if (this._dead) return;
      try {
        const canvas = this._canvas = result[0]?.node;
        if (!canvas) throw new Error('没有取得 WebGL2 Canvas 节点');
        const width = Math.round(this.data.viewWidth * this._dpr), height = Math.round(this.data.viewHeight * this._dpr);
        canvas.width = width; canvas.height = height;
        const gl = this._gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
        this.log('webgl2', probeWebGL2(gl));
        const facade = this._facade = createCanvasFacade(canvas, gl, this.data.viewWidth, this.data.viewHeight);
        const renderer = this._renderer = new THREE.WebGLRenderer({ canvas: facade, context: gl, alpha: false, antialias: false });
        renderer.setSize(width, height, false); renderer.autoClear = false;
        renderer.debug.onShaderError = (context, program) => { this._shaderError = context.getProgramInfoLog(program) || 'Three shader 编译失败'; };
        this._background = createCameraBackground(gl);
        renderer.resetState();
        this._scene = new THREE.Scene();
        this._camera = new THREE.PerspectiveCamera();
        this._previewCamera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);
        this._previewCamera.position.set(0, 0.45, 3);
        this._previewCamera.updateMatrixWorld();
        this._content = new THREE.Group();
        this._scene.add(this._content);
        this._rig = createAnimationRig(); this._rig.root.position.y = 0.4;
        this._mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0x30cc80, roughness: 0.6 }));
        this._rig.object.add(this._mesh); this._content.add(this._rig.root);
        this._scene.add(new THREE.AmbientLight(0xffffff, 2));
        const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 3, 4); this._scene.add(light);
        this._reticle = new THREE.Mesh(new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x39e8bc, side: THREE.DoubleSide, depthTest: false }));
        this._reticle.visible = false; this._scene.add(this._reticle);
        this._synthetic = this.makeSyntheticFrame();
        this._vk = new VKSessionController({ api: wx, gl, size: () => ({ width: canvas.width, height: canvas.height }),
          now: this._now, onFrame: (frame, timing) => this.renderAR(frame, timing),
          onState: (state, message) => this.onSessionState(state, message), onAnchors: (name, anchors) => this.onAnchors(name, anchors) });
        this.renderPreview();
        // One diagnostic readback only. Live AR never copies camera pixels to JS.
        const pixel = new Uint8Array(4);
        gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const error = gl.getError();
        if (error !== gl.NO_ERROR || this._shaderError || pixel[0] < 90 || pixel[0] > 104 || pixel[1] < 90 || pixel[1] > 104 || pixel[2] < 90 || pixel[2] > 104) {
          throw new Error(`背景合成自检失败：GL=${error}, pixel=${Array.from(pixel)}, shader=${this._shaderError || ''}`);
        }
        this.setData({ gpuReady: true, status: 'Three 渲染已就绪；灰底为测试背景，请在真机启动 AR' });
        this.log('renderer-ready', { width, height, syntheticBackgroundPixel: Array.from(pixel), note: '仅验证 GPU 合成；真实相机、追踪与放置需真机验证' });
        this.startPreview();
      } catch (error) {
        this.setData({ gpuReady: false, status: error.message });
        this.log('init-error', { message: error.message });
      }
    });
  },
  makeSyntheticFrame() {
    const gl = this._gl;
    const create = rgba => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
      return texture;
    };
    const yTexture = create([96, 96, 96, 255]), uvTexture = create([128, 128, 128, 128]);
    gl.bindTexture(gl.TEXTURE_2D, null); this._renderer.resetState();
    this._testTextures = [yTexture, uvTexture];
    return { getCameraTexture: () => ({ yTexture, uvTexture }), getDisplayTransform: () => new Float32Array([1,0,0,0,1,0,0,0,1]) };
  },
  startAR() {
    if (!this.data.gpuReady || this.data.starting || this.data.arRunning || !this._active) return;
    this._resumeAR = false; this.stopPreview(); this.resetPlacement();
    this._planes.clear(); this._reportAt = this._lastAnimationAt = null; this._samples = [];
    this._lastVKTimestamp = this._lastValidFrameAt = null; this._arStartedAt = this._now();
    this._vk.start();
  },
  onSessionState(state, message) {
    if (this._dead) return;
    this.log('session', { state, message: message || null });
    if (state === 'starting') this.setData({ starting: true, arRunning: false, status: '正在启动 AR 相机…' });
    if (state === 'running') this.setData({ starting: false, arRunning: true, status: '请左右平移手机扫描地面，再将准星对准落点', planeCount: 0 });
    if (state === 'error') {
      this.resetPlacement();
      this.setData({ starting: false, arRunning: false, status: message });
      this.startPreview();
    }
  },
  stopAR() {
    this._resumeAR = false; this._vk?.stop(); this.resetPlacement();
    this.setData({ starting: false, arRunning: false, status: 'AR 已停止，当前为 Three 测试画面', planeCount: 0 });
    this.startPreview();
  },
  resetPlacement() {
    if (this._content) {
      this._content.visible = false; this._content.matrixAutoUpdate = true;
      this._content.position.set(0, 0, 0); this._content.quaternion.identity(); this._content.scale.set(1, 1, 1);
      this._content.updateMatrix();
    }
    if (this._reticle) this._reticle.visible = false;
    this._cameraValid = false; this._lastHitAt = null;
    if (!this._dead) this.setData({ placed: false, canPlace: false });
  },
  onAnchors(name, anchors) {
    for (const anchor of anchors || []) {
      if (name === 'removeAnchors') this._planes.delete(anchor.id);
      else if (anchor.type === 0) this._planes.add(anchor.id);
    }
    if (!this._dead) this.setData({ planeCount: this._planes.size });
  },
  renderAR(frame, timing) {
    const start = this._now(), now = timing.now;
    if (!frame?.camera) {
      this._cameraValid = false; this._reticle.visible = false;
      if (this.data.canPlace) this.setData({ canPlace: false });
      if (now - (this._lastValidFrameAt ?? this._arStartedAt) > 10000) throw new Error('连续 10 秒未取得相机帧，请检查真机支持与相机权限');
      return;
    }
    const syncStart = this._now();
    if (!syncVKCamera(this._camera, frame.camera)) throw new Error('VisionKit 返回了无效的相机矩阵');
    const syncMs = this._now() - syncStart;
    const backgroundStart = this._now();
    if (!this._background.draw(frame, this._renderer, this._canvas.width, this._canvas.height, this.data.uvPacking)) {
      this._cameraValid = false; this._reticle.visible = false;
      if (this.data.canPlace) this.setData({ canPlace: false });
      if (now - (this._lastValidFrameAt ?? this._arStartedAt) > 10000) throw new Error('无法取得相机 GPU 纹理或画面变换，当前设备的 WebGL2 / VisionKit 组合需检查');
      return;
    }
    this._cameraValid = true; this._lastValidFrameAt = now;
    const backgroundMs = this._now() - backgroundStart;
    const hitStart = this._now();
    if (this._lastHitAt == null || now - this._lastHitAt >= 100) {
      this._lastHitAt = now;
      const hit = this._vk.hitTest()[0];
      const canPlace = !!hit && applyHitMatrix(this._reticle, hit.transform);
      this._reticle.visible = canPlace && !this.data.placed;
      if (canPlace !== this.data.canPlace) this.setData({ canPlace });
    }
    const hitMs = this._now() - hitStart;
    const animationStart = this._now(); this.animate(now);
    const animationMs = this._now() - animationStart;
    const renderStart = this._now();
    this._renderer.render(this._scene, this._camera);
    if (this._shaderError) throw new Error(this._shaderError);
    const renderMs = this._now() - renderStart;
    const timestamp = Number(frame.timestamp);
    this._stats.cameraFrameIntervalMs = this._lastVKTimestamp != null && timestamp > this._lastVKTimestamp ? (timestamp - this._lastVKTimestamp) / 1e6 : null;
    this._lastVKTimestamp = timestamp;
    this.recordTimings(now, { acquireMs: timing.acquireMs, cameraSyncMs: syncMs, backgroundSubmitMs: backgroundMs,
      hitTestMs: hitMs, animationMs, threeSubmitMs: renderMs, frameWorkMs: this._now() - start + timing.acquireMs });
  },
  animate(now) {
    const dt = this._lastAnimationAt == null ? 0 : Math.min(0.1, Math.max(0, (now - this._lastAnimationAt) / 1000));
    this._lastAnimationAt = now;
    if (this.data.playing) this._seconds = (this._seconds + dt) % 4;
    this._rig.sample(this._seconds); this._gltfMixer?.setTime(this._seconds);
  },
  renderPreview() {
    this._content.visible = true; this._reticle.visible = false;
    this.animate(this._now());
    this._background.draw(this._synthetic, this._renderer, this._canvas.width, this._canvas.height, this.data.uvPacking);
    this._renderer.render(this._scene, this._previewCamera);
  },
  startPreview() {
    if (!this._active || this._dead || !this.data.gpuReady || this.data.arRunning || this.data.starting || this._previewRAF != null) return;
    this._lastAnimationAt = null;
    const tick = () => {
      this._previewRAF = null;
      if (!this._active || this._dead || this.data.arRunning || this.data.starting) return;
      try { this.renderPreview(); }
      catch (error) { this.setData({ gpuReady: false, status: error.message }); this.log('preview-error', { message: error.message }); return; }
      this._previewRAF = this._canvas.requestAnimationFrame(tick);
    };
    this._previewRAF = this._canvas.requestAnimationFrame(tick);
  },
  stopPreview() {
    if (this._previewRAF != null) this._canvas?.cancelAnimationFrame(this._previewRAF);
    this._previewRAF = null; this._lastAnimationAt = null;
  },
  placeOnPlane() {
    if (!this._vk?.running || !this._cameraValid) return;
    try {
      const hit = this._vk.hitTest()[0];
      if (!hit || !applyHitMatrix(this._content, hit.transform)) {
        this.setData({ canPlace: false, status: '准星下暂无可用平面，请继续扫描' }); return;
      }
      this.finishPlacement('plane');
    } catch (error) { this.log('placement-error', { message: error.message }); this.setData({ status: error.message }); }
  },
  placeInFront() {
    if (!this._vk?.running || !this._cameraValid) return;
    const matrix = this._camera.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(0, -0.4, -2));
    if (applyHitMatrix(this._content, matrix.elements)) this.finishPlacement('front-2m');
  },
  finishPlacement(kind) {
    this._content.visible = true; this._reticle.visible = false; this._seconds = 0;
    this.setData({ placed: true, status: kind === 'plane' ? '已放到平面；可以绕行观察，或重新放置' : '已固定在当前镜头前约 2 米处；这是会话内位置' });
    this.log('placement', { kind, position: this._content.position.toArray(), metric: true, persistentRelocalization: false });
  },
  recordTimings(now, sample) {
    this._samples.push(sample);
    if (this._reportAt == null) this._reportAt = now;
    if (now - this._reportAt < 1000) return;
    const stages = {};
    for (const key of Object.keys(sample)) {
      const sorted = this._samples.map(s => s[key]).sort((a, b) => a - b);
      stages[key] = { p50: +sorted[Math.floor(sorted.length / 2)].toFixed(2), p95: +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(2) };
    }
    this._stats = { ...this._stats, mode: 'VisionKit v2 + Three', fps: +(this._samples.length * 1000 / (now - this._reportAt)).toFixed(1),
      width: this._canvas.width, height: this._canvas.height, planeCount: this._planes.size, placed: this.data.placed, uvPacking: this.data.uvPacking, stages,
      note: 'JS / API 提交耗时，不是 GPU 完成耗时；AR 渲染不做 readPixels' };
    this.setData({ summary: JSON.stringify(this._stats, null, 2), playhead: Math.round(this._seconds * 1000) });
    console.log('[VKThreeLab][timings]', JSON.stringify(this._stats));
    this._samples = []; this._reportAt = now;
  },
  testGLB() {
    if (this._gltf || this._loadingGLB || !this.data.gpuReady) return;
    this._loadingGLB = true; const start = this._now();
    new THREE.GLTFLoader().parse(createFixtureGLB(), '', gltf => {
      this._loadingGLB = false;
      if (this._dead) { this.disposeObject(gltf.scene); return; }
      this._gltf = gltf; gltf.scene.position.set(0.4, 0.4, 0); gltf.scene.scale.setScalar(0.5);
      this._content.add(gltf.scene); this._gltfMixer = new THREE.AnimationMixer(gltf.scene);
      gltf.animations.forEach(clip => this._gltfMixer.clipAction(clip).play());
      this.log('gltf', { parseMs: this._now() - start, animations: gltf.animations.length, note: '内嵌 buffer、无压缩 GLB；纹理与网络加载需另行适配' });
    }, error => { this._loadingGLB = false; if (!this._dead) this.log('gltf-error', { message: error.message }); });
  },
  testImage() {
    if (this._imageLoading || this._imageTexture || !this.data.gpuReady) return;
    this._imageLoading = true; const start = this._now(), image = this._canvas.createImage();
    image.onload = () => {
      this._imageLoading = false; if (this._dead) return;
      const texture = this._imageTexture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
      this._mesh.material.map = texture; this._mesh.material.color.set(0xffffff); this._mesh.material.needsUpdate = true;
      this.log('image', { loadMs: this._now() - start, width: image.width, height: image.height });
    };
    image.onerror = error => { this._imageLoading = false; if (!this._dead) this.log('image-error', { message: error.errMsg || '图片加载失败' }); };
    image.src = '/assets/DHL-Outlined.png';
  },
  togglePlay() { this.setData({ playing: !this.data.playing }); },
  onSeek(event) { this._seconds = Number(event.detail.value) / 1000; this.setData({ playing: false, playhead: Number(event.detail.value) }); },
  toggleUV() { this.setData({ uvPacking: this.data.uvPacking === 'ra' ? 'rg' : 'ra' }); this.log('uv-packing', { value: this.data.uvPacking }); },
  toggleDiagnostics() { this.setData({ showDiagnostics: !this.data.showDiagnostics }); },
  openBridge() { wx.navigateTo({ url: '/labs/xr-three/bridge' }); },
  log(stage, payload) {
    const event = { time: new Date().toISOString(), stage, ...payload };
    console.log('[VKThreeLab]', JSON.stringify(event));
    this._events.push(event); if (this._events.length > 60) this._events.shift();
    if (!this._dead) this.setData({ logText: this._events.slice(-8).map(item => JSON.stringify(item)).join('\n') });
  },
  copyReport() { wx.setClipboardData({ data: JSON.stringify({ build, environment: this._environment, timings: this._stats, events: this._events }, null, 2) }); },
  onShow() {
    this._active = true;
    if (this._resumeAR && this.data.gpuReady) this.startAR(); else this.startPreview();
  },
  onHide() {
    this._active = false; this._resumeAR = this.data.arRunning || this.data.starting;
    this.stopPreview(); this._vk?.stop(); this.resetPlacement();
    this.setData({ starting: false, arRunning: false, status: '页面已暂停；返回后重新扫描并放置' });
  },
  onResize() { this.updateDimensions(wx.getSystemInfoSync()); },
  onContextLost(event) {
    this._resumeAR = false; this.stopPreview(); this._vk?.stop();
    this._facade?.dispatch('webglcontextlost', event.detail);
    this.setData({ gpuReady: false, arRunning: false, starting: false, canPlace: false, status: 'WebGL 上下文丢失，请退出验证页后重新进入' });
    this.log('context-lost', {});
  },
  onContextRestored(event) { this._facade?.dispatch('webglcontextrestored', event.detail); this.log('context-restored', { note: '请重新进入验证页以重建原生会话和 GPU 资源' }); },
  disposeObject(object) { object?.traverse(node => { node.geometry?.dispose(); if (Array.isArray(node.material)) node.material.forEach(m => m.dispose()); else node.material?.dispose(); }); },
  onUnload() {
    this._dead = true; this._active = false; this.stopPreview(); this._vk?.stop();
    this._rig?.dispose(); this._gltfMixer?.stopAllAction(); if (this._gltf) this._gltfMixer?.uncacheRoot(this._gltf.scene);
    this.disposeObject(this._scene); this._imageTexture?.dispose(); this._background?.dispose();
    for (const texture of this._testTextures || []) this._gl.deleteTexture(texture);
    this._renderer?.dispose(); this._canvas = this._vk = this._synthetic = null;
  },
});

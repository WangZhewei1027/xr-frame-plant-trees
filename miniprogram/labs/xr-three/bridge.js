const { THREE, createAnimationRig, probeWebGL2, createCanvasFacade, flipRows, createFixtureGLB } = require('./runtime');
const build = require('./vendor/build-info');
const SIZE = 256;

Page({
  data: { revision: THREE.REVISION, xrMounted: false, xrReady: false, xrStatus: '尚未启动', gpuReady: false, playing: true,
    bridgeEnabled: false, flipY: true, playhead: 0, viewWidth: 300, xrWidth: 600, xrHeight: 480,
    summary: '等待画布初始化', logText: '' },
  onLoad() {
    this._dead = false; this._active = true; this._seconds = 0; this._events = [];
    this._stats = {}; this._rig = createAnimationRig();
    const info = wx.getSystemInfoSync();
    this._environment = { platform: info.platform, system: info.system, model: info.model, SDKVersion: info.SDKVersion, version: info.version, pixelRatio: info.pixelRatio };
    const width = Math.max(200, info.windowWidth - 56), dpr = Math.min(info.pixelRatio || 1, 2);
    this.setData({ viewWidth: width, xrWidth: Math.round(width * dpr), xrHeight: Math.round(240 * dpr) });
    this.log('core', { revision: THREE.REVISION, packageVersion: build.version, result: 'AnimationMixer 已创建', ...this._environment });
  },
  onReady() {
    this.createSelectorQuery().select('#three-canvas').fields({ node: true, size: true }).exec(result => {
      if (this._dead) return;
      const canvas = result[0]?.node;
      if (!canvas) { this.log('gpu-error', { message: '没有取得 Canvas 节点' }); return; }
      this._canvas = canvas;
      canvas.width = canvas.height = SIZE;
      try {
        const gl = canvas.getContext('webgl2', { alpha: true, antialias: false });
        this._gl = gl;
        this.log('webgl2', probeWebGL2(gl));
        const facade = this._facade = createCanvasFacade(canvas, gl, SIZE, SIZE);
        const renderer = this._renderer = new THREE.WebGLRenderer({ canvas: facade, context: gl, alpha: true, antialias: false });
        renderer.setSize(SIZE, SIZE, false);
        renderer.setClearColor(0x14202b, 1);
        renderer.debug.onShaderError = (context, program, vertex, fragment) => {
          this._gpuFailed = true;
          this.log('shader-error', { program: context.getProgramInfoLog(program), vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment) });
        };
        this._threeScene = new THREE.Scene();
        this._camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        this._camera.position.set(0, 0, 3);
        this._mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0x30cc80, roughness: 0.6 }));
        this._rig.object.add(this._mesh);
        this._threeScene.add(this._rig.root);
        this._threeScene.add(new THREE.AmbientLight(0xffffff, 2));
        const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 3, 4); this._threeScene.add(light);
        this._pixels = new Uint8Array(SIZE * SIZE * 4);
        this._flipped = new Uint8Array(this._pixels.length);
        renderer.render(this._threeScene, this._camera);
        const error = gl.getError();
        if (error !== gl.NO_ERROR || this._gpuFailed) throw new Error(`首帧渲染失败，GL error=${error}`);
        // Rendering without an exception is not sufficient evidence. Read back
        // once and check that there is more than a uniform background.
        gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this._pixels);
        let variedPixels = 0;
        for (let i = 4; i < this._pixels.length; i += 4) {
          if (this._pixels[i] !== this._pixels[0] || this._pixels[i + 1] !== this._pixels[1] || this._pixels[i + 2] !== this._pixels[2]) variedPixels++;
        }
        const readError = gl.getError();
        if (!variedPixels || readError !== gl.NO_ERROR) throw new Error(`首帧像素验证失败：非背景像素=${variedPixels}，GL error=${readError}`);
        this.setData({ gpuReady: true });
        this.log('renderer', { result: '首帧与非背景像素检查通过', variedPixels, width: SIZE, height: SIZE });
      } catch (e) {
        this._gpuFailed = true;
        this.log('gpu-error', { message: e.message, note: '动画→XR 桥接仍可单独测试；不会回退旧版后冒充新版通过' });
      }
      this.startLoop();
    });
  },
  log(stage, payload) {
    const event = { time: new Date().toISOString(), stage, ...payload };
    console.log('[XRThreeLab]', JSON.stringify(event));
    this._events.push(event); if (this._events.length > 60) this._events.shift();
    if (!this._dead) this.setData({ logText: this._events.slice(-10).map(e => `${e.stage}: ${JSON.stringify(e)}`).join('\n') });
  },
  mountXR() {
    if (this.data.xrMounted) return;
    this.setData({ xrMounted: true, xrReady: false, xrStatus: '正在初始化；AR 需要真机' }, () => { this._xrView = this.selectComponent('#lab-xr'); });
    this._xrTimer = setTimeout(() => {
      if (!this._dead && !this.data.xrReady) {
        this.setData({ xrStatus: 'XR 未就绪：请检查控制台。模拟器 AR / 内置引擎失败时请用真机验证。' });
        this.log('xr-not-ready', { platform: this._environment.platform, message: '10 秒内没有 scene ready；不能把两项桥接判为通过' });
      }
    }, 10000);
  },
  unmountXR() {
    clearTimeout(this._xrTimer); this._xrView?.disposeBridge(); this._xrView = null;
    this.setData({ xrMounted: false, xrReady: false, bridgeEnabled: false, xrStatus: '已关闭，可重新启动' });
  },
  onXRDiagnostic({ detail }) {
    this._xrView = this.selectComponent('#lab-xr');
    if (detail.stage === 'xr-ready') { clearTimeout(this._xrTimer); this.setData({ xrReady: true, xrStatus: '场景已就绪；请检查绿色方块的运动与方向' }); }
    if (detail.stage === 'ar-ready') this.setData({ xrStatus: 'AR 已就绪；可以放置并测试贴图桥接' });
    if (detail.stage === 'xr-error') this.setData({ xrReady: false, bridgeEnabled: false, xrStatus: detail.message });
    this.log(detail.stage, detail);
  },
  placeInFront() { try { this._xrView?.placeInFront(); } catch (e) { this.log('placement-error', { message: e.message }); } },
  startLoop() {
    if (!this._canvas || this._dead || !this._active || this._raf != null) return;
    this._lastTick = null;
    const tick = timestamp => {
      this._raf = null;
      if (!this._active || this._dead) return;
      try { this.frame(Number.isFinite(timestamp) ? timestamp : Date.now()); }
      catch (e) { this._gpuFailed = true; this.setData({ gpuReady: false, bridgeEnabled: false }); this.log('frame-error', { message: e.message }); }
      if (!this._dead && this._active) this._raf = this._canvas.requestAnimationFrame(tick);
    };
    this._raf = this._canvas.requestAnimationFrame(tick);
  },
  frame(now) {
    const dt = this._lastTick == null ? 0 : Math.max(0, (now - this._lastTick) / 1000);
    this._lastTick = now;
    if (this.data.playing) this._seconds = (this._seconds + dt) % 4;
    const animationStart = Date.now();
    this._rig.sample(this._seconds);
    this._xrView?.setAnimationTime(this._seconds);
    this._gltfMixer?.setTime(this._seconds);
    this._stats.animationMs = Date.now() - animationStart;
    if (this._renderer && !this._gpuFailed) {
      const renderStart = Date.now();
      this._renderer.render(this._threeScene, this._camera);
      this._stats.renderSubmitMs = Date.now() - renderStart;
      if (this.data.bridgeEnabled && (this._lastCopy == null || now - this._lastCopy >= 100)) {
        this._lastCopy = now;
        const readStart = Date.now(), gl = this._gl;
        gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this._pixels);
        this._stats.readPixelsMs = Date.now() - readStart;
        const readError = gl.getError();
        if (readError !== gl.NO_ERROR) throw new Error(`readPixels GL error=${readError}`);
        const flipStart = Date.now();
        const pixels = this.data.flipY ? flipRows(this._pixels, this._flipped, SIZE, SIZE) : this._pixels;
        this._stats.flipRowsMs = Date.now() - flipStart;
        const uploadStart = Date.now();
        try {
          const accepted = this._xrView?.updateBridge(pixels, SIZE, SIZE);
          this._stats.xrTextureSubmitMs = Date.now() - uploadStart;
          this._stats.copyAccepted = !!accepted;
          if (accepted) this._copies = (this._copies || 0) + 1;
        } catch (e) { this.setData({ bridgeEnabled: false }); this.log('bridge-error', { message: e.message }); this._xrView?.disposeBridge(); }
      }
    }
    this._frames = (this._frames || 0) + 1;
    if (this._reportStart == null) this._reportStart = now;
    const span = now - this._reportStart;
    if (span >= 1000) {
      this._stats.fps = Math.round(this._frames * 1000 / span);
      this._stats.copyFps = Math.round((this._copies || 0) * 1000 / span);
      this._stats.copyMiBPerSecond = Number(((this._copies || 0) * SIZE * SIZE * 4 / (1024 * 1024) * 1000 / span).toFixed(2));
      this._stats.xr = this._xrView?.getDiagnostics() || null;
      this.setData({ playhead: Math.round(this._seconds * 1000), summary: JSON.stringify(this._stats, null, 2) });
      console.log('[XRThreeLab][timings]', JSON.stringify(this._stats));
      this._frames = this._copies = 0; this._reportStart = now;
    }
  },
  togglePlay() { this.setData({ playing: !this.data.playing }); },
  onSeek(e) { this._seconds = Number(e.detail.value) / 1000; this.setData({ playing: false, playhead: Number(e.detail.value) }); },
  toggleFlip() { this.setData({ flipY: !this.data.flipY }); },
  toggleBridge() {
    if (!this.data.xrReady || !this.data.gpuReady) return;
    const enabled = !this.data.bridgeEnabled;
    if (!enabled) this._xrView?.disposeBridge();
    this._lastCopy = null;
    this.setData({ bridgeEnabled: enabled });
    this.log('bridge-switch', { enabled, maxFps: 10, frameBytes: SIZE * SIZE * 4 });
  },
  testGLB() {
    if (this._gltf || this._loadingGLB) return;
    this._loadingGLB = true;
    const start = Date.now();
    new THREE.GLTFLoader().parse(createFixtureGLB(), '', gltf => {
      this._loadingGLB = false;
      if (this._dead) { this.disposeObject(gltf.scene); return; }
      this._gltf = gltf;
      gltf.scene.position.y = -0.55; gltf.scene.scale.setScalar(0.6);
      this._threeScene.add(gltf.scene);
      this._gltfMixer = new THREE.AnimationMixer(gltf.scene);
      gltf.animations.forEach(clip => this._gltfMixer.clipAction(clip).play());
      this.log('gltf', { parseMs: Date.now() - start, animations: gltf.animations.map(c => c.name), note: '仅无纹理、无压缩、内嵌 buffer 的 GLB；不代表网络 GLB 或 Draco/KTX2 已适配' });
    }, e => { this._loadingGLB = false; if (!this._dead) this.log('gltf-error', { message: e.message }); });
  },
  testImage() {
    if (this._imageTexture || this._imageLoading) return;
    this._imageLoading = true;
    const image = this._canvas.createImage(), start = Date.now();
    image.onload = () => {
      this._imageLoading = false;
      if (this._dead) return;
      const texture = this._imageTexture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
      this._mesh.material.map = texture; this._mesh.material.color.set(0xffffff); this._mesh.material.needsUpdate = true;
      try {
        this._renderer.render(this._threeScene, this._camera);
        const error = this._gl.getError();
        if (error !== this._gl.NO_ERROR) throw new Error(`图片纹理 GL error=${error}`);
        this.log('image', { loadAndSubmitMs: Date.now() - start, width: image.width, height: image.height, note: 'Canvas.createImage + THREE.Texture，请同时检查画面' });
      } catch (e) { this.log('image-error', { message: e.message }); }
    };
    image.onerror = e => { this._imageLoading = false; if (!this._dead) this.log('image-error', { message: e.errMsg || '本地图片加载失败' }); };
    image.src = '/assets/DHL-Outlined.png';
  },
  onContextLost(e) {
    this._facade?.dispatch('webglcontextlost', e.detail); this._gpuFailed = true;
    this.setData({ gpuReady: false, bridgeEnabled: false });
    this.log('context-lost', { message: 'WebGL 上下文丢失；请退出后重新进入实验页' });
  },
  onContextRestored(e) { this._facade?.dispatch('webglcontextrestored', e.detail); this.log('context-restored', { message: '本实验需重新进入页面复测' }); },
  copyReport() { wx.setClipboardData({ data: JSON.stringify({ build, environment: this._environment, timings: this._stats, events: this._events }, null, 2) }); },
  onShow() { this._active = true; this.startLoop(); },
  onHide() { this._active = false; this.stopLoop(); },
  stopLoop() {
    if (this._raf != null) this._canvas?.cancelAnimationFrame(this._raf);
    this._raf = null; this._lastTick = null; this._reportStart = null; this._frames = this._copies = 0;
  },
  disposeObject(object) { object?.traverse(node => { node.geometry?.dispose(); if (Array.isArray(node.material)) node.material.forEach(m => m.dispose()); else node.material?.dispose(); }); },
  onUnload() {
    this._dead = true; this._active = false; this.stopLoop();
    clearTimeout(this._xrTimer);
    this._xrView?.disposeBridge(); this._rig?.dispose();
    this._gltfMixer?.stopAllAction(); if (this._gltf) this._gltfMixer?.uncacheRoot(this._gltf.scene);
    this.disposeObject(this._threeScene); this._imageTexture?.dispose(); this._renderer?.dispose();
    this._pixels = this._flipped = this._canvas = this._xrView = null;
  },
});

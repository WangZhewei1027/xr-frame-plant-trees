const { createAnimationRig, applyToXR } = require('../runtime');
Component({
  lifetimes: {
    attached() { this._rig = createAnimationRig(); this._seconds = 0; this._dead = false; },
    detached() { this._dead = true; this.disposeBridge(); this._rig?.dispose(); this._scene = null; },
  },
  methods: {
    report(stage, data) { if (!this._dead) this.triggerEvent('diagnostic', { stage, ...data }); },
    onReady({ detail }) {
      try {
        this._scene = detail.value;
        this._xr = wx.getXrFrameSystem();
        this._transform = this._scene.getElementById('lab-performer').getComponent(this._xr.Transform);
        this.report('xr-ready', { ready: true, note: 'Three AnimationMixer → XR Transform；没有共享渲染器' });
      } catch (e) { this.report('xr-error', { message: e.message }); }
    },
    onARReady() { this._arReady = true; this.report('ar-ready', { version: this._scene?.ar?.arVersion }); this.placeInFront(); },
    setAnimationTime(seconds) { this._seconds = seconds; },
    onTick() {
      if (!this._transform || this._dead || this._failed) return;
      try {
        const start = Date.now();
        this._rig.sample(this._seconds);
        applyToXR(this._rig.object, this._transform);
        this._lastWriteMs = Date.now() - start;
      } catch (e) { this._failed = true; this.report('xr-error', { message: e.message }); }
    },
    getDiagnostics() { return { animationWriteMs: this._lastWriteMs ?? null, arReady: !!this._arReady, arVersion: this._scene?.ar?.arVersion ?? null }; },
    placeInFront() {
      if (!this._scene) return false;
      const xr = this._xr;
      const camera = this._scene.getElementById('lab-camera').getComponent(xr.Transform);
      const origin = this._scene.getElementById('lab-origin').getComponent(xr.Transform);
      const p = camera.worldPosition, f = camera.worldForward;
      // The project already uses camera's worldForward as the look direction.
      origin.position.setValue(p.x + f.x * 2, p.y + f.y * 2, p.z + f.z * 2);
      origin.quaternion.setValue(camera.worldQuaternion.x, camera.worldQuaternion.y, camera.worldQuaternion.z, camera.worldQuaternion.w);
      if (this._panel) {
        const t = this._panel.getComponent(xr.Transform);
        t.position.setValue(p.x + f.x * 2, p.y + f.y * 2 - 0.65, p.z + f.z * 2);
        t.quaternion.setValue(camera.worldQuaternion.x, camera.worldQuaternion.y, camera.worldQuaternion.z, camera.worldQuaternion.w);
      }
      this.report('placed', { arReady: !!this._arReady });
      return true;
    },
    updateBridge(buffer, width, height) {
      if (!this._scene || this._dead) return false;
      const scene = this._scene, xr = this._xr;
      if (!this._texture) {
        this._texture = scene.createTexture({ source: [buffer], width, height,
          pixelFormat: xr.ETextureFormat.RGBA8, generateMipmaps: false,
          minFilter: xr.EFilterMode.LINEAR, magFilter: xr.EFilterMode.LINEAR,
          wrapU: xr.EWrapMode.CLAMP_TO_EDGE, wrapV: xr.EWrapMode.CLAMP_TO_EDGE });
        this._material = scene.createMaterial(scene.assets.getAsset('effect', 'simple'), { u_baseColorMap: this._texture });
        this._material.setRenderState('cullOn', false);
        scene.assets.addAsset('material', 'lab-copy-material', this._material);
        this._panel = scene.createElement(xr.XRNode, { position: '0 -0.65 -2' });
        scene.getElementById('lab-texture-root').addChild(this._panel);
        const mesh = scene.createElement(xr.XRMesh, { geometry: 'plane', material: 'lab-copy-material', rotation: '90 0 0', scale: '0.8 1 0.8' });
        this._panel.addChild(mesh);
        this.placeInFront();
        this.report('texture-created', { width, height, note: '二维画面贴在 XR 平面；不共享深度/几何/灯光' });
      } else {
        this._texture.update({ width, height, buffer });
      }
      return true;
    },
    disposeBridge() {
      try {
        if (this._panel) {
          this._scene?.getElementById('lab-texture-root')?.removeChild(this._panel);
          this._panel.release();
        }
        if (this._material) this._scene?.assets.releaseAsset('material', 'lab-copy-material');
        this._texture?.destroy();
      } catch (e) { console.warn('[XRThreeLab] bridge cleanup', e.message); }
      this._panel = this._material = this._texture = null;
    },
  },
});

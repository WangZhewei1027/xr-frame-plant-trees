const { THREE } = require("../../../lib/three-runtime/runtime");
const {
  download,
  removeFile,
  disposeTree,
} = require("../../../lib/three-runtime/resources");
const { instantiateModel } = require("./model");
module.exports = (XR_CONFIG) => ({
  async _placeAudioAsset(asset) {
    if (!asset.file_url) return;
    const url = asset.file_url.replace(/\.webm(?=\?|$)/i, ".m4a");
    const path = await download(url);
    if (!this._isAssetPlacementCurrent(asset)) {
      if (path !== url) removeFile(path);
      return;
    }
    let handle, instance;
    try {
      handle = await this._modelCache.acquire("/assets/headphone.glb");
      instance = instantiateModel(handle, 0.3, asset.config);
    } catch (error) {
      if (handle) {
        disposeTree(handle.object);
        handle.release();
      }
      console.warn("[audio] 耳机模型加载失败，使用图形标记", error);
    }
    const pos =
      this._isAssetPlacementCurrent(asset) && this._calcForwardPos("audio");
    if (!pos) {
      if (instance) {
        instance.dispose();
        disposeTree(instance.root);
      }
      if (path !== url) removeFile(path);
      return;
    }
    const root = instance?.root || new THREE.Group();
    if (!instance)
      root.add(
        new THREE.Mesh(
          new THREE.BoxGeometry(0.15, 0.15, 0.15),
          new THREE.MeshStandardMaterial({ color: 0x4488ff }),
        ),
      );
    let ctx;
    const meta = asset.metadata || {},
      baseVolume = Math.min(
        1,
        Math.max(0, Number.isFinite(meta.volume) ? meta.volume : 1),
      );
    try {
      ctx = wx.createInnerAudioContext({ useWebAudioImplement: false });
      ctx.loop = meta.loop !== false;
      ctx.volume = 0;
      ctx.src = path;
      ctx.onError((error) => this.reportAssetError?.(asset, error));
    } catch (error) {
      try {
        ctx?.destroy();
      } catch (_) {}
      instance?.dispose();
      disposeTree(root);
      if (path !== url) removeFile(path);
      throw error;
    }
    root.position.set(pos.x, pos.y, pos.z);
    this.shadowRoot.add(root);
    let playing = meta.autoPlay !== false;
    const entry = this._registerNode(asset.id, root, null, {
      type: "audio",
      contentEpoch: asset._contentEpoch,
      audioRefs: { ctx, baseVolume },
      onTap() {
        playing = !playing;
        if (playing) ctx.play();
        else ctx.pause();
      },
      dispose() {
        try {
          ctx.stop();
        } catch (_) {}
        try {
          ctx.destroy();
        } catch (_) {}
        instance?.dispose();
        if (path !== url) removeFile(path);
      },
    });
    entry.mixer = instance?.mixer;
    if (!entry._destroyed && playing) {
      this.tickAudioVolume(true);
      ctx.play();
    }
  },
  tickAudioVolume(force = false) {
    if (!this._arReady) return;
    const now = Date.now();
    if (!force && now - (this._audioUpdatedAt || 0) < 100) return;
    this._audioUpdatedAt = now;
    const camera = this._runtime.camera.position,
      entries = this._audioEntries || [];
    let focus = null,
      nearest = 0.3;
    for (const entry of entries) {
      entry.audioRefs.distance = entry.node.position.distanceTo(camera);
      if (entry.audioRefs.distance < nearest) {
        focus = entry;
        nearest = entry.audioRefs.distance;
      }
    }
    for (const entry of entries) {
      const { ctx, baseVolume, distance } = entry.audioRefs;
      ctx.volume = focus
        ? focus === entry
          ? baseVolume
          : 0
        : distance >= XR_CONFIG.maxDistanceMeters
          ? 0
          : baseVolume / Math.pow(Math.max(1, distance), 4);
    }
  },
});

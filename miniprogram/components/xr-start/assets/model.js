const { THREE } = require("../../../lib/three-runtime/runtime");
const { disposeTree } = require("../../../lib/three-runtime/resources");
function instantiateModel(handle, targetSize, config = {}) {
  const root = new THREE.Group(),
    model = handle.object;
  const bounds = new THREE.Box3().setFromObject(model),
    size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  const configured = Number(config.scale_multiplier),
    multiplier = Number.isFinite(configured) && configured > 0 ? configured : 1;
  model.scale.multiplyScalar(
    (targetSize / (extent > 0.0001 ? extent : 1)) * multiplier,
  );
  root.add(model);
  const mixer = handle.animations.length
    ? new THREE.AnimationMixer(model)
    : null;
  handle.animations.forEach((clip) => mixer.clipAction(clip).play());
  return {
    root,
    mixer,
    dispose() {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      handle.release();
    },
  };
}
module.exports = {
  async _placeModelAsset(asset) {
    if (!asset.file_url) return;
    const handle = await this._modelCache.acquire(asset.file_url);
    const pos =
      this._isAssetPlacementCurrent(asset) && this._calcForwardPos("model");
    if (!pos || !this._wouldSurvive(pos, "heavy")) {
      disposeTree(handle.object);
      handle.release();
      return;
    }
    let instance;
    try {
      instance = instantiateModel(handle, 1, asset.config);
    } catch (error) {
      disposeTree(handle.object);
      handle.release();
      throw error;
    }
    const root = instance.root;
    root.position.set(pos.x, pos.y, pos.z);
    this.shadowRoot.add(root);
    const entry = this._registerNode(asset.id, root, null, {
      type: "model",
      contentEpoch: asset._contentEpoch,
      dispose: instance.dispose,
    });
    entry.mixer = instance.mixer;
    if (!instance.mixer)
      entry.modelAnim = {
        phase: Math.random() * Math.PI * 2,
        model: handle.object,
        baseY: handle.object.position.y,
      };
  },
  tickModelAnimation() {
    for (const entry of this.nodeList.concat(this._hugeNodeList || [])) {
      entry.mixer?.update(this._frameDelta || 0);
      if (entry.modelAnim) {
        const anim = entry.modelAnim;
        anim.phase += (this._frameDelta || 0) * 2;
        anim.model.position.y = anim.baseY + Math.sin(anim.phase) * 0.05;
        anim.model.rotation.y += this._frameDelta || 0;
      }
      entry.tick?.(this._frameDelta || 0);
    }
  },
};
module.exports.instantiateModel = instantiateModel;

const { THREE } = require("../../../lib/three-runtime/runtime");
const { createVideo } = require("../../../lib/three-runtime/video");
module.exports = {
  async _placeVideoAsset(asset) {
    if (!asset.file_url) return;
    const pos = this._calcForwardPos("video");
    if (!pos) return;
    const meta = asset.metadata || {};
    const video = createVideo(asset.file_url, meta, (error) =>
      this.reportAssetError?.(asset, error),
    );
    const ratio =
      Number(meta.width) > 0 && Number(meta.height) > 0
        ? Number(meta.width) / Number(meta.height)
        : 16 / 9;
    const root = new THREE.Group();
    root.position.set(pos.x, pos.y, pos.z);
    root.add(
      new THREE.Mesh(new THREE.PlaneGeometry(0.9 * ratio, 0.9), video.material),
    );
    this.shadowRoot.add(root);
    const entry = this._registerNode(asset.id, root, root, {
      type: "video",
      contentEpoch: asset._contentEpoch,
      dispose: video.dispose,
      onTap: video.toggle,
      tick: video.tick,
    });
    if (!entry._destroyed && meta.autoPlay !== false) video.play();
  },
};

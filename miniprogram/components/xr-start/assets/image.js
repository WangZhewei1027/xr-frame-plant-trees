const { THREE } = require("../../../lib/three-runtime/runtime");
const { loadTexture } = require("../../../lib/three-runtime/resources");
module.exports = {
  async _placeImageAsset(asset) {
    if (!asset.file_url) return;
    const texture = await loadTexture(this._canvas, asset.file_url);
    const pos =
      this._isAssetPlacementCurrent(asset) && this._calcForwardPos("image");
    if (!pos) {
      texture.dispose();
      return;
    }
    const aspect = texture.image.width / Math.max(1, texture.image.height);
    const root = new THREE.Group();
    root.position.set(pos.x, pos.y + (Math.random() - 0.5) * 0.4, pos.z);
    root.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(0.6 * aspect, 0.6),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      ),
    );
    this.shadowRoot.add(root);
    this._registerNode(asset.id, root, root, {
      type: "image",
      contentEpoch: asset._contentEpoch,
    });
  },
};

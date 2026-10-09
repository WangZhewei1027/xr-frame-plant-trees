const { createTextAsset } = require("../../../lib/three-runtime/text");
module.exports = {
  _placeTextAsset(asset) {
    const pos = this._calcForwardPos("text");
    if (!pos) return;
    const root = createTextAsset(
      asset.text_content,
      asset.config || {},
      this._textAssetStyle,
    );
    root.position.set(pos.x, pos.y + (Math.random() - 0.5) * 0.6, pos.z);
    this.shadowRoot.add(root);
    this._registerNode(asset.id, root, root, {
      type: "text",
      contentEpoch: asset._contentEpoch,
    });
  },
};

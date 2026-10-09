const { THREE } = require("../../../lib/three-runtime/runtime");
const { createTextAsset } = require("../../../lib/three-runtime/text");
module.exports = () => ({
  showDanmakuInXR(text) {
    if (
      this.retrievalMode === "anchor" ||
      this._retrievalPaused ||
      this._disposed ||
      !this._arReady
    )
      return;
    const camera = this._runtime.camera;
    const start = new THREE.Vector3(0, -0.4, 0.3).applyMatrix4(
      camera.matrixWorld,
    );
    const end = new THREE.Vector3(0, 0, -1.5).applyMatrix4(camera.matrixWorld);
    const node = createTextAsset(text, {}, this._textAssetStyle);
    node.position.copy(start);
    node.scale.setScalar(0.15);
    this.shadowRoot.add(node);
    const entry = this._registerNode(null, node, node, { type: "danmaku" });
    if (!entry._destroyed)
      this.flyingDanmakus.push({ node, start, end, at: Date.now() });
  },
  tickFlyingDanmakus() {
    this.flyingDanmakus = this.flyingDanmakus.filter((item) => {
      const t = Math.min(1, (Date.now() - item.at) / 600),
        ease = 1 - Math.pow(1 - t, 3);
      item.node.position.lerpVectors(item.start, item.end, ease);
      item.node.scale.setScalar(0.15 + ease * 0.85);
      return t < 1;
    });
  },
});

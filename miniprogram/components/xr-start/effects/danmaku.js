const { THREE } = require("../../../lib/three-runtime/runtime");
const { createTextAsset } = require("../../../lib/three-runtime/text");
module.exports = () => ({
  showDanmakuInXR(text, record) {
    if (
      this.retrievalMode === "anchor" ||
      this._retrievalPaused ||
      this._disposed ||
      !this._arReady ||
      !record || typeof record.id !== "string" || typeof record.placement_id !== "string"
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
    const id = `activity:${record.id}`;
    this._activityRecordIds = this._activityRecordIds || new Set();
    this._activityRecordIds.add(id);
    this._activityRecordPlacements = this._activityRecordPlacements || new Map();
    this._activityRecordPlacements.set(id, record.placement_id);
    this._allowedAssetIds.add(id);
    this._activityRevision = (this._activityRevision || 0) + 1;
    this._activityNextFetch = 1;
    const entry = this._registerNode(id, node, node, { type: "danmaku", contentEpoch: this._contentEpoch });
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

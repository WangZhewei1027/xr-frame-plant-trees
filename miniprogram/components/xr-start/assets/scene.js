const { CONFIG, backendRpc } = require("../../../utils/backend");
const { THREE } = require("../../../lib/three-runtime/runtime");
const { createCompositionPlayer } = require("../../../lib/scene-runtime/composition");

// One scene placement occupies one queue slot; its model children share its lifetime.
module.exports = {
  async _loadScenePlayer(asset, manifest) {
    if (manifest?.schemaVersion !== 2 || manifest.assetId !== asset.id || manifest.content?.kind !== "composition")
      throw new Error("不支持的场景内容");
    if (manifest.content.instances?.length === 0) return null;
    const player = createCompositionPlayer(manifest, { modelCache: this._modelCache });
    try {
      await player.load();
      if (!this._isAssetPlacementCurrent(asset)) { player.dispose(); return null; }
      if (player.state !== "ready") throw new Error(player.diagnostics?.message || "场景模型加载失败");
      return player;
    } catch (error) { player.dispose(); throw error; }
  },
  _mountScenePlayer(asset, player) {
    const camera = this.getCamTransform();
    if (!camera || !this._isAssetPlacementCurrent(asset)) { player.dispose(); return false; }
    const forward = camera.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const root = player.root;
    root.position.copy(camera.position).addScaledVector(forward, 2);
    // QR preview is directly in front; map scenes retain their ground-level origin.
    if (!this._scenePreviewMode) root.position.y -= 1.4;
    root.rotation.y = Math.atan2(-forward.x, -forward.z);
    if (!this._wouldSurvive(root.position, "scene")) { player.dispose(); return false; }
    this.shadowRoot.add(root);
    const entry = this._registerNode(asset.id, root, null, {
      type: "scene", contentEpoch: asset._contentEpoch, repulsionEnabled: false,
      dispose: () => player.dispose(), tick: (dt) => player.update(dt),
      onTap: () => {
        if (player.state === "ended") player.restart();
        else if (player.state === "playing") player.pause();
        else player.play();
      },
    });
    if (!entry._destroyed) player.play();
    return !entry._destroyed;
  },
  async _placeSceneAsset(asset) {
    let player;
    try {
      const { statusCode, data } = await backendRpc("get_scene_asset", {
        asset_id: asset.id, p_workspace_id: CONFIG.workspaceId, p_organization_id: CONFIG.organizationId,
      });
      if (!this._isAssetPlacementCurrent(asset)) return;
      if (statusCode !== 200) throw new Error(data?.error || "场景加载失败");
      player = await this._loadScenePlayer(asset, data);
      if (player) this._mountScenePlayer(asset, player);
    } catch (error) {
      player?.dispose();
      if (this._isAssetPlacementCurrent(asset)) throw error;
    }
  },
};

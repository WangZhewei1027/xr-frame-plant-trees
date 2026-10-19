const { fetchScenePreview } = require("../../utils/backend");
const MAX_FRAME_GAP_MS = 250;

module.exports = {
  _scenePreviewStatus(state, message) {
    this._scenePreviewState = state;
    this.triggerEvent("scenestatus", { state, message });
  },
  _cancelScenePreview() {
    this._scenePreviewRequest = (this._scenePreviewRequest || 0) + 1;
    this._scenePreviewPlayer?.dispose();
    this._scenePreviewPlayer = null;
    this._scenePreviewFrameAt = null;
    this._scenePreviewPlaced = false;
    this._scenePreviewState = null;
  },
  async _beginScenePreview() {
    this._cancelScenePreview();
    const request = this._scenePreviewRequest;
    const asset = { id: this.data.sceneId, file_type: "scene", _contentEpoch: this._contentEpoch };
    this._allowedAssetIds.add(asset.id);
    this._scenePreviewAsset = asset;
    this._scenePreviewStatus("loading", "正在加载场景，请缓慢移动手机…");
    let player;
    try {
      const { statusCode, data } = await fetchScenePreview(asset.id, this.data.sceneOrganizationId);
      if (request !== this._scenePreviewRequest || !this._isAssetPlacementCurrent(asset)) return;
      if (statusCode !== 200) throw new Error(data?.error || "场景加载失败");
      player = await this._loadScenePlayer(asset, data);
      if (request !== this._scenePreviewRequest || !this._isAssetPlacementCurrent(asset)) { player?.dispose(); return; }
      if (!player) { this._scenePreviewStatus("empty", "场景中还没有模型，请在管理端添加并保存"); return; }
      this._scenePreviewPlayer = player;
      this._scenePreviewStatus("tracking", "正在获取相机位置…");
    } catch (error) {
      player?.dispose();
      if (request === this._scenePreviewRequest && this._isAssetPlacementCurrent(asset))
        this._scenePreviewStatus("error", error.message || "场景加载失败");
    }
  },
  // Frames only enable manual placement. Waiting never mounts a Scene.
  _tickScenePreview(now = Date.now()) {
    if (!this._arReady || this._retrievalPaused || this._disposed || this._scenePreviewPlaced) return;
    this._scenePreviewFrameAt = now;
    if (this._scenePreviewPlayer && this._scenePreviewState !== "placeable")
      this._scenePreviewStatus("placeable", "点击放置场景");
  },
  placeScenePreview(now = Date.now()) {
    if (!this._scenePreviewMode || !this._arReady || this._retrievalPaused || this._disposed || this._scenePreviewPlaced || !this._scenePreviewPlayer) return false;
    // Reject a click against an old camera pose after tracking has stopped.
    if (this._scenePreviewFrameAt === null || now - this._scenePreviewFrameAt > MAX_FRAME_GAP_MS) {
      this._scenePreviewStatus("tracking", "正在获取相机位置…");
      return false;
    }
    const player = this._scenePreviewPlayer;
    this._scenePreviewPlayer = null;
    try {
      this._scenePreviewPlaced = this._mountScenePlayer(this._scenePreviewAsset, player);
      if (!this._scenePreviewPlaced) throw new Error("场景放置失败，请重试");
      this._scenePreviewStatus("ready", "");
      return true;
    } catch (error) { player.dispose(); this._scenePreviewStatus("error", error.message); return false; }
  },
  retryScenePreview() {
    if (!this._scenePreviewMode || this._disposed || this._retrievalPaused) return;
    if (!this._arReady) { this.retryAR(); return; }
    this._cancelScenePreview();
    this._clearRemoteAssets();
    this._beginScenePreview();
  },
};

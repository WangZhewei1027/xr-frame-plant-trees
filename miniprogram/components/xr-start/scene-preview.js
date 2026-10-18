const { fetchScenePreview } = require("../../utils/backend");
const STABLE_SECONDS = 2;
const MAX_FRAME_GAP_MS = 250;

module.exports = {
  _scenePreviewStatus(state, message) {
    this.triggerEvent("scenestatus", { state, message });
  },
  _cancelScenePreview() {
    this._scenePreviewRequest = (this._scenePreviewRequest || 0) + 1;
    this._scenePreviewPlayer?.dispose();
    this._scenePreviewPlayer = null;
    this._scenePreviewElapsed = 0;
    this._scenePreviewFrameAt = null;
    this._scenePreviewPlaced = false;
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
      this._scenePreviewStatus("stabilizing", "等待 AR 稳定，场景将在前方显示…");
    } catch (error) {
      player?.dispose();
      if (request === this._scenePreviewRequest && this._isAssetPlacementCurrent(asset))
        this._scenePreviewStatus("error", error.message || "场景加载失败");
    }
  },
  // Only valid AR camera frames count. Backgrounding, errors and long frame gaps reset the gate.
  _tickScenePreview(dt, now = Date.now()) {
    if (!this._arReady || this._retrievalPaused || this._disposed || this._scenePreviewPlaced) return;
    if (this._scenePreviewFrameAt === null || now - this._scenePreviewFrameAt > MAX_FRAME_GAP_MS)
      this._scenePreviewElapsed = 0;
    else this._scenePreviewElapsed += Math.min(Math.max(dt, 0), MAX_FRAME_GAP_MS / 1000);
    this._scenePreviewFrameAt = now;
    if (this._scenePreviewElapsed + 1e-9 < STABLE_SECONDS || !this._scenePreviewPlayer) return;
    const player = this._scenePreviewPlayer;
    this._scenePreviewPlayer = null;
    try {
      this._scenePreviewPlaced = this._mountScenePlayer(this._scenePreviewAsset, player);
      if (!this._scenePreviewPlaced) throw new Error("场景放置失败，请重试");
      this._scenePreviewStatus("ready", "轻触场景可暂停或继续播放");
    } catch (error) { player.dispose(); this._scenePreviewStatus("error", error.message); }
  },
  retryScenePreview() {
    if (!this._scenePreviewMode || this._disposed || this._retrievalPaused) return;
    if (!this._arReady) { this.retryAR(); return; }
    this._cancelScenePreview();
    this._clearRemoteAssets();
    this._beginScenePreview();
  },
};

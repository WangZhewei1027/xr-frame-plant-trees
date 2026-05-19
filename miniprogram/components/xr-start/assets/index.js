const { CONFIG, supabaseRpc } = require("../../../utils/supabase");
const createQueueMethods = require("./queue");
const createAudioMethods = require("./audio");
const textMethods = require("./text");
const modelMethods = require("./model");
const imageMethods = require("./image");
const videoMethods = require("./video");

/**
 * 远程素材模块入口：fetch + display + 分发到具体类型放置器，
 * 并合并队列管理与各类型放置/驱动方法。
 */
module.exports = function (XR_CONFIG) {
  const queueMethods = createQueueMethods(XR_CONFIG);
  const audioMethods = createAudioMethods(XR_CONFIG);

  return {
    ...queueMethods,
    ...textMethods,
    ...modelMethods,
    ...imageMethods,
    ...audioMethods,
    ...videoMethods,

    async fetchNearbyAssets() {
      if (this.isFetchingAssets || !this.currentGPS) return;
      this.isFetchingAssets = true;

      try {
        const { statusCode, data } = await supabaseRpc("get_nearby_assets", {
          user_lat: this.currentGPS.latitude,
          user_lng: this.currentGPS.longitude,
          max_distance_meters: XR_CONFIG.maxDistanceMeters,
          p_workspace_id: CONFIG.workspaceId,
          p_organization_id: CONFIG.organizationId,
        });

        if (statusCode === 200 && Array.isArray(data)) {
          this.displayAssets(
            data.filter(
              (a) =>
                (a.file_type === "text" ||
                  a.file_type === "model" ||
                  a.file_type === "image" ||
                  a.file_type === "audio" ||
                  a.file_type === "video") &&
                !a.is_huge,
            ),
          );
        }
      } catch (err) {
        console.error("[fetch] 请求失败:", err);
      } finally {
        this.isFetchingAssets = false;
      }
    },

    /**
     * 双队列策略（oldQueue / newQueue / danmakuQueue 共享同一个 nodeList 数组，靠 entry.gen 区分）：
     *   - gen='old'：上一轮及更早拉取遗留。驱逐策略 = 离用户最远优先。包含从数据库拉下来的历史弹幕。
     *   - gen='new'：本轮拉取刚放置。驱逐策略 = FIFO。
     *   - gen='danmaku'：用户刚发、尚未入库返回的在场弹幕。驱逐策略 = FIFO 独立队列。
     *
     * 拉取生命周期：
     *   1. 将上轮的所有 'new' 提升为 'old'（轮次转换）
     *   2. 以整个 nodeList 的 assetId 为准 diff，跳过重复、保证场景无重复素材
     *   3. 逐个放置新素材，_registerNode 以 gen='new' 插入并触发该队列的容量检查
     */
    displayAssets(assets) {
      // 预加载（scene + 头像/气泡纹理）未就绪时，先暂存，等 flushPendingDisplayAssets 调用
      if (!this._preloadDone) {
        this._pendingDisplayAssets = (this._pendingDisplayAssets || []).concat(
          assets,
        );
        return;
      }

      // 1. 轮次转换：上一轮的 'new' 变为 'old'。弹幕队列不受影响。
      for (const entry of this.nodeList) {
        if (entry.gen === "new") entry.gen = "old";
      }

      // 2. diff 去重：跳过任何队列中已存在的 assetId
      const cachedIds = new Set();
      for (const entry of this.nodeList) {
        if (entry.assetId !== null) cachedIds.add(entry.assetId);
      }
      const newAssets = assets.filter((a) => !cachedIds.has(a.id));

      // 3. 放置新素材；_registerNode 会在插入后自动检查各队列的容量
      newAssets.forEach((a) => this._placeAsset(a));
    },

    /** 预加载完成后由 index.js 调用，把暂存的 assets 一次性放置 */
    flushPendingDisplayAssets() {
      if (!this._pendingDisplayAssets || !this._pendingDisplayAssets.length) {
        return;
      }
      const pending = this._pendingDisplayAssets;
      this._pendingDisplayAssets = [];
      this.displayAssets(pending);
    },

    /** 按 file_type 分发到对应的放置方法 */
    _placeAsset(asset) {
      if (asset.file_type === "model") this._placeModelAsset(asset);
      else if (asset.file_type === "text") this._placeTextAsset(asset);
      else if (asset.file_type === "image") this._placeImageAsset(asset);
      else if (asset.file_type === "audio") this._placeAudioAsset(asset);
      else if (asset.file_type === "video") this._placeVideoAsset(asset);
    },
  };
};

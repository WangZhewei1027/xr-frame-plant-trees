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
     * 容量桶策略（所有节点共享 nodeList 数组，靠 entry.bucket 区分，见 registry.js / config.js）：
     *   - heavy（model/video）、light（text/image，含历史弹幕）、audio：按【位置距离】最远先踢。
     *   - transient（直发弹幕）：FIFO 驱逐最旧。
     * 各桶独立限容、互不驱逐 —— 文本洪水只挤 light 桶，永远碰不到 heavy 里的模型。
     *
     * 拉取生命周期（不再有 new/old 轮次翻转）：
     *   1. 以整个 nodeList 的 assetId 为准 diff（在场 + 消失冷却期都跳过）
     *   2. 限量揭示：每轮最多 revealPerFetch 个（首轮 revealFirstFetch），heavy 优先
     *   3. 逐个串行放置，_registerNode 按类型归桶并触发该桶容量检查
     */
    displayAssets(assets) {
      // 预加载（scene + 头像/气泡纹理）未就绪时，先暂存，等 flushPendingDisplayAssets 调用
      if (!this._preloadDone) {
        const merged = (this._pendingDisplayAssets || []).concat(assets);
        // 限制暂存上限：用户在预加载期间快速移动可能触发多次 fetch，
        // 累积过多 asset 会让 preload 完成后串行放置队列工作数秒。仅保留最新一批最相关的。
        const lightCap = (XR_CONFIG.buckets && XR_CONFIG.buckets.light.cap) || 20;
        const MAX_PENDING = lightCap * 2;
        this._pendingDisplayAssets =
          merged.length > MAX_PENDING ? merged.slice(-MAX_PENDING) : merged;
        return;
      }

      // 1. diff 去重：跳过在场的 assetId + 处于消失冷却期的（防短距离重复弹幕）
      const cachedIds = new Set();
      for (const entry of this.nodeList) {
        if (entry.assetId !== null) cachedIds.add(entry.assetId);
      }
      const newAssets = assets.filter(
        (a) =>
          !cachedIds.has(a.id) && !this._isInRepeatCooldown(a.id, a.file_type),
      );

      // 2. 限量揭示：每轮最多放 revealPerFetch 个（首轮 revealFirstFetch 加量），
      //    未入选的直接丢弃，下轮拉取重新返回时再轮到——制造"边走边逐步出现"。
      //    _firstRevealDone 只在实际放了内容时置位：首轮遇到空区域不消耗加量资格。
      const limit = this._firstRevealDone
        ? XR_CONFIG.revealPerFetch || 3
        : XR_CONFIG.revealFirstFetch || 6;
      const batch = this._pickRevealBatch(newAssets, limit);
      if (batch.length > 0) this._firstRevealDone = true;

      // 3. 串行放置：等上一个 asset 的异步操作完成后再开始下一个，
      //    避免多个 loadAsset 回调在同一帧扎堆导致卡顿。
      //    相邻两次放置之间额外插入 placeStaggerMs 的空闲窗口，让渲染帧喘气。
      this._enqueueDisplayAssets(batch);
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

    /**
     * 串行放置队列：把 assets 追加到内部队列，逐个 await 完成后再放下一个。
     * 多次调用（如 GPS 触发的连续 fetch）会自然排队，不会并发爆发。
     */
    _enqueueDisplayAssets(assets) {
      if (!this._placeQueue) this._placeQueue = [];
      for (const a of assets) this._placeQueue.push(a);

      // 关键优化：一拿到 model 类型 asset 就立刻并行 prefetch GLB 下载（不实例化）。
      // 串行放置每次 await loadAsset 时，网络阶段已被 prefetch 完成，可直接命中
      // xr-frame asset 缓存，避免"放置完一个 → 等下一个网络往返"的串行长尾。
      if (this.scene && this._prefetchModelAsset) {
        for (const a of assets) {
          if (a.file_type === "model" && a.file_url) {
            this._prefetchModelAsset(this.scene, a.file_url);
          }
        }
      }

      if (!this._placingBusy) this._drainPlaceQueue();
    },

    async _drainPlaceQueue() {
      this._placingBusy = true;
      const baseStagger = XR_CONFIG.placeStaggerMs || 40;
      while (this._placeQueue && this._placeQueue.length > 0) {
        const asset = this._placeQueue.shift();
        await this._placeAsset(asset);
        // 模型放置触发 GPU 资源上传，给主线程多一点喘息时间；
        // 其他轻量类型（text/image/audio/video）用配置中的基础值即可。
        const stagger =
          asset.file_type === "model"
            ? Math.max(baseStagger, 120)
            : baseStagger;
        await new Promise((r) => setTimeout(r, stagger));
      }
      this._placingBusy = false;
    },

    /**
     * 计算素材在相机正前方扇形区域内的随机放置坐标。
     * 在 await 之后调用，使用加载完成时的相机状态，避免素材出现在身后。
     * 半径区间和前向弧角均从 XR_CONFIG 读取，集中在 config.js 调整。
     *
     * @param {'text'|'image'|'model'|'audio'|'video'} type  素材类型
     * @returns {{ x: number, y: number, z: number } | null}
     */
    _calcForwardPos(type) {
      const xr = wx.getXrFrameSystem();
      const camTransform = this.getCamTransform();
      if (!camTransform) return null;
      const camPos = camTransform.position;
      // XR-Frame 坐标系：相机 local forward = (0,0,1)（+Z 朝前，Unity 约定）
      const wm = camTransform.worldMatrix;
      const localFwd = xr.Vector3.createFromNumber(0, 0, 1);
      const fwd = wm.transformDirection(localFwd);
      // atan2(z, x) → 以 +X 轴为 0° 的朝向角，与 cos/sin 放置约定匹配
      const camYaw = Math.atan2(fwd.z, fwd.x);
      const halfArc = ((XR_CONFIG.placeForwardArcDeg || 120) * Math.PI) / 180;
      const angle = camYaw + (Math.random() - 0.5) * 2 * halfArc;
      const { min: rMin, max: rMax } = (XR_CONFIG.placeRadius &&
        XR_CONFIG.placeRadius[type]) || { min: 1.0, max: 2.0 };
      const radius = rMin + Math.random() * (rMax - rMin);
      return {
        x: camPos.x + Math.cos(angle) * radius,
        y: camPos.y,
        z: camPos.z + Math.sin(angle) * radius,
      };
    },

    /** 按 file_type 分发到对应的放置方法 */
    async _placeAsset(asset) {
      if (asset.file_type === "model") await this._placeModelAsset(asset);
      else if (asset.file_type === "text") this._placeTextAsset(asset);
      else if (asset.file_type === "image") await this._placeImageAsset(asset);
      else if (asset.file_type === "audio") await this._placeAudioAsset(asset);
      else if (asset.file_type === "video") await this._placeVideoAsset(asset);
    },
  };
};

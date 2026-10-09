const { CONFIG, backendRpc } = require("../../../utils/backend");
const createQueueMethods = require("./queue");
const createAudioMethods = require("./audio");
const textMethods = require("./text");
const modelMethods = require("./model");
const imageMethods = require("./image");
const videoMethods = require("./video");
const matchLog = require("../matching/log");

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
      if (this._disposed || this._retrievalPaused) return;
      if (this.retrievalMode === "anchor") return this.recognizeAnchor();
      if (this.isFetchingAssets || !this.currentGPS) return;
      const epoch = this._modeEpoch;
      this.isFetchingAssets = true;

      try {
        const { statusCode, data } = await backendRpc("get_nearby_assets", {
          user_lat: this.currentGPS.latitude,
          user_lng: this.currentGPS.longitude,
          max_distance_meters: XR_CONFIG.maxDistanceMeters,
          p_workspace_id: CONFIG.workspaceId,
          p_organization_id: CONFIG.organizationId,
        });

        if (this._disposed || epoch !== this._modeEpoch) return;
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
        if (epoch === this._modeEpoch) this.isFetchingAssets = false;
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
      if (this._disposed || this._retrievalPaused) return;
      // 匹配模式只接收已确认 anchor 的白名单；预加载回放也不能复活旧轮素材。
      assets = assets.filter(
        (a) =>
          a &&
          (a._contentEpoch == null || a._contentEpoch === this._contentEpoch) &&
          (this.retrievalMode !== "anchor" ||
            (this._matchedAnchorId && this._allowedAssetIds.has(a.id))),
      );
      if (!assets.length) return;
      assets = assets.map((a) => ({ ...a, _contentEpoch: this._contentEpoch }));
      for (const a of assets) this._allowedAssetIds.add(a.id);
      // 预加载（VisionKit + Three）未就绪时，先暂存，等 flushPendingDisplayAssets 调用
      if (!this._preloadDone) {
        const merged = (this._pendingDisplayAssets || []).concat(assets);
        // 限制暂存上限：用户在预加载期间快速移动可能触发多次 fetch，
        // 累积过多 asset 会让 preload 完成后串行放置队列工作数秒。仅保留最新一批最相关的。
        const lightCap =
          (XR_CONFIG.buckets && XR_CONFIG.buckets.light.cap) || 20;
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
      for (const queued of this._placeQueue || []) cachedIds.add(queued.id);
      if (this._placingAssetId != null) cachedIds.add(this._placingAssetId);
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
      // Three 模型缓存，避免"放置完一个 → 等下一个网络往返"的串行长尾。
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
        // 关联匹配请求，而非素材加载完成时碰巧处于活动状态的另一轮请求。
        const timing =
          this.retrievalMode === "anchor" &&
          this._recognitionTiming?.contentEpoch === asset._contentEpoch
            ? this._recognitionTiming
            : null;
        const placementStartedAt = Date.now();
        const existingEntries = timing ? new Set(this.nodeList) : null;
        const queueWaitMs = timing
          ? Math.max(0, placementStartedAt - timing.matchedAt)
          : null;
        let placementError = null;
        if (timing) {
          matchLog(
            "素材开始放置",
            {
              anchorId: timing.anchorId,
              assetId: asset.id,
              assetType: asset.file_type,
              queueWaitMs,
            },
            "info",
            timing.requestId,
          );
        }
        try {
          this._placingAssetId = asset.id;
          await this._placeAsset(asset);
        } catch (error) {
          placementError = error;
          console.warn("[assets] 放置失败", error);
          this.reportAssetError?.(asset, error);
        } finally {
          this._placingAssetId = null;
        }
        if (timing) {
          const completedAt = Date.now();
          const current =
            this._recognitionTiming === timing &&
            this.retrievalMode === "anchor" &&
            !this._disposed &&
            !this._retrievalPaused &&
            timing.contentEpoch === this._contentEpoch &&
            asset._contentEpoch === this._contentEpoch &&
            this._matchedAnchorId === timing.anchorId &&
            this._allowedAssetIds.has(asset.id);
          // _placeAsset 也可能正常返回但没有放置节点，不能把返回时间说成显示成功。
          const placed =
            current &&
            this.nodeList.some(
              (entry) =>
                entry.assetId === asset.id &&
                entry.node &&
                !entry._destroyed &&
                !existingEntries.has(entry),
            );
          const outcome = !current
            ? "cancelled"
            : placementError
              ? "error"
              : placed
                ? "ready"
                : "skipped";
          const fields = {
            anchorId: timing.anchorId,
            assetId: asset.id,
            assetType: asset.file_type,
            outcome,
            queueWaitMs,
            placementMs: Math.max(0, completedAt - placementStartedAt),
            matchToAssetReadyMs:
              outcome === "ready"
                ? Math.max(0, completedAt - timing.matchedAt)
                : null,
            captureToAssetReadyMs:
              outcome === "ready" && Number.isFinite(timing.captureStartedAt)
                ? Math.max(0, completedAt - timing.captureStartedAt)
                : null,
            totalMs: Math.max(0, completedAt - timing.startedAt),
          };
          matchLog(
            "素材放置结束",
            fields,
            outcome === "error" ? "warn" : "info",
            timing.requestId,
          );
          if (outcome === "ready" && !timing.firstAssetReadyLogged) {
            timing.firstAssetReadyLogged = true;
            matchLog(
              "首个素材就绪",
              {
                ...fields,
                // 这里只测量放置方法完成且节点已登记，未测量 GPU 呈现的屏幕首帧。
                readiness: "placement_complete",
                screenFirstFrameMeasured: false,
              },
              "info",
              timing.requestId,
            );
          }
        }
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
      const camTransform = this.getCamTransform();
      if (!camTransform) return null;
      const camPos = camTransform.position;
      const fwd = this._runtime.camera.getWorldDirection(this._forwardScratch);
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

    _isAssetPlacementCurrent(asset) {
      return (
        !this._disposed &&
        !this._retrievalPaused &&
        asset._contentEpoch === this._contentEpoch &&
        this._allowedAssetIds.has(asset.id) &&
        (this.retrievalMode !== "anchor" || !!this._matchedAnchorId)
      );
    },

    /** 按 file_type 分发到对应的放置方法 */
    async _placeAsset(asset) {
      if (!this._isAssetPlacementCurrent(asset)) return;
      this._activePlacementEpoch = asset._contentEpoch;
      if (asset.file_type === "model") await this._placeModelAsset(asset);
      else if (asset.file_type === "text") await this._placeTextAsset(asset);
      else if (asset.file_type === "image") await this._placeImageAsset(asset);
      else if (asset.file_type === "audio") await this._placeAudioAsset(asset);
      else if (asset.file_type === "video") await this._placeVideoAsset(asset);
    },
  };
};

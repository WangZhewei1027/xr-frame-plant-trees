const { CONFIG, supabaseRpc } = require("../../../utils/supabase");

/**
 * 巨型远景模型：从 asset 表查询 is_huge=true 的 model，
 * 用 GPS + 罗盘估算方位，放置在远处；用户靠近时消失。
 */

// URL → Promise<model>：相同 GLB 只让 xr-frame 解析一次，重复放置直接复用。
// 必须用 Promise 缓存而非依赖 assetId 重复 loadAsset，因为 xr-frame 二次调用
// 不返回 { value: model } 包装，会让 const { value } = ... 解构到 undefined。
const __hugeUrlToPromise = new Map();
// URL → 包围盒尺寸：巨型 GLB 的 calcTotalBoundBox 是最贵的一档（高面数可达数百 ms），
// 同 URL 实例化出的包围盒固定，缓存复用（与 model.js 的 __urlToBoundSize 同策略）。
const __hugeUrlToBoundSize = new Map();
// URL → assetId：LRU 释放时需要按 assetId 调 releaseAsset
const __hugeUrlToAssetId = new Map();

function __hugeAssetId(url) {
  let aid = __hugeUrlToAssetId.get(url);
  if (!aid) {
    let h = 5381;
    for (let i = 0; i < url.length; i++) {
      h = ((h << 5) + h + url.charCodeAt(i)) | 0;
    }
    aid = `huge-model-asset-${(h >>> 0).toString(36)}`;
    __hugeUrlToAssetId.set(url, aid);
  }
  return aid;
}

function __getHugeModel(scene, url) {
  let p = __hugeUrlToPromise.get(url);
  if (p) {
    // LRU 触碰：删除后重插，把该 URL 刷新到 Map 尾部
    __hugeUrlToPromise.delete(url);
    __hugeUrlToPromise.set(url, p);
    return p;
  }
  const aid = __hugeAssetId(url);
  p = scene.assets
    .loadAsset({ type: "gltf", assetId: aid, src: url })
    .then((res) => {
      const model = res && res.value ? res.value : res;
      if (!model) throw new Error(`[huge] loadAsset returned empty for ${url}`);
      return model;
    })
    .catch((err) => {
      __hugeUrlToPromise.delete(url);
      throw err;
    });
  __hugeUrlToPromise.set(url, p);
  return p;
}

/**
 * 巨型 GLB 缓存 LRU 裁剪：超过 max 时从最久未用端释放不受保护的条目。
 * 巨型模型动辄几十 MB，驻留代价远高于普通模型，上限从紧。
 */
function __trimHugeCache(scene, max, protectedUrls) {
  if (__hugeUrlToPromise.size <= max) return;
  for (const url of Array.from(__hugeUrlToPromise.keys())) {
    if (__hugeUrlToPromise.size <= max) break;
    if (protectedUrls.has(url)) continue;
    __hugeUrlToPromise.delete(url);
    try {
      scene.assets.releaseAsset("gltf", __hugeAssetId(url));
    } catch (_) {}
  }
}

module.exports = function (XR_CONFIG) {
  const HUGE_DISPLAY_DISTANCE = 100; // XR 世界中最大放置距离（米）
  const HUGE_MODEL_SCALE = 15; // normalize 后的放大倍数
  const HUGE_HIDE_DISTANCE = 30; // GPS 距离小于此值时隐藏（米）

  return {
    /**
     * 从 asset 表拉取 is_huge=true 的模型，存入 _pendingHugeAssets 后尝试放置。
     */
    async fetchHugeAssets() {
      if (this._isFetchingHuge || !this.currentGPS) return;
      // organizationId 必须有；workspaceId 可选（为 null/undefined 时 RPC 返回该 org 下全部 workspace 的巨型模型）
      if (!CONFIG.organizationId) {
        console.warn("[huge] 缺少 organizationId，跳过巨型模型拉取");
        return;
      }
      this._isFetchingHuge = true;

      try {
        const { statusCode, data } = await supabaseRpc("get_huge_assets", {
          p_organization_id: CONFIG.organizationId,
          // workspaceId 未设置时传 null，RPC 解释为"不限 workspace"
          p_workspace_id: CONFIG.workspaceId ?? null,
        });

        XR_CONFIG.debugLog &&
          console.log(
            `[huge] fetch结果: statusCode=${statusCode}, 条数=${Array.isArray(data) ? data.length : "N/A"}`,
          );
        if (statusCode === 200 && Array.isArray(data)) {
          XR_CONFIG.debugLog &&
            console.log(
              "[huge] 原始数据:",
              JSON.stringify(
                data.map((a) => ({
                  id: a.id,
                  file_url: a.file_url,
                  lat: a.latitude,
                  lng: a.longitude,
                })),
              ),
            );
          this._pendingHugeAssets = data.filter(
            (a) => a.file_url && a.latitude != null && a.longitude != null,
          );
          XR_CONFIG.debugLog &&
            console.log(
              `[huge] 过滤后待放置: ${this._pendingHugeAssets.length} 个`,
            );
          this._placeHugeAssets();
        }
      } catch (err) {
        console.error("[huge] 获取巨型模型失败:", err);
      } finally {
        this._isFetchingHuge = false;
      }
    },

    /**
     * 将 _pendingHugeAssets 逐个放置到场景中。
     * 需要 scene、camera、GPS 均就绪；否则保留 pending，由 tickHugeModels 重试。
     */
    _placeHugeAssets() {
      if (!this._pendingHugeAssets || this._pendingHugeAssets.length === 0)
        return;
      if (!this.scene || !this.getCamTransform()) {
        return;
      }
      XR_CONFIG.debugLog &&
        console.log(
          `[huge] _placeHugeAssets 开始放置 ${this._pendingHugeAssets.length} 个模型`,
        );

      const toPlace = this._pendingHugeAssets;
      this._pendingHugeAssets = [];

      // 先清除同 id 的旧巨型节点，避免重复
      const incomingIds = new Set(toPlace.map((a) => a.id));
      for (let i = this._hugeNodeList.length - 1; i >= 0; i--) {
        if (incomingIds.has(this._hugeNodeList[i].assetId)) {
          try {
            this.shadowRoot.removeChild(this._hugeNodeList[i].node);
          } catch (_) {}
          this._hugeNodeList.splice(i, 1);
        }
      }

      // 串行放置：huge GLB 通常体积较大（几 MB ~ 几十 MB），并发下载/解析会让网络和
      // 主线程瞬间饱和，造成长时间掉帧。改为逐个 await，相邻之间给一个空闲窗口。
      this._enqueueHugePlace(toPlace);
    },

    _enqueueHugePlace(assets) {
      if (!this._hugePlaceQueue) this._hugePlaceQueue = [];
      for (const a of assets) this._hugePlaceQueue.push(a);
      if (!this._hugePlacingBusy) this._drainHugePlaceQueue();
    },

    async _drainHugePlaceQueue() {
      this._hugePlacingBusy = true;
      const stagger = XR_CONFIG.placeStaggerMs || 40;
      while (this._hugePlaceQueue && this._hugePlaceQueue.length > 0) {
        const asset = this._hugePlaceQueue.shift();
        try {
          await this._placeHugeModel(asset);
        } catch (e) {
          console.warn("[huge] place error:", e);
        }
        await new Promise((r) => setTimeout(r, stagger));
      }
      this._hugePlacingBusy = false;
    },

    /**
     * 加载并放置一个巨型模型。
     * 位置通过 GPS 方位角 + 罗盘航向映射到 XR 世界坐标。
     */
    async _placeHugeModel(asset) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform || !asset.file_url) return;
      if (!this.currentGPS) return;

      // GPS 方位角和距离
      const { bearing, distance } = this._gpsToRelative(
        this.currentGPS.latitude,
        this.currentGPS.longitude,
        asset.latitude,
        asset.longitude,
      );

      // 罗盘航向（设备朝向相对正北的角度，可能尚未获取，默认 0）
      const compassHeading = this._compassHeading || 0;

      // 相机在 XR 世界中的朝向角度（水平面）
      const wm = camTransform.worldMatrix;
      const localForward = xr.Vector3.createFromNumber(0, 0, 1);
      const worldForward = wm.transformDirection(localForward);
      const camAngleXR = Math.atan2(worldForward.x, worldForward.z);

      // 地理方位角 → XR 世界角度
      const relAngleRad = ((bearing - compassHeading) * Math.PI) / 180;
      const assetAngleXR = camAngleXR + relAngleRad;

      // 实际 GPS 距离映射到 XR 放置距离（远处模型不需要 1:1 映射）
      const displayDist = Math.min(distance * 1, HUGE_DISPLAY_DISTANCE);

      const camPos = camTransform.position;
      const x = camPos.x + Math.sin(assetAngleXR) * displayDist;
      const z = camPos.z + Math.cos(assetAngleXR) * displayDist;
      const y = camPos.y;

      XR_CONFIG.debugLog &&
        console.log(
          `[huge] 放置计算 id=${asset.id}:`,
          `\n  用户GPS=(${this.currentGPS.latitude.toFixed(6)}, ${this.currentGPS.longitude.toFixed(6)})`,
          `\n  模型GPS=(${asset.latitude.toFixed(6)}, ${asset.longitude.toFixed(6)})`,
          `\n  GPS距离=${distance.toFixed(1)}m, 方位角=${bearing.toFixed(1)}°`,
          `\n  罗盘航向=${compassHeading.toFixed(1)}°`,
          `\n  相机XR朝向=${((camAngleXR * 180) / Math.PI).toFixed(1)}°`,
          `\n  相对角度=${((relAngleRad * 180) / Math.PI).toFixed(1)}°, 最终角度=${((assetAngleXR * 180) / Math.PI).toFixed(1)}°`,
          `\n  XR放置距离=${displayDist.toFixed(2)}m`,
          `\n  相机位置=(${camPos.x.toFixed(2)}, ${camPos.y.toFixed(2)}, ${camPos.z.toFixed(2)})`,
          `\n  目标位置=(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`,
        );

      try {
        const nodeId = this.nodeIdCounter++;
        // 共享 Promise：同 URL 只解析一次（即使是几十 MB 的巨型 GLB）
        const model = await __getHugeModel(scene, asset.file_url);

        // 让一帧再做场景实例化，把网络回调与 GPU 上传切开
        await new Promise((r) => setTimeout(r, 0));

        const rootNode = scene.createElement(xr.XRNode, {
          id: `huge-model-node-${nodeId}`,
        });
        this.shadowRoot.addChild(rootNode);

        const transform = rootNode.getComponent(xr.Transform);
        transform.position.x = x;
        transform.position.y = y;
        transform.position.z = z;

        const gltfEl = scene.createElement(xr.XRGLTF);
        const gltfComp = gltfEl.getComponent(xr.GLTF);
        gltfComp.setData({ model });
        rootNode.addChild(gltfEl);

        // setData 引发 GPU 上传，让出一帧再算包围盒
        await new Promise((r) => setTimeout(r, 0));

        // 先 normalize 最长边到 1m，再乘以放大倍数。
        // 包围盒按 URL 缓存：巨型 GLB 的 calcTotalBoundBox 最贵，同 URL 只算一次。
        let size = __hugeUrlToBoundSize.get(asset.file_url);
        if (!size) {
          const boundBox = gltfComp.calcTotalBoundBox();
          size = {
            x: boundBox.size.x,
            y: boundBox.size.y,
            z: boundBox.size.z,
          };
          __hugeUrlToBoundSize.set(asset.file_url, size);
        }
        const maxExtent = Math.max(size.x, size.y, size.z);
        const normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0;
        const scaleMultiplier =
          asset.config && asset.config.scale_multiplier
            ? asset.config.scale_multiplier
            : 1.0;
        const hugeScale = normalizeScale * HUGE_MODEL_SCALE * scaleMultiplier;
        transform.scale.setValue(hugeScale, hugeScale, hugeScale);

        XR_CONFIG.debugLog &&
          console.log(
            `[huge] ✅ 放置完成 id=${asset.id}:`,
            `\n  boundBox.size=(${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)})`,
            `\n  maxExtent=${maxExtent.toFixed(3)}, normalizeScale=${normalizeScale.toFixed(3)}`,
            `\n  scaleMultiplier=${scaleMultiplier}, hugeScale=${hugeScale.toFixed(3)}`,
            `\n  hugeNodeList当前数量=${this._hugeNodeList.length + 1}`,
          );

        this._hugeNodeList.push({
          assetId: asset.id,
          node: rootNode,
          url: asset.file_url,
          lat: asset.latitude,
          lng: asset.longitude,
        });

        // 裁剪巨型 GLB 缓存：保护在场实例、待放置队列与本次 URL
        const protectedUrls = new Set([asset.file_url]);
        for (const e of this._hugeNodeList) {
          if (e.url) protectedUrls.add(e.url);
        }
        if (this._hugePlaceQueue) {
          for (const a of this._hugePlaceQueue) {
            if (a.file_url) protectedUrls.add(a.file_url);
          }
        }
        __trimHugeCache(
          scene,
          XR_CONFIG.maxCachedHugeUrls || 3,
          protectedUrls,
        );
      } catch (e) {
        console.error("[huge] 加载巨型模型失败:", asset.file_url, e);
      }
    },

    /** Haversine: GPS 坐标 → 方位角(度) + 距离(米) */
    _gpsToRelative(lat1, lng1, lat2, lng2) {
      const R = 6371000;
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const lat1R = toRad(lat1);
      const lat2R = toRad(lat2);

      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1R) * Math.cos(lat2R) * Math.sin(dLng / 2) ** 2;
      const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      const y = Math.sin(dLng) * Math.cos(lat2R);
      const x =
        Math.cos(lat1R) * Math.sin(lat2R) -
        Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLng);
      const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

      return { bearing, distance };
    },

    /**
     * 每帧调用：
     *  1. 尝试放置尚未放置的 pending 巨型模型（scene 可能在 fetch 后才就绪）
     *  2. 检查 GPS 距离，靠近时移除模型
     * Haversine 三角计算只在 GPS 更新时执行（updateGPS 每次生成新对象，引用比较即可），
     * GPS ~1Hz，无需每帧重算。
     */
    tickHugeModels() {
      // 重试 pending
      if (this._pendingHugeAssets && this._pendingHugeAssets.length > 0) {
        this._placeHugeAssets();
      }

      if (!this._hugeNodeList || this._hugeNodeList.length === 0) return;
      if (!this.currentGPS) return;
      if (this.currentGPS === this._lastHugeTickGPS) return;
      this._lastHugeTickGPS = this.currentGPS;

      for (let i = this._hugeNodeList.length - 1; i >= 0; i--) {
        const entry = this._hugeNodeList[i];
        const { distance } = this._gpsToRelative(
          this.currentGPS.latitude,
          this.currentGPS.longitude,
          entry.lat,
          entry.lng,
        );

        if (distance < HUGE_HIDE_DISTANCE) {
          XR_CONFIG.debugLog &&
            console.log(
              `[huge] 用户靠近巨型模型 id=${entry.assetId}, 距离=${distance.toFixed(0)}m, 隐藏`,
            );
          try {
            this.shadowRoot.removeChild(entry.node);
          } catch (_) {}
          this._hugeNodeList.splice(i, 1);
        }
      }
    },
  };
};

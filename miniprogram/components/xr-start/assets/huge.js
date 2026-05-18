const { CONFIG, supabaseRpc } = require("../../../utils/supabase");

/**
 * 巨型远景模型：从 asset 表查询 is_huge=true 的 model，
 * 用 GPS + 罗盘估算方位，放置在远处；用户靠近时消失。
 */
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

        console.log(
          `[huge] fetch结果: statusCode=${statusCode}, 条数=${Array.isArray(data) ? data.length : "N/A"}`,
        );
        if (statusCode === 200 && Array.isArray(data)) {
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
        console.log(
          `[huge] _placeHugeAssets 等待: scene=${!!this.scene}, camTransform=${!!this.getCamTransform()}`,
        );
        return;
      }
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

      for (const asset of toPlace) {
        this._placeHugeModel(asset);
      }
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
        const gltfAssetId = `huge-model-asset-${nodeId}`;
        const { value: model } = await scene.assets.loadAsset({
          type: "gltf",
          assetId: gltfAssetId,
          src: asset.file_url,
        });

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

        // 先 normalize 最长边到 1m，再乘以放大倍数
        const boundBox = gltfComp.calcTotalBoundBox();
        const size = boundBox.size;
        const maxExtent = Math.max(size.x, size.y, size.z);
        const normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0;
        const scaleMultiplier =
          asset.config && asset.config.scale_multiplier
            ? asset.config.scale_multiplier
            : 1.0;
        const hugeScale = normalizeScale * HUGE_MODEL_SCALE * scaleMultiplier;
        transform.scale.setValue(hugeScale, hugeScale, hugeScale);

        // 读回实际设置的 transform 值
        const actualPos = transform.position;
        const actualScale = transform.scale;
        console.log(
          `[huge] ✅ 放置完成 id=${asset.id}:`,
          `\n  boundBox.size=(${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)})`,
          `\n  maxExtent=${maxExtent.toFixed(3)}, normalizeScale=${normalizeScale.toFixed(3)}`,
          `\n  scaleMultiplier=${scaleMultiplier}`,
          `\n  hugeScale=${hugeScale.toFixed(3)}`,
          `\n  实际position=(${actualPos.x.toFixed(2)}, ${actualPos.y.toFixed(2)}, ${actualPos.z.toFixed(2)})`,
          `\n  实际scale=(${actualScale.x.toFixed(3)}, ${actualScale.y.toFixed(3)}, ${actualScale.z.toFixed(3)})`,
          `\n  hugeNodeList当前数量=${this._hugeNodeList.length + 1}`,
        );

        this._hugeNodeList.push({
          assetId: asset.id,
          node: rootNode,
          lat: asset.latitude,
          lng: asset.longitude,
        });
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
     */
    tickHugeModels() {
      // 重试 pending
      if (this._pendingHugeAssets && this._pendingHugeAssets.length > 0) {
        this._placeHugeAssets();
      }

      if (!this._hugeNodeList || this._hugeNodeList.length === 0) return;
      if (!this.currentGPS) return;

      for (let i = this._hugeNodeList.length - 1; i >= 0; i--) {
        const entry = this._hugeNodeList[i];
        const { distance } = this._gpsToRelative(
          this.currentGPS.latitude,
          this.currentGPS.longitude,
          entry.lat,
          entry.lng,
        );

        if (distance < HUGE_HIDE_DISTANCE) {
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

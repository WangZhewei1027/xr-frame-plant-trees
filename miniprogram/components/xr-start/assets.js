const { CONFIG, supabaseRpc } = require("../../utils/supabase");

/** 远程素材获取与场景渲染 */
module.exports = function (XR_CONFIG) {
  return {
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
                a.file_type === "text" ||
                a.file_type === "model" ||
                a.file_type === "image" ||
                a.file_type === "audio",
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
     * 将新拉取的 assets 与已显示的 nodeList 做 diff 对比：
     *  - 保留 ID 仍在新列表中的节点（不重建）
     *  - 销毁 ID 不在新列表中的旧节点
     *  - 按 maxNodeCount 上限补充新节点
     */
    displayAssets(assets) {
      const newIds = new Set(assets.map((a) => a.id));

      // 移除已失效的节点；assetId === null 为弹幕节点，保留不参与 diff
      const kept = [];
      for (const entry of this.nodeList) {
        if (entry.assetId === null || newIds.has(entry.assetId)) {
          kept.push(entry);
        } else {
          this._destroyNode(entry);
        }
      }
      this.nodeList = kept;

      // 过滤出尚未显示的新 asset，并按剩余名额进行放置
      const existingIds = new Set(kept.map((e) => e.assetId));
      const toAdd = assets.filter((a) => !existingIds.has(a.id));
      const slots = XR_CONFIG.maxNodeCount - kept.length;
      toAdd.slice(0, Math.max(0, slots)).forEach((a) => this._placeAsset(a));
    },

    /** 按 file_type 分发到对应的放置方法 */
    _placeAsset(asset) {
      if (asset.file_type === "model") this._placeModelAsset(asset);
      else if (asset.file_type === "text") this._placeTextAsset(asset);
      else if (asset.file_type === "image") this._placeImageAsset(asset);
      else if (asset.file_type === "audio") this._placeAudioAsset(asset);
    },

    /**
     * 统一注册一个已创建好的场景节点。
     * 提供双重 maxNodeCount 保护（应对异步竞态），超出时驱逐最旧节点。
     */
    _registerNode(assetId, node, billboardEl) {
      while (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
        this._destroyNode(this.nodeList.shift());
      }
      this.nodeList.push({ assetId, node, billboardEl });
    },

    /** 统一销毁一个 nodeList 条目（从场景中移除根节点，清理相关引用） */
    _destroyNode(entry) {
      try {
        this.shadowRoot.removeChild(entry.node);
      } catch (_) {}
      this.flyingDanmakus = (this.flyingDanmakus || []).filter(
        (d) => d.node !== entry.node,
      );
    },

    _placeTextAsset(asset) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const camPos = camTransform.position;
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.8 + Math.random() * 0.7;
      const x = camPos.x + Math.cos(angle) * radius;
      const z = camPos.z + Math.sin(angle) * radius;
      const y = camPos.y + (Math.random() - 0.5) * 0.6;

      const rootNode = scene.createElement(xr.XRNode, {
        id: `label-node-${this.nodeIdCounter++}`,
        position: `${x} ${y} ${z}`,
        scale: "0.1 0.1 0.1",
      });
      this.shadowRoot.addChild(rootNode);

      const text = scene.createElement(xr.XRText, {
        position: "0 0 0",
        value: asset.text_content || "无内容",
        size: "2",
        anchor: "0.5 0.5",
        "never-cull": "",
      });
      rootNode.addChild(text);
      this._registerNode(asset.id, rootNode, text);
    },

    async _placeModelAsset(asset) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform || !asset.file_url) return;

      // 在异步加载之前先记录当前相机世界坐标，避免加载完成后位置已漂移
      const camPos = camTransform.position;
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.0 + Math.random() * 1.5;
      const x = camPos.x + Math.cos(angle) * radius;
      const z = camPos.z + Math.sin(angle) * radius;
      const y = camPos.y;

      try {
        const assetId = `model-asset-${this.nodeIdCounter}`;
        const { value: model } = await scene.assets.loadAsset({
          type: "gltf",
          assetId,
          src: asset.file_url,
        });

        // 先把节点加入场景，再通过 Transform API 设置世界坐标，
        // 避免 createElement 字符串属性在 AR 模式下被清空或变为摄像机相对坐标
        const rootNode = scene.createElement(xr.XRNode, {
          id: `model-node-${this.nodeIdCounter++}`,
        });
        this.shadowRoot.addChild(rootNode);
        // 节点挂入场景后再写入世界位置，确保锚定在 AR 世界坐标中而非跟随相机
        const transform = rootNode.getComponent(xr.Transform);
        transform.position.x = x;
        transform.position.y = y;
        transform.position.z = z;

        const gltfEl = scene.createElement(xr.XRGLTF);
        const gltfComp = gltfEl.getComponent(xr.GLTF);
        gltfComp.setData({ model });
        rootNode.addChild(gltfEl);

        // 计算模型包围盒，将最长边 normalize 到 1m
        const boundBox = gltfComp.calcTotalBoundBox();
        const size = boundBox.size;
        const maxExtent = Math.max(size.x, size.y, size.z);
        const normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0;
        transform.scale.setValue(
          normalizeScale,
          normalizeScale,
          normalizeScale,
        );

        this._registerNode(asset.id, rootNode, null);
      } catch (e) {
        console.error("[model] 加载模型失败:", asset.file_url, e);
      }
    },

    /**
     * 在 AR 场景中放置一张图片（双面公告牌，始终朝向相机）
     * 字段：file_url（图片 URL），metadata.width / metadata.height（可选，用于计算宽高比）
     */
    async _placeImageAsset(asset) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform || !asset.file_url) return;

      // 异步加载前记录相机位置，避免加载完成后位置漂移
      const camPos = camTransform.position;
      const angle = Math.random() * Math.PI * 2;
      const radius = 0.8 + Math.random() * 1.0;
      const x = camPos.x + Math.cos(angle) * radius;
      const z = camPos.z + Math.sin(angle) * radius;
      const y = camPos.y + (Math.random() - 0.5) * 0.4;

      try {
        // 立即递增并快照，防止并发调用共享同一 assetId（竞态导致纹理缓存错乱）
        const nodeId = this.nodeIdCounter++;
        const assetId = `image-tex-${nodeId}`;

        // 并行：获取图片实际尺寸 + 加载纹理资源
        const [imgInfo] = await Promise.all([
          new Promise((resolve) => {
            wx.getImageInfo({
              src: asset.file_url,
              success: resolve,
              fail: () => resolve({ width: 1, height: 1 }),
            });
          }),
          scene.assets.loadAsset({
            type: "texture",
            assetId,
            src: asset.file_url,
          }),
        ]);

        console.log(
          "[image] getImageInfo res:",
          JSON.stringify({
            nodeId,
            width: imgInfo.width,
            height: imgInfo.height,
            orientation: imgInfo.orientation,
            type: imgInfo.type,
            path: imgInfo.path,
          }),
        );

        const rawW = imgInfo.width > 0 ? imgInfo.width : 1;
        const rawH = imgInfo.height > 0 ? imgInfo.height : 1;
        // EXIF orientation 为 right/left 系时，实际显示宽高互换（width/height 不含旋转）
        const rotated90 = [
          "right",
          "right-mirrored",
          "left",
          "left-mirrored",
        ].includes(imgInfo.orientation);
        const imgW = rotated90 ? rawH : rawW;
        const imgH = rotated90 ? rawW : rawH;
        console.log(
          `[image] nodeId=${nodeId}, rotated90=${rotated90}, effective size=${imgW}x${imgH}, aspect=${(imgW / imgH).toFixed(3)}`,
        );
        const targetH = 0.6; // 目标高度 0.6m

        const rootNode = scene.createElement(xr.XRNode, {
          id: `image-node-${nodeId}`,
        });
        this.shadowRoot.addChild(rootNode);

        const transform = rootNode.getComponent(xr.Transform);
        transform.position.x = x;
        transform.position.y = y;
        transform.position.z = z;

        // plane 默认水平（XZ 平面）；meshEl 绕 X 轴旋转 90° 后变为竖直（XY 平面）。
        // 旋转后平面的高度方向落在父节点的 Y 轴，宽度方向落在父节点的 X 轴，Z 分量为 0。
        // 故：scale.x = 宽，scale.y = 高，scale.z 无关紧要置 1。
        transform.scale.setValue(targetH * (imgW / imgH), targetH, 1);

        // plane 默认水平，旋转 90° 让它垂直朝前；rootNode 在 tick 中会自动朝向相机
        const meshEl = scene.createElement(xr.XRMesh, {
          geometry: "plane",
          material: "standard-mat",
          uniforms: `u_baseColorMap: ${assetId}`,
          rotation: "90 0 0",
          states: "cullOn: false",
        });
        rootNode.addChild(meshEl);

        // billboardEl = rootNode，使其在 handleTick 中参与 billboard 旋转
        this._registerNode(asset.id, rootNode, rootNode);
      } catch (e) {
        console.error("[image] 加载图片失败:", asset.file_url, e);
      }
    },

    /**
     * 在 AR 场景中放置一个 3D 空间音频源（WebAudio HRTF）
     * 字段：file_url（音频 URL），metadata.loop（是否循环，默认 true），
     *        metadata.volume（音量，默认 1），metadata.refDistance（参考距离，默认 1）
     */
    async _placeAudioAsset(asset) {
      if (!asset.file_url) return;
      const camTransform = this.getCamTransform();
      if (!camTransform) return;

      const audioCtx = this._ensureAudioContext();
      if (!audioCtx) return;

      if (!this.spatialAudioList) this.spatialAudioList = [];
      const maxAudio = XR_CONFIG.maxAudioCount || 5;
      if (this.spatialAudioList.length >= maxAudio) {
        const oldest = this.spatialAudioList.shift();
        try {
          oldest.source.stop();
        } catch (_) {}
        try {
          oldest.panner.disconnect();
        } catch (_) {}
        try {
          oldest.gainNode.disconnect();
        } catch (_) {}
      }

      // 异步加载前记录相机位置，确定音频的 AR 世界坐标
      const camPos = camTransform.position;
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.5 + Math.random() * 2.0;
      const srcX = camPos.x + Math.cos(angle) * radius;
      const srcZ = camPos.z + Math.sin(angle) * radius;
      const srcY = camPos.y;

      try {
        // 拉取音频文件为 ArrayBuffer
        const arrayBuffer = await new Promise((resolve, reject) => {
          wx.request({
            url: asset.file_url,
            method: "GET",
            responseType: "arraybuffer",
            success: (res) => resolve(res.data),
            fail: reject,
          });
        });

        const audioBuffer = await new Promise((resolve, reject) => {
          audioCtx.decodeAudioData(arrayBuffer, resolve, reject);
        });

        const meta = asset.metadata || {};

        // 音源节点
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = meta.loop !== false; // 默认循环

        // 音量节点
        const gainNode = audioCtx.createGain();
        gainNode.gain.value =
          typeof meta.volume === "number" ? meta.volume : 1.0;

        // 3D 空间定位节点（HRTF）
        const panner = audioCtx.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "inverse";
        panner.refDistance =
          typeof meta.refDistance === "number" ? meta.refDistance : 1;
        panner.maxDistance = XR_CONFIG.maxDistanceMeters || 20;
        panner.rolloffFactor = 1;
        if (typeof panner.setPosition === "function") {
          panner.setPosition(srcX, srcY, srcZ);
        }

        // 连接音频图：source -> gainNode -> panner -> destination
        source.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(audioCtx.destination);
        source.start();

        this.spatialAudioList.push({ source, gainNode, panner });
      } catch (e) {
        console.error("[audio] 加载音频失败:", asset.file_url, e);
      }
    },

    /** 懒初始化 WebAudio 上下文 */
    _ensureAudioContext() {
      if (!this._audioCtx) {
        try {
          this._audioCtx = wx.createWebAudioContext();
        } catch (e) {
          console.error("[audio] 无法创建 WebAudio 上下文:", e);
          return null;
        }
      }
      return this._audioCtx;
    },

    /**
     * 每帧更新 WebAudio 监听器的位置与朝向，使 3D 音频随相机变化
     * 需在 handleTick 中调用
     */
    tickSpatialAudio() {
      if (
        !this._audioCtx ||
        !this.spatialAudioList ||
        !this.spatialAudioList.length
      )
        return;

      const camTransform = this.getCamTransform();
      if (!camTransform) return;

      const pos = camTransform.worldPosition;
      const fwd = camTransform.worldForward;
      const up = camTransform.worldUp;

      const listener = this._audioCtx.listener;
      if (typeof listener.setPosition === "function") {
        // 旧版 WebAudio API（微信小程序目前支持的形式）
        listener.setPosition(pos.x, pos.y, pos.z);
        listener.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      } else {
        // 新版 AudioParam API
        const t = this._audioCtx.currentTime;
        listener.positionX && listener.positionX.setValueAtTime(pos.x, t);
        listener.positionY && listener.positionY.setValueAtTime(pos.y, t);
        listener.positionZ && listener.positionZ.setValueAtTime(pos.z, t);
        listener.forwardX && listener.forwardX.setValueAtTime(fwd.x, t);
        listener.forwardY && listener.forwardY.setValueAtTime(fwd.y, t);
        listener.forwardZ && listener.forwardZ.setValueAtTime(fwd.z, t);
        listener.upX && listener.upX.setValueAtTime(up.x, t);
        listener.upY && listener.upY.setValueAtTime(up.y, t);
        listener.upZ && listener.upZ.setValueAtTime(up.z, t);
      }
    },
  };
};

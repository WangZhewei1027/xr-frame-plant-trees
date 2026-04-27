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
                (a.file_type === "text" ||
                  a.file_type === "model" ||
                  a.file_type === "image" ||
                  a.file_type === "audio") &&
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

    // /**
    //  * 将新拉取的 assets 与已显示的 nodeList 做 diff 对比：
    //  *  - 保留 ID 仍在新列表中的节点（不重建）
    //  *  - 销毁 ID 不在新列表中的旧节点
    //  *  - 按 maxNodeCount 上限补充新节点
    //  */
    // displayAssets(assets) {
    //   const newIds = new Set(assets.map((a) => a.id));
    //
    //   // 移除已失效的节点；assetId === null 为弹幕节点，保留不参与 diff
    //   const kept = [];
    //   for (const entry of this.nodeList) {
    //     if (entry.assetId === null || newIds.has(entry.assetId)) {
    //       kept.push(entry);
    //     } else {
    //       this._destroyNode(entry);
    //     }
    //   }
    //   this.nodeList = kept;
    //
    //   // 过滤出尚未显示的新 asset，并按剩余名额进行放置
    //   const existingIds = new Set(kept.map((e) => e.assetId));
    //   const toAdd = assets.filter((a) => !existingIds.has(a.id));
    //   const slots = XR_CONFIG.maxNodeCount - kept.length;
    //   toAdd.slice(0, Math.max(0, slots)).forEach((a) => this._placeAsset(a));
    // },

    /** 每次拉取后全量放置，重复 ID 删旧留新，超出 maxNodeCount 时驱逐最旧节点 */
    displayAssets(assets) {
      // 先移除与本次拉取重复的旧节点（按 assetId 去重，弹幕节点 assetId===null 不参与）
      const incomingIds = new Set(assets.map((a) => a.id));
      const kept = [];
      for (const entry of this.nodeList) {
        if (entry.assetId !== null && incomingIds.has(entry.assetId)) {
          this._destroyNode(entry);
        } else {
          kept.push(entry);
        }
      }
      this.nodeList = kept;

      // 超出上限时，从头部驱逐最旧节点
      while (this.nodeList.length + assets.length > XR_CONFIG.maxNodeCount) {
        const oldest = this.nodeList.shift();
        if (oldest) this._destroyNode(oldest);
        else break;
      }
      assets.forEach((a) => this._placeAsset(a));
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
     * audioRefs: 可选，{ source, gainNode, panner }，销毁时一并停止音频。
     */
    _registerNode(assetId, node, billboardEl, audioRefs) {
      while (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
        this._destroyNode(this.nodeList.shift());
      }
      this.nodeList.push({
        assetId,
        node,
        billboardEl,
        audioRefs: audioRefs || null,
      });
    },

    /** 统一销毁一个 nodeList 条目（从场景中移除根节点，清理相关引用） */
    _destroyNode(entry) {
      try {
        this.shadowRoot.removeChild(entry.node);
      } catch (_) {}
      this.flyingDanmakus = (this.flyingDanmakus || []).filter(
        (d) => d.node !== entry.node,
      );
      if (entry.audioRefs) {
        try {
          entry.audioRefs.ctx.stop();
        } catch (_) {}
        try {
          entry.audioRefs.ctx.destroy();
        } catch (_) {}
      }
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

      this._buildBubbleNodes(rootNode, asset.text_content || "无内容");
      // billboard 目标 = rootNode，让整个气泡结构朝向相机
      this._registerNode(asset.id, rootNode, rootNode);
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
        // 为普通 model 节点添加动画参数：上下跳动 + 水平旋转
        const lastEntry = this.nodeList[this.nodeList.length - 1];
        if (lastEntry && lastEntry.node === rootNode) {
          lastEntry.modelAnim = {
            baseY: y,
            bobAmplitude: 0.05, // 上下幅度 5cm
            bobSpeed: 1.5 + Math.random() * 1.0, // 1.5~2.5 rad/s
            bobPhase: Math.random() * Math.PI * 2,
            rotateSpeed: 0.6 + Math.random() * 0.8, // 0.6~1.4 rad/s
            rotateAngle: Math.random() * Math.PI * 2,
          };
        }
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
     * 在 AR 场景中放置一个音频源，并用耳机模型标示其空间位置。
     * 字段：file_url（音频 URL），metadata.loop（是否循环，默认 true），
     *        metadata.volume（音量 0-1，默认 1）
     */
    async _placeAudioAsset(asset) {
      if (!asset.file_url) return;
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const meta = asset.metadata || {};
      const baseVolume = typeof meta.volume === "number" ? meta.volume : 1.0;

      // InnerAudioContext 需要本地路径（远程 URL 缺少 Content-Length 会报 -11828）
      // 先用 wx.downloadFile 下载到临时文件，再交给 InnerAudioContext 播放
      const ctx = wx.createInnerAudioContext({ useWebAudioImplement: false });
      ctx.loop = meta.loop !== false;
      ctx.volume = baseVolume;
      ctx.onError((err) => {
        console.error("[audio] 播放失败:", asset.file_url, err);
      });

      // .webm 转码为 .m4a，优先使用兼容性更好的 m4a 版本
      const audioUrl = asset.file_url.endsWith(".webm")
        ? asset.file_url.slice(0, -5) + ".m4a"
        : asset.file_url;

      wx.downloadFile({
        url: audioUrl,
        success: (res) => {
          if (res.statusCode === 200) {
            ctx.src = res.tempFilePath;
            ctx.play();
          } else {
            console.error(
              "[audio] 下载失败 statusCode:",
              res.statusCode,
              audioUrl,
            );
          }
        },
        fail: (err) => {
          console.error("[audio] 下载失败:", audioUrl, err);
        },
      });

      // 在相机附近随机放置耳机模型，表示音频源的 AR 空间位置
      const camPos = camTransform.position;
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.5 + Math.random() * 2.0;
      const srcX = camPos.x + Math.cos(angle) * radius;
      const srcZ = camPos.z + Math.sin(angle) * radius;
      const srcY = camPos.y;

      try {
        const nodeId = this.nodeIdCounter++;
        const glbAssetId = `audio-headphone-${nodeId}`;
        const { value: model } = await scene.assets.loadAsset({
          type: "gltf",
          assetId: glbAssetId,
          src: "/assets/headphone.glb",
        });

        const rootNode = scene.createElement(xr.XRNode, {
          id: `audio-node-${nodeId}`,
        });
        this.shadowRoot.addChild(rootNode);

        const transform = rootNode.getComponent(xr.Transform);
        transform.position.x = srcX;
        transform.position.y = srcY;
        transform.position.z = srcZ;

        const gltfEl = scene.createElement(xr.XRGLTF);
        const gltfComp = gltfEl.getComponent(xr.GLTF);
        gltfComp.setData({ model });
        rootNode.addChild(gltfEl);

        // normalize 最长边到 0.3m
        const boundBox = gltfComp.calcTotalBoundBox();
        const size = boundBox.size;
        const maxExtent = Math.max(size.x, size.y, size.z);
        const s = maxExtent > 0.0001 ? 0.3 / maxExtent : 0.3;
        transform.scale.setValue(s, s, s);

        // audioRefs.ctx 在 _destroyNode 中自动 stop()+destroy()
        // 直接存储世界坐标，避免依赖 worldPosition（多节点时可能不稳定）
        this._registerNode(asset.id, rootNode, null, {
          ctx,
          baseVolume,
          srcX,
          srcY,
          srcZ,
        });
      } catch (e) {
        console.error("[audio] 加载耳机模型失败:", e);
        // 回退：用小立方体占位，音频仍正常播放
        const nodeId = this.nodeIdCounter++;
        const rootNode = scene.createElement(xr.XRNode, {
          id: `audio-node-${nodeId}`,
        });
        this.shadowRoot.addChild(rootNode);
        const transform = rootNode.getComponent(xr.Transform);
        transform.position.x = srcX;
        transform.position.y = srcY;
        transform.position.z = srcZ;
        transform.scale.setValue(0.15, 0.15, 0.15);
        const cubeEl = scene.createElement(xr.XRMesh, {
          geometry: "cube",
          material: "standard-mat",
          uniforms: "u_baseColorFactor: 0.2 0.5 1.0 1.0",
        });
        rootNode.addChild(cubeEl);
        this._registerNode(asset.id, rootNode, null, {
          ctx,
          baseVolume,
          srcX,
          srcY,
          srcZ,
        });
      }
    },

    /**
     * 每帧根据音源节点与相机的距离动态调整音量。
     * 在 refDist 以内保持 baseVolume，超过后线性衰减至 maxDistanceMeters 处为 0。
     * 需在 handleTick 中调用。
     */
    tickAudioVolume() {
      const camTransform = this.getCamTransform();
      if (!camTransform) return;
      const camPos = camTransform.worldPosition;
      // refDist 以内满音量，之后按 (refDist/dist)² 平方反比衰减
      // 1m→1.0  2m→0.25  3m→0.11  5m→0.04
      const refDist = 1.0;
      const cutoffDist = XR_CONFIG.maxDistanceMeters || 20;
      this._audioDbgTick = (this._audioDbgTick || 0) + 1;
      const log = this._audioDbgTick % 60 === 0;
      for (const entry of this.nodeList) {
        if (!entry.audioRefs) continue;
        const { ctx, baseVolume, srcX, srcY, srcZ } = entry.audioRefs;
        const dist = Math.sqrt(
          (srcX - camPos.x) ** 2 +
            (srcY - camPos.y) ** 2 +
            (srcZ - camPos.z) ** 2,
        );
        // 平方反比衰减，超过 cutoffDist 强制为 0
        const r = Math.max(dist, refDist);
        const t = dist >= cutoffDist ? 0 : (refDist * refDist) / (r * r);
        const newVol = baseVolume * t;
        ctx.volume = newVol;
        if (log) {
          console.log(
            `[audio] dist=${dist.toFixed(2)}m  t=${t.toFixed(3)}  baseVol=${baseVolume}  setVol=${newVol.toFixed(3)}  ctx.volume=${ctx.volume}`,
          );
        }
      }
    },
    /**
     * 每帧驱动：为普通 model 节点添加上下小幅跳动 + 缓慢旋转。
     * 需在 handleTick 中调用。巨型模型（_hugeNodeList）不受影响。
     */
    tickModelAnimation() {
      const xr = wx.getXrFrameSystem();
      if (!this.nodeList || this.nodeList.length === 0) return;
      this._modelAnimLastTime = this._modelAnimLastTime || Date.now();
      const now = Date.now();
      const dt = Math.min((now - this._modelAnimLastTime) / 1000, 0.1);
      this._modelAnimLastTime = now;

      for (const entry of this.nodeList) {
        const anim = entry.modelAnim;
        if (!anim || !entry.node) continue;
        const trs = entry.node.getComponent(xr.Transform);
        if (!trs) continue;

        // 上下跳动：基于初始 baseY 加上 sin 偏移
        anim.bobPhase += anim.bobSpeed * dt;
        trs.position.y =
          anim.baseY + Math.sin(anim.bobPhase) * anim.bobAmplitude;

        // 水平旋转：绕 Y 轴累加角度
        anim.rotateAngle += anim.rotateSpeed * dt;
        const half = anim.rotateAngle * 0.5;
        trs.quaternion.setValue(0, Math.sin(half), 0, Math.cos(half));
      }
    },
  };
};

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

    /**
     * 双队列策略（oldQueue / newQueue / danmakuQueue 共享同一个 nodeList 数组，靠 entry.gen 区分）：
     *   - gen='old'：上一轮及更早拉取遗留。驱逐策略 = 离用户最远优先。包含从数据库拉下来的历史弹幕（text 类型）。
     *   - gen='new'：本轮拉取刚放置。驱逐策略 = FIFO。
     *   - gen='danmaku'：用户刚发、尚未入库返回的在场弹幕。驱逐策略 = FIFO 独立队列。
     *
     * 拉取生命周期（displayAssets 入口）：
     *   1. 将上轮的所有 'new' 提升为 'old'（轮次转换）
     *   2. 以整个 nodeList 的 assetId 为准 diff，跳过重复、保证场景无重复素材
     *   3. 逐个放置新素材，_registerNode 以 gen='new' 插入并触发该队列的容量检查
     */
    displayAssets(assets) {
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

    /** 按 file_type 分发到对应的放置方法 */
    _placeAsset(asset) {
      if (asset.file_type === "model") this._placeModelAsset(asset);
      else if (asset.file_type === "text") this._placeTextAsset(asset);
      else if (asset.file_type === "image") this._placeImageAsset(asset);
      else if (asset.file_type === "audio") this._placeAudioAsset(asset);
    },

    /**
     * 统一注册一个已创建好的场景节点，追加到 nodeList 末尾。
     * gen 推断优先级：
     *   - 显式传入 opts.gen → 尊重（用于弹幕主动传 'danmaku'）
     *   - 否则 assetId === null → 弹幕带入 'danmaku'（发送逻辑未传 gen 的兼容默认值）
     *   - 否则 → 'new'
     */
    _registerNode(assetId, node, billboardEl, audioRefs, opts) {
      const gen = (opts && opts.gen) || (assetId === null ? "danmaku" : "new");
      const newEntry = {
        assetId,
        node,
        billboardEl,
        audioRefs: audioRefs || null,
        gen,
      };
      this.nodeList.push(newEntry);
      this._enforceCapacity(newEntry);
    },

    /**
     * 分队列硬上限驱逐。三个队列互不影响。
     *   - newQueue (gen='new')      : 超 maxNewNodeCount    → FIFO
     *   - oldQueue (gen='old')      : 超 maxOldNodeCount    → 最远优先
     *   - danmakuQueue(gen='danmaku'): 超 maxDanmakuCount    → FIFO
     * protectEntry: 刚插入的节点引用，不参与驱逐。
     */
    _enforceCapacity(protectEntry) {
      const xr = wx.getXrFrameSystem();
      const camPos = this.getCamTransform()?.position;

      const evictFifo = (genTag, maxCount) => {
        while (true) {
          const list = this.nodeList.filter((e) => e.gen === genTag);
          if (list.length <= maxCount) break;
          let victimIdx = -1;
          for (let i = 0; i < this.nodeList.length; i++) {
            const e = this.nodeList[i];
            if (e === protectEntry) continue;
            if (e.gen !== genTag) continue;
            victimIdx = i;
            break;
          }
          if (victimIdx < 0) break;
          this._destroyNode(this.nodeList.splice(victimIdx, 1)[0]);
        }
      };

      const evictFarthest = (genTag, maxCount) => {
        while (true) {
          const list = this.nodeList.filter((e) => e.gen === genTag);
          if (list.length <= maxCount) break;
          let victimIdx = -1;
          let victimDistSq = -Infinity;
          for (let i = 0; i < this.nodeList.length; i++) {
            const e = this.nodeList[i];
            if (e === protectEntry) continue;
            if (e.gen !== genTag) continue;
            let d = Infinity;
            if (camPos) {
              const wp = e.node?.getComponent(xr.Transform)?.worldPosition;
              if (wp) {
                const dx = wp.x - camPos.x;
                const dz = wp.z - camPos.z;
                d = dx * dx + dz * dz;
              }
            }
            if (d > victimDistSq) {
              victimDistSq = d;
              victimIdx = i;
            }
          }
          if (victimIdx < 0) break;
          this._destroyNode(this.nodeList.splice(victimIdx, 1)[0]);
        }
      };

      evictFifo("new", XR_CONFIG.maxNewNodeCount);
      evictFarthest("old", XR_CONFIG.maxOldNodeCount);
      evictFifo("danmaku", XR_CONFIG.maxDanmakuCount);
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
        console.log(
          `[model] 开始加载 assetId=${assetId} url=${asset.file_url}`,
        );
        const { value: model } = await scene.assets.loadAsset({
          type: "gltf",
          assetId,
          src: asset.file_url,
        });
        console.log(`[model] 加载完成 assetId=${assetId} model=`, model);

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
        console.log(
          `[model] 节点 ${rootNode.id} 已挂载到场景，世界坐标 x=${x.toFixed(3)} y=${y.toFixed(3)} z=${z.toFixed(3)}`,
        );

        const gltfEl = scene.createElement(xr.XRGLTF);
        const gltfComp = gltfEl.getComponent(xr.GLTF);
        gltfComp.setData({ model });
        rootNode.addChild(gltfEl);
        console.log(`[model] GLTF 组件已创建并挂载到节点 ${rootNode.id}`);

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
        console.log(
          `[model] 包围盒 size=${size.x.toFixed(3)}x${size.y.toFixed(3)}x${size.z.toFixed(3)} maxExtent=${maxExtent.toFixed(3)} scale=${normalizeScale.toFixed(4)}`,
        );

        // 检查模型是否含有内置动画（GLTF/GLB 均支持）
        const animator = gltfEl.getComponent(xr.Animator);
        const hasAnimation =
          animator && animator._clips && animator._clips.size > 0;
        console.log(
          `[model] Animator 组件:`,
          animator ? "存在" : "不存在",
          `| 动画片段数:`,
          animator?._clips?.size ?? 0,
        );

        if (hasAnimation) {
          // 循环播放所有动画片段（不传 loop 选项默认无限循环）
          animator._clips.forEach((_, clipName) => {
            try {
              animator.play(clipName);
              console.log(`[model] ✅ 成功播放动画片段: "${clipName}"`);
            } catch (e) {
              console.warn(`[model] ❌ 播放动画片段失败: "${clipName}"`, e);
            }
          });
        } else {
          console.log(`[model] 无内置动画，使用上下跳动+旋转替代`);
        }

        this._registerNode(asset.id, rootNode, null);
        // 无内置动画时才叠加上下跳动 + 水平旋转效果
        if (!hasAnimation) {
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

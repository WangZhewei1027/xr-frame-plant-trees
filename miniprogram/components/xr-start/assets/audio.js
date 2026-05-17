/**
 * 音频素材：在 AR 场景中放置一个音频源，用耳机模型标示空间位置。
 * 字段：file_url（音频 URL），metadata.loop（是否循环，默认 true），
 *       metadata.volume（音量 0-1，默认 1）
 */
module.exports = function (XR_CONFIG) {
  return {
    async _placeAudioAsset(asset) {
      if (!asset.file_url) return;
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const meta = asset.metadata || {};
      const baseVolume = typeof meta.volume === "number" ? meta.volume : 1.0;

      // InnerAudioContext 需要本地路径（远程 URL 缺少 Content-Length 会报 -11828）
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
        const scaleMultiplier =
          asset.config && asset.config.scale_multiplier
            ? asset.config.scale_multiplier
            : 1.0;
        const finalScale = s * scaleMultiplier;
        transform.scale.setValue(finalScale, finalScale, finalScale);
        console.log(
          `[audio] 耳机模型 normalizeScale=${s.toFixed(4)} scaleMultiplier=${scaleMultiplier} finalScale=${finalScale.toFixed(4)}`,
        );

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
     * refDist 以内保持 baseVolume，超过后按 (refDist/dist)² 平方反比衰减，
     * 超过 maxDistanceMeters 强制为 0。
     */
    tickAudioVolume() {
      const camTransform = this.getCamTransform();
      if (!camTransform) return;
      const camPos = camTransform.worldPosition;
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
  };
};

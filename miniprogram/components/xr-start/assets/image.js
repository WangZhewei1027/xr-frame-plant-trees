/**
 * 图片素材：双面公告牌，按真实宽高比缩放，始终朝向相机。
 * 字段：file_url（图片 URL），metadata.width / metadata.height（可选）
 */
module.exports = {
  async _placeImageAsset(asset) {
    const xr = wx.getXrFrameSystem();
    const scene = this.scene;
    const camTransform = this.getCamTransform();
    if (!scene || !camTransform || !asset.file_url) return;

    try {
      // 立即递增并快照，防止并发调用共享同一 assetId（竞态导致纹理缓存错乱）
      const nodeId = this.nodeIdCounter++;
      const assetId = `image-tex-${nodeId}`;

      // 并行：获取图片实际尺寸 + 加载纹理资源
      // 图片尺寸通过 Storage 持久化缓存（按 URL 索引），避免重复 getImageInfo（每次 100-300ms）。
      const dimCacheKey = `imgInfo:dim:${asset.file_url}`;
      let cachedDim = null;
      try {
        cachedDim = wx.getStorageSync(dimCacheKey) || null;
      } catch (_) {}
      const dimPromise = cachedDim
        ? Promise.resolve(cachedDim)
        : new Promise((resolve) => {
            wx.getImageInfo({
              src: asset.file_url,
              success: (info) => {
                try {
                  wx.setStorageSync(dimCacheKey, {
                    width: info.width,
                    height: info.height,
                    orientation: info.orientation,
                  });
                } catch (_) {}
                resolve(info);
              },
              fail: () => resolve({ width: 1, height: 1 }),
            });
          });

      const [imgInfo] = await Promise.all([
        dimPromise,
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
      // EXIF orientation 为 right/left 系时，实际显示宽高互换
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

      // 加载完成后取当前相机位置，确保素材落在用户前方而非身后
      const pos = this._calcForwardPos("image");
      if (!pos) return;
      const x = pos.x;
      const z = pos.z;
      const y = pos.y + (Math.random() - 0.5) * 0.4;

      const rootNode = scene.createElement(xr.XRNode, {
        id: `image-node-${nodeId}`,
      });
      this.shadowRoot.addChild(rootNode);

      const transform = rootNode.getComponent(xr.Transform);
      transform.position.x = x;
      transform.position.y = y;
      transform.position.z = z;

      // plane 默认水平（XZ 平面）；meshEl 绕 X 轴旋转 90° 后变为竖直（XY 平面）。
      // 旋转后平面的高度方向落在父节点的 Y 轴，宽度方向落在父节点的 X 轴。
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
};

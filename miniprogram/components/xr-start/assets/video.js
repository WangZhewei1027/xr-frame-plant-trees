/**
 * 透明视频素材（TBB / Top-by-Bottom 格式）：
 *   - 加载 video-texture 资源
 *   - 动态创建基于自定义 TBB 合成 Effect 的 Material
 *   - 在相机附近随机位置放置垂直广告牌平面
 *
 * 字段：file_url（视频 URL）
 *       metadata.loop（是否循环，默认 true）
 *       metadata.autoPlay（是否自动播放，默认 true）
 *       metadata.width / metadata.height（视频【内容】尺寸，即 TBB 上半区域的宽/高，
 *                                         用于计算宽高比；默认 16:9）
 *
 * 注意：
 *   - width/height 填写的是【显示内容】的尺寸，不是原始 TBB 视频帧（双倍高度）的尺寸。
 *     例如原始视频为 1920×1080 TBB，内容为 1920×540，则填 width:1920 height:540。
 *   - 播放时控制台可能出现 "wx.createVideoDecoder with type: 'wemedia' is deprecated" 警告，可忽略。
 */

// 模块加载时注册 TBB Effect（全局只需执行一次）
require("../effects/transparent-video-tbb");

module.exports = {
  async _placeVideoAsset(asset) {
    const xr = wx.getXrFrameSystem();
    const scene = this.scene;
    const camTransform = this.getCamTransform();
    if (!scene || !camTransform || !asset.file_url) return;

    const meta = asset.metadata || {};
    const loop = meta.loop !== false;
    const autoPlay = meta.autoPlay !== false;

    try {
      const nodeId = this.nodeIdCounter++;
      const videoAssetId = `video-tbb-${nodeId}`;
      const matAssetId = `video-tbb-mat-${nodeId}`;

      // 1. 加载视频纹理
      const { value: videoTexture } = await scene.assets.loadAsset({
        type: "video-texture",
        assetId: videoAssetId,
        src: asset.file_url,
        options: { autoPlay, loop },
      });

      // 2. 获取 TBB Effect，基于它为本视频创建独立 Material 并绑定纹理
      const tbbEffect = scene.assets.getAsset(
        "effect",
        "transparent-video-tbb",
      );
      const videoMat = scene.createMaterial(tbbEffect, {
        u_videoMap: videoTexture.texture,
      });
      scene.assets.addAsset("material", matAssetId, videoMat);

      // 加载完成后取当前相机位置，确保素材落在用户前方而非身后
      const pos = this._calcForwardPos("video");
      if (!pos) return;
      const { x, y, z } = pos;

      // 3. 计算显示宽高比
      //    metadata.width/height 为内容（上半区）尺寸，不包含下半 Alpha 区；默认 16:9
      const contentW = meta.width || 16;
      const contentH = meta.height || 9;
      const aspect = contentW / contentH;
      const targetH = 0.9; // 目标高度 0.9m

      // 4. 创建场景节点
      const rootNode = scene.createElement(xr.XRNode, {
        id: `video-node-${nodeId}`,
      });
      this.shadowRoot.addChild(rootNode);

      const transform = rootNode.getComponent(xr.Transform);
      transform.position.x = x;
      transform.position.y = y;
      transform.position.z = z;
      // scale.x = 宽，scale.y = 高（与 image 资源保持一致）
      transform.scale.setValue(targetH * aspect, targetH, 1);

      // plane 默认水平，绕 X 轴旋转 90° 后变为垂直朝前
      const meshEl = scene.createElement(xr.XRMesh, {
        geometry: "plane",
        material: matAssetId,
        rotation: "90 0 0",
        states: "cullOn: false",
      });
      rootNode.addChild(meshEl);

      // billboardEl = rootNode，使整个平面在 handleTick 中始终朝向相机
      this._registerNode(asset.id, rootNode, rootNode, null, {
        videoRefs: { scene, videoAssetId, matAssetId },
      });

      console.log(
        `[video] TBB 透明视频已放置 videoAssetId=${videoAssetId} src=${asset.file_url}`,
      );
    } catch (e) {
      console.error("[video] 加载透明视频失败:", asset.file_url, e);
    }
  },
};

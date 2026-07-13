/**
 * 素材类型注册表（type → descriptor）。
 *
 * 队列引擎（queue.js）只认这里声明的策略，不认具体类型。
 * 新增一种素材类型 = 写一个 assets/xxx.js 放置模块 + 在此加一项，引擎零改动。
 *
 * descriptor 字段：
 *   - bucket ：归属的容量桶（见 config.js 的 buckets），决定限容与驱逐策略。
 *   - async  ：是否为"昂贵异步加载"类型（model/video）。为 true 时放置器需在
 *              实例化（setData/GPU 上传）之前调用 _wouldSurvive 做完成时复检，
 *              避免加载完立刻被驱逐、白花最贵的一步。
 *   - dispose(entry)：销毁该类型节点时的自定义资源清理（this = 组件实例）。
 *                     基础的 removeChild 由 _destroyNode 统一处理，这里只补类型特有的释放。
 *   - repeatCooldownMs：节点被驱逐（消失）后，该 assetId 在此窗口内不会被
 *              displayAssets 重新放置。防止"被踢 → 下次拉取又回来"的短距离重复弹幕。
 *              不设置 = 无冷却（model/video/audio 是场景主角，走回来应立刻可见）。
 */
module.exports = {
  text: { bucket: "light", repeatCooldownMs: 60000 },

  image: {
    bucket: "light",
    repeatCooldownMs: 60000,
    // 每次放置创建的唯一纹理必须随节点驱逐一起释放，否则 GPU 内存只增不减、越走越卡
    dispose(entry) {
      const { scene, texAssetId } = entry.imageRefs || {};
      if (!scene) return;
      try {
        scene.assets.releaseAsset("texture", texAssetId);
      } catch (_) {}
    },
  },

  model: { bucket: "heavy", async: true },

  video: {
    bucket: "heavy",
    async: true,
    dispose(entry) {
      const { scene, videoAssetId, matAssetId } = entry.videoRefs || {};
      if (!scene) return;
      try {
        scene.assets.releaseAsset("video-texture", videoAssetId);
      } catch (_) {}
      try {
        scene.assets.releaseAsset("material", matAssetId);
      } catch (_) {}
    },
  },

  audio: {
    bucket: "audio",
    dispose(entry) {
      const ctx = entry.audioRefs && entry.audioRefs.ctx;
      if (!ctx) return;
      try {
        ctx.stop();
      } catch (_) {}
      try {
        ctx.destroy();
      } catch (_) {}
    },
  },

  // 直发弹幕：用户刚发、尚未入库返回的在场弹幕（飞行动画由 tickFlyingDanmakus 驱动）
  danmaku: {
    bucket: "transient",
    dispose(entry) {
      // this = 组件实例；把该节点从飞行队列里摘掉
      this.flyingDanmakus = (this.flyingDanmakus || []).filter(
        (d) => d.node !== entry.node,
      );
    },
  },
};

/** XR 场景就绪后预加载纹理：树模型、头像圈图、气泡背景 */
const XR_CONFIG = require("./config");

const PROFILE_COUNT = 31;
const BUBBLE_RATIO_MIN = 2;
const BUBBLE_RATIO_MAX = 8;

module.exports = {
  /** 加载树 GLB 主模型，挂到 this.gltfModel */
  async loadTreeModel(xrScene) {
    const { value: model } = await xrScene.assets.loadAsset({
      type: "gltf",
      assetId: "tree",
      src: XR_CONFIG.treeModelUrl,
    });
    this.gltfModel = model;
  },

  /**
   * 头像圈图预加载：优先 await 前 8 张（足够首批气泡生成使用），
   * 剩余 23 张转为 "fire-and-forget" 后台加载，不阻塞 _preloadDone。
   * 这样首屏可以提前 ~50% 进入素材放置阶段。
   */
  async loadProfileTextures(xrScene) {
    this._profileAssetIds = [];
    const PRIORITY_COUNT = 8;
    const loadOne = (i) => {
      const aid = `profile-tex-${i - 1}`;
      return xrScene.assets
        .loadAsset({
          type: "texture",
          assetId: aid,
          src: `/assets/profile/profile_${i}_circle.png`,
        })
        .then(() => this._profileAssetIds.push(aid))
        .catch((e) => console.warn("[profile] 加载头像失败:", i, e));
    };
    const priority = [];
    for (let i = 1; i <= Math.min(PRIORITY_COUNT, PROFILE_COUNT); i++) {
      priority.push(loadOne(i));
    }
    // 后台异步加载剩余头像（不 await）
    for (let i = PRIORITY_COUNT + 1; i <= PROFILE_COUNT; i++) {
      loadOne(i);
    }
    await Promise.all(priority);
  },

  /** 并行预加载圆角气泡纹理（不同宽高比 2x1 ~ 8x1） */
  async loadBubbleTextures(xrScene) {
    this._bubbleTexIds = {};
    const tasks = [];
    for (let ratio = BUBBLE_RATIO_MIN; ratio <= BUBBLE_RATIO_MAX; ratio++) {
      const aid = `bubble-tex-${ratio}`;
      tasks.push(
        xrScene.assets
          .loadAsset({
            type: "texture",
            assetId: aid,
            src: `/assets/bubble/bubble_${ratio}x1.png`,
          })
          .then(() => {
            this._bubbleTexIds[ratio] = aid;
          })
          .catch((e) => console.warn("[bubble] 加载气泡纹理失败:", ratio, e)),
      );
    }
    await Promise.all(tasks);
  },
};

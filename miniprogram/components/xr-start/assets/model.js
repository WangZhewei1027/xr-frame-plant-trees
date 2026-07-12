/** 模型素材：加载 GLTF/GLB，normalize 包围盒到 1m，无内置动画时叠加跳动+旋转 */

// URL → assetId 稳定映射：同一 GLB 复用 xr-frame 资源缓存，避免重复下载/解析。
// nodeIdCounter 已不能作为 assetId 的唯一来源（会让相同 URL 反复加载，每次 500-1500ms）。
const __urlToAssetId = new Map();
// URL → Promise<model>：prefetch 与正式放置共享同一个 loadAsset 调用。
// 关键：xr-frame 的 loadAsset 用相同 assetId 重复调用时不返回 { value: model } 包装，
// 必须靠 Promise 缓存复用首次解析结果，否则二次 await 会拿到 undefined → m.value 报错。
const __urlToModelPromise = new Map();
// URL → { x, y, z } 包围盒缓存：calcTotalBoundBox 会遍历所有 mesh，
// 对高面数模型可达 100-300ms；同一 URL 实例化出的 model 包围盒固定，缓存复用。
const __urlToBoundSize = new Map();

function __getModelAssetId(url) {
  let aid = __urlToAssetId.get(url);
  if (!aid) {
    // 简单稳定 hash（djb2），保证同 URL → 同 assetId，跨节点共享缓存
    let h = 5381;
    for (let i = 0; i < url.length; i++)
      h = ((h << 5) + h + url.charCodeAt(i)) | 0;
    aid = `model-asset-${(h >>> 0).toString(36)}`;
    __urlToAssetId.set(url, aid);
  }
  return aid;
}

/**
 * 取（或创建）某个 URL 的 GLB 加载 Promise。
 * 仅在首次为该 URL 调用 scene.assets.loadAsset，后续 prefetch / 放置共享同一 Promise。
 * 失败时清掉缓存，下一次调用会重试。
 */
function __getOrLoadModel(scene, url) {
  let p = __urlToModelPromise.get(url);
  if (p) return p;
  const aid = __getModelAssetId(url);
  p = scene.assets
    .loadAsset({ type: "gltf", assetId: aid, src: url })
    .then((res) => {
      // xr-frame 首次加载返回 { value: model }；缓存裸 model 供后续复用
      const model = res && res.value ? res.value : res;
      if (!model)
        throw new Error(`[model] loadAsset returned empty for ${url}`);
      return model;
    })
    .catch((err) => {
      __urlToModelPromise.delete(url);
      throw err;
    });
  __urlToModelPromise.set(url, p);
  return p;
}

// 主线程让渡：在两次重操作（loadAsset / setData / calcTotalBoundBox）之间插入一帧，
// 让渲染线程有机会出图，把单次 500-1500ms 的"卡死"切碎成多个 60ms 的小尖刺。
function __yieldFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

module.exports = {
  // 暴露给 assets/index.js 调用：批拿到 model 列表时立刻并行 prefetch GLB 下载，
  // 不实例化（不 setData），仅让 xr-frame 把数据缓存好，
  // 后续串行放置阶段 await 时直接命中已 resolve 的 Promise，无需再走网络。
  _prefetchModelAsset(scene, url) {
    if (!scene || !url) return;
    // 启动（或复用）加载 Promise，失败静默吞掉，正式放置时再走一次错误路径
    __getOrLoadModel(scene, url).catch(() => {});
  },

  async _placeModelAsset(asset) {
    const xr = wx.getXrFrameSystem();
    const scene = this.scene;
    const camTransform = this.getCamTransform();
    if (!scene || !camTransform || !asset.file_url) return;

    try {
      console.log(`[model] 开始加载 url=${asset.file_url}`);
      // 共享同一 Promise：若 prefetch 已经发起，这里直接 await 同一结果
      const model = await __getOrLoadModel(scene, asset.file_url);
      console.log(`[model] 加载完成`);

      // 让出一帧：loadAsset 解析刚结束，立刻 setData/calcBoundBox 会连成长任务，
      // 用户感知为"咔哒一下卡"。等待一帧再继续，把重活摊到下一帧。
      await __yieldFrame();

      // 加载完成后取当前相机位置，确保素材落在用户前方而非身后
      const pos = this._calcForwardPos("model");
      if (!pos) return;
      const { x, y, z } = pos;

      // 完成时复检：若放下去会立即成为 heavy 桶里最远被踢，直接放弃。
      // GLB 已被 URL Promise 缓存（复用零成本），跳过最贵的 setData/GPU 上传/calcBoundBox。
      if (!this._wouldSurvive(pos, "heavy")) {
        console.log(`[model] 完成时复检：无存活槽位，放弃放置 ${asset.file_url}`);
        return;
      }

      // 先把节点加入场景，再通过 Transform API 设置世界坐标
      const rootNode = scene.createElement(xr.XRNode, {
        id: `model-node-${this.nodeIdCounter++}`,
      });
      this.shadowRoot.addChild(rootNode);
      const transform = rootNode.getComponent(xr.Transform);
      transform.position.x = x;
      transform.position.y = y;
      transform.position.z = z;

      const gltfEl = scene.createElement(xr.XRGLTF);
      const gltfComp = gltfEl.getComponent(xr.GLTF);
      // xr-frame 允许同一 model 对象给多个 XRGLTF 节点 setData（内部会每节点 instantiate 一份）
      gltfComp.setData({ model });
      rootNode.addChild(gltfEl);

      // 再让一帧：setData 触发了 GPU 资源上传，把 calcTotalBoundBox 推迟到下一帧执行
      await __yieldFrame();

      // 计算（或复用）包围盒：calcTotalBoundBox 对高面数模型耗时显著，按 URL 缓存
      let cachedSize = __urlToBoundSize.get(asset.file_url);
      let size;
      if (cachedSize) {
        size = cachedSize;
      } else {
        const boundBox = gltfComp.calcTotalBoundBox();
        size = { x: boundBox.size.x, y: boundBox.size.y, z: boundBox.size.z };
        __urlToBoundSize.set(asset.file_url, size);
      }
      const maxExtent = Math.max(size.x, size.y, size.z);
      const normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0;
      const scaleMultiplier =
        asset.config && asset.config.scale_multiplier
          ? asset.config.scale_multiplier
          : 1.0;
      const finalScale = normalizeScale * scaleMultiplier;
      transform.scale.setValue(finalScale, finalScale, finalScale);

      // 检查模型是否含有内置动画（GLTF/GLB 均支持）
      const animator = gltfEl.getComponent(xr.Animator);
      const hasAnimation =
        animator && animator._clips && animator._clips.size > 0;

      if (hasAnimation) {
        // 循环播放所有动画片段（不传 loop 选项默认无限循环）
        animator._clips.forEach((_, clipName) => {
          try {
            animator.play(clipName);
          } catch (e) {
            console.warn(`[model] 播放动画片段失败: "${clipName}"`, e);
          }
        });
      }

      const entry = this._registerNode(asset.id, rootNode, null, {
        type: "model",
      });
      // 无内置动画时才叠加上下跳动 + 水平旋转效果
      if (!hasAnimation && entry) {
        entry.modelAnim = {
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
   * 每帧驱动：为普通 model 节点添加上下小幅跳动 + 缓慢旋转。
   * 巨型模型（_hugeNodeList）不受影响。
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
      trs.position.y = anim.baseY + Math.sin(anim.bobPhase) * anim.bobAmplitude;

      // 水平旋转：绕 Y 轴累加角度
      anim.rotateAngle += anim.rotateSpeed * dt;
      const half = anim.rotateAngle * 0.5;
      trs.quaternion.setValue(0, Math.sin(half), 0, Math.cos(half));
    }
  },
};

/** 模型素材：加载 GLTF/GLB，normalize 包围盒到 1m，无内置动画时叠加跳动+旋转 */
module.exports = {
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
      console.log(`[model] 开始加载 assetId=${assetId} url=${asset.file_url}`);
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

      // 计算模型包围盒，将最长边 normalize 到 1m
      const boundBox = gltfComp.calcTotalBoundBox();
      const size = boundBox.size;
      const maxExtent = Math.max(size.x, size.y, size.z);
      const normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0;
      const scaleMultiplier =
        asset.config && asset.config.scale_multiplier
          ? asset.config.scale_multiplier
          : 1.0;
      const finalScale = normalizeScale * scaleMultiplier;
      transform.scale.setValue(finalScale, finalScale, finalScale);
      console.log(
        `[model] 包围盒 size=${size.x.toFixed(3)}x${size.y.toFixed(3)}x${size.z.toFixed(3)} maxExtent=${maxExtent.toFixed(3)} normalizeScale=${normalizeScale.toFixed(4)} scaleMultiplier=${scaleMultiplier} finalScale=${finalScale.toFixed(4)}`,
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

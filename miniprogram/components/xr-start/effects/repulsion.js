/**
 * 通用斥力模块：nodeList 中所有已落位的素材节点之间互相排斥。
 * 覆盖所有素材类型（text / model / image / audio / video / danmaku）。
 * 跳过仍在飞行动画中的弹幕节点，避免干扰飞入动画。
 *
 * 参数（均来自 XR_CONFIG）：
 *   repulsionRadius   — 斥力开始生效的距离（米）
 *   repulsionStrength — 每帧最大位移量
 */
module.exports = function (XR_CONFIG) {
  return {
    tickRepulsion() {
      const xr = wx.getXrFrameSystem();
      if (!this.nodeList || this.nodeList.length < 2) return;

      const REPULSION_RADIUS = XR_CONFIG.repulsionRadius || 1.5;
      const REPULSION_STRENGTH = XR_CONFIG.repulsionStrength || 0.008;
      const MIN_DIST = 0.001; // 防止除零

      // 跳过仍在飞行动画中的节点（目前仅弹幕有飞行阶段）
      const flyingSet = new Set((this.flyingDanmakus || []).map((d) => d.node));

      const settled = [];
      for (const entry of this.nodeList) {
        const node = entry.node;
        if (!node || flyingSet.has(node)) continue;
        const trs = node.getComponent(xr.Transform);
        if (!trs) continue;
        settled.push({
          trs,
          x: trs.position.x,
          y: trs.position.y,
          z: trs.position.z,
        });
      }

      if (settled.length < 2) return;

      // 先累加每个节点受到的合力位移，再统一应用，避免顺序偏差
      const offsets = settled.map(() => ({ x: 0, y: 0, z: 0 }));
      const RADIUS_SQ = REPULSION_RADIUS * REPULSION_RADIUS;

      for (let i = 0; i < settled.length; i++) {
        const a = settled[i];
        for (let j = i + 1; j < settled.length; j++) {
          const b = settled[j];
          const dx = a.x - b.x;
          // AABB 单轴早剔除：单个坐标差已超半径则不可能在球内，省掉后续乘法和 sqrt
          if (dx > REPULSION_RADIUS || dx < -REPULSION_RADIUS) continue;
          const dy = a.y - b.y;
          if (dy > REPULSION_RADIUS || dy < -REPULSION_RADIUS) continue;
          const dz = a.z - b.z;
          if (dz > REPULSION_RADIUS || dz < -REPULSION_RADIUS) continue;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq >= RADIUS_SQ || distSq < MIN_DIST * MIN_DIST) continue;
          const dist = Math.sqrt(distSq);

          // 强度随距离线性衰减
          const force = REPULSION_STRENGTH * (1 - dist / REPULSION_RADIUS);
          const inv = 1 / dist;
          const nx = dx * inv;
          const ny = dy * inv;
          const nz = dz * inv;

          offsets[i].x += nx * force;
          offsets[i].y += ny * force;
          offsets[i].z += nz * force;
          offsets[j].x -= nx * force;
          offsets[j].y -= ny * force;
          offsets[j].z -= nz * force;
        }
      }

      // 应用位移
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        const o = offsets[i];
        s.trs.position.setValue(s.x + o.x, s.y + o.y, s.z + o.z);
      }
    },
  };
};

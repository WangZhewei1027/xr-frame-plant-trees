/**
 * 通用斥力模块：nodeList 中所有已落位的素材节点之间互相排斥。
 * 覆盖所有素材类型（text / model / image / audio / video / danmaku）。
 * 跳过仍在飞行动画中的弹幕节点，避免干扰飞入动画。
 *
 * 性能约定（每帧路径，禁止分配）：
 *   - Transform 用 _registerNode 时缓存的 entry.trs，不做每帧 getComponent。
 *   - settled/offsets 使用挂在组件实例上的扁平 scratch 数组（Float 槽位复用），
 *     每帧零对象分配，避免小程序 GC 抖动。
 *
 * 参数（均来自 XR_CONFIG）：
 *   repulsionRadius   — 斥力开始生效的距离（米）
 *   repulsionStrength — 每帧最大位移量
 */
module.exports = function (XR_CONFIG) {
  return {
    tickRepulsion() {
      const nodeList = this.nodeList;
      if (!nodeList || nodeList.length < 2) return;

      const REPULSION_RADIUS = XR_CONFIG.repulsionRadius || 1.5;
      const REPULSION_STRENGTH = XR_CONFIG.repulsionStrength || 0.008;
      const MIN_DIST_SQ = 0.001 * 0.001; // 防止除零
      const RADIUS_SQ = REPULSION_RADIUS * REPULSION_RADIUS;

      // scratch 缓冲：trs 引用数组 + 扁平坐标/合力数组（x,y,z 连续存放），跨帧复用
      let trsArr = this._repTrs;
      let posArr = this._repPos;
      let offArr = this._repOff;
      if (!trsArr) {
        trsArr = this._repTrs = [];
        posArr = this._repPos = [];
        offArr = this._repOff = [];
      }

      // 飞行中的弹幕节点跳过（通常为空，为空时不做任何集合构建）
      const flying = this.flyingDanmakus;
      const hasFlying = flying && flying.length > 0;

      let n = 0;
      for (let k = 0; k < nodeList.length; k++) {
        const entry = nodeList[k];
        const trs = entry.trs;
        if (!trs) continue;
        if (hasFlying) {
          let isFlying = false;
          for (let f = 0; f < flying.length; f++) {
            if (flying[f].node === entry.node) {
              isFlying = true;
              break;
            }
          }
          if (isFlying) continue;
        }
        const p = trs.position;
        const base = n * 3;
        trsArr[n] = trs;
        posArr[base] = p.x;
        posArr[base + 1] = p.y;
        posArr[base + 2] = p.z;
        offArr[base] = 0;
        offArr[base + 1] = 0;
        offArr[base + 2] = 0;
        n++;
      }
      if (n < 2) return;

      for (let i = 0; i < n; i++) {
        const ib = i * 3;
        const ax = posArr[ib];
        const ay = posArr[ib + 1];
        const az = posArr[ib + 2];
        for (let j = i + 1; j < n; j++) {
          const jb = j * 3;
          const dx = ax - posArr[jb];
          // AABB 单轴早剔除：单个坐标差已超半径则不可能在球内，省掉后续乘法和 sqrt
          if (dx > REPULSION_RADIUS || dx < -REPULSION_RADIUS) continue;
          const dy = ay - posArr[jb + 1];
          if (dy > REPULSION_RADIUS || dy < -REPULSION_RADIUS) continue;
          const dz = az - posArr[jb + 2];
          if (dz > REPULSION_RADIUS || dz < -REPULSION_RADIUS) continue;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq >= RADIUS_SQ || distSq < MIN_DIST_SQ) continue;
          const dist = Math.sqrt(distSq);

          // 强度随距离线性衰减
          const force = REPULSION_STRENGTH * (1 - dist / REPULSION_RADIUS);
          const s = force / dist;
          const fx = dx * s;
          const fy = dy * s;
          const fz = dz * s;

          offArr[ib] += fx;
          offArr[ib + 1] += fy;
          offArr[ib + 2] += fz;
          offArr[jb] -= fx;
          offArr[jb + 1] -= fy;
          offArr[jb + 2] -= fz;
        }
      }

      // 应用位移（合力为零的节点跳过 setValue）
      for (let i = 0; i < n; i++) {
        const ib = i * 3;
        const ox = offArr[ib];
        const oy = offArr[ib + 1];
        const oz = offArr[ib + 2];
        if (ox === 0 && oy === 0 && oz === 0) continue;
        trsArr[i].position.setValue(
          posArr[ib] + ox,
          posArr[ib + 1] + oy,
          posArr[ib + 2] + oz,
        );
      }

      // 防止 trs 引用滞留：截断到本帧实际数量（posArr/offArr 是数字，无需清理）
      trsArr.length = n;
    },
  };
};

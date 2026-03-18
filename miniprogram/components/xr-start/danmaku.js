/** 弹幕飞行动画：从相机后下方飞到正前方 */
module.exports = function (XR_CONFIG) {
  return {
    showDanmakuInXR(text) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const camPos = camTransform.position;
      const wm = camTransform.worldMatrix;

      const localForward = xr.Vector3.createFromNumber(0, 0, 1);
      const localDown = xr.Vector3.createFromNumber(0, -1, 0);
      const worldForward = wm.transformDirection(localForward);
      const worldDown = wm.transformDirection(localDown);

      // 起点：相机后下方 (后 0.3m, 下 0.4m)
      const sx = camPos.x - worldForward.x * 0.3 + worldDown.x * 0.4;
      const sy = camPos.y - worldForward.y * 0.3 + worldDown.y * 0.4;
      const sz = camPos.z - worldForward.z * 0.3 + worldDown.z * 0.4;

      // 终点：相机正前方 1.5m
      const ex = camPos.x + worldForward.x * 1.5;
      const ey = camPos.y + worldForward.y * 1.5;
      const ez = camPos.z + worldForward.z * 1.5;

      if (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
        this.removeOldestNode();
      }

      const rootNode = scene.createElement(xr.XRNode, {
        id: `danmaku-${this.nodeIdCounter++}`,
        position: `${sx} ${sy} ${sz}`,
        scale: "0.02 0.02 0.02",
      });
      this.shadowRoot.addChild(rootNode);

      const textEl = scene.createElement(xr.XRText, {
        position: "0 0 0",
        value: text,
        size: "2.5",
        anchor: "0.5 0.5",
        "never-cull": "",
        uniforms: "u_baseColorFactor:1.0 1.0 1.0 1",
      });
      rootNode.addChild(textEl);
      // assetId = null 表示弹幕节点，不参与远程素材的 diff 对比
      this._registerNode(null, rootNode, textEl);

      this.flyingDanmakus.push({
        node: rootNode,
        textEl,
        startPos: { x: sx, y: sy, z: sz },
        endPos: { x: ex, y: ey, z: ez },
        startTime: Date.now(),
        duration: 600,
        finalScale: 0.15,
        arrived: false,
      });
    },

    /** 每帧驱动：插值飞行弹幕位置，到达后触发粒子爆发 */
    tickFlyingDanmakus() {
      if (!this.flyingDanmakus || this.flyingDanmakus.length === 0) return;
      const xr = wx.getXrFrameSystem();
      const now = Date.now();
      const finished = [];

      for (let i = 0; i < this.flyingDanmakus.length; i++) {
        const d = this.flyingDanmakus[i];
        const elapsed = now - d.startTime;
        let t = Math.min(elapsed / d.duration, 1);
        const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

        const trs = d.node.getComponent(xr.Transform);
        if (!trs) {
          finished.push(i);
          continue;
        }

        const px = d.startPos.x + (d.endPos.x - d.startPos.x) * ease;
        const py = d.startPos.y + (d.endPos.y - d.startPos.y) * ease;
        const pz = d.startPos.z + (d.endPos.z - d.startPos.z) * ease;
        trs.position.setValue(px, py, pz);

        const s = 0.02 + (d.finalScale - 0.02) * ease;
        trs.scale.setValue(s, s, s);

        if (t >= 1 && !d.arrived) {
          d.arrived = true;
          finished.push(i);
          this.burstParticleAt(d.node);
        }
      }

      for (let i = finished.length - 1; i >= 0; i--) {
        this.flyingDanmakus.splice(finished[i], 1);
      }
    },

    /**
     * 每帧驱动：已落位的 text node 之间互相排斥，像磁铁同极相斥。
     * 只对不在飞行中的节点施加斥力，避免干扰飞入动画。
     */
    tickRepulsion() {
      const xr = wx.getXrFrameSystem();
      if (!this.nodeList || this.nodeList.length < 2) return;

      // ── 可调参数 ──────────────────────────────────
      const REPULSION_RADIUS = 0.8; // 斥力作用半径 (米)
      const REPULSION_STRENGTH = 0.003; // 每帧最大位移量
      const MIN_DIST = 0.001; // 防止除零

      // 收集已落位节点（不在飞行列表中）
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

      // 计算每个节点受到的斥力位移（先累加再应用，避免顺序偏差）
      const offsets = settled.map(() => ({ x: 0, y: 0, z: 0 }));

      for (let i = 0; i < settled.length; i++) {
        for (let j = i + 1; j < settled.length; j++) {
          const a = settled[i];
          const b = settled[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          if (dist >= REPULSION_RADIUS || dist < MIN_DIST) continue;

          // 强度随距离线性衰减
          const force = REPULSION_STRENGTH * (1 - dist / REPULSION_RADIUS);
          const nx = dx / dist;
          const ny = dy / dist;
          const nz = dz / dist;

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

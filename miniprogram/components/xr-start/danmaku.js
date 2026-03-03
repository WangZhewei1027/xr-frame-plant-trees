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
      this.nodeList.push(rootNode);

      const textEl = scene.createElement(xr.XRText, {
        position: "0 0 0",
        value: text,
        size: "2.5",
        anchor: "0.5 0.5",
        "never-cull": "",
        uniforms: "u_baseColorFactor:1.0 1.0 1.0 1",
      });
      rootNode.addChild(textEl);
      this.textList.push(textEl);

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
  };
};

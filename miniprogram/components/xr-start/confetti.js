/**
 * 随机彩带模块：定期在摄像机前方随机位置爆发 confetti 粒子。
 * - 通过 _confettiBursts 列表跟踪所有进行中的爆发
 * - 上限 MAX_ACTIVE_BURSTS，超出时驱逐最旧的
 * - 每个爆发结束后自动清理节点和列表条目
 */
module.exports = function (XR_CONFIG) {
  const MIN_INTERVAL_MS = 3000;
  const MAX_INTERVAL_MS = 7000;
  const MAX_ACTIVE_BURSTS = 2;
  const BURST_LIFETIME_MS = 7000;
  const FORWARD_MIN = 1.5;
  const FORWARD_MAX = 3.0;
  const SIDE_RANGE = 0.6; // 节点位置左右随机（在节点周围，Box 本身会再在水平面上撒开）
  const HEIGHT_MIN = 1.5; // 摄像机上方 (+Y 为上)
  const HEIGHT_MAX = 2.2;

  return {
    /** 启动随机彩带循环 */
    startRandomConfetti() {
      if (this._confettiTimer) {
        console.log("[confetti] already started, skip");
        return;
      }
      this._confettiBursts = this._confettiBursts || [];
      console.log("[confetti] startRandomConfetti", {
        hasScene: !!this.scene,
        hasShadowRoot: !!this.shadowRoot,
        hasGetCamTransform: typeof this.getCamTransform === "function",
      });
      // 立刻先生成一发，便于调试
      this._spawnRandomConfetti();
      this._scheduleNextConfetti();
    },

    /** 停止循环并清理所有进行中的爆发 */
    stopRandomConfetti() {
      if (this._confettiTimer) {
        clearTimeout(this._confettiTimer);
        this._confettiTimer = null;
      }
      this._cleanupAllConfetti();
    },

    _scheduleNextConfetti() {
      const delay =
        MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
      this._confettiTimer = setTimeout(() => {
        this._confettiTimer = null;
        this._spawnRandomConfetti();
        this._scheduleNextConfetti();
      }, delay);
    },

    _spawnRandomConfetti() {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform || !this.shadowRoot) {
        console.warn("[confetti] spawn skipped:", {
          hasScene: !!scene,
          hasCamTransform: !!camTransform,
          hasShadowRoot: !!this.shadowRoot,
        });
        return;
      }

      // 超出上限时驱逐最旧爆发
      while (this._confettiBursts.length >= MAX_ACTIVE_BURSTS) {
        const oldest = this._confettiBursts.shift();
        if (oldest) this._destroyConfettiBurst(oldest);
      }

      // 在摄像机前上方生成：forward 使用在水平面上的投影，避免抬头/低头时彩带在背后
      const camPos = camTransform.position;
      const wm = camTransform.worldMatrix;
      // 注意：XR-Frame 中摄像机的 forward 实际为 +Z 方向（部分版本与 OpenGL 约定相反）
      const camForward = wm.transformDirection(
        xr.Vector3.createFromNumber(0, 0, 1),
      );
      // 水平投影后归一化（去掉 y 分量）
      let fx = camForward.x;
      let fz = camForward.z;
      const flen = Math.sqrt(fx * fx + fz * fz) || 1;
      fx /= flen;
      fz /= flen;
      // 水平右向（世界上轴 × forward）
      const rx = fz;
      const rz = -fx;

      const forwardDist =
        FORWARD_MIN + Math.random() * (FORWARD_MAX - FORWARD_MIN);
      const sideOff = (Math.random() - 0.5) * 2 * SIDE_RANGE;
      const heightOff = HEIGHT_MIN + Math.random() * (HEIGHT_MAX - HEIGHT_MIN);

      const x = camPos.x + fx * forwardDist + rx * sideOff;
      const y = camPos.y + heightOff;
      const z = camPos.z + fz * forwardDist + rz * sideOff;

      const burstNode = scene.createElement(xr.XRNode, {
        id: `confetti-burst-${this._confettiCounter++ || 0}`,
      });
      this.shadowRoot.addChild(burstNode);
      const trs = burstNode.getComponent(xr.Transform);
      trs.position.x = x;
      trs.position.y = y;
      trs.position.z = z;

      console.log("[confetti] spawn", {
        camPos: {
          x: +camPos.x.toFixed(2),
          y: +camPos.y.toFixed(2),
          z: +camPos.z.toFixed(2),
        },
        camForward: {
          x: +camForward.x.toFixed(2),
          y: +camForward.y.toFixed(2),
          z: +camForward.z.toFixed(2),
        },
        horizForward: { fx: +fx.toFixed(2), fz: +fz.toFixed(2) },
        offsets: {
          forwardDist: +forwardDist.toFixed(2),
          sideOff: +sideOff.toFixed(2),
          heightOff: +heightOff.toFixed(2),
        },
        spawn: { x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) },
        active: this._confettiBursts.length + 1,
      });

      const particleEl = scene.createElement(xr.XRParticle, {
        position: "0 0 0",
        capacity: "16",
        "emit-rate": "0",
        "burst-count": "6",
        "burst-time": "0",
        "burst-cycle": "1",
        // 初速接近 0，主要依赖重力下落
        speed: "0 0.15",
        size: "0.5 0.9",
        "start-rotation": "0 360",
        "rotate-speed": "-60 60",
        "life-time": "4.0 6.0",
        "start-color": "1 1 1 1",
        "end-color": "1 1 1 0",
        // 重力是标量（y轴向下的每秒位移），正值=向下落
        gravity: "0.6",
        "emitter-type": "BoxShape",
        // direction 默认为 (0,1,0) 会让粒子向上喷，改为接近零使其靠重力下落
        // minEmitBox/maxEmitBox 在水平面上撒开，粒子位置在此范围内随机
        "emitter-props":
          "minEmitBox:-2.5 -0.1 -2.5,maxEmitBox:2.5 0.1 2.5,direction:-0.05 -0.1 -0.05,direction2:0.05 -0.05 0.05",
        texture: "particle-confetti",
        "never-cull": "",
        "stop-duration": "6.0",
      });
      burstNode.addChild(particleEl);

      try {
        const ps = particleEl.getComponent(xr.Particle);
        if (ps) {
          ps.addSizeGradient(0, 1, 1);
          ps.addSizeGradient(1, 1, 1);
          ps.addAlphaGradient(0, 0, 0);
          ps.addAlphaGradient(0.08, 1, 1);
          ps.addAlphaGradient(0.7, 1, 1);
          ps.addAlphaGradient(1, 0, 0);
          console.log("[confetti] particle component ready");
        } else {
          console.warn("[confetti] xr.Particle component NOT found on element");
        }
      } catch (e) {
        console.warn("[confetti] particle gradient setup failed", e);
      }

      const timerId = setTimeout(() => {
        const idx = this._confettiBursts.findIndex(
          (b) => b.timerId === timerId,
        );
        if (idx !== -1) {
          this._destroyConfettiBurst(this._confettiBursts[idx]);
          this._confettiBursts.splice(idx, 1);
        }
      }, BURST_LIFETIME_MS);

      this._confettiBursts.push({ node: burstNode, timerId });
    },

    _destroyConfettiBurst(entry) {
      if (!entry) return;
      if (entry.timerId) {
        clearTimeout(entry.timerId);
      }
      try {
        this.shadowRoot.removeChild(entry.node);
      } catch (_) {}
    },

    _cleanupAllConfetti() {
      if (!this._confettiBursts) return;
      for (const entry of this._confettiBursts) {
        this._destroyConfettiBurst(entry);
      }
      this._confettiBursts = [];
    },
  };
};

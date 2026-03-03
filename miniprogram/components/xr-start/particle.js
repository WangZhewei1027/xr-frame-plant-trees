/** 粒子爆发效果 */
module.exports = {
  burstParticleAt(parentNode) {
    const xr = wx.getXrFrameSystem();
    const scene = this.scene;
    if (!scene) return;

    const particleNode = scene.createElement(xr.XRNode, {
      position: "0 0 0",
    });
    parentNode.addChild(particleNode);

    const particleEl = scene.createElement(xr.XRParticle, {
      position: "0 0 0",
      capacity: "200",
      "emit-rate": "0",
      "burst-count": "120",
      "burst-time": "0",
      "burst-cycle": "1",
      speed: "3 6",
      size: "0.3 0.6",
      "life-time": "0.6 1.2",
      "start-color": "0.3 0.8 1 1",
      "end-color": "1 0.5 0.9 0",
      "emitter-type": "SphereShape",
      "emitter-props": "radius:1.5",
      texture: "particle-point",
      "never-cull": "",
      "stop-duration": "1.5",
    });
    particleNode.addChild(particleEl);

    try {
      const ps = particleEl.getComponent(xr.Particle);
      if (ps) {
        ps.addSizeGradient(0, 1, 1);
        ps.addSizeGradient(1, 0, 0);
        ps.addAlphaGradient(0, 0, 0);
        ps.addAlphaGradient(0.15, 1, 1);
        ps.addAlphaGradient(1, 0, 0);
      }
    } catch (e) {}

    const timerId = setTimeout(() => {
      const idx = this.particleTimers.indexOf(timerId);
      if (idx !== -1) this.particleTimers.splice(idx, 1);
      try {
        parentNode.removeChild(particleNode);
      } catch (e) {}
    }, 2000);
    this.particleTimers.push(timerId);
  },
};

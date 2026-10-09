const { THREE } = require("../../../lib/three-runtime/runtime");
const { disposeTree } = require("../../../lib/three-runtime/resources");
module.exports = () => ({
  startRandomConfetti() {
    if (
      this._confettiTimer ||
      !this._arReady ||
      this._retrievalPaused ||
      this.retrievalMode === "anchor"
    )
      return;
    this._spawnRandomConfetti();
    this._scheduleNextConfetti();
  },
  _scheduleNextConfetti() {
    this._confettiTimer = setTimeout(
      () => {
        this._confettiTimer = null;
        if (
          this._disposed ||
          this._retrievalPaused ||
          !this._arReady ||
          this.retrievalMode === "anchor" ||
          !this._confettiEnabled
        )
          return;
        this._spawnRandomConfetti();
        this._scheduleNextConfetti();
      },
      3000 + Math.random() * 4000,
    );
  },
  _spawnRandomConfetti() {
    if (!this._arReady) return;
    while (this._confettiBursts.length >= 2)
      this._destroyConfettiBurst(this._confettiBursts.shift());
    const root = new THREE.Group(),
      camera = this._runtime.camera;
    const center = this._calcForwardPos("text");
    root.position.set(center.x, camera.position.y + 1.8, center.z);
    const particles = [];
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.08, 0.2),
        new THREE.MeshBasicMaterial({
          color: [0xffce30, 0xf171ce, 0x48cfae, 0xa5a0ff][i % 4],
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
        }),
      );
      mesh.position.set(
        (Math.random() - 0.5) * 3,
        Math.random() * 0.4,
        (Math.random() - 0.5) * 3,
      );
      mesh.rotation.set(
        Math.random() * 3,
        Math.random() * 3,
        Math.random() * 3,
      );
      root.add(mesh);
      particles.push({
        mesh,
        vx: (Math.random() - 0.5) * 0.15,
        vz: (Math.random() - 0.5) * 0.15,
      });
    }
    this._runtime.scene.add(root);
    this._confettiBursts.push({ node: root, particles, age: 0 });
  },
  tickConfetti() {
    this._confettiBursts = this._confettiBursts.filter((burst) => {
      burst.age += this._frameDelta || 0;
      if (burst.age >= 7) {
        this._destroyConfettiBurst(burst);
        return false;
      }
      for (const p of burst.particles) {
        const dt = this._frameDelta || 0;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.z += p.vz * dt;
        p.mesh.position.y -= 0.6 * dt;
        p.mesh.rotation.x += dt;
        p.mesh.rotation.z += dt * 0.7;
        p.mesh.material.opacity = Math.min(
          1,
          burst.age * 4,
          (7 - burst.age) / 2,
        );
      }
      return true;
    });
  },
  _destroyConfettiBurst(entry) {
    entry?.node.removeFromParent();
    disposeTree(entry?.node);
  },
  stopRandomConfetti() {
    clearTimeout(this._confettiTimer);
    this._confettiTimer = null;
    for (const burst of this._confettiBursts || [])
      this._destroyConfettiBurst(burst);
    this._confettiBursts = [];
  },
});

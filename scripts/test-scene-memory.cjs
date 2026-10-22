// Run with --expose-gc. Checks actual reachability, not just a dispose counter.
const assert = require('node:assert/strict');
const { createSceneCore } = require('../miniprogram/lib/scene-runtime/vendor/scene-core');
const { THREE, createFixtureGLB } = require('../miniprogram/labs/xr-three/runtime');
const { ModelCache } = require('../miniprogram/lib/three-runtime/resources');
const { createCompositionPlayer } = require('../miniprogram/lib/scene-runtime/composition');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function collect() {
  // Drain zero-delay library callbacks before checking reachability.
  await new Promise(resolve => setTimeout(resolve, 5));
  for (let n = 0; n < 4; n++) { await turn(); global.gc(); }
  await turn();
}
function content(seed) {
  const instances = Array.from({ length: 8 }, (_, i) => ({ id: `object${i}`, asset: 'model', position: [i, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: { clipIndex: 0, startSeconds: 1, loop: true },
    tracks: { 'position.x': Array.from({ length: 150 }, (_, k) => ({ time: k / 15, value: Math.sin(k + seed), handles: [.5, 1, .5, 0], connectedRight: true })) } }));
  return { kind: 'composition', units: 'meters', durationSeconds: 10, loop: true, assets: { model: { assetId: 'model' } }, instances };
}
async function main() {
  assert.equal(typeof global.gc, 'function', 'Use node --expose-gc scripts/test-scene-memory.cjs');
  const references = [];
  const samples = [];
  async function cycle(i) {
    const data = content(i);
    const runtime = await createSceneCore({ content: data });
    const root = new THREE.Group();
    const stop = runtime.bind('object0', root);
    void runtime.play(true); runtime.advance(3); runtime.pause();
    references.push(new WeakRef(data), new WeakRef(runtime), new WeakRef(root));
    stop(); runtime.dispose();
  }
  for (let i = 0; i < 220; i++) {
    await cycle(i);
    if (i % 20 === 19) { await collect(); samples.push({ cycles: i + 1, heapMiB: +(process.memoryUsage().heapUsed / 2 ** 20).toFixed(2) }); }
  }
  await collect();
  const retained = references.filter(ref => ref.deref()).length;
  console.log(JSON.stringify({ phase: 'core', cycles: 220, instancesPerScene: 8, keyframesPerScene: 1200, retainedObjects: retained, samples }));
  assert.equal(retained, 0, 'Disposed scene states, players and roots must be garbage-collectible');
  assert.ok(samples.at(-1).heapMiB - samples[1].heapMiB < 8, 'Retained heap must plateau after warm-up');

  const gltf = await new Promise((resolve, reject) => new THREE.GLTFLoader().parse(createFixtureGLB(), '', resolve, reject));
  const cache = new ModelCache(null, 8, async () => gltf);
  const players = [];
  async function playerCycle(i) {
    const manifest = { schemaVersion: 4, assetId: `scene${i}`, resources: { model: { url: 'fixture.glb' } }, content: content(i) };
    const player = createCompositionPlayer(manifest, { modelCache: cache });
    await player.load(); assert.equal(player.state, 'ready');
    players.push(new WeakRef(player), new WeakRef(manifest.content), new WeakRef(player.instances[0].object));
    player.play(); player.update(3); player.pause(); player.play(); player.update(11); player.restart();
    player.dispose(); assert.equal(player.root.children.length, 0);
    assert.ok([...cache.items.values()].every(entry => entry.refs === 0));
  }
  for (let i = 0; i < 120; i++) await playerCycle(i);
  cache.dispose(); await collect();
  console.log(JSON.stringify({ phase: 'composition', cycles: 120, retainedIndices: players.flatMap((ref, i) => ref.deref() ? [i] : []) }));
  assert.equal(players.filter(ref => ref.deref()).length, 0, 'Disposed composition, native state and GLB clones must be collectible');
  assert.equal(cache.items.size, 0);
  console.log('PASS 120 real GLB composition load/play/pause/restart/dispose cycles; no retained players, scene data, clones or cache references');
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });

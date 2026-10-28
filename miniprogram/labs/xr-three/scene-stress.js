const { visualProbe } = require('./scene-visual-probe');
const { createCompositionPlayer } = require('../../lib/scene-runtime/composition');

// Development-only GPU/resource soak; uses the same loader and player as AR.
async function stressScene({ manifest, cache, scene, renderer, camera, canvas, cancelled, progress, cycles = 100 }) {
  const samples = [];
  for (let i = 0; i < cycles; i++) {
    if (cancelled()) throw new Error('循环验收已取消');
    const player = createCompositionPlayer(JSON.parse(JSON.stringify(manifest)), { modelCache: cache, canvas });
    try {
      await player.load();
      if (cancelled()) throw new Error('循环验收已取消');
      if (player.state !== 'ready') throw new Error(player.diagnostics?.message || '场景加载失败');
      scene.add(player.root);
      player.play(); player.update(1.25); player.pause();
      const paused = player.time; player.update(0.5);
      if (player.time !== paused) throw new Error('暂停时仍推进');
      player.play(); player.update(0.75); player.restart(); player.update(0.5);
      const probe = visualProbe(manifest);
      player.pause(); player.seek(probe.time);
      renderer.render(scene, camera);
      if (probe.visual && !renderer.info.render.triangles) throw new Error('没有渲染模型');
    } finally {
      scene.remove(player.root); player.dispose();
      // Flush Three's previous render list so it cannot retain the last clones.
      if (!cancelled()) renderer.render(scene, camera);
    }
    if (player.root.children.length || [...cache.items.values()].some(entry => entry.refs !== 0)) throw new Error('退出后仍有模型引用');
    const sample = { cycle: i + 1, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs.length, cacheEntries: cache.items.size };
    if (i === 0 || i % 10 === 9) samples.push(sample);
    const baseline = samples[0];
    if (sample.geometries > baseline.geometries || sample.textures > baseline.textures || sample.programs > baseline.programs || sample.cacheEntries > baseline.cacheEntries) throw new Error(`GPU/缓存资源持续增长：${JSON.stringify(sample)}`);
    progress(i + 1);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { cycles, samples };
}
module.exports = { stressScene };

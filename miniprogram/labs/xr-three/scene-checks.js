// Deterministic checks against a loaded, real mini-program composition player.
// No alternate renderer, animation evaluator or fake model cache is used here.
function verifyScenePlayer(player, manifest, cache) {
  const checks = [];
  const assert = (condition, name) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const near = (a, b) => Math.abs(a - b) < 0.0001;
  assert(player.state === "ready", "模型全部加载完成");
  assert(player.instances.length > 0 && player.instances.length === manifest.content.instances.length, "实例数量与 Web 保存一致");
  const objects = player.instances.map((item) => item.object);
  assert(new Set(objects).size === objects.length, "每个实例使用独立模型副本");
  for (const entry of player.instances) {
    assert(entry.instanceRoot.position.toArray().every(Number.isFinite), `${entry.id}：变换有效`);
    if (entry.inst.animation) assert(!!entry.action, `${entry.id}：GLB 动画片段可用`);
  }
  player.play();
  const step = Math.min(0.25, (player.duration || 1) / 4);
  player.update(step);
  assert(near(player.time, step), "播放推进时间");
  player.pause();
  const paused = player.time;
  player.update(0.5);
  assert(player.state === "paused" && near(player.time, paused), "暂停保持时间");
  player.play();
  player.update(step);
  assert(near(player.time, paused + step), "继续播放不跳帧");
  // Check exact saved keyframes (not a second copy of the curve evaluator).
  for (const entry of player.instances) {
    for (const [path, frames] of Object.entries(entry.inst.tracks || {})) {
      const [group, axis] = path.split(".");
      for (const frame of frames) {
        if (frame.time > player.duration || (manifest.content.loop && frame.time === player.duration)) continue;
        player.restart();
        player.update(frame.time);
        assert(near(entry.instanceRoot[group][axis], frame.value), `${entry.id} ${group}.${axis} @${frame.time}s 与保存值一致`);
      }
    }
    if (entry.action && entry.inst.animation.startSeconds > 0) {
      player.restart();
      player.update(Math.min(entry.inst.animation.startSeconds / 2, step));
      assert(near(entry.action.time, 0), `${entry.id}：延迟开始前保持首帧`);
    }
  }
  if (player.duration) {
    player.restart();
    player.update(player.duration + step);
    assert(manifest.content.loop
      ? player.state === "playing" && near(player.time, step)
      : player.state === "ended" && near(player.time, player.duration), "整场结束／循环正确");
  }
  player.restart();
  assert(player.state === "playing" && player.time === 0, "重播回到起点");
  player.dispose();
  assert(player.state === "disposed" && player.root.children.length === 0, "整场退出清空节点");
  assert([...cache.items.values()].every((item) => item.refs === 0), "模型引用全部释放");
  return checks;
}
module.exports = { verifyScenePlayer };

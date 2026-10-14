const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const { THREE, createFixtureGLB } = require(path.join(root, "labs/xr-three/runtime"));
const { ModelCache } = require(path.join(root, "lib/three-runtime/resources"));
const { createCompositionPlayer } = require(path.join(root, "lib/scene-runtime/composition"));
const { verifyScenePlayer } = require(path.join(root, "labs/xr-three/scene-checks"));

async function main() {
  const gltf = await new Promise((resolve, reject) => new THREE.GLTFLoader().parse(createFixtureGLB(), "", resolve, reject));
  const manifest = { schemaVersion: 2, assetId: "test", resources: { model: { url: "fixture.glb" } }, content: {
    kind: "composition", units: "meters", durationSeconds: 6, loop: false, assets: { model: { assetId: "model" } }, instances: [
      { id: "left", asset: "model", position: [-1,0,0], quaternion: [0,0,0,1], scale: [1,1,1], animation: { clipIndex: 0, startSeconds: 1, loop: false },
        tracks: { "position.x": [{ time: 0, value: -1, handles: [0.5,1,0.5,0], connectedRight: true }, { time: 3, value: 1, handles: [0.5,1,0.5,0], connectedRight: false }] } },
      { id: "right", asset: "model", position: [1,0,0], quaternion: [0,0,0,1], scale: [1,1,1], animation: { clipIndex: 0, startSeconds: 2, loop: true } },
    ],
  } };
  const cache = new ModelCache(null, 8, async () => gltf);
  for (const loop of [false, true]) {
    manifest.content.loop = loop;
    const player = createCompositionPlayer(manifest, { modelCache: cache });
    await player.load();
    const result = verifyScenePlayer(player, manifest, cache);
    assert.ok(result.includes("模型引用全部释放"));
    assert.ok(result.includes("left：延迟开始前保持首帧"));
  }
  const broken = createCompositionPlayer(manifest, { modelCache: cache });
  await broken.load();
  broken.update = () => {};
  assert.throws(() => verifyScenePlayer(broken, manifest, cache), /播放推进时间/);
  broken.dispose(); cache.dispose();
  console.log("PASS preview assertions use real GLB/mixer/clones, detect broken playback, cover delayed clips and looping");

  const code = buildSync({ entryPoints: [path.join(root, "labs/xr-three/scene-preview.js")], bundle: true, format: "cjs", platform: "neutral", write: false }).outputFiles[0].text;
  function makePage(env) {
    let page, requests = 0;
    vm.runInNewContext(code, { module: { exports: {} }, console, setTimeout, clearTimeout, Page: (p) => { page = p; },
      wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }), getStorageSync: () => "", getDeviceInfo: () => ({ platform: "devtools" }), request: () => { requests++; } } });
    const host = { ...page, data: { ...page.data }, setData(values) { Object.assign(this.data, values); } };
    return { host, requests: () => requests };
  }
  for (const env of ["trial", "release"]) {
    const { host, requests } = makePage(env);
    host.createSelectorQuery = () => { throw new Error("Production must not initialize preview GPU"); };
    host.onLoad({}); host.onReady(); await host.loadScene();
    assert.equal(requests(), 0); assert.equal(host.data.enabled, false);
  }
  const { host } = makePage("develop");
  host.onLoad({});
  let disposed = 0, stopped = 0;
  host._player = { root: {}, dispose: () => { disposed++; } };
  host._scene = { remove() {} };
  host._canvas = { cancelAnimationFrame() { stopped++; } };
  host._raf = 123;
  host.onHide();
  assert.equal(disposed, 1); assert.equal(stopped, 1); assert.equal(host._active, false);
  assert.equal(host._player, null); assert.equal(host._generation, 1);
  for (const match of fs.readFileSync(path.join(root, "labs/xr-three/scene-preview.wxml"), "utf8").matchAll(/bind[\w:]+="(\w+)"/g)) {
    assert.equal(typeof host[match[1]], "function", match[1]);
  }
  console.log("PASS release/trial blocked before GPU/network, hide invalidates pending loads and disposes player, WXML handlers exist");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

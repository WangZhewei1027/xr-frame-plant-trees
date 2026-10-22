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
  const manifest = { schemaVersion: 4, assetId: "test", resources: { model: { url: "fixture.glb" } }, content: {
    kind: "composition", units: "meters", durationSeconds: 6, loop: false, assets: { model: { assetId: "model" } }, instances: [
      { id: "left", asset: "model", position: [-1,0,0], rotation: [0, 0, 0], scale: [1,1,1], animation: { clipIndex: 0, startSeconds: 1, loop: false },
      },
      { id: "right", asset: "model", position: [1,0,0], rotation: [0, 0, 0], scale: [1,1,1], animation: { clipIndex: 0, startSeconds: 2, loop: true } },
    ],
  } };
  manifest.content.instances[0].tracks = { 'position.x': [
    { time: 0, value: -1, handles: [.5, 1, .5, 0], connectedRight: true },
    { time: 3, value: 1, handles: [.5, 1, .5, 0], connectedRight: false },
  ] };
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
  function makePage(env, request) {
    let page, requests = 0;
    vm.runInNewContext(code, { module: { exports: {} }, console: { ...console, log() {} }, setTimeout, clearTimeout, Page: (p) => { page = p; },
      wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion: env } }), getStorageSync: () => "", getDeviceInfo: () => ({ platform: "devtools" }), request: (options) => { requests++; request?.(options); } } });
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

  // Drive the actual Page lifecycle and frame callback, not just player.restart().
  // Only the native canvas/GPU and HTTP transport are stand-ins.
  const sceneId = "19100000-0000-4000-8000-000000000004";
  const organizationId = "19100000-0000-4000-8000-000000000002";
  const saved = { ...manifest, assetId: sceneId, content: { ...manifest.content, loop: false } };
  const requests = [];
  const { host: page } = makePage("develop", (options) => requests.push(options));
  page.onLoad({ sceneId, organizationId });
  page._cache = new ModelCache(null, 8, async () => gltf);
  page._scene = new THREE.Scene();
  page._camera = new THREE.PerspectiveCamera();
  page._renderer = { render() {}, dispose() {}, info: { render: { triangles: 1 } } };
  const frames = new Map();
  let nextFrame = 0;
  page._canvas = {
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const tick = (time) => {
    assert.equal(frames.size, 1, "exactly one active frame loop");
    const [id, frame] = frames.entries().next().value;
    frames.delete(id); frame(time);
  };
  const settle = async () => {
    for (let n = 0; n < 50 && !page.data.loaded; n++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.data.loaded, true, page.data.status);
    assert.equal(page._player.state, "playing");
    assert.equal(page._player.time, 0, "entry starts from zero");
  };
  page.onShow();
  const firstLoad = page.loadScene();
  requests.shift().success({ statusCode: 200, data: saved });
  await firstLoad; await settle();
  let frameTime = 20000;
  for (const previousState of ["playing", "paused", "ended"]) {
    tick(frameTime); tick(frameTime += 100);
    assert.ok(Math.abs(page._player.time - 0.1) < 1e-9, "real frame loop advances playback");
    if (previousState === "paused") page.togglePlayback();
    if (previousState === "ended") page._player.update(saved.content.durationSeconds);
    assert.equal(page._player.state, previousState);
    const previous = page._player;
    const staleFrame = frames.values().next().value;
    page.onHide();
    assert.equal(previous.state, "disposed");
    assert.equal(frames.size, 0);
    page.onShow();
    assert.equal(requests.length, 1, "returning must reload the saved scene");
    requests.shift().success({ statusCode: 200, data: saved });
    await settle();
    staleFrame(999999); // A callback already queued by the native canvas may arrive late.
    assert.equal(frames.size, 1, "the old callback cannot start a second frame loop");
    assert.equal(page._player.time, 0, "the old frame timestamp cannot advance the new player");
    tick(10); tick(110); // Native timestamps may restart on a new foreground session.
    assert.ok(Math.abs(page._player.time - 0.1) < 1e-9);
    page._player.restart();
    frameTime = 110;
    page.onShow();
    assert.equal(requests.length, 0, "duplicate show does not reload a playing scene");
    assert.equal(frames.size, 1);
  }
  // Leave while the HTTP request is pending, then return before it completes.
  page.loadScene();
  const oldRequest = requests.shift();
  page.onHide(); page.onShow();
  const newRequest = requests.shift();
  assert.ok(newRequest, "return while loading starts a new request");
  oldRequest.success({ statusCode: 200, data: saved });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page._player, null, "late response from the hidden page cannot mount");
  newRequest.success({ statusCode: 200, data: saved });
  await settle();
  assert.equal(page._scene.children.length, 1, "only the new player mounts");
  // An explicit clear differs from leaving a loaded page.
  page.clearScene(); page.onHide(); page.onShow();
  assert.equal(requests.length, 0, "explicit clear stays empty on return");
  assert.equal(page._player, null);
  page.onUnload();
  assert.equal(frames.size, 0);
  assert.equal(page._cache.items.size, 0);
  page.onShow();
  assert.equal(requests.length, 0, "an unloaded page cannot restart");
  console.log("PASS actual preview hide/show: playing/paused/ended all reload at zero, stale callbacks ignored, unload releases everything");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

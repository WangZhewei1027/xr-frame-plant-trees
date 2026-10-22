// Scene asset regressions using the real Three bundle with native API stand-ins.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");

const near = (actual, expected, message, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${message || "value"}: expected ${expected}, got ${actual}`,
  );
async function until(check, label) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for ${label}`);
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeWx(extra = {}) {
  return {
    env: { USER_DATA_PATH: "/tmp/scene-test" },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getStorageSync: () => "",
    setStorageSync() {},
    getFileSystemManager: () => ({
      unlink() {},
      readFile({ fail }) {
        fail(new Error("no files in test"));
      },
      writeFile({ success }) {
        success();
      },
    }),
    createOffscreenCanvas(options) {
      const canvas = { width: options.width, height: options.height };
      canvas.getContext = () => ({
        font: "",
        measureText: (s) => ({ width: Array.from(s).length * 24 }),
        clearRect() {},
        fillText() {},
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      });
      return canvas;
    },
    showToast() {},
    showModal(options) {
      (this.modals = this.modals || []).push(options);
    },
    ...extra,
  };
}

/** vm module loader in the style of test-ar-runtime.cjs; `overrides` seed stub modules by relative path. */
function makeLoader(wx, overrides = {}) {
  const context = vm.createContext({
    console: { ...console, log() {}, warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    wx,
    Intl,
    Component(value) {
      context.component = value;
    },
    Page(value) {
      context.page = value;
    },
  });
  const modules = new Map();
  for (const [relative, exports] of Object.entries(overrides))
    modules.set(path.resolve(root, relative), { exports });
  function load(file) {
    if (!path.extname(file)) file += fs.existsSync(file + ".js") ? ".js" : ".ts";
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    let code = fs.readFileSync(file, "utf8");
    if (file.endsWith(".ts")) code = transformSync(code, { loader: "ts", format: "cjs" }).code;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(
      (name) => load(path.resolve(path.dirname(file), name)),
      module,
      module.exports,
    );
    return module.exports;
  }
  return { load, lib: (name) => load(path.join(root, "lib", name)), context };
}

// ── fixtures ────────────────────────────────────────────────────────────────
const DANCER = {
  alias: "dancer",
  assetId: "a-dancer",
  url: "https://cdn.test/dancer.glb",
  contentHash: "h1",
  fileType: "model",
  metadata: {},
  animations: [
    { index: 0, name: "move", durationSeconds: 2 },
    { index: 1, name: "spin", durationSeconds: 1 },
  ],
};
const STAGE = {
  alias: "stage",
  assetId: "a-stage",
  url: "https://cdn.test/stage.glb",
  contentHash: "h2",
  fileType: "model",
  metadata: {},
  animations: [],
};
function compositionManifest(o = {}) {
  return {
    schemaVersion: 4,
    assetId: "dance",
    content: {
      kind: "composition",
      units: "meters",
      durationSeconds: o.durationSeconds === undefined ? 8 : o.durationSeconds,
      loop: !!o.loop,
      assets: { dancer: { assetId: "a-dancer" }, stage: { assetId: "a-stage" } },
      instances: o.instances ?? [
        {
          id: "left",
          asset: "dancer",
          position: [-1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          animation: { clipIndex: 0, startSeconds: 0, loop: false },
        },
        {
          id: "right",
          asset: "dancer",
          position: [1, 0, 0],
          rotation: [0, 0, 0],
          scale: [0.8, 0.8, 0.8],
          animation: { clipName: "move", startSeconds: 3, loop: true },
        },
      ],
    },
    resources: { dancer: DANCER, stage: STAGE },
  };
}

/** Fake ModelCache: counts acquire/release, builds a fresh clone-like Group per acquire. */
function fakeCache(THREE, { failing = new Set(), defer = false } = {}) {
  const stats = { acquires: 0, releases: 0, live: 0, pending: [] };
  const moveClip = new THREE.AnimationClip("move", 2, [
    new THREE.VectorKeyframeTrack(".position", [0, 2], [0, 0, 0, 2, 0, 0]),
  ]);
  const spinClip = new THREE.AnimationClip("spin", 1, [
    new THREE.VectorKeyframeTrack(".scale", [0, 1], [1, 1, 1, 1, 1, 1]),
  ]);
  async function acquire(url) {
    stats.acquires++;
    if (defer) await new Promise((resolve) => stats.pending.push(resolve));
    if (failing.has(url))
      throw new Error("模型使用 KHR_draco_mesh_compression，请导出未压缩 GLB 后重试");
    stats.live++;
    const object = new THREE.Group();
    object.userData.sharedModel = true;
    object.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial()));
    let released = false;
    return {
      object,
      animations: [moveClip, spinClip],
      release() {
        if (released) return;
        released = true;
        stats.releases++;
        stats.live--;
      },
    };
  }
  return { stats, acquire, failing, resolvePending: () => stats.pending.splice(0).forEach((r) => r()) };
}

async function main() {
  // QR dispatch caches the Scene target without starting map or location requests.
  {
    const sceneId = "8a5219f1-a635-46f7-9b3e-70d7c02ec63a";
    const organizationId = "512301ab-2679-4350-81e1-520a3ab2afd4";
    let redirected, retried = false;
    const loader = makeLoader(makeWx({
      navigateTo: ({ url }) => { redirected = url; },
      getDeviceInfo: () => ({ platform: "devtools" }),
      getSystemInfoSync: () => ({ windowWidth: 390, windowHeight: 753, pixelRatio: 3 }),
    }));
    const mount = () => ({ ...loader.context.page, data: { ...loader.context.page.data },
      setData(patch) { Object.assign(this.data, patch); } });
    loader.load(path.join(root, "pages/index/index.ts"));
    const index = mount();
    await index.onLoad({ sceneId, organizationId }); index.onShow();
    assert.equal(redirected, `/pages/scene/scene?sceneId=${sceneId}&organizationId=${organizationId}`);
    loader.load(path.join(root, "pages/scene/scene.ts"));
    const invalid = mount(); invalid.onLoad({ sceneId: "invalid", organizationId });
    assert.equal(invalid.data.invalid, true); assert.equal(invalid.data.sceneId, "");
    const page = mount(); page.onLoad({ sceneId, organizationId });
    assert.equal(page.data.sceneId, sceneId); assert.equal(page.data.renderHeight, 1130);
    assert.equal(page.data.height, 753, "Scene canvas fills the page without a footer");
    page.onRenderStatus({ detail: { state: "error", message: "相机权限未开启" } });
    assert.equal(page.data.state, "error"); assert.equal(page.data.message, "相机权限未开启");
    page.selectComponent = () => ({ retryScenePreview() { retried = true; } });
    page.retry(); assert.equal(retried, true);
    let placed = 0;
    page.selectComponent = () => ({ placeScenePreview() { placed++; } });
    page.onSceneStatus({ detail: { state: "placeable", message: "" } });
    page.place(); assert.equal(placed, 1);
    page.onSceneStatus({ detail: { state: "ready", message: "轻触场景" } });
    assert.equal(page.data.state, "ready");
    page.place(); assert.equal(placed, 1, "placed Scene has no second placement action");
    console.log("PASS QR entry: no map/location requests, valid parameters, AR error and retry");
  }
  const wx = makeWx();
  const { load, lib } = makeLoader(wx);
  const { THREE } = lib("three-runtime/runtime");
  const { createCompositionPlayer, clipTime } = lib("scene-runtime/composition");

  // ── 1. composition timing ───────────────────────────────────────────────
  {
    assert.equal(clipTime(-1, 2, false), 0);
    assert.equal(clipTime(4, 2, false), 2, "non-loop clips hold the last frame");
    assert.equal(clipTime(4, 2, true), 0, "loop clips wrap by their own duration");
    assert.equal(clipTime(4.5, 2, true), 0.5);

    const cache = fakeCache(THREE);
    const states = [];
    const player = createCompositionPlayer(compositionManifest(), {
      modelCache: cache,
      onState: (state) => states.push(state),
    });
    assert.equal(player.state, "idle");
    await player.load();
    assert.equal(player.state, "ready");
    assert.equal(cache.stats.acquires, 2, "two instances → two independent acquires of one resource");
    assert.equal(player.root.children.length, 2);
    const [left, right] = player.instances;
    assert.deepEqual(Array.from(left.instanceRoot.position.toArray()), [-1, 0, 0]);
    assert.deepEqual(Array.from(right.instanceRoot.scale.toArray()), [0.8, 0.8, 0.8]);
    assert.equal(left.object.scale.x, 1, "GLB subtree is not normalized or scaled by scale_multiplier");
    assert.notEqual(left.object, right.object, "each instance owns its own clone");
    assert.ok(left.mixer && right.mixer);
    const ax = () => left.object.position.x,
      bx = () => right.object.position.x;
    near(ax(), 0, "left at clip time 0 before play");
    near(bx(), 0, "right at clip time 0 before play");
    player.update(1);
    near(ax(), 0, "update is ignored before play");
    player.play();
    player.update(1);
    near(ax(), 1, "t=1 left");
    near(bx(), 0, "t=1 right waits at clip time 0 until startSeconds=3");
    player.update(3);
    near(ax(), 2, "t=4 left holds last frame after its 2 s clip");
    near(bx(), 1, "t=4 right local time 1");
    player.update(3);
    near(ax(), 2, "t=7 left still held");
    near(bx(), 0, "t=7 right wrapped (local 4 % 2)");
    player.pause();
    assert.equal(player.state, "paused");
    player.update(5);
    near(player.time, 7, "pause freezes scene time");
    near(bx(), 0, "pause freezes poses");
    player.play();
    player.update(0.5);
    near(player.time, 7.5, "resume continues without a jump");
    near(bx(), 0.5, "t=7.5 right local 4.5 % 2");
    player.update(0.5);
    assert.equal(player.state, "ended", "scene end at durationSeconds");
    near(player.time, 8);
    near(ax(), 2, "final frame evaluated exactly at duration");
    near(bx(), 1, "right evaluated at local 5 % 2 = 1");
    player.update(1);
    near(player.time, 8, "ended scene is frozen");
    player.play();
    assert.equal(player.state, "ended", "play() does not resurrect an ended scene; restart() does");
    player.restart();
    assert.equal(player.state, "playing");
    near(player.time, 0);
    near(ax(), 0, "restart resets poses to clip time 0");
    near(bx(), 0);
    player.update(2.5);
    near(ax(), 2);
    player.dispose();
    assert.equal(player.state, "disposed");
    assert.equal(cache.stats.releases, 2, "every acquired handle released on dispose");
    assert.equal(player.root.children.length, 0);
    player.dispose();
    assert.equal(cache.stats.releases, 2, "dispose is idempotent");
    assert.deepEqual(states, ["loading", "ready", "playing", "paused", "playing", "ended", "playing", "disposed"]);

    const looping = createCompositionPlayer(compositionManifest({ loop: true }), {
      modelCache: fakeCache(THREE),
    });
    await looping.load();
    looping.play();
    looping.update(8.5);
    assert.equal(looping.state, "playing", "loop=true restarts instead of ending");
    near(looping.time, 0.5);
    near(looping.instances[1].object.position.x, 0, "delayed instance resets at the loop boundary");
    looping.update(1);
    near(looping.instances[0].object.position.x, 1.5, "loop preserves overflow time");
    looping.dispose();
    console.log("PASS composition timing: shared resource, startSeconds, hold/loop, end freeze, scene loop, pause/resume, restart");
  }

  // ── 2. static composition holds its pose ────────────────────────────────────
  {
    const cache = fakeCache(THREE);
    const player = createCompositionPlayer(
      compositionManifest({
        durationSeconds: 10,
        instances: [
          { id: "a", asset: "stage", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: null },
          { id: "b", asset: "dancer", position: [0, 0, 1], rotation: [0, 0, 0], scale: [2, 2, 2], animation: null },
        ],
      }),
      { modelCache: cache },
    );
    await player.load();
    assert.ok(player.instances.every((inst) => inst.mixer === null), "no mixer without animation");
    player.play();
    player.update(1000);
    player.update(1000);
    assert.equal(player.state, "ended", "static scenes use the same native finite timeline");
    player.dispose();
    assert.equal(cache.stats.releases, 2);
    console.log("PASS static composition holds its pose and creates no mixer");
  }

  // Shared transform curves share the same playhead as GLB clips.
  {
    const cache = fakeCache(THREE);
    const manifest = compositionManifest({ durationSeconds: 4 });
    manifest.schemaVersion = 4;
    const frames = (from, to) => [
      { time: 0, value: from, handles: [0.5, 0.5, 0.5, 0.5], connectedRight: true },
      { time: 4, value: to, handles: [0.5, 0.5, 0.5, 0.5], connectedRight: false },
    ];
    manifest.content.instances[0].tracks = { 'position.x': frames(0, 4), 'rotation.y': frames(0, Math.PI), 'scale.z': frames(1, 3) };
    const player = createCompositionPlayer(manifest, { modelCache: cache });
    await player.load(); player.play(); player.update(2);
    const group = player.instances[0].instanceRoot;
    near(group.position.x, 2, "position curve", 1e-6);
    near(group.rotation.y, Math.PI / 2, "rotation curve", 1e-6);
    near(group.scale.z, 2, "scale curve", 1e-6);
    player.pause(); player.update(1); near(group.position.x, 2, "pause", 1e-6);
    player.play(); player.update(2); near(group.position.x, 4, "end frame");
    player.restart(); near(group.position.x, 0, "restart");
    player.dispose(); assert.equal(cache.stats.live, 0);
    console.log("PASS native Core transform tracks, clip coexistence, pause/end/restart and cleanup");
  }

  // Schema 5 groups are animated transform parents; members keep local transforms.
  {
    const cache = fakeCache(THREE);
    const manifest = compositionManifest({ durationSeconds: 4 });
    manifest.schemaVersion = 5;
    manifest.content.groups = [
      { id: "rig", name: "Rig", position: [0, 1, 0], rotation: [0, 0, 0], scale: [2, 2, 2],
        tracks: { "position.x": [
          { time: 0, value: 0, handles: [0.5, 0.5, 0.5, 0.5], connectedRight: true },
          { time: 4, value: 4, handles: [0.5, 0.5, 0.5, 0.5], connectedRight: false },
        ] } },
      { id: "inner", name: "Inner", parent: "rig", position: [0, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ];
    manifest.content.instances[0].parent = "inner";
    const player = createCompositionPlayer(manifest, { modelCache: cache });
    await player.load(); assert.equal(player.state, "ready");
    player.play(); player.update(2);
    const left = player.instances[0].instanceRoot, right = player.instances[1].instanceRoot;
    assert.equal(left.parent.name, "group:inner"); assert.equal(left.parent.parent.name, "group:rig");
    assert.equal(right.parent, player.root, "members without a parent stay at the scene root");
    left.updateWorldMatrix(true, false);
    const world = new THREE.Vector3().setFromMatrixPosition(left.matrixWorld);
    near(world.x, 2 + -1 * 2, "group curve moves members", 1e-6);
    near(world.z, 2, "nested group offset is scaled by its parent", 1e-6);
    player.dispose(); assert.equal(cache.stats.live, 0);
    const flat = compositionManifest(); flat.content.groups = manifest.content.groups;
    const ignored = createCompositionPlayer(flat, { modelCache: fakeCache(THREE) });
    await ignored.load(); assert.equal(ignored.instances[0].instanceRoot.parent, ignored.root, "schema 4 never builds groups");
    ignored.dispose();
    console.log("PASS schema 5 nested animated groups and flat schema 4 compatibility");
  }

  // ── 3. load failure / cancellation release every handle ────────────────
  {
    const cache = fakeCache(THREE, { failing: new Set([STAGE.url]) });
    const states = [];
    const player = createCompositionPlayer(
      compositionManifest({
        instances: [
          { id: "left", asset: "dancer", position: [-1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: { clipIndex: 0, startSeconds: 0, loop: false } },
          { id: "right", asset: "dancer", position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: { clipIndex: 0, startSeconds: 1, loop: true } },
          { id: "stage", asset: "stage", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: null },
        ],
      }),
      { modelCache: cache, onState: (state) => states.push(state) },
    );
    await player.load();
    assert.equal(player.state, "error");
    assert.equal(cache.stats.acquires, 3);
    assert.equal(cache.stats.releases, 2, "both fulfilled handles released when a sibling resource fails");
    assert.equal(cache.stats.live, 0);
    assert.equal(player.diagnostics.alias, "stage");
    assert.equal(player.diagnostics.instanceId, "stage");
    assert.equal(player.diagnostics.kind, "resource");
    assert.match(player.diagnostics.message, /KHR_draco/);
    assert.equal(player.root.children.length, 0);
    cache.failing.clear();
    await player.load();
    assert.equal(player.state, "ready", "load can be retried after error");
    assert.equal(cache.stats.live, 3);
    player.dispose();
    player.dispose();
    assert.equal(cache.stats.live, 0);
    assert.deepEqual(states, ["loading", "error", "loading", "ready", "disposed"]);

    const badClip = createCompositionPlayer(
      compositionManifest({
        instances: [
          { id: "x", asset: "dancer", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: { clipName: "nope", startSeconds: 0, loop: false } },
          { id: "y", asset: "dancer", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: null },
        ],
      }),
      { modelCache: cache },
    );
    const before = cache.stats.acquires;
    await badClip.load();
    assert.equal(badClip.state, "error");
    assert.equal(badClip.diagnostics.kind, "animation", "clip errors are animation config errors, not resource errors");
    assert.equal(badClip.diagnostics.instanceId, "x");
    assert.equal(cache.stats.acquires - before, 2);
    assert.equal(cache.stats.live, 0, "animation config error releases every handle including the valid instance");

    const deferred = fakeCache(THREE, { defer: true });
    const cancelled = createCompositionPlayer(compositionManifest(), { modelCache: deferred });
    const loading = cancelled.load();
    await flush();
    assert.equal(deferred.stats.acquires, 2);
    cancelled.dispose();
    deferred.resolvePending();
    await loading;
    assert.equal(cancelled.state, "disposed");
    assert.equal(deferred.stats.releases, 2, "late handles after dispose are released, never attached");
    assert.equal(cancelled.root.children.length, 0);
    console.log("PASS load failure/cancel: all acquired handles released, error diagnostics, retry, idempotent dispose");
  }

  // QR preview uses the real composition player and the same mounting/disposal code.
  {
    let response = { statusCode: 200, data: compositionManifest() };
    let pending;
    const calls = [];
    const loader = makeLoader(makeWx(), { "utils/backend.ts": {
      CONFIG: {}, fetchScenePreview: async (...args) => { calls.push(args); return pending || response; },
    } });
    const { THREE: T } = loader.lib("three-runtime/runtime");
    const methods = loader.load(path.join(root, "components/xr-start/assets/index.js"))({ buckets: { scene: { cap: 1, evict: "farthest" } }, minLifetimeMs: 0 });
    const preview = loader.load(path.join(root, "components/xr-start/scene-preview.js"));
    const camera = new T.PerspectiveCamera(); camera.position.set(0, 1.6, 0);
    const cache = fakeCache(T);
    const states = [];
    const host = { ...methods, ...preview, data: { sceneId: "dance", sceneOrganizationId: "team" },
      _scenePreviewMode: true, _modelCache: cache, nodeList: [], _contentEpoch: 1, _arReady: true,
      _allowedAssetIds: new Set(), shadowRoot: new T.Group(), retrievalMode: "gps",
      getCamTransform: () => camera, triggerEvent: (_, detail) => states.push(detail),
    };
    let now = 0;
    const tick = (frames) => { for (let i = 0; i < frames; i++) host._tickScenePreview(now += 100); };
    await host._beginScenePreview();
    assert.deepEqual(calls[0], ["dance", "team"]);
    assert.equal(host.placeScenePreview(now), false, "no placement before a valid camera frame");
    tick(100); assert.equal(host.nodeList.length, 0, "waiting ten seconds never places automatically");
    assert.equal(states.at(-1).state, "placeable");
    camera.position.x = 9;
    assert.equal(host.placeScenePreview(now), true);
    assert.equal(host.nodeList.length, 1);
    near(host.nodeList[0].node.position.x, 9, "placement uses the camera at display time");
    near(host.nodeList[0].node.position.y, 1.6); near(host.nodeList[0].node.position.z, -2);
    tick(20); assert.equal(host.placeScenePreview(now), false);
    assert.equal(host.nodeList.length, 1, "rapid/repeated clicks mount only once");
    host._destroyNode(host.nodeList[0]); host.nodeList = [];
    assert.equal(cache.stats.live, 0);

    await host._beginScenePreview(); tick(1);
    now += 1000;
    assert.equal(host.placeScenePreview(now), false, "tracking gap rejects stale camera pose");
    assert.equal(host.nodeList.length, 0);
    assert.equal(states.at(-1).state, "tracking");
    tick(1);
    assert.equal(host.placeScenePreview(now), true, "one new valid frame suffices; no two-second delay");
    assert.equal(host.nodeList.length, 1);
    host._destroyNode(host.nodeList[0]); host.nodeList = [];

    await host._beginScenePreview(); tick(1);
    assert.equal(cache.stats.live, 2, "loaded Scene waits off-stage for a click");
    host._retrievalPaused = true; host._cancelScenePreview(); host._contentEpoch++;
    assert.equal(cache.stats.live, 0, "leaving before placement releases the loaded Scene");
    assert.equal(host.placeScenePreview(now), false);
    host._retrievalPaused = false;

    let finish;
    pending = new Promise(resolve => { finish = resolve; });
    const old = host._beginScenePreview();
    host._retrievalPaused = true; host._cancelScenePreview(); host._contentEpoch++;
    finish(response); await old; tick(30);
    assert.equal(host.nodeList.length, 0); assert.equal(cache.stats.live, 0, "background cancels late manifests");
    pending = null; host._retrievalPaused = false;
    const delayed = fakeCache(T, { defer: true }); host._modelCache = delayed;
    const loading = host._beginScenePreview();
    await until(() => delayed.stats.acquires === 2, "preview model load");
    tick(30); assert.equal(host.placeScenePreview(now), false);
    assert.equal(host.nodeList.length, 0, "clicking cannot reveal unloaded models");
    host._cancelScenePreview(); host._contentEpoch++; delayed.resolvePending(); await loading;
    assert.equal(delayed.stats.live, 0, "late model handles are released after cancel");
    host._modelCache = cache;
    response = { statusCode: 404, data: { error: "场景不存在" } };
    await host._beginScenePreview(); assert.equal(states.at(-1).state, "error");
    response = { statusCode: 200, data: compositionManifest({ instances: [] }) };
    await host._beginScenePreview(); assert.equal(states.at(-1).state, "empty");
    response = { statusCode: 200, data: compositionManifest() };
    await host._beginScenePreview(); tick(1);
    assert.equal(states.at(-1).state, "placeable");
    host._retrievalPaused = true; assert.equal(host.placeScenePreview(now), false);
    host._retrievalPaused = false;
    assert.equal(host.placeScenePreview(now), true);
    assert.equal(states.at(-1).state, "ready", "retry requires a new click after error or empty content");
    for (const entry of host.nodeList) host._destroyNode(entry);
    host._cancelScenePreview(); assert.equal(cache.stats.live, 0);
    let restartedAR = false;
    host._arReady = false; host.retryAR = () => { restartedAR = true; };
    host.retryScenePreview(); assert.equal(restartedAR, true, "retry starts AR again when initialization failed");
    console.log("PASS QR scene: manual placement, latest camera, single mount, tracking gaps, background cancellation, slow models, errors and retry");
  }

  // Real AR component hide/show and detach/re-enter drive the real runtime clock,
  // composition Core and queue. Only VisionKit/GPU and resource IO are stand-ins.
  {
    const manifest = compositionManifest();
    manifest.content.instances[0].tracks = { "rotation.y": [
      { time: 0, value: 0, handles: [0, 0, 1, 1], connectedRight: true },
      { time: 8, value: Math.PI, handles: [0, 0, 1, 1], connectedRight: false },
    ] };
    let requests = 0;
    const loader = makeLoader(makeWx(), { "utils/backend.ts": {
      CONFIG: {}, fetchScenePreview: async () => { requests++; return { statusCode: 200, data: manifest }; },
    } });
    loader.load(path.join(root, "components/xr-start/index.js"));
    const component = loader.context.component;
    const { THREE: T } = loader.lib("three-runtime/runtime");
    const { ARRuntime } = loader.lib("three-runtime/ar-runtime");
    const nativeCamera = new T.PerspectiveCamera(45, 1, 0.01, 300);
    nativeCamera.position.set(0, 1.6, 0); nativeCamera.updateMatrixWorld(true);
    const nativeFrame = { camera: { viewMatrix: nativeCamera.matrixWorldInverse.toArray(),
      getProjectionMatrix: () => nativeCamera.projectionMatrix.toArray() } };
    for (let entry = 0; entry < 3; entry++) {
      const host = { ...component.methods,
        data: { ...component.data, sceneId: "dance", sceneOrganizationId: "team" },
        setData(values) { Object.assign(this.data, values); }, triggerEvent() {},
      };
      component.lifetimes.attached.call(host);
      const cache = fakeCache(T);
      cache.dispose = () => assert.equal(cache.stats.live, 0, "component releases every model before cache disposal");
      host._modelCache = cache;
      const runtime = Object.assign(Object.create(ARRuntime.prototype), {
        canvas: { width: 480, height: 640 }, scene: new T.Scene(), camera: new T.PerspectiveCamera(),
        content: new T.Group(), reticle: new T.Group(),
        background: { draw: () => true, dispose() {} },
        renderer: { render() {}, resetState() {}, dispose() {}, info: { render: {}, memory: {} } },
        session: { start() {}, stop() {} },
        onReady: () => host.handleARReady(), onTick: dt => host.handleTick(dt),
      });
      runtime.scene.add(runtime.content);
      host._runtime = runtime; host.scene = runtime.scene; host.shadowRoot = runtime.content;
      for (const previousState of ["playing", "paused", "ended"]) {
        component.pageLifetimes.show.call(host);
        assert.equal(runtime.lastFrameAt, null, "AR restarts its frame clock");
        runtime.frame(nativeFrame, { now: 10, acquireMs: 0 });
        await until(() => !!host._scenePreviewPlayer, "foreground scene loaded");
        const player = host._scenePreviewPlayer;
        assert.equal(player.time, 0);
        runtime.frame(nativeFrame, { now: 20, acquireMs: 0 });
        assert.equal(host.placeScenePreview(), true);
        assert.equal(player.state, "playing");
        assert.equal(player.time, 0, "placement starts at zero");
        runtime.frame(nativeFrame, { now: 120, acquireMs: 0 });
        near(player.time, 0.1, "AR frame drives the new player");
        near(player.instances[0].instanceRoot.rotation.y, Math.PI / 80, "transform follows restarted time");
        if (previousState === "paused") player.pause();
        if (previousState === "ended") player.update(8);
        assert.equal(player.state, previousState);
        component.pageLifetimes.hide.call(host);
        assert.equal(player.state, "disposed");
        assert.equal(host.nodeList.length, 0);
        assert.equal(cache.stats.live, 0);
      }
      component.lifetimes.detached.call(host);
      assert.equal(host._runtime, null);
    }
    assert.equal(requests, 9, "every re-entry reads a fresh scene document");
    console.log("PASS AR component hide/show and detach/re-entry: playing/paused/ended reset clock and pose, old players fully disposed");
  }

  // Real queue integration: same registry, tick, tap, capacity and clearing as other assets.
  {
    let response = { statusCode: 200, data: compositionManifest() };
    let pendingResponse;
    const calls = [];
    const loader = makeLoader(makeWx(), {
      "utils/backend.ts": {
        CONFIG: { workspaceId: "workspace", organizationId: "org" },
        backendRpc: async (name, body) => { calls.push({ name, body }); return pendingResponse || response; },
      },
    });
    const { THREE: T } = loader.lib("three-runtime/runtime");
    const methods = loader.load(path.join(root, "components/xr-start/assets/index.js"))({
      buckets: { scene: { cap: 1, evict: "farthest" }, light: { cap: 20, evict: "farthest" } },
      minLifetimeMs: 0,
    });
    const cache = fakeCache(T);
    const camera = new T.PerspectiveCamera();
    camera.position.set(0, 1.4, 0);
    const host = {
      ...methods, _modelCache: cache, nodeList: [], _contentEpoch: 1,
      _allowedAssetIds: new Set(["dance"]), shadowRoot: new T.Group(),
      retrievalMode: "gps", getCamTransform: () => camera,
    };
    const asset = { id: "dance", file_type: "scene", _contentEpoch: 1 };
    await host._placeAsset(asset);
    assert.equal(calls[0].name, "get_scene_asset");
    assert.equal(calls[0].body.p_workspace_id, "workspace");
    assert.equal(host.nodeList.length, 1);
    const entry = host.nodeList[0];
    assert.equal(entry.bucket, "scene");
    assert.equal(entry.repulsionEnabled, false);
    near(entry.node.position.y, 0);
    near(entry.node.position.z, -2);
    const model = entry.node.children[0].children[0];
    entry.tick(1);
    near(model.position.x, 1);
    entry.onTap(); entry.tick(1);
    near(model.position.x, 1, "tap pauses");
    entry.onTap(); entry.tick(10);
    entry.onTap(); entry.tick(0.5);
    near(model.position.x, 0.5, "tap replays ended scene");
    host._destroyNode(entry); host.nodeList = [];
    assert.equal(cache.stats.live, 0);
    assert.equal(host.shadowRoot.children.length, 0);

    // Stale manifest never starts a model load.
    let resolveResponse;
    pendingResponse = new Promise((r) => { resolveResponse = r; });
    const before = cache.stats.acquires;
    const stale = host._placeAsset(asset);
    host._contentEpoch++;
    resolveResponse(response);
    await stale;
    assert.equal(cache.stats.acquires, before);
    pendingResponse = null;

    // Models completing after mode/content change must be released without a node.
    const delayed = fakeCache(T, { defer: true });
    host._modelCache = delayed;
    asset._contentEpoch = host._contentEpoch;
    const loading = host._placeAsset(asset);
    await until(() => delayed.stats.acquires === 2, "model loading");
    host._contentEpoch++;
    delayed.resolvePending(); await loading;
    assert.equal(delayed.stats.live, 0);
    assert.equal(host.nodeList.length, 0);

    // Dependency/protocol errors are reported, without a partially mounted composition.
    host._modelCache = cache;
    asset._contentEpoch = host._contentEpoch;
    response = { statusCode: 400, data: { error: "场景资源不存在" } };
    await assert.rejects(host._placeAsset(asset), /场景资源不存在/);
    response = { statusCode: 200, data: { ...compositionManifest(), schemaVersion: 2 } };
    await assert.rejects(host._placeAsset(asset), /不支持/);
    response = { statusCode: 200, data: { ...compositionManifest(), schemaVersion: 1 } };
    await assert.rejects(host._placeAsset(asset), /不支持/, "removed protocol is not accepted");
    assert.equal(host.nodeList.length, 0);

    response = { statusCode: 200, data: { ...compositionManifest({ instances: [] }), schemaVersion: 4 } };
    await host._placeAsset(asset);
    assert.equal(host.nodeList.length, 0, "blank scene is a valid draft with no AR node");

    // Capacity evicts an entire old scene while keeping normal assets.
    const text = new T.Group();
    host._allowedAssetIds.add("text");
    host._registerNode("text", text, null, { type: "text", contentEpoch: host._contentEpoch });
    response = { statusCode: 200, data: compositionManifest() };
    await host._placeAsset(asset);
    const old = host.nodeList.find((e) => e.type === "scene");
    camera.position.z = 10;
    await host._placeAsset(asset);
    assert.ok(old._destroyed);
    assert.equal(host.nodeList.filter((e) => e.type === "scene").length, 1);
    assert.equal(host.nodeList.filter((e) => e.type === "text").length, 1);
    for (const node of host.nodeList) host._destroyNode(node);
    assert.equal(cache.stats.live, 0);
    console.log("PASS scene asset queue: placement, tap, dependency errors, late results, whole-scene capacity and disposal");
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

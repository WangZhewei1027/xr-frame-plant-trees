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
    showModal(options) {
      (this.modals = this.modals || []).push(options);
    },
    ...extra,
  };
}

/** vm module loader in the style of test-ar-runtime.cjs; `overrides` seed stub modules by relative path. */
function makeLoader(wx, overrides = {}) {
  const context = vm.createContext({
    console: { log() {}, warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    wx,
    Intl,
    Component(value) {
      context.component = value;
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
    schemaVersion: 1,
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
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          animation: { clipIndex: 0, startSeconds: 0, loop: false },
        },
        {
          id: "right",
          asset: "dancer",
          position: [1, 0, 0],
          quaternion: [0, 0, 0, 1],
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

  // ── 2. static composition never ends ────────────────────────────────────
  {
    const cache = fakeCache(THREE);
    const player = createCompositionPlayer(
      compositionManifest({
        durationSeconds: null,
        instances: [
          { id: "a", asset: "stage", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], animation: null },
          { id: "b", asset: "dancer", position: [0, 0, 1], quaternion: [0, 0, 0, 1], scale: [2, 2, 2], animation: null },
        ],
      }),
      { modelCache: cache },
    );
    await player.load();
    assert.ok(player.instances.every((inst) => inst.mixer === null), "no mixer without animation");
    player.play();
    player.update(1000);
    player.update(1000);
    assert.equal(player.state, "playing", "durationSeconds=null never reaches ended");
    player.dispose();
    assert.equal(cache.stats.releases, 2);
    console.log("PASS static composition (durationSeconds null) never ends and creates no mixer");
  }

  // Version 2 transform curves share the same playhead as GLB clips.
  {
    const cache = fakeCache(THREE);
    const manifest = compositionManifest({ durationSeconds: 4 });
    manifest.schemaVersion = 2;
    const frames = (from, to) => [
      { time: 0, value: from, handles: [0.5, 0.5, 0.5, 0.5], connectedRight: true },
      { time: 4, value: to, handles: [0.5, 0.5, 0.5, 0.5], connectedRight: false },
    ];
    manifest.content.instances[0].tracks = { "position.x": frames(0, 4), "rotation.y": frames(0, Math.PI), "scale.z": frames(1, 3) };
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
    console.log("PASS v2 transform tracks, clip coexistence, pause/end/restart and cleanup");
  }

  // ── 3. load failure / cancellation release every handle ────────────────
  {
    const cache = fakeCache(THREE, { failing: new Set([STAGE.url]) });
    const states = [];
    const player = createCompositionPlayer(
      compositionManifest({
        instances: [
          { id: "left", asset: "dancer", position: [-1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], animation: { clipIndex: 0, startSeconds: 0, loop: false } },
          { id: "right", asset: "dancer", position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], animation: { clipIndex: 0, startSeconds: 1, loop: true } },
          { id: "stage", asset: "stage", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], animation: null },
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
          { id: "x", asset: "dancer", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], animation: { clipName: "nope", startSeconds: 0, loop: false } },
          { id: "y", asset: "dancer", position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], animation: null },
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
    response = { statusCode: 200, data: { ...compositionManifest(), schemaVersion: 3 } };
    await assert.rejects(host._placeAsset(asset), /不支持/);
    assert.equal(host.nodeList.length, 0);

    response = { statusCode: 200, data: { ...compositionManifest({ instances: [] }), schemaVersion: 2 } };
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

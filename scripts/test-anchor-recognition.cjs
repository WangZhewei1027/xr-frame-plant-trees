const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const componentPath = "miniprogram/components/xr-start/";
function load(relative, dependencies = {}) {
  const filename = path.join(root, relative);
  const m = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module: m,
      exports: m.exports,
      require: (id) =>
        dependencies[id] ??
        require(require.resolve(id, { paths: [path.dirname(filename)] })),
      wx: global.wx,
      console,
      setTimeout,
      clearTimeout,
      Date,
      Set,
      Map,
      Uint8Array,
      Uint8ClampedArray,
    },
    { filename },
  );
  return m.exports;
}
let response,
  responseBody,
  uploaded,
  removed = [],
  pendingUpload,
  deferredLocation;
const config = {
  apiBaseUrl: "https://ar.example.test",
  intervalMs: 0,
  timeoutMs: 20000,
  confirmationCount: 2,
};
const matched = (id = "a", assets = [{ id: "child", file_type: "image" }]) => ({
  matched: true,
  anchor: { id, name: id },
  assets,
});
function mockWx() {
  global.wx = {
    getLocation(opts) {
      if (deferredLocation) deferredLocation = opts;
      else opts.success({ latitude: 31, longitude: 121, accuracy: 10 });
    },
    uploadFile(opts) {
      uploaded = opts;
      if (response === "pending") pendingUpload = opts;
      else
        opts.success({
          statusCode: typeof response === "number" ? response : 200,
          data: responseBody ?? JSON.stringify({ data: response }),
        });
      return {
        abort() {
          opts.fail({ errMsg: "abort" });
        },
      };
    },
    getXrFrameSystem() {
      return { Transform: "Transform" };
    },
  };
}
function instance() {
  mockWx();
  const matching = load(componentPath + "matching/index.js", {
    "./config": config,
    "../../../utils/supabase": {
      CONFIG: { workspaceId: "workspace" },
      getPublicApiHeaders: () => { throw new Error("Recognition must not request credentials"); },
    },
    "./capture": {
      captureCamera: async () => "/tmp/frame.jpg",
      removeTempFile: (p) => {
        if (p) removed.push(p);
      },
    },
  });
  const x = Object.assign(
    {
      retrievalMode: "anchor",
      _arReady: true,
      _modeEpoch: 0,
      _contentEpoch: 0,
      _allowedAssetIds: new Set(),
      _nextRecognitionAt: 0,
      nodeList: [],
      _hugeNodeList: [],
      _seenAssets: new Map(),
      statuses: [],
      displayed: [],
      triggerEvent(_, detail) {
        this.statuses.push(detail.message);
      },
      updateGPS(gps) {
        this.currentGPS = gps;
      },
      _destroyNode(e) {
        removed.push(e.assetId);
      },
      displayAssets(assets) {
        this.displayed.push(assets);
      },
      fetchNearbyAssets() {
        this.gpsCalls = (this.gpsCalls || 0) + 1;
      },
      fetchHugeAssets() {},
    },
    matching,
  );
  return x;
}
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("mini-program relative requires resolve without Node directory fallback", () => {
  const sourceRoot = path.join(root, "miniprogram");
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        inspect(filename);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const source = fs.readFileSync(filename, "utf8");
      for (const [, target] of source.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const base = path.resolve(path.dirname(filename), target);
        const exists = ["", ".js", ".ts", ".json"].some((extension) => {
          try { return fs.statSync(base + extension).isFile(); }
          catch { return false; }
        });
        assert.ok(exists, `${path.relative(root, filename)}: ${target} must name a file; use /index for directory modules`);
      }
    }
  }
  inspect(sourceRoot);
});

test("two confirmations, valid multipart GPS protocol, returned children only", async () => {
  const x = instance();
  response = matched();
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 0);
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 1);
  assert.equal(x.displayed[0][0].id, "child");
  assert.equal(uploaded.name, "image");
  assert.equal(uploaded.header, undefined);
  assert.equal(uploaded.formData.coordinate_system, "wgs84");
  assert.equal(uploaded.formData.latitude, "31");
  assert.ok(Date.now() - Number(uploaded.formData.gps_timestamp) < 1000);
  assert.equal(
    new URL(uploaded.url).searchParams.get("workspace_id"),
    "workspace",
  );
});
test("miss and different point reset confirmation", async () => {
  const x = instance();
  response = matched();
  await x.recognizeAnchor();
  response = { matched: false, assets: [], reason: "no_nearby_anchor" };
  await x.recognizeAnchor();
  response = matched();
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 0);
  response = matched("b");
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 0);
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 1);
});
test("switch aborts upload and late successful response cannot render", async () => {
  const x = instance();
  response = "pending";
  const run = x.recognizeAnchor();
  await flush();
  const old = pendingUpload;
  x.setRetrievalMode("gps");
  old.success({ statusCode: 200, data: JSON.stringify({ data: matched() }) });
  await run;
  assert.equal(x.displayed.length, 0);
  assert.equal(x.gpsCalls, 1);
  assert.equal(x._recognizing, false);
});
test("switch during GPS sampling prevents upload", async () => {
  const x = instance();
  deferredLocation = true;
  uploaded = null;
  const run = x.recognizeAnchor();
  x.setRetrievalMode("gps");
  deferredLocation.success({ latitude: 31, longitude: 121, accuracy: 10 });
  deferredLocation = null;
  await run;
  assert.equal(uploaded, null);
});
test("hide pauses recognition, destroys remote and pending audio, preserves local nodes", async () => {
  const x = instance();
  let destroyed = false;
  x.nodeList = [{ assetId: null }, { assetId: "remote" }];
  x._pendingAudioContexts = new Set([
    {
      stop() {},
      destroy() {
        destroyed = true;
      },
    },
  ]);
  x.pauseRetrieval();
  assert.equal(x.nodeList.length, 1);
  assert.equal(x.nodeList[0].assetId, null);
  assert.ok(destroyed);
  uploaded = null;
  await x.recognizeAnchor();
  assert.equal(uploaded, null);
  x.resumeRetrieval();
  assert.equal(x._retrievalPaused, false);
});
test("GPS mode and missing endpoint never upload", async () => {
  const x = instance();
  x.retrievalMode = "gps";
  uploaded = null;
  await x.recognizeAnchor();
  assert.equal(uploaded, null);
  x.retrievalMode = "anchor";
  const base = config.apiBaseUrl;
  config.apiBaseUrl = "";
  await x.recognizeAnchor();
  config.apiBaseUrl = base;
  assert.equal(uploaded, null);
  assert.equal(x._nextRecognitionAt, Infinity);
  assert.match(x.statuses.at(-1), /配置/);
});
test("poor GPS accuracy fails closed", async () => {
  const x = instance();
  global.wx.getLocation = (opts) =>
    opts.success({ latitude: 31, longitude: 121, accuracy: 150 });
  uploaded = null;
  await x.recognizeAnchor();
  assert.equal(uploaded, null);
  assert.match(x.statuses.at(-1), /精度不足/);
});
test("rate limiting backs off and clears confirmation", async () => {
  const x = instance();
  response = 429;
  await x.recognizeAnchor();
  assert.ok(x._nextRecognitionAt >= Date.now() + 59000);
  assert.equal(x._candidateCount, 0);
});
test("invalid API payload fails closed", async () => {
  const x = instance();
  response = { unexpected: true };
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 0);
  assert.match(x.statuses.at(-1), /格式异常/);
});
test("503 exposes the backend reason and HTML errors retain the fallback", async () => {
  try {
    const x = instance();
    response = 503;
    responseBody = JSON.stringify({ error: "匹配接口未就绪，请检查数据库迁移" });
    await x.recognizeAnchor();
    assert.equal(x.statuses.at(-1), "匹配接口未就绪，请检查数据库迁移");
    assert.equal(x.displayed.length, 0);
    responseBody = "<html>upstream unavailable</html>";
    await x.recognizeAnchor();
    assert.equal(x.statuses.at(-1), "匹配服务尚未就绪");
  } finally {
    responseBody = undefined;
  }
});
test("stale node with same id rejected after switching back", () => {
  const queue = load(componentPath + "assets/queue.js", {
    "./registry": { image: { bucket: "light" } },
  })({});
  let destroyed = false;
  const x = {
    _activePlacementEpoch: 0,
    _contentEpoch: 2,
    _allowedAssetIds: new Set(["same"]),
    nodeList: [],
    _destroyNode() {
      destroyed = true;
    },
    _enforceCapacity() {},
  };
  queue._registerNode.call(x, "same", null, null, { type: "image" });
  assert.ok(destroyed);
  assert.equal(x.nodeList.length, 0);
  queue._registerNode.call(x, null, null, null, { type: "text" });
  assert.equal(x.nodeList.length, 1);
});
test("old GPS RPC result is discarded after switching", async () => {
  let resolve;
  const noop = () => ({});
  const assets = load(componentPath + "assets/index.js", {
    "../../../utils/supabase": {
      CONFIG: {},
      supabaseRpc: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
    "./queue": noop,
    "./audio": noop,
    "./text": {},
    "./model": {},
    "./image": {},
    "./video": {},
  })({});
  let rendered = false;
  const x = {
    retrievalMode: "gps",
    _modeEpoch: 0,
    currentGPS: {},
    displayAssets() {
      rendered = true;
    },
  };
  const run = assets.fetchNearbyAssets.call(x);
  x._modeEpoch++;
  x.retrievalMode = "anchor";
  resolve({ statusCode: 200, data: [{ id: "old", file_type: "image" }] });
  await run;
  assert.equal(rendered, false);
});
test("YUV neutral pixels, rotation and malformed layout", () => {
  const { convertFrame } = load(componentPath + "matching/capture.js");
  const raw = {
    width: 2,
    height: 2,
    yBuffer: Uint8Array.from([0, 64, 128, 255]).buffer,
    uvBuffer: Uint8Array.from([128, 128]).buffer,
  };
  const a = convertFrame(raw);
  assert.deepEqual(
    Array.from(a.data.slice(0, 8)),
    [0, 0, 0, 255, 64, 64, 64, 255],
  );
  const b = convertFrame(raw, { rotation: 90 });
  assert.equal(b.data[0], 128);
  assert.equal(b.data[4], 0);
  assert.throws(() => convertFrame({ ...raw, width: 4 }), /格式不支持/);
});
(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log("PASS", name);
  }
  console.log(`${tests.length} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

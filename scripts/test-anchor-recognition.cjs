const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const componentPath = "miniprogram/components/xr-start/";
function load(relative, dependencies = {}, globals = {}) {
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
      Component: global.Component,
      console,
      setTimeout,
      clearTimeout,
      Date,
      Set,
      Map,
      Uint8Array,
      Uint8ClampedArray,
      ...globals,
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
  deferredLocation,
  capturePath = "/tmp/frame.jpg";
const config = {
  apiBaseUrl: "https://ar.example.test",
  pixelConverter: "cpu",
  intervalMs: 0,
  errorRetryMs: 0,
  initialCaptureDelayMs: 0,
  maxInFlightRequests: 6,
  restartDistanceMeters: 1.5,
  timeoutMs: 20000,
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
      return { Transform: "Transform", Vector3: { createFromNumber: (x, y, z) => ({ x, y, z }) } };
    },
  };
}
function instance(logs, captureOverrides = {}) {
  mockWx();
  const matching = load(componentPath + "matching/index.js", {
    ...(logs ? { "./log": (event, fields, level, requestId) => logs.push({ event, fields, level, requestId }) } : {}),
    "./config": config,
    "../../../utils/supabase": {
      CONFIG: { workspaceId: "workspace" },
      getPublicApiHeaders: () => { throw new Error("Recognition must not request credentials"); },
    },
    "./capture": {
      isCaptureBusy: () => false,
      createCaptureTiming: require(path.join(root, componentPath, "matching/capture.js")).createCaptureTiming,
      captureCamera: async (_scene, onInfo) => {
        onInfo?.({ rawWidth: 1920, rawHeight: 1080, width: 640, height: 360, rotation: 0, uvOrder: "uv" });
        return capturePath;
      },
      removeTempFile: (p) => {
        if (p) removed.push(p);
      },
      ...captureOverrides,
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
      setData(data) { this.data = { ...this.data, ...data }; },
      statuses: [],
      frames: [],
      displayed: [],
      triggerEvent(name, detail) {
        if (name === "recognitionframe") this.frames.push(detail);
        else this.statuses.push(detail.message);
      },
      getCamTransform() {
        return { worldPosition: this.testPosition || { x: 0, y: 0, z: 0 }, worldMatrix: { transformDirection: v => v } };
      },
      updateGPS(gps) {
        this.currentGPS = gps;
      },
      _destroyNode(e) {
        removed.push(e.assetId);
        if (e.node) this.shadowRoot?.removeChild(e.node);
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

test("production recognition endpoint calls the public Supabase Edge Function directly", () => {
  const production = require(path.join(root, componentPath, "matching/config.js"));
  assert.equal(production.apiBaseUrl, "https://mkdfezaufjhrfjkfqlbj.supabase.co");
  assert.equal(production.apiPath, "/functions/v1/recognize-anchor");
  assert.equal(production.functionRegion, "ap-south-1");
  assert.equal(production.Authorization, undefined);
  assert.equal(production.apikey, undefined);
});

test("custom API path and function region preserve anonymous upload and trace identifiers", async () => {
  const previous = { apiBaseUrl: config.apiBaseUrl, apiPath: config.apiPath, functionRegion: config.functionRegion };
  try {
    config.apiBaseUrl = "https://edge.example.test/";
    config.apiPath = "/functions/v1/recognize-anchor";
    config.functionRegion = "ap-southeast-1";
    const logs = [];
    const x = instance(logs);
    response = miss();
    await x.recognizeAnchor();
    assert.equal(uploaded.url, "https://edge.example.test/functions/v1/recognize-anchor?workspace_id=workspace");
    assert.equal(uploaded.header["x-region"], "ap-southeast-1");
    assert.equal(uploaded.header["X-Recognition-Request-Id"], logs.find(e => e.event === "开始识别").requestId);
    assert.deepEqual(Object.keys(uploaded.header).map(key => key.toLowerCase()).sort(), ["x-recognition-request-id", "x-region"]);
    assert.equal(uploaded.name, "image");
    assert.equal(uploaded.formData.coordinate_system, "wgs84");
    const upload = logs.find(e => e.event === "上传识别请求").fields;
    assert.equal(upload.origin, "https://edge.example.test");
    assert.equal(upload.path, config.apiPath);
    assert.equal(upload.functionRegion, "ap-southeast-1");

    config.functionRegion = "";
    const automatic = instance();
    await automatic.recognizeAnchor();
    assert.deepEqual(Object.keys(uploaded.header), ["X-Recognition-Request-Id"]);
  } finally {
    config.apiBaseUrl = previous.apiBaseUrl;
    if (previous.apiPath === undefined) delete config.apiPath; else config.apiPath = previous.apiPath;
    if (previous.functionRegion === undefined) delete config.functionRegion; else config.functionRegion = previous.functionRegion;
  }
});

test("warmup prevents both GPS and capture, and resume starts a new preparation window", async () => {
  const previous = config.initialCaptureDelayMs;
  config.initialCaptureDelayMs = 3000;
  try {
    const x = instance();
    let gpsCalls = 0;
    global.wx.getLocation = () => { gpsCalls++; };
    uploaded = null;
    await x.recognizeAnchor();
    assert.equal(gpsCalls, 0);
    assert.equal(uploaded, null);
    assert.match(x.statuses.at(-1), /稍后/);
    x.pauseRetrieval();
    x.resumeRetrieval();
    await x.recognizeAnchor();
    assert.equal(gpsCalls, 0);
    assert.ok(x._captureGate.readyAt > Date.now() + 2900);
  } finally {
    config.initialCaptureDelayMs = previous;
  }
});
test("movement during GPS no longer postpones capture", async () => {
  const x = instance();
  response = { matched: false, assets: [] };
  deferredLocation = true;
  uploaded = null;
  const run = x.recognizeAnchor();
  x.testPosition = { x: 10, y: 0, z: 0 };
  x.sampleCaptureMotion(x.getCamTransform(), Date.now() + 100, true);
  deferredLocation.success({ latitude: 31, longitude: 121, accuracy: 10 });
  deferredLocation = null;
  await run;
  assert.ok(uploaded);
  assert.equal(x._recognizing, false);
});

async function clocked(fn) {
  const realNow = Date.now;
  let time = 100000;
  Date.now = () => time;
  try { await fn(ms => { time += ms; }); }
  finally { Date.now = realNow; }
}
const reply = (request, data) => request.success({ statusCode: 200, data: JSON.stringify({ data }) });
const miss = () => ({ matched: false, reason: "below_threshold", assets: [] });

test("one-second capture cadence permits six in-flight requests and skips overflow without queuing", async () => {
  config.intervalMs = 1000;
  try {
    await clocked(async advance => {
      const x = instance();
      response = "pending";
      const runs = [x.recognizeAnchor()];
      await flush();
      const first = pendingUpload;
      advance(999);
      await x.recognizeAnchor();
      assert.equal(x._recognitionRequests.size, 1);
      advance(1);
      runs.push(x.recognizeAnchor());
      await flush();
      assert.notEqual(pendingUpload, first);
      for (let i = 2; i < 6; i++) {
        advance(1000);
        runs.push(x.recognizeAnchor());
        await flush();
      }
      assert.equal(x._recognitionRequests.size, 6);
      const last = pendingUpload;
      advance(1000);
      await x.recognizeAnchor();
      assert.equal(pendingUpload, last);
      assert.equal(x._recognitionRequests.size, 6);
      x.pauseRetrieval();
      await Promise.all(runs);
      assert.equal(x._recognitionRequests.size, 0);
    });
  } finally { config.intervalMs = 0; }
});

test("a slow capture skips ticks without blocking concurrent uploads after export", async () => {
  config.intervalMs = 1000;
  try {
    await clocked(async advance => {
      let busy = false;
      const captures = [];
      const x = instance(undefined, {
        isCaptureBusy: () => busy,
        captureCamera: (_scene, _onInfo, current) => new Promise(resolve => {
          busy = true;
          captures.push({ current, finish(file) { busy = false; resolve(file); } });
        }),
      });
      response = "pending";
      uploaded = null;
      const first = x.recognizeAnchor();
      await flush();
      assert.equal(captures.length, 1);
      advance(2000);
      await x.recognizeAnchor();
      assert.equal(captures.length, 1, "busy capture must skip ticks rather than queue frames");
      assert.equal(x._recognitionRequests.size, 1);
      assert.equal(uploaded, null);
      captures[0].finish("/tmp/serialized-first.jpg");
      await flush();
      const firstUpload = pendingUpload;
      const second = x.recognizeAnchor();
      await flush();
      assert.equal(captures.length, 2, "pending network must not prevent a new capture");
      assert.equal(x._recognitionRequests.size, 2);
      captures[1].finish("/tmp/serialized-second.jpg");
      await flush();
      const secondUpload = pendingUpload;
      reply(firstUpload, miss());
      reply(secondUpload, miss());
      await Promise.all([first, second]);
      assert.equal(x._recognitionRequests.size, 0);
    });
  } finally { config.intervalMs = 0; }
});

test("mode changes invalidate the capture callback and discard a late exported frame", async () => {
  let finish;
  let isCurrent;
  const x = instance(undefined, {
    captureCamera: (_scene, _onInfo, current) => new Promise(resolve => {
      isCurrent = current;
      finish = resolve;
    }),
  });
  uploaded = null;
  const run = x.recognizeAnchor();
  await flush();
  assert.equal(isCurrent(), true);
  x.setRetrievalMode("gps");
  assert.equal(isCurrent(), false);
  finish("/tmp/stale-export.jpg");
  await run;
  assert.equal(uploaded, null);
  assert.ok(removed.includes("/tmp/stale-export.jpg"));
  assert.equal(x._recognitionRequests.size, 0);
});

test("a single match displays only returned children and stops every future capture", async () => {
  const x = instance();
  response = matched();
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 1);
  assert.equal(x.displayed[0][0].id, "child");
  assert.equal(x._captureGate.locked, true);
  assert.equal(x._nextRecognitionAt, Infinity);
  const first = uploaded;
  response = miss();
  for (let i = 0; i < 10; i++) await x.recognizeAnchor();
  assert.equal(uploaded, first);
  assert.equal(x.displayed.length, 1);
  assert.equal(uploaded.name, "image");
  assert.ok(uploaded.header["X-Recognition-Request-Id"]);
  assert.equal(uploaded.header.Authorization, undefined);
  assert.equal(uploaded.header.apikey, undefined);
  assert.equal(uploaded.formData.coordinate_system, "wgs84");
  assert.equal(uploaded.formData.latitude, "31");
  assert.ok(Date.now() - Number(uploaded.formData.gps_timestamp) < 1000);
  assert.equal(new URL(uploaded.url).searchParams.get("workspace_id"), "workspace");
});

test("a miss keeps scanning and the first subsequent match locks immediately", async () => {
  const x = instance();
  response = miss();
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 0);
  assert.equal(x._captureGate.locked, false);
  response = matched("b");
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 1);
  assert.equal(x._matchedAnchorId, "b");
});

test("a match aborts concurrent uploads and late failures cannot clear the matched scene", async () => {
  const x = instance();
  response = "pending";
  const one = x.recognizeAnchor();
  await flush();
  const old = pendingUpload;
  const two = x.recognizeAnchor();
  await flush();
  reply(pendingUpload, matched("winner"));
  await two;
  old.fail({ errMsg: "late failure" });
  reply(old, miss());
  await one;
  assert.equal(x._matchedAnchorId, "winner");
  assert.equal(x.displayed.length, 1);
  assert.equal(x._nextRecognitionAt, Infinity);
  assert.equal(x._recognitionRequests.size, 0);
});

test("old match responses cannot override a newer completed miss", async () => {
  const x = instance();
  response = "pending";
  const one = x.recognizeAnchor();
  await flush();
  const old = pendingUpload;
  const two = x.recognizeAnchor();
  await flush();
  reply(pendingUpload, miss());
  await two;
  reply(old, matched("stale"));
  await one;
  assert.equal(x.displayed.length, 0);
  assert.equal(x._captureGate.locked, false);
});

test("older 429 cannot postpone scanning after a newer match result", async () => {
  const x = instance();
  response = "pending";
  const one = x.recognizeAnchor();
  await flush();
  const old = pendingUpload;
  const two = x.recognizeAnchor();
  await flush();
  reply(pendingUpload, miss());
  await two;
  const nextAt = x._nextRecognitionAt;
  old.success({ statusCode: 429, data: JSON.stringify({ error: "rate limited" }) });
  await one;
  assert.equal(x._nextRecognitionAt, nextAt);
});

test("newer model-busy errors do not suppress an earlier in-progress successful match", async () => {
  const x = instance();
  response = "pending";
  const one = x.recognizeAnchor();
  await flush();
  const older = pendingUpload;
  const two = x.recognizeAnchor();
  await flush();
  pendingUpload.success({ statusCode: 429, data: JSON.stringify({ error: "busy", code: "model_busy", retry_after_ms: 2000 }) });
  await two;
  assert.ok(x._nextRecognitionAt >= Date.now() + 1900);
  assert.ok(x._nextRecognitionAt < Date.now() + 2100);
  reply(older, matched("valid"));
  await one;
  assert.equal(x._matchedAnchorId, "valid");
  assert.equal(x._captureGate.locked, true);
});

test("moving 1.5m after success clears assets and restarts the full three-second preparation", async () => {
  await clocked(async advance => {
    const x = instance();
    response = matched();
    await x.recognizeAnchor();
    x.nodeList = [{ assetId: "child" }];
    config.initialCaptureDelayMs = 3000;
    try {
      advance(100);
      x.testPosition = { x: 1.49, y: 0, z: 0 };
      x.sampleCaptureMotion(x.getCamTransform());
      assert.equal(x._captureGate.locked, true);
      assert.equal(x.nodeList.length, 1);
      advance(100);
      x.testPosition = { x: 1.5, y: 0, z: 0 };
      x.sampleCaptureMotion(x.getCamTransform());
      assert.equal(x._captureGate.locked, false);
      assert.equal(x.nodeList.length, 0);
      assert.equal(x._matchedAnchorId, null);
      uploaded = null;
      advance(2999);
      await x.recognizeAnchor();
      assert.equal(uploaded, null);
      advance(1);
      response = miss();
      await x.recognizeAnchor();
      assert.ok(uploaded);
    } finally { config.initialCaptureDelayMs = 0; }
  });
});

test("GPS lookup is shared and resolving it does not create a burst of simultaneous captures", async () => {
  config.intervalMs = 1000;
  try {
    await clocked(async advance => {
      const x = instance();
      deferredLocation = true;
      response = "pending";
      const one = x.recognizeAnchor();
      const gps = deferredLocation;
      advance(1000);
      const two = x.recognizeAnchor();
      assert.equal(deferredLocation, gps);
      gps.success({ latitude: 31, longitude: 121, accuracy: 10 });
      deferredLocation = null;
      await flush();
      assert.equal(x._recognitionRequests.size, 1);
      reply(pendingUpload, miss());
      await Promise.all([one, two]);
    });
  } finally { config.intervalMs = 0; deferredLocation = null; }
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
test("hide pauses recognition and destroys all local, remote and pending audio content", async () => {
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
  assert.equal(x.nodeList.length, 0);
  assert.equal(x.flyingDanmakus.length, 0);
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
test("legacy rate limiting backs off without locking capture", async () => {
  const x = instance();
  response = 429;
  await x.recognizeAnchor();
  assert.ok(x._nextRecognitionAt >= Date.now() + 59000);
  assert.equal(x._matchedAnchorId, null);
});
for (const code of ["model_queue_full", "model_queue_timeout"]) {
  test(`${code} uses a one-second retry and retains only allowed error diagnostics`, async () => {
    await clocked(async advance => {
      const logs = [];
      const x = instance(logs);
      response = "pending";
      const run = x.recognizeAnchor();
      await flush();
      advance(60);
      pendingUpload.success({
        statusCode: 429,
        header: {
          "X-Recognition-Request-ID": "edge-header-request",
          "X-SB-Edge-Region": "ap-southeast-1", "SB-Request-ID": "platform-trace-123",
          Authorization: "SECRET_RESPONSE_HEADER", "x-private-token": "SECRET_PRIVATE_HEADER",
        },
        data: JSON.stringify({
          error: "模型队列繁忙", code, request_id: "edge-body-request",
          secret: "SECRET_RAW_ERROR_BODY", diagnostics: {
            request_id: "diagnostic-request", upstream_request_id: "eas-request-123",
            edge_region: "ap-southeast-1", model_device: "cuda:0", model_code: code,
            upstream_status: 429, token: "SECRET_DIAGNOSTIC_TOKEN", embedding: ["SECRET_VECTOR"],
            timings_ms: {
              database_context_ms: 11, database_finalize_ms: 0,
              model_queue_ms: 15, model_decode_ms: 2, model_inference_ms: 7,
              model_service_total_ms: 25, model_request_ms: 30, api_total_ms: 40,
              unknown_stage: "SECRET_UNKNOWN_TIMING",
            },
          },
        }),
      });
      await run;
      assert.equal(x._nextRecognitionAt - Date.now(), 1000);
      assert.equal(x._captureGate.locked, false);
      const rejected = logs.find(e => e.event === "服务端拒绝识别").fields;
      const summary = logs.find(e => e.event === "识别耗时汇总").fields;
      assert.equal(rejected.code, code);
      for (const fields of [rejected, summary]) {
        assert.equal(fields.serverRequestId, "edge-body-request");
        assert.equal(fields.upstreamRequestId, "eas-request-123");
        assert.equal(fields.platformRequestId, "platform-trace-123");
        assert.equal(fields.edgeRegion, "ap-southeast-1");
        assert.equal(fields.modelDevice, "cuda:0");
        assert.equal(fields.modelCode, code);
        assert.equal(fields.upstreamStatus, 429);
      }
      for (const stages of [rejected.timingsMs, summary.serverTimingsMs]) {
        assert.equal(stages.database_context_ms, 11);
        assert.equal(stages.database_finalize_ms, 0);
        assert.equal(stages.model_queue_ms, 15);
        assert.equal(stages.model_decode_ms, 2);
        assert.equal(stages.model_inference_ms, 7);
        assert.equal(stages.model_service_total_ms, 25);
        assert.equal(stages.model_request_ms, 30);
        assert.equal(stages.api_total_ms, 40);
        assert.equal(stages.unknown_stage, undefined);
      }
      assert.equal(summary.transportAndPlatformEstimateMs, 20);
      assert.equal(summary.clientTimingsMs.uploadRoundtripMs, 60);
      assert.doesNotMatch(JSON.stringify(logs), /SECRET_/);
    });
  });
}

test("invalid diagnostic labels and negative or nonnumeric stage times are not forwarded", async () => {
  const logs = [];
  const x = instance(logs);
  response = "pending";
  const run = x.recognizeAnchor();
  await flush();
  pendingUpload.success({ statusCode: 502, header: { "SB-Request-ID": "safe-platform-id" }, data: JSON.stringify({
    error: "模型暂不可用", diagnostics: {
      request_id: "SECRET invalid request label", upstream_request_id: "https://secret.example/token",
      model_device: { token: "SECRET_DEVICE_OBJECT" }, edge_region: "\nSECRET_REGION",
      model_code: "SECRET invalid code", upstream_status: "SECRET_STATUS",
      timings_ms: { database_context_ms: -1, database_finalize_ms: "SECRET_TIME",
        model_inference_ms: 0, raw_response: "SECRET_RAW_RESPONSE" },
    },
  }) });
  await run;
  const summary = logs.find(e => e.event === "识别耗时汇总").fields;
  assert.equal(summary.serverRequestId, null);
  assert.equal(summary.edgeRegion, null);
  assert.equal(summary.platformRequestId, "safe-platform-id");
  assert.equal(summary.modelDevice, undefined);
  assert.equal(summary.modelCode, undefined);
  assert.equal(summary.upstreamStatus, undefined);
  assert.equal(summary.serverTimingsMs.database_context_ms, null);
  assert.equal(summary.serverTimingsMs.database_finalize_ms, null);
  assert.equal(summary.serverTimingsMs.model_inference_ms, 0);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|secret[.]example/);
});

test("successful Edge diagnostics expose database and model stages with safe response trace metadata", async () => {
  const logs = [];
  const x = instance(logs);
  response = "pending";
  const run = x.recognizeAnchor();
  await flush();
  pendingUpload.success({ statusCode: 200,
    header: { "X-SB-Edge-Region": "ap-southeast-1", "SB-Request-ID": "edge-platform-success", Cookie: "SECRET_COOKIE" },
    data: JSON.stringify({ data: {
      ...matched("edge-match"), request_id: "edge-success-request", secret: "SECRET_SUCCESS_BODY",
      diagnostics: {
        upstream_request_id: "eas-success-request", model_device: "cuda:0", upstream_status: 200,
        candidate_count: 2, ready_reference_count: 2, best_similarity: 0.91,
        timings_ms: {
          database_context_ms: 130, database_finalize_ms: 42, model_queue_ms: 8,
          model_decode_ms: 12, model_inference_ms: 230, model_service_total_ms: 252,
          model_request_ms: 300, api_total_ms: 480, raw_body: "SECRET_SUCCESS_TIMING",
        },
      },
    } }),
  });
  await run;
  const diagnostics = logs.find(e => e.event === "匹配诊断").fields;
  const summary = logs.find(e => e.event === "识别耗时汇总").fields;
  for (const fields of [diagnostics, summary]) {
    assert.equal(fields.serverRequestId, "edge-success-request");
    assert.equal(fields.upstreamRequestId, "eas-success-request");
    assert.equal(fields.platformRequestId, "edge-platform-success");
    assert.equal(fields.edgeRegion, "ap-southeast-1");
    assert.equal(fields.modelDevice, "cuda:0");
    assert.equal(fields.upstreamStatus, 200);
  }
  for (const stages of [diagnostics.timingsMs, summary.serverTimingsMs]) {
    assert.equal(stages.database_context_ms, 130);
    assert.equal(stages.database_finalize_ms, 42);
    assert.equal(stages.model_queue_ms, 8);
    assert.equal(stages.model_decode_ms, 12);
    assert.equal(stages.model_inference_ms, 230);
    assert.equal(stages.model_service_total_ms, 252);
    assert.equal(stages.raw_body, undefined);
  }
  assert.equal(summary.outcome, "matched_locked");
  assert.equal(x._matchedAnchorId, "edge-match");
  assert.doesNotMatch(JSON.stringify(logs), /SECRET_/);
});

for (const statusCode of [502, 504]) {
  test(`${statusCode} honors a structured two-second retry without resuming before the deadline`, async () => {
    const previous = config.errorRetryMs;
    config.errorRetryMs = 5000;
    try {
      await clocked(async advance => {
        const x = instance();
        response = "pending";
        const run = x.recognizeAnchor();
        await flush();
        pendingUpload.success({ statusCode, data: JSON.stringify({
          error: "模型暂不可用", code: statusCode === 504 ? "model_timeout" : "model_network_error", retry_after_ms: 2000,
        }) });
        await run;
        assert.equal(x._nextRecognitionAt - Date.now(), 2000);
        uploaded = null;
        advance(1999);
        await x.recognizeAnchor();
        assert.equal(uploaded, null);
        advance(1);
        response = miss();
        await x.recognizeAnchor();
        assert.ok(uploaded);
        assert.equal(x._captureGate.locked, false);
      });
    } finally { config.errorRetryMs = previous; }
  });
}

test("non-429 retry values are bounded and invalid or absent values keep the ordinary five-second delay", async () => {
  const previous = config.errorRetryMs;
  config.errorRetryMs = 5000;
  try {
    const cases = [
      [0.5, 1000], [500, 1000], [2000, 2000], [60000, 60000], [120000, 60000],
      [0, 5000], [-5, 5000], ["2000", 5000], [null, 5000], [undefined, 5000],
    ];
    for (const [retryAfterMs, expected] of cases) {
      await clocked(async () => {
        const x = instance();
        response = "pending";
        const run = x.recognizeAnchor();
        await flush();
        pendingUpload.success({ statusCode: 502, data: JSON.stringify({ error: "服务暂不可用", retry_after_ms: retryAfterMs }) });
        await run;
        assert.equal(x._nextRecognitionAt - Date.now(), expected, `retry_after_ms=${retryAfterMs}`);
      });
    }
  } finally { config.errorRetryMs = previous; }
});

test("structured retries from cancelled or superseded uploads cannot restart a paused or matched session", async () => {
  await clocked(async advance => {
    const paused = instance();
    response = "pending";
    const pending = paused.recognizeAnchor();
    await flush();
    const cancelledUpload = pendingUpload;
    paused.pauseRetrieval();
    const pausedNextAt = paused._nextRecognitionAt;
    cancelledUpload.success({ statusCode: 504, data: JSON.stringify({ error: "timeout", retry_after_ms: 2000 }) });
    await pending;
    assert.equal(paused._nextRecognitionAt, pausedNextAt);
    uploaded = null;
    advance(10000);
    await paused.recognizeAnchor();
    assert.equal(uploaded, null);

    const locked = instance();
    const first = locked.recognizeAnchor();
    await flush();
    const older = pendingUpload;
    const second = locked.recognizeAnchor();
    await flush();
    reply(pendingUpload, matched("winner"));
    await second;
    older.success({ statusCode: 502, data: JSON.stringify({ error: "unavailable", retry_after_ms: 2000 }) });
    await first;
    assert.equal(locked._nextRecognitionAt, Infinity);
    assert.equal(locked._matchedAnchorId, "winner");
    assert.equal(locked.displayed.length, 1);
    uploaded = null;
    advance(10000);
    await locked.recognizeAnchor();
    assert.equal(uploaded, null);
  });
});

test("invalid API payload fails closed", async () => {
  const x = instance();
  response = { unexpected: true };
  await x.recognizeAnchor();
  assert.equal(x.displayed.length, 0);
  assert.match(x.statuses.at(-1), /格式异常/);
});
test("unmatched diagnostics log scores without displaying AR or leaking payload fields", async () => {
  const logs = [];
  const x = instance(logs);
  response = {
    matched: false, reason: "below_threshold", anchor: null, assets: [],
    diagnostics: { candidate_count: 1, ready_reference_count: 1, threshold: 0.8,
      required_margin: 0.03, best_similarity: 0, second_similarity: null, score_gap: null,
      best_distance_meters: 12, embedding: ["secret-vector"],
      timings_ms: { model_request_ms: 1500, api_total_ms: 2000, token: "secret-token" } },
  };
  await x.recognizeAnchor();
  const d = logs.find(entry => entry.event === "匹配诊断").fields;
  assert.equal(d.bestSimilarity, 0);
  assert.equal(d.threshold, 0.8);
  assert.equal(d.secondSimilarity, null);
  assert.equal(d.timingsMs.model_request_ms, 1500);
  assert.equal(d.timingsMs.assets_read_ms, null);
  assert.equal(x.displayed.length, 0);
  assert.equal(x._matchedAnchorId, null);
  assert.doesNotMatch(JSON.stringify(logs), /secret-vector|secret-token/);
});
test("timing summary separates GPS, capture, HTTP, server and display dispatch without counting nested totals twice", async () => {
  await clocked(async advance => {
    const logs = [];
    const x = instance(logs, {
      captureCamera: async (_scene, onInfo) => {
        advance(120);
        onInfo({ rawReadMs: 10, snapshotMs: 2, canvasPrepareMs: 3,
          convertMs: 60, convertWorkMs: 22, convertYieldWaitMs: 38, maxConvertSliceMs: 4, convertSliceCount: 30,
          pixelConverter: "cpu", gpuInitMs: 2, gpuAttemptMs: 0, gpuUploadMs: null, gpuDrawReadMs: null, gpuFallbackReason: "webgl_unavailable",
          canvasWriteMs: 5, jpegExportMs: 20 });
        return "/tmp/timed-frame.jpg";
      },
    });
    x._locateForRecognition = async () => {
      advance(12);
      return { latitude: 31, longitude: 121, accuracy: 10, sampledAt: Date.now() };
    };
    const clear = x._clearRemoteAssets;
    x._clearRemoteAssets = function () { advance(7); clear.call(this); };
    x.displayAssets = function (assets) { advance(3); this.displayed.push(assets); };
    response = "pending";
    const run = x.recognizeAnchor();
    await flush();
    advance(2000);
    reply(pendingUpload, { ...matched("timed-anchor"), diagnostics: { timings_ms: {
      request_parse_ms: 10, gps_query_ms: 200, reference_read_ms: 250,
      model_request_ms: 1200, matching_total_ms: 1790, api_total_ms: 1800,
      secret: "unlisted-server-field",
    } } });
    await run;
    const entry = logs.find(e => e.event === "识别耗时汇总");
    const summary = entry.fields;
    assert.equal(summary.gpsSource, "fresh");
    assert.equal(summary.httpStatus, 200);
    assert.equal(summary.clientTimingsMs.gpsMs, 12);
    assert.equal(summary.clientTimingsMs.captureMs, 120);
    assert.equal(summary.clientTimingsMs.uploadRoundtripMs, 2000);
    assert.equal(summary.clientTimingsMs.responseParseMs, 0);
    assert.equal(summary.clientTimingsMs.sceneClearMs, 7);
    assert.equal(summary.clientTimingsMs.displayDispatchMs, 3);
    assert.equal(summary.clientTimingsMs.resultHandlingMs, 10);
    assert.equal(summary.clientTimingsMs.totalMs, 2142);
    assert.equal(summary.captureToMatchMs, 2120);
    assert.equal(summary.captureStagesMs.maxConvertSliceMs, 4);
    assert.equal(summary.captureStagesMs.convertMs, 60);
    assert.equal(summary.captureStagesMs.convertWorkMs, 22);
    assert.equal(summary.captureStagesMs.convertYieldWaitMs, 38);
    assert.equal(summary.pixelConverter, "cpu");
    assert.equal(summary.gpuFallbackReason, "webgl_unavailable");
    assert.equal(summary.captureStagesMs.gpuInitMs, 2);
    assert.equal(summary.captureStagesMs.gpuUploadMs, null);
    assert.equal(summary.serverTimingsMs.model_request_ms, 1200);
    assert.equal(summary.serverTimingsMs.assets_read_ms, null);
    assert.equal(summary.transportAndPlatformEstimateMs, 200);
    assert.equal(x._recognitionTiming.requestId, entry.requestId);
    assert.equal(x._recognitionTiming.contentEpoch, x._contentEpoch);
    assert.equal(x._recognitionTiming.matchedAt - x._recognitionTiming.captureStartedAt, 2120);
    assert.doesNotMatch(JSON.stringify(logs), /unlisted-server-field/);
  });
});

test("cadence logs distinguish the one-second target from actual capture spacing and cached GPS", async () => {
  assert.equal(require(path.join(root, componentPath, "matching/config.js")).intervalMs, 1000);
  config.intervalMs = 1000;
  try {
    await clocked(async advance => {
      const logs = [];
      const x = instance(logs);
      response = miss();
      await x.recognizeAnchor();
      advance(1200);
      await x.recognizeAnchor();
      const starts = logs.filter(e => e.event === "开始取图");
      assert.equal(starts.length, 2);
      assert.equal(starts[0].fields.actualCaptureIntervalMs, null);
      assert.equal(starts[1].fields.targetIntervalMs, 1000);
      assert.equal(starts[1].fields.actualCaptureIntervalMs, 1200);
      assert.equal(starts[1].fields.intervalOverrunMs, 200);
      const summaries = logs.filter(e => e.event === "识别耗时汇总");
      assert.equal(summaries[1].fields.gpsSource, "cache");
      assert.equal(summaries[1].fields.transportAndPlatformEstimateMs, null);
      assert.equal(summaries[1].fields.serverTimingsMs, null);
    });
  } finally { config.intervalMs = 0; }
});

test("failed capture records partial elapsed time and leaves unexecuted stages null", async () => {
  await clocked(async advance => {
    const logs = [];
    const x = instance(logs, { captureCamera: async () => { advance(17); throw new Error("capture failed"); } });
    x._locateForRecognition = async () => {
      advance(10);
      return { latitude: 31, longitude: 121, accuracy: 10, sampledAt: Date.now() };
    };
    await x.recognizeAnchor();
    const summary = logs.find(e => e.event === "识别耗时汇总").fields;
    assert.equal(summary.outcome, "error");
    assert.equal(summary.phase, "capture");
    assert.equal(summary.clientTimingsMs.gpsMs, 10);
    assert.equal(summary.clientTimingsMs.captureMs, 17);
    assert.equal(summary.clientTimingsMs.totalMs, 27);
    assert.equal(summary.clientTimingsMs.uploadRoundtripMs, null);
    assert.equal(summary.clientTimingsMs.displayDispatchMs, null);
    assert.equal(summary.captureStagesMs.convertMs, null);
    assert.equal(summary.serverTimingsMs, null);
    assert.equal(summary.captureToMatchMs, null);
  });
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
function realAssetMethods() {
  const noop = () => ({});
  return load(componentPath + "assets/index.js", {
    "../../../utils/supabase": { CONFIG: {} },
    "./queue": noop, "./audio": noop, "./text": {}, "./model": {}, "./image": {}, "./video": {},
  })(require(path.join(root, componentPath, "config.js")));
}

test("both mode switches clear all scene nodes, media, queues and confirmation before fetching", () => {
  for (const from of ["gps", "anchor"]) {
    const x = instance();
    x.retrievalMode = from;
    x.nodeList = [{ assetId: "remote" }, { assetId: null, type: "model" }, { assetId: null, type: "danmaku" }];
    x.flyingDanmakus = [{}];
    x._hugeNodeList = [{ node: "huge" }];
    x._pendingDisplayAssets = [{ id: "old" }];
    x._placeQueue = [{ id: "old" }];
    x._pendingHugeAssets = [{}];
    x._hugePlaceQueue = [{}];
      x._matchedAnchorId = "old-anchor";
    const deleted = [];
    x.shadowRoot = { removeChild(node) { deleted.push(node); } };
    let stopped = false;
    x.stopRandomConfetti = () => { stopped = true; };
    const checkCleared = () => {
      for (const key of ["nodeList", "flyingDanmakus", "_hugeNodeList", "_pendingDisplayAssets", "_placeQueue", "_pendingHugeAssets", "_hugePlaceQueue"]) {
        assert.equal(x[key].length, 0, key);
      }
      assert.equal(x._matchedAnchorId, null);
      assert.equal(x._matchedAnchorId, null);
      assert.ok(stopped);
    };
    x.recognizeAnchor = checkCleared;
    x.fetchNearbyAssets = checkCleared;
    const to = from === "gps" ? "anchor" : "gps";
    x.setRetrievalMode(to);
    assert.equal(x.data.retrievalMode, to);
    assert.ok(deleted.includes("huge"));
    checkCleared();
  }
});

test("confirmed anchor reuses the existing display pipeline and rejects unconfirmed or unrelated assets", async () => {
  const x = instance();
  const methods = realAssetMethods();
  x.displayAssets = methods.displayAssets;
  x._preloadDone = true;
  x._isInRepeatCooldown = () => false;
  x._pickRevealBatch = a => a;
  const batches = [];
  x._enqueueDisplayAssets = a => batches.push(a);
  const child = { id: "child", file_type: "model", is_huge: true, config: { scale_multiplier: 3 } };
  x.displayAssets([child]);
  assert.equal(batches.length, 0);
  response = matched("a", [child, { id: "anchor", file_type: "anchor" }]);
  await x.recognizeAnchor();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].config.scale_multiplier, 3);
  assert.equal(batches[0][0].is_huge, true);
  x.displayAssets([{ id: "unrelated", file_type: "image" }]);
  assert.equal(batches.length, 1);
  x.displayAssets([{ ...child, _contentEpoch: x._contentEpoch - 1 }]);
  assert.equal(batches.length, 1);
});

test("preload completion after a mode switch cannot revive queued GPS content", () => {
  const x = instance();
  const methods = realAssetMethods();
  x.displayAssets = methods.displayAssets;
  x.flushPendingDisplayAssets = methods.flushPendingDisplayAssets;
  x.retrievalMode = "gps";
  x.displayAssets([{ id: "old-gps", file_type: "image" }]);
  assert.equal(x._pendingDisplayAssets.length, 1);
  x.recognizeAnchor = () => {};
  x.setRetrievalMode("anchor");
  x._preloadDone = true;
  x._enqueueDisplayAssets = () => { throw new Error("stale preload rendered"); };
  x.flushPendingDisplayAssets();
  assert.equal(x._pendingDisplayAssets.length, 0);
});

test("an image finishing after switching away and back releases its texture without attaching a node", async () => {
  const x = instance();
  x._isAssetPlacementCurrent = realAssetMethods()._isAssetPlacementCurrent;
  x._matchedAnchorId = "a";
  x._allowedAssetIds.add("same");
  x.nodeIdCounter = 0;
  let finishLoad;
  const released = [];
  x.scene = {
    createElement() { throw new Error("stale image attached"); },
    assets: { releaseAsset(type, id) { released.push([type, id]); } },
  };
  global.wx.getStorageSync = () => ({ width: 100, height: 100 });
  x._loadImageTexture = () => new Promise(resolve => { finishLoad = resolve; });
  const image = load(componentPath + "assets/image.js");
  const run = image._placeImageAsset.call(x, { id: "same", file_url: "image.jpg", _contentEpoch: 0 });
  x.setRetrievalMode("gps");
  x.recognizeAnchor = () => {};
  x.setRetrievalMode("anchor");
  x._matchedAnchorId = "a";
  x._allowedAssetIds.add("same");
  finishLoad();
  await run;
  assert.deepEqual(released, [["texture", "image-tex-0"]]);
});

test("an obsolete video releases its decoder before material or scene creation", async () => {
  const x = instance();
  x._isAssetPlacementCurrent = realAssetMethods()._isAssetPlacementCurrent;
  x._matchedAnchorId = "a";
  x._allowedAssetIds.add("video");
  x.nodeIdCounter = 0;
  let finishLoad;
  const released = [];
  x.scene = { assets: {
    loadAsset() { return new Promise(resolve => { finishLoad = resolve; }); },
    getAsset() { throw new Error("stale video created material"); },
    releaseAsset(type, id) { released.push([type, id]); },
  } };
  const video = load(componentPath + "assets/video.js", { "../effects/transparent-video-tbb": {} });
  const run = video._placeVideoAsset.call(x, { id: "video", file_url: "video.mp4", _contentEpoch: 0 });
  x.setRetrievalMode("gps");
  finishLoad({ value: {} });
  await run;
  assert.deepEqual(released, [["video-texture", "video-tbb-0"]]);
});

for (const switchAt of ["download", "gpu-yield"]) {
  test(`model cancelled during ${switchAt} cannot reappear after a mode switch`, async () => {
    const x = instance();
    const frames = [];
    const model = load(componentPath + "assets/model.js", {}, { setTimeout: cb => frames.push(cb) });
    const queue = load(componentPath + "assets/queue.js")({});
    x._isAssetPlacementCurrent = realAssetMethods()._isAssetPlacementCurrent;
    x._registerNode = queue._registerNode;
    x._destroyNode = queue._destroyNode;
    x._enforceCapacity = () => {};
    x._wouldSurvive = () => true;
    x._calcForwardPos = () => ({ x: 0, y: 0, z: 2 });
    x._matchedAnchorId = "a";
    x._allowedAssetIds.add("model");
    x.nodeIdCounter = 0;
    const attached = new Set();
    x.shadowRoot = { addChild: node => attached.add(node), removeChild: node => attached.delete(node) };
    let finishLoad;
    let created = 0;
    const xr = { Transform: "Transform", GLTF: "GLTF", XRNode: "node", XRGLTF: "gltf" };
    global.wx.getXrFrameSystem = () => xr;
    x.scene = {
      assets: { loadAsset: () => new Promise(resolve => { finishLoad = resolve; }) },
      createElement() {
        created++;
        const trs = { position: {}, scale: { setValue() {} } };
        return { addChild() {}, getComponent(type) {
          if (type === "Transform") return trs;
          if (type === "GLTF") return { setData() {}, calcTotalBoundBox() { throw new Error("stale model touched after yield"); } };
          return null;
        } };
      },
    };
    const run = model._placeModelAsset.call(x, { id: "model", file_url: "model.glb", _contentEpoch: 0 });
    if (switchAt === "gpu-yield") {
      finishLoad({ value: {} });
      await flush();
      frames.shift()();
      await flush();
      assert.equal(attached.size, 1);
      assert.equal(x.nodeList.length, 1);
    }
    x.setRetrievalMode("gps");
    assert.equal(attached.size, 0);
    x.recognizeAnchor = () => {};
    x.setRetrievalMode("anchor");
    x._matchedAnchorId = "a";
    x._allowedAssetIds.add("model");
    if (switchAt === "download") {
      finishLoad({ value: {} });
      await flush();
    }
    frames.shift()();
    await run;
    assert.equal(attached.size, 0);
    assert.equal(x.nodeList.length, 0);
    if (switchAt === "download") assert.equal(created, 0);
  });
}

test("explicit placement generation rejects stale registration even if component generation advanced", () => {
  instance();
  const queue = load(componentPath + "assets/queue.js")({});
  const x = { _contentEpoch: 2, _activePlacementEpoch: 2, _allowedAssetIds: new Set(["same"]),
    retrievalMode: "anchor", _matchedAnchorId: "a", nodeList: [], _destroyNode() {}, _enforceCapacity() {} };
  queue._registerNode.call(x, "same", null, null, { type: "model", contentEpoch: 0 });
  queue._registerNode.call(x, null, null, null, { type: "danmaku" });
  assert.equal(x.nodeList.length, 0);
  queue._registerNode.call(x, "same", null, null, { type: "model", contentEpoch: 2 });
  assert.equal(x.nodeList.length, 1);
});

test("anchor mode suppresses tap-to-plant and local danmaku while GPS trees are registered for cleanup", () => {
  instance();
  let component;
  global.Component = c => { component = c; };
  const noop = () => ({});
  load(componentPath + "index.js", {
    "./preload": {}, "./gps": {}, "./navigation": {}, "./matching/index": {},
    "../../utils/supabase": { CONFIG: {} }, "../common/share-behavior": { default: {} },
    "./assets/index": noop, "./assets/huge": noop, "./effects/danmaku": noop,
    "./effects/repulsion": noop, "./effects/confetti": noop,
  });
  delete global.Component;
  const methods = component.methods;
  const x = { retrievalMode: "anchor", scene: { event: { addOnce() {} }, createElement() { throw new Error("unexpected tree"); } }, placeNode: methods.placeNode };
  methods.placeNode.call(x);
  const danmaku = load(componentPath + "effects/danmaku.js")({});
  danmaku.showDanmakuInXR.call(x, "test");
  const element = { getComponent() { return { setData() {}, scale: { setValue() {} } }; } };
  let registered;
  x.retrievalMode = "gps";
  x.scene.createElement = () => element;
  x.scene.ar = { placeHere() {} };
  x.shadowRoot = { addChild() {} };
  x._registerNode = (id, node) => { registered = node; };
  methods.placeNode.call(x);
  assert.equal(registered, element);
});

test("preview keeps the exact completed upload and cleans replacement, cancellation and disposal", async () => {
  config.debugFramePreview = true;
  try {
    removed = [];
    capturePath = "/tmp/first-preview.jpg";
    const x = instance();
    response = { matched: false, reason: "below_threshold", anchor: null, assets: [], diagnostics: { best_similarity: 0.268, threshold: 0.8 } };
    await x.recognizeAnchor();
    assert.equal(x._recognitionFrame.path, uploaded.filePath);
    assert.equal(x._recognitionFrame.bestSimilarity, 0.268);
    assert.equal(x._recognitionFrame.width, 640);
    assert.equal(x._recognitionFrame.height, 360);
    assert.ok(!removed.includes(capturePath));
    const firstFrame = x._recognitionFrame;
    x.pauseRetrieval();
    assert.equal(x._recognitionFrame, firstFrame);
    x._retrievalPaused = false;
    capturePath = "/tmp/second-preview.jpg";
    await x.recognizeAnchor();
    assert.ok(removed.includes(firstFrame.path));
    assert.equal(x._recognitionFrame.path, uploaded.filePath);
    assert.ok(!removed.includes(capturePath));
    capturePath = "/tmp/cancelled-preview.jpg";
    response = "pending";
    const inFlight = x.recognizeAnchor();
    await flush();
    x.pauseRetrieval();
    await inFlight;
    assert.ok(removed.includes(capturePath));
    assert.equal(x._recognitionFrame.path, "/tmp/second-preview.jpg");
    assert.equal(x.frames.filter(frame => frame.path).length, 2);
    x._disposed = true;
    x.clearRecognitionFrame();
    assert.ok(removed.includes("/tmp/second-preview.jpg"));
    assert.equal(x._recognitionFrame, null);
  } finally {
    config.debugFramePreview = false;
    capturePath = "/tmp/frame.jpg";
  }
});
test("turning off frame preview preserves immediate temporary-file cleanup", async () => {
  config.debugFramePreview = false;
  removed = [];
  const x = instance();
  response = matched();
  await x.recognizeAnchor();
  assert.equal(x._recognitionFrame, undefined);
  assert.ok(removed.includes(uploaded.filePath));
});
test("clockwise portrait correction preserves all pixels of a landscape camera frame", () => {
  const { convertFrame } = load(componentPath + "matching/capture.js");
  const raw = { width: 4, height: 2,
    yBuffer: Uint8Array.from([10,20,30,40,50,60,70,80]).buffer,
    uvBuffer: Uint8Array.from([128,128,128,128]).buffer };
  const corrected = convertFrame(raw);
  assert.equal(corrected.width, 2);
  assert.equal(corrected.height, 4);
  const pixels = Array.from(corrected.data).filter((_, i) => i % 4 === 0);
  assert.deepEqual(pixels, [50,10,60,20,70,30,80,40]);
});
test("YUV neutral pixels, rotation and malformed layout", () => {
  const { convertFrame } = load(componentPath + "matching/capture.js");
  const raw = {
    width: 2,
    height: 2,
    yBuffer: Uint8Array.from([0, 64, 128, 255]).buffer,
    uvBuffer: Uint8Array.from([128, 128]).buffer,
  };
  const a = convertFrame(raw, { rotation: 0 });
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

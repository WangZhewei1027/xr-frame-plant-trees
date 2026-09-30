const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const filename = path.resolve(__dirname, "../miniprogram/components/xr-start/assets/index.js");
const tests = [];
const test = (name, run) => tests.push([name, run]);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness() {
  const clock = { now: 1000 };
  const logs = [];
  const timers = [];
  const placements = [];
  const pending = new Map();
  const warnings = [];
  class ClockDate extends Date { static now() { return clock.now; } }
  const module = { exports: {} };
  const dependencies = {
    "../../../utils/supabase": { CONFIG: {} },
    "./queue": () => ({}), "./audio": () => ({}),
    "./text": {}, "./model": {}, "./image": {}, "./video": {},
    "../matching/log": (event, fields, level, requestId) => logs.push({ event, fields, level, requestId }),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected dependency ${id}`);
      return dependencies[id];
    },
    Date: ClockDate, Set, Map, Number,
    console: { ...console, warn: (...args) => warnings.push(args) },
    setTimeout(callback, delay) { timers.push({ callback, delay, due: clock.now + delay }); },
  }, { filename });
  const methods = module.exports({ placeStaggerMs: 40, revealFirstFetch: 6 });
  const timing = {
    requestId: "capture-1", startedAt: 100, captureStartedAt: 200,
    matchedAt: 1000, contentEpoch: 0, anchorId: "anchor-1",
  };
  const instance = {
    ...methods,
    retrievalMode: "anchor", _contentEpoch: 0,
    _matchedAnchorId: timing.anchorId, _recognitionTiming: timing,
    _allowedAssetIds: new Set(["image", "model"]), nodeList: [],
    _preloadDone: true, _placeQueue: [],
    _isInRepeatCooldown: () => false, _pickRevealBatch: (assets) => assets,
  };
  const place = (asset) => new Promise((resolve, reject) => {
    placements.push({ id: asset.id, at: clock.now });
    pending.set(asset.id, {
      resolve({ register = true, destroyed = false } = {}) {
        if (register) instance.nodeList.push({ assetId: asset.id, node: {}, _destroyed: destroyed });
        resolve();
      },
      reject,
    });
  });
  instance._placeImageAsset = place;
  instance._placeModelAsset = place;
  const originalDrain = instance._drainPlaceQueue;
  instance._drainPlaceQueue = function () {
    this.drainPromise = originalDrain.call(this);
    return this.drainPromise;
  };
  const asset = (id = "image", file_type = "image") => ({ id, file_type, _contentEpoch: 0 });
  async function nextTimer() {
    await flush();
    assert.ok(timers.length, "expected the unchanged placement stagger timer");
    const timer = timers.shift();
    clock.now = Math.max(clock.now, timer.due);
    timer.callback();
    await flush();
    return timer;
  }
  return { instance, timing, clock, logs, placements, pending, timers, warnings, asset, nextTimer };
}

function events(context, event) { return context.logs.filter((log) => log.event === event); }
function end(context) {
  const entries = events(context, "素材放置结束");
  assert.equal(entries.length, 1);
  return entries[0];
}
async function completeOne(context, options) {
  context.clock.now = 1450;
  context.pending.get("image").resolve(options);
  await flush();
  await context.nextTimer();
  await context.instance.drainPromise;
}
function startOne(context) {
  context.clock.now = 1200;
  context.instance.displayAssets([context.asset()]);
  assert.equal(context.placements.length, 1);
}

test("preload waiting and serial asynchronous placement report exact per-asset and first-ready times", async () => {
  const context = harness();
  const { instance, timing, clock, logs, placements, pending, asset } = context;
  instance._preloadDone = false;
  clock.now = 1500;
  instance.displayAssets([asset(), asset("model", "model")]);
  assert.equal(logs.length, 0, "preload waiting must not claim placement started");
  assert.equal(placements.length, 0);
  clock.now = 1800;
  instance._preloadDone = true;
  instance.flushPendingDisplayAssets();
  assert.deepEqual(placements, [{ id: "image", at: 1800 }]);
  const firstStart = events(context, "素材开始放置")[0];
  assert.equal(firstStart.requestId, timing.requestId);
  assert.equal(firstStart.fields.queueWaitMs, 800, "wait begins at match, including preload");
  assert.equal(events(context, "素材放置结束").length, 0, "pending promise is not ready");
  clock.now = 2100;
  pending.get("image").resolve();
  await flush();
  const firstEnd = events(context, "素材放置结束")[0];
  assert.equal(firstEnd.fields.outcome, "ready");
  assert.equal(firstEnd.fields.placementMs, 300);
  assert.equal(firstEnd.fields.matchToAssetReadyMs, 1100);
  assert.equal(firstEnd.fields.captureToAssetReadyMs, 1900);
  assert.equal(firstEnd.fields.totalMs, 2000);
  assert.equal(placements.length, 1, "second asset still waits for existing stagger");
  const first = events(context, "首个素材就绪")[0];
  assert.equal(first.fields.readiness, "placement_complete");
  assert.equal(first.fields.screenFirstFrameMeasured, false);
  assert.equal(first.fields.assetId, "image");
  const stagger = await context.nextTimer();
  assert.equal(stagger.delay, 40);
  assert.deepEqual(placements[1], { id: "model", at: 2140 });
  assert.equal(events(context, "素材开始放置")[1].fields.queueWaitMs, 1140);
  clock.now = 2520;
  pending.get("model").resolve();
  await flush();
  const secondEnd = events(context, "素材放置结束")[1];
  assert.equal(secondEnd.fields.placementMs, 380);
  assert.equal(secondEnd.fields.matchToAssetReadyMs, 1520);
  assert.equal(secondEnd.fields.captureToAssetReadyMs, 2320);
  assert.equal(secondEnd.fields.totalMs, 2420);
  assert.equal(events(context, "首个素材就绪").length, 1);
  assert.ok(logs.every((entry) => entry.requestId === timing.requestId));
  assert.equal((await context.nextTimer()).delay, 120, "model stagger is unchanged");
  await instance.drainPromise;
  assert.equal(instance._placingBusy, false);
});

for (const [name, mutate] of [
  ["clear", (context) => {
    context.instance._recognitionTiming = null;
    context.instance._contentEpoch++;
    context.instance._allowedAssetIds.clear();
    context.instance._matchedAnchorId = null;
  }],
  ["a different timing object with the same anchor and epoch", (context) => {
    context.instance._recognitionTiming = { ...context.timing, requestId: "capture-2" };
  }],
  ["GPS mode switch", (context) => { context.instance.retrievalMode = "gps"; }],
  ["pause", (context) => { context.instance._retrievalPaused = true; }],
  ["dispose", (context) => { context.instance._disposed = true; }],
]) {
  test(`placement completing after ${name} reports cancellation, never success`, async () => {
    const context = harness();
    startOne(context);
    mutate(context);
    // Even if a stale placer incorrectly registers a node, the timing must not claim success.
    await completeOne(context);
    const log = end(context);
    assert.equal(log.requestId, "capture-1");
    assert.equal(log.fields.outcome, "cancelled");
    assert.equal(log.fields.placementMs, 250);
    assert.equal(log.fields.matchToAssetReadyMs, null);
    assert.equal(log.fields.captureToAssetReadyMs, null);
    assert.equal(events(context, "首个素材就绪").length, 0);
  });
}

for (const [name, options] of [
  ["no registered node", { register: false }],
  ["a destroyed registered node", { destroyed: true }],
]) {
  test(`normal return with ${name} is skipped, not ready`, async () => {
    const context = harness();
    startOne(context);
    await completeOne(context, options);
    assert.equal(end(context).fields.outcome, "skipped");
    assert.equal(end(context).fields.matchToAssetReadyMs, null);
    assert.equal(events(context, "首个素材就绪").length, 0);
  });
}

test("an older registered entry with the same asset id cannot manufacture a new placement success", async () => {
  const context = harness();
  context.instance.nodeList.push({ assetId: "image", node: {} });
  context.clock.now = 1200;
  // Directly exercise an already queued duplicate; displayAssets normally deduplicates it.
  context.instance._enqueueDisplayAssets([context.asset()]);
  await completeOne(context, { register: false });
  assert.equal(end(context).fields.outcome, "skipped");
});

test("placement rejection reports an error with elapsed times and no ready event", async () => {
  const context = harness();
  startOne(context);
  context.clock.now = 1550;
  context.pending.get("image").reject(new Error("test download failure"));
  await flush();
  assert.equal(end(context).fields.outcome, "error");
  assert.equal(end(context).fields.placementMs, 350);
  assert.equal(end(context).fields.totalMs, 1450);
  assert.equal(end(context).level, "warn");
  assert.equal(events(context, "首个素材就绪").length, 0);
  assert.equal(context.warnings.length, 1);
  await context.nextTimer();
  await context.instance.drainPromise;
});

test("missing capture timestamp is represented as null without losing match and total times", async () => {
  const context = harness();
  delete context.timing.captureStartedAt;
  startOne(context);
  await completeOne(context);
  assert.equal(end(context).fields.outcome, "ready");
  assert.equal(end(context).fields.captureToAssetReadyMs, null);
  assert.equal(end(context).fields.matchToAssetReadyMs, 450);
  assert.equal(end(context).fields.totalMs, 1350);
});

test("GPS-originated placement stays silent even if old recognition timing remains", async () => {
  const context = harness();
  context.instance.retrievalMode = "gps";
  startOne(context);
  await completeOne(context);
  assert.equal(context.logs.length, 0);
});

(async () => {
  for (const [name, run] of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`${tests.length} asset timing regression checks passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

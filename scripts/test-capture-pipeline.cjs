const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const filename = path.resolve(__dirname, "../miniprogram/components/xr-start/matching/capture.js");
const source = fs.readFileSync(filename, "utf8");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const sleep = () => new Promise(resolve => setTimeout(resolve, 1));

async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await sleep();
  }
  throw new Error("Timed out waiting for the mocked capture pipeline");
}

function rawFrame() {
  const width = 64, height = 64;
  const y = new Uint8Array(width * height);
  const uv = new Uint8Array(width * height / 2);
  for (let i = 0; i < y.length; i++) y[i] = (i * 7 + 31) % 256;
  for (let i = 0; i < uv.length; i++) uv[i] = (i * 3 + 70) % 256;
  return { width, height, yBuffer: y.buffer, uvBuffer: uv.buffer };
}

function harness(options = {}) {
  const raw = options.raw || rawFrame();
  const state = {
    rawReads: 0, canvases: [], imageData: [], writes: [], exports: [], removed: [],
    timers: new Set(), canvasYields: 0,
  };
  const scene = { ar: { getARRawData() {
    state.rawReads++;
    options.onRaw?.(raw);
    return raw;
  } } };
  const wx = {
    createOffscreenCanvas({ type, width, height }) {
      if (type === "webgl") {
        state.gpuAttempts = (state.gpuAttempts || 0) + 1;
        throw new Error("WebGL is unavailable in this CPU harness");
      }
      const canvas = { width, height };
      const ctx = {
        createImageData(w, h) {
          options.onCreateImageData?.();
          const pixels = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          state.imageData.push(pixels);
          return pixels;
        },
        putImageData(pixels) {
          state.writes.push(new Uint8ClampedArray(pixels.data));
        },
      };
      canvas.getContext = type => {
        assert.equal(type, "2d");
        return ctx;
      };
      state.canvases.push(canvas);
      return canvas;
    },
    canvasToTempFilePath(request) { state.exports.push(request); },
    getFileSystemManager() {
      return { unlink({ filePath }) { state.removed.push(filePath); } };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, wx, console, Uint8Array, Uint8ClampedArray,
    WeakMap, Date, Promise,
    require(id) {
      if (id === "./config") return { rotation: 90, uvOrder: "uv", maxImageEdge: 640, pixelConverter: "cpu", ...options.config };
      if (id === "./log") return () => {};
      throw new Error(`Unexpected require: ${id}`);
    },
    setTimeout(callback, delay = 0) {
      if (delay === 5000) {
        const timer = { callback };
        state.timers.add(timer);
        return timer;
      }
      return setTimeout(() => {
        if (state.imageData.length && !state.exports.length) {
          state.canvasYields++;
          options.onCanvasYield?.(state.canvasYields, state);
        }
        callback();
      }, delay);
    },
    clearTimeout(timer) {
      if (!state.timers.delete(timer)) clearTimeout(timer);
    },
  }, { filename });
  return {
    ...module.exports, raw, scene, state,
    expireExport() {
      assert.equal(state.timers.size, 1);
      const [timer] = state.timers;
      state.timers.delete(timer);
      timer.callback();
    },
  };
}

test("actual capture yields between conversion slices and preserves 90-degree UV pixels", async () => {
  let heartbeat = false;
  const h = harness({ onCanvasYield(count) { if (count === 2) heartbeat = true; } });
  const expected = h.convertFrame(h.raw);
  let info;
  const capture = h.captureCamera(h.scene, value => { info = value; });
  assert.equal(h.isCaptureBusy(h.scene), true);
  assert.equal(h.state.rawReads, 0, "capture must first return control to the event loop");
  await until(() => h.state.exports.length === 1);
  assert.equal(heartbeat, true);
  assert.deepEqual(h.state.writes[0], expected.data);
  h.state.exports[0].success({ tempFilePath: "/tmp/async-frame.jpg" });
  assert.equal(await capture, "/tmp/async-frame.jpg");
  assert.ok(info.convertSliceCount >= 4);
  for (const key of ["rawReadMs", "snapshotMs", "canvasPrepareMs", "geometryPrepareMs", "convertMs", "convertWorkMs", "convertYieldWaitMs", "maxConvertSliceMs", "canvasWriteMs", "jpegExportMs"]) {
    assert.ok(Number.isFinite(info[key]) && info[key] >= 0, `${key} must be recorded`);
  }
  assert.equal(info.convertMs, info.convertWorkMs + info.convertYieldWaitMs);
  assert.ok(info.convertYieldWaitMs > 0);
  assert.equal(h.isCaptureBusy(h.scene), false);
});

test("raw YUV is snapshotted before yielding even if the engine reuses its buffers", async () => {
  let mutated = false;
  const h = harness({ onRaw(raw) {
    setTimeout(() => {
      new Uint8Array(raw.yBuffer).fill(0);
      new Uint8Array(raw.uvBuffer).fill(255);
      mutated = true;
    }, 0);
  } });
  const expected = h.convertFrame(h.raw);
  const capture = h.captureCamera(h.scene);
  await until(() => h.state.exports.length === 1);
  assert.equal(mutated, true);
  assert.deepEqual(h.state.writes[0], expected.data);
  h.state.exports[0].success({ tempFilePath: "/tmp/snapshot-frame.jpg" });
  await capture;
});

test("only capture is serialized and completed exports reuse the canvas and ImageData", async () => {
  const h = harness();
  const first = h.captureCamera(h.scene);
  await until(() => h.state.exports.length === 1);
  assert.equal(h.isCaptureBusy(h.scene), true);
  await assert.rejects(h.captureCamera(h.scene), /仍在处理中/);
  assert.equal(h.state.rawReads, 1);
  h.state.exports[0].success({ tempFilePath: "/tmp/first-frame.jpg" });
  await first;
  const second = h.captureCamera(h.scene);
  await until(() => h.state.exports.length === 2);
  assert.equal(h.state.canvases.length, 1);
  assert.equal(h.state.imageData.length, 1);
  assert.equal(h.state.exports[0].canvas, h.state.exports[1].canvas);
  h.state.exports[1].success({ tempFilePath: "/tmp/second-frame.jpg" });
  await second;
  assert.equal(h.isCaptureBusy(h.scene), false);
});

test("snapshot and geometry caches are reused without retaining old frame pixels", async () => {
  const h = harness();
  const frames = [];
  const first = h.captureCamera(h.scene, info => frames.push(info));
  await until(() => h.state.exports.length === 1);
  h.state.exports[0].success({ tempFilePath: "/tmp/cache-first.jpg" });
  await first;
  new Uint8Array(h.raw.yBuffer).fill(201);
  new Uint8Array(h.raw.uvBuffer).fill(135);
  const expected = h.convertFrame(h.raw);
  const second = h.captureCamera(h.scene, info => frames.push(info));
  await until(() => h.state.exports.length === 2);
  assert.deepEqual(h.state.writes[1], expected.data);
  assert.notDeepEqual(h.state.writes[0], h.state.writes[1]);
  h.state.exports[1].success({ tempFilePath: "/tmp/cache-second.jpg" });
  await second;
  assert.equal(frames[0].snapshotReused, false);
  assert.equal(frames[0].geometryReused, false);
  assert.equal(frames[1].snapshotReused, true);
  assert.equal(frames[1].geometryReused, true);
});

test("changing raw frame dimensions invalidates cached geometry and snapshot sizes", async () => {
  const h = harness();
  const frames = [];
  const first = h.captureCamera(h.scene, info => frames.push(info));
  await until(() => h.state.exports.length === 1);
  h.state.exports[0].success({ tempFilePath: "/tmp/size-first.jpg" });
  await first;
  h.raw.width = 32;
  h.raw.height = 24;
  h.raw.yBuffer = new Uint8Array(32 * 24).fill(125).buffer;
  h.raw.uvBuffer = new Uint8Array(32 * 24 / 2).fill(90).buffer;
  const expected = h.convertFrame(h.raw);
  const second = h.captureCamera(h.scene, info => frames.push(info));
  await until(() => h.state.exports.length === 2);
  assert.deepEqual(h.state.writes[1], expected.data);
  h.state.exports[1].success({ tempFilePath: "/tmp/size-second.jpg" });
  await second;
  assert.equal(frames[1].snapshotReused, false);
  assert.equal(frames[1].geometryReused, false);
  assert.equal(h.state.canvases.length, 2);
});

test("unavailable GPU falls back to identical CPU pixels and does not retry every frame", async () => {
  const h = harness({ config: { pixelConverter: "auto" } });
  const expected = h.convertFrame(h.raw);
  const infos = [];
  for (let i = 0; i < 2; i++) {
    const capture = h.captureCamera(h.scene, info => infos.push(info));
    await until(() => h.state.exports.length === i + 1);
    assert.deepEqual(h.state.writes[i], expected.data);
    h.state.exports[i].success({ tempFilePath: `/tmp/fallback-${i}.jpg` });
    await capture;
  }
  assert.equal(h.state.gpuAttempts, 1);
  assert.equal(h.state.canvases.length, 1);
  assert.equal(infos[0].pixelConverter, "cpu");
  assert.equal(infos[1].gpuFallbackReason, "webgl_unavailable");
  assert.equal(infos[1].gpuInitMs, 0);
});

test("disposing during native export cancels delivery and retains the lock until callback", async () => {
  const h = harness();
  const capture = h.captureCamera(h.scene);
  const rejected = assert.rejects(capture, /取图已取消/);
  await until(() => h.state.exports.length === 1);
  h.disposeCapture(h.scene);
  assert.equal(h.isCaptureBusy(h.scene), true);
  h.state.exports[0].success({ tempFilePath: "/tmp/disposed-frame.jpg" });
  await rejected;
  assert.equal(h.isCaptureBusy(h.scene), false);
  assert.deepEqual(h.state.removed, ["/tmp/disposed-frame.jpg"]);
  await assert.rejects(h.captureCamera(h.scene), /取图已取消/);
});

test("a transient ImageData allocation failure does not poison the cached canvas", async () => {
  let allocations = 0;
  const h = harness({ onCreateImageData() {
    if (++allocations === 1) throw new Error("temporary canvas allocation failure");
  } });
  await assert.rejects(h.captureCamera(h.scene), /temporary canvas allocation failure/);
  assert.equal(h.isCaptureBusy(h.scene), false);
  const retry = h.captureCamera(h.scene);
  const completion = retry.then(value => ({ value }), error => ({ error }));
  await until(() => h.state.exports.length === 1 || !h.isCaptureBusy(h.scene));
  if (!h.state.exports.length) {
    const result = await completion;
    assert.fail(`Capture failed to recover after canvas allocation: ${result.error?.message}`);
  }
  h.state.exports[0].success({ tempFilePath: "/tmp/allocation-retry.jpg" });
  assert.deepEqual(await completion, { value: "/tmp/allocation-retry.jpg" });
});

test("cancellation during pixel conversion stops before canvas writes or JPEG export", async () => {
  let current = true;
  const h = harness({ onCanvasYield(count) { if (count === 2) current = false; } });
  await assert.rejects(h.captureCamera(h.scene, undefined, () => current), /取图已取消/);
  assert.ok(h.state.imageData[0].data.some(value => value !== 0), "one slice should have run");
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.exports.length, 0);
  assert.equal(h.isCaptureBusy(h.scene), false);
});

test("cancellation while native export is pending removes its late temporary file", async () => {
  let current = true;
  const h = harness();
  const capture = h.captureCamera(h.scene, undefined, () => current);
  const rejected = assert.rejects(capture, /取图已取消/);
  await until(() => h.state.exports.length === 1);
  current = false;
  assert.equal(h.isCaptureBusy(h.scene), true);
  h.state.exports[0].success({ tempFilePath: "/tmp/cancelled-frame.jpg" });
  await rejected;
  assert.deepEqual(h.state.removed, ["/tmp/cancelled-frame.jpg"]);
  assert.equal(h.isCaptureBusy(h.scene), false);
});

test("timeout retains native export ownership until its callback and removes the late file", async () => {
  const h = harness();
  const capture = h.captureCamera(h.scene);
  const rejected = assert.rejects(capture, /导出超时/);
  await until(() => h.state.exports.length === 1);
  h.expireExport();
  await rejected;
  assert.equal(h.isCaptureBusy(h.scene), true);
  await assert.rejects(h.captureCamera(h.scene), /仍在处理中/);
  h.state.exports[0].success({ tempFilePath: "/tmp/expired-frame.jpg" });
  assert.deepEqual(h.state.removed, ["/tmp/expired-frame.jpg"]);
  assert.equal(h.isCaptureBusy(h.scene), false);
  const retry = h.captureCamera(h.scene);
  await until(() => h.state.exports.length === 2);
  h.state.exports[1].success({ tempFilePath: "/tmp/retry-frame.jpg" });
  await retry;
});

test("an older completion cannot release capture ownership acquired by a reentrant callback", async () => {
  const h = harness();
  let second;
  const first = h.captureCamera(h.scene, () => { second = h.captureCamera(h.scene); });
  await until(() => h.state.exports.length === 1);
  h.state.exports[0].success({ tempFilePath: "/tmp/reentrant-first.jpg" });
  await first;
  assert.equal(h.isCaptureBusy(h.scene), true);
  await until(() => h.state.exports.length === 2);
  h.state.exports[1].success({ tempFilePath: "/tmp/reentrant-second.jpg" });
  await second;
  assert.equal(h.isCaptureBusy(h.scene), false);
});

test("frame-info callback failures reject, clean temporary output, and release capture", async () => {
  const h = harness();
  const capture = h.captureCamera(h.scene, () => { throw new Error("frame info consumer failed"); });
  const rejected = assert.rejects(capture, /frame info consumer failed/);
  await until(() => h.state.exports.length === 1);
  h.state.exports[0].success({ tempFilePath: "/tmp/callback-error.jpg" });
  await rejected;
  assert.deepEqual(h.state.removed, ["/tmp/callback-error.jpg"]);
  assert.equal(h.isCaptureBusy(h.scene), false);
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`✓ ${name}`);
  }
  console.log(`${tests.length} capture pipeline checks passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

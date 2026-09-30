#!/usr/bin/env node
/* Optional integration test: requires Playwright and an installed Chromium/Chrome.
 * PLAYWRIGHT_MODULE=/path/to/playwright CHROME_PATH=/path/to/chrome node scripts/test-capture-gpu.cjs
 * CAPTURE_SOURCE=/path/to/capture.js overrides the project source.
 * CAPTURE_BEFORE_SOURCE=/path/to/previous/capture.js enables the optional before benchmark.
 * No camera, network, app credentials, or user images are used.
 */
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
  let chromium;
  try { ({ chromium } = require(playwrightModule)); }
  catch (_) { throw new Error("Playwright is required: install it separately or set PLAYWRIGHT_MODULE to its module path."); }
  const sourcePath = process.env.CAPTURE_SOURCE || path.resolve(__dirname,
    "../miniprogram/components/xr-start/matching/capture.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const beforeSource = process.env.CAPTURE_BEFORE_SOURCE
    ? fs.readFileSync(process.env.CAPTURE_BEFORE_SOURCE, "utf8") : null;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(async ({ source, beforeSource }) => {
      const options = { rotation: 90, maxImageEdge: 640, uvOrder: "uv", pixelConverter: "auto" };
      function load(text, overrides = {}) {
        const module = { exports: {} };
        const configuration = { ...options, ...overrides };
        new Function("module", "require", text)(module, id => {
          if (id === "./config") return configuration;
          if (id === "./log") return () => {};
          throw new Error(`Unexpected dependency: ${id}`);
        });
        return module.exports;
      }
      function assert(value, message) { if (!value) throw new Error(message); }
      function raw(width, height) {
        const y = new Uint8Array(width * height), uv = new Uint8Array(width * height / 2);
        let seed = 73417;
        for (const data of [y, uv]) for (let i = 0; i < data.length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          data[i] = seed >>> 24;
        }
        return { width, height, yBuffer: y.buffer, uvBuffer: uv.buffer };
      }
      const { convertFrame, prepareFrame, createGpuConverter } = load(source);
      const converter = createGpuConverter(() => new OffscreenCanvas(1, 1));
      let maxError = 0, differentChannels = 0, checks = 0, totalChannels = 0;
      try {
        for (const [width, height, maxImageEdge] of [[2, 2, 640], [8, 6, 640], [18, 10, 7],
          [640, 480, 640], [1920, 1440, 640], [1280, 720, 640], [1440, 1920, 639]]) {
          const data = raw(width, height);
          for (const rotation of [0, 90, 180, 270]) for (const uvOrder of ["uv", "vu"]) {
            const settings = { rotation, uvOrder, maxImageEdge };
            converter.verify(settings);
            const frame = prepareFrame(data, settings);
            frame.data = new Uint8ClampedArray(frame.width * frame.height * 4);
            for (let pass = 0; pass < 2; pass++) {
              // Update the same buffers on pass two; geometry and output storage stay unchanged.
              if (pass) { frame.y[0] = (frame.y[0] + 23) & 255; frame.uv[0] = (frame.uv[0] + 41) & 255; }
              const expected = convertFrame(data, settings);
              converter.convert(frame);
              for (let i = 0; i < frame.data.length; i++) {
                const error = Math.abs(frame.data[i] - expected.data[i]);
                maxError = Math.max(maxError, error);
                differentChannels += error > 0;
                totalChannels++;
                if (error > (i % 4 === 3 ? 0 : 1)) throw new Error(JSON.stringify({ width, height,
                  maxImageEdge, rotation, uvOrder, pass, i, error,
                  actual: frame.data[i], expected: expected.data[i] }));
              }
              checks++;
            }
          }
        }
      } finally { converter.dispose(); converter.dispose(); }
      assert(checks === 112, `Expected 112 pixel cases, got ${checks}`);

      // Exercise captureCamera with genuine Chromium WebGL and Canvas2D objects.
      // Only the WeChat JPEG file callback and filesystem cleanup are mocked.
      const integrationChecks = [];
      function harness({ holdExport = false, invalidOnRead = 0, corruptOnRead = 0 } = {}) {
        const report = { gpuCreates: 0, reads: 0, texImage: 0, texSubImage: 0,
          created: 0, deleted: 0, exports: [], unlinked: [], contexts: [] };
        let sequence = 0;
        globalThis.wx = {
          createOffscreenCanvas({ type, width, height }) {
            const canvas = new OffscreenCanvas(width, height);
            if (type === "2d") return canvas;
            report.gpuCreates++;
            const gl = canvas.getContext("webgl");
            assert(gl, "Chromium WebGL is unavailable");
            report.contexts.push(gl);
            const wrapped = new Proxy(gl, {
              get(target, key) {
                const value = Reflect.get(target, key, target);
                if (typeof value !== "function") return value;
                return (...args) => {
                  if (/^create(Shader|Program|Buffer|Texture|Framebuffer)$/.test(key)) report.created++;
                  if (/^delete(Shader|Program|Buffer|Texture|Framebuffer)$/.test(key)) report.deleted++;
                  if (key === "texImage2D") report.texImage++;
                  if (key === "texSubImage2D") report.texSubImage++;
                  const result = value.apply(target, args);
                  if (key === "readPixels") {
                    report.reads++;
                    // Generate a real GL error, rather than faking getError's return value.
                    if (report.reads === invalidOnRead) target.enable(0xffffffff);
                    if (report.reads === corruptOnRead) args[6].fill(0);
                  }
                  return result;
                };
              },
            });
            return { getContext: () => wrapped };
          },
          canvasToTempFilePath(args) {
            const entry = { args, path: `synthetic-frame-${++sequence}.jpg` };
            report.exports.push(entry);
            if (!holdExport) setTimeout(() => args.success({ tempFilePath: entry.path }), 0);
          },
          getFileSystemManager() { return { unlink({ filePath }) { report.unlinked.push(filePath); } }; },
        };
        const api = load(source);
        const image = raw(18, 10);
        const scene = { ar: { getARRawData: () => image } };
        async function capture(isCurrent) {
          let info;
          const file = await api.captureCamera(scene, value => { info = value; }, isCurrent);
          const exported = report.exports[report.exports.length - 1];
          const canvas = exported.args.canvas;
          const actual = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
          const expected = api.convertFrame(image, options).data;
          assert(actual.length === expected.length, "Export canvas dimensions changed");
          for (let i = 0; i < actual.length; i++) assert(Math.abs(actual[i] - expected[i]) <=
            (i % 4 === 3 ? 0 : 1), `Exported canvas pixel differs at ${i}`);
          assert(!api.isCaptureBusy(scene), "Capture lock remained held after export callback");
          return { file, info };
        }
        function cleanup() { api.disposeCapture(scene); api.disposeCapture(scene); }
        return { api, image, scene, report, capture, cleanup };
      }
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function waitFor(predicate, label) {
        const deadline = performance.now() + 3000;
        while (!predicate()) {
          assert(performance.now() < deadline, `Timed out waiting for ${label}`);
          await delay(1);
        }
      }
      async function rejection(promise, text) {
        const error = await promise.then(() => null, error => error);
        assert(error && error.message.includes(text), `Expected rejection containing ${text}, got ${error?.message}`);
      }
      {
        const h = harness();
        try {
          const first = await h.capture();
          assert(first.info.pixelConverter === "webgl", "Healthy GL did not use GPU");
          const imagesBefore = h.report.texImage, subsBefore = h.report.texSubImage;
          new Uint8Array(h.image.yBuffer)[0] ^= 127;
          new Uint8Array(h.image.uvBuffer)[0] ^= 63;
          const second = await h.capture();
          assert(second.info.pixelConverter === "webgl", "Second capture lost GPU path");
          assert(h.report.gpuCreates === 1, "GPU context was recreated per frame");
          assert(h.report.texImage === imagesBefore, "Unchanged geometry reallocated texture storage");
          assert(h.report.texSubImage === subsBefore + 2, "Y/UV texture updates were not reused");
          assert(second.info.geometryReused && second.info.snapshotReused, "Capture buffers were not reused");
          integrationChecks.push("GPU capture exports correct pixels and updates reused Y/UV textures");
        } finally { h.cleanup(); }
        assert(h.report.created === h.report.deleted, "GPU resources were not completely disposed");
        integrationChecks.push("GPU dispose is idempotent and deletes all allocated GL resources");
      }
      {
        // Read one is the self-test, read two is the first camera image.
        const h = harness({ invalidOnRead: 2 });
        try {
          const first = await h.capture();
          assert(first.info.pixelConverter === "cpu" && first.info.gpuFallbackReason === "gpu_readback_failed",
            `Real GL error did not fall back safely: ${JSON.stringify(first.info)}`);
          assert(h.report.created === h.report.deleted, "Failed GPU converter leaked resources");
          await h.capture();
          assert(h.report.gpuCreates === 1, "Failed GPU conversion was initialized repeatedly");
          integrationChecks.push("Real GL error falls back to correct CPU pixels and disables repeated GPU attempts");
        } finally { h.cleanup(); }
      }
      {
        const h = harness({ invalidOnRead: 1 });
        try {
          const first = await h.capture();
          assert(first.info.pixelConverter === "cpu", "Failed GPU initialization did not fall back");
          await h.capture();
          assert(h.report.gpuCreates === 1, "Failed GPU initialization was retried on every capture");
          assert(h.report.created === h.report.deleted, "Initialization failure leaked GL resources");
          integrationChecks.push("GPU self-test failure initializes once, frees resources, and remains on CPU");
        } finally { h.cleanup(); }
      }
      {
        const h = harness({ corruptOnRead: 1 });
        try {
          const first = await h.capture();
          assert(first.info.pixelConverter === "cpu" && first.info.gpuFallbackReason === "gpu_self_test_failed",
            "Incorrect GPU pixels were not rejected by the startup self-test");
          await h.capture();
          assert(h.report.gpuCreates === 1 && h.report.created === h.report.deleted,
            "Pixel self-test failure retried or leaked GL resources");
          integrationChecks.push("Incorrect self-test pixels disable GPU and preserve correct CPU output");
        } finally { h.cleanup(); }
      }
      {
        const h = harness();
        try {
          await h.capture();
          const gl = h.report.contexts[0];
          const extension = gl.getExtension("WEBGL_lose_context");
          assert(extension, "WEBGL_lose_context is required for the context-loss test");
          extension.loseContext();
          await waitFor(() => gl.isContextLost(), "real WebGL context loss");
          const next = await h.capture();
          assert(next.info.pixelConverter === "cpu" && next.info.gpuFallbackReason === "gpu_context_lost",
            `Lost context did not fall back safely: ${JSON.stringify(next.info)}`);
          await h.capture();
          assert(h.report.gpuCreates === 1, "Context-loss fallback kept creating GL contexts");
          integrationChecks.push("Real context loss falls back to CPU and does not recreate contexts every frame");
        } finally { h.cleanup(); }
      }
      {
        const h = harness({ holdExport: true });
        let current = true;
        // Attach rejection handling immediately; cancellation is the expected outcome.
        const pending = h.api.captureCamera(h.scene, undefined, () => current).then(
          () => ({ success: true }), error => ({ error }));
        try {
          await waitFor(() => h.report.exports.length === 1, "held JPEG export");
          current = false;
          assert(h.api.isCaptureBusy(h.scene), "Cancellation prematurely released native export lock");
          await rejection(h.api.captureCamera(h.scene), "上一张图片仍在处理中");
          const entry = h.report.exports[0];
          entry.args.success({ tempFilePath: entry.path });
          const result = await pending;
          assert(result.error?.message.includes("取图已取消"), "Late export was delivered after cancellation");
          assert(!h.api.isCaptureBusy(h.scene), "Late cancelled export did not release capture lock");
          assert(h.report.unlinked.includes(entry.path), "Late cancelled export left its temp file");
          integrationChecks.push("Cancellation retains the export lock until callback and removes its late temp file");
        } finally { h.cleanup(); }
      }
      {
        const h = harness({ holdExport: true });
        const pending = h.api.captureCamera(h.scene).then(() => ({ success: true }), error => ({ error }));
        await waitFor(() => h.report.exports.length === 1, "export before scene disposal");
        h.cleanup();
        assert(h.report.created === h.report.deleted, "Scene disposal leaked GPU resources");
        assert(h.api.isCaptureBusy(h.scene), "Scene disposal released an active native export lock");
        await rejection(h.api.captureCamera(h.scene), "上一张图片仍在处理中");
        const entry = h.report.exports[0];
        entry.args.success({ tempFilePath: entry.path });
        const result = await pending;
        assert(result.error?.message.includes("取图已取消"), "Disposed scene delivered late image");
        assert(!h.api.isCaptureBusy(h.scene), "Disposed scene export lock stayed held after callback");
        assert(h.report.unlinked.includes(entry.path), "Disposed scene left a late temp file");
        await rejection(h.api.captureCamera(h.scene), "取图已取消");
        integrationChecks.push("Scene disposal releases GL resources, preserves native lock, and rejects future captures");
      }
      delete globalThis.wx;

      const benchmarkConverter = createGpuConverter(() => new OffscreenCanvas(1, 1));
      const image = raw(1920, 1440), frame = prepareFrame(image, options);
      frame.data = new Uint8ClampedArray(frame.width * frame.height * 4);
      const before = beforeSource ? load(beforeSource).convertFrame : null;
      const cpu = [], gpu = [], previousCpu = [];
      try {
        for (let i = 0; i < 30; i++) {
          let at = performance.now();
          benchmarkConverter.convert(frame);
          if (i >= 10) gpu.push(performance.now() - at);
          at = performance.now(); convertFrame(image, options);
          if (i >= 10) cpu.push(performance.now() - at);
          if (before) {
            at = performance.now(); before(image, options);
            if (i >= 10) previousCpu.push(performance.now() - at);
          }
        }
      } finally { benchmarkConverter.dispose(); }
      const stats = values => ({ samples: values.length,
        meanMs: values.reduce((x, y) => x + y, 0) / values.length,
        medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] });
      return { pixels: { checks, maxError, differentChannels, totalChannels },
        integration: { checks: integrationChecks.length, passed: integrationChecks },
        benchmark: { scope: "Desktop Chromium WebGL including upload/readback; 10 warmups + 20 samples. Excludes camera, snapshot, yields, JPEG and phone behavior. CPU convertFrame allocates output; GPU reuses output. Performance is informational, not a phone speed claim.",
          cpu: stats(cpu), gpu: stats(gpu), ...(before ? { previousCpu: stats(previousCpu) } : {}) } };
    }, { source, beforeSource });
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

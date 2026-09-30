// Frozen pre-optimization conversion is an independent pixel oracle and optional local benchmark.
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { convertFrame } = require("../miniprogram/components/xr-start/matching/capture.js");
const legacyConfig = { rotation: 90, uvOrder: "uv", maxImageEdge: 640 };

function legacyPrepareFrame(raw, options = legacyConfig, data) {
  const { width, height } = raw || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
      width % 2 || height % 2 || raw.yBuffer?.byteLength !== width * height ||
      raw.uvBuffer?.byteLength !== (width * height) / 2) {
    throw new Error("相机帧格式不支持，请检查真机 YUV 排列");
  }
  const rotation = options.rotation || 0;
  if (![0, 90, 180, 270].includes(rotation)) throw new Error("相机旋转配置无效");
  const scale = Math.min(1, (options.maxImageEdge || 640) / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return {
    rawWidth: width, rawHeight: height, w, h, scale, rotation,
    width: rotation % 180 ? h : w, height: rotation % 180 ? w : h,
    y: new Uint8Array(raw.yBuffer), uv: new Uint8Array(raw.uvBuffer),
    uOffset: options.uvOrder === "vu" ? 1 : 0, data,
  };
}

function legacyConvertRows(frame, start, end) {
  const { w, h, scale, rawWidth, width, y, uv, uOffset, rotation, data } = frame;
  for (let row = start; row < end; row++) {
    const sy = Math.min(frame.rawHeight - 1, Math.floor(row / scale));
    for (let col = 0; col < w; col++) {
      const sx = Math.min(rawWidth - 1, Math.floor(col / scale));
      const yi = y[sy * rawWidth + sx];
      const ui = Math.floor(sy / 2) * rawWidth + Math.floor(sx / 2) * 2;
      const u = uv[ui + uOffset] - 128, v = uv[ui + 1 - uOffset] - 128;
      let ox = col, oy = row;
      if (rotation === 90) { ox = h - 1 - row; oy = col; }
      if (rotation === 180) { ox = w - 1 - col; oy = h - 1 - row; }
      if (rotation === 270) { ox = row; oy = w - 1 - col; }
      const i = (oy * width + ox) * 4;
      data[i] = yi + 1.402 * v;
      data[i + 1] = yi - 0.344136 * u - 0.714136 * v;
      data[i + 2] = yi + 1.772 * u;
      data[i + 3] = 255;
    }
  }
}

/** 同步纯转换保留给像素回归；真机取图使用下方分片异步转换。 */
function legacyConvertFrame(raw, options = legacyConfig) {
  const frame = legacyPrepareFrame(raw, options);
  frame.data = new Uint8ClampedArray(frame.width * frame.height * 4);
  legacyConvertRows(frame, 0, frame.h);
  return { width: frame.width, height: frame.height, data: frame.data };
}

function makeRaw(width, height) {
  const y = new Uint8Array(width * height);
  const uv = new Uint8Array(width * height / 2);
  let seed = 73417;
  const byte = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; };
  for (let i = 0; i < y.length; i++) y[i] = byte();
  for (let i = 0; i < uv.length; i++) uv[i] = byte();
  return { width, height, yBuffer: y.buffer, uvBuffer: uv.buffer };
}

const cases = [
  [2, 2, 640], [8, 6, 640], [18, 10, 7], [640, 480, 640],
  [1920, 1440, 640], [1280, 720, 640], [1440, 1920, 639],
];
let checked = 0;
for (const [width, height, maxImageEdge] of cases) {
  const raw = makeRaw(width, height);
  for (const rotation of [0, 90, 180, 270]) {
    for (const uvOrder of ["uv", "vu"]) {
      const options = { maxImageEdge, rotation, uvOrder };
      const before = legacyConvertFrame(raw, options);
      const after = convertFrame(raw, options);
      const label = `${width}x${height}, edge=${maxImageEdge}, rotation=${rotation}, ${uvOrder}`;
      assert.equal(after.width, before.width, label);
      assert.equal(after.height, before.height, label);
      assert.equal(Buffer.compare(Buffer.from(after.data), Buffer.from(before.data)), 0, label);
      checked++;
    }
  }
}
console.log(`${checked} pixel comparisons passed against the frozen old implementation`);

if (process.argv.includes("--benchmark")) {
  const raw = makeRaw(1920, 1440);
  const options = { maxImageEdge: 640, rotation: 90, uvOrder: "uv" };
  const rounds = 40;
  const warmups = 15;
  for (let i = 0; i < warmups; i++) { legacyConvertFrame(raw, options); convertFrame(raw, options); }
  const samples = { before: [], after: [] };
  let checksum = 0;
  const measure = (name, fn) => {
    const startedAt = performance.now();
    const output = fn(raw, options);
    samples[name].push(performance.now() - startedAt);
    checksum += output.data[19];
  };
  for (let i = 0; i < rounds; i++) {
    // Alternate ordering to reduce systematic first/second-call bias.
    if (i % 2) { measure("after", convertFrame); measure("before", legacyConvertFrame); }
    else { measure("before", legacyConvertFrame); measure("after", convertFrame); }
  }
  const stats = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: Number(((sorted[19] + sorted[20]) / 2).toFixed(3)),
      meanMs: Number((sorted.reduce((sum, x) => sum + x, 0) / sorted.length).toFixed(3)),
      p95Ms: Number(sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3)) };
  };
  const before = stats(samples.before), after = stats(samples.after);
  console.log(JSON.stringify({
    scope: "Local Node CPU conversion only; excludes raw capture, yields, canvas, JPEG, network and device performance",
    node: process.version, platform: `${process.platform}/${process.arch}`,
    input: "1920x1440 YUV420", output: "480x640 RGBA, 90 degrees, uv", rounds, warmups,
    before, after, medianSpeedup: Number((before.medianMs / after.medianMs).toFixed(2)), checksum,
  }, null, 2));
}

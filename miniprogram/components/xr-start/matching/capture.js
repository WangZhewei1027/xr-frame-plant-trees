const config = require("./config");
const matchLog = require("./log");

// Geometry depends only on dimensions/rotation and is reused across live frames.
function createFrameGeometry(rawWidth, rawHeight, w, h, scale, rotation) {
  const width = rotation % 180 ? h : w;
  const sourceX = new Uint32Array(w);
  const chromaX = new Uint32Array(w);
  const yRows = new Uint32Array(h);
  const uvRows = new Uint32Array(h);
  const outputRows = new Uint32Array(h);
  const outputStep = rotation === 90 ? width * 4 : rotation === 270 ? -width * 4 : rotation === 180 ? -4 : 4;
  for (let col = 0; col < w; col++) {
    const sx = Math.min(rawWidth - 1, Math.floor(col / scale));
    sourceX[col] = sx;
    chromaX[col] = Math.floor(sx / 2) * 2;
  }
  for (let row = 0; row < h; row++) {
    const sy = Math.min(rawHeight - 1, Math.floor(row / scale));
    yRows[row] = sy * rawWidth;
    uvRows[row] = Math.floor(sy / 2) * rawWidth;
    if (rotation === 90) outputRows[row] = (h - 1 - row) * 4;
    else if (rotation === 180) outputRows[row] = ((h - 1 - row) * w + w - 1) * 4;
    else if (rotation === 270) outputRows[row] = ((w - 1) * width + row) * 4;
    else outputRows[row] = row * w * 4;
  }
  return { rawWidth, rawHeight, w, h, scale, rotation,
    sourceX, chromaX, yRows, uvRows, outputRows, outputStep };
}

function prepareFrame(raw, options = config, geometry) {
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
  if (!geometry || geometry.rawWidth !== width || geometry.rawHeight !== height ||
      geometry.w !== w || geometry.h !== h || geometry.scale !== scale || geometry.rotation !== rotation) {
    geometry = createFrameGeometry(width, height, w, h, scale, rotation);
  }
  return {
    rawWidth: width, rawHeight: height, w, h, scale, rotation, geometry,
    width: rotation % 180 ? h : w, height: rotation % 180 ? w : h,
    y: new Uint8Array(raw.yBuffer), uv: new Uint8Array(raw.uvBuffer),
    uOffset: options.uvOrder === "vu" ? 1 : 0, data: null,
  };
}

function convertRows(frame, start, end) {
  const { w, y, uv, uOffset, data } = frame;
  const { sourceX, chromaX, yRows, uvRows, outputRows, outputStep } = frame.geometry;
  for (let row = start; row < end; row++) {
    const yRow = yRows[row], uvRow = uvRows[row];
    let i = outputRows[row];
    // Pixel arithmetic/order is unchanged; sampling and rotation are precomputed.
    for (let col = 0; col < w; col++, i += outputStep) {
      const yi = y[yRow + sourceX[col]];
      const ui = uvRow + chromaX[col];
      const u = uv[ui + uOffset] - 128, v = uv[ui + 1 - uOffset] - 128;
      data[i] = yi + 1.402 * v;
      data[i + 1] = yi - 0.344136 * u - 0.714136 * v;
      data[i + 2] = yi + 1.772 * u;
      data[i + 3] = 255;
    }
  }
}

/** 同步纯转换保留给像素回归；真机取图使用下方分片异步转换。 */
function convertFrame(raw, options = config) {
  const frame = prepareFrame(raw, options);
  frame.data = new Uint8ClampedArray(frame.width * frame.height * 4);
  convertRows(frame, 0, frame.h);
  return { width: frame.width, height: frame.height, data: frame.data };
}

const yieldCapture = () => new Promise(resolve => setTimeout(resolve, 0));
function assertCaptureCurrent(isCurrent) {
  if (!isCurrent()) throw new Error("取图已取消");
}

async function convertFrameAsync(frame, isCurrent = () => true) {
  let row = 0;
  let maxConvertSliceMs = 0;
  let convertSliceCount = 0;
  let convertWorkMs = 0;
  let convertYieldWaitMs = 0;
  let sliceStartedAt = Date.now();
  // 每段最多 16 行 / 约 4ms，主动归还事件循环，让 AR tick 和用户操作继续。
  while (row < frame.h) {
    assertCaptureCurrent(isCurrent);
    const lastRow = Math.min(frame.h, row + 16);
    do { convertRows(frame, row, row + 1); row++; }
    while (row < lastRow && Date.now() - sliceStartedAt < 4);
    const workFinishedAt = Date.now();
    const sliceMs = Math.max(0, workFinishedAt - sliceStartedAt);
    convertWorkMs += sliceMs;
    maxConvertSliceMs = Math.max(maxConvertSliceMs, sliceMs);
    convertSliceCount++;
    if (row < frame.h) {
      await yieldCapture();
      sliceStartedAt = Date.now();
      convertYieldWaitMs += Math.max(0, sliceStartedAt - workFinishedAt);
    }
  }
  // Work is synchronous wall time, not CPU profiling; wait includes timer/AR scheduling.
  return { convertMs: convertWorkMs + convertYieldWaitMs, convertWorkMs, convertYieldWaitMs,
    maxConvertSliceMs, convertSliceCount };
}

// Dedicated offscreen context: never changes xr-frame's renderer or camera texture.
// Draw into an RGBA framebuffer, then read straight into the reusable 2D ImageData.
function createGpuConverter(createCanvas) {
  let gl;
  const owned = { Shader: [], Program: [], Buffer: [], Texture: [], Framebuffer: [] };
  function dispose() {
    if (!gl) return;
    for (const type of Object.keys(owned)) {
      for (const value of owned[type]) { try { gl[`delete${type}`](value); } catch (_) {} }
      owned[type] = [];
    }
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (_) {}
    gl = null;
  }
  const fail = code => { const error = new Error(code); error.code = code; throw error; };
  const allocate = (type, ...args) => {
    const value = gl[`create${type}`](...args);
    if (!value) fail("gpu_allocation_failed");
    owned[type].push(value);
    return value;
  };
  try {
    const canvas = createCanvas({ type: "webgl", width: 1, height: 1 });
    gl = canvas?.getContext("webgl");
    if (!gl) fail("webgl_unavailable");
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!precision || precision.precision < 16) fail("gpu_precision_unsupported");
    const vertex = `attribute vec2 position;
      void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
    const fragment = `precision highp float;
      precision highp sampler2D;
      uniform sampler2D yPlane, uvPlane, xIndex, yIndex;
      uniform vec2 rawSize, sampleSize;
      uniform float rotation, swapUV;
      float sourceIndex(sampler2D indices, float p, float size) {
        vec2 bytes = texture2D(indices, vec2((p + 0.5) / size, 0.5)).rg;
        return floor(bytes.r * 255.0 + 0.5) * 256.0 + floor(bytes.g * 255.0 + 0.5);
      }
      void main() {
        // readPixels row zero becomes ImageData row zero; do not add a second Y flip.
        vec2 p = floor(gl_FragCoord.xy);
        if (rotation == 1.0) p = vec2(p.y, sampleSize.y - 1.0 - p.x);
        else if (rotation == 2.0) p = sampleSize - 1.0 - p;
        else if (rotation == 3.0) p = vec2(sampleSize.x - 1.0 - p.y, p.x);
        vec2 source = vec2(sourceIndex(xIndex, p.x, sampleSize.x), sourceIndex(yIndex, p.y, sampleSize.y));
        float y = texture2D(yPlane, (source + 0.5) / rawSize).r * 255.0;
        vec2 uv = texture2D(uvPlane, (floor(source / 2.0) + 0.5) / (rawSize / 2.0)).ra * 255.0 - 128.0;
        if (swapUV == 1.0) uv = uv.yx;
        vec3 rgb = vec3(y + 1.402 * uv.y, y - 0.344136 * uv.x - 0.714136 * uv.y, y + 1.772 * uv.x);
        gl_FragColor = vec4(clamp(rgb, 0.0, 255.0) / 255.0, 1.0);
      }`;
    const program = allocate("Program");
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = allocate("Shader", type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) fail("gpu_shader_failed");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) fail("gpu_program_failed");
    gl.useProgram(program);
    const buffer = allocate("Buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    if (position < 0) fail("gpu_program_failed");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const textures = [];
    for (let unit = 0; unit < 5; unit++) {
      const texture = allocate("Texture");
      textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const parameter of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.NEAREST);
      for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
    }
    for (const [unit, name] of ["yPlane", "uvPlane", "xIndex", "yIndex"].entries()) {
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    }
    const uniforms = {};
    for (const name of ["rawSize", "sampleSize", "rotation", "swapUV"]) uniforms[name] = gl.getUniformLocation(program, name);
    const framebuffer = allocate("Framebuffer");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures[4], 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const option of [gl.DITHER, gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.CULL_FACE]) gl.disable(option);
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let previousGeometry = null, rawWidth = 0, rawHeight = 0, outputWidth = 0, outputHeight = 0;
    let outputData = null, outputBytes = null;
    function upload(unit, width, height, format, data, reuse = false) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
      if (reuse) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, gl.UNSIGNED_BYTE, data);
      else gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, format, gl.UNSIGNED_BYTE, data);
    }
    function convert(frame) {
      if (!gl || gl.isContextLost()) fail("gpu_context_lost");
      if (Math.max(frame.rawWidth, frame.rawHeight, frame.width, frame.height) > Math.min(maxTextureSize, 65535)) fail("gpu_size_unsupported");
      const startedAt = Date.now();
      const reuse = rawWidth === frame.rawWidth && rawHeight === frame.rawHeight;
      upload(0, frame.rawWidth, frame.rawHeight, gl.LUMINANCE, frame.y, reuse);
      upload(1, frame.rawWidth / 2, frame.rawHeight / 2, gl.LUMINANCE_ALPHA, frame.uv, reuse);
      rawWidth = frame.rawWidth; rawHeight = frame.rawHeight;
      if (previousGeometry !== frame.geometry) {
        // Encode exact CPU sampling indices, avoiding float floor errors for odd resize ratios.
        const xs = new Uint8Array(frame.w * 4), ys = new Uint8Array(frame.h * 4);
        for (let x = 0; x < frame.w; x++) {
          const value = frame.geometry.sourceX[x];
          xs[x * 4] = value >>> 8; xs[x * 4 + 1] = value & 255;
        }
        for (let y = 0; y < frame.h; y++) {
          const value = frame.geometry.yRows[y] / frame.rawWidth;
          ys[y * 4] = value >>> 8; ys[y * 4 + 1] = value & 255;
        }
        upload(2, frame.w, 1, gl.RGBA, xs);
        upload(3, frame.h, 1, gl.RGBA, ys);
        previousGeometry = frame.geometry;
      }
      if (outputWidth !== frame.width || outputHeight !== frame.height) {
        upload(4, frame.width, frame.height, gl.RGBA, null);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) fail("gpu_framebuffer_failed");
        outputWidth = frame.width; outputHeight = frame.height;
      }
      gl.viewport(0, 0, frame.width, frame.height);
      gl.uniform2f(uniforms.rawSize, frame.rawWidth, frame.rawHeight);
      gl.uniform2f(uniforms.sampleSize, frame.w, frame.h);
      gl.uniform1f(uniforms.rotation, frame.rotation / 90);
      gl.uniform1f(uniforms.swapUV, frame.uOffset);
      if (outputData !== frame.data) {
        outputData = frame.data;
        outputBytes = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      }
      const uploadedAt = Date.now();
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // Synchronous GPU readback. No await here, and no CPU row-flip/copy afterward.
      gl.readPixels(0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, outputBytes);
      if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) fail("gpu_readback_failed");
      const finishedAt = Date.now();
      return { gpuUploadMs: uploadedAt - startedAt, gpuDrawReadMs: finishedAt - uploadedAt };
    }
    function verify(options) {
      // Catch unsupported texture/channel/orientation behavior once before using real frames.
      const width = 18, height = 10;
      const y = new Uint8Array(width * height), uv = new Uint8Array(width * height / 2);
      for (let i = 0; i < y.length; i++) y[i] = (i * 37 + 23) & 255;
      for (let i = 0; i < uv.length; i++) uv[i] = (i * 19 + 61) & 255;
      const raw = { width, height, yBuffer: y.buffer, uvBuffer: uv.buffer };
      const frame = prepareFrame(raw, { ...options, maxImageEdge: 7 });
      frame.data = new Uint8ClampedArray(frame.width * frame.height * 4);
      convertRows(frame, 0, frame.h);
      const expected = frame.data.slice();
      convert(frame);
      for (let i = 0; i < expected.length; i++) {
        // WebGL normalized-byte rounding can differ from JS clamped rounding by one level.
        if (Math.abs(frame.data[i] - expected[i]) > (i % 4 === 3 ? 0 : 1)) fail("gpu_self_test_failed");
      }
    }
    return { convert, verify, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function convertForCapture(frame, session, isCurrent) {
  let gpuInitMs = 0, gpuAttemptMs = 0;
  assertCaptureCurrent(isCurrent);
  if (config.pixelConverter !== "cpu" && !session.gpuDisabled) {
    if (!session.gpu) {
      const startedAt = Date.now();
      try {
        session.gpu = createGpuConverter(options => wx.createOffscreenCanvas(options));
        session.gpu.verify(config);
      } catch (error) {
        session.gpu?.dispose();
        session.gpu = null;
        session.gpuDisabled = error.code || "webgl_unavailable";
      }
      gpuInitMs = Date.now() - startedAt;
      // Shader initialization/self-test happens once; let AR resume before processing the image.
      await yieldCapture();
      assertCaptureCurrent(isCurrent);
    }
    if (session.gpu) {
      const startedAt = Date.now();
      try {
        const timings = session.gpu.convert(frame);
        const convertWorkMs = Date.now() - startedAt;
        return { pixelConverter: "webgl", gpuInitMs, gpuAttemptMs: 0, ...timings,
          convertMs: convertWorkMs, convertWorkMs, convertYieldWaitMs: 0,
          maxConvertSliceMs: convertWorkMs, convertSliceCount: 1, gpuFallbackReason: null };
      } catch (error) {
        gpuAttemptMs = Date.now() - startedAt;
        session.gpu.dispose();
        session.gpu = null;
        session.gpuDisabled = error.code || "gpu_conversion_failed";
        await yieldCapture();
        assertCaptureCurrent(isCurrent);
      }
    }
  }
  const conversion = await convertFrameAsync(frame, isCurrent);
  return { ...conversion, pixelConverter: "cpu", gpuInitMs, gpuAttemptMs,
    gpuUploadMs: null, gpuDrawReadMs: null, gpuFallbackReason: session.gpuDisabled || null };
}

function removeTempFile(filePath) {
  if (!filePath) return;
  try { wx.getFileSystemManager().unlink({ filePath, fail() {} }); } catch (_) {}
}

// 与网络请求独立的取图锁；模式切换不能提前释放仍在原生导出的画布。
const captureSessions = new WeakMap();
function disposeCapture(scene) {
  const session = scene && captureSessions.get(scene);
  if (!session) return;
  session.disposed = true;
  session.gpu?.dispose();
  session.gpu = null;
  // Keep an in-flight export locked until its real callback. WeakMap memory follows scene lifetime.
}
function isCaptureBusy(scene) {
  return !!scene && !!captureSessions.get(scene)?.busy;
}

async function captureCamera(scene, onFrameInfo, isCurrent = () => true) {
  if (!scene?.ar?.getARRawData || !wx.createOffscreenCanvas) {
    throw new Error("当前微信不支持 AR 原始取图，请升级并使用真机");
  }
  let session = captureSessions.get(scene);
  if (!session) {
    session = { busy: false, canvas: null, ctx: null, pixels: null,
      geometry: null, ySnapshot: null, uvSnapshot: null, gpu: null, gpuDisabled: null, disposed: false };
    captureSessions.set(scene, session);
  }
  if (session.busy) throw new Error("上一张图片仍在处理中");
  const callerCurrent = isCurrent;
  isCurrent = () => !session.disposed && callerCurrent();
  assertCaptureCurrent(isCurrent);
  session.busy = true;
  const owner = {};
  session.owner = owner;
  const releaseCapture = () => {
    if (session.owner === owner) {
      session.owner = null;
      session.busy = false;
    }
  };
  let exportPending = false;
  try {
    // 从 AR tick 回调退出后再做取图，避免同一帧叠加像素工作。
    await yieldCapture();
    assertCaptureCurrent(isCurrent);
    const rawStartedAt = Date.now();
    const raw = scene.ar.getARRawData();
    const rawReadMs = Date.now() - rawStartedAt;
    const geometryStartedAt = Date.now();
    const frame = prepareFrame(raw, config, session.geometry);
    const geometryReused = session.geometry === frame.geometry;
    session.geometry = frame.geometry;
    const geometryPrepareMs = Date.now() - geometryStartedAt;
    // 引擎可能复用原始缓冲：在第一次分片 yield 前复制同一帧的 Y/UV 数据。
    // 独立取图锁持有到导出结束，因此可以安全复用这两块快照内存。
    const snapshotStartedAt = Date.now();
    const snapshotReused = session.ySnapshot?.length === frame.y.length &&
      session.uvSnapshot?.length === frame.uv.length;
    if (!snapshotReused) {
      const ySnapshot = new Uint8Array(frame.y.length);
      const uvSnapshot = new Uint8Array(frame.uv.length);
      Object.assign(session, { ySnapshot, uvSnapshot });
    }
    session.ySnapshot.set(frame.y);
    session.uvSnapshot.set(frame.uv);
    frame.y = session.ySnapshot;
    frame.uv = session.uvSnapshot;
    const snapshotMs = Date.now() - snapshotStartedAt;
    await yieldCapture();
    assertCaptureCurrent(isCurrent);
    const canvasStartedAt = Date.now();
    if (!session.canvas || session.canvas.width !== frame.width || session.canvas.height !== frame.height) {
      const canvas = wx.createOffscreenCanvas({ type: "2d", width: frame.width, height: frame.height });
      const ctx = canvas.getContext("2d");
      const pixels = ctx?.createImageData(frame.width, frame.height);
      if (!pixels?.data) throw new Error("相机画布创建失败，请稍后重试");
      // 完整创建成功后再缓存，临时资源不足不能使后续重试一直使用半初始化画布。
      Object.assign(session, { canvas, ctx, pixels });
    }
    frame.data = session.pixels.data;
    const canvasPrepareMs = Date.now() - canvasStartedAt;
    await yieldCapture();
    const conversion = await convertForCapture(frame, session, isCurrent);
    await yieldCapture();
    assertCaptureCurrent(isCurrent);
    const writeStartedAt = Date.now();
    session.ctx.putImageData(session.pixels, 0, 0);
    const canvasWriteMs = Date.now() - writeStartedAt;
    await yieldCapture();
    assertCaptureCurrent(isCurrent);
    const exportStartedAt = Date.now();
    exportPending = true;
    return await new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        // 不能取消原生导出：保持 busy 到真实回调，防下一张覆盖尚在读取的画布。
        reject(new Error("相机图片导出超时，请重新进入 AR 页面"));
      }, 5000);
      const finishExport = () => {
        clearTimeout(timer);
        exportPending = false;
        releaseCapture();
      };
      try {
        wx.canvasToTempFilePath({
          canvas: session.canvas, fileType: "jpg", quality: 0.8,
          success: (res) => {
            finishExport();
            if (expired || !isCurrent()) {
              removeTempFile(res.tempFilePath);
              if (!expired) reject(new Error("取图已取消"));
              return;
            }
            const info = {
              rawWidth: frame.rawWidth, rawHeight: frame.rawHeight,
              width: frame.width, height: frame.height,
              rotation: config.rotation || 0, uvOrder: config.uvOrder || "uv",
              rawReadMs, geometryPrepareMs, geometryReused, snapshotMs, snapshotReused, canvasPrepareMs, ...conversion, canvasWriteMs,
              jpegExportMs: Date.now() - exportStartedAt,
            };
            try {
              onFrameInfo?.(info);
              resolve(res.tempFilePath);
            } catch (error) {
              removeTempFile(res.tempFilePath);
              reject(error);
            }
          },
          fail: () => {
            finishExport();
            reject(new Error("相机图片导出失败，请检查真机兼容性"));
          },
        });
      } catch (error) {
        finishExport();
        reject(error);
      }
    });
  } finally {
    if (!exportPending) releaseCapture();
  }
}
// Keep capture scheduling in this already-loaded module: new-file hot reload can omit dependencies.
const captureMotion = (() => {
  // Only net displacement in XR world metres can restart a matched session.
  function distance(a, b) {
    return Math.hypot(...a.position.map((n, i) => n - b.position[i]));
  }
  function valid(pose) {
    return Boolean(pose && pose.position?.length === 3 && pose.position.every(Number.isFinite));
  }
  function copy(pose) {
    return { position: [...pose.position] };
  }
  function createGate(now, delayMs) {
    return { readyAt: now + delayMs, locked: false, anchor: null, lastSampleAt: null };
  }
  function lock(gate, pose, now) {
    gate.locked = true;
    gate.anchor = valid(pose) ? copy(pose) : null;
    gate.lastSampleAt = now;
  }
  function sample(gate, pose, now, config) {
    gate.lastSampleAt = now;
    // Movement never gates recognition before a match. Missing tracking cannot unlock a match.
    if (!gate.locked || !valid(pose)) return null;
    if (!gate.anchor) {
      gate.anchor = copy(pose);
      return null;
    }
    const movement = { distanceMeters: distance(gate.anchor, pose) };
    return movement.distanceMeters >= (config.restartDistanceMeters ?? 1.5) ? movement : null;
  }
  function decision(gate, now) {
    if (gate?.locked) return "locked";
    return !gate || now < gate.readyAt ? "preparing" : "ready";
  }
  return { createGate, lock, sample, decision };
})();
const motion = captureMotion;

function readCapturePose(transform) {
  try {
    const position = transform?.worldPosition || transform?.position;
    return position ? { position: [position.x, position.y, position.z] } : null;
  } catch (_) {
    return null;
  }
}

const createCaptureTiming = (config) => ({
  resetCaptureTiming(delay = config.initialCaptureDelayMs ?? 3000) {
    this._captureGate = null;
    this._captureWarmupDelay = delay;
    this._captureGateState = null;
  },
  sampleCaptureMotion(transform, now = Date.now(), force = false) {
    if (!this._arReady || this._retrievalPaused || this._disposed || this.retrievalMode !== "anchor") return;
    if (!this._captureGate) this._captureGate = motion.createGate(now, this._captureWarmupDelay ?? config.initialCaptureDelayMs ?? 3000);
    const lastSampleAt = this._captureGate.lastSampleAt;
    if (!force && lastSampleAt !== null && now >= lastSampleAt && now - lastSampleAt < 100) return;
    const movement = motion.sample(this._captureGate, readCapturePose(transform), now, config);
    if (!movement) return;
    this.restartRecognitionAfterMovement(movement);
    // The restart callback cancels requests and clears assets; start the new delay in this same tick.
    this._captureGate = motion.createGate(now, config.initialCaptureDelayMs ?? 3000);
    this._captureWarmupDelay = config.initialCaptureDelayMs ?? 3000;
    this._captureGateState = null;
  },
  lockCaptureForMatch() {
    const now = Date.now();
    let transform = null;
    try { transform = this.getCamTransform?.(); } catch (_) {}
    if (!this._captureGate) this._captureGate = motion.createGate(now, 0);
    motion.lock(this._captureGate, readCapturePose(transform), now);
    this._captureGateState = null;
    return { hasPose: Boolean(this._captureGate.anchor) };
  },
  captureAllowed() {
    const now = Date.now();
    if (!this._captureGate) this._captureGate = motion.createGate(now, this._captureWarmupDelay ?? config.initialCaptureDelayMs ?? 3000);
    const state = motion.decision(this._captureGate, now);
    if (this._captureGateState !== state) {
      this._captureGateState = state;
      matchLog("取图时机", { state, minIntervalMs: config.intervalMs,
        warmupRemainingMs: Math.max(0, this._captureGate.readyAt - now),
        restartDistanceMeters: config.restartDistanceMeters ?? 1.5 });
      if (state === "preparing") this._recognitionStatus("请先将镜头朝向预设地点，稍后开始识别…");
    }
    return state === "ready";
  },
});

module.exports = { convertFrame, prepareFrame, createGpuConverter, disposeCapture, captureCamera, isCaptureBusy, removeTempFile, createCaptureTiming, captureMotion };

const config = require("./config");
const matchLog = require("./log");
const {
  writeTemp,
  removeFile,
} = require("../../../lib/three-runtime/resources");
const sessions = new WeakMap();
const removeTempFile = removeFile;
function isCaptureBusy(scene) {
  return !!(scene && sessions.get(scene)?.busy);
}
function disposeCapture(scene) {
  const state = scene && sessions.get(scene);
  if (state) state.disposed = true;
}
function exportJPEG(canvas) {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("JPEG 导出超时"));
    }, 5000);
    try {
      wx.canvasToTempFilePath({
        canvas,
        fileType: "jpg",
        quality: 0.8,
        success: (res) => {
          clearTimeout(timer);
          if (expired) removeTempFile(res.tempFilePath);
          else resolve(res.tempFilePath);
        },
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
async function captureCamera(scene, onFrameInfo, isCurrent = () => true) {
  if (!scene?.requestCameraFrame) throw new Error("VisionKit 相机尚未就绪");
  let state = sessions.get(scene);
  if (!state || state.disposed) {
    state = { busy: false, disposed: false };
    sessions.set(scene, state);
  }
  if (state.busy) throw new Error("上一帧仍在导出");
  state.busy = true;
  let path;
  const current = () => !state.disposed && isCurrent();
  try {
    return await scene.requestCameraFrame(async (frame, width, height) => {
      if (!current()) throw new Error("取图已取消");
      const scale = Math.min(
        1,
        (config.maxImageEdge || 640) / Math.max(width, height),
      );
      const w = Math.max(16, Math.floor((width * scale) / 16) * 16),
        h = Math.max(1, Math.round((w * height) / width));
      const started = Date.now();
      let bytes,
        converter = "visionkit-jpeg",
        reason = null;
      if (typeof frame.getCameraJpgBuffer === "function") {
        try {
          const raw = frame.getCameraJpgBuffer(w, h, 80);
          const view = raw && new Uint8Array(raw);
          if (view?.length > 2 && view[0] === 255 && view[1] === 216)
            bytes = raw.slice(0);
          else reason = "native JPEG returned invalid bytes";
        } catch (error) {
          reason = error.message || "native JPEG unavailable";
        }
      } else reason = "getCameraJpgBuffer unavailable";
      let rawReadMs = Date.now() - started,
        canvasWriteMs = 0,
        canvasPrepareMs = 0,
        snapshotMs = 0,
        jpegExportMs = 0;
      if (!bytes) {
        converter = "visionkit-rgba";
        const readAt = Date.now();
        const raw = frame.getCameraBuffer(w, h);
        rawReadMs += Date.now() - readAt;
        if (!raw || raw.byteLength !== w * h * 4)
          throw new Error("VisionKit RGBA 帧尺寸异常");
        // Consume the native frame before the first await. No virtual scene readback.
        const prepareAt = Date.now();
        const canvas = wx.createOffscreenCanvas({
            type: "2d",
            width: w,
            height: h,
          }),
          ctx = canvas.getContext("2d");
        const image = ctx.createImageData(w, h);
        canvasPrepareMs = Date.now() - prepareAt;
        const copyAt = Date.now();
        image.data.set(new Uint8Array(raw));
        snapshotMs = Date.now() - copyAt;
        const writeAt = Date.now();
        ctx.putImageData(image, 0, 0);
        canvasWriteMs = Date.now() - writeAt;
        const exportAt = Date.now();
        path = await exportJPEG(canvas);
        jpegExportMs = Date.now() - exportAt;
      } else {
        const exportAt = Date.now();
        path = await writeTemp(bytes, "jpg");
        jpegExportMs = Date.now() - exportAt;
      }
      if (!current()) {
        removeTempFile(path);
        path = null;
        throw new Error("取图已取消");
      }
      onFrameInfo?.({
        width: w,
        height: h,
        rawWidth: width,
        rawHeight: height,
        rotation: 0,
        uvOrder: "native",
        pixelConverter: converter,
        gpuFallbackReason: reason,
        rawReadMs,
        canvasPrepareMs,
        snapshotMs,
        canvasWriteMs,
        jpegExportMs,
        convertMs: 0,
        convertWorkMs: 0,
        convertYieldWaitMs: 0,
        maxConvertSliceMs: 0,
      });
      return path;
    });
  } catch (error) {
    if (path) removeTempFile(path);
    throw error;
  } finally {
    state.busy = false;
  }
}
// Keep capture scheduling in this already-loaded module: new-file hot reload can omit dependencies.
const captureMotion = (() => {
  // Only net displacement in XR world metres can restart a matched session.
  function distance(a, b) {
    return Math.hypot(...a.position.map((n, i) => n - b.position[i]));
  }
  function valid(pose) {
    return Boolean(
      pose &&
        pose.position?.length === 3 &&
        pose.position.every(Number.isFinite),
    );
  }
  function copy(pose) {
    return { position: [...pose.position] };
  }
  function createGate(now, delayMs) {
    return {
      readyAt: now + delayMs,
      locked: false,
      anchor: null,
      lastSampleAt: null,
    };
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
    return movement.distanceMeters >= (config.restartDistanceMeters ?? 1.5)
      ? movement
      : null;
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
    if (
      !this._arReady ||
      this._retrievalPaused ||
      this._disposed ||
      this.retrievalMode !== "anchor"
    )
      return;
    if (!this._captureGate)
      this._captureGate = motion.createGate(
        now,
        this._captureWarmupDelay ?? config.initialCaptureDelayMs ?? 3000,
      );
    const lastSampleAt = this._captureGate.lastSampleAt;
    if (
      !force &&
      lastSampleAt !== null &&
      now >= lastSampleAt &&
      now - lastSampleAt < 100
    )
      return;
    const movement = motion.sample(
      this._captureGate,
      readCapturePose(transform),
      now,
      config,
    );
    if (!movement) return;
    this.restartRecognitionAfterMovement(movement);
    // The restart callback cancels requests and clears assets; start the new delay in this same tick.
    this._captureGate = motion.createGate(
      now,
      config.initialCaptureDelayMs ?? 3000,
    );
    this._captureWarmupDelay = config.initialCaptureDelayMs ?? 3000;
    this._captureGateState = null;
  },
  lockCaptureForMatch() {
    const now = Date.now();
    let transform = null;
    try {
      transform = this.getCamTransform?.();
    } catch (_) {}
    if (!this._captureGate) this._captureGate = motion.createGate(now, 0);
    motion.lock(this._captureGate, readCapturePose(transform), now);
    this._captureGateState = null;
    return { hasPose: Boolean(this._captureGate.anchor) };
  },
  captureAllowed() {
    const now = Date.now();
    if (!this._captureGate)
      this._captureGate = motion.createGate(
        now,
        this._captureWarmupDelay ?? config.initialCaptureDelayMs ?? 3000,
      );
    const state = motion.decision(this._captureGate, now);
    if (this._captureGateState !== state) {
      this._captureGateState = state;
      matchLog("取图时机", {
        state,
        minIntervalMs: config.intervalMs,
        warmupRemainingMs: Math.max(0, this._captureGate.readyAt - now),
        restartDistanceMeters: config.restartDistanceMeters ?? 1.5,
      });
      if (state === "preparing")
        this._recognitionStatus("请先将镜头朝向预设地点，稍后开始识别…");
    }
    return state === "ready";
  },
});

module.exports = {
  captureCamera,
  isCaptureBusy,
  disposeCapture,
  removeTempFile,
  createCaptureTiming,
  captureMotion,
};

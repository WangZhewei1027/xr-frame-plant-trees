const { THREE } = require("../three-runtime/runtime");
const { download, removeFile } = require("../three-runtime/resources");

function call(method, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("媒体信息读取超时")), 15000);
    function finish(callback, value) { clearTimeout(timer); callback(value); }
    try {
      const result = method({ ...options, success: value => finish(resolve, value), fail: error => finish(reject, error) });
      if (result?.then) result.then(value => finish(resolve, value), error => finish(reject, error));
      else if (result?.tracks) finish(resolve, result);
    } catch (error) { finish(reject, error); }
  });
}
function errorMessage(error) { return error?.message || error?.errMsg || String(error); }

async function inspectSoundtrack(path) {
  if (typeof wx.createMediaContainer !== "function") return true;
  const container = wx.createMediaContainer();
  try {
    const result = await call(options => container.extractDataSource(options), { source: path });
    return result.tracks.some(track => track.kind === "audio");
  } finally { container.destroy(); }
}

async function createVideoPlayback(url, material, resize, { onError, isCancelled, mediaContext }) {
  if (typeof wx.createVideoDecoder !== "function") throw new Error("此微信版本不支持演出视频，请升级微信后重试");
  const path = await download(url);
  let decoder = null, texture = null, disposed = false, timer = null, seekPending = false, operation = Promise.resolve();
  let target = 0, shown = -Infinity, inFlight = 0, loading = true, playing = false, sourceDuration;
  let info;
  const unregister = mediaContext.onDispose(dispose);
  function dispose() {
    if (disposed) return;
    disposed = true; if (timer) clearTimeout(timer); timer = null;
    unregister();
    const previous = decoder; decoder = null;
    // The path must stay alive until pending native work has released the decoder.
    Promise.resolve(operation).catch(() => {}).then(async () => {
      if (previous) {
        try { await previous.stop(); } catch (_) {}
        try { await previous.remove(); } catch (_) {}
      }
      if (path !== url) removeFile(path);
    });
    texture?.dispose(); texture = null; material.map = null;
  }
  function fail(error) {
    if (disposed || isCancelled()) return;
    dispose(); onError(new Error(`视频解码失败: ${errorMessage(error)}`));
  }
  function upload(frame) {
    const { width, height, data } = frame;
    if (!(width > 0 && height > 0 && data?.byteLength >= width * height * 4)) throw new Error("视频解码器返回了无效 RGBA 帧");
    // Native frame memory is reused by getFrameData; retain our own copy.
    const bytes = new Uint8Array(data, 0, width * height * 4);
    if (!texture || texture.image.width !== width || texture.image.height !== height) {
      texture?.dispose();
      texture = new THREE.DataTexture(new Uint8Array(bytes.length), width, height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = true;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      material.map = texture; material.needsUpdate = true; resize(width, height);
    }
    texture.image.data.set(bytes); texture.needsUpdate = true;
  }
  // pkPts is documented only as a raw timestamp, without a portable time base.
  // Seek in the SDK's explicit millisecond unit, serializing/coalescing requests.
  // This also makes paused scrubbing independent of a decoder's wall clock.
  function pump() {
    timer = null;
    if (disposed || isCancelled() || loading || seekPending) return;
    if (Math.abs(target - shown) < 1 / (info.fps || 30)) return;
    seekPending = true; inFlight = target;
    // Seeking exactly to EOF may never yield a frame. Match HTML video's final
    // displayed frame while retaining the requested logical source time.
    const lastFrame = Number.isFinite(sourceDuration) ? Math.max(0, sourceDuration - 1 / (info.fps || 30)) : Infinity;
    try { operation = Promise.resolve(decoder.seek(Math.min(inFlight, lastFrame) * 1000)); }
    catch (error) { fail(error); return; }
    operation.then(() => {
      if (disposed || isCancelled()) return;
      const started = Date.now();
      function read() {
        timer = null;
        if (disposed || isCancelled()) return;
        if (!playing && Math.abs(target - inFlight) > .15) { seekPending = false; pump(); return; }
        try {
          const frame = decoder.getFrameData();
          if (frame) {
            upload(frame); shown = inFlight; seekPending = false;
            if (Math.abs(target - shown) >= 1 / (info.fps || 30)) timer = setTimeout(pump, 0);
          } else if (Date.now() - started > 10000) fail(new Error("获取视频帧超时"));
          else timer = setTimeout(read, 16);
        } catch (error) { fail(error); }
      }
      read();
    }, fail);
  }
  try {
    if (isCancelled()) throw new Error("演出视频加载已取消");
    info = typeof wx.getVideoInfo === "function" ? await call(options => wx.getVideoInfo(options), { src: path }).catch(error => {
      // DevTools does not implement metadata inspection on every supported SDK.
      if (/暂时不支持|not support|not implement/i.test(errorMessage(error))) return {};
      throw error;
    }) : {};
    if (isCancelled()) throw new Error("演出视频加载已取消");
    decoder = wx.createVideoDecoder();
    operation = Promise.resolve(decoder.start({ source: path, mode: 1, abortAudio: true }));
    const started = await operation;
    if (isCancelled()) throw new Error("演出视频加载已取消");
    resize(info.width || started?.width || 16, info.height || started?.height || 9);
    loading = false; sourceDuration = info.duration;
    return {
      path, duration: info.duration,
      get sourceTime() { return target; },
      sync(time, isPlaying, duration) { if (!disposed) { target = time; playing = isPlaying; sourceDuration = duration ?? info.duration; pump(); } },
      dispose,
    };
  } catch (error) { dispose(); throw new Error(`视频加载失败: ${errorMessage(error)}`); }
}

module.exports = { createVideoPlayback, inspectSoundtrack };

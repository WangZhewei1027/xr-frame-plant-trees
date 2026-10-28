const { readBytes } = require("../three-runtime/resources");

function failure(error, label) {
  return new Error(`${label}: ${error?.message || error?.errMsg || String(error)}`);
}
function ignore(promise) { if (promise?.catch) promise.catch(() => {}); }

// A performance shares one hardware context; text/image-only scenes create none.
function createSceneMediaContext() {
  let context = null, disposed = false;
  const buffers = new Map(), cleanups = new Set(), pendingDecodes = new Set();
  return {
    get disposed() { return disposed; },
    onDispose(cleanup) { cleanups.add(cleanup); return () => cleanups.delete(cleanup); },
    getAudioContext() {
      if (disposed) throw new Error("演出音频上下文已释放");
      if (!context) {
        if (typeof wx.createWebAudioContext !== "function") throw new Error("此微信版本不支持演出音频，请升级微信后重试");
        context = wx.createWebAudioContext();
      }
      return context;
    },
    decode(url) {
      if (!buffers.has(url)) buffers.set(url, (async () => {
        const audio = this.getAudioContext(), bytes = await readBytes(url);
        if (disposed) throw new Error("演出音频加载已取消");
        const buffer = await new Promise((resolve, reject) => {
          const cancel = error => finish(reject, error);
          const timer = setTimeout(() => cancel(new Error("音频解码超时")), 15000);
          function finish(callback, value) { clearTimeout(timer); pendingDecodes.delete(cancel); callback(value); }
          pendingDecodes.add(cancel);
          try {
            const result = audio.decodeAudioData(bytes, value => finish(resolve, value), cancel);
            if (result?.then) result.then(value => finish(resolve, value), cancel);
          } catch (error) { cancel(error); }
        });
        if (disposed) throw new Error("演出音频加载已取消");
        if (!(buffer?.duration > 0)) throw new Error("音频没有可播放的数据");
        return buffer;
      })().catch(error => { buffers.delete(url); throw failure(error, "音频解码失败"); }));
      return buffers.get(url);
    },
    dispose() {
      if (disposed) return;
      disposed = true; buffers.clear();
      for (const cleanup of cleanups) { try { cleanup(); } catch (_) {} }
      cleanups.clear();
      for (const cancel of pendingDecodes) cancel(new Error("演出音频加载已取消"));
      pendingDecodes.clear();
      if (context) { try { ignore(context.close()); } catch (_) {} context = null; }
    },
  };
}

// WeChat BufferSource.playbackRate is limited to 2. Resampling by two keeps the
// schema's complete .1–4 range without asking native playback to clamp the rate.
function doubleSpeedBuffer(context, buffer) {
  const length = Math.max(1, Math.ceil(buffer.length / 2));
  const result = context.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel), output = result.getChannelData(channel);
    for (let i = 0; i < length; i++) output[i] = (input[i * 2] + (input[Math.min(i * 2 + 1, input.length - 1)])) / 2;
  }
  return result;
}

async function createAudioPlayback(url, settings, { mediaContext, onError, isCancelled }) {
  const context = mediaContext.getAudioContext();
  const original = await mediaContext.decode(url);
  if (isCancelled()) throw new Error("演出音频加载已取消");
  const factor = settings.playbackRate > 2 ? 2 : 1;
  let buffer = factor === 2 ? doubleSpeedBuffer(context, original) : original;
  const gain = context.createGain(); gain.gain.value = 0; gain.connect(context.destination);
  let disposed = false, source = null, generation = 0, pending = false;
  const unregister = mediaContext.onDispose(dispose);
  let offset = 0, startedAt = 0, desired = null;
  const start = Math.min(original.duration, settings.trimStartSeconds);
  const end = Math.max(start, Math.min(original.duration, settings.trimEndSeconds === null ? Infinity : settings.trimEndSeconds));
  function stop() {
    generation++; pending = false;
    if (!source) return;
    const previous = source; source = null; previous.onended = null;
    try { previous.stop(); } catch (_) {}
    try { previous.disconnect(); } catch (_) {}
  }
  function position() {
    if (!source) return offset;
    const local = Math.max(0, context.currentTime - startedAt) * settings.playbackRate;
    return settings.loop && end > start ? start + ((offset - start + local) % (end - start)) : Math.min(end, offset + local);
  }
  function begin() {
    if (disposed || !desired?.playing || pending || source || end <= start) return;
    const request = ++generation;
    function launch() {
      if (disposed || isCancelled() || request !== generation || !desired?.playing) return;
      pending = false;
      try {
        const node = context.createBufferSource();
        node.buffer = buffer; node.playbackRate.value = settings.playbackRate / factor;
        node.loop = settings.loop; node.loopStart = start / factor; node.loopEnd = end / factor;
        node.connect(gain); source = node; offset = desired.time; startedAt = context.currentTime;
        node.onended = () => { if (source === node) { source = null; try { node.disconnect(); } catch (_) {} } };
        // Explicit stop uses the audio clock (start's duration semantics differ across SDKs).
        node.start(0, offset / factor);
        if (!settings.loop) node.stop(startedAt + Math.max(0, end - offset) / settings.playbackRate);
      } catch (error) { stop(); onError(failure(error, "音频播放失败")); }
    }
    if (context.state === "suspended") {
      pending = true;
      Promise.resolve(context.resume()).then(launch, error => {
        if (disposed || request !== generation) return;
        pending = false; onError(failure(error, "音频恢复失败"));
      });
    } else launch();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stop(); gain.gain.value = 0; unregister();
    try { gain.disconnect(); } catch (_) {}
    buffer = null; desired = null;
  }
  return {
    duration: original.duration,
    get sourceTime() { return desired?.time || 0; },
    sync(time, playing, volume) {
      if (disposed) return;
      desired = { time, playing: playing && end > start && (settings.loop || time < end) };
      gain.gain.value = settings.muted ? 0 : volume;
      if (!desired.playing) { stop(); offset = time; return; }
      if (source && Math.abs(position() - time) > .15) stop();
      begin();
    },
    dispose,
  };
}

module.exports = { createSceneMediaContext, createAudioPlayback, doubleSpeedBuffer };

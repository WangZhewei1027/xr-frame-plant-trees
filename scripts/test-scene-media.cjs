const assert = require("node:assert/strict");
const { createSceneSurface, createSceneMediaContext } = require("../miniprogram/lib/scene-runtime/media");
const { doubleSpeedBuffer } = require("../miniprogram/lib/scene-runtime/media-audio");
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }
function buffer(channels = 2, length = 200, sampleRate = 10) {
  const data = Array.from({ length: channels }, () => Float32Array.from({ length }, (_, i) => i / length));
  return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: channel => data[channel] };
}
function platform(options = {}) {
  const state = { contexts: [], decoders: [], removed: [], canvases: [], containers: [] };
  global.wx = {
    downloadFile({ url, success }) { success({ statusCode: 200, tempFilePath: `/tmp/${url.split('/').pop()}` }); },
    getFileSystemManager() { return { readFile({ success }) { success({ data: new ArrayBuffer(8) }); }, unlink({ filePath }) { state.removed.push(filePath); } }; },
    getVideoInfo({ success }) { success({ width: 1920, height: 1080, duration: 20, fps: 30 }); },
    createMediaContainer() {
      const container = { destroyed: 0, extractDataSource({ success }) { success({ tracks: options.silent ? [{ kind: "video" }] : [{ kind: "video" }, { kind: "audio" }] }); }, destroy() { this.destroyed++; } };
      state.containers.push(container); return container;
    },
    createWebAudioContext() {
      const context = {
        currentTime: 0, state: options.suspended ? "suspended" : "running", destination: {}, sources: [], gains: [], closed: 0, decodes: 0,
        createBuffer: buffer,
        decodeAudioData(bytes, success, fail) {
          this.decodes++;
          if (options.decode) options.decode.promise.then(success, fail);
          else if (options.codecError) fail(new Error("unsupported codec"));
          else success(buffer());
        },
        createBufferSource() {
          const source = { playbackRate: { value: 1 }, starts: [], stops: [], disconnected: 0,
            connect(target) { this.target = target; }, start(...args) { this.starts.push(args); }, stop(...args) { this.stops.push(args); }, disconnect() { this.disconnected++; } };
          this.sources.push(source); return source;
        },
        createGain() { const gain = { gain: { value: 1 }, disconnected: 0, connect() {}, disconnect() { this.disconnected++; } }; this.gains.push(gain); return gain; },
        resume() { if (options.resume) return options.resume.promise.then(() => { this.state = "running"; }); this.state = "running"; return Promise.resolve(); },
        close() { this.closed++; return Promise.resolve(); },
      };
      state.contexts.push(context); return context;
    },
    createVideoDecoder() {
      const decoder = { seeks: [], stopped: 0, removed: 0, frame: null,
        start(args) { this.args = args; return options.start?.promise || Promise.resolve({ width: 1920, height: 1080 }); },
        seek(ms) {
          this.seeks.push(ms);
          const done = () => { this.frame = { width: 2, height: 1, pkPts: ms * 1000, data: Uint8Array.from([Math.round(ms / 1000), 0, 0, 255, 0, 0, 0, 255]).buffer }; };
          if (options.seek) return options.seek(this, ms).then(done);
          done(); return Promise.resolve();
        },
        getFrameData() { const frame = this.frame; this.frame = null; return frame; },
        stop() { this.stopped++; return Promise.resolve(); }, remove() { this.removed++; return Promise.resolve(); },
      };
      state.decoders.push(decoder); return decoder;
    },
    createOffscreenCanvas({ width, height }) {
      const canvas = { width, height, calls: [] };
      const context = { font: "", measureText(text) { return { width: Array.from(text).length * 50 }; }, scale(...args) { canvas.calls.push(["scale", ...args]); },
        fillRect(...args) { canvas.calls.push(["rect", ...args]); }, fillText(...args) { canvas.calls.push(["text", ...args]); },
        getImageData(x, y, w, h) { canvas.raster = { width: w, height: h }; return { data: new Uint8ClampedArray(w * h * 4) }; } };
      canvas.getContext = () => context; state.canvases.push(canvas); return canvas;
    },
  };
  state.canvas = { createImage() { return { width: 300, height: 200, set src(value) { this.path = value; if (this.onload) queueMicrotask(() => this.onload?.()); } }; } };
  return state;
}
const media = { trimStartSeconds: 2, trimEndSeconds: 10, playbackRate: 1, volume: .8, muted: false, loop: false };
const instance = (overrides = {}) => ({ id: "cue", asset: "asset", timing: { startSeconds: 2, endSeconds: 12, fadeInSeconds: 2, fadeOutSeconds: 2 }, media, ...overrides });
const resource = kind => ({ kind, url: `https://assets.example/${kind}.bin` });

async function main() {
  {
    const state = platform(), owner = createSceneMediaContext();
    const text = { content: "ABCD\nEF", fontSize: 1, width: 2, align: "right", color: "#ffffff", backgroundColor: "#112233" };
    const surface = await createSceneSurface({ id: "text", text }, undefined, { mediaContext: owner });
    assert.equal(state.contexts.length, 0, "text must not allocate audio hardware");
    assert.equal(state.canvases[0].raster.width, 192);
    assert.equal(state.canvases[0].raster.height, 437);
    assert.deepEqual(state.canvases[0].calls.filter(c => c[0] === "text").map(c => c.slice(1, 3)), [["AB", 168], ["CD", 168], ["EF", 168]]);
    near(surface.object.children[0].scale.y, (3 * 129.6 + 48) / 192 * 2);
    near(surface.object.children[0].position.y, surface.object.children[0].scale.y / 2);
    assert.equal(surface.materials[0].depthWrite, false);
    let disposed = 0; surface.materials[0].map.addEventListener("dispose", () => disposed++);
    surface.dispose(); surface.dispose(); assert.equal(disposed, 1); owner.dispose();
  }
  {
    const state = platform();
    const surface = await createSceneSurface(instance(), resource("image"), { canvas: state.canvas });
    near(surface.object.children[0].scale.x, 2); near(surface.object.children[0].scale.y, 4 / 3);
    assert.deepEqual(state.removed, ["/tmp/image.bin"]);
    assert.equal(state.contexts.length, 0); surface.dispose();
  }
  {
    const state = platform(), owner = createSceneMediaContext();
    const a = await createSceneSurface(instance(), resource("audio"), { mediaContext: owner });
    const b = await createSceneSurface(instance(), resource("audio"), { mediaContext: owner });
    const native = state.contexts[0];
    assert.equal(state.contexts.length, 1); assert.equal(native.decodes, 1);
    assert.equal(native.sources.length, 0, "loading must never produce sound");
    a.sync(1, true, 20); assert.equal(native.sources.length, 0, "before cue start");
    a.sync(3, true, 20); near(a.audio.sourceTime, 3); near(native.gains[0].gain.value, .4);
    assert.deepEqual(native.sources[0].starts, [[0, 3]]);
    assert.deepEqual(native.sources[0].stops, [[7]], "trimmed end scheduled in audio-clock seconds");
    native.currentTime = .1; a.sync(3.1, true, 20); assert.equal(native.sources.length, 1, "continuous playback must retain source");
    a.sync(7, true, 20); assert.equal(native.sources.length, 2); near(native.sources[1].starts[0][1], 7);
    a.sync(11, true, 20); near(native.gains[0].gain.value, .4); assert.equal(native.sources[1].stops.at(-1).length, 0, "clip end stops immediately");
    a.sync(4, false, 20); near(a.audio.sourceTime, 4);
    a.sync(4, true, 20); assert.equal(native.sources.length, 3);
    a.sync(12, true, 20); near(native.gains[0].gain.value, 0);
    owner.dispose(); assert.equal(native.closed, 1); assert.equal(a.object.children.length, 0); b.dispose();
  }
  {
    const state = platform();
    const a = await createSceneSurface(instance({ media: { ...media, playbackRate: 4, loop: true } }), resource("audio"));
    a.sync(3, true, 20);
    const node = state.contexts[0].sources[0];
    near(a.audio.sourceTime, 6); near(node.playbackRate.value, 2); near(node.starts[0][1], 3);
    near(node.loopStart, 1); near(node.loopEnd, 5); near(node.buffer.duration, 10);
    state.contexts[0].currentTime = 1; a.sync(4, true, 20); near(a.audio.sourceTime, 2);
    assert.equal(state.contexts[0].sources.length, 1, "native trimmed loop follows the same source clock");
    a.dispose();
    const odd = doubleSpeedBuffer({ createBuffer: buffer }, buffer(1, 5, 10));
    assert.equal(odd.length, 3); assert.ok([...odd.getChannelData(0)].every(Number.isFinite));
  }
  {
    const resume = deferred(), state = platform({ suspended: true, resume });
    const a = await createSceneSurface(instance(), resource("audio"));
    a.sync(3, true, 20); a.sync(8, false, 20); resume.resolve(); await flush();
    assert.equal(state.contexts[0].sources.length, 0, "late resume cannot undo pause");
    a.sync(8, true, 20); assert.equal(state.contexts[0].sources.length, 1); a.dispose();
  }
  {
    const resume = deferred(), state = platform({ suspended: true, resume });
    const a = await createSceneSurface(instance(), resource("audio"));
    a.sync(3, true, 20); a.dispose(); resume.resolve(); await flush();
    assert.equal(state.contexts[0].sources.length, 0, "late resume cannot resurrect disposed sound");
  }
  {
    const decode = deferred(), state = platform({ decode }), owner = createSceneMediaContext();
    const loading = createSceneSurface(instance(), resource("audio"), { mediaContext: owner });
    await flush(); owner.dispose(); await assert.rejects(loading, /取消/);
    decode.resolve(buffer()); await flush(); assert.equal(state.contexts[0].gains.length, 0);
  }
  {
    const state = platform({ codecError: true });
    await assert.rejects(createSceneSurface(instance(), resource("audio")), /音频解码失败.*unsupported codec/);
    assert.equal(state.contexts[0].closed, 1);
  }
  {
    const gates = [], state = platform({ silent: true, seek() { const gate = deferred(); gates.push(gate); return gate.promise; } });
    const a = await createSceneSurface(instance(), resource("video"));
    assert.equal(state.contexts.length, 0, "silent video must not require an audio codec");
    const decoder = state.decoders[0];
    assert.deepEqual(decoder.args, { source: "/tmp/video.bin", mode: 1, abortAudio: true });
    a.sync(3, false, 20); a.sync(8, false, 20);
    assert.deepEqual(decoder.seeks, [3000], "native seeks must never overlap");
    gates[0].resolve(); await flush(); assert.deepEqual(decoder.seeks, [3000, 8000]);
    gates[1].resolve(); await flush();
    assert.equal(a.materials[0].map.image.data[0], 8, "late old seek must not replace the latest frame");
    near(a.object.children[0].scale.y, 1); near(a.video.sourceTime, 8);
    a.sync(4, false, 20); const texture = a.materials[0].map; let released = 0; texture.addEventListener("dispose", () => released++);
    a.dispose(); assert.equal(released, 1); assert.equal(decoder.removed, 0, "pending seek owns decoder until settled");
    gates[2].resolve(); await flush(); assert.equal(decoder.removed, 1); assert.equal(decoder.stopped, 1);
    assert.deepEqual(state.removed, ["/tmp/video.bin"]);
  }
  {
    const gates = [], state = platform({ silent: true, seek() { const gate = deferred(); gates.push(gate); return gate.promise; } });
    const a = await createSceneSurface(instance({ timing: undefined, media: { ...media, trimStartSeconds: 0, trimEndSeconds: 20, playbackRate: 4, loop: true } }), resource("video"));
    a.sync(0, true, 30);
    // At 4x, 50ms of native seek latency means the requested source moves .2s.
    // Completed frames must still be presented; rejecting each as stale starves video forever.
    let version = 0;
    for (let step = 1; step <= 10; step++) {
      a.sync(step * .05, true, 30);
      gates[step - 1].resolve();
      await flush();
      const texture = a.materials[0].map;
      assert.ok(texture && texture.version > version, "slow continuous decoding must present every completed frame");
      version = texture.version;
      await new Promise(resolve => setTimeout(resolve, 2));
      assert.equal(gates.length, step + 1, "completed frame schedules a single coalesced latest request");
    }
    a.dispose(); gates.at(-1).resolve(); await flush();
    assert.equal(state.decoders[0].removed, 1);
  }
  {
    const state = platform({ silent: true });
    const a = await createSceneSurface(instance({ timing: undefined, media: { ...media, trimStartSeconds: 0, trimEndSeconds: null } }), resource("video"));
    a.sync(20, false, 30); await flush();
    near(a.video.sourceTime, 20);
    near(state.decoders[0].seeks[0], (20 - 1 / 30) * 1000);
    assert.ok(a.materials[0].map, "EOF must retain a decodable final frame"); a.dispose(); await flush();
  }
  {
    const start = deferred(), state = platform({ start }), owner = createSceneMediaContext();
    const loading = createSceneSurface(instance(), resource("video"), { mediaContext: owner });
    await flush(); owner.dispose(); start.resolve({ width: 160, height: 90 });
    await assert.rejects(loading, /取消/); await flush();
    assert.equal(state.decoders[0].removed, 1); assert.equal(state.contexts.length, 0);
  }
  {
    const state = platform(), errors = [];
    const a = await createSceneSurface(instance(), resource("video"), { onError: error => errors.push(error) });
    a.sync(3, true, 20); await flush();
    near(a.audio.sourceTime, a.video.sourceTime); near(state.contexts[0].gains[0].gain.value, .4);
    state.decoders[0].seek = () => Promise.reject(new Error("decoder lost"));
    a.sync(7, true, 20); await flush(); assert.match(errors[0].message, /decoder lost/);
    assert.equal(state.contexts[0].sources.at(-1).stops.at(-1).length, 0, "decoder failure must silence its soundtrack");
    assert.equal(state.contexts[0].closed, 1); a.dispose();
  }
  console.log("scene media: text/image layout, cue volume, trim/rate/loop, async seek/resume and resource disposal passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const virtualFiles = new Map();
let lastJPEGOptions, component;
const wx = {
  env: { USER_DATA_PATH: "/tmp/ar-test" },
  getStorageSync: () => "",
  setStorageSync() {},
  base64ToArrayBuffer: (value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.length,
    );
  },
  getFileSystemManager: () => ({
    readFile({ filePath, success, fail }) {
      try {
        const data = fs.readFileSync(
          /^\/?assets\//.test(filePath) ? path.join(root, filePath) : filePath,
        );
        success({
          data: data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.length,
          ),
        });
      } catch (e) {
        fail(e);
      }
    },
    writeFile({ filePath, data, success }) {
      virtualFiles.set(filePath, data);
      success();
    },
    unlink({ filePath }) {
      virtualFiles.delete(filePath);
    },
  }),
  createOffscreenCanvas(options) {
    const canvas = { width: options.width, height: options.height };
    const ctx = {
      font: "",
      measureText: (s) => ({ width: Array.from(s).length * 24 }),
      clearRect() {},
      fillText() {},
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
      getImageData: (x, y, w, h) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
    };
    canvas.getContext = () => ctx;
    return canvas;
  },
  canvasToTempFilePath(options) {
    lastJPEGOptions = options;
    virtualFiles.set("/tmp/export.jpg", new ArrayBuffer(4));
    options.success({ tempFilePath: "/tmp/export.jpg" });
  },
};
const context = vm.createContext({
  console: { log() {}, warn() {}, error: console.error },
  setTimeout,
  clearTimeout,
  wx,
  Intl,
  Component: (value) => {
    component = value;
  },
});
const modules = new Map();
function load(file) {
  if (!path.extname(file)) file += fs.existsSync(file + ".js") ? ".js" : ".ts";
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  let code = fs.readFileSync(file, "utf8");
  if (file.endsWith(".ts"))
    code = transformSync(code, { loader: "ts", format: "cjs" }).code;
  vm.runInContext(`(function(require,module,exports){${code}\n})`, context, {
    filename: file,
  })(
    (name) => load(path.resolve(path.dirname(file), name)),
    module,
    module.exports,
  );
  return module.exports;
}
const lib = (name) => load(path.join(root, "lib/three-runtime", name));
async function main() {
  const { THREE } = lib("runtime");
  const { layoutText, splitGraphemes, createTextAsset } = lib("text");
  const wrapped = layoutText("中文测试\nhello", (s) => Array.from(s).length, 3);
  assert.deepEqual(Array.from(wrapped.lines), ["中文测", "试", "hel", "lo"]);
  assert.equal(splitGraphemes("👨‍👩‍👧‍👦👍🏽").length, 2);
  const short = createTextAsset("Hi", {}, "dialog_decorated"),
    long = createTextAsset(
      "这是一段需要自动换行的文字，用于检查动态气泡尺寸和显式换行。",
      {},
      "dialog_decorated",
    );
  assert.ok(long.userData.textLayout.lines > 1);
  assert.ok(long.userData.textLayout.height > short.userData.textLayout.height);
  assert.ok(
    short.children.some((node) => node.geometry.type === "ShapeGeometry"),
  );
  const plain = createTextAsset(
    "白字",
    { text_color: "#fa0", text_size: 2 },
    "plain_white",
  );
  assert.equal(plain.children.length, 1);
  assert.ok(createTextAsset("\n".repeat(1000)).userData.textLayout.truncated);
  let releasedTextures = 0;
  short.traverse((node) =>
    node.material?.map?.addEventListener("dispose", () => releasedTextures++),
  );
  lib("resources").disposeTree(short);
  assert.equal(releasedTextures, 1);
  lib("resources").disposeTree(long);
  lib("resources").disposeTree(plain);
  console.log(
    "PASS dynamic text: Chinese/newlines/emoji, geometry backgrounds, size/color, bounded texture and disposal",
  );

  const canvas = {
    createImage() {
      const image = { width: 16, height: 16 };
      Object.defineProperty(image, "src", {
        set() {
          Promise.resolve().then(() => image.onload?.());
        },
      });
      return image;
    },
  };
  const resources = lib("resources");
  const gltf = await resources.loadGLTF(canvas, "/assets/headphone.glb");
  let meshes = 0,
    maps = 0;
  gltf.scene.traverse((node) => {
    if (node.isMesh) meshes++;
    if (node.material?.map) maps++;
  });
  assert.ok(meshes > 0);
  assert.ok(maps > 0, "actual headphone GLB embedded image must be loaded");
  assert.equal(virtualFiles.size, 0);
  assert.equal(
    resources.resolveURI(
      "../textures/a.png",
      "https://example.com/models/x/model.gltf",
    ),
    "https://example.com/models/textures/a.png",
  );
  resources.disposeTree(gltf.scene, { shared: true });
  console.log(
    "PASS actual business GLB: geometry + embedded image via native resource adapter, no browser globals/temp leaks",
  );

  const { ARRuntime, RETICLE_MODEL_PATH } = lib("ar-runtime");
  assert.equal(RETICLE_MODEL_PATH, "assets/ar-plane-marker.glb");
  let reticleHits = 0;
  let reticleHit = new THREE.Matrix4().makeTranslation(0, 0, -1).elements;
  const cursorRuntime = Object.assign(Object.create(ARRuntime.prototype), {
    canvas,
    camera: new THREE.PerspectiveCamera(),
    reticle: new THREE.Group(),
    reticleReady: false,
    session: {
      hitTest(x, y) {
        assert.equal(x, 0.5);
        assert.equal(y, 0.5);
        reticleHits++;
        return reticleHit ? [{ transform: reticleHit }] : [];
      },
    },
    onReticleError(error) {
      throw error;
    },
  });
  cursorRuntime.updateReticle(true);
  assert.equal(
    cursorRuntime.reticle.visible,
    false,
    "do not plant before the real cursor model is ready",
  );
  assert.equal(reticleHits, 0);
  await cursorRuntime.loadReticleModel();
  const oldMarker = cursorRuntime.reticle.getObjectByName("Torus");
  assert.ok(
    oldMarker?.isMesh,
    "restore the actual old GLB rather than a generated circle",
  );
  assert.equal(oldMarker.geometry.attributes.position.count, 150);
  assert.ok(Math.abs(oldMarker.scale.x - 0.7128448486328125) < 1e-9);
  assert.equal(oldMarker.material.emissive.b, 1);

  const baseModel = new THREE.Group();
  baseModel.add(
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()),
  );
  let cachedDisposals = 0;
  baseModel.children[0].geometry.addEventListener(
    "dispose",
    () => cachedDisposals++,
  );
  const cache = new resources.ModelCache(canvas, 0, async () => ({
    scene: baseModel,
    animations: [],
  }));
  const a = await cache.acquire("same"),
    b = await cache.acquire("same");
  assert.notEqual(a.object, b.object);
  resources.disposeTree(a.object);
  a.release();
  assert.equal(cachedDisposals, 0);
  resources.disposeTree(b.object);
  b.release();
  assert.equal(cachedDisposals, 1);
  cache.dispose();
  console.log(
    "PASS reference-counted GLB cache: one instance cleanup cannot invalidate another",
  );

  load(path.join(root, "components/xr-start/index"));
  const tickHost = {
    _arReady: true,
    _runtime: cursorRuntime,
    retrievalMode: "gps",
    nodeList: [],
    sampleCaptureMotion() {},
    tickFlyingDanmakus() {},
    tickRepulsion() {},
    tickAudioVolume() {},
    tickModelAnimation() {},
    tickHugeModels() {},
    tickConfetti() {},
  };
  for (let i = 1; i <= 5; i++) {
    reticleHit = new THREE.Matrix4().makeTranslation(i * 0.01, 0, -1).elements;
    component.methods.handleTick.call(tickHost, 1 / 60);
    assert.equal(cursorRuntime.reticle.position.x, i * 0.01);
  }
  assert.equal(
    reticleHits,
    5,
    "no 100 ms gate between consecutive component frames",
  );
  tickHost.retrievalMode = "anchor";
  tickHost._nextRecognitionAt = Infinity;
  component.methods.handleTick.call(tickHost, 1 / 60);
  assert.equal(cursorRuntime.reticle.visible, false);
  assert.equal(reticleHits, 5);
  tickHost.retrievalMode = "gps";
  reticleHit = null;
  component.methods.handleTick.call(tickHost, 1 / 60);
  assert.equal(cursorRuntime.reticle.visible, false);
  reticleHit = new Array(16).fill(NaN);
  component.methods.handleTick.call(tickHost, 1 / 60);
  assert.equal(cursorRuntime.reticle.visible, false);
  reticleHit = new THREE.Matrix4().makeTranslation(1, 0, -2).elements;
  component.methods.handleTick.call(tickHost, 1 / 60);
  assert.equal(cursorRuntime.reticle.visible, true);
  tickHost._retrievalPaused = true;
  component.methods.handleTick.call(tickHost, 1 / 60);
  assert.equal(cursorRuntime.reticle.visible, false);
  resources.disposeTree(cursorRuntime.reticle);
  console.log(
    "PASS original cursor GLB/material/scale, per-frame placement updates and invalid/mode/pause hiding",
  );
  for (const m of fs
    .readFileSync(path.join(root, "components/xr-start/index.wxml"), "utf8")
    .matchAll(/bind[\w:]+="(\w+)"/g))
    assert.equal(typeof component.methods[m[1]], "function");
  const host = Object.assign(
    {
      data: {},
      setData(p) {
        Object.assign(this.data, p);
      },
      triggerEvent() {},
    },
    component.methods,
  );
  host.startGPSWatch = () => {};
  host.fetchOrgStyle = () => {};
  component.lifetimes.attached.call(host);
  host._runtime = {
    camera: new THREE.PerspectiveCamera(),
    scene: new THREE.Scene(),
  };
  host._runtime.camera.updateMatrixWorld();
  host.scene = host._runtime.scene;
  host.shadowRoot = new THREE.Group();
  host.scene.add(host.shadowRoot);
  host._arReady = true;
  host._preloadDone = true;
  host._allowedAssetIds.add("t");
  host._placeTextAsset({
    id: "t",
    file_type: "text",
    text_content: "test",
    _contentEpoch: 0,
  });
  assert.equal(host.nodeList.length, 1);
  assert.equal(host.shadowRoot.children.length, 1);
  assert.ok(host.nodeList[0].node.position.z < 0, "Three camera forward is -Z");
  host._clearRemoteAssets();
  assert.equal(host.nodeList.length, 0);
  assert.equal(host.shadowRoot.children.length, 0);
  const stale = new THREE.Group();
  host.shadowRoot.add(stale);
  let staleDisposed = 0;
  host._allowedAssetIds.add("old");
  const rejected = host._registerNode("old", stale, stale, {
    contentEpoch: 0,
    dispose() {
      staleDisposed++;
    },
  });
  assert.equal(rejected._destroyed, true);
  assert.equal(staleDisposed, 1);
  assert.equal(host.shadowRoot.children.length, 0);
  host.retrievalMode = "anchor";
  host._allowedAssetIds.add("wrong");
  host.displayAssets([
    { id: "wrong", file_type: "text", text_content: "must not appear" },
  ]);
  assert.equal(host.shadowRoot.children.length, 0);
  host._matchedAnchorId = "a";
  host._allowedAssetIds = new Set(["ok"]);
  host._placeQueue = [];
  host._placingBusy = true;
  host.displayAssets([
    { id: "ok", file_type: "text", text_content: "accepted" },
    { id: "wrong", file_type: "text" },
  ]);
  assert.equal(host._placeQueue.length, 1);
  assert.equal(host._placeQueue[0].id, "ok");
  host.displayAssets([{ id: "ok", file_type: "text" }]);
  assert.equal(
    host._placeQueue.length,
    1,
    "pending placement must not duplicate",
  );
  host._clearRemoteAssets();
  host._placingBusy = false;
  console.log(
    "PASS production component dependencies/handlers, -Z placement, full text cleanup, stale async rejection, anchor whitelist and queue dedup",
  );

  // Exercise real async placement, including switching away and back to the same anchor/id.
  const allow = (id) => {
    host.retrievalMode = "anchor";
    host._matchedAnchorId = "same-anchor";
    host._allowedAssetIds.add(id);
    return { id, file_url: "/fixture", _contentEpoch: host._contentEpoch };
  };
  let pendingImage;
  host._canvas = {
    createImage() {
      return (pendingImage = { width: 24, height: 16 });
    },
  };
  let textureDisposals = 0;
  const originalDispose = THREE.Texture.prototype.dispose;
  THREE.Texture.prototype.dispose = function () {
    textureDisposals++;
    return originalDispose.call(this);
  };
  const imagePlacement = host._placeImageAsset(allow("late-image"));
  await new Promise(setImmediate);
  host._clearRemoteAssets();
  allow("late-image");
  pendingImage.onload();
  await imagePlacement;
  THREE.Texture.prototype.dispose = originalDispose;
  assert.equal(textureDisposals, 1);
  assert.equal(host.shadowRoot.children.length, 0);
  let finishModel,
    modelReleases = 0;
  host._modelCache = {
    acquire: () =>
      new Promise((resolve) => {
        finishModel = resolve;
      }),
  };
  const modelPlacement = host._placeModelAsset(allow("late-model"));
  host._clearRemoteAssets();
  allow("late-model");
  finishModel({
    object: new THREE.Group(),
    animations: [],
    release() {
      modelReleases++;
    },
  });
  await modelPlacement;
  assert.equal(modelReleases, 1);
  assert.equal(host.shadowRoot.children.length, 0);
  // Anchor mode blocks local planting and local danmaku at the entry point.
  await host.placeNode();
  host.showDanmakuInXR("not associated with the matched anchor");
  assert.equal(host.shadowRoot.children.length, 0);
  host._clearRemoteAssets();
  console.log(
    "PASS late image/model downloads release resources after clearing, even with the same anchor/id; local content blocked in anchor mode",
  );

  host.retrievalMode = "gps";
  const reticle = new THREE.Group();
  reticle.visible = false;
  host.scene.add(reticle);
  host._runtime.reticle = reticle;
  host._runtime.session = {
    hitTest() {
      throw new Error("planting must use the displayed cursor");
    },
  };
  host._modelCache = {
    acquire() {
      throw new Error("no visible cursor must not load a tree");
    },
  };
  await host.placeNode();
  assert.equal(host.nodeList.length, 0);
  reticle.visible = true;
  reticle.position.set(1.2, -0.4, -2.3);
  reticle.rotation.y = 0.4;
  const plantedAt = reticle.position.clone();
  const treeHandle = () => {
    const object = new THREE.Group();
    // Deliberately offset the geometry pivot to catch a floating/off-centre tree.
    object.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(1, 3, 1).translate(2, 5, -1),
        new THREE.MeshBasicMaterial(),
      ),
    );
    return { object, animations: [], release() {} };
  };
  let finishTree;
  host._modelCache = {
    acquire: () =>
      new Promise((resolve) => {
        finishTree = resolve;
      }),
  };
  const planting = host.placeNode(0.1, 0.9);
  reticle.position.set(8, 2, -9); // Phone/cursor moves while the model downloads.
  finishTree(treeHandle());
  await planting;
  const tree = host.nodeList[0];
  assert.ok(tree.node.position.distanceTo(plantedAt) < 1e-9);
  assert.ok(tree.node.quaternion.angleTo(reticle.quaternion) < 1e-7);
  assert.equal(tree.repulsionEnabled, false);
  const treeBounds = new THREE.Box3().setFromObject(tree.node);
  assert.ok(
    Math.abs(treeBounds.min.y - plantedAt.y) < 1e-7,
    "tree base must touch the cursor plane",
  );
  assert.ok(
    Math.abs(treeBounds.getCenter(new THREE.Vector3()).x - plantedAt.x) < 1e-7,
  );
  assert.ok(
    Math.abs(treeBounds.getCenter(new THREE.Vector3()).z - plantedAt.z) < 1e-7,
  );

  reticle.position.copy(plantedAt).add(new THREE.Vector3(0.25, 0, 0));
  host._modelCache = { acquire: async () => treeHandle() };
  await host.placeNode();
  const secondTree = host.nodeList[1],
    secondTreeAt = secondTree.node.position.clone();
  const loose = new THREE.Group();
  loose.position.copy(plantedAt).add(new THREE.Vector3(0.1, 0, 0));
  host.shadowRoot.add(loose);
  host._registerNode(null, loose, null, { type: "image" });
  const looseAt = loose.position.clone();
  host._frameDelta = 1 / 30;
  for (let i = 0; i < 120; i++) host.tickRepulsion();
  assert.ok(tree.node.position.distanceTo(plantedAt) < 1e-9);
  assert.ok(secondTree.node.position.distanceTo(secondTreeAt) < 1e-9);
  assert.ok(
    loose.position.distanceTo(looseAt) < 1e-9,
    "trees must not repel other assets either",
  );
  const otherLoose = new THREE.Group();
  otherLoose.position.copy(looseAt).add(new THREE.Vector3(0.2, 0, 0));
  host.shadowRoot.add(otherLoose);
  host._registerNode(null, otherLoose, null, { type: "image" });
  host.tickRepulsion();
  assert.ok(
    loose.position.distanceTo(looseAt) > 0,
    "ordinary assets retain repulsion",
  );
  assert.ok(tree.node.position.distanceTo(plantedAt) < 1e-9);
  const originalPlaceNode = host.placeNode,
    originalRaycaster = host._raycaster;
  let tapPlantings = 0,
    mediaTaps = 0;
  host.placeNode = (...args) => {
    assert.equal(
      args.length,
      0,
      "finger coordinates must not determine the planting site",
    );
    tapPlantings++;
  };
  host.createSelectorQuery = () => {
    let callback;
    const query = {
      select() {
        return query;
      },
      boundingClientRect(cb) {
        callback = cb;
        return query;
      },
      exec() {
        callback({ left: 10, top: 20, width: 100, height: 200 });
      },
    };
    return query;
  };
  host._raycaster = {
    setFromCamera() {},
    intersectObjects: () => [{ object: tree.node.children[0] }],
  };
  const offCenterTap = { changedTouches: [{ clientX: 90, clientY: 170 }] };
  host.onCanvasTap(offCenterTap);
  assert.equal(
    tapPlantings,
    1,
    "an existing non-interactive tree must not swallow planting taps",
  );
  tree.onTap = () => mediaTaps++;
  host.onCanvasTap(offCenterTap);
  assert.equal(mediaTaps, 1);
  assert.equal(
    tapPlantings,
    1,
    "interactive media taps must not also plant a tree",
  );
  host.placeNode = originalPlaceNode;
  host._raycaster = originalRaycaster;
  delete host.createSelectorQuery;
  host._clearRemoteAssets();
  reticle.removeFromParent();
  console.log(
    "PASS tree planting snapshots the visible cursor, grounds offset geometry and excludes trees from all repulsion",
  );

  const capture = load(path.join(root, "components/xr-start/matching/capture"));
  const gate = capture.captureMotion.createGate(0, 3000);
  assert.equal(capture.captureMotion.decision(gate, 2999), "preparing");
  assert.equal(capture.captureMotion.decision(gate, 3000), "ready");
  capture.captureMotion.lock(gate, { position: [0, 0, 0] }, 3000);
  assert.equal(
    capture.captureMotion.sample(gate, { position: [1.49, 0, 0] }, 4000, {
      restartDistanceMeters: 1.5,
    }),
    null,
  );
  assert.ok(
    capture.captureMotion.sample(gate, { position: [1.5, 0, 0] }, 4000, {
      restartDistanceMeters: 1.5,
    }),
  );
  let frameInfo;
  const source = {
    requestCameraFrame: (callback) =>
      callback(
        {
          getCameraJpgBuffer: () => new Uint8Array([255, 216, 255, 217]).buffer,
        },
        480,
        640,
      ),
  };
  let file = await capture.captureCamera(source, (info) => {
    frameInfo = info;
  });
  assert.equal(frameInfo.pixelConverter, "visionkit-jpeg");
  assert.equal(frameInfo.rotation, 0);
  capture.removeTempFile(file);
  const fallback = {
    requestCameraFrame: (callback) =>
      callback(
        { getCameraBuffer: (w, h) => new Uint8Array(w * h * 4).buffer },
        480,
        640,
      ),
  };
  file = await capture.captureCamera(fallback, (info) => {
    frameInfo = info;
  });
  assert.equal(frameInfo.pixelConverter, "visionkit-rgba");
  assert.equal(lastJPEGOptions.canvas.width % 16, 0);
  capture.removeTempFile(file);
  let finishFrame;
  const pending = {
    requestCameraFrame: (callback) =>
      new Promise((resolve) => {
        finishFrame = () =>
          resolve(
            callback(
              {
                getCameraJpgBuffer: () =>
                  new Uint8Array([255, 216, 255, 217]).buffer,
              },
              480,
              640,
            ),
          );
      }),
  };
  const pendingCapture = capture.captureCamera(pending);
  assert.equal(capture.isCaptureBusy(pending), true);
  capture.disposeCapture(pending);
  finishFrame();
  await assert.rejects(pendingCapture, /取图已取消/);
  assert.equal(virtualFiles.size, 0);
  console.log(
    "PASS matching policy and native capture: 3s delay, displacement lock, JPEG/RGBA fallback, rotation removal, cancellation/file cleanup",
  );
  host.scene.requestCameraFrame = source.requestCameraFrame;
  host.currentGPS = {
    latitude: 31,
    longitude: 121,
    accuracy: 10,
    sampledAt: Date.now(),
  };
  host._retrievalPaused = false;
  host._disposed = false;
  host._arReady = true;
  host.retrievalMode = "anchor";
  host._nextRecognitionAt = 0;
  host.resetCaptureTiming(0);
  wx.uploadFile = (options) => {
    Promise.resolve().then(() =>
      options.success({
        statusCode: 200,
        header: {},
        data: JSON.stringify({
          data: {
            matched: true,
            anchor: { id: "matched-place", name: "Place" },
            assets: [
              {
                id: "result-text",
                file_type: "text",
                text_content: "Anchor text",
              },
            ],
          },
        }),
      }),
    );
    return { abort() {} };
  };
  await host.recognizeAnchor();
  assert.equal(host._matchedAnchorId, "matched-place");
  assert.equal(host._captureGate.locked, true);
  assert.equal(host._nextRecognitionAt, Infinity);
  assert.equal(host.nodeList.length, 1);
  assert.equal(host.nodeList[0].assetId, "result-text");
  host._runtime.camera.position.x = 1.5;
  host.sampleCaptureMotion(host._runtime.camera, Date.now(), true);
  assert.equal(host.nodeList.length, 0);
  assert.equal(host.shadowRoot.children.length, 0);
  assert.equal(host._captureGate.locked, false);
  assert.ok(host._captureGate.readyAt > Date.now() + 2900);
  host.clearRecognitionFrame();
  assert.equal(virtualFiles.size, 0);
  console.log(
    "PASS recognition integration: real matching controller -> Three text -> lock -> 1.5m restart -> complete scene/file cleanup",
  );

  let decoderRemoved = 0,
    audioDestroyed = 0,
    ended,
    getFrame = true;
  wx.createVideoDecoder = () => ({
    on(name, fn) {
      ended = fn;
    },
    off() {},
    start: async () => {},
    stop: async () => {},
    remove: async () => {
      decoderRemoved++;
    },
    seek: async () => {},
    getFrameData: () =>
      getFrame
        ? { data: new Uint8Array(4 * 4 * 4).buffer, width: 4, height: 4 }
        : null,
  });
  wx.createMediaAudioPlayer = () => ({
    addAudioSource: async () => {},
    start: async () => {},
    stop: async () => {},
    removeAudioSource: async () => {},
    destroy: async () => {
      audioDestroyed++;
    },
  });
  const video = lib("video").createVideo("demo.mp4", {}, (e) => {
    throw e;
  });
  await video.play();
  video.tick();
  assert.equal(video.material.uniforms.ready.value, true);
  assert.equal(video.material.uniforms.tbb.value, true);
  video.dispose();
  getFrame = false;
  video.tick();
  assert.equal(decoderRemoved, 1);
  assert.equal(audioDestroyed, 1);
  assert.equal(typeof ended, "function");
  video.material.uniforms.videoMap.value.dispose();
  video.material.dispose();
  let finishStart;
  const createDecoder = wx.createVideoDecoder;
  wx.createVideoDecoder = () => ({
    ...createDecoder(),
    start: () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  });
  const lateVideo = lib("video").createVideo("late.mp4");
  const starting = lateVideo.play();
  lateVideo.dispose();
  finishStart();
  await starting;
  lateVideo.tick();
  assert.equal(lateVideo.material.uniforms.ready.value, false);
  assert.equal(
    audioDestroyed,
    1,
    "late decoder start must not create a new audio player",
  );
  lateVideo.material.dispose();
  console.log(
    "PASS native video frame upload, TBB selection and decoder/audio cleanup",
  );

  for (const file of [
    "index.js",
    "assets/model.js",
    "assets/image.js",
    "assets/audio.js",
    "assets/video.js",
    "assets/text.js",
    "assets/huge.js",
    "effects/danmaku.js",
    "effects/confetti.js",
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, "components/xr-start", file), "utf8"),
      /getXrFrameSystem|scene\.createElement|assets\/bubble/,
    );
  }
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "components/xr-start/index.json"), "utf8"),
    /xr-frame/,
  );
  console.log(
    "PASS production rendering no longer invokes XR renderer or fixed bubble PNGs",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

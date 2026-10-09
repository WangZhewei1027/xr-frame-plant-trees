const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const base = path.resolve(__dirname, '../miniprogram/labs/xr-three');

// Execute the actual generated bundle in an environment with no window,
// document, self, navigator, fetch, TextDecoder or requestAnimationFrame.
const context = vm.createContext({ console, setTimeout, clearTimeout });
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const factory = vm.runInContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`, context, { filename: file });
  factory(name => load(path.resolve(path.dirname(file), name + '.js')), module, module.exports);
  return module.exports;
}
async function main() {
  const { THREE, createAnimationRig, applyToXR, probeWebGL2, createCanvasFacade, flipRows, createFixtureGLB } = load(path.join(base, 'runtime.js'));
  assert.equal(THREE.REVISION, '186');
  const rig = createAnimationRig();
  rig.sample(2);
  assert.ok(Math.abs(rig.object.position.x - 0.5) < 1e-6);
  assert.ok(Math.abs(rig.object.scale.x - 1.4) < 1e-6);
  assert.ok(Math.abs(rig.object.quaternion.y - 1) < 1e-6);
  const actual = {};
  const transform = Object.fromEntries(['position', 'quaternion', 'scale'].map(k => [k, { setValue(...v) { actual[k] = v; } }]));
  applyToXR(rig.object, transform);
  assert.deepEqual(actual.position, [0.5, 0, 0]);
  rig.sample(0); assert.equal(rig.object.position.x, -0.5);
  rig.sample(6); assert.equal(rig.object.position.x, 0.5);
  rig.dispose();
  console.log('PASS: latest Three bundle / mixer / quaternion bridge / seek without browser globals');

  assert.throws(() => probeWebGL2(null), /返回空值/);
  assert.throws(() => probeWebGL2({ getParameter: () => 'WebGL 1.0' }), /不是完整/);
  const mockGL = { VERSION: 1, getParameter: p => p === 1 ? 'WebGL 2.0' : 4096 };
  for (const k of ['createVertexArray', 'bindVertexArray', 'texStorage2D', 'drawBuffers', 'bindBufferBase', 'fenceSync']) mockGL[k] = () => {};
  assert.equal(probeWebGL2(mockGL).version, 'WebGL 2.0');
  const canvas = { width: 256, height: 256 };
  const facade = createCanvasFacade(canvas, mockGL, 256, 256);
  let events = 0; const listener = e => { e.preventDefault(); events++; };
  facade.addEventListener('webglcontextlost', listener); facade.dispatch('webglcontextlost', {});
  facade.removeEventListener('webglcontextlost', listener); facade.dispatch('webglcontextlost', {});
  assert.equal(events, 1); facade.width = 128; assert.equal(canvas.width, 128);
  console.log('PASS: no fake WebGL 1 fallback / canvas facade context events');

  const source = new Uint8Array([1,2,3,4,5,6,7,8]); const target = new Uint8Array(8);
  flipRows(source, target, 1, 2);
  assert.deepEqual([...target], [5,6,7,8,1,2,3,4]);
  assert.deepEqual([...source], [1,2,3,4,5,6,7,8]);
  console.log('PASS: readback orientation without mutating source');

  const gltf = await new Promise((resolve, reject) => new THREE.GLTFLoader().parse(createFixtureGLB(), '', resolve, reject));
  assert.equal(gltf.animations.length, 1);
  assert.equal(gltf.scene.children[0].name, 'GLB演出');
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play(); mixer.setTime(1);
  assert.ok(Math.abs(gltf.scene.children[0].position.x - 0.3) < 1e-6);
  assert.equal(gltf.scene.children[0].geometry.attributes.position.count, 3);
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
  console.log('PASS: real GLTFLoader binary fixture, geometry, UTF-8 name and animation (no fetch/Blob/DOM)');

  let page, component;
  context.Page = value => { page = value; };
  context.Component = value => { component = value; };
  load(path.join(base, 'index.js'));
  load(path.join(base, 'xr-view/index.js'));
  for (const [file, handlers] of [['index.wxml', page], ['xr-view/index.wxml', component.methods]]) {
    for (const match of fs.readFileSync(path.join(base, file), 'utf8').matchAll(/bind(?::?[\w-]+)="([\w]+)"/g)) {
      assert.equal(typeof handlers[match[1]], 'function', `${file}: ${match[1]}`);
    }
  }
  assert.equal(page.data.gpuReady, false);
  assert.equal(page.data.arRunning, false);
  assert.equal(page.data.starting, false);
  load(path.join(base, 'bridge.js'));
  for (const match of fs.readFileSync(path.join(base, 'bridge.wxml'), 'utf8').matchAll(/bind(?::?[\w-]+)="([\w]+)"/g)) {
    assert.equal(typeof page[match[1]], 'function');
  }
  console.log('PASS: page/component CommonJS dependencies and WXML handler registration');

  const { syncVKCamera, applyHitMatrix } = load(path.join(base, 'vk-renderer.js'));
  const nativeCamera = new THREE.PerspectiveCamera(63, 0.75, 0.01, 100);
  nativeCamera.position.set(2, 1.3, 4);
  nativeCamera.rotation.set(0.2, 0.6, -0.1);
  nativeCamera.updateMatrixWorld();
  const native = { viewMatrix: nativeCamera.matrixWorldInverse.toArray(), getProjectionMatrix: () => nativeCamera.projectionMatrix.toArray() };
  const camera = new THREE.PerspectiveCamera();
  assert.equal(syncVKCamera(camera, native), true);
  assert.equal(camera.matrixWorldAutoUpdate, false);
  assert.ok(camera.position.distanceTo(nativeCamera.position) < 1e-10);
  assert.ok(camera.quaternion.angleTo(nativeCamera.quaternion) < 1e-7);
  const worldPoint = new THREE.Vector3(0.2, 0.4, -2).applyMatrix4(nativeCamera.matrixWorld);
  assert.ok(worldPoint.clone().project(camera).distanceTo(worldPoint.clone().project(nativeCamera)) < 1e-10);
  assert.ok(worldPoint.clone().project(camera).unproject(camera).distanceTo(worldPoint) < 1e-9);
  assert.equal(syncVKCamera(camera, { ...native, viewMatrix: new Array(16).fill(0) }), false);
  assert.equal(syncVKCamera(camera, { ...native, viewMatrix: new Array(16).fill(NaN) }), false);
  const placed = new THREE.Group();
  const hit = new THREE.Matrix4().makeTranslation(1, 0, -3);
  assert.equal(applyHitMatrix(placed, hit.elements), true);
  const child = new THREE.Object3D(); child.position.set(0.5, 0.2, 0); placed.add(child);
  placed.updateMatrixWorld(true);
  assert.ok(child.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(1.5, 0.2, -3)) < 1e-10);
  assert.equal(applyHitMatrix(placed, new Array(16).fill(0)), false);
  assert.equal(placed.position.x, 1);
  console.log('PASS: native 6DoF + projection roundtrip, stable local animation under fixed placement, invalid poses rejected');

  const { VKSessionController } = load(path.join(base, 'vk-session.js'));
  const sessions = [], states = [], frames = [];
  let time = 0;
  const api = { isVKSupport: () => true, createVKSession(config) {
    const session = { config, callbacks: new Map(), listeners: new Map(), nextID: 0, frames: 0, stopped: 0, destroyed: 0,
      on(name, fn) { this.listeners.set(name, fn); }, off(name) { this.listeners.delete(name); },
      start(fn) { this.startCallback = fn; }, stop() { this.stopped++; }, destroy() { this.destroyed++; },
      requestAnimationFrame(fn) { const id = ++this.nextID; this.callbacks.set(id, fn); return id; },
      cancelAnimationFrame(id) { this.callbacks.delete(id); },
      getVKFrame(width, height) { this.frames++; assert.equal(width, 480); assert.equal(height, 640); return { camera: {} }; },
      hitTest() { return ['hit']; },
      tick() { const [id, fn] = this.callbacks.entries().next().value; this.callbacks.delete(id); fn(); }
    }; sessions.push(session); return session;
  }};
  const vk = new VKSessionController({ api, gl: {}, size: () => ({ width: 480, height: 640 }), now: () => time,
    onFrame: f => frames.push(f), onState: (state, message) => states.push({ state, message }) });
  vk.start(); const first = sessions[0];
  assert.equal(first.config.version, 'v2');
  vk.stop(); first.startCallback(0);
  assert.equal(vk.running, false); assert.equal(first.callbacks.size, 0); assert.equal(first.destroyed, 1);
  assert.equal(first.listeners.size, 0);
  vk.start(); const second = sessions[1]; second.startCallback(0);
  second.tick(); time = 10; second.tick(); time = 34; second.tick();
  assert.equal(frames.length, 2); assert.equal(second.frames, 2);
  assert.equal(vk.hitTest()[0], 'hit');
  const queued = second.callbacks.values().next().value;
  vk.stop(); queued();
  assert.equal(second.callbacks.size, 0); assert.equal(second.destroyed, 1);
  assert.equal(vk.hitTest().length, 0);
  vk.start(); sessions[2].startCallback(2003002);
  assert.equal(states.at(-1).state, 'error'); assert.match(states.at(-1).message, /相机权限/);
  assert.equal(sessions[2].destroyed, 1);
  vk.start(); sessions[3].startCallback(0);
  vk.onFrame = () => { throw new Error('texture access failed'); };
  time = 80; sessions[3].tick();
  assert.equal(states.at(-1).message, 'texture access failed');
  assert.equal(sessions[3].destroyed, 1); assert.equal(sessions[3].callbacks.size, 0);
  vk.api = { isVKSupport: () => false, createVKSession: () => { throw new Error('must not create v1'); } };
  vk.start(); assert.match(states.at(-1).message, /不支持 VisionKit v2/);
  console.log('PASS: session cancellation, late callbacks, 30 FPS acquisition cap, permission failures, no v1 fallback, error cleanup');

  const nativeFrames = [];
  const nativeRate = new VKSessionController({ api, gl: {}, size: () => ({ width: 480, height: 640 }),
    maxFps: 0, now: () => time, onFrame: frame => nativeFrames.push(frame), onState() {} });
  nativeRate.start();
  const nativeSession = sessions.at(-1);
  nativeSession.startCallback(0);
  for (const timestamp of [100, 108, 116, 133, 150, 166]) {
    time = timestamp; nativeSession.tick();
  }
  assert.equal(nativeFrames.length, 6, 'production must process every native RAF, including intervals shorter than 30 FPS');
  const lateTick = nativeSession.callbacks.values().next().value;
  nativeRate.stop(); lateTick();
  assert.equal(nativeFrames.length, 6);
  assert.equal(nativeSession.destroyed, 1);
  console.log('PASS: production native RAF cadence has no added 30 FPS cap and still cancels late frames');

}
main().catch(e => { console.error(e); process.exitCode = 1; });

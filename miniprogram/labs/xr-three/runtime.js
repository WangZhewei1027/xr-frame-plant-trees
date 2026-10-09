const { THREE, probeWebGL2, createCanvasFacade } = require('../../lib/three-runtime/runtime');

function createAnimationRig() {
  const root = new THREE.Group();
  const object = new THREE.Object3D();
  object.name = 'performer';
  root.add(object);
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const clip = new THREE.AnimationClip('演出', 4, [
    new THREE.VectorKeyframeTrack('performer.position', [0, 1, 2, 3, 4], [
      -0.5, 0, 0, 0, 0.35, 0, 0.5, 0, 0, 0, -0.15, 0, -0.5, 0, 0,
    ]),
    new THREE.QuaternionKeyframeTrack('performer.quaternion', [0, 2, 4], [
      ...q0.toArray(), ...q1.toArray(), ...q0.toArray(),
    ]),
    new THREE.VectorKeyframeTrack('performer.scale', [0, 2, 4], [1, 1, 1, 1.4, 1.4, 1.4, 1, 1, 1]),
  ]);
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(0);
  return {
    root, object, mixer,
    sample(seconds) { mixer.setTime(Math.max(0, seconds) % 4); },
    dispose() { mixer.stopAllAction(); mixer.uncacheRoot(root); },
  };
}

function applyToXR(object, transform) {
  transform.position.setValue(object.position.x, object.position.y, object.position.z);
  transform.quaternion.setValue(object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w);
  transform.scale.setValue(object.scale.x, object.scale.y, object.scale.z);
}

// getImageData-style row order for XR texture upload. Separate buffers avoid
// mutating Three's readback and make orientation explicit in the experiment.
function flipRows(source, target, width, height) {
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    target.set(source.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  }
  return target;
}

// Local GLB with geometry, PBR material and a translation animation. No fetch,
// external texture, Blob URL, Worker or decoder is involved in this test.
function createFixtureGLB() {
  const values = new Float32Array([
    -0.55, -0.45, 0, 0.55, -0.45, 0, 0, 0.55, 0,
    0, 1, 2,
    -0.3, 0, 0, 0.3, 0.25, 0, -0.3, 0, 0,
  ]);
  const doc = {
    asset: { version: '2.0', generator: 'xr-three-lab' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: 'GLB演出', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [1, 0.45, 0.12, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: values.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: 36 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.55, -0.45, 0], max: [0.55, 0.55, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    animations: [{ name: 'fixture-motion', samplers: [{ input: 1, output: 2, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
  };
  // Escape non-ASCII in JSON so this fixture needs no TextEncoder global.
  const json = JSON.stringify(doc).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const jsonSize = Math.ceil(json.length / 4) * 4;
  const buffer = new ArrayBuffer(12 + 8 + jsonSize + 8 + values.byteLength);
  const view = new DataView(buffer);
  [0x46546c67, 2, buffer.byteLength, jsonSize, 0x4e4f534a].forEach((v, i) => view.setUint32(i * 4, v, true));
  const jsonBytes = new Uint8Array(buffer, 20, jsonSize);
  jsonBytes.fill(32);
  for (let i = 0; i < json.length; i++) jsonBytes[i] = json.charCodeAt(i);
  view.setUint32(20 + jsonSize, values.byteLength, true);
  view.setUint32(24 + jsonSize, 0x004e4942, true);
  new Uint8Array(buffer, 28 + jsonSize).set(new Uint8Array(values.buffer));
  return buffer;
}

module.exports = { THREE, createAnimationRig, applyToXR, probeWebGL2, createCanvasFacade, flipRows, createFixtureGLB };

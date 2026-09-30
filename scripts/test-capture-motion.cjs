const assert = require('node:assert/strict');
const { captureMotion, createCaptureTiming } = require('../miniprogram/components/xr-start/matching/capture');
const { createGate, lock, sample, decision } = captureMotion;
const config = { initialCaptureDelayMs: 3000, intervalMs: 1000, restartDistanceMeters: 1.5 };

function pose(degrees = 0, position = [0, 0, 0], axis = 'z') {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const axes = axis === 'x' ? [[1, 0, 0], [0, c, s], [0, -s, c]] :
    axis === 'y' ? [[c, 0, -s], [0, 1, 0], [s, 0, c]] : [[c, s, 0], [-s, c, 0], [0, 0, 1]];
  return { position, axes };
}
function transform(current) {
  if (!current) return null;
  const [x, y, z] = current.position;
  return {
    worldPosition: { x, y, z },
    get worldMatrix() { throw new Error('Movement tracking must never read orientation'); },
  };
}

let gate = createGate(0, 3000);
assert.equal(decision(gate, 2999), 'preparing');
assert.equal(decision(gate, 3000), 'ready');
sample(gate, pose(120, [12, 0, 0]), 3100, config);
assert.equal(decision(gate, 3100), 'ready');
sample(gate, null, 3200, config);
assert.equal(decision(gate, 9000), 'ready');
console.log('PASS fixed preparation delay; movement and missing poses do not block unlocked capture');

lock(gate, pose(), 10000);
assert.equal(decision(gate, 99999), 'locked');
for (let x = 0.1; x < 1.5; x += 0.1) assert.equal(sample(gate, pose(0, [x, 0, 0]), 10100, config), null);
assert.equal(sample(gate, pose(0, [0, 0, 0]), 10200, config), null);
assert.equal(sample(gate, pose(0, [1.5, 0, 0]), 10300, config).distanceMeters, 1.5);
assert.deepEqual(gate.anchor.position, [0, 0, 0]);
console.log('PASS fixed baseline uses net displacement, allows small movements, and restarts at 1.5 m');

for (const axis of ['x', 'y', 'z']) {
  gate = createGate(0, 0);
  lock(gate, pose(), 0);
  for (const degrees of [20, 90, 180, 270, 360]) {
    assert.equal(sample(gate, pose(degrees, [0, 0, 0], axis), 100, config), null);
    assert.equal(decision(gate, 100), 'locked');
  }
}
console.log('PASS pitch, yaw and roll never restart a locked session');

gate = createGate(0, 0);
lock(gate, null, 0);
sample(gate, null, 50000, config);
assert.equal(decision(gate, 50000), 'locked');
assert.equal(sample(gate, pose(90, [10, 0, 0]), 50100, config), null);
assert.deepEqual(gate.anchor.position, [10, 0, 0]);
assert.equal(sample(gate, pose(90, [10.1, 0, 0]), 50200, config), null);
const invalid = pose(); invalid.position[0] = NaN;
assert.equal(sample(gate, invalid, 50300, config), null);
assert.deepEqual(gate.anchor.position, [10, 0, 0]);
assert.equal(sample(gate, pose(90, [11.5, 0, 0]), 50400, config).distanceMeters, 1.5);
console.log('PASS missing tracking remains locked; recovery establishes or preserves a fixed baseline');

const mutablePose = pose();
gate = createGate(0, 0);
lock(gate, mutablePose, 0);
mutablePose.position[0] = 100;
mutablePose.axes[0][0] = 0;
assert.deepEqual(gate.anchor, { position: [0, 0, 0] });
console.log('PASS baseline is copied so later pose mutations cannot move it');

const realNow = Date.now;
let now = 10000;
Date.now = () => now;
try {
  const component = {
    ...createCaptureTiming(config), _arReady: true, retrievalMode: 'anchor',
    xr: { Vector3: { createFromNumber: (x, y, z) => ({ x, y, z }) } },
    currentPose: pose(), restarts: [], statuses: [],
    getCamTransform() { return transform(this.currentPose); },
    _recognitionStatus(message) { this.statuses.push(message); },
    restartRecognitionAfterMovement(movement) { this.restarts.push(movement); this.resetCaptureTiming(); },
  };
  component.resetCaptureTiming();
  component.sampleCaptureMotion(null, now);
  assert.equal(component.captureAllowed(), false);
  now += 3000;
  assert.equal(component.captureAllowed(), true);
  console.log('PASS component preparation completes with no usable XR pose');

  component.sampleCaptureMotion(transform(pose(0, [-10, 0, 0])), now);
  component.currentPose = pose(0, [10, 0, 0]);
  assert.deepEqual(component.lockCaptureForMatch(), { hasPose: true });
  assert.deepEqual(component._captureGate.anchor.position, [10, 0, 0]);
  assert.equal(component.captureAllowed(), false);
  now += 100;
  component.sampleCaptureMotion(transform(pose(0, [11, 0, 0])), now);
  assert.equal(component.restarts.length, 0);
  console.log('PASS successful match locks using the current pose, never an earlier sampled frame');

  now += 50;
  component.sampleCaptureMotion(transform(pose(0, [12, 0, 0])), now);
  assert.equal(component.restarts.length, 0);
  now += 50;
  component.sampleCaptureMotion(transform(pose(0, [11.5, 0, 0])), now);
  assert.equal(component.restarts.length, 1);
  assert.equal(component.restarts[0].distanceMeters, 1.5);
  assert.equal(component._captureGate.readyAt, now + 3000);
  assert.equal(component.captureAllowed(), false);
  now += 2999;
  component.sampleCaptureMotion(transform(pose(150, [100, 0, 0])), now);
  assert.equal(component.captureAllowed(), false);
  now++;
  assert.equal(component.captureAllowed(), true);
  assert.equal(component.restarts.length, 1);
  console.log('PASS 100 ms sampling restarts once, and the next 3 second delay starts in the movement tick');

  component.currentPose = null;
  assert.deepEqual(component.lockCaptureForMatch(), { hasPose: false });
  now += 100;
  component.sampleCaptureMotion(null, now);
  assert.equal(component.captureAllowed(), false);
  now += 100;
  component.sampleCaptureMotion(transform(pose(90, [20, 0, 0])), now);
  assert.equal(component.restarts.length, 1);
  assert.equal(component.captureAllowed(), false);
  now += 100;
  component.sampleCaptureMotion(transform(pose(110, [21.5, 0, 0])), now);
  assert.equal(component.restarts.length, 2);
  console.log('PASS component stays locked through tracking loss and resumes from a recovered baseline');

  now += 3000;
  component.currentPose = { position: [0, 0, 0] };
  assert.deepEqual(component.lockCaptureForMatch(), { hasPose: true });
  now += 100;
  component.sampleCaptureMotion(transform(pose(180)), now);
  assert.equal(component.restarts.length, 2);
  now++;
  component.sampleCaptureMotion(transform(pose(20, [1.5, 0, 0])), now, true);
  assert.equal(component.restarts.length, 3);
  component._retrievalPaused = true;
  component.currentPose = pose();
  component.lockCaptureForMatch();
  now += 100;
  component.sampleCaptureMotion(transform(pose(90)), now);
  assert.equal(component.restarts.length, 3);
  console.log('PASS forced sampling can check immediately; paused recognition does not trigger restarts');
} finally {
  Date.now = realNow;
}

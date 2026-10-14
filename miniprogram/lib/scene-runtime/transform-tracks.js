// Theatre's normalized cubic Bezier handles, kept independent of the editor bundle.
function bezier(t, a, b) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t;
}
function sampleTrack(frames, time) {
  if (time <= frames[0].time) return frames[0].value;
  const last = frames[frames.length - 1];
  if (time >= last.time) return last.value;
  let low = 0, high = frames.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (frames[middle].time <= time) low = middle;
    else high = middle;
  }
  const left = frames[low], right = frames[high];
  if (!left.connectedRight) return left.value;
  const progress = (time - left.time) / (right.time - left.time);
  let a = 0, b = 1;
  for (let i = 0; i < 24; i++) {
    const t = (a + b) / 2;
    if (bezier(t, left.handles[2], right.handles[0]) < progress) a = t;
    else b = t;
  }
  const weight = bezier((a + b) / 2, left.handles[3], right.handles[1]);
  return left.value + (right.value - left.value) * weight;
}
function applyTransformTracks(root, tracks, time) {
  for (const channel of Object.keys(tracks)) {
    const [group, axis] = channel.split(".");
    root[group][axis] = sampleTrack(tracks[channel], time);
  }
}
module.exports = { sampleTrack, applyTransformTracks };

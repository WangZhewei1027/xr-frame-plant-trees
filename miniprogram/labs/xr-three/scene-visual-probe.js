const { samplePresentation } = require('../../lib/scene-runtime/vendor/scene-core');

// A scene may begin with silence/black or contain only audio; neither is a rendering failure.
function visualProbe(manifest) {
  const duration = manifest.content.durationSeconds;
  const visual = manifest.content.instances.filter(instance => instance.text || manifest.resources[instance.asset]?.kind !== 'audio');
  if (visual.some(instance => { const value = samplePresentation(instance, 0, duration); return value.visible && value.opacity > 0; })) return { visual: true, time: 0 };
  for (const instance of visual) {
    const start = instance.timing?.startSeconds ?? 0;
    const end = Math.min(instance.timing?.endSeconds ?? duration ?? 600, duration ?? 600);
    if (start < end) return { visual: true, time: start + (end - start) / 2 };
  }
  return { visual: false, time: 0 };
}
module.exports = { visualProbe };

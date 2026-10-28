// Validate external playback data before starting downloads or constructing a hierarchy.
// The server remains authoritative for team ownership; this boundary protects native resources.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const identifier = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
const kinds = ["model", "image", "audio", "video"];
const channels = ["position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z", "scale.x", "scale.y", "scale.z"];
function invalid(message, instance) {
  throw Object.assign(new Error(message), { kind: "protocol", instanceId: instance?.id, alias: instance?.asset });
}
function validateManifest(manifest) {
  const version = manifest?.schemaVersion, content = manifest?.content;
  if (![4, 5, 7].includes(version) || !record(content) || content.kind !== "composition") invalid("不支持的场景播放协议");
  if (content.units !== "meters" || typeof content.loop !== "boolean") invalid("场景单位或循环参数无效");
  if (content.durationSeconds !== null && !finite(content.durationSeconds, Number.MIN_VALUE, 600)) invalid("场景时长必须大于 0 且不超过 600 秒");
  const list = content.instances, groupList = version === 4 || content.groups === undefined ? [] : content.groups;
  const resources = manifest.resources;
  if (!Array.isArray(list) || !list.length || list.length > 24) invalid("场景必须包含 1–24 个对象");
  if (!Array.isArray(groupList) || groupList.length > 16) invalid("场景分组数量无效");
  if (!record(resources) || Object.keys(resources).length > 8 || !record(content.assets) || Object.keys(content.assets).length > 8) invalid("场景资源列表无效");
  const ids = new Set(), groups = new Map();
  let keyCount = 0, animated = false;
  const transform = node => {
    if (!record(node) || !identifier(node.id) || ids.has(node.id)) invalid("场景对象标识无效或重复", node);
    ids.add(node.id);
    for (const field of ["position", "rotation", "scale"]) {
      const values = node[field];
      if (!Array.isArray(values) || values.length !== 3 || !values.every(value => finite(value, field === "scale" ? Number.MIN_VALUE : -100, 100))) invalid("场景空间变换无效", node);
    }
    if (node.tracks !== undefined) {
      if (!record(node.tracks)) invalid("场景关键帧无效", node);
      for (const [channel, frames] of Object.entries(node.tracks)) {
        if (!channels.includes(channel) || !Array.isArray(frames) || !frames.length) invalid("场景关键帧通道无效", node);
        animated = true; keyCount += frames.length;
        if (keyCount > 2400) invalid("场景关键帧数量不能超过 2400", node);
        let previous = -1;
        for (const frame of frames) {
          if (!record(frame) || !finite(frame.time, 0, 600) || frame.time <= previous || !finite(frame.value, channel.startsWith("scale.") ? Number.MIN_VALUE : -100, 100)) invalid("场景关键帧时间或数值无效", node);
          if (!Array.isArray(frame.handles) || frame.handles.length !== 4 || !frame.handles.every(value => finite(value, -100, 100)) || !finite(frame.handles[0], 0, 1) || !finite(frame.handles[2], 0, 1) || typeof frame.connectedRight !== "boolean") invalid("场景关键帧曲线无效", node);
          previous = frame.time;
        }
      }
    }
  };
  for (const group of groupList) { transform(group); groups.set(group.id, group); }
  for (const group of groupList) {
    const visited = new Set([group.id]);
    for (let parent = group.parent; parent !== undefined; parent = groups.get(parent).parent) {
      if (!groups.has(parent) || visited.has(parent) || visited.size >= 4) invalid("场景分组存在循环、缺失父级或超过四层", group);
      visited.add(parent);
    }
  }
  const kindOf = inst => inst.text !== undefined ? "text" : resources[inst.asset]?.kind ?? "model";
  for (const inst of list) {
    transform(inst);
    if (version !== 4 && inst.parent !== undefined && !groups.has(inst.parent)) invalid("场景对象的父分组不存在", inst);
    const kind = kindOf(inst);
    if (version !== 7 && (kind !== "model" || inst.timing !== undefined || inst.media !== undefined)) invalid("此场景需要演出播放协议 7", inst);
    if (inst.text !== undefined) {
      const text = inst.text;
      if (inst.asset !== undefined || inst.animation != null || inst.media !== undefined || !record(text)) invalid("空间文字不能同时引用素材或媒体参数", inst);
      if (typeof text.content !== "string" || !text.content.trim() || text.content.length > 4000 || !finite(text.fontSize, .02, 5) || !finite(text.width, .1, 20) || !["left", "center", "right"].includes(text.align)) invalid("空间文字内容或排版参数无效", inst);
      if (typeof text.color !== "string" || !/^#[0-9a-f]{6}$/i.test(text.color) || (text.backgroundColor !== undefined && (typeof text.backgroundColor !== "string" || !/^#[0-9a-f]{6}$/i.test(text.backgroundColor)))) invalid("空间文字颜色无效", inst);
    } else {
      const resource = resources[inst.asset];
      if (!identifier(inst.asset) || !own(content.assets, inst.asset) || !own(resources, inst.asset) || !record(resource) || typeof resource.url !== "string" || !resource.url.trim()) invalid(`资源 ${inst.asset} 缺少可用 url`, inst);
      if (!kinds.includes(kind)) invalid("不支持的场景素材类型", inst);
    }
    if (inst.timing !== undefined) {
      animated = true;
      const timing = inst.timing;
      if (!record(timing) || !finite(timing.startSeconds, 0, 600) || (timing.endSeconds !== null && (!finite(timing.endSeconds, 0, 600) || timing.endSeconds <= timing.startSeconds)) || !finite(timing.fadeInSeconds, 0, 600) || !finite(timing.fadeOutSeconds, 0, 600)) invalid("场景出入场或淡入淡出参数无效", inst);
    }
    if (inst.media !== undefined) {
      animated = true;
      const media = inst.media;
      if (!["audio", "video"].includes(kind) || inst.animation != null || !record(media) || !finite(media.trimStartSeconds, 0, 86400) || (media.trimEndSeconds !== null && (!finite(media.trimEndSeconds, 0, 86400) || media.trimEndSeconds <= media.trimStartSeconds)) || !finite(media.playbackRate, .1, 4) || !finite(media.volume, 0, 1) || typeof media.loop !== "boolean" || typeof media.muted !== "boolean") invalid("场景媒体播放参数无效", inst);
    }
    if (inst.animation != null) {
      animated = true;
      const animation = inst.animation;
      if (kind !== "model" || !record(animation) || !finite(animation.startSeconds, 0, 600) || (content.durationSeconds !== null && animation.startSeconds >= content.durationSeconds) || typeof animation.loop !== "boolean") invalid("模型动画参数无效", inst);
      const indexed = animation.clipIndex !== undefined, named = animation.clipName !== undefined;
      if (indexed === named || (indexed && (!Number.isInteger(animation.clipIndex) || animation.clipIndex < 0)) || (named && (typeof animation.clipName !== "string" || !animation.clipName))) invalid("模型动画片段标识无效", inst);
    }
  }
  if (animated && content.durationSeconds === null) invalid("带动画或媒体时序的场景必须设置时长");
  return { content, resources, list, groupList, kindOf };
}
module.exports = { validateManifest };

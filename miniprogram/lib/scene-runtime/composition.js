// One scene clock drives model animation, spatial surfaces and native media.
// The host owns placement/frame scheduling; this player owns every loaded instance.
const { THREE } = require("../three-runtime/runtime");
const { createSceneCore, clipTime: coreClipTime, samplePresentation } = require("./vendor/scene-core");
const { disposeTree } = require("../three-runtime/resources");
const { groundOffset } = require("../three-runtime/pivot");
const { validateManifest } = require("./manifest");

function clipTime(local, clipDuration, loop) {
  return coreClipTime(local, { startSeconds: 0, loop }, clipDuration);
}
function selectClip(animations, animation) {
  if (!animation || typeof animation !== "object") return null;
  if (Number.isInteger(animation.clipIndex)) return animations[animation.clipIndex] || null;
  if (typeof animation.clipName === "string") {
    let found = null;
    for (const clip of animations) {
      if (clip.name !== animation.clipName) continue;
      if (found) return null;
      found = clip;
    }
    return found;
  }
  return null;
}
function tagError(error, fields) {
  return Object.assign(error instanceof Error ? error : new Error(error?.errMsg || String(error)), fields);
}

function createCompositionPlayer(manifest, { modelCache, canvas = modelCache?.canvas, onState, surfaceFactory } = {}) {
  const content = manifest && manifest.content;
  const root = new THREE.Group();
  root.name = `scene:${manifest?.assetId || ""}`;
  const instances = [], groups = new Map(), animated = [], unbind = [];
  let core = null, mediaContext = null, cancelLoading = null;
  const duration = Number.isFinite(content?.durationSeconds) && content.durationSeconds > 0 ? content.durationSeconds : null;
  const sceneLoop = !!content?.loop;
  let state = "idle", t = 0, loadGeneration = 0, disposed = false, diagnostics = null;
  const player = {
    kind: "composition",
    get state() { return state; },
    get root() { return root; },
    get time() { return t; },
    get duration() { return duration; },
    get diagnostics() { return diagnostics; },
    get instances() { return instances; },
    load, play, pause, seek, restart, update, dispose,
    // Scene taps toggle the whole performance through the host, not an individual media clip.
    tap() { return false; },
  };

  function setState(next, message) {
    if (disposed && next !== "disposed") return;
    state = next;
    if (typeof onState === "function") {
      try { onState(next, message || "", player); }
      catch (error) { console.warn("[scene-runtime] onState 回调异常", error); }
    }
  }
  function releaseLoaded(loaded) {
    if (loaded.surface) { try { loaded.surface.dispose(); } catch (_) {} }
    if (loaded.handle) {
      try { disposeTree(loaded.handle.object); } catch (_) {}
      try { loaded.handle.release(); } catch (_) {}
    }
  }
  function teardownBuilt() {
    unbind.splice(0).forEach(stop => stop());
    core?.dispose(); core = null;
    for (const entry of instances) {
      if (entry.mixer) {
        try { entry.mixer.stopAllAction(); entry.mixer.uncacheRoot(entry.object); } catch (_) {}
      }
      // Surface adapters own their entire tree; models keep shared cache geometry/textures.
      releaseLoaded(entry);
      if (entry.handle) for (const original of entry.materials) {
        try { original.material.dispose(); } catch (_) {}
      }
    }
    instances.length = 0; animated.length = 0; groups.clear();
    root.removeFromParent(); root.clear();
    try { mediaContext?.dispose(); } catch (_) {}
    mediaContext = null;
  }
  function describe(error) {
    return { assetId: manifest?.assetId, instanceId: error.instanceId || null, alias: error.alias || null,
      kind: error.kind || "resource", message: error.message || String(error) };
  }
  function failRuntime(error) {
    if (disposed || state === "error") return;
    loadGeneration++;
    cancelLoading?.();
    diagnostics = describe(error);
    teardownBuilt();
    setState("error", diagnostics.message);
  }
  async function load() {
    if (disposed || (state !== "idle" && state !== "error")) return;
    diagnostics = null;
    const generation = ++loadGeneration;
    const acquired = [];
    let loadingError = null, cancelled = false;
    const cancel = () => {
      cancelled = true;
      acquired.splice(0).forEach(releaseLoaded);
    };
    const recordFailure = error => {
      loadingError = loadingError || error;
      cancel();
    };
    cancelLoading = cancel;
    setState("loading");
    try {
      // State observers may navigate away synchronously when loading starts.
      if (disposed || generation !== loadGeneration) return;
      const { list, groupList, resources, kindOf } = validateManifest(manifest);
      if (list.some(inst => kindOf(inst) === "model") && !modelCache) throw tagError(new Error("缺少 ModelCache"), { kind: "protocol" });
      let createSurface = surfaceFactory;
      if (list.some(inst => kindOf(inst) !== "model") && !createSurface) {
        const media = require("./media");
        createSurface = media.createSceneSurface;
        mediaContext = media.createSceneMediaContext();
      }
      const results = await Promise.allSettled(list.map(async inst => {
        const alias = inst.asset, kind = kindOf(inst);
        try {
          let loaded;
          if (kind === "model") loaded = { inst, alias, kind, handle: await modelCache.acquire(resources[alias].url) };
          else loaded = { inst, alias, kind, surface: await createSurface(inst, alias ? resources[alias] : undefined, {
            canvas, mediaContext,
            isCancelled: () => cancelled || disposed || generation !== loadGeneration,
            onError(error) {
              if (disposed || generation !== loadGeneration) return;
              const failure = tagError(error, { alias, instanceId: inst.id, kind: "media" });
              if (state === "loading") recordFailure(failure);
              else failRuntime(failure);
            },
          }) };
          // A sibling can fail or the host can disappear while this operation is pending.
          if (cancelled || disposed || generation !== loadGeneration) releaseLoaded(loaded);
          else acquired.push(loaded);
          return loaded;
        } catch (error) {
          const failure = tagError(error, { alias, instanceId: inst.id, kind: "resource" });
          recordFailure(failure);
          throw failure;
        }
      }));
      if (disposed || generation !== loadGeneration) { acquired.splice(0).forEach(releaseLoaded); return; }
      const failed = results.find(result => result.status === "rejected");
      if (failed || loadingError) throw loadingError || failed.reason;
      for (const group of groupList) {
        const groupRoot = new THREE.Group(); groupRoot.name = `group:${group.id}`;
        groups.set(group.id, groupRoot);
      }
      for (const group of groupList) (groups.get(group.parent) || root).add(groups.get(group.id));
      for (const result of results) {
        const loaded = result.value, { inst, alias, kind, handle, surface } = loaded;
        const object = handle?.object || surface?.object;
        if (!object?.isObject3D) throw tagError(new Error("场景资源没有可渲染对象"), { alias, instanceId: inst.id, kind: "resource" });
        const instanceRoot = new THREE.Group(); instanceRoot.name = `instance:${inst.id}`;
        const entry = { id: inst.id, alias, kind, inst, instanceRoot, object, handle, surface, mixer: null, action: null, materials: [] };
        instances.push(entry); acquired.splice(acquired.indexOf(loaded), 1);
        if (handle) {
          // A model clone shares cache materials; fade settings must never mutate another instance.
          const materials = new Map();
          const independent = original => {
            if (!materials.has(original)) {
              const material = original.clone(); materials.set(original, material);
              entry.materials.push({ material, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
            }
            return materials.get(original);
          };
          object.traverse(node => { if (node.material) node.material = Array.isArray(node.material) ? node.material.map(independent) : independent(node.material); });
          const pivot = new THREE.Group(); pivot.name = "pivot";
          groundOffset(object, pivot.position); pivot.add(object); instanceRoot.add(pivot);
        } else {
          instanceRoot.add(object);
          entry.materials = (surface.materials || []).map(material => ({ material, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite }));
        }
        (groups.get(inst.parent) || root).add(instanceRoot);
      }
      for (const entry of instances) {
        const { inst, alias, handle } = entry;
        if (inst.animation == null) continue;
        const clip = selectClip(handle.animations || [], inst.animation);
        if (!clip || !(clip.duration > 0)) throw tagError(new Error(`实例 ${inst.id} 指定的 clip 不存在、名称不唯一或时长无效`), { alias, instanceId: inst.id, kind: "animation" });
        const mixer = new THREE.AnimationMixer(handle.object), action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.enabled = true; action.play();
        entry.mixer = mixer; entry.action = action;
        animated.push({ action, mixer, startSeconds: inst.animation.startSeconds, loop: inst.animation.loop, clipDuration: clip.duration, lastClip: -1 });
      }
      core = createSceneCore({ content });
      for (const entry of instances) unbind.push(core.bind(entry.id, entry.instanceRoot));
      for (const [id, groupRoot] of groups) unbind.push(core.bind(id, groupRoot));
      core.seek(0); t = 0;
      if (evaluate(0, false)) {
        if (loadingError) throw loadingError;
        setState("ready");
      }
    } catch (error) {
      acquired.splice(0).forEach(releaseLoaded);
      teardownBuilt();
      diagnostics = describe(error);
      if (!disposed && generation === loadGeneration) setState("error", diagnostics.message);
    } finally {
      if (cancelLoading === cancel) cancelLoading = null;
    }
  }

  /** All native state is recomputed from absolute scene time, including when paused/seeking. */
  function evaluate(time, playing = state === "playing") {
    let currentEntry;
    try {
      for (const entry of instances) {
        currentEntry = entry;
        const presentation = samplePresentation(entry.inst, time, duration);
        entry.instanceRoot.visible = presentation.visible;
        for (const original of entry.materials) {
          const transparent = original.transparent || presentation.opacity < 1;
          if (original.material.transparent !== transparent) { original.material.transparent = transparent; original.material.needsUpdate = true; }
          original.material.opacity = original.opacity * presentation.opacity;
          original.material.depthWrite = original.depthWrite && presentation.opacity === 1;
        }
        entry.surface?.sync(time, playing, duration);
        if (disposed || state === "error") return false;
      }
      for (const animation of animated) {
        const clip = clipTime(time - animation.startSeconds, animation.clipDuration, animation.loop);
        if (clip === animation.lastClip) continue;
        animation.lastClip = clip; animation.action.time = clip; animation.mixer.update(0);
      }
      return true;
    } catch (error) {
      failRuntime(tagError(error, { kind: currentEntry?.surface ? "media" : "resource", instanceId: currentEntry?.id, alias: currentEntry?.alias }));
      return false;
    }
  }
  function startCore() {
    core.play(sceneLoop);
    if (evaluate(t, true)) setState("playing");
  }
  function play() {
    if (!core) return;
    if (state === "ready" || state === "paused") startCore();
  }
  function pause() {
    if (state !== "playing" || !core) return;
    core.pause();
    if (evaluate(t, false)) setState("paused");
  }
  function seek(seconds) {
    if (!core || !Number.isFinite(seconds) || !["ready", "playing", "paused", "ended"].includes(state)) return;
    const wasPlaying = state === "playing";
    core.seek(seconds); t = core.time;
    const ended = !sceneLoop && duration !== null && t >= duration;
    if (ended) core.pause();
    else if (wasPlaying) { core.play(sceneLoop); t = core.time; }
    if (!evaluate(t, wasPlaying && !ended)) return;
    const next = ended ? "ended" : wasPlaying ? "playing" : "paused";
    if (state !== next) setState(next);
  }
  function restart() {
    if (!core || !["ready", "playing", "paused", "ended"].includes(state)) return;
    core.seek(0); t = 0; startCore();
  }
  function update(dt) {
    if (state !== "playing" || !(dt > 0) || !Number.isFinite(dt)) return;
    core.advance(dt); t = core.time;
    const ended = !sceneLoop && duration !== null && t >= duration;
    if (evaluate(t, !ended) && ended) setState("ended");
  }
  function dispose() {
    if (disposed) return;
    disposed = true; loadGeneration++; cancelLoading?.(); teardownBuilt();
    setState("disposed");
  }
  return player;
}
module.exports = { createCompositionPlayer, clipTime, selectClip };

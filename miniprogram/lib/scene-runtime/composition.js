// composition 播放器（scene asset）：GLB 编排 + 统一时间轴。
//   结构：sceneRoot(root，由宿主放置) → instanceRoot（JSON 变换） → GLB 子树（ModelCache clone）
//   每个实例独立 acquire 一份 ModelCache 句柄（cloneSkinned 副本），dispose 时逐个 release。
//   不归一化尺寸、不读 scale_multiplier；只应用 position/quaternion/scale。
const { THREE } = require("../three-runtime/runtime");
const { applyTransformTracks } = require("./transform-tracks");
const { disposeTree } = require("../three-runtime/resources");

/**
 * 局部时间 → clip 时间。
 *   local ≤ 0        → 0（延迟开始前保持第 0 秒姿态）
 *   loop             → local 对 clip 时长取模（整倍数处回到 0）
 *   非 loop          → 超过 clip 时长后钉在末帧
 */
function clipTime(local, clipDuration, loop) {
  if (!(local > 0) || !(clipDuration > 0)) return 0;
  if (loop) return local % clipDuration;
  return local < clipDuration ? local : clipDuration;
}

/** clipIndex / clipName 二选一；clipName 只在文件内唯一时有效。 */
function selectClip(animations, animation) {
  if (!animation || typeof animation !== "object") return null;
  if (Number.isInteger(animation.clipIndex))
    return animations[animation.clipIndex] || null;
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
  const err = error instanceof Error ? error : new Error(String(error));
  return Object.assign(err, fields);
}

function createCompositionPlayer(manifest, { modelCache, onState } = {}) {
  const content = manifest && manifest.content;
  const resources = (manifest && manifest.resources) || {};
  const root = new THREE.Group();
  root.name = `scene:${(manifest && manifest.assetId) || ""}`;
  // instances: { id, alias, instanceRoot, object, handle, mixer, action }
  const instances = [];
  // animated: 每帧驯动的扁平数组，避免 tick 内分配
  const animated = [];
  const duration =
    content &&
    Number.isFinite(content.durationSeconds) &&
    content.durationSeconds > 0
      ? content.durationSeconds
      : null;
  const sceneLoop = !!(content && content.loop);
  let state = "idle",
    t = 0,
    loadGeneration = 0,
    disposed = false,
    diagnostics = null;

  const player = {
    kind: "composition",
    get state() {
      return state;
    },
    get root() {
      return root;
    },
    get time() {
      return t;
    },
    get duration() {
      return duration;
    },
    get diagnostics() {
      return diagnostics;
    },
    get instances() {
      return instances;
    },
    load,
    play,
    pause,
    restart,
    update,
    dispose,
    /** 编排场景没有可点击切换的媒体；返回 false 让宿主按“命中场景”处理。 */
    tap() {
      return false;
    },
  };

  function setState(next, message) {
    if (disposed && next !== "disposed") return;
    state = next;
    if (typeof onState === "function") {
      try {
        onState(next, message || "", player);
      } catch (error) {
        console.warn("[scene-runtime] onState 回调异常", error);
      }
    }
  }

  function releaseHandles(handles) {
    for (const handle of handles) {
      try {
        disposeTree(handle.object);
      } catch (_) {}
      try {
        handle.release();
      } catch (_) {}
    }
  }

  /** 释放已经构建出来的实例（mixer → 子树 → 句柄），保持 root 为空。 */
  function teardownBuilt() {
    for (const inst of instances) {
      if (inst.mixer) {
        try {
          inst.mixer.stopAllAction();
          inst.mixer.uncacheRoot(inst.object);
        } catch (_) {}
      }
    }
    root.removeFromParent();
    // disposeTree 跳过 sharedModel 子树的几何/材质（缓存所有），只清骨架。
    disposeTree(root);
    root.clear();
    const handles = instances.map((inst) => inst.handle);
    instances.length = 0;
    animated.length = 0;
    for (const handle of handles) {
      try {
        handle.release();
      } catch (_) {}
    }
  }

  function describe(error) {
    return {
      assetId: manifest && manifest.assetId,
      instanceId: error.instanceId || null,
      alias: error.alias || null,
      kind: error.kind || "resource",
      message: error.message || String(error),
    };
  }

  async function load() {
    if (state !== "idle" && state !== "error") return;
    if (disposed) return;
    diagnostics = null;
    const generation = ++loadGeneration;
    setState("loading");
    const acquired = [];
    try {
      if (!content || content.kind !== "composition")
        throw tagError(new Error("场景内容不是 composition"), {
          kind: "protocol",
        });
      const list = Array.isArray(content.instances) ? content.instances : [];
      if (!list.length)
        throw tagError(new Error("composition 没有任何实例"), {
          kind: "protocol",
        });
      if (!modelCache)
        throw tagError(new Error("缺少 ModelCache"), { kind: "protocol" });
      // 全部资源都是必需的：并行 acquire，任一失败则整场失败并释放已拿到的句柄。
      const results = await Promise.allSettled(
        list.map((inst) => {
          const alias = inst && inst.asset;
          const resource = resources[alias];
          const url = resource && resource.url;
          if (!url)
            return Promise.reject(
              tagError(new Error(`资源 ${alias} 缺少可用 url`), {
                alias,
                instanceId: inst && inst.id,
                kind: "resource",
              }),
            );
          return modelCache.acquire(url).then(
            (handle) => ({ handle, inst, alias }),
            (error) => {
              throw tagError(error, {
                alias,
                instanceId: inst && inst.id,
                kind: "resource",
              });
            },
          );
        }),
      );
      for (const result of results)
        if (result.status === "fulfilled") acquired.push(result.value.handle);
      if (disposed || generation !== loadGeneration) {
        // 加载期间被 dispose/重置：迟到的句柄只能释放，不能挂回场景。
        releaseHandles(acquired);
        return;
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      // 第一阶段：先让每个句柄都归属一个实例（后续任何抛错都由 teardownBuilt 统一释放，不漏句柄）
      for (const result of results) {
        const { handle, inst, alias } = result.value;
        const instanceRoot = new THREE.Group();
        instanceRoot.name = `instance:${inst.id}`;
        instanceRoot.position.fromArray(inst.position);
        instanceRoot.quaternion.fromArray(inst.quaternion);
        instanceRoot.scale.fromArray(inst.scale);
        instanceRoot.add(handle.object);
        root.add(instanceRoot);
        instances.push({
          id: inst.id,
          alias,
          inst,
          instanceRoot,
          object: handle.object,
          handle,
          mixer: null,
          action: null,
        });
        acquired.splice(acquired.indexOf(handle), 1);
      }
      // 第二阶段：动画配置（clip 选择错误属于“动画配置错误”，与资源加载错误区分）
      for (const entry of instances) {
        const { inst, alias, handle } = entry;
        if (inst.animation === null || inst.animation === undefined) continue;
        const clip = selectClip(handle.animations || [], inst.animation);
        if (!clip)
          throw tagError(
            new Error(
              `实例 ${inst.id} 指定的 clip 不存在或名称不唯一（${
                Number.isInteger(inst.animation.clipIndex)
                  ? `clipIndex=${inst.animation.clipIndex}`
                  : `clipName=${inst.animation.clipName}`
              }）`,
            ),
            { alias, instanceId: inst.id, kind: "animation" },
          );
        if (!(clip.duration > 0))
          throw tagError(new Error(`实例 ${inst.id} 的 clip 时长无效`), {
            alias,
            instanceId: inst.id,
            kind: "animation",
          });
        const mixer = new THREE.AnimationMixer(handle.object);
        const action = mixer.clipAction(clip);
        const loop = !!inst.animation.loop;
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        action.clampWhenFinished = !loop;
        action.enabled = true;
        action.play();
        entry.mixer = mixer;
        entry.action = action;
        animated.push({
          action,
          mixer,
          startSeconds: Number.isFinite(inst.animation.startSeconds)
            ? inst.animation.startSeconds
            : 0,
          loop,
          clipDuration: clip.duration,
          lastClip: -1,
        });
      }
      t = 0;
      evaluate(0);
      setState("ready");
    } catch (error) {
      releaseHandles(acquired);
      teardownBuilt();
      diagnostics = describe(error);
      if (!disposed && generation === loadGeneration)
        setState("error", diagnostics.message);
    }
  }

  /**
   * 以“设置 action.time + mixer.update(0)”确定性求值，而不是累加 dt：
   * 暂停/恢复不会跳时，LoopOnce 结束后也不会被 mixer.setTime 重置回第 0 帧。
   */
  function evaluate(time) {
    for (const entry of instances) {
      if (entry.inst.tracks) applyTransformTracks(entry.instanceRoot, entry.inst.tracks, time);
    }
    for (let i = 0; i < animated.length; i++) {
      const a = animated[i];
      const clip = clipTime(time - a.startSeconds, a.clipDuration, a.loop);
      if (clip === a.lastClip) continue;
      a.lastClip = clip;
      a.action.time = clip;
      a.mixer.update(0);
    }
  }

  function play() {
    if (state === "ready") {
      t = 0;
      setState("playing");
    } else if (state === "paused") setState("playing");
  }

  function pause() {
    if (state === "playing") setState("paused");
  }

  function restart() {
    if (
      state !== "ready" &&
      state !== "playing" &&
      state !== "paused" &&
      state !== "ended"
    )
      return;
    t = 0;
    evaluate(0);
    setState("playing");
  }

  function update(dt) {
    if (state !== "playing" || !(dt > 0) || !Number.isFinite(dt)) return;
    t += dt;
    if (duration !== null && t >= duration) {
      // Preserve elapsed time across loop boundaries; non-looping scenes hold the final pose.
      t = sceneLoop ? t % duration : duration;
      evaluate(t);
      if (!sceneLoop) setState("ended");
      return;
    }
    evaluate(t);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    loadGeneration++;
    teardownBuilt();
    state = "disposed";
    if (typeof onState === "function") {
      try {
        onState("disposed", "", player);
      } catch (_) {}
    }
  }

  return player;
}

module.exports = { createCompositionPlayer, clipTime, selectClip };

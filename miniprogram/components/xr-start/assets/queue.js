/**
 * 三队列驱逐策略：
 *   - newQueue (gen='new')      : 超 maxNewNodeCount    → FIFO
 *   - oldQueue (gen='old')      : 超 maxOldNodeCount    → 离用户最远优先
 *   - danmakuQueue(gen='danmaku'): 超 maxDanmakuCount    → FIFO
 */
module.exports = function (XR_CONFIG) {
  return {
    /**
     * 统一注册一个已创建好的场景节点，追加到 nodeList 末尾。
     * gen 推断优先级：
     *   - 显式传入 opts.gen → 尊重（用于弹幕主动传 'danmaku'）
     *   - 否则 assetId === null → 弹幕带入 'danmaku'
     *   - 否则 → 'new'
     */
    _registerNode(assetId, node, billboardEl, audioRefs, opts) {
      const gen = (opts && opts.gen) || (assetId === null ? "danmaku" : "new");
      const newEntry = {
        assetId,
        node,
        billboardEl,
        audioRefs: audioRefs || null,
        videoRefs: (opts && opts.videoRefs) || null,
        gen,
      };
      this.nodeList.push(newEntry);
      this._enforceCapacity(newEntry);
    },

    /** 按 gen 分队进行硬上限驱逐。protectEntry 不参与驱逐。 */
    _enforceCapacity(protectEntry) {
      const xr = wx.getXrFrameSystem();
      const camPos = this.getCamTransform()?.position;

      const evictFifo = (genTag, maxCount) => {
        while (true) {
          const list = this.nodeList.filter((e) => e.gen === genTag);
          if (list.length <= maxCount) break;
          let victimIdx = -1;
          for (let i = 0; i < this.nodeList.length; i++) {
            const e = this.nodeList[i];
            if (e === protectEntry) continue;
            if (e.gen !== genTag) continue;
            victimIdx = i;
            break;
          }
          if (victimIdx < 0) break;
          this._destroyNode(this.nodeList.splice(victimIdx, 1)[0]);
        }
      };

      const evictFarthest = (genTag, maxCount) => {
        while (true) {
          const list = this.nodeList.filter((e) => e.gen === genTag);
          if (list.length <= maxCount) break;
          let victimIdx = -1;
          let victimDistSq = -Infinity;
          for (let i = 0; i < this.nodeList.length; i++) {
            const e = this.nodeList[i];
            if (e === protectEntry) continue;
            if (e.gen !== genTag) continue;
            let d = Infinity;
            if (camPos) {
              const wp = e.node?.getComponent(xr.Transform)?.worldPosition;
              if (wp) {
                const dx = wp.x - camPos.x;
                const dz = wp.z - camPos.z;
                d = dx * dx + dz * dz;
              }
            }
            if (d > victimDistSq) {
              victimDistSq = d;
              victimIdx = i;
            }
          }
          if (victimIdx < 0) break;
          this._destroyNode(this.nodeList.splice(victimIdx, 1)[0]);
        }
      };

      evictFifo("new", XR_CONFIG.maxNewNodeCount);
      evictFarthest("old", XR_CONFIG.maxOldNodeCount);
      evictFifo("danmaku", XR_CONFIG.maxDanmakuCount);
    },

    /** 统一销毁一个 nodeList 条目（从场景中移除根节点，清理相关引用） */
    _destroyNode(entry) {
      try {
        this.shadowRoot.removeChild(entry.node);
      } catch (_) {}
      this.flyingDanmakus = (this.flyingDanmakus || []).filter(
        (d) => d.node !== entry.node,
      );
      if (entry.audioRefs) {
        try {
          entry.audioRefs.ctx.stop();
        } catch (_) {}
        try {
          entry.audioRefs.ctx.destroy();
        } catch (_) {}
      }
      if (entry.videoRefs) {
        const { scene, videoAssetId, matAssetId } = entry.videoRefs;
        try {
          scene.assets.releaseAsset("video-texture", videoAssetId);
        } catch (_) {}
        try {
          scene.assets.releaseAsset("material", matAssetId);
        } catch (_) {}
      }
    },
  };
};

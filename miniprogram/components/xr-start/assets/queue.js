/**
 * 通用容量引擎（描述符驱动）：
 *   - 每个节点按 registry.js 声明的 descriptor.bucket 归入一个容量桶。
 *   - 每桶按 config.js 中 buckets[bucket] 的 { cap, evict } 独立限容，互不驱逐。
 *   - evict='farthest'：离用户【位置】最远的先踢（转头不变，只随移动缓慢淘汰）。
 *     evict='fifo'    ：注册顺序最旧的先踢（短命弹幕）。
 *   - minLifetimeMs：新节点在此窗口内不参与驱逐，防止"刚淡入就被挤掉"的一闪。
 * 加新素材类型无需改本文件，只需在 registry.js 加一项描述符。
 */
const REGISTRY = require("./registry");

module.exports = function (XR_CONFIG) {
  return {
    /**
     * 注册一个已创建好的场景节点，追加到 nodeList 末尾，并触发其所属桶的容量检查。
     * @param {number|null} assetId 素材库 id（本地直发弹幕为 null）
     * @param {Element} node 场景根节点
     * @param {Element|null} billboardEl 朝向相机的目标节点（null 表示不朝向）
     * @param {{ type?: string, audioRefs?: object, videoRefs?: object }} [opts]
     *        type 决定桶归属（查 registry）；audioRefs/videoRefs 供 dispose 释放资源。
     * @returns {object} 新建的 entry（供放置器后续挂 modelAnim 等）
     */
    _registerNode(assetId, node, billboardEl, opts) {
      const o = opts || {};
      const type = o.type || "text";
      const desc = REGISTRY[type];
      const bucket = (desc && desc.bucket) || "light";
      const newEntry = {
        assetId,
        node,
        billboardEl,
        type,
        bucket,
        bornAt: Date.now(),
        audioRefs: o.audioRefs || null,
        videoRefs: o.videoRefs || null,
      };
      this.nodeList.push(newEntry);
      this._enforceCapacity(newEntry);
      return newEntry;
    },

    /** 遍历所有容量桶做硬上限驱逐。protectEntry（刚注册的）不参与驱逐。 */
    _enforceCapacity(protectEntry) {
      const buckets = XR_CONFIG.buckets || {};
      for (const bucketName in buckets) {
        this._evictBucket(bucketName, buckets[bucketName], protectEntry);
      }
    },

    /** 单桶驱逐：按 cfg.evict 策略反复踢，直到成员数 <= cfg.cap。 */
    _evictBucket(bucketName, cfg, protectEntry) {
      if (!cfg) return;
      const xr = wx.getXrFrameSystem();
      const camPos = this.getCamTransform()?.position;
      const minLife = XR_CONFIG.minLifetimeMs || 0;

      while (true) {
        const members = this.nodeList.filter((e) => e.bucket === bucketName);
        if (members.length <= cfg.cap) break;

        const now = Date.now();
        // 优先只在"已过最小停留"的成员里选victim；若没有，放宽到全部以保证硬上限。
        let pool = members.filter(
          (e) => e !== protectEntry && now - (e.bornAt || 0) >= minLife,
        );
        if (pool.length === 0) {
          pool = members.filter((e) => e !== protectEntry);
        }
        if (pool.length === 0) break;

        let victim = null;
        if (cfg.evict === "fifo") {
          // nodeList 顺序即注册顺序，取最早出现的 pool 成员
          for (const e of this.nodeList) {
            if (pool.indexOf(e) !== -1) {
              victim = e;
              break;
            }
          }
        } else {
          // farthest：XZ 位置距离最大者
          let best = -Infinity;
          for (const e of pool) {
            const d = this._nodeDistSq(e, camPos, xr);
            if (d > best) {
              best = d;
              victim = e;
            }
          }
        }
        if (!victim) break;
        const idx = this.nodeList.indexOf(victim);
        if (idx < 0) break;
        this._destroyNode(this.nodeList.splice(idx, 1)[0]);
      }
    },

    /** 节点到相机的 XZ 平方距离（忽略高度）；无坐标/无相机时视作最远，优先淘汰。 */
    _nodeDistSq(entry, camPos, xr) {
      if (!camPos) return Infinity;
      const wp = entry.node?.getComponent(xr.Transform)?.worldPosition;
      if (!wp) return Infinity;
      const dx = wp.x - camPos.x;
      const dz = wp.z - camPos.z;
      return dx * dx + dz * dz;
    },

    /**
     * 完成时复检：一个将放在世界坐标 pos 的 bucket 节点，放下去后能否逃过立即驱逐？
     * 用于 async 类型（model/video）在昂贵实例化之前判断——若注定最远被踢，直接放弃。
     *   - 桶有空位 → 能存活
     *   - 桶已满 → 存在比它更远、且已过最小停留（可被驱逐）的现有成员时才能存活
     */
    _wouldSurvive(pos, bucketName) {
      const cfg = (XR_CONFIG.buckets || {})[bucketName];
      if (!cfg) return true;
      const members = this.nodeList.filter((e) => e.bucket === bucketName);
      if (members.length < cfg.cap) return true;

      const xr = wx.getXrFrameSystem();
      const camPos = this.getCamTransform()?.position;
      if (!camPos || !pos) return true; // 无法判断时放行，交由后续正常驱逐处理

      const dx = pos.x - camPos.x;
      const dz = pos.z - camPos.z;
      const candDistSq = dx * dx + dz * dz;
      const now = Date.now();
      const minLife = XR_CONFIG.minLifetimeMs || 0;
      for (const e of members) {
        if (now - (e.bornAt || 0) < minLife) continue; // 受保护成员不能被替换
        if (this._nodeDistSq(e, camPos, xr) > candDistSq) return true;
      }
      return false;
    },

    /**
     * 限量揭示：从候选 assets 中挑选至多 limit 个本轮放置。
     * heavy（model/video）优先——模型是场景主角且稀少，应尽早出现；
     * 两组各自洗牌，避免服务端固定排序导致每轮都是同一批被选中。
     * 未入选的直接丢弃（不放置、不进冷却），下轮拉取重新返回时自然轮到。
     */
    _pickRevealBatch(assets, limit) {
      if (!Array.isArray(assets) || assets.length <= limit) return assets;
      const shuffle = (arr) => {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      };
      const heavy = [];
      const rest = [];
      for (const a of assets) {
        const desc = REGISTRY[a.file_type];
        (desc && desc.bucket === "heavy" ? heavy : rest).push(a);
      }
      shuffle(heavy);
      shuffle(rest);
      return heavy.concat(rest).slice(0, limit);
    },

    /**
     * 重复冷却检查：assetId 是否处于"消失后 repeatCooldownMs 内不再重现"的窗口。
     * 无冷却配置的类型恒为 false；顺手清理已过期的记录，防 _seenAssets 无界增长。
     */
    _isInRepeatCooldown(assetId, fileType) {
      const desc = REGISTRY[fileType];
      const cooldown = desc && desc.repeatCooldownMs;
      if (!cooldown || !this._seenAssets) return false;
      const evictedAt = this._seenAssets.get(assetId);
      if (evictedAt === undefined) return false;
      if (Date.now() - evictedAt >= cooldown) {
        this._seenAssets.delete(assetId);
        return false;
      }
      return true;
    },

    /** 统一销毁一个 nodeList 条目：移除场景节点 + 调该类型 descriptor.dispose 释放资源。 */
    _destroyNode(entry) {
      try {
        this.shadowRoot.removeChild(entry.node);
      } catch (_) {}
      // 有 repeatCooldownMs 的类型：记录消失时刻，冷却期内 displayAssets 不再重新放置
      const desc = REGISTRY[entry.type];
      if (entry.assetId !== null && desc && desc.repeatCooldownMs) {
        if (!this._seenAssets) this._seenAssets = new Map();
        this._seenAssets.set(entry.assetId, Date.now());
      }
      const dispose = desc && desc.dispose;
      if (dispose) {
        try {
          dispose.call(this, entry);
        } catch (_) {}
      }
    },
  };
};

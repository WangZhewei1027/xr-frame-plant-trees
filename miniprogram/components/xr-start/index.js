const XR_CONFIG = require("./config");
const preload = require("./preload");
const gps = require("./gps");
const navigation = require("./navigation");
const { CONFIG, supabaseGet } = require("../../utils/supabase");

const createAssetsMethods = require("./assets/index");
const createHugeMethods = require("./assets/huge");
const createDanmakuMethods = require("./effects/danmaku");
const createRepulsionMethods = require("./effects/repulsion");
const particle = require("./effects/particle");
const createConfettiMethods = require("./effects/confetti");

const assetsMethods = createAssetsMethods(XR_CONFIG);
const danmakuMethods = createDanmakuMethods(XR_CONFIG);
const repulsionMethods = createRepulsionMethods(XR_CONFIG);
const hugeMethods = createHugeMethods(XR_CONFIG);
const confettiMethods = createConfettiMethods(XR_CONFIG);

const DEFAULT_TEXT_ASSET_STYLE = "dialog_decorated";

/**
 * 组织配置（organization.config jsonb）本地缓存键。
 * 整份 config 存一份，供冷启动/慢网时即时兜底：
 * 用户可能在 fetchOrgStyle 拉取完成前就已进入 AR 页，靠缓存先渲染上次已知配置。
 */
function orgConfigStorageKey(orgId) {
  return `config:org:${orgId || ""}:config:v1`;
}

/** 读取本地缓存的整份组织配置；无缓存或格式异常时返回 {} */
function loadCachedOrgConfig() {
  try {
    const orgId = CONFIG.organizationId || "";
    const saved = wx.getStorageSync(orgConfigStorageKey(orgId));
    return saved && typeof saved === "object" ? saved : {};
  } catch (_) {
    return {};
  }
}

/** 从一份 config 派生文本资源样式，缺省回退默认气泡样式 */
function textAssetStyleFromConfig(cfg) {
  const style = cfg && cfg.text_asset_miniapp_style;
  return typeof style === "string" && style ? style : DEFAULT_TEXT_ASSET_STYLE;
}

/** 组件 attach 时的实例字段初始值 */
function buildInitialState() {
  // 冷启动即读一次本地缓存的整份组织配置，彩带/文本样式都从中派生，
  // 保证「已进入 AR 但 fetchOrgStyle 尚未返回」时也能按上次已知配置渲染。
  const cachedConfig = loadCachedOrgConfig();
  return {
    nodeIdCounter: 0,
    nodeList: [], // [{ assetId, node, billboardEl, audioRefs, gen }]
    spatialAudioList: [],
    flyingDanmakus: [],
    particleTimers: [],
    // 预加载完成（tree/profile/bubble 全部就绪）才开始放置素材，避免气泡/头像降级
    _preloadDone: false,
    _pendingDisplayAssets: [],
    // 上次拉取时相机的 x/z 参考点；null 表示尚未设置（首帧 tick 时初始化）
    _fetchAnchorXZ: null,
    // 上次触发 fetchNearbyAssets 的时间戳（用于冷却判断）
    _lastFetchTime: 0,
    gpsReady: false,
    firstFetchDone: false,
    currentGPS: null,
    isFetchingAssets: false,
    // 导航状态
    _navTarget: null,
    _navActive: false,
    _compassHeading: null,
    _navNodes: [],
    _navParticleEls: [],
    _navLabelNode: null,
    _navLabelTextEl: null,
    _lastNavLabel: "",
    // 巨型远景模型
    _hugeNodeList: [],
    _pendingHugeAssets: [],
    _isFetchingHuge: false,
    // 随机彩带
    _confettiBursts: [],
    _confettiTimer: null,
    _confettiCounter: 0,
    // 组织配置（organization.config jsonb），由 fetchOrgStyle 刷新；先用本地缓存兜底
    _orgConfig: cachedConfig,
    // 资源是否已加载完成（彩带启动闸门之一）
    _assetsLoaded: false,
    // 彩带开关：来自 config.confetti_enabled，默认关闭（保守）
    _confettiEnabled: cachedConfig.confetti_enabled === true,
    // 文本资源样式：来自 config.text_asset_miniapp_style，默认气泡样式
    _textAssetStyle: textAssetStyleFromConfig(cachedConfig),
  };
}

Component({
  behaviors: [require("../common/share-behavior").default],
  properties: { a: Number },
  data: { loaded: false, arReady: false },

  lifetimes: {
    attached() {
      Object.assign(this, buildInitialState());
      this.startGPSWatch();
      this.fetchOrgStyle();
    },
    detached() {
      if (this.locationWatchId) {
        wx.stopLocationUpdate();
        this.locationWatchId = null;
      }
      if (this.particleTimers) {
        this.particleTimers.forEach((id) => clearTimeout(id));
        this.particleTimers = [];
      }
      this.flyingDanmakus = [];
      for (const entry of this.nodeList) {
        try {
          this.shadowRoot?.removeChild(entry.node);
        } catch (_) {}
      }
      this.nodeList = [];
      // 清理巨型远景模型
      for (const entry of this._hugeNodeList || []) {
        try {
          this.shadowRoot?.removeChild(entry.node);
        } catch (_) {}
      }
      this._hugeNodeList = [];
      this._pendingHugeAssets = [];
      // 停止并清理随机彩带
      this.stopRandomConfetti && this.stopRandomConfetti();
      if (this.spatialAudioList) {
        for (const entry of this.spatialAudioList) {
          try {
            entry.source.stop();
          } catch (_) {}
          try {
            entry.panner.disconnect();
          } catch (_) {}
          try {
            entry.gainNode.disconnect();
          } catch (_) {}
        }
        this.spatialAudioList = [];
      }
      if (this._audioCtx) {
        try {
          this._audioCtx.close();
        } catch (_) {}
        this._audioCtx = null;
      }
    },
  },

  methods: {
    // ─── GPS ────────────────────────────────────────
    ...gps,

    // ─── 远程素材（含队列管理 + text/model/image/audio 放置） ──
    ...assetsMethods,

    // ─── 弹幕飞行 ───────────────────────────────────
    ...danmakuMethods,

    // ─── 通用斥力（所有素材类型） ────────────────────
    ...repulsionMethods,

    // ─── 粒子爆发 ───────────────────────────────────
    ...particle,

    // ─── 导航状态 ───────────────────────────────────
    ...navigation,

    // ─── 巨型远景模型 ─────────────────────────────────
    ...hugeMethods,

    // ─── 随机彩带 ───────────────────────────────────
    ...confettiMethods,

    // ─── 预加载（tree / profile / bubble） ───────────
    ...preload,

    // ─── 场景节点管理 ───────────────────────────────
    getCamTransform() {
      const xr = wx.getXrFrameSystem();
      const cam = this.scene?.getElementById("camera");
      return cam?.getComponent(xr.Transform);
    },

    removeOldestNode() {
      if (!this.nodeList.length) return;
      const entry = this.nodeList.shift();
      this._destroyNode(entry);
    },

    // ─── XR 事件处理 ────────────────────────────────
    async handleReady({ detail }) {
      const xrScene = (this.scene = detail.value);
      const xr = wx.getXrFrameSystem();

      this.shadowRoot = xrScene.getElementById("shadow-root");
      this.FACING = xr.Vector3.createFromNumber(0, 0, 0);
      this.UP = xr.Vector3.createFromNumber(0, 1, 0);

      await this.loadTreeModel(xrScene);
      await Promise.all([
        this.loadProfileTextures(xrScene),
        this.loadBubbleTextures(xrScene),
      ]);
      this._preloadDone = true;
      // 预加载期间 GPS 触发的 fetch 已把 assets 暂存到 _pendingDisplayAssets，统一刷出
      this.flushPendingDisplayAssets();

      // 若导航目标在场景就绪前已设置，延迟创建导航系统
      if (this._navTarget) {
        this._createNavSystem(this._navTarget);
      }
    },

    handleAssetsLoaded() {
      this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
      this._assetsLoaded = true;
      // 资源加载完成后按 org 配置启动随机彩带（依赖 particle-confetti 纹理）
      this._maybeStartConfetti();
    },

    // 仅当资源已加载且 org 配置开启彩带时才启动；两个触发源（资源加载、
    // 配置拉取）都会调用本方法，规避 fetchOrgStyle 异步未 await 的时序竞态。
    _maybeStartConfetti() {
      if (!this._assetsLoaded) return;
      if (this._confettiEnabled !== true) return;
      this.startRandomConfetti();
    },

    handleAssetsProgress() {},

    handleARReady() {
      // AR 相机就绪：标记 AR 侧闸门并尝试启动首批拉取。
      // 必须设置 _arReady，否则 _maybeStartFirstFetch 永远 bail，导致完全不拉取 asset。
      this._arReady = true;
      this._maybeStartFirstFetch();
    },

    handleTick() {
      const xr = wx.getXrFrameSystem();
      const camTransform = this.getCamTransform();
      if (!camTransform) return;

      const camPos = camTransform.position;

      // 首帧时初始化参考点
      if (!this._fetchAnchorXZ) {
        this._fetchAnchorXZ = { x: camPos.x, z: camPos.z };
      }

      this.tickFlyingDanmakus();
      this.tickRepulsion();
      this.tickAudioVolume();
      this.tickModelAnimation();
      this.tickHugeModels();

      for (const entry of this.nodeList) {
        const el = entry.billboardEl;
        const trs = el?.getComponent(xr.Transform);
        if (!trs) continue;
        this.FACING.set(trs.worldPosition).sub(camPos, this.FACING);
        xr.Quaternion.lookRotation(this.FACING, this.UP, trs.quaternion);
      }

      // 计算参考点到当前相机位置的 x/z 净位移向量长度
      const dax = camPos.x - this._fetchAnchorXZ.x;
      const daz = camPos.z - this._fetchAnchorXZ.z;
      const netDisplacement = Math.sqrt(dax * dax + daz * daz);
      const now = Date.now();

      if (
        netDisplacement >= XR_CONFIG.distanceThreshold &&
        now - this._lastFetchTime >= XR_CONFIG.fetchCooldownMs
      ) {
        // 以当前位置作为下一次计算的新参考点
        this._fetchAnchorXZ = { x: camPos.x, z: camPos.z };
        this._lastFetchTime = now;
        this.fetchNearbyAssets();
      }
    },

    async fetchOrgStyle() {
      const orgId = CONFIG.organizationId || "";
      if (!orgId) return;
      try {
        // 所有配置都在 config (jsonb) 字段里，不存在顶层 text_asset_miniapp_style 列，
        // select 该列会整条查询报错（非 200），导致配置永远读不到。
        const { statusCode, data } = await supabaseGet(
          "organization",
          `id=eq.${orgId}&select=config`,
        );
        if (statusCode === 200 && Array.isArray(data) && data.length > 0) {
          const row = data[0];
          const cfg =
            row.config && typeof row.config === "object" ? row.config : {};
          this._orgConfig = cfg;

          // 持久化整份 config，供下次冷启动/慢网时即时兜底
          try {
            wx.setStorageSync(orgConfigStorageKey(orgId), cfg);
          } catch (e) {
            console.error("[orgConfig] Storage write failed", e);
          }

          // 文本样式：仅来自 config.text_asset_miniapp_style
          this._textAssetStyle = textAssetStyleFromConfig(cfg);

          // 彩带开关：来自 config.confetti_enabled
          this._confettiEnabled = cfg.confetti_enabled === true;
          if (this._confettiEnabled) {
            this._maybeStartConfetti();
          } else {
            this.stopRandomConfetti();
          }
        }
      } catch (e) {
        console.error("[orgConfig] fetch failed", e);
      }
    },

    placeNode() {
      try {
        const xr = wx.getXrFrameSystem();
        const el = this.scene.createElement(xr.XRGLTF);
        this.shadowRoot.addChild(el);
        el.getComponent(xr.GLTF).setData({ model: this.gltfModel });
        this.scene.ar.placeHere(el, true);
        el.getComponent(xr.Transform).scale.setValue(0.3, 0.3, 0.3);
      } catch (e) {
        console.error("placeNode error", e);
      }
      this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
    },
  },
});

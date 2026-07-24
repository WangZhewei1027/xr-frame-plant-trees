const XR_CONFIG = require("./config");
const preload = require("./preload");
const gps = require("./gps");
const navigation = require("./navigation");
const { CONFIG, supabaseGet } = require("../../utils/supabase");

const createAssetsMethods = require("./assets/index");
const createHugeMethods = require("./assets/huge");
const createDanmakuMethods = require("./effects/danmaku");
const createRepulsionMethods = require("./effects/repulsion");
const createConfettiMethods = require("./effects/confetti");

const assetsMethods = createAssetsMethods(XR_CONFIG);
const danmakuMethods = createDanmakuMethods(XR_CONFIG);
const repulsionMethods = createRepulsionMethods(XR_CONFIG);
const hugeMethods = createHugeMethods(XR_CONFIG);
const confettiMethods = createConfettiMethods(XR_CONFIG);

/** 组件 attach 时的实例字段初始值 */
function buildInitialState() {
  return {
    nodeIdCounter: 0,
    nodeList: [], // [{ assetId, node, billboardEl, trs, billboardTrs, type, bucket, bornAt, audioRefs, videoRefs, imageRefs, modelAnim? }]
    // 音频节点子列表（audioRefs 非空的 entry），由 queue 在注册/销毁时维护，
    // tickAudioVolume 直接用，避免每帧 nodeList.filter 分配
    _audioEntries: [],
    // 相机 Transform 缓存（getCamTransform 首次解析后填充）
    _camTrs: null,
    // assetId → 被驱逐时刻：repeatCooldownMs 类型（text/image）消失后冷却期内不重复放置
    _seenAssets: new Map(),
    // 首轮限量揭示是否已消耗（首轮 revealFirstFetch 加量，仅在实际放置过内容后置位）
    _firstRevealDone: false,
    spatialAudioList: [],
    flyingDanmakus: [],
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
    // 组织配置（organization.config jsonb），由 fetchOrgStyle 填充
    _orgConfig: {},
    // 资源是否已加载完成（彩带启动闸门之一）
    _assetsLoaded: false,
    // 彩带开关：从 org 配置读取，默认关闭（保守）；带本地缓存兜底
    _confettiEnabled: (() => {
      try {
        const orgId = CONFIG.organizationId || "";
        const saved = wx.getStorageSync(`config:org:${orgId}:confetti:v1`);
        return saved === true;
      } catch (_) {
        return false;
      }
    })(),
    // 文本资源样式：从 org 配置读取，默认使用气泡样式
    _textAssetStyle: (() => {
      try {
        const orgId = CONFIG.organizationId || "";
        const saved = wx.getStorageSync(`config:org:${orgId}:textStyle:v1`);
        return typeof saved === "string" && saved ? saved : "dialog_decorated";
      } catch (_) {
        return "dialog_decorated";
      }
    })(),
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

    // ─── 导航状态 ───────────────────────────────────
    ...navigation,

    // ─── 巨型远景模型 ─────────────────────────────────
    ...hugeMethods,

    // ─── 随机彩带 ───────────────────────────────────
    ...confettiMethods,

    // ─── 预加载（tree / profile / bubble） ───────────
    ...preload,

    // ─── 场景节点管理 ───────────────────────────────
    // 相机 Transform 首次解析后缓存：camera 元素不会变，
    // 避免每帧多次 getElementById（字符串查找）+ getComponent。
    getCamTransform() {
      if (this._camTrs) return this._camTrs;
      const xr = this.xr || wx.getXrFrameSystem();
      const cam = this.scene?.getElementById("camera");
      const trs = cam?.getComponent(xr.Transform);
      if (trs) this._camTrs = trs;
      return trs;
    },

    removeOldestNode() {
      if (!this.nodeList.length) return;
      const entry = this.nodeList.shift();
      this._destroyNode(entry);
    },

    // ─── XR 事件处理 ────────────────────────────────
    async handleReady({ detail }) {
      const xrScene = (this.scene = detail.value);
      // xr-frame 系统引用缓存：运行期不变，供所有每帧路径复用
      const xr = (this.xr = wx.getXrFrameSystem());

      this.shadowRoot = xrScene.getElementById("shadow-root");
      this.FACING = xr.Vector3.createFromNumber(0, 0, 0);
      this.UP = xr.Vector3.createFromNumber(0, 1, 0);

      // 树 GLB 与头像/气泡纹理并行加载：GLB 在远端（8thwall），串行会把它压在
      // _preloadDone 关键路径最前面，白白推迟首批素材放置。
      await Promise.all([
        this.loadTreeModel(xrScene),
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
      XR_CONFIG.debugLog &&
        console.log(
          "[confetti] _maybeStartConfetti gate assetsLoaded=",
          this._assetsLoaded,
          "confettiEnabled=",
          this._confettiEnabled,
        );
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
      const xr = this.xr || (this.xr = wx.getXrFrameSystem());
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

      // billboard：使用注册时缓存的 billboardTrs，零 getComponent 查找
      for (const entry of this.nodeList) {
        const trs = entry.billboardTrs;
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
      const styleKey = `config:org:${orgId}:textStyle:v1`;
      const confettiKey = `config:org:${orgId}:confetti:v1`;
      try {
        // 注意：text_asset_miniapp_style 顶层列已废弃并迁入 config jsonb。
        // 若仍在 select 中引用该列，PostgREST 会以 400 拒绝整个请求，
        // 导致 statusCode!==200、配置不落地、彩带无法启动。故只选 config。
        const { statusCode, data } = await supabaseGet(
          "organization",
          `id=eq.${orgId}&select=config`,
        );
        if (statusCode === 200 && Array.isArray(data) && data.length > 0) {
          const row = data[0];
          const cfg =
            row.config && typeof row.config === "object" ? row.config : {};
          this._orgConfig = cfg;

          // 文本样式：优先读 config.text_asset_miniapp_style，
          // 回退到历史顶层列 text_asset_miniapp_style（兼容旧数据）。
          const style =
            (typeof cfg.text_asset_miniapp_style === "string" &&
              cfg.text_asset_miniapp_style) ||
            (typeof row.text_asset_miniapp_style === "string" &&
              row.text_asset_miniapp_style) ||
            "";
          if (style) {
            this._textAssetStyle = style;
            try {
              wx.setStorageSync(styleKey, style);
            } catch (e) {
              console.error("[orgStyle] Storage write failed", e);
            }
          }

          // 彩带开关：来自 config.confetti_enabled
          const confettiEnabled = cfg.confetti_enabled === true;
          this._confettiEnabled = confettiEnabled;
          console.log(
            "[orgConfig] fetched",
            JSON.stringify(cfg),
            "confettiEnabled=",
            confettiEnabled,
            "assetsLoaded=",
            this._assetsLoaded,
          );
          try {
            wx.setStorageSync(confettiKey, confettiEnabled);
          } catch (e) {
            console.error("[orgConfig] Storage write failed", e);
          }
          if (confettiEnabled) {
            this._maybeStartConfetti();
          } else {
            this.stopRandomConfetti();
          }

          // 将店铺打卡/页脚开关向上抛给 ar 页面（bind:orgconfigload）。
          // 与 confetti_enabled 同语义：页面用 === true 判定，
          // 缺省(undefined)按“默认关”，显式 true 才显示。
          this.triggerEvent("orgconfigload", {
            shopCheckinEnabled: cfg.shop_checkin_enabled,
            footerEnabled: cfg.footer_enabled,
          });
        } else {
          console.warn(
            "[orgConfig] unexpected response orgId=",
            orgId,
            "statusCode=",
            statusCode,
            "data=",
            JSON.stringify(data),
          );
        }
      } catch (e) {
        console.error("[orgStyle] fetch failed", e);
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

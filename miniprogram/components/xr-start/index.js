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

/** 组件 attach 时的实例字段初始值 */
function buildInitialState() {
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
      // 清空串行放置队列，防止组件销毁后残留 asset 继续执行
      this._placeQueue = [];
      this._placingBusy = false;
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
        this._destroyNode(entry);
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

      // 三类预加载并行：树模型不再串行阻塞头像/气泡纹理，缩短首屏空白时间。
      // 任一失败不阻塞其他（preload.js 内部对单张纹理加载已 catch）。
      await Promise.all([
        this.loadTreeModel(xrScene).catch((e) =>
          console.warn("[preload] tree model failed:", e),
        ),
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
      // 资源加载完成后，仅在组织开启彩带配置时启动（依赖 particle-confetti 纹理）
      if (this._orgConfig && this._orgConfig.confetti_enabled) {
        this.startRandomConfetti();
      }
    },

    handleAssetsProgress() {},

    handleARReady() {},

    handleTick() {
      const xr = wx.getXrFrameSystem();
      const camTransform = this.getCamTransform();
      if (!camTransform) return;

      const camPos = camTransform.position;

      // 首帧时初始化参考点
      if (!this._fetchAnchorXZ) {
        this._fetchAnchorXZ = { x: camPos.x, z: camPos.z };
      }

      // 分帧调度：把每帧 tick 的几类高频工作错开到不同帧，避免单帧累计耗时溢出 16ms。
      // 弹幕飞行动画对延迟敏感，每帧都跑；其余按相位轮转。
      this.tickFlyingDanmakus();
      const phase = (this._tickPhase = ((this._tickPhase || 0) + 1) & 0x3); // 0..3
      if (phase === 0) this.tickRepulsion();
      else if (phase === 1) this.tickModelAnimation();
      else if (phase === 2) this.tickAudioVolume();
      else this.tickHugeModels();

      // billboard 朝向：每隔一帧更新一次，且仅在相机相对上次更新位移 > 1cm 时才重算；
      // 否则沿用上一帧 quaternion（视觉上无差别，节省 35 节点 × Quaternion.lookRotation）。
      const lastBb = this._lastBillboardCam;
      const camMoved =
        !lastBb ||
        Math.abs(camPos.x - lastBb.x) > 0.01 ||
        Math.abs(camPos.y - lastBb.y) > 0.01 ||
        Math.abs(camPos.z - lastBb.z) > 0.01;
      if ((phase & 1) === 0 && camMoved) {
        this._lastBillboardCam = { x: camPos.x, y: camPos.y, z: camPos.z };
        for (const entry of this.nodeList) {
          const el = entry.billboardEl;
          const trs = el?.getComponent(xr.Transform);
          if (!trs) continue;
          this.FACING.set(trs.worldPosition).sub(camPos, this.FACING);
          xr.Quaternion.lookRotation(this.FACING, this.UP, trs.quaternion);
        }
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
      const storageKey = `config:org:${orgId}:textStyle:v1`;
      try {
        const { statusCode, data } = await supabaseGet(
          "organization",
          `id=eq.${orgId}&select=text_asset_miniapp_style,config`,
        );
        if (statusCode === 200 && Array.isArray(data) && data.length > 0) {
          const style = data[0].text_asset_miniapp_style;
          if (typeof style === "string" && style) {
            this._textAssetStyle = style;
            try {
              wx.setStorageSync(storageKey, style);
            } catch (e) {
              console.error("[orgStyle] Storage write failed", e);
            }
          }
          const cfg = data[0].config;
          this._orgConfig = cfg && typeof cfg === "object" ? cfg : {};
          console.log("[orgStyle] config:", JSON.stringify(this._orgConfig));
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

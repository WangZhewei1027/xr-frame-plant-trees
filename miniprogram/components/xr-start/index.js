const gps = require("./gps");
const createAssetsMethods = require("./assets");
const createDanmakuMethods = require("./danmaku");
const particle = require("./particle");
const navigation = require("./navigation");
const createHugeMethods = require("./huge");
const createConfettiMethods = require("./confetti");

const XR_CONFIG = {
  maxDistanceMeters: 50,
  maxNodeCount: 25,
  distanceThreshold: 5,
  treeModelUrl: "https://8thwall.8thwall.app/assets/tree-d51u9146bh.glb",
};

const assetsMethods = createAssetsMethods(XR_CONFIG);
const danmakuMethods = createDanmakuMethods(XR_CONFIG);
const hugeMethods = createHugeMethods(XR_CONFIG);
const confettiMethods = createConfettiMethods(XR_CONFIG);

Component({
  behaviors: [require("../common/share-behavior").default],
  properties: { a: Number },
  data: { loaded: false, arReady: false },

  lifetimes: {
    attached() {
      Object.assign(this, {
        nodeIdCounter: 0,
        nodeList: [], // [{ assetId, node, billboardEl }]
        spatialAudioList: [],
        flyingDanmakus: [],
        particleTimers: [],
        lastCamPos: null,
        accumulatedDistance: 0,
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
      });
      this.startGPSWatch();
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

    // ─── 远程素材 ───────────────────────────────────
    ...assetsMethods,

    // ─── 弹幕飞行 ───────────────────────────────────
    ...danmakuMethods,

    // ─── 粒子爆发 ───────────────────────────────────
    ...particle,

    // ─── 导航粒子系统 ─────────────────────────────────
    ...navigation,

    // ─── 巨型远景模型 ─────────────────────────────────
    ...hugeMethods,

    // ─── 随机彩带 ───────────────────────────────────
    ...confettiMethods,

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

      const { value: model } = await xrScene.assets.loadAsset({
        type: "gltf",
        assetId: "tree",
        src: XR_CONFIG.treeModelUrl,
      });
      this.gltfModel = model;

      // 预加载头像纹理（profile 文件夹下所有图片）
      const profileImages = [
        "profile_1_circle.png",
        "profile_2_circle.png",
        "profile_3_circle.png",
        "profile_4_circle.png",
        "profile_5_circle.png",
        "profile_6_circle.png",
        "profile_7_circle.png",
        "profile_8_circle.png",
        "profile_9_circle.png",
        "profile_10_circle.png",
        "profile_11_circle.png",
        "profile_12_circle.png",
        "profile_13_circle.png",
        "profile_14_circle.png",
        "profile_15_circle.png",
        "profile_16_circle.png",
        "profile_17_circle.png",
        "profile_18_circle.png",
        "profile_19_circle.png",
        "profile_20_circle.png",
        "profile_21_circle.png",
        "profile_22_circle.png",
        "profile_23_circle.png",
        "profile_24_circle.png",
        "profile_25_circle.png",
        "profile_26_circle.png",
        "profile_27_circle.png",
        "profile_28_circle.png",
        "profile_29_circle.png",
        "profile_30_circle.png",
        "profile_31_circle.png",
      ];
      this._profileAssetIds = [];
      for (let i = 0; i < profileImages.length; i++) {
        const aid = `profile-tex-${i}`;
        try {
          await xrScene.assets.loadAsset({
            type: "texture",
            assetId: aid,
            src: `/assets/profile/${profileImages[i]}`,
          });
          this._profileAssetIds.push(aid);
        } catch (e) {
          console.warn("[profile] 加载头像失败:", profileImages[i], e);
        }
      }

      // 预加载圆角气泡纹理（bubble 文件夹，不同宽高比）
      this._bubbleTexIds = {};
      for (let ratio = 2; ratio <= 8; ratio++) {
        const aid = `bubble-tex-${ratio}`;
        try {
          await xrScene.assets.loadAsset({
            type: "texture",
            assetId: aid,
            src: `/assets/bubble/bubble_${ratio}x1.png`,
          });
          this._bubbleTexIds[ratio] = aid;
        } catch (e) {
          console.warn("[bubble] 加载气泡纹理失败:", ratio, e);
        }
      }

      // 若导航目标在场景就绪前已设置，延迟创建导航系统
      if (this._navTarget) {
        this._createNavSystem(this._navTarget);
      }
    },

    handleAssetsLoaded() {
      this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
      // 资源加载完成后启动随机彩带（依赖 particle-confetti 纹理）
      this.startRandomConfetti();
    },

    handleAssetsProgress() {},

    handleARReady() {},

    handleTick() {
      const xr = wx.getXrFrameSystem();
      const camTransform = this.getCamTransform();
      if (!camTransform) return;

      const camPos = camTransform.position;

      if (this.lastCamPos) {
        const dx = camPos.x - this.lastCamPos.x;
        const dz = camPos.z - this.lastCamPos.z;
        this.accumulatedDistance += Math.sqrt(dx * dx + dz * dz);
      }
      this.lastCamPos = { x: camPos.x, z: camPos.z };

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

      if (this.accumulatedDistance >= XR_CONFIG.distanceThreshold) {
        this.accumulatedDistance = 0;
        this.fetchNearbyAssets();
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

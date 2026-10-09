const XR_CONFIG = require("./config");
const gps = require("./gps");
const navigation = require("./navigation");
const matching = require("./matching/index");
const { CONFIG, fetchOrganizations } = require("../../utils/backend");
const { THREE } = require("../../lib/three-runtime/runtime");
const { ARRuntime } = require("../../lib/three-runtime/ar-runtime");
const {
  ModelCache,
  disposeTree,
} = require("../../lib/three-runtime/resources");
const { instantiateModel } = require("./assets/model");
const assetsMethods = require("./assets/index")(XR_CONFIG);
const danmakuMethods = require("./effects/danmaku")(XR_CONFIG);
const repulsionMethods = require("./effects/repulsion")(XR_CONFIG);
const hugeMethods = require("./assets/huge")(XR_CONFIG);
const confettiMethods = require("./effects/confetti")(XR_CONFIG);
function buildInitialState() {
  return {
    retrievalMode: "gps",
    _modeEpoch: 0,
    _contentEpoch: 0,
    _allowedAssetIds: new Set(),
    _nextRecognitionAt: 0,
    _disposed: false,
    _retrievalPaused: false,
    nodeIdCounter: 0,
    nodeList: [], // [{ assetId, node, billboardEl, trs, billboardTrs, type, bucket, bornAt, audioRefs, videoRefs, imageRefs, modelAnim? }]
    // 音频节点子列表（audioRefs 非空的 entry），由 queue 在注册/销毁时维护，
    // tickAudioVolume 直接用，避免每帧 nodeList.filter 分配
    _audioEntries: [],

    // assetId → 被驱逐时刻：repeatCooldownMs 类型（text/image）消失后冷却期内不重复放置
    _seenAssets: new Map(),
    // 首轮限量揭示是否已消耗（首轮 revealFirstFetch 加量，仅在实际放置过内容后置位）
    _firstRevealDone: false,
    spatialAudioList: [],
    flyingDanmakus: [],
    // Three 渲染器初始化完成后即可放置；文字无需背景图预加载。
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
  properties: {
    width: { type: Number, value: 300 },
    height: { type: Number, value: 300 },
  },
  observers: {
    "width,height"(width, height) {
      this._runtime?.resize(width, height);
    },
  },
  data: {
    arReady: false,
    retrievalMode: "gps",
    renderError: "",
    renderStatus: "正在启动 AR 相机…",
    canRetry: true,
  },
  lifetimes: {
    attached() {
      Object.assign(this, buildInitialState());
      this._pageVisible = true;
      this._forwardScratch = new THREE.Vector3();
      this._raycaster = new THREE.Raycaster();
      this._tapPoint = new THREE.Vector2();
      this.startGPSWatch();
      this.fetchOrgStyle();
    },
    ready() {
      this.createSelectorQuery()
        .select("#ar-canvas")
        .fields({ node: true, size: true })
        .exec((result) => {
          if (this._disposed) return;
          try {
            const canvas = (this._canvas = result[0]?.node);
            if (!canvas) throw new Error("无法创建 AR 画布");
            this._runtime = new ARRuntime(canvas, {
              width: this.data.width,
              height: this.data.height,
              onReady: () => this.handleARReady(),
              onTick: (dt) => this.handleTick(dt),
              onState: (state, message) => this.onARState(state, message),
              onReticleError: (error) =>
                this.reportAssetError({ file_type: "cursor" }, error),
            });
            this.scene = this._runtime.scene;
            this.shadowRoot = this._runtime.content;
            this._modelCache = new ModelCache(
              canvas,
              XR_CONFIG.maxCachedModelUrls || 8,
            );
            this._hugeModelCache = new ModelCache(
              canvas,
              XR_CONFIG.maxCachedHugeUrls || 3,
            );
            this._preloadDone = this._assetsLoaded = true;
            if (this._pageVisible) this.startAR();
          } catch (error) {
            this.onARState("error", error.message);
          }
        });
    },
    detached() {
      this.pauseRetrieval();
      this._disposed = true;
      this._arReady = false;
      this.disposeRecognitionCapture();
      this.clearRecognitionFrame();
      clearTimeout(this._firstFetchTimer);
      if (this._gpsListener) wx.offLocationChange(this._gpsListener);
      this._runtime?.dispose();
      this._modelCache?.dispose();
      this._hugeModelCache?.dispose();
      this._runtime = null;
      this.scene = null;
      this._canvas = null;
    },
  },
  pageLifetimes: {
    hide() {
      this._pageVisible = false;
      this.pauseRetrieval();
      this._arReady = false;
      this._sessionActive = false;
      this._runtime?.stop();
      this.disposeRecognitionCapture();
      clearTimeout(this._firstFetchTimer);
      this._firstFetchStarted = false;
      this._fetchAnchorXZ = null;
      this.setData({ arReady: false });
    },
    show() {
      this._pageVisible = true;
      if (this._runtime && !this._sessionActive) this.startAR();
    },
  },
  methods: {
    ...gps,
    ...matching,
    ...assetsMethods,
    ...danmakuMethods,
    ...repulsionMethods,
    ...navigation,
    ...hugeMethods,
    ...confettiMethods,
    getCamTransform() {
      return this._arReady ? this._runtime?.camera : null;
    },
    startAR() {
      if (this._disposed || !this._runtime || this._sessionActive) return;
      this._sessionActive = true;
      this.setData({ renderError: "", renderStatus: "正在启动 AR 相机…" });
      this._runtime.start();
    },
    onARState(state, message) {
      if (this._disposed) return;
      if (state === "error") {
        clearTimeout(this._firstFetchTimer);
        this._firstFetchStarted = false;
        this._sessionActive = false;
        this._arReady = false;
        this._cancelRetrieval();
        this._clearRemoteAssets();
        this.setData({
          arReady: false,
          renderError: message || "AR 初始化失败",
          renderStatus: "",
          canRetry: !!this._runtime && !this._contextLost,
        });
      } else
        this.setData({
          renderStatus:
            state === "running"
              ? "请缓慢移动手机，初始化空间追踪…"
              : "正在启动 AR 相机…",
        });
      this.triggerEvent("renderstatus", {
        state,
        message: message || "",
        renderer: "visionkit-three",
      });
    },
    handleARReady() {
      this._arReady = true;
      this._firstFetchStarted = false;
      this._fetchAnchorXZ = null;
      this.resetCaptureTiming();
      this.setData({ arReady: true, renderStatus: "", renderError: "" });
      this._maybeStartFirstFetch();
      this.flushPendingDisplayAssets();
      this._maybeStartConfetti();
    },
    handleTick(dt) {
      if (this._disposed || !this._arReady) return;
      this._frameDelta = dt;
      const camera = this._runtime.camera,
        camPos = camera.position;
      this.sampleCaptureMotion(camera);
      if (!this._fetchAnchorXZ)
        this._fetchAnchorXZ = { x: camPos.x, z: camPos.z };
      this._runtime.updateReticle(
        this.retrievalMode === "gps" && !this._retrievalPaused,
      );
      this.tickFlyingDanmakus();
      this.tickRepulsion();
      this.tickAudioVolume();
      this.tickModelAnimation();
      this.tickHugeModels();
      this.tickConfetti();
      for (const entry of this.nodeList)
        if (entry.billboardEl) entry.billboardEl.lookAt(camPos);
      if (this._retrievalPaused) return;
      if (this.retrievalMode === "anchor") {
        if (Date.now() >= this._nextRecognitionAt) this.recognizeAnchor();
        return;
      }
      const displacement = Math.hypot(
          camPos.x - this._fetchAnchorXZ.x,
          camPos.z - this._fetchAnchorXZ.z,
        ),
        now = Date.now();
      if (
        displacement >= XR_CONFIG.distanceThreshold &&
        now - this._lastFetchTime >= XR_CONFIG.fetchCooldownMs
      ) {
        this._fetchAnchorXZ = { x: camPos.x, z: camPos.z };
        this._lastFetchTime = now;
        this.fetchNearbyAssets();
        this.fetchHugeAssets();
      }
    },
    _maybeStartConfetti() {
      if (
        this._arReady &&
        this._assetsLoaded &&
        this._confettiEnabled === true &&
        !this._retrievalPaused &&
        this.retrievalMode === "gps"
      )
        this.startRandomConfetti();
    },
    reportAssetError(asset, error) {
      if (this._disposed) return;
      console.warn("[ThreeAR][asset-error]", {
        assetId: asset?.id,
        type: asset?.file_type,
        message: error?.message || error?.errMsg || String(error),
      });
      this.triggerEvent("asseterror", {
        assetId: asset?.id,
        type: asset?.file_type,
        message: error?.message || error?.errMsg || "素材加载失败",
      });
    },
    onCanvasTap(event) {
      if (!this._arReady || this._retrievalPaused) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      this.createSelectorQuery()
        .select("#ar-canvas")
        .boundingClientRect((rect) => {
          if (!rect || !this._arReady || this._disposed) return;
          const x = (touch.clientX - rect.left) / rect.width,
            y = (touch.clientY - rect.top) / rect.height;
          this._tapPoint.set(x * 2 - 1, 1 - y * 2);
          this._raycaster.setFromCamera(this._tapPoint, this._runtime.camera);
          const hits = this._raycaster.intersectObjects(
            this.nodeList.map((e) => e.node),
            true,
          );
          if (hits.length) {
            let node = hits[0].object;
            while (node) {
              const entry = this.nodeList.find((e) => e.node === node);
              if (entry) {
                if (entry.onTap) {
                  entry.onTap();
                  return;
                }
                break;
              }
              node = node.parent;
            }
          }
          if (this.retrievalMode === "gps") this.placeNode();
        })
        .exec();
    },
    async placeNode() {
      if (
        this.retrievalMode !== "gps" ||
        this._retrievalPaused ||
        !this._arReady ||
        this._treePlacing
      )
        return;
      const reticle = this._runtime.reticle;
      if (!reticle?.visible) return;
      // Use the displayed cursor, not the finger position or a later hit test.
      // Snapshot before loading: moving the phone must not move this planting site.
      reticle.updateWorldMatrix(true, false);
      const epoch = this._contentEpoch,
        matrix = reticle.matrixWorld.clone();
      this._treePlacing = true;
      let handle;
      try {
        handle = await this._modelCache.acquire(XR_CONFIG.treeModelUrl);
        if (this._disposed || epoch !== this._contentEpoch || !this._arReady) {
          disposeTree(handle.object);
          handle.release();
          return;
        }
        const instance = instantiateModel(handle, 0.3);
        // Imported models may have an offset pivot. Keep the ground alignment
        // outside the animated model so AnimationMixer cannot overwrite it.
        const bounds = new THREE.Box3().setFromObject(instance.root);
        if (!bounds.isEmpty())
          instance.root.position.set(
            -(bounds.min.x + bounds.max.x) / 2,
            -bounds.min.y,
            -(bounds.min.z + bounds.max.z) / 2,
          );
        const placement = new THREE.Group();
        placement.add(instance.root);
        matrix.decompose(
          placement.position,
          placement.quaternion,
          placement.scale,
        );
        this.shadowRoot.add(placement);
        const entry = this._registerNode(null, placement, null, {
          type: "model",
          dispose: instance.dispose,
          repulsionEnabled: false,
        });
        entry.mixer = instance.mixer;
      } catch (error) {
        if (handle) {
          disposeTree(handle.object);
          handle.release();
        }
        this.reportAssetError({ file_type: "model" }, error);
      } finally {
        this._treePlacing = false;
      }
    },
    onContextLost(event) {
      this._runtime?.facade.dispatch("webglcontextlost", event.detail);
      this._runtime?.stop();
      this._contextLost = true;
      this.onARState("error", "渲染上下文已丢失，请返回首页后重新进入 AR");
    },
    onContextRestored() {
      if (!this._disposed)
        this.setData({
          renderError: "请返回首页后重新进入 AR，以重新建立相机和渲染资源",
        });
    },
    retryAR() {
      if (this._contextLost) return;
      this.startAR();
    },
    async fetchOrgStyle() {
      const orgId = CONFIG.organizationId || "";
      if (!orgId) return;
      const styleKey = `config:org:${orgId}:textStyle:v1`;
      const confettiKey = `config:org:${orgId}:confetti:v1`;
      try {
        // 接口只返回小程序会用到的 config 键（见 docs/miniapp-api.md）。
        const { statusCode, data } = await fetchOrganizations([orgId]);
        if (this._disposed) return;
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
  },
});

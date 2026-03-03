const { CONFIG, supabaseRpc } = require("../../utils/supabase");

const XR_CONFIG = {
  maxDistanceMeters: 500,
  maxNodeCount: 10,
  distanceThreshold: 5, // 触发素材更新的距离阈值（米）
  treeModelUrl: "https://8thwall.8thwall.app/assets/tree-d51u9146bh.glb",
};

Component({
  behaviors: [require("../common/share-behavior").default],
  properties: { a: Number },
  data: { loaded: false, arReady: false },

  lifetimes: {
    attached() {
      Object.assign(this, {
        nodeIdCounter: 0,
        nodeList: [],
        textList: [],
        lastCamPos: null,
        accumulatedDistance: 0,
        gpsReady: false,
        firstFetchDone: false,
        currentGPS: null,
        isFetchingAssets: false,
      });
      this.startGPSWatch();
    },
    detached() {
      if (this.locationWatchId) {
        wx.stopLocationUpdate();
        this.locationWatchId = null;
      }
    },
  },

  methods: {
    // ─── GPS ────────────────────────────────────────
    updateGPS({ latitude, longitude, accuracy }) {
      const isFirst = !this.gpsReady;
      this.currentGPS = { latitude, longitude, accuracy };
      this.gpsReady = true;
      if (isFirst && !this.firstFetchDone) {
        this.firstFetchDone = true;
        this.fetchNearbyAssets();
      }
    },

    startGPSWatch() {
      wx.startLocationUpdate({
        success: () => {
          wx.onLocationChange((res) => this.updateGPS(res));
          this.locationWatchId = true;
        },
        fail: () => this.getLocationOnce(),
      });
    },

    getLocationOnce() {
      wx.getLocation({
        type: "wgs84",
        success: (res) => this.updateGPS(res),
        fail: (err) => console.error("[GPS] 定位失败", err),
      });
    },

    // ─── Supabase 素材获取 ──────────────────────────
    async fetchNearbyAssets() {
      if (this.isFetchingAssets || !this.currentGPS) return;
      this.isFetchingAssets = true;

      try {
        const { statusCode, data } = await supabaseRpc("get_nearby_assets", {
          user_lat: this.currentGPS.latitude,
          user_lng: this.currentGPS.longitude,
          max_distance_meters: XR_CONFIG.maxDistanceMeters,
          p_workspace_id: CONFIG.workspaceId,
          p_organization_id: CONFIG.organizationId,
        });

        if (statusCode === 200 && Array.isArray(data)) {
          this.displayAssets(data.filter((a) => a.file_type === "text"));
        }
      } catch (err) {
        console.error("[fetch] 请求失败:", err);
      } finally {
        this.isFetchingAssets = false;
      }
    },

    // ─── AR 场景素材渲染 ────────────────────────────
    getCamTransform() {
      const xr = wx.getXrFrameSystem();
      const cam = this.scene?.getElementById("camera");
      return cam?.getComponent(xr.Transform);
    },

    displayAssets(assets) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const camPos = camTransform.position;

      for (const asset of assets) {
        // 超出上限时删最旧节点
        if (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
          this.shadowRoot.removeChild(this.nodeList.shift());
          this.textList.shift();
        }

        const angle = Math.random() * Math.PI * 2;
        const radius = 0.8 + Math.random() * 0.7;
        const x = camPos.x + Math.cos(angle) * radius;
        const z = camPos.z + Math.sin(angle) * radius;
        const y = camPos.y + (Math.random() - 0.5) * 0.6;

        const rootNode = scene.createElement(xr.XRNode, {
          id: `label-node-${this.nodeIdCounter++}`,
          position: `${x} ${y} ${z}`,
          scale: "0.1 0.1 0.1",
        });
        this.shadowRoot.addChild(rootNode);
        this.nodeList.push(rootNode);

        const text = scene.createElement(xr.XRText, {
          position: "0 0 0",
          value: asset.text_content || "无内容",
          size: "2",
          anchor: "0.5 0.5",
          "never-cull": "",
        });
        rootNode.addChild(text);
        this.textList.push(text);
      }
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
    },

    handleAssetsLoaded() {
      this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
    },

    handleAssetsProgress() {},

    handleARReady() {
      console.log("arReady", this.scene.ar.arVersion);
    },

    handleTick() {
      const xr = wx.getXrFrameSystem();
      const camTransform = this.getCamTransform();
      if (!camTransform) return;

      const camPos = camTransform.position;

      // 累积水平移动距离
      if (this.lastCamPos) {
        const dx = camPos.x - this.lastCamPos.x;
        const dz = camPos.z - this.lastCamPos.z;
        this.accumulatedDistance += Math.sqrt(dx * dx + dz * dz);
      }
      this.lastCamPos = { x: camPos.x, z: camPos.z };

      // 让所有 text 面向相机（billboard）
      for (const el of this.textList) {
        const trs = el?.getComponent(xr.Transform);
        if (!trs) continue;
        this.FACING.set(trs.worldPosition).sub(camPos, this.FACING);
        xr.Quaternion.lookRotation(this.FACING, this.UP, trs.quaternion);
      }

      // 达到阈值时拉取新素材
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

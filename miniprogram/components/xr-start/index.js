Component({
  behaviors: [require("../common/share-behavior").default],
  properties: {
    a: Number,
  },
  data: {
    loaded: false,
    arReady: false,
  },
  lifetimes: {
    async attached() {
      console.log("data", this.data);
      // 初始化节点管理
      this.nodeIdCounter = 0;
      this.nodeList = [];
      this.maxNodeCount = 10;

      // 累积移动距离相关
      this.lastCamPos = null; // 上一帧相机位置
      this.distanceThreshold = 5; // 触发素材更新的距离阈值（米）
      this.accumulatedDistance = 0; // 初始为0，等GPS就绪后首次触发
      this.gpsReady = false; // GPS是否已就绪
      this.firstFetchDone = false; // 首次拉取是否完成

      // GPS 相关
      this.currentGPS = null; // 当前GPS位置
      this.isFetchingAssets = false; // 防止重复请求

      // Supabase 配置
      this.supabaseUrl = "https://mkdfezaufjhrfjkfqlbj.supabase.co";
      this.supabaseKey =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZGZlemF1ZmpocmZqa2ZxbGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDI2NzksImV4cCI6MjA4MDc3ODY3OX0.YvoVQP5k61rl1dbm-y7O-MQCsfke3rnSIzhWvbVGQdU";
      this.workspaceName = "test";
      this.maxDistanceMeters = 500;

      // 启动GPS监听
      this.startGPSWatch();
    },
    detached() {
      // 停止GPS监听
      if (this.locationWatchId) {
        wx.stopLocationUpdate();
        this.locationWatchId = null;
      }
    },
  },
  methods: {
    // 启动GPS监听
    startGPSWatch() {
      wx.startLocationUpdate({
        success: () => {
          console.log("[GPS] 开启定位成功");
          wx.onLocationChange((res) => {
            const isFirstGPS = !this.gpsReady;
            this.currentGPS = {
              latitude: res.latitude,
              longitude: res.longitude,
              accuracy: res.accuracy,
            };
            this.gpsReady = true;
            console.log("[GPS] 位置更新:", this.currentGPS);

            // GPS首次就绪时，立即触发素材拉取
            if (isFirstGPS && !this.firstFetchDone) {
              console.log("[GPS] 首次定位成功，触发素材拉取");
              this.firstFetchDone = true;
              this.fetchNearbyAssets();
            }
          });
          this.locationWatchId = true;
        },
        fail: (err) => {
          console.error("[GPS] 开启定位失败", err);
          // 尝试使用单次定位作为备选
          this.getLocationOnce();
        },
      });
    },

    // 单次获取GPS位置
    getLocationOnce() {
      wx.getLocation({
        type: "gcj02",
        success: (res) => {
          const isFirstGPS = !this.gpsReady;
          this.currentGPS = {
            latitude: res.latitude,
            longitude: res.longitude,
            accuracy: res.accuracy,
          };
          this.gpsReady = true;
          console.log("[GPS] 单次定位成功:", this.currentGPS);

          // GPS首次就绪时，立即触发素材拉取
          if (isFirstGPS && !this.firstFetchDone) {
            console.log("[GPS] 首次定位成功，触发素材拉取");
            this.firstFetchDone = true;
            this.fetchNearbyAssets();
          }
        },
        fail: (err) => {
          console.error("[GPS] 单次定位失败", err);
        },
      });
    },

    // 请求附近素材
    async fetchNearbyAssets() {
      if (this.isFetchingAssets || !this.currentGPS) {
        console.log(
          "[fetch] 跳过请求: fetching=",
          this.isFetchingAssets,
          "gps=",
          this.currentGPS,
        );
        return;
      }

      this.isFetchingAssets = true;

      try {
        const response = await new Promise((resolve, reject) => {
          wx.request({
            url: `${this.supabaseUrl}/rest/v1/rpc/get_nearby_assets`,
            method: "POST",
            header: {
              "Content-Type": "application/json",
              apikey: this.supabaseKey,
              Authorization: `Bearer ${this.supabaseKey}`,
            },
            data: {
              user_lat: this.currentGPS.latitude,
              user_lng: this.currentGPS.longitude,
              max_distance_meters: this.maxDistanceMeters,
              workspace_name: this.workspaceName,
            },
            success: (res) => resolve(res),
            fail: (err) => reject(err),
          });
        });

        console.log("[fetch] 接口返回:", response.data);

        if (response.statusCode === 200 && Array.isArray(response.data)) {
          // 过滤出 file_type == 'text' 的数据
          const textAssets = response.data.filter(
            (asset) => asset.file_type === "text",
          );
          console.log("[fetch] text素材数量:", textAssets.length);

          // 将素材显示到空间中
          this.displayAssets(textAssets);
        }
      } catch (err) {
        console.error("[fetch] 请求失败:", err);
      } finally {
        this.isFetchingAssets = false;
      }
    },

    // 将素材显示到AR空间中
    displayAssets(assets) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      if (!scene) return;

      const camera = scene.getElementById("camera");
      const camTransform = camera.getComponent(xr.Transform);
      if (!camTransform) return;

      const camPos = camTransform.position;

      for (const asset of assets) {
        // 控制节点总量，超出时删除最旧的
        if (this.nodeList.length >= this.maxNodeCount) {
          const oldestNode = this.nodeList.shift();
          this.textList.shift();
          this.shadowRoot.removeChild(oldestNode);
          console.log("[remove] oldest node removed");
        }

        // 随机摆在 camera 周围 0.8~1.5 米
        const angle = Math.random() * Math.PI * 2;
        const radius = 0.8 + Math.random() * 0.7;
        const x = camPos.x + Math.cos(angle) * radius;
        const z = camPos.z + Math.sin(angle) * radius;
        // y轴在相机高度基础上随机 -0.3 ~ +0.3 米
        const y = camPos.y + (Math.random() - 0.5) * 0.6;

        // 创建 root XRNode
        const nodeId = `label-node-${this.nodeIdCounter++}`;
        const rootNode = scene.createElement(xr.XRNode, {
          id: nodeId,
          position: `${x} ${y} ${z}`,
          scale: "0.1 0.1 0.1",
        });

        this.shadowRoot.addChild(rootNode);
        this.nodeList.push(rootNode);

        // 创建 text 显示 text_content
        const text = scene.createElement(xr.XRText, {
          position: "0 0 0",
          value: asset.text_content || "无内容",
          size: "2",
          anchor: "0.5 0.5",
          "never-cull": "",
        });
        rootNode.addChild(text);
        this.textList.push(text);

        console.log(
          `[spawn] ${nodeId} content="${asset.text_content}" at`,
          x.toFixed(2),
          y.toFixed(2),
          z.toFixed(2),
        );
      }
    },

    async handleReady({ detail }) {
      const xrScene = (this.scene = detail.value);
      const xr = wx.getXrFrameSystem();
      this.mat = new xr.Matrix4();
      this.shadowRoot = xrScene.getElementById("shadow-root");

      // 用于 lookAt 计算的向量
      this.FACING = xr.Vector3.createFromNumber(0, 0, 0);
      this.UP = xr.Vector3.createFromNumber(0, 1, 0);
      // 存储所有需要面向相机的 text 节点
      this.textList = [];

      const { value: model } = await xrScene.assets.loadAsset({
        type: "gltf",
        assetId: "tree",
        src: "https://8thwall.8thwall.app/assets/tree-d51u9146bh.glb",
      });
      this.gltfModel = model;

      console.log("xr-scene", xrScene);
    },
    handleAssetsProgress: function ({ detail }) {
      console.log("assets progress", detail.value);
    },
    handleAssetsLoaded: function ({ detail }) {
      console.log("assets loaded", detail.value);
      // this.setData({loaded: true});
      this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
    },
    handleARReady: function ({ detail }) {
      console.log("arReady", this.scene.ar.arVersion);
    },
    handleTick() {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;

      const camera = scene.getElementById("camera");
      const camTransform = camera.getComponent(xr.Transform);
      if (!camTransform) return;

      const camPos = camTransform.position;

      // ========= 计算相机累积移动距离（只考虑水平面移动，不含y轴） =========
      if (this.lastCamPos) {
        const dx = camPos.x - this.lastCamPos.x;
        const dz = camPos.z - this.lastCamPos.z;
        const frameDist = Math.sqrt(dx * dx + dz * dz);
        this.accumulatedDistance += frameDist;
      }
      // 更新上一帧位置
      this.lastCamPos = { x: camPos.x, z: camPos.z };

      // ========= 让所有 text 面向相机 =========
      for (const textEl of this.textList) {
        if (!textEl) continue;
        const textTrs = textEl.getComponent(xr.Transform);
        if (textTrs) {
          const quaternion = textTrs.quaternion;
          // 算出从相机到物体的向量（反向，使正面朝向相机）
          this.FACING.set(textTrs.worldPosition).sub(camPos, this.FACING);
          xr.Quaternion.lookRotation(this.FACING, this.UP, quaternion);
        }
      }

      // 累积移动距离未达到阈值，跳过素材更新
      if (this.accumulatedDistance < this.distanceThreshold) return;

      // 重置累积距离
      console.log(
        `[distance] 累积移动 ${this.accumulatedDistance.toFixed(2)}m，触发素材更新`,
      );
      this.accumulatedDistance = 0;

      // 调用接口获取附近素材
      this.fetchNearbyAssets();
    },
    placeNode(event) {
      try {
        console.log("start");

        const xr = wx.getXrFrameSystem();

        // 创建 XRGLTF 元素（和 example 一致）
        const gltfElement = this.scene.createElement(xr.XRGLTF);

        // 挂到 shadowRoot（⚠️ 关键）
        this.shadowRoot.addChild(gltfElement);

        // 设置模型
        gltfElement.getComponent(xr.GLTF).setData({
          model: this.gltfModel,
        });

        // 通过 AR 系统放到当前命中的平面
        this.scene.ar.placeHere(gltfElement, true);

        // 设置缩放
        gltfElement.getComponent(xr.Transform).scale.setValue(0.3, 0.3, 0.3);

        const pos = gltfElement.getComponent(xr.Transform).position;

        console.log("Tree position: ", pos.x, pos.z, pos.y);

        console.log("place success");
      } catch (e) {
        console.error("placeNode error", e);
      }

      // 下一次再点才能继续放
      this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
    },
  },
});

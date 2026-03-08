const { CONFIG, supabaseRpc } = require("../../utils/supabase");

/** 远程素材获取与场景渲染 */
module.exports = function (XR_CONFIG) {
  return {
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
          this.displayAssets(
            data.filter(
              (a) => a.file_type === "text" || a.file_type === "model",
            ),
          );
        }
      } catch (err) {
        console.error("[fetch] 请求失败:", err);
      } finally {
        this.isFetchingAssets = false;
      }
    },

    displayAssets(assets) {
      for (const asset of assets) {
        if (asset.file_type === "model") {
          this._placeModelAsset(asset);
        } else if (asset.file_type === "text") {
          this._placeTextAsset(asset);
        }
      }
    },

    _placeTextAsset(asset) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      if (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
        this.removeOldestNode();
      }

      const camPos = camTransform.position;
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
    },

    async _placeModelAsset(asset) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform || !asset.file_url) return;

      if (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
        this.removeOldestNode();
      }

      // 在异步加载之前先记录当前相机世界坐标，避免加载完成后位置已漂移
      const camPos = camTransform.position;
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.0 + Math.random() * 1.5;
      const x = camPos.x + Math.cos(angle) * radius;
      const z = camPos.z + Math.sin(angle) * radius;
      const y = camPos.y;

      try {
        const assetId = `model-asset-${this.nodeIdCounter}`;
        const { value: model } = await scene.assets.loadAsset({
          type: "gltf",
          assetId,
          src: asset.file_url,
        });

        // 先把节点加入场景，再通过 Transform API 设置世界坐标，
        // 避免 createElement 字符串属性在 AR 模式下被清空或变为摄像机相对坐标
        const rootNode = scene.createElement(xr.XRNode, {
          id: `model-node-${this.nodeIdCounter++}`,
          scale: "0.3 0.3 0.3",
        });
        this.shadowRoot.addChild(rootNode);
        // 节点挂入场景后再写入世界位置，确保锚定在 AR 世界坐标中而非跟随相机
        rootNode.getComponent(xr.Transform).position.setValue(x, y, z);

        const gltfEl = scene.createElement(xr.XRGLTF);
        gltfEl.getComponent(xr.GLTF).setData({ model });
        rootNode.addChild(gltfEl);

        this.nodeList.push(rootNode);
        this.textList.push(null);
      } catch (e) {
        console.error("[model] 加载模型失败:", asset.file_url, e);
      }
    },
  };
};

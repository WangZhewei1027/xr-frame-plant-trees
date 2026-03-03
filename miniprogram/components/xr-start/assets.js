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
          this.displayAssets(data.filter((a) => a.file_type === "text"));
        }
      } catch (err) {
        console.error("[fetch] 请求失败:", err);
      } finally {
        this.isFetchingAssets = false;
      }
    },

    displayAssets(assets) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const camPos = camTransform.position;

      for (const asset of assets) {
        if (this.nodeList.length >= XR_CONFIG.maxNodeCount) {
          this.removeOldestNode();
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
  };
};

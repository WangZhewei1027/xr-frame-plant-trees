/** 文本素材：在相机周围随机位置放置一个气泡节点 */
module.exports = {
  _placeTextAsset(asset) {
    const xr = wx.getXrFrameSystem();
    const scene = this.scene;
    const camTransform = this.getCamTransform();
    if (!scene || !camTransform) return;

    const pos = this._calcForwardPos("text");
    if (!pos) return;
    const x = pos.x;
    const z = pos.z;
    const y = pos.y + (Math.random() - 0.5) * 0.6;

    const rootNode = scene.createElement(xr.XRNode, {
      id: `label-node-${this.nodeIdCounter++}`,
      position: `${x} ${y} ${z}`,
      scale: "0.1 0.1 0.1",
    });
    this.shadowRoot.addChild(rootNode);

    let entry;
    try {
      // 先登记父节点，构建文字/气泡失败时也能完整回收。
      entry = this._registerNode(asset.id, rootNode, rootNode, {
        type: "text", contentEpoch: asset._contentEpoch,
      });
      if (entry._destroyed) return;
      const textEl = this._buildBubbleNodes(
        rootNode,
        asset.text_content || "无内容",
        asset.config || null,
      );
      entry.textRefs = { textEl };
    } catch (error) {
      const registered = entry || this.nodeList.find((item) => item.node === rootNode);
      this.nodeList = this.nodeList.filter((item) => item.node !== rootNode);
      this._destroyNode(registered || { assetId: asset.id, node: rootNode, type: "text" });
      throw error;
    }
  },
};

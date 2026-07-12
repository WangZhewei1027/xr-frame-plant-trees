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

    this._buildBubbleNodes(
      rootNode,
      asset.text_content || "无内容",
      asset.config || null,
    );
    // billboard 目标 = rootNode，让整个气泡结构朝向相机
    this._registerNode(asset.id, rootNode, rootNode, { type: "text" });
  },
};

/** 弹幕飞行动画：从相机后下方飞到正前方，微信聊天气泡样式 */

/**
 * 将十六进制颜色（如 #FF5500 或 #f55）转为 XR-Frame u_baseColorFactor 格式（R G B 1）
 * @param {string} hex
 * @returns {string}
 */
function _hexToRgbaFactor(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const r = (parseInt(h.slice(0, 2), 16) / 255).toFixed(3);
  const g = (parseInt(h.slice(2, 4), 16) / 255).toFixed(3);
  const b = (parseInt(h.slice(4, 6), 16) / 255).toFixed(3);
  return `${r} ${g} ${b} 1`;
}

module.exports = function (XR_CONFIG) {
  return {
    /**
     * 在 rootNode 下创建微信气泡子节点（背景 + 箭头 + 头像 + 文字）。
     * 供 showDanmakuInXR 和 _placeTextAsset 共用。
     * @returns {Element} textEl 文字节点
     */
    _buildBubbleNodes(rootNode, text, config) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;

      // plain_white：严格无装饰，只显示纯白文字
      // 此模式下读取 per-asset config 中的颜色和大小设置
      if (this._textAssetStyle === "plain_white") {
        const colorFactor =
          config && config.text_color
            ? _hexToRgbaFactor(config.text_color)
            : "1 1 1 1";
        const fontSize =
          config && config.text_size ? String(config.text_size) : "1.5";
        const textEl = scene.createElement(xr.XRText, {
          position: "0 0 0",
          value: text,
          size: fontSize,
          anchor: "0.5 0.5",
          "never-cull": "",
          uniforms: `u_baseColorFactor:${colorFactor}`,
        });
        rootNode.addChild(textEl);
        return textEl;
      }

      // ── 紫色半透明气泡 + 发亮边框 ──
      const dir = Math.random() > 0.5 ? 1 : -1;
      const textColor = "0.945 0.914 0.914 1"; // #F1E9E9
      const avatarColor = "0.78 0.78 0.78 1.0";

      // ── 根据文字长度动态计算气泡尺寸（整体缩小一半） ──
      const charW = 1.1;
      const padH = 1.25;
      const bw = Math.max(text.length * charW + padH * 2, 4);
      const bh = 2;
      const avatarSize = 1.75;

      // ── 气泡背景（圆角矩形 PNG 纹理） ──
      const ratio = Math.max(2, Math.min(8, Math.round(bw / bh)));
      const bubbleTexIds = this._bubbleTexIds || {};
      const bubbleTexId = bubbleTexIds[ratio];

      if (bubbleTexId) {
        const bgMesh = scene.createElement(xr.XRMesh, {
          geometry: "plane",
          material: "standard-mat",
          uniforms: `u_baseColorMap: ${bubbleTexId}`,
          position: "0 0 -0.15",
          rotation: "90 0 0",
          scale: `${bw} 1 ${bh}`,
          states: "cullOn: false, alphaMode:BLEND, renderQueue:2500",
        });
        rootNode.addChild(bgMesh);
      } else {
        // fallback: 无纹理时用 cube
        const bgMesh = scene.createElement(xr.XRMesh, {
          geometry: "cube",
          uniforms: "u_baseColorFactor:0.596 0.145 0.596 0.55",
          position: "0 0 -0.15",
          scale: `${bw} ${bh} 0.01`,
          states: "alphaMode:BLEND, renderQueue:2500",
        });
        rootNode.addChild(bgMesh);
      }

      // ── 头像（从 profile 文件夹随机选图，无图时用灰色占位） ──
      const avatarX = dir * (bw / 2 + avatarSize / 2 + 0.3);
      const profiles = this._profileAssetIds || [];
      if (profiles.length > 0) {
        const texId = profiles[Math.floor(Math.random() * profiles.length)];
        const avatarMesh = scene.createElement(xr.XRMesh, {
          geometry: "plane",
          material: "standard-mat",
          uniforms: `u_baseColorMap: ${texId}`,
          position: `${avatarX} 0 -0.15`,
          rotation: "90 0 0",
          scale: `${avatarSize} 1 ${avatarSize}`,
          states: "cullOn: false, alphaMode:BLEND, renderQueue:2510",
        });
        rootNode.addChild(avatarMesh);
      } else {
        const avatarMesh = scene.createElement(xr.XRMesh, {
          geometry: "cube",
          uniforms: `u_baseColorFactor:${avatarColor}`,
          position: `${avatarX} 0 -0.15`,
          scale: `${avatarSize} ${avatarSize} 0.01`,
        });
        rootNode.addChild(avatarMesh);
      }

      // ── 文字（+Z 方向最靠近相机） ──
      const textEl = scene.createElement(xr.XRText, {
        position: "0 0 0",
        value: text,
        size: "1.25",
        anchor: "0.5 0.5",
        "never-cull": "",
        uniforms: `u_baseColorFactor:${textColor}`,
      });
      rootNode.addChild(textEl);

      return textEl;
    },

    showDanmakuInXR(text) {
      const xr = wx.getXrFrameSystem();
      const scene = this.scene;
      const camTransform = this.getCamTransform();
      if (!scene || !camTransform) return;

      const camPos = camTransform.position;
      const wm = camTransform.worldMatrix;

      const localForward = xr.Vector3.createFromNumber(0, 0, 1);
      const localDown = xr.Vector3.createFromNumber(0, -1, 0);
      const worldForward = wm.transformDirection(localForward);
      const worldDown = wm.transformDirection(localDown);

      // 起点：相机后下方 (后 0.3m, 下 0.4m)
      const sx = camPos.x - worldForward.x * 0.3 + worldDown.x * 0.4;
      const sy = camPos.y - worldForward.y * 0.3 + worldDown.y * 0.4;
      const sz = camPos.z - worldForward.z * 0.3 + worldDown.z * 0.4;

      // 终点：相机正前方 1.5m
      const ex = camPos.x + worldForward.x * 1.5;
      const ey = camPos.y + worldForward.y * 1.5;
      const ez = camPos.z + worldForward.z * 1.5;

      // 弹幕独立 transient 桶，超限时由 _enforceCapacity FIFO 驱逐最旧弹幕。

      const rootNode = scene.createElement(xr.XRNode, {
        id: `danmaku-${this.nodeIdCounter++}`,
        position: `${sx} ${sy} ${sz}`,
        scale: "0.02 0.02 0.02",
      });
      this.shadowRoot.addChild(rootNode);

      const textEl = this._buildBubbleNodes(rootNode, text);

      // billboard 目标 = rootNode，让整个气泡结构朝向相机
      // assetId = null 表示本地刚发、未入库的弹幕；type='danmaku' 归入 transient 桶（FIFO）。
      // （后续从数据库拉下来的历史弹幕是 text 类型素材，归入 light 桶）
      const entry = this._registerNode(null, rootNode, rootNode, {
        type: "danmaku",
      });

      this.flyingDanmakus.push({
        node: rootNode,
        trs: entry.trs, // 注册时缓存的 Transform，飞行插值每帧直接用
        textEl,
        startPos: { x: sx, y: sy, z: sz },
        endPos: { x: ex, y: ey, z: ez },
        startTime: Date.now(),
        duration: 600,
        finalScale: 0.15,
        arrived: false,
      });
    },

    /** 每帧驱动：插值飞行弹幕位置 */
    tickFlyingDanmakus() {
      if (!this.flyingDanmakus || this.flyingDanmakus.length === 0) return;
      const now = Date.now();
      const finished = [];

      for (let i = 0; i < this.flyingDanmakus.length; i++) {
        const d = this.flyingDanmakus[i];
        const elapsed = now - d.startTime;
        let t = Math.min(elapsed / d.duration, 1);
        const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

        const trs = d.trs;
        if (!trs) {
          finished.push(i);
          continue;
        }

        const px = d.startPos.x + (d.endPos.x - d.startPos.x) * ease;
        const py = d.startPos.y + (d.endPos.y - d.startPos.y) * ease;
        const pz = d.startPos.z + (d.endPos.z - d.startPos.z) * ease;
        trs.position.setValue(px, py, pz);

        const s = 0.02 + (d.finalScale - 0.02) * ease;
        trs.scale.setValue(s, s, s);

        if (t >= 1 && !d.arrived) {
          d.arrived = true;
          finished.push(i);
        }
      }

      for (let i = finished.length - 1; i >= 0; i--) {
        this.flyingDanmakus.splice(finished[i], 1);
      }
    },
  };
};

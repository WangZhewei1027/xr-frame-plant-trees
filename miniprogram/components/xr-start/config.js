/** xr-start 全局配置 */
const XR_CONFIG = {
  maxDistanceMeters: 20,
  // 三个队列分开管理：
  //   - newQueue：本轮拉取引入的新节点，超限时 FIFO 驱逐（保留最近刚到的）
  //   - oldQueue：上一轮及更早拉取遗留的节点，超限时 "离用户最远" 优先驱逐
  //   - danmakuQueue：用户刚发出、尚未入库返回的在场弹幕，超限时 FIFO 驱逐最旧弹幕
  // 分队使"沿路逐渐补充"成为可能：新拉不会一口气挤掉身边的旧素材。
  maxNewNodeCount: 10,
  maxOldNodeCount: 25,
  maxDanmakuCount: 8,
  // 参考点到当前位置的 x/z 净位移超过此值才重新拉取素材（单位：XR 世界米）
  distanceThreshold: 5,
  // 两次拉取之间的最小间隔（毫秒），防止短时间内连续触发
  fetchCooldownMs: 3000,
  // 一批素材放置时，每个 asset 之间的错开间隔（毫秒）。
  // 避免一次性 createElement/addChild/loadAsset 全部堆在同一帧导致卡顿。
  placeStaggerMs: 80,
  // 斥力参数：nodeList 中所有已落位素材节点（文本/模型/图片/音频/视频/弹幕）之间的互斥推力。
  // repulsionRadius   : 斥力开始生效的距离（米），节点间距小于此值才会被推开。
  // repulsionStrength : 每帧最大位移量，值越大节点分散越快。
  repulsionRadius: 1.5,
  repulsionStrength: 0.008,
  treeModelUrl: "https://8thwall.8thwall.app/assets/tree-d51u9146bh.glb",
};

module.exports = XR_CONFIG;

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
  // 首次拉取延迟（毫秒）：ar-ready 后 AR 相机位姿（VIO）仍需若干帧收敛，
  // 立刻放置会用到尚未稳定的相机 worldMatrix（forward 退化为世界 +Z），导致素材落到身后。
  // 等 AR 就绪 + 该延迟后再触发首批拉取放置，确保 _calcForwardPos 拿到真实设备朝向。
  firstFetchDelayMs: 2000,
  // 一批素材放置时，每个 asset 之间的错开间隔（毫秒）。
  // 避免一次性 createElement/addChild/loadAsset 全部堆在同一帧导致卡顿。
  // 40ms ≈ 2.5 帧，足够让一帧渲染完成、又能让一批 10 个素材在 ~0.4s 内显完。
  placeStaggerMs: 40,
  // 斥力参数：nodeList 中所有已落位素材节点（文本/模型/图片/音频/视频/弹幕）之间的互斥推力。
  // repulsionRadius   : 斥力开始生效的距离（米），节点间距小于此值才会被推开。
  // repulsionStrength : 每帧最大位移量，值越大节点分散越快。
  repulsionRadius: 1.5,
  repulsionStrength: 0.008,
  // 素材放置参数：控制各类型素材在相机前方的散布方式
  // placeForwardArcDeg : 前向扇形两侧各展开的半角（度），30 = 前方 60° 覆盖（正前方 ±30°）
  // placeRadius        : 各类型的最小/最大放置半径（米），在此统一调整
  placeForwardArcDeg: 30,
  placeRadius: {
    text: { min: 1.5, max: 5.0 },
    image: { min: 1.5, max: 5.0 },
    model: { min: 1.5, max: 5.0 },
    audio: { min: 1.5, max: 5.0 },
    video: { min: 1.5, max: 5.0 },
  },
  treeModelUrl: "https://8thwall.8thwall.app/assets/tree-d51u9146bh.glb",
};

module.exports = XR_CONFIG;

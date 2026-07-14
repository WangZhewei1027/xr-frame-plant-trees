/** xr-start 全局配置 */
const XR_CONFIG = {
  // 调试日志开关：放置/加载热路径上的 console.log（含 JSON.stringify 构造）在真机上
  // 开销可观，且集中在 GPU 上传的突发窗口，默认关闭；排查问题时置 true。
  // console.warn / console.error 不受此开关控制。
  debugLog: false,
  maxDistanceMeters: 20,
  // ── 容量桶（bucket）：素材按"代价类"分桶，各桶独立限容、互不驱逐 ──
  //   - heavy（model/video）：加载昂贵、渲染重，独立小桶，文本洪水永远挤不掉。
  //   - light（text/image）  ：轻量同步素材，桶大一些。
  //   - audio                ：空间音频源。
  //   - transient（直发弹幕）：短命飞行动画，FIFO 驱逐最旧。
  // 归属由 assets/registry.js 的 descriptor.bucket 声明；加新类型无需改本文件。
  // evict 策略：
  //   - 'farthest'：离用户【位置】最远的先踢。距离在转头时不变，只有走远才变，
  //                 内容随移动平滑新旧交替，不会因视线晃动闪进闪出。
  //   - 'fifo'    ：注册顺序最旧的先踢（仅短命弹幕用）。
  buckets: {
    heavy: { cap: 6, evict: "farthest" },
    light: { cap: 20, evict: "farthest" },
    audio: { cap: 6, evict: "farthest" },
    transient: { cap: 8, evict: "fifo" },
  },
  // 最小停留时间（毫秒）：节点出现后此窗口内不参与驱逐，防止"刚淡入就被挤掉"的一闪。
  // 某桶找不到已过龄的可驱逐节点时，回退到无视此保护以保证 cap 是硬上限。
  minLifetimeMs: 1500,
  // GLB 解析缓存的 LRU 上限（按 URL 计）：超出时释放最久未用、且场景中已无实例的
  // gltf 资源（releaseAsset），防止"见过的模型全部永久驻留内存"。
  // 普通模型较小、复用率高，上限可放宽；巨型模型动辄几十 MB，从紧。
  maxCachedModelUrls: 8,
  maxCachedHugeUrls: 3,
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
  // 限量揭示：每轮拉取最多放置的新素材数，制造"边走边逐步出现"的探索感。
  // 超额素材直接丢弃（不放置、不进冷却），服务端下轮拉取会重新返回、自然轮到。
  //   - revealFirstFetch：首轮（进场）适当加量，避免开场冷清。
  //   - revealPerFetch  ：之后每走 distanceThreshold 触发一轮，逐步冒新内容。
  revealFirstFetch: 20,
  revealPerFetch: 10,
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

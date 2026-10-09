module.exports = {
  debugFramePreview: true, // 调试：保留最近一张已完成识别的临时图片供核对，离开 AR 页面清理。
  debugLogs: true, // 控制台筛选 [AnchorMatch]；设为 false 关闭匹配日志。
  // 识别接口在 Web 平台（阿里云上海，与数据库、模型同地域）；模型 Token 保存在服务端。
  // 留空则使用 utils/backend.ts 的 RECOGNIZE_API（与数据接口同一个地址，只在那里改）。
  apiBaseUrl: "",
  apiPath: "/api/miniapp/anchors/recognize",
  functionRegion: "", // 已不再经过 Supabase Edge，无需 x-region 头。
  intervalMs: 1000, // 取图间隔 1 秒；日志同时记录实际间隔，上传/识别允许并发。
  maxInFlightRequests: 6, // 慢网络时跳过调度，不积压旧图片或无限并发。
  gpsCacheMs: 5000, // 单次定位（兜底路径）在同一识别周期内的复用时间。
  // 优先使用组件的持续定位（startLocationUpdate，与 GPS 模式共用，人移动时持续更新）；
  // 超过这个时间没有新的定位推送、或精度超过 100 米，才退回单次高精度定位（最多等 3 秒）。
  // 服务端要求 gps_timestamp 在 30 秒内，这里必须小于 30000。
  gpsWatchMaxAgeMs: 10000,
  errorRetryMs: 5000,
  initialCaptureDelayMs: 3000,
  restartDistanceMeters: 1.5,
  timeoutMs: 20000,
  maxImageEdge: 640,
  // Native VKFrame exports apply the viewport crop. No XR YUV conversion or fixed rotation.
};

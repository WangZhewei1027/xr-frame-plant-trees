module.exports = {
  debugFramePreview: true, // 调试：保留最近一张已完成识别的临时图片供核对，离开 AR 页面清理。
  debugLogs: true, // 控制台筛选 [AnchorMatch]；设为 false 关闭匹配日志。
  // 直接调用 Supabase Edge Function；模型 Token 保存在服务端。
  apiBaseUrl: "https://mkdfezaufjhrfjkfqlbj.supabase.co",
  apiPath: "/functions/v1/recognize-anchor",
  functionRegion: "ap-south-1", // 固定数据库所在孟买；本轮区域对照验收18/18成功，留空可恢复自动路由。
  intervalMs: 1000, // 取图间隔 1 秒；日志同时记录实际间隔，上传/识别允许并发。
  maxInFlightRequests: 6, // 慢网络时跳过调度，不积压旧图片或无限并发。
  gpsCacheMs: 5000, // 同一识别周期内短暂复用定位，避免每秒重复定位。
  errorRetryMs: 5000,
  initialCaptureDelayMs: 3000,
  restartDistanceMeters: 1.5,
  timeoutMs: 20000,
  maxImageEdge: 640,
  pixelConverter: "auto", // 优先 WebGL；不支持/自检失败自动回退 CPU。设为 cpu 可做真机对照。
  // getARRawData 的设备差异需真机验证；紧密排列 YUV420，默认 NV12 / full range。
  uvOrder: "uv", // 若颜色异常且确认原始格式为 NV21，改为 vu
  rotation: 90, // 当前竖屏真机原始帧逆时针偏转 90°，上传前顺时针纠正；其他设备需预览核对。
};

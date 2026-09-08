module.exports = {
  debugLogs: true, // 控制台筛选 [AnchorMatch]；设为 false 关闭匹配日志。
  // Web 管理端 HTTPS origin，例如 https://ar.example.com（不是 EAS 或 Supabase 地址）。
  apiBaseUrl: "https://www.spatialmemory.online",
  intervalMs: 5000,
  timeoutMs: 20000,
  confirmationCount: 2,
  maxImageEdge: 640,
  // getARRawData 的设备差异需真机验证；紧密排列 YUV420，默认 NV12 / full range。
  uvOrder: "uv", // 若颜色异常且确认原始格式为 NV21，改为 vu
  rotation: 0, // 根据真机原始帧方向设置顺时针 0 / 90 / 180 / 270
};

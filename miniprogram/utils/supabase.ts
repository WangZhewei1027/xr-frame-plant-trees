const SUPABASE_URL = "https://mkdfezaufjhrfjkfqlbj.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZGZlemF1ZmpocmZqa2ZxbGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDI2NzksImV4cCI6MjA4MDc3ODY3OX0.YvoVQP5k61rl1dbm-y7O-MQCsfke3rnSIzhWvbVGQdU";

/** 兜底默认值 */
const DEFAULT_CONFIG = {
  organizationId: "41d8feec-b541-46ba-bfb0-30cb63f71170", // 东明
  workspaceId: "388bc7ed-068e-4e20-8e66-53aa1e952b98", // 东明/test
};

const SCAN_CONFIG_STORAGE_KEY = "config:scan:v1";

/** 读取持久化的上次扫码参数 */
function loadPersistedScanConfig(): {
  organizationId?: string;
  workspaceId?: string;
} {
  try {
    const saved = wx.getStorageSync(SCAN_CONFIG_STORAGE_KEY);
    if (saved && typeof saved === "object" && saved.organizationId) {
      // 必须显式包含 workspaceId 键（即便值为 undefined），
      // 否则 spread 合并时 DEFAULT_CONFIG.workspaceId 会静默渗入。
      // 背景：undefined 值会被 JSON 序列化丢弃，Storage 里不存在该 key，
      // 导致 { ...DEFAULT_CONFIG, ...savedObject } 无法覆盖 workspaceId。
      return {
        organizationId: saved.organizationId as string,
        workspaceId: (saved.workspaceId as string) || undefined,
      };
    }
    return {};
  } catch (e) {
    console.error("[storage] config read failed", e);
    return {};
  }
}

/** 持久化扫码参数 */
function persistScanConfig(config: {
  organizationId?: string;
  workspaceId?: string;
}) {
  try {
    wx.setStorageSync(SCAN_CONFIG_STORAGE_KEY, config);
  } catch (e) {
    console.error("[storage] config write failed", e);
  }
}

// 优先级：扫码参数 > storage 上次扫码参数 > 兜底默认值
// 此处初始化时先合并 storage（模块加载时生效，onLoad 中若有扫码参数会进一步覆盖）
export const CONFIG: { organizationId?: string; workspaceId?: string } = {
  ...DEFAULT_CONFIG,
  ...loadPersistedScanConfig(),
};

/** 从页面 query 参数更新 CONFIG；若有扫码参数则持久化到 Storage */
export function setConfig(params: {
  organizationId?: string;
  workspaceId?: string;
}) {
  const hasScanParams = !!(params.organizationId || params.workspaceId);
  if (params.organizationId) {
    CONFIG.organizationId = params.organizationId;
    // 新 orgId 未携带 workspaceId 时，清除旧 workspaceId，避免跨组织错配
    if (!params.workspaceId) CONFIG.workspaceId = undefined;
  }
  if (params.workspaceId) CONFIG.workspaceId = params.workspaceId;
  if (hasScanParams) {
    persistScanConfig({
      organizationId: CONFIG.organizationId,
      workspaceId: CONFIG.workspaceId,
    });
  }
}

/** Supabase REST GET 查询，支持 query string 过滤 */
export function supabaseGet<T = any>(
  table: string,
  query?: string,
): Promise<{ statusCode: number; data: T }> {
  const qs = query ? `?${query}` : "";
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${SUPABASE_URL}/rest/v1/${table}${qs}`,
      method: "GET",
      header: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      success: (res) => resolve(res as { statusCode: number; data: T }),
      fail: reject,
    });
  });
}

/** wx.request 的 Promise 封装，自动注入 Supabase 认证头 */
export function supabaseRpc<T = any>(
  fnName: string,
  data: Record<string, any>,
): Promise<{ statusCode: number; data: T }> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${SUPABASE_URL}/rest/v1/rpc/${fnName}`,
      method: "POST",
      header: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      data,
      success: (res) => resolve(res as { statusCode: number; data: T }),
      fail: reject,
    });
  });
}

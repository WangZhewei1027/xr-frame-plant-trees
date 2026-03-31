const SUPABASE_URL = "https://mkdfezaufjhrfjkfqlbj.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZGZlemF1ZmpocmZqa2ZxbGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDI2NzksImV4cCI6MjA4MDc3ODY3OX0.YvoVQP5k61rl1dbm-y7O-MQCsfke3rnSIzhWvbVGQdU";

/** 兜底默认值 */
const DEFAULT_CONFIG = {
  organizationId: "41d8feec-b541-46ba-bfb0-30cb63f71170", // 东明
  workspaceId: "388bc7ed-068e-4e20-8e66-53aa1e952b98", // 东明/test
};

export const CONFIG: { organizationId?: string; workspaceId?: string } = {
  ...DEFAULT_CONFIG,
};

/** 从页面 query 参数更新 CONFIG */
export function setConfig(params: {
  organizationId?: string;
  workspaceId?: string;
}) {
  if (params.organizationId) CONFIG.organizationId = params.organizationId;
  if (params.workspaceId) CONFIG.workspaceId = params.workspaceId;
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

const SUPABASE_URL = "https://mkdfezaufjhrfjkfqlbj.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZGZlemF1ZmpocmZqa2ZxbGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDI2NzksImV4cCI6MjA4MDc3ODY3OX0.YvoVQP5k61rl1dbm-y7O-MQCsfke3rnSIzhWvbVGQdU";

export const CONFIG = {
  workspaceId: "388bc7ed-068e-4e20-8e66-53aa1e952b98", // 东明/test
  organizationId: "41d8feec-b541-46ba-bfb0-30cb63f71170", // 东明
};

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

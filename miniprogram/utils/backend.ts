// 后端访问层：小程序只和 Web 平台的公开接口 /api/miniapp/* 通信
// （服务端文档：sanlinlaojie/docs/miniapp-api.md），不再直连数据库。
// 接口的参数名与返回结构和原先的 Supabase RPC / 表查询完全一致，
// 调用方只需换函数名，渲染逻辑不变。
//
// 临时地址（2026-10-08）：域名 spatialmemory.online 还在等 ICP 备案，阿里云会拦截
// 未备案域名，所以暂时直连服务器 IP（Let's Encrypt 签发的 IP 证书，HTTPS 有效）。
// 注意：微信不允许把 IP 配成「服务器域名」，所以只能在以下场景使用：
//   - 开发者工具勾选「不校验合法域名」（project.private.config.json: urlCheck=false）
//   - 真机预览 / 开发版 / 体验版，并在小程序右上角菜单里「打开调试」
// 备案通过后改回 "https://spatialmemory.online" 再发正式版。
const API_BASE_URL = "https://139.196.189.102";
const API_PREFIX = "/api/miniapp";

/** 兜底默认值 */
const DEFAULT_CONFIG = {
  organizationId: "41d8feec-b541-46ba-bfb0-30cb63f71170", // 东明
  workspaceId: "388bc7ed-068e-4e20-8e66-53aa1e952b98", // 东明/test
};

const SCAN_CONFIG_STORAGE_KEY = "config:scan:v1";
const SCAN_HISTORY_STORAGE_KEY = "config:scan:history:v1";
/** 历史记录最多保留条数，超出则淘汰最旧 */
const SCAN_HISTORY_MAX = 20;

/** 一条历史扫码记录 */
export interface ScanHistoryEntry {
  organizationId: string;
  workspaceId?: string;
  /** 展示用名称，由 index 拉取后回填 */
  orgName?: string;
  workspaceName?: string;
  /** 最近使用时间戳，用于排序 */
  ts: number;
}

/** 同一 org+workspace 视为同一条记录 */
function historyKey(organizationId?: string, workspaceId?: string): string {
  return `${organizationId || ""}|${workspaceId || ""}`;
}

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

/** 读取历史扫码记录，按最近使用时间倒序 */
export function loadScanHistory(): ScanHistoryEntry[] {
  try {
    const saved = wx.getStorageSync(SCAN_HISTORY_STORAGE_KEY);
    if (Array.isArray(saved)) {
      return saved
        .filter((e) => e && typeof e === "object" && e.organizationId)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    return [];
  } catch (e) {
    console.error("[storage] history read failed", e);
    return [];
  }
}

/**
 * 覆写整份历史记录。
 * 用于批量回填/刷新名称等场景（保留各条目原有 ts 与顺序）。
 */
export function saveScanHistory(list: ScanHistoryEntry[]): void {
  try {
    wx.setStorageSync(
      SCAN_HISTORY_STORAGE_KEY,
      list.slice(0, SCAN_HISTORY_MAX),
    );
  } catch (e) {
    console.error("[storage] history save failed", e);
  }
}

/**
 * 写入/更新一条历史记录。
 * 同一 org+workspace 去重（更新名称与时间戳并置顶），超出上限淘汰最旧。
 */
export function recordScanHistory(entry: {
  organizationId?: string;
  workspaceId?: string;
  orgName?: string;
  workspaceName?: string;
}): void {
  if (!entry.organizationId) return;
  try {
    const list = loadScanHistory();
    const key = historyKey(entry.organizationId, entry.workspaceId);
    const filtered = list.filter(
      (e) => historyKey(e.organizationId, e.workspaceId) !== key,
    );
    const prev = list.find(
      (e) => historyKey(e.organizationId, e.workspaceId) === key,
    );
    filtered.unshift({
      organizationId: entry.organizationId,
      workspaceId: entry.workspaceId || undefined,
      // 名称缺省时沿用旧记录，避免覆盖已有展示名
      orgName: entry.orgName ?? prev?.orgName,
      workspaceName: entry.workspaceName ?? prev?.workspaceName,
      ts: Date.now(),
    });
    wx.setStorageSync(
      SCAN_HISTORY_STORAGE_KEY,
      filtered.slice(0, SCAN_HISTORY_MAX),
    );
  } catch (e) {
    console.error("[storage] history write failed", e);
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

/** 识别接口地址（matching/index.js 用 wx.uploadFile 直接上传） */
export const RECOGNIZE_API = {
  baseUrl: API_BASE_URL,
  path: `${API_PREFIX}/anchors/recognize`,
};

type ApiResponse<T> = { statusCode: number; data: T };

/** wx.request 的 Promise 封装（公开接口，无需鉴权头） */
function request<T>(
  path: string,
  method: "GET" | "POST",
  data?: Record<string, any>,
): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE_URL}${API_PREFIX}${path}`,
      method,
      header: { "Content-Type": "application/json" },
      data,
      success: (res) => resolve(res as ApiResponse<T>),
      fail: reject,
    });
  });
}

export interface OrganizationSummary {
  id: string;
  name: string;
  /** 只包含小程序会用到的键：confetti_enabled / shop_checkin_enabled / footer_enabled / text_asset_miniapp_style */
  config: Record<string, unknown>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

/** 按 id 批量取组织名称与小程序相关配置（最多 50 个） */
export function fetchOrganizations(
  ids: string[],
): Promise<ApiResponse<OrganizationSummary[]>> {
  return request(`/organizations?ids=${encodeURIComponent(ids.join(","))}`, "GET");
}

/** 按 id 批量取工作空间名称（最多 50 个） */
export function fetchWorkspaces(
  ids: string[],
): Promise<ApiResponse<WorkspaceSummary[]>> {
  return request(`/workspaces?ids=${encodeURIComponent(ids.join(","))}`, "GET");
}

/** 原 Supabase RPC 名 → 新接口路径；请求体与返回值和原 RPC 完全一致 */
const RPC_PATHS = {
  get_nearby_assets: "/assets/nearby",
  get_huge_assets: "/assets/huge",
  get_shop_assets: "/shops",
  upload_text_asset: "/text-assets",
} as const;

export type RpcName = keyof typeof RPC_PATHS;

/** 调用原先通过 RPC 暴露的数据库函数（参数名不变） */
export function backendRpc<T = any>(
  fnName: RpcName,
  data: Record<string, any>,
): Promise<ApiResponse<T>> {
  return request<T>(RPC_PATHS[fnName], "POST", data);
}

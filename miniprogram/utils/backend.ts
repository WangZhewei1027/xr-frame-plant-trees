// 后端访问层：小程序只和 Web 平台的公开接口 /api/miniapp/* 通信
// （服务端文档：sanlinlaojie/docs/miniapp-api.md），不再直连数据库。
// 素材发现与活动参与使用独立接口；只有最终的 AR 渲染复用现有展示器。
import { resolveBackendBaseUrl } from "./backend-environment";
import type { ActivityLocation, ActivitySubmission } from "./activity-state";

// 开发版连接本地 Web；体验版／正式版保留线上后端。识别上传也使用此地址。
// 地址配置与真机开发说明见 backend-environment.ts 和 docs/local-development.md。
const API_BASE_URL = resolveBackendBaseUrl(
  wx.getAccountInfoSync().miniProgram.envVersion,
  wx.getDeviceInfo?.().platform,
);
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

export interface ScanConfig {
  organizationId?: string;
  workspaceId?: string;
  sceneId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isSceneConfig(config: ScanConfig): config is ScanConfig & { organizationId: string; sceneId: string } {
  return UUID.test(config.sceneId || "") && UUID.test(config.organizationId || "");
}

/** 一条历史扫码记录 */
export interface ScanHistoryEntry extends ScanConfig {
  organizationId: string;
  /** 展示用名称，由 index 拉取后回填 */
  orgName?: string;
  workspaceName?: string;
  sceneName?: string;
  /** 最近使用时间戳，用于排序 */
  ts: number;
}

/** 场景与地图合集分别去重，即便它们的 UUID 相同。 */
export function scanHistoryKey(config: ScanConfig): string {
  return `${config.organizationId || ""}|${config.sceneId ? `scene:${config.sceneId}` : `map:${config.workspaceId || ""}`}`;
}

/** 读取持久化的上次扫码参数 */
function loadPersistedScanConfig(): ScanConfig {
  try {
    const saved = wx.getStorageSync(SCAN_CONFIG_STORAGE_KEY);
    if (saved && typeof saved === "object" && typeof saved.organizationId === "string" && saved.organizationId) {
      if (saved.sceneId && !isSceneConfig(saved)) return {};
      // 必须显式包含 workspaceId 键（即便值为 undefined），
      // 否则 spread 合并时 DEFAULT_CONFIG.workspaceId 会静默渗入。
      // 背景：undefined 值会被 JSON 序列化丢弃，Storage 里不存在该 key，
      // 导致 { ...DEFAULT_CONFIG, ...savedObject } 无法覆盖 workspaceId。
      return {
        organizationId: saved.organizationId as string,
        workspaceId: saved.sceneId ? undefined : (saved.workspaceId as string) || undefined,
        sceneId: saved.sceneId || undefined,
      };
    }
    return {};
  } catch (e) {
    console.error("[storage] config read failed", e);
    return {};
  }
}

/** 持久化扫码参数 */
function persistScanConfig(config: ScanConfig) {
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
        .filter((e) => e && typeof e === "object" && typeof e.organizationId === "string" && e.organizationId && (!e.sceneId || isSceneConfig(e)))
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
 * 同一团队和目标去重（更新名称与时间戳并置顶），超出上限淘汰最旧。
 */
export function recordScanHistory(entry: {
  organizationId?: string;
  workspaceId?: string;
  sceneId?: string;
  orgName?: string;
  workspaceName?: string;
  sceneName?: string;
}): void {
  if (!entry.organizationId) return;
  if (entry.sceneId && !isSceneConfig(entry)) return;
  try {
    const list = loadScanHistory();
    const key = scanHistoryKey(entry);
    const filtered = list.filter(
      (e) => scanHistoryKey(e) !== key,
    );
    const prev = list.find(
      (e) => scanHistoryKey(e) === key,
    );
    filtered.unshift({
      organizationId: entry.organizationId,
      workspaceId: entry.sceneId ? undefined : entry.workspaceId || undefined,
      sceneId: entry.sceneId || undefined,
      // 名称缺省时沿用旧记录，避免覆盖已有展示名
      orgName: entry.orgName ?? prev?.orgName,
      workspaceName: entry.workspaceName ?? prev?.workspaceName,
      sceneName: entry.sceneName ?? prev?.sceneName,
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
export const CONFIG: ScanConfig = {
  ...DEFAULT_CONFIG,
  ...loadPersistedScanConfig(),
};

/** 从页面 query 参数更新 CONFIG；若有扫码参数则持久化到 Storage */
export function setConfig(params: ScanConfig) {
  const hasScanParams = !!(params.organizationId || params.workspaceId || params.sceneId);
  if (!hasScanParams) return;
  // Scene 必须携带自己的团队，不能从上一个地图入口借用团队 ID。
  if (params.sceneId) {
    if (!isSceneConfig(params)) return;
    CONFIG.organizationId = params.organizationId;
    CONFIG.sceneId = params.sceneId;
    CONFIG.workspaceId = undefined;
  } else {
    CONFIG.sceneId = undefined;
    if (params.organizationId) {
      CONFIG.organizationId = params.organizationId;
      // 新 orgId 未携带 workspaceId 时，清除旧 workspaceId，避免跨组织错配
      if (!params.workspaceId) CONFIG.workspaceId = undefined;
    }
    if (params.workspaceId) CONFIG.workspaceId = params.workspaceId;
  }
  persistScanConfig({ ...CONFIG });
  // 在网络请求和页面跳转前落盘，真机调试无启动参数时也可恢复。
  recordScanHistory({ ...CONFIG });
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
  /** 只包含小程序会用到的展示配置；活动入口来自活动投放。 */
  config: Record<string, unknown>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface SceneSummary {
  id: string;
  name: string;
}

/** 按团队刷新已扫码 Scene 的名称，不加载模型或场景内容。 */
export function fetchScenes(ids: string[], organizationId: string): Promise<ApiResponse<SceneSummary[]>> {
  return request(`/scenes?ids=${encodeURIComponent(ids.join(","))}&organization_id=${encodeURIComponent(organizationId)}`, "GET");
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

/** Public playback endpoints: response ids identify placements, not source assets. */
const RPC_PATHS = {
  get_nearby_assets: "/assets/nearby",
  get_scene_asset: "/assets/scene",
  get_huge_assets: "/assets/huge",
} as const;

export type RpcName = keyof typeof RPC_PATHS;

/** Request public map content. Team and collection scopes are checked by the backend. */
export function backendRpc<T = any>(
  fnName: RpcName,
  data: Record<string, any>,
): Promise<ApiResponse<T>> {
  return request<T>(RPC_PATHS[fnName], "POST", data);
}

/** Direct saved-scene preview. It never changes the selected map collection. */
export function fetchScenePreview(sceneId: string, organizationId: string): Promise<ApiResponse<any>> {
  return request("/scenes/preview", "POST", { scene_id: sceneId, organization_id: organizationId });
}

/** Activities belong to the selected map deployment, independent of the asset catalog. */
export function fetchActivities(workspaceId: string | undefined, organizationId: string): Promise<ApiResponse<unknown>> {
  const workspace = workspaceId ? `workspace_id=${encodeURIComponent(workspaceId)}&` : "";
  return request(`/activities?${workspace}organization_id=${encodeURIComponent(organizationId)}`, "GET");
}

export function fetchActivityProgress(placementId: string, participantId: string): Promise<ApiResponse<{ point_ids?: unknown; error?: string }>> {
  return request(`/activity-progress?placement_id=${encodeURIComponent(placementId)}&participant_id=${encodeURIComponent(participantId)}`, "GET");
}

export function fetchActivityRecords(placementId: string, location: ActivityLocation, radiusMeters: number): Promise<ApiResponse<unknown>> {
  return request(`/activity-records?placement_id=${encodeURIComponent(placementId)}&user_lat=${location.latitude}&user_lng=${location.longitude}&max_distance_meters=${radiusMeters}`, "GET");
}

export function submitActivityRecord(input: ActivitySubmission): Promise<ApiResponse<{ id?: string; error?: string }>> {
  return request("/activity-records", "POST", input);
}

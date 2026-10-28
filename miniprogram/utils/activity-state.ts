/** Public activity contracts and local presentation rules. Participant IDs identify a device, not an account. */
export interface ActivityLocation {
  latitude: number;
  longitude: number;
}

export interface ActivityPoint {
  /** Fixed point identity owned by the activity; the same point is shared across maps. */
  id: string;
  point_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  reward_url: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ActivityPlacement {
  id: string;
  activity_id: string;
  workspace_id: string;
  workspace_name: string;
  type: "shop_checkin" | "danmaku";
  name: string;
  /** Includes the map name when browsing all maps in a team. */
  display_name: string;
  config: { checkinRadiusMeters?: number; maxLength?: number };
  location: ActivityLocation | null;
  radius_meters: number | null;
  points: ActivityPoint[];
}

export interface ActivitySubmission {
  placement_id: string;
  kind: "danmaku" | "checkin";
  point_id?: string;
  content?: string;
  user_lat: number;
  user_lng: number;
  participant_id: string;
  idempotency_key: string;
}

const PARTICIPANT_KEY = "activity:participant:v1";
let sessionParticipant = "";
let discoverySequence = 0;
let appliedDiscoverySequence = 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shared by page discovery and the XR refresh, so their responses can be ordered. */
export function nextActivityDiscoverySequence(): number {
  return ++discoverySequence;
}

export function isCurrentActivityDiscovery(sequence: number): boolean {
  return Number.isInteger(sequence) && sequence > 0 && sequence >= appliedDiscoverySequence;
}

/** A newer discovery response invalidates both older menus and their pending record streams. */
export function acceptActivityDiscovery(sequence: number): boolean {
  if (!isCurrentActivityDiscovery(sequence)) return false;
  appliedDiscoverySequence = sequence;
  return true;
}

export function activityRequestKey(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (letter) => {
    const digit = Math.floor(Math.random() * 16);
    return (letter === "x" ? digit : (digit & 3) | 8).toString(16);
  });
}

/** Stable across app launches when device storage is available. Never used as authentication. */
export function activityParticipantId(): string {
  if (sessionParticipant) return sessionParticipant;
  try {
    const saved: unknown = wx.getStorageSync(PARTICIPANT_KEY);
    if (typeof saved === "string" && UUID.test(saved)) sessionParticipant = saved;
  } catch (_) {}
  if (!sessionParticipant) {
    sessionParticipant = activityRequestKey();
    try { wx.setStorageSync(PARTICIPANT_KEY, sessionParticipant); } catch (_) {}
  }
  return sessionParticipant;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function validActivityLocation(value: unknown): value is ActivityLocation {
  const location = object(value);
  return !!location && typeof location.latitude === "number" && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90 &&
    typeof location.longitude === "number" && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
}

/** Reject malformed responses instead of accidentally turning a scoped activity into a map-wide one. */
export function parseActivityPlacements(value: unknown, showWorkspace = false): ActivityPlacement[] {
  if (!Array.isArray(value)) throw new Error("活动列表格式错误");
  return value.map((entry) => {
    const item = object(entry);
    if (!item || typeof item.id !== "string" || !UUID.test(item.id) || typeof item.activity_id !== "string" || !UUID.test(item.activity_id) ||
      typeof item.workspace_id !== "string" || !UUID.test(item.workspace_id) || typeof item.workspace_name !== "string" ||
      !["shop_checkin", "danmaku"].includes(String(item.type)) || typeof item.name !== "string" || !Array.isArray(item.points)) throw new Error("活动格式错误");
    const config = object(item.config);
    if (!config || (item.location !== null && !validActivityLocation(item.location)) ||
      (item.radius_meters !== null && (typeof item.radius_meters !== "number" || !Number.isFinite(item.radius_meters) || item.radius_meters <= 0)) ||
      (item.radius_meters !== null && item.location === null)) throw new Error("活动范围格式错误");
    for (const key of ["checkinRadiusMeters", "maxLength"]) {
      const setting = config[key];
      if (setting !== undefined && (typeof setting !== "number" || !Number.isFinite(setting) || setting <= 0)) throw new Error("活动配置格式错误");
    }
    const points = item.points.map((entry: unknown): ActivityPoint => {
      const point = object(entry);
      if (!point || typeof point.id !== "string" || !UUID.test(point.id) || typeof point.point_id !== "string" || !UUID.test(point.point_id) ||
        typeof point.name !== "string" || !((point.latitude === null && point.longitude === null) || validActivityLocation(point))) throw new Error("打卡点格式错误");
      const text = (key: string) => typeof point[key] === "string" ? point[key] as string : null;
      return { id: point.id, point_id: point.point_id, name: point.name, description: text("description"), image_url: text("image_url"), reward_url: text("reward_url"), latitude: point.latitude as number | null, longitude: point.longitude as number | null };
    });
    return { id: item.id, activity_id: item.activity_id, workspace_id: item.workspace_id, workspace_name: item.workspace_name,
      type: item.type as ActivityPlacement["type"], name: item.name, display_name: showWorkspace ? `${item.name} · ${item.workspace_name}` : item.name, config,
      location: item.location as ActivityLocation | null, radius_meters: item.radius_meters as number | null, points };
  });
}

export function activityDistance(a: unknown, b: unknown): number | null {
  if (!validActivityLocation(a) || !validActivityLocation(b)) return null;
  const rad = Math.PI / 180;
  const sinLat = Math.sin((b.latitude - a.latitude) * rad / 2);
  const sinLng = Math.sin((b.longitude - a.longitude) * rad / 2);
  const term = sinLat * sinLat + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * sinLng * sinLng;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, term)));
}

export function withinActivityScope(activity: ActivityPlacement | null, location: unknown): boolean {
  if (!activity || !validActivityLocation(location)) return false;
  if (activity.radius_meters === null) return true;
  const distance = activityDistance(location, activity.location);
  return distance !== null && distance <= activity.radius_meters;
}

export function danmakuMaxLength(activity: ActivityPlacement | null): number {
  return Math.min(500, Math.max(1, Math.floor(activity?.config.maxLength || 200)));
}

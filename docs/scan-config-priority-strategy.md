# 扫码参数优先级与持久化策略

## 背景

小程序支持通过扫描二维码携带参数（`organizationId`、`workspaceId`）直接跳转进入。  
但用户并非每次都从扫码入口进入，也可能直接从最近使用列表、桌面快捷方式等途径打开。  
因此需要一套优先级策略，保证参数来源的正确性与连续性。

## 优先级（高 → 低）

```
扫码参数（当次 onLoad query）
    ↓ 无扫码参数
Storage 上次扫码参数（key: config:scan:v1）
    ↓ Storage 也无记录
兜底默认值（DEFAULT_CONFIG 硬编码）
```

## 实现位置

`miniprogram/utils/supabase.ts`

### 模块初始化时（加载即生效）

```ts
export const CONFIG = {
  ...DEFAULT_CONFIG,
  ...loadPersistedScanConfig(), // Storage 覆盖默认值
};
```

### onLoad 时（扫码参数覆盖 Storage）

**只有 `index.ts`** 在 `onLoad` 中调用 `setConfig`：

```ts
setConfig({
  organizationId: options.organizationId,
  workspaceId: options.workspaceId,
});
```

> `ar.ts` 不调用 `setConfig`。ar 页始终由 `index.ts` 的 `goToAR()` 跳转进入，
> CONFIG 在此之前已由 index 正确设置。若 ar.ts 也持久化 URL 参数，
> 微信「最近使用」场景下携带的**过期 URL 参数**会覆盖 Storage 中更新的扫码结果。

`setConfig` 内部逻辑：
1. 若 `options` 中存在任意参数，视为本次由扫码进入。
2. 将扫码参数写入 CONFIG（内存态立即生效）。
3. 将完整 CONFIG 持久化到 Storage，供下次无扫码参数时使用。

```ts
function setConfig(params) {
  const hasScanParams = !!(params.organizationId || params.workspaceId);
  if (params.organizationId) {
    CONFIG.organizationId = params.organizationId;
    // 新 orgId 未携带 workspaceId 时，清除旧 workspaceId，避免跨组织错配
    if (!params.workspaceId) CONFIG.workspaceId = undefined;
  }
  if (params.workspaceId) CONFIG.workspaceId = params.workspaceId;
  if (hasScanParams) {
    persistScanConfig({ organizationId: CONFIG.organizationId, workspaceId: CONFIG.workspaceId });
  }
}
```

## Storage Key

| Key | 格式 | 用途 |
|-----|------|------|
| `config:scan:v1` | `{ organizationId?: string, workspaceId?: string }` | 持久化上次扫码参数 |

命名遵循 `<module>:<name>:v<version>` 规范，无多租户维度（config 本身即租户标识）。

## 容错

- `getStorageSync` / `setStorageSync` 均包裹 `try/catch`。
- 读取失败：返回空对象，CONFIG 回退到默认值。
- 写入失败：`console.error` 记录，不阻塞主流程。
- Storage 内容读出后做类型校验（`typeof saved === "object"`），非法值回退为空对象。

### ⚠️ `undefined` 序列化陷阱

`workspaceId: undefined` 会被 `JSON.stringify` **静默丢弃**，导致 Storage 里只存 `{ organizationId }`（无 `workspaceId` key）。
下次冷启动 spread 合并时，`DEFAULT_CONFIG.workspaceId` 会渗入：

```
{ ...DEFAULT_CONFIG, ...{ organizationId: "ORG1" } }
  → { organizationId: "ORG1", workspaceId: DEFAULT_WS }  ← 错误！
```

**修复**：`loadPersistedScanConfig` 在 Storage 有 `organizationId` 时，显式返回 `workspaceId` 键（即便值为 `undefined`），
让 spread 能正确覆盖 DEFAULT：

```ts
function loadPersistedScanConfig() {
  const saved = wx.getStorageSync(SCAN_CONFIG_STORAGE_KEY);
  if (saved && typeof saved === "object" && saved.organizationId) {
    return {
      organizationId: saved.organizationId as string,
      workspaceId: (saved.workspaceId as string) || undefined, // 显式包含 key
    };
  }
  return {};
}
```

## 数据流图

```
用户打开小程序
      │
      ▼
模块初始化（supabase.ts import）
      │
      └─ CONFIG = { ...DEFAULT_CONFIG, ...loadPersistedScanConfig() }
             loadPersistedScanConfig 显式返回 workspaceId 键，
             防止 DEFAULT 值渗入（undefined 序列化陷阱）
      │
      ▼
index.ts onLoad(options)
      │
      ├─ options 有扫码参数？
      │        │ Yes
      │        ▼
      │   setConfig(options)
      │        │
      │        ├─ 更新内存 CONFIG（立即生效）
      │        └─ 写入 Storage config:scan:v1
      │
      │        │ No
      │        ▼
      │   CONFIG 保持模块初始化时的值（Storage 或 DEFAULT）
      │
      ▼
goToAR() → 将当前 CONFIG 作为 URL query 传给 ar.ts
      │
      ▼
ar.ts onLoad
      │
      └─ 不调用 setConfig（避免过期 URL 参数覆盖 Storage）
         直接读取 CONFIG 使用
      │
      ▼
业务逻辑使用 CONFIG.organizationId / CONFIG.workspaceId
```

## 注意事项

- `CONFIG` 是模块级单例，整个小程序生命周期共享。
- 不同组织/工作区的用户共用同一设备时，扫新码会覆盖 Storage 中的旧参数（符合预期）。
- `DEFAULT_CONFIG` 仅作为最终兜底，生产环境不应长期依赖。
- **只有 `index.ts` 调用 `setConfig` 并持久化**；其他页面（`ar.ts`、`upload.ts`）只读取 `CONFIG`，不修改也不持久化。
- `workspaceId: undefined` 写入 Storage 时会被 JSON 序列化丢弃，`loadPersistedScanConfig` 须显式返回该键以防 DEFAULT 渗入（见「容错」章节）。

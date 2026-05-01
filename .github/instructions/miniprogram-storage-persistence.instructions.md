---
applyTo: "miniprogram/**/*.{js,ts}"
---

# 微信小程序本地持久化（Storage）实践约束

适用于需要跨页面、跨会话保留状态的数据（如：打卡状态、最近使用记录、轻量配置）。

## 1) 何时用 Storage

- 用于小体积、可序列化、非敏感数据。
- 不要放大文件、二进制、长列表历史（避免读写阻塞和配额压力）。
- 服务端真实状态优先，Storage 用于本地体验增强与离线兜底。

## 2) Key 设计

- 使用稳定且可读的 key，避免临时命名。
- 多租户/多空间数据必须带作用域：`tenantId`、`contextId`（或等价业务维度）。
- 推荐格式：`<module>:<tenantId>:<contextId>:<name>:v<version>`。

示例：

```js
const key = `checkState:${tenantId}:${contextId}:map:v1`;
```

## 3) 读写时机

- 页面/组件初始化时读取一次（`onLoad`/`attached`）。
- 用户动作成功后立即写入（例如“首次打卡成功”后写入）。
- 不要在高频回调中频繁写（如 `onLocationChange`、`onCompassChange`、每帧 tick）。

## 4) 数据结构

- 优先使用对象字典而非数组做状态集合，降低查找和更新成本。
- 示例：`{ [shopId]: true }` 用于“是否已打卡”。
- 读取后必须做类型校验，不合法时回退到默认值。

示例：

```js
const saved = wx.getStorageSync(key);
const checkedMap = saved && typeof saved === "object" ? saved : {};
```

## 5) 容错与降级

- `getStorageSync/setStorageSync` 外层加 `try/catch`。
- 读失败：使用默认值继续业务流程。
- 写失败：记录 `console.error`，不要阻塞主流程。

## 6) 同步约定（关键）

- 先更新内存态（`setData`），再写 Storage，保证 UI 立即响应。
- 持久化字段和 UI 计算字段分离：
  - 持久化：原始状态（如 `checkedInShopIds`）
  - 计算态：派生值（如 `checkedInCount`）

## 7) 清理策略

- 业务列表变化后，定期清理无效 ID（已下线店铺）。
- 版本升级时做迁移：
  - 新 key 启用后，旧 key 读取一次迁移并删除。
- 用户切换组织/空间时，按作用域 key 隔离，不共享状态。

## 8) 通用状态持久化模式

- 布尔状态集合推荐结构：`{ [entityId]: true }`。
- 按业务作用域隔离 key（如租户、场景、环境），避免跨上下文串数据。
- UI 可基于持久化态提供“已完成/已处理”反馈；首次完成时写入 Storage。

推荐实现片段：

```js
const stateKey = `checkState:${tenantId}:${contextId}:map:v1`;

function loadStateMap() {
  try {
    const saved = wx.getStorageSync(stateKey);
    return saved && typeof saved === "object" ? saved : {};
  } catch (e) {
    console.error("[storage] read failed", e);
    return {};
  }
}

function persistStateMap(nextMap) {
  try {
    wx.setStorageSync(stateKey, nextMap);
  } catch (e) {
    console.error("[storage] write failed", e);
  }
}
```

## 9) 禁止项

- 禁止把敏感信息（token、手机号明文、隐私数据）写入 Storage。
- 禁止无上限累积日志或历史数组。
- 禁止在无类型校验情况下直接信任 Storage 内容。

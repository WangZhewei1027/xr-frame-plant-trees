# 附近素材拉取触发策略

## 背景

AR 组件需要在用户移动到新位置时，重新向服务器拉取附近的 AR 素材。核心问题是：**如何判断"用户真正发生了位移"**，而不是误把旋转、手抖或 VIO 追踪漂移当成移动。

## 旧策略（已废弃）：逐帧累计位移

```
// handleTick 每帧执行：
accumulatedDistance += |camPos - lastCamPos|   // 累加帧间位移
if accumulatedDistance >= 5m → fetchNearbyAssets()
```

**问题：** 每帧的帧间位移是一个"标量累加器"——它只会增大，从不抵消。原地转圈时，AR VIO
（视觉惯性里程计）为了维持追踪稳定性，会在相机坐标上产生每帧数毫米的小幅振荡。这些振荡
被逐帧累加，几十秒后就会触发误拉取。

## 新策略：固定参考点净位移向量

### 核心思路

在 x/z 平面上记录一个**固定起点**（参考点），以当前相机位置为**终点**，计算两点间的直线距离：

$$
d = \sqrt{(x - x_0)^2 + (z - z_0)^2}
$$

只有当 $d \ge 5$ 时，才认为用户真正发生了位移，触发素材拉取。触发后，把当前位置设为新的
参考点，重新开始下一轮计算。

```
// 首帧：_fetchAnchorXZ = 当前相机 x/z
// 每帧：
netDisplacement = |camPos.xz - _fetchAnchorXZ|
if netDisplacement >= 5m AND 冷却已过 → fetchNearbyAssets(); _fetchAnchorXZ = camPos.xz
```

### 为什么能过滤旋转漂移

旋转时，VIO 产生的漂移通常是**围绕参考点来回振荡**的小幅扰动（幅度约 1–3 cm），终点相对
起点的**净位移**不会持续增大。累计策略把每次振荡都加进总量，净位移策略则让这些振荡自然
相互抵消：

```
累计策略：  0.01 + 0.01 + 0.01 + ... → 越转越大
净位移策略：|当前 - 参考点| ≈ 0.02m → 转多久都不触发
```

只有用户**真正走出** 5m，终点到固定起点的直线距离才会持续增加并超过阈值。

### 双重保护：刷新冷却

触发条件除了位移判断，还叠加了一个时间冷却（`fetchCooldownMs: 5000`）：

```js
now - this._lastFetchTime >= XR_CONFIG.fetchCooldownMs
```

这能防止如下边界情况：用户快速穿越 5m 边界后，VIO 跳变导致参考点重置不及时，在同一帧内
重复触发。

## 参数说明

| 参数 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| `distanceThreshold` | `XR_CONFIG` in `index.js` | `5` | 参考点到当前位置的最小触发距离（XR 世界米） |
| `fetchCooldownMs` | `XR_CONFIG` in `index.js` | `5000` | 两次拉取之间的最小冷却时长（毫秒） |

## 相关状态字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `_fetchAnchorXZ` | `{x, z} \| null` | 固定参考点坐标；`null` 时在首帧 tick 初始化 |
| `_lastFetchTime` | `number` | 上次触发拉取的 `Date.now()` 时间戳 |

## 代码位置

- 触发逻辑：[`index.js`](../../miniprogram/components/xr-start/index.js) → `handleTick()`
- 实际拉取：[`assets.js`](../../miniprogram/components/xr-start/assets.js) → `fetchNearbyAssets()`
- GPS 首次触发：[`gps.js`](../../miniprogram/components/xr-start/gps.js) → `updateGPS()` （首次定位时的一次性触发，与此策略独立）

## 调参建议

- **拉取太频繁**：调大 `distanceThreshold`（如 8–10）或 `fetchCooldownMs`（如 10000）
- **拉取太迟钝**：调小 `distanceThreshold`（如 3）；不建议低于 2，否则漂移可能偶发误触发
- **在 AR 追踪不稳定设备上偶发误触发**：把 `distanceThreshold` 从 5 调至 8，同时将 `fetchCooldownMs` 从 5000 调至 8000

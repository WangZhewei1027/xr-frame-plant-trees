# 素材更新以及去重管理策略

## 背景与取舍

`xr-start` 组件中的 `nodeList` 同时承载远程素材（model / text / image / audio）和本地即时弹幕。单队列 + 单一驱逐策略在两类场景里都存在明显问题：

1. 城市场景（高密度）中，素材规模可能持续增长，如果没有上限管理，会带来渲染与内存压力累积。
2. 课程场景（强叙事）中，重复素材会打断叙事路径，因此必须严格去重。
3. 移动触发拉取时若整批替换，会出现“每 5m 刷新一次”的割裂感。

因此采用三队列方案，这是一种工程上的平衡：

- 用上限控制保证运行稳定性。
- 用分队列驱逐保证空间连续感。
- 用全局 diff 去重保证内容叙事一致性。

## 三队列模型

`nodeList` 是单数组容器，队列身份通过 `entry.gen` 标记：

| `gen` | 来源 | 上限 | 驱逐策略 |
|---|---|---|---|
| `'new'` | 当前拉取周期新增素材 | `maxNewNodeCount` (10) | FIFO |
| `'old'` | 上一轮及更早沉淀素材 | `maxOldNodeCount` (25) | 最远优先 |
| `'danmaku'` | 本地刚发送、尚未回流数据库的弹幕 | `maxDanmakuCount` (8) | FIFO |

说明：数据库回流的历史弹幕是 `text` 素材，走正常 `'new' -> 'old'` 流程，不进入 `danmaku` 队列。

## 更新时序（displayAssets）

每次 `fetchNearbyAssets` 返回后，处理顺序如下：

```text
displayAssets(assets)
	1) 轮次提升: nodeList 中 gen='new' -> gen='old'
	2) 全局去重: cachedIds = 所有 entry.assetId(非 null)
							 newAssets = assets.filter(a => !cachedIds.has(a.id))
	3) 放置新增: newAssets.forEach(_placeAsset)
							 _placeAsset 完成创建后调用 _registerNode(..., gen='new')
```

关键点：

- 去重是全局的，不区分 old/new/danmaku，只要 `assetId` 已存在就跳过。
- 去重发生在渲染前，避免“删旧再建新”的无意义抖动。
- 异步素材（如 model/image/audio）在实际创建完成后入队，入队即触发容量收敛。

## 容量收敛（_enforceCapacity）

`_registerNode` 追加节点后立刻执行 `_enforceCapacity(protectEntry)`，分别对三类队列独立收敛。

### new / danmaku: FIFO

```text
while queue(genTag).length > maxCount:
	victim = nodeList 中最早出现且 != protectEntry 的同 gen 节点
	destroy(victim)
```

用途：保证最新一批内容优先展示，避免刚插入的节点被本轮淘汰。

### old: 最远优先

```text
while oldQueue.length > maxOldNodeCount:
	victim = 与相机 xz 平面距离最大的 old 节点
	destroy(victim)
```

用途：优先保留用户附近内容，弱化“场景瞬时跳变”。

## 去重保证

场景无重复素材由以下约束共同保证：

1. `displayAssets` 使用 `assetId` 做 diff，重复项直接 skip。
2. `nodeList` 是全局单容器，`cachedIds` 覆盖所有队列。
3. 本地弹幕使用 `assetId = null`，不与远程素材 `assetId` 命名空间冲突。

## 场景效果

| 场景 | 旧策略表现 | 当前策略表现 |
|---|---|---|
| 用户按位移持续触发拉取 | 容易整批替换 | 新素材增量进入，旧素材渐进淘汰 |
| 高密度城市素材流 | 总量易失控或频繁抖动 | 通过三上限稳定收敛 |
| 课程叙事链路 | 重复出现同素材 | 全局 diff 去重，叙事更连贯 |
| 高频本地弹幕 | 与远程素材抢同一池 | 弹幕独立队列，不挤占远程容量 |

## 参数说明

| 参数 | 默认值 | 作用 |
|---|---|---|
| `maxNewNodeCount` | 10 | 控制“本轮新增素材”可见规模 |
| `maxOldNodeCount` | 25 | 控制“沉淀素材”规模，影响空间连续感 |
| `maxDanmakuCount` | 8 | 控制“本地即时弹幕”规模 |
| `maxDistanceMeters` | 50 | 服务端附近素材查询半径 |
| `distanceThreshold` | 5 | 触发重拉取的净位移阈值 |
| `fetchCooldownMs` | 3000 | 两次拉取的最小时间间隔 |

## 已知限制与影响

该策略有一个需要提前告知内容团队的限制：

1. 创作者在单次拉取窗口内投放的“新增叙述点”可见数量，会受到 `maxNewNodeCount` 直接约束。
2. 当同一轮新增素材数量超过 `maxNewNodeCount` 时，new 队列按 FIFO 收敛，最早进入的那部分新增点会被优先淘汰。
3. 这不等于场景总量只能显示 `maxNewNodeCount`，因为 old 与 danmaku 仍有各自上限；但“单轮新增叙述点”的稳定可见规模，确实由 `maxNewNodeCount` 决定。

对课程类叙事场景的影响是：如果希望一口气展示更多新叙述点，需要配套提高 `maxNewNodeCount`，或降低触发频率，让同一轮的新增素材有更长展示窗口。

## 调参建议

- 追求稳定帧率：优先降低 `maxOldNodeCount` 与 `maxDanmakuCount`。
- 追求沿路丰富度：提高 `maxOldNodeCount`，并保持 old 队列最远优先策略。
- 追求叙事一致性：保持严格 diff 去重，不建议放宽 `assetId` 判重规则。

## 代码位置

- 配置与容量参数：../miniprogram/components/xr-start/index.js
- 更新、去重、驱逐主逻辑：../miniprogram/components/xr-start/assets.js
- 本地弹幕入队：../miniprogram/components/xr-start/danmaku.js
- 拉取触发策略：./fetch-trigger-strategy.md

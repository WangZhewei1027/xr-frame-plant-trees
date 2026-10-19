# 扫码参数与真机调试恢复

地图合集和 Scene 共用最近入口与扫码历史。Scene 入口使用
`organizationId + sceneId`，地图合集使用 `organizationId + workspaceId`；
同一个当前入口不会同时包含 `sceneId` 和 `workspaceId`。

## 真机调试

1. 带参数打开一次首页：扫码，或将开发者工具的编译条件设为
   `pages/index/index`，启动参数设为 `organizationId=<团队 UUID>&sceneId=<场景 UUID>`。
2. 首页在跳转 Scene **之前**同步写入本地缓存和历史，无需等待网络请求成功。
3. 后续真机调试或普通启动没有 query 时，直接恢复最近的 Scene。
   Scene 页面本身无参数启动也会读取缓存。
4. Scene 使用顶部系统返回键回到选择页，点击历史可切换目标。
   最近选择会持久化，下次无参数启动使用新选择。

缓存保存在各自的微信运行环境中；开发者工具与手机不共享 Storage。
需要在用于真机调试的环境中带参数进入一次。清除小程序数据后也需要重新设置。
旧版未保存过的 Scene 参数无法从已有地图缓存推断出来。

## 优先级与职责

```text
当次首页 query > Storage 上次入口 > DEFAULT_CONFIG
```

- `utils/backend.ts` 加载时用 Storage 初始化模块级单例 `CONFIG`。
- 首页 `onLoad` 调用 `setConfig(options)`；空参数保持原选择。
- 有效 Scene 参数必须同时包含 Scene 和团队 UUID，不能借用上个入口的团队。
- 选择 Scene 会清除旧 `workspaceId`；选择地图或仅团队会清除旧 `sceneId`。
  仅提供团队时同时清除旧 `workspaceId`，防止跨团队错配。
- 有效参数先更新内存，再写当前入口与历史，最后跳转或请求名称。
- 无效 Scene query 不覆盖缓存，进入 Scene 页显示参数错误，不回退到另一场景。
- 首页恢复 Scene 使用 `navigateTo`，保留首页供系统返回；返回时不再次自动跳转。
  `pages/index/index?select=1` 可用于直接调试选择页，不清除缓存。
- 首页 `goToAR()` 根据当前目标进入 Scene 或地图 AR 页。
- AR、Scene 等子页面不持久化自己的 URL，避免旧页面参数覆盖较新的扫码选择。

## Storage 与历史

沿用现有 Storage key 和地图记录，无需清理已有数据。

| Key | 内容 |
| --- | --- |
| `config:scan:v1` | `{ organizationId, workspaceId?, sceneId? }` |
| `config:scan:history:v1` | 最近使用的入口数组，附带 `orgName?`、`workspaceName?`、`sceneName?`、`ts` |

历史按团队、目标类型、目标 ID 去重：

- Scene：`organizationId|scene:sceneId`
- 地图合集：`organizationId|map:workspaceId`

最多保留 20 条，最近使用置顶。地图和 Scene 即使 UUID 相同也不会互相覆盖。
每条记录显示独立的 `Scene` / `Map` 标签、内容名称和团队名称。
Scene 名称通过 `/api/miniapp/scenes?ids=…&organization_id=…` 按团队批量查询，
与地图名称一样缓存并刷新。没有名称缓存且请求失败时显示「场景名称暂不可用」。
未获取到名称时保留已缓存的名称。

首页会批量刷新团队、地图与 Scene 名称。请求完成时以最新历史合并名称，避免慢请求覆盖
期间新加入的 Scene。当前标题刷新也会校验目标，避免快速切换时显示旧目标名称。

## 容错

- Storage 读写失败不阻塞本次入口；写入失败时不能保证下次启动恢复。
- 非法缓存回退到默认值；非法 Scene 不进入历史。
- JSON 会丢弃 `undefined`。读取有效缓存时必须显式返回 `workspaceId: undefined`
  （Scene 或仅团队入口），覆盖默认地图 ID，防止默认地图混入缓存的入口。

## 回归验证

`npm run test:scan-config` 使用真实页面和后端模块，在独立 JS runtime 间保留
JSON 序列化的 Storage，验证 Scene 无参数冷启动、地图切换、显式 query 优先级、
历史去重、异步名称刷新和 Storage 故障。测试也包含在 `npm test` 中。

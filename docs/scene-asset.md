# Scene 播放与扫码预览

Scene、基础 Asset 属于团队，地图合集通过 Placement 引用它们。Scene 保存即生效，没有发布、版本选择或旧协议分支；地图和独立预览均读取最新保存的 `scene.document`，模型按团队 Asset ID 解析当前 URL。修改资产后，下次加载场景使用新资源。

## 地图合集

GPS、巨大模型、商户及识别点接口返回地图 Placement，返回值的 `id` 是投放 ID。小程序使用它做去重、容量管理和获取内容；不要把它当作基础 Asset ID。既有 `workspaceId` 参数表示地图合集，`organizationId` 表示团队。

地图中的 Scene 继续进入统一素材放置队列，通过 `backendRpc("get_scene_asset", { asset_id, p_workspace_id, p_organization_id })` 请求 `/api/miniapp/assets/scene`；这里 `asset_id` 是发现接口返回的 Placement ID。没有独立内容版本。归档 Scene 不破坏已存在的地图引用，但不能新增投放。

## 微信扫码独立预览

管理端 Scene 编辑器的二维码与地图合集共享微信生成和 OSS 缓存流程。入口为 `pages/index/index?organizationId=<teamId>&sceneId=<sceneId>`，首页缓存当前 Scene 与扫码历史后打开 `pages/scene/scene`，保留首页供系统返回；Scene 不请求 GPS。无参数真机调试可恢复最近的 Scene。

预览页调用 `POST /api/miniapp/scenes/preview`，请求 `{ scene_id, organization_id }`。接口校验团队归属、团队和场景的归档状态，返回不可缓存的当前场景。已归档 Scene 的独立预览不可用。未保存的本地编辑不会进入预览。

- 场景模型加载后，获得有效相机帧即启用「放置场景」按钮。只有点击才显示整场，不再等待两秒自动放置。
- 显示时取最新相机位置与水平朝向，放在前方 2 米、与相机同高处。地图触发的 Scene 保留前方 2 米、下方 1.4 米的放置方式。
- 点击时若相机帧已超过 250ms，拒绝使用过期位置，等新帧后可再次点击。隐藏页面、AR 错误、重试或卸载会取消加载并释放迟到的资源。
- 画布占满页面，不再预留底部状态栏或显示切换按钮。唯一的悬浮按钮显示加载 / 定位 / 放置 / 重试状态，放置成功后消失。错误通过临时提示展示，空场景不会占用播放容量。

## 播放器

运行时只接收 `schemaVersion: 4` 的 composition manifest；后端将 schema 6 编辑文档编译为此协议，不是资产内容版本。最多 8 个资源、24 个实例、2400 关键帧、600 秒。实例独立克隆，使用米制 `position`、Euler XYZ 弧度 `rotation` 和 `scale`，不归一化尺寸。Web 旋转字段显示度，保存与两端采样使用弧度并保留多圈值。

`lib/scene-runtime/composition.js` 使用与 Web 同源的零依赖 `@spatial-memory/scene-core` 2.1.0。schema 5 清单可带 `groups`：分组是带变换和轨道的空 `THREE.Group`，实例和子分组按 `parent` 挂到对应分组下，Core 用同一时钟采样分组与实例；schema 4 平铺清单从不构建分组。每实例可选 `tracks` 保存 9 个变换通道的数值关键帧：`{ time, value, handles: [inX, inY, outX, outY], connectedRight }`；time 为秒，`connectedRight: false` 表示保持到下一关键帧，其余使用左右相邻帧的 Bezier 出/入柄采样。没有轨道时使用静态姿态。GLB 动画继续由 Three.AnimationMixer 求值。每个播放器持有独立 Core，`dispose` 清空订阅、绑定与内容引用；宿主释放模型和帧时钟。暂停不推进时间；循环保留跨边界余量；结束冻结；轻触场景暂停/继续或重播。整场登记一个 `nodeList` 条目，容量桶最多 1 场，替换时整场回收。实例不参与普通素材斥力。任一资源或动画片段失败会释放整场，不显示残缺场景。

Core 提供 `play/pause/seek/advance/sync/sample/subscribe/observe/bind/dispose`，不依赖 DOM、全局 RAF、定时器或项目注册表。当前提交的压缩 bundle 为 2459 字节；`miniprogram/lib/scene-runtime/vendor/build-info.json` 记录版本和源码哈希。更新 npm pack 快照及构建步骤见相邻 Web 仓库 `packages/scene-core/README.md`。旧 schema 4/5 编辑文档与 Theatre 状态只在后端标准数据库迁移中转换和归档，小程序没有旧协议运行时分支。

`npm test` 覆盖实际 Three 播放器、地图队列、手动放置、重复点击、跟踪间断、后台取消、异步资源释放和错误重试。开发者工具的无相机联调见 [场景自动联调](scene-auto-debug.md)；VisionKit 相机追踪及实际放置效果需真机验证。

`npm run test:scene-memory` 检查反复装载后的对象回收与堆内存平台期；开发者工具可在联调页 query 加 `stressCycles=100` 检查实际 WebGL 资源计数。两端播放矩阵比对脚本位于相邻 Web 仓库 `scripts/test-scene-playback-parity.ts`。当前结果见 [自动验收](scene-auto-debug.md#2026-10-20-当前自动验收)。本轮未重新运行微信模拟器；旧 GPU 数字在同文档中标为历史记录。

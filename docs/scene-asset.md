# Scene 素材播放

`scene` 是普通 asset 类型，通过现有 `get_nearby_assets` 或匹配点关联素材列表进入串行放置队列。没有工作空间模式切换、场景候选页或独立发布接口。

`assets/scene.js` 调用 `backendRpc("get_scene_asset", { asset_id, p_workspace_id, p_organization_id })`，按当前素材内容加载。Web 的 `sanlinlaojie/docs/scene-asset.md` 和 `lib/scene/protocol.ts` 定义完整 JSON 与接口。

- 场景 JSON 在 asset.text_content，资源用同工作空间的模型 asset ID；服务端每次解析当前模型 URL。替换模型在下次加载生效，删除/移出工作空间则报依赖错误。
- 仅支持 composition：最多 8 个资源、24 个实例、600 秒。每实例独立克隆及动画，按米制 position/quaternion/scale 布局，不归一化尺寸。
- 兼容协议 1 和 2。协议 2 的 `tracks` 存储 Theatre.js 编排的位移、XYZ 欧拉角旋转（弧度）和缩放曲线，`transform-tracks.js` 求值归一化贝塞尔曲线及停顿关键帧，与 GLB 动画共用播放时间；小程序不引入 Theatre.js。
- 只填标题创建的空白场景是合法草稿，`instances` 为空时跳过 AR 放置，不占 scene 容量。
- `lib/scene-runtime/composition.js` 保留统一时间轴：延迟开始前保持第 0 帧；暂停不推进时间；循环保留跨边界的时间余量；结束冻结；点击暂停/继续或结束后重播。
- 场景整体在加载完成时相机前方 2 米、下方 1.4 米；相机水平朝向决定场景朝向，场景内部不参与普通素材斥力。
- 整场登记为一个 `nodeList` 条目。现有容量引擎的 scene 桶最多 1 场，替换时整场回收；普通模型/文字/音视频保留原有桶。
- 复用内容代次、页面隐藏、GPS/匹配切换与统一清场。每个 await 后检查当前代次，过期模型句柄释放，不重新挂载。
- 任一资源或 clip 出错时整场失败并释放所有已取得句柄。沿用现有素材错误事件，不启动残缺场景。
- 仅作场景资源的模型不设置独立展示位置；有 GPS 或匹配关联的模型仍按普通素材独立展示。

`npm test` 包含 `scripts/test-scene-asset.cjs`，使用实际 Three bundle + 原生 API 替身。真机图像、骨骼动画、内存和帧率仍需 iOS/Android 验证。

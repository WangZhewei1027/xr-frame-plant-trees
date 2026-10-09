# AR 素材来源切换

当前识别链路为：小程序上传 JPEG 和 GPS → Web 平台 `POST https://spatialmemory.online/api/miniapp/anchors/recognize?workspace_id=…`（阿里云上海，与数据库、SAGE 模型同地域）→ GPS 候选与参考特征查询 → 阿里云 SAGE 推理 → 返回匹配点及其关联素材。管理端继续负责匹配点、参考图及关联素材管理。请求/响应协议与原 Supabase Edge Function 一致（`X-Recognition-Request-Id` 回显、`data.request_id`、`diagnostics`），不再需要 `x-region` 头。所有数据接口见 `miniprogram/utils/backend.ts` 与 Web 仓库的 `docs/miniapp-api.md`。

> 2026-10-08 起临时改为直连 `https://139.196.189.102`（域名等待 ICP 备案）。微信不允许 IP 作为服务器域名，只能在开发者工具「不校验合法域名」或真机「打开调试」时使用；备案通过后改回域名（只需改 `utils/backend.ts` 的 `API_BASE_URL`）。

## 当前渲染与取图

正式 `pages/ar/ar` 已切为 VisionKit v2 + Three.js 单画布，组件路径仍为 `components/xr-start`，便于复用页面接口。迁移结构、素材支持与真机清单见 [VisionKit + Three 迁移](visionkit-three-migration.md)。旧 xr-frame YUV 转换与固定文字背景图已退出业务链路。

显示相机背景直接使用同一 VKFrame 的 GPU 纹理；识别取图另从该帧调用 `getCameraJpgBuffer(width, height, 80)`，最长边 640，宽度为 16 的倍数，使用当前视口比例。JPEG 不可用时回退 `getCameraBuffer` 的 RGBA 数据，通过离屏 2D Canvas 导出 JPEG。原生帧在第一个 await 前消费/复制完成，不跨帧保存。两条路径均不截取含 AR 素材的画布。

不再手写 YUV 转换或固定顺时针 90°，`rotation: 0` / `uvOrder: native` 表示没有额外修改原生导出方向，不能当作方向已真机验证。原生导出及画布写入仍可能同步阻塞，不能称为完全异步。每次只允许一张图片导出；导出完成即释放取图锁，HTTP 请求可继续并发。等待下一帧超时 3 秒，RGBA 路径 JPEG 导出超时 5 秒，迟到的导出文件会清理；每次回退使用自己的画布，避免超时回调与新一轮互相覆盖。

## 模式行为

- 默认 GPS 模式：`get_nearby_assets` / `get_huge_assets` 获取附近素材，沿相机前方扇形放置，保留分批展示、容量桶、互斥推开、动画和距离音量。
- 匹配模式：只展示成功响应中该 anchor 的关联素材。进入后等待 3 秒，每 1 秒尝试取图并上传，最多 6 个在途任务；不要求手机平稳，不做二次确认。达到并发上限或导出未完成时跳过本次调度，不积压旧帧。
- 单次命中即停止取图并取消其余客户端任务。较旧结果、迟到错误和被取消的资源加载不能覆盖已显示场景。客户端取消上传不撤回服务端已经开始的推理。
- 相对成功时 VisionKit 米制位置的三维净位移达到 1.5 米，清空场景并重新等待 3 秒。只旋转手机不重启，位移不累加里程；缺失位姿不解锁。
- 切换模式清空全部素材，包括文字、气泡、媒体、点击生成的树、巨型模型、弹幕和彩带。匹配模式禁止本地种树、直发弹幕和随机彩带。
- 页面隐藏取消识别、清场并销毁 VK 会话；返回后新建会话，旧空间坐标作废。查看识别画面只暂停检索；关闭预览重新等待 3 秒。
- 匹配点下的 `is_huge` 模型也按近景关联素材展示。SAGE 提供地点触发，不提供固定地点的 6DoF 重定位或真实遮挡。

## 接口配置

`miniprogram/utils/backend.ts` 的 `API_BASE_URL` 是当前唯一公共后端地址。匹配配置沿用它：

```js
apiBaseUrl: "", // 使用 backend.ts 的 RECOGNIZE_API.baseUrl
apiPath: "/api/miniapp/anchors/recognize",
functionRegion: "", // 当前链路无需 x-region
intervalMs: 1000,
maxInFlightRequests: 6,
initialCaptureDelayMs: 3000,
restartDistanceMeters: 1.5,
```

请求使用 `wx.uploadFile`，`workspace_id` 在 URL query；表单包括 image、latitude、longitude、accuracy、gps_timestamp（毫秒）、coordinate_system=wgs84。优先使用不超过 10 秒且精度不超过 100 米的持续定位，否则复用 5 秒内单次定位或共用定位请求。定位不合格时不上传，请求超时 20 秒。

识别接口公开访问，客户端不带模型 Token、数据库密钥、Authorization 或 apikey。`X-Recognition-Request-Id` 用于日志关联，`X-Client-Id` 为本地随机设备标识，用于后端限流。必须选择明确的 workspace。服务端负责模型连接、GPS 候选、参考特征、相似度阈值及素材关联；此渲染迁移没有改变服务端配置或匹配阈值。

正式域名需要配置 uploadFile / request 白名单，素材域名需要 downloadFile 等对应白名单；当前 IP 调试限制见文首已有部署说明。旧 Supabase Edge 区域对照属于历史方案，当前不经 Edge Function；更换渲染器不改变后端网络路径。

## 重试与错误

服务端非 200 响应优先显示其 JSON `error`，过滤控制字符并截断到 200 字；非 JSON 使用通用提示。有有效 `retry_after_ms` 时采用该值并限制在 1–60 秒，否则普通错误默认 5 秒。429 的模型繁忙类默认 1 秒，空间额度类默认 60 秒；兼容没有错误码的旧服务按 60 秒退避。已锁定、切换或暂停后，旧错误不能重启任务。

503 不等于模型冷启动。结合 `code` 检查：`database_unavailable` 的数据库查询/迁移、`model_unconfigured` 的服务端模型连接、`threshold_unconfigured` 的服务端阈值。`reference_not_ready` 则在管理端检查参考特征是否完成。具体服务端设置以 Web 仓库当前部署文档为准。

## 调试日志与耗时

控制台筛选 `AnchorMatch`，`matching/config.js` 的 `debugLogs` 控制识别日志。每轮 `[AnchorMatch][请求编号]` 关联取图、上传、匹配及素材放置；不输出照片内容、完整向量或鉴权头。

- `开始取图`：目标间隔、实际间隔和超出目标的时间。
- `匹配诊断`：候选数、可用参考数、最佳/次佳相似度、阈值、分差与各服务端阶段；未命中的分数在这里，不能把 `cosineSimilarity: null` 当作零分。
- `识别耗时汇总`：成功、未命中、失败和取消都会记录已执行阶段；未执行阶段为 null，实际零毫秒为 0。
- `素材开始放置` / `素材放置结束` / `首个素材就绪`：确认匹配到放置的排队、资源加载与构建耗时。就绪指节点已登记，**不是屏幕首帧计时**；视频第一帧还需等待原生解码。

| 字段 | 当前含义 |
| --- | --- |
| `gpsSource` | watch 持续定位、fresh 单次定位、cache 单次定位缓存、shared 共用定位请求 |
| `clientTimingsMs.captureMs` | 等待下一 VK 帧、原生图像导出、保存 JPEG 的总时间 |
| `pixelConverter` | `visionkit-jpeg` 或 `visionkit-rgba` |
| `gpuFallbackReason` | 为兼容旧日志保留字段名；现表示原生 JPEG 不可用而改用 RGBA 的原因 |
| `captureStagesMs.rawReadMs` | 原生 JPEG 调用及必要时 RGBA 读取；JPEG 路径包含原生编码和快照复制 |
| `canvasPrepareMs` / `snapshotMs` / `canvasWriteMs` | RGBA 回退的画布准备、像素复制和写入；JPEG 路径为 0 |
| `jpegExportMs` | JPEG 路径为保存原生 JPEG 文件，RGBA 路径为 Canvas 编码与文件导出；不与 rawReadMs 重复计算 |
| 旧 `gpu*` / `convert*` 阶段 | 当前已无自建 YUV 转换；保留协议字段，未用为 null 或 0 |
| `uploadRoundtripMs` | 上传、后端全部处理、响应下载及回调等待；取消时为取消前等待时间 |
| `responseParseMs` | 客户端 JSON 解析 |
| `resultHandlingMs` | 应用匹配结果，包含 sceneClearMs 与 displayDispatchMs，勿重复求和 |
| `captureToMatchMs` | 开始取图到客户端确认命中；未命中为 null |
| `totalMs` | 定位前到识别逻辑结束，不含最初 3 秒和后续资源加载 |
| `serverTimingsMs` | 服务器返回的阶段，字段依当前后端实现，未返回为 null |
| `model_request_ms` | 后端到模型服务的完整往返，不是 GPU 推理时间 |
| `model_inference_ms` / `model_service_total_ms` | 模型内部推理/服务总耗时，均包含在模型请求往返内 |
| `transportAndPlatformEstimateMs` | HTTP 往返减 api_total_ms 的非负差值估算，不能称为纯网络时间 |

渲染另有 `[ThreeAR][timings]`：约每 2 秒输出帧率及该帧 acquireMs、matrixMs、backgroundSubmitMs、businessMs、reticleHitTestMs、threeSubmitMs、frameWorkMs、drawCalls、geometries、textures。阶段为 JS/API 调用耗时，没有测 GPU 真正完成时间；帧率为该窗口平均，其余阶段为采样帧，不是中位数。

## 上传预览与验收

`debugFramePreview: true` 默认保留最近已完成识别上传的同一张 JPEG，点击“查看识别画面”核对；替换、切换及退出时清理旧文件。失败/取消文件立即清理；关闭预览配置后每轮文件都在结束时清理。

真机依次验证：GPS 素材显示；切换清场；3 秒准备与每秒上传；命中只显示关联素材；原地旋转不重启而移动 1.5 米会清场；资源下载中快速切换；后台恢复新会话；JPEG 与手机实际画面的方向、裁切、颜色一致。详见迁移文档的 iOS/Android 检查表。

本地统一回归：

```sh
npm run build:xr-three-lab
npm test
```

包含 Three/VK 会话与矩阵、实际 GLB 解析、动态文字、资源生命周期、识别并发与乱序、位移闸门、素材耗时。旧 `test-capture-pixels` / `test-capture-pipeline` / `test-capture-gpu` / `test-text-cleanup` 随旧渲染实现退役，替换为 `test-ar-runtime.cjs`。旧 CPU/GPU YUV 性能对照可在迁移前提交 `e397a90` 的本文和脚本查看，不能用于描述原生 VK 导出性能。

本地测试使用原生 API 替身，不能代替微信真机联调。本轮尚无新渲染链路的真机耗时结论。

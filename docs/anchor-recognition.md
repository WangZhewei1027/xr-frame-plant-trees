# AR 素材来源切换

当前识别链路为：小程序上传 JPEG 和 GPS → Web 平台 `POST https://spatialmemory.online/api/miniapp/anchors/recognize?workspace_id=…`（阿里云上海，与数据库、SAGE 模型同地域）→ GPS 候选与参考特征查询 → 阿里云 SAGE 推理 → 返回匹配点及其关联素材。管理端继续负责匹配点、参考图及关联素材管理。请求/响应协议与原 Supabase Edge Function 一致（`X-Recognition-Request-Id` 回显、`data.request_id`、`diagnostics`），不再需要 `x-region` 头。所有数据接口见 `miniprogram/utils/backend.ts` 与 Web 仓库的 `docs/miniapp-api.md`。

> 2026-10-08 起临时改为直连 `https://139.196.189.102`（域名等待 ICP 备案）。微信不允许 IP 作为服务器域名，只能在开发者工具「不校验合法域名」或真机「打开调试」时使用；备案通过后改回域名（只需改 `utils/backend.ts` 的 `API_BASE_URL`）。

## 匹配调试日志

开发者工具 Console 或真机调试控制台筛选 `AnchorMatch`，并开启 Log / Warning / Error 级别。`matching/config.js` 的 `debugLogs: true` 默认开启；改为 `false` 可关闭。日志仅输出到本地控制台，不上传到日志服务。

每轮请求都有 `[AnchorMatch][轮次编号]`，包括定位精度和耗时、取图耗时、上传往返耗时、HTTP 状态、匹配原因、匹配点 ID / 名称、余弦相似度、距离、GPS 候选半径、返回素材数量、模型版本、当前在途数和匹配后暂停状态。日志不包含鉴权头、图片内容、完整向量或完整响应。等待 AR 的日志只在进入等待时输出，冷却和正在处理中的逐帧调用不会刷屏。

示例（数字仅为说明，不是实测结果）：

```text
[AnchorMatch][abc-1] 匹配结果 {"matched":true,"anchorName":"老街入口","cosineSimilarity":0.89,"distanceMeters":12,"assetCount":3}
[AnchorMatch][abc-1] 匹配成功，停止取图 {"anchorId":"…","restartDistanceMeters":1.5}
[AnchorMatch][abc-1] 本轮结束 {"outcome":"matched_locked","inFlightCount":0,"nextAttemptAfterMs":null}
```

单次命中后显示“匹配成功，停止取图”和“已交给 AR 素材展示队列”；这表示已提交素材，具体资源是否加载和渲染成功还需结合 xr-frame 日志判断。未命中时查看 `reason` / `reasonText`。未命中时 anchor 字段为空，分数与阈值见后续“匹配诊断”日志；客户端不会推测缺失数值。

`本轮结束.outcome`：`matched_locked` 已命中并暂停、`not_matched` 未匹配、`error` 失败、`cancelled` 因命中/切换/暂停取消、`stale_result` / `stale_error` 忽略乱序旧结果、`capture_slot_skipped` 共用 GPS 返回后跳过重复取图时机。上传失败区分 timeout / aborted / network_or_domain。配置缺失时输出“配置不完整，无法发起识别”。`uploadRoundtripMs` 包含上传、整个后端处理及响应下载，不代表模型本身推理耗时。


## 反应速度调试

`matching/config.js` 的 `intervalMs: 1000` 为一秒取图目标，`debugLogs: true` 默认输出以下日志。首次准备仍是 3 秒，命中后停止取图；画布仍忙或在途数达到上限时跳过取图，错误时按既有退避处理。每轮使用同一个 `[AnchorMatch][请求编号]` 关联定位、取图、匹配及素材日志。

优先筛选三种日志：

- `开始取图`：`targetIntervalMs` 为设置间隔，`actualCaptureIntervalMs` 为本轮和上轮真正开始取图流程的间隔，`intervalOverrunMs` 为超过目标的时间；本周期第一张没有前一张，实际间隔为 null。
- `识别耗时汇总`：无论匹配、未命中、失败还是取消，输出已经测到的分段耗时、`phase`、`outcome` 和 HTTP 状态。没有执行或没有返回的数据为 null，实际零毫秒仍为 0。
- `首个素材就绪`：本轮第一个素材完成放置并且节点仍有效。它测量放置结束时间，不代表已经测到手机屏幕首帧。

| 日志字段 | 含义 |
| --- | --- |
| `gpsSource` | watch 组件的持续定位（首选，随移动更新）、fresh 新的单次高精度定位（持续定位超过 `gpsWatchMaxAgeMs` 未更新或精度 > 100 m 时的兜底）、cache 单次定位缓存、shared 等待同一个单次定位 |
| `clientTimingsMs.gpsMs` | 本轮等待定位所花的时间 |
| `clientTimingsMs.captureMs` | 开始取图到 JPEG 导出结束，包括让出主线程的等待 |
| `captureStagesMs` | 原始帧读取、帧快照、画布准备、像素转换、画布写入与 JPEG 导出的分阶段耗时 |
| `pixelConverter` / `gpuFallbackReason` | 实际使用 webgl 或 cpu；GPU 不可用时的回退原因 |
| `captureStagesMs.gpuInitMs` | 首帧建立独立 GPU 上下文、编译 shader 和合成像素自检；不计入 convertMs |
| `captureStagesMs.gpuUploadMs` | GPU 路径的纹理上传、尺寸变化时分配及绘制参数配置 |
| `captureStagesMs.gpuDrawReadMs` | GPU 绘制、同步 RGBA 回读与错误检查的墙钟耗时，并非纯 GPU kernel 时间 |
| `captureStagesMs.gpuAttemptMs` | GPU 转换失败后回退前已经花费的时间；不计入 CPU convertMs |
| `captureStagesMs.convertMs` | 当前转换路径的工作与让出等待；等于 convertWorkMs + convertYieldWaitMs，初始化/失败尝试另计 |
| `captureStagesMs.convertWorkMs` | 各同步转换片段的墙钟耗时之和，包含同步运算及可能发生的 GC / 线程调度，不是 CPU profiler 的纯运算时间 |
| `captureStagesMs.convertYieldWaitMs` | 分片之间 await 让出事件循环至恢复执行的等待之和，包含计时器及 AR / 系统调度等待 |
| `captureStagesMs.maxConvertSliceMs` | CPU 为最长分片（目标约 4ms）；WebGL 为单次同步上传、绘制与回读的整体时间 |
| `clientTimingsMs.uploadRoundtripMs` | 上传开始到 HTTP 回调，包含传输、平台及整个后端处理；取消时为取消前已等待的时间 |
| `clientTimingsMs.responseParseMs` | 客户端 JSON 解析 |
| `clientTimingsMs.resultHandlingMs` | 客户端应用匹配结果的总时间，包含清场及提交素材队列 |
| `clientTimingsMs.sceneClearMs` / `displayDispatchMs` | 本轮清场 / 调用 displayAssets 提交素材的时间；提交队列不等于所有素材加载完成 |
| `clientTimingsMs.totalMs` | 本轮请求开始（定位之前）到识别逻辑结束，不含最初 3 秒准备和后续异步素材加载 |
| `captureToMatchMs` | 开始取图到客户端确认本轮命中的时间，未命中或未走到确认时为 null |
| `serverTimingsMs` | 后端返回的数据库、模型请求、排序及 API 总耗时；Edge Function 用 database_context_ms 合并计量候选/参考查询，用 database_finalize_ms 计量命中复检及素材读取 |
| `serverTimingsMs.model_queue_ms` / `model_decode_ms` / `model_inference_ms` / `model_service_total_ms` | 模型服务返回的排队、图片解码、推理及服务总时间；上游未返回则为 null |
| `serverRequestId` / `upstreamRequestId` / `platformRequestId` / `edgeRegion` / `modelDevice` / `upstreamStatus` | 已校验的服务请求标识、上游请求标识、平台标识、函数区域、模型设备与上游 HTTP 状态，用于跨层排错 |
| `transportAndPlatformEstimateMs` | HTTP 往返减后端 api_total_ms 的非负差值估算，含链路、平台、序列化和回调开销；缺后端数据或差值无效时为 null，不能称为纯网络耗时 |

每个素材还有 `素材开始放置` / `素材放置结束`。其中 `queueWaitMs` 是确认匹配到开始放置的等待，包含预加载等待和前面素材的串行队列；`placementMs` 是该素材放置方法执行及等待完成的时间，可能包含下载、解码和节点创建。`matchToAssetReadyMs` 是匹配成功到该素材就绪，`captureToAssetReadyMs` 是开始取图到就绪，`totalMs` 从本轮定位开始计算。放置结束的 `outcome` 分为 ready / skipped / error / cancelled，只有真实完成且仍有效的节点会输出 ready；清场后的旧任务不会被记成成功。

这些计时存在包含关系：`api_total_ms` 包含 `matching_total_ms`，后者包含数据库和模型等阶段；HTTP 往返又包含后端 API 时间。客户端 `resultHandlingMs` 包含清场和队列提交，`captureMs` 包含取图子阶段。不要把父项和子项累加。`model_request_ms` 是识别函数到 EAS 的整个请求，不是纯 GPU 推理时间；应结合上游返回的 `model_inference_ms` 和 `modelDevice` 判断。当前 Edge Function 的成功及 JSON 错误响应均可带阶段诊断；小程序仅记录白名单内的非负数值和已校验标识，不记录原始错误响应。网关直接返回 HTML、旧服务缺少诊断或阶段未执行时，相应数据仍为 null。

回归：`node scripts/test-anchor-recognition.cjs` 检查分段耗时、目标/实际间隔及失败的空值；`node scripts/test-asset-timing.cjs` 检查预加载和串行放置的耗时、首次就绪，以及取消/跳过/错误不会误报成功。真实速度仍需重新编译后用手机运行，以上字段不填模拟估值。

## 模式行为

AR 页底部可切换「GPS 直接过滤」和「匹配点识别」，默认 GPS。

- GPS：保留原来的 get_nearby_assets / get_huge_assets 行为，用于直接按距离展示和对照实验。
- 匹配点：直接 POST 到 Supabase Edge Function `/functions/v1/recognize-anchor`，GPS 筛选后由后端视觉匹配，仅显示返回的子素材。首次准备 3 秒后每 1 秒尝试取图上传，最多 6 轮同时在途。单次命中即展示并停止后续取图，取消其他请求；相对命中时 XR 位移达到 1.5 米，清场并重新等待 3 秒。未命中继续取图，普通错误按退避重试。不回退 GPS。
- 切换模式、页面隐藏时取消上传并隔离旧请求和加载队列，清空全部场景素材（含本地直发弹幕、点击生成的树、巨型模型和随机彩带）。切回前台重新识别。镜头无需重启。
- 匹配模式隐藏平面标记，禁止点击种树、本地弹幕和随机彩带；单次命中 anchor 后，仅允许该点返回的关联素材进入场景。加载中的旧图片、视频、模型不能在切换后重新出现。GPS 模式仍按附近位置直接展示。
- 匹配成功后复用原有 displayAssets → 放置队列 → 各素材类型的展示流程，空间排列、样式、缩放、动画、容量和分批显示策略均保持原样；仅改变清场和展示触发条件。
- 匹配点的 model 子素材（包括 is_huge）统一走现有近景模型展示；其位置沿用相机前方放置规则。这是地点触发，不输出视觉定位的 6DoF 位姿。

## 接入配置

当前 `miniprogram/components/xr-start/matching/config.js` 使用以下配置：

```js
apiBaseUrl: "https://mkdfezaufjhrfjkfqlbj.supabase.co",
apiPath: "/functions/v1/recognize-anchor",
functionRegion: "ap-south-1", // 默认固定孟买；留空可使用自动路由
```

当前固定数据库所在的孟买区域（`ap-south-1`）。本轮区域对照中，东京和新加坡路径出现调用 EAS 超时；孟买先后两组按每秒一次发送 6 次、12 次请求，共 **18/18 请求成功返回**，因此采用孟买作为当前默认。该小样本只反映本轮验收，不能保证长期网络稳定；实际手机和后续线上表现仍需观察。区域选择没有改变一秒取图间隔、并发上限或命中锁定行为。

实际地址为 `https://mkdfezaufjhrfjkfqlbj.supabase.co/functions/v1/recognize-anchor?workspace_id=…`。`apiBaseUrl` 只填写 HTTPS origin；`apiPath` 单独填写路径。配置无效时 UI 显示「请配置匹配服务地址」，不上传图片。

微信小程序后台必须把 **`https://mkdfezaufjhrfjkfqlbj.supabase.co` 添加到 uploadFile 合法域名**，填写域名而非 `/functions/v1/…` 路径。重新编译并在手机上确认域名和网络访问正常；开发者工具跳过合法域名检查不能代替真机验证。素材所在域名继续配置 downloadFile 等现有白名单。

识别函数按当前方案公开访问，部署时关闭其 JWT 校验（`verify_jwt = false`）。小程序不发送 `apikey` 或 `Authorization`，不需要填任何模型 Token 或 Supabase 密钥，也不需要工作空间授权名单；服务端保管 Supabase service_role 和 `SAGE_EAS_TOKEN`。上传只额外发送 `X-Recognition-Request-Id` 关联日志；配置 `functionRegion` 时才增加 `x-region` 请求头。必须扫描或选择一个明确的 workspace_id，只选择组织不支持识别。

服务端须完成识别函数及数据库迁移部署，并配置 `SAGE_EAS_ENDPOINT`、`SAGE_EAS_TOKEN`、`SAGE_MATCH_THRESHOLD`；`SAGE_MATCH_MARGIN` 默认 0.03。参考图特征仍在管理端生成和维护，正常识别读取已生成的向量。

旧 Vercel 管理端的 `/api/miniapp/anchors/recognize` 仅作为兼容入口保留，不是当前默认链路。需要对照旧链路时才显式将 origin 改回 `https://www.spatialmemory.online`，并将 `apiPath` 改为旧路径；不要只改其中一项。未配置 `apiPath` 的旧配置也会使用该兼容路径。

上传字段：image（JPEG）、latitude、longitude、accuracy、gps_timestamp（毫秒）、coordinate_system=wgs84；workspace_id 放 URL query。使用 WGS84 GPS，同一识别周期内定位最多缓存 5 秒，共用未完成定位请求；精度大于 100 米时不上传。请求超时 20 秒。非 429 错误若包含有效数值 `retry_after_ms`，按该值退避并限制在 1–60 秒，例如当前 Edge 502/504 的 2000ms；缺失、非数值、零或负值时保留普通错误默认 5 秒。429 的 `model_busy` / `model_queue_full` / `model_queue_timeout` 默认退避 1 秒，`workspace_rate_limited` 默认 60 秒；优先使用响应中的有效 `retry_after_ms`，其次使用有错误码的 Retry-After，限制在 1–60 秒。旧服务没有明确错误码时按 60 秒处理。

## 相机与真机验证

使用 scene.ar.getARRawData() 读取不含虚拟物体的 YUV420 帧，缩小最长边到 640 像素，在离屏 2D Canvas 转 JPEG。默认开启 `debugFramePreview`，只保留最近一次已完成识别的上传 JPEG，供“查看识别画面”核对；新结果替换旧文件，切换模式或离开 AR 页面时清理。失败、取消的上传文件立即清理；关闭该配置后，所有上传文件均在本轮结束时清理。当前转换支持紧密排列、无 stride padding 的半平面 YUV420，默认 NV12 / full range；缓冲长度不符会报错。

原始图像方向、UV 顺序、色彩范围和离屏 Canvas 导出支持需要 iOS / Android 真机验证。当前竖屏真机预览确认原始画面逆时针偏转 90°，因此默认 `config.rotation = 90`，在生成上传 JPEG 前顺时针纠正。`config.rotation` 可设顺时针 0/90/180/270，`uvOrder` 可设 uv/vu。该值针对已验证的竖屏场景，其他设备和横屏需通过预览重新核对。若设备输出带 stride 或不同色彩范围，需要按设备返回数据扩展转换；不要用包含 AR 叠层的截图替代。

真机验收：

1. GPS 模式确认原有附近素材正常显示。
2. 配置服务后选择匹配点模式，朝向参考地点，一次命中后出现该点子素材，并停止取图与后续上传；原地转动不重启，移动达到 1.5 米后清空素材并等待 3 秒重启；确认文字和气泡也完整消失。
3. 在请求、模型及音频下载过程中快速反复切换，检查旧素材不再出现或播放。
4. 页面切后台再回来，检查没有后台上传、没有旧响应生效。
5. 检查原始 JPEG 的方向和颜色，并用同一环境与后端参考图做真实匹配。定位、相机授权须已满足原 AR 页要求。

本地回归：

```sh
node scripts/test-anchor-recognition.cjs
node scripts/test-capture-motion.cjs
node scripts/test-capture-pipeline.cjs
node scripts/test-capture-pixels.cjs
node scripts/test-text-cleanup.cjs
node scripts/test-asset-timing.cjs
```

这些测试覆盖接口配置、匿名上传、诊断白名单、识别状态、请求失效、资源隔离、像素一致及异步取图；不等同于微信真机联调。

## 503 错误排查

HTTP 非 200 时，小程序优先展示识别服务 JSON 的 `error` 文本，并记录“服务端拒绝识别”的状态码、错误码及安全诊断；非 JSON 响应继续使用通用提示。错误文本去除控制字符并限制为 200 字，不记录原始响应、照片、Token 或向量。

- `database_unavailable` / “匹配查询未就绪，请检查数据库迁移”：检查识别函数使用的匹配结构及合并查询 RPC 迁移。
- `model_unconfigured` / “匹配服务尚未配置”：检查 Supabase Edge Function 的 `SAGE_EAS_ENDPOINT` / `SAGE_EAS_TOKEN`。
- `threshold_unconfigured`：检查识别函数的 `SAGE_MATCH_THRESHOLD`。
- 管理端参考特征状态 `unconfigured`：另行检查管理端的模型连接配置；它与识别函数的服务端配置分别生效。
- `reference_not_ready`：在管理端生成参考特征后重试。

503 本身不能说明模型正在冷启动，应以实际后端错误为准。


## 未命中分数与耗时

新版本在“匹配结果”之后输出“匹配诊断”：`bestSimilarity`、`threshold`、`secondSimilarity`、`scoreGap`、`requiredMargin`、`candidateCount`、`readyReferenceCount`、`bestDistanceMeters` 和 `timingsMs`。未比较的分数或未执行阶段显示 null，实际 0 分保持 0。只记录预设字段，诊断数据不参与命中锁定或 AR 展示逻辑。旧接口没有 diagnostics 时仍可正常识别。

`below_threshold` 表示最高相似度低于阈值，不能从旧日志中的 `cosineSimilarity: null` 判断实际得分为 0。`model_request_ms` 是当前识别函数到 EAS 的完整耗时，`api_total_ms` 是识别函数内部总耗时；二者都不能直接当作 GPU 计算时间。旧兼容入口返回的是其自身路由耗时。与“收到 HTTP 响应”中的 `uploadRoundtripMs` 对照可定位慢在哪一段。

### 核对实际上传画面

在匹配模式完成一次识别后，点击“查看识别画面”。预览直接显示该轮上传的同一张 JPEG，包含请求编号、尺寸、旋转角度、最佳相似度和阈值；预览期间暂停识别，关闭后继续。取图日志同时记录原始帧与输出尺寸、旋转角度和 UV 顺序。

方向纠正作用于模型收到的像素，而非仅旋转预览界面。修复后先在真机确认图像正向，再比较同一画面的新相似度；目前不调整匹配阈值，不能仅凭方向修复断言匹配分数已提高。

## 定时取图与命中锁定

进入匹配模式且 AR 就绪后先等待 3 秒。每 1 秒尝试抓取新帧并上传，不等待之前请求完成；最多 6 个在途任务（含定位、JPEG 导出和上传），达到上限时跳过调度，不缓存旧图片或无限排队。GPS 同一周期缓存最多 5 秒，未完成定位共用同一 Promise；定位恢复时只允许一个任务占用取图时机，避免多帧同时导出。实际频率受 XR tick、图像转换/导出、网络和服务端承载影响。

取消角速度、平移速度和 800ms 稳定窗口，不因取图前的手持运动阻止识别。没有可用位姿也可以在准备结束后取图；GPS、相机数据格式和图片导出错误继续正常报错。

单次有效命中即复用原 displayAssets 流程展示关联素材，并以成功当下的 XR 位置建立固定基准。停止取图、取消其他在途请求；迟到的失败、未命中或成功都不能覆盖已锁定结果。小程序主动取消上传不会撤回服务端已经开始的推理。已完成较新图像匹配结果之后到达的旧结果会被忽略；模型繁忙或网络错误不会让较早的有效命中失效。

锁定后仍约每 100ms 读取 XR 位置。相对固定基准的三维净位移达到 1.5 米时，清理场景并在该帧启动下一轮 3 秒准备。原地转动、抬头低头和侧倾均不触发重新识别，也不改变成功时的位置基准。小幅移动不更新基准，不累加行走里程。跟踪无效时保持锁定；若成功时没有有效位姿，以恢复后的首个位姿建立基准。模式切换或页面暂停取消全部任务；恢复时同样重新等待 3 秒。

配套后端迁移 `20260915000000_anchor_match_rate_limit_120.sql` 将工作空间共享额度设为 120 次/分钟；当前识别函数的 429 包括 `workspace_rate_limited`（60 秒）以及 `model_busy` / `model_queue_full` / `model_queue_timeout`（1 秒）。小程序优先读取 `retry_after_ms`，再读取有错误码的 Retry-After；兼容旧服务按 60 秒退避。非 429 结构化错误同样采用有效 `retry_after_ms` 并限制在 1–60 秒；未给出有效值时默认 5 秒。退避期间已有请求仍可返回有效命中；暂停、切换或已锁定匹配后，旧错误不能触发重启。

日志增加 `inFlightCount`、`匹配成功，停止取图`、`移动后重新识别`。取图状态为 `preparing` / `ready` / `locked`，不再输出连续确认次数和稳定窗口。参数位于 `matching/config.js`。

回归：`node scripts/test-capture-motion.cjs` 覆盖准备窗口、固定位置基准、转动不触发及跟踪中断；`node scripts/test-anchor-recognition.cjs` 覆盖一秒并发、容量上限、单次命中、成功后取消、乱序结果、短暂繁忙、位移重启和原有素材清场/上传/预览。


## 文字清场与取图性能

文字和本地弹幕先登记动态父节点，再构建文字及气泡；构建或注册检查失败时立即回收，避免出现未登记但仍在场景中的文字。清场先清空文字、隐藏子树，再移除并释放自己创建的动态节点，同时回收内容容器里未登记的残留节点。原有文字样式、气泡和素材空间排列不变。

默认 `matching/config.js` 的 `pixelConverter: "auto"` 优先使用独立 WebGL1 离屏上下文：把同一帧的 Y / UV 快照上传为两张纹理，由 shader 合并完成颜色转换、缩放和方向纠正，渲染到独立 RGBA framebuffer，再直接 `readPixels` 写入现有 ImageData 的 Uint8Array 视图。继续使用原 2D 画布及 JPEG 导出，不引入 Worker、新的相机来源或第三方依赖，不修改 xr-frame 内部 WebGL 状态。

采样位置仍取自现有整数索引，编码成两张小纹理，避免非整数缩放比例在 GPU 浮点 floor 边界造成偏移；shader 同时处理输出行方向，无需 JS 逐行翻转/复制。最长边保持 640，默认顺时针 90° / uv；0/180/270° 和 vu 保留。颜色系数、全范围 YUV 和 128 色度偏移不变，GPU 与 JS 的归一化字节舍入可能相差 1/255。

首次创建 GPU 上下文时检查 highp float、shader 编译、FBO 和纹理尺寸，并用确定性小图自检采样、当前旋转方向及 UV 顺序（颜色最多允许 1 灰阶差，alpha 必须相同）。不可用、自检失败、上下文丢失或回读错误，都会释放自有 GL 资源并自动回退到原 CPU 分片转换；同一 scene 不会每秒重复失败初始化。组件 detached 时释放 GPU 上下文；普通暂停、匹配锁定或模式切换保留缓存用于恢复。设置 `pixelConverter: "cpu"` 可强制旧路径做真机对照。

CPU 回退仍按最多 16 行 / 约 4ms 一段执行，段间通过计时器让出事件循环，采样和旋转索引按尺寸缓存。两条路径都复用 Y/UV 快照、画布及 ImageData；GPU 额外复用 shader、纹理和 FBO，尺寸变化时才重分配纹理。引擎可能复用相机原始内存，快照仍在第一次让出前完整复制，避免混帧。

每个场景同时只允许一张图片进行转换或 JPEG 导出。图片完成导出后即释放取图锁，不等待 HTTP 响应；因此仍支持每秒尝试一次及最多 6 个在途识别请求。上张图片未导出时跳过本次取图，不积压相机帧。取消或切换后，分片转换检查到失效就停止；原生导出已经开始时等待真实回调并清理临时文件。导出超过 5 秒报错，仍保留锁直到原生回调，避免复用正在导出的画布；原生始终不回调时需重新进入 AR 页面。

原始帧读取、缓冲快照、`putImageData` 仍为同步调用。WebGL shader 由 GPU 执行，但 JS 提交命令及 `readPixels` 等待 GPU 回读仍同步，不能称为完全异步或保证无卡顿。绘制与回读在同一段内完成，阶段之间主动让出；JPEG 沿用回调接口。首帧 shader 初始化开销单列，后续帧复用；AR 与转换共享设备 GPU，实际是否改善流畅度需真机测量。

`相机取图完成` 和 `识别耗时汇总` 增加 `pixelConverter`、`gpuFallbackReason`、`gpuInitMs`、`gpuAttemptMs`、`gpuUploadMs`、`gpuDrawReadMs`，原有阶段继续保留。其中：

- `convertWorkMs` 是同步调用片段的墙钟耗时，WebGL 路径包含 GPU 回读等待，不是纯 JS CPU 时间。`convertYieldWaitMs` 为转换片段之间主动让出的恢复等待；GPU 转换阶段没有内部 await，此项为 0，整条取图仍会在阶段间让出。
- `maxConvertSliceMs` 对 CPU 是最长分片，对 WebGL 是一次上传/绘制/回读的整个同步段。GPU 初始化及失败尝试分别在 `gpuInitMs` / `gpuAttemptMs`，不藏进成功转换的计时。
- `geometryReused` / `snapshotReused` 表示缓存复用；每轮仍复制并上传当前帧。`gpuUploadMs` 含纹理更新及参数设置，`gpuDrawReadMs` 含提交绘制、回读及 GL 错误检查，均不是 GPU profiler 的纯计算耗时。

真实 WebGL 回归：`PLAYWRIGHT_MODULE=/path/to/playwright CHROME_PATH=/path/to/chrome node scripts/test-capture-gpu.cjs`（环境需已有 Playwright/Chrome；默认模块名 playwright）。使用合成数据验证四种旋转、uv/vu、多种尺寸和非整数缩放比例、缓存后像素更新、自动回退、取消及资源清理。该测试不会访问业务图片或账号。CPU 的逐字节对照和异步流水线回归继续保留。

本轮真实 Chromium 验证通过 112 组 GPU 像素对照（73,661,504 个通道，最大差 1）和 8 项 GPU 流水线/异常检查；原有及新增 CPU/识别/素材回归共 151 项通过。2026-09-15 桌面 macOS Chrome、10 次预热后 20 次采样，GPU 上传+绘制+回读中位约 8.0ms，CPU 同步转换中位约 1.8ms：桌面环境 GPU 没有更快，不能据此宣称真机提速。此改动针对手机日志中约 375ms 的 JS 分片工作与约 117ms 的让出等待，将逐像素工作移到设备 GPU；真机默认路径是否更快须通过新日志确认。

先前 CPU 优化的本地同帧基准可运行 `node scripts/test-capture-pixels.cjs --benchmark`。一次 macOS arm64 / Node 22、1920×1440 YUV → 480×640 RGBA 的 40 轮交替对照中，旧版同步转换中位数 9.198ms，优化后 6.318ms，约 1.46 倍；56 组像素对照覆盖 0/90/180/270°、uv/vu 和多种尺寸，输出逐字节一致。该基准不包含让出等待、原生相机读取、JPEG 或网络，也不代表手机加速比例。

实际手机取图耗时和 AR 帧率仍需重新编译后测量。先对照 work / yield / 最长片段，再看 HTTP 与模型排队时间；不能根据本地基准保证真机不卡顿或端到端响应达到某个数值。

回归：`node scripts/test-capture-pipeline.cjs` 检查 CPU 回退的事件循环让出、像素一致性、帧快照、画布复用、取消、并发锁、超时清理及 GPU 不可用时单次回退；`node scripts/test-text-cleanup.cjs` 检查真实文字构建及清理流程的正常和异常路径。

GPU API 依据：[微信官方 OffscreenCanvas 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)、[微信官方 YUV shader 示例](https://github.com/wechat-miniprogram/miniprogram-demo/blob/master/miniprogram/packageAPI/pages/ar/visionkit-basic/yuvBehavior.js)、[WebGL 1.0 规范](https://registry.khronos.org/webgl/specs/latest/1.0/)。

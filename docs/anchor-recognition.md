# AR 素材来源切换

## 匹配调试日志

开发者工具 Console 或真机调试控制台筛选 `AnchorMatch`，并开启 Log / Warning / Error 级别。`matching/config.js` 的 `debugLogs: true` 默认开启；改为 `false` 可关闭。日志仅输出到本地控制台，不上传到日志服务。

每轮请求都有 `[AnchorMatch][轮次编号]`，包括定位精度和耗时、取图耗时、上传往返耗时、HTTP 状态、匹配原因、匹配点 ID / 名称、余弦相似度、距离、GPS 候选半径、返回素材数量、模型版本及连续确认次数。日志不包含鉴权头、图片内容、完整向量或完整响应。等待 AR 的日志只在进入等待时输出，冷却和正在处理中的逐帧调用不会刷屏。

示例（数字仅为说明，不是实测结果）：

```text
[AnchorMatch][abc-1] 匹配结果 {"matched":true,"anchorName":"老街入口","cosineSimilarity":0.89,"distanceMeters":12,"assetCount":3}
[AnchorMatch][abc-1] 连续确认 {"count":1,"required":2,"confirmed":false}
[AnchorMatch][abc-1] 本轮结束 {"outcome":"awaiting_confirmation","nextAttemptAfterMs":5000}
```

第二次命中同一匹配点后，`confirmed` 为 true，随后显示“已交给 AR 素材展示队列”；这表示已提交素材，具体资源是否加载和渲染成功还需结合 xr-frame 日志判断。未命中时查看 `reason` / `reasonText`。当前后端未命中响应不返回候选分数、第二名分数或阈值，因此相似度等缺失字段显示为 null；客户端日志不会推测这些数值。

`本轮结束.outcome`：`confirmed` 已连续确认、`awaiting_confirmation` 等待再确认、`not_matched` 未匹配、`error` 失败、`cancelled` 切换模式或暂停后取消。上传失败区分 timeout / aborted / network_or_domain。配置缺失时输出“配置不完整，无法发起识别”。`uploadRoundtripMs` 包含上传、整个后端处理及响应下载，不代表模型本身推理耗时。

## 模式行为

AR 页底部可切换「GPS 直接过滤」和「匹配点识别」，默认 GPS。

- GPS：保留原来的 get_nearby_assets / get_huge_assets 行为，用于直接按距离展示和对照实验。
- 匹配点：请求管理端 POST /api/miniapp/anchors/recognize，GPS 筛选后由后端视觉匹配，仅显示返回的子素材。每轮完成后至少间隔 5 秒，连续两次匹配同一点才展示；未匹配或出错会清空远程素材并重新确认。不回退 GPS。
- 切换、页面隐藏时取消上传并隔离旧请求、加载队列，清理远程素材，保留本地直发弹幕。切回前台重新识别。镜头无需重启。
- 匹配点的 model 子素材（包括 is_huge）统一走现有近景模型展示；其位置沿用相机前方放置规则。这是地点触发，不输出视觉定位的 6DoF 位姿。

## 接入配置

编辑 miniprogram/components/xr-start/matching/config.js 的 apiBaseUrl，填写管理端 HTTPS origin，不带路径。留空时 UI 显示「请配置匹配服务地址」，不上传图片。

微信后台将该 origin 添加至 uploadFile 合法域名；素材所在域名继续配置 downloadFile 等现有白名单。后端需要已经部署 matching API、数据库迁移和 SAGE 特征提取服务。扫描/选择一个明确 workspace_id；只选择组织不支持识别。识别接口按当前方案公开访问，小程序不发送 apikey 或 Authorization，也不需要配置工作空间授权名单。客户端不放 Supabase service_role 或 EAS token。

上传字段：image（JPEG）、latitude、longitude、accuracy、gps_timestamp（毫秒）、coordinate_system=wgs84；workspace_id 放 URL query。每轮显式获取 WGS84 GPS，精度大于 100 米时不上传。请求超时 20 秒，429 后暂停 60 秒。

## 相机与真机验证

使用 scene.ar.getARRawData() 读取不含虚拟物体的 YUV420 帧，缩小最长边到 640 像素，在离屏 2D Canvas 转 JPEG。默认开启 `debugFramePreview`，只保留最近一次已完成识别的上传 JPEG，供“查看识别画面”核对；新结果替换旧文件，切换模式或离开 AR 页面时清理。失败、取消的上传文件立即清理；关闭该配置后，所有上传文件均在本轮结束时清理。当前转换支持紧密排列、无 stride padding 的半平面 YUV420，默认 NV12 / full range；缓冲长度不符会报错。

原始图像方向、UV 顺序、色彩范围和离屏 Canvas 导出支持需要 iOS / Android 真机验证。当前竖屏真机预览确认原始画面逆时针偏转 90°，因此默认 `config.rotation = 90`，在生成上传 JPEG 前顺时针纠正。`config.rotation` 可设顺时针 0/90/180/270，`uvOrder` 可设 uv/vu。该值针对已验证的竖屏场景，其他设备和横屏需通过预览重新核对。若设备输出带 stride 或不同色彩范围，需要按设备返回数据扩展转换；不要用包含 AR 叠层的截图替代。

真机验收：

1. GPS 模式确认原有附近素材正常显示。
2. 配置服务后选择匹配点模式，朝向参考地点，两次命中后出现该点子素材；无匹配或网络断开时显示状态并清除旧素材。
3. 在请求、模型及音频下载过程中快速反复切换，检查旧素材不再出现或播放。
4. 页面切后台再回来，检查没有后台上传、没有旧响应生效。
5. 检查原始 JPEG 的方向和颜色，并用同一环境与后端参考图做真实匹配。定位、相机授权须已满足原 AR 页要求。

本地回归：node scripts/test-anchor-recognition.cjs。测试覆盖匹配状态、GPS/API 协议、请求失效、资源隔离和 YUV 转换；不等同于微信真机联调。

## 503 错误排查

HTTP 非 200 时，小程序优先展示管理端 JSON 的 `error` 文本，并记录“服务端拒绝识别”的状态码和原因；非 JSON 响应继续使用通用提示。错误文本去除控制字符并限制为 200 字，不记录原始响应、照片、Token 或向量。

- “匹配接口未就绪，请检查数据库迁移”：管理端限流 RPC 不可用，先检查匹配结构迁移。
- 匹配点特征状态 `unconfigured`：管理端尚未配置完整的 `SAGE_EAS_ENDPOINT` / `SAGE_EAS_TOKEN`，补齐并重新部署。
- `reference_not_ready`：在管理端生成参考特征后重试。

503 本身不能说明模型正在冷启动，应以实际后端错误为准。


## 未命中分数与耗时

新版本在“匹配结果”之后输出“匹配诊断”：`bestSimilarity`、`threshold`、`secondSimilarity`、`scoreGap`、`requiredMargin`、`candidateCount`、`readyReferenceCount`、`bestDistanceMeters` 和 `timingsMs`。未比较的分数或未执行阶段显示 null，实际 0 分保持 0。只记录预设字段，诊断数据不参与连续确认或 AR 展示逻辑。旧接口没有 diagnostics 时仍可正常识别。

`below_threshold` 表示最高相似度低于阈值，不能从旧日志中的 `cosineSimilarity: null` 判断实际得分为 0。`model_request_ms` 是管理端到 EAS 的完整耗时，`api_total_ms` 是管理端路由内部总耗时；二者都不能直接当作 GPU 计算时间。与“收到 HTTP 响应”中的 `uploadRoundtripMs` 对照可定位慢在哪一段。

### 核对实际上传画面

在匹配模式完成一次识别后，点击“查看识别画面”。预览直接显示该轮上传的同一张 JPEG，包含请求编号、尺寸、旋转角度、最佳相似度和阈值；预览期间暂停识别，关闭后继续。取图日志同时记录原始帧与输出尺寸、旋转角度和 UV 顺序。

方向纠正作用于模型收到的像素，而非仅旋转预览界面。修复后先在真机确认图像正向，再比较同一画面的新相似度；目前不调整匹配阈值，不能仅凭方向修复断言匹配分数已提高。

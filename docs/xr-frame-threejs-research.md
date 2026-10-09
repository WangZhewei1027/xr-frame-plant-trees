# VisionKit + Three.js 独立验证（含早期 xr-frame 调研）

## 当前实现：VisionKit v2 + Three.js

2026-10-08 根据方案选择，将 `labs/xr-three/index` 改为 **VisionKit v2 + Three.js 单画布渲染**。本页不再创建 xr-frame 场景。之前的桥接实验保留在 `labs/xr-three/bridge`，可从验证页按钮进入。原 `XR-Three-Lab` 编译模式仍可直接打开新入口。随后正式 `pages/ar/ar` 也迁移至同一共享运行时；当前业务状态见 [迁移文档](visionkit-three-migration.md)。本页其余内容保留独立验证阶段的边界与历史记录。

### 一帧如何渲染

1. `VKSessionController` 创建一个 `{ version: 'v2', track: { plane: { mode: 1 } }, gl }` 会话。
2. 用会话 RAF 调度，最多每秒 30 次 `getVKFrame(canvas.width, canvas.height)`。
3. 同一个 VKFrame 的 `camera.viewMatrix`、`camera.getProjectionMatrix()` 同步给 Three 相机；关闭 Three 自动重算相机世界矩阵，避免覆盖原生位姿。
4. 相机背景 GPU pass 直接借用 `getCameraTexture(gl, 'yuv')` 返回的纹理，应用 `getDisplayTransform()`。GLSL 300 shader 和核心 VAO 使用同一 WebGL2 上下文；不访问 Three 的私有纹理字段。
5. 原生纹理访问和背景绘制前后调用 `renderer.resetState()`，清理手写 GL 与 Three 状态缓存之间的不一致。背景 pass 清理颜色和深度，Three `autoClear=false` 保留背景再绘制场景。
6. 更新 AnimationMixer，渲染模型、落点圈等全部虚拟内容。运行中没有 CPU 相机像素复制，也没有跨引擎贴图上传。

背景 pass 是同一上下文中的手写 WebGL shader，并非把原生纹理伪装成 Three.Texture；这仍是一条显示链路、一个画布。测试页面初始化仅做一次 1 像素 readPixels，校验合成 shader，真实 AR 循环不做读回。

### 放置和生命周期

- 平面交点查询为中心归一化坐标 `(0.5, 0.5)`，落点圈最多 10 Hz 更新。点击放置时再次查询，避免使用旧交点。
- 交点矩阵固定到 `contentRoot`，演出在其局部坐标中播放；不每帧把根节点跟随相机。另有“前方 2 米”用于没有平面时测试，明确不等于保存地点重定位。
- 仅使用支持真实尺度的 v2，不静默回退 v1。
- 页面隐藏时取消 RAF、移除事件、停止并销毁会话；返回后重建并清除旧落点。会话代次校验忽略已经退出页面的启动回调。
- 启动超时、相机权限错误、无效矩阵、连续无相机帧或纹理都显示具体错误；失败后回到明确标注的测试画面。
- 上下文丢失停止渲染与 AR，要求退出重进；不把恢复事件误当成原生资源已恢复。

### 兼容边界

- Three 锁定 `0.186.1`，构建为 CommonJS。小程序版本、设备是否同时支持 VisionKit v2 + WebGL2 需要真机验证。
- 官方旧示例 UV 取 `.ra`，当前默认沿用；调试提供 `.rg` 手动对照，记录机型后再决定是否需要按平台适配。不是自动准确判断纹理格式的算法。
- 平面追踪不等于深度遮挡，也不等于跨会话 VPS 重定位。
- 本次 GLB fixture 无纹理、无压缩、buffer 内嵌。本地图片经 Canvas.createImage 创建 Three.Texture；网络加载、带内嵌图片的任意 GLB、Draco/KTX2、字体、视频、后处理还未全面适配。
- 实验页没有调用 SAGE、GPS、数据库和资产接口；原 App 生命周期仍会执行。

### 验证记录与操作

已通过 `npm run build:xr-three-lab`、`npm run test:xr-three-lab`、JS 语法检查、`git diff --check`。测试覆盖实际 bundle / GLTFLoader、相机 6DoF 矩阵与投影往返、放置后局部动画、无效矩阵拒绝、会话取消与晚回调、30 FPS 取帧上限、授权失败和渲染错误的资源清理。

**尚未通过真实相机 / 真机验收。** 本轮尝试打开微信开发者工具时 Mac 锁屏，无法完成模拟器视觉检查。旧 Three 独立渲染在开发者工具通过的结论不能代替这次 VisionKit 链路验收。

操作步骤：

1. 微信开发者工具选择 `XR-Three-Lab` 编译模式，或自定义启动路径 `labs/xr-three/index`。
2. 初始灰色背景明确标注“测试画面 · 非相机”，显示 Three 动画方块。可加载 GLB 动画和本地图片纹理。
3. 真机打开后点击“启动 AR”，允许既有相机权限，左右移动手机扫描地面。
4. 中心落点圈出现后点击“放到准星处”；走动确认物体留在落点，暂停/拖动动画确认根节点不动。
5. 切后台再返回，应重新扫描放置；停止/重启和退出应释放相机。
6. 展开调试 / 复制报告，检查 `[VKThreeLab]` 和 `[VKThreeLab][timings]`。

耗时为每秒窗口内的 p50/p95：`acquireMs`、`cameraSyncMs`、`backgroundSubmitMs`、`hitTestMs`、`animationMs`、`threeSubmitMs`、`frameWorkMs`。均是 JS / API 调用耗时，不是异步 GPU 执行完成时间。画布像素比上限 2，尺寸跟随窗口更新，getVKFrame 与渲染视口使用相同像素尺寸。

依据：[微信 plane-ar-v2 示例](https://github.com/wechat-miniprogram/miniprogram-demo/tree/master/miniprogram/packageAPI/pages/ar/plane-ar-v2)、[官方 API 类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)。示例提供的是旧 Three / WebGL1 实现，本次独立适配成新版 Three / WebGL2，不能把示例可用性当成此次改造已真机通过。

---

## 以下为早期 xr-frame 桥接调研记录（入口已迁至 bridge）

核验日期：2026-10-08。目标是在保留 xr-frame 的前提下判断能复用多少 Three.js 编辑器/动画运行时；本次没有迁移正式 AR 页面，也没有新建 VisionKit 相机会话。

## 结论

1. **新版 Three.js 可以进入小程序工程，不必限定在官方旧适配库的 r108。** 本次锁定 npm 最新 `three@0.186.1`（`REVISION=186`），用构建工具转换成小程序可加载的 CommonJS，给 DOM / 编解码依赖提供局部适配。
2. **已在微信开发者工具实际完成 WebGL 2 渲染、基础 PBR 材质、本地图片纹理、无纹理无压缩 GLB 动画。** 这不是 iOS / Android 真机兼容性证明。
3. **xr-frame + Three.js 可以分为动画属性桥接与画面贴图桥接。** 两条路径已实现为可操作实验，xr-frame 侧仍待真机；不能据此宣称 `THREE.Scene` 已由 xr-frame 原生渲染。
4. **没有找到稳定公开的共享 WebGL 上下文 / 导入外部 WebGLTexture / 接管 xr-frame 渲染器接口。** 不依赖 `__handle`、原生 worker 或其他内部字段。
5. 如果只要素材位移、旋转、缩放演出，优先试 AnimationMixer → XR Transform。若要完整复用 Three.js 材质、骨骼、后处理及编辑器运行时，长期更合适的路线仍是另行验证 VisionKit + Three.js；本次没有用这条路线冒充混合接入。

## 证据与版本

| 核验项 | 结果 | 来源 |
| --- | --- | --- |
| 新版 WebGLRenderer | r163 起不支持 WebGL 1，要求 WebGL 2 | [Three.js 官方文档](https://threejs.org/docs/pages/WebGLRenderer.html) |
| 当前 npm three | 本次查询为 0.186.1；在 package-lock.json 固定完整性摘要 | [npm registry](https://registry.npmjs.org/three/latest) |
| 微信 Canvas | 当前官方类型声明有 `getContext('webgl2')`；不是所有机型通过的保证 | [官方 API 类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts) |
| 微信 OffscreenCanvas | 当前声明只列 `webgl` / `2d`，不能由在屏能力推断离屏 WebGL 2 可用 | 同上 |
| xr-frame 纹理公开数据源 | `ArrayBuffer / ArrayBufferView / IImage`；`ITextureOptions.canvas` 标为 `@internal` | [官方 xr-frame 类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.xr-frame.d.ts) |
| xr-frame 原始 AR 帧 | 包含时间戳、YUV、内参、视图矩阵；没有公开的 VKFrame 或 WebGL context getter | 同上 |
| VisionKit + Three.js | 官方 plane-ar-v2 示例获取相机矩阵、平面交点并使用 Three.js 渲染 | [官方示例](https://github.com/wechat-miniprogram/miniprogram-demo/tree/master/miniprogram/packageAPI/pages/ar/plane-ar-v2) |

也检查了旧适配库的默认分支最新提交（不等于维护者所有私有/其他分支的活动）：

- 微信 `threejs-miniprogram`：README 声明 r108，默认分支最后提交为 [2021-04-25](https://github.com/wechat-miniprogram/threejs-miniprogram/commit/5c4964e43e8fd69a433483c30e8efeac5879e560)。
- `deepkolos/three-platformize`：默认分支最后提交为 [2021-12-12](https://github.com/deepkolos/three-platformize/commit/812179569aa00e3721b9b94b58debfb8f30a7d64)。
- 后续 `deepkolos/platformize`：默认分支最后提交为 [2024-10-23](https://github.com/deepkolos/platformize/commit/124af6a9ab8bfd89c173344d1ae04f0e9f0350bd)。可参考其平台抽象，不能默认当作最新版 Three.js 的现成支持承诺。

## 独立验证页

历史桥接页当前路径：`labs/xr-three/bridge`。原编译模式 `XR-Three-Lab` 现打开上文的 VisionKit 新验证页。入口注册在独立子包中，正式首页没有新增实验入口。以下描述的是迁移前实验；正式识别页现已引用共享 Three.js 运行时。

这不是 `independent:true` 的独立分包，仍会执行现有 app 生命周期；实验页面本身不请求 GPS、数据库、SAGE，也不读取用户参考图。唯一图片测试复用已有的本地 DHL 图片。

### A：Three.js 动画核心 → xr-frame 原生节点

通过 Three.js `Group / Object3D / AnimationClip / AnimationMixer / VectorKeyframeTrack / QuaternionKeyframeTrack` 求值，向 XR Transform 写入局部位置、四元数和缩放。

- 使用同一个演出时间，支持暂停和拖动。
- 只同步 TRS，不复制完整 Three 场景、材质或几何。
- XR 保持相机、空间跟踪和原生渲染。
- 不把 Three 欧拉角直接当成 XR 属性中的角度字符串，避免弧度/角度混用。
- 实验以简单局部变换为边界。复杂父子层级、负缩放、坐标手性、根运动、骨骼和形变映射没有完成通用转换，也没有经过真机方向校验。
- 确认相机方向和位置后可点“放到当前镜头前方”；它不是保存点重定位。

这是最适合逐步引入演出系统的路径，动画数据可复用，但 XR 节点适配层仍存在。

### B：Three.js WebGLRenderer → 独立在屏 Canvas

- 明确创建 `<canvas type="webgl2">`，检查版本及关键 WebGL 2 方法，不会悄悄降级成旧 Three。
- 固定 256×256 缓冲，作为兼容性检查，不代表全屏性能。
- 使用 Canvas facade 提供尺寸及事件接口；上下文丢失由 WXML 事件转发。没有修改全局 window/document/self。
- 使用 Canvas RAF 驱动，不启动 WebXR / `renderer.setAnimationLoop()`。
- 首帧不仅检查是否抛错，还回读像素确认存在非背景颜色，并检查 GL error。
- GLB 样本由内存生成，实际使用 GLTFLoader 解析，含几何、PBR 材质、中文节点名和一段动画。
- 图片通过 `canvas.createImage()` 加载，再创建 `THREE.Texture`。不代表 GLTFLoader 内嵌图片 Blob 路径已经适配。

### C：Three.js 渲染画面 → xr-frame 平面纹理

流程为 `Three render → gl.readPixels → 可选逐行翻转 → XR Texture.update`，新纹理通过 `scene.createTexture({source:[bytes]})` 创建。

- 最多 10 FPS；256×256 RGBA 每帧 262,144 bytes，10 FPS 的单向有效像素载荷上限约 **2.5 MiB/s**。这是计算值，不是实测总内存带宽；GPU→CPU→GPU 会有更多传输和同步开销。
- xr-frame 得到的是一个二维画面。Three 中多个物体对 XR 而言仍是同一块平面，无法共享每个物体的深度、碰撞或光照。
- `readPixels` 可能引起 GPU 同步，UI/渲染抖动必须真机测。高分辨率、高帧率会放大此问题。
- 在屏/离屏 Canvas 到原生纹理的零拷贝共享没有被验证，不把 `@internal canvas` 当作稳定公开方案。
- 提供 Y 翻转按钮用于真机核对纹理方向；不假定 GL 与 XR 纹理原点一致。

此路径用于判断互通边界，适合屏幕/画框内容的实验，不推荐承担完整 AR 三维场景。

## 实际验证记录

开发者工具：macOS，Wechat Devtools Stable 2.02.2608060。控制台报告基础库 3.17.3（工程文件为 3.14.0，实际测试按控制台值记录），模拟机型 iPhone 12/13 Pro；**它不是真实 iPhone**。

| 项目 | 结果 |
| --- | --- |
| Three.js 0.186.1 CJS 模块、AnimationMixer | Node VM 无浏览器全局环境通过；小程序逻辑层也成功创建 |
| WebGL 2 | 模拟器返回 `WebGL 2.0 (OpenGL ES 3.0 Chromium)`，最大纹理尺寸 16384 |
| 首帧渲染 | 成功；一次像素检查得到 1148 个不同于背景的像素；界面可见绿色立方体 |
| 无纹理 GLB | 成功；两次解析采样为 10 / 5 ms，轨道 `fixture-motion`，界面可见橙色三角形；不是负载压测 |
| 本地图片纹理 | 成功；两次加载与提交采样为 174 / 28 ms，图片 756×214；界面检查见纹理方块，缓存状态未控制 |
| 轻场景帧循环 | 稳态日志约 120 FPS；初始化/操作时出现 84–108 FPS。仅桌面模拟器数据，不能推算手机帧率 |
| xr-frame + AR | 模拟器报告 `ar-system is only supported in wx-mini-program!` |
| xr-frame 内置引擎 | 模拟器启动时 `ENGINE_WASM` / `draco_mini` 资源返回 500，后续 `PhysSystem` 未定义；因此此环境不能完成 XR 场景验证 |
| AnimationMixer → XR 原生节点 | 纯数据桥接自动测试通过；原生视觉结果待真机 |
| Three 画面 → XR 纹理 | 实现已提供；实际纹理更新、朝向、开销待真机，未判定通过 |
| Android / iOS 实机 | 未执行 |

CLI 尝试被“服务端口关闭”阻止；没有开启安全设置。之后通过开发者工具 UI 完成了页面编译和上面的模拟器检查。

页面日志前缀 `[XRThreeLab]`，计时日志 `[XRThreeLab][timings]`。`animationMs / renderSubmitMs / readPixelsMs / flipRowsMs / xrTextureSubmitMs` 是最近一次对应调用的毫秒采样；使用 Date.now，所以 0 只代表低于计时分辨率。渲染和纹理上传时间是 JS 提交时间，**不是 GPU 完成时间**。FPS 来自页面 RAF，**不是 XR 引擎的真实绘制 FPS**。

“复制完整报告”包含平台、基础库、固定版本、阶段事件和最近耗时。XR 未 ready 时会禁止贴图按钮，并在 10 秒后给出未就绪提示，避免把两个独立画布当作混合成功。

## 新版适配中已解决与尚未解决的部分

已解决：

- ES Module → CommonJS 打包，避免小程序模块解析差异。
- 提供有作用域的 UTF-8 TextDecoder 兜底，仅覆盖本实验有效 UTF-8 数据，不声称完整流式编码兼容。
- 新版 FileLoader 构造时依赖 AbortController；通过 `abort-controller@3.0.0` 局部注入，未改 Three 源码、未改全局。
- 运行期不能直接 `require('./build.json')`，构建信息改为 JS 模块。
- 新文件写入过程中热编译可能先报模块未定义；完整构建结束后重新编译通过。
- 退出实验页停止 RAF，释放动画绑定、几何、材质、纹理和桥接节点；隐藏页面暂停时钟。

后续工作必须按能力逐项验证：

| 能力 | 原因与建议 |
| --- | --- |
| 远程 GLB | 新版 FileLoader 使用 Request、fetch、Response/stream、AbortSignal；优先用 wx.request 取得 ArrayBuffer 后 parse，同时处理 GLB 外链资源 |
| GLB 内嵌图片 | GLTFLoader 使用 self.URL、Blob、createObjectURL 或 ImageBitmapLoader；需要文件/图片适配，不能由独立图片纹理成功推断 |
| Draco / KTX2 | 默认插件使用 Blob Worker，解码器还有 WASM/Worker 兼容问题；第一版先支持不压缩资源 |
| 动态文字与视频 | 小程序字体、Canvas、视频帧 API 与浏览器不同；分别做验证，不能直接搬 DOM/CSS3DRenderer |
| R3F / 编辑器插件 | 使用同一 Three 版本仍不保证浏览器 DOM、事件、音频依赖可用 |
| WebGPU / TSL | 本次只验证 WebGLRenderer；不能把同一包有 WebGPU 导出视为微信已支持 |
| XR 相机与 Three 相机对齐 | 原始矩阵之外还有屏幕方向、裁切、投影约定；本次 B 为固定预览相机，没有伪造 AR 矩阵同步 |
| 上下文恢复 | 已捕获并停用 GPU 测试，提示重进；生产版还应实现完整资源重建 |

## 构建与复测

```sh
npm ci
npm run build:xr-three-lab
npm run test:xr-three-lab
```

预构建的 `vendor/three.js` 已写入实验子包，因此打开开发者工具不依赖“构建 npm”。只有升级版本/修改入口时才需要重新运行构建脚本。构建脚本附带 Three、AbortController、event-target-shim 的许可证。

真机验证步骤：

1. 选择 `XR-Three-Lab` 编译模式（或启动页 `labs/xr-three/index`）。
2. 先检查 B 的绿色方块、GLB 动画及本地纹理。
3. 启动 A，允许本实验需要的相机访问。待场景和 AR ready 后放到镜头前方，验证移动、旋转、缩放以及拖动时间轴。
4. 开启贴图桥接，检查纹理、朝向和读回/提交时间，分别记录开启前后帧率。
5. 暂停、切后台、返回、关闭 XR、重进页面，核对无残留动画/相机/纹理。
6. 复制报告。至少各覆盖一台 iOS 和 Android，再决定是否替换生产路径。

## 对演出系统的建议

如果目标是现有 asset 的出场和空间编排，先用 A：保留 xr-frame 渲染，Three 只负责可移植的动画求值。不要为了复用材质把 C 扩大为高分辨率逐帧复制。

如果目标是把 Web 编辑器的三维场景连同材质、骨骼、效果大范围复用，继续维护“xr-frame 原生渲染 + Three 全功能映射”会增加长期成本。此时应在另一个实验中验证 **VisionKit + 同版本 Three.js**，尤其是相机背景合成、矩阵方向、真实手机 WebGL 2、完整 GLB 资源加载，然后用结果决定迁移。

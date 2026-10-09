# 正式 AR 渲染迁移：VisionKit v2 + Three.js

2026-10-08。`aliyun-backend` 已快进合并到本地 `master`（`e397a90`），从该提交建立 `feat/visionkit-three-renderer`。保留 master 命名。本文描述该分支中的正式业务实现，不仅是实验页。

## 架构

```text
pages/ar/ar（原业务 UI、模式切换、扫码参数）
  └─ components/xr-start（保留组件路径和外部方法）
       ├─ GPS / SAGE 匹配 / 素材队列 / 容量与清场
       └─ lib/three-runtime/ARRuntime
            ├─ 一个 VisionKit v2 会话：相机、米制位姿、平面 hitTest
            └─ 一个 WebGL2 Canvas
                 ├─ 原生相机 YUV 纹理背景 pass
                 └─ Three.Scene：文字、图像、模型、视频面片、特效
```

VisionKit 负责跟踪与相机，Three r186 负责全部业务虚拟内容。背景 pass 直接借用原生纹理，在同一个 GL 上下文绘制；不把 xr-frame 画面贴到 Three，也不把 Three 离屏渲染后贴回 xr-frame。每帧用同一个 VKFrame 的视图/投影矩阵与背景纹理，原生绘制前后同步重置 Three 状态缓存。

生产入口仍是 `pages/ar/ar`；现有 `xr-start` 名称仅为组件接口兼容。历史桥接实验留在 `labs/xr-three/bridge`，独立 VK 实验留在 `labs/xr-three/index`。实验页和生产页共用 `lib/three-runtime` 下的 Three bundle、会话和相机适配，主包不依赖子包。

## 素材实现

| 业务内容 | 新实现 |
| --- | --- |
| text / 本地弹幕 | 字符测量与自动换行，原生 2D Canvas 生成字形 RGBA，Three DataTexture + Plane；圆角气泡、边框、尾巴、头像标记由几何体绘制 |
| image | 原生下载与 Canvas.createImage 解码，Three.Texture，保持图片宽高比并朝向相机 |
| model / 种树 | GLTFLoader + 原生资源插件，SkeletonUtils 克隆，AnimationMixer 播放 GLB 动画；无动画模型保留浮动旋转 |
| audio | 原生音频播放器 + Three 耳机模型，保留距离衰减与近距离聚焦；点击播放/暂停 |
| video | 原生 VideoDecoder → RGBA DataTexture → Three shader；支持上彩色下灰度 alpha 的 TBB 和普通视频 |
| 巨型远景模型 | GPS/罗盘估算方向，Three 放置，保留 100 米显示距离上限、15 米归一化尺寸和靠近 30 米隐藏 |
| 彩带、弹幕飞入、互斥推开 | Three 节点更新；运动按帧间隔计算，彩带为程序化几何 |
| 平面落点 | VisionKit hitTest + 原来的 ar-plane-marker.glb 光标，逐帧更新，点击时在当前光标处种树；树底贴平面，固定落点不参与斥力 |

文字不再加载固定 bubble/profile 图。气泡随内容宽高生成，多行中文、显式换行及常见 emoji 都可布局；`plain_white` 仍为纯文字。已有组织样式和素材 `text_color`、`text_size`、`background_color` 配置生效；每条最多 2000 个 UTF-16 单元、32 行，超行显示省略号，避免巨型纹理。头像采用程序化人物标记，不再随机使用预制头像图片。这里是 Three 中的动态排版面片，并非挤出的立体文字网格。

旧 profile、bubble、confetti 位图仍在源码中作为历史参考，已从小程序打包排除。材质/几何布局入口是 `lib/three-runtime/text.js`，后续增加编辑器的字号、颜色、动画绑定可以从这里扩展。

## 光标资源与更新频率

正式页面复用迁移前 xr-ar-tracker 的同一 [ar-plane-marker.glb](https://mmbizwxaminiprogram-1258344707.cos.ap-guangzhou.myqcloud.com/xr-frame/demo/ar-plane-marker.glb)，保留模型尺寸与材质，没有重新归一化缩放或替换成基础圆环。该文件已保存到 `miniprogram/assets/ar-plane-marker.glb` 并显式加入打包清单，大小 7016 字节，SHA-256 为 `d98cb2adbb1cba6c58cfd3dbd903c41fbff03de09ffcb404ce50e65a8aea8583`。

原迁移版本光标每 100ms 跳到新交点，渲染额外限到 30 FPS。正式页现跟随 VisionKit 原生 RAF，每帧更新相机与光标；不加入额外低通拖尾。模型未加载、没有有效平面、匹配模式或暂停时隐藏光标并禁止种植。点击种植复制当前显示光标的变换，后续异步加载不改变这个落点。`[ThreeAR][timings].reticleHitTestMs` 记录当前帧光标交点更新时间，包含在 businessMs 中；实际流畅度以真机 fps/帧耗时为准。

## 保留的业务规则

沿相机前方 ±30° 扇形随机分布，各类型默认 1.5–5 米；Three 相机前方使用 -Z。继续使用原有 displayAssets、串行放置、分批揭示、容量桶、重复冷却和互斥推开规则。默认 GPS 模式与匹配模式 UI 保留；SAGE 匹配机制、服务地址与阈值不在本次迁移中更改。

匹配仍为：3 秒准备 → 每 1 秒尝试上传（最多 6 个在途）→ 单次成功显示关联素材并锁定 → 净位移 1.5 米后清场重启。纯旋转不重启。所有异步加载都带内容代次复检，切换、暂停或重复返回同一 anchor 后，旧素材不能恢复。匹配下的巨型子素材按近景规则显示。

图像识别改为原生 `VKFrame.getCameraJpgBuffer`；不支持时使用 `getCameraBuffer` + JPEG 导出。没有虚拟物体叠层，也不再套用旧 YUV 路径固定旋转角度。原生图片方向与裁切仍需逐机验证，详见 [识别流程与日志](anchor-recognition.md)。

## 资源与生命周期

- 正式 AR 页跟随每次 VisionKit RAF 取帧与渲染，光标每帧做中心 hitTest，取消原来的 30 FPS / 100ms 双重限频。实际帧率由设备和工作负载决定；独立实验页仍保留 30 FPS 采样上限。同一个原生帧立即消费，不保留到下一 tick。
- 页面隐藏销毁 VK 会话、停止上传、清理全部动态素材；返回重建会话，重新扫描。GL 上下文丢失要求退出重进。
- 普通/巨型模型分别使用引用计数 URL 缓存，空闲 LRU 目标上限 8/3；有在场实例的模板不会被其他实例清理破坏。离开页面释放缓存。
- 每条素材拥有独立清理函数，回收几何、材质、纹理、混合器、音频/视频解码器及临时文件。即使同一 URL 复用模型，也分别保留动画与骨骼状态。
- 初始化失败、相机无帧/无效矩阵/无纹理、导出失败和素材失败会明确提示；没有用模拟相机或假场景冒充业务成功。

## 兼容边界

1. 要求 VisionKit **v2 + WebGL2**。不回退到无真实尺度的 v1 或旧 Three。npm 固定 Three `0.186.1`，bundle 使用局部 TextDecoder / AbortController，不注入全局 DOM。
2. GLB/glTF 适配内嵌 buffer、外部 bin、PNG/JPEG 和原生支持的 WebP 图片。已用项目实际 `headphone.glb` 解析几何和内嵌图片路径；测试图片解码使用原生 API 替身。
3. **当前不支持必须依赖 Draco / meshopt 的压缩模型，也不支持仅有 KTX2 的纹理。** 会提示导出未压缩 GLB 与 PNG/JPEG/WebP；有普通纹理兜底的 KTX2 模型可用兜底。不能承诺任意 Web Three 插件或压缩加载器直接可用。
4. 背景沿用微信官方示例的 UV `.ra` 取样；实验页可切 `.rg` 对照。各设备格式、方向、颜色和透明视频 RGBA 格式需要真机确认。
5. 视频需要原生解码结果为紧密 RGBA，并逐帧复制上传纹理；这部分不属于零拷贝。默认 TBB，普通视频用 `metadata.transparent=false` 或 `metadata.format='normal'`。原生解码支持的容器/编码由设备决定。
6. 空间跟踪不等于场景深度、遮挡或持久化视觉定位。此次不增加外部演出编辑器，也不把 SAGE 相似度变成精确落点位姿。

## 构建与回归

```sh
npm ci
npm run build:xr-three-lab
npm test
```

构建命令保留原名，同时生成生产共享 bundle 与实验页代理。提交生成物后，微信开发者工具不需要再做 npm 构建。共享 Three bundle 约 666 KB；包体最终大小以开发者工具实际打包报告为准。

`npm test` 包含：

- `test-xr-three-lab.cjs`：实际 bundle/GLTF、位姿矩阵与投影、平面落点、会话启动/取消/晚回调、渲染错误清理。
- `test-ar-runtime.cjs`：动态文字与清场、实际业务 GLB 解析、缓存引用、晚加载拦截、原生 JPEG/RGBA 导出、命中到展示再位移重启、视频清理。
- `test-anchor-recognition.cjs`：接口与匿名上传、并发与容量、单次命中、乱序/取消、退避、诊断白名单和预览。
- `test-capture-motion.cjs`：准备期、1.5 米固定基准、旋转不触发、缺失位姿。
- `test-asset-timing.cjs`：排队/放置/首个素材就绪的计时与取消语义。

本地构建、5 组测试及 46 个小程序 JS/TS 模块的语法转译检查通过。本地回归不提供 native WebGL / 相机 / 视频播放的证明。

开发者工具检查受限：此前 Mac 锁屏；最终可读取首页及控制台，但截图不可用、控制台粘贴超时，未能验证正式 AR 路由画面。工具当前灰度基础库 3.17.3 还显示系统 ENGINE_WASM / draco_mini 资源 HTTP 500；问题面板的 3 条错误均指向已有参考工程 xr-frame-demo-master 的 TS 输出配置，不能算作新渲染器运行结果。**当前尚未完成 iOS/Android 真机验收**。

## 真机检查

开发者工具使用首页编译模式进入原 AR 业务页，不要只打开实验页。

1. iOS、Android 各验证启动授权、相机正向/色彩、走动时物体留在世界坐标、横竖屏或窗口尺寸变化、退出释放相机。
2. GPS 模式分别检查中文长文字、emoji、图片、带纹理/骨骼动画 GLB、空间音频、TBB/普通视频、种树、巨型模型与彩带。
3. 模式切换及快速反复切换时文字/气泡/媒体全部消失，加载中的资源不能复活；切后台再回来重新建图。
4. 匹配模式检查 3 秒/1 秒/1.5 米行为，确认上传预览没有 AR 素材且与看到的方向、内容一致。
5. 查看 `[ThreeAR][timings]` 和 `[AnchorMatch]`。当前只计 JS/API 耗时，不是 GPU profiler；比较完整取图、HTTP、首个素材就绪后再判断体感变化。

API 依据：[微信 plane-ar-v2 官方示例](https://github.com/wechat-miniprogram/miniprogram-demo/tree/master/miniprogram/packageAPI/pages/ar/plane-ar-v2)、[微信官方 API 类型](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)、[Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)。

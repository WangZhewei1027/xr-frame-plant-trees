# XR-Frame 3D 场景交互示例总结

## 目标

本文总结 xr-frame-demo-master 中与 3D 场景交互相关的典型案例，重点关注“点击模型”能力，并补充“点击屏幕投射到 3D 世界”的实现方式，方便在当前项目中复用。

## 一、有哪些可直接参考的交互案例

### 1) 基础交互：点击 + 拖拽模型

- 示例路径：`/pages/basic/scene-basic-touch/index`
- 组件：`miniprogram/components/xr-basic-touch`
- 交互点：
  - 地球：touch/untouch/drag
  - 月亮：touch/untouch/drag
- 关键实现：
  - 在节点上声明 shape（`sphere-shape`）
  - 使用 `bind:touch-shape`、`bind:untouch-shape`、`bind:drag-shape`
  - 在回调中通过 `detail.value.target`、`detail.value.camera` 修改 transform

### 2) 模板交互：点击模型触发动画控制

- 示例路径：`/pages/template/xr-template-select/index`
- 组件：`miniprogram/components/template/xr-template-select`
- 交互点：
  - 点击 gltf 模型后，读取 Animator clips
  - 将动作列表通过 `triggerEvent` 抛给上层 UI，执行播放/暂停/继续
- 关键实现：
  - `xr-gltf` 上配置点击体（`cube-shape`）
  - `bind:touch-shape="handleTouchModel"`
  - 回调里获取 Animator：
    - `const myModel = xrScene.getElementById('myModel')`
    - `myModel.getComponent(xrFrameSystem.Animator)`

### 3) 业务交互：点击模型切换视频播放状态

- 示例路径：`/pages/basic/scene-basic-video/index`
- 组件：`miniprogram/components/xr-basic-video`
- 交互点：
  - 点击立方体后暂停/恢复视频纹理
- 关键实现：
  - `cube-shape="autoFit:true"` + `bind:touch-shape`
  - 回调中根据 `video.state` 判断 `pause()` / `resume()`

### 4) AR 交互：识别后点击模型触发动画

- 示例路径：`/pages/ar-classic/scene-classic-wxball/index`
- 组件：`miniprogram/components/xr-classic-wxball`
- 交互点：
  - OSD 识别成功后，点击微信球触发动画恢复
- 关键实现：
  - `xr-gltf` 上 `sphere-shape` + `bind:touch-shape="handleTouchWXball"`
  - Animator 先 `pauseToFrame`，点击后 `resume`

### 5) 复杂剧情交互：点击物体 + 距离门槛 + UI 联动

- 示例组件：
  - `miniprogram/components/xr-beside-edge`
  - `miniprogram/components/xr-last-record`
- 交互点：
  - 点击物体/角色后先校验是否来自主相机
  - 根据相机与目标的距离决定是否允许触发
  - 触发后同步 2D 文本或对话框
- 关键实现：
  - `bind:touch-shape` 绑定大量场景对象
  - 在回调中做距离判断（世界坐标差）
  - 使用 `camera.convertWorldPositionToClip` 做 3D 到 2D 的 UI 对齐

## 二、核心实现模式（点击模型）

### 模式 A：节点自带命中 + 直接绑定事件（推荐，最常用）

1. 给可交互节点添加 shape（命中体）
   - `cube-shape`
   - `sphere-shape`
   - `capsule-shape`
2. 在节点上绑定事件
   - `bind:touch-shape`
   - `bind:drag-shape`
   - `bind:untouch-shape`
3. 在 JS 回调处理业务
   - 修改 transform（位置/旋转/缩放）
   - 控制动画（Animator）
   - 控制材质/视频纹理
   - 向上层抛事件（`triggerEvent`）

### 模式 B：自定义 Element 封装“可点击模型”能力

- 对应示例：`miniprogram/xr-custom/elements/xr-auto-rotate-touchable-gltf.ts`
- 关键思想：
  - 在自定义 element 的 `defaultComponents` 中合并 `mesh-shape` 与业务组件（如 `auto-rotate`）
  - 注册后可像普通标签一样在 wxml 中复用
- 优势：
  - 能力打包，可跨页面复用
  - 页面层只保留业务回调，结构更清晰

## 三、另一类交互：点击屏幕投射到 3D（不是点模型）

- 代表示例：`/pages/physics/scene-physics-shoot/index`
- 思路：
  1. 监听 `scene.event.add('touchstart', ...)`
  2. 将屏幕坐标归一化到裁剪空间（clip space）
  3. 用 `camera.convertClipPositionToWorld` 得到世界方向
  4. 生成刚体并 `addForce` 发射
- 适用场景：
  - 射击
  - 发射/投掷
  - 点击地面放置

## 四、最小可复用模板（点击模型）

```xml
<xr-gltf
  id="myModel"
  model="gltf-myModel"
  cube-shape="size: 0.5 2 0.5; center: 0 0.8 0"
  bind:touch-shape="handleTouchModel"
/>
```

```js
handleTouchModel({ detail }) {
  const xr = wx.getXrFrameSystem();
  const target = detail.value.target; // 被点击目标
  const transform = target.getComponent(xr.Transform);

  // 示例：点击后绕 Y 轴旋转
  transform.rotation.y += Math.PI / 6;
}
```

## 五、落地建议（当前项目）

1. 优先复用“模式 A”（节点 shape + `bind:touch-shape`），实现快、调试直观。
2. 当页面内出现多处相同交互（如“可拖拽+可点击+自动旋转”）时，再升级为“模式 B”自定义 element。
3. 需要与 2D UI 联动时，统一使用 `convertWorldPositionToClip` 做空间映射，避免手写屏幕坐标偏移。
4. AR 场景建议增加相机来源和距离门槛判断，避免误触。

## 六、快速定位索引

- 基础交互：`miniprogram/components/xr-basic-touch`
- 动画点选模板：`miniprogram/components/template/xr-template-select`
- 视频纹理点选：`miniprogram/components/xr-basic-video`
- AR 微信球点选：`miniprogram/components/xr-classic-wxball`
- 复杂剧情交互：
  - `miniprogram/components/xr-beside-edge`
  - `miniprogram/components/xr-last-record`
- 射线投射交互：`miniprogram/components/xr-physics-shoot`
- 自定义可交互元素：`miniprogram/xr-custom/elements/xr-auto-rotate-touchable-gltf.ts`

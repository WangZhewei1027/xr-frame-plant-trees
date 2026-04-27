---
applyTo: "miniprogram/**/*.{js,ts,wxml}"
---

# XR-Frame 坐标系与粒子参数（避坑速查）

## 坐标系约定（右手系，+Y 朝上）

- **+X 向右，+Y 向上，+Z 向后**（即摄像机的 forward 是 **−Z**，与 OpenGL 一致）。
- 重力方向 = 世界 −Y。
- 抬起物体使其在地面之上：`position.y += 高度`（正值）。
- 实测：之前误以为 +Y 朝下导致 confetti 反着飘，已确认 +Y 朝上。

## 摄像机 forward

- 取摄像机朝向（世界空间）：
  ```js
  const wm = camTransform.worldMatrix;
  const camForward = wm.transformDirection(
    xr.Vector3.createFromNumber(0, 0, -1),
  );
  ```
- ⚠️ 之前用 `(0,0,1)` 得到的是 backward，会让"摄像机前方"的物体出现在背后。**正确是 `(0,0,-1)`**。
- 水平方向只取 `x,z` 并归一化，避免抬头/低头时投影偏移。
- 水平右向（与世界上轴叉乘）：`right = (fz, 0, -fx)`。

## XRParticle 关键属性（容易踩坑）

### `gravity` 是 **标量数字**，不是 Vec3

- 类型：`number`（"y轴方向上的每秒位移"）。
- **正值 = 向下加速**（向 −Y 方向，符合现实重力）。
- 错例：`gravity: "0 -0.4 0"` → 解析为 0，重力失效。
- 正例：`gravity: "0.6"`。

### `emitter-props` 的字段名按 emitter 类型区分

`BoxShape`：

- `minEmitBox` / `maxEmitBox`：Vec3，发射体积的两个角点（**不是** `size`/`emitFrom`）。
- `direction` / `direction2`：粒子初速方向的随机区间（会被归一化）。
- 默认 `direction = direction2 = (0,1,0)` → 粒子向上喷射。如果只想靠重力下落，把 direction 改为接近零或微向下，例如 `direction:-0.05 -0.1 -0.05,direction2:0.05 -0.05 0.05`。

`SphereShape`：`radius`、`randomizeDirection`。

写法示例（参考 demo `xr-last-record/index.wxml`）：

```
emitter-type="BoxShape"
emitter-props="minEmitBox:-1.5 -0.1 -1.5,maxEmitBox:1.5 0.1 1.5,direction:0 -0.1 0,direction2:0 -0.05 0"
```

### 其他属性

- `speed`、`size`、`life-time`、`rotate-speed`、`start-rotation`：**两个数表示随机区间**（如 `"0.1 0.5"`）。
- `burst-count` + `burst-time` + `burst-cycle` 用于一次性爆发；emit-rate 设为 0。
- `never-cull` 让粒子不被视锥剔除（动态生成位置时建议加）。
- `stop-duration` ≥ life-time 上限，否则粒子会被提前停。

## 节点位置 vs 粒子 emitter 范围

- **节点 transform.position** 决定粒子系统的"原点"。
- **emitter 的 minEmitBox/maxEmitBox / radius** 决定粒子在原点周围的散布范围。
- 想要"很大一片"散落：建议把散布主要放在 emitter（更高效），节点位置只做整体偏移；避免两层都给大范围导致叠加过宽。

## Quaternion 旋转

- `quaternion.setValue(x, y, z, w)` 顺序，不是 `(w,x,y,z)`。
- 绕 Y 轴旋转角度 θ：`(0, sin(θ/2), 0, cos(θ/2))`。

## Demo 参考

- 粒子参数实例：`xr-frame-demo-master/miniprogram/components/xr-last-record/index.wxml`
- BoxShapeEmitter 源码：`xr-frame-demo-master/miniprogram/xr-custom/components/Particle/Shape/BoxShapeEmitter.ts`
- 类型定义：`xr-frame-demo-master/typings/types/wx/xr-frame.d.ts`（搜 `IParticleData`）

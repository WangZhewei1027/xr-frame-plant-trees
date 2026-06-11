---
applyTo: "miniprogram/**/*.{js,ts,wxml}"
---

# XR-Frame 坐标与朝向（通用速查）

本文件仅包含坐标系、摄像机朝向、旋转相关规则。
粒子参数规范见同目录的 `xr-frame-particles.instructions.md`。

## 坐标系约定（左手系，+Y 朝上）

- **+X 向右，+Y 向上，+Z 向前**（相机 forward = **+Z**，与 Unity 一致，即左手系）。
  - 引擎仅提供 `Vector3.ForwardLH`（注释明确为"基于左手坐标系"），无右手系 forward 常量。
- 重力方向 = 世界 −Y。
- 抬起物体使其在地面之上：`position.y += 高度`（正值）。
- 常见误区：把 +Y 当成向下会导致位移、重力、粒子方向全部反直觉。

## 摄像机 forward

- 取摄像机朝向（世界空间）：
  ```js
  const wm = camTransform.worldMatrix;
  const camForward = wm.transformDirection(
    xr.Vector3.createFromNumber(0, 0, 1),
  );
  ```
- ⚠️ 用 `(0,0,-1)` 得到的是 backward，会让"摄像机前方"的物体出现在背后。**正确是 `(0,0,1)`**。
- 水平方向只取 `x,z` 并归一化，避免抬头/低头时投影偏移。
- 水平右向（与世界上轴叉乘）：`right = (fz, 0, -fx)`。

## Quaternion 旋转

- `quaternion.setValue(x, y, z, w)` 顺序，不是 `(w,x,y,z)`。
- 绕 Y 轴旋转角度 θ：`(0, sin(θ/2), 0, cos(θ/2))`。

---
applyTo: "miniprogram/labs/xr-three/xr-view/**"
---

# XR-Frame 粒子参数（通用速查）

> **⚠️ 历史文档（xr-frame）**：正式 AR 页 `pages/ar/ar` 自 2026-10-09 起不再使用 xr-frame，已切换为 VisionKit v2 + Three.js（见 [`visionkit-three-migration.md`](../../docs/visionkit-three-migration.md)）。下文仅适用于实验页 `miniprogram/labs/xr-three/xr-view/` 与参考工程 `xr-frame-demo-master/`。最危险的差异：xr-frame 相机 forward 为 **+Z**（左手系），Three 为 **−Z**（右手系，`camera.getWorldDirection()`）——不要把本文的朝向规则用于生产代码。生产页的彩带已是 `effects/confetti.js` 中的 Three 程序化几何（`PlaneGeometry` 面片，每帧按 `_frameDelta` 下落），没有 xr-frame 粒子系统与标量 `gravity`。

## 1) `gravity` 是标量，不是 Vec3

- `gravity` 类型是 `number`，表示 y 轴方向上的每秒位移。
- **正值表示向下加速**（沿世界 -Y）。
- 错例：`gravity: "0 -0.4 0"`（会被错误解析）。
- 正例：`gravity: "0.6"`。

## 2) `emitter-props` 字段按 emitter 类型区分

`BoxShape`：

- `minEmitBox` / `maxEmitBox`：发射体积的两个角点（不是 `size` / `emitFrom`）。
- `direction` / `direction2`：初速度方向随机区间（会归一化）。
- 默认通常向上；若希望主要表现为下落，可将方向设为接近零或轻微向下。

`SphereShape`：

- 常用 `radius`、`randomizeDirection`。

示例：

```
emitter-type="BoxShape"
emitter-props="minEmitBox:-1.5 -0.1 -1.5,maxEmitBox:1.5 0.1 1.5,direction:0 -0.1 0,direction2:0 -0.05 0"
```

## 3) 常用参数理解

- `speed`、`size`、`life-time`、`rotate-speed`、`start-rotation`：两个值表示随机区间（如 `"0.1 0.5"`）。
- 一次性爆发可组合：`burst-count` + `burst-time` + `burst-cycle`，并将 `emit-rate` 设为 0。
- `never-cull` 可避免视锥剔除导致的粒子闪断（动态生成位置时常用）。
- `stop-duration` 应大于等于 `life-time` 上限，避免粒子尚未结束就被停止。

## 4) 节点位置与 emitter 范围的关系

- 节点 `transform.position` 决定粒子系统原点。
- `minEmitBox/maxEmitBox/radius` 决定原点周围散布范围。
- 大范围效果优先通过 emitter 参数实现，节点位置只做整体偏移。
- 避免同时给“节点位移 + emitter 范围”过大值，防止结果不可控。

## 5) 快速排查顺序

- 先确认坐标系方向是否正确（尤其 +Y/-Y 语义）。
- 再检查 `gravity` 是否为数字。
- 再核对 `emitter-props` 字段名是否与 emitter 类型匹配。
- 最后调整 `life-time`、`stop-duration`、`burst` 相关参数。

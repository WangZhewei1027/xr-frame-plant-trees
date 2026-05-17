# 模型归一化大小渲染逻辑调查（xr-start）

## 调查范围

本次仅覆盖 `miniprogram/components/xr-start` 内与「3D 模型尺寸归一化」直接相关的路径：

- 普通远程模型（`file_type = model`）
- 巨型远景模型（`is_huge = true`）
- 音频素材附带的耳机 GLB 模型
- 每个素材可选配置：`asset.config.scale_multiplier`

不包含 2D 图片、文本气泡、弹幕、粒子的尺寸策略（这些不是基于 GLTF 包围盒归一化）。

## 结论摘要

现有实现采用了统一思路：

1. 加载 GLTF/GLB
2. 计算模型总包围盒 `calcTotalBoundBox()`
3. 取最长边 `maxExtent = max(size.x, size.y, size.z)`
4. 使用目标最长边（1m / 0.3m）反推等比缩放
5. 再乘素材级倍率 `asset.config.scale_multiplier`（缺省按 `1.0` 处理）

核心公式：

$$
baseScale =
\begin{cases}
\frac{targetLongestEdge}{maxExtent}, & maxExtent > 0.0001 \\
 targetLongestEdge, & maxExtent \le 0.0001
\end{cases}
$$

$$
finalScale = baseScale \times scaleMultiplier
$$

巨型模型是在 1m 归一化后再乘以倍率：

$$
hugeScale = \frac{1.0}{maxExtent} \times HUGE\_MODEL\_SCALE \times scaleMultiplier
$$

`scaleMultiplier` 的读取方式（当前实现）：

```js
const scaleMultiplier =
   asset.config && asset.config.scale_multiplier
      ? asset.config.scale_multiplier
      : 1.0;
```

说明：`config` 为 `null` / `undefined` / `{}` 时会回退到 `1.0`。

## 代码调用链（何时触发）

### 普通模型

1. 首次 GPS 就绪后触发拉取：`updateGPS()`
   - 文件：`miniprogram/components/xr-start/gps.js`
2. 进入素材分发：`fetchNearbyAssets()` -> `displayAssets()` -> `_placeAsset()`
   - 文件：`miniprogram/components/xr-start/assets/index.js`
3. `file_type === "model"` 时调用 `_placeModelAsset()`
   - 文件：`miniprogram/components/xr-start/assets/model.js`

### 巨型模型

1. 首次 GPS 就绪后触发：`fetchHugeAssets()`
   - 文件：`miniprogram/components/xr-start/gps.js`
2. 放置流程：`_placeHugeAssets()` -> `_placeHugeModel()`
   - 文件：`miniprogram/components/xr-start/assets/huge.js`
3. 每帧维护：`tickHugeModels()`
   - 文件：`miniprogram/components/xr-start/assets/huge.js`
   - 在 `handleTick()` 中调用
   - 文件：`miniprogram/components/xr-start/index.js`

## 归一化实现细节

### 1) 普通模型（目标最长边 = 1m）

位置：`miniprogram/components/xr-start/assets/model.js`

关键逻辑：

- `const boundBox = gltfComp.calcTotalBoundBox();`
- `const maxExtent = Math.max(size.x, size.y, size.z);`
- `const normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0;`
- `const scaleMultiplier = ...;`
- `const finalScale = normalizeScale * scaleMultiplier;`
- `transform.scale.setValue(finalScale, finalScale, finalScale);`

说明：

- 最长边先归一到 1m，再乘 `scale_multiplier`。
- `maxExtent <= 0.0001` 时使用兜底 `1.0`，避免除零或异常放大。
- 若模型无内置动画，仅附加上下跳动与旋转，不改变 scale。

### 2) 巨型模型（先归一到 1m，再放大 15 倍）

位置：`miniprogram/components/xr-start/assets/huge.js`

关键常量：

- `const HUGE_MODEL_SCALE = 15;`

关键逻辑：

- `normalizeScale = maxExtent > 0.0001 ? 1.0 / maxExtent : 1.0`
- `scaleMultiplier = ...`
- `hugeScale = normalizeScale * HUGE_MODEL_SCALE * scaleMultiplier`
- `transform.scale.setValue(hugeScale, hugeScale, hugeScale)`

说明：

- 尺寸归一化规则与普通模型一致。
- 在 `HUGE_MODEL_SCALE` 基础上继续乘 `scale_multiplier`，形成可配置远景体量。
- 该分支还会基于 GPS 与罗盘计算放置方向/距离，但这是位置逻辑，不影响大小归一公式本身。

### 3) 音频耳机模型（目标最长边 = 0.3m）

位置：`miniprogram/components/xr-start/assets/audio.js`

关键逻辑：

- `const boundBox = gltfComp.calcTotalBoundBox();`
- `const maxExtent = Math.max(size.x, size.y, size.z);`
- `const s = maxExtent > 0.0001 ? 0.3 / maxExtent : 0.3;`
- `const scaleMultiplier = ...;`
- `const finalScale = s * scaleMultiplier;`
- `transform.scale.setValue(finalScale, finalScale, finalScale);`

说明：

- 和普通模型相同算法，但目标最长边改为 `0.3m`，随后再乘 `scale_multiplier`。
- 若耳机模型加载失败，回退为立方体占位并固定缩放 `0.15`（非归一化分支）。

## 非归一化分支与例外

以下逻辑不是“按模型包围盒归一化”：

1. `placeNode()` 调试/示例放置：固定 `scale = 0.3`
   - 文件：`miniprogram/components/xr-start/index.js`
2. 音频模型加载失败回退立方体：固定 `scale = 0.15`
   - 文件：`miniprogram/components/xr-start/assets/audio.js`
3. 图片素材按目标高度设置：`transform.scale.setValue(targetH * (imgW / imgH), targetH, 1)`
   - 文件：`miniprogram/components/xr-start/assets/image.js`

## 调试与验收要点

可直接看日志关键字确认归一化是否生效：

- 普通模型：`[model] ... normalizeScale=... scaleMultiplier=... finalScale=...`
- 巨型模型：`[huge] ... normalizeScale=... scaleMultiplier=... hugeScale=...`
- 音频耳机：`[audio] 耳机模型 normalizeScale=... scaleMultiplier=... finalScale=...`

快速验收建议：

1. 准备两个原始尺寸差异很大的模型（如一个 0.2m，一个 8m）。
2. 在普通模型路径下观察最终视觉大小应接近一致（最长边约 1m）。
3. 在巨型路径下观察应约为普通模型 15 倍体量。
4. 在音频路径下观察耳机模型最长边应稳定在约 0.3m。

## 可优化点（可选）

1. 将 `1.0`、`0.3`、`15` 提升到统一配置，避免多处硬编码。
2. 抽一个通用函数（如 `normalizeModelScale(gltfComp, targetLongestEdge)`），减少重复实现。
3. 为 `maxExtent <= 0.0001` 增加告警日志，便于定位损坏模型或异常包围盒。

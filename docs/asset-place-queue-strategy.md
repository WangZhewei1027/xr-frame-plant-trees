# Asset 串行放置队列策略

## 问题背景

每次 GPS 触发 `fetchNearbyAssets` 后，可能一次返回 10–20 个素材。旧实现直接用 `forEach` 调用 `_placeAsset`：

```js
newAssets.forEach((a) => this._placeAsset(a));
```

这会造成两类卡顿：

| 素材类型 | 原因 |
|---|---|
| `text`（文本气泡）| `_placeTextAsset` 完全同步，N 个 `createElement + addChild + _buildBubbleNodes` 全部压在同一帧，JS 线程长时间被占用 |
| `model / image / audio`（异步加载）| `loadAsset` 全部同时发起网络请求；一旦集中回调完成，所有 post-`await` 的 scene 操作扎堆进入同一个 microtask 批次 |

结果：XR 渲染帧被 JS 阻塞，画面出现明显卡顿/掉帧。

---

## 解决方案：串行放置队列

### 核心思路

将"批量同时触发"改为"逐个串行完成"：

```
旧（并发）:
asset1 ─> loadAsset ─────────────> 回调 ┐
asset2 ─> loadAsset ─────────────> 回调 ┤← 同时完成，scene 操作扎堆
asset3 ─> loadAsset ─────────────> 回调 ┘

新（串行）:
asset1 ─> loadAsset ─> scene操作 ─> 等80ms ─>
                                               asset2 ─> loadAsset ─> scene操作 ─> 等80ms ─>
                                                                                              asset3 ─> ...
```

每次只有 **一个 asset** 的网络 IO + scene 操作在进行，渲染帧始终有喘息机会。

### 关键方法

#### `_enqueueDisplayAssets(assets)`

将新素材追加进内部 `_placeQueue` 数组，如果 drain 循环当前没有在跑，则启动它。

```js
_enqueueDisplayAssets(assets) {
  if (!this._placeQueue) this._placeQueue = [];
  for (const a of assets) this._placeQueue.push(a);
  if (!this._placingBusy) this._drainPlaceQueue();
},
```

多次 GPS 触发的连续 fetch 会自然排队，不会并发爆发。

#### `_drainPlaceQueue()`

循环从队列头部取出一个 asset，await 其放置完成，再等一个 `placeStaggerMs` 的空闲窗口，然后处理下一个。

```js
async _drainPlaceQueue() {
  this._placingBusy = true;
  const stagger = XR_CONFIG.placeStaggerMs || 80;
  while (this._placeQueue && this._placeQueue.length > 0) {
    const asset = this._placeQueue.shift();
    await this._placeAsset(asset);           // 等待 IO + scene 操作完成
    await new Promise((r) => setTimeout(r, stagger)); // 让渲染帧喘气
  }
  this._placingBusy = false;
},
```

#### `_placeAsset(asset)`（现为 async）

根据 `file_type` 分发，并 `await` 异步放置方法：

```js
async _placeAsset(asset) {
  if (asset.file_type === "model")      await this._placeModelAsset(asset);
  else if (asset.file_type === "text")        this._placeTextAsset(asset);
  else if (asset.file_type === "image") await this._placeImageAsset(asset);
  else if (asset.file_type === "audio") await this._placeAudioAsset(asset);
  else if (asset.file_type === "video") await this._placeVideoAsset(asset);
},
```

`text` 素材本身是同步的，无需 `await`，放置后直接进入 stagger 等待。

---

## 配置参数

位于 `config.js`：

```js
placeStaggerMs: 80,   // 相邻两次放置之间的空闲窗口（毫秒）
```

| 值 | 效果 |
|---|---|
| `0` | 无空闲窗口，但仍然串行——不会扎堆，适合素材很少的场景 |
| `80`（默认）| 每个素材之间留 ~80ms 给渲染帧，约 2–3 帧（30fps）的喘息时间 |
| `150+` | 素材出现更稀疏，帧率更稳定，适合低端机型 |

> 调大 `placeStaggerMs` 不影响加载速度（网络 IO 仍在后台进行），只影响 scene 操作写入渲染管线的频率。

---

## 生命周期安全

组件 `detached` 时清空队列，防止已销毁的场景引用被继续操作：

```js
detached() {
  this._placeQueue = [];
  this._placingBusy = false;
  // ... 其他清理
}
```

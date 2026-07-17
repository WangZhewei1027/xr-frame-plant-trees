# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A WeChat Mini Program that renders a location-based AR experience using WeChat's `xr-frame` engine (`renderer: "xr-frame"`, a WebGL/glTF AR system). Users scan a QR code that carries an `organizationId`/`workspaceId`, then walk around while nearby user-generated "assets" (text bubbles, 3D models, images, audio, video, danmaku) appear in AR around them. Branded internally as "Spatial Memories". Backend is **Supabase** accessed directly over REST/RPC from the client.

There is no npm dependency graph, no build script, no test suite, and no linter configured (`package.json` scripts/deps are empty). TypeScript is transpiled by the WeChat DevTools compiler plugin (`useCompilerPlugins: ["typescript"]`), not `tsc`. `tsconfig.json` exists only for editor typechecking.

## Build / run / develop

- **Open the project root in WeChat DevTools** (微信开发者工具). `project.config.json` points `miniprogramRoot` at `miniprogram/`. AppID is `wxaa785b12f71e1743`, base library `3.14.0`.
- **Preview / debug** happens inside DevTools (Simulator + Preview QR). `xr-frame` AR camera features require a **real device via Preview**; the simulator does not run the AR camera.
- **Entry with params**: the app expects `organizationId` / `workspaceId` in the launch query (from a scanned QR). Without them, `DEFAULT_CONFIG` in `miniprogram/utils/supabase.ts` (东明 org) is used, so it still runs.
- **No test/lint commands exist.** Do not invent `npm test` / `npm run lint`. If asked to typecheck, run `npx tsc --noEmit` at the repo root (config already excludes `node_modules`).

`xr-frame-demo-master/` is the **upstream official demo集** kept for reference only — not part of the shipping app. `crop_circle.py` is a one-off asset-prep script, unrelated to the app runtime.

## Documentation is the source of truth for design decisions

`docs/*.md` contain the *rationale* behind the non-obvious strategies below (in Chinese). Read the relevant doc before changing any of these subsystems — the current code encodes hard-won fixes and the comments explain what breaks if you revert them. `.github/instructions/*.md` are scoped coding rules (they carry `applyTo` globs).

## Architecture

### Page flow
- `pages/index` — landing / scan-entry. Resolves `CONFIG` from launch params, fetches org/workspace display names from Supabase, manages a **scan-history dropdown** (recently used org/workspace, persisted in Storage). `goToAR()` navigates to the AR page carrying the current config in the query.
- `pages/ar` — the AR host page. Owns location (`wx.startLocationUpdate` + `onLocationChange`, falling back to polling), compass (`wx.onCompassChange`), the danmaku input bar, and the optional shop-checkin panel. Embeds the `xr-start` component as `#main-frame` and forwards GPS/compass/nav into it via `selectComponent`.
- `pages/logs` — boilerplate launch-log page (from the quickstart template).

### The AR engine: `miniprogram/components/xr-start/`
This component is the whole AR runtime. `index.js` is a WeChat `Component` whose `methods` are **composed by spreading many factory modules** (`...gps`, `...assetsMethods`, `...danmakuMethods`, etc.). Per-instance mutable state is not in `data` — it's assigned onto `this` via `buildInitialState()` in `attached()`. `data` only holds the two reactive flags (`loaded`, `arReady`). When adding state, extend `buildInitialState()` and clean it up in `detached()`.

`index.wxml` declares the `xr-scene` (AR plane mode), a `xr-shadow#shadow-root` that all runtime nodes are added to, the camera (`id="camera"`), lights, and preloaded material/texture assets. Lifecycle events wire up in `index.js`: `handleReady` (scene ready → parallel preload of tree GLB + profile/bubble textures), `handleARReady` (AR camera ready gate), `handleTick` (per-frame loop), `handleAssetsLoaded`.

Sub-modules:
- `assets/` — remote asset fetch + placement. `index.js` fetches via `get_nearby_assets` RPC and dispatches by `file_type` to `text.js` / `model.js` / `image.js` / `audio.js` / `video.js`. `queue.js` is the **generic capacity engine**; `registry.js` is the **type→descriptor table** that drives it; `huge.js` handles `is_huge` distant landmark models.
- `effects/` — `danmaku.js` (flying chat-bubble animation for just-sent text), `repulsion.js` (per-frame mutual push-apart of all placed nodes), `confetti.js` (org-gated random particle bursts), `transparent-video-tbb.js`.
- `gps.js`, `navigation.js` (stubbed — XR nav visuals removed, only receives state), `preload.js`, `config.js`.

### Key subsystems and their invariants

**Config resolution & persistence** (`utils/supabase.ts`, doc: `scan-config-priority-strategy.md`). Priority: **scan params > persisted last-scan (Storage `config:scan:v1`) > `DEFAULT_CONFIG`**. `CONFIG` is a module-level singleton merged at load time; only `index.ts` calls `setConfig` in `onLoad` (the AR page must NOT, or WeChat's stale "recent" URLs would clobber a newer scan). Note the subtle Storage-spread bug guarded in `loadPersistedScanConfig`: `workspaceId` must be an explicit key or `DEFAULT_CONFIG.workspaceId` leaks in via spread. Supabase calls go through `supabaseGet` (REST) / `supabaseRpc` (POST rpc) which inject the anon key headers.

**Capacity buckets** (`assets/config.js` `buckets`, `queue.js`, `registry.js`, doc: `node-list-queue-strategy.md`). All placed nodes live in one `nodeList` array; each entry belongs to a **bucket** (`heavy`/`light`/`audio`/`transient`) declared by its type's descriptor in `registry.js`. Each bucket has independent `{ cap, evict }` and never evicts across buckets (a flood of text can't push out a model). Evict strategies: `farthest` (by XZ distance from camera — stable under head-rotation, only changes as you walk) or `fifo` (danmaku only). `minLifetimeMs` protects freshly-placed nodes. **To add an asset type: write a placement module + add one entry to `registry.js`; the engine needs no changes.**

**Serial placement queue** (`assets/index.js` `_drainPlaceQueue`, doc: `asset-place-queue-strategy.md`). Fetched assets are placed **one at a time** with a `placeStaggerMs` gap (models get extra) so `loadAsset`/`createElement`/GPU-upload never pile into one frame. Model GLBs are prefetched in parallel while placement is still serial. Async types (`model`/`video`) call `_wouldSurvive` before the expensive instantiation so they don't load only to be evicted immediately.

**Fetch triggering** (`index.js` `handleTick`, `config.js`, doc: `fetch-trigger-strategy.md`). Re-fetch fires on **net displacement of a fixed anchor point** (`distanceThreshold` meters, `fetchCooldownMs` cooldown), NOT accumulated per-frame movement — this rejects VIO jitter/rotation drift. First fetch is gated on **both GPS ready AND AR ready + `firstFetchDelayMs`** (`_maybeStartFirstFetch`), so the camera pose (VIO) has converged and assets don't spawn behind the user. **Limited reveal**: only `revealPerFetch` (first round `revealFirstFetch`) new assets are placed per round; the rest are dropped and reappear on later fetches for a "gradual discovery" feel.

**GLB caching** (`assets/model.js`, `assets/huge.js`, doc: `model-normalization-rendering.md`, `performance-optimization.md`). Same URL → same stable `assetId` (djb2 hash) and a shared `Promise<model>` cache, because `xr-frame`'s `loadAsset` does NOT return `{ value: model }` on repeat calls with the same assetId — you must reuse the first promise or the destructure yields `undefined`. Bound-box sizes are cached per URL (`calcTotalBoundBox` is 100-300ms+). An LRU (`maxCachedModelUrls`/`maxCachedHugeUrls`) releases GLBs with no live instances. Models are normalized to a target longest-edge (1m / 0.3m) then multiplied by `asset.config.scale_multiplier`. **Do not add `releaseAsset('gltf')` to model's `dispose`** — it would yank the shared resource out from under other on-screen instances; LRU owns shared-GLB release.

**Per-frame tick discipline** (`handleTick`). Everything O(N-nodes) runs each frame (billboard facing, repulsion, audio volume, model anim, huge models). Hot-path rules: cache `Transform` components at register time (`entry.trs`/`billboardTrs`), cache the camera transform (`getCamTransform`) and the `xr` system ref, and **avoid per-frame allocations** (repulsion uses flat scratch arrays; `_audioEntries` is a maintained sublist to avoid `nodeList.filter` each frame). `XR_CONFIG.debugLog` gates hot-path `console.log` (which build strings via `JSON.stringify`) — keep it `false` by default.

**Org configuration** (`index.js` `fetchOrgStyle`). The `organization.config` jsonb drives feature flags: `confetti_enabled`, `text_asset_miniapp_style`, `shop_checkin_enabled`, `footer_enabled`. Values are cached in Storage (`config:org:<id>:*`) for a fast/offline default and re-fetched on attach. Confetti start is guarded by `_maybeStartConfetti` because two async sources (assets-loaded, config-fetched) race to enable it. `shop_checkin`/`footer` flags are raised to the AR page via the `orgconfigload` event (page treats `!== false` as "on" so undefined defaults to enabled).

### xr-frame coordinate gotchas (docs: `xr-frame-coordinates.md`, `xr-frame-particles.instructions.md`)
- **Left-handed, +Y up, camera forward = `(0,0,1)`.** Using `(0,0,-1)` puts "in front of camera" behind the user. Camera world forward = `worldMatrix.transformDirection((0,0,1))`.
- Raise objects with **positive** `position.y`; gravity is world −Y.
- `quaternion.setValue(x, y, z, w)` — that order, not `(w,x,y,z)`.
- Particle `gravity` is a **scalar** number string (`"0.6"` = downward), NOT a Vec3 (`"0 -0.4 0"` is wrong). `BoxShape` emitters use `minEmitBox`/`maxEmitBox` (not `size`).

### Storage conventions (`.github/instructions/miniprogram-storage-persistence.instructions.md`)
Storage is for small, serializable, non-sensitive local state only. Scope keys by tenant/context: `<module>:<tenantId>:<contextId>:<name>:v<version>`. Read once at init, write on successful user action — never in high-frequency callbacks (`onLocationChange`, `onCompassChange`, per-frame tick).

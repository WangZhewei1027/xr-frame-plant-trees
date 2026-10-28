const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const root = path.resolve(__dirname, "../miniprogram");
const copy = (value) => JSON.parse(JSON.stringify(value));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = { latitude: 31.2, longitude: 121.5 };
const point = (n) => ({ id: uuid(200 + n), point_id: uuid(200 + n), name: `Point ${n}`, description: "Point", image_url: null, reward_url: "https://example.test/reward.png", ...at });
const activity = (n, type = "danmaku", points = []) => ({ id: uuid(n), activity_id: uuid(20 + n), workspace_id: uuid(900 + n), workspace_name: `Map ${n}`, type, name: `Activity ${n}`, display_name: `Activity ${n}`, config: {}, location: null, radius_meters: null, points });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function launch(storage = new Map()) {
  const calls = { requests: [], toasts: [], writes: [], navigation: [], danmaku: [] };
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getDeviceInfo: () => ({ platform: "devtools" }),
    getStorageSync: (key) => storage.has(key) ? copy(storage.get(key)) : "",
    setStorageSync(key, value) { storage.set(key, copy(value)); calls.writes.push(key); },
    request(options) { calls.requests.push(options); },
    showToast(options) { calls.toasts.push(options.title); },
  };
  let pageDefinition, componentDefinition;
  const context = vm.createContext({ wx, console: { log() {}, error() {} }, setTimeout, clearTimeout,
    Page(value) { pageDefinition = value; }, Component(value) { componentDefinition = value; } });
  const modules = new Map();
  modules.set(path.join(root, "utils/backend-environment.ts"), { exports: { resolveBackendBaseUrl: () => "https://example.test" } });
  function load(file) {
    if (!path.extname(file)) file += fs.existsSync(file + ".ts") ? ".ts" : ".js";
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = transformSync(fs.readFileSync(file, "utf8"), { loader: file.endsWith(".ts") ? "ts" : "js", format: "cjs" }).code;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(
      (name) => load(path.resolve(path.dirname(file), name)), module, module.exports);
    return module.exports;
  }
  const backend = load(path.join(root, "utils/backend.ts"));
  backend.setConfig({ workspaceId: uuid(900), organizationId: uuid(901) });
  const state = load(path.join(root, "utils/activity-state.ts"));
  const frame = { pauseRetrieval() {}, resumeRetrieval() {}, setNavigationTarget(value) { calls.navigation.push(value); }, showDanmakuInXR(value) { calls.danmaku.push(value); }, setRetrievalMode() {} };
  function page() {
    load(path.join(root, "pages/ar/ar.ts"));
    return { ...pageDefinition, data: copy(pageDefinition.data), setData(patch) { Object.assign(this.data, patch); }, selectComponent() { return frame; } };
  }
  function component(activities, legacy = {}) {
    storage.set("checkedInShopIds", legacy);
    load(path.join(root, "components/shop-checkin/index.js"));
    const host = { ...componentDefinition.methods, data: copy(componentDefinition.data), properties: { activities, location: { ...at }, visible: false, compassHeading: 0 },
      setData(patch) { Object.assign(this.data, patch); }, triggerEvent(name, value) { if (name === "navchange") calls.navigation.push(value.shop); } };
    componentDefinition.lifetimes.attached.call(host);
    return { host, definition: componentDefinition };
  }
  function respond(statusCode, data) {
    const request = calls.requests.shift();
    assert.ok(request, "a request is pending");
    request.success({ statusCode, data });
    return request;
  }
  return { backend, state, calls, page, component, storage, respond, activityMethods: () => load(path.join(root, "components/xr-start/activities.js"))({ maxDistanceMeters: 100 }) };
}

async function main() {
  const first = launch();
  const participant = first.state.activityParticipantId();
  assert.match(participant, /^[0-9a-f-]{36}$/);
  assert.equal(launch(first.storage).state.activityParticipantId(), participant, "device participant survives relaunch");
  assert.equal(first.state.activityDistance(at, { latitude: null, longitude: null }), null, "directory points never become the equator");
  assert.equal(first.state.withinActivityScope(activity(1), null), false);
  const ranged = { ...activity(1), location: at, radius_meters: 50 };
  assert.equal(first.state.withinActivityScope(ranged, at), true);
  assert.equal(first.state.withinActivityScope(ranged, { latitude: 31.3, longitude: 121.5 }), false);
  assert.throws(() => first.state.parseActivityPlacements([{ ...ranged, location: null }]), /范围/);
  assert.throws(() => first.state.parseActivityPlacements([{ ...activity(1), points: [{ ...point(1), latitude: null }] }]), /打卡点/);
  assert.throws(() => first.state.parseActivityPlacements([{ ...activity(1), workspace_id: undefined }]), /活动格式/);
  assert.equal(first.state.parseActivityPlacements([activity(1)])[0].display_name, "Activity 1");
  const sharedMaps = [activity(1), { ...activity(2), activity_id: activity(1).activity_id, name: activity(1).name }];
  assert.deepEqual(copy(first.state.parseActivityPlacements(sharedMaps, true).map((item) => item.display_name)), ["Activity 1 · Map 1", "Activity 1 · Map 2"]);
  const sharedShop = activity(3, "shop_checkin", [point(1), point(2)]);
  const shopMaps = first.state.parseActivityPlacements([sharedShop, { ...sharedShop, id: uuid(4), workspace_id: uuid(904), workspace_name: "Map 4" }], true);
  assert.deepEqual(copy(shopMaps[0].points), copy(shopMaps[1].points), "both maps consume the same fixed activity locations and point IDs");
  assert.notEqual(shopMaps[0].id, shopMaps[1].id, "participation remains scoped to a map association");

  const app = launch();
  const page = app.page();
  page.data.location = { ...at };
  const definitions = [activity(1), { ...activity(2), config: { maxLength: 3 } }, activity(3, "shop_checkin", [point(1), point(2)])];
  const loading = page.refreshActivities();
  assert.match(app.calls.requests[0].url, /\/activities\?workspace_id=/);
  app.respond(200, definitions); await loading;
  assert.equal(page.data.shopActivities.length, 1);
  assert.equal(page.data.danmakuActivities.length, 2);
  page.onOrgConfigLoad({ detail: { shopCheckinEnabled: false, footerEnabled: true } });
  assert.equal(page.data.shopCheckinEnabled, true, "legacy organization switch does not hide active deployments");
  page.onTextInput({ detail: { value: "Hello" } });
  assert.equal(page.data.canSubmit, true);
  const failed = page.submitText();
  assert.equal(page.data.isSubmitting, true);
  assert.equal(page.data.textContent, "Hello", "do not clear drafts before acknowledgement");
  assert.equal(app.calls.danmaku.length, 0);
  await page.submitText();
  assert.equal(app.calls.requests.length, 1, "double taps cannot duplicate a request");
  const firstBody = copy(app.calls.requests[0].data);
  assert.equal(firstBody.placement_id, uuid(1));
  assert.match(app.calls.requests[0].url, /\/activity-records$/);
  assert.equal("p_workspace_id" in firstBody, false);
  app.calls.requests.shift().fail(new Error("connection lost after commit")); await failed;
  assert.equal(page.data.textContent, "Hello");
  assert.equal(page.data.isSubmitting, false);
  page.data.location = { latitude: 31.201, longitude: 121.501 };
  const retry = page.submitText();
  assert.deepEqual(copy(app.calls.requests[0].data), firstBody, "uncertain retry retains both idempotency key and original GPS body");
  app.respond(200, { id: uuid(500) }); await retry;
  assert.equal(page.data.textContent, "");
  assert.deepEqual(app.calls.danmaku, ["Hello"], "animate only acknowledged content");
  page.onDanmakuActivityChange({ detail: { value: "1" } });
  page.onTextInput({ detail: { value: "Long text" } });
  assert.equal(page.data.canSubmit, false);
  page.onTextInput({ detail: { value: "Hi" } });
  assert.equal(page.data.canSubmit, true);
  const second = page.submitText();
  assert.equal(app.calls.requests[0].data.placement_id, uuid(2));
  assert.notEqual(app.calls.requests[0].data.idempotency_key, firstBody.idempotency_key);
  app.respond(200, { id: uuid(501) }); await second;
  page.onRetrievalModeChange({ currentTarget: { dataset: { mode: "anchor" } } });
  page.onTextInput({ detail: { value: "Hi" } });
  assert.equal(page.data.canSubmit, false);
  const refreshed = page.refreshActivities(); app.respond(200, []); await refreshed;
  assert.equal(page.data.shopCheckinEnabled, false);
  assert.equal(page.data.activeDanmaku, null);
  await page.submitText(); assert.equal(app.calls.requests.length, 0);
  const stale = page.refreshActivities(); page.onHide(); app.respond(200, definitions); await stale;
  assert.equal(page.data.activeDanmaku, null, "a response after hiding cannot re-enable activities");
  const failedLoad = page.refreshActivities(); app.respond(503, {}); await failedLoad;
  assert.ok(page.data.activitiesError);
  app.backend.setConfig({ organizationId: uuid(901) });
  const allMaps = page.refreshActivities();
  assert.match(app.calls.requests[0].url, /\/activities\?organization_id=/);
  assert.doesNotMatch(app.calls.requests[0].url, /workspace_id=/);
  app.respond(200, definitions); await allMaps;
  assert.equal(page.data.danmakuActivities.length, 2, "organization-only QR retains activity access across all maps");
  assert.equal(page.data.danmakuActivities[0].display_name, "Activity 1 · Map 1");
  page._activityVisible = true;
  const oldPageDiscovery = page.refreshActivities();
  const newerDiscoverySequence = app.state.nextActivityDiscoverySequence();
  page.onActivitiesLoad({ detail: { activities: [], discoverySequence: newerDiscoverySequence } });
  app.respond(200, definitions); await oldPageDiscovery;
  assert.equal(page.data.activeDanmaku, null, "an older page response cannot undo the XR's newer paused activity list");
  const newPageDiscovery = page.refreshActivities();
  app.respond(200, definitions); await newPageDiscovery;
  page.onActivitiesLoad({ detail: { activities: [], error: true, discoverySequence: newerDiscoverySequence } });
  assert.equal(page.data.danmakuActivities.length, 2, "an older XR failure cannot erase newer page discovery");
  console.log("PASS activity discovery, multiple deployments, scope/limits, disabled entry points and acknowledged/idempotent danmaku");

  const shops = launch();
  const a = activity(10, "shop_checkin", [point(1), point(2), { ...point(3), latitude: null, longitude: null }]);
  const b = { ...activity(11, "shop_checkin", [{ ...point(1), id: uuid(111) }]), activity_id: a.activity_id };
  const { host, definition } = shops.component([a, b], { [point(1).id]: true, [uuid(999)]: true });
  assert.equal(host.data.checkedInCount, 0, "old local storage is never used as activity progress");
  assert.equal(host.data.shops[2].canCheckin, false);
  assert.equal(shops.calls.requests.length, 0, "local history must not generate server records");
  const progress = host.loadProgress();
  shops.respond(200, { point_ids: [] }); await progress;
  const checkin = host.onCheckin({ currentTarget: { dataset: { idx: 1 } } });
  assert.equal(host.data.checkedInCount, 0, "pending check-in is not progress");
  assert.equal(host.data.showCheckinModal, false);
  await host.onCheckin({ currentTarget: { dataset: { idx: 1 } } });
  assert.equal(shops.calls.requests.length, 1);
  const checkinBody = copy(shops.calls.requests[0].data);
  assert.equal(checkinBody.point_id, point(2).point_id, "post definition point identity, not old placement identity");
  shops.calls.requests.shift().fail(new Error("offline")); await checkin;
  assert.equal(host.data.checkedInCount, 0);
  const checkinRetry = host.onCheckin({ currentTarget: { dataset: { idx: 1 } } });
  assert.deepEqual(copy(shops.calls.requests[0].data), checkinBody);
  shops.respond(200, { id: uuid(502) }); await checkinRetry;
  assert.equal(host.data.checkedInCount, 1);
  assert.equal(host.data.checkedPointIds[point(2).point_id], true);
  assert.equal(host.data.showCheckinModal, true);
  assert.equal(shops.calls.writes.includes("checkedInShopIds"), false, "only server records determine progress");
  host.closeCheckinModal();
  const oldProgress = host.loadProgress();
  host.onActivityChange({ detail: { value: "1" } });
  assert.equal(host.data.checkedInCount, 0, "progress is scoped to deployment even when point definitions are shared");
  shops.respond(200, { point_ids: [point(1).point_id, point(2).point_id] }); await oldProgress;
  assert.equal(host.data.checkedInCount, 0, "stale progress cannot overwrite another deployment");
  const bProgress = host.loadProgress(); shops.respond(200, { point_ids: [point(1).point_id] }); await bProgress;
  assert.equal(host.data.checkedInCount, 1);
  const late = host.loadProgress(); definition.lifetimes.detached.call(host); shops.respond(200, { point_ids: [] }); await late;
  assert.equal(host.data.checkedInCount, 1);
  assert.equal(host._computeDistances(a.points, a)[2].hasLocation, false);
  host._activateNavigation(a.points[2]);
  assert.equal(host.data.isNavigating, false);
  console.log("PASS multi-point check-in, server-only progress, deployment isolation, race handling and directory points");

  const runtime = launch();
  runtime.backend.setConfig({ organizationId: uuid(901) });
  const removed = [], events = [];
  const ordinary = { assetId: uuid(700), node: {} };
  const renderer = { ...runtime.activityMethods(), _modeEpoch: 1, _activityRevision: 0, _arReady: true, retrievalMode: "gps", currentGPS: at,
    _allowedAssetIds: new Set([ordinary.assetId]), _activityRecordIds: new Set(), _seenAssets: new Map(), nodeList: [ordinary],
    _pendingDisplayAssets: [], _placeQueue: [], flyingDanmakus: [],
    triggerEvent(name, detail) { events.push({ name, detail }); },
    _destroyNode(entry) { removed.push(entry.assetId); },
    displayAssets(records) { for (const record of records) { this._allowedAssetIds.add(record.id); if (!this.nodeList.some((entry) => entry.assetId === record.id)) this.nodeList.push({ assetId: record.id, node: {} }); } },
  };
  const record = (id, deployment) => ({ id: uuid(id), activity_id: deployment.activity_id, activity_placement_id: deployment.id,
    file_type: "text", text_content: `Record ${id}`, metadata: at });
  const d1 = activity(1), d2 = activity(2), outOfRange = { ...activity(3), location: { latitude: 30, longitude: 120 }, radius_meters: 20 };
  const initial = renderer.refreshActivityContent();
  assert.match(runtime.calls.requests[0].url, /\/activities\?organization_id=/);
  await renderer.refreshActivityContent();
  assert.equal(runtime.calls.requests.length, 1, "frame polling cannot start parallel discovery requests");
  runtime.respond(200, [d1, d2, outOfRange]); await tick();
  assert.equal(runtime.calls.requests.length, 2, "fetch only the in-range activity record streams");
  assert.ok(runtime.calls.requests.every((request) => request.url.includes("/activity-records?placement_id=")));
  runtime.respond(200, [record(710, d1), record(711, d2)]); // Wrong placement is ignored.
  runtime.respond(200, [record(712, d2)]); await initial;
  assert.deepEqual(renderer.nodeList.map((entry) => entry.assetId), [ordinary.assetId, `activity:${uuid(710)}`, `activity:${uuid(712)}`]);
  assert.equal(events[0].name, "activitiesload");
  await renderer.refreshActivityContent(); assert.equal(runtime.calls.requests.length, 0, "successful discovery is throttled while stationary");
  renderer._pendingDisplayAssets = [{ id: `activity:${uuid(710)}` }, { id: ordinary.assetId }];
  renderer._placeQueue = [{ id: `activity:${uuid(710)}` }, { id: ordinary.assetId }];
  renderer.flyingDanmakus = [{ node: renderer.nodeList[1].node }];
  renderer._activityNextFetch = 0;
  const paused = renderer.refreshActivityContent();
  runtime.respond(200, [d2]); await tick(); runtime.respond(200, [record(712, d2)]); await paused;
  assert.deepEqual(removed, [`activity:${uuid(710)}`]);
  assert.equal(renderer.flyingDanmakus.length, 0, "paused activity cannot leave a flying message behind");
  assert.deepEqual(renderer._placeQueue.map((entry) => entry.id), [ordinary.assetId]);
  assert.deepEqual(renderer._pendingDisplayAssets.map((entry) => entry.id), [ordinary.assetId]);
  renderer._activityNextFetch = 0;
  const moderated = renderer.refreshActivityContent();
  runtime.respond(200, [d2]); await tick(); runtime.respond(200, []); await moderated;
  assert.deepEqual(renderer.nodeList.map((entry) => entry.assetId), [ordinary.assetId], "hidden records are removed without touching ordinary assets");
  renderer._activityNextFetch = 0;
  const staleRecords = renderer.refreshActivityContent();
  runtime.respond(200, [d1]); await tick(); renderer._modeEpoch++;
  runtime.respond(200, [record(710, d1)]); await staleRecords;
  assert.equal(renderer.nodeList.length, 1, "late response from another retrieval epoch cannot resurrect activity records");
  renderer._activityNextFetch = 0;
  renderer._replaceActivityRecords([record(710, d1)]);
  const supersededRecords = renderer.refreshActivityContent();
  runtime.respond(200, [d1]); await tick();
  const oldRecordResponse = runtime.calls.requests.shift();
  const newerPage = runtime.page();
  renderer.setNavigationTarget = () => {};
  newerPage.selectComponent = () => renderer;
  const newDiscovery = newerPage.refreshActivities();
  runtime.respond(200, []); await newDiscovery;
  assert.equal(renderer.nodeList.length, 1, "the newer pause list immediately removes already displayed activity records");
  oldRecordResponse.success({ statusCode: 200, data: [record(710, d1)] }); await supersededRecords;
  assert.equal(renderer.nodeList.length, 1, "a newer page pause result must also cancel older XR record responses");
  renderer._activityNextFetch = 0;
  const offline = renderer.refreshActivityContent();
  runtime.calls.requests.shift().fail(new Error("offline")); await offline;
  assert.equal(events.at(-1).detail.error, true);
  assert.equal(renderer.nodeList[0], ordinary);
  console.log("PASS separate activity discovery/records, scoped rendering, stationary refresh, pause/moderation removal and stale-response cleanup");

  for (const [file, handlers] of [["pages/ar/ar.wxml", page], ["components/shop-checkin/index.wxml", host]]) {
    for (const match of fs.readFileSync(path.join(root, file), "utf8").matchAll(/bind[\w:]+="(\w+)"/g)) assert.equal(typeof handlers[match[1]], "function", `${file}: ${match[1]}`);
  }
  console.log("PASS activity WXML event handlers exist");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

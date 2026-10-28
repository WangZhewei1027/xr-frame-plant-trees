const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

// Exercise the real backend entry point: all data APIs and recognition must agree.
const code = buildSync({
  entryPoints: [path.join(__dirname, "../miniprogram/utils/backend.ts")],
  bundle: true,
  platform: "neutral",
  format: "cjs",
  write: false,
  external: ["./backend-development-local"],
}).outputFiles[0].text;

const testLanUrl = "http://192.168.20.5:3000";

function loadBackend(envVersion, failRequests = false, platform, developmentUrl = testLanUrl) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console,
    require(name) {
      assert.ok(name.endsWith("backend-development-local"));
      return { apiBaseUrl: developmentUrl };
    },
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
      getDeviceInfo: () => ({ platform }),
      getStorageSync: () => undefined,
      request(options) {
        calls.push(options);
        if (failRequests) options.fail(new Error("local backend unavailable"));
        else options.success({ statusCode: 200, data: [] });
      },
    },
  });
  return { backend: module.exports, calls };
}

async function main() {
  for (const [env, base, platform] of [
    ["develop", testLanUrl],
    ["develop", testLanUrl, "ios"],
    ["develop", testLanUrl, "android"],
    ["develop", "http://127.0.0.1:3000", "devtools"],
    ["trial", "https://139.196.189.102"],
    ["release", "https://139.196.189.102"],
    ["trial", "https://139.196.189.102", "devtools"],
    ["release", "https://139.196.189.102", "devtools"],
  ]) {
    const { backend, calls } = loadBackend(env, false, platform);
    await backend.fetchOrganizations(["org"]);
    await backend.fetchWorkspaces(["workspace"]);
    for (const name of ["get_nearby_assets", "get_scene_asset", "get_huge_assets"]) {
      await backend.backendRpc(name, { p_workspace_id: "workspace" });
    }
    await backend.fetchActivities("workspace", "org");
    await backend.fetchActivityRecords("placement", { latitude: 31, longitude: 121 }, 50);
    await backend.fetchActivityProgress("placement", "participant");
    await backend.submitActivityRecord({ placement_id: "placement" });
    assert.deepEqual(calls.map((call) => call.url), [
      `${base}/api/miniapp/organizations?ids=org`,
      `${base}/api/miniapp/workspaces?ids=workspace`,
      `${base}/api/miniapp/assets/nearby`,
      `${base}/api/miniapp/assets/scene`,
      `${base}/api/miniapp/assets/huge`,
      `${base}/api/miniapp/activities?workspace_id=workspace&organization_id=org`,
      `${base}/api/miniapp/activity-records?placement_id=placement&user_lat=31&user_lng=121&max_distance_meters=50`,
      `${base}/api/miniapp/activity-progress?placement_id=placement&participant_id=participant`,
      `${base}/api/miniapp/activity-records`,
    ]);
    assert.equal(backend.RECOGNIZE_API.baseUrl + backend.RECOGNIZE_API.path,
      `${base}/api/miniapp/anchors/recognize`);
    console.log(`PASS ${env}: all data APIs and recognition use ${base}`);
  }

  const { backend, calls } = loadBackend("develop", true);
  await assert.rejects(backend.submitActivityRecord({ placement_id: "placement" }), /unavailable/);
  assert.equal(calls.length, 1, "failed local writes must not retry against production");
  assert.equal(calls[0].url, `${testLanUrl}/api/miniapp/activity-records`);
  assert.throws(() => loadBackend("develop", false, "ios", ""), /未检测到电脑局域网地址/);
  assert.equal(loadBackend("develop", false, "devtools", "").backend.RECOGNIZE_API.baseUrl, "http://127.0.0.1:3000");
  for (const env of ["trial", "release"]) {
    assert.equal(loadBackend(env, false, "ios", "").backend.RECOGNIZE_API.baseUrl, "https://139.196.189.102");
  }
  assert.equal(loadBackend("develop", false, "ios", "http://10.20.30.40:3000").backend.RECOGNIZE_API.baseUrl, "http://10.20.30.40:3000");
  for (const env of [undefined, "", "unknown"]) {
    assert.throws(() => loadBackend(env), /无法确定小程序环境/);
  }
  console.log("PASS local failures and unknown environments never fall back to production");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

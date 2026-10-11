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
}).outputFiles[0].text;

function loadBackend(envVersion, failRequests = false) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    console,
    wx: {
      getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
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
  for (const [env, base] of [
    ["develop", "http://192.168.1.7:3000"],
    ["trial", "https://139.196.189.102"],
    ["release", "https://139.196.189.102"],
  ]) {
    const { backend, calls } = loadBackend(env);
    await backend.fetchOrganizations(["org"]);
    await backend.fetchWorkspaces(["workspace"]);
    for (const name of ["get_nearby_assets", "get_huge_assets", "get_shop_assets", "upload_text_asset"]) {
      await backend.backendRpc(name, { p_workspace_id: "workspace" });
    }
    assert.deepEqual(calls.map((call) => call.url), [
      `${base}/api/miniapp/organizations?ids=org`,
      `${base}/api/miniapp/workspaces?ids=workspace`,
      `${base}/api/miniapp/assets/nearby`,
      `${base}/api/miniapp/assets/huge`,
      `${base}/api/miniapp/shops`,
      `${base}/api/miniapp/text-assets`,
    ]);
    assert.equal(backend.RECOGNIZE_API.baseUrl + backend.RECOGNIZE_API.path,
      `${base}/api/miniapp/anchors/recognize`);
    console.log(`PASS ${env}: all data APIs and recognition use ${base}`);
  }

  const { backend, calls } = loadBackend("develop", true);
  await assert.rejects(backend.backendRpc("upload_text_asset", {}), /unavailable/);
  assert.equal(calls.length, 1, "failed local writes must not retry against production");
  assert.equal(calls[0].url, "http://192.168.1.7:3000/api/miniapp/text-assets");
  for (const env of [undefined, "", "unknown"]) {
    assert.throws(() => loadBackend(env), /无法确定小程序环境/);
  }
  console.log("PASS local failures and unknown environments never fall back to production");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

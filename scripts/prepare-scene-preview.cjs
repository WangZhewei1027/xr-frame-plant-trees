// Configure a repeatable DevTools entry without changing the normal AR entry.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

async function main() {
  const [assetId, workspaceId] = process.argv.slice(2);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.ok(uuid.test(assetId || "") && uuid.test(workspaceId || ""), "用法：npm run scene:preview -- <sceneAssetId> <workspaceId>");
  const response = await fetch("http://127.0.0.1:3000/api/miniapp/assets/scene", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id: assetId, p_workspace_id: workspaceId }),
    signal: AbortSignal.timeout(15000),
  });
  const manifest = await response.json();
  assert.ok(response.ok, manifest.error || `HTTP ${response.status}`);
  assert.equal(manifest.assetId, assetId);
  assert.ok(manifest.content.instances.length, "请先在 Web 编辑器添加模型并保存场景");
  const file = path.resolve(__dirname, "../project.private.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const conditions = ((config.condition ||= {}).miniprogram ||= { list: [] });
  const list = conditions.list ||= [];
  const name = "Scene 本地全流程验证";
  const previous = list.find((item) => item.name === name);
  const entry = { id: previous?.id ?? Math.max(0, ...list.map((item) => item.id || 0)) + 1,
    name, pathName: "labs/xr-three/scene-preview", query: new URLSearchParams({ assetId, workspaceId }).toString(), scene: null };
  if (previous) Object.assign(previous, entry);
  else list.push(entry);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(`本地接口已确认：${manifest.content.instances.length} 个实例，协议 ${manifest.schemaVersion}`);
  console.log(`微信开发者工具选择「${name}」并编译，页面会自动加载、验证并播放。`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });

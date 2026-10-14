const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { selectAddress, syncDevelopmentBackend, outputRelativePath } = require("./sync-dev-backend.cjs");

const ipv4 = (address, internal = false) => ({ address, internal, family: "IPv4" });
const wifi = (address) => ({ lo0: [ipv4("127.0.0.1", true)], en0: [ipv4(address)] });
assert.equal(selectAddress(wifi("192.168.1.10"), "en0").host, "192.168.1.10");
assert.equal(selectAddress({ en0: [ipv4("10.0.0.3")], en1: [ipv4("192.168.2.8")] }, "en1").host, "192.168.2.8");
assert.equal(selectAddress({ ...wifi("192.168.1.10"), utun4: [ipv4("10.8.0.2")], docker0: [ipv4("172.17.0.1")] }, "utun4").host, "192.168.1.10");
assert.equal(selectAddress({ lo: [ipv4("127.0.0.1", true)], eth0: [{ address: "192.168.1.4", family: 4, internal: false }] }).host, "192.168.1.4");
assert.equal(selectAddress({ en0: [ipv4("169.254.1.2"), { address: "fe80::1", family: "IPv6", internal: false }] }).host, "");
const dual = { en0: [ipv4("10.0.0.3")], en1: [ipv4("192.168.2.8")] };
assert.match(selectAddress(dual, "utun4").warning, /多个局域网地址/);
assert.equal(selectAddress(dual, "en0", { interface: "en1" }).host, "192.168.2.8");
assert.equal(selectAddress(dual, "en0", { interface: "missing" }).host, "");
assert.equal(selectAddress({}, undefined, { host: "192.168.10.20" }).host, "192.168.10.20");
for (const host of ["127.0.0.1", "0.0.0.0", "8.8.8.8", "https://example.com", "192.168.1.8; echo bad"]) {
  assert.throws(() => selectAddress({}, undefined, { host }), /局域网 IPv4/);
}
assert.throws(() => selectAddress({}, undefined, { typo: "en0" }), /不支持字段/);
console.log("PASS LAN selection: routed interface, VPN/Docker exclusion, multi-NIC override, ambiguous/offline failure");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "miniapp-dev-backend-"));
try {
  const output = path.join(root, outputRelativePath);
  const sync = (interfaces) => syncDevelopmentBackend({ root, interfaces, preferredInterface: "en0" });
  assert.equal(sync(wifi("192.168.1.10")).changed, true);
  assert.match(fs.readFileSync(output, "utf8"), /http:\/\/192\.168\.1\.10:3000/);
  const mtime = fs.statSync(output).mtimeMs;
  assert.equal(sync(wifi("192.168.1.10")).changed, false);
  assert.equal(fs.statSync(output).mtimeMs, mtime, "unchanged IP must not trigger a compile loop");
  sync(wifi("10.20.30.40"));
  assert.match(fs.readFileSync(output, "utf8"), /http:\/\/10\.20\.30\.40:3000/);
  assert.doesNotMatch(fs.readFileSync(output, "utf8"), /192\.168\.1\.10/);
  sync({});
  assert.match(fs.readFileSync(output, "utf8"), /apiBaseUrl: ""/);
  sync(wifi("10.20.30.40"));
  fs.writeFileSync(path.join(root, ".miniapp-dev.local.json"), '{"interface":"en1"}');
  assert.equal(sync(dual).host, "192.168.2.8");
  fs.writeFileSync(path.join(root, ".miniapp-dev.local.json"), '{"host":"8.8.8.8"}');
  assert.throws(() => sync(dual), /局域网 IPv4/);
  assert.match(fs.readFileSync(output, "utf8"), /apiBaseUrl: ""/, "invalid config clears stale address");
  fs.writeFileSync(path.join(root, ".miniapp-dev.local.json"), '{');
  assert.throws(() => sync(dual), SyntaxError);
  console.log("PASS network changes replace generated IP; no-op preserves mtime; offline/invalid config clears stale IP");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "../project.config.json"), "utf8"));
assert.equal(config.setting.scriptsEnable, true);
for (const name of ["beforeCompile", "beforePreview", "beforeUpload"]) {
  assert.equal(config.scripts[name], "sh scripts/sync-dev-backend.sh");
}
console.log("PASS DevTools hooks are enabled for compile, preview and upload");

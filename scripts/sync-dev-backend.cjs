// Runs on the computer before DevTools compiles/previews; no mini-program APIs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isIPv4 } = require("node:net");

const projectRoot = path.resolve(__dirname, "..");
const outputRelativePath = "miniprogram/utils/backend-development-local.js";
const overrideName = ".miniapp-dev.local.json";

function isLanAddress(address) {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isVirtualInterface(name) {
  return /^(lo\d*|utun\d*|tun\d*|tap\d*|awdl\d*|llw\d*|docker.*|veth.*|virbr.*|vmnet.*|vboxnet.*|br-.*)$/i.test(name)
    || /vpn|virtual|loopback|tailscale|wireguard|zerotier|wsl|vethernet/i.test(name);
}

function defaultInterface() {
  try {
    if (process.platform === "darwin") {
      return execFileSync("/sbin/route", ["-n", "get", "default"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })
        .match(/interface:\s*(\S+)/)?.[1];
    }
    if (process.platform === "linux") {
      return execFileSync("ip", ["-4", "route", "show", "default"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })
        .match(/\bdev\s+(\S+)/)?.[1];
    }
  } catch { /* Offline or route utility absent: inspect interfaces below. */ }
  return undefined;
}

function selectAddress(interfaces, preferredInterface, override = {}) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    throw new Error(`${overrideName} 必须是 JSON 对象`);
  }
  for (const key of Object.keys(override)) {
    if (!["host", "interface"].includes(key)) throw new Error(`${overrideName} 不支持字段 ${key}`);
  }
  if (override.host !== undefined) {
    if (!isLanAddress(override.host)) throw new Error("host 必须是局域网 IPv4 地址，例如 192.168.1.8");
    return { host: override.host, source: `${overrideName}: host` };
  }
  if (override.interface !== undefined && (typeof override.interface !== "string" || !override.interface.trim())) {
    throw new Error("interface 必须是网卡名称，例如 en0");
  }
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || []).filter((entry) => !entry.internal && (entry.family === "IPv4" || entry.family === 4)
      && isLanAddress(entry.address) && (override.interface === name || !isVirtualInterface(name)))
      .map((entry) => ({ host: entry.address, source: name })));
  const requested = override.interface || preferredInterface;
  const preferred = candidates.filter((entry) => entry.source === requested);
  const choices = override.interface || preferred.length ? preferred : candidates;
  const unique = [...new Map(choices.map((entry) => [entry.host, entry])).values()];
  if (unique.length === 1) return unique[0];
  const reason = unique.length > 1
    ? `有多个局域网地址（${unique.map((entry) => `${entry.source}: ${entry.host}`).join(", ")}）`
    : override.interface ? `网卡 ${override.interface} 没有局域网 IPv4 地址` : "未找到可用的局域网 IPv4 地址";
  return { host: "", source: "", warning: `${reason}；真机开发地址已清空。可在 ${overrideName} 指定 interface 或 host。` };
}

function writeAddress(root, host) {
  const file = path.join(root, outputRelativePath);
  const content = `// 自动生成：编译/预览前更新，不要手改或提交。\nmodule.exports = { apiBaseUrl: ${JSON.stringify(host ? `http://${host}:3000` : "")} };\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
  return true;
}

function syncDevelopmentBackend({ root = projectRoot, interfaces = os.networkInterfaces(), preferredInterface = defaultInterface() } = {}) {
  try {
    const overrideFile = path.join(root, overrideName);
    const override = fs.existsSync(overrideFile) ? JSON.parse(fs.readFileSync(overrideFile, "utf8")) : {};
    const result = selectAddress(interfaces, preferredInterface, override);
    return { ...result, changed: writeAddress(root, result.host) };
  } catch (error) {
    // Never leave a previous network's address active after a configuration error.
    writeAddress(root, "");
    throw error;
  }
}

if (require.main === module) {
  try {
    const result = syncDevelopmentBackend();
    if (result.warning) console.warn(`[miniapp backend] ${result.warning}`);
    else console.log(`[miniapp backend] 真机开发 → http://${result.host}:3000 (${result.source})${result.changed ? "，已更新" : ""}`);
    console.log("[miniapp backend] 模拟器 → http://127.0.0.1:3000；体验版/正式版保持线上配置");
  } catch (error) {
    console.error(`[miniapp backend] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { selectAddress, syncDevelopmentBackend, outputRelativePath };

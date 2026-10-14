import { apiBaseUrl } from "./backend-development-local";

// 电脑在编译／预览前自动生成；本机地址不提交到 Git。
export const DEVELOPMENT_API_BASE_URL = apiBaseUrl;

// 保留现有线上配置：域名备案完成后再切换为 https://spatialmemory.online。
// 当前服务器 IP 的微信调试限制见 docs/local-development.md。
export const ONLINE_API_BASE_URL = "https://139.196.189.102";

export function resolveBackendBaseUrl(envVersion: string | undefined, platform?: string): string {
  switch (envVersion) {
    case "develop":
      if (platform === "devtools") return "http://127.0.0.1:3000";
      if (!DEVELOPMENT_API_BASE_URL) {
        throw new Error("未检测到电脑局域网地址；连接 Wi-Fi 后重新编译/预览，或运行 npm run dev:sync");
      }
      return DEVELOPMENT_API_BASE_URL;
    case "trial":
    case "release":
      return ONLINE_API_BASE_URL;
    default:
      // 无法识别环境时停止初始化，避免本地开发意外写入线上数据。
      throw new Error("无法确定小程序环境，未连接后端；请检查 envVersion");
  }
}

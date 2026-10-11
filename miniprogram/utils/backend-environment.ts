// 开发者工具与同一 Wi-Fi 下的真机共用本机 Web 后端。
// 换电脑或网络后更新此地址；只用模拟器时也可设为 http://127.0.0.1:3000。
export const DEVELOPMENT_API_BASE_URL = "http://192.168.1.7:3000";

// 保留现有线上配置：域名备案完成后再切换为 https://spatialmemory.online。
// 当前服务器 IP 的微信调试限制见 docs/local-development.md。
export const ONLINE_API_BASE_URL = "https://139.196.189.102";

export function resolveBackendBaseUrl(envVersion: string | undefined): string {
  switch (envVersion) {
    case "develop":
      return DEVELOPMENT_API_BASE_URL;
    case "trial":
    case "release":
      return ONLINE_API_BASE_URL;
    default:
      // 无法识别环境时停止初始化，避免本地开发意外写入线上数据。
      throw new Error("无法确定小程序环境，未连接后端；请检查 envVersion");
  }
}

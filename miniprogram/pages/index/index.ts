import { setConfig, CONFIG, supabaseGet } from "../../utils/supabase";

Page({
  data: {
    title: "",
    subtitle: "",
    loaded: false,
  },

  async onLoad(options: Record<string, string | undefined>) {
    setConfig({
      organizationId: options.organizationId,
      workspaceId: options.workspaceId,
    });
    console.log("[index] parsed config:", CONFIG);
    await this.fetchNames();
  },

  async fetchNames() {
    try {
      // 获取 organization 名称
      if (CONFIG.organizationId) {
        const { statusCode, data } = await supabaseGet<{ name: string }[]>(
          "organization",
          `id=eq.${CONFIG.organizationId}&select=name&limit=1`,
        );
        if (statusCode === 200 && Array.isArray(data) && data.length > 0) {
          this.setData({ title: data[0].name });
        }
      }
      // 获取 workspace 名称
      if (CONFIG.workspaceId) {
        const { statusCode, data } = await supabaseGet<{ name: string }[]>(
          "workspace",
          `id=eq.${CONFIG.workspaceId}&select=name&limit=1`,
        );
        if (statusCode === 200 && Array.isArray(data) && data.length > 0) {
          this.setData({ subtitle: data[0].name });
        }
      }
    } catch (err) {
      console.error("[index] fetchNames error:", err);
    } finally {
      this.setData({ loaded: true });
    }
  },

  goToAR() {
    const params: string[] = [];
    if (CONFIG.organizationId)
      params.push(`organizationId=${CONFIG.organizationId}`);
    if (CONFIG.workspaceId) params.push(`workspaceId=${CONFIG.workspaceId}`);
    const query = params.length ? `?${params.join("&")}` : "";
    wx.navigateTo({
      url: `/pages/ar/ar${query}`,
    });
  },
});

import { setConfig, CONFIG, supabaseGet } from "../../utils/supabase";

Page({
  data: {
    title: "",
    subtitle: "",
    loaded: false,
    showFooter: false,
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
      // 并行拉取 organization / workspace 名称，避免串行 await 阻塞首屏渲染
      const orgPromise = CONFIG.organizationId
        ? supabaseGet<{ name: string; config?: Record<string, unknown> }[]>(
            "organization",
            `id=eq.${CONFIG.organizationId}&select=name,config&limit=1`,
          ).catch(() => null)
        : Promise.resolve(null);
      const wsPromise = CONFIG.workspaceId
        ? supabaseGet<{ name: string }[]>(
            "workspace",
            `id=eq.${CONFIG.workspaceId}&select=name&limit=1`,
          ).catch(() => null)
        : Promise.resolve(null);

      const [orgRes, wsRes] = await Promise.all([orgPromise, wsPromise]);

      const patch: Record<string, string> = {};
      if (
        orgRes &&
        orgRes.statusCode === 200 &&
        Array.isArray(orgRes.data) &&
        orgRes.data.length > 0
      ) {
        patch.title = orgRes.data[0].name;
        const cfg = orgRes.data[0].config;
        (patch as Record<string, unknown>).showFooter =
          cfg && typeof cfg === "object"
            ? !!(cfg as Record<string, unknown>).footer_enabled
            : false;
      }
      if (
        wsRes &&
        wsRes.statusCode === 200 &&
        Array.isArray(wsRes.data) &&
        wsRes.data.length > 0
      ) {
        patch.subtitle = wsRes.data[0].name;
      }
      // 单次 setData 批量更新，减少 WXML diff
      this.setData({ ...patch, loaded: true });
    } catch (err) {
      console.error("[index] fetchNames error:", err);
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

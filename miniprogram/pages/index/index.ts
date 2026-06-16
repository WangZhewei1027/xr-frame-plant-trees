import {
  setConfig,
  CONFIG,
  supabaseGet,
  loadScanHistory,
  recordScanHistory,
  saveScanHistory,
  ScanHistoryEntry,
} from "../../utils/supabase";

/** 历史记录在下拉菜单中的展示形态 */
interface HistoryItem extends ScanHistoryEntry {
  /** 列表展示文案，如「东明 / test」 */
  label: string;
  /** 是否为当前选中项 */
  active: boolean;
}

Page({
  data: {
    title: "",
    subtitle: "",
    loaded: false,
    showFooter: false,
    history: [] as HistoryItem[],
    dropdownOpen: false,
  },

  async onLoad(options: Record<string, string | undefined>) {
    setConfig({
      organizationId: options.organizationId,
      workspaceId: options.workspaceId,
    });
    console.log("[index] parsed config:", CONFIG);
    await this.fetchNames();
    // 首屏渲染后异步刷新历史列表名称，反映后端重命名（不阻塞首屏）
    this.refreshHistoryNames();
  },

  onShow() {
    // 从 AR 等页面返回时刷新历史列表的选中态
    this.refreshHistory();
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

      // 默认清空：切换到无 workspace（或拉取失败）的 org 时，
      // 必须重置标题/副标题/footer，否则旧值会残留。
      const patch: Record<string, unknown> = {
        title: "",
        subtitle: "",
        showFooter: false,
      };
      if (
        orgRes &&
        orgRes.statusCode === 200 &&
        Array.isArray(orgRes.data) &&
        orgRes.data.length > 0
      ) {
        patch.title = orgRes.data[0].name;
        const cfg = orgRes.data[0].config;
        patch.showFooter =
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

      // 回填名称到历史记录（去重置顶），再刷新下拉列表
      recordScanHistory({
        organizationId: CONFIG.organizationId,
        workspaceId: CONFIG.workspaceId,
        orgName: (patch.title as string) || undefined,
        workspaceName: (patch.subtitle as string) || undefined,
      });
      this.refreshHistory();
    } catch (err) {
      console.error("[index] fetchNames error:", err);
      this.setData({ loaded: true });
      this.refreshHistory();
    }
  },

  /** 从 Storage 重新加载历史，构建展示用 label 与选中态 */
  refreshHistory() {
    const currentKey = `${CONFIG.organizationId || ""}|${CONFIG.workspaceId || ""}`;
    const history: HistoryItem[] = loadScanHistory().map((e) => {
      const org = e.orgName || "未命名组织";
      const label = e.workspaceName ? `${org} / ${e.workspaceName}` : org;
      return {
        ...e,
        label,
        active: `${e.organizationId || ""}|${e.workspaceId || ""}` === currentKey,
      };
    });
    this.setData({ history });
  },

  /**
   * 批量异步刷新历史记录的展示名称，反映后端重命名。
   * 仅用两次 `id=in.(…)` 请求覆盖全部历史，名称变化时写回 Storage 并重渲染。
   */
  async refreshHistoryNames() {
    const list = loadScanHistory();
    if (!list.length) return;

    const orgIds = [
      ...new Set(list.map((e) => e.organizationId).filter(Boolean)),
    ];
    const wsIds = [
      ...new Set(list.map((e) => e.workspaceId).filter(Boolean)),
    ] as string[];

    try {
      const [orgRes, wsRes] = await Promise.all([
        orgIds.length
          ? supabaseGet<{ id: string; name: string }[]>(
              "organization",
              `id=in.(${orgIds.join(",")})&select=id,name`,
            ).catch(() => null)
          : Promise.resolve(null),
        wsIds.length
          ? supabaseGet<{ id: string; name: string }[]>(
              "workspace",
              `id=in.(${wsIds.join(",")})&select=id,name`,
            ).catch(() => null)
          : Promise.resolve(null),
      ]);

      const orgMap: Record<string, string> = {};
      if (orgRes && orgRes.statusCode === 200 && Array.isArray(orgRes.data)) {
        orgRes.data.forEach((o) => (orgMap[o.id] = o.name));
      }
      const wsMap: Record<string, string> = {};
      if (wsRes && wsRes.statusCode === 200 && Array.isArray(wsRes.data)) {
        wsRes.data.forEach((w) => (wsMap[w.id] = w.name));
      }

      // 仅在确有名称变化时写回，避免无谓的 Storage 写入与重渲染。
      // 后端查不到（已删除）的条目保留旧名，不清空。
      let changed = false;
      const updated = list.map((e) => {
        const next = { ...e };
        const newOrg = orgMap[e.organizationId];
        if (newOrg && newOrg !== e.orgName) {
          next.orgName = newOrg;
          changed = true;
        }
        const newWs = e.workspaceId ? wsMap[e.workspaceId] : undefined;
        if (newWs && newWs !== e.workspaceName) {
          next.workspaceName = newWs;
          changed = true;
        }
        return next;
      });

      if (changed) {
        saveScanHistory(updated);
        this.refreshHistory();
      }
    } catch (err) {
      console.error("[index] refreshHistoryNames error:", err);
    }
  },

  toggleDropdown() {
    this.setData({ dropdownOpen: !this.data.dropdownOpen });
  },

  /** 选择一条历史记录，切换当前 org/workspace */
  onSelectHistory(e: WechatMiniprogram.TouchEvent) {
    const { org, ws } = e.currentTarget.dataset as {
      org: string;
      ws?: string;
    };
    this.setData({ dropdownOpen: false });
    if (org === CONFIG.organizationId && (ws || undefined) === CONFIG.workspaceId) {
      return; // 已是当前选中项，无需切换
    }
    // 复用 setConfig：写入内存 CONFIG 并持久化为当前扫码参数
    setConfig({ organizationId: org, workspaceId: ws });
    this.fetchNames();
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

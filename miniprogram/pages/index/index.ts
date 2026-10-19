import {
  setConfig,
  CONFIG,
  fetchOrganizations,
  fetchWorkspaces,
  fetchScenes,
  loadScanHistory,
  recordScanHistory,
  saveScanHistory,
  scanHistoryKey,
  ScanHistoryEntry,
} from "../../utils/backend";

/** 历史记录在下拉菜单中的展示形态 */
interface HistoryItem extends ScanHistoryEntry {
  key: string;
  kind: "Scene" | "Map";
  /** 列表展示文案，如「东明 / test」 */
  label: string;
  /** 是否为当前选中项 */
  active: boolean;
}

/** AR 体验依赖的授权 scope 及其展示名 */
const REQUIRED_SCOPES: { scope: string; label: string }[] = [
  { scope: "scope.userLocation", label: "位置" },
  { scope: "scope.camera", label: "相机" },
];

Page({
  data: {
    title: "",
    subtitle: "",
    loaded: false,
    showFooter: false,
    history: [] as HistoryItem[],
    dropdownOpen: false,
    /** 被用户明确拒绝的权限名称，如「位置、相机」；为空则不显示引导条 */
    deniedPermText: "",
    openingScene: false,
    isScene: false,
  },

  async onLoad(options: Record<string, string | undefined>) {
    setConfig(options);
    // 显式扫码优先；普通启动恢复缓存。select=1 可直接调试内容选择页。
    const entry = options.sceneId ? options : CONFIG;
    if (entry.sceneId && options.select !== "1") {
      this.setData({ openingScene: true });
      wx.navigateTo({
        url: `/pages/scene/scene?sceneId=${encodeURIComponent(entry.sceneId)}&organizationId=${encodeURIComponent(entry.organizationId || "")}`,
        success: () => {
          // 保留首页在页面栈中，Scene 只用系统返回键即可切换内容。
          this.setData({ openingScene: false });
          void this.fetchNames();
          void this.refreshHistoryNames();
        },
        fail: () => {
          this.setData({ openingScene: false });
          void this.fetchNames();
        },
      });
      return;
    }
    console.log("[index] parsed config:", CONFIG);
    await this.fetchNames();
    // 首屏渲染后异步刷新历史列表名称，反映后端重命名（不阻塞首屏）
    this.refreshHistoryNames();
  },

  onShow() {
    if (this.data.openingScene) return;
    // 从 AR 等页面返回时刷新历史列表的选中态
    this.refreshHistory();
    // 用户可能在 AR 页拒绝过授权，或从系统设置返回，每次展示都重查
    this.checkPermissions();
  },

  /**
   * 检查 AR 所需权限是否被用户明确拒绝过。
   * authSetting 中 undefined 表示从未询问（首次使用时会正常弹授权框），
   * 只有显式为 false 才需要引导去设置页——拒绝后 wx.authorize 不会再弹窗。
   */
  checkPermissions() {
    wx.getSetting({
      success: (res) => {
        const denied = REQUIRED_SCOPES.filter(
          (s) => res.authSetting[s.scope] === false,
        ).map((s) => s.label);
        this.setData({ deniedPermText: denied.join("、") });
      },
    });
  },

  /** 设置页返回后的回调：直接用返回的 authSetting 刷新引导条 */
  onOpenSetting(e: WechatMiniprogram.CustomEvent) {
    const authSetting =
      (e.detail && e.detail.authSetting) || ({} as Record<string, boolean>);
    const denied = REQUIRED_SCOPES.filter(
      (s) => authSetting[s.scope] === false,
    ).map((s) => s.label);
    this.setData({ deniedPermText: denied.join("、") });
    if (!denied.length) {
      wx.showToast({ title: "权限已开启", icon: "success" });
    }
  },

  async fetchNames() {
    const selected = { ...CONFIG };
    const cached = loadScanHistory().find((e) => scanHistoryKey(e) === scanHistoryKey(selected));
    try {
      // 并行拉取团队与内容名称，避免串行 await 阻塞首屏渲染。
      const orgPromise = selected.organizationId
        ? fetchOrganizations([selected.organizationId]).catch(() => null)
        : Promise.resolve(null);
      const wsPromise = selected.workspaceId
        ? fetchWorkspaces([selected.workspaceId]).catch(() => null)
        : Promise.resolve(null);
      const scenePromise = selected.sceneId && selected.organizationId
        ? fetchScenes([selected.sceneId], selected.organizationId).catch(() => null)
        : Promise.resolve(null);

      const [orgRes, wsRes, sceneRes] = await Promise.all([orgPromise, wsPromise, scenePromise]);
      if (scanHistoryKey(selected) !== scanHistoryKey(CONFIG)) return;

      // 只使用当前目标的缓存，切换时不能残留其他目标的标题或 footer。
      const patch: Record<string, unknown> = {
        title: cached?.orgName || "",
        subtitle: selected.sceneId ? cached?.sceneName || "场景名称暂不可用" : cached?.workspaceName || "",
        isScene: !!selected.sceneId,
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
            ? !selected.sceneId && !!(cfg as Record<string, unknown>).footer_enabled
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
      const sceneName = sceneRes?.statusCode === 200 && Array.isArray(sceneRes.data)
        ? sceneRes.data.find((s) => s.id === selected.sceneId)?.name
        : undefined;
      if (sceneName) patch.subtitle = sceneName;
      // 单次 setData 批量更新，减少 WXML diff
      this.setData({ ...patch, loaded: true });

      // 回填名称到历史记录（去重置顶），再刷新下拉列表
      recordScanHistory({
        ...selected,
        orgName: (patch.title as string) || undefined,
        workspaceName: selected.sceneId ? undefined : (patch.subtitle as string) || undefined,
        sceneName,
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
    const currentKey = scanHistoryKey(CONFIG);
    const history: HistoryItem[] = loadScanHistory().map((e) => {
      const org = e.orgName || "未命名组织";
      const label = e.sceneId
        ? e.sceneName || "场景名称暂不可用"
        : e.workspaceName || (e.workspaceId ? "地图名称暂不可用" : "全部地图");
      return {
        ...e,
        key: scanHistoryKey(e),
        kind: e.sceneId ? "Scene" : "Map",
        orgName: org,
        label,
        active: scanHistoryKey(e) === currentKey,
      };
    });
    this.setData({ history });
  },

  /**
   * 批量异步刷新历史记录的展示名称，反映后端重命名。
   * 团队和地图批量查询；Scene 按团队分组，名称变化时写回 Storage。
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
    const scenesByOrg = new Map<string, string[]>();
    list.forEach((e) => {
      if (e.sceneId) scenesByOrg.set(e.organizationId, [...(scenesByOrg.get(e.organizationId) || []), e.sceneId]);
    });

    try {
      const [orgRes, wsRes, sceneResults] = await Promise.all([
        orgIds.length
          ? fetchOrganizations(orgIds).catch(() => null)
          : Promise.resolve(null),
        wsIds.length
          ? fetchWorkspaces(wsIds).catch(() => null)
          : Promise.resolve(null),
        Promise.all([...scenesByOrg].map(async ([organizationId, ids]) => ({
          organizationId, response: await fetchScenes(ids, organizationId).catch(() => null),
        }))),
      ]);

      const orgMap: Record<string, string> = {};
      if (orgRes && orgRes.statusCode === 200 && Array.isArray(orgRes.data)) {
        orgRes.data.forEach((o) => (orgMap[o.id] = o.name));
      }
      const wsMap: Record<string, string> = {};
      if (wsRes && wsRes.statusCode === 200 && Array.isArray(wsRes.data)) {
        wsRes.data.forEach((w) => (wsMap[w.id] = w.name));
      }
      const sceneMap: Record<string, string> = {};
      sceneResults.forEach(({ organizationId, response }) => {
        if (response?.statusCode === 200 && Array.isArray(response.data)) {
          response.data.forEach((s) => (sceneMap[scanHistoryKey({ organizationId, sceneId: s.id })] = s.name));
        }
      });

      // 仅在确有名称变化时写回，避免无谓的 Storage 写入与重渲染。
      // 后端查不到（已删除）的条目保留旧名，不清空。
      let changed = false;
      const updated = loadScanHistory().map((e) => {
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
        const newScene = e.sceneId ? sceneMap[scanHistoryKey(e)] : undefined;
        if (newScene && newScene !== e.sceneName) {
          next.sceneName = newScene;
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

  /** 选择一条历史记录，切换当前场景或地图合集。 */
  onSelectHistory(e: WechatMiniprogram.TouchEvent) {
    const { org, ws, scene } = e.currentTarget.dataset as {
      org: string;
      ws?: string;
      scene?: string;
    };
    this.setData({ dropdownOpen: false });
    const next = { organizationId: org, workspaceId: ws, sceneId: scene };
    if (scanHistoryKey(next) === scanHistoryKey(CONFIG)) {
      return; // 已是当前选中项，无需切换
    }
    // 复用 setConfig：写入内存 CONFIG 并持久化为当前扫码参数
    setConfig(next);
    // 切换期间回到骨架态，避免旧组织/空间名残留
    this.setData({ loaded: false });
    this.fetchNames();
  },

  goToAR() {
    if (CONFIG.sceneId) {
      wx.navigateTo({ url: `/pages/scene/scene?sceneId=${encodeURIComponent(CONFIG.sceneId)}&organizationId=${encodeURIComponent(CONFIG.organizationId || "")}` });
      return;
    }
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

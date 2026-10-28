const { CONFIG, fetchActivities, fetchActivityRecords } = require("../../utils/backend");
const { acceptActivityDiscovery, isCurrentActivityDiscovery, nextActivityDiscoverySequence, parseActivityPlacements, validActivityLocation, withinActivityScope } = require("../../utils/activity-state");

const REFRESH_MS = 10000;
const recordRenderId = (id) => `activity:${id}`;

/** Activity records are fetched independently; only the final text rendering is shared with assets. */
module.exports = (XR_CONFIG) => ({
  async refreshActivityContent() {
    if (this._disposed || this._retrievalPaused || this._scenePreviewMode || this.retrievalMode !== "gps" || !this._arReady) return;
    const epoch = this._modeEpoch;
    if (this._activityFetch?.epoch === epoch) return;
    if (this._activityFetchEpoch === epoch && Date.now() < this._activityNextFetch) return;
    this._activityFetchEpoch = epoch;
    this._activityNextFetch = Date.now() + REFRESH_MS;
    const request = { epoch, revision: this._activityRevision || 0, discoverySequence: nextActivityDiscoverySequence() };
    this._activityFetch = request;
    const location = this.currentGPS;
    const current = () => !this._disposed && !this._retrievalPaused && epoch === this._modeEpoch &&
      this.retrievalMode === "gps" && request.revision === (this._activityRevision || 0) && isCurrentActivityDiscovery(request.discoverySequence);
    try {
      if (!CONFIG.organizationId || !validActivityLocation(location)) {
        this._replaceActivityRecords([]);
        return;
      }
      const response = await fetchActivities(CONFIG.workspaceId, CONFIG.organizationId);
      if (response.statusCode !== 200) throw new Error("活动加载失败");
      const activities = parseActivityPlacements(response.data, !CONFIG.workspaceId);
      if (!current()) return;
      if (!acceptActivityDiscovery(request.discoverySequence)) return;
      this.applyActivityAvailability(activities, request.discoverySequence);
      this.triggerEvent("activitiesload", { activities, discoverySequence: request.discoverySequence });
      const deployments = activities.filter((activity) => activity.type === "danmaku" && withinActivityScope(activity, location));
      const records = [];
      // Bound concurrent requests so a map with many activities cannot flood the native HTTP queue.
      for (let start = 0; start < deployments.length; start += 4) {
        const groups = await Promise.all(deployments.slice(start, start + 4).map(async (activity) => {
          try {
            const result = await fetchActivityRecords(activity.id, location, XR_CONFIG.maxDistanceMeters);
            if (result.statusCode !== 200 || !Array.isArray(result.data)) return [];
            return result.data.filter((record) => record && typeof record.id === "string" && record.activity_placement_id === activity.id &&
              record.activity_id === activity.activity_id && record.file_type === "text" && typeof record.text_content === "string" && validActivityLocation(record.metadata));
          } catch (error) {
            console.error("[活动留言] 读取失败:", error);
            return [];
          }
        }));
        if (!current()) return;
        for (const group of groups) records.push(...group);
      }
      if (current()) this._replaceActivityRecords(records);
    } catch (error) {
      if (!current()) return;
      acceptActivityDiscovery(request.discoverySequence);
      console.error("[活动] 刷新失败:", error);
      // A stale cached record must not stay visible after an activity is paused or hidden.
      this._replaceActivityRecords([]);
      this.triggerEvent("activitiesload", { activities: [], error: true, discoverySequence: request.discoverySequence });
    } finally {
      if (this._activityFetch === request) this._activityFetch = null;
    }
  },

  /** Remove unavailable deployments as soon as discovery settles, before other record requests finish. */
  applyActivityAvailability(activities, discoverySequence) {
    if (!isCurrentActivityDiscovery(discoverySequence)) return;
    const enabled = new Set(activities.filter((activity) => activity.type === "danmaku" && withinActivityScope(activity, this.currentGPS)).map((activity) => activity.id));
    const sources = this._activityRecordPlacements || new Map();
    this._removeActivityRecordIds(new Set([...(this._activityRecordIds || [])].filter((id) => !enabled.has(sources.get(id)))));
  },

  _replaceActivityRecords(records) {
    const mapped = records.map((record) => ({ ...record, id: recordRenderId(record.id), _activityRecordId: record.id }));
    const nextIds = new Set(mapped.map((record) => record.id));
    const previousIds = this._activityRecordIds || new Set();
    const removed = new Set([...previousIds].filter((id) => !nextIds.has(id)));
    this._removeActivityRecordIds(removed);
    this._activityRecordIds = nextIds;
    this._activityRecordPlacements = new Map(mapped.map((record) => [record.id, record.activity_placement_id]));
    this.displayAssets(mapped);
  },

  _removeActivityRecordIds(removed) {
    if (!removed.size) return;
    for (const id of removed) this._allowedAssetIds.delete(id);
    this._pendingDisplayAssets = (this._pendingDisplayAssets || []).filter((record) => !removed.has(record.id));
    this._placeQueue = (this._placeQueue || []).filter((record) => !removed.has(record.id));
    const removedNodes = new Set();
    this.nodeList = this.nodeList.filter((entry) => {
      if (!removed.has(entry.assetId)) return true;
      removedNodes.add(entry.node);
      this._destroyNode(entry);
      return false;
    });
    for (const id of removed) {
      this._seenAssets?.delete(id);
      this._activityRecordIds?.delete(id);
      this._activityRecordPlacements?.delete(id);
    }
    this.flyingDanmakus = (this.flyingDanmakus || []).filter((entry) => !removedNodes.has(entry.node));
  },
});

const config = require("./config");
const { CONFIG } = require("../../../utils/supabase");
const { captureCamera, removeTempFile } = require("./capture");
const matchLog = require("./log");

const reasons = {
  no_nearby_anchor: "附近没有匹配点，请走近预设地点",
  reference_not_ready: "参考图尚未就绪，请在管理端检查",
  model_version_mismatch: "参考图模型版本不一致，请重新提取特征",
  below_threshold: "未匹配，请将镜头朝向预设地点",
  ambiguous: "多个地点相似，请调整拍摄角度",
  reference_changed: "参考图已更新，正在重新确认",
};

function locate() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("定位超时，请检查定位权限")),
      12000,
    );
    wx.getLocation({
      type: "wgs84",
      isHighAccuracy: true,
      highAccuracyExpireTime: 3000,
      success: (res) => {
        clearTimeout(timer);
        resolve({ ...res, sampledAt: Date.now() });
      },
      fail: () => {
        clearTimeout(timer);
        reject(new Error("定位失败，请开启微信定位权限"));
      },
    });
  });
}

module.exports = {
  _recognitionStatus(message) {
    matchLog("状态", { mode: this.retrievalMode, message });
    if (!this._disposed)
      this.triggerEvent("recognitionstatus", {
        mode: this.retrievalMode,
        message,
      });
  },

  _clearRemoteAssets() {
    this._contentEpoch++;
    for (const ctx of this._pendingAudioContexts || []) {
      try {
        ctx.stop();
        ctx.destroy();
      } catch (_) {}
    }
    this._pendingAudioContexts?.clear();
    this._allowedAssetIds.clear();
    this._placeQueue = [];
    this._pendingDisplayAssets = [];
    this.nodeList = this.nodeList.filter((entry) => {
      if (entry.assetId == null) return true;
      this._destroyNode(entry);
      return false;
    });
    for (const entry of this._hugeNodeList || []) {
      try {
        this.shadowRoot?.removeChild(entry.node);
      } catch (_) {}
    }
    this._hugeNodeList = [];
    this._pendingHugeAssets = [];
    this._hugePlaceQueue = [];
    this._seenAssets.clear();
    this._firstRevealDone = false;
    this._matchedAnchorId = null;
  },

  _cancelRetrieval() {
    matchLog("取消当前识别", {
      mode: this.retrievalMode,
      uploadInFlight: !!this._uploadTask,
      confirmationCount: this._candidateCount || 0,
    });
    this._modeEpoch++;
    this._uploadTask?.abort();
    this._uploadTask = null;
    this._recognizing = false;
    this.isFetchingAssets = false;
    this._isFetchingHuge = false;
    this._candidateAnchor = null;
    this._candidateCount = 0;
    this._nextRecognitionAt = 0;
  },

  setRetrievalMode(mode) {
    if (
      !["gps", "anchor"].includes(mode) ||
      this.retrievalMode === mode ||
      this._disposed
    )
      return;
    matchLog("切换模式", { from: this.retrievalMode, to: mode });
    this._cancelRetrieval();
    this._clearRemoteAssets();
    this.retrievalMode = mode;
    this._recognitionStatus(
      mode === "anchor" ? "等待 AR 相机就绪" : "根据附近位置直接显示素材",
    );
    if (mode === "anchor") this.recognizeAnchor();
    else if (this._arReady) {
      this.fetchNearbyAssets();
      this.fetchHugeAssets();
    }
  },

  pauseRetrieval() {
    matchLog("暂停识别", { mode: this.retrievalMode });
    this._retrievalPaused = true;
    this._cancelRetrieval();
    this._clearRemoteAssets();
  },

  resumeRetrieval() {
    if (!this._retrievalPaused || this._disposed) return;
    matchLog("恢复识别", { mode: this.retrievalMode, arReady: !!this._arReady });
    this._retrievalPaused = false;
    if (this._arReady) {
      this.fetchNearbyAssets();
      this.fetchHugeAssets();
    }
  },

  async recognizeAnchor() {
    // This entry can run every frame: report AR readiness once, not every tick.
    if (this.retrievalMode === "anchor" && !this._disposed && !this._retrievalPaused && !this._arReady) {
      if (!this._loggedWaitingForAr) matchLog("等待 AR 相机就绪");
      this._loggedWaitingForAr = true;
    } else {
      this._loggedWaitingForAr = false;
    }
    if (
      this.retrievalMode !== "anchor" ||
      this._disposed ||
      this._retrievalPaused ||
      this._recognizing ||
      !this._arReady ||
      Date.now() < this._nextRecognitionAt
    )
      return;
    const base = config.apiBaseUrl.replace(/\/+$/, "");
    if (!/^https:\/\/[^/]+$/.test(base) || !CONFIG.workspaceId) {
      matchLog("配置不完整，无法发起识别", {
        validApiOrigin: /^https:\/\/[^/]+$/.test(base),
        workspaceConfigured: !!CONFIG.workspaceId,
      }, "warn");
      this._recognitionStatus(
        !CONFIG.workspaceId ? "请先选择具体空间" : "请配置匹配服务地址",
      );
      this._nextRecognitionAt = Infinity;
      return;
    }
    const epoch = this._modeEpoch;
    const startedAt = Date.now();
    this._recognitionSequence = (this._recognitionSequence || 0) + 1;
    const requestId = `${startedAt.toString(36)}-${this._recognitionSequence}`;
    const log = (event, fields = {}, level = "info") =>
      matchLog(event, { elapsedMs: Date.now() - startedAt, ...fields }, level, requestId);
    let phase = "gps";
    let outcome = "pending";
    log("开始识别", {
      workspaceId: CONFIG.workspaceId,
      timeoutMs: config.timeoutMs,
      requiredConfirmations: config.confirmationCount,
    });
    const current = () =>
      !this._disposed && !this._retrievalPaused && this._modeEpoch === epoch;
    this._recognizing = true;
    let filePath;
    let retryDelay = config.intervalMs;
    try {
      this._recognitionStatus("正在定位…");
      const gps = await locate();
      if (!current()) return;
      log("定位完成", { accuracyMeters: gps.accuracy, gpsAgeMs: Date.now() - gps.sampledAt });
      if (
        !Number.isFinite(gps.accuracy) ||
        gps.accuracy < 0 ||
        gps.accuracy > 100
      )
        throw new Error("定位精度不足，请移至开阔处");
      this.updateGPS(gps);
      this._recognitionStatus("正在识别，请将镜头朝向预设地点…");
      phase = "capture";
      const captureStartedAt = Date.now();
      filePath = await captureCamera(this.scene);
      if (!current()) return;
      log("相机取图完成", { captureMs: Date.now() - captureStartedAt });
      phase = "upload";
      const uploadStartedAt = Date.now();
      log("上传识别请求", { path: "/api/miniapp/anchors/recognize" });
      const result = await new Promise((resolve, reject) => {
        this._uploadTask = wx.uploadFile({
          url: `${base}/api/miniapp/anchors/recognize?workspace_id=${encodeURIComponent(CONFIG.workspaceId)}`,
          filePath,
          name: "image",
          timeout: config.timeoutMs,
          formData: {
            latitude: String(gps.latitude),
            longitude: String(gps.longitude),
            accuracy: String(gps.accuracy),
            gps_timestamp: String(gps.sampledAt),
            coordinate_system: "wgs84",
          },
          success: (res) => {
            if (!current()) {
              log("忽略过期响应", { httpStatus: res.statusCode });
            }
            log("收到 HTTP 响应", {
              httpStatus: res.statusCode,
              uploadRoundtripMs: Date.now() - uploadStartedAt,
            }, res.statusCode === 200 ? "info" : "warn");
            if (res.statusCode !== 200) {
              const messages = {
                401: "识别接口应开放访问，请检查管理端部署版本",
                403: "识别接口被拒绝访问，请检查管理端部署或网关",
                429: "识别请求过多，稍后重试",
                503: "匹配服务尚未就绪",
              };
              if (res.statusCode === 429) retryDelay = 60000;
              reject(
                new Error(
                  messages[res.statusCode] ||
                    `识别服务异常（${res.statusCode}）`,
                ),
              );
              return;
            }
            try {
              const body = JSON.parse(res.data);
              if (
                !body.data ||
                typeof body.data.matched !== "boolean" ||
                !Array.isArray(body.data.assets)
              )
                throw new Error();
              resolve(body.data);
            } catch (_) {
              log("响应格式异常", { httpStatus: res.statusCode }, "warn");
              reject(new Error("匹配服务返回格式异常"));
            }
          },
          fail: (error) => {
            const message = String(error?.errMsg || "");
            log("上传失败", {
              kind: /abort/i.test(message) ? "aborted" : /timeout/i.test(message) ? "timeout" : "network_or_domain",
              uploadRoundtripMs: Date.now() - uploadStartedAt,
              stale: !current(),
            }, current() ? "warn" : "info");
            reject(new Error("识别请求失败，请检查网络及上传域名配置"));
          },
        });
      });
      if (!current()) return;
      phase = "match";
      log("匹配结果", {
        matched: result.matched,
        reason: result.reason || null,
        reasonText: reasons[result.reason] || null,
        anchorId: result.anchor?.id || null,
        anchorName: result.anchor?.name || null,
        cosineSimilarity: result.anchor?.cosine_similarity ?? null,
        distanceMeters: result.anchor?.distance_meters ?? null,
        gpsRadiusMeters: result.gps_radius_meters ?? null,
        assetCount: result.assets.length,
        embeddingVersion: result.embedding_version || null,
      });
      if (!result.matched || !result.anchor?.id) {
        outcome = "not_matched";
        log("未确认匹配，重置连续确认", { previousCount: this._candidateCount || 0 });
        this._candidateAnchor = null;
        this._candidateCount = 0;
        this._clearRemoteAssets();
        this._recognitionStatus(
          reasons[result.reason] || "未匹配，请调整拍摄位置",
        );
        return;
      }
      const anchorId = result.anchor.id;
      if (this._candidateAnchor !== anchorId) {
        log("候选匹配点变化", { previousAnchorId: this._candidateAnchor || null, anchorId });
        this._candidateAnchor = anchorId;
        this._candidateCount = 0;
        this._clearRemoteAssets();
      }
      this._candidateCount++;
      log("连续确认", {
        anchorId,
        count: this._candidateCount,
        required: config.confirmationCount,
        confirmed: this._candidateCount >= config.confirmationCount,
      });
      if (this._candidateCount < config.confirmationCount) {
        outcome = "awaiting_confirmation";
        this._recognitionStatus("发现匹配点，请保持朝向，再确认一次…");
        return;
      }
      // 匹配点触发的模型按普通近景素材展示；不走全空间巨型模型 GPS 通道。
      const assets = result.assets.filter(
        (a) =>
          a &&
          ["text", "image", "model", "audio", "video"].includes(a.file_type),
      );
      const incomingIds = new Set(assets.map((a) => a.id));
      this._allowedAssetIds = incomingIds;
      this._pendingDisplayAssets = (this._pendingDisplayAssets || []).filter(
        (a) => incomingIds.has(a.id),
      );
      this._placeQueue = (this._placeQueue || []).filter((a) =>
        incomingIds.has(a.id),
      );
      this.nodeList = this.nodeList.filter((entry) => {
        if (entry.assetId == null || incomingIds.has(entry.assetId))
          return true;
        this._destroyNode(entry);
        return false;
      });
      this._matchedAnchorId = anchorId;
      phase = "display";
      this.displayAssets(assets);
      outcome = "confirmed";
      log("已交给 AR 素材展示队列", {
        anchorId,
        acceptedAssetCount: assets.length,
        unsupportedAssetCount: result.assets.length - assets.length,
      });
      this._recognitionStatus(
        `已匹配：${result.anchor.name || "匹配点"} · ${assets.length} 个素材`,
      );
    } catch (error) {
      if (!current()) return;
      outcome = "error";
      log("识别失败", { phase, message: error.message || "未知错误" }, "error");
      this._candidateAnchor = null;
      this._candidateCount = 0;
      this._clearRemoteAssets();
      this._recognitionStatus(error.message || "识别失败，请稍后重试");
    } finally {
      removeTempFile(filePath);
      log("本轮结束", {
        outcome: current() ? outcome : "cancelled",
        nextAttemptAfterMs: current() ? retryDelay : null,
      });
      if (current()) {
        this._recognizing = false;
        this._uploadTask = null;
        this._nextRecognitionAt = Date.now() + retryDelay;
      }
    }
  },
};

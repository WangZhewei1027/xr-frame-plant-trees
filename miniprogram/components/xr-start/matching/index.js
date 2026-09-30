const config = require("./config");
const { CONFIG } = require("../../../utils/supabase");
const { captureCamera, isCaptureBusy, removeTempFile, createCaptureTiming, disposeCapture } = require("./capture");
const matchLog = require("./log");

const SERVER_STAGES = ["request_parse_ms", "validation_ms", "rate_limit_ms",
  "gps_query_ms", "reference_read_ms", "database_context_ms", "database_finalize_ms",
  "model_request_ms", "model_queue_ms", "model_decode_ms", "model_inference_ms", "model_service_total_ms",
  "ranking_ms", "candidate_recheck_ms", "assets_read_ms", "matching_total_ms", "api_total_ms"];
function safeLabel(value, limit = 100) {
  return typeof value === "string" && value.length <= limit && /^[a-zA-Z0-9._:-]+$/.test(value) ? value : null;
}
function serverStages(diagnostics) {
  if (!diagnostics?.timings_ms) return null;
  const result = {};
  for (const key of SERVER_STAGES) {
    const value = diagnostics.timings_ms[key];
    result[key] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return result;
}
function diagnosticMeta(diagnostics) {
  return {
    serverRequestId: safeLabel(diagnostics?.request_id),
    upstreamRequestId: safeLabel(diagnostics?.upstream_request_id),
    edgeRegion: safeLabel(diagnostics?.edge_region),
    modelDevice: safeLabel(diagnostics?.model_device),
    modelCode: safeLabel(diagnostics?.model_code),
    upstreamStatus: Number.isInteger(diagnostics?.upstream_status) ? diagnostics.upstream_status : null,
  };
}
function responseMeta(headers = {}) {
  const values = {};
  for (const key of Object.keys(headers)) values[key.toLowerCase()] = headers[key];
  return {
    serverRequestId: safeLabel(values["x-recognition-request-id"]),
    edgeRegion: safeLabel(values["x-sb-edge-region"]),
    platformRequestId: safeLabel(values["sb-request-id"] || values["x-vercel-id"], 200),
  };
}

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
  ...createCaptureTiming(config),
  disposeRecognitionCapture() {
    disposeCapture(this.scene);
  },

  clearRecognitionFrame() {
    removeTempFile(this._recognitionFrame?.path);
    this._recognitionFrame = null;
    if (!this._disposed) this.triggerEvent("recognitionframe", { path: "" });
  },

  _retainRecognitionFrame(filePath, info, result, requestId) {
    if (!config.debugFramePreview) return;
    const previous = this._recognitionFrame?.path;
    this._recognitionFrame = {
      path: filePath, requestId, ...info,
      bestSimilarity: result.diagnostics?.best_similarity ?? result.anchor?.cosine_similarity ?? null,
      threshold: result.diagnostics?.threshold ?? null,
    };
    if (previous && previous !== filePath) removeTempFile(previous);
    this.triggerEvent("recognitionframe", this._recognitionFrame);
  },

  _recognitionStatus(message) {
    matchLog("状态", { mode: this.retrievalMode, message });
    if (!this._disposed)
      this.triggerEvent("recognitionstatus", {
        mode: this.retrievalMode,
        message,
      });
  },

  _clearRemoteAssets() {
    this._recognitionTiming = null;
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
    const clearedNodeCount = this.nodeList.length;
    for (const entry of this.nodeList) this._destroyNode(entry);
    this.nodeList = [];
    this.flyingDanmakus = [];
    this.stopRandomConfetti?.();
    matchLog("清空场景素材", { clearedNodeCount, hugeNodeCount: this._hugeNodeList?.length || 0 });
    for (const entry of this._hugeNodeList || []) this._destroyNode(entry);
    this._hugeNodeList = [];
    this._pendingHugeAssets = [];
    this._hugePlaceQueue = [];
    this._seenAssets.clear();
    this._firstRevealDone = false;
    this._matchedAnchorId = null;
    // 兜底回收此前构建异常留下的、未能登记的动态根节点。
    const orphans = this.shadowRoot?.getChildrenByFilter?.(() => true) || [];
    for (const node of orphans) this._destroyNode({ node });
    if (orphans.length) matchLog("清理未登记场景节点", { count: orphans.length });
  },

  _stopRecognitionRequests(exceptId) {
    for (const [id, request] of this._recognitionRequests || []) {
      if (id === exceptId) continue;
      request.cancelled = true;
      try { request.uploadTask?.abort(); } catch (_) {}
      request.rejectUpload?.(new Error("识别已取消"));
      this._recognitionRequests.delete(id);
    }
    this._recognizing = !!this._recognitionRequests?.size;
  },

  _cancelRetrieval() {
    matchLog("取消当前识别", {
      mode: this.retrievalMode,
      inFlightCount: this._recognitionRequests?.size || 0,
    });
    this._modeEpoch++;
    this._stopRecognitionRequests();
    this.isFetchingAssets = false;
    this._isFetchingHuge = false;
    this._nextRecognitionAt = 0;
    this._lastCaptureStartedAt = null;
    this._lastRecognitionResultSequence = 0;
    this._recognitionGPS = null;
    this._recognitionGPSRequest = null;
    this.resetCaptureTiming();
  },

  restartRecognitionAfterMovement(movement) {
    if (this.retrievalMode !== "anchor" || this._retrievalPaused || this._disposed) return;
    matchLog("移动后重新识别", {
      ...movement,
      distanceThresholdMeters: config.restartDistanceMeters,
      prepareMs: config.initialCaptureDelayMs,
    });
    this._cancelRetrieval();
    this._clearRemoteAssets();
    this._recognitionStatus("已移动，3 秒后重新识别…");
  },

  _locateForRecognition(epoch) {
    if (this._recognitionGPS && Date.now() - this._recognitionGPS.sampledAt < (config.gpsCacheMs ?? 5000)) {
      return Promise.resolve(this._recognitionGPS);
    }
    if (this._recognitionGPSRequest?.epoch === epoch) return this._recognitionGPSRequest.promise;
    const request = { epoch };
    request.promise = locate().then((gps) => {
      if (this._modeEpoch === epoch && !this._disposed && !this._retrievalPaused) this._recognitionGPS = gps;
      return gps;
    }).finally(() => {
      if (this._recognitionGPSRequest === request) this._recognitionGPSRequest = null;
    });
    this._recognitionGPSRequest = request;
    return request.promise;
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
    this.clearRecognitionFrame();
    this.retrievalMode = mode;
    this.setData({ retrievalMode: mode });
    if (mode === "gps") this._maybeStartConfetti?.();
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
    this._maybeStartConfetti?.();
    this.resetCaptureTiming();
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
      isCaptureBusy(this.scene) ||
      (this._recognitionRequests?.size || 0) >= (config.maxInFlightRequests ?? 6) ||
      !this._arReady ||
      Date.now() < this._nextRecognitionAt
    )
      return;
    const base = config.apiBaseUrl.replace(/\/+$/, "");
    const apiPath = config.apiPath || "/api/miniapp/anchors/recognize";
    if (!/^https:\/\/[^/]+$/.test(base) || !/^\/[a-zA-Z0-9/_-]+$/.test(apiPath) || !CONFIG.workspaceId) {
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
    this.sampleCaptureMotion(this.getCamTransform?.(), Date.now(), true);
    if (!this.captureAllowed()) return;
    const epoch = this._modeEpoch;
    const startedAt = Date.now();
    this._recognitionSequence = (this._recognitionSequence || 0) + 1;
    const sequence = this._recognitionSequence;
    const requestId = `${startedAt.toString(36)}-${sequence}`;
    const request = { sequence, cancelled: false, uploadTask: null, rejectUpload: null };
    if (!this._recognitionRequests) this._recognitionRequests = new Map();
    this._recognitionRequests.set(requestId, request);
    this._nextRecognitionAt = startedAt + config.intervalMs;
    const log = (event, fields = {}, level = "info") =>
      matchLog(event, { elapsedMs: Date.now() - startedAt, ...fields }, level, requestId);
    let phase = "gps";
    let outcome = "pending";
    log("开始识别", {
      workspaceId: CONFIG.workspaceId,
      timeoutMs: config.timeoutMs,
      inFlightCount: this._recognitionRequests.size,
      intervalMs: config.intervalMs,
    });
    const current = () =>
      !this._disposed && !this._retrievalPaused && this._modeEpoch === epoch && !request.cancelled;
    this._recognizing = true;
    let filePath;
    let frameInfo = {};
    let retryDelay = null;
    let captureStartedAt = null;
    let uploadStartedAt = null;
    let resultStartedAt = null;
    let matchedAt = null;
    let actualCaptureIntervalMs = null;
    let httpStatus = null;
    let serverTimingsMs = null;
    let serviceMeta = {};
    const timingsMs = {
      gpsMs: null, captureMs: null, uploadRoundtripMs: null, responseParseMs: null,
      resultHandlingMs: null, sceneClearMs: null, displayDispatchMs: null,
    };
    const gpsSource = this._recognitionGPS &&
      startedAt - this._recognitionGPS.sampledAt < (config.gpsCacheMs ?? 5000)
      ? "cache" : this._recognitionGPSRequest?.epoch === epoch ? "shared" : "fresh";
    const clearScene = () => {
      const at = Date.now();
      try { this._clearRemoteAssets(); }
      finally { timingsMs.sceneClearMs = (timingsMs.sceneClearMs ?? 0) + Date.now() - at; }
    };
    const parseResponse = (data) => {
      const at = Date.now();
      try { return JSON.parse(data); }
      finally { timingsMs.responseParseMs = Date.now() - at; }
    };
    try {
      this._recognitionStatus("正在定位…");
      const gpsStartedAt = Date.now();
      let gps;
      try { gps = await this._locateForRecognition(epoch); }
      finally { timingsMs.gpsMs = Date.now() - gpsStartedAt; }
      if (!current()) return;
      log("定位完成", {
        accuracyMeters: gps.accuracy, gpsAgeMs: Date.now() - gps.sampledAt,
        gpsMs: timingsMs.gpsMs, gpsSource,
      });
      if (
        !Number.isFinite(gps.accuracy) ||
        gps.accuracy < 0 ||
        gps.accuracy > 100
      )
        throw new Error("定位精度不足，请移至开阔处");
      this.updateGPS(gps);
      // GPS 共用请求恢复时，不让多个等待者同时抓取同一瞬间的画面。
      const captureSlotAt = Date.now();
      if (isCaptureBusy(this.scene) ||
          (this._lastCaptureStartedAt != null && captureSlotAt - this._lastCaptureStartedAt < config.intervalMs)) {
        outcome = "capture_slot_skipped";
        return;
      }
      captureStartedAt = captureSlotAt;
      actualCaptureIntervalMs = this._lastCaptureStartedAt == null ? null : captureStartedAt - this._lastCaptureStartedAt;
      this._lastCaptureStartedAt = captureStartedAt;
      log("开始取图", {
        targetIntervalMs: config.intervalMs, actualCaptureIntervalMs,
        intervalOverrunMs: actualCaptureIntervalMs == null ? null : Math.max(0, actualCaptureIntervalMs - config.intervalMs),
        inFlightCount: this._recognitionRequests.size,
      });
      this._nextRecognitionAt = Math.max(this._nextRecognitionAt, captureStartedAt + config.intervalMs);
      this._recognitionStatus("正在识别，请将镜头朝向预设地点…");
      phase = "capture";
      try { filePath = await captureCamera(this.scene, (info) => { frameInfo = info; }, current); }
      finally { timingsMs.captureMs = Date.now() - captureStartedAt; }
      if (!current()) return;
      log("相机取图完成", { captureMs: timingsMs.captureMs, ...frameInfo });
      phase = "upload";
      uploadStartedAt = Date.now();
      log("上传识别请求", { origin: base, path: apiPath, functionRegion: config.functionRegion || "auto" });
      const result = await new Promise((resolve, reject) => {
        request.rejectUpload = reject;
        request.uploadTask = wx.uploadFile({
          url: `${base}${apiPath}?workspace_id=${encodeURIComponent(CONFIG.workspaceId)}`,
          header: {
            "X-Recognition-Request-Id": requestId,
            ...(config.functionRegion ? { "x-region": config.functionRegion } : {}),
          },
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
            httpStatus = res.statusCode;
            serviceMeta = responseMeta(res.header);
            timingsMs.uploadRoundtripMs = Date.now() - uploadStartedAt;
            if (!current()) {
              log("忽略过期响应", { httpStatus: res.statusCode });
            }
            log("收到 HTTP 响应", {
              httpStatus: res.statusCode,
              ...serviceMeta,
              uploadRoundtripMs: Date.now() - uploadStartedAt,
            }, res.statusCode === 200 ? "info" : "warn");
            if (res.statusCode !== 200) {
              const messages = {
                401: "识别接口需要开放访问，请检查 Edge Function 的 JWT 配置",
                403: "识别接口被拒绝访问，请检查服务网关",
                429: "识别请求过多，稍后重试",
                503: "匹配服务尚未就绪",
              };
              let serverMessage = "";
              let serverCode = null;
              let serverRetryMs = null;
              try {
                const body = parseResponse(res.data);
                serverCode = safeLabel(body?.code);
                serverTimingsMs = serverStages(body?.diagnostics);
                const meta = diagnosticMeta(body?.diagnostics);
                for (const key of Object.keys(meta)) if (meta[key] !== null) serviceMeta[key] = meta[key];
                if (safeLabel(body?.request_id)) serviceMeta.serverRequestId = safeLabel(body.request_id);
                if (Number.isFinite(body?.retry_after_ms) && body.retry_after_ms > 0) serverRetryMs = body.retry_after_ms;
                if (typeof body?.error === "string") {
                  serverMessage = body.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
                }
              } catch (_) {
                // Proxy HTML/errors must retain a readable fallback.
              }
              log("服务端拒绝识别", {
                httpStatus: res.statusCode,
                serverMessage: serverMessage || null,
                code: serverCode,
                ...serviceMeta,
                timingsMs: serverTimingsMs,
              }, "warn");
              if (res.statusCode === 429) {
                const header = res.header || {};
                const retryKey = Object.keys(header).find(key => key.toLowerCase() === "retry-after");
                const headerMs = retryKey ? Number(header[retryKey]) * 1000 : NaN;
                const fallback = ["model_busy", "model_queue_full", "model_queue_timeout"].includes(serverCode) ? 1000 : 60000;
                // 兼容旧部署：没有明确错误码时按工作空间配额退避。
                retryDelay = Math.min(60000, Math.max(1000,
                  serverRetryMs ?? (serverCode && Number.isFinite(headerMs) && headerMs > 0 ? headerMs : fallback)));
              } else if (serverRetryMs !== null) {
                // 结构化 502/504 等错误也可给出短暂退避；缺失/无效时沿用默认错误间隔。
                retryDelay = Math.min(60000, Math.max(1000, serverRetryMs));
              }
              reject(
                new Error(
                  serverMessage || messages[res.statusCode] ||
                    `识别服务异常（${res.statusCode}）`,
                ),
              );
              return;
            }
            try {
              const body = parseResponse(res.data);
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
            timingsMs.uploadRoundtripMs = Date.now() - uploadStartedAt;
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
      if (sequence < (this._lastRecognitionResultSequence || 0)) {
        outcome = "stale_result";
        log("忽略乱序旧结果", { sequence, lastAppliedSequence: this._lastRecognitionResultSequence });
        return;
      }
      this._lastRecognitionResultSequence = sequence;
      const resultMeta = diagnosticMeta(result.diagnostics);
      for (const key of Object.keys(resultMeta)) if (resultMeta[key] !== null) serviceMeta[key] = resultMeta[key];
      if (safeLabel(result.request_id)) serviceMeta.serverRequestId = safeLabel(result.request_id);
      resultStartedAt = Date.now();
      phase = "match";
      this._retainRecognitionFrame(filePath, frameInfo, result, requestId);
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
      if (result.diagnostics) {
        const d = result.diagnostics;
        const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
        const timingsMs = serverStages(d);
        serverTimingsMs = timingsMs;
        log("匹配诊断", {
          ...serviceMeta,
          candidateCount: number(d.candidate_count),
          readyReferenceCount: number(d.ready_reference_count),
          threshold: number(d.threshold),
          requiredMargin: number(d.required_margin),
          bestSimilarity: number(d.best_similarity),
          secondSimilarity: number(d.second_similarity),
          scoreGap: number(d.score_gap),
          bestDistanceMeters: number(d.best_distance_meters),
          timingsMs,
        });
      }
      if (!result.matched || !result.anchor?.id) {
        outcome = "not_matched";
        clearScene();
        this._recognitionStatus(
          reasons[result.reason] || "未匹配，请调整拍摄位置",
        );
        return;
      }
      const anchorId = result.anchor.id;
      matchedAt = Date.now();
      clearScene();
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
        if (incomingIds.has(entry.assetId)) return true;
        this._destroyNode(entry);
        return false;
      });
      this._matchedAnchorId = anchorId;
      this._recognitionTiming = {
        requestId, startedAt, captureStartedAt, matchedAt, anchorId,
        contentEpoch: this._contentEpoch,
      };
      phase = "display";
      const displayStartedAt = Date.now();
      try { this.displayAssets(assets); }
      finally { timingsMs.displayDispatchMs = Date.now() - displayStartedAt; }
      this.lockCaptureForMatch();
      this._nextRecognitionAt = Infinity;
      this._stopRecognitionRequests(requestId);
      outcome = "matched_locked";
      log("匹配成功，停止取图", {
        anchorId,
        restartDistanceMeters: config.restartDistanceMeters,
      });
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
      if (sequence < (this._lastRecognitionResultSequence || 0)) {
        outcome = "stale_error";
        return;
      }
      // 请求失败不能证明新画面未命中，不能淘汰仍在推理的较早成功结果。
      outcome = "error";
      if (retryDelay === null) retryDelay = config.errorRetryMs ?? 5000;
      log("识别失败", { phase, message: error.message || "未知错误" }, "error");
      clearScene();
      this._recognitionStatus(error.message || "识别失败，请稍后重试");
    } finally {
      const finishedAt = Date.now();
      if (resultStartedAt !== null) timingsMs.resultHandlingMs = finishedAt - resultStartedAt;
      // 上传主动取消或同步抛错时没有网络回调，只能记录本地等待到结束的时间。
      if (uploadStartedAt !== null && timingsMs.uploadRoundtripMs === null) {
        timingsMs.uploadRoundtripMs = finishedAt - uploadStartedAt;
      }
      const captureStagesMs = {};
      for (const key of ["rawReadMs", "geometryPrepareMs", "snapshotMs", "canvasPrepareMs", "gpuInitMs", "gpuAttemptMs", "gpuUploadMs", "gpuDrawReadMs",
        "convertMs", "convertWorkMs", "convertYieldWaitMs", "maxConvertSliceMs", "canvasWriteMs", "jpegExportMs"]) {
        captureStagesMs[key] = Number.isFinite(frameInfo[key]) ? frameInfo[key] : null;
      }
      const serverTotalMs = serverTimingsMs?.api_total_ms;
      // 差值还含路由、序列化和回调等开销，不能标为纯网络时间。
      const overheadEstimateMs = Number.isFinite(serverTotalMs) && serverTotalMs >= 0 &&
        Number.isFinite(timingsMs.uploadRoundtripMs) && timingsMs.uploadRoundtripMs >= serverTotalMs
        ? timingsMs.uploadRoundtripMs - serverTotalMs : null;
      log("识别耗时汇总", {
        outcome: current() ? outcome : "cancelled", phase, httpStatus, gpsSource,
        ...serviceMeta,
        targetIntervalMs: config.intervalMs, actualCaptureIntervalMs,
        captureToMatchMs: matchedAt !== null && captureStartedAt !== null ? matchedAt - captureStartedAt : null,
        clientTimingsMs: { ...timingsMs, totalMs: finishedAt - startedAt },
        pixelConverter: frameInfo.pixelConverter || null, gpuFallbackReason: frameInfo.gpuFallbackReason || null,
        captureStagesMs, serverTimingsMs, transportAndPlatformEstimateMs: overheadEstimateMs,
      });
      if (filePath !== this._recognitionFrame?.path) removeTempFile(filePath);
      request.rejectUpload = null;
      if (this._recognitionRequests?.get(requestId) === request) this._recognitionRequests.delete(requestId);
      if (current() && outcome === "error" && retryDelay !== null) {
        this._nextRecognitionAt = Math.max(this._nextRecognitionAt, Date.now() + retryDelay);
      }
      this._recognizing = !!this._recognitionRequests?.size;
      log("本轮结束", {
        outcome: current() ? outcome : "cancelled",
        inFlightCount: this._recognitionRequests?.size || 0,
        nextAttemptAfterMs: current() && Number.isFinite(this._nextRecognitionAt)
          ? Math.max(0, this._nextRecognitionAt - Date.now()) : null,
      });
    }
  },
};

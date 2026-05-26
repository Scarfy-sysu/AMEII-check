const els = {
  healthBadge: document.getElementById("healthBadge"),
  btnSettings: document.getElementById("btnSettings"),
  settingsPopover: document.getElementById("settingsPopover"),
  themeAutoToggle: document.getElementById("themeAutoToggle"),
  previewModeToggle: document.getElementById("previewModeToggle"),
  themeModeTag: document.getElementById("themeModeTag"),
  cameraSupport: document.getElementById("cameraSupport"),
  btnDetectCameras: document.getElementById("btnDetectCameras"),
  cameraSelect: document.getElementById("cameraSelect"),
  btnTogglePreview: document.getElementById("btnTogglePreview"),
  btnRotate90: document.getElementById("btnRotate90"),
  btnMirrorX: document.getElementById("btnMirrorX"),
  autoStopCountdown: document.getElementById("autoStopCountdown"),
  cameraPreview: document.getElementById("cameraPreview"),
  overlayCanvas: document.getElementById("overlayCanvas"),
  wsModeStatus: document.getElementById("wsModeStatus"),
  serverPreviewStatus: document.getElementById("serverPreviewStatus"),
  netSpeedTag: document.getElementById("netSpeedTag"),
  pendingBody: document.getElementById("pendingBody"),
  onlineBody: document.getElementById("onlineBody"),
  onlineTable: document.getElementById("onlineTable"),
  onlineModeToggle: document.getElementById("onlineModeToggle"),
  onlineDeckWrap: document.getElementById("onlineDeckWrap"),
  onlineDeckViewport: document.getElementById("onlineDeckViewport"),
  btnRefreshRecords: document.getElementById("btnRefreshRecords"),
  recordsBody: document.getElementById("recordsBody"),
  logBox: document.getElementById("logBox"),
  invalidReasonToast: document.getElementById("invalidReasonToast"),
  invalidReasonText: document.getElementById("invalidReasonText"),
  cameraMainCard: document.querySelector(".camera-main"),
  rightStack: document.querySelector(".right-stack"),
  pendingSideCard: document.querySelector(".pending-side"),
  onlineSideCard: document.querySelector(".online-side"),
};

let previewStream = null;
let wsModeSocket = null;
let wsModeTimer = null;
let wsSendBusy = false;
let wsSendStartedAt = 0;
let wsFailStreak = 0;
let switchingToHttp = false;
let previewAutoStopTimer = null;
let previewAutoStopTickTimer = null;
let previewAutoStopDeadlineMs = 0;

const PREVIEW_AUTO_STOP_MS = 5 * 60 * 1000;

let wsShouldRun = false;
let wsConnectWatchdog = null;
let wsResultWatchdog = null;
let wsAutoRetryTimer = null;
let wsRetryCount = 0;
let wsLastResultAt = 0;

let httpModeTimer = null;
let httpSendBusy = false;

let speedEwma = null;
let latencyEwma = null;
let lastOverlayData = null;
let onlineSnapshot = [];
let onlineLastSyncMs = 0;
let onlineTickTimer = null;
let onlineRowRefs = new Map();
let onlineDisplayedSec = new Map();
let onlineTodayDisplayedSec = new Map();
let rotationDeg = 0;
let mirrorX = true;
let pendingActionInFlight = new Set();
let invalidReasonToastTimer = null;
let victoryConfirmHits = 0;
let victoryConfirmLastTs = 0;
let victoryNoMatchLastLogTs = 0;
const THEME_DAY_KEY = "facecheck_theme_day_v1";
const PENDING_SOURCE = "cam1";
const VICTORY_CONFIRM_HITS = 2;
const VICTORY_CONFIRM_COOLDOWN_MS = 1800;
const PENDING_CONFIRM_SUCCESS_MS = 980;
const PENDING_CONFIRM_LEAVE_MS = 320;
const PENDING_REJECT_SHATTER_MS = 880;
const CAMERA_OPEN_TEXT = "打开摄像头";
const CAMERA_CLOSE_TEXT = "关闭摄像头";
const HTML2CANVAS_CDN = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
const ONLINE_MODE_KEY = "facecheck_online_mode_v1";
const PREVIEW_MODE_KEY = "facecheck_preview_mode_v1";
let html2CanvasLoadPromise = null;
let onlineMode = "table";
let previewOnlyMode = true;
let onlineDeckIndex = 0;
let onlineDeckAnimating = false;
let onlineDeckLastStepTs = 0;
let onlineDeckTouchStartY = null;
let onlineDeckAutoTimer = null;
let pendingSignoutFocusName = "";
let onlineFocusedKey = null;
let onlineFocusTransitionToken = 0;
const ONLINE_DECK_VISIBLE_COUNT = 3;
const ONLINE_DECK_AUTO_SCROLL_MS = 2600;
const ONLINE_DECK_SCROLL_MS = 420;
let pendingRefMeasureWidth = 0;

function log(msg) {
  const now = new Date().toLocaleTimeString();
  els.logBox.textContent = `[${now}] ${msg}\n${els.logBox.textContent}`;
}

async function request(path, options = {}) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    let payload = null;
    let detail = "";
    try {
      if (contentType.includes("application/json")) {
        payload = await resp.json();
      } else {
        const text = await resp.text();
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (_) {
            detail = text;
          }
        }
      }
    } catch (_) {
      // keep fallback detail below
    }
    if (!detail && payload && typeof payload === "object" && payload.detail != null) {
      detail = String(payload.detail);
    }
    if (!detail && payload != null && typeof payload !== "object") {
      detail = String(payload);
    }
    if (!detail) detail = resp.statusText || "request failed";
    const err = new Error(`${resp.status} ${detail}`);
    err.status = resp.status;
    err.detail = detail;
    err.payload = payload;
    throw err;
  }
  if (resp.status === 204) return {};
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      return { raw: text };
    }
  }
  return resp.json();
}

function setHealth(ok) {
  if (!els.healthBadge) return;
  els.healthBadge.className = `badge ${ok ? "ok" : "bad"}`;
  els.healthBadge.textContent = `API: ${ok ? "OK" : "BAD"}`;
}

function setElText(el, text) {
  if (!el) return;
  el.textContent = text;
}

async function refreshHealth() {
  if (!els.healthBadge) return;
  try {
    await request("/health");
    setHealth(true);
  } catch (e) {
    setHealth(false);
    log(`health check failed: ${e.message}`);
  }
}

function setWsModeStatus(text) {
  setElText(els.wsModeStatus, text);
}

function setOverlayStatus(text) {
  setElText(els.serverPreviewStatus, text);
}

function applyThemeMode(mode) {
  const next = mode === "day" ? "day" : "night";
  document.body.dataset.theme = next;
  if (els.themeModeTag) {
    els.themeModeTag.textContent = `主题: ${next === "day" ? "白天" : "黑夜"}`;
  }
}

function formatCountdown(totalSec) {
  const sec = Math.max(0, Number(totalSec) || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function stopAutoStopCountdown() {
  if (previewAutoStopTickTimer) {
    clearInterval(previewAutoStopTickTimer);
    previewAutoStopTickTimer = null;
  }
  previewAutoStopDeadlineMs = 0;
  if (els.autoStopCountdown) {
    els.autoStopCountdown.style.display = "none";
  }
}

function updateAutoStopCountdown() {
  if (!els.autoStopCountdown) return;
  if (!previewAutoStopDeadlineMs || !isPreviewActive()) {
    els.autoStopCountdown.style.display = "none";
    return;
  }
  const remainSec = Math.max(0, Math.ceil((previewAutoStopDeadlineMs - Date.now()) / 1000));
  els.autoStopCountdown.textContent = `自动关闭倒计时: ${formatCountdown(remainSec)}`;
  els.autoStopCountdown.style.display = "inline-flex";
}

function startAutoStopCountdown(durationMs) {
  stopAutoStopCountdown();
  previewAutoStopDeadlineMs = Date.now() + durationMs;
  updateAutoStopCountdown();
  previewAutoStopTickTimer = setInterval(updateAutoStopCountdown, 1000);
}

function setThemeAutoEnabled(enabled) {
  const isDay = !!enabled;
  if (els.themeAutoToggle) {
    els.themeAutoToggle.checked = isDay;
    els.themeAutoToggle.title = isDay ? "当前: 白天模式" : "当前: 黑夜模式";
  }
  applyThemeMode(isDay ? "day" : "night");
}

function initThemeAuto() {
  let enabled = false;
  try {
    const raw = localStorage.getItem(THEME_DAY_KEY);
    if (raw !== null) enabled = raw === "1";
  } catch (_) {
    // ignore localStorage failures
  }
  setThemeAutoEnabled(enabled);
  if (els.themeAutoToggle) {
    els.themeAutoToggle.addEventListener("change", () => {
      const on = !!els.themeAutoToggle.checked;
      try {
        localStorage.setItem(THEME_DAY_KEY, on ? "1" : "0");
      } catch (_) {
        // ignore localStorage failures
      }
      setThemeAutoEnabled(on);
    });
  }
}

function isPreviewOnlyModeEnabled() {
  return !!previewOnlyMode;
}

function applyPreviewModeToggleState() {
  if (!els.previewModeToggle) return;
  els.previewModeToggle.checked = isPreviewOnlyModeEnabled();
  els.previewModeToggle.title = isPreviewOnlyModeEnabled() ? "预览模式已开启" : "预览模式已关闭";
}

function setPreviewModeEnabled(enabled, persist = true) {
  previewOnlyMode = !!enabled;
  if (persist) {
    try {
      localStorage.setItem(PREVIEW_MODE_KEY, previewOnlyMode ? "1" : "0");
    } catch (_) {
      // ignore localStorage failures
    }
  }
  applyPreviewModeToggleState();
  if (previewOnlyMode) {
    pendingSignoutFocusName = "";
    renderPendingEmptyState("预览模式已开启");
    applyDesiredOnlineFocus(true);
  } else {
    void refreshPending();
  }
  sendPreviewModeConfig();
}

function initPreviewMode() {
  let enabled = true;
  try {
    const raw = localStorage.getItem(PREVIEW_MODE_KEY);
    if (raw !== null) enabled = raw === "1";
  } catch (_) {
    // ignore localStorage failures
  }
  setPreviewModeEnabled(enabled, false);
  if (els.previewModeToggle) {
    els.previewModeToggle.addEventListener("change", () => {
      setPreviewModeEnabled(!!els.previewModeToggle.checked, true);
    });
  }
}

function setSettingsPopoverOpen(open) {
  if (!els.settingsPopover || !els.btnSettings) return;
  const next = !!open;
  els.settingsPopover.hidden = !next;
  els.btnSettings.setAttribute("aria-expanded", next ? "true" : "false");
}

function initSettingsPopover() {
  if (!els.settingsPopover || !els.btnSettings) return;
  setSettingsPopoverOpen(false);

  els.btnSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    const openNow = !els.settingsPopover.hidden;
    setSettingsPopoverOpen(!openNow);
  });

  els.settingsPopover.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  document.addEventListener("click", () => {
    setSettingsPopoverOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setSettingsPopoverOpen(false);
  });
}

function formatSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return "--";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  return `${(bps / 1_000).toFixed(0)} Kbps`;
}

function updateNetSpeed(bytes, elapsedMs) {
  if (!bytes || !elapsedMs) return;
  const bps = (bytes * 8 * 1000) / elapsedMs;
  speedEwma = speedEwma == null ? bps : speedEwma * 0.7 + bps * 0.3;
  latencyEwma = latencyEwma == null ? elapsedMs : latencyEwma * 0.7 + elapsedMs * 0.3;
  setElText(els.netSpeedTag, `net: ${formatSpeed(speedEwma)} | latency: ${Math.round(latencyEwma)}ms`);
}

function canvasFrameToBlob(canvas, quality = 0.68) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof canvas.toBlob === "function") {
        canvas.toBlob((blob) => resolve(blob || null), "image/jpeg", quality);
        return;
      }

      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        resolve(null);
        return;
      }
      const base64 = dataUrl.slice(comma + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      resolve(new Blob([bytes], { type: "image/jpeg" }));
    } catch (err) {
      reject(err);
    }
  });
}

function clearOverlay() {
  lastOverlayData = null;
  const canvas = els.overlayCanvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  speedEwma = null;
  latencyEwma = null;
  setElText(els.netSpeedTag, "net: --");
}

function isPreviewActive() {
  return !!previewStream && !!els.cameraPreview.srcObject;
}

function updatePreviewToggleButton() {
  const btn = els.btnTogglePreview;
  if (!btn) return;
  const active = isPreviewActive();
  btn.textContent = active ? CAMERA_CLOSE_TEXT : CAMERA_OPEN_TEXT;
  btn.classList.toggle("primary", !active);
  btn.classList.toggle("danger", active);
}

function prepareCanvas() {
  const canvas = els.overlayCanvas;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssW, cssH };
}

function containRect(dstW, dstH, srcW, srcH) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (dstAspect > srcAspect) {
    const h = dstH;
    const w = h * srcAspect;
    return { x: (dstW - w) / 2, y: 0, w, h };
  }
  const w = dstW;
  const h = w / srcAspect;
  return { x: 0, y: (dstH - h) / 2, w, h };
}

function mapBox(box, rect, srcW, srcH) {
  let x1 = rect.x + (box[0] / srcW) * rect.w;
  const y1 = rect.y + (box[1] / srcH) * rect.h;
  let x2 = rect.x + (box[2] / srcW) * rect.w;
  const y2 = rect.y + (box[3] / srcH) * rect.h;
  if (mirrorX) {
    const mx1 = rect.x + rect.w - (x1 - rect.x);
    const mx2 = rect.x + rect.w - (x2 - rect.x);
    x1 = Math.min(mx1, mx2);
    x2 = Math.max(mx1, mx2);
  }
  return [x1, y1, x2, y2];
}

function drawLabel(ctx, text, x, y, fg, bg) {
  ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
  const padX = 6;
  const padY = 3;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 20;
  const rx = Math.max(0, x);
  const ry = Math.max(0, y - h);
  ctx.fillStyle = bg;
  ctx.fillRect(rx, ry, w, h);
  ctx.fillStyle = fg;
  ctx.fillText(text, rx + padX, ry + h - padY - 1);
}

function drawOverlay(data) {
  if (!isPreviewActive()) {
    clearOverlay();
    return;
  }
  const { ctx, cssW, cssH } = prepareCanvas();
  ctx.clearRect(0, 0, cssW, cssH);
  if (!data) return;

  const srcW = Number(data.frame_w) || 640;
  const srcH = Number(data.frame_h) || 480;
  const rect = containRect(cssW, cssH, srcW, srcH);

  const faces = Array.isArray(data.faces) ? data.faces : [];
  const hands = Array.isArray(data.hands) ? data.hands : [];

  for (const face of faces) {
    if (!Array.isArray(face.bbox) || face.bbox.length !== 4) continue;
    const [x1, y1, x2, y2] = mapBox(face.bbox, rect, srcW, srcH);
    const color = face.known ? "#33dd66" : "#ff5a5a";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const dist = Number.isFinite(face.distance) ? face.distance.toFixed(2) : "--";
    drawLabel(ctx, `${face.name || "unknown"} (${dist})`, x1, y1, "#fff", "rgba(0,0,0,0.65)");
  }

  for (const hand of hands) {
    if (!Array.isArray(hand.bbox) || hand.bbox.length !== 4) continue;
    const [x1, y1, x2, y2] = mapBox(hand.bbox, rect, srcW, srcH);
    ctx.strokeStyle = "#ffcc33";
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const score = Number.isFinite(hand.score) ? hand.score.toFixed(2) : "--";
    drawLabel(ctx, `${hand.label || "hand"}:${score}`, x1, y1, "#000", "rgba(255,204,51,0.9)");
  }

  drawLabel(ctx, `name=${data.name || "None"} action=${data.action || "NONE"}`, rect.x + 8, rect.y + 24, "#42ff6b", "rgba(0,0,0,0.55)");
  if (data.ts) drawLabel(ctx, data.ts, rect.x + 8, rect.y + 50, "#fff", "rgba(0,0,0,0.45)");
}

function normalizeGestureLabel(label) {
  return String(label || "").trim().toLowerCase();
}

function hasVictoryGesture(data) {
  const hands = Array.isArray(data && data.hands) ? data.hands : [];
  for (const hand of hands) {
    const lab = normalizeGestureLabel(hand && hand.label);
    if (lab === "victory" || lab === "victory_sign" || lab === "v_sign") {
      return true;
    }
  }
  return false;
}

function isValidRecognizedName(name) {
  const text = String(name || "").trim();
  if (!text) return false;
  if (text.toLowerCase() === "none") return false;
  return true;
}

function findPendingCardForAutoConfirm(name, pendingId) {
  if (pendingId != null) {
    const byId = getPendingCard(String(pendingId));
    if (byId) return byId;
  }
  const who = String(name || "").trim();
  if (!who) return null;
  const cards = els.pendingBody.querySelectorAll(".pending-card");
  for (const card of cards) {
    if (!(card instanceof HTMLElement)) continue;
    const cardName = String(card.dataset.pendingName || "").trim();
    if (cardName && cardName === who) return card;
  }
  return null;
}

async function tryAutoConfirmByVictory(data) {
  if (!hasVictoryGesture(data)) {
    victoryConfirmHits = 0;
    return;
  }

  const who = String(data && data.name ? data.name : "").trim();
  if (!isValidRecognizedName(who)) {
    victoryConfirmHits = 0;
    return;
  }

  victoryConfirmHits += 1;
  if (victoryConfirmHits < VICTORY_CONFIRM_HITS) return;

  const now = Date.now();
  if (now - victoryConfirmLastTs < VICTORY_CONFIRM_COOLDOWN_MS) return;

  let card = findPendingCardForAutoConfirm(who, data ? data.pending_id : null);
  if (!card && data && data.pending_id) {
    await refreshPending();
    card = findPendingCardForAutoConfirm(who, data.pending_id);
  }
  if (!card) {
    if (now - victoryNoMatchLastLogTs >= 3000) {
      log(`Victory detected, but no pending action for ${who}`);
      victoryNoMatchLastLogTs = now;
    }
    return;
  }

  const sid = String(card.dataset.pendingId || "").trim();
  if (!sid || pendingActionInFlight.has(sid)) return;

  victoryConfirmLastTs = now;
  victoryConfirmHits = 0;
  log(`Victory detected, auto confirming #${sid} (${who})`);
  await confirmPending(sid);
}

function handleInferResult(data) {
  if (!data || data.type !== "result") return;
  if (!isPreviewActive()) return;
  lastOverlayData = data;
  drawOverlay(data);
  if (typeof data.result_bps === "number" && typeof data.proc_ms === "number") {
    setElText(els.netSpeedTag, `net: ${formatSpeed(data.result_bps)} | infer: ${Math.round(data.proc_ms)}ms`);
  }
  if (!isPreviewOnlyModeEnabled() && data.pending_id) refreshPending();
  if (!isPreviewOnlyModeEnabled()) void tryAutoConfirmByVictory(data);
}

function defaultWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/camera`;
}

function sendPreviewModeConfig() {
  if (!wsModeSocket || wsModeSocket.readyState !== WebSocket.OPEN) return;
  try {
    wsModeSocket.send(
      JSON.stringify({
        type: "config",
        preview_only: isPreviewOnlyModeEnabled(),
      })
    );
  } catch (_) {
    // ignore transient ws send error
  }
}

async function readWsText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) {
    return await data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder("utf-8").decode(data);
  }
  return "";
}

function getRotationScale() {
  if (rotationDeg % 180 === 0) return 1;
  const stack = els.cameraPreview?.parentElement;
  if (!stack) return 1;
  const w = Math.max(1, stack.clientWidth || 1);
  const h = Math.max(1, stack.clientHeight || 1);
  return Math.min(w / h, h / w);
}

function applyPreviewRotation() {
  const scale = getRotationScale();
  const mx = mirrorX ? -1 : 1;
  const videoTransform = `scaleX(${mx}) rotate(${rotationDeg}deg) scale(${scale})`;
  const overlayTransform = `rotate(${rotationDeg}deg) scale(${scale})`;
  if (els.cameraPreview) els.cameraPreview.style.transform = videoTransform;
  if (els.overlayCanvas) els.overlayCanvas.style.transform = overlayTransform;
  if (els.btnRotate90) els.btnRotate90.title = `旋转90度（当前：${rotationDeg}°）`;
  if (els.btnMirrorX) {
    els.btnMirrorX.title = `左右镜像（当前：${mirrorX ? "开" : "关"}）`;
    els.btnMirrorX.classList.toggle("primary", mirrorX);
  }
}

function rotatePreview90() {
  rotationDeg = (rotationDeg + 90) % 360;
  applyPreviewRotation();
  clearOverlay();
}

function toggleMirrorX() {
  mirrorX = !mirrorX;
  applyPreviewRotation();
}

function clearWsRuntimeTimers() {
  if (wsConnectWatchdog) clearTimeout(wsConnectWatchdog);
  wsConnectWatchdog = null;
  if (wsResultWatchdog) clearInterval(wsResultWatchdog);
  wsResultWatchdog = null;
  if (wsAutoRetryTimer) clearTimeout(wsAutoRetryTimer);
  wsAutoRetryTimer = null;
}

function scheduleWsReconnect(reason) {
  if (!wsShouldRun || !previewStream) return;
  if (wsAutoRetryTimer) return;
  wsRetryCount += 1;
  const delay = Math.min(2000, 400 + wsRetryCount * 300);
  setWsModeStatus(`WS: reconnecting (${reason})`);
  wsAutoRetryTimer = setTimeout(async () => {
    wsAutoRetryTimer = null;
    if (!wsShouldRun || !previewStream) return;
    await startWebMode();
  }, delay);
}

function startWsResultWatchdog() {
  if (wsResultWatchdog) clearInterval(wsResultWatchdog);
  wsResultWatchdog = setInterval(() => {
    if (!wsShouldRun) return;
    if (!wsModeSocket || wsModeSocket.readyState !== WebSocket.OPEN) return;
    if (!wsLastResultAt) return;
    if (Date.now() - wsLastResultAt < 5000) return;
    log("no result packet for 5s, force reconnect");
    try { wsModeSocket.close(); } catch (_) {}
    scheduleWsReconnect("timeout");
  }, 1500);
}

function stopWebMode() {
  wsShouldRun = false;
  switchingToHttp = false;
  clearWsRuntimeTimers();
  if (wsModeTimer) clearInterval(wsModeTimer);
  wsModeTimer = null;
  wsSendBusy = false;
  wsSendStartedAt = 0;
  wsFailStreak = 0;
  wsRetryCount = 0;
  wsLastResultAt = 0;
  if (wsModeSocket) {
    try { wsModeSocket.close(); } catch (_) {}
    wsModeSocket = null;
  }
  stopHttpMode();
  setWsModeStatus("WS: stopped");
  setOverlayStatus("video: idle");
  clearOverlay();
}

function stopPreview() {
  if (previewAutoStopTimer) {
    clearTimeout(previewAutoStopTimer);
    previewAutoStopTimer = null;
  }
  stopAutoStopCountdown();
  stopWebMode();
  if (previewStream) {
    for (const t of previewStream.getTracks()) t.stop();
    previewStream = null;
  }
  els.cameraPreview.srcObject = null;
  victoryConfirmHits = 0;
  victoryConfirmLastTs = 0;
  victoryNoMatchLastLogTs = 0;
  updatePreviewToggleButton();
  scheduleLayoutSync();
}

async function encodeCurrentFrame(canvas, ctx) {
  const v = els.cameraPreview;
  if (!v || v.readyState < 2) return null;

  const srcW = v.videoWidth || 640;
  const srcH = v.videoHeight || 480;
  const maxW = 640;
  const longest = Math.max(srcW, srcH);
  const resizeScale = longest > maxW ? maxW / longest : 1.0;
  const targetW = Math.max(160, Math.round(srcW * resizeScale));
  const targetH = Math.max(120, Math.round(srcH * resizeScale));

  const rot = ((rotationDeg % 360) + 360) % 360;
  const quarterTurn = rot === 90 || rot === 270;
  const outW = quarterTurn ? targetH : targetW;
  const outH = quarterTurn ? targetW : targetH;
  if (canvas.width !== outW || canvas.height !== outH) {
    canvas.width = outW;
    canvas.height = outH;
  }

  const t0 = performance.now();
  ctx.save();
  ctx.clearRect(0, 0, outW, outH);
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(v, -targetW / 2, -targetH / 2, targetW, targetH);
  ctx.restore();

  const blob = await canvasFrameToBlob(canvas, 0.68);
  if (!blob) return null;
  return { blob, elapsed: Math.max(1, performance.now() - t0) };
}

function stopHttpMode() {
  if (httpModeTimer) clearInterval(httpModeTimer);
  httpModeTimer = null;
  httpSendBusy = false;
}

function activateHttpFallback(reason) {
  if (httpModeTimer) return;
  log(`ws unavailable, switch to HTTP fallback (${reason})`);
  switchingToHttp = true;
  wsShouldRun = false;
  clearWsRuntimeTimers();
  if (wsModeTimer) clearInterval(wsModeTimer);
  wsModeTimer = null;
  wsSendBusy = false;
  wsSendStartedAt = 0;
  if (wsModeSocket) {
    try { wsModeSocket.close(); } catch (_) {}
    wsModeSocket = null;
  }
  setWsModeStatus("HTTP: fallback");
  setOverlayStatus("video: online");
  startHttpMode();
}

function startHttpMode() {
  if (!previewStream || httpModeTimer) return;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const source = PENDING_SOURCE;

  httpModeTimer = setInterval(() => {
    if (!previewStream || httpSendBusy) return;
    httpSendBusy = true;
    (async () => {
      try {
        const encoded = await encodeCurrentFrame(canvas, ctx);
        if (!encoded) {
          httpSendBusy = false;
          return;
        }
        updateNetSpeed(encoded.blob.size || 0, encoded.elapsed);
        const resp = await fetch("/camera/infer", {
          method: "POST",
          headers: {
            "Content-Type": "image/jpeg",
            "X-Cam-Source": source,
            "X-Preview-Only": isPreviewOnlyModeEnabled() ? "1" : "0",
          },
          body: encoded.blob,
          cache: "no-store",
        });
        if (!resp.ok) {
          throw new Error(`${resp.status} ${await resp.text()}`);
        }
        const data = await resp.json();
        handleInferResult(data);
      } catch (e) {
        log(`http infer failed: ${e.message}`);
      } finally {
        httpSendBusy = false;
      }
    })();
  }, 180);
}

async function detectCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    setElText(els.cameraSupport, "no mediaDevices");
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput");
    els.cameraSelect.innerHTML = "";
    for (const cam of cameras) {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `camera-${cam.deviceId.slice(0, 8)}`;
      els.cameraSelect.appendChild(opt);
    }
    setElText(els.cameraSupport, cameras.length ? `camera count: ${cameras.length}` : "no camera found");
  } catch (e) {
    setElText(els.cameraSupport, "camera detect failed");
    log(`detect camera failed: ${e.message}`);
  }
}

function startCaptureLoop() {
  if (wsModeTimer) clearInterval(wsModeTimer);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });

  wsModeTimer = setInterval(() => {
    if (!previewStream || !wsModeSocket || wsModeSocket.readyState !== WebSocket.OPEN) return;
    if (wsSendBusy) {
      if (performance.now() - wsSendStartedAt > 2200) {
        wsSendBusy = false;
        wsSendStartedAt = 0;
      } else {
        return;
      }
    }

    const v = els.cameraPreview;
    if (!v || v.readyState < 2) return;

    const srcW = v.videoWidth || 640;
    const srcH = v.videoHeight || 480;
    const maxW = 640;
    const longest = Math.max(srcW, srcH);
    const resizeScale = longest > maxW ? maxW / longest : 1.0;
    const targetW = Math.max(160, Math.round(srcW * resizeScale));
    const targetH = Math.max(120, Math.round(srcH * resizeScale));

    const rot = ((rotationDeg % 360) + 360) % 360;
    const quarterTurn = rot === 90 || rot === 270;
    const outW = quarterTurn ? targetH : targetW;
    const outH = quarterTurn ? targetW : targetH;
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }

    const t0 = performance.now();
    wsSendBusy = true;
    wsSendStartedAt = t0;

    ctx.save();
    ctx.clearRect(0, 0, outW, outH);
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(v, -targetW / 2, -targetH / 2, targetW, targetH);
    ctx.restore();

    (async () => {
      try {
        const blob = await canvasFrameToBlob(canvas, 0.68);
        if (!blob || !wsModeSocket || wsModeSocket.readyState !== WebSocket.OPEN) {
          wsSendBusy = false;
          wsSendStartedAt = 0;
          return;
        }
        wsModeSocket.send(blob);
        const elapsed = Math.max(1, performance.now() - t0);
        updateNetSpeed(blob.size || 0, elapsed);
      } catch (e) {
        wsSendBusy = false;
        wsSendStartedAt = 0;
        log(`send frame failed: ${e.message}`);
      }
    })();
  }, 120);
}

async function startWebMode() {
  if (!previewStream) {
    log("open local preview first");
    return;
  }

  stopHttpMode();
  switchingToHttp = false;
  wsShouldRun = true;
  const wsUrl = defaultWsUrl();

  try {
    if (wsModeSocket && wsModeSocket.readyState === WebSocket.OPEN) return;

    if (wsModeSocket) {
      try { wsModeSocket.close(); } catch (_) {}
      wsModeSocket = null;
    }
    if (wsModeTimer) clearInterval(wsModeTimer);
    wsModeTimer = null;
    wsSendBusy = false;
    wsSendStartedAt = 0;

    setWsModeStatus("WS: connecting");
    wsModeSocket = new WebSocket(wsUrl);
    wsModeSocket.binaryType = "arraybuffer";

    wsConnectWatchdog = setTimeout(() => {
      if (!wsShouldRun) return;
      if (!wsModeSocket || wsModeSocket.readyState === WebSocket.OPEN) return;
      try { wsModeSocket.close(); } catch (_) {}
      scheduleWsReconnect("connect");
    }, 4500);

    wsModeSocket.onopen = () => {
      if (wsConnectWatchdog) clearTimeout(wsConnectWatchdog);
      wsConnectWatchdog = null;
      wsFailStreak = 0;
      wsRetryCount = 0;
      wsLastResultAt = Date.now();
      setWsModeStatus("WS: connected");
      setOverlayStatus("video: online");
      log("ws connected");
      sendPreviewModeConfig();
      startCaptureLoop();
      startWsResultWatchdog();
    };

    wsModeSocket.onmessage = async (event) => {
      wsSendBusy = false;
      wsSendStartedAt = 0;
      wsLastResultAt = Date.now();
      try {
        const payloadText = await readWsText(event.data);
        if (!payloadText) return;
        const data = JSON.parse(payloadText);
        handleInferResult(data);
      } catch (e) {
        log(`ws parse failed: ${e.message}`);
      }
    };

    wsModeSocket.onclose = () => {
      wsSendBusy = false;
      wsSendStartedAt = 0;
      if (wsConnectWatchdog) clearTimeout(wsConnectWatchdog);
      wsConnectWatchdog = null;
      if (switchingToHttp) {
        switchingToHttp = false;
        log("ws closed (switch to http)");
        return;
      }
      if (wsShouldRun) {
        wsFailStreak += 1;
        if (wsFailStreak >= 3) {
          activateHttpFallback("close");
          return;
        }
        scheduleWsReconnect("close");
      } else {
        setWsModeStatus("WS: stopped");
        setOverlayStatus("video: idle");
        clearOverlay();
      }
      log("ws closed");
    };

    wsModeSocket.onerror = () => {
      wsSendBusy = false;
      wsSendStartedAt = 0;
      if (wsConnectWatchdog) clearTimeout(wsConnectWatchdog);
      wsConnectWatchdog = null;
      if (wsShouldRun) {
        wsFailStreak += 1;
        if (wsFailStreak >= 3) {
          activateHttpFallback("error");
          return;
        }
        scheduleWsReconnect("error");
      } else {
        setWsModeStatus("WS: error");
        setOverlayStatus("video: idle");
        clearOverlay();
      }
      log("ws error");
    };
  } catch (e) {
    setWsModeStatus("WS: failed");
    log(`start ws failed: ${e.message}`);
    scheduleWsReconnect("exception");
  }
}

async function startPreview() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    log("browser does not support getUserMedia");
    return false;
  }
  stopPreview();
  try {
    const deviceId = els.cameraSelect.value;
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId }, frameRate: { ideal: 15 } }, audio: false }
      : { video: { facingMode: "user", frameRate: { ideal: 15 } }, audio: false };
    previewStream = await navigator.mediaDevices.getUserMedia(constraints);
    els.cameraPreview.srcObject = previewStream;
    const onMeta = () => {
      scheduleLayoutSync();
      els.cameraPreview.removeEventListener("loadedmetadata", onMeta);
    };
    els.cameraPreview.addEventListener("loadedmetadata", onMeta);
    startAutoStopCountdown(PREVIEW_AUTO_STOP_MS);
    if (previewAutoStopTimer) clearTimeout(previewAutoStopTimer);
    previewAutoStopTimer = setTimeout(() => {
      if (!previewStream) return;
      log("local preview auto-stopped after 5 minutes");
      stopPreview();
    }, PREVIEW_AUTO_STOP_MS);
    setOverlayStatus("video: starting");
    log("camera started");
    await startWebMode();
    updatePreviewToggleButton();
    scheduleLayoutSync();
    return true;
  } catch (e) {
    log(`open preview failed: ${e.message}`);
    updatePreviewToggleButton();
    return false;
  }
}

async function togglePreview() {
  if (isPreviewActive()) {
    stopPreview();
    log("camera stopped");
    return;
  }
  await startPreview();
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pendingActionType(actionText) {
  const text = String(actionText || "").toUpperCase();
  return text.includes("SIGN_OUT") || text.includes("签退") ? "signout" : "signin";
}

function pendingCard(item) {
  const actionType = pendingActionType(item.action);
  const actionText = actionType === "signout" ? "签退" : "签到";
  const card = document.createElement("article");
  card.className = `pending-card ${actionType}`;
  card.dataset.pendingId = String(item.id);
  card.dataset.pendingName = String(item.name || "");
  card.dataset.pendingActionType = actionType;
  card.innerHTML = `
    <div class="pending-card-content">
      <div class="pending-card-head">
        <span class="pending-id">#${escapeHtml(item.id)}</span>
        <span class="pending-action-badge ${actionType}">${actionText}</span>
      </div>
      <div class="pending-meta-grid">
        <div class="pending-meta-item">
          <span class="pending-meta-label">姓名</span>
          <span class="pending-meta-value">${escapeHtml(item.name || "-")}</span>
        </div>
        <div class="pending-meta-item">
          <span class="pending-meta-label">检测时间</span>
          <span class="pending-meta-value">${escapeHtml(formatTimeToSecond(item.detected_time))}</span>
        </div>
      </div>
      <div class="pending-actions">
        <button class="btn primary" data-confirm="${item.id}">确认</button>
        <button class="btn" data-reject="${item.id}">驳回</button>
      </div>
    </div>
    <canvas class="pending-shatter-canvas" aria-hidden="true"></canvas>
    <div class="pending-confirm-success" aria-hidden="true">
      <svg class="pending-confirm-icon" viewBox="0 0 120 120" focusable="false">
        <circle class="ring" cx="60" cy="60" r="34"></circle>
        <path class="check" d="M42 61 L55 74 L80 47"></path>
      </svg>
    </div>
  `;
  return card;
}

function pendingEmptyCard(message = "当前没有待确认动作") {
  const empty = document.createElement("div");
  empty.className = "pending-empty";
  empty.textContent = String(message || "当前没有待确认动作");
  return empty;
}

function renderPendingEmptyState(message = "当前没有待确认动作") {
  if (!els.pendingBody) return;
  els.pendingBody.innerHTML = "";
  els.pendingBody.classList.add("single");
  els.pendingBody.appendChild(pendingEmptyCard(message));
  scheduleLayoutSync();
}

async function refreshPending() {
  if (pendingActionInFlight.size > 0) return;
  if (isPreviewOnlyModeEnabled()) {
    pendingSignoutFocusName = "";
    renderPendingEmptyState("预览模式已开启");
    return;
  }
  const source = encodeURIComponent(PENDING_SOURCE);
  try {
    const data = await request(`/pending-actions?source=${source}&limit=20`);
    const items = Array.isArray(data.items) ? data.items : [];
    const signoutPending = items.find((item) => {
      const who = String(item && item.name ? item.name : "").trim();
      return who && pendingActionType(item.action) === "signout";
    });
    const nextFocusName = signoutPending ? String(signoutPending.name).trim() : "";
    const pendingFocusChanged = nextFocusName !== pendingSignoutFocusName;
    pendingSignoutFocusName = nextFocusName;

    els.pendingBody.innerHTML = "";
    els.pendingBody.classList.toggle("single", !items.length || items.length <= 1);
    for (const item of items) els.pendingBody.appendChild(pendingCard(item));
    if (!items.length) els.pendingBody.appendChild(pendingEmptyCard());

    if (pendingFocusChanged) applyDesiredOnlineFocus(true);
    scheduleLayoutSync();
  } catch (e) {
    log(`load pending failed: ${e.message}`);
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatTimeToSecond(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const normalized = text.replace("T", " ");
  const dot = normalized.indexOf(".");
  return dot >= 0 ? normalized.slice(0, dot) : normalized;
}

function setPendingCardRefHeight(px) {
  const h = Math.ceil(Number(px) || 0);
  if (!Number.isFinite(h) || h <= 0) return;
  document.documentElement.style.setProperty("--pending-card-ref-height", `${h}px`);
}

function measurePendingTemplateCardHeight() {
  if (!els.pendingBody && !els.pendingSideCard) return 0;
  const host = els.pendingBody || els.pendingSideCard;
  const width = Math.max(220, Math.floor(host.clientWidth || 0));
  if (!width) return 0;

  const probe = document.createElement("article");
  probe.className = "pending-card signout";
  probe.style.position = "fixed";
  probe.style.left = "-99999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = `${width}px`;
  probe.innerHTML = `
    <div class="pending-card-content">
      <div class="pending-card-head">
        <span class="pending-id">#000</span>
        <span class="pending-action-badge signout">签退</span>
      </div>
      <div class="pending-meta-grid">
        <div class="pending-meta-item">
          <span class="pending-meta-label">姓名</span>
          <span class="pending-meta-value">示例用户</span>
        </div>
        <div class="pending-meta-item">
          <span class="pending-meta-label">检测时间</span>
          <span class="pending-meta-value">2026-03-07 12:00:00</span>
        </div>
      </div>
      <div class="pending-actions">
        <button class="btn primary">确认</button>
        <button class="btn">驳回</button>
      </div>
    </div>
  `;
  document.body.appendChild(probe);
  const h = Math.ceil(probe.getBoundingClientRect().height);
  probe.remove();
  return h;
}

function syncPendingCardReferenceHeight() {
  const card = els.pendingBody?.querySelector(".pending-card");
  if (card) {
    setPendingCardRefHeight(card.getBoundingClientRect().height);
    return;
  }
  const host = els.pendingBody || els.pendingSideCard;
  if (!host) return;
  const width = Math.floor(host.clientWidth || 0);
  if (!width) return;
  if (Math.abs(width - pendingRefMeasureWidth) < 2) return;
  pendingRefMeasureWidth = width;
  const measured = measurePendingTemplateCardHeight();
  if (measured > 0) setPendingCardRefHeight(measured);
}

function syncOnlineCardHeightAndNameSize() {
  const root = document.documentElement;
  if (!root) return;

  if (window.matchMedia("(max-width: 1100px)").matches) {
    root.style.removeProperty("--online-card-target-height");
    return;
  }

  if (onlineMode !== "deck") return;

  const refRaw = getComputedStyle(root).getPropertyValue("--pending-card-ref-height");
  const refH = parseFloat(refRaw || "0");
  if (!Number.isFinite(refH) || refH <= 0) return;

  const onlineTarget = Math.max(122, Math.round(refH - 44));
  root.style.setProperty("--online-card-target-height", `${onlineTarget}px`);
}

function syncPendingPanelHeight() {
  const pendingSide = els.pendingSideCard;
  const pendingBody = els.pendingBody;
  if (!pendingSide || !pendingBody) return;

  if (window.matchMedia("(max-width: 1100px)").matches) {
    pendingSide.style.removeProperty("flex-basis");
    pendingSide.style.removeProperty("min-height");
    pendingSide.style.removeProperty("max-height");
    return;
  }

  const firstItem = pendingBody.querySelector(".pending-card, .pending-empty");
  const head = pendingSide.querySelector(".card-head");
  if (!firstItem || !head) return;

  const panelStyle = getComputedStyle(pendingSide);
  const padTop = parseFloat(panelStyle.paddingTop || "0") || 0;
  const padBottom = parseFloat(panelStyle.paddingBottom || "0") || 0;
  const headH = Math.ceil(head.getBoundingClientRect().height);
  const itemH = Math.ceil(firstItem.getBoundingClientRect().height);
  const reserve = 14;
  const need = Math.max(230, padTop + padBottom + headH + itemH + reserve);

  pendingSide.style.flexBasis = `${need}px`;
  pendingSide.style.minHeight = `${need}px`;
  pendingSide.style.maxHeight = `${need}px`;
}

function syncOnlinePanelHeight() {
  const onlineSide = els.onlineSideCard;
  const pendingSide = els.pendingSideCard;
  const cameraMain = els.cameraMainCard;
  const rightStack = els.rightStack;
  if (!onlineSide || !pendingSide || !cameraMain || !rightStack) return;

  if (window.matchMedia("(max-width: 1100px)").matches) {
    onlineSide.style.removeProperty("--online-panel-height");
    return;
  }

  const cameraH = cameraMain.getBoundingClientRect().height;
  const pendingH = pendingSide.getBoundingClientRect().height;
  const gap = parseFloat(getComputedStyle(rightStack).rowGap || getComputedStyle(rightStack).gap || "14") || 14;
  const raw = Math.floor(cameraH - pendingH - gap);
  const h = Math.max(280, Math.min(680, raw));
  onlineSide.style.setProperty("--online-panel-height", `${h}px`);
}

function scheduleLayoutSync() {
  syncPendingCardReferenceHeight();
  syncOnlineCardHeightAndNameSize();
  syncPendingPanelHeight();
  syncOnlinePanelHeight();
  [120, 360, 820, 1400].forEach((ms) => {
    setTimeout(() => {
      syncPendingCardReferenceHeight();
      syncOnlineCardHeightAndNameSize();
      syncPendingPanelHeight();
      syncOnlinePanelHeight();
    }, ms);
  });
}

function onlineRowKey(item) {
  return `${item.name}@@${item.sign_in_time}`;
}

function computeOnlineDurations(item, nowMs = Date.now()) {
  const deltaSec = Math.max(0, Math.floor((nowMs - onlineLastSyncMs) / 1000));
  let durationSec = (item.base_seconds || 0) + deltaSec;
  const prevSec = onlineDisplayedSec.get(item.key);
  if (typeof prevSec === "number" && durationSec < prevSec) durationSec = prevSec;
  onlineDisplayedSec.set(item.key, durationSec);

  let todaySec = (item.today_base_seconds || 0) + deltaSec;
  const prevTodaySec = onlineTodayDisplayedSec.get(item.key);
  if (typeof prevTodaySec === "number" && todaySec < prevTodaySec) todaySec = prevTodaySec;
  onlineTodayDisplayedSec.set(item.key, todaySec);

  return { durationSec, todaySec };
}

function getRotatingOnlineItems() {
  if (!onlineFocusedKey) return onlineSnapshot.slice();
  return onlineSnapshot.filter((item) => item.key !== onlineFocusedKey);
}

function findOnlineItemByName(name) {
  const who = String(name || "").trim();
  if (!who) return null;
  return (
    onlineSnapshot.find((item) => String(item.name || "").trim() === who) ||
    null
  );
}

function resolveDesiredOnlineFocusKey() {
  if (!pendingSignoutFocusName) return null;
  const hit = findOnlineItemByName(pendingSignoutFocusName);
  return hit ? hit.key : null;
}

function findDeckCardByKey(key) {
  if (!key || !els.onlineDeckViewport) return null;
  const cards = els.onlineDeckViewport.querySelectorAll(".online-deck-card[data-key]");
  for (const card of cards) {
    if (String(card.dataset.key || "") === String(key)) return card;
  }
  return null;
}

function animateDeckCardRelocation(card, fromRect, durationMs = 320) {
  if (!card || !fromRect) return;
  const toRect = card.getBoundingClientRect();
  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;
  const sx = fromRect.width > 0 ? fromRect.width / Math.max(1, toRect.width) : 1;
  const sy = fromRect.height > 0 ? fromRect.height / Math.max(1, toRect.height) : 1;
  card.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transform: "translate(0, 0) scale(1, 1)" },
    ],
    {
      duration: durationMs,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "none",
    }
  );
}

function animateDeckFocusTransition(prevKey, nextKey, animate = true) {
  const viewport = els.onlineDeckViewport;
  if (!viewport) return;

  let fromRect = null;
  let moveKey = null;
  if (animate) {
    if (nextKey) {
      const src = findDeckCardByKey(nextKey);
      if (src) {
        fromRect = src.getBoundingClientRect();
        moveKey = nextKey;
      }
    }
    if (!fromRect && prevKey) {
      const src = findDeckCardByKey(prevKey);
      if (src) {
        fromRect = src.getBoundingClientRect();
        moveKey = prevKey;
      }
    }
  }

  renderOnlineDeck(Date.now());
  syncOnlineCardHeightAndNameSize();

  if (!animate || !fromRect || !moveKey) return;
  const target = findDeckCardByKey(nextKey || prevKey);
  if (target) animateDeckCardRelocation(target, fromRect, 340);
}

function applyDesiredOnlineFocus(animate = false) {
  const nextKey = resolveDesiredOnlineFocusKey();
  const prevKey = onlineFocusedKey;
  if (nextKey === prevKey) return false;

  const token = ++onlineFocusTransitionToken;
  if (onlineMode !== "deck" || !animate) {
    onlineFocusedKey = nextKey;
    return true;
  }

  if (onlineDeckAnimating) {
    onlineFocusedKey = nextKey;
    setTimeout(() => {
      if (token !== onlineFocusTransitionToken) return;
      if (onlineMode !== "deck" || onlineDeckAnimating) return;
      renderOnlineDeck(Date.now());
      syncOnlineCardHeightAndNameSize();
      scheduleLayoutSync();
    }, ONLINE_DECK_SCROLL_MS + 80);
    return true;
  }

  if (prevKey && nextKey && prevKey !== nextKey) {
    onlineFocusedKey = null;
    animateDeckFocusTransition(prevKey, null, true);
    setTimeout(() => {
      if (token !== onlineFocusTransitionToken) return;
      onlineFocusedKey = nextKey;
      animateDeckFocusTransition(null, nextKey, true);
      scheduleLayoutSync();
    }, 210);
    return true;
  }

  onlineFocusedKey = nextKey;
  animateDeckFocusTransition(prevKey, nextKey, true);
  return true;
}

function normalizeOnlineDeckIndex() {
  const total = getRotatingOnlineItems().length;
  if (!total) {
    onlineDeckIndex = 0;
    return;
  }
  onlineDeckIndex = ((onlineDeckIndex % total) + total) % total;
}

function stopOnlineDeckAutoScroll() {
  if (onlineDeckAutoTimer) {
    clearInterval(onlineDeckAutoTimer);
    onlineDeckAutoTimer = null;
  }
}

function startOnlineDeckAutoScroll() {
  stopOnlineDeckAutoScroll();
  if (onlineMode !== "deck") return;
  if (getRotatingOnlineItems().length <= 1) return;
  onlineDeckAutoTimer = setInterval(() => {
    stepOnlineDeck(1);
  }, ONLINE_DECK_AUTO_SCROLL_MS);
}

function setOnlineMode(mode, persist = true) {
  onlineMode = mode === "deck" ? "deck" : "table";
  if (persist) localStorage.setItem(ONLINE_MODE_KEY, onlineMode);
  if (els.onlineModeToggle) els.onlineModeToggle.checked = onlineMode === "deck";
  if (els.onlineTable) els.onlineTable.hidden = onlineMode === "deck";
  if (els.onlineDeckWrap) els.onlineDeckWrap.hidden = onlineMode !== "deck";
  if (onlineMode === "deck") {
    applyDesiredOnlineFocus(false);
    renderOnlineDeck(Date.now());
    startOnlineDeckAutoScroll();
  } else {
    stopOnlineDeckAutoScroll();
    renderOnlineTable(Date.now());
    tickOnlineDurations(Date.now());
  }
  syncOnlineCardHeightAndNameSize();
  syncOnlinePanelHeight();
}

function buildOnlineDeckCard(item, nowMs = Date.now(), placeholder = false) {
  if (placeholder) {
    const emptyCard = document.createElement("article");
    emptyCard.className = "online-deck-card online-deck-card-placeholder";
    emptyCard.innerHTML = '<div class="online-deck-placeholder-text">暂无更多在线成员</div>';
    return emptyCard;
  }
  const { durationSec, todaySec } = computeOnlineDurations(item, nowMs);
  const card = document.createElement("article");
  card.className = "online-deck-card";
  card.dataset.key = String(item.key || "");
  card.innerHTML = `
    <div class="online-deck-card-head">
      <span class="online-deck-name">${escapeHtml(item.name || "-")}</span>
      <span class="online-deck-badge">在线</span>
    </div>
    <div class="online-deck-main">
      <span class="online-deck-main-label">在线时长</span>
      <span class="online-deck-main-value online-deck-duration-value">${formatDuration(durationSec)}</span>
    </div>
    <div class="online-deck-foot">
      <div class="online-deck-foot-item">
        <span class="k">签到时间</span>
        <span class="v">${escapeHtml(formatTimeToSecond(item.sign_in_time))}</span>
      </div>
      <div class="online-deck-foot-item">
        <span class="k">今日时长</span>
        <span class="v online-deck-today-value">${formatDuration(todaySec)}</span>
      </div>
    </div>
  `;
  return card;
}

function renderOnlineDeck(nowMs = Date.now(), options = {}) {
  const { startIndex = onlineDeckIndex } = options;
  const viewport = els.onlineDeckViewport;
  if (!viewport) return;
  viewport.innerHTML = "";
  if (!onlineSnapshot.length) {
    const empty = document.createElement("article");
    empty.className = "online-deck-empty";
    empty.textContent = "当前无人在线";
    viewport.appendChild(empty);
    return;
  }

  let focusItem = null;
  if (onlineFocusedKey) {
    focusItem = onlineSnapshot.find((item) => item.key === onlineFocusedKey) || null;
    if (!focusItem) onlineFocusedKey = null;
  }
  const rotating = getRotatingOnlineItems();
  normalizeOnlineDeckIndex();

  if (focusItem) {
    const focusLayer = document.createElement("div");
    focusLayer.className = "online-focus-layer";
    const focusCard = buildOnlineDeckCard(focusItem, nowMs, false);
    focusCard.classList.add("online-focus-card");
    focusLayer.appendChild(focusCard);
    viewport.appendChild(focusLayer);
  }

  const list = document.createElement("div");
  list.className = "online-deck-list";

  const total = rotating.length;
  if (!total) {
    viewport.appendChild(list);
    return list;
  }
  const begin = ((startIndex % total) + total) % total;
  const usePlaceholders = !focusItem && total <= 1;
  const cardCount = usePlaceholders ? Math.max(ONLINE_DECK_VISIBLE_COUNT, 1) : total;
  for (let i = 0; i < cardCount; i += 1) {
    if (usePlaceholders && i >= total) {
      list.appendChild(buildOnlineDeckCard(null, nowMs, true));
      continue;
    }
    const idx = (begin + i) % total;
    list.appendChild(buildOnlineDeckCard(rotating[idx], nowMs, false));
  }
  viewport.appendChild(list);
  return list;
}

function getOnlineDeckStepPx(list) {
  if (!list) return 0;
  const first = list.querySelector(".online-deck-card");
  if (!first) return 0;
  const cs = getComputedStyle(list);
  const gap = parseFloat(cs.rowGap || cs.gap || "0") || 0;
  return Math.max(1, Math.round(first.getBoundingClientRect().height + gap));
}

function updateOnlineDeckDurationsInPlace(nowMs = Date.now()) {
  const viewport = els.onlineDeckViewport;
  if (!viewport || !onlineSnapshot.length) return;
  const lookup = new Map(onlineSnapshot.map((item) => [item.key, item]));
  const cards = viewport.querySelectorAll(".online-deck-card[data-key]");
  for (const card of cards) {
    const key = String(card.dataset.key || "");
    const item = lookup.get(key);
    if (!item) continue;
    const { durationSec, todaySec } = computeOnlineDurations(item, nowMs);
    const durationEl = card.querySelector(".online-deck-duration-value");
    if (durationEl) {
      const t = formatDuration(durationSec);
      if (durationEl.textContent !== t) durationEl.textContent = t;
    }
    const todayEl = card.querySelector(".online-deck-today-value");
    if (todayEl) {
      const t = formatDuration(todaySec);
      if (todayEl.textContent !== t) todayEl.textContent = t;
    }
  }
}

async function stepOnlineDeck(direction) {
  if (onlineMode !== "deck" || onlineDeckAnimating) return;
  normalizeOnlineDeckIndex();
  const total = getRotatingOnlineItems().length;
  if (total <= 1) return;
  const viewport = els.onlineDeckViewport;
  if (!viewport) return;
  onlineDeckAnimating = true;
  const dir = direction < 0 ? -1 : 1;
  const list = viewport.querySelector(".online-deck-list") || renderOnlineDeck(Date.now());
  const stepPx = getOnlineDeckStepPx(list);
  if (!list || !stepPx) {
    onlineDeckAnimating = false;
    return;
  }
  if (dir > 0) {
    list.style.transition = `transform ${ONLINE_DECK_SCROLL_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
    list.style.transform = `translateY(-${stepPx}px)`;
    await waitMs(ONLINE_DECK_SCROLL_MS + 22);
    list.style.transition = "none";
    list.style.transform = "translateY(0)";
    const first = list.firstElementChild;
    if (first) list.appendChild(first);
    onlineDeckIndex = (onlineDeckIndex + 1) % total;
    void list.offsetHeight;
  } else {
    const last = list.lastElementChild;
    if (last) list.insertBefore(last, list.firstElementChild);
    list.style.transition = "none";
    list.style.transform = `translateY(-${stepPx}px)`;
    void list.offsetHeight;
    list.style.transition = `transform ${ONLINE_DECK_SCROLL_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`;
    list.style.transform = "translateY(0)";
    await waitMs(ONLINE_DECK_SCROLL_MS + 22);
    onlineDeckIndex = ((onlineDeckIndex - 1) % total + total) % total;
  }
  list.style.transition = "";
  list.style.transform = "none";
  updateOnlineDeckDurationsInPlace(Date.now());
  onlineDeckAnimating = false;
}

function renderOnlineTable(nowMs = Date.now()) {
  els.onlineBody.innerHTML = "";
  onlineRowRefs = new Map();
  if (!onlineSnapshot.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="4">no online users</td>';
    els.onlineBody.appendChild(tr);
    return;
  }
  for (const item of onlineSnapshot) {
    const { durationSec, todaySec } = computeOnlineDurations(item, nowMs);

    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = item.name;
    const tdTime = document.createElement("td");
    tdTime.textContent = formatTimeToSecond(item.sign_in_time);
    const tdDuration = document.createElement("td");
    tdDuration.textContent = formatDuration(durationSec);
    const tdToday = document.createElement("td");
    tdToday.textContent = formatDuration(todaySec);
    tr.appendChild(tdName);
    tr.appendChild(tdTime);
    tr.appendChild(tdDuration);
    tr.appendChild(tdToday);
    els.onlineBody.appendChild(tr);
    onlineRowRefs.set(item.key, { durationTd: tdDuration, todayTd: tdToday });
  }
}

function tickOnlineDurations(nowMs = Date.now()) {
  if (onlineMode === "deck") {
    if (!onlineDeckAnimating) updateOnlineDeckDurationsInPlace(nowMs);
    return;
  }
  if (!onlineSnapshot.length || !onlineRowRefs.size) return;
  for (const item of onlineSnapshot) {
    const ref = onlineRowRefs.get(item.key);
    if (!ref) continue;
    const { durationSec, todaySec } = computeOnlineDurations(item, nowMs);
    const nextText = formatDuration(durationSec);
    if (ref.durationTd.textContent !== nextText) {
      ref.durationTd.textContent = nextText;
    }
    const todayText = formatDuration(todaySec);
    if (ref.todayTd.textContent !== todayText) {
      ref.todayTd.textContent = todayText;
    }
  }
}

function scheduleOnlineTick() {
  if (onlineTickTimer) clearTimeout(onlineTickTimer);
  const now = Date.now();
  const delay = 1000 - (now % 1000) + 8;
  onlineTickTimer = setTimeout(() => {
    tickOnlineDurations(Date.now());
    scheduleOnlineTick();
  }, delay);
}

async function refreshOnline() {
  try {
    const prevKeys = onlineSnapshot.map((x) => x.key).join("||");
    const data = await request("/online-status?limit=50");
    const nextSnapshot = [];
    const keepKeys = new Set();
    for (const item of (data.items || [])) {
      const key = onlineRowKey(item);
      keepKeys.add(key);
      const rawBase = Number(item.online_duration_seconds) || 0;
      const prevDisplayed = onlineDisplayedSec.get(key);
      const baseSeconds = typeof prevDisplayed === "number" ? Math.max(rawBase, prevDisplayed) : rawBase;
      const rawTodayBase = Number(item.today_duration_seconds);
      const todayBaseFromApi = Number.isFinite(rawTodayBase) ? rawTodayBase : rawBase;
      const prevTodayDisplayed = onlineTodayDisplayedSec.get(key);
      const todayBaseSeconds =
        typeof prevTodayDisplayed === "number" ? Math.max(todayBaseFromApi, prevTodayDisplayed) : todayBaseFromApi;
      nextSnapshot.push({
        key,
        name: item.name,
        sign_in_time: item.sign_in_time,
        base_seconds: baseSeconds,
        today_base_seconds: todayBaseSeconds,
      });
    }
    for (const key of Array.from(onlineDisplayedSec.keys())) {
      if (!keepKeys.has(key)) onlineDisplayedSec.delete(key);
    }
    for (const key of Array.from(onlineTodayDisplayedSec.keys())) {
      if (!keepKeys.has(key)) onlineTodayDisplayedSec.delete(key);
    }
    const nextKeys = nextSnapshot.map((x) => x.key).join("||");
    const structureChanged = prevKeys !== nextKeys;
    onlineSnapshot = nextSnapshot;
    onlineLastSyncMs = Date.now();
    const focusChanged = applyDesiredOnlineFocus(false);
    normalizeOnlineDeckIndex();
    if (onlineMode === "deck") {
      if (!onlineDeckAnimating) {
        if (focusChanged || structureChanged || !els.onlineDeckViewport?.querySelector(".online-deck-list")) {
          renderOnlineDeck(onlineLastSyncMs);
          syncOnlineCardHeightAndNameSize();
        } else {
          updateOnlineDeckDurationsInPlace(onlineLastSyncMs);
        }
      }
      startOnlineDeckAutoScroll();
    } else {
      renderOnlineTable(onlineLastSyncMs);
      tickOnlineDurations(onlineLastSyncMs);
    }
  } catch (e) {
    log(`load online failed: ${e.message}`);
  }
}

function recordRow(item) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td>${item.id}</td><td>${item.name}</td><td>${item.action}</td><td>${item.event_time}</td><td>${item.duration}</td>`;
  return tr;
}

async function refreshRecords() {
  try {
    const data = await request("/attendance-records?limit=50");
    els.recordsBody.innerHTML = "";
    for (const item of data.items) els.recordsBody.appendChild(recordRow(item));
  } catch (e) {
    log(`load records failed: ${e.message}`);
  }
}

function getPendingCard(id) {
  const sid = String(id);
  return els.pendingBody.querySelector(`.pending-card[data-pending-id="${sid}"]`);
}

function pendingCardActionType(card) {
  if (card && card.classList.contains("signout")) return "signout";
  return "signin";
}

function startConfirmSuccessAnimation(card) {
  if (!card) return;
  card.classList.remove("is-confirming-flow", "is-leaving-confirm", "is-shattering-canvas", "is-shattering-whole");
  void card.offsetWidth;
  card.classList.add("is-confirming-flow");
}

function clearRejectShatterCanvas(card) {
  if (els.pendingBody) els.pendingBody.classList.remove("shatter-lock");
  if (!card) return;
  if (card._pendingShatterRafId) {
    cancelAnimationFrame(card._pendingShatterRafId);
    card._pendingShatterRafId = 0;
  }
  const canvas = card.querySelector(".pending-shatter-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  canvas.width = 0;
  canvas.height = 0;
}

function copyComputedStylesRecursive(sourceEl, cloneEl) {
  if (!(sourceEl instanceof HTMLElement) || !(cloneEl instanceof HTMLElement)) return;
  const computed = getComputedStyle(sourceEl);
  let cssText = "";
  for (let i = 0; i < computed.length; i += 1) {
    const prop = computed[i];
    cssText += `${prop}:${computed.getPropertyValue(prop)};`;
  }
  cloneEl.style.cssText = cssText;
  const sourceChildren = sourceEl.children;
  const cloneChildren = cloneEl.children;
  for (let i = 0; i < sourceChildren.length && i < cloneChildren.length; i += 1) {
    copyComputedStylesRecursive(sourceChildren[i], cloneChildren[i]);
  }
}

function cardSnapshotMeta(card) {
  const rect = card.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  return { width, height, dpr };
}

async function capturePendingCardSnapshotViaSvg(card) {
  const { width, height, dpr } = cardSnapshotMeta(card);

  const clone = card.cloneNode(true);
  if (!(clone instanceof HTMLElement)) throw new Error("invalid card clone");
  clone.classList.remove(
    "is-processing",
    "is-confirming",
    "is-confirming-flow",
    "is-leaving-confirm",
    "is-rejecting",
    "is-leaving-reject",
    "is-shattering-canvas",
    "is-shattering-whole",
    "is-invalid-shake"
  );
  copyComputedStylesRecursive(card, clone);

  for (const sel of [".pending-confirm-success", ".pending-shatter-canvas"]) {
    const node = clone.querySelector(sel);
    if (node) node.remove();
  }
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.margin = "0";
  clone.style.transform = "none";
  clone.style.animation = "none";
  clone.style.transition = "none";

  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  wrapper.style.width = `${width}px`;
  wrapper.style.height = `${height}px`;
  wrapper.style.overflow = "hidden";
  wrapper.appendChild(clone);

  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const blob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const node = new Image();
      node.decoding = "sync";
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error("card snapshot render failed"));
      node.src = url;
    });
    const snapshotCanvas = document.createElement("canvas");
    snapshotCanvas.width = Math.max(1, Math.round(width * dpr));
    snapshotCanvas.height = Math.max(1, Math.round(height * dpr));
    const snapshotCtx = snapshotCanvas.getContext("2d");
    if (!snapshotCtx) throw new Error("snapshot context unavailable");
    snapshotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    snapshotCtx.drawImage(img, 0, 0, width, height);
    return { canvas: snapshotCanvas, width, height, dpr };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadHtml2CanvasLib() {
  if (typeof window.html2canvas === "function") return window.html2canvas;
  if (html2CanvasLoadPromise) return html2CanvasLoadPromise;
  html2CanvasLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HTML2CANVAS_CDN;
    script.async = true;
    script.onload = () => {
      if (typeof window.html2canvas === "function") resolve(window.html2canvas);
      else reject(new Error("html2canvas loaded but unavailable"));
    };
    script.onerror = () => reject(new Error("html2canvas load failed"));
    document.head.appendChild(script);
  }).catch((err) => {
    html2CanvasLoadPromise = null;
    throw err;
  });
  return html2CanvasLoadPromise;
}

async function capturePendingCardSnapshotViaHtml2Canvas(card) {
  const { width, height, dpr } = cardSnapshotMeta(card);
  const html2canvas = await loadHtml2CanvasLib();
  const canvas = await html2canvas(card, {
    backgroundColor: null,
    scale: dpr,
    useCORS: true,
    logging: false,
  });
  if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error("html2canvas returned invalid canvas");
  }
  return {
    canvas,
    width,
    height,
    dpr: Math.max(1, canvas.width / Math.max(1, width)),
  };
}

async function capturePendingCardSnapshot(card) {
  const errs = [];
  try {
    return await capturePendingCardSnapshotViaSvg(card);
  } catch (e) {
    errs.push(`svg:${e.message}`);
  }
  try {
    return await capturePendingCardSnapshotViaHtml2Canvas(card);
  } catch (e) {
    errs.push(`html2canvas:${e.message}`);
  }
  throw new Error(errs.join(" | "));
}

function polygonCentroid(points) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p0 = points[i];
    const p1 = points[(i + 1) % points.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    area2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (Math.abs(area2) < 1e-5) {
    const sx = points.reduce((acc, p) => acc + p.x, 0);
    const sy = points.reduce((acc, p) => acc + p.y, 0);
    return { x: sx / points.length, y: sy / points.length };
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) };
}

function buildRandomShatterPolygons(width, height) {
  const cols = Math.floor(randRange(5, 8));
  const rows = Math.floor(randRange(4, 7));
  const points = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(null));

  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= cols; c += 1) {
      const xBase = (c / cols) * width;
      const yBase = (r / rows) * height;
      if (r === 0 || r === rows || c === 0 || c === cols) {
        points[r][c] = { x: xBase, y: yBase };
        continue;
      }
      const jx = randRange(-0.34, 0.34) * (width / cols);
      const jy = randRange(-0.34, 0.34) * (height / rows);
      points[r][c] = {
        x: Math.min(width, Math.max(0, xBase + jx)),
        y: Math.min(height, Math.max(0, yBase + jy)),
      };
    }
  }

  const polygons = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const p00 = points[r][c];
      const p10 = points[r][c + 1];
      const p11 = points[r + 1][c + 1];
      const p01 = points[r + 1][c];
      if (Math.random() < 0.35) {
        if (Math.random() < 0.5) {
          polygons.push([p00, p10, p11]);
          polygons.push([p00, p11, p01]);
        } else {
          polygons.push([p00, p10, p01]);
          polygons.push([p10, p11, p01]);
        }
      } else {
        polygons.push([p00, p10, p11, p01]);
      }
    }
  }
  return polygons;
}

function buildShatterParticles(width, height, impactX, impactY) {
  const span = Math.max(width, height);
  const polygons = buildRandomShatterPolygons(width, height);
  return polygons.map((poly) => {
    const center = polygonCentroid(poly);
    const dx = center.x - impactX;
    const dy = center.y - impactY;
    const dist = Math.max(10, Math.hypot(dx, dy));
    const nx = dx / dist;
    const ny = dy / dist;
    const amp = randRange(130, 260) + randRange(40, 180) * (1 - Math.min(1, dist / span));
    const vx = nx * amp + randRange(-46, 46);
    const vy = ny * amp - randRange(48, 110);
    return {
      points: poly,
      center,
      local: poly.map((p) => ({ x: p.x - center.x, y: p.y - center.y })),
      vx,
      vy,
      gravity: randRange(260, 420),
      spin: randRange(-2.8, 2.8),
      delay: randRange(0, 0.12),
      decay: randRange(0.92, 1.18),
      scaleLoss: randRange(0.12, 0.28),
      blurMax: randRange(0.6, 1.8),
    };
  });
}

function drawShatterFrame(
  ctx,
  snapshot,
  particles,
  width,
  height,
  impactX,
  impactY,
  progress,
  originX = 0,
  originY = 0,
  canvasW = width,
  canvasH = height
) {
  ctx.clearRect(0, 0, canvasW, canvasH);
  const dayMode = document.body && document.body.dataset && document.body.dataset.theme === "day";

  const shock = Math.max(0, 1 - progress * 3.8);
  if (shock > 0) {
    const gx = originX + impactX;
    const gy = originY + impactY;
    const glow = ctx.createRadialGradient(gx, gy, 2, gx, gy, Math.max(width, height) * 0.45);
    if (dayMode) {
      glow.addColorStop(0, `rgba(86,133,214,${0.24 * shock})`);
    } else {
      glow.addColorStop(0, `rgba(255,255,255,${0.2 * shock})`);
    }
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvasW, canvasH);
  }

  for (const piece of particles) {
    const localProgress = Math.max(0, Math.min(1, (progress - piece.delay) / (1 - piece.delay)));
    if (localProgress <= 0) continue;
    const ease = 1 - Math.pow(1 - localProgress, 2.3);
    const moveX = piece.vx * ease;
    const moveY = piece.vy * ease + piece.gravity * ease * ease * 0.5;
    const alpha = Math.max(0, 1 - Math.pow(localProgress, piece.decay));
    if (alpha <= 0.002) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(originX + piece.center.x + moveX, originY + piece.center.y + moveY);
    ctx.rotate(piece.spin * ease);
    const scale = Math.max(0.68, 1 - piece.scaleLoss * ease);
    ctx.scale(scale, scale);
    const blurPx = Math.max(0, (localProgress - 0.3) * piece.blurMax);
    ctx.filter = blurPx > 0.03 ? `blur(${blurPx.toFixed(2)}px)` : "none";
    ctx.beginPath();
    for (let i = 0; i < piece.local.length; i += 1) {
      const p = piece.local[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(
      snapshot,
      0,
      0,
      snapshot.width,
      snapshot.height,
      originX - piece.center.x,
      originY - piece.center.y,
      width,
      height
    );
    if (dayMode) {
      ctx.shadowBlur = 8;
      ctx.shadowColor = `rgba(17, 42, 86, ${Math.min(0.28, alpha * 0.36)})`;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = `rgba(23, 52, 102, ${Math.min(0.58, alpha * 0.72)})`;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.34, alpha * 0.44)})`;
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.42, alpha * 0.55)})`;
      ctx.stroke();
    }
    ctx.restore();
  }
}

async function startRejectShatterAnimation(card) {
  if (!card) return false;
  clearRejectShatterCanvas(card);
  if (els.pendingBody) els.pendingBody.classList.add("shatter-lock");
  card.classList.remove("is-rejecting", "is-leaving-reject", "is-confirming-flow");
  void card.offsetWidth;

  let snap;
  try {
    snap = await capturePendingCardSnapshot(card);
  } catch (e) {
    log(`reject shatter snapshot failed: ${e.message}`);
    if (els.pendingBody) els.pendingBody.classList.remove("shatter-lock");
    return false;
  }

  const padding = Math.max(36, Math.round(Math.max(snap.width, snap.height) * 0.22));
  const floatW = snap.width + padding * 2;
  const floatH = snap.height + padding * 2;
  const canvas = card.querySelector(".pending-shatter-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return false;
  canvas.width = Math.max(1, Math.round(floatW * snap.dpr));
  canvas.height = Math.max(1, Math.round(floatH * snap.dpr));
  canvas.style.width = `${floatW}px`;
  canvas.style.height = `${floatH}px`;
  canvas.style.left = `${-padding}px`;
  canvas.style.top = `${-padding}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.setTransform(snap.dpr, 0, 0, snap.dpr, 0, 0);

  const impactX = randRange(snap.width * 0.3, snap.width * 0.7);
  const impactY = randRange(snap.height * 0.24, snap.height * 0.62);
  const particles = buildShatterParticles(snap.width, snap.height, impactX, impactY);
  card.classList.add("is-shattering-whole");

  const startAt = performance.now();
  const durationMs = PENDING_REJECT_SHATTER_MS;
  const tick = (now) => {
    const progress = Math.max(0, Math.min(1, (now - startAt) / durationMs));
    drawShatterFrame(
      ctx,
      snap.canvas,
      particles,
      snap.width,
      snap.height,
      impactX,
      impactY,
      progress,
      padding,
      padding,
      floatW,
      floatH
    );
    if (progress < 1) {
      card._pendingShatterRafId = requestAnimationFrame(tick);
    } else {
      card._pendingShatterRafId = 0;
      if (els.pendingBody) els.pendingBody.classList.remove("shatter-lock");
    }
  };
  card._pendingShatterRafId = requestAnimationFrame(tick);
  return true;
}

function endPendingAnimationClasses(card) {
  if (!card) return;
  card.classList.remove(
    "is-confirming",
    "is-confirming-flow",
    "is-leaving-confirm",
    "is-rejecting",
    "is-leaving-reject",
    "is-shattering-canvas",
    "is-shattering-whole"
  );
  clearRejectShatterCanvas(card);
}

function shakePendingCard(card) {
  if (!card) return;
  card.classList.remove("is-invalid-shake");
  void card.offsetWidth;
  card.classList.add("is-invalid-shake");
  setTimeout(() => card.classList.remove("is-invalid-shake"), 460);
}

function mapConfirmInvalidReason(error, actionType = "signin") {
  const status = Number(error && error.status);
  const detail = String((error && (error.detail || error.message)) || "").trim();
  const lower = detail.toLowerCase();

  if (detail.includes("当前已签到") || detail.includes("重复签到")) {
    return "当前已签到，请勿重复签到。";
  }
  if (detail.includes("还没有签到") || detail.includes("不能签退")) {
    return "当前未签到，不能签退。";
  }
  if (detail.includes("上一状态为签退")) {
    return "当前未签到，请先签到后再签退。";
  }
  if (lower.includes("pending action not found")) {
    return "该待确认动作已失效或已被处理，请刷新列表。";
  }
  if (lower.includes("email missing")) {
    return "该用户未填写邮箱，请先在管理员页面补全邮箱。";
  }
  if (lower.includes("email invalid")) {
    return "该用户邮箱格式无效，请先在管理员页面修正邮箱。";
  }
  if (
    lower.includes("cannot confirm") ||
    lower.includes("not pending") ||
    detail.includes("状态") ||
    detail.includes("褰撳墠")
  ) {
    return "该动作当前不可确认，可能已被处理，请刷新后重试。";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "网络连接异常，请检查网络后重试。";
  }
  if (Number.isFinite(status) && status >= 500) {
    return "服务器繁忙，请稍后重试。";
  }
  return actionType === "signout" ? "签退确认失败，请稍后重试。" : "签到确认失败，请稍后重试。";
}

function showInvalidReasonPopup(reasonText) {
  const text = String(reasonText || "").trim() || "确认失败，请稍后重试。";
  if (!els.invalidReasonToast || !els.invalidReasonText) {
    alert(`操作无效：${text}`);
    return;
  }
  if (invalidReasonToastTimer) {
    clearTimeout(invalidReasonToastTimer);
    invalidReasonToastTimer = null;
  }
  els.invalidReasonText.textContent = text;
  els.invalidReasonToast.hidden = false;
  els.invalidReasonToast.classList.remove("show");
  void els.invalidReasonToast.offsetWidth;
  els.invalidReasonToast.classList.add("show");

  invalidReasonToastTimer = setTimeout(() => {
    els.invalidReasonToast.classList.remove("show");
    setTimeout(() => {
      if (!els.invalidReasonToast.classList.contains("show")) {
        els.invalidReasonToast.hidden = true;
      }
    }, 220);
  }, 3200);
}

function initOnlineModeUI() {
  const saved = localStorage.getItem(ONLINE_MODE_KEY);
  setOnlineMode(saved === "deck" ? "deck" : "table", false);

  if (els.onlineModeToggle) {
    els.onlineModeToggle.addEventListener("change", () => {
      setOnlineMode(els.onlineModeToggle.checked ? "deck" : "table", true);
    });
  }

  const wheelHost = els.onlineSideCard;
  if (wheelHost) {
    wheelHost.addEventListener(
      "wheel",
      (e) => {
        if (onlineMode !== "deck") return;
        if (getRotatingOnlineItems().length <= 1) return;
        e.preventDefault();
        const now = Date.now();
        if (now - onlineDeckLastStepTs < 170) return;
        onlineDeckLastStepTs = now;
        const direction = e.deltaY < 0 ? -1 : 1;
        stepOnlineDeck(direction);
      },
      { passive: false }
    );
  }

  const touchHost = els.onlineDeckViewport || els.onlineDeckWrap;
  if (touchHost) {
    touchHost.addEventListener(
      "touchstart",
      (e) => {
        if (onlineMode !== "deck" || getRotatingOnlineItems().length <= 1) return;
        if (!e.touches || !e.touches.length) return;
        onlineDeckTouchStartY = e.touches[0].clientY;
      },
      { passive: true }
    );
    touchHost.addEventListener(
      "touchmove",
      (e) => {
        if (onlineMode !== "deck" || getRotatingOnlineItems().length <= 1) return;
        e.preventDefault();
      },
      { passive: false }
    );
    touchHost.addEventListener(
      "touchend",
      (e) => {
        if (onlineMode !== "deck" || getRotatingOnlineItems().length <= 1) return;
        if (onlineDeckTouchStartY == null || !e.changedTouches || !e.changedTouches.length) {
          onlineDeckTouchStartY = null;
          return;
        }
        const dy = e.changedTouches[0].clientY - onlineDeckTouchStartY;
        onlineDeckTouchStartY = null;
        if (Math.abs(dy) < 22) return;
        const direction = dy < 0 ? -1 : 1;
        stepOnlineDeck(direction);
      },
      { passive: true }
    );
  }
}

function setPendingCardBusy(card, busy) {
  if (!card) return;
  card.classList.toggle("is-processing", busy);
  const buttons = card.querySelectorAll("button");
  buttons.forEach((btn) => {
    btn.disabled = !!busy;
  });
}

async function confirmPending(id) {
  const sid = String(id);
  if (pendingActionInFlight.has(sid)) return;
  pendingActionInFlight.add(sid);
  const card = getPendingCard(sid);
  try {
    setPendingCardBusy(card, true);
    const res = await request(`/pending-actions/${sid}/confirm`, { method: "POST" });
    const sync = res && res.external_sync ? res.external_sync : null;
    if (sync && sync.status) {
      const syncDetail = [sync.status, sync.http_status || "", sync.error || sync.reason || ""]
        .filter(Boolean)
        .join(" | ");
      log(`confirmed #${sid} | external sync: ${syncDetail}`);
    } else {
      log(`confirmed #${sid}`);
    }
    if (card) {
      startConfirmSuccessAnimation(card);
      await waitMs(PENDING_CONFIRM_SUCCESS_MS);
      card.classList.add("is-leaving-confirm");
      await waitMs(PENDING_CONFIRM_LEAVE_MS);
    }
    pendingActionInFlight.delete(sid);
    await refreshPending();
    await refreshOnline();
    await refreshRecords();
  } catch (e) {
    pendingActionInFlight.delete(sid);
    if (card) {
      endPendingAnimationClasses(card);
      setPendingCardBusy(card, false);
    }
    const actionType = pendingCardActionType(card);
    const reason = mapConfirmInvalidReason(e, actionType);
    shakePendingCard(card);
    showInvalidReasonPopup(reason);
    log(`confirm failed #${sid}: ${reason}`);
  }
}

async function rejectPending(id) {
  const sid = String(id);
  if (pendingActionInFlight.has(sid)) return;
  pendingActionInFlight.add(sid);
  const card = getPendingCard(sid);
  try {
    setPendingCardBusy(card, true);
    if (card) {
      card.classList.add("is-rejecting");
      await waitMs(220);
      card.classList.remove("is-rejecting");
    }
    await request(`/pending-actions/${sid}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual_reject" }),
    });
    log(`rejected #${sid}`);
    if (card) {
      const played = await startRejectShatterAnimation(card);
      if (played) {
        await waitMs(PENDING_REJECT_SHATTER_MS);
      } else {
        card.classList.add("is-leaving-reject");
        await waitMs(260);
      }
    }
    pendingActionInFlight.delete(sid);
    await refreshPending();
  } catch (e) {
    pendingActionInFlight.delete(sid);
    if (card) {
      endPendingAnimationClasses(card);
      setPendingCardBusy(card, false);
    }
    log(`reject failed #${sid}: ${e.message}`);
  }
}

els.btnRefreshRecords.addEventListener("click", refreshRecords);
els.btnDetectCameras.addEventListener("click", detectCameras);
if (els.btnTogglePreview) els.btnTogglePreview.addEventListener("click", togglePreview);
if (els.btnRotate90) els.btnRotate90.addEventListener("click", rotatePreview90);
if (els.btnMirrorX) els.btnMirrorX.addEventListener("click", toggleMirrorX);

els.pendingBody.addEventListener("click", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const confirmId = t.getAttribute("data-confirm");
  const rejectId = t.getAttribute("data-reject");
  if (confirmId) await confirmPending(confirmId);
  if (rejectId) await rejectPending(rejectId);
});

window.addEventListener("resize", () => {
  applyPreviewRotation();
  if (lastOverlayData) drawOverlay(lastOverlayData);
  else clearOverlay();
  scheduleLayoutSync();
});

window.addEventListener("load", () => {
  scheduleLayoutSync();
});

window.addEventListener("beforeunload", () => {
  if (onlineTickTimer) clearTimeout(onlineTickTimer);
  stopPreview();
});

(async function boot() {
  initSettingsPopover();
  initThemeAuto();
  initPreviewMode();
  initOnlineModeUI();
  await refreshHealth();
  await detectCameras();
  updatePreviewToggleButton();
  setWsModeStatus("WS: stopped");
  setOverlayStatus("video: idle");
  applyPreviewRotation();
  clearOverlay();
  await refreshPending();
  await refreshOnline();
  await refreshRecords();
  scheduleLayoutSync();
  scheduleOnlineTick();
  setInterval(refreshHealth, 10000);
  setInterval(refreshPending, 2500);
  setInterval(refreshOnline, 4000);
  setInterval(refreshRecords, 6000);
})();




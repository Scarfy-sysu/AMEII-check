const els = {
  btnLogout: document.getElementById("btnLogout"),
  tabRegister: document.getElementById("tabRegister"),
  tabLibrary: document.getElementById("tabLibrary"),
  tabOps: document.getElementById("tabOps"),
  panelRegister: document.getElementById("panelRegister"),
  panelLibrary: document.getElementById("panelLibrary"),
  panelOps: document.getElementById("panelOps"),

  cameraSupport: document.getElementById("cameraSupport"),
  btnDetectCameras: document.getElementById("btnDetectCameras"),
  cameraSelect: document.getElementById("cameraSelect"),
  btnStartPreview: document.getElementById("btnStartPreview"),
  btnStopPreview: document.getElementById("btnStopPreview"),
  btnRotate90: document.getElementById("btnRotate90"),
  cameraPreview: document.getElementById("cameraPreview"),

  nameInput: document.getElementById("nameInput"),
  emailInput: document.getElementById("emailInput"),
  noteInput: document.getElementById("noteInput"),
  btnCapture: document.getElementById("btnCapture"),
  btnRetake: document.getElementById("btnRetake"),
  btnRegisterFace: document.getElementById("btnRegisterFace"),
  registerMsg: document.getElementById("registerMsg"),
  capturePlaceholder: document.getElementById("capturePlaceholder"),
  capturePreview: document.getElementById("capturePreview"),

  faceSearchInput: document.getElementById("faceSearchInput"),
  btnRefreshFaces: document.getElementById("btnRefreshFaces"),
  facesBody: document.getElementById("facesBody"),

  opsTypeFilter: document.getElementById("opsTypeFilter"),
  opsKeywordInput: document.getElementById("opsKeywordInput"),
  btnRefreshOps: document.getElementById("btnRefreshOps"),
  opsBody: document.getElementById("opsBody"),
  logBox: document.getElementById("logBox"),
};

const OPS_STORAGE_KEY = "facecheck_admin_ops_v1";
const MAX_OPS = 300;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const THEME_DAY_KEY = "facecheck_theme_day_v1";

let previewStream = null;
let rotationDeg = 0;
let capturedImageB64 = "";
let facesCache = [];
let opsCache = [];

function applyThemeFromPreference() {
  let isDay = false;
  try {
    isDay = localStorage.getItem(THEME_DAY_KEY) === "1";
  } catch (_) {
    // ignore localStorage failures
  }
  document.body.dataset.theme = isDay ? "day" : "night";
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function isValidEmail(v) {
  const email = normalizeEmail(v);
  return email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
}

function nowIsoLocal() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function log(msg) {
  const now = new Date().toLocaleTimeString();
  els.logBox.textContent = `[${now}] ${msg}\n${els.logBox.textContent}`;
}

function setRegisterMsg(text, isError = false) {
  els.registerMsg.textContent = text;
  els.registerMsg.style.color = isError ? "#ff8a8a" : "";
}

function setCapturePreviewState(hasImage) {
  const showImage = !!hasImage;
  if (els.capturePreview) {
    els.capturePreview.classList.toggle("ready", showImage);
  }
  if (els.capturePlaceholder) {
    els.capturePlaceholder.classList.toggle("hidden", showImage);
  }
}

async function request(path, options = {}) {
  const resp = await fetch(path, {
    credentials: "include",
    ...options,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text}`);
  }
  return resp.json();
}

async function ensureAdmin() {
  try {
    const me = await request("/admin/me");
    if (!me.ok) location.href = "/admin/login";
  } catch (_) {
    location.href = "/admin/login";
  }
}

function setActiveTab(tab) {
  const config = [
    { key: "register", btn: els.tabRegister, panel: els.panelRegister },
    { key: "library", btn: els.tabLibrary, panel: els.panelLibrary },
    { key: "ops", btn: els.tabOps, panel: els.panelOps },
  ];
  for (const item of config) {
    const active = item.key === tab;
    item.btn.classList.toggle("primary", active);
    item.panel.classList.toggle("active", active);
  }
}

function saveOps() {
  try {
    localStorage.setItem(OPS_STORAGE_KEY, JSON.stringify(opsCache));
  } catch (_) {
    // ignore storage errors
  }
}

function loadOps() {
  try {
    const raw = localStorage.getItem(OPS_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) opsCache = arr.slice(0, MAX_OPS);
  } catch (_) {
    opsCache = [];
  }
}

function addOp(action, target, result, detail = "") {
  opsCache.unshift({
    time: nowIsoLocal(),
    action,
    target,
    result,
    detail,
  });
  if (opsCache.length > MAX_OPS) opsCache = opsCache.slice(0, MAX_OPS);
  saveOps();
  renderOps();
}

function opRow(item) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${item.time || "-"}</td>
    <td>${item.action || "-"}</td>
    <td>${item.target || "-"}</td>
    <td>${item.result || "-"}</td>
    <td>${item.detail || "-"}</td>
  `;
  return tr;
}

function renderOps() {
  const typeFilter = (els.opsTypeFilter.value || "").trim();
  const keyword = (els.opsKeywordInput.value || "").trim().toLowerCase();
  const rows = opsCache.filter((item) => {
    if (typeFilter && item.action !== typeFilter) return false;
    if (!keyword) return true;
    const hay = `${item.target || ""} ${item.detail || ""}`.toLowerCase();
    return hay.includes(keyword);
  });

  els.opsBody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="5">暂无操作记录</td>';
    els.opsBody.appendChild(tr);
    return;
  }
  for (const item of rows) els.opsBody.appendChild(opRow(item));
}

async function logout() {
  try {
    await request("/admin/logout", { method: "POST" });
  } catch (_) {
    // ignore
  }
  location.href = "/admin/login";
}

function stopPreview() {
  if (!previewStream) return;
  for (const t of previewStream.getTracks()) t.stop();
  previewStream = null;
  els.cameraPreview.srcObject = null;
}

function getRotationScale() {
  if (rotationDeg % 180 === 0) return 1;
  const wrap = els.cameraPreview?.parentElement;
  if (!wrap) return 1;
  const w = Math.max(1, wrap.clientWidth || 1);
  const h = Math.max(1, wrap.clientHeight || 1);
  return Math.min(w / h, h / w);
}

function applyRotation() {
  const scale = getRotationScale();
  els.cameraPreview.style.transform = `rotate(${rotationDeg}deg) scale(${scale})`;
  els.btnRotate90.title = `旋转90度（当前 ${rotationDeg}°）`;
}

function rotate90() {
  rotationDeg = (rotationDeg + 90) % 360;
  applyRotation();
}

async function detectCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    els.cameraSupport.textContent = "浏览器不支持";
    log("浏览器不支持 mediaDevices API");
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    els.cameraSelect.innerHTML = "";
    for (const cam of cams) {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `camera-${cam.deviceId.slice(0, 8)}`;
      els.cameraSelect.appendChild(opt);
    }
    els.cameraSupport.textContent = cams.length ? `检测到 ${cams.length} 个摄像头` : "未检测到摄像头";
  } catch (e) {
    els.cameraSupport.textContent = "检测失败";
    log(`检测摄像头失败: ${e.message}`);
  }
}

async function startPreview() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    log("浏览器不支持 getUserMedia");
    return false;
  }
  stopPreview();
  try {
    const deviceId = els.cameraSelect.value;
    const constraints = deviceId
      ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }
      : { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    previewStream = await navigator.mediaDevices.getUserMedia(constraints);
    els.cameraPreview.srcObject = previewStream;
    applyRotation();
    return true;
  } catch (e) {
    log(`打开摄像头失败: ${e.message}`);
    return false;
  }
}

function capturePreviewBase64() {
  const v = els.cameraPreview;
  if (!v || v.readyState < 2) {
    throw new Error("摄像头画面尚未就绪，请先打开摄像头");
  }

  const srcW = v.videoWidth || 640;
  const srcH = v.videoHeight || 480;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const deg = ((rotationDeg % 360) + 360) % 360;

  if (deg === 90 || deg === 270) {
    canvas.width = srcH;
    canvas.height = srcW;
  } else {
    canvas.width = srcW;
    canvas.height = srcH;
  }

  if (deg === 90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(v, 0, 0, srcW, srcH);
  } else if (deg === 180) {
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(v, 0, 0, srcW, srcH);
  } else if (deg === 270) {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(v, 0, 0, srcW, srcH);
  } else {
    ctx.drawImage(v, 0, 0, srcW, srcH);
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return dataUrl.split(",", 2)[1];
}

function captureNow() {
  capturedImageB64 = capturePreviewBase64();
  els.capturePreview.src = `data:image/jpeg;base64,${capturedImageB64}`;
  setCapturePreviewState(true);
  setRegisterMsg("已拍照，可以直接提交注册");
}

function clearCapture() {
  capturedImageB64 = "";
  els.capturePreview.removeAttribute("src");
  setCapturePreviewState(false);
  setRegisterMsg("请重新拍照");
}

async function registerFace() {
  const name = (els.nameInput.value || "").trim();
  const email = normalizeEmail(els.emailInput.value || "");
  const note = (els.noteInput.value || "").trim();

  if (!name) {
    setRegisterMsg("请输入姓名", true);
    return;
  }
  if (!isValidEmail(email)) {
    setRegisterMsg("请输入有效邮箱", true);
    return;
  }

  try {
    if (!capturedImageB64) captureNow();
    setRegisterMsg("提交中...");
    const data = await request("/admin/faces/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, image_b64: capturedImageB64 }),
    });
    const sampleCount = Number(data.sample_count || 0);
    const sampleHint = sampleCount > 0 ? `（当前样本数：${sampleCount}）` : "";
    setRegisterMsg(`注册成功：${data.name || name}${sampleHint}`);
    addOp("注册", `${name} <${email}>`, "成功", note || "通过摄像头注册");
    log(`注册成功: ${name} (${email})`);
    clearCapture();
    els.nameInput.value = "";
    els.emailInput.value = "";
    els.noteInput.value = "";
    await refreshFaces();
    setActiveTab("library");
  } catch (e) {
    setRegisterMsg(`注册失败: ${e.message}`, true);
    addOp("注册", `${name || "-"} <${email || "-"}>`, "失败", e.message);
    log(`注册失败: ${e.message}`);
  }
}

function faceRow(item) {
  const emailText = (item.email || "").trim() || "待填写";
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${item.id}</td>
    <td>${item.name}</td>
    <td>${emailText}</td>
    <td>${item.created_time}</td>
    <td><img class="face-thumb" alt="${item.name}" /></td>
    <td>
      <button class="btn" data-append="${item.id}" data-name="${item.name}" data-current-email="${item.email || ""}">补样本</button>
      <button class="btn" data-email="${item.id}" data-name="${item.name}" data-current-email="${item.email || ""}">${item.email ? "改邮箱" : "填邮箱"}</button>
      <button class="btn" data-rename="${item.id}" data-name="${item.name}">改名</button>
      <button class="btn danger" data-delete="${item.id}" data-name="${item.name}">删除</button>
    </td>
  `;

  const img = tr.querySelector("img.face-thumb");
  const baseUrl = `/admin/faces/${item.id}/image`;
  let retries = 0;
  const maxRetries = 3;

  const setImgSrc = () => {
    img.src = `${baseUrl}?t=${Date.now()}&r=${retries}`;
  };

  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => {
    if (retries >= maxRetries) {
      img.alt = `${item.name}-加载失败`;
      return;
    }
    retries += 1;
    setTimeout(setImgSrc, 220 * retries);
  });

  setImgSrc();
  return tr;
}

function renderFaces() {
  const keyword = (els.faceSearchInput.value || "").trim().toLowerCase();
  const rows = facesCache.filter((item) => {
    if (!keyword) return true;
    const name = String(item.name || "").toLowerCase();
    const email = String(item.email || "").toLowerCase();
    return name.includes(keyword) || email.includes(keyword);
  });

  els.facesBody.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6">暂无人脸数据</td>';
    els.facesBody.appendChild(tr);
    return;
  }

  for (const item of rows) els.facesBody.appendChild(faceRow(item));
}

async function refreshFaces() {
  try {
    const data = await request("/admin/faces");
    facesCache = Array.isArray(data.items) ? data.items : [];
    renderFaces();
  } catch (e) {
    log(`加载人脸列表失败: ${e.message}`);
    addOp("系统", "人脸库", "失败", e.message);
  }
}

async function renameFace(id, oldName) {
  const next = (prompt("请输入新姓名", oldName) || "").trim();
  if (!next || next === oldName) return;

  try {
    const res = await request(`/admin/faces/${id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next, legacy_names: [oldName] }),
    });

    const u = (res && res.updated) || {};
    const detail = `ID=${id}, attendance=${u.attendance || 0}, pending=${u.pending_actions || 0}, sync_jobs=${u.external_sync_jobs || 0}`;
    addOp("改名", `${oldName} -> ${next}`, "成功", detail);
    log(`改名成功 #${id}: ${oldName} -> ${next}; ${detail}`);
    await refreshFaces();
  } catch (e) {
    addOp("改名", `${oldName} -> ${next}`, "失败", e.message);
    log(`改名失败 #${id}: ${e.message}`);
  }
}

async function updateEmail(id, name, currentEmail) {
  const raw = prompt(`请输入 ${name} 的邮箱`, currentEmail || "");
  if (raw == null) return;

  const nextEmail = normalizeEmail(raw);
  if (!isValidEmail(nextEmail)) {
    log("邮箱格式不正确");
    addOp("邮箱", name, "失败", "邮箱格式不正确");
    return;
  }

  try {
    await request(`/admin/faces/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: nextEmail }),
    });
    addOp("邮箱", name, "成功", `${currentEmail || "待填写"} -> ${nextEmail}`);
    log(`邮箱更新成功 #${id}: ${nextEmail}`);
    await refreshFaces();
  } catch (e) {
    addOp("邮箱", name, "失败", e.message);
    log(`邮箱更新失败 #${id}: ${e.message}`);
  }
}

async function deleteFace(id, name) {
  const ok = confirm(`确认删除 ${name}（ID=${id}）吗？删除后不可恢复。`);
  if (!ok) return;

  try {
    await request(`/admin/faces/${id}`, { method: "DELETE" });
    addOp("删除", name, "成功", `ID=${id}`);
    log(`删除成功 #${id}`);
    await refreshFaces();
  } catch (e) {
    addOp("删除", name, "失败", e.message);
    log(`删除失败 #${id}: ${e.message}`);
  }
}

function appendSampleForUser(name, currentEmail) {
  const n = (name || "").trim();
  const e = normalizeEmail(currentEmail || "");
  if (!n) return;
  setActiveTab("register");
  els.nameInput.value = n;
  if (e) els.emailInput.value = e;
  setRegisterMsg(`已切换到补样本：${n}，请拍照后提交注册`);
  log(`补样本模式: ${n}`);
  try {
    els.nameInput.focus();
  } catch (_) {
    // ignore
  }
}

els.btnLogout.addEventListener("click", logout);
els.btnDetectCameras.addEventListener("click", detectCameras);
els.btnStartPreview.addEventListener("click", startPreview);
els.btnStopPreview.addEventListener("click", stopPreview);
els.btnRotate90.addEventListener("click", rotate90);

els.btnCapture.addEventListener("click", () => {
  try {
    captureNow();
  } catch (e) {
    setRegisterMsg(e.message, true);
  }
});

els.btnRetake.addEventListener("click", clearCapture);
els.btnRegisterFace.addEventListener("click", registerFace);
els.btnRefreshFaces.addEventListener("click", refreshFaces);
els.faceSearchInput.addEventListener("input", renderFaces);
els.btnRefreshOps.addEventListener("click", renderOps);
els.opsTypeFilter.addEventListener("change", renderOps);
els.opsKeywordInput.addEventListener("input", renderOps);

for (const tabBtn of [els.tabRegister, els.tabLibrary, els.tabOps]) {
  tabBtn.addEventListener("click", () => setActiveTab(tabBtn.dataset.tab || "register"));
}

els.facesBody.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  const renameId = target.getAttribute("data-rename");
  const emailId = target.getAttribute("data-email");
  const deleteId = target.getAttribute("data-delete");
  const appendId = target.getAttribute("data-append");
  const name = target.getAttribute("data-name") || "";
  const currentEmail = target.getAttribute("data-current-email") || "";

  if (appendId) {
    appendSampleForUser(name, currentEmail);
    return;
  }
  if (emailId) {
    await updateEmail(emailId, name, currentEmail);
    return;
  }
  if (renameId) {
    await renameFace(renameId, name);
    return;
  }
  if (deleteId) {
    await deleteFace(deleteId, name);
  }
});

window.addEventListener("resize", applyRotation);
window.addEventListener("beforeunload", stopPreview);
window.addEventListener("storage", (event) => {
  if (event.key === THEME_DAY_KEY) applyThemeFromPreference();
});

(async function boot() {
  applyThemeFromPreference();
  await ensureAdmin();
  setCapturePreviewState(false);

  if (els.capturePreview) {
    els.capturePreview.addEventListener("error", () => {
      setCapturePreviewState(false);
      setRegisterMsg("预览加载失败，请重新拍照", true);
    });
  }

  loadOps();
  setActiveTab("register");
  await detectCameras();
  await refreshFaces();
  renderOps();
})();

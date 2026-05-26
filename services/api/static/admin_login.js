const form = document.getElementById("loginForm");
const passwordInput = document.getElementById("passwordInput");
const loginMsg = document.getElementById("loginMsg");
const THEME_DAY_KEY = "facecheck_theme_day_v1";

function applyThemeFromPreference() {
  let isDay = false;
  try {
    isDay = localStorage.getItem(THEME_DAY_KEY) === "1";
  } catch (_) {
    // ignore localStorage failures
  }
  document.body.dataset.theme = isDay ? "day" : "night";
}

function setMsg(text, isError = false) {
  loginMsg.textContent = text;
  loginMsg.style.color = isError ? "#ff8a8a" : "";
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

async function checkAuthed() {
  try {
    const me = await request("/admin/me");
    if (me.ok) location.href = "/admin";
  } catch (_) {
    // ignore
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = (passwordInput.value || "").trim();
  if (!password) {
    setMsg("请输入管理员密码", true);
    return;
  }

  try {
    await request("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setMsg("登录成功，正在跳转...");
    location.href = "/admin";
  } catch (err) {
    setMsg(`登录失败: ${err.message}`, true);
  }
});

window.addEventListener("storage", (event) => {
  if (event.key === THEME_DAY_KEY) applyThemeFromPreference();
});

applyThemeFromPreference();
checkAuthed();

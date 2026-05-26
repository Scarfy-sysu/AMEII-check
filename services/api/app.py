import asyncio
import hashlib
import datetime
import hmac
import json
import os
import re
import time
from pathlib import Path
from typing import Generator, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus
from urllib.request import Request as UrlRequest, urlopen

import websockets
from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from DB import DB


app = FastAPI(title="Face Attendance API", version="1.0.0")
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
LIVE_PREVIEW_PATH = Path(os.getenv("LIVE_PREVIEW_PATH", "/data/live_preview.jpg"))
WEBCAM_WS_BACKEND = os.getenv("WEBCAM_WS_BACKEND", "ws://host.docker.internal:8765/ws/camera")
WEBCAM_INTERNAL_REGISTER_URL = os.getenv(
    "WEBCAM_INTERNAL_REGISTER_URL", "http://host.docker.internal:8765/internal/register-face"
)
WEBCAM_INTERNAL_INFER_URL = os.getenv(
    "WEBCAM_INTERNAL_INFER_URL", "http://host.docker.internal:8765/internal/infer-frame"
)
EXTERNAL_SYNC_URL = os.getenv("EXTERNAL_SYNC_URL", "").strip()
EXTERNAL_SYNC_SECRET = os.getenv("EXTERNAL_SYNC_SECRET", "").strip()
EXTERNAL_SYNC_BEARER_TOKEN = os.getenv("EXTERNAL_SYNC_BEARER_TOKEN", "").strip()
EXTERNAL_SYNC_ENABLED = os.getenv("EXTERNAL_SYNC_ENABLED", "0").strip().lower() not in {"0", "false", "no", "off"}
EXTERNAL_SYNC_TIMEOUT_SEC = float(os.getenv("EXTERNAL_SYNC_TIMEOUT_SEC", "8"))
EXTERNAL_SYNC_MAX_ATTEMPTS = int(os.getenv("EXTERNAL_SYNC_MAX_ATTEMPTS", "6"))
EXTERNAL_SYNC_POLL_SEC = float(os.getenv("EXTERNAL_SYNC_POLL_SEC", "2"))
ATTENDANCE_RETENTION_DAYS = int(os.getenv("ATTENDANCE_RETENTION_DAYS", "3"))
AUTO_CHECKOUT_DAYS = int(os.getenv("AUTO_CHECKOUT_DAYS", str(ATTENDANCE_RETENTION_DAYS)))
MAINTENANCE_POLL_SEC = float(os.getenv("MAINTENANCE_POLL_SEC", "60"))
ONLINE_INVALIDATE_HOURS = float(os.getenv("ONLINE_INVALIDATE_HOURS", "6"))

USER_PASSWORD = os.getenv("USER_PASSWORD", "facecheck-user")
USER_SIGN_KEY = os.getenv("USER_SIGN_KEY", f"{USER_PASSWORD}:facecheck-user")
USER_COOKIE_NAME = "facecheck_user"
USER_TOKEN_TTL_SEC = int(os.getenv("USER_TOKEN_TTL_SEC", "86400"))

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "facecheck-admin")
ADMIN_SIGN_KEY = os.getenv("ADMIN_SIGN_KEY", f"{ADMIN_PASSWORD}:facecheck-admin")
ADMIN_COOKIE_NAME = "facecheck_admin"
ADMIN_TOKEN_TTL_SEC = int(os.getenv("ADMIN_TOKEN_TTL_SEC", "43200"))
ADMIN_COOKIE_SECURE_MODE = os.getenv("ADMIN_COOKIE_SECURE", "auto").strip().lower()
DISPLAY_TZ_OFFSET_HOURS = float(os.getenv("DISPLAY_TZ_OFFSET_HOURS", "8"))
DISPLAY_TZ_DELTA = datetime.timedelta(hours=DISPLAY_TZ_OFFSET_HOURS)
ACTION_SIGN_IN = "\u7b7e\u5230"
ACTION_SIGN_OUT = "\u7b7e\u9000"
_last_cleanup_display_date = None

if ATTENDANCE_RETENTION_DAYS <= 0:
    ATTENDANCE_RETENTION_DAYS = 3
if AUTO_CHECKOUT_DAYS <= 0:
    AUTO_CHECKOUT_DAYS = ATTENDANCE_RETENTION_DAYS
if ONLINE_INVALIDATE_HOURS <= 0:
    ONLINE_INVALIDATE_HOURS = 6.0

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def disable_ui_cache(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path in {"/", "/login", "/admin", "/admin/login"} or (
        path.startswith("/static/") and (path.endswith(".js") or path.endswith(".css") or path.endswith(".html"))
    ):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


def _is_user_protected_path(path: str) -> bool:
    if path == "/":
        return True
    if path.startswith("/pending-actions"):
        return True
    if path.startswith("/online-status"):
        return True
    if path.startswith("/attendance-records"):
        return True
    if path.startswith("/camera/"):
        return True
    if path.startswith("/live-preview.jpg"):
        return True
    return False


@app.middleware("http")
async def require_user_login(request: Request, call_next):
    path = request.url.path or "/"
    if not _is_user_protected_path(path):
        return await call_next(request)
    if is_user_request(request):
        return await call_next(request)

    accept = (request.headers.get("accept") or "").lower()
    wants_html = request.method.upper() == "GET" and ("text/html" in accept)
    if wants_html:
        return RedirectResponse(url="/login", status_code=302)
    return Response(
        content='{"detail":"login required"}',
        status_code=401,
        media_type="application/json",
    )


def get_db() -> Generator[DB, None, None]:
    db = DB()
    try:
        yield db
    finally:
        db.close()


async def external_sync_worker_loop():
    while True:
        try:
            await asyncio.to_thread(run_sync_cycle, 12)
        except Exception as e:
            print(f"[external_sync_worker] cycle error: {e}", flush=True)
        await asyncio.sleep(max(0.5, EXTERNAL_SYNC_POLL_SEC))


async def maintenance_worker_loop():
    while True:
        try:
            result = await asyncio.to_thread(run_maintenance_cycle)
            if (
                result.get("invalidated_online_count")
                or result.get("auto_checkout_count")
                or result.get("deleted_rows")
                or result.get("cleanup_ran")
            ):
                print(f"[maintenance] {result}", flush=True)
        except Exception as e:
            print(f"[maintenance] cycle error: {e}", flush=True)
        await asyncio.sleep(max(10.0, MAINTENANCE_POLL_SEC))


@app.on_event("startup")
async def on_startup():
    if EXTERNAL_SYNC_ENABLED:
        app.state.external_sync_task = asyncio.create_task(external_sync_worker_loop())
    else:
        app.state.external_sync_task = None
    app.state.maintenance_task = asyncio.create_task(maintenance_worker_loop())


@app.on_event("shutdown")
async def on_shutdown():
    for key in ("external_sync_task", "maintenance_task"):
        task = getattr(app.state, key, None)
        if not task:
            continue
        task.cancel()
        try:
            await task
        except Exception:
            pass


def format_duration(seconds: Optional[int]) -> str:
    if seconds is None:
        return "-"
    try:
        total = int(seconds)
    except Exception:
        return "-"
    if total < 0:
        total = 0
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def parse_datetime_value(value) -> Optional[datetime.datetime]:
    if isinstance(value, datetime.datetime):
        return value
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def format_display_time(value) -> str:
    dt = parse_datetime_value(value)
    if dt is None:
        return str(value)
    return str(dt + DISPLAY_TZ_DELTA)


def get_display_day_bounds_in_server_tz(now_server: datetime.datetime) -> tuple[datetime.datetime, datetime.datetime]:
    now_display = now_server + DISPLAY_TZ_DELTA
    day_start_display = datetime.datetime.combine(now_display.date(), datetime.time.min)
    day_end_display = day_start_display + datetime.timedelta(days=1)
    day_start_server = day_start_display - DISPLAY_TZ_DELTA
    day_end_server = day_end_display - DISPLAY_TZ_DELTA
    return day_start_server, day_end_server


def calc_today_duration_seconds_for_user(
    db: DB,
    name: str,
    now_server: datetime.datetime,
    day_start_server: datetime.datetime,
    day_end_server: datetime.datetime,
) -> int:
    total = 0
    open_start: Optional[datetime.datetime] = None

    before_row = db.cursor.execute(
        """
        SELECT action
        FROM attendance
        WHERE name=? AND event_time < ?
        ORDER BY event_time DESC, id DESC
        LIMIT 1
        """,
        (name, day_start_server),
    ).fetchone()
    if before_row and before_row[0] == ACTION_SIGN_IN:
        open_start = day_start_server

    day_rows = db.cursor.execute(
        """
        SELECT action, event_time
        FROM attendance
        WHERE name=? AND event_time >= ? AND event_time < ?
        ORDER BY event_time ASC, id ASC
        """,
        (name, day_start_server, day_end_server),
    ).fetchall()

    for action, event_time in day_rows:
        dt = db._to_datetime(event_time) if hasattr(db, "_to_datetime") else None
        if dt is None:
            continue
        if action == ACTION_SIGN_IN:
            if open_start is None:
                open_start = dt
            continue
        if action == ACTION_SIGN_OUT and open_start is not None:
            end_dt = dt if dt <= day_end_server else day_end_server
            if end_dt > open_start:
                total += int((end_dt - open_start).total_seconds())
            open_start = None

    if open_start is not None:
        end_dt = now_server if now_server <= day_end_server else day_end_server
        if end_dt > open_start:
            total += int((end_dt - open_start).total_seconds())

    return max(0, int(total))


def _user_sign(exp_ts: int) -> str:
    msg = str(exp_ts).encode("utf-8")
    key = USER_SIGN_KEY.encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def create_user_token() -> str:
    exp_ts = int(time.time()) + USER_TOKEN_TTL_SEC
    sig = _user_sign(exp_ts)
    return f"{exp_ts}.{sig}"


def verify_user_token(token: Optional[str]) -> bool:
    if not token:
        return False
    try:
        exp_str, sig = token.split(".", 1)
        exp_ts = int(exp_str)
    except Exception:
        return False
    if exp_ts <= int(time.time()):
        return False
    expected = _user_sign(exp_ts)
    return hmac.compare_digest(expected, sig)


def is_user_request(request: Request) -> bool:
    token = request.cookies.get(USER_COOKIE_NAME)
    return verify_user_token(token)


def require_user(request: Request):
    if not is_user_request(request):
        raise HTTPException(status_code=401, detail="login required")


def _admin_sign(exp_ts: int) -> str:
    msg = str(exp_ts).encode("utf-8")
    key = ADMIN_SIGN_KEY.encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def create_admin_token() -> str:
    exp_ts = int(time.time()) + ADMIN_TOKEN_TTL_SEC
    sig = _admin_sign(exp_ts)
    return f"{exp_ts}.{sig}"


def verify_admin_token(token: Optional[str]) -> bool:
    if not token:
        return False
    try:
        exp_str, sig = token.split(".", 1)
        exp_ts = int(exp_str)
    except Exception:
        return False
    if exp_ts <= int(time.time()):
        return False
    expected = _admin_sign(exp_ts)
    return hmac.compare_digest(expected, sig)


def is_admin_request(request: Request) -> bool:
    token = request.cookies.get(ADMIN_COOKIE_NAME)
    return verify_admin_token(token)


def require_admin(request: Request):
    if not is_admin_request(request):
        raise HTTPException(status_code=401, detail="admin auth required")


def should_secure_cookie(request: Request) -> bool:
    if ADMIN_COOKIE_SECURE_MODE in {"1", "true", "yes", "on"}:
        return True
    if ADMIN_COOKIE_SECURE_MODE in {"0", "false", "no", "off"}:
        return False
    return request.url.scheme == "https"


EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def normalize_email(email: str) -> str:
    value = (email or "").strip().lower()
    if not value:
        raise HTTPException(status_code=400, detail="email required")
    if len(value) > 254 or not EMAIL_RE.match(value):
        raise HTTPException(status_code=400, detail="email invalid")
    return value


def parse_bool_flag(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def map_action_to_external_status(action: str) -> str:
    text = str(action or "").strip()
    if text in {"签到", "绛惧埌", "check_in"}:
        return "check_in"
    if text in {"签退", "绛鹃€€", "check_out"}:
        return "check_out"
    raise ValueError(f"unsupported action: {action}")


def should_retry_http_status(http_status: Optional[int]) -> bool:
    if http_status is None:
        return True
    if http_status in {408, 429}:
        return True
    if http_status >= 500:
        return True
    return False


def call_external_sync(email: str, external_status: str):
    if not EXTERNAL_SYNC_ENABLED:
        return True, False, 200, '{"message":"sync disabled"}', None
    if not EXTERNAL_SYNC_URL:
        return False, False, None, None, "EXTERNAL_SYNC_URL empty"
    if not EXTERNAL_SYNC_SECRET:
        return False, False, None, None, "EXTERNAL_SYNC_SECRET empty"

    payload = {
        "email": email,
        "status": external_status,
        "token": EXTERNAL_SYNC_SECRET,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if EXTERNAL_SYNC_BEARER_TOKEN:
        headers["Authorization"] = f"Bearer {EXTERNAL_SYNC_BEARER_TOKEN}"

    req = UrlRequest(
        EXTERNAL_SYNC_URL,
        data=data,
        method="POST",
        headers=headers,
    )
    try:
        with urlopen(req, timeout=EXTERNAL_SYNC_TIMEOUT_SEC) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            return True, False, int(resp.status), body[:2000], None
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        status = int(getattr(e, "code", 0) or 0)
        return False, should_retry_http_status(status), status, body[:2000], f"http {status}"
    except URLError as e:
        return False, True, None, None, f"urlerror: {e}"
    except Exception as e:
        return False, True, None, None, f"exception: {e}"


def process_single_sync_job(db: DB, row) -> dict:
    job_id, _attendance_id, _pending_id, _name, email, action, attempt_count = row
    try:
        external_status = map_action_to_external_status(action)
    except Exception as e:
        db.mark_sync_job_failed(job_id, error_text=str(e))
        return {"job_id": job_id, "status": "failed", "reason": str(e)}

    ok, retryable, http_status, response_text, error_text = call_external_sync(email=email, external_status=external_status)
    next_attempt = int(attempt_count) + 1
    if ok:
        db.mark_sync_job_success(job_id, http_status=http_status, response_text=response_text)
        return {"job_id": job_id, "status": "success", "http_status": http_status}

    if (not retryable) or (next_attempt >= EXTERNAL_SYNC_MAX_ATTEMPTS):
        db.mark_sync_job_failed(job_id, http_status=http_status, response_text=response_text, error_text=error_text)
        return {"job_id": job_id, "status": "failed", "http_status": http_status, "error": error_text}

    # exponential backoff: 2s, 4s, ... max 5min
    delay = min(300, 2 ** max(1, next_attempt))
    db.mark_sync_job_retry(
        job_id,
        delay_seconds=delay,
        http_status=http_status,
        response_text=response_text,
        error_text=error_text,
    )
    return {"job_id": job_id, "status": "retry", "delay": delay, "http_status": http_status, "error": error_text}


def run_sync_cycle(limit: int = 10):
    db = DB()
    try:
        rows = db.list_retryable_sync_jobs(limit=limit)
        results = []
        for row in rows:
            results.append(process_single_sync_job(db, row))
        return results
    finally:
        db.close()


def _daily_cleanup_cutoff_storage(now_storage: Optional[datetime.datetime] = None) -> datetime.datetime:
    storage_now = now_storage or datetime.datetime.now()
    display_now = storage_now + DISPLAY_TZ_DELTA
    display_midnight = datetime.datetime.combine(display_now.date(), datetime.time.min)
    display_cutoff = display_midnight - datetime.timedelta(days=ATTENDANCE_RETENTION_DAYS)
    return display_cutoff - DISPLAY_TZ_DELTA


def _auto_checkout_overdue_users(db: DB, now_storage: datetime.datetime) -> list[dict]:
    overdue_before = now_storage - datetime.timedelta(days=AUTO_CHECKOUT_DAYS)
    overdue_rows = db.list_overdue_signed_in_users(overdue_before=overdue_before, limit=200)
    results = []
    for name, sign_in_time in overdue_rows:
        ok, reason = db.validate_attendance_transition(name, ACTION_SIGN_OUT)
        if not ok:
            results.append({"name": name, "status": "skip", "reason": reason})
            continue

        att = db.insert_attendance(name, ACTION_SIGN_OUT, event_time=now_storage)
        attendance_id = att.get("id") if isinstance(att, dict) else None
        item = {
            "name": name,
            "sign_in_time": str(sign_in_time),
            "attendance_id": attendance_id,
            "status": "signed_out",
            "sync": "disabled",
        }

        if not EXTERNAL_SYNC_ENABLED or not attendance_id:
            results.append(item)
            continue

        raw_email = db.get_face_email_by_name(name)
        if not raw_email:
            item["sync"] = "skip_email_missing"
            results.append(item)
            continue
        try:
            email = normalize_email(raw_email)
        except HTTPException:
            item["sync"] = "skip_email_invalid"
            results.append(item)
            continue

        job_id = db.create_external_sync_job(
            attendance_id=attendance_id,
            pending_id=None,
            name=name,
            email=email,
            action=ACTION_SIGN_OUT,
        )
        job_row = db.get_sync_job_by_id(job_id)
        if not job_row:
            item["sync"] = "queued"
            item["sync_job_id"] = job_id
            results.append(item)
            continue
        sync_result = process_single_sync_job(db, job_row)
        item["sync"] = sync_result.get("status", "unknown")
        item["sync_job_id"] = job_id
        item["sync_http_status"] = sync_result.get("http_status")
        item["sync_error"] = sync_result.get("error") or sync_result.get("reason")
        results.append(item)
    return results


def _format_hours_text(hours: float) -> str:
    if float(hours).is_integer():
        return str(int(hours))
    return f"{hours:g}"


def _invalidate_overtime_online_users(db: DB, now_storage: datetime.datetime) -> list[dict]:
    overdue_before = now_storage - datetime.timedelta(hours=ONLINE_INVALIDATE_HOURS)
    overdue_rows = db.list_overdue_signed_in_entries(overdue_before=overdue_before, limit=500)
    results = []
    seen_names = set()
    timeout_reason = f"online_timeout_{_format_hours_text(ONLINE_INVALIDATE_HOURS)}h"

    for _attendance_id, name, _sign_in_time in overdue_rows:
        if name in seen_names:
            continue
        seen_names.add(name)

        deleted_attendance = 0
        superseded_pending = 0
        first_overdue_time = None

        # Some historical data may contain consecutive sign-in rows.
        # Keep invalidating until this user is no longer overdue-online.
        for _ in range(50):
            overdue_row = db.get_overdue_signed_in_entry_for_name(name, overdue_before)
            if not overdue_row:
                break
            attendance_id, overdue_dt = overdue_row
            if first_overdue_time is None and overdue_dt is not None:
                first_overdue_time = overdue_dt
            changed = db.invalidate_overdue_signin_by_id(
                attendance_id=attendance_id,
                name=name,
                reason=timeout_reason,
            )
            deleted = int((changed or {}).get("deleted_attendance", 0))
            deleted_attendance += deleted
            superseded_pending += int((changed or {}).get("superseded_pending", 0))
            if deleted <= 0:
                break

        if deleted_attendance <= 0 and superseded_pending <= 0:
            continue

        results.append(
            {
                "name": name,
                "sign_in_time": str(first_overdue_time) if first_overdue_time is not None else "",
                "deleted_attendance": deleted_attendance,
                "superseded_pending": superseded_pending,
            }
        )
    return results


def run_maintenance_cycle() -> dict:
    global _last_cleanup_display_date
    now_storage = datetime.datetime.now()
    display_today = (now_storage + DISPLAY_TZ_DELTA).date()
    db = DB()
    try:
        invalidated_results = _invalidate_overtime_online_users(db=db, now_storage=now_storage)
        auto_checkout_results = _auto_checkout_overdue_users(db=db, now_storage=now_storage)
        cleanup_ran = _last_cleanup_display_date != display_today
        deleted_rows = 0
        if cleanup_ran:
            cutoff = _daily_cleanup_cutoff_storage(now_storage=now_storage)
            deleted_rows = db.delete_attendance_before(cutoff_time=cutoff)
            _last_cleanup_display_date = display_today
        return {
            "invalidated_online_count": len(invalidated_results),
            "auto_checkout_count": len(auto_checkout_results),
            "deleted_rows": int(deleted_rows),
            "cleanup_ran": cleanup_ran,
        }
    finally:
        db.close()


class RejectBody(BaseModel):
    reason: str = "manual_reject"


class UserLoginBody(BaseModel):
    password: str


class AdminLoginBody(BaseModel):
    password: str


class AdminRenameBody(BaseModel):
    name: str
    legacy_names: list[str] = Field(default_factory=list)


class AdminRegisterBody(BaseModel):
    name: str
    email: str
    image_b64: str


class AdminEmailBody(BaseModel):
    email: str


@app.get("/")
def index(request: Request):
    if not is_user_request(request):
        return RedirectResponse(url="/login", status_code=302)
    index_file = STATIC_DIR / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=404, detail="UI not found")
    return FileResponse(index_file)


@app.get("/login")
def user_login_page(request: Request):
    if is_user_request(request):
        return RedirectResponse(url="/", status_code=302)
    page = STATIC_DIR / "login.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="login page not found")
    return FileResponse(page)


@app.post("/login")
def user_login(body: UserLoginBody, response: Response, request: Request):
    if (body.password or "").strip() != USER_PASSWORD:
        raise HTTPException(status_code=401, detail="password invalid")
    token = create_user_token()
    response.set_cookie(
        key=USER_COOKIE_NAME,
        value=token,
        max_age=USER_TOKEN_TTL_SEC,
        httponly=True,
        secure=should_secure_cookie(request),
        samesite="lax",
        path="/",
    )
    return {"ok": True}


@app.post("/logout")
def user_logout(response: Response):
    response.delete_cookie(USER_COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/me")
def user_me(request: Request):
    return {"ok": is_user_request(request)}


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "display_tz_offset_hours": DISPLAY_TZ_OFFSET_HOURS,
        "attendance_retention_days": ATTENDANCE_RETENTION_DAYS,
        "auto_checkout_days": AUTO_CHECKOUT_DAYS,
        "online_invalidate_hours": ONLINE_INVALIDATE_HOURS,
    }


@app.get("/live-preview.jpg")
def live_preview() -> FileResponse:
    if not LIVE_PREVIEW_PATH.exists():
        raise HTTPException(status_code=404, detail="preview not ready")
    return FileResponse(
        path=str(LIVE_PREVIEW_PATH),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.websocket("/ws/camera")
async def ws_camera_proxy(client_ws: WebSocket):
    if not verify_user_token(client_ws.cookies.get(USER_COOKIE_NAME)):
        await client_ws.close(code=1008, reason="login required")
        return
    await client_ws.accept()
    try:
        async with websockets.connect(WEBCAM_WS_BACKEND, max_size=8 * 1024 * 1024) as backend_ws:
            stop_event = asyncio.Event()

            async def client_to_backend():
                while not stop_event.is_set():
                    try:
                        msg = await client_ws.receive()
                    except WebSocketDisconnect:
                        stop_event.set()
                        break
                    if msg.get("type") == "websocket.disconnect":
                        stop_event.set()
                        break
                    if msg.get("bytes") is not None:
                        await backend_ws.send(msg["bytes"])
                    elif msg.get("text") is not None:
                        await backend_ws.send(msg["text"])

            async def backend_to_client():
                while not stop_event.is_set():
                    try:
                        data = await backend_ws.recv()
                    except Exception:
                        stop_event.set()
                        break
                    if isinstance(data, bytes):
                        await client_ws.send_bytes(data)
                    else:
                        await client_ws.send_text(data)

            await asyncio.gather(client_to_backend(), backend_to_client())
    except Exception:
        try:
            await client_ws.send_text('{"type":"error","message":"ws proxy unavailable"}')
        except Exception:
            pass
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass


@app.get("/admin/login")
def admin_login_page(request: Request):
    if is_admin_request(request):
        return RedirectResponse(url="/admin", status_code=302)
    page = STATIC_DIR / "admin_login.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="admin login page not found")
    return FileResponse(page)


@app.post("/admin/login")
def admin_login(body: AdminLoginBody, response: Response, request: Request):
    if (body.password or "").strip() != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="password invalid")
    token = create_admin_token()
    response.set_cookie(
        key=ADMIN_COOKIE_NAME,
        value=token,
        max_age=ADMIN_TOKEN_TTL_SEC,
        httponly=True,
        secure=should_secure_cookie(request),
        samesite="lax",
        path="/",
    )
    return {"ok": True}


@app.post("/admin/logout")
def admin_logout(response: Response):
    response.delete_cookie(ADMIN_COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/admin/me")
def admin_me(request: Request):
    return {"ok": is_admin_request(request)}


@app.get("/admin")
def admin_page(request: Request):
    if not is_admin_request(request):
        return RedirectResponse(url="/admin/login", status_code=302)
    page = STATIC_DIR / "admin.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="admin page not found")
    return FileResponse(page)


@app.get("/admin/faces")
def admin_faces(request: Request, db: DB = Depends(get_db)):
    require_admin(request)
    rows = db.list_all()
    items = []
    for rid, name, email, ctime in rows:
        items.append(
            {
                "id": rid,
                "name": name,
                "email": email or "",
                "created_time": format_display_time(ctime),
            }
        )
    return {"items": items}


@app.get("/admin/faces/{face_id}/image")
def admin_face_image(face_id: int, request: Request, db: DB = Depends(get_db)):
    require_admin(request)
    row = db.cursor.execute("SELECT image FROM faces WHERE id=?", (face_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="face not found")
    image_bytes = row[0]
    media_type = "application/octet-stream"
    if image_bytes.startswith(b"\xff\xd8\xff"):
        media_type = "image/jpeg"
    elif image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        media_type = "image/png"
    elif image_bytes.startswith(b"GIF87a") or image_bytes.startswith(b"GIF89a"):
        media_type = "image/gif"
    return Response(
        content=image_bytes,
        media_type=media_type,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.post("/admin/faces/{face_id}/rename")
def admin_face_rename(face_id: int, body: AdminRenameBody, request: Request, db: DB = Depends(get_db)):
    require_admin(request)
    new_name = (body.name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="name required")
    exists = db.cursor.execute("SELECT 1 FROM faces WHERE id=?", (face_id,)).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail="face not found")
    try:
        result = db.update_name(face_id, new_name, legacy_names=body.legacy_names)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **result}


@app.post("/admin/faces/{face_id}/email")
def admin_face_email(face_id: int, body: AdminEmailBody, request: Request, db: DB = Depends(get_db)):
    require_admin(request)
    new_email = normalize_email(body.email)
    exists = db.cursor.execute("SELECT 1 FROM faces WHERE id=?", (face_id,)).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail="face not found")
    db.update_email(face_id, new_email)
    return {"ok": True, "email": new_email}


@app.delete("/admin/faces/{face_id}")
def admin_face_delete(face_id: int, request: Request, db: DB = Depends(get_db)):
    require_admin(request)
    exists = db.cursor.execute("SELECT 1 FROM faces WHERE id=?", (face_id,)).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail="face not found")
    db.delete_by_id(face_id)
    return {"ok": True}


@app.post("/admin/faces/register")
def admin_face_register(body: AdminRegisterBody, request: Request):
    require_admin(request)

    name = (body.name or "").strip()
    email = normalize_email(body.email)
    image_b64 = (body.image_b64 or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    if not image_b64:
        raise HTTPException(status_code=400, detail="image required")

    payload = json.dumps({"name": name, "email": email, "image_b64": image_b64}, ensure_ascii=False).encode("utf-8")
    req = UrlRequest(
        WEBCAM_INTERNAL_REGISTER_URL,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise HTTPException(status_code=400, detail=f"register failed: {detail}")
    except URLError as e:
        raise HTTPException(status_code=502, detail=f"register backend unavailable: {e}")

    if not data.get("ok"):
        raise HTTPException(status_code=400, detail=str(data))
    return data


@app.post("/camera/infer")
async def camera_infer(request: Request):
    frame_bytes = await request.body()
    if not frame_bytes:
        raise HTTPException(status_code=400, detail="empty frame")

    source = (request.headers.get("X-Cam-Source") or "cam1").strip() or "cam1"
    preview_only = parse_bool_flag(request.headers.get("X-Preview-Only"), default=False)
    infer_url = f"{WEBCAM_INTERNAL_INFER_URL}?source={quote_plus(source)}"
    req = UrlRequest(
        infer_url,
        data=frame_bytes,
        method="POST",
        headers={
            "Content-Type": "image/jpeg",
            "X-Cam-Source": source,
            "X-Preview-Only": "1" if preview_only else "0",
        },
    )
    try:
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise HTTPException(status_code=400, detail=f"infer failed: {detail}")
    except URLError as e:
        raise HTTPException(status_code=502, detail=f"infer backend unavailable: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"infer proxy error: {e}")

    return data


@app.get("/external-sync/jobs")
def external_sync_jobs(request: Request, limit: int = 100, db: DB = Depends(get_db)) -> dict:
    require_admin(request)
    rows = db.list_sync_jobs(limit=limit)
    items = []
    for (
        rid,
        attendance_id,
        pending_id,
        name,
        email,
        action,
        status,
        attempt_count,
        next_retry_time,
        last_http_status,
        last_response,
        last_error,
        created_time,
        updated_time,
    ) in rows:
        items.append(
            {
                "id": rid,
                "attendance_id": attendance_id,
                "pending_id": pending_id,
                "name": name,
                "email": email,
                "action": action,
                "status": status,
                "attempt_count": attempt_count,
                "next_retry_time": format_display_time(next_retry_time),
                "last_http_status": last_http_status,
                "last_response": last_response,
                "last_error": last_error,
                "created_time": format_display_time(created_time),
                "updated_time": format_display_time(updated_time),
            }
        )
    return {"items": items}


@app.get("/pending-actions")
def pending_actions(limit: int = 50, source: Optional[str] = None, db: DB = Depends(get_db)) -> dict:
    _invalidate_overtime_online_users(db=db, now_storage=datetime.datetime.now())
    rows = db.list_pending_actions(source=source, limit=limit)
    items = []
    for rid, src, name, action, detected_time, status in rows:
        items.append(
            {
                "id": rid,
                "source": src,
                "name": name,
                "action": action,
                "detected_time": format_display_time(detected_time),
                "status": status,
            }
        )
    return {"items": items}


@app.post("/pending-actions/{pending_id}/confirm")
def confirm_pending(pending_id: int, db: DB = Depends(get_db)) -> dict:
    pending = db.get_pending_action_by_id(pending_id)
    if not pending:
        raise HTTPException(status_code=400, detail="pending action not found")
    _, _, pending_name, pending_action, _, pending_status = pending
    if pending_status != "pending":
        raise HTTPException(status_code=400, detail=f"pending action already {pending_status}, cannot confirm")

    now_storage = datetime.datetime.now()
    if pending_action == ACTION_SIGN_OUT:
        overdue_before = now_storage - datetime.timedelta(hours=ONLINE_INVALIDATE_HOURS)
        overdue_row = db.get_overdue_signed_in_entry_for_name(pending_name, overdue_before)
        if overdue_row:
            overdue_id, _ = overdue_row
            db.invalidate_overdue_signin_by_id(
                attendance_id=overdue_id,
                name=pending_name,
                reason=f"online_timeout_{_format_hours_text(ONLINE_INVALIDATE_HOURS)}h",
            )
            hour_text = _format_hours_text(ONLINE_INVALIDATE_HOURS)
            raise HTTPException(
                status_code=400,
                detail=f"{pending_name} 在线已超过{hour_text}小时，记录作废，请先签到",
            )

    ok, msg, att = db.confirm_pending_action(pending_id)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)

    duration_seconds = None
    if isinstance(att, dict):
        duration_seconds = att.get("duration_seconds")
    attendance_id = att.get("id") if isinstance(att, dict) else None

    sync_result = {"status": "disabled", "detail": "external sync disabled"}
    if EXTERNAL_SYNC_ENABLED and attendance_id:
        raw_email = db.get_face_email_by_name(pending_name)
        if not raw_email:
            raise HTTPException(status_code=400, detail=f"user {pending_name} email missing, please fill in admin page")
        try:
            email = normalize_email(raw_email)
        except HTTPException:
            raise HTTPException(status_code=400, detail=f"user {pending_name} email invalid, please update in admin page")

        job_id = db.create_external_sync_job(
            attendance_id=attendance_id,
            pending_id=pending_id,
            name=pending_name,
            email=email,
            action=pending_action,
        )
        job_row = db.get_sync_job_by_id(job_id)
        if job_row:
            sync_result = process_single_sync_job(db, job_row)
            sync_result["job_id"] = job_id
        else:
            sync_result = {"status": "retry", "detail": "sync job queued", "job_id": job_id}

    return {
        "ok": True,
        "message": msg,
        "attendance": {
            "id": attendance_id,
            "duration_seconds": duration_seconds,
            "duration": format_duration(duration_seconds),
        },
        "external_sync": sync_result,
    }


@app.post("/pending-actions/{pending_id}/reject")
def reject_pending(pending_id: int, body: RejectBody, db: DB = Depends(get_db)) -> dict:
    ok, msg = db.reject_pending_action(pending_id, reason=body.reason)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@app.get("/attendance-records")
def attendance_records(limit: int = 500, db: DB = Depends(get_db)) -> dict:
    rows = db.list_attendance_recent(days=ATTENDANCE_RETENTION_DAYS, limit=limit)
    items = []
    for rid, name, action, event_time, duration_seconds in rows:
        items.append(
            {
                "id": rid,
                "name": name,
                "action": action,
                "event_time": format_display_time(event_time),
                "duration_seconds": duration_seconds,
                "duration": format_duration(duration_seconds) if action == "签退" else "-",
            }
        )
    return {"items": items}


@app.get("/online-status")
def online_status(limit: int = 200, db: DB = Depends(get_db)) -> dict:
    _invalidate_overtime_online_users(db=db, now_storage=datetime.datetime.now())
    try:
        limit = int(limit)
    except Exception:
        limit = 200
    if limit <= 0:
        limit = 200

    rows = db.cursor.execute(
        """
        SELECT a.name, a.event_time
        FROM attendance a
        JOIN (
            SELECT name, MAX(id) AS max_id
            FROM attendance
            GROUP BY name
        ) last ON last.max_id = a.id
        WHERE a.action='签到'
        ORDER BY a.event_time DESC, a.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()

    now = datetime.datetime.now()
    day_start_server, day_end_server = get_display_day_bounds_in_server_tz(now)
    items = []
    for name, sign_in_time in rows:
        dt = db._to_datetime(sign_in_time) if hasattr(db, "_to_datetime") else None
        duration_seconds = None
        if dt is not None:
            duration_seconds = int(max(0, (now - dt).total_seconds()))
        today_duration_seconds = calc_today_duration_seconds_for_user(
            db=db,
            name=name,
            now_server=now,
            day_start_server=day_start_server,
            day_end_server=day_end_server,
        )
        items.append(
            {
                "name": name,
                "sign_in_time": format_display_time(sign_in_time),
                "online_duration_seconds": duration_seconds,
                "online_duration": format_duration(duration_seconds),
                "today_duration_seconds": today_duration_seconds,
                "today_duration": format_duration(today_duration_seconds),
            }
        )
    return {"items": items}



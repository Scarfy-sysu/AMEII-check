import asyncio
import base64
import datetime
import json
import os
import time
import traceback

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from DB import DB
from FaceRecognition import FaceRecognition
from backend_embedder import FaceEmbedder
from gesture_utils import GestureDetector


SIGN_IN = "\u7b7e\u5230"
SIGN_OUT = "\u7b7e\u9000"


def env_float(name, default):
    try:
        return float(os.getenv(name, default))
    except Exception:
        return float(default)


def env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except Exception:
        return int(default)


def parse_bool(value, default=False):
    if value is None:
        return bool(default)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def resize_keep_aspect(frame, max_w, max_h):
    h, w = frame.shape[:2]
    if h <= 0 or w <= 0:
        return frame
    if max_w <= 0 or max_h <= 0:
        return frame

    scale = min(max_w / float(w), max_h / float(h))
    if scale >= 1.0:
        return frame
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    return cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)


def predict_action_from_attendance(db: DB, name: str) -> str:
    """
    First time a known face appears:
    - currently signed in  => suggest sign out
    - otherwise            => suggest sign in
    """
    last = db.get_last_attendance(name)
    if last and str(last[0]).strip() == SIGN_IN:
        return SIGN_OUT
    return SIGN_IN


class RegisterFaceBody(BaseModel):
    name: str
    email: str
    image_b64: str


def build_app() -> FastAPI:
    app = FastAPI(title="Facecheck Web Camera Inference", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )

    analysis_w = env_int("WEB_ANALYSIS_WIDTH", 640)
    analysis_h = env_int("WEB_ANALYSIS_HEIGHT", 360)
    gesture_score_thresh = env_float("WEB_GESTURE_SCORE_THRESH", 0.48)
    feature_reload_interval = env_float("FEATURE_RELOAD_INTERVAL_SEC", 2.0)
    action_confirm_frames = env_int("ACTION_CONFIRM_FRAMES", 3)
    display_tz_offset_hours = env_float("DISPLAY_TZ_OFFSET_HOURS", 8.0)
    source = os.getenv("CAM_SOURCE", "cam1")

    db = DB()
    face_recog = FaceRecognition(feature_reload_interval_sec=feature_reload_interval)
    face_embedder = FaceEmbedder()
    gest_det = GestureDetector(
        num_hands=2,
        det_conf=0.6,
        presence_conf=0.6,
        track_conf=0.6,
        score_thresh=gesture_score_thresh,
    )

    infer_lock = asyncio.Lock()
    http_pending_state = {"key": None, "hits": 0, "last_send_ts": time.time(), "seen_names": set()}

    @app.get("/health")
    async def health():
        return {
            "ok": True,
            "mode": "webcam_ws",
            "analysis": {"w": analysis_w, "h": analysis_h},
            "source": source,
            "display_tz_offset_hours": display_tz_offset_hours,
        }

    @app.post("/internal/register-face")
    async def internal_register_face(body: RegisterFaceBody):
        name = (body.name or "").strip()
        email = (body.email or "").strip().lower()
        if not name:
            raise HTTPException(status_code=400, detail="name required")
        if not email:
            raise HTTPException(status_code=400, detail="email required")

        b64 = (body.image_b64 or "").strip()
        if not b64:
            raise HTTPException(status_code=400, detail="image required")
        if "," in b64:
            b64 = b64.split(",", 1)[1]

        try:
            frame_bytes = base64.b64decode(b64)
        except Exception:
            raise HTTPException(status_code=400, detail="image decode failed")

        arr = np.frombuffer(frame_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="image invalid")

        async with infer_lock:
            bbox, face = face_embedder.detect_largest_face(frame)
            if face is None or face.size == 0:
                raise HTTPException(status_code=400, detail="no face detected")
            feat = face_embedder.embed_face(face)
            db.insert(name, feat, frame, ".jpg", email=email)
            face_recog.reload_features(force=True)
            row = db.cursor.execute("SELECT COUNT(*) FROM faces WHERE name=?", (name,)).fetchone()
            sample_count = int(row[0]) if row and row[0] is not None else 1

        return {"ok": True, "name": name, "email": email, "bbox": bbox, "sample_count": sample_count}

    async def infer_from_frame(frame: np.ndarray, pending_state: dict, source_name: str, preview_only: bool = False):
        t0 = time.perf_counter()
        frame = resize_keep_aspect(frame, analysis_w, analysis_h)
        frame_h, frame_w = frame.shape[:2]

        async with infer_lock:
            face_recog.detect_and_recognize(frame, draw=False)
            names = face_recog.get_last_names() if hasattr(face_recog, "get_last_names") else []
            face_dets = face_recog.get_last_detections() if hasattr(face_recog, "get_last_detections") else []
            primary_name = None
            if hasattr(face_recog, "get_primary_name"):
                primary_name = face_recog.get_primary_name()
            if not primary_name and names:
                primary_name = names[0]

            g_boxes, labels, g_scores, _ = gest_det.infer(frame)
            first_action = None
            for lab in labels:
                if lab in ("Thumb_Up", "Thumb_Down"):
                    first_action = SIGN_IN if lab == "Thumb_Up" else SIGN_OUT
                    break

            seen_names = pending_state.get("seen_names")
            if not isinstance(seen_names, set):
                seen_names = set()
                pending_state["seen_names"] = seen_names
            visible_names = {
                str(d.get("name")).strip()
                for d in face_dets
                if bool(d.get("known")) and str(d.get("name") or "").strip()
            }
            if not visible_names and names:
                visible_names = set(names)
            seen_names.intersection_update(visible_names)

            predicted_action = None
            predicted_once = False
            if primary_name:
                who = primary_name
                if who not in seen_names:
                    predicted_action = predict_action_from_attendance(db, who)
                    predicted_once = True
                    seen_names.add(who)

            action_candidate = first_action or predicted_action

            pending_id = None
            if preview_only:
                pending_state["key"] = None
                pending_state["hits"] = 0
            elif primary_name and action_candidate:
                who = primary_name
                action_key = (who, action_candidate)
                if action_key == pending_state.get("key"):
                    pending_state["hits"] = int(pending_state.get("hits", 0)) + 1
                else:
                    pending_state["key"] = action_key
                    pending_state["hits"] = 1

                required_hits = 1 if (predicted_once and not first_action) else action_confirm_frames
                if pending_state["hits"] >= required_hits:
                    pending_id = db.upsert_pending_action(source=source_name, name=who, action=action_candidate)
                    pending_state["key"] = None
                    pending_state["hits"] = 0
            else:
                pending_state["key"] = None
                pending_state["hits"] = 0

        who_txt = primary_name if primary_name else "None"
        proc_ms = (time.perf_counter() - t0) * 1000.0

        hands = []
        for i, box in enumerate(g_boxes):
            lab = labels[i] if i < len(labels) else None
            scr = float(g_scores[i]) if i < len(g_scores) else 0.0
            hands.append(
                {
                    "bbox": [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                    "label": lab,
                    "score": scr,
                }
            )

        faces = []
        for det in face_dets:
            box = det.get("bbox")
            if not box:
                continue
            faces.append(
                {
                    "bbox": [int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                    "name": det.get("name"),
                    "distance": float(det.get("distance", 0.0)),
                    "second_distance": (
                        float(det.get("second_distance"))
                        if det.get("second_distance") is not None
                        else None
                    ),
                    "margin": float(det.get("margin")) if det.get("margin") is not None else None,
                    "known": bool(det.get("known", False)),
                }
            )

        payload = {
            "type": "result",
            "name": who_txt,
            "action": action_candidate,
            "pending_id": pending_id,
            "preview_only": bool(preview_only),
            "ts": (
                datetime.datetime.utcnow() + datetime.timedelta(hours=display_tz_offset_hours)
            ).strftime("%Y-%m-%d %H:%M:%S"),
            "frame_w": int(frame_w),
            "frame_h": int(frame_h),
            "faces": faces,
            "hands": hands,
            "proc_ms": round(proc_ms, 1),
        }
        payload_text = json.dumps(payload, ensure_ascii=False)
        payload_bytes = len(payload_text.encode("utf-8"))

        now = time.time()
        last_send_ts = float(pending_state.get("last_send_ts", now))
        dt = max(1e-3, now - last_send_ts)
        speed_bps = (payload_bytes * 8.0) / dt
        pending_state["last_send_ts"] = now
        payload["result_bytes"] = payload_bytes
        payload["result_bps"] = round(speed_bps, 1)
        return payload

    @app.post("/internal/infer-frame")
    async def internal_infer_frame(request: Request):
        frame_bytes = await request.body()
        if not frame_bytes:
            raise HTTPException(status_code=400, detail="empty frame")

        arr = np.frombuffer(frame_bytes, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="invalid image")

        source_name = (request.headers.get("X-Cam-Source") or source).strip() or source
        preview_only = parse_bool(request.headers.get("X-Preview-Only"), default=False)
        try:
            return await infer_from_frame(
                frame,
                http_pending_state,
                source_name=source_name,
                preview_only=preview_only,
            )
        except Exception as e:
            print(f"[webcam_http] infer error: {e}", flush=True)
            traceback.print_exc()
            raise HTTPException(status_code=500, detail="infer failed")

    @app.websocket("/ws/camera")
    async def ws_camera(websocket: WebSocket):
        await websocket.accept()
        ws_pending_state = {"key": None, "hits": 0, "last_send_ts": time.time(), "seen_names": set(), "preview_only": False}

        try:
            while True:
                msg = await websocket.receive()
                frame_bytes = None
                if msg.get("bytes") is not None:
                    frame_bytes = msg["bytes"]
                elif msg.get("text") is not None:
                    text = msg["text"]
                    if text == "ping":
                        await websocket.send_text('{"type":"pong"}')
                        continue
                    try:
                        obj = json.loads(text)
                        if isinstance(obj, dict) and "preview_only" in obj:
                            ws_pending_state["preview_only"] = parse_bool(obj.get("preview_only"), default=False)
                        b64 = obj.get("image_b64")
                        if b64:
                            frame_bytes = base64.b64decode(b64)
                    except Exception:
                        frame_bytes = None

                if not frame_bytes:
                    continue

                arr = np.frombuffer(frame_bytes, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if frame is None:
                    continue

                payload = await infer_from_frame(
                    frame,
                    ws_pending_state,
                    source_name=source,
                    preview_only=parse_bool(ws_pending_state.get("preview_only"), default=False),
                )
                await websocket.send_text(json.dumps(payload, ensure_ascii=False))

        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[webcam_ws] loop error: {e}", flush=True)
            traceback.print_exc()
            try:
                await websocket.close()
            except Exception:
                pass

    return app


app = build_app()

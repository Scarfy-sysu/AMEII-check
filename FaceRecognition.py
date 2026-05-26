import os
import time

import cv2
import numpy as np
import torch
import mediapipe as mp
from PIL import ImageFont, Image, ImageDraw
from facenet_pytorch import InceptionResnetV1

from DB import DB


class FaceRecognition:
    def __init__(self, feature_reload_interval_sec=2.0):
        self.device = torch.device('cuda:0' if torch.cuda.is_available() else 'cpu')

        self.mp_face_detection = mp.solutions.face_detection.FaceDetection(
            model_selection=0,
            min_detection_confidence=0.6,
        )

        self.faceNet_model = InceptionResnetV1(pretrained='vggface2').eval().to(self.device)

        self.db = DB()
        self.feature_reload_interval_sec = max(0.0, float(feature_reload_interval_sec))
        self._last_feature_reload_at = 0.0
        self.db_face_feature = {}
        self.reload_features(force=True)
        try:
            self.face_distance_threshold = float(os.getenv("FACE_DISTANCE_THRESHOLD", "0.75"))
        except Exception:
            self.face_distance_threshold = 0.75
        self.face_distance_threshold = max(0.35, min(1.2, self.face_distance_threshold))
        try:
            self.face_margin_threshold = float(os.getenv("FACE_MARGIN_THRESHOLD", "0.06"))
        except Exception:
            self.face_margin_threshold = 0.06
        self.face_margin_threshold = max(0.0, min(0.6, self.face_margin_threshold))
        self.unknown_label = os.getenv("FACE_UNKNOWN_LABEL", "Unknown")

        try:
            self.font = ImageFont.truetype("simhei.ttf", 24)
        except Exception:
            self.font = ImageFont.load_default()

        self.last_names = []
        self.last_detections = []

    def _load_db_features_to_device(self):
        raw = self.db.select_features()  # {name: [tensor([1,512]), ...]} or {name: tensor([1,512])}
        dev = {}
        for name, feats in raw.items():
            if not isinstance(feats, (list, tuple)):
                feats = [feats]
            buf = []
            for feat in feats:
                if isinstance(feat, torch.Tensor):
                    t = feat.detach().float().view(-1)
                else:
                    t = torch.tensor(feat, dtype=torch.float32).view(-1)
                if t.numel() > 0:
                    buf.append(t)
            if not buf:
                continue
            bank = torch.stack(buf, dim=0)  # [K, D]
            dev[name] = bank.to(self.device, non_blocking=True)
        return dev

    def reload_features(self, force=False):
        now = time.time()
        need_reload = force or self.feature_reload_interval_sec == 0.0
        if not need_reload:
            need_reload = (now - self._last_feature_reload_at) >= self.feature_reload_interval_sec

        if need_reload:
            self.db_face_feature = self._load_db_features_to_device()
            self._last_feature_reload_at = now
            return True
        return False

    def pretreatment_face(self, face):
        face = cv2.cvtColor(face, cv2.COLOR_BGR2RGB)
        face = cv2.resize(face, (160, 160))
        face = (face / 255.0 - 0.5) / 0.5
        face = torch.tensor(face, dtype=torch.float32).permute(2, 0, 1).unsqueeze(0)
        return face.to(self.device, non_blocking=True)

    def put_chinese_text(self, img, text, position):
        img_pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(img_pil)
        draw.text(position, text, font=self.font, fill=(255, 0, 0))
        return cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)

    def detect_and_recognize(self, img, draw=True):
        # Timed refresh instead of per-frame DB reload.
        self.reload_features(force=False)
        self.last_names = []
        self.last_detections = []
        cnt = 0

        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        results = self.mp_face_detection.process(img_rgb)
        if not results.detections:
            return cnt, img

        h, w, _ = img.shape
        for det in results.detections:
            bbox = det.location_data.relative_bounding_box
            x1 = int(bbox.xmin * w)
            y1 = int(bbox.ymin * h)
            x2 = int((bbox.xmin + bbox.width) * w)
            y2 = int((bbox.ymin + bbox.height) * h)
            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(w, x2)
            y2 = min(h, y2)
            if x2 <= x1 or y2 <= y1:
                continue

            face = img[y1:y2, x1:x2]
            if face.size == 0:
                continue
            cnt += 1

            pred_face = self.pretreatment_face(face)
            with torch.no_grad():
                face_feature = self.faceNet_model(pred_face)

            q = face_feature.view(-1)
            best_match = self.unknown_label
            min_dist = float("inf")
            second_min_dist = float("inf")
            for name, feature_bank in self.db_face_feature.items():
                if not isinstance(feature_bank, torch.Tensor) or feature_bank.numel() == 0:
                    continue
                dists = torch.norm(feature_bank - q.unsqueeze(0), dim=1)
                if dists.numel() == 0:
                    continue
                name_dist = float(torch.min(dists).item())
                if name_dist < min_dist:
                    second_min_dist = min_dist
                    min_dist = name_dist
                    best_match = name
                elif name_dist < second_min_dist:
                    second_min_dist = name_dist

            margin = second_min_dist - min_dist if np.isfinite(second_min_dist) else float("inf")
            pass_distance = min_dist <= self.face_distance_threshold
            pass_margin = margin >= self.face_margin_threshold
            is_known = bool(pass_distance and pass_margin and best_match != self.unknown_label)
            if not is_known:
                best_match = self.unknown_label
            elif best_match not in self.last_names:
                self.last_names.append(best_match)

            self.last_detections.append(
                {
                    "bbox": (x1, y1, x2, y2),
                    "name": best_match,
                    "distance": float(min_dist),
                    "second_distance": float(second_min_dist) if np.isfinite(second_min_dist) else None,
                    "margin": float(margin) if np.isfinite(margin) else None,
                    "known": bool(is_known),
                }
            )

            if draw:
                cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)
                img = self.put_chinese_text(img, f"{best_match} ({min_dist:.2f})", (x1, max(0, y1 - 22)))

        return cnt, img

    def get_last_names(self):
        return list(self.last_names)

    def get_last_detections(self):
        return list(self.last_detections)

    def get_primary_detection(self):
        known = [x for x in self.last_detections if bool(x.get("known"))]
        if not known:
            return None
        return min(known, key=lambda x: float(x.get("distance", 1e9)))

    def get_primary_name(self):
        det = self.get_primary_detection()
        if not det:
            return None
        return str(det.get("name") or "").strip() or None


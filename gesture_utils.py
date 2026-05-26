# gesture_utils.py
# 依赖：pip install mediapipe opencv-python
# 首次运行会自动下载官方模型 gesture_recognizer.task
import os
import time
import urllib.request
import cv2
import mediapipe as mp

# 把模型固定放到当前文件同目录，避免工作目录变化带来的找不到文件
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(_THIS_DIR, "gesture_recognizer.task")
MODEL_URL  = "https://storage.googleapis.com/mediapipe-assets/gesture_recognizer.task"

def _ensure_model(path=MODEL_PATH, url=MODEL_URL):
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print("[INFO] downloading gesture model:", url)
    urllib.request.urlretrieve(url, path)
    print("[OK] model saved:", path)
    return path

def _bbox_from_landmarks(norm_landmarks, W, H, pad=12):
    xs = [lm.x * W for lm in norm_landmarks]
    ys = [lm.y * H for lm in norm_landmarks]
    x1 = max(0, int(min(xs) - pad))
    y1 = max(0, int(min(ys) - pad))
    x2 = min(W, int(max(xs) + pad))
    y2 = min(H, int(max(ys) + pad))
    return x1, y1, x2, y2

class GestureDetector:
    def __init__(self, num_hands=2, det_conf=0.6, presence_conf=0.6, track_conf=0.6, score_thresh=0.6):
        model_path = _ensure_model()

        # --- 使用“buffer”方式传模型，彻底避免路径被拼错 ---
        with open(model_path, "rb") as f:
            model_bytes = f.read()

        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        BaseOptions = mp_python.BaseOptions
        GestureRecognizer = mp_vision.GestureRecognizer
        GestureRecognizerOptions = mp_vision.GestureRecognizerOptions
        RunningMode = mp_vision.RunningMode

        self.Image = mp.Image
        self.ImageFormat = mp.ImageFormat

        self.options = GestureRecognizerOptions(
            base_options=BaseOptions(model_asset_buffer=model_bytes),  # ⬅️ 关键改动
            running_mode=RunningMode.VIDEO,
            num_hands=num_hands,
            min_hand_detection_confidence=det_conf,
            min_hand_presence_confidence=presence_conf,
            min_tracking_confidence=track_conf,
        )
        self.recognizer = GestureRecognizer.create_from_options(self.options)
        self.score_thresh = score_thresh
        self._t0 = time.perf_counter()

    def infer(self, frame_bgr):
        """返回：
           boxes:  [(x1,y1,x2,y2), ...]
           labels: ['Thumb_Up'/'Thumb_Down'/其它类别名/None, ...]
           scores: [score 或 0.0, ...]
           lmks:   [landmarks list, ...]（用于可视化关键点）
        """
        H, W = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        mp_image = self.Image(image_format=self.ImageFormat.SRGB, data=rgb)
        ts_ms = int((time.perf_counter() - self._t0) * 1000)
        result = self.recognizer.recognize_for_video(mp_image, ts_ms)

        boxes, labels, scores, lmks = [], [], [], []
        if not result:
            return boxes, labels, scores, lmks

        if result.hand_landmarks:
            for i, landmarks in enumerate(result.hand_landmarks):
                lmks.append(landmarks)

                # top-1 类别
                top_label, top_score = None, 0.0
                if result.gestures and i < len(result.gestures) and result.gestures[i]:
                    top = result.gestures[i][0]
                    top_label, top_score = top.category_name, top.score
                    if top_score < self.score_thresh:
                        top_label, top_score = None, 0.0

                # 锚框基于 21 点
                x1, y1, x2, y2 = _bbox_from_landmarks(landmarks, W, H, pad=12)

                # 统一返回（方便上层统一处理和画框）
                boxes.append((x1, y1, x2, y2))
                labels.append(top_label if top_label is not None else None)
                scores.append(top_score if top_label is not None else 0.0)

        return boxes, labels, scores, lmks

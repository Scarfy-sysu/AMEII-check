# backend_embedder.py
# 功能：MediaPipe 人脸检测 + FaceNet 特征提取（CUDA 优先）
# 依赖：mediapipe, opencv-python, facenet-pytorch, torch, numpy

import cv2
import numpy as np
import torch
import mediapipe as mp
from facenet_pytorch import InceptionResnetV1


class FaceEmbedder:
    def __init__(self):
        # GPU 优先
        self.device = torch.device('cuda:0' if torch.cuda.is_available() else 'cpu')

        # MediaPipe 人脸检测（轻量、实时）
        self.detector = mp.solutions.face_detection.FaceDetection(
            model_selection=0, min_detection_confidence=0.6
        )

        # FaceNet 模型（VGGFace2 预训练）→ GPU
        self.model = InceptionResnetV1(pretrained='vggface2').eval().to(self.device)

    def detect_largest_face(self, frame_bgr):
        """
        输入：BGR 帧
        输出： (x1,y1,x2,y2), face_crop_bgr
             若未检测到人脸，返回 (None, None)
        """
        h, w = frame_bgr.shape[:2]
        result = self.detector.process(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
        if not result.detections:
            return None, None

        best_box = None
        best_area = -1
        for det in result.detections:
            box = det.location_data.relative_bounding_box
            x1 = max(0, int(box.xmin * w))
            y1 = max(0, int(box.ymin * h))
            x2 = min(w, int((box.xmin + box.width) * w))
            y2 = min(h, int((box.ymin + box.height) * h))
            if x2 <= x1 or y2 <= y1:
                continue
            area = (x2 - x1) * (y2 - y1)
            if area > best_area:
                best_area = area
                best_box = (x1, y1, x2, y2)

        if best_box is None:
            return None, None

        x1, y1, x2, y2 = best_box
        crop = frame_bgr[y1:y2, x1:x2].copy()
        return best_box, crop

    def _preprocess(self, face_bgr):
        # FaceNet 预处理：BGR -> RGB, resize 160, 归一化到 [-1,1]，转 torch.Tensor 并放到设备
        rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
        rgb = cv2.resize(rgb, (160, 160), interpolation=cv2.INTER_LINEAR)
        rgb = rgb.astype(np.float32) / 255.0
        rgb = (rgb - 0.5) / 0.5
        t = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)  # [1,3,160,160]
        return t.to(self.device, dtype=torch.float32, non_blocking=True)

    @torch.no_grad()
    def embed_face(self, face_bgr):
        """
        输入：人脸 BGR 裁剪图
        输出：FaceNet embedding，形状 [1,512]（在 GPU 上）
        """
        inp = self._preprocess(face_bgr)
        emb = self.model(inp)  # [1,512]
        return emb

FROM python:3.10-slim

WORKDIR /app

COPY services/inference/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY DB.py /app/DB.py
COPY FaceRecognition.py /app/FaceRecognition.py
COPY gesture_utils.py /app/gesture_utils.py
COPY backend_embedder.py /app/backend_embedder.py
COPY gesture_recognizer.task /app/gesture_recognizer.task
COPY services/inference/webcam_server.py /app/webcam_server.py

CMD ["uvicorn", "webcam_server:app", "--host", "0.0.0.0", "--port", "8765"]

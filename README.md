# AMEII-check

AMEII-check 是一个面向实验室、课程、小团队和活动现场的人脸签到/签退系统。它把浏览器摄像头采集、服务端人脸识别、手势识别、人工确认、在线状态和打卡统计整合在一个网页里：用户打开网页即可启动摄像头，管理员可以在网页端注册人脸，多样本补录提升稳定性，签到/签退记录会自动沉淀到本地数据库。

这个公开版不包含任何私有服务器地址、账号、密码、真实人脸库或主网站密钥。外部系统同步默认关闭，只保留通用接口，方便你接入自己的平台。

## Features

- 浏览器摄像头采集：不需要本地推流工具，网页直接采集画面并发送到服务端识别。
- 服务端识别框叠加：前端显示本地实时画面，服务端返回人脸框、手势框和识别结果后叠加显示。
- 人脸签到/签退：识别到用户后，根据当前在线状态自动推荐签到或签退。
- 手势辅助确认：支持手势识别逻辑，可结合待确认卡片完成签到/签退流程。
- 管理台注册人脸：管理员可注册用户、填写邮箱、补录多张人脸样本、管理人脸库。
- 在线状态统计：显示在线用户、签到时间、在线时长、今日时长。
- 记录管理：保存最近签到/签退记录，并自动计算签退时长。
- 可选外部同步：确认签到/签退后可通知第三方系统，默认关闭。

## Project Structure

```text
AMEII-check/
  services/api/          # Web console, login, admin pages, attendance API
  services/inference/    # Browser-camera inference WebSocket service
  deploy/                # Docker Compose and deployment helpers
  docs/                  # Optional integration docs
  data/                  # Runtime database directory, not committed
  DB.py                  # SQLite database layer
  FaceRecognition.py     # Face recognition logic
  gesture_utils.py       # Gesture recognition helper
  gesture_recognizer.task
```

## Quick Start With Docker

### 1. Install Requirements

Install:

- Docker
- Docker Compose
- A modern browser, such as Chrome or Edge

### 2. Clone

```bash
git clone <your-repository-url> AMEII-check
cd AMEII-check
```

### 3. Create Local Config

```bash
cp .env.example .env
```

Open `.env` and change at least:

```bash
USER_PASSWORD=your-user-password
ADMIN_PASSWORD=your-admin-password
```

Do not commit `.env`.

### 4. Start Services

```bash
cd deploy
docker compose --env-file ../.env up --build -d
```

### 5. Open The Web Console

Open:

```text
http://localhost:8000
```

Login with `USER_PASSWORD`.

Open the admin page from the top-right admin entry, then login with `ADMIN_PASSWORD`.

Docker exposes the web console on `8000`. The inference service is bound to `127.0.0.1:8765` by default, so the API can use it locally but other devices on the LAN cannot call it directly.

### 6. Register A Face

1. Enter the admin page.
2. Open the camera preview.
3. Fill in name and email.
4. Click capture.
5. Submit registration.
6. Use "add sample" to record more face samples for the same user.

### 7. Start Attendance

1. Return to the main console.
2. Click "open camera".
3. Wait for face boxes and recognition results.
4. Confirm or reject the pending attendance card.
5. View online status and attendance records.

## Local Python Development

Use Python 3.10.

### 1. Create Environment

```bash
python -m venv .venv
source .venv/bin/activate
```

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install Dependencies

```bash
pip install -r services/api/requirements.txt -r services/inference/requirements.txt
```

### 3. Create Config

```bash
cp .env.example .env
```

For local development, set:

```bash
DB_PATH=./data/face_database.db
WEBCAM_WS_BACKEND=ws://127.0.0.1:8765/ws/camera
WEBCAM_INTERNAL_REGISTER_URL=http://127.0.0.1:8765/internal/register-face
WEBCAM_INTERNAL_INFER_URL=http://127.0.0.1:8765/internal/infer-frame
```

### 4. Start Inference Service

Terminal 1:

```bash
set -a
source .env
set +a
python -m uvicorn services.inference.webcam_server:app --host 0.0.0.0 --port 8765
```

On Windows PowerShell:

```powershell
$env:DB_PATH="./data/face_database.db"
$env:CAM_SOURCE="cam1"
python -m uvicorn services.inference.webcam_server:app --host 0.0.0.0 --port 8765
```

### 5. Start API Service

Terminal 2:

```bash
set -a
source .env
set +a
python -m uvicorn services.api.app:app --host 0.0.0.0 --port 8000
```

On Windows PowerShell:

```powershell
$env:DB_PATH="./data/face_database.db"
$env:WEBCAM_WS_BACKEND="ws://127.0.0.1:8765/ws/camera"
$env:WEBCAM_INTERNAL_REGISTER_URL="http://127.0.0.1:8765/internal/register-face"
$env:WEBCAM_INTERNAL_INFER_URL="http://127.0.0.1:8765/internal/infer-frame"
$env:USER_PASSWORD="facecheck-user"
$env:ADMIN_PASSWORD="facecheck-admin"
python -m uvicorn services.api.app:app --host 0.0.0.0 --port 8000
```

Open:

```text
http://localhost:8000
```

## Camera Permission

Browser camera access works directly on:

- `http://localhost`
- `http://127.0.0.1`
- HTTPS pages

If you visit the site from another phone or computer on the LAN, use HTTPS. You can generate a self-signed certificate:

```bash
cd deploy
bash generate_self_signed_cert.sh <your-server-ip>
```

Then place the API behind HTTPS or adjust your Uvicorn command to use the generated certificate.

## External Sync

External sync is disabled by default:

```bash
EXTERNAL_SYNC_ENABLED=0
```

To connect your own platform, read:

```text
docs/EXTERNAL_SYNC.md
```

The public repository does not include a real external URL, token, bearer token, or private server address.

## Sensitive Files

Do not commit:

- `.env`
- `data/face_database.db`
- face photos or captured samples
- certificates and private keys
- tokens, passwords, cookies, logs, temporary files

The included `.gitignore` already blocks common runtime files.

## Security Notes

- Change `USER_PASSWORD` and `ADMIN_PASSWORD` before sharing the site with other users.
- Keep `EXTERNAL_SYNC_ENABLED=0` unless you have configured your own trusted endpoint.
- Do not expose port `8765` to the LAN or public internet. It is an internal inference service.
- Use HTTPS when accessing the site from phones or other computers on the same network.
- Treat `data/face_database.db` as sensitive biometric data. Back it up carefully and never publish it.

## FAQ

### The camera cannot be opened

Use `localhost` or HTTPS. Browser `getUserMedia` is usually blocked on plain HTTP LAN addresses.

### The camera opens but no recognition box appears

Check the inference service:

```bash
curl http://localhost:8765/health
```

Then check API health:

```bash
curl http://localhost:8000/health
```

### How do I change login passwords?

Edit `.env`:

```bash
USER_PASSWORD=your-user-password
ADMIN_PASSWORD=your-admin-password
```

Restart the services after changing passwords.

### How do I clear all local data?

Stop services, then delete:

```text
data/face_database.db
```

The database will be recreated on the next start.

### How do I add more samples for one person?

Open the admin page, find the user in the face library, and use the add-sample function. Multiple samples usually improve recognition stability under different lighting, angles, and distance.

### How do I disable external sync?

Set:

```bash
EXTERNAL_SYNC_ENABLED=0
```

This is the default behavior.

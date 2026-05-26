# AMEII-check

AMEII-check 是一个网页版人脸签到系统。它把浏览器摄像头、服务端人脸识别、手势识别、人工确认、在线状态和打卡记录放在同一个页面里。用户打开网页就能开摄像头，管理员也可以直接在网页里注册人脸、补录样本和管理人脸库。

这个仓库是公开版。里面不包含真实服务器地址、账号、密码、token、人脸数据库或注册照片。外部系统同步默认关闭，如果你需要把签到结果发给自己的平台，可以按 `docs/EXTERNAL_SYNC.md` 自行接入。

## 主要功能

- 浏览器直接调用摄像头，不需要本地推流工具。
- 服务端做人脸和手势识别，前端把识别框叠加到实时画面上。
- 识别到用户后，系统会根据当前在线状态推荐签到或签退。
- 待确认动作以卡片形式显示，需要确认后才会写入记录。
- 管理台支持注册人脸、填写邮箱、补录多张样本和管理人脸库。
- 在线状态会显示签到时间、在线时长和今日时长。
- 签退时自动计算本次打卡时长。
- 可选外部同步接口，默认不启用。

## 目录结构

```text
AMEII-check/
  services/api/          # 网页、登录、管理台、签到接口
  services/inference/    # 浏览器摄像头推理服务
  deploy/                # Docker Compose 和部署脚本
  docs/                  # 外部同步说明
  data/                  # 运行时数据库目录，不提交真实数据
  DB.py                  # SQLite 数据库逻辑
  FaceRecognition.py     # 人脸识别逻辑
  gesture_utils.py       # 手势识别逻辑
  gesture_recognizer.task
```

## 用 Docker 启动

推荐先用 Docker 跑起来。这样环境最少，出错点也少。

### 1. 准备环境

需要安装：

- Docker
- Docker Compose
- Chrome、Edge 或其他支持摄像头权限的现代浏览器

### 2. 克隆仓库

```bash
git clone <your-repository-url> AMEII-check
cd AMEII-check
```

### 3. 创建配置文件

```bash
cp .env.example .env
```

打开 `.env`，至少改掉这两个密码：

```bash
USER_PASSWORD=your-user-password
ADMIN_PASSWORD=your-admin-password
```

不要把 `.env` 提交到 GitHub。

### 4. 启动服务

```bash
cd deploy
docker compose --env-file ../.env up --build -d
```

### 5. 打开网页

浏览器访问：

```text
http://localhost:8000
```

使用 `.env` 里的 `USER_PASSWORD` 登录首页。

右上角进入管理台，使用 `ADMIN_PASSWORD` 登录。

Docker 默认只把网页服务暴露在 `8000` 端口。推理服务绑定在 `127.0.0.1:8765`，API 可以通过 Docker 内网访问它，但局域网里的其他设备不能直接调用推理服务。

### 6. 注册人脸

1. 进入管理台。
2. 打开摄像头预览。
3. 填写姓名和邮箱。
4. 点击拍照。
5. 提交注册。
6. 如果想提高识别稳定性，可以给同一个人继续补录样本。

### 7. 开始签到

1. 回到首页。
2. 点击打开摄像头。
3. 等待人脸框和识别结果出现。
4. 在待确认卡片上点击确认或驳回。
5. 在在线状态和签到记录里查看结果。

## 本地 Python 开发

如果你要改代码或调试细节，可以用本地 Python 启动。建议使用 Python 3.10。

### 1. 创建虚拟环境

Linux 或 macOS：

```bash
python -m venv .venv
source .venv/bin/activate
```

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. 安装依赖

```bash
pip install -r services/api/requirements.txt -r services/inference/requirements.txt
```

### 3. 创建配置

```bash
cp .env.example .env
```

本地开发通常使用下面这些地址：

```bash
DB_PATH=./data/face_database.db
WEBCAM_WS_BACKEND=ws://127.0.0.1:8765/ws/camera
WEBCAM_INTERNAL_REGISTER_URL=http://127.0.0.1:8765/internal/register-face
WEBCAM_INTERNAL_INFER_URL=http://127.0.0.1:8765/internal/infer-frame
```

### 4. 启动推理服务

终端 1：

```bash
set -a
source .env
set +a
python -m uvicorn services.inference.webcam_server:app --host 0.0.0.0 --port 8765
```

Windows PowerShell：

```powershell
$env:DB_PATH="./data/face_database.db"
$env:CAM_SOURCE="cam1"
python -m uvicorn services.inference.webcam_server:app --host 0.0.0.0 --port 8765
```

### 5. 启动 API 服务

终端 2：

```bash
set -a
source .env
set +a
python -m uvicorn services.api.app:app --host 0.0.0.0 --port 8000
```

Windows PowerShell：

```powershell
$env:DB_PATH="./data/face_database.db"
$env:WEBCAM_WS_BACKEND="ws://127.0.0.1:8765/ws/camera"
$env:WEBCAM_INTERNAL_REGISTER_URL="http://127.0.0.1:8765/internal/register-face"
$env:WEBCAM_INTERNAL_INFER_URL="http://127.0.0.1:8765/internal/infer-frame"
$env:USER_PASSWORD="facecheck-user"
$env:ADMIN_PASSWORD="facecheck-admin"
python -m uvicorn services.api.app:app --host 0.0.0.0 --port 8000
```

然后访问：

```text
http://localhost:8000
```

## 摄像头权限

浏览器对摄像头权限比较严格。下面几种情况通常可以正常使用：

- `http://localhost`
- `http://127.0.0.1`
- HTTPS 页面

如果你想在手机或另一台电脑上访问，需要使用 HTTPS。可以先生成自签名证书：

```bash
cd deploy
bash generate_self_signed_cert.sh <your-server-ip>
```

之后可以把 API 放到 HTTPS 反向代理后面，或者自己调整 Uvicorn 启动命令，加载生成的证书。

## 外部系统同步

默认不会向外部系统发送签到结果：

```bash
EXTERNAL_SYNC_ENABLED=0
```

如果你要接入自己的主站、课程平台或实验室系统，阅读：

```text
docs/EXTERNAL_SYNC.md
```

公开仓库不会内置任何真实外部接口地址、token 或服务器信息。

## 不要提交这些文件

下面这些文件可能包含隐私或运行数据，不应该上传到 GitHub：

- `.env`
- `data/face_database.db`
- 人脸照片或截图样本
- 证书和私钥
- token、密码、cookie、日志、临时文件

仓库里的 `.gitignore` 已经默认忽略这些内容。

## 安全建议

- 部署前一定要修改 `USER_PASSWORD` 和 `ADMIN_PASSWORD`。
- 不接外部系统时，保持 `EXTERNAL_SYNC_ENABLED=0`。
- 不要把 `8765` 端口暴露到局域网或公网，它只是内部推理服务。
- 手机或其他电脑访问时，尽量使用 HTTPS。
- `data/face_database.db` 里会保存人脸特征和注册图片，按敏感数据处理。

## 常见问题

### 摄像头打不开

先确认你是在 `localhost`、`127.0.0.1` 或 HTTPS 页面中访问。普通 HTTP 局域网地址经常会被浏览器禁止摄像头权限。

### 摄像头打开了，但没有识别框

先检查推理服务：

```bash
curl http://localhost:8765/health
```

再检查 API：

```bash
curl http://localhost:8000/health
```

两个接口都应该返回 JSON，并且包含 `"ok": true`。

### 怎么修改登录密码

编辑 `.env`：

```bash
USER_PASSWORD=your-user-password
ADMIN_PASSWORD=your-admin-password
```

修改后重启服务。

### 怎么清空本地数据

停止服务后删除：

```text
data/face_database.db
```

下次启动时系统会自动创建新的数据库。

### 一个人能录入多张样本吗

可以。进入管理台，在人脸库里找到这个用户，使用补样本功能继续录入。多样本通常能改善不同光照、角度和距离下的识别效果。

### 怎么关闭外部同步

保持下面这个配置即可：

```bash
EXTERNAL_SYNC_ENABLED=0
```

这是默认设置。

# Deployment Steps

This guide uses Docker Compose as the recommended path. It starts two services:

- `api`: web console, login, attendance records, admin pages
- `webcam-ws`: browser-camera frame inference service

## 1. Prepare

Install Docker and Docker Compose, then clone the repository:

```bash
git clone <your-repository-url> AMEII-check
cd AMEII-check
```

Create local configuration:

```bash
cp .env.example .env
```

Edit `.env` and change at least:

```bash
USER_PASSWORD=your-user-password
ADMIN_PASSWORD=your-admin-password
```

## 2. Start With Docker

```bash
cd deploy
docker compose --env-file ../.env up --build -d
```

Open:

```text
http://localhost:8000
```

Default ports:

- Web console: `8000`
- Web camera inference WebSocket: `127.0.0.1:8765`

The inference service is intentionally bound to localhost. Keep it internal unless you add your own authentication and network controls.

## 3. Use HTTPS On A LAN

Browser camera access is reliable on `localhost` over HTTP. For another device on the same LAN, use HTTPS or a trusted reverse proxy.

Generate a self-signed certificate for your server IP:

```bash
cd deploy
bash generate_self_signed_cert.sh <your-server-ip>
```

Then run the API behind your own HTTPS proxy, or adjust `deploy/docker-compose.yml` to mount `deploy/certs` and pass `--ssl-keyfile` and `--ssl-certfile` to Uvicorn.

## 4. Health Checks

```bash
curl http://localhost:8000/health
curl http://localhost:8765/health
```

Both endpoints should return JSON with `"ok": true`.

## 5. Stop

```bash
cd deploy
docker compose down
```

Runtime data is stored in `data/face_database.db`. Do not commit this file to GitHub.

## Security Checklist

- Change `USER_PASSWORD` and `ADMIN_PASSWORD` in `.env`.
- Keep `EXTERNAL_SYNC_ENABLED=0` unless you configure your own trusted endpoint.
- Keep port `8765` local-only.
- Use HTTPS for LAN or public access.
- Never publish `data/face_database.db`, certificates, private keys, or `.env`.

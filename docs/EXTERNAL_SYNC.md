# External Sync

AMEII-check can notify another system after an attendance action is confirmed. This is disabled by default so the public repository does not call any private service.

## Enable

Copy `.env.example` to `.env`, then configure:

```bash
EXTERNAL_SYNC_ENABLED=1
EXTERNAL_SYNC_URL=https://example.com/api/face-check
EXTERNAL_SYNC_SECRET=replace-with-your-shared-secret
EXTERNAL_SYNC_BEARER_TOKEN=
```

If the external service needs a bearer token, set `EXTERNAL_SYNC_BEARER_TOKEN`. Otherwise leave it empty.

## Request Shape

When enabled, the API sends a `POST` request after a sign-in or sign-out action is confirmed:

```json
{
  "email": "user@example.com",
  "status": "checked_in",
  "token": "replace-with-your-shared-secret"
}
```

For sign-out, `status` is:

```json
"checked_out"
```

The request includes:

```http
Content-Type: application/json
Authorization: Bearer <EXTERNAL_SYNC_BEARER_TOKEN>
```

The `Authorization` header is sent only when `EXTERNAL_SYNC_BEARER_TOKEN` is not empty.

## Retry Behavior

Failed requests with timeout, HTTP 408, HTTP 429, or HTTP 5xx are retried. The default retry settings are:

```bash
EXTERNAL_SYNC_MAX_ATTEMPTS=6
EXTERNAL_SYNC_POLL_SEC=2
EXTERNAL_SYNC_TIMEOUT_SEC=8
```

## Notes

- External sync only runs after a pending action is confirmed.
- Preview mode and rejected actions do not trigger external sync.
- If a user has no valid email and external sync is enabled, confirmation fails and asks the admin to update the email.
- If external sync is disabled, attendance works without email-based external notification.

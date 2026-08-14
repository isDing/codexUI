# Codex UI

Codex UI is a self-hosted web client for the Codex App Server installed on this machine. It groups all persisted Codex threads by working directory, renders full thread history, streams active turns, and can continue an existing thread with per-thread model, reasoning-effort, and permission settings.

## Runtime layout

- Web/API: Node.js + Express + React, exposed by Docker on `127.0.0.1:3090`.
- Codex: one `codex app-server` child process using `/home/user/.codex`.
- State: a Docker volume containing login sessions, thread preferences, and unread completion notices.
- Public ingress: the host Nginx instance at `https://example.com`.

The compose file mounts `/home/user/code` and `/home/user/server` at their original absolute paths. This is required because Codex stores each thread's original working directory.

## Configure

Create `.env` from `.env.example`. Generate the password hash without storing a plaintext password in the file:

```bash
CODEXUI_PASSWORD='a-long-unique-password' node scripts/hash-password.mjs
openssl rand -base64 48
```

Put the first command's output in `ADMIN_PASSWORD_HASH` and the second command's output in `SESSION_SECRET`. Login sessions expire after four hours without pointer, keyboard, or touch activity.

## Run

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3090/api/health
```

Install `deploy/nginx-http.conf` first, request the certificate with Certbot's webroot mode, and then replace it with `deploy/nginx-https.conf`:

```bash
certbot certonly --webroot -w /var/www/certbot -d example.com
nginx -t
systemctl reload nginx
```

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

The Vite server runs on port 5173 and proxies the API and WebSocket to port 3000.

Run the browser checks against a test instance on port 3100 without putting a password in source control:

```bash
CODEXUI_E2E_PASSWORD='the-test-instance-password' \
CODEXUI_BASE_URL='http://127.0.0.1:3100' \
npm run test:e2e
```

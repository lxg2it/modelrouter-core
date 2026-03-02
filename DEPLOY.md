# Deployment Guide — Model Router

**Domain:** `api.lxg2it.com`  
**Server:** `13.54.219.192` (same server as lxg2it.com)  
**Port:** `3003` (Docker container, mapped to host)

---

## Prerequisites

This guide assumes:
- SSH access to `13.54.219.192` as `ec2-user`
- Docker and Docker Compose installed on the server
- Nginx installed and running
- `certbot` installed for Let's Encrypt

---

## Step 1: Clone the repo on the server

```bash
ssh ec2-user@13.54.219.192
cd ~/repo
git clone git@github.com:lxg2it/modelrouter.git
cd modelrouter
```

> **Note:** The `sje397-automation` SSH key at `~/.ssh/id_rsa` has access to `lxg2it` repos.

---

## Step 2: Create `.env`

```bash
cat > .env << 'EOF'
# Provider API keys
ANTHROPIC_API_KEY=<from 1Password / Anthropic console>
OPENAI_API_KEY=<from 1Password / OpenAI console>
GOOGLE_API_KEY=AIzaSyAGJXVUTnmkFr5_oIYJEMKIAwhwotir-rY

# Stripe billing
STRIPE_SECRET_KEY=<your Stripe live secret key>
STRIPE_PUBLISHABLE_KEY=<your Stripe live publishable key>

# Satbill (optional — leave blank if not deploying satbill yet)
SATBILL_BASE_URL=
SATBILL_API_SECRET=
EOF
```

> Stripe sandbox keys are in the `.env` on the local dev machine (`~/repo/modelrouter/.env`).  
> For production, use **live** keys from the Stripe dashboard.

---

## Step 3: Build and start the container

```bash
cd ~/repo/modelrouter
docker compose build
docker compose up -d
```

Verify it's running:
```bash
curl http://localhost:3003/health
```

Should return:
```json
{"status":"ok","version":"0.1.0","billing":{"satbill":"disabled","stripe":"enabled"}}
```

---

## Step 4: DNS

Add an A record to `lxg2it.com` DNS (via Cloudflare):

| Type | Name | Value              |
|------|------|--------------------|
| A    | api  | 13.54.219.192      |

Cloudflare API token is in global memories if needed.

---

## Step 5: Nginx config

Create `/etc/nginx/conf.d/api.lxg2it.com.conf`:

```nginx
server {
    listen 80;
    server_name api.lxg2it.com;

    location / {
        proxy_pass http://localhost:3003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 120s;
        chunked_transfer_encoding on;
    }
}
```

Test and reload:
```bash
sudo nginx -t && sudo nginx -s reload
```

---

## Step 6: SSL with Let's Encrypt

```bash
sudo certbot --nginx -d api.lxg2it.com
```

Certbot will rewrite the nginx config to add HTTPS and auto-redirect.

---

## Step 7: Create your first API key

```bash
curl -X POST https://api.lxg2it.com/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"admin"}'
```

Save the returned `apiKey`. Use it with the dashboard:

```
https://api.lxg2it.com/dashboard
```

---

## Updating

```bash
cd ~/repo/modelrouter
git pull
docker compose build
docker compose up -d
```

Zero-downtime: the old container handles requests until the new one is ready.

---

## Environment variables reference

| Variable              | Required | Description                                      |
|-----------------------|----------|--------------------------------------------------|
| `ANTHROPIC_API_KEY`   | Yes*     | Anthropic API key (* at least one provider required) |
| `OPENAI_API_KEY`      | Yes*     | OpenAI API key                                   |
| `GOOGLE_API_KEY`      | Yes*     | Google Gemini API key                            |
| `STRIPE_SECRET_KEY`   | No       | Enables card billing + dashboard                 |
| `STRIPE_PUBLISHABLE_KEY` | No    | Needed alongside secret key for dashboard        |
| `SATBILL_BASE_URL`    | No       | URL of satbill instance for Bitcoin billing      |
| `SATBILL_API_SECRET`  | No       | Shared secret for satbill API                    |
| `PORT`                | No       | HTTP port (default: 3003)                        |
| `DB_PATH`             | No       | SQLite database path (default: /data/modelrouter.db) |
| `LOG_LEVEL`           | No       | `debug` or `info` (default: info)               |

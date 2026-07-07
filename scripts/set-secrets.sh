#!/usr/bin/env bash
# Nastaví produkčné secrets workera granthub z lokálneho .env (SMTP) + vygeneruje tajomstvá.
# DATABASE_URL sa nastavuje zvlášť: echo "postgres://..." | npx wrangler secret put DATABASE_URL
set -euo pipefail
cd "$(dirname "$0")/.."
export CLOUDFLARE_ACCOUNT_ID=6648ac609237bc7e2568ca1ed3914d8d

source <(grep -E '^(SMTP_|MAIL_FROM|ORDERS_EMAIL|ADMIN_EMAILS)' .env | sed 's/^/export /')

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  ✓ $1"; }

put SESSION_SECRET "$(openssl rand -base64 48)"
put CRON_SECRET "$(openssl rand -hex 32)"
put SMTP_HOST "$SMTP_HOST"
put SMTP_PORT "$SMTP_PORT"
put SMTP_SECURE "${SMTP_SECURE:-0}"
put SMTP_USER "$SMTP_USER"
put SMTP_PASS "$SMTP_PASS"
put MAIL_FROM "${MAIL_FROM//\"/}"
put ORDERS_EMAIL "${ORDERS_EMAIL:-filip@ques.sk}"
put ADMIN_EMAILS "${ADMIN_EMAILS:-filip@ques.sk}"
put BASE_URL "https://granthub.sk"
echo "Hotovo. DATABASE_URL nastav zvlášť."

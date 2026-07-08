#!/usr/bin/env bash
# Pridá do Cloudflare DNS (granthub.sk) SPF + 2× DKIM CNAME pre Brevo.
# Potrebuje Cloudflare API token s právom Zone → DNS → Edit pre granthub.sk.
#
# Použitie:
#   CF_TOKEN=xxxxxxxx bash scripts/add-brevo-dns.sh
#
# Token vytvoríš: Cloudflare → My Profile → API Tokens → Create Token →
#   „Edit zone DNS" → Zone Resources: Include → Specific zone → granthub.sk.
set -euo pipefail

: "${CF_TOKEN:?Nastav CF_TOKEN=<cloudflare API token s Zone:DNS:Edit>}"
ZONE="1285da3be37321cd182cc2d5614be27c"   # granthub.sk
API="https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records"

add() {  # typ, meno, obsah, [extra json]
  local type="$1" name="$2" content="$3" extra="${4:-}"
  echo "→ $type $name"
  curl -s -X POST "$API" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"type\":\"$type\",\"name\":\"$name\",\"content\":\"$content\",\"ttl\":3600,\"proxied\":false${extra}}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ✓ pridané' if d.get('success') else '  ✗ '+str(d.get('errors')))"
}

add CNAME "brevo1._domainkey.granthub.sk" "b1.granthub-sk.dkim.brevo.com"
add CNAME "brevo2._domainkey.granthub.sk" "b2.granthub-sk.dkim.brevo.com"
add TXT   "granthub.sk"                    "v=spf1 include:spf.brevo.com mx ~all"

echo "Hotovo. V Brevo (Domains → granthub.sk) klikni Verify/Authenticate."

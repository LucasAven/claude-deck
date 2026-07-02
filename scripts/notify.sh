#!/usr/bin/env bash
# Push vía ntfy.sh cuando Claude Code necesita atención (hooks Notification/Stop).
# El topic secreto se lee de NTFY_TOPIC en el .env del proyecto (nunca commitearlo).
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${NTFY_TOPIC:-}" ] && [ -f "$DIR/.env" ]; then
  NTFY_TOPIC="$(grep -E '^NTFY_TOPIC=' "$DIR/.env" | tail -n1 | cut -d= -f2-)"
fi

[ -z "${NTFY_TOPIC:-}" ] && exit 0

curl -s -m 5 \
  -H "Title: claude-deck" \
  -H "Tags: robot" \
  -d "${1:-Claude espera tu respuesta}" \
  "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true

exit 0

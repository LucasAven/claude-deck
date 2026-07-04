#!/usr/bin/env bash
# Push vía ntfy.sh cuando Claude Code necesita atención (hooks Notification/Stop).
# El topic secreto se lee de NTFY_TOPIC en el .env del proyecto (nunca commitearlo).
set -u

# Solo notificar sesiones que corren dentro de tmux (las controlables remoto);
# fuera de tmux estás en la compu mirando la terminal, el push sobra.
[ -z "${TMUX:-}" ] && exit 0

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

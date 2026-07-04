#!/usr/bin/env bash
# Push vía ntfy.sh cuando Claude Code necesita atención (hooks Notification /
# Stop / PermissionRequest). El topic secreto se lee de NTFY_TOPIC en el .env
# del proyecto (nunca commitearlo).
#
# Contexto (tarea 1): los hooks mandan un JSON por stdin (hook_event_name,
# message, tool_input, …) — se usa para armar título (sesión tmux), cuerpo
# (qué pide) y deep-link (Click → PWA con esa sesión seleccionada, DECK_URL
# en .env). Fallback: sin jq / sin stdin / JSON roto, se comporta como antes
# usando el mensaje fijo de argv — las configs de hooks viejas siguen andando.
set -u

# Solo notificar sesiones que corren dentro de tmux (las controlables remoto);
# fuera de tmux estás en la compu mirando la terminal, el push sobra.
[ -z "${TMUX:-}" ] && exit 0

DIR="$(cd "$(dirname "$0")/.." && pwd)"

env_get() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-; }

if [ -z "${NTFY_TOPIC:-}" ]; then NTFY_TOPIC="$(env_get NTFY_TOPIC)"; fi
[ -z "${NTFY_TOPIC:-}" ] && exit 0

# DECK_URL (opcional): la escribe `deck install`/`deck url` al configurar
# tailscale serve; sin ella el push sale igual, solo que sin deep-link.
if [ -z "${DECK_URL:-}" ]; then DECK_URL="$(env_get DECK_URL)"; fi

# stdin UNA sola vez (los hooks siempre lo pipean; en una terminal interactiva
# no hay que colgarse esperando EOF)
PAYLOAD=''
[ -t 0 ] || PAYLOAD="$(cat 2>/dev/null || true)"

# Título = sesión tmux (estamos adentro: $TMUX está seteado, sin -t resuelve
# la sesión propia del cliente)
SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
TITLE="${SESSION:-claude-deck}"

# Cuerpo por defecto = argv, como siempre (configs de hooks viejas)
BODY="${1:-Claude espera tu respuesta}"

# Dedup permiso: PermissionRequest y Notification(permission_prompt) disparan
# los dos para el MISMO prompt (medido: ~6 s de diferencia). Si ambos eventos
# están hookeados, el rico (PermissionRequest) marca y el genérico se calla.
MARK_DIR="${TMPDIR:-/tmp}/claude-deck-notify"

if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  EVENT="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
  SID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
  case "$EVENT" in
    PermissionRequest)
      # payload real: tool_name + tool_input.{command,description,file_path…}
      TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null || true)"
      DETAIL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // .tool_input.file_path // .tool_input.url // empty' 2>/dev/null || true)"
      DESC="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.description // empty' 2>/dev/null || true)"
      if [ -n "$TOOL" ]; then
        if [ -n "$DETAIL" ]; then
          BODY="$TOOL: ${DETAIL:0:300}"
        else
          BODY="Permiso para usar $TOOL"
        fi
        [ -n "$DESC" ] && BODY="$BODY
${DESC:0:200}"
      fi
      if [ -n "$SID" ]; then
        mkdir -p "$MARK_DIR" 2>/dev/null || true
        touch "$MARK_DIR/permreq-$SID" 2>/dev/null || true
        find "$MARK_DIR" -type f -mmin +60 -delete 2>/dev/null || true
      fi
      ;;
    Notification)
      NTYPE="$(printf '%s' "$PAYLOAD" | jq -r '.notification_type // empty' 2>/dev/null || true)"
      if [ "$NTYPE" = "permission_prompt" ] && [ -n "$SID" ] && [ -f "$MARK_DIR/permreq-$SID" ]; then
        NOW="$(date +%s)"
        MTIME="$(stat -f %m "$MARK_DIR/permreq-$SID" 2>/dev/null || echo 0)"
        [ $((NOW - MTIME)) -lt 30 ] && exit 0 # ya salió el push rico
      fi
      MSG="$(printf '%s' "$PAYLOAD" | jq -r '.message // empty' 2>/dev/null || true)"
      [ -n "$MSG" ] && BODY="${MSG:0:300}"
      ;;
    Stop)
      BODY="${1:-Claude terminó la tarea}"
      SNIPPET="$(printf '%s' "$PAYLOAD" | jq -r '.last_assistant_message // empty' 2>/dev/null | tr '\n' ' ' | cut -c1-160)"
      [ -n "$SNIPPET" ] && BODY="Terminó: $SNIPPET"
      ;;
  esac
fi

# Click → PWA con la sesión ya seleccionada (init lee ?session=). Solo con
# nombres que el server acepta (mismo SESSION_RE) — así no hace falta encodear.
ARGS=(-s -m 5 -H "Title: $TITLE" -H "Tags: robot" -d "$BODY")
if [ -n "${DECK_URL:-}" ] && printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$'; then
  ARGS+=(-H "Click: ${DECK_URL%/}/?session=$SESSION")
fi

curl "${ARGS[@]}" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true

exit 0

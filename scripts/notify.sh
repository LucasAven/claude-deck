#!/usr/bin/env bash
# Push nativo (Web Push de la PWA) cuando Claude Code necesita atención (hooks
# Notification / Stop / PermissionRequest). El envío va por el server local
# (POST /api/push/send con el AUTH_TOKEN del .env, solo a 127.0.0.1) y de ahí
# al push service de Apple/Google con firma VAPID. ntfy se retiró (tarea 26):
# sin PWA suscripta (campanita 🔔 de la app) NO hay push — la campanita es LA
# fuente de notificaciones; el server loguea los envíos sin entrega y el panel
# muestra un aviso.
#
# Contexto (tarea 1): los hooks mandan un JSON por stdin (hook_event_name,
# message, tool_input, …) — se usa para armar título (sesión tmux), cuerpo
# (qué pide) y deep-link (tap → PWA con esa sesión seleccionada; la URL va
# RELATIVA y el service worker la resuelve contra su propio scope). Las pushes
# de permiso ya no llevan botones Permitir/Denegar (Lucas no los usaba y el
# Web Push de iOS no soporta actions custom): el tap abre la app y se contesta
# adentro. Fallback: sin stdin / JSON roto, sale el mensaje fijo de argv — las
# configs de hooks viejas siguen andando.
set -u

# Solo notificar sesiones que corren dentro de tmux (las controlables remoto);
# fuera de tmux estás en la compu mirando la terminal, el push sobra.
[ -z "${TMUX:-}" ] && exit 0

DIR="$(cd "$(dirname "$0")/.." && pwd)"

env_get() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-; }

# jq es requisito duro: parsea el payload del hook Y arma el JSON del push
# (BODY puede traer comillas/saltos de línea — nada de printf a mano). Sin jq
# no hay push (brew install jq).
command -v jq >/dev/null 2>&1 || exit 0

AUTH_TOKEN="$(env_get AUTH_TOKEN)"
[ -z "$AUTH_TOKEN" ] && exit 0
DECK_PORT="${DECK_PORT:-$(env_get DECK_PORT)}"
DECK_PORT="${DECK_PORT:-7433}"

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

if [ -n "$PAYLOAD" ]; then
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

# Presencia (tarea 3): si ya estás mirando, el push sobra — se DESCARTA (no
# hay push silencioso; decidido 2026-07-04). Única señal: alguna PWA visible en
# primer plano — el server lo sabe por los reports {t:'vis'} del WS
# (GET /api/presence, TTL 25 s). Al bloquear el celu o cambiar de app,
# visibilitychange lo apaga. Falla ABIERTO: error, timeout o lectura rara =
# mandar el push igual (perder una notificación es peor que una redundante).
# La señal "Mac presente" (pantalla desbloqueada + HIDIdleTime) se RETIRÓ a
# pedido de Lucas 2026-07-07: dejar la compu un rato y seguir desde el celu
# suprimía pushes que sí quería recibir.
phone_present() {
  curl -s -m 1 -H "x-deck-token: $AUTH_TOKEN" \
    "http://127.0.0.1:${DECK_PORT}/api/presence" 2>/dev/null | grep -q '"visible":true'
}

if phone_present; then
  exit 0
fi

# Web Push (tareas 23/26): única vía, para TODOS los eventos — permiso, Stop e
# idle. URL del click RELATIVA (path only): el service worker la resuelve contra
# su propio scope (self.registration.scope), así el tap cae en el origen desde
# el que se instaló la PWA — que puede NO ser el de DECK_URL (rama en otro
# puerto vía tailscale serve). Mandar una URL absoluta acá rompía el enrutado a
# la app en iOS. Solo con nombres de sesión que el server acepta (SESSION_RE) —
# así no hace falta encodear. El AUTH_TOKEN viaja SOLO a 127.0.0.1.
WP_URL='/'
if printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$'; then
  WP_URL="/?session=$SESSION"
fi
WP_PAYLOAD="$(jq -nc --arg t "$TITLE" --arg b "$BODY" --arg u "$WP_URL" --arg g "$SESSION" \
  '{title:$t, body:$b, url:$u, tag:$g}' 2>/dev/null || true)"
[ -n "$WP_PAYLOAD" ] && curl -s -m 3 -H "x-deck-token: $AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d "$WP_PAYLOAD" "http://127.0.0.1:${DECK_PORT}/api/push/send" >/dev/null 2>&1 || true

exit 0

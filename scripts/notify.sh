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

# ¿Este push corresponde a un prompt de permiso? (tarea 2) Solo esos llevan los
# botones Permitir/Denegar — Stop / idle no tienen menú que contestar.
IS_PERMISSION=0

# Dedup permiso: PermissionRequest y Notification(permission_prompt) disparan
# los dos para el MISMO prompt (medido: ~6 s de diferencia). Si ambos eventos
# están hookeados, el rico (PermissionRequest) marca y el genérico se calla.
MARK_DIR="${TMPDIR:-/tmp}/claude-deck-notify"

if command -v jq >/dev/null 2>&1 && [ -n "$PAYLOAD" ]; then
  EVENT="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
  SID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null || true)"
  case "$EVENT" in
    PermissionRequest)
      IS_PERMISSION=1
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
      # Si el rico no llegó a marcar (solo Notification hookeado), este push
      # ES el del permiso y debe llevar los botones.
      [ "$NTYPE" = "permission_prompt" ] && IS_PERMISSION=1
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
# hay push silencioso; decidido 2026-07-04). Dos señales, alcanza una:
#   (a) Mac presente: pantalla desbloqueada + input hace < DECK_PRESENCE_IDLE
#       segundos (HIDIdleTime; default 5 min — tolera leer output largo).
#   (b) Celu presente: alguna PWA visible en primer plano — el server lo sabe
#       por los reports {t:'vis'} del WS (GET /api/presence, TTL 25 s). Al
#       bloquear el celu o cambiar de app, visibilitychange lo apaga.
# Todo falla ABIERTO: error, timeout o lectura rara = mandar el push igual
# (perder una notificación es peor que una redundante). El AUTH_TOKEN viaja
# SOLO a 127.0.0.1 — jamás en nada que toque ntfy.
IDLE_MAX="${DECK_PRESENCE_IDLE:-$(env_get DECK_PRESENCE_IDLE)}"
IDLE_MAX="${IDLE_MAX:-300}"

mac_present() {
  # pantalla bloqueada → ausente. macOS moderno (probado en Darwin 25) expone
  # IOConsoleLocked (siempre presente, true/false — y recién pasa a true cuando
  # vence el "require password after", no al apagarse la pantalla); versiones
  # viejas mostraban CGSSessionScreenIsLocked solo al bloquear. Se aceptan las
  # dos: cualquiera en <true/> = bloqueada.
  LOCKED="$(ioreg -n Root -d1 -a 2>/dev/null | grep -A1 -E 'IOConsoleLocked|CGSSessionScreenIsLocked' | grep -c '<true/>')"
  [ "${LOCKED:-0}" -gt 0 ] && return 1
  IDLE="$(ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}')"
  case "$IDLE" in '' | *[!0-9]*) return 1 ;; esac # sin lectura → no afirmar presencia
  [ "$IDLE" -lt "$IDLE_MAX" ]
}

phone_present() {
  TOKEN="$(env_get AUTH_TOKEN)"
  [ -n "$TOKEN" ] || return 1
  PORT="${DECK_PORT:-$(env_get DECK_PORT)}"
  curl -s -m 1 -H "x-deck-token: $TOKEN" \
    "http://127.0.0.1:${PORT:-7433}/api/presence" 2>/dev/null | grep -q '"visible":true'
}

if mac_present || phone_present; then
  exit 0
fi

# Web Push nativo de la PWA (tarea 23): SOLO para las pushes planas (Stop /
# "Claude te necesita"). Las de permiso llevan botones Permitir/Denegar y el
# Web Push de iOS no soporta action buttons custom → esas SIEMPRE por ntfy.
# Si hay una PWA suscripta y el envío entrega ≥1, NO mandamos ntfy (evitamos la
# doble notificación). Sin suscripción, sin server o si falla → degradación
# silenciosa a ntfy, como siempre. El AUTH_TOKEN viaja SOLO a 127.0.0.1.
if [ "$IS_PERMISSION" = 0 ]; then
  WP_TOKEN="$(env_get AUTH_TOKEN)"
  WP_PORT="${DECK_PORT:-$(env_get DECK_PORT)}"; WP_PORT="${WP_PORT:-7433}"
  # URL del click RELATIVA (path only): el service worker la resuelve contra su
  # propio scope (self.registration.scope), así el tap cae en el origen desde el
  # que se instaló la PWA — que puede NO ser el de DECK_URL (rama en otro puerto
  # vía tailscale serve). Mandar el DECK_URL absoluto acá rompía el enrutado a la
  # app en iOS. No depende de DECK_URL: la web push es local al deck instalado.
  WP_URL=''
  if printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$'; then
    WP_URL="/?session=$SESSION"
  fi
  if [ -n "$WP_TOKEN" ] && command -v jq >/dev/null 2>&1; then
    WP_PAYLOAD="$(jq -nc --arg t "$TITLE" --arg b "$BODY" --arg u "$WP_URL" --arg g "$SESSION" \
      '{title:$t, body:$b, url:$u, tag:$g}' 2>/dev/null || true)"
    if [ -n "$WP_PAYLOAD" ]; then
      SENT="$(curl -s -m 3 -H "x-deck-token: $WP_TOKEN" -H 'Content-Type: application/json' \
        -d "$WP_PAYLOAD" "http://127.0.0.1:${WP_PORT}/api/push/send" 2>/dev/null \
        | jq -r '.sent // 0' 2>/dev/null || echo 0)"
      case "$SENT" in ''|*[!0-9]*) SENT=0 ;; esac
      [ "$SENT" -ge 1 ] && exit 0 # entregada a la PWA: ntfy sobra
    fi
  fi
fi

# Click → PWA con la sesión ya seleccionada (init lee ?session=). Solo con
# nombres que el server acepta (mismo SESSION_RE) — así no hace falta encodear.
ARGS=(-s -m 5 -H "Title: $TITLE" -H "Tags: robot" -d "$BODY")
LINK_OK=0
if [ -n "${DECK_URL:-}" ] && printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$'; then
  ARGS+=(-H "Click: ${DECK_URL%/}/?session=$SESSION")
  LINK_OK=1
fi

# Botones Permitir/Denegar (tarea 2): solo para prompts de permiso. Se pide un
# nonce al server LOCAL (auth normal con el AUTH_TOKEN, jamás a ntfy); si sale,
# se arman dos acciones http que el celu dispara contra /api/approve (exento de
# auth: el nonce es la credencial). Sin DECK_URL / sin server / nonce fallido →
# se degrada al push plano de la tarea 1 (sin botones). El AUTH_TOKEN NO aparece
# en ninguna cabecera, URL ni cuerpo que toque ntfy.
if [ "$IS_PERMISSION" = 1 ] && [ "$LINK_OK" = 1 ]; then
  TOKEN="$(env_get AUTH_TOKEN)"
  PORT="${DECK_PORT:-$(env_get DECK_PORT)}"; PORT="${PORT:-7433}"
  if [ -n "$TOKEN" ] && [ -n "$SESSION" ]; then
    NONCE="$(curl -s -m 2 -H "x-deck-token: $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"session\":\"$SESSION\"}" \
      "http://127.0.0.1:${PORT}/api/approve-nonce" 2>/dev/null \
      | jq -r '.nonce // empty' 2>/dev/null || true)"
    if [ -n "$NONCE" ]; then
      BASE="${DECK_URL%/}/api/approve?nonce=$NONCE"
      # ntfy capea en 3 acciones: Permitir, Denegar y ver (deep-link).
      ARGS+=(-H "Actions: http, Permitir, ${BASE}&answer=allow, method=POST, clear=true; http, Denegar, ${BASE}&answer=deny, method=POST, clear=true; view, Abrir app, ${DECK_URL%/}/?session=$SESSION")
    fi
  fi
fi

curl "${ARGS[@]}" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true

exit 0

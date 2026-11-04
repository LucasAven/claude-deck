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
EVENT=''
TRANSCRIPT=''
# Arranque del hook menos 2 s (margen por si el stop_hook_summary se escribe en
# el mismo instante): ver stop_settled
START="$(date -u -v-2S +%Y-%m-%dT%H:%M:%S)"

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
      # AskUserQuestion pasa por la misma tarjeta de permiso: el cuerpo es la
      # primera pregunta, no "Permiso para usar AskUserQuestion"
      QUESTION="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.questions[0].question // empty' 2>/dev/null || true)"
      if [ -n "$QUESTION" ]; then
        BODY="Pregunta: ${QUESTION:0:300}"
      elif [ -n "$TOOL" ]; then
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
      # Ruido (2026-11-04): idle_prompt ("Claude is waiting for your input")
      # llega ~1 min después de un Stop que ya avisó, sin nada que contestar.
      # Los demás tipos que no piden nada (login, agentes, computer use) tampoco
      # avisan. Los tipos nuevos o desconocidos SÍ avisan (falla abierto).
      case "$NTYPE" in
        idle_prompt | auth_success | agent_completed | computer_use_enter | computer_use_exit) exit 0 ;;
      esac
      if [ "$NTYPE" = "permission_prompt" ] && [ -n "$SID" ] && [ -f "$MARK_DIR/permreq-$SID" ]; then
        NOW="$(date +%s)"
        MTIME="$(stat -f %m "$MARK_DIR/permreq-$SID" 2>/dev/null || echo 0)"
        [ $((NOW - MTIME)) -lt 30 ] && exit 0 # ya salió el push rico
      fi
      MSG="$(printf '%s' "$PAYLOAD" | jq -r '.message // empty' 2>/dev/null || true)"
      [ -n "$MSG" ] && BODY="${MSG:0:300}"
      ;;
    Stop)
      # Pausa, no fin (2026-11-04): con subagentes en background el turno
      # corta para esperarlos y cada resultado despierta otro turno + Stop.
      # Solo avisa el Stop sin agentes en vuelo. Shells y monitors no cuentan:
      # un dev server en background silenciaría la sesión para siempre.
      AGENTS="$(printf '%s' "$PAYLOAD" | jq -r '[.background_tasks[]? | select(.type != "shell" and .type != "monitor")] | length' 2>/dev/null || echo 0)"
      [ "${AGENTS:-0}" -gt 0 ] 2>/dev/null && exit 0
      # Lo mismo con un wakeup de una sola vez (ScheduleWakeup, /loop): vuelve
      # solo. Un cron recurrente sí avisa: si no, silenciaría la sesión para
      # siempre.
      WAKEUPS="$(printf '%s' "$PAYLOAD" | jq -r '[.session_crons[]? | select(.recurring != true)] | length' 2>/dev/null || echo 0)"
      [ "${WAKEUPS:-0}" -gt 0 ] 2>/dev/null && exit 0
      BODY="${1:-Claude terminó la tarea}"
      SNIPPET="$(printf '%s' "$PAYLOAD" | jq -r '.last_assistant_message // empty' 2>/dev/null | tr '\n' ' ' | cut -c1-160)"
      [ -n "$SNIPPET" ] && BODY="Terminó: $SNIPPET"
      TRANSCRIPT="$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null || true)"
      ;;
    StopFailure)
      # El turno cortó por un error de la API (rate limit, auth, overload…):
      # no hay Stop, así que sin este push la sesión queda muda.
      ERR="$(printf '%s' "$PAYLOAD" | jq -r '[.error, .error_details] | map(select(. != null and . != "") | tostring) | join(": ")' 2>/dev/null || true)"
      BODY="Error: ${ERR:-el turno terminó con un error}"
      BODY="${BODY:0:300}"
      ;;
  esac
fi

# Stop bloqueado (2026-11-04): otro hook de Stop (p. ej. check-comments.sh en
# st-direct) puede bloquear el corte y Claude sigue trabajando, pero este hook
# ya arrancó en paralelo. El único registro de qué pasó es el
# stop_hook_summary que Claude Code escribe en el transcript cuando terminan
# los hooks síncronos: hookErrors no vacío = algún hook bloqueó. Se espera a
# ese registro (hasta 90 s) y si no aparece, avisa igual (falla abierto).
stop_settled() {
  local start="$1" n summary
  [ -f "$TRANSCRIPT" ] || return 0
  for n in $(seq 1 90); do
    sleep 1
    summary="$(tail -n 40 "$TRANSCRIPT" 2>/dev/null | jq -R -r --arg s "$start" \
      'fromjson? | select(.type == "system" and .subtype == "stop_hook_summary" and .timestamp >= $s) | (.hookErrors // []) | length' 2>/dev/null | tail -n1)"
    [ -n "$summary" ] && { [ "$summary" = 0 ]; return; }
  done
  return 0
}

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

# Web Push (tareas 23/26): única vía, para TODOS los eventos — permiso, Stop e
# error. URL del click RELATIVA (path only): el service worker la resuelve contra
# su propio scope (self.registration.scope), así el tap cae en el origen desde
# el que se instaló la PWA — que puede NO ser el de DECK_URL (rama en otro
# puerto vía tailscale serve). Mandar una URL absoluta acá rompía el enrutado a
# la app en iOS. Solo con nombres de sesión que el server acepta (SESSION_RE) —
# así no hace falta encodear. El AUTH_TOKEN viaja SOLO a 127.0.0.1.
send_push() {
  phone_present && return 0
  local url='/' payload
  if printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$'; then
    url="/?session=$SESSION"
  fi
  payload="$(jq -nc --arg t "$TITLE" --arg b "$BODY" --arg u "$url" --arg g "$SESSION" \
    '{title:$t, body:$b, url:$u, tag:$g}' 2>/dev/null || true)"
  [ -n "$payload" ] && curl -s -m 3 -H "x-deck-token: $AUTH_TOKEN" -H 'Content-Type: application/json' \
    -d "$payload" "http://127.0.0.1:${DECK_PORT}/api/push/send" >/dev/null 2>&1 || true
}

# Stop espera al stop_hook_summary en un proceso suelto (fds cerrados): así no
# frena el corte del turno aunque el hook esté registrado sin "async".
if [ "$EVENT" = Stop ]; then
  (stop_settled "$START" && send_push) </dev/null >/dev/null 2>&1 &
else
  send_push
fi

exit 0

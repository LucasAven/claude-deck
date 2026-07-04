#!/usr/bin/env bash
# Escribe el estado del Claude de esta sesión tmux para el semáforo de chips
# (tarea 4): un archivo por sesión en ~/.claude-deck/state/<sesión> cuyo
# contenido es el estado y cuyo mtime es el ts. El server lo mezcla en
# GET /api/tmux/sessions; un archivo por sesión evita locks entre hooks
# concurrentes de distintas sesiones.
#
# Uso desde los hooks globales (el estado viene por argv, no hace falta jq):
#   UserPromptSubmit / PreToolUse      → state.sh working
#   Notification / PermissionRequest  → state.sh waiting
#   Stop                               → state.sh idle
set -u

# Mismo guard que notify.sh: fuera de tmux no hay chip que actualizar.
[ -z "${TMUX:-}" ] && exit 0

STATE="${1:-}"
case "$STATE" in working|waiting|idle) ;; *) exit 0 ;; esac

# Sesión propia del cliente ($TMUX seteado, sin -t). Solo nombres que pasan
# el SESSION_RE del server: son filename-safe y son los únicos que la UI lista.
SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$' || exit 0

DIR="$HOME/.claude-deck/state"
mkdir -p "$DIR" 2>/dev/null || exit 0

# Escritura atómica (tmp + mv): un lector nunca ve un archivo a medias.
TMP="$DIR/.tmp-$SESSION-$$"
if printf '%s' "$STATE" > "$TMP" 2>/dev/null; then
  mv -f "$TMP" "$DIR/$SESSION" 2>/dev/null || rm -f "$TMP" 2>/dev/null
fi

# Transcript de la sesión (tarea 9, overlay 📜): el JSON del hook trae
# transcript_path — anotarlo en <sesión>.transcript resuelve el matching
# sesión tmux ↔ .jsonl sin adivinar por mtime (y sobrevive a varios claude
# en el mismo repo). Sin jq (misma decisión que el estado): sed sobre el
# primer tramo del stdin. Si no hay stdin (corrida manual) no se toca nada.
if [ ! -t 0 ]; then
  TRANSCRIPT="$(head -c 200000 2>/dev/null | sed -n 's/.*"transcript_path":"\([^"]*\)".*/\1/p' | head -n 1)"
  case "$TRANSCRIPT" in
    /*.jsonl)
      TMPT="$DIR/.tmpt-$SESSION-$$"
      if printf '%s' "$TRANSCRIPT" > "$TMPT" 2>/dev/null; then
        mv -f "$TMPT" "$DIR/$SESSION.transcript" 2>/dev/null || rm -f "$TMPT" 2>/dev/null
      fi
      ;;
  esac
fi

# Limpieza oportunista de registros de sesiones muertas hace rato (el server
# ya ignora archivos de sesiones que no existen; esto solo evita acumular).
find "$DIR" -type f -mmin +1440 -delete 2>/dev/null || true

exit 0

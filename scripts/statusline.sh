#!/usr/bin/env bash
# Statusline en la PWA (tarea 22): persiste el estado de contexto/tokens/costo
# del Claude de esta sesión tmux para que el panel lo muestre como el statusLine
# de Claude Code. Mismo patrón que scripts/state.sh: un archivo por sesión en
# ~/.claude-deck/state/<sesión>.status.json (escritura atómica tmp+mv), guard
# $TMUX. El server lo mezcla en GET /api/claude/status?session=.
#
# Se registra como el hook `statusLine` de los perfiles globales. A diferencia
# de state.sh esto NO recibe el estado por argv: Claude Code manda por stdin un
# JSON con model/context_window/cost (formato real documentado abajo). Y como el
# statusLine ADEMÁS pinta la línea de estado de la terminal, este script hace de
# passthrough: escribe el JSON del panel y después delega el render a la línea
# preexistente del usuario (DECK_STATUSLINE_CHAIN, default
# ~/.claude/statusline-command.sh) para no pisársela.
#
# Formato REAL del stdin (probe contra un claude vivo, Haiku 4.5, v2.1.202,
# Darwin 25, 2026-07-07 — NO se asumió ningún campo):
#   {
#     "session_id","transcript_path","cwd","prompt_id","session_name","version",
#     "model": { "id", "display_name" },
#     "workspace": { "current_dir","project_dir","added_dirs" },
#     "output_style": { "name" },
#     "cost": { "total_cost_usd","total_duration_ms","total_api_duration_ms",
#               "total_lines_added","total_lines_removed" },
#     "context_window": {
#       "total_input_tokens","total_output_tokens","context_window_size",
#       "current_usage": { input/output/cache_creation/cache_read } | null,
#       "used_percentage" | null, "remaining_percentage" | null
#     },
#     "exceeds_200k_tokens","fast_mode","thinking":{enabled},
#     "rate_limits": { "five_hour":{used_percentage,resets_at}, "seven_day":{...} }
#   }
# Antes del primer turno: current_usage/used_percentage/remaining_percentage son
# null (context_window_size y total_*_tokens ya vienen, en 0) — el UI lo maneja.
set -u

# Leer el stdin UNA vez (se reusa para el JSON del panel y para el chain).
input=$(cat)

# Guard $TMUX + nombre de sesión filename-safe (idéntico a state.sh): fuera de
# tmux no hay sesión en el panel que actualizar, pero igual hay que renderizar.
render_chain() {
  local chain="${DECK_STATUSLINE_CHAIN:-$HOME/.claude/statusline-command.sh}"
  if [ -f "$chain" ]; then
    printf '%s' "$input" | bash "$chain"
  else
    # Fallback mínimo autocontenido si no hay línea previa del usuario.
    printf '%s' "$input" | jq -r '
      (.workspace.current_dir // .cwd // "" | split("/") | last) as $dir
      | (.context_window.remaining_percentage) as $rem
      | (.model.display_name // "") as $m
      | "\($dir)\(if $rem != null then "  ctx:\($rem|floor)%" else "" end)\(if $m != "" then "  [\($m)]" else "" end)"
    ' 2>/dev/null || printf '\n'
  fi
}

if [ -n "${TMUX:-}" ] && command -v jq >/dev/null 2>&1; then
  SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
  if printf '%s' "$SESSION" | grep -qE '^[A-Za-z0-9_-]{1,32}$'; then
    DIR="$HOME/.claude-deck/state"
    if mkdir -p "$DIR" 2>/dev/null; then
      # Extraer SOLO los campos que el panel usa (no filtrar cwd/transcript_path
      # al archivo del panel; el server igual solo sirve estos). used_percentage
      # y demás pueden ser null → pasan como null, el UI decide.
      STATUS="$(printf '%s' "$input" | jq -c '{
        model: (.model.display_name // null),
        modelId: (.model.id // null),
        ctxPct: (.context_window.used_percentage),
        ctxSize: (.context_window.context_window_size // null),
        inputTokens: (.context_window.total_input_tokens // null),
        outputTokens: (.context_window.total_output_tokens // null),
        costUsd: (.cost.total_cost_usd // null),
        exceeds200k: (.exceeds_200k_tokens // false)
      }' 2>/dev/null)"
      if [ -n "$STATUS" ]; then
        TMP="$DIR/.tmps-$SESSION-$$"
        if printf '%s' "$STATUS" > "$TMP" 2>/dev/null; then
          mv -f "$TMP" "$DIR/$SESSION.status.json" 2>/dev/null || rm -f "$TMP" 2>/dev/null
        fi
      fi
    fi
  fi
fi

render_chain
exit 0

import type { Terminal } from '@xterm/xterm'
import { useDeckStore } from '../store'

// Modo de permisos de Claude para el chip de la statusline. No hay fuente dura:
// el JSON del hook statusLine no trae el modo (verificado en v2.1.308) y
// shift+tab no dispara hooks. Lo que sí hay es el footer que Claude pinta
// debajo del prompt ("⏵⏵ auto mode on (shift+tab to cycle)"), así que se lee
// del buffer de xterm tras cada write.
//
// El default se pinta como "⏸ manual mode on" (v2.1.308), pero los diálogos
// de permisos tapan el footer, así que "sin texto de modo" no dice nada: se
// conserva el último visto (Lucas 2026-10-28). Arranca en null ("mode") y
// vuelve a null al cambiar de sesión.

// Palabra corta + color del tema dark de Claude (pa/indicator en el binario:
// planMode, autoAccept, warning, error; manual sin tinte). El indicador del
// footer es "<indicator> on".
export const MODES = {
  default: { indicator: 'manual mode', word: 'manual', color: 'var(--text)' },
  plan: { indicator: 'plan mode', word: 'plan', color: '#48968c' },
  acceptEdits: { indicator: 'accept edits', word: 'edits', color: '#af87ff' },
  auto: { indicator: 'auto mode', word: 'auto', color: '#ffc107' },
  bypassPermissions: { indicator: 'bypass permissions', word: 'bypass', color: '#ff6b80' },
  dontAsk: { indicator: "don't ask", word: "don't ask", color: '#ff6b80' },
} as const

export type ClaudeMode = keyof typeof MODES

// el símbolo (⏸ manual/plan, ⏵⏵ el resto) ancla el match al footer y no a texto del
// transcript que justo mencione "auto mode on"
const FOOTER_RE = /[⏸⏵]+\s*(manual mode|plan mode|accept edits|bypass permissions|don't ask|auto mode) on\b/
const BY_INDICATOR = new Map(
  (Object.keys(MODES) as ClaudeMode[]).map((m) => [MODES[m].indicator as string, m]),
)

// el footer es lo último que Claude pinta (debajo puede estar la barra de
// tmux), pero no siempre al fondo de la pantalla: con poco output queda arriba
// y debajo hay filas vacías. Se miran las últimas filas NO vacías del screen
// (no el scrollback), así un transcript que mencione el modo más arriba no
// cuenta.
const FOOTER_ROWS = 5

function readMode(term: Terminal): ClaudeMode | null {
  const buf = term.buffer.active
  let seen = 0
  for (let y = buf.baseY + term.rows - 1; y >= buf.baseY && seen < FOOTER_ROWS; y--) {
    const text = buf.getLine(y)?.translateToString(true) ?? ''
    if (!text.trim()) continue
    seen++
    const m = FOOTER_RE.exec(text)
    if (m) return BY_INDICATOR.get(m[1]) ?? null
  }
  return null
}

// un escaneo por frame como mucho: Claude escribe en ráfagas (spinner, stream)
export function watchMode(term: Terminal) {
  let queued = false
  term.onWriteParsed(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const mode = readMode(term)
      if (mode && mode !== useDeckStore.getState().claudeMode) useDeckStore.setState({ claudeMode: mode })
    })
  })
}

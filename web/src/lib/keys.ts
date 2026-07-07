// Constantes portadas de public/app.js — secuencias de teclado, catálogos de
// modelo/esfuerzo y la regex de nombre de sesión. Nada de lógica: solo datos que
// varias piezas comparten.

// Secuencias que mandan las quickkeys (app.js:301-311; catálogo ampliado en la
// tarea 11b — los ctrl+X son el control char crudo, las flechas secuencias CSI).
export const KEYS: Record<string, string> = {
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  tab: '\t',
  ctrlc: '\x03',
  slash: '/',
  // salto de línea SIN enviar el prompt: Claude Code trata ESC+CR (alt+enter)
  // como newline suave — verificado contra claude real dentro de tmux
  nl: '\x1b\r',
  ctrlr: '\x12',
  ctrld: '\x04',
  ctrlz: '\x1a',
  // inicio/fin de línea van como ctrl+a/ctrl+e (readline) y no como Home/End:
  // las secuencias de Home/End dependen del modo del terminal, ^A/^E no
  ctrla: '\x01',
  ctrle: '\x05',
  ctrll: '\x0c',
  ctrlu: '\x15',
}

// Catálogo de quickkeys disponibles para la barra (tarea 11b): label = lo que
// muestra el botón, title = tooltip/descripción en el editor. El orden de acá
// es el del catálogo en el sheet; el de la BARRA sale de deck-quickkeys.
export const QUICKKEY_CATALOG: { id: string; label: string; title: string }[] = [
  { id: 'nl', label: '\\n', title: 'Salto de línea (sin enviar)' },
  { id: 'slash', label: '/', title: 'Comando slash' },
  { id: 'esc', label: 'esc', title: 'Escape' },
  { id: 'up', label: '↑', title: 'Flecha arriba' },
  { id: 'down', label: '↓', title: 'Flecha abajo' },
  { id: 'left', label: '←', title: 'Flecha izquierda' },
  { id: 'right', label: '→', title: 'Flecha derecha' },
  { id: 'tab', label: 'tab', title: 'Tab' },
  { id: 'ctrlc', label: 'ctrl+c', title: 'Interrumpir' },
  { id: 'ctrlr', label: 'ctrl+r', title: 'Buscar en el historial' },
  { id: 'ctrld', label: 'ctrl+d', title: 'EOF / cerrar' },
  { id: 'ctrlz', label: 'ctrl+z', title: 'Suspender proceso' },
  { id: 'ctrla', label: 'ctrl+a', title: 'Inicio de línea' },
  { id: 'ctrle', label: 'ctrl+e', title: 'Fin de línea' },
  { id: 'ctrll', label: 'ctrl+l', title: 'Limpiar pantalla' },
  { id: 'ctrlu', label: 'ctrl+u', title: 'Borrar la línea' },
]

// barra por defecto = la histórica (nl primero, pedido del usuario — ui-test
// asserta este orden con la config default)
export const DEFAULT_QUICKKEYS = ['nl', 'slash', 'esc', 'up', 'down', 'tab', 'ctrlc']

export const QUICKKEYS_LS_KEY = 'deck-quickkeys'

// lector puro (sin store, para poder usarlo en el init del store sin ciclos):
// valida contra el catálogo y dedupea; cualquier cosa rara → default
export function loadQuickkeys(): string[] {
  try {
    const raw = localStorage.getItem(QUICKKEYS_LS_KEY)
    if (!raw) return DEFAULT_QUICKKEYS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_QUICKKEYS
    const known = new Set(QUICKKEY_CATALOG.map((k) => k.id))
    const list = [...new Set(parsed.filter((id) => typeof id === 'string' && known.has(id)))] as string[]
    return list.length ? list : DEFAULT_QUICKKEYS
  } catch {
    return DEFAULT_QUICKKEYS
  }
}

// Catálogos del switcher de modelo/esfuerzo (app.js:348-359).
export const MODELS = [
  { id: 'fable', label: 'Fable 5' },
  { id: 'opus', label: 'Opus 4.8' },
  { id: 'sonnet', label: 'Sonnet 5' },
  { id: 'haiku', label: 'Haiku 4.5' },
] as const

export const EFFORTS = [
  { id: 'low', label: 'Bajo' },
  { id: 'medium', label: 'Medio' },
  { id: 'high', label: 'Alto' },
  { id: 'max', label: 'Máx' },
] as const

// igual que SESSION_RE del server (app.js:1555)
export const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

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
  // Enter crudo (CR): envia el prompt / acepta los prompts de Claude Code dentro
  // de tmux. A diferencia de nl (ESC+CR, salto suave), este SI confirma.
  // Verificado contra claude real en sesion scratch, igual que se hizo con nl.
  enter: '\r',
  ctrlr: '\x12',
  ctrld: '\x04',
  ctrlz: '\x1a',
  // inicio/fin de línea van como ctrl+a/ctrl+e (readline) y no como Home/End:
  // las secuencias de Home/End dependen del modo del terminal, ^A/^E no
  ctrla: '\x01',
  ctrle: '\x05',
  ctrll: '\x0c',
  ctrlu: '\x15',
  // Ctrl+End = scroll:bottom de Claude Code (salta al ultimo mensaje y reactiva
  // el auto-follow). Secuencia xterm modifyOtherKeys (CSI 1;5F). Verificada
  // contra un claude real: scrolleado arriba con PageUp, esta lo trajo de vuelta
  // al final de la conversacion.
  ctrlend: '\x1b[1;5F',
}

// Catálogo de quickkeys disponibles para la barra (tarea 11b): label = lo que
// muestra el botón, title = tooltip/descripción en el editor. El orden de acá
// es el del catálogo en el sheet; el de la BARRA sale de deck-quickkeys.
// barLabel (rediseño): forma compacta para la barra (^C en vez de ctrl+c) —
// las teclas ya no scrollean y el ancho se reparte, así que cada label debe
// entrar en ~44px; el editor sigue mostrando el label largo.
export const QUICKKEY_CATALOG: { id: string; label: string; title: string; barLabel?: string }[] = [
  { id: 'nl', label: '\\n', title: 'Salto de línea (sin enviar)' },
  { id: 'enter', label: '⏎', title: 'Enviar / aceptar (Enter)' },
  { id: 'slash', label: '/', title: 'Comando slash' },
  { id: 'esc', label: 'esc', title: 'Escape' },
  { id: 'up', label: '↑', title: 'Flecha arriba' },
  { id: 'down', label: '↓', title: 'Flecha abajo' },
  { id: 'left', label: '←', title: 'Flecha izquierda' },
  { id: 'right', label: '→', title: 'Flecha derecha' },
  { id: 'tab', label: 'tab', title: 'Tab' },
  { id: 'ctrlc', label: 'ctrl+c', barLabel: '^C', title: 'Interrumpir' },
  { id: 'ctrlr', label: 'ctrl+r', barLabel: '^R', title: 'Buscar en el historial' },
  { id: 'ctrld', label: 'ctrl+d', barLabel: '^D', title: 'EOF / cerrar' },
  { id: 'ctrlz', label: 'ctrl+z', barLabel: '^Z', title: 'Suspender proceso' },
  { id: 'ctrla', label: 'ctrl+a', barLabel: '^A', title: 'Inicio de línea' },
  { id: 'ctrle', label: 'ctrl+e', barLabel: '^E', title: 'Fin de línea' },
  { id: 'ctrll', label: 'ctrl+l', barLabel: '^L', title: 'Limpiar pantalla' },
  { id: 'ctrlu', label: 'ctrl+u', barLabel: '^U', title: 'Borrar la línea' },
  { id: 'ctrlend', label: 'ctrl+end', barLabel: '^End', title: 'Ir al final de la conversación (scroll)' },
]

// barra por defecto = la histórica (nl primero, pedido del usuario — ui-test
// asserta este orden con la config default)
// (tarea 29) enter va segundo, junto a nl: nl hace salto sin enviar, enter
// envia/acepta. Son 8 teclas: a 390px se reparten sin scroll; en pantallas mas
// angostas (iPhone SE) el overflow-x de .quickkeys entra como rescate.
export const DEFAULT_QUICKKEYS = ['nl', 'enter', 'slash', 'esc', 'up', 'down', 'tab', 'ctrlc']

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

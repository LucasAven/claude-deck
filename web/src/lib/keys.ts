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
  // shift+tab (CSI Z): cicla el modo de Claude Code. Lo manda el chip de modo
  // (lib/switch.cycleMode) y también es una quickkey del catálogo.
  shifttab: '\x1b[Z',
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

// Catálogo de quickkeys disponibles para el riel de la toolbox (tarea 11b):
// label = la forma compacta, una sola, que pintan tanto el botón del riel como
// el editor (^C, ^End); desc = descripción corta que el editor lista al lado
// del label y que además va como title del botón. El orden de acá es el del
// catálogo en el sheet; el del RIEL sale de deck-quickkeys.
// Las flechas y enter salieron del catálogo: viven en el d-pad (sus secuencias
// siguen en KEYS para eso). Migración, sin código aparte: loadQuickkeys filtra
// contra este catálogo y respeta el orden del resto, así que una config vieja
// ["up","nl","down","esc","enter","tab"] carga como ["nl","esc","tab"].
export const QUICKKEY_CATALOG: { id: string; label: string; desc: string }[] = [
  { id: 'nl', label: '\\n', desc: 'Nueva línea sin enviar' },
  { id: 'slash', label: '/', desc: 'Comandos' },
  { id: 'esc', label: 'esc', desc: 'Cancelar / salir' },
  { id: 'tab', label: 'tab', desc: 'Autocompletar' },
  { id: 'ctrlc', label: '^C', desc: 'Interrumpir' },
  { id: 'ctrlr', label: '^R', desc: 'Buscar historial' },
  { id: 'ctrld', label: '^D', desc: 'Cerrar / EOF' },
  { id: 'ctrlz', label: '^Z', desc: 'Suspender' },
  { id: 'ctrla', label: '^A', desc: 'Inicio de línea' },
  { id: 'ctrle', label: '^E', desc: 'Fin de línea' },
  { id: 'ctrll', label: '^L', desc: 'Limpiar pantalla' },
  { id: 'ctrlu', label: '^U', desc: 'Borrar línea' },
  { id: 'shifttab', label: '⇧tab', desc: 'Cambiar modo' },
  { id: 'ctrlend', label: '^End', desc: 'Ir al final' },
]

// riel por defecto = el histórico sin flechas ni enter (nl primero, pedido del
// usuario; ui-test asserta este orden con la config default)
export const DEFAULT_QUICKKEYS = ['nl', 'slash', 'esc', 'tab', 'ctrlc']

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

// ---------- config del d-pad ----------
// Las dos esquinas de ABAJO del d-pad toman una tecla del catálogo, o quedan
// vacías; las de arriba son fijas (cámara y pegar).
// TODO(d-pad): ni el d-pad flotante ni el d-pad fijo en la toolbox existen
// todavía. Hoy el único d-pad es el popover 3x3 y `style` solo se guarda;
// cuando se implementen, los dos lo leen de acá.
export type DpadStyle = 'floating' | 'fixed'
export type DpadConfig = { corners: { bl: string | null; br: string | null }; style: DpadStyle }

export const DEFAULT_DPAD: DpadConfig = { corners: { bl: null, br: null }, style: 'floating' }

export const DPAD_LS_KEY = 'deck-dpad'

// lector puro, igual que loadQuickkeys: esquina con un id que no esté en el
// catálogo → vacía, estilo raro → flotante, cualquier cosa rota → DEFAULT_DPAD
export function loadDpad(): DpadConfig {
  try {
    const raw = localStorage.getItem(DPAD_LS_KEY)
    if (!raw) return DEFAULT_DPAD
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_DPAD
    const cfg = parsed as { corners?: unknown; style?: unknown }
    const corners = (cfg.corners && typeof cfg.corners === 'object' ? cfg.corners : {}) as Record<string, unknown>
    const known = new Set(QUICKKEY_CATALOG.map((k) => k.id))
    const corner = (v: unknown) => (typeof v === 'string' && known.has(v) ? v : null)
    return {
      corners: { bl: corner(corners.bl), br: corner(corners.br) },
      style: cfg.style === 'fixed' ? 'fixed' : 'floating',
    }
  } catch {
    return DEFAULT_DPAD
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

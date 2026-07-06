// Constantes portadas de public/app.js — secuencias de teclado, catálogos de
// modelo/esfuerzo y la regex de nombre de sesión. Nada de lógica: solo datos que
// varias piezas comparten.

// Secuencias que mandan las quickkeys (app.js:301-311).
export const KEYS: Record<string, string> = {
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  ctrlc: '\x03',
  slash: '/',
  // salto de línea SIN enviar el prompt: Claude Code trata ESC+CR (alt+enter)
  // como newline suave — verificado contra claude real dentro de tmux
  nl: '\x1b\r',
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

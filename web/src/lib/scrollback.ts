import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useDeckStore, sessionQuery, type SbTurn } from '../store'
import { api } from './api'

// Scrollback legible (app.js:1088-1231): overlay fullscreen de solo lectura.
// Fuente primaria: el transcript .jsonl de la sesión como turnos (asistente
// renderizado como markdown sanitizado, user/tool como texto plano); fallback
// para shells: capture-pane como texto plano. HTML plano: scroll, selección,
// copy y find-in-page nativos (nada de eso existe en el canvas de xterm).

const SB_STEP = 500 //                  modo pane: líneas por fetch
const SB_MAX = 5000 //                  modo pane: techo (= el del server)
const SB_BYTES_STEP = 2 * 1024 * 1024 // modo transcript: cola inicial
const SB_BYTES_MAX = 32 * 1024 * 1024 // modo transcript: techo (= el del server)
const SB_FONT_KEY = 'deck-sb-font'
const SB_FONT_DEFAULT = 13

let sbMode: 'turns' | 'text' = 'text' // 'turns' (transcript) | 'text' (capture-pane)
let sbLines = 0 //     modo pane: líneas pedidas en el fetch vigente
let sbBytes = 0 //     modo transcript: bytes pedidos en el fetch vigente
let sbTurnCount = 0 // modo transcript: para detectar re-fetch sin crecimiento

// ancla de lectura: el lib captura scrollHeight/scrollTop del body ANTES del
// setState que pinta contenido nuevo (el DOM todavía muestra lo viejo, la
// lectura sincrónica es válida) y el componente la restaura en useLayoutEffect
// —con effects normales la restauración llega tarde y la vista salta (§5.6).
export interface SbAnchor {
  prevH: number
  prevTop: number
  keepAnchor: boolean // true → compensar (cargar más mete arriba); false → al fondo
}
let pendingAnchor: SbAnchor | null = null

export function takeScrollbackAnchor(): SbAnchor | null {
  const a = pendingAnchor
  pendingAnchor = null
  return a
}

// captura el ancla del body vivo justo antes de repintar
function captureAnchor(keepAnchor: boolean) {
  const body = document.getElementById('scrollback-body')
  pendingAnchor = body
    ? { prevH: body.scrollHeight, prevTop: body.scrollTop, keepAnchor }
    : { prevH: 0, prevTop: 0, keepAnchor }
}

function bumpNonce() {
  const sb = useDeckStore.getState().scrollback
  return sb.renderNonce + 1
}

// aplica el tamaño persistido (+delta opcional, clampeado) → --sb-font
export function sbApplyFont(delta: number) {
  let px = SB_FONT_DEFAULT
  try {
    px = parseInt(localStorage.getItem(SB_FONT_KEY) || '', 10) || SB_FONT_DEFAULT
  } catch {
    /* ignore */
  }
  px = Math.min(Math.max(px + (delta || 0), 10), 20)
  try {
    localStorage.setItem(SB_FONT_KEY, String(px))
  } catch {
    /* ignore */
  }
  useDeckStore.setState({ scrollback: { ...useDeckStore.getState().scrollback, font: px } })
}

// modo transcript: turnos legibles del jsonl (404/vacío → el caller cae a sbFetch)
async function sbFetchTranscript(bytes: number, keepAnchor: boolean): Promise<boolean> {
  let data: { turns?: unknown; more?: boolean }
  try {
    const res = await api(`/api/claude/transcript?${sessionQuery(useDeckStore.getState().session)}&bytes=${bytes}`)
    if (!res.ok) return false
    data = await res.json()
  } catch {
    return false
  }
  const rawTurns = data.turns
  if (!Array.isArray(rawTurns) || !rawTurns.length) return false // recién nacida: mejor el pane

  const turns: SbTurn[] = rawTurns.map((t: { role?: string; text?: string }) => {
    const role: SbTurn['role'] = t.role === 'user' || t.role === 'tool' ? t.role : 'assistant'
    const text = t.text ?? ''
    // el texto del asistente es markdown: renderizarlo (misma dupla marked +
    // DOMPurify que la vista de archivos .md; sanitizado obligatorio, el
    // transcript es input no confiable). User y tool quedan como texto plano:
    // los prompts suelen traer paths/código literal que el md manglaría.
    let html: string | null = null
    if (role === 'assistant') {
      try {
        html = DOMPurify.sanitize(marked.parse(text, { breaks: true }) as string)
      } catch {
        html = null
      }
    }
    return { role, html, text }
  })

  // ocultar "cargar más" al llegar al techo o si un re-fetch no creció (techo
  // de turnos del server: más bytes ya no agregan nada visible)
  const grew = turns.length > sbTurnCount
  const moreVisible = !(!data.more || bytes >= SB_BYTES_MAX || (keepAnchor && !grew))
  sbTurnCount = turns.length
  sbBytes = bytes
  sbMode = 'turns'

  captureAnchor(keepAnchor)
  useDeckStore.setState({
    scrollback: {
      ...useDeckStore.getState().scrollback,
      mode: 'turns',
      srcLabel: '· transcript',
      turns,
      text: '',
      moreVisible,
      renderNonce: bumpNonce(),
    },
  })
  return true
}

// modo pane (fallback shells): capture-pane como texto plano
async function sbFetch(lines: number, keepAnchor: boolean) {
  let text: string
  try {
    const res = await api(`/api/tmux/scrollback?${sessionQuery(useDeckStore.getState().session)}&lines=${lines}`)
    if (!res.ok) throw new Error(String(res.status))
    text = await res.text()
  } catch {
    sbMode = 'text'
    useDeckStore.setState({
      scrollback: {
        ...useDeckStore.getState().scrollback,
        mode: 'text',
        turns: [],
        text: 'No se pudo leer el scrollback de la sesión.',
        moreVisible: false,
        renderNonce: bumpNonce(),
      },
    })
    return
  }
  sbLines = lines
  sbMode = 'text'
  // "Cargar más" solo si tmux devolvió al menos lo pedido: si vino menos, la
  // historia se acabó (heurística: la captura incluye el viewport además de
  // las -S líneas, así que puede sobrar un tap no-op — aceptable)
  const got = text.split('\n').length
  const moreVisible = !(got < lines || lines >= SB_MAX)

  captureAnchor(keepAnchor)
  useDeckStore.setState({
    scrollback: {
      ...useDeckStore.getState().scrollback,
      mode: 'text',
      srcLabel: '· pane',
      turns: [],
      text,
      moreVisible,
      renderNonce: bumpNonce(),
    },
  })
}

export async function sbLoadMore() {
  if (sbMode === 'turns') await sbFetchTranscript(Math.min(sbBytes * 2, SB_BYTES_MAX), true)
  else await sbFetch(Math.min(sbLines + SB_STEP, SB_MAX), true)
}

export async function openScrollback() {
  const s = useDeckStore.getState()
  sbTurnCount = 0
  sbMode = 'text'
  // reset a "Cargando…" y aplicar el font persistido
  let px = SB_FONT_DEFAULT
  try {
    px = parseInt(localStorage.getItem(SB_FONT_KEY) || '', 10) || SB_FONT_DEFAULT
  } catch {
    /* ignore */
  }
  px = Math.min(Math.max(px, 10), 20)
  useDeckStore.setState({
    scrollbackOpen: true,
    scrollback: {
      ...s.scrollback,
      session: s.session,
      mode: 'text',
      srcLabel: '',
      turns: [],
      text: 'Cargando…',
      moreVisible: false,
      font: px,
      renderNonce: s.scrollback.renderNonce + 1,
    },
  })
  if (!(await sbFetchTranscript(SB_BYTES_STEP, false))) await sbFetch(SB_STEP, false)
}

export function closeScrollback() {
  sbLines = 0
  sbBytes = 0
  sbTurnCount = 0
  // soltar el contenido grande del DOM
  useDeckStore.setState({
    scrollbackOpen: false,
    scrollback: { ...useDeckStore.getState().scrollback, turns: [], text: '' },
  })
}

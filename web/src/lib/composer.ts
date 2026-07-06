import { flushSync } from 'react-dom'
import { useDeckStore } from '../store'
import { closeSwitchMenu } from './switch'
import { hideSnipTip } from './sniptip'
import { loadSnippets, refreshSnippetsInBackground } from './snippets'

// Composer de prompts (app.js:689-781): sheet a media pantalla con <textarea>
// nativo — autocorrección, dictado del teclado iOS y cursor libre gratis. El
// textarea es NO-controlado (ref registrado por el componente): controlarlo
// re-rendería por tecla y complicaría setRangeText (§5.8). Los borradores se
// guardan por sesión en draft:<sesión> con debounce y sobreviven a que iOS mate
// la pestaña; Cancelar conserva, Enviar limpia.

const DRAFT_DEBOUNCE_MS = 500
let ta: HTMLTextAreaElement | null = null
let draftTimer: ReturnType<typeof setTimeout> | null = null

// el componente registra su <textarea> al montar (siempre montado, §5.3): así
// el botón ✎ de la controlbar puede enfocarlo sincrónicamente dentro del gesto.
export function registerComposerTextarea(el: HTMLTextAreaElement | null) {
  ta = el
}

const draftKey = (name: string | null) => `draft:${name}`

export function composerIsOpen() {
  return useDeckStore.getState().composerOpen
}

// guarda (o borra, si quedó vacío) el borrador de composerSession
export function saveDraftNow() {
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = null
  const session = useDeckStore.getState().composerSession
  if (session === null || !ta) return
  const text = ta.value
  try {
    if (text) localStorage.setItem(draftKey(session), text)
    else localStorage.removeItem(draftKey(session))
  } catch {
    /* ignore */
  }
  useDeckStore.setState({ draftSaved: !!text })
}

export function scheduleDraftSave() {
  useDeckStore.setState({ draftSaved: false }) // hay cambios sin guardar
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(saveDraftNow, DRAFT_DEBOUNCE_MS)
}

export function openComposer() {
  if (composerIsOpen()) {
    closeComposer() // el ✎ togglea
    return
  }
  closeSwitchMenu()
  const session = useDeckStore.getState().session
  let draft = ''
  try {
    draft = localStorage.getItem(draftKey(session)) || ''
  } catch {
    /* ignore */
  }
  if (ta) ta.value = draft
  // flushSync fuerza el render AHORA (saca la clase hidden sincrónicamente): sin
  // esto el setState es async y el ta?.focus() de abajo corre con el textarea
  // todavía display:none → el foco no engancha y iOS no abre el teclado (§5.3).
  flushSync(() => useDeckStore.setState({ composerOpen: true, composerSession: session, draftSaved: !!draft }))
  document.body.classList.add('composer-open')
  // focus sincrónico dentro del gesto: iOS no abre el teclado desde un timer.
  // El fit va en rAF (el sheet le comió filas a la terminal); si el teclado
  // aparece, updateViewportGeometry re-fittea de nuevo con el alto final.
  ta?.focus()
  requestAnimationFrame(() => window.claudeConn?.fit())
}

export function closeComposer() {
  if (!composerIsOpen()) return
  saveDraftNow() // Cancelar conserva el borrador; tras enviar guarda vacío → borra la key
  hideComposerSnips()
  ta?.blur() // sin esto el teclado iOS queda abierto sobre la terminal
  useDeckStore.setState({ composerOpen: false, composerSession: null })
  document.body.classList.remove('composer-open')
  requestAnimationFrame(() => window.claudeConn?.fit())
}

export function sendComposer() {
  if (!ta) return
  const text = ta.value
  if (!text.trim() || !window.claudeConn) return
  window.claudeConn.term.paste(text) // bracketed paste: el multilínea entra sin submitear
  // Enter diferido, mismo patrón que sendSlashCommand: en el mismo tick el
  // prompt se come el \r
  setTimeout(() => window.claudeConn?.sendKeys('\r'), 150)
  ta.value = '' // enviado: closeComposer guarda vacío → limpia el borrador
  closeComposer()
}

// inserta un \n literal en el cursor del textarea — NO KEYS.nl: \x1b\r es un
// concepto de terminal, acá es un textarea nativo
export function composerNewline() {
  if (!ta) return
  ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end')
  scheduleDraftSave() // setRangeText no dispara 'input'
}

// inserta texto (snippet) en el cursor del textarea, sin enviar (app.js:834-839)
export function insertIntoComposer(text: string) {
  if (!ta) return
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end')
  scheduleDraftSave()
  hideComposerSnips()
  ta.focus()
}

// --- paleta de snippets DENTRO del composer (#composer-snips) ---
export async function toggleComposerSnips() {
  if (useDeckStore.getState().composerSnipsOpen) {
    hideComposerSnips()
    return
  }
  useDeckStore.setState({ snippetsEditing: false })
  await loadSnippets()
  if (!composerIsOpen()) return // se cerró el composer durante el await
  useDeckStore.setState({ composerSnipsOpen: true })
  refreshSnippetsInBackground()
}

export function hideComposerSnips() {
  if (!useDeckStore.getState().composerSnipsOpen) return
  useDeckStore.setState({ composerSnipsOpen: false })
  hideSnipTip() // que el tooltip no sobreviva al panel
}

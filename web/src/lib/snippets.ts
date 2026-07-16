import { useDeckStore } from '../store'
import { deck, AuthError, DeckError } from './api'
import { closeSwitchMenu } from './switch'
import { composerIsOpen, insertIntoComposer } from './composer'

// Paleta de snippets (app.js:783-1076): frases de uso constante a un tap. La
// lista es GLOBAL y vive en el server (~/.claude-deck/snippets.json, GET/PUT
// /api/snippets) para que sincronice celu ↔ desktop. Tocar un chip ESCRIBE el
// texto en el prompt y NUNCA envía (bracketed paste, sin el \r diferido): hasta
// /compact entra como texto tipeado. Con el composer abierto inserta en el cursor.

// snippets vive en el store (null = todavía no se pudo cargar). loadSnippets solo
// re-fetchea si no hay cache o se fuerza (app.js:795-803).
export async function loadSnippets(force?: boolean) {
  if (useDeckStore.getState().snippets && !force) return
  try {
    const data = await deck.get<{ snippets?: unknown }>('/api/snippets')
    if (Array.isArray(data.snippets)) useDeckStore.setState({ snippets: data.snippets })
  } catch {
    /* server caído: la paleta muestra el error (snippets sigue null) */
  }
}

async function saveSnippets() {
  try {
    await deck.put('/api/snippets', { body: { snippets: useDeckStore.getState().snippets } })
  } catch (e) {
    if (e instanceof DeckError) alert(`No se pudieron guardar los snippets: ${e.message}`)
    else if (!(e instanceof AuthError)) alert('No se pudieron guardar los snippets (error de red)')
  }
}

// la lista es compartida entre dispositivos: refrescar en cada apertura y
// re-pintar solo si cambió y no hay una edición en curso (app.js:824-830). En
// React basta con NO tocar el store si estamos editando (setState = re-render).
export async function refreshSnippetsInBackground() {
  const before = JSON.stringify(useDeckStore.getState().snippets)
  try {
    const data = await deck.get<{ snippets?: unknown }>('/api/snippets')
    if (!Array.isArray(data.snippets)) return
    if (useDeckStore.getState().snippetsEditing) return // no pisar una edición en curso
    if (JSON.stringify(data.snippets) !== before) useDeckStore.setState({ snippets: data.snippets })
  } catch {
    /* ignore */
  }
}

// mismo patrón toggle/re-render que openModelMenu / openAttachMenu, pero async:
// se abre recién con la lista cargada (app.js:1027-1043)
export async function openSnippetsMenu() {
  if (useDeckStore.getState().switchMenu === 'snippets') {
    closeSwitchMenu()
    return
  }
  useDeckStore.setState({ snippetsEditing: false })
  await loadSnippets()
  useDeckStore.setState({ switchMenu: 'snippets' })
  refreshSnippetsInBackground()
}

// insertar SIN enviar: ese es el contrato de toda la paleta (app.js:833-844)
export function insertSnippet(text: string) {
  if (composerIsOpen()) {
    insertIntoComposer(text)
  } else {
    window.claudeConn?.term.paste(text)
    closeSwitchMenu()
  }
}

export function setSnippetsEditing(v: boolean) {
  useDeckStore.setState({ snippetsEditing: v })
}

export function snippetAdd() {
  const input = window.prompt('Texto del nuevo snippet:')
  if (input === null) return
  const text = input.trim()
  if (!text) return
  useDeckStore.setState({ snippets: [...(useDeckStore.getState().snippets ?? []), text] })
  saveSnippets()
}

export function snippetRename(i: number) {
  const snippets = useDeckStore.getState().snippets
  if (!snippets) return
  const input = window.prompt('Editar snippet:', snippets[i])
  if (input === null) return
  const text = input.trim()
  if (!text || text === snippets[i]) return
  const next = snippets.slice()
  next[i] = text
  useDeckStore.setState({ snippets: next })
  saveSnippets()
}

export function snippetDelete(i: number) {
  const snippets = useDeckStore.getState().snippets
  if (!snippets) return
  if (!window.confirm(`¿Borrar el snippet "${snippets[i]}"?`)) return
  const next = snippets.slice()
  next.splice(i, 1)
  useDeckStore.setState({ snippets: next })
  saveSnippets()
}

// mover un lugar hacia atrás alcanza para cualquier reordenamiento (grilla 2
// col: "antes" = izquierda o fila anterior) — app.js:875-880
export function snippetMove(i: number) {
  const snippets = useDeckStore.getState().snippets
  if (!snippets || i <= 0) return
  const next = snippets.slice()
  ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
  useDeckStore.setState({ snippets: next })
  saveSnippets()
}

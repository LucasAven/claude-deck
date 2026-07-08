import { useDeckStore } from '../store'
import { DEFAULT_QUICKKEYS, QUICKKEYS_LS_KEY } from './keys'

// Quickkeys configurables (tarea 11b): la barra se renderiza desde
// store.quickkeys, que persiste en localStorage['deck-quickkeys'] (global del
// dispositivo, como deck-fontsize y deck-chip-order: el orden solo importa en
// el teléfono). El editor es un bottom sheet (esqueleto host-sheet) que se abre
// desde el sheet de Ajustes (engranaje de la fila de sesiones; antes era
// long-press sobre la barra). Edición estilo snippets: ◀ mueve un lugar antes,
// ✕ saca, los chips del catálogo agregan al final.

function persist(list: string[]) {
  try {
    localStorage.setItem(QUICKKEYS_LS_KEY, JSON.stringify(list))
  } catch {
    /* localStorage puede fallar (modo privado) — la barra igual queda en el store */
  }
}

export function openQuickkeysSheet() {
  useDeckStore.setState({ quickkeysSheetOpen: true })
}

export function closeQuickkeysSheet() {
  useDeckStore.setState({ quickkeysSheetOpen: false })
}

function setQuickkeys(list: string[]) {
  useDeckStore.setState({ quickkeys: list })
  persist(list)
}

export function addQuickkey(id: string) {
  const cur = useDeckStore.getState().quickkeys
  if (cur.includes(id)) return
  setQuickkeys([...cur, id])
}

// no se puede sacar la última: una barra vacía dejaría la fila muerta
export function removeQuickkey(id: string) {
  const cur = useDeckStore.getState().quickkeys
  if (cur.length <= 1) return
  setQuickkeys(cur.filter((k) => k !== id))
}

// mover un lugar antes alcanza para reordenar todo (mismo criterio que la
// edición de snippets)
export function moveQuickkeyEarlier(id: string) {
  const cur = useDeckStore.getState().quickkeys
  const i = cur.indexOf(id)
  if (i <= 0) return
  const next = [...cur]
  next[i] = next[i - 1]
  next[i - 1] = id
  setQuickkeys(next)
}

export function resetQuickkeys() {
  setQuickkeys([...DEFAULT_QUICKKEYS])
}

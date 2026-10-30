import { useDeckStore } from '../store'
import {
  DEFAULT_DPAD,
  DEFAULT_QUICKKEYS,
  DPAD_LS_KEY,
  QUICKKEYS_LS_KEY,
  type DpadConfig,
  type DpadStyle,
} from './keys'

// Quickkeys configurables (tarea 11b): el riel de la toolbox se renderiza desde
// store.quickkeys, que persiste en localStorage['deck-quickkeys'] (global del
// dispositivo, como deck-fontsize y deck-chip-order: el orden solo importa en
// el teléfono). El editor es un bottom sheet (esqueleto host-sheet) que se abre
// desde el sheet de Ajustes (engranaje de la fila de sesiones).
// Edición: la lista de "En el riel" se reordena arrastrando el ⠿ (el commit del
// drag entra por setQuickkeyOrder, una sola escritura), el "−" saca una tecla y
// los chips punteados del catálogo agregan al final.
// La config del d-pad (esquinas de abajo + estilo) vive aparte, en
// localStorage['deck-dpad'], pero se edita en el mismo sheet y el "restaurar
// por defecto" la vuelve a cero junto con el riel.

function persist(list: string[]) {
  try {
    localStorage.setItem(QUICKKEYS_LS_KEY, JSON.stringify(list))
  } catch {
    /* localStorage puede fallar (modo privado): el riel igual queda en el store */
  }
}

function persistDpad(cfg: DpadConfig) {
  try {
    localStorage.setItem(DPAD_LS_KEY, JSON.stringify(cfg))
  } catch {
    /* idem persist(): el d-pad igual queda en el store */
  }
}

// `corner`: el "+" de una esquina vacía del d-pad abre el sheet apuntando a ella
export function openQuickkeysSheet(corner: 'bl' | 'br' | null = null) {
  useDeckStore.setState({ quickkeysSheetOpen: true, quickkeysSheetCorner: corner })
}

export function closeQuickkeysSheet() {
  useDeckStore.setState({ quickkeysSheetOpen: false, quickkeysSheetCorner: null })
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

// no se puede sacar la última: un riel vacío dejaría la fila muerta
export function removeQuickkey(id: string) {
  const cur = useDeckStore.getState().quickkeys
  if (cur.length <= 1) return
  setQuickkeys(cur.filter((k) => k !== id))
}

// commit del drag de reordenamiento: el sheet lleva el orden en vivo mientras
// el dedo se mueve y al soltar manda la lista entera de una (una escritura al
// store + una a localStorage, no una por cada cruce de fila). Se filtra contra
// el estado actual por las dudas: lo que no esté en el store se ignora y lo que
// falte queda al final, así un orden viejo nunca borra una tecla.
export function setQuickkeyOrder(list: string[]) {
  const cur = useDeckStore.getState().quickkeys
  const next = list.filter((id) => cur.includes(id))
  for (const id of cur) if (!next.includes(id)) next.push(id)
  setQuickkeys(next)
}

function setDpad(cfg: DpadConfig) {
  useDeckStore.setState({ dpad: cfg })
  persistDpad(cfg)
}

export function setDpadCorner(corner: 'bl' | 'br', id: string | null) {
  const cur = useDeckStore.getState().dpad
  setDpad({ ...cur, corners: { ...cur.corners, [corner]: id } })
}

export function setDpadStyle(style: DpadStyle) {
  const cur = useDeckStore.getState().dpad
  setDpad({ ...cur, style })
}

// restaura las dos cosas que edita el sheet: el riel y la config del d-pad
export function resetQuickkeys() {
  setQuickkeys([...DEFAULT_QUICKKEYS])
  setDpad({ corners: { ...DEFAULT_DPAD.corners }, style: DEFAULT_DPAD.style })
}

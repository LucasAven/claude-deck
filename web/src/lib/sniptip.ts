import { useDeckStore } from '../store'

// Tooltip de texto completo de un snippet (app.js:882-930). Los chips truncan
// con ellipsis y un snippet largo se vuelve ilegible: desktop lo muestra al
// hacer hover, touch (sin hover) al mantener apretado ~medio segundo. El estado
// visible vive en el store (<SnipTip/> lo posiciona midiéndose a sí mismo); el
// hold timer y el flag anti-tap son module-level porque se leen sincrónicamente.

const SNIP_TIP_HOLD_MS = 450
let holdTimer: ReturnType<typeof setTimeout> | null = null

// true = el pointerup en curso fue un peek (long-press), no una acción: su
// release NO debe insertar el snippet. Objeto mutable para que el binding vivo
// se lea desde los handlers de tap (app.js:889).
export const snipTip = { suppressTap: false }

// guarda el rect del chip; <SnipTip/> se posiciona en un layout effect midiendo
// su propio ancho (fixed = mismas coordenadas que getBoundingClientRect).
export function showSnipTip(chip: HTMLElement, text: string) {
  useDeckStore.setState({ snipTip: { text, rect: chip.getBoundingClientRect() } })
}

export function hideSnipTip() {
  if (holdTimer) {
    clearTimeout(holdTimer)
    holdTimer = null
  }
  if (useDeckStore.getState().snipTip) useDeckStore.setState({ snipTip: null })
}

// arranca el long-press (touch): tras SNIP_TIP_HOLD_MS, si el texto realmente no
// entra en el chip, marca el peek y muestra el tooltip. app.js:917-927.
export function beginSnipHold(chip: HTMLElement, text: string, isTruncated: () => boolean) {
  snipTip.suppressTap = false // gesto nuevo; el flag NO se consume en los taps
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => {
    holdTimer = null
    if (isTruncated()) {
      snipTip.suppressTap = true
      showSnipTip(chip, text)
    }
  }, SNIP_TIP_HOLD_MS)
}

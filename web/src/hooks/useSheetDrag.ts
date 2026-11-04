import { useLayoutEffect, useMemo, useRef } from 'react'

// Arrastrar para cerrar los host-sheet, como un sheet de iOS. El handle es el
// encabezado (grip + título): el panel sigue al dedo hacia abajo y el backdrop
// se aclara con el avance (--sheet-drag, 0..1, lo lee el CSS). Al soltar,
// cierra si bajó lo suficiente o si fue un flick rápido; si no, vuelve a su
// lugar. Las posiciones van directo al style del panel, sin pasar por React:
// un setState por pointermove re-renderizaría el sheet entero.
//
// El drag recién toma el puntero (setPointerCapture) pasado DRAG_SLOP hacia
// abajo. Antes de eso el pointerup sigue llegando a los botones del encabezado
// ("Listo" usa useTap), así que un tap ahí sigue siendo un tap.
//
// `dismiss` cierra con la misma animación, para "Listo" y el backdrop. Los
// cierres que pasan a otro sheet o siguen a un submit siguen siendo al toque.
const DRAG_SLOP = 8 // px hacia abajo antes de empezar a arrastrar
const CLOSE_DIST = 140 // px (o un tercio del panel, lo que sea menor) para cerrar al soltar
const FLICK_V = 0.5 // px/ms hacia abajo al soltar que cierra aunque haya bajado poco
const SETTLE_MS = 220 // igual que la transition de .host-sheet.settling

export function useSheetDrag(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dragRef = useRef<{ id: number; y0: number; active: boolean; y: number; t: number; v: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const api = useMemo(() => {
    const place = (y: number) => {
      const p = panelRef.current
      if (!p) return
      p.style.transform = y ? `translateY(${y}px)` : ''
      p.parentElement?.style.setProperty('--sheet-drag', y ? String(Math.min(1, y / p.offsetHeight)) : '0')
    }
    // con transition (snap de vuelta o salida); sin ella durante el drag
    const settle = (y: number, after?: () => void) => {
      const bd = panelRef.current?.parentElement
      if (!bd) return
      bd.classList.add('settling')
      place(y)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        bd.classList.remove('settling')
        after?.()
      }, SETTLE_MS)
    }
    const release = (e: React.PointerEvent) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.id) return
      dragRef.current = null
      const p = panelRef.current
      if (!d.active || !p) return
      const h = p.offsetHeight
      // la velocidad es la del último move: si el dedo se quedó quieto antes de
      // soltar ya no cuenta como flick
      const flick = d.v > FLICK_V && e.timeStamp - d.t < 100
      if (d.y > Math.min(CLOSE_DIST, h / 3) || flick) settle(h, () => closeRef.current())
      else settle(0)
    }
    // cierre con la misma salida por abajo que el drag, para "Listo" y el
    // backdrop. Mientras sale, un segundo tap no la vuelve a disparar
    const dismiss = () => {
      const p = panelRef.current
      if (!p || timerRef.current) return
      settle(p.offsetHeight, () => closeRef.current())
    }
    const handle = {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button > 0 || timerRef.current) return
        dragRef.current = { id: e.pointerId, y0: e.clientY, active: false, y: 0, t: e.timeStamp, v: 0 }
      },
      onPointerMove: (e: React.PointerEvent) => {
        const d = dragRef.current
        if (!d || e.pointerId !== d.id) return
        const dy = e.clientY - d.y0
        if (!d.active) {
          if (dy < -DRAG_SLOP) dragRef.current = null // hacia arriba: no es un drag del sheet
          if (dy <= DRAG_SLOP) return
          d.active = true
          d.y0 = e.clientY // arranca desde acá, sin saltar los px del slop
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* pointer sintético (tests) sin puntero activo */
          }
          return
        }
        const y = Math.max(0, dy)
        const dt = e.timeStamp - d.t
        if (dt > 0) d.v = (y - d.y) / dt
        d.y = y
        d.t = e.timeStamp
        place(y)
      },
      onPointerUp: release,
      onPointerCancel: release,
    }
    return { handle, dismiss }
  }, [])

  // el panel cerrado arrastrando queda con translateY(alto): se limpia recién
  // cuando ya está hidden, así no hay un frame con el panel de vuelta arriba
  useLayoutEffect(() => {
    if (open) return
    const p = panelRef.current
    if (p) p.style.transform = ''
    p?.parentElement?.style.removeProperty('--sheet-drag')
  }, [open])

  return { panelRef, ...api }
}

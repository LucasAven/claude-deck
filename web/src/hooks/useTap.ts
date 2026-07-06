import { useMemo, useRef } from 'react'

// Tap con tolerancia al scroll (app.js:313-331). preventDefault en pointerdown
// mantiene el foco (no se cierra el teclado virtual — §5.4), pero la acción
// recién dispara en pointerup y solo si el dedo no se movió más que TAP_SLOP;
// apoyar el pulgar en un botón para scrollear la fila ya no lo dispara.
//
// Devuelve props de pointer events para spreadear sobre el elemento. NO
// reemplazar por onClick: se perdería el preventDefault que preserva el foco.
//
// `onLongPress` (tarea 5, opcional): mantener apretado ~medio segundo dispara
// esa acción en vez del tap (mismo patrón de hold que beginSnipHold en
// lib/sniptip.ts). El release de un long-press NO tapea (flag como
// snipTip.suppressTap), y el timer se cancela si el dedo se mueve más que el
// slop o iOS se queda con el gesto (pointercancel). Sin el callback el hook se
// comporta EXACTO igual que antes: ningún consumidor existente cambia.
const TAP_SLOP = 12 // px de movimiento tolerado para seguir contando como tap
const LONG_PRESS_MS = 500

export function useTap(fn: (e: React.PointerEvent) => void, onLongPress?: () => void) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const lpRef = useRef(onLongPress)
  lpRef.current = onLongPress
  const startRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firedRef = useRef(false) // el long-press ya disparó: suprimir el tap del release

  return useMemo(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        startRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        firedRef.current = false
        if (lpRef.current) {
          clearTimer()
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            firedRef.current = true
            lpRef.current?.()
          }, LONG_PRESS_MS)
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        // solo cancela el hold: el tap sigue midiendo su propio slop en el up
        const start = startRef.current
        if (!timerRef.current || !start || e.pointerId !== start.id) return
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) clearTimer()
      },
      onPointerUp: (e: React.PointerEvent) => {
        clearTimer()
        const start = startRef.current
        if (!start || e.pointerId !== start.id) return
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
        startRef.current = null
        if (firedRef.current) {
          firedRef.current = false
          return
        }
        if (moved <= TAP_SLOP) fnRef.current(e)
      },
      onPointerCancel: () => {
        clearTimer()
        firedRef.current = false
        startRef.current = null // el scroll se quedó con el gesto
      },
    }
  }, [])
}

import { useMemo, useRef } from 'react'

// Tap con tolerancia al scroll (app.js:313-331). preventDefault en pointerdown
// mantiene el foco (no se cierra el teclado virtual — §5.4), pero la acción
// recién dispara en pointerup y solo si el dedo no se movió más que TAP_SLOP;
// apoyar el pulgar en un botón para scrollear la fila ya no lo dispara.
//
// Devuelve props de pointer events para spreadear sobre el elemento. NO
// reemplazar por onClick: se perdería el preventDefault que preserva el foco.
const TAP_SLOP = 12 // px de movimiento tolerado para seguir contando como tap

export function useTap(fn: (e: React.PointerEvent) => void) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const startRef = useRef<{ id: number; x: number; y: number } | null>(null)

  return useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        startRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
      },
      onPointerUp: (e: React.PointerEvent) => {
        const start = startRef.current
        if (!start || e.pointerId !== start.id) return
        const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
        startRef.current = null
        if (moved <= TAP_SLOP) fnRef.current(e)
      },
      onPointerCancel: () => {
        startRef.current = null // el scroll se quedó con el gesto
      },
    }),
    [],
  )
}

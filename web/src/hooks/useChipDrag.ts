import { useEffect, useRef, useState } from 'react'
import { saveChipOrder } from '../lib/chiporder'
import { useDeckStore, type Session } from '../store'

// Drag para reordenar los chips de sesión (tarea 19). El cuidado central: la
// fila (#session-chips) SCROLLEA horizontal y el tap ATTACHEA — el drag no puede
// pelear con ninguno. Solución (misma familia que el long-press del + de la
// tarea 5 y el slop del diff de la 13): "levantar" el chip con un long-press.
//
//  - pointerdown NO hace preventDefault → un tap corto sigue disparando el
//    onClick de select del chip (attach), y un swipe inmediato scrollea nativo.
//  - un timer de 500 ms sin mover más que el slop → se "levanta" el chip
//    (draggingRef=true). Recién ahí bloqueamos el scroll: un touchmove non-passive
//    (React lo registra passive, no sirve para preventDefault) frena la página
//    SOLO mientras draggingRef está activo.
//  - durante el drag reordenamos por hit-test (elementFromPoint sobre el chip de
//    abajo; el levantado va con pointer-events:none para no taparse a sí mismo).
//  - el release commitea el orden a localStorage y suprime el click de select
//    que iOS sintetizaría (suppressClickRef).
//
// setPointerCapture asegura que todos los move/up caigan en el contenedor aunque
// el dedo se salga de la fila.

const HOLD_MS = 500
const SLOP = 12 // mismo TAP_SLOP que useTap

// Reordena las Session del store según una lista de nombres; los que no estén en
// la lista (no debería pasar en el commit) quedan al final en su orden previo.
function reorderSessions(sessions: Session[], names: string[]): Session[] {
  const byName = new Map(sessions.map((s) => [s.name, s]))
  const out: Session[] = []
  for (const n of names) {
    const s = byName.get(n)
    if (s) {
      out.push(s)
      byName.delete(n)
    }
  }
  for (const s of byName.values()) out.push(s)
  return out
}

export function useChipDrag(sessions: Session[]) {
  const ref = useRef<HTMLDivElement>(null)
  const [order, setOrder] = useState<string[] | null>(null) // orden en vivo durante el drag
  const [lifted, setLifted] = useState<string | null>(null)

  const startRef = useRef<{ id: number; x: number; y: number; name: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draggingRef = useRef(false)
  const orderRef = useRef<string[]>([])
  const suppressClickRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTouchMove = (e: TouchEvent) => {
      if (draggingRef.current) e.preventDefault()
    }
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => el.removeEventListener('touchmove', onTouchMove)
  }, [])

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const beginDrag = (name: string, id: number) => {
    draggingRef.current = true
    suppressClickRef.current = true
    setLifted(name)
    setOrder(orderRef.current.slice())
    try {
      ref.current?.setPointerCapture(id)
    } catch {
      /* el pointer ya se soltó */
    }
  }

  const finish = () => {
    clearTimer()
    startRef.current = null
    if (draggingRef.current) {
      draggingRef.current = false
      saveChipOrder(orderRef.current)
      // reflejar el orden nuevo en el store ya mismo (el poll de 8 s lo re-derivaría
      // igual vía orderNames, pero así no parpadea al limpiar el estado local)
      useDeckStore.setState((s) => ({ sessions: reorderSessions(s.sessions, orderRef.current) }))
      setOrder(null)
      setLifted(null)
    }
  }

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const chip = (e.target as HTMLElement).closest?.('.chip') as HTMLElement | null
      const name = chip?.dataset.name
      if (!name) return
      suppressClickRef.current = false
      startRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, name }
      orderRef.current = sessions.map((s) => s.name)
      draggingRef.current = false
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        beginDrag(name, e.pointerId)
      }, HOLD_MS)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const st = startRef.current
      if (!st || e.pointerId !== st.id) return
      if (!draggingRef.current) {
        // mientras no se levantó, el movimiento cancela el hold (es scroll/tap)
        if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > SLOP) clearTimer()
        return
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const over = el?.closest?.('.chip[data-name]') as HTMLElement | null
      const overName = over?.dataset.name
      if (!overName || overName === st.name) return
      const cur = orderRef.current
      const from = cur.indexOf(st.name)
      const to = cur.indexOf(overName)
      if (from < 0 || to < 0) return
      const next = cur.slice()
      next.splice(from, 1)
      next.splice(to, 0, st.name)
      orderRef.current = next
      setOrder(next)
    },
    onPointerUp: () => finish(),
    onPointerCancel: () => {
      // no se llegó a levantar: solo limpiar. Si ya estaba arrastrando, commitea
      // el orden actual (no hay razón para descartar lo que ya se ve).
      if (!draggingRef.current) {
        clearTimer()
        startRef.current = null
        return
      }
      finish()
    },
    // el long-press sintetiza un click al soltar en iOS: suprimir el select
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }

  const displayNames = order ?? sessions.map((s) => s.name)
  return { ref, handlers, displayNames, lifted }
}

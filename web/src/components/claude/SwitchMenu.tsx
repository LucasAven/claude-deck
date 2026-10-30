import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDeckStore } from '../../store'
import {
  DEFAULT_DPAD_SPOT,
  DPAD_SPOTS,
  EFFORTS,
  KEYS,
  MODELS,
  QUICKKEY_CATALOG,
  loadDpadSpot,
  saveDpadSpot,
  type DpadCol,
  type DpadRow,
  type DpadSpot,
} from '../../lib/keys'
import { saveSwitch, sendSlashCommand, closeSwitchMenu } from '../../lib/switch'
import { pasteFromClipboard } from '../../lib/image'
import { openQuickkeysSheet } from '../../lib/quickkeys'
import { useTap } from '../../hooks/useTap'
import { SnippetsPalette } from './Snippets'

// Popover único de la controlbar (#switch-menu, app.js:398-464, 630-654,
// 1027-1043): un solo contenedor con kind 'model'|'dpad'|'snippets' en el
// store. El toggle (tap en el kind abierto lo cierra) y el tap-afuera los manejan
// lib/switch y el listener global de App. Acá solo se pinta el contenido del kind.

function MenuItem({ label, selected, onPick }: { label: string; selected: boolean; onPick: () => void }) {
  const tap = useTap(onPick)
  return (
    <button className={'mi' + (selected ? ' sel' : '')} {...tap}>
      <span>{label}</span>
      {selected && <span className="mi-check">✓</span>}
    </button>
  )
}

function EffortButton({ label, selected, onPick }: { label: string; selected: boolean; onPick: () => void }) {
  const tap = useTap(onPick)
  return (
    <button className={selected ? 'sel' : ''} {...tap}>
      {label}
    </button>
  )
}

function ModelMenu() {
  const session = useDeckStore((s) => s.session)
  const sw = useDeckStore((s) => s.switchState)
  const setSwitchState = useDeckStore((s) => s.setSwitchState)

  const pickModel = (id: string) => {
    sendSlashCommand(`/model ${id}`)
    const next = { ...sw, model: id }
    saveSwitch(session, next)
    setSwitchState(next)
    closeSwitchMenu()
  }
  const pickEffort = (id: string) => {
    sendSlashCommand(`/effort ${id}`)
    const next = { ...sw, effort: id }
    saveSwitch(session, next)
    setSwitchState(next)
    closeSwitchMenu()
  }

  return (
    <>
      <div className="mh">Modelo</div>
      {MODELS.map((m) => (
        <MenuItem key={m.id} label={m.label} selected={m.id === sw.model} onPick={() => pickModel(m.id)} />
      ))}
      <div className="mdiv" />
      <div className="mh">Esfuerzo</div>
      <div className="mi-efforts">
        {EFFORTS.map((e) => (
          <EffortButton key={e.id} label={e.label} selected={e.id === sw.effort} onPick={() => pickEffort(e.id)} />
        ))}
      </div>
    </>
  )
}

// Íconos de las dos esquinas FIJAS de arriba. Se exportan por lo mismo que
// TOOL_ICONS en ControlBar: el diagrama del d-pad en el editor de teclas
// rápidas los vuelve a pintar en chico y no quiere una segunda copia del svg.
export const DPAD_ICONS = {
  camera: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2.5" />
      <path d="M8.5 7l1.6-2.4h3.8L15.5 7" />
      <circle cx="12" cy="13.2" r="3.4" />
    </svg>
  ),
  paste: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="4.5" width="14" height="17" rx="2.5" />
      <path d="M9 4.5a3 3 0 0 1 6 0" />
      <path d="M9.3 13.5l2 2 3.4-3.8" />
    </svg>
  ),
}

const REPEAT_DELAY_MS = 350
const REPEAT_EVERY_MS = 80

// Flecha del d-pad: manda en pointerdown (no en el up como useTap) para que
// mantener apretado auto-repita. En el popover no hay scroll que proteger, así
// que no hace falta el slop. El preventDefault mantiene el teclado virtual.
function ArrowCell({ k, title, children }: { k: string; title: string; children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stop = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => stop, [])
  const send = () => window.claudeConn?.sendKeys(KEYS[k])
  const repeat = () => {
    send()
    timerRef.current = setTimeout(repeat, REPEAT_EVERY_MS)
  }
  return (
    <button
      className="dp-cell"
      data-k={k}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault()
        stop()
        send()
        timerRef.current = setTimeout(repeat, REPEAT_DELAY_MS)
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      {children}
    </button>
  )
}

// iOS sintetiza mousedown/click después del touchend, en el punto donde se
// levantó el dedo y contra lo que haya ahí EN ESE MOMENTO. Si el gesto movió o
// cerró el menú (snap o doble tap del handle, cámara, pegar, el "+"), ese click
// cae en la terminal, el textarea de xterm (que está en la línea del cursor,
// justo debajo del lugar por defecto) toma foco y se abre el teclado.
// preventDefault en el touchend cancela ese click. Va como listener nativo en
// el elemento y no como onTouchEnd de React: el "+", cámara y pegar ya se
// desmontaron cuando llega el touchend, y un nodo suelto no burbujea hasta la
// raíz donde React delega. La acción no se pierde: corre antes, en pointerup.
// Ref callback estable: React lo llama una vez por elemento montado.
function noGhostClick(el: HTMLElement | null) {
  el?.addEventListener(
    'touchend',
    (e) => {
      if (e.cancelable) e.preventDefault()
    },
    { passive: false },
  )
}

// Esquina de abajo configurable (sheet de teclas rápidas): manda la tecla
// asignada y NO cierra el menú, igual que enter, para poder tocarla varias
// veces seguidas. Sin tecla asignada es un slot punteado con "+" que abre el
// sheet de teclas rápidas para elegirla.
function CornerCell({ which, id }: { which: 'bl' | 'br'; id: string | null }) {
  const cat = id ? QUICKKEY_CATALOG.find((c) => c.id === id) : undefined
  const tap = useTap(() => {
    if (cat) {
      window.claudeConn?.sendKeys(KEYS[cat.id])
      return
    }
    closeSwitchMenu()
    openQuickkeysSheet(which)
  })
  if (!cat)
    return (
      <button className="dp-slot" title="Elegir una tecla para esta esquina" ref={noGhostClick} {...tap}>
        +
      </button>
    )
  // el modificador (^ o ⇧) va apagado delante de la tecla, mismo tamaño y fuente
  const [, mod, key] = cat.label.match(/^([\^⇧]?)(.*)$/) ?? ['', '', cat.label]
  return (
    <button className="dp-cell dp-corner" data-k={cat.id} title={cat.desc} {...tap}>
      {mod && <span className="dp-mod">{mod}</span>}
      {key}
    </button>
  )
}

// D-pad: grilla 3x3. Flechas, enter y las esquinas configurables NO cierran el
// menú (↓ ↓ ⏎ seguidos); cámara y pegar sí. Esos dos corren dentro del
// pointerup (useTap) → sigue habiendo user activation para abrir el file
// picker / clipboard.
function DpadMenu({ onCamera }: { onCamera: () => void }) {
  const corners = useDeckStore((s) => s.dpad.corners)
  const cameraTap = useTap(() => {
    closeSwitchMenu()
    onCamera()
  })
  const pasteTap = useTap(() => {
    closeSwitchMenu()
    pasteFromClipboard()
  })
  const enterTap = useTap(() => window.claudeConn?.sendKeys(KEYS.enter))
  return (
    <>
      <button className="dp-cell" data-act="camera" title="Cámara o galería" ref={noGhostClick} {...cameraTap}>
        {DPAD_ICONS.camera}
      </button>
      <ArrowCell k="up" title="Flecha arriba">↑</ArrowCell>
      <button className="dp-cell" data-act="paste" title="Pegar del portapapeles" ref={noGhostClick} {...pasteTap}>
        {DPAD_ICONS.paste}
      </button>
      <ArrowCell k="left" title="Flecha izquierda">←</ArrowCell>
      <button className="dp-cell dp-enter" data-k="enter" title="Enter" {...enterTap}>
        {'⏎︎'}
      </button>
      <ArrowCell k="right" title="Flecha derecha">→</ArrowCell>
      <CornerCell which="bl" id={corners.bl} />
      <ArrowCell k="down" title="Flecha abajo">↓</ArrowCell>
      <CornerCell which="br" id={corners.br} />
    </>
  )
}

// ---------- d-pad flotante: handle, lugares y snap ----------
const DP_EDGE = 12 // distancia mínima a los bordes del área visible
const DP_BACK_SWIPE = 20 // el drag no entra a la franja del back-swipe de iOS
const DP_GAP = 6 // entre la fila de abajo y la statusline (o la toolbox)
const DP_TAP_SLOP = 12 // soltar sin pasar de acá es un tap (cuenta para el doble tap), como useTap
const DP_DOUBLE_TAP_MS = 300
const DP_SETTLE_MS = 150 // el teclado dispara ráfagas de resize: se espera a que termine

type Pt = { left: number; top: number }

// Geometría en coordenadas del containing block del popover (.controlbar):
// los 9 lugares y los límites del drag. Lo vertical sale del visualViewport
// (#app lo sigue, así que comparten coordenadas de cliente); lo horizontal se
// recorta además a la .controlbar, que ya descuenta el safe-area (notch en
// horizontal) y deja la columna izquierda alineada con #btn-dpad.
function measureDpad(menu: HTMLElement) {
  const cb = menu.offsetParent as HTMLElement
  const size = { w: menu.offsetWidth, h: menu.offsetHeight }
  const vv = window.visualViewport
  const c = cb.getBoundingClientRect()
  const area = {
    left: Math.max(vv?.offsetLeft ?? 0, c.left),
    right: Math.min(vv ? vv.offsetLeft + vv.width : window.innerWidth, c.right),
    top: vv?.offsetTop ?? 0,
    bottom: vv ? vv.offsetTop + vv.height : window.innerHeight,
  }
  // left/top de un hijo absoluto se miden desde el padding box: el borde
  // superior de la controlbar (con teclado abierto) corre el origen 1px
  const origin = { left: c.left + cb.clientLeft, top: c.top + cb.clientTop }
  // con teclado abierto la statusline no se muestra: el piso es la toolbox
  const sl = document.querySelector<HTMLElement>('#view-claude .statusline')
  const floor = (sl?.offsetHeight ? sl.getBoundingClientRect().top : c.top) - DP_GAP
  const output = document.getElementById('term-claude')?.getBoundingClientRect().top ?? area.top
  const minTop = area.top + DP_EDGE
  const maxTop = area.bottom - DP_EDGE - size.h
  const clampTop = (t: number) => Math.min(Math.max(t, minTop), maxTop)
  const low = clampTop(floor - size.h)
  const high = clampTop(output + DP_EDGE)
  const tops: Record<DpadRow, number> = { low, mid: (low + high) / 2, high }
  const lefts: Record<DpadCol, number> = {
    left: area.left + DP_EDGE,
    center: (area.left + area.right - size.w) / 2,
    right: area.right - DP_EDGE - size.w,
  }
  const at = (s: DpadSpot): Pt => ({ left: lefts[s.col] - origin.left, top: tops[s.row] - origin.top })
  return {
    origin,
    size,
    at,
    clamp: (p: Pt): Pt => ({
      left: Math.min(Math.max(p.left, area.left + DP_BACK_SWIPE - origin.left), lefts.right - origin.left),
      top: Math.min(Math.max(p.top, minTop - origin.top), maxTop - origin.top),
    }),
    nearest: (p: Pt): DpadSpot => {
      const dist = (s: DpadSpot) => Math.hypot(at(s).left - p.left, at(s).top - p.top)
      return DPAD_SPOTS.reduce((best, s) => (dist(s) < dist(best) ? s : best))
    },
  }
}

type DpadDrag = {
  id: number
  geo: ReturnType<typeof measureDpad>
  grabX: number // dedo menos esquina del menú, para que el menú no salte al agarrarlo
  grabY: number
  x0: number
  y0: number
  moved: boolean // pasó DP_TAP_SLOP: es un drag y no un tap
  at: Pt // última posición del drag, ya dentro de los límites
}

// Posición del popover del d-pad flotante. Al abrir (y cuando el
// visualViewport termina de cambiar, p. ej. al abrir el teclado) va al lugar
// guardado, recalculado para el área visible de ese momento; el handle lo arrastra 1:1 y al soltar se acomoda en el
// lugar más cercano. Con `enabled` en false no hay posición propia y el CSS
// lo deja en el lugar por defecto.
function useDpadPlacement(menuRef: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [pos, setPos] = useState<Pt | null>(null)
  const [spots, setSpots] = useState<{ at: Pt[]; w: number; h: number } | null>(null) // contornos durante el drag
  const [snapping, setSnapping] = useState(false)
  const dragRef = useRef<DpadDrag | null>(null)
  const lastTapRef = useRef(0)

  const geometry = () => (menuRef.current?.offsetParent ? measureDpad(menuRef.current) : null)

  useLayoutEffect(() => {
    if (!enabled) {
      setPos(null)
      return
    }
    // durante un drag no se mueve: settle() vuelve a medir al soltar
    const place = () => {
      if (dragRef.current) return
      const geo = geometry()
      if (!geo) return
      setSnapping(false)
      setPos(geo.at(loadDpadSpot()))
    }
    place()
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(place, DP_SETTLE_MS)
    }
    const vv = window.visualViewport
    vv?.addEventListener('resize', onResize)
    window.addEventListener('resize', onResize)
    return () => {
      if (timer) clearTimeout(timer)
      vv?.removeEventListener('resize', onResize)
      window.removeEventListener('resize', onResize)
      dragRef.current = null
      setSpots(null)
    }
  }, [enabled])

  // se mide de nuevo: si el teclado o la rotación cambiaron el viewport
  // durante el drag, la geometría del pointerdown ya no sirve
  const settle = (pick: (geo: ReturnType<typeof measureDpad>) => DpadSpot) => {
    const drag = dragRef.current
    dragRef.current = null
    setSpots(null)
    if (!drag) return
    const geo = geometry() ?? drag.geo
    const spot = pick(geo)
    saveDpadSpot(spot)
    setSnapping(true)
    setPos(geo.at(spot))
  }

  const handleProps = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault() // el teclado virtual no se cierra al agarrar el handle
      if (dragRef.current) return // un segundo dedo no le roba el drag al primero
      const geo = geometry()
      const menu = menuRef.current?.getBoundingClientRect()
      if (!geo || !menu) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* pointer sintético (tests) sin puntero activo */
      }
      dragRef.current = {
        id: e.pointerId,
        geo,
        grabX: e.clientX - menu.left,
        grabY: e.clientY - menu.top,
        x0: e.clientX,
        y0: e.clientY,
        moved: false,
        at: { left: menu.left - geo.origin.left, top: menu.top - geo.origin.top },
      }
      setSnapping(false)
    },
    // sigue al dedo desde el primer px; el slop solo decide si al soltar fue tap
    onPointerMove: (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.id) return
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) >= DP_TAP_SLOP) {
        drag.moved = true
        setSpots({ at: DPAD_SPOTS.map(drag.geo.at), w: drag.geo.size.w, h: drag.geo.size.h })
      }
      drag.at = drag.geo.clamp({
        left: e.clientX - drag.grabX - drag.geo.origin.left,
        top: e.clientY - drag.grabY - drag.geo.origin.top,
      })
      setPos(drag.at)
    },
    onPointerUp: (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.id) return
      if (drag.moved) {
        lastTapRef.current = 0
        settle((geo) => geo.nearest(drag.at))
        return
      }
      const now = performance.now()
      const double = now - lastTapRef.current < DP_DOUBLE_TAP_MS
      lastTapRef.current = double ? 0 : now
      settle(() => (double ? DEFAULT_DPAD_SPOT : loadDpadSpot()))
    },
    // sin lostpointercapture a propósito: el gesto lo terminan solo el up y el
    // cancel, así un lostpointercapture antes del up no se come el doble tap
    onPointerCancel: (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.id) return
      settle((geo) => (drag.moved ? geo.nearest(drag.at) : loadDpadSpot()))
    },
  }

  return { pos, spots, snapping, dragging: spots !== null, handleProps }
}

function DpadHandle({ dragging, handlers }: { dragging: boolean; handlers: ReturnType<typeof useDpadPlacement>['handleProps'] }) {
  return (
    <button
      className={'dp-handle' + (dragging ? ' dragging' : '')}
      ref={noGhostClick}
      title="Mover el d-pad (doble tap: volver al lugar por defecto)"
      {...handlers}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M15 5L5 15M15 10l-5 5M15 15h0" />
      </svg>
    </button>
  )
}

export function SwitchMenu({ onCamera }: { onCamera: () => void }) {
  const kind = useDeckStore((s) => s.switchMenu)
  const floating = useDeckStore((s) => s.dpad.style === 'floating')
  const menuRef = useRef<HTMLDivElement>(null)
  const dp = useDpadPlacement(menuRef, kind === 'dpad' && floating)
  // data-kind espeja el kind al DOM: parte del contrato con ui-test.mjs (lee
  // menu.dataset.kind) y con el CSS, igual que el `dataset.kind` del vanilla.
  return (
    <>
      <div
        id="switch-menu"
        ref={menuRef}
        className={'switch-menu' + (kind ? '' : ' hidden') + (kind === 'dpad' && dp.snapping ? ' dp-snapping' : '')}
        data-kind={kind ?? undefined}
        style={kind === 'dpad' && dp.pos ? { left: dp.pos.left, top: dp.pos.top, bottom: 'auto' } : undefined}
      >
        {kind === 'model' && <ModelMenu />}
        {kind === 'dpad' && <DpadMenu onCamera={onCamera} />}
        {kind === 'dpad' && floating && <DpadHandle dragging={dp.dragging} handlers={dp.handleProps} />}
        {kind === 'snippets' && <SnippetsPalette />}
      </div>
      {dp.spots?.at.map((s, i) => (
        <div key={i} className="dp-spot" style={{ left: s.left, top: s.top, width: dp.spots?.w, height: dp.spots?.h }} />
      ))}
    </>
  )
}

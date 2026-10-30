import { useEffect, useRef, useState } from 'react'
import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { QUICKKEY_CATALOG, type DpadStyle } from '../../lib/keys'
import {
  closeQuickkeysSheet,
  addQuickkey,
  removeQuickkey,
  setQuickkeyOrder,
  setDpadCorner,
  setDpadStyle,
  resetQuickkeys,
} from '../../lib/quickkeys'
import { TOOL_ICONS } from './ControlBar'
import { DPAD_ICONS } from './SwitchMenu'

// Editor de la toolbox (tarea 11b). Bottom sheet con el esqueleto del
// host-sheet (siempre montado, toggle hidden, backdrop cierra), abierto desde
// el sheet de Ajustes. De arriba a abajo: vista previa en vivo de la fila real,
// la lista de teclas del riel (arrastrables por el ⠿, "−" para sacar), los
// chips del catálogo para agregar, las dos esquinas de abajo del d-pad y el
// estilo del d-pad. Cada cambio persiste al instante (deck-quickkeys y
// deck-dpad).
// Los botones van con useTap, nunca onClick: el sheet se cierra sobre la
// controlbar y un click fantasma sobre lo que quede debajo repetiría el bug de
// las tareas 20/27. Los <select> de las esquinas son la excepción a propósito:
// nativos, para que iOS abra su propio picker.

const ROW_H = 44 // alto fijo de cada fila: el drag se apoya en que son todas iguales

const catOf = (id: string | null) => (id ? QUICKKEY_CATALOG.find((c) => c.id === id) : undefined)

// Copia chica y muerta de la .toolrow real (misma estructura: d-pad fijo a la
// izquierda, teclas + snippets + lector scrolleando en el medio, compose fijo a
// la derecha). Los svg son los mismos objetos que pinta ControlBar, importados,
// así no hay dos copias del markup que se desincronicen.
function Preview({ order }: { order: string[] }) {
  const keysRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState(false)
  // el fade del borde derecho solo mientras sobre contenido. Se re-mide con el
  // orden (cambia el ancho) y con el tamaño del contenedor, que pasa de 0 a lo
  // suyo recién cuando el sheet deja de estar display:none
  useEffect(() => {
    const el = keysRef.current
    if (!el) return
    const update = () => setFade(el.scrollWidth - el.clientWidth > 1)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [order])

  return (
    <div id="qk-preview" className="qk-preview" aria-hidden>
      <span className="qk-pv-sq">{TOOL_ICONS.dpad}</span>
      <div className={'qk-pv-keys' + (fade ? ' fade' : '')} ref={keysRef}>
        {order.map((id) => {
          const c = catOf(id)
          return c ? (
            <span className="qk-pv-key" data-k={id} key={id}>
              {c.label}
            </span>
          ) : null
        })}
        <span className="qk-pv-sq">{TOOL_ICONS.snippets}</span>
        <span className="qk-pv-sq">{TOOL_ICONS.scrollback}</span>
      </div>
      <span className="qk-pv-compose">{TOOL_ICONS.compose}</span>
    </div>
  )
}

// Fila del riel: ⠿ (único punto de agarre del drag), label mono en columna
// fija, descripción elipsada y "−" para sacarla.
function RailRow({
  id,
  lifted,
  offset,
  canRemove,
  onGripDown,
}: {
  id: string
  lifted: boolean
  offset: number
  canRemove: boolean
  onGripDown: (e: React.PointerEvent, id: string) => void
}) {
  const delTap = useTap(() => removeQuickkey(id))
  const c = catOf(id)
  if (!c) return null
  return (
    <div
      className={'qk-row' + (lifted ? ' lifted' : '')}
      data-qk={id}
      style={lifted ? { transform: `translateY(${offset}px)` } : undefined}
    >
      <span className="qk-grip" onPointerDown={(e) => onGripDown(e, id)}>
        ⠿
      </span>
      <span className="qk-key">{c.label}</span>
      <span className="qk-desc">{c.desc}</span>
      {canRemove && (
        <button className="qk-del" title="Sacar del riel" {...delTap}>
          −
        </button>
      )}
    </div>
  )
}

function CatalogChip({ id, label, desc }: { id: string; label: string; desc: string }) {
  const addTap = useTap(() => addQuickkey(id))
  return (
    <button className="qk-chip qk-add" data-qk={id} title={desc} {...addTap}>
      <span className="qk-plus">+</span>
      {label}
    </button>
  )
}

// Diagrama del d-pad: espejo del popover 3x3 (cámara ↑ pegar / ← ⏎ → /
// esquina ↓ esquina). Solo para mirar, nada acá es tocable.
function DpadDiagram({
  corners,
  focus,
}: {
  corners: { bl: string | null; br: string | null }
  focus: 'bl' | 'br' | null
}) {
  const corner = (which: 'bl' | 'br') => {
    const c = catOf(corners[which])
    return (
      <span className={'qk-dp-cell qk-dp-corner' + (c ? '' : ' empty') + (focus === which ? ' focus' : '')}>
        {c?.label ?? ''}
      </span>
    )
  }
  return (
    <div className="qk-dp" aria-hidden>
      <span className="qk-dp-cell qk-dp-ico">{DPAD_ICONS.camera}</span>
      <span className="qk-dp-cell">↑</span>
      <span className="qk-dp-cell qk-dp-ico">{DPAD_ICONS.paste}</span>
      <span className="qk-dp-cell">←</span>
      <span className="qk-dp-cell qk-dp-enter">⏎</span>
      <span className="qk-dp-cell">→</span>
      {corner('bl')}
      <span className="qk-dp-cell">↓</span>
      {corner('br')}
    </div>
  )
}

function StyleButton({ style, label, sel }: { style: DpadStyle; label: string; sel: boolean }) {
  const tap = useTap(() => setDpadStyle(style))
  return (
    <button className={'qk-seg-btn' + (sel ? ' sel' : '')} data-style={style} {...tap}>
      {label}
    </button>
  )
}

export function QuickkeysSheet() {
  const open = useDeckStore((s) => s.quickkeysSheetOpen)
  const list = useDeckStore((s) => s.quickkeys)
  const dpad = useDeckStore((s) => s.dpad)
  const doneTap = useTap(() => closeQuickkeysSheet())
  const resetTap = useTap(() => resetQuickkeys())
  const [focus, setFocus] = useState<'bl' | 'br' | null>(null)
  // abierto desde el "+" de una esquina del d-pad: esa esquina queda resaltada
  // hasta que se toque un select, y el sheet baja hasta la sección. No se le da
  // foco al <select>: en iOS eso abre el picker solo, sin que el usuario lo pida.
  const pointedCorner = useDeckStore((s) => s.quickkeysSheetCorner)
  const cornersRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || !pointedCorner) return
    const raf = requestAnimationFrame(() => cornersRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    return () => cancelAnimationFrame(raf)
  }, [open, pointedCorner])
  const shownFocus = focus ?? pointedCorner

  // Drag de reordenamiento, solo desde el ⠿ (tarea 11b, rediseño). No hay
  // long-press como en los chips de sesión: acá el riel no scrollea ni el tap
  // de la fila hace nada, así que el pointerdown sobre el ⠿ ya levanta la fila.
  // dragRef guarda lo que no pinta (puntero, orden de partida, orden en vivo) y
  // `drag` lo que sí (orden mostrado + desplazamiento de la fila levantada).
  const listRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; id: string; startY: number; from: number; base: string[]; live: string[] } | null>(null)
  const [drag, setDrag] = useState<{ id: string; order: string[]; offset: number } | null>(null)

  const onGripDown = (e: React.PointerEvent, id: string) => {
    const base = list.slice()
    const from = base.indexOf(id)
    if (from < 0) return
    e.preventDefault() // sin esto iOS selecciona el ⠿ como texto durante el arrastre
    // el capture va en la LISTA, no en el ⠿: la fila levantada se mueve de
    // lugar en el DOM al reordenar y eso puede soltar el capture a mitad del
    // gesto. La lista no se mueve nunca y los eventos igual llegan acá.
    try {
      listRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* el dedo ya se fue: el drag muere en el primer move */
    }
    dragRef.current = { pointerId: e.pointerId, id, startY: e.clientY, from, base, live: base }
    setDrag({ id, order: base, offset: 0 })
  }

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const dy = e.clientY - d.startY
    // el centro de la fila levantada define en qué slot cae: medio renglón de
    // recorrido (22px) ya manda a la vecina al lugar que la levantada deja
    const to = Math.max(0, Math.min(d.base.length - 1, d.from + Math.round(dy / ROW_H)))
    const order = d.base.slice()
    order.splice(d.from, 1)
    order.splice(to, 0, d.id)
    d.live = order
    // el translate se mide contra el slot donde la fila se pinta AHORA, no
    // contra el de partida: así sigue al dedo sin saltar al reordenarse
    setDrag({ id: d.id, order, offset: dy - (to - d.from) * ROW_H })
  }

  // un solo commit al soltar (una escritura al store + una a localStorage),
  // no una por cada cruce de fila
  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    dragRef.current = null
    setDrag(null)
    setQuickkeyOrder(d.live)
  }

  const order = drag?.order ?? list
  const available = QUICKKEY_CATALOG.filter((c) => !list.includes(c.id))

  // <select> nativo (iOS abre su picker), vestido de chip mono con ▾
  const cornerSelect = (which: 'bl' | 'br') => (
    <span className={'qk-sel' + (shownFocus === which ? ' focus' : '')}>
      <select
        id={'qk-corner-' + which}
        value={dpad.corners[which] ?? ''}
        onChange={(e) => setDpadCorner(which, e.target.value || null)}
        onFocus={() => {
          setFocus(which)
          useDeckStore.setState({ quickkeysSheetCorner: null })
        }}
        onBlur={() => setFocus(null)}
      >
        <option value="">vacía</option>
        {QUICKKEY_CATALOG.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <span className="qk-sel-caret">▾</span>
    </span>
  )

  return (
    <div
      id="quickkeys-sheet"
      className={'host-sheet' + (open ? '' : ' hidden')}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeQuickkeysSheet()
      }}
    >
      <div className="host-sheet-panel">
        <div className="sheet-grip" />
        <div className="host-title qk-title">
          <b>Teclas rápidas</b>
          <button id="qk-done" className="qk-done" {...doneTap}>
            Listo
          </button>
        </div>

        <div className="qk-label">Vista previa</div>
        <Preview order={order} />

        <div className="qk-label qk-label-row">
          <span>En el riel</span>
          <span className="qk-hint">arrastrá ⠿ para ordenar</span>
        </div>
        <div
          id="qk-current"
          className="qk-list"
          ref={listRef}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {order.map((id) => (
            <RailRow
              key={id}
              id={id}
              lifted={drag?.id === id}
              offset={drag?.offset ?? 0}
              canRemove={order.length > 1}
              onGripDown={onGripDown}
            />
          ))}
        </div>

        <div className="qk-label">Agregar</div>
        <div id="qk-catalog" className="qk-chips">
          {available.map((c) => (
            <CatalogChip key={c.id} id={c.id} label={c.label} desc={c.desc} />
          ))}
          {!available.length && <span className="qk-empty">Todas en el riel</span>}
        </div>

        <div className="qk-label">Esquinas del d-pad</div>
        <div className="qk-corners" ref={cornersRef}>
          <DpadDiagram corners={dpad.corners} focus={shownFocus} />
          <div className="qk-corner-rows">
            <div className="qk-corner-row">
              <span>Arriba: cámara · pegar</span>
              <span className="qk-fixed">(fijas)</span>
            </div>
            <div className="qk-corner-row">
              <span>Abajo izq.:</span>
              {cornerSelect('bl')}
            </div>
            <div className="qk-corner-row">
              <span>Abajo der.:</span>
              {cornerSelect('br')}
            </div>
          </div>
        </div>

        <div className="qk-label">Estilo del d-pad</div>
        {/* Flotante: el popover 3x3 se mueve con su handle. Fijo: queda en el
            lugar por defecto, sin handle.
            TODO(d-pad): el d-pad fijo DENTRO de la toolbox todavía no existe. */}
        <div id="qk-style" className="qk-seg">
          <StyleButton style="floating" label="Flotante" sel={dpad.style === 'floating'} />
          <StyleButton style="fixed" label="Fijo en el toolbox" sel={dpad.style === 'fixed'} />
        </div>

        <button id="qk-reset" className="qk-reset" {...resetTap}>
          Restaurar por defecto
        </button>
      </div>
    </div>
  )
}

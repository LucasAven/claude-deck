import { useEffect, useRef, useState } from 'react'
import { KEYS, QUICKKEY_CATALOG } from '../../lib/keys'
import { useTap } from '../../hooks/useTap'
import { useDeckStore } from '../../store'
import { openSnippetsMenu } from '../../lib/snippets'
import { openComposer } from '../../lib/composer'
import { openScrollback } from '../../lib/scrollback'
import { attachImage, sendPendingImage, hideImgChip } from '../../lib/image'
import { closeSwitchMenu, openDpadMenu } from '../../lib/switch'
import { SwitchMenu } from './SwitchMenu'

// Controlbar (index.html:88-133). Chip de imagen + popover switch-menu + la
// toolbox (una sola fila: d-pad, quickkeys/snippets/lector, compose). La lógica
// vive en las libs (switch/snippets/composer/image); acá se pinta y se cablea
// con useTap (preventDefault en pointerdown mantiene el foco del teclado
// virtual — §5.4, NO reemplazar por onClick).

// Íconos de la toolbox. Se exportan porque la "vista previa" del editor de
// teclas rápidas (QuickkeysSheet) pinta una copia en chico de esta misma fila:
// un solo svg por ícono, no dos copias que se desincronizan.
export const TOOL_ICONS = {
  dpad: (
    // un path por triángulo: el drag del botón resalta solo el de su dirección
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <circle cx="12" cy="12" r="2" />
      <path data-dir="up" d="M12 3l3 3.5H9z" />
      <path data-dir="down" d="M12 21l3-3.5H9z" />
      <path data-dir="left" d="M3 12l3.5-3v6z" />
      <path data-dir="right" d="M21 12l-3.5-3v6z" />
    </svg>
  ),
  snippets: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></svg>
  ),
  scrollback: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3.5" width="14" height="17" rx="3" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></svg>
  ),
  compose: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.7 3.8a2.1 2.1 0 0 1 3 3L7.5 19l-4 1 1-4z" /></svg>
  ),
  kbclose: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10l5 5 5-5" /></svg>
  ),
}

// Una quickkey: manda la secuencia cruda al terminal (app.js:301-339). El
// editor del riel (tarea 11b) ya no se abre por long-press: vive en el
// sheet de ajustes (engranaje de la fila de sesiones).
function QuickKey({ k, title, blocked, children }: { k: string; title?: string; blocked: () => boolean; children: React.ReactNode }) {
  const tap = useTap(() => {
    if (!blocked()) window.claudeConn?.sendKeys(KEYS[k])
  })
  return (
    <button data-k={k} title={title} {...tap}>
      {children}
    </button>
  )
}

type Dir = 'up' | 'down' | 'left' | 'right'
const DIR_ARROW: Record<Dir, string> = { up: '↑', down: '↓', left: '←', right: '→' }
const DPAD_TAP_SLOP = 8 // soltar sin pasar de acá abre/cierra el menú
const DPAD_DRAG_START = 14 // pasar de acá es un drag: manda flechas
const DPAD_REPEAT_MS = 120

// Botón del d-pad. Tap = toggle del menú (sin límite de tiempo: un tap lento
// también abre). Arrastrar más de DPAD_DRAG_START px desde donde apoyó el dedo
// manda la flecha del eje dominante una vez y la repite cada DPAD_REPEAT_MS
// mientras el dedo siga afuera; volver adentro pausa y salir de nuevo manda
// otra vez al instante. Soltar frena. El ×N del label cuenta solo la flecha
// actual. No usa useTap porque necesita el move con pointer capture, pero
// mantiene su preventDefault en pointerdown (el teclado virtual no se cierra).
function DpadButton({ active }: { active: boolean }) {
  const [drag, setDrag] = useState<{ dir: Dir; count: number } | null>(null)
  const startRef = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null)
  const dirRef = useRef<Dir | null>(null) // la que repite ahora; null = pausado en la zona muerta
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopRepeat = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    dirRef.current = null
  }
  useEffect(() => stopRepeat, [])

  const fire = (dir: Dir) => {
    window.claudeConn?.sendKeys(KEYS[dir])
    navigator.vibrate?.(5)
    setDrag((d) => ({ dir, count: d?.dir === dir ? d.count + 1 : 1 }))
  }

  const end = () => {
    stopRepeat()
    startRef.current = null
    setDrag(null)
  }
  // cancel y lostpointercapture solo cortan el drag de su propio dedo: con dos
  // dedos, el que suelta primero no mata el drag del otro
  const endFor = (e: React.PointerEvent) => {
    if (e.pointerId === startRef.current?.id) end()
  }

  return (
    <>
      {drag && (
        <div className="dpad-drag-label">
          <b className="dl-dir">{DIR_ARROW[drag.dir]}</b> <b>×{drag.count}</b>
          {'  '}soltá para parar
        </div>
      )}
      <button
        id="btn-dpad"
        className={'ctl-sq' + (active ? ' active' : '') + (drag ? ' dragging' : '')}
        data-dir={drag?.dir}
        title="D-pad"
        onPointerDown={(e) => {
          e.preventDefault()
          end()
          startRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false }
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* pointer sintético (tests) sin puntero activo */
          }
        }}
        onPointerMove={(e) => {
          const start = startRef.current
          if (!start || e.pointerId !== start.id) return
          const dx = e.clientX - start.x
          const dy = e.clientY - start.y
          const outside = Math.hypot(dx, dy) >= DPAD_DRAG_START
          if (!start.dragging) {
            if (!outside) return
            start.dragging = true
            closeSwitchMenu()
          }
          const dir: Dir | null = !outside
            ? null
            : Math.abs(dx) > Math.abs(dy)
              ? dx > 0 ? 'right' : 'left'
              : dy > 0 ? 'down' : 'up'
          if (dir === dirRef.current) return
          stopRepeat()
          if (!dir) return
          dirRef.current = dir
          fire(dir)
          timerRef.current = setInterval(() => fire(dir), DPAD_REPEAT_MS)
        }}
        onPointerUp={(e) => {
          const start = startRef.current
          if (!start || e.pointerId !== start.id) return
          const tap = !start.dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DPAD_TAP_SLOP
          end()
          if (tap) openDpadMenu()
        }}
        onPointerCancel={endFor}
        onLostPointerCapture={endFor}
      >
        {TOOL_ICONS.dpad}
      </button>
    </>
  )
}

export function ControlBar() {
  const imgChip = useDeckStore((s) => s.imgChip)
  const snippetsActive = useDeckStore((s) => s.switchMenu === 'snippets')
  const dpadActive = useDeckStore((s) => s.switchMenu === 'dpad')
  const quickkeys = useDeckStore((s) => s.quickkeys)
  const inputRef = useRef<HTMLInputElement>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState(false)
  // useTap ya ignora un arrastre (slop + pointercancel), pero el tap que frena
  // un scroll con inercia llega quieto: si la fila scrolleó hace <100ms al
  // apoyar el dedo, ese gesto no cuenta como tecla.
  const lastScrollAt = useRef(0)
  const downWhileScrolling = useRef(false)
  const blocked = () => downWhileScrolling.current
  const onRowPointerDown = () => {
    downWhileScrolling.current = performance.now() - lastScrollAt.current < 100
  }

  const updateFade = () => {
    const el = scrollRef.current
    if (el) setFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }
  const onScroll = () => {
    lastScrollAt.current = performance.now()
    updateFade()
  }
  // el ancho cambia con rotación, teclado y la config de teclas
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateFade)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(updateFade, [quickkeys])

  const snippetsTap = useTap(() => {
    if (!blocked()) openSnippetsMenu()
  })
  const composerTap = useTap(() => openComposer())
  // el foco lo tiene el textarea de xterm: soltarlo baja el teclado iOS
  const kbCloseTap = useTap(() => (document.activeElement as HTMLElement | null)?.blur())
  const scrollbackTap = useTap(() => {
    if (!blocked()) openScrollback()
  })

  const onImgInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) attachImage(f, 'Imagen adjunta')
    e.target.value = '' // permitir re-elegir el mismo archivo
  }

  return (
    <div className="controlbar">
      {/* chip de preview de imagen: tap en el chip envía, ✕ descarta (app.js:498-539) */}
      <div
        id="img-chip"
        className={'img-chip' + (imgChip ? '' : ' hidden') + (imgChip?.pending ? ' pending' : '')}
        onClick={() => sendPendingImage()}
      >
        <img id="img-chip-thumb" alt="" src={imgChip?.url} />
        <div className="img-chip-info">
          <div id="img-chip-title">{imgChip?.title}</div>
          <div id="img-chip-meta">{imgChip?.meta}</div>
          <div id="img-chip-hint">Tocá la imagen para enviarla · ✕ para descartar</div>
        </div>
        <button
          id="img-chip-close"
          title="Descartar"
          onClick={(e) => {
            e.stopPropagation() // que el ✕ no cuente como tap de "enviar"
            hideImgChip()
          }}
        >
          ✕
        </button>
      </div>

      <SwitchMenu onCamera={() => inputRef.current?.click()} />

      {/* toolbox: una sola fila. D-pad fijo a la izquierda, teclas + snippets +
          lector en el medio (scroll horizontal, la config de "Teclas rápidas"
          en su orden guardado) y Compose fijo a la derecha como botón principal
          (con teclado abierto lo reemplaza ⌄, que cierra el teclado; el swap es
          por CSS con body.kb-open).
          El fade del borde derecho solo está mientras queda contenido a la
          derecha: al final del scroll el último botón se ve entero. */}
      <div className="toolrow">
        <DpadButton active={dpadActive} />
        <input id="img-input" type="file" accept="image/*" className="hidden" ref={inputRef} onChange={onImgInput} />
        <div
          className={'quickkeys' + (fade ? ' fade' : '')}
          data-term="claude"
          ref={scrollRef}
          onScroll={onScroll}
          onPointerDownCapture={onRowPointerDown}
        >
          {quickkeys.map((id) => {
            const cat = QUICKKEY_CATALOG.find((c) => c.id === id)
            if (!cat) return null
            return (
              <QuickKey key={id} k={id} title={cat.desc} blocked={blocked}>
                {cat.label}
              </QuickKey>
            )
          })}
          <button id="btn-snippets" className={'ctl-sq' + (snippetsActive ? ' active' : '')} title="Snippets" {...snippetsTap}>
            {TOOL_ICONS.snippets}
          </button>
          <button id="btn-scrollback" className="ctl-sq" title="Vista de lectura (scrollback legible)" {...scrollbackTap}>
            {TOOL_ICONS.scrollback}
          </button>
        </div>
        <button id="btn-composer" className="ctl-compose" title="Componer prompt" {...composerTap}>
          {TOOL_ICONS.compose}
        </button>
        <button id="btn-kbclose" className="ctl-sq" title="Cerrar teclado" {...kbCloseTap}>
          {TOOL_ICONS.kbclose}
        </button>
      </div>
    </div>
  )
}

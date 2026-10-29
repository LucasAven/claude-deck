import { useEffect, useRef, useState } from 'react'
import { KEYS, QUICKKEY_CATALOG } from '../../lib/keys'
import { useTap } from '../../hooks/useTap'
import { useDeckStore } from '../../store'
import { openSnippetsMenu } from '../../lib/snippets'
import { openComposer } from '../../lib/composer'
import { openScrollback } from '../../lib/scrollback'
import { attachImage, sendPendingImage, hideImgChip } from '../../lib/image'
import { openDpadMenu } from '../../lib/switch'
import { SwitchMenu } from './SwitchMenu'

// Controlbar (index.html:88-133). Chip de imagen + popover switch-menu + la
// toolbox (una sola fila: d-pad, quickkeys/snippets/lector, compose). La lógica
// vive en las libs (switch/snippets/composer/image); acá se pinta y se cablea
// con useTap (preventDefault en pointerdown mantiene el foco del teclado
// virtual — §5.4, NO reemplazar por onClick).

// Una quickkey: manda la secuencia cruda al terminal (app.js:301-339). El
// editor de la barra (tarea 11b) ya no se abre por long-press: vive en el
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
  const dpadTap = useTap(() => openDpadMenu())
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
          en su orden guardado) y Compose fijo a la derecha como botón principal.
          El fade del borde derecho solo está mientras queda contenido a la
          derecha: al final del scroll el último botón se ve entero. */}
      <div className="toolrow">
        <button id="btn-dpad" className={'ctl-sq' + (dpadActive ? ' active' : '')} title="D-pad" {...dpadTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="12" r="2" /><path d="M12 3l3 3.5H9zM12 21l3-3.5H9zM3 12l3.5-3v6zM21 12l-3.5-3v6z" /></svg>
        </button>
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
              <QuickKey key={id} k={id} title={cat.title} blocked={blocked}>
                {cat.barLabel ?? cat.label}
              </QuickKey>
            )
          })}
          <button id="btn-snippets" className={'ctl-sq' + (snippetsActive ? ' active' : '')} title="Snippets" {...snippetsTap}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></svg>
          </button>
          <button id="btn-scrollback" className="ctl-sq" title="Vista de lectura (scrollback legible)" {...scrollbackTap}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3.5" width="14" height="17" rx="3" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></svg>
          </button>
        </div>
        <button id="btn-composer" className="ctl-compose" title="Componer prompt" {...composerTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.7 3.8a2.1 2.1 0 0 1 3 3L7.5 19l-4 1 1-4z" /></svg>
        </button>
      </div>
    </div>
  )
}

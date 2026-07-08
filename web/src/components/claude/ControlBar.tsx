import { useRef } from 'react'
import { KEYS, QUICKKEY_CATALOG } from '../../lib/keys'
import { useTap } from '../../hooks/useTap'
import { useDeckStore } from '../../store'
import { openModelMenu, openAttachMenu, cycleMode } from '../../lib/switch'
import { openSnippetsMenu } from '../../lib/snippets'
import { openComposer } from '../../lib/composer'
import { openScrollback } from '../../lib/scrollback'
import { attachImage, sendPendingImage, hideImgChip } from '../../lib/image'
import { SwitchMenu } from './SwitchMenu'

// Controlbar (index.html:88-133). Chip de imagen + popover switch-menu + fila
// de acciones (adjuntar/snippets/composer/scrollback + pill modelo·modo) + fila
// de quickkeys. La lógica vive en las libs (switch/snippets/composer/image);
// acá se pinta y se cablea con useTap (preventDefault en pointerdown mantiene el
// foco del teclado virtual — §5.4, NO reemplazar por onClick). El scrollback
// sigue inerte hasta la Fase 4.

// Una quickkey: manda la secuencia cruda al terminal (app.js:301-339). El
// editor de la barra (tarea 11b) ya no se abre por long-press: vive en el
// sheet de ajustes (engranaje de la fila de sesiones).
function QuickKey({ k, title, children }: { k: string; title?: string; children: React.ReactNode }) {
  const tap = useTap(() => window.claudeConn?.sendKeys(KEYS[k]))
  return (
    <button data-k={k} title={title} {...tap}>
      {children}
    </button>
  )
}

export function ControlBar() {
  const imgChip = useDeckStore((s) => s.imgChip)
  const snippetsActive = useDeckStore((s) => s.switchMenu === 'snippets')
  const quickkeys = useDeckStore((s) => s.quickkeys)
  const inputRef = useRef<HTMLInputElement>(null)

  const modeTap = useTap(() => cycleMode())
  const switchTap = useTap(() => openModelMenu())
  const attachTap = useTap(() => openAttachMenu())
  const snippetsTap = useTap(() => openSnippetsMenu())
  const composerTap = useTap(() => openComposer())
  const scrollbackTap = useTap(() => openScrollback())

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

      {/* rediseño: una sola fila de acciones — los 4 cuadrados + los botones
          Model (abre el menú de modelo/esfuerzo) y Mode (cicla con shift+tab).
          Labels fijos: el modelo/esfuerzo en uso los muestra la statusline. */}
      <div className="controlrow actions">
        <button id="btn-attach" className="ctl-sq" title="Adjuntar: cámara o portapapeles" {...attachTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <input id="img-input" type="file" accept="image/*" className="hidden" ref={inputRef} onChange={onImgInput} />
        <button id="btn-snippets" className={'ctl-sq' + (snippetsActive ? ' active' : '')} title="Snippets" {...snippetsTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6.5h16M4 12h16M4 17.5h16" /></svg>
        </button>
        <button id="btn-composer" className="ctl-sq" title="Componer prompt" {...composerTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.7 3.8a2.1 2.1 0 0 1 3 3L7.5 19l-4 1 1-4z" /></svg>
        </button>
        <button id="btn-scrollback" className="ctl-sq" title="Ponerse al día (scrollback legible)" {...scrollbackTap}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5h16M4 9.5h16M4 13.5h10" /><path d="M17 21v-6M14 17.8l3 3 3-3" /></svg>
        </button>
        <button id="btn-switch" className="switch-pill" title="Modelo y esfuerzo" {...switchTap}>
          <span className="model-star">✦</span>
          <span>Model</span>
        </button>
        <button id="btn-mode" className="switch-pill" title="Ciclar modo (shift+tab)" {...modeTap}>
          <span>Mode</span>
          <span className="pill-chev">⇅</span>
        </button>
      </div>

      {/* tarea 11b: la fila sale del store (deck-quickkeys en localStorage);
          el default conserva el orden histórico (nl primero — app.js:249).
          El editor se abre desde Ajustes. Rediseño: las teclas se reparten el
          ancho (sin scroll con la barra default); si configurás más de las que
          entran, el overflow-x de .quickkeys vuelve como rescate. */}
      <div className="controlrow quickkeys" data-term="claude">
        {quickkeys.map((id) => {
          const cat = QUICKKEY_CATALOG.find((c) => c.id === id)
          if (!cat) return null
          return (
            <QuickKey key={id} k={id} title={cat.title}>
              {cat.barLabel ?? cat.label}
            </QuickKey>
          )
        })}
      </div>
    </div>
  )
}

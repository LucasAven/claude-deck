import { useLayoutEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { sbApplyFont, sbLoadMore, closeScrollback, takeScrollbackAnchor } from '../../lib/scrollback'

// Scrollback legible (index.html:74-86). SIEMPRE montado, se togglea con hidden.
// El contenido se pinta desde el store (lib/scrollback.ts); el ancla de lectura
// se restaura en useLayoutEffect —antes del paint del navegador— para que
// "cargar más" no salte la posición (§5.6). El font sale de --sb-font (A−/A+).
// Los botones usan useTap como el vanilla (onTap en wireScrollback).
export function Scrollback() {
  const open = useDeckStore((s) => s.scrollbackOpen)
  const sb = useDeckStore((s) => s.scrollback)
  const bodyRef = useRef<HTMLDivElement>(null)

  const smallerTap = useTap(() => sbApplyFont(-1))
  const biggerTap = useTap(() => sbApplyFont(1))
  const closeTap = useTap(() => closeScrollback())
  const moreTap = useTap(() => sbLoadMore())

  // restaurar el ancla capturada por el lib justo antes de este repintado:
  // al fondo en la carga inicial, compensada cuando "cargar más" mete arriba
  useLayoutEffect(() => {
    const a = takeScrollbackAnchor()
    const body = bodyRef.current
    if (!a || !body) return
    body.scrollTop = a.keepAnchor ? body.scrollHeight - a.prevH + a.prevTop : body.scrollHeight
  }, [sb.renderNonce])

  return (
    <div
      id="scrollback"
      className={'scrollback' + (open ? '' : ' hidden')}
      style={{ '--sb-font': `${sb.font}px` } as React.CSSProperties}
    >
      <div className="scrollback-head">
        <div className="scrollback-title">
          <span id="scrollback-session">{sb.session}</span>{' '}
          <span id="scrollback-src" className="muted">
            {sb.srcLabel}
          </span>
        </div>
        <button id="scrollback-smaller" className="icon-btn" title="Letra más chica" {...smallerTap}>
          A−
        </button>
        <button id="scrollback-bigger" className="icon-btn" title="Letra más grande" {...biggerTap}>
          A+
        </button>
        <button id="scrollback-close" className="icon-btn" title="Cerrar" {...closeTap}>
          ✕
        </button>
      </div>
      <div id="scrollback-body" className="scroll" ref={bodyRef}>
        <button id="scrollback-more" className={'scrollback-more' + (sb.moreVisible ? '' : ' hidden')} {...moreTap}>
          Cargar más
        </button>
        <div id="scrollback-turns" className={sb.mode === 'turns' ? '' : 'hidden'}>
          {sb.mode === 'turns' &&
            sb.turns.map((t, i) =>
              // el asistente es markdown sanitizado (dangerouslySetInnerHTML con
              // la misma dupla marked+DOMPurify que Archivos .md); user/tool plano
              t.html !== null ? (
                <div
                  key={i}
                  className={`sb-turn sb-${t.role} md-body`}
                  dangerouslySetInnerHTML={{ __html: t.html }}
                />
              ) : (
                <div key={i} className={`sb-turn sb-${t.role}`}>
                  {t.text}
                </div>
              ),
            )}
        </div>
        <pre id="scrollback-text" className={sb.mode === 'text' ? '' : 'hidden'}>
          {sb.mode === 'text' ? sb.text : ''}
        </pre>
      </div>
    </div>
  )
}

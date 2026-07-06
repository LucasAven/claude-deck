import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { beginSnipHold, showSnipTip, hideSnipTip, snipTip } from '../../lib/sniptip'
import { insertSnippet, snippetAdd, snippetRename, snippetDelete, snippetMove, setSnippetsEditing } from '../../lib/snippets'

// Paleta de snippets (app.js:932-1009): header (Snippets · Editar) + grilla 2
// col con "+ Nuevo". Compartida por el popover (#switch-menu) y el panel del
// composer (#composer-snips) — insertSnippet decide dónde va según composerIsOpen.

const TAP_SLOP = 12

function SnipChip({ text, i, editing }: { text: string; i: number; editing: boolean }) {
  const chipRef = useRef<HTMLButtonElement>(null)
  const spanRef = useRef<HTMLSpanElement>(null)
  const start = useRef<{ id: number; x: number; y: number } | null>(null)
  const truncated = () => {
    const s = spanRef.current
    return !!s && s.scrollWidth > s.clientWidth + 1
  }

  // combina el tap con tolerancia al scroll (useTap) con la lógica de tooltip
  // (hover en desktop, long-press en touch) sobre el mismo chip. Los controles
  // (◀ / ✕) burbujean hasta acá: se resuelven por e.target, sin handlers propios.
  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && truncated()) showSnipTip(chipRef.current!, text)
  }
  const onPointerLeave = () => hideSnipTip()
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault() // mantiene el foco (teclado virtual) — §5.4
    start.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    beginSnipHold(chipRef.current!, text, truncated)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    hideSnipTip()
    const s = start.current
    start.current = null
    if (!s || e.pointerId !== s.id) return
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP) return
    if (snipTip.suppressTap) return // release de un peek (long-press), no un tap
    const t = e.target as HTMLElement
    if (t.closest('.snip-move')) snippetMove(i)
    else if (t.closest('.snip-x')) snippetDelete(i)
    else if (editing) snippetRename(i)
    else insertSnippet(text)
  }
  const onPointerCancel = () => {
    start.current = null
    hideSnipTip()
  }

  return (
    <button
      ref={chipRef}
      className="snip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span ref={spanRef} className="snip-text">
        {text}
      </span>
      {editing && i > 0 && (
        <span className="snip-move" title="Mover antes">
          ◀
        </span>
      )}
      {editing && (
        <span className="snip-x" title="Borrar">
          ✕
        </span>
      )}
    </button>
  )
}

export function SnippetsPalette() {
  const snippets = useDeckStore((s) => s.snippets)
  const editing = useDeckStore((s) => s.snippetsEditing)
  const editTap = useTap(() => setSnippetsEditing(!editing))
  const addTap = useTap(() => snippetAdd())

  // un re-render reemplaza/reordena los chips: el pointerleave del tooltip
  // podría no llegar (app.js:935). Ocultarlo cuando la lista o el modo cambian.
  useEffect(() => hideSnipTip(), [snippets, editing])

  return (
    <>
      <div className="snip-head">
        <span className="snip-title">Snippets</span>
        {snippets && (
          <button className="snip-edit" {...editTap}>
            {editing ? 'Listo' : 'Editar'}
          </button>
        )}
      </div>
      {!snippets ? (
        <div className="empty-state">No se pudieron cargar los snippets</div>
      ) : (
        <div className="mi-snippets">
          {snippets.map((text, i) => (
            <SnipChip key={i} text={text} i={i} editing={editing} />
          ))}
          <button className="snip snip-new" {...addTap}>
            + Nuevo
          </button>
        </div>
      )}
    </>
  )
}

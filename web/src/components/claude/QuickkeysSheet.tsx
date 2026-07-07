import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { QUICKKEY_CATALOG } from '../../lib/keys'
import {
  closeQuickkeysSheet,
  addQuickkey,
  removeQuickkey,
  moveQuickkeyEarlier,
  resetQuickkeys,
} from '../../lib/quickkeys'

// Editor de la barra de quickkeys (tarea 11b). Bottom sheet con el esqueleto
// del host-sheet (siempre montado, toggle hidden, backdrop cierra). Se abre con
// long-press sobre cualquier tecla de la barra. Edición estilo snippets: los
// chips de "En la barra" tienen ◀ (mover un lugar antes; el primero no lo
// muestra) y ✕ (sacar; la última tecla no lo muestra — sin teclas no habría
// dónde hacer long-press para volver acá); los del catálogo agregan al final.
// Cada cambio persiste al instante en localStorage (deck-quickkeys). TODO va
// con useTap, nunca onClick: el sheet se cierra sobre la controlbar y un click
// fantasma sobre lo que quede debajo repetiría el bug de las tareas 20/27.

function BarChip({ id, label, first, last }: { id: string; label: string; first: boolean; last: boolean }) {
  const moveTap = useTap(() => moveQuickkeyEarlier(id))
  const delTap = useTap(() => removeQuickkey(id))
  return (
    <span className="qk-chip" data-qk={id}>
      {!first && (
        <button className="qk-act qk-move" title="Mover antes" {...moveTap}>
          ◀
        </button>
      )}
      <span className="qk-chip-label">{label}</span>
      {!last && (
        <button className="qk-act qk-del" title="Sacar de la barra" {...delTap}>
          ✕
        </button>
      )}
    </span>
  )
}

function CatalogChip({ id, label, title }: { id: string; label: string; title: string }) {
  const addTap = useTap(() => addQuickkey(id))
  return (
    <button className="qk-chip qk-add" data-qk={id} title={title} {...addTap}>
      + {label}
    </button>
  )
}

export function QuickkeysSheet() {
  const open = useDeckStore((s) => s.quickkeysSheetOpen)
  const list = useDeckStore((s) => s.quickkeys)
  const resetTap = useTap(() => resetQuickkeys())

  const inBar = list
    .map((id) => QUICKKEY_CATALOG.find((c) => c.id === id))
    .filter((c): c is (typeof QUICKKEY_CATALOG)[number] => !!c)
  const available = QUICKKEY_CATALOG.filter((c) => !list.includes(c.id))

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
        <div className="host-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="6" width="19" height="12" rx="2" />
            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
          </svg>
          <span>Teclas rápidas</span>
        </div>
        <div className="qk-label">En la barra</div>
        <div id="qk-current" className="qk-chips">
          {inBar.map((c, i) => (
            <BarChip key={c.id} id={c.id} label={c.label} first={i === 0} last={inBar.length === 1} />
          ))}
        </div>
        <div className="qk-label">Agregar</div>
        <div id="qk-catalog" className="qk-chips">
          {available.map((c) => (
            <CatalogChip key={c.id} id={c.id} label={c.label} title={c.title} />
          ))}
          {!available.length && <span className="qk-empty">Todas en la barra</span>}
        </div>
        <button id="qk-reset" className="qk-reset" {...resetTap}>
          Restaurar por defecto
        </button>
      </div>
    </div>
  )
}

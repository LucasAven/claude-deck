import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { ctxLevel, ctxRemaining, fmtTokens, fmtCost } from '../../lib/status'

// Statusline del panel (tarea 22): línea fina y discreta (mono) arriba de la
// barra de quickkeys, tipo el statusLine de Claude Code. Muestra el % de
// contexto RESTANTE (Lucas 2026-07-07: prefiere "cuánto queda" sobre "cuánto
// usé" — se invierte en el display, el endpoint sigue exponiendo el usado) +
// tokens de input; y modelo y costo de la sesión (que vienen gratis en el mismo
// JSON del hook). Color de alerta cuando queda POCO contexto (ctxLevel:
// ok/warn/alert). Oculta si no hay datos (hook inactivo).
//
// Como el host-banner, le roba/devuelve una fila a la terminal al aparecer/
// desaparecer → fit() en el cambio de visibilidad (§5.5). El % puede ser null
// antes del primer turno: ahí mostramos solo modelo/tokens.
export function Statusline() {
  const s = useDeckStore((st) => st.claudeStatus)
  const show = !!s
  const level = ctxLevel(s)
  const rem = ctxRemaining(s) // % restante (Lucas lo prefiere sobre el usado)
  const cost = fmtCost(s?.costUsd ?? null)

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    requestAnimationFrame(() => window.claudeConn?.fit())
  }, [show])

  return (
    <div id="statusline" className={'statusline sl-' + level + (show ? '' : ' hidden')}>
      <span className="sl-ctx">
        <span className="sl-label">ctx restante</span>{' '}
        <span id="sl-pct">{rem != null ? `${rem}%` : '—'}</span>
      </span>
      <span className="sl-sep">·</span>
      <span id="sl-tokens" className="sl-tokens">
        {fmtTokens(s?.inputTokens ?? null)} tok
      </span>
      {s?.model && (
        <>
          <span className="sl-sep">·</span>
          <span id="sl-model" className="sl-model">
            {s.model}
          </span>
        </>
      )}
      {cost && (
        <>
          <span className="sl-sep">·</span>
          <span id="sl-cost" className="sl-cost">
            {cost}
          </span>
        </>
      )}
    </div>
  )
}

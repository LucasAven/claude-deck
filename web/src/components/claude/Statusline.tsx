import { useDeckStore } from '../../store'
import { ctxLevel, ctxRemaining, fmtTokens } from '../../lib/status'
import { battLow, openHostSheet } from '../../lib/host'
import { useTap } from '../../hooks/useTap'

// Statusline del panel (tarea 22): línea fina y discreta (mono) arriba de la
// barra de quickkeys, tipo el statusLine de Claude Code. A la izquierda, el % de
// contexto RESTANTE (Lucas 2026-07-07: prefiere "cuánto queda" sobre "cuánto
// usé" — se invierte en el display, el endpoint sigue exponiendo el usado) +
// tokens de input y modelo (el costo se retiró: no le interesa). Color de
// alerta cuando queda POCO contexto (ctxLevel: ok/warn/alert); esos segmentos
// se ocultan si no hay datos (hook inactivo).
//
// A la derecha viven el chip de batería del host y el punto de conexión (antes
// en la fila de sesiones): como el host es el único camino al tailnet, acá se
// ve de un vistazo batería + estado del enlace. La línea está SIEMPRE visible
// (ya no roba/devuelve filas → no hace falta el fit() por visibilidad, §5.5).
export function Statusline() {
  const s = useDeckStore((st) => st.claudeStatus)
  const connected = useDeckStore((st) => st.connected)
  const hostStatus = useDeckStore((st) => st.hostStatus)
  const level = ctxLevel(s)
  const rem = ctxRemaining(s) // % restante (Lucas lo prefiere sobre el usado)

  // el chip de host va con useTap (no onClick): un onClick se dispara con el
  // `click` fantasma que el navegador sintetiza tras un tap táctil, y al cerrar
  // un overlay tocando su ✕ ese click fantasma caía acá y abría el host-sheet
  // solo (tarea 20). useTap solo escucha pointer events, así que lo ignora.
  const hostChipTap = useTap(() => openHostSheet())

  // chip 🔋 solo si el host reporta batería (Mac de escritorio / pmset ilegible
  // → null); la barrita interna del ícono refleja el nivel (ancho útil 13.2px)
  const batt = hostStatus?.battery
  const fillW = batt ? Math.max(0.8, (13.2 * batt.pct) / 100).toFixed(1) : '0'

  return (
    <div id="statusline" className={'statusline sl-' + level}>
      {s && (
        <>
          <span className="sl-ctx">
            <span className="sl-label">ctx restante</span>{' '}
            <span id="sl-pct">{rem != null ? `${rem}%` : '—'}</span>
          </span>
          <span className="sl-sep">·</span>
          <span id="sl-tokens" className="sl-tokens">
            {fmtTokens(s.inputTokens)} tok
          </span>
          {s.model && (
            <>
              <span className="sl-sep">·</span>
              <span id="sl-model" className="sl-model">
                {s.model}
              </span>
            </>
          )}
        </>
      )}
      <span className="sl-right">
        {/* chip de batería del host: tap abre el sheet (mismos id/clases de siempre) */}
        <button
          id="host-chip"
          className={'sl-batt' + (batt ? '' : ' hidden') + (battLow(hostStatus) ? ' warn' : '')}
          title="Estado de la Mac"
          {...hostChipTap}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7.5" width="17" height="9" rx="2.5" />
            <path d="M22 10.5v3" />
            <rect id="host-batt-fill" x="4.2" y="9.7" width={fillW} height="4.6" rx="1" fill="currentColor" stroke="none" />
          </svg>
          <span id="host-chip-pct">{batt ? `${batt.pct}%` : ''}</span>
        </button>
        <span className={'conn' + (connected ? ' on' : '')} id="conn-claude">
          <span className="dot" />
        </span>
      </span>
    </div>
  )
}

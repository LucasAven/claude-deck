import { useDeckStore } from '../../store'
import { ctxLevel, ctxRemaining, fmtTokens } from '../../lib/status'
import { battLow, openHostSheet } from '../../lib/host'
import { openModelMenu, cycleMode } from '../../lib/switch'
import { MODES } from '../../lib/mode'
import { useTap } from '../../hooks/useTap'

// Statusline del panel (tarea 22): línea fina y discreta (mono) arriba de la
// barra de quickkeys, tipo el statusLine de Claude Code. A la izquierda, el % de
// contexto RESTANTE (Lucas 2026-07-07: prefiere "cuánto queda" sobre "cuánto
// usé" — se invierte en el display, el endpoint sigue exponiendo el usado) +
// tokens de input, modelo y esfuerzo (el costo se retiró: no le interesa).
// Sin labels: "96% · 84k" (Lucas 2026-10-28 sacó "ctx" y "tok" para que
// entren junto a los chips; el número sigue siendo el restante).
// El esfuerzo (también tarea 28) sale de switchState.effort, señal BLANDA:
// refleja lo elegido en el SwitchMenu del deck (persistido por sesión en
// deck-switch:<sesión>), no lo que Claude corre realmente si el effort se
// cambió por fuera del panel. No hay fuente dura: ni el JSON del hook
// statusLine ni el transcript lo exponen (verificado 2026-07-09; Lucas aceptó
// la fuente blanda ese día). Se muestra solo si está definido, colgado del
// modelo ("Opus 4.8 · high"). Color de
// alerta cuando queda POCO contexto (ctxLevel: ok/warn/alert); esos segmentos
// se ocultan si no hay datos (hook inactivo).
//
// A la derecha vive el chip de batería del host (antes en la fila de
// sesiones). El punto de conexión se retiró (Lucas 2026-10-28, para ganar
// ancho): con el WS caído la línea entera se atenúa (sl-off). La línea está
// SIEMPRE visible (ya no roba/devuelve filas → no hace falta el fit() por
// visibilidad, §5.5).
//
// Modelo y modo son chips tocables (mudados de la fila de acciones de la
// controlbar): #btn-switch abre el menú de modelo/esfuerzo y #btn-mode manda un
// shift+tab. El chip de modo muestra el último modo leído del footer de la
// terminal, con el color de Claude (lib/mode), y "mode" hasta ver uno. Los
// chips se pintan aunque no haya datos (si no, sin hook no habría cómo cambiar
// de modelo); lo que se acorta con "…" cuando falta ancho es ctx/tokens.
export function Statusline() {
  const s = useDeckStore((st) => st.claudeStatus)
  const connected = useDeckStore((st) => st.connected)
  const hostStatus = useDeckStore((st) => st.hostStatus)
  const level = ctxLevel(s)
  const rem = ctxRemaining(s) // % restante (Lucas lo prefiere sobre el usado)
  // esfuerzo elegido en el SwitchMenu (fuente blanda, ver cabecera)
  const effort = useDeckStore((st) => st.switchState.effort)
  // último modo leído del footer de la terminal (lib/mode); null → "mode"
  const mode = useDeckStore((st) => st.claudeMode)

  // el chip de host va con useTap (no onClick): un onClick se dispara con el
  // `click` fantasma que el navegador sintetiza tras un tap táctil, y al cerrar
  // un overlay tocando su ✕ ese click fantasma caía acá y abría el host-sheet
  // solo (tarea 20). useTap solo escucha pointer events, así que lo ignora.
  const hostChipTap = useTap(() => openHostSheet())
  const switchTap = useTap(() => openModelMenu())
  const modeTap = useTap(() => cycleMode())

  // chip 🔋 solo si el host reporta batería (Mac de escritorio / pmset ilegible
  // → null); la barrita interna del ícono refleja el nivel (ancho útil 13.2px)
  const batt = hostStatus?.battery
  const fillW = batt ? Math.max(0.8, (13.2 * batt.pct) / 100).toFixed(1) : '0'

  return (
    <div id="statusline" className={'statusline sl-' + level + (connected ? '' : ' sl-off')}>
      <span className="sl-info">
        {s && (
          <>
            <span className="sl-ctx">
              <span id="sl-pct">{rem != null ? `${rem}%` : '—'}</span>
            </span>
            <span className="sl-sep"> · </span>
            <span id="sl-tokens" className="sl-tokens">
              {fmtTokens(s.inputTokens)}
            </span>
          </>
        )}
      </span>
      <span className="sl-right">
        <button id="btn-switch" className="sl-chip" title="Modelo y esfuerzo" {...switchTap}>
          <span className="sl-star">✦</span>
          <span id="sl-model">{s?.model ?? 'Model'}</span>
          {effort && (
            <>
              <span className="sl-sep">·</span>
              <span id="sl-effort">{effort}</span>
            </>
          )}
          <span className="sl-chev">▾</span>
        </button>
        <button id="btn-mode" className="sl-chip" title="Ciclar modo (shift+tab)" {...modeTap}>
          <span id="sl-mode" style={mode ? { color: MODES[mode].color } : undefined}>
            {mode ? MODES[mode].word : 'mode'}
          </span>
          <span className="sl-chev">▾</span>
        </button>
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
      </span>
    </div>
  )
}

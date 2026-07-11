import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { BATT_STATES, fmtUptime, closeHostSheet, toggleHostAlert, editHostThreshold, toggleAway } from '../../lib/host'

// iconos de las filas del sheet (markup 100% estático, como FT_ICONS)
const svg = (body: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {body}
  </svg>
)
const HOST_ICONS = {
  batt: svg(
    <>
      <rect x="2" y="7.5" width="17" height="9" rx="2.5" />
      <path d="M22 10.5v3" />
      <path d="M6 10.5v3M9.5 10.5v3" />
    </>,
  ),
  power: svg(<path d="M13 2.5L4.5 13.5h6l-1.5 8L17.5 10h-6z" />),
  sleep: svg(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />),
  uptime: svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
  ),
  crd: svg(
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.8" />
      <path d="M9 20h6M12 16.5V20" />
      <path d="M8.5 10.5l2.5 2.5 4.5-4.5" />
    </>,
  ),
}

function HostRow({ icon, label, value, valueCls }: { icon: keyof typeof HOST_ICONS; label: string; value: string; valueCls?: string }) {
  return (
    <div className="host-row">
      <span className="host-ico">{HOST_ICONS[icon]}</span>
      <span className="host-label">{label}</span>
      <span className={'host-val' + (valueCls ? ` ${valueCls}` : '')}>{value}</span>
    </div>
  )
}

// Panel de host (index.html:166-184): bottom sheet al tocar el chip de batería.
// SIEMPRE montado, se togglea con hidden. Tap en el fondo oscurecido (no en el
// panel) cierra. Las filas salen del último /api/host/status del store.
export function HostSheet() {
  const open = useDeckStore((s) => s.hostSheetOpen)
  const h = useDeckStore((s) => s.hostStatus)

  // toggle y umbral con useTap como el vanilla (wireHost); el chip, el backdrop
  // y el ✕ del banner van por click directo (así los cablea el vanilla también)
  const toggleTap = useTap(() => toggleHostAlert())
  const thresholdTap = useTap(() => editHostThreshold())
  const awayTap = useTap(() => toggleAway())

  const b = h?.battery

  return (
    <div
      id="host-sheet"
      className={'host-sheet' + (open ? '' : ' hidden')}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeHostSheet()
      }}
    >
      <div className="host-sheet-panel">
        <div className="sheet-grip" />
        <div className="host-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.5" y="5" width="17" height="11" rx="1.8" />
            <path d="M2 19h20" />
          </svg>
          <span id="host-name">{h?.name || 'Mac'}</span>
        </div>
        <div id="host-rows">
          {h && (
            <>
              <HostRow
                icon="batt"
                label="Batería"
                value={b ? `${b.pct}% · ${BATT_STATES[b.state] || b.state}` : 'sin batería'}
                valueCls={b && b.state === 'discharging' ? 'warn' : ''}
              />
              <HostRow icon="power" label="Energía" value={h.ac === null ? '—' : h.ac ? 'Corriente' : 'En batería'} />
              <HostRow
                icon="sleep"
                label="Reposo (pmset)"
                value={h.sleepDisabled === null ? '—' : h.sleepDisabled ? 'Activo · no dormirá' : 'Normal · puede dormir'}
                valueCls={h.sleepDisabled ? 'good' : ''}
              />
              <HostRow icon="uptime" label="Uptime" value={fmtUptime(h.uptime)} />
              {h.crd && h.crd !== 'absent' && (
                <HostRow
                  icon="crd"
                  label="Acceso remoto (CRD)"
                  value={h.crd === 'running' ? 'Corriendo' : 'Caído'}
                  valueCls={h.crd === 'running' ? 'good' : 'warn'}
                />
              )}
            </>
          )}
        </div>
        {h && (
          <div className="host-alert" id="host-away">
            <div className="host-alert-info">
              <div className="host-alert-label">Modo away</div>
              <div className="host-alert-sub">
                {h.crd && h.crd !== 'absent' ? 'No dormir + CRD listo (deck away)' : 'La Mac no duerme (deck away)'}
              </div>
            </div>
            <button
              id="host-away-toggle"
              className={'switch' + (h.sleepDisabled ? ' on' : '')}
              role="switch"
              title="Modo away"
              {...awayTap}
            />
          </div>
        )}
        <div className="host-alert">
          <div className="host-alert-info">
            <div className="host-alert-label">
              Avisarme bajo{' '}
              <button id="host-threshold" className="host-threshold" {...thresholdTap}>
                {h ? `${h.alert.threshold}%` : ''}
              </button>
            </div>
            <div className="host-alert-sub">Push proactivo si queda en batería</div>
          </div>
          <button
            id="host-alert-toggle"
            className={'switch' + (h?.alert.enabled ? ' on' : '')}
            role="switch"
            title="Alerta de batería"
            {...toggleTap}
          />
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { battLow, dismissHostBanner } from '../../lib/host'

// Banner de batería (index.html:39-41): solo descargando bajo el umbral y sin
// descartar. Le come filas a la terminal → fit al mostrar/ocultar (como el hint,
// §5.5). El ✕ lo descarta por episodio (se re-arma en refreshHost al salir).
export function HostBanner() {
  const hostStatus = useDeckStore((s) => s.hostStatus)
  const dismissed = useDeckStore((s) => s.hostBannerDismissed)
  const show = battLow(hostStatus) && !dismissed
  const pct = hostStatus?.battery?.pct

  // fit solo cuando la visibilidad cambia (no en el mount inicial): el banner
  // roba/devuelve filas y tmux repinta todo en cada resize
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    requestAnimationFrame(() => window.claudeConn?.fit())
  }, [show])

  return (
    <div id="host-banner" className={'hint host-banner' + (show ? '' : ' hidden')}>
      <span className="host-banner-warn">⚠</span> La Mac está{' '}
      <b>
        en batería (<span id="host-banner-pct">{pct}</span>%)
      </b>
      . Si se agota perdés el acceso al tailnet. Enchufala o cerrá lo que no uses.{' '}
      <span className="hint-close" id="host-banner-close" onClick={() => dismissHostBanner()}>
        ✕
      </span>
    </div>
  )
}

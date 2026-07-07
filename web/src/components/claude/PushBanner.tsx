import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'

// Banner de pushes perdidas (tarea 26): web push es la ÚNICA vía de
// notificación desde que ntfy se retiró — si la suscripción se cae (Apple la
// rota, PWA reinstalada) los avisos se pierden en silencio. El server cuenta
// cada envío sin entrega (pushMissed en /api/host/status, poll de 8 s) y acá
// se muestra. Se oculta si ESTE dispositivo está suscripto ('on'): suscribirse
// resetea el contador server-side, pero el hostStatus viejo tarda un poll en
// reflejarlo. El ✕ descarta el count actual; más perdidas después → reaparece.
// Mismo patrón que HostBanner: roba filas a la terminal → fit al cambiar.
export function PushBanner() {
  const hostStatus = useDeckStore((s) => s.hostStatus)
  const pushState = useDeckStore((s) => s.pushState)
  const dismissedCount = useDeckStore((s) => s.pushBannerDismissedCount)
  const missed = hostStatus?.pushMissed ?? null
  const show = !!missed && missed.count > dismissedCount && pushState !== 'on'

  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    requestAnimationFrame(() => window.claudeConn?.fit())
  }, [show])

  return (
    <div id="push-banner" className={'hint host-banner' + (show ? '' : ' hidden')}>
      <span className="host-banner-warn">🔕</span> <b>{missed?.count ?? 0} aviso{(missed?.count ?? 0) === 1 ? '' : 's'} sin
      entregar</b>: no hay ninguna suscripción de notificaciones viva. Tocá la campanita para reactivarlas.{' '}
      <span
        className="hint-close"
        id="push-banner-close"
        onClick={() => useDeckStore.setState({ pushBannerDismissedCount: missed?.count ?? 0 })}
      >
        ✕
      </span>
    </div>
  )
}

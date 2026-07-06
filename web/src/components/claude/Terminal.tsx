import { useEffect, useRef } from 'react'
import { useDeckStore } from '../../store'
import { getClaudeConn, wireTouchScroll, wirePinchZoom } from '../../lib/term'

// Contenedor #term-claude (index.html:42). En un efecto —una sola vez— crea el
// singleton de conexión (lib/term.ts), lo abre sobre el div y cablea el scroll
// táctil. La vista Claude NUNCA se desmonta (§5.1): si React sacara este div se
// perdería el buffer de xterm y se duplicaría el attach al volver.
//
// El singleton necesita una sesión elegida para el primer attach, así que se
// crea recién cuando session deja de ser null (restoreInitialSession corre async
// en el arranque). El guard `created` garantiza que sea una sola vez; los
// cambios de sesión posteriores van por claudeConn.reconnect(), no por re-mount.
export function Terminal() {
  const ref = useRef<HTMLDivElement>(null)
  const created = useRef(false)
  const session = useDeckStore((s) => s.session)

  useEffect(() => {
    if (created.current || !session || !ref.current) return
    created.current = true
    getClaudeConn(ref.current)
    wireTouchScroll(ref.current, () => window.claudeConn)
    wirePinchZoom(ref.current, () => window.claudeConn)
  }, [session])

  return <div id="term-claude" className="term-wrap" ref={ref} />
}

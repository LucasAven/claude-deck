import { useEffect } from 'react'
import { useDeckStore } from '../store'

// Auto-refresh cada 8 s mientras la pestaña esté visible + manejo de
// visibilitychange (app.js:2185-2208). refreshGit corre en cualquier tab para
// mantener al día el badge de Cambios.
//
// Fase 1: solo presencia (sendVis) + git. sessions/host/tree se suman cuando sus
// refreshers existan (Fases 2/4/5) — ver docs/REACT-PORT.md §3, Fase 1.
export function usePolling() {
  useEffect(() => {
    const { refreshGit } = useDeckStore.getState()

    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.claudeConn?.sendVis() // re-afirmar presencia: el server la expira a los 25 s
      refreshGit()
      // Fase 2/4/5: refreshHost(); if (tab==='claude') refreshSessions();
      //             if (tab==='files') refreshTree(false)
    }, 8000)

    const onVis = () => {
      // presencia: avisar también el pasaje a hidden — iOS congela la página
      // después de este evento, es la última chance de decir "no miro más"
      window.claudeConn?.sendVis()
      if (document.visibilityState === 'visible') {
        refreshGit()
        // iOS suele matar los WS en background: reconectar sin esperar backoff
        window.claudeConn?.resume()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
}

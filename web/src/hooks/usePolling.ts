import { useEffect } from 'react'
import { useDeckStore } from '../store'

// Auto-refresh cada 8 s mientras la pestaña esté visible + manejo de
// visibilitychange (app.js:2185-2208). refreshGit corre en cualquier tab para
// mantener al día el badge de Cambios.
//
// Fase 1: presencia (sendVis) + git. Fase 2 suma sessions (solo en la tab
// claude). host/tree se suman en las Fases 4/5 — ver docs/REACT-PORT.md §3.
export function usePolling() {
  useEffect(() => {
    const { refreshGit, refreshSessions } = useDeckStore.getState()

    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.claudeConn?.sendVis() // re-afirmar presencia: el server la expira a los 25 s
      refreshGit()
      if (useDeckStore.getState().activeTab === 'claude') refreshSessions()
      // Fase 4/5: refreshHost(); if (tab==='files') refreshTree(false)
    }, 8000)

    const onVis = () => {
      // presencia: avisar también el pasaje a hidden — iOS congela la página
      // después de este evento, es la última chance de decir "no miro más"
      window.claudeConn?.sendVis()
      if (document.visibilityState === 'visible') {
        refreshGit()
        refreshSessions()
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

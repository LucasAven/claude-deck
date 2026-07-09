/// <reference types="vite/client" />

// Puente para ui-test.mjs y para que el terminal (singleton de módulo) sea
// alcanzable fuera de React. La forma completa la implementa lib/term.ts;
// los callers usan `window.claudeConn?.` porque puede no estar montado aún.
interface ClaudeConn {
  term: import('@xterm/xterm').Terminal
  sendKeys: (data: string) => void
  setStatusBar: (on: boolean) => void
  fit: (force?: boolean) => void
  reconnect: () => void
  sendVis: () => void
  resume: () => void
  currentSession: () => string | null
}

interface Window {
  claudeConn?: ClaudeConn
  // puentes para ui-test.mjs: el test mockea fetch y llama estos refreshers
  // globales (como en el vanilla) para probar árbol / semáforo / host
  refreshTree?: (force: boolean) => Promise<void>
  refreshSessions?: () => Promise<void>
  refreshHost?: () => Promise<void>
  refreshClaudeStatus?: () => Promise<void>
  // puente para ui-test.mjs (tarea 23): setear el estado del opt-in de Web Push
  // y disparar el toggle sin depender de las APIs reales (SW/PushManager)
  __deckPush?: {
    setState: (v: 'unsupported' | 'off' | 'on' | 'denied') => void
    toggle: () => void
  }
}

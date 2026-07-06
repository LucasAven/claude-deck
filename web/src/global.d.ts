/// <reference types="vite/client" />

// Puente para ui-test.mjs y para que el terminal (singleton de módulo, Fase 2)
// sea alcanzable fuera de React. La forma completa la implementa lib/term.ts en
// la Fase 2 — ver docs/REACT-PORT.md §5.9. Opcional acá porque en la Fase 1 el
// terminal todavía no existe y los callers usan `window.claudeConn?.`.
interface ClaudeConn {
  term: import('@xterm/xterm').Terminal
  sendKeys: (data: string) => void
  fit: () => void
  reconnect: () => void
  sendVis: () => void
  resume: () => void
  currentSession: () => string | null
}

interface Window {
  claudeConn?: ClaudeConn
}

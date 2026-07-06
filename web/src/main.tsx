import { createRoot } from 'react-dom/client'
import DOMPurify from 'dompurify'
import { App } from './App'

// CSS de libs primero, después el propio — mismo orden de cascada que los
// <link> del index.html vanilla (xterm → diff2html → hljs github-dark → style).
// Reemplazan los tres <link> de CDN (docs/REACT-PORT.md §1, Fase 1).
import '@xterm/xterm/css/xterm.css'
import 'diff2html/bundles/css/diff2html.min.css'
import 'highlight.js/styles/github-dark.css'
import './styles/app.css'

// Links del markdown renderizado (transcript y .md del repo) en pestaña nueva:
// que un tap no navegue la PWA. Se registra una sola vez, global (app.js:1994-2001).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

// Sin StrictMode a propósito: el doble-mount de efectos en dev duplicaría el
// attach del WS/pty (texto doblado, pelea de resize) — ver docs/REACT-PORT.md §1.
createRoot(document.getElementById('root')!).render(<App />)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

import { createRoot } from 'react-dom/client'
import { App } from './App'

// CSS de libs primero, después el propio — mismo orden de cascada que los
// <link> del index.html vanilla (xterm → diff2html → hljs github-dark → style).
// Reemplazan los tres <link> de CDN (docs/REACT-PORT.md §1, Fase 1).
import '@xterm/xterm/css/xterm.css'
import 'diff2html/bundles/css/diff2html.min.css'
import 'highlight.js/styles/github-dark.css'
import './styles/app.css'

// Sin StrictMode a propósito: el doble-mount de efectos en dev duplicaría el
// attach del WS/pty (texto doblado, pelea de resize) — ver docs/REACT-PORT.md §1.
createRoot(document.getElementById('root')!).render(<App />)

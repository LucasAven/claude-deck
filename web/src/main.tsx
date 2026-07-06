import { createRoot } from 'react-dom/client'
import { App } from './App'

// Sin StrictMode a propósito: el doble-mount de efectos en dev duplicaría el
// attach del WS/pty (texto doblado, pelea de resize) — ver docs/REACT-PORT.md §1.
createRoot(document.getElementById('root')!).render(<App />)

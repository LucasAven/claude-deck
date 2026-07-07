import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import { closeCreateMenu, openWorktreeSheet, openDispatchSheet } from '../../lib/worktree'

// Menú CREAR (tarea 5, design-refs/task05-06-menu-crear.png): popover bajo la
// fila de chips, abierto con long-press en el +. Siempre montado (toggle
// hidden); el tap-afuera lo cierra el listener global de App. Reusa las clases
// .mh/.mi del switch-menu (mismo lenguaje visual, otro anclaje).
// La tarea 6 agrega acá su tercera entrada: "Despachar con prompt…".
export function CreateMenu() {
  const open = useDeckStore((s) => s.createMenuOpen)
  const createSession = useDeckStore((s) => s.createSession)

  const newTap = useTap(() => {
    closeCreateMenu()
    createSession()
  })
  const wtTap = useTap(() => openWorktreeSheet())
  const dispatchTap = useTap(() => openDispatchSheet())

  return (
    <div id="create-menu" className={'create-menu' + (open ? '' : ' hidden')}>
      <div className="mh">Crear</div>
      <button className="mi" {...newTap}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M12 8.5v7M8.5 12h7" />
        </svg>
        <span>Nueva sesión</span>
      </button>
      <button className="mi" {...wtTap}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="6" r="2.5" />
          <circle cx="7" cy="18" r="2.5" />
          <circle cx="17" cy="9" r="2.5" />
          <path d="M7 8.5v7M17 11.5c0 3.5-4 3-7.5 4.5" />
        </svg>
        <span>Nuevo worktree…</span>
      </button>
      <button className="mi" {...dispatchTap}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h13M13 6l6 6-6 6" />
          <path d="M4 5v14" />
        </svg>
        <span>Despachar con prompt…</span>
      </button>
    </div>
  )
}

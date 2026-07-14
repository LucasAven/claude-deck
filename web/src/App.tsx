import { useEffect } from 'react'
import { useDeckStore, restoreInitialSession } from './store'
import { useViewportGeometry } from './hooks/useViewportGeometry'
import { usePolling } from './hooks/usePolling'
import { TabBar } from './components/TabBar'
import { AuthError } from './components/AuthError'
import { SnipTip } from './components/SnipTip'
import { ClaudeView } from './components/claude/ClaudeView'
import { ChangesView } from './components/changes/ChangesView'
import { FilesView } from './components/files/FilesView'
import { ProjectsView } from './components/projects/ProjectsView'
import { HostSheet } from './components/claude/HostSheet'
import { WorktreeSheet } from './components/claude/WorktreeSheet'
import { DispatchSheet } from './components/claude/DispatchSheet'
import { QuickkeysSheet } from './components/claude/QuickkeysSheet'
import { SettingsSheet } from './components/claude/SettingsSheet'
import { closeSwitchMenu } from './lib/switch'
import { closeCreateMenu } from './lib/worktree'
import { refreshHost } from './lib/host'
import { refreshStatus } from './lib/status'
import { initPushState } from './lib/push'
import { hideComposerSnips } from './lib/composer'
import { attachImage, pasteTextToPrompt } from './lib/image'

// Shell de la app (index.html:20-203). Las tres <section class="view"> están
// SIEMPRE montadas y se togglea .active por CSS — la vista Claude no puede
// desmontarse jamás (xterm + WS viven en un singleton, §5.1). El contenido de
// cada vista y los overlays los llenan las fases siguientes:
//   Fase 2 → SessionRow + Terminal (dentro de #view-claude)
//   Fase 3 → ControlBar + Composer + SwitchMenu + Snippets
//   Fase 4 → Scrollback + HostSheet + HostBanner
//   Fase 5 → ChangesView + FilesView
export function App() {
  const activeTab = useDeckStore((s) => s.activeTab)

  // arranque: config + sesión inicial (localStorage / deep-link). El terminal
  // se crea en la Fase 2; acá solo dejamos elegida la sesión y el primer git.
  useEffect(() => {
    restoreInitialSession().then(() => {
      const s = useDeckStore.getState()
      s.refreshSessions() // primeros chips sin esperar el poll
      s.refreshGit() // primer badge de Cambios sin esperar el poll
      refreshStatus() // primera statusline (ctx/tokens/modelo) sin esperar el poll de 8 s
    })
    refreshHost() // primer estado del host (chip de batería) sin esperar el poll
    initPushState() // estado del opt-in de Web Push (tarea 23) para el botón 🔔
  }, [])

  useViewportGeometry()
  usePolling()

  // Listeners globales de la controlbar (app.js:470-472, 669-687, 1073-1075):
  //  · tap afuera cierra el popover switch-menu y el panel de snippets del composer
  //  · Cmd/Ctrl+V pega imagen (desde cualquier lado) o texto (solo si el foco NO
  //    está en la terminal — ahí xterm ya pega solo), con la tab Claude activa
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest('#switch-menu, #btn-switch, #btn-attach, #btn-snippets')) closeSwitchMenu()
      if (!t?.closest('#composer-snips, #composer-snippets')) hideComposerSnips()
      // el menú CREAR se abre con long-press: el pointerdown sobre el propio +
      // corre ANTES de que el hold dispare, así que cerrarlo acá no lo pisa
      if (!t?.closest('#create-menu')) closeCreateMenu()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (useDeckStore.getState().activeTab !== 'claude') return
      const items = e.clipboardData?.items ?? []
      // La imagen SIEMPRE dispara el chip de preview (flujo de imágenes intacto),
      // incluso con el composer abierto: el textarea no la maneja de forma útil.
      const img = [...items].find((i) => i.type.startsWith('image/'))
      if (img) {
        e.preventDefault()
        attachImage(img.getAsFile(), 'Imagen del portapapeles')
        return
      }
      // TEXTO con foco en un campo editable (el textarea del composer, o cualquier
      // input) → comportamiento nativo: el texto queda ahí, editable, y no viaja al
      // pty. El único camino a la terminal es el botón + → "Pegar portapapeles".
      // Cubrimos también composerOpen por si el paste llega sin target editable
      // (globito de iOS) con el composer abierto. La terminal (xterm) ya pega sola.
      const t = e.target as HTMLElement | null
      if (t?.closest?.('textarea, input, [contenteditable="true"], .term-wrap') || useDeckStore.getState().composerOpen) return
      const text = e.clipboardData?.getData('text/plain')
      if (text) {
        e.preventDefault()
        pasteTextToPrompt(text)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  const cls = (name: string) => 'view' + (activeTab === name ? ' active' : '')

  return (
    <>
      <div id="app">
        {/* Pestaña Claude — SessionRow + Terminal + ControlBar (Fase 2/3) */}
        <section id="view-claude" className={cls('claude')}>
          <ClaudeView />
        </section>

        {/* Pestaña Cambios — header + lista + diff */}
        <section id="view-changes" className={cls('changes')}>
          <ChangesView />
        </section>

        {/* Pestaña Archivos — árbol + vista de archivo */}
        <section id="view-files" className={cls('files')}>
          <FilesView />
        </section>

        {/* Pestaña Proyectos: sesiones agrupadas por proyecto (tarea 41/42) */}
        <section id="view-projects" className={cls('projects')}>
          <ProjectsView />
        </section>

        {/* overlays globales siempre montados: host-sheet (Fase 4), worktree-sheet (tarea 5), snip-tip */}
        <HostSheet />
        <WorktreeSheet />
        <DispatchSheet />
        <QuickkeysSheet />
        <SettingsSheet />
        <SnipTip />

        <TabBar />
      </div>
      <AuthError />
    </>
  )
}

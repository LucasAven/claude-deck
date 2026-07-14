import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDeckStore } from '../../store'
import { useTap } from '../../hooks/useTap'
import {
  fetchProjectSessions,
  fetchWorkspaceRoots,
  registerProjectsRefresh,
  sessionCd,
  newSession,
  projName,
  projRootLabel,
  type ProjSession,
} from '../../lib/projects'

// Tab Proyectos (tarea 41, layout A "separado"). Arriba las secciones pins /
// recientes / explorar (tarea 42, MISMO componente: acá van los andamios con
// placeholders), un divisor, y abajo la seccion PROYECTOS CON SESIONES: las
// sesiones tmux vivas agrupadas por el dir de su pane, cada una con [abrir]
// [cd] [kill] y un [+ nueva sesion aca] por proyecto. Vive siempre montada como
// las otras vistas; el toggle .active es CSS (la vista Claude nunca se desmonta).
//
// Regla de teclado/foco (§5.3, §5.4): TODAS las acciones tocables acá usan
// useTap (preventDefault en pointerdown, dispara en pointerup dentro del gesto),
// NUNCA onClick. [abrir] enfoca el terminal sincronico dentro del gesto.

// --- una sesion dentro de un grupo (chip con estado + acciones) ---
function ProjSessionItem({ s, onChanged }: { s: ProjSession; onChanged: () => void }) {
  const selectSession = useDeckStore((st) => st.selectSession)
  const killSession = useDeckStore((st) => st.killSession)
  const setActiveTab = useDeckStore((st) => st.setActiveTab)

  const openTap = useTap(() => {
    // foco sincronico dentro del gesto (§5.3): la vista Claude vive siempre
    // montada (singleton xterm), asi que term.focus() es seguro aunque la tab
    // recien pase a .active en el proximo render. Nada de foco diferido.
    selectSession(s.name)
    setActiveTab('claude')
    window.claudeConn?.term?.focus()
  })

  const cdTap = useTap(async () => {
    const res = await sessionCd(s.name, s.dir)
    if (!res.ok) {
      alert(`No se pudo cd: ${res.error}`)
      return
    }
    onChanged()
  })

  const killTap = useTap(async () => {
    await killSession(s.name) // confirma + DELETE + fallback si mata la activa
    onChanged()
  })

  const status = s.claudeRunning ? 'claude corriendo' : 'shell'
  return (
    <div className="proj-session" data-name={s.name}>
      <span className={'proj-dot ' + (s.claudeRunning ? 'run' : 'shell')} />
      <span className="proj-session-name">{s.name}</span>
      <span className="proj-session-status">{status}</span>
      <div className="proj-session-actions">
        <button className="proj-session-open" {...openTap}>
          abrir
        </button>
        {s.claudeRunning ? (
          // [cd] deshabilitado con candado y razon visible: el cd se tipearia
          // DENTRO de claude (el gate paneAtShellPrompt del server, hecho visual)
          <button
            className="proj-session-cd disabled"
            disabled
            aria-disabled="true"
            title="claude corriendo: el cd se tipearía dentro de claude"
          >
            <span className="proj-lock" aria-hidden="true">
              &#128274;
            </span>{' '}
            cd
            <span className="proj-cd-reason"> (claude corriendo)</span>
          </button>
        ) : (
          <button className="proj-session-cd" {...cdTap}>
            cd
          </button>
        )}
        <button className="proj-session-kill" {...killTap}>
          kill
        </button>
      </div>
    </div>
  )
}

// --- un proyecto (dir del pane) con sus sesiones + [+ nueva sesion aca] ---
function ProjectGroup({
  dir,
  sessions,
  roots,
  onChanged,
}: {
  dir: string
  sessions: ProjSession[]
  roots: string[]
  onChanged: () => void
}) {
  const selectSession = useDeckStore((st) => st.selectSession)
  const setActiveTab = useDeckStore((st) => st.setActiveTab)

  const newTap = useTap(async () => {
    const res = await newSession(dir)
    if (!res.ok) {
      alert(`No se pudo crear la sesión: ${res.error}`)
      return
    }
    // la sesion ya existe server-side: selectSession pelado (sin expectCreate /
    // create=1), el guard anti-resurreccion ve una sesion viva (created=false)
    selectSession(res.session)
    setActiveTab('claude')
    onChanged()
  })

  const rootLabel = projRootLabel(dir, roots)
  return (
    <div className="proj-group" data-dir={dir}>
      <div className="proj-group-header">
        <span className="proj-group-name">{projName(dir)}</span>
        {rootLabel && <span className="proj-group-root">{rootLabel}</span>}
      </div>
      {sessions.map((s) => (
        <ProjSessionItem key={s.name} s={s} onChanged={onChanged} />
      ))}
      {/* sin dir resoluble no hay donde parir la sesion: se omite el boton */}
      {dir && (
        <button className="proj-new-session" {...newTap}>
          + nueva sesión acá
        </button>
      )}
    </div>
  )
}

export function ProjectsView() {
  const activeTab = useDeckStore((s) => s.activeTab)
  const [sessions, setSessions] = useState<ProjSession[]>([])
  const [roots, setRoots] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try {
      setSessions(await fetchProjectSessions())
    } catch (e) {
      if (String((e as Error).message) === '401') return
      /* error transitorio: conservar la ultima lista */
    }
  }, [])

  // bridge global para ui-test (mockea fetch y llama window.refreshProjects())
  useEffect(() => registerProjectsRefresh(refresh), [refresh])
  // raices del perimetro una vez (etiqueta de proyecto): no cambian en runtime
  useEffect(() => {
    fetchWorkspaceRoots().then(setRoots)
  }, [])

  // fetch al entrar a la tab + poll de 8 s mientras este activa y visible
  useEffect(() => {
    if (activeTab !== 'projects') return
    refresh()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 8000)
    return () => clearInterval(id)
  }, [activeTab, refresh])

  // agrupar las sesiones vivas por el dir de su pane (dos sesiones en el mismo
  // dir caen bajo el mismo proyecto). Orden estable: por nombre de proyecto.
  const groups = useMemo(() => {
    const byDir = new Map<string, ProjSession[]>()
    for (const s of sessions) {
      const k = s.dir || ''
      const arr = byDir.get(k)
      if (arr) arr.push(s)
      else byDir.set(k, [s])
    }
    return [...byDir.entries()]
      .map(([dir, ss]) => ({ dir, sessions: ss.slice().sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => projName(a.dir).localeCompare(projName(b.dir)) || a.dir.localeCompare(b.dir))
  }, [sessions])

  return (
    <div id="projects-view" className="proj-view">
      <div className="proj-title-row">
        <span className="proj-title">Proyectos</span>
      </div>

      {/* TOP TIERS (tarea 42, MISMO componente): pins / recientes / explorar.
          Andamiaje de labels con placeholders; la logica de datos (pins/recent/
          browse desde /api/dirs) la implementa la tarea 42 acá mismo. */}
      <div className="proj-top">
        <div className="proj-section" data-tier="pins">
          <div className="proj-section-label">PINNEADOS</div>
          <div className="proj-tier-placeholder muted">(tarea 42)</div>
        </div>
        <div className="proj-section" data-tier="recent">
          <div className="proj-section-label">RECIENTES</div>
          <div className="proj-tier-placeholder muted">(tarea 42)</div>
        </div>
        <div className="proj-section" data-tier="explore">
          <div className="proj-section-label">EXPLORAR</div>
          <div className="proj-tier-placeholder muted">(tarea 42)</div>
        </div>
      </div>

      <div className="proj-divider" />

      {/* PROYECTOS CON SESIONES (tarea 41): sesiones vivas agrupadas por dir */}
      <div className="proj-bottom">
        <div className="proj-section-label proj-bottom-label">
          PROYECTOS CON SESIONES <span className="proj-count">{groups.length}</span>
        </div>
        {groups.length === 0 ? (
          <div className="proj-empty muted">No hay sesiones vivas.</div>
        ) : (
          groups.map((g) => (
            <ProjectGroup key={g.dir || '(sin dir)'} dir={g.dir} sessions={g.sessions} roots={roots} onChanged={refresh} />
          ))
        )}
      </div>
    </div>
  )
}

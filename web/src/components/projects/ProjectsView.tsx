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
  fetchDirs,
  pin,
  unpin,
  browseDir,
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
// FIXUP tarea 42: el [cd] por-sesion que tenia esta fila (tarea 41) llamaba
// sessionCd(s.name, s.dir), es decir cd de una sesion al dir DE SU PROPIO
// pane: un no-op efectivo. Se saca de aca; el [cd] que importa ahora es el de
// las filas de directorio en PINNEADOS/RECIENTES/EXPLORAR (mueve la sesion
// ACTIVA a ese dir, ver DirActions mas abajo). Quedan [abrir] y [kill].
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
        <button className="proj-session-kill" {...killTap}>
          kill
        </button>
      </div>
    </div>
  )
}

// --- acciones de un directorio (tarea 42): [nueva sesion] pare una sesion
// pelada ahi; [cd] mueve la sesion ACTIVA (store.session) a ese dir, gateado
// por cdEnabled/cdReason (decision de Lucas: el [cd] de tier opera sobre la
// sesion seleccionada, no crea una nueva ni se ata al dir del renglon). El
// visual deshabilitado espeja el que tenia el [cd] por-sesion de la seccion de
// abajo (candado + razon), reusando las mismas clases .proj-lock/.proj-cd-reason. ---
function DirActions({
  dir,
  activeSession,
  cdEnabled,
  cdReason,
  onChanged,
}: {
  dir: string
  activeSession: string | null
  cdEnabled: boolean
  cdReason: string
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
    selectSession(res.session)
    setActiveTab('claude')
    onChanged()
  })

  const cdTap = useTap(async () => {
    if (!activeSession) return
    const res = await sessionCd(activeSession, dir)
    if (!res.ok) {
      alert(`No se pudo cd: ${res.error}`)
      return
    }
    onChanged()
  })

  return (
    <div className="proj-dir-actions">
      <button className="proj-dir-new" {...newTap}>
        nueva sesión
      </button>
      {cdEnabled ? (
        <button className="proj-dir-cd" {...cdTap}>
          cd
        </button>
      ) : (
        <button className="proj-dir-cd disabled" disabled aria-disabled="true" title={cdReason}>
          <span className="proj-lock" aria-hidden="true">
            &#128274;
          </span>{' '}
          cd
          <span className="proj-cd-reason"> ({cdReason})</span>
        </button>
      )}
    </div>
  )
}

// --- estrella de pin (tarea 42): 'unpin-only' (fila de PINNEADOS, siempre
// pinneado), 'pin-only' (fila de RECIENTES, agrega si no estaba), 'toggle'
// (nodo del arbol de EXPLORAR, prende/apaga segun el estado actual) ---
function PinToggle({
  dir,
  pinned,
  mode,
  onChanged,
}: {
  dir: string
  pinned: boolean
  mode: 'unpin-only' | 'pin-only' | 'toggle'
  onChanged: () => void
}) {
  const tap = useTap(async () => {
    const res = pinned ? await unpin(dir) : await pin(dir)
    if (!res.ok) {
      alert(`No se pudo actualizar el pin: ${res.error}`)
      return
    }
    onChanged()
  })

  if (mode === 'unpin-only') {
    return (
      <button className="proj-unpin" {...tap} aria-label="despinnear" title="despinnear">
        &#10005;
      </button>
    )
  }
  if (mode === 'pin-only') {
    return (
      <button className="proj-pin" {...tap} aria-label="pinnear" title="pinnear">
        +
      </button>
    )
  }
  return (
    <button
      className={'proj-pin-toggle' + (pinned ? ' pinned' : '')}
      {...tap}
      aria-pressed={pinned}
      title={pinned ? 'despinnear' : 'pinnear'}
    >
      {pinned ? 'pinneado' : 'pin'}
    </button>
  )
}

// --- una fila de directorio (PINNEADOS/RECIENTES): nombre + etiqueta de raiz
// (desambigua homonimos entre raices, projRootLabel) + acciones + pin ---
function DirRow({
  dir,
  roots,
  activeSession,
  cdEnabled,
  cdReason,
  onChanged,
  pinned,
  pinMode,
}: {
  dir: string
  roots: string[]
  activeSession: string | null
  cdEnabled: boolean
  cdReason: string
  onChanged: () => void
  pinned: boolean
  pinMode: 'unpin-only' | 'pin-only'
}) {
  const rootLabel = projRootLabel(dir, roots)
  return (
    <div className="proj-dir" data-dir={dir}>
      <div className="proj-dir-info">
        <span className="proj-dir-name">{projName(dir)}</span>
        {rootLabel && <span className="proj-dir-root">{rootLabel}</span>}
      </div>
      <DirActions dir={dir} activeSession={activeSession} cdEnabled={cdEnabled} cdReason={cdReason} onChanged={onChanged} />
      <PinToggle dir={dir} pinned={pinned} mode={pinMode} onChanged={onChanged} />
    </div>
  )
}

// --- nodo del arbol de EXPLORAR (tarea 42): shallow lazy, un nivel por vez.
// El caret dispara /api/dirs/browse SOLO la primera vez que se expande (children
// null = no cargado todavia); expandir/colapsar despues no vuelve a pedir. Cada
// hijo es otro TreeNode: la recursion es la que da la profundidad, nunca se
// prefetchea mas de un nivel por vez. ---
function TreeNode({
  path,
  roots,
  pins,
  activeSession,
  cdEnabled,
  cdReason,
  onChanged,
}: {
  path: string
  roots: string[]
  pins: string[]
  activeSession: string | null
  cdEnabled: boolean
  cdReason: string
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  const caretTap = useTap(async () => {
    if (!expanded && children === null) {
      setLoading(true)
      try {
        const names = await browseDir(path)
        const base = path.replace(/\/+$/, '')
        setChildren(names.map((n) => `${base}/${n}`))
      } catch {
        setChildren([])
      } finally {
        setLoading(false)
      }
    }
    setExpanded((v) => !v)
  })

  const pinned = pins.includes(path)
  const rootLabel = projRootLabel(path, roots)

  return (
    <div className="proj-tree-node" data-dir={path}>
      <div className="proj-tree-row">
        <button
          className="proj-tree-caret"
          {...caretTap}
          aria-expanded={expanded}
          aria-label={expanded ? 'colapsar' : 'expandir'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div className="proj-dir-info">
          <span className="proj-dir-name">{projName(path)}</span>
          {rootLabel && <span className="proj-dir-root">{rootLabel}</span>}
        </div>
        <DirActions dir={path} activeSession={activeSession} cdEnabled={cdEnabled} cdReason={cdReason} onChanged={onChanged} />
        <PinToggle dir={path} pinned={pinned} mode="toggle" onChanged={onChanged} />
      </div>
      {expanded && (
        <div className="proj-tree-children">
          {loading && <div className="proj-tree-loading muted">cargando...</div>}
          {!loading && children && children.length === 0 && (
            <div className="proj-tree-empty muted">sin subcarpetas</div>
          )}
          {!loading &&
            children &&
            children.map((c) => (
              <div className="proj-tree-child" key={c}>
                <TreeNode
                  path={c}
                  roots={roots}
                  pins={pins}
                  activeSession={activeSession}
                  cdEnabled={cdEnabled}
                  cdReason={cdReason}
                  onChanged={onChanged}
                />
              </div>
            ))}
        </div>
      )}
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
  const activeSession = useDeckStore((s) => s.session)
  const [sessions, setSessions] = useState<ProjSession[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [pins, setPins] = useState<string[]>([])
  const [recent, setRecent] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try {
      setSessions(await fetchProjectSessions())
    } catch (e) {
      if (String((e as Error).message) === '401') return
      /* error transitorio: conservar la ultima lista */
    }
    try {
      const d = await fetchDirs()
      setPins(d.pins)
      setRecent(d.recent)
    } catch {
      /* error transitorio: conservar pins/recientes actuales */
    }
  }, [])

  // bridge global para ui-test (mockea fetch y llama window.refreshProjects())
  useEffect(() => registerProjectsRefresh(refresh), [refresh])
  // raices del perimetro una vez (etiqueta de proyecto + raices del arbol de
  // EXPLORAR): no cambian en runtime
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

  // gate del [cd] de tier (decision de Lucas): habilitado SOLO si la sesion
  // ACTIVA (store.session) esta en la lista viva de sesiones Y en un shell
  // pelado (claudeRunning === false). Sin sesion activa viva -> deshabilitado
  // con "no hay una sesion activa en un shell"; con claude corriendo ->
  // deshabilitado con "la sesion activa tiene claude corriendo".
  const activeSess = useMemo(
    () => sessions.find((s) => s.name === activeSession) || null,
    [sessions, activeSession],
  )
  const cdEnabled = !!activeSess && !activeSess.claudeRunning
  const cdReason = !activeSess
    ? 'no hay una sesión activa en un shell'
    : activeSess.claudeRunning
      ? 'la sesión activa tiene claude corriendo'
      : ''

  return (
    <div id="projects-view" className="proj-view">
      <div className="proj-title-row">
        <span className="proj-title">Proyectos</span>
      </div>

      {/* TOP TIERS (tarea 42): pins / recientes / explorar, todas desde
          /api/dirs (pins+recent) y /api/workspaces (raices del arbol de
          EXPLORAR). El [cd] de cada fila mueve la sesion ACTIVA (arriba), no
          crea ni ata nada al dir de la fila; [nueva sesion] si crea, ahi. */}
      <div className="proj-top">
        <div className="proj-section" data-tier="pins">
          <div className="proj-section-label">PINNEADOS</div>
          {pins.length === 0 ? (
            <div className="proj-empty muted">todavía nada, tocá la estrella en una carpeta para fijarla</div>
          ) : (
            pins.map((p) => (
              <DirRow
                key={p}
                dir={p}
                roots={roots}
                activeSession={activeSession}
                cdEnabled={cdEnabled}
                cdReason={cdReason}
                onChanged={refresh}
                pinned
                pinMode="unpin-only"
              />
            ))
          )}
        </div>
        <div className="proj-section" data-tier="recent">
          <div className="proj-section-label">RECIENTES</div>
          {recent.length === 0 ? (
            <div className="proj-empty muted">se llena sola cuando parís o hacés cd a un proyecto</div>
          ) : (
            recent.map((r) => (
              <DirRow
                key={r}
                dir={r}
                roots={roots}
                activeSession={activeSession}
                cdEnabled={cdEnabled}
                cdReason={cdReason}
                onChanged={refresh}
                pinned={pins.includes(r)}
                pinMode="pin-only"
              />
            ))
          )}
        </div>
        <div className="proj-section" data-tier="explore">
          <div className="proj-section-label">EXPLORAR</div>
          {roots.length === 0 ? (
            <div className="proj-empty muted">sin raíces configuradas</div>
          ) : (
            roots.map((r) => (
              <TreeNode
                key={r}
                path={r}
                roots={roots}
                pins={pins}
                activeSession={activeSession}
                cdEnabled={cdEnabled}
                cdReason={cdReason}
                onChanged={refresh}
              />
            ))
          )}
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

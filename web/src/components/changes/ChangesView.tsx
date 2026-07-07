import { useEffect, useRef, useState } from 'react'
import { html as diff2htmlHtml } from 'diff2html'
import { useDeckStore, type GitFile } from '../../store'
import { stageFile, fetchDiff, commitChanges, pushChanges } from '../../lib/git'

// Pestaña Cambios (index.html:136-148, app.js:1633-1785). El header + la lista
// salen de `git` (refreshGit vive en el store); el diff es estado local (esta
// vista está siempre montada). inDiff se refleja en el store para que el
// auto-refresh de 8 s no pise la vista de diff (§4).

const BADGES: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T', '??': '??' }

interface DiffState {
  file: GitFile
  loading: boolean
  error: string | null
  html: string | null // null + !loading + !error → sin diferencias (binario/vacío)
}

function FileRow({ f, onOpen }: { f: GitFile; onOpen: (f: GitFile) => void }) {
  const [busy, setBusy] = useState(false)
  // div y no button: adentro va el botón de stage/unstage (no se anidan buttons)
  return (
    <div className="file-row" onClick={() => onOpen(f)}>
      <span className={'badge' + (f.staged ? ' staged' : '')}>{BADGES[f.status] || f.status}</span>
      <span className="file-path">{f.path}</span>
      <button
        className="file-act"
        title={f.staged ? 'Sacar del stage' : 'Stagear'}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          stageFile(f).finally(() => setBusy(false))
        }}
      >
        {f.staged ? '−' : '+'}
      </button>
    </div>
  )
}

// Formulario de commit + push (tarea 12). Se muestra solo con archivos staged
// (deriva de `git`, sin fetch extra). Endpoints REALES: rompe a propósito el
// "toda escritura pasa por Claude" (ver README Seguridad). Controles con
// onClick plano (patrón local de la vista, no useTap). El mensaje lo tipea
// Lucas; input controlado simple (no es el composer: sin baile de foco iOS).
function CommitForm({ stagedCount }: { stagedCount: number }) {
  const refreshGit = useDeckStore((s) => s.refreshGit)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (push: boolean) => {
    const message = msg.trim()
    if (!message || busy) return
    setBusy(true)
    let hash: string
    try {
      hash = await commitChanges(message)
    } catch (e) {
      if (String((e as Error).message) !== '401') window.alert(`Commit falló: ${(e as Error).message}`)
      setBusy(false)
      return
    }
    if (push) {
      try {
        await pushChanges()
      } catch (e) {
        if (String((e as Error).message) !== '401') {
          window.alert(`Commit hecho (${hash}) pero el push falló: ${(e as Error).message}`)
        }
        setMsg('')
        setBusy(false)
        refreshGit()
        return
      }
    }
    setMsg('')
    setBusy(false)
    refreshGit()
  }

  return (
    <div id="commit-form" className="commit-form">
      <label className="commit-label" htmlFor="commit-msg">
        Mensaje del commit · {stagedCount} staged
      </label>
      <input
        id="commit-msg"
        className="commit-input"
        type="text"
        value={msg}
        placeholder="Mensaje del commit"
        disabled={busy}
        onChange={(e) => setMsg(e.target.value)}
      />
      <div className="commit-actions">
        <button id="btn-commit" className="commit-btn" disabled={busy || !msg.trim()} onClick={() => run(false)}>
          Commit
        </button>
        <button
          id="btn-commit-push"
          className="commit-btn primary"
          disabled={busy || !msg.trim()}
          onClick={() => run(true)}
        >
          Commit + Push ↑
        </button>
      </div>
    </div>
  )
}

export function ChangesView() {
  const git = useDeckStore((s) => s.git)
  const gitNoRepo = useDeckStore((s) => s.gitNoRepo)
  const refreshGit = useDeckStore((s) => s.refreshGit)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const diffRef = useRef<HTMLDivElement>(null)

  // diff recién pintado (o cambio de archivo): al tope, como view.scrollTop = 0
  useEffect(() => {
    if (diff && diffRef.current) diffRef.current.scrollTop = 0
  }, [diff?.html, diff?.file.path])

  const openDiff = async (file: GitFile) => {
    useDeckStore.setState({ inDiff: true }) // bloquea el auto-refresh (no pisar la vista)
    setDiff({ file, loading: true, error: null, html: null })
    try {
      const text = await fetchDiff(file)
      if (!text.trim()) {
        setDiff({ file, loading: false, error: null, html: null })
        return
      }
      setDiff({
        file,
        loading: false,
        error: null,
        // salida de git, ya escapada por diff2html → seguro para innerHTML (§5.7);
        // line-by-line siempre: nunca side-by-side en móvil
        html: diff2htmlHtml(text, { drawFileList: false, matching: 'lines', outputFormat: 'line-by-line' }),
      })
    } catch (e) {
      setDiff({ file, loading: false, error: (e as Error).message, html: null })
    }
  }

  const closeDiff = () => {
    useDeckStore.setState({ inDiff: false })
    setDiff(null)
    refreshGit()
  }

  const ab: string[] = []
  if (git?.ahead) ab.push(`↑${git.ahead}`)
  if (git?.behind) ab.push(`↓${git.behind}`)
  if (git?.upstream) ab.push(git.upstream)

  const staged = git?.files.filter((f) => f.staged) ?? []
  const unstaged = git?.files.filter((f) => !f.staged) ?? []

  return (
    <>
      <div className="changes-header">
        <button
          id="btn-diff-back"
          className={'icon-btn' + (diff ? '' : ' hidden')}
          onClick={closeDiff}
        >
          ←
        </button>
        <div className="branch-info">
          <span id="git-branch">{git ? `⎇ ${git.branch || '?'}` : gitNoRepo ? '' : '(sin datos git)'}</span>
          <span id="git-ab" className="muted">
            {ab.join('  ')}
          </span>
        </div>
        <button id="btn-refresh" className="icon-btn" onClick={() => !diff && refreshGit()}>
          ↻
        </button>
      </div>

      <div id="file-list" className={'scroll' + (diff ? ' hidden' : '')}>
        {gitNoRepo && <div className="empty-state">Esta sesión no está en un repo git</div>}
        {git && !git.files.length && <div className="empty-state">Árbol de trabajo limpio ✓</div>}
        {!!staged.length && <div className="file-section">Staged</div>}
        {staged.map((f) => (
          <FileRow key={`s:${f.path}`} f={f} onOpen={openDiff} />
        ))}
        {!!unstaged.length && <div className="file-section">Sin stagear</div>}
        {unstaged.map((f) => (
          <FileRow key={`u:${f.path}`} f={f} onOpen={openDiff} />
        ))}
      </div>

      {diff && diff.html ? (
        <div
          id="diff-view"
          ref={diffRef}
          className="scroll"
          dangerouslySetInnerHTML={{ __html: diff.html }}
        />
      ) : (
        <div id="diff-view" ref={diffRef} className={'scroll' + (diff ? '' : ' hidden')}>
          {diff && (
            <div className="empty-state">
              {diff.loading
                ? 'Cargando diff…'
                : diff.error
                  ? `No se pudo cargar el diff: ${diff.error}`
                  : 'Sin diferencias (¿archivo binario o vacío?)'}
            </div>
          )}
        </div>
      )}

      {!diff && !!staged.length && <CommitForm stagedCount={staged.length} />}
    </>
  )
}

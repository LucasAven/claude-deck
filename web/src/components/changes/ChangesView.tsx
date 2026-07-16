import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { html as diff2htmlHtml } from 'diff2html'
import { useDeckStore, type GitFile, type PrChecks } from '../../store'
import { stageFile, fetchDiff, commitChanges, pushChanges, fetchLog, fetchShow, type Commit } from '../../lib/git'
import { pasteTextToPrompt } from '../../lib/image'
import { rawImageUrl } from '../../lib/files'
import { AuthError } from '../../lib/api'
import { relTime, isPreviewImage } from '../../lib/format'

// Pestaña Cambios (index.html:136-148, app.js:1633-1785). El header + la lista
// salen de `git` (refreshGit vive en el store); el diff es estado local (esta
// vista está siempre montada). inDiff se refleja en el store para que el
// auto-refresh de 8 s no pise la vista de diff (§4).

const BADGES: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T', '??': '??' }

interface DiffState {
  title: string // clave de scroll/header: path del archivo o "hash subject"
  from: 'files' | 'history' // de dónde se abrió (a dónde vuelve el ←)
  file: GitFile | null // null en diffs de commit (deshabilita comentar, tarea 13)
  loading: boolean
  error: string | null
  html: string | null // null + !loading + !error → sin diferencias (binario/vacío)
  image: boolean // tarea 16: preview de la versión del worktree en vez del text diff
}

// Estado agregado del chip de CI/PR (tarea 15): rojo si algo falló, ámbar si
// algo corre, verde si todo pasó (leyenda del mockup).
type PrAgg = 'passed' | 'pending' | 'failed'
function prState(pr: PrChecks): PrAgg {
  if (pr.checks.failed > 0) return 'failed'
  if (pr.checks.pending > 0) return 'pending'
  return 'passed'
}
const PR_ICON: Record<PrAgg, string> = { passed: '✓', pending: '●', failed: '✗' }
function prSummary(pr: PrChecks): string {
  const { total, passed, failed, pending } = pr.checks
  if (failed > 0) return `✗ ${failed} check${failed > 1 ? 's' : ''} ${failed > 1 ? 'fallaron' : 'falló'}`
  if (pending > 0) return `● ${passed}/${total} checks corriendo`
  const base = `✓ ${passed} check${passed !== 1 ? 's' : ''} ${passed !== 1 ? 'pasaron' : 'pasó'}`
  return pr.mergeable === 'MERGEABLE' ? `${base} · merge listo` : base
}

// diff2html: line-by-line siempre (nunca side-by-side en móvil). Compartido por
// el diff de un archivo y el `git show` de un commit (tarea 14). Salida de git
// ya escapada → seguro para innerHTML (§5.7).
function renderDiff(text: string): string {
  return diff2htmlHtml(text, { drawFileList: false, matching: 'lines', outputFormat: 'line-by-line' })
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
      if (!(e instanceof AuthError)) window.alert(`Commit falló: ${(e as Error).message}`)
      setBusy(false)
      return
    }
    if (push) {
      try {
        await pushChanges()
      } catch (e) {
        if (!(e instanceof AuthError)) {
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
  const gitChecks = useDeckStore((s) => s.gitChecks)
  const refreshGit = useDeckStore((s) => s.refreshGit)
  const [prCardOpen, setPrCardOpen] = useState(false) // card expandida del chip CI/PR
  const [diff, setDiff] = useState<DiffState | null>(null)
  // Historial de commits (tarea 14): lista o null (cerrado). Tap en la rama del
  // header lo abre; tap en un commit abre su `git show` en el mismo visor.
  const [history, setHistory] = useState<Commit[] | null>(null)
  const [historyErr, setHistoryErr] = useState<string | null>(null)
  const diffRef = useRef<HTMLDivElement>(null)
  // Comentar una línea del diff (tarea 13): estado {path, line} de la línea
  // seleccionada. La fila resaltada vive dentro de dangerouslySetInnerHTML, así
  // que el highlight se toggea imperativo sobre el <tr> (§5.7); el box es un
  // componente normal debajo de #diff-view.
  const [comment, setComment] = useState<{ path: string; line: string } | null>(null)
  const [commentText, setCommentText] = useState('')
  const tapDown = useRef<{ x: number; y: number } | null>(null)
  // Arrastre de rango (tarea 13, ampliación): el <tr> ancla desde donde empezó
  // el drag en la columna de números. Ver el porqué del mecanismo abajo.
  const rangeAnchor = useRef<HTMLElement | null>(null)
  // El path del diff abierto, en un ref: los handlers de puntero son estables
  // (van en el elemento memoizado del diff — ver diffBody) así que no pueden
  // cerrar sobre `diff` directamente sin quedar viejos.
  const diffFileRef = useRef<string | null>(null)
  diffFileRef.current = diff?.file?.path ?? null

  // Limpia el highlight ámbar de cualquier fila marcada dentro del diff.
  const clearHighlight = useCallback(() => {
    diffRef.current?.querySelectorAll('.diff-comment-line').forEach((el) => el.classList.remove('diff-comment-line'))
  }, [])

  // nº de línea de una fila de código (nuevo, o el viejo en borrados); '' si no es una.
  const rowLine = (tr: Element): string => {
    const ln = tr.querySelector('.d2h-code-linenumber')
    if (!ln) return ''
    return (ln.querySelector('.line-num2')?.textContent?.trim() || ln.querySelector('.line-num1')?.textContent?.trim() || '')
  }
  // filas de código del diff, en orden del DOM (sin hunk headers ni placeholders).
  const codeRows = (): HTMLElement[] =>
    [...(diffRef.current?.querySelectorAll('tr') ?? [])].filter((tr) => tr.querySelector('.d2h-code-linenumber')) as HTMLElement[]

  // Delegación en el contenedor (los rows entran por innerHTML). Dos gestos:
  //   · TAP con slop → una línea (igual que antes; no pelea con el scroll).
  //   · DRAG desde la COLUMNA DE NÚMEROS → rango de líneas.
  // Mecanismo del rango (elegido con evidencia): `touch-action: none` SOLO en
  // `.d2h-code-linenumber` (ver app.css) — un toque que arranca en el gutter no
  // lo consume el scroll del navegador, así que el drag es nuestro; un toque que
  // arranca sobre el código scrollea como siempre. Por eso el ancla sólo se arma
  // si el pointerdown cae en el gutter. (El long-press-para-armar se descartó:
  // competía con el tap simple y seguía necesitando cancelar el scroll a mano.)
  // Si el feel del drag queda dudoso en touch real, queda para que Lucas lo
  // pruebe en el celu — no cambiar el gesto sin su ok.
  const onDiffPointerDown = useCallback((e: React.PointerEvent) => {
    tapDown.current = { x: e.clientX, y: e.clientY }
    rangeAnchor.current = null
    const gutter = (e.target as HTMLElement).closest('.d2h-code-linenumber')
    const tr = gutter?.closest('tr') as HTMLElement | undefined
    if (tr && rowLine(tr)) rangeAnchor.current = tr // drag potencial de rango
  }, [])
  const onDiffPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!rangeAnchor.current) return // sólo si el drag arrancó en el gutter
      // el toque tiene captura implícita del gutter, así que el elemento bajo el
      // dedo se busca con elementFromPoint (e.target queda pegado al ancla).
      const tr = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('tr') as HTMLElement | null
      if (!tr || !diffRef.current?.contains(tr) || !rowLine(tr)) return
      const rows = codeRows()
      const ia = rows.indexOf(rangeAnchor.current)
      const ib = rows.indexOf(tr)
      if (ia === -1 || ib === -1) return
      const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
      clearHighlight()
      for (let i = lo; i <= hi; i++) rows[i].classList.add('diff-comment-line')
    },
    [clearHighlight],
  )
  const onDiffPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const TAP_SLOP = 10
      const down = tapDown.current
      const startedInGutter = rangeAnchor.current !== null
      tapDown.current = null
      rangeAnchor.current = null
      const path = diffFileRef.current
      if (!path) return

      // ¿Se resaltó un rango durante el drag? (arranque en el gutter + movimiento)
      if (startedInGutter) {
        const nums = codeRows().filter((tr) => tr.classList.contains('diff-comment-line')).map(rowLine).map(Number)
        if (nums.length) {
          const l1 = Math.min(...nums)
          const l2 = Math.max(...nums)
          setComment({ path, line: l1 === l2 ? String(l1) : `${l1}-${l2}` })
          setCommentText('')
          return
        }
        // no se movió sobre ninguna fila (tap en el gutter) → cae al tap simple
      }

      // TAP simple (con slop): una sola línea.
      if (!down) return
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) return // fue scroll
      const tr = (e.target as HTMLElement).closest('tr')
      if (!tr || !diffRef.current?.contains(tr)) return
      const line = rowLine(tr)
      if (!line) return // fila de contexto de hunk (.d2h-info) o placeholder vacío
      clearHighlight()
      tr.classList.add('diff-comment-line')
      setComment({ path, line })
      setCommentText('')
    },
    [clearHighlight],
  )

  const clearComment = () => {
    clearHighlight()
    setComment(null)
    setCommentText('')
  }

  const addComment = () => {
    if (!comment) return
    const text = commentText.trim()
    // "En <path>:<line>: <comentario>" → al prompt, SIN enviar; el usuario lo
    // termina/manda desde la pestaña Claude (se acumulan si agrega varios).
    pasteTextToPrompt(`En ${comment.path}:${comment.line}: ${text}`)
    useDeckStore.getState().setActiveTab('claude')
    clearComment()
  }

  // diff recién pintado (o cambio de archivo/commit): al tope, como scrollTop = 0
  useEffect(() => {
    if (diff && diffRef.current) diffRef.current.scrollTop = 0
  }, [diff?.html, diff?.title])

  const openDiff = async (file: GitFile) => {
    useDeckStore.setState({ inDiff: true }) // bloquea el auto-refresh (no pisar la vista)
    // tarea 16: imágenes → preview de la versión del worktree (via /api/fs/raw)
    // en vez del inútil "Binary files differ"; borradas no tienen blob en disco.
    if (isPreviewImage(file.path)) {
      setDiff({ title: file.path, from: 'files', file, loading: false, error: null, html: null, image: true })
      return
    }
    setDiff({ title: file.path, from: 'files', file, loading: true, error: null, html: null, image: false })
    try {
      const text = await fetchDiff(file)
      if (!text.trim()) {
        setDiff({ title: file.path, from: 'files', file, loading: false, error: null, html: null, image: false })
        return
      }
      setDiff({ title: file.path, from: 'files', file, loading: false, error: null, html: renderDiff(text), image: false })
    } catch (e) {
      setDiff({ title: file.path, from: 'files', file, loading: false, error: (e as Error).message, html: null, image: false })
    }
  }

  // Historial (tarea 14): abre la lista de commits. inDiff bloquea el poll
  // también acá (para no repintar sobre la lista/el diff del commit).
  const openHistory = async () => {
    useDeckStore.setState({ inDiff: true })
    setHistory([])
    setHistoryErr(null)
    try {
      setHistory(await fetchLog(30))
    } catch (e) {
      if (!(e instanceof AuthError)) setHistoryErr((e as Error).message)
    }
  }

  const closeHistory = () => {
    useDeckStore.setState({ inDiff: false })
    setHistory(null)
    setHistoryErr(null)
    refreshGit()
  }

  // Tap en un commit → su diff completo en el mismo visor (from: 'history').
  const openCommit = async (commit: Commit) => {
    const title = `${commit.hash} ${commit.subject}`
    setDiff({ title, from: 'history', file: null, loading: true, error: null, html: null, image: false })
    try {
      const text = await fetchShow(commit.hash)
      setDiff({ title, from: 'history', file: null, loading: false, error: null, html: text.trim() ? renderDiff(text) : null, image: false })
    } catch (e) {
      setDiff({ title, from: 'history', file: null, loading: false, error: (e as Error).message, html: null, image: false })
    }
  }

  const closeDiff = () => {
    clearComment() // tarea 13: el box y su highlight se desarman con el diff
    // Diff abierto desde el historial → vuelve a la lista de commits (sigue
    // montada, inDiff sigue true). Desde la lista de archivos → cierra del todo.
    if (diff?.from === 'history') {
      setDiff(null)
      return
    }
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

  // El diff-view se memoiza sobre `diff`: abrir/mover el box de comentario
  // (tarea 13) cambia otro estado, y sin esto React reescribiría el innerHTML
  // en cada re-render, borrando el highlight imperativo de la fila (§5.7).
  const diffBody = useMemo(() => {
    if (diff && diff.html) {
      return (
        <div
          id="diff-view"
          ref={diffRef}
          className="scroll"
          onPointerDown={onDiffPointerDown}
          onPointerMove={onDiffPointerMove}
          onPointerUp={onDiffPointerUp}
          dangerouslySetInnerHTML={{ __html: diff.html }}
        />
      )
    }
    return (
      <div id="diff-view" ref={diffRef} className={'scroll' + (diff ? '' : ' hidden')}>
        {diff &&
          // tarea 16: imagen → preview del worktree en vez del text diff
          (diff.image && diff.file ? (
            diff.file.status === 'D' ? (
              <div className="empty-state">Imagen borrada (sin versión en el worktree)</div>
            ) : (
              <div className="img-preview">
                <img src={rawImageUrl(diff.file.path)} alt={diff.file.path} />
                <div className="img-caption">{diff.file.path.split('/').pop()}</div>
              </div>
            )
          ) : (
            <div className="empty-state">
              {diff.loading
                ? 'Cargando diff…'
                : diff.error
                  ? `No se pudo cargar el diff: ${diff.error}`
                  : 'Sin diferencias (¿archivo binario o vacío?)'}
            </div>
          ))}
      </div>
    )
  }, [diff, onDiffPointerDown, onDiffPointerMove, onDiffPointerUp])

  const inHistory = history !== null

  return (
    <>
      <div className="changes-header">
        <button
          id="btn-diff-back"
          className={'icon-btn' + (diff || inHistory ? '' : ' hidden')}
          onClick={diff ? closeDiff : closeHistory}
        >
          ←
        </button>
        <div className="branch-info">
          {/* tap en la rama abre el historial (tarea 14); sin repo no hace nada */}
          <span
            id="git-branch"
            className={git && !diff && !inHistory ? 'tappable' : ''}
            onClick={() => git && !diff && !inHistory && openHistory()}
          >
            {git ? `⎇ ${git.branch || '?'}${inHistory ? ' · historial' : ''}` : gitNoRepo ? '' : '(sin datos git)'}
          </span>
          {/* chip de CI/PR (tarea 15): sólo en la vista base, con PR presente */}
          {gitChecks && !diff && !inHistory && (
            <span
              id="pr-chip"
              className={`pr-chip pr-${prState(gitChecks)}`}
              onClick={() => setPrCardOpen((o) => !o)}
            >
              {PR_ICON[prState(gitChecks)]} PR #{gitChecks.number}
            </span>
          )}
          <span id="git-ab" className="muted">
            {inHistory ? '' : ab.join('  ')}
          </span>
        </div>
        <button id="btn-refresh" className="icon-btn" onClick={() => !diff && !inHistory && refreshGit()}>
          ↻
        </button>
      </div>

      {gitChecks && prCardOpen && !diff && !inHistory && (
        <div id="pr-card" className="pr-card">
          <div className="pr-card-title">{gitChecks.title}</div>
          <div className={`pr-card-summary pr-${prState(gitChecks)}`}>{prSummary(gitChecks)}</div>
        </div>
      )}

      {inHistory && !diff && (
        <div id="history-view" className="scroll">
          {historyErr ? (
            <div className="empty-state">No se pudo cargar el historial: {historyErr}</div>
          ) : history.length === 0 ? (
            <div className="empty-state">Sin commits todavía</div>
          ) : (
            history.map((cmt) => (
              <div key={cmt.hash} className="commit-row" onClick={() => openCommit(cmt)}>
                <div className="commit-line1">
                  <span className="commit-hash">{cmt.hash}</span>
                  <span className="commit-subject">{cmt.subject}</span>
                  <span className="commit-stats">
                    {cmt.add > 0 && <span className="stat-add">+{cmt.add}</span>}
                    {cmt.del > 0 && <span className="stat-del"> −{cmt.del}</span>}
                  </span>
                </div>
                <div className="commit-meta">
                  {cmt.author} · {relTime(cmt.ts)}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <div id="file-list" className={'scroll' + (diff || inHistory ? ' hidden' : '')}>
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

      {diffBody}

      {comment && (
        <div id="diff-comment" className="diff-comment">
          <div className="diff-comment-head">
            En {comment.path}:{comment.line}
          </div>
          <textarea
            id="diff-comment-text"
            className="diff-comment-input"
            value={commentText}
            placeholder="Comentario…"
            autoFocus
            onChange={(e) => setCommentText(e.target.value)}
          />
          <div className="diff-comment-actions">
            <button id="btn-comment-cancel" className="commit-btn" onClick={clearComment}>
              Cancelar
            </button>
            <button id="btn-comment-add" className="commit-btn primary" onClick={addComment}>
              Agregar al prompt
            </button>
          </div>
        </div>
      )}

      {!diff && !inHistory && !!staged.length && <CommitForm stagedCount={staged.length} />}
    </>
  )
}

import { useDeckStore } from '../store'
import type { ImgChip } from '../store'
import { deck, AuthError } from './api'

// Imágenes → Claude (app.js:476-687): se re-encodean a PNG en un canvas (los
// HEIC del iPhone no los entiende el server) y se suben; el server la pone en el
// clipboard de la Mac y manda Ctrl+V a la sesión (Claude Code la toma como
// [Image #N]). La parte reactiva (chip de preview) vive en el store; el blob
// pendiente, el objectURL a revocar y los timers son module-level.

const IMG_MAX_SIDE = 1600 // más resolución no aporta para visión y pesa

export async function normalizeImage(file: Blob) {
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * scale))
    canvas.height = Math.max(1, Math.round(bmp.height * scale))
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (blob) return { blob, width: canvas.width, height: canvas.height }
  } catch {
    /* formato no decodificable acá: que lo valide el server */
  }
  return { blob: file, width: 0, height: 0 }
}

// Dos pasos: primero se muestra el preview en el chip y recién al tocarlo se
// sube — así el usuario confirma que la imagen es la correcta antes de que
// llegue al prompt. El ✕ descarta sin enviar (app.js:526-539).
let pendingImg: { blob: Blob; dims: string } | null = null
let chipTimer: ReturnType<typeof setTimeout> | null = null
let sendingImage = false

const fit = () => requestAnimationFrame(() => window.claudeConn?.fit())

function showImgChip(blob: Blob, title: string, meta: string, pending: boolean) {
  if (chipTimer) clearTimeout(chipTimer)
  const prev = useDeckStore.getState().imgChip
  if (prev?.url) URL.revokeObjectURL(prev.url)
  const url = URL.createObjectURL(blob)
  useDeckStore.setState({ imgChip: { url, title, meta, pending } })
  fit()
}

// parche parcial del chip (meta/pending) sin recrear el objectURL
function patchChip(p: Partial<ImgChip>) {
  const c = useDeckStore.getState().imgChip
  if (c) useDeckStore.setState({ imgChip: { ...c, ...p } })
}

export function hideImgChip() {
  if (chipTimer) clearTimeout(chipTimer)
  chipTimer = null
  pendingImg = null
  const c = useDeckStore.getState().imgChip
  if (c?.url) URL.revokeObjectURL(c.url)
  useDeckStore.setState({ imgChip: null })
  fit()
}

export async function attachImage(file: Blob | null, title: string) {
  if (!file || sendingImage) return
  const { blob, width, height } = await normalizeImage(file)
  const dims = width ? `${width} × ${height} · PNG` : (file.type || 'imagen')
  pendingImg = { blob, dims }
  showImgChip(blob, title, dims, true)
}

export async function sendPendingImage() {
  if (!pendingImg || sendingImage) return
  sendingImage = true
  const { blob, dims } = pendingImg
  patchChip({ pending: false, meta: `${dims} · enviando…` })
  try {
    const session = useDeckStore.getState().session
    const res = await deck.raw('/api/paste-image', {
      method: 'POST',
      params: { session: session ?? '' },
      headers: { 'content-type': 'image/png' },
      body: blob,
    })
    if (res.ok) {
      pendingImg = null
      patchChip({ meta: `${dims} · enviada — mirá el prompt` })
      chipTimer = setTimeout(hideImgChip, 8000)
    } else {
      let msg = `HTTP ${res.status}`
      try {
        msg = (await res.json()).error || msg
      } catch {
        /* sin body json */
      }
      patchChip({ meta: `${dims} · error: ${msg}`, pending: true }) // otro tap reintenta
    }
  } catch (e) {
    if (!(e instanceof AuthError)) patchChip({ meta: 'error de red (¿server caído?)', pending: true })
  } finally {
    sendingImage = false
  }
}

// Texto del portapapeles → prompt de Claude. term.paste() normaliza los \n a \r
// y respeta el bracketed paste, así un texto multilínea entra como pegado y NO
// submitea el prompt (app.js:577-580).
export function pasteTextToPrompt(text: string) {
  window.claudeConn?.term.paste(text)
}

// Clipboard API asíncrona: requiere HTTPS (tailscale ✓) y un tap real del
// usuario; iOS muestra el globito de permiso "Pegar" la primera vez. Prioridad
// imagen > texto (una captura copiada puede traer ambos types) — app.js:585-613.
export async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    alert('Este navegador no permite leer el portapapeles')
    return
  }
  let items: ClipboardItems
  try {
    items = await navigator.clipboard.read()
  } catch {
    return // permiso denegado o portapapeles vacío: no molestar con alerts
  }
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'))
    if (type) {
      attachImage(await item.getType(type), 'Imagen del portapapeles')
      return
    }
  }
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const text = await (await item.getType('text/plain')).text()
      if (text) {
        pasteTextToPrompt(text)
        return
      }
    }
  }
  alert('No hay imagen ni texto en el portapapeles')
}

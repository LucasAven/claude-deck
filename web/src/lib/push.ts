// Web Push nativo de la PWA (tarea 23): opt-in de notificaciones que, al
// tocarlas, abren la app instalada (el service worker las maneja) en vez de una
// pestaña nueva de Safari. Todo el flujo del browser vive acá; el server guarda
// la subscription (lib/api → /api/push/*) y notify.sh la usa para las pushes
// planas. En iOS esto SOLO funciona dentro de la PWA instalada (Add to Home
// Screen) y con permiso otorgado desde ahí — el botón se oculta si no hay
// soporte, así la degradación a ntfy es silenciosa.
import { api } from './api'
import { useDeckStore } from '../store'

// El SW ya se registra en main.tsx; acá se detecta soporte y estado.
export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// base64url (VAPID) → Uint8Array para applicationServerKey. El tipo del buffer
// va explícito en ArrayBuffer: BufferSource no admite ArrayBufferLike (TS 5.7).
function urlB64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// Estado inicial del opt-in (se corre una vez al arrancar): refleja si ya hay
// una subscription viva, si el permiso está denegado, o si simplemente está
// apagado. No pide permiso ni suscribe — eso necesita gesto del usuario.
export async function initPushState(): Promise<void> {
  const set = useDeckStore.getState().setPushState
  if (!pushSupported()) {
    set('unsupported')
    return
  }
  if (Notification.permission === 'denied') {
    set('denied')
    return
  }
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    set(sub ? 'on' : 'off')
  } catch {
    set('off')
  }
}

// Opt-in: pide permiso (gesto del usuario), suscribe con la clave VAPID del
// server y guarda la subscription. Debe llamarse desde un handler de tap.
export async function subscribePush(): Promise<void> {
  const set = useDeckStore.getState().setPushState
  if (!pushSupported()) return
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      set(perm === 'denied' ? 'denied' : 'off')
      return
    }
    const { publicKey } = await (await api('/api/push/vapid')).json()
    const reg = await navigator.serviceWorker.ready
    // reusar la subscription existente si la hay (evita rotar la clave)
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(publicKey),
      })
    }
    await api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    set('on')
  } catch (e) {
    // 401 lo maneja api(); cualquier otro fallo deja el estado en off (ntfy
    // sigue cubriendo, así que no es un error visible para el usuario)
    if (String((e as Error).message) !== '401') set('off')
  }
}

// Opt-out: baja la subscription local y avisa al server para que la borre.
export async function unsubscribePush(): Promise<void> {
  const set = useDeckStore.getState().setPushState
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {})
      await sub.unsubscribe().catch(() => {})
    }
    set('off')
  } catch {
    set('off')
  }
}

// Toggle que cablea el botón de la UI.
export function togglePush(): void {
  const st = useDeckStore.getState().pushState
  if (st === 'on') void unsubscribePush()
  else if (st === 'off') void subscribePush()
  // 'denied'/'unsupported': no-op (el botón informa, no puede re-pedir permiso)
}

// puente para ui-test.mjs: setear el estado del opt-in y disparar el toggle sin
// las APIs reales de Web Push (que no existen headless)
if (typeof window !== 'undefined') {
  window.__deckPush = {
    setState: (v) => useDeckStore.getState().setPushState(v),
    toggle: togglePush,
  }
}

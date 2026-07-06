import { useDeckStore } from '../store'

// Reemplaza el showAuthError() imperativo (app.js:1430-1436) que inyectaba un
// <div id="auth-error"> al body. Mismo markup/id; se muestra cuando api() ve un
// 401 y prende el flag del store.
export function AuthError() {
  const authError = useDeckStore((s) => s.authError)
  if (!authError) return null
  return (
    <div id="auth-error">
      Sesión no autorizada.
      <br />
      Abrí la app con <code>/?token=&lt;AUTH_TOKEN&gt;</code>
    </div>
  )
}

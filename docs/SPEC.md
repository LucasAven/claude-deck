# claude-deck — Panel remoto móvil para sesiones locales de Claude Code

## 1. Objetivo

Construir una app web (PWA) que corre en mi PC y me permite, desde el celular:

1. Ver y controlar **la misma sesión interactiva de Claude Code** que dejé corriendo en la terminal integrada de VS Code — la sesión viva, no una copia ni un "resume".
2. Ver el estado de git del repo: rama, archivos modificados/creados/borrados, y el **diff de cada archivo** renderizado en forma legible.
3. Abrir una **terminal libre** dentro del repo para cualquier otra cosa.

Todo se ejecuta en mi máquina; el celular es solo una ventana. El acceso es únicamente a través de mi red Tailscale.

## 2. Decisión clave de arquitectura (no cambiar)

La sesión de Claude Code corre **dentro de tmux**. Así, "continuar exactamente donde estaba" es trivial: tanto la terminal de VS Code como la pestaña del celular se conectan (attach) a la misma sesión tmux, y ven/controlan lo mismo en tiempo real.

**No usar el Claude Agent SDK en v1.** El SDK solo puede *reanudar* una sesión por `session_id` (retomarla después); no puede engancharse en vivo a la sesión interactiva de la CLI que está corriendo en VS Code. Queda documentado como fase 2 en §11.

## 2.1 Multi-sesión (v1, obligatorio)

Debo poder correr **varias instancias de Claude Code en paralelo** (una por sesión tmux) y saltar entre ellas desde el celular:

- El WS de §7.1 acepta un parámetro extra `&session=<nombre>` (default: `$TMUX_SESSION`). Validar el nombre contra `^[A-Za-z0-9_-]{1,32}$`. Si la sesión no existe, crearla con `-c $REPO_DIR`.
- Nuevo endpoint `GET /api/tmux/sessions` → `[{ "name": "deck", "attached": true, "dir": "/ruta/actual/del/pane" }]`, usando `tmux list-sessions` + `tmux display-message -p -t <s>: '#{pane_current_path}'`. Excluir las sesiones `*-shell`.
- Los endpoints git de §7.2, §7.3 y §7.4 aceptan `?session=<nombre>` opcional: el server resuelve el directorio actual del pane de esa sesión y opera git **ahí**. Validación: el directorio debe ser un repo git (`git rev-parse --show-toplevel`) y estar dentro de `WORKSPACES_ROOT` (nueva variable de entorno opcional; default: el directorio padre de `REPO_DIR`). Sin `session`, se usa `REPO_DIR` como hasta ahora.
- UI de la pestaña **Claude**: fila de chips horizontales con las sesiones disponibles + botón `+` que crea `deck-2`, `deck-3`, etc. El chip activo indica a qué sesión está conectada la terminal. La pestaña **Cambios** sigue a la sesión seleccionada.
- Patrón recomendado (documentarlo en el README): para trabajar en paralelo sobre el mismo proyecto sin que las instancias se pisen los archivos, una sesión por **git worktree** (`git worktree add ../proyecto-feature-x rama-x`), con cada `claude` corriendo en su worktree.

## 3. Stack (fijado)

> **Obsoleto (frontend).** Esta sección describe el stack de la v1: frontend vanilla
> sin bundler, con las libs por CDN. El frontend se **portó a React + TypeScript + Vite**
> (código en `web/`, deps por npm, sin CDN); el plan y las decisiones vigentes están en
> [`docs/REACT-PORT.md`](REACT-PORT.md). El resto de este documento (arquitectura tmux,
> protocolo WS, endpoints, UX) sigue vigente byte a byte — el port fue 1:1. La descripción
> del server (Hono + ws + node-pty) también sigue vigente.

- Runtime: Node.js 20+ con TypeScript (usar `tsx` para correr sin build step).
- Server: **Hono** (o Express si resulta más simple) + **ws** + **node-pty**.
- Frontend: ~~una sola página HTML/CSS/JS vanilla, sin bundler~~ → **React + TypeScript + Vite** (`web/`); el server sirve `web/dist` buildeado (fallback a `public/`):
  - **@xterm/xterm** + **@xterm/addon-fit** (por npm) para las terminales.
  - **diff2html** (por npm) para renderizar diffs.
- PWA: `manifest.json` + service worker mínimo (solo para poder instalarla en la pantalla de inicio; sin caché offline agresiva).
- Sin base de datos.

## 4. Prerrequisitos (verificarlos/instalarlos al inicio)

- `tmux`
- Node.js 20+
- `git`
- Tailscale instalado y logueado en la PC (yo lo instalo también en el celular).

## 5. Estructura del proyecto

```
claude-deck/
  server/index.ts       # servidor HTTP + WS + ptys
  public/index.html
  public/app.js
  public/style.css
  public/manifest.json
  public/sw.js
  package.json
  .env.example
  README.md             # setup, flujo de trabajo, seguridad
```

## 6. Configuración (variables de entorno, con `.env`)

| Variable       | Obligatoria | Default | Descripción                                  |
|----------------|-------------|---------|----------------------------------------------|
| `REPO_DIR`     | sí          | —       | Ruta absoluta del repo a monitorear           |
| `AUTH_TOKEN`   | sí          | —       | String aleatorio largo (≥32 chars)            |
| `TMUX_SESSION` | no          | `deck`  | Nombre de la sesión tmux de Claude            |
| `PORT`         | no          | `7433`  | Puerto local                                  |

El servidor hace bind **solo a 127.0.0.1**. Se expone al tailnet con `tailscale serve --bg <PORT>` (HTTPS automático, solo visible para mis dispositivos). El README debe documentar este comando.

## 7. Servidor — API

**Auth:** la primera visita llega como `/?token=XXX` → si coincide con `AUTH_TOKEN`, setear cookie httpOnly `deck_token` y redirigir a `/`. Todas las rutas, estáticos incluidos, y el handshake de WebSocket validan la cookie (o el header `x-deck-token`). Sin token válido → 401.

### 7.1 `WS /ws/term?target=claude|shell`

- Abre un pseudo-terminal con node-pty:
  - `target=claude` → comando: `tmux new-session -A -s $TMUX_SESSION -c $REPO_DIR` (attach-or-create).
  - `target=shell`  → comando: `tmux new-session -A -s ${TMUX_SESSION}-shell -c $REPO_DIR` (así la shell libre también sobrevive a desconexiones).
- `env` del pty: heredar el entorno + `TERM=xterm-256color`.
- Protocolo de mensajes JSON:
  - cliente → server: `{"t":"in","d":"<texto/teclas>"}` y `{"t":"resize","cols":N,"rows":N}`
  - server → cliente: `{"t":"out","d":"<chunk>"}`
- Al conectar, aplicar de inmediato el resize con las dimensiones que manda el cliente.
- Al cerrarse el WS, matar solo el pty (el attach), **nunca** la sesión tmux.

### 7.2 `GET /api/git/summary`

Ejecutar `git -C $REPO_DIR status --porcelain=v2 --branch` y devolver JSON:

```json
{
  "branch": "main",
  "upstream": "origin/main",
  "ahead": 2, "behind": 0,
  "files": [
    { "path": "src/app.ts", "status": "M", "staged": false, "untracked": false }
  ]
}
```

### 7.3 `GET /api/git/diff?path=<relativo>&staged=0|1`

- **Validación estricta**: resolver el path y rechazar todo lo que quede fuera de `REPO_DIR` (nada de `..`, ni rutas absolutas, ni symlinks que escapen).
- Archivo untracked → devolver su contenido como diff de archivo nuevo (`git diff --no-index /dev/null -- <path>`; ignorar el exit code 1, que es normal).
- `staged=1` → `git diff --cached --no-color -- <path>`; si no → `git diff --no-color -- <path>`.
- Respuesta `text/plain` con el diff unificado. Si supera ~500 KB, truncar y avisar en la última línea.

### 7.4 `GET /api/git/log?n=15`

`git log --oneline -n <n>` → JSON `[{ "hash": "...", "subject": "..." }]`.

**Importante:** ningún endpoint HTTP ejecuta comandos arbitrarios. Cualquier acción de escritura (stage, commit, push) la hago pidiéndosela a Claude en su pestaña, o a mano en la pestaña Shell.

## 8. Frontend — UX móvil (lo más importante)

Una sola página con **tab bar inferior de 3 pestañas** (targets táctiles ≥ 44 px):

1. **Claude** — xterm.js a pantalla completa conectado a `target=claude`.
   - Addon fit + re-fit en rotación, resize y apertura/cierre del teclado (usar `visualViewport`).
   - **Barra de teclas rápidas** arriba de la terminal con las teclas que el teclado del celular no tiene y que Claude Code usa todo el tiempo: `Esc` · `↑` · `↓` · `Tab` · `Ctrl+C` · `Enter`. Esto es clave para aprobar/rechazar permisos y navegar menús de Claude Code desde el celu.
   - Si la sesión tmux se acaba de crear (está vacía), mostrar un hint: escribir `claude --continue` para retomar la última conversación del repo.
2. **Cambios** — header con rama y ahead/behind; lista de archivos con badge de estado (M / A / D / R / ??) y distinción staged/unstaged. Tap en un archivo → vista de diff con diff2html en modo *line-by-line* (nunca side-by-side en móvil), con botón ← para volver. Botón ⟳ + auto-refresh cada 8 s mientras la pestaña esté visible (`document.visibilityState`).
3. **Shell** — otro xterm.js sobre `target=shell`, con la misma barra de teclas rápidas.

Detalles obligatorios: tema oscuro tipo "sala de control" (fondo casi negro, monospace como tipografía protagonista, un único color de acento para estados/badges — evitar el verde ácido genérico); `viewport-fit=cover` + safe-area-insets para iPhone; fuente de terminal 14–15 px; reconexión automática del WS con backoff si se corta la red; indicador visible de conectado/desconectado.

## 9. Seguridad (no negociable)

Esto expone una shell de mi PC, así que:

- Bind solo a `127.0.0.1`; la exposición es exclusivamente vía `tailscale serve`. **Jamás** bindear `0.0.0.0` ni abrir puertos al router/internet.
- `AUTH_TOKEN` obligatorio incluso dentro del tailnet (defensa en profundidad). Si falta la variable, el server no arranca.
- Validación de `path` en `/api/git/diff` como se describe en §7.3.
- Rate limit básico en los endpoints HTTP.
- El README debe incluir una sección "Seguridad" explicando todo esto.

## 10. Criterios de aceptación

1. `npm run dev` levanta el servidor y la consola imprime la URL local, el comando `tailscale serve` sugerido y la URL con `?token=` lista para abrir.
2. En la PC corro `tmux new -A -s deck` y adentro `claude`; en VS Code, la terminal integrada corre `tmux attach -t deck`. Ambas ven lo mismo.
3. Desde el celular (misma cuenta de Tailscale) abro `https://<maquina>.<tailnet>.ts.net/?token=...` → la pestaña **Claude** muestra la misma sesión en vivo; lo que escribo ahí aparece también en VS Code, y viceversa.
4. La pestaña **Cambios** lista los archivos modificados y muestra el diff de cualquiera al tocarlo.
5. La pestaña **Shell** da una terminal funcional parada en `REPO_DIR`.
6. Cerrar el navegador del celular **no** mata la sesión de Claude (tmux la mantiene).
7. Sin token válido, todo devuelve 401, incluido el WebSocket.
8. Puedo aprobar un pedido de permisos de Claude Code desde el celular usando la barra de teclas rápidas.
9. Con dos sesiones (`deck` y `deck-2`) corriendo `claude` en paralelo, el selector de la pestaña Claude cambia entre ambas, y la pestaña Cambios refleja el directorio de la sesión seleccionada.
10. `GET /api/tmux/sessions` lista las sesiones activas sin incluir las `*-shell`.

## 11. Fase 2 (documentar en README, NO implementar ahora)

Reemplazar la pestaña Claude por un chat nativo con burbujas y botones Aprobar/Denegar, usando el **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, TypeScript):

- `query()` streamea los mensajes del loop del agente; el mensaje `init` trae el `session_id`.
- `options.resume = sessionId` continúa una sesión previa (la CLI y el SDK comparten el almacenamiento en `~/.claude/projects/`).
- El callback `canUseTool` recibe cada pedido de permiso → se renderiza como botones en la UI.
- Limitación que motiva el diseño v1: `resume` retoma una sesión *después*, no se cuelga de la sesión interactiva viva de la CLI. El flujo sería "salgo de claude en VS Code → la web reanuda ese session_id".
- Referencia: https://platform.claude.com/docs/en/agent-sdk/typescript

## 12. Bonus recomendado (sí implementar): push cuando Claude me necesita

Agregar en el repo un hook de Claude Code (eventos `Notification` y `Stop` en `.claude/settings.json`) que haga `curl -d "Claude espera tu respuesta" ntfy.sh/<topic-largo-y-secreto>`. Con la app **ntfy** instalada en el celular, me llega una notificación push cuando Claude pide un permiso o termina una tarea, y ahí entro a claude-deck. Documentar el setup en el README (ver "Hooks" en la doc oficial de Claude Code).

## 13. Instrucción de arranque

Leé este archivo completo e implementá el proyecto cumpliendo **todos** los criterios de aceptación de §10 y el bonus de §12. Antes de codear, verificá los prerrequisitos de §4 e instalá lo que falte. Al final, probá levantar el servidor y mostrame el checklist de §10 con el estado de cada punto.

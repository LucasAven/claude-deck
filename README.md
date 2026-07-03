# claude-deck

Panel remoto móvil (PWA) para controlar **la misma sesión interactiva de Claude Code** que dejaste corriendo en tu PC — desde el celular, vía Tailscale. Además: estado git con diffs legibles y un explorador de archivos de solo lectura.

Todo corre en tu máquina; el celular es solo una ventana.

## Cómo funciona

La sesión de Claude Code corre **dentro de tmux**. La terminal de VS Code y la pestaña del celular se *attachean* a la misma sesión tmux, así ambas ven y controlan exactamente lo mismo en tiempo real. Cerrar el navegador nunca mata la sesión: tmux la mantiene viva.

```
VS Code (tmux attach -t deck) ──┐
                                ├──► sesión tmux "deck" ──► claude
Celular (claude-deck / WS) ─────┘
```

## Requisitos

- macOS/Linux con `tmux`, `git` y Node.js 20+
- [Tailscale](https://tailscale.com) instalado y logueado en la PC **y** en el celular (misma cuenta)

## Setup

```bash
git clone <este-repo> && cd claude-deck
npm install

cp .env.example .env
# Editar .env:
#   REPO_DIR=/ruta/absoluta/de/tu/repo
#   AUTH_TOKEN=$(openssl rand -hex 32)

npm run dev
```

La consola imprime la URL local, el comando de Tailscale y la URL con `?token=` lista para abrir. `dev` corre con **watch**: editar `server/index.ts` reinicia el server solo (la PWA reconecta). El puerto se configura con `DECK_PORT` (en `.env` o como variable de entorno) — el server ignora `PORT` a propósito, porque los perfiles de shell suelen exportarlo.

Exponer al tailnet (HTTPS automático, visible solo para tus dispositivos):

```bash
tailscale serve --bg 7433
```

Desde el celular abrí `https://<maquina>.<tailnet>.ts.net/?token=<AUTH_TOKEN>`. La primera visita setea una cookie y ya no hace falta el token. Desde el menú del navegador podés **instalarla como app** (Add to Home Screen).

## Flujo de trabajo

1. En la PC: `tmux new -A -s deck` y adentro corrés `claude`.
2. En VS Code: la terminal integrada corre `tmux attach -t deck`. Ves lo mismo.
3. En el celular: pestaña **Claude** → la misma sesión, en vivo. La barra de teclas rápidas (`\n` `/` `esc` `↑` `↓` `tab` `ctrl+c`) te deja aprobar permisos y navegar los menús de Claude Code. `\n` inserta un salto de línea en el prompt **sin enviarlo** (manda ESC+CR, el alt+enter de Claude Code); shift+enter en un teclado Bluetooth hace lo mismo.
4. Pestaña **Cambios**: rama, ahead/behind y archivos modificados; tap en un archivo para ver su diff, `+`/`−` para stagearlo/sacarlo del stage. Se refresca solo cada 8 s, y la tab muestra un badge con la cantidad de archivos con cambios (visible desde cualquier pestaña).
5. Pestaña **Archivos**: árbol de archivos del directorio de la sesión (estilo explorador de VS Code — carpetas colapsables, carpetas primero, iconos por tipo de archivo, carga por nivel). Tap en un archivo para leerlo con syntax highlighting (solo lectura, truncado a 512 KB; el resaltado se salta en archivos de más de 200 KB). Con un `.md` abierto, el botón 👁 del header alterna entre el fuente y la vista renderizada (sanitizada con DOMPurify). La pestaña Shell de la v1 se retiró: la pestaña Claude ya es una terminal.

Si la pestaña Claude muestra una sesión tmux recién creada (vacía), escribí `claude --continue` para retomar la última conversación del repo.

## Multi-sesión (varias instancias de Claude en paralelo)

En la pestaña Claude hay una fila de **chips** con las sesiones tmux disponibles; el botón `+` crea `deck-2`, `deck-3`, etc. El chip activo indica a qué sesión está conectada la terminal, y la pestaña **Cambios** sigue a la sesión seleccionada (opera git en el directorio actual de esa sesión).

**Patrón recomendado — git worktrees.** Para trabajar en paralelo sobre el mismo proyecto sin que las instancias se pisen los archivos, usá una sesión por worktree:

```bash
git worktree add ../proyecto-feature-x rama-x
# en la sesión tmux deck-2:
cd ../proyecto-feature-x && claude
```

Cada `claude` corre en su worktree, con su propio árbol de archivos y su propia rama. Los endpoints git de claude-deck resuelven el directorio de cada sesión automáticamente (limitado a `WORKSPACES_ROOT`, por defecto el directorio padre de `REPO_DIR`).

## Configuración (`.env`)

| Variable          | Obligatoria | Default                  | Descripción                                        |
|-------------------|-------------|--------------------------|----------------------------------------------------|
| `REPO_DIR`        | sí          | —                        | Ruta absoluta del repo a monitorear                 |
| `AUTH_TOKEN`      | sí          | —                        | String aleatorio largo (≥32 chars)                  |
| `TMUX_SESSION`    | no          | `deck`                   | Nombre de la sesión tmux de Claude                  |
| `DECK_PORT`       | no          | `7433`                   | Puerto local  |
| `WORKSPACES_ROOT` | no          | padre de `REPO_DIR`      | Raíz permitida para repos de otras sesiones tmux    |
| `NTFY_TOPIC`      | no          | —                        | Topic secreto de ntfy.sh para push (ver abajo)      |

## Notificaciones push cuando Claude te necesita (ntfy)

Para enterarte en el celular cuando Claude pide un permiso o termina una tarea:

1. Instalá la app [ntfy](https://ntfy.sh) en el celular y suscribite a un topic **largo y secreto** (ej: `openssl rand -hex 16`).
2. Agregá `NTFY_TOPIC=<ese-topic>` a tu `.env`.
3. Activá los hooks de Claude Code renombrando el archivo de ejemplo:

   ```bash
   mv .claude/settings.example.json .claude/settings.json
   ```

   Eso registra hooks en los eventos `Notification` (Claude espera tu input) y `Stop` (Claude terminó), que ejecutan `scripts/notify.sh` → `curl` a `ntfy.sh/$NTFY_TOPIC`. Ver "Hooks" en la doc oficial de Claude Code.

   > Nota: los hooks aplican al `claude` que corras **en este repo**. Para tener push trabajando en otro repo, copiá `.claude/settings.json` y `scripts/notify.sh` a ese repo (o definí los hooks en `~/.claude/settings.json` con la ruta absoluta del script).

Cuando llegue la notificación, entrás a claude-deck y aprobás desde la pestaña Claude.

## Seguridad

Esta app expone una shell de tu PC. Medidas tomadas (no negociables):

- **Bind solo a `127.0.0.1`.** El server nunca escucha en interfaces externas. La única exposición es vía `tailscale serve` (HTTPS + WireGuard, visible solo para los dispositivos de tu tailnet). **Jamás** bindear `0.0.0.0` ni abrir el puerto en el router.
- **`AUTH_TOKEN` obligatorio** incluso dentro del tailnet (defensa en profundidad). Si falta o es corto (<32 chars), el server no arranca. Toda ruta — estáticos incluidos — y el handshake del WebSocket validan la cookie httpOnly `deck_token` (o el header `x-deck-token`). Sin token válido → 401.
- **Validación estricta de paths** en `/api/git/diff`, `/api/git/stage` y `/api/fs/*` (helper compartido `checkRepoPath`): se rechazan rutas absolutas, `..` y symlinks que escapen de la raíz.
- **Sin ejecución arbitraria por HTTP**: ningún endpoint ejecuta comandos del cliente; solo subcomandos fijos de `git`/`tmux` con argumentos validados (`execFile`, sin shell). La única escritura sobre el repo es stage/unstage de un archivo (`/api/git/stage`); el explorador de archivos es de solo lectura; commit, push, etc. se hacen pidiéndoselos a Claude.
- **Multi-sesión acotada**: los endpoints git con `?session=` solo operan en repos dentro de `WORKSPACES_ROOT`; los nombres de sesión se validan contra `^[A-Za-z0-9_-]{1,32}$`.
- **Rate limit** básico en los endpoints HTTP.
- El token en la URL solo se usa la primera vez; después vive en una cookie httpOnly.

## API (referencia rápida)

Todas las rutas requieren auth (cookie o header `x-deck-token`).

| Ruta | Descripción |
|---|---|
| `WS /ws/term?session=<s>` | Terminal (attach tmux). Mensajes JSON: `{"t":"in","d":…}`, `{"t":"resize","cols":N,"rows":N}` ⇄ `{"t":"out","d":…}` |
| `GET /api/tmux/sessions` | Sesiones tmux activas (excluye `*-shell`, legacy de la pestaña Shell) |
| `DELETE /api/tmux/sessions/:name` | Mata la sesión tmux (y su `*-shell` acompañante si quedó de la v1) |
| `PATCH /api/tmux/sessions/:name` | Renombra la sesión (y su `*-shell` si existe). Body JSON: `{ "newName": "<nombre>" }` (letras/números/`-`/`_`, máx 32, sufijo `-shell` reservado). 409 si el nombre ya existe |
| `POST /api/paste-image?session=<s>` | Sube una imagen (PNG/JPEG, máx 15 MB): la pone en el clipboard de la Mac y manda `Ctrl+V` a la sesión — Claude Code la ingiere como `[Image #N]`. Fallback: escribe la ruta del archivo en el prompt |
| `GET /api/git/summary?session=<s>` | Rama, upstream, ahead/behind, archivos |
| `GET /api/git/diff?path=<rel>&staged=0\|1&session=<s>` | Diff unificado (`text/plain`, truncado a 500 KB) |
| `POST /api/git/stage?session=<s>` | Stage/unstage de un archivo. Body JSON: `{ "path": "<rel>", "action": "stage"\|"unstage" }`. Unstage usa `git restore --staged` (o `git rm -r --cached` si el repo no tiene commits) |
| `GET /api/git/log?n=15&session=<s>` | Últimos commits |
| `GET /api/fs/list?path=<rel>&session=<s>` | Lista un directorio (no recursivo; carpetas primero, excluye `.git`, máx 500 entradas). `path` vacío → raíz de la sesión (toplevel git del pane, o el dir del pane si no es repo) |
| `GET /api/fs/file?path=<rel>&session=<s>` | Contenido de un archivo (solo lectura, truncado a 512 KB, detecta binarios) |
| `GET /api/config` | Sesión default y `REPO_DIR` |

Al cerrar el WebSocket se mata **solo el attach** (pty); la sesión tmux sigue viva.

## Fase 2 (futuro — no implementado)

Reemplazar la pestaña Claude por un **chat nativo** (burbujas, botones Aprobar/Denegar) usando el [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript) (`@anthropic-ai/claude-agent-sdk`):

- `query()` streamea los mensajes del loop del agente; el mensaje `init` trae el `session_id`.
- `options.resume = sessionId` continúa una sesión previa — la CLI y el SDK comparten el almacenamiento en `~/.claude/projects/`.
- El callback `canUseTool` recibe cada pedido de permiso → se renderiza como botones Aprobar/Denegar en la UI.

**Limitación que motiva el diseño v1:** `resume` retoma una sesión *después*; no puede engancharse en vivo a la sesión interactiva que está corriendo en la CLI de VS Code. El flujo fase 2 sería: salir de `claude` en VS Code → la web reanuda ese `session_id`. Por eso v1 usa tmux: attach compartido, en vivo, sin copias.

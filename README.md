# claude-deck

Panel remoto móvil (PWA) para controlar **la misma sesión interactiva de Claude Code** que dejaste corriendo en tu PC — desde el celular, vía Tailscale. Además: estado git con diffs legibles y un explorador de archivos de solo lectura.

Todo corre en tu máquina; el celular es solo una ventana.

> **¿Primera vez? Andá directo a [`docs/SETUP.md`](docs/SETUP.md)** — la guía paso a paso para dejarlo funcionando desde cero (instalación, teléfono y uso diario) sin leer el resto de este README. Lo que sigue acá es la referencia de cómo funciona el proyecto.

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
npm install                 # deps del server
npm --prefix web install    # deps del frontend (React/Vite)

cp .env.example .env
# Editar .env:
#   WORKSPACES_ROOT=/ruta/que/contiene/tus/proyectos
#   AUTH_TOKEN=$(openssl rand -hex 32)

npm run build               # buildea el frontend a web/dist (lo que sirve el server)
npm run dev                 # levanta el server en :7433
```

El frontend es **React + Vite** (código en `web/`); el server sirve `web/dist` si existe, si no cae a `public/`. Para producción/LaunchAgent hay que correr **`npm run build`** antes de arrancar (`deck start` / el agente corre `tsx server/index.ts`, que no buildea nada — sirve el `web/dist` ya generado).

Para **desarrollar el frontend** con hot-reload, en vez de buildear cada vez:

```bash
npm run dev       # server en :7433
npm run dev:web   # Vite en :5173 (proxya /api y /ws al server con el token)
```

y abrís `http://127.0.0.1:5173`. Editar `server/index.ts` con `npm run dev` reinicia el server solo (watch); la PWA reconecta. El puerto del server se configura con `DECK_PORT` (en `.env` o como variable de entorno) — el server ignora `PORT` a propósito, porque los perfiles de shell suelen exportarlo.

Exponer al tailnet (HTTPS automático, visible solo para tus dispositivos):

```bash
tailscale serve --bg 7433
```

Desde el celular abrí `https://<maquina>.<tailnet>.ts.net/?token=<AUTH_TOKEN>`. La primera visita setea una cookie y ya no hace falta el token. Desde el menú del navegador podés **instalarla como app** (Add to Home Screen).

## Flujo de trabajo

1. En la PC: `tmux new -A -s deck` y adentro corrés `claude` — o en un solo paso, **`scripts/deck claude [flags]`** (o `deck cc` / `deck ccw` si usás esos alias): crea/attachea una sesión tmux nombrada según el directorio actual, corre claude adentro y el celu la ve al instante como chip. Los flags van a claude (`deck claude --continue`); si la sesión del directorio ya existe attachea sin relanzar nada (salvo que esté en el shell: ahí relanza).
2. En VS Code: la terminal integrada corre `tmux attach -t deck`. Ves lo mismo.
3. En el celular: pestaña **Claude** → la misma sesión, en vivo. La barra de teclas rápidas (`\n` `/` `esc` `↑` `↓` `tab` `ctrl+c`) te deja aprobar permisos y navegar los menús de Claude Code. `\n` inserta un salto de línea en el prompt **sin enviarlo** (manda ESC+CR, el alt+enter de Claude Code); shift+enter en un teclado Bluetooth hace lo mismo. Para prompts largos, el botón ✎ abre el **composer**: un sheet a media pantalla con textarea nativo (autocorrección, dictado del teclado de iOS y cursor libre; la terminal sigue visible arriba). "Enviar ↑" pega el texto en el prompt y lo submitea; "Cancelar" cierra guardando un **borrador por sesión** (sobrevive a que iOS mate la pestaña) que se restaura al reabrirlo. Para **leer** lo que Claude hizo (o copiar un error/path/hash), el botón 📜 abre el **scrollback legible**: overlay de solo lectura con el transcript de la sesión como turnos (tus prompts resaltados, el texto de Claude, las tools como one-liners) — scroll y selección nativos, buscar-en-página del browser, tamaño de letra ajustable (A−/A+) y "Cargar más" para traer más historia. La fuente es el `.jsonl` de Claude Code (tmux no puede: el TUI corre en alternate screen y repinta en el lugar, así que el pane no acumula historia); requiere los hooks de abajo — sin ellos, o en un shell pelado, el overlay muestra el texto del pane vía `capture-pane`.
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

Cada `claude` corre en su worktree, con su propio árbol de archivos y su propia rama. Los endpoints git de claude-deck resuelven el directorio de cada sesión automáticamente (siempre dentro de `WORKSPACES_ROOT`).

## Modo remoto: "me voy, sigo desde el celu" (`scripts/deck`)

Para irte y seguir trabajando desde el teléfono hacen falta tres cosas: el server corriendo, tailscale sirviéndolo y la Mac despierta con la tapa cerrada. `tailscale serve --bg` ya es persistente (queda configurado hasta que lo apagues), así que `scripts/deck` automatiza las otras dos.

**Una vez** (pide el password de sudo):

```bash
scripts/deck install
# tip: alias deck='<repo>/scripts/deck' en ~/.zshrc
```

Instala el server como **LaunchAgent** (`~/Library/LaunchAgents/com.claude-deck.plist`): arranca al iniciar sesión, se relevanta solo si se cae, loguea en `~/Library/Logs/claude-deck.log`. Ya no hay que "prender" nada. También agrega una regla sudoers acotada (`/etc/sudoers.d/claude-deck`) para poder alternar `pmset disablesleep` sin password — es lo único que requiere root y solo cubre esos dos comandos exactos —, configura `tailscale serve` si falta y termina imprimiendo la URL del panel con token (**`deck url`** la muestra cuando quieras, con un QR escaneable si instalaste `qrencode` — así el celular se configura escaneando en vez de tipear la URL).

**Cada vez que te vas** (esto sí es el "un comando"):

```bash
deck away    # verifica server + URL del tailnet de punta a punta, y desactiva el sueño
# ... cerrás la tapa y te vas. Al volver:
deck back    # la Mac vuelve a dormir normalmente
```

⚠️ Con la tapa cerrada, **enchufada**: mantenerla despierta a batería la come rápido ( `away` avisa si estás a batería). `disablesleep` es el mismo mecanismo que usa Amphetamine con su "Closed-Display Mode" — no hace falta Amphetamine si usás `deck away`.

Otros subcomandos: `deck status` (server / agente / tailscale / sueño / batería), `deck stop` + `deck start` (liberar el puerto para desarrollar claude-deck con `npm run dev` y devolvérselo al agente), `deck log`, `deck uninstall`.

## Configuración (`.env`)

| Variable          | Obligatoria | Default                  | Descripción                                        |
|-------------------|-------------|--------------------------|----------------------------------------------------|
| `WORKSPACES_ROOT` | sí          | —                        | **Perímetro de seguridad**: raíz que contiene tus proyectos; el server no lee ni opera git fuera de ella |
| `AUTH_TOKEN`      | sí          | —                        | String aleatorio largo (≥32 chars)                  |
| `DEFAULT_DIR`     | no          | `WORKSPACES_ROOT`        | "Home" del panel: dónde nacen las sesiones tmux nuevas y qué usan los endpoints sin `?session=`. Debe estar dentro de `WORKSPACES_ROOT` |
| `TMUX_SESSION`    | no          | `deck`                   | Nombre de la sesión tmux de Claude                  |
| `DECK_PORT`       | no          | `7433`                   | Puerto local  |
| `NTFY_TOPIC`      | no          | —                        | Topic secreto de ntfy.sh para push (ver abajo)      |
| `DECK_URL`        | no          | —                        | URL pública del panel (la escriben solos `deck install`/`deck url`); habilita el deep-link del push |
| `DECK_PRESENCE_IDLE` | no       | `300`                    | Segundos sin teclado/mouse para que la Mac deje de contar como "estás mirando" (supresión de push por presencia) |
| `DECK_BATT_WATCH_MS` | no       | `60000`                  | Intervalo (ms) del watcher de batería (la alerta proactiva); existe sobre todo para poder testearlo sin esperar minutos |

## Notificaciones push cuando Claude te necesita (ntfy)

Para enterarte en el celular cuando Claude pide un permiso o termina una tarea:

1. Generá un topic **largo y secreto** (ej: `openssl rand -hex 16`) y agregá `NTFY_TOPIC=<ese-topic>` a tu `.env`.
2. Suscribite al topic en el celular, con cualquiera de las dos opciones:
   - **App nativa**: instalá [ntfy](https://ntfy.sh) y suscribite al topic. Conexión persistente, la entrega más confiable.
   - **Web push (sin instalar nada)**: abrí `https://ntfy.sh/<ese-topic>` en el navegador del celular y tocá **Subscribe**. En iPhone hace falta *Add to Home Screen* primero (iOS solo entrega web push a PWAs instaladas).
3. Activá los hooks de Claude Code renombrando el archivo de ejemplo:

   ```bash
   mv .claude/settings.example.json .claude/settings.json
   ```

   Eso registra hooks en los eventos `Notification` (Claude espera tu input), `PermissionRequest` (Claude pide un permiso) y `Stop` (Claude terminó), que ejecutan `scripts/notify.sh` → `curl` a `ntfy.sh/$NTFY_TOPIC`. Además registra `UserPromptSubmit` y `PreToolUse` (y los mismos tres de arriba) ejecutando `scripts/state.sh`, que alimenta el semáforo de los chips (ver abajo) — no manda push. Ver "Hooks" en la doc oficial de Claude Code.

   > Nota: los hooks aplican al `claude` que corras **en este repo**. Para tener push (y semáforo) trabajando en cualquier repo, definí los hooks en el `settings.json` global (`~/.claude/settings.json`) con las rutas absolutas de `scripts/notify.sh` y `scripts/state.sh` — los scripts son autocontenidos; notify.sh lee el topic del `.env` de este repo.

El push es **contextual**: el título es el nombre de la sesión tmux, y el cuerpo dice qué pasa — con el hook `PermissionRequest`, el tool y el comando exacto que Claude quiere correr (`Bash: npm publish` + su descripción); con `Notification` solo, el mensaje genérico del evento; con `Stop`, un resumen de la última respuesta. Si ambos eventos de permiso están hookeados no hay push doble: el genérico se suprime solo (marcador con TTL en `$TMPDIR`). Si `DECK_URL` está en el `.env` (la escriben `deck install`/`deck url` al configurar tailscale serve), tocar la notificación abre el panel **con esa sesión ya seleccionada** (`?session=`).

> Limitación en iOS (confirmada en el teléfono): cada contexto tiene su propio "cookie jar". Con ntfy por **web push**, "Abrir enlace" abre un navegador interno dentro de la PWA de ntfy que nunca vio `?token=` → 401, y no hay forma de sembrarle la cookie. El deep-link funcional necesita la **app nativa de ntfy** (el tap abre Safari) + haber abierto la URL de `deck url` una vez en Safari para dejarle la cookie.

`notify.sh` solo notifica sesiones que corren **dentro de tmux** (las que podés controlar remoto); un `claude` en una terminal común no manda push, porque estás mirando la pantalla. Cuando llegue la notificación, entrás a claude-deck y aprobás desde la pestaña Claude.

Además el push se **suprime si ya estás mirando** (presencia): con la Mac desbloqueada y actividad de teclado/mouse en los últimos 5 min (`DECK_PRESENCE_IDLE` en segundos para cambiarlo), o con la PWA visible en primer plano en cualquier dispositivo (`GET /api/presence` — bloquear el celular o cambiar de app te vuelve "ausente" al instante). El push suprimido se descarta, no se encola. Todos los chequeos fallan abiertos: si algo no se puede leer, el push sale igual.

### Semáforo de sesiones (punto en el chip)

Cada chip de sesión muestra un punto con lo que su Claude está haciendo: **verde = trabajando, ámbar = espera tu input, gris = idle**. Lo alimentan los mismos hooks: `scripts/state.sh` escribe el estado en `~/.claude-deck/state/<sesión>` (`UserPromptSubmit`/`PreToolUse` → working, `Notification`/`PermissionRequest` → waiting, `Stop` → idle) y el server lo mezcla en `GET /api/tmux/sessions`. El mismo script anota además el `transcript_path` que trae cada evento (`<sesión>.transcript`) — es lo que le permite al overlay 📜 saber qué `.jsonl` corresponde a cada sesión tmux. Una sesión sin registro (un shell pelado, o un `claude` sin estos hooks) no muestra punto. Un `working` sin señales por más de 5 min decae a "sin punto" (un claude matado con `kill` nunca emite `Stop`); `waiting` e `idle` no decaen — un permiso pendiente sigue en ámbar aunque vuelvas horas después.

### Panel de host y alerta de batería

La matemática del modo remoto: `deck away` mantiene la Mac despierta **a batería** — si se agota, se cae el acceso al tailnet y quedás afuera hasta volver físicamente. Por eso la PWA muestra la salud del host y el server avisa **antes** de que pase:

- **Chip "🔋 N%"** en la fila de sesiones (solo si la Mac reporta batería; en un desktop no aparece). Tocarlo abre un panel con batería, energía, `SleepDisabled` de pmset (la palanca de `deck away`) y uptime.
- **Banner ámbar** sobre la terminal cuando la batería descarga bajo el umbral. Se puede descartar; se re-arma al terminar el episodio (enchufar o recargar).
- **Alerta push proactiva** (server-side, corre aunque nadie mire): un watcher chequea la batería cada minuto y manda un push al `NTFY_TOPIC` al cruzar el umbral descargando — **una vez por episodio**, con histéresis (se re-arma al volver a corriente o subir umbral+5). El toggle y el umbral se configuran desde el panel y persisten en `~/.claude-deck/host-alert.json` (default: activada, 30%). Sin `NTFY_TOPIC`, el watcher calla.

## Seguridad

Esta app expone una shell de tu PC. Medidas tomadas (no negociables):

- **Bind solo a `127.0.0.1`.** El server nunca escucha en interfaces externas. La única exposición es vía `tailscale serve` (HTTPS + WireGuard, visible solo para los dispositivos de tu tailnet). **Jamás** bindear `0.0.0.0` ni abrir el puerto en el router.
- **`AUTH_TOKEN` obligatorio** incluso dentro del tailnet (defensa en profundidad). Si falta o es corto (<32 chars), el server no arranca. Toda ruta — estáticos incluidos — y el handshake del WebSocket validan la cookie httpOnly `deck_token` (o el header `x-deck-token`). Sin token válido → 401.
- **Validación estricta de paths** en `/api/git/diff`, `/api/git/stage` y `/api/fs/*` (helper compartido `checkRepoPath`): se rechazan rutas absolutas, `..` y symlinks que escapen de la raíz.
- **Sin ejecución arbitraria por HTTP**: ningún endpoint ejecuta comandos del cliente; solo subcomandos fijos de `git`/`tmux` con argumentos validados (`execFile`, sin shell). Las escrituras sobre repos son stage/unstage de un archivo (`/api/git/stage`) y la creación de worktrees (`POST /api/worktree`: `git worktree add -b` con rama/base validadas por regex propia y destino confinado a `WORKSPACES_ROOT` — crea, nunca borra ni pisa); el explorador de archivos es de solo lectura (incluido el preview de imágenes `GET /api/fs/raw`, que sirve el byte crudo con extensión whitelisteada —`png/jpg/jpeg/gif/webp/svg`— y cap de 5 MB; los SVG llevan CSP `sandbox` + `nosniff` para que ni una navegación directa ejecute scripts embebidos); commit, push, etc. se hacen pidiéndoselos a Claude. Las únicas otras escrituras son `PUT /api/snippets` y `POST /api/host/alert`, que solo tocan sus propios JSON de datos de la app (`~/.claude-deck/snippets.json` y `~/.claude-deck/host-alert.json`, contenido validado, paths fijos).
- **Todo acceso acotado a `WORKSPACES_ROOT`**: los endpoints git/fs — con `?session=` o sin él — solo operan dentro de esa raíz (validada con realpath, anti-symlinks); los nombres de sesión se validan contra `^[A-Za-z0-9_-]{1,32}$`.
- **Única excepción al perímetro (solo lectura)**: `GET /api/claude/transcript` lee el transcript `.jsonl` de la sesión para el overlay de lectura 📜 — esos archivos viven en `~/.claude/projects` / `~/.claude-work/projects`, fuera de `WORKSPACES_ROOT`. El path no viene del cliente: lo anota `scripts/state.sh` desde los hooks (`transcript_path` del evento) en `~/.claude-deck/state/<sesión>.transcript`, y el server solo lo sirve si realpath-resuelve a un `*.jsonl` dentro de esas dos raíces. Nada más de `~/.claude*` es accesible, y nunca hay escritura.
- **Rate limit** básico en los endpoints HTTP.
- El token en la URL solo se usa la primera vez; después vive en una cookie httpOnly.

## API (referencia rápida)

Todas las rutas requieren auth (cookie o header `x-deck-token`).

| Ruta | Descripción |
|---|---|
| `WS /ws/term?session=<s>&create=1` | Terminal (attach tmux). Solo crea la sesión si falta con `create=1` (o si es la default); sin él, una sesión inexistente contesta `{"t":"meta","gone":true}` y cierra — así el retry de un cliente viejo no resucita una sesión recién matada. Mensajes JSON: `{"t":"in","d":…}`, `{"t":"resize","cols":N,"rows":N}`, `{"t":"refresh"}` (repaint completo, lo manda la PWA al volver de background), `{"t":"vis","visible":bool}` (presencia: la PWA reporta si está en primer plano) ⇄ `{"t":"out","d":…}` |
| `GET /api/tmux/sessions` | Sesiones tmux activas (excluye `*-shell`, legacy de la pestaña Shell). Incluye `state` (`working`\|`waiting`\|`idle`\|`null`) leído de `~/.claude-deck/state/` — lo escriben los hooks vía `scripts/state.sh` |
| `GET /api/presence` | `{ visible, sessions }`: si alguna PWA está en primer plano (y qué sesiones mira), según los reports `{"t":"vis"}` del WS (TTL 25 s). Lo consulta `notify.sh` para suprimir pushes mientras estás mirando |
| `DELETE /api/tmux/sessions/:name` | Mata la sesión tmux (y su `*-shell` acompañante si quedó de la v1) |
| `PATCH /api/tmux/sessions/:name` | Renombra la sesión (y su `*-shell` si existe). Body JSON: `{ "newName": "<nombre>" }` (letras/números/`-`/`_`, máx 32, sufijo `-shell` reservado). 409 si el nombre ya existe |
| `GET /api/claude/transcript?session=<s>&bytes=<n>` | Turnos legibles (vos/Claude/tools) del transcript `.jsonl` de la sesión — fuente primaria del overlay 📜. El `.jsonl` lo apunta el marker que escriben los hooks (`state.sh`); sin marker responde `{ turns: [] }` y la UI cae a `capture-pane`. `bytes` acota la cola leída (default 2 MB, máx 32 MB) |
| `GET /api/tmux/scrollback?session=<s>&lines=<n>` | Últimas `n` líneas del pane vía `capture-pane` (`text/plain`, default 500, máx 5000) — fallback del overlay 📜 para shells. Ojo: Claude Code 2.x corre en alternate screen, tmux nunca acumula SU transcript — por eso existe el endpoint de arriba |
| `POST /api/paste-image?session=<s>` | Sube una imagen (PNG/JPEG, máx 15 MB): la pone en el clipboard de la Mac y manda `Ctrl+V` a la sesión — Claude Code la ingiere como `[Image #N]`. Fallback: escribe la ruta del archivo en el prompt |
| `GET /api/git/summary?session=<s>` | Rama, upstream, ahead/behind, archivos |
| `GET /api/git/diff?path=<rel>&staged=0\|1&session=<s>` | Diff unificado (`text/plain`, truncado a 500 KB) |
| `POST /api/git/stage?session=<s>` | Stage/unstage de un archivo. Body JSON: `{ "path": "<rel>", "action": "stage"\|"unstage" }`. Unstage usa `git restore --staged` (o `git rm -r --cached` si el repo no tiene commits) |
| `GET /api/git/log?n=15&session=<s>` | Últimos commits |
| `GET /api/git/branches?session=<s>` | Ramas del repo de la sesión: `{ repo, branches, current }` — alimenta el "Basado en" del sheet de worktree |
| `POST /api/worktree?session=<s>` | Crea worktree + rama + sesión tmux en un paso (long-press en `+` → "Nuevo worktree…"). Body JSON: `{ "branch": "feat/x", "base": "main" }`. El worktree nace como HERMANO del repo (`../<repo>-<último-segmento>`, siempre dentro de `WORKSPACES_ROOT`); la sesión toma el nombre de la rama sanitizado. 409 si el path ya existe |
| `GET /api/fs/list?path=<rel>&session=<s>` | Lista un directorio (no recursivo; carpetas primero, excluye `.git`, máx 500 entradas). `path` vacío → raíz de la sesión (toplevel git del pane, o el dir del pane si no es repo) |
| `GET /api/fs/file?path=<rel>&session=<s>` | Contenido de un archivo (solo lectura, truncado a 512 KB, detecta binarios) |
| `GET /api/fs/raw?path=<rel>&session=<s>` | Byte crudo de una imagen del repo para `<img src>` (preview en Archivos/Cambios). Solo lectura, extensión whitelisteada (`png/jpg/jpeg/gif/webp/svg`, resto 415), cap 5 MB (413), Content-Type real. Los SVG salen con CSP `sandbox` + `nosniff` para que una navegación directa no ejecute scripts embebidos |
| `GET /api/snippets` | Lista global de snippets para la paleta ☰ (frases que se insertan en el prompt sin enviar). Vive en `~/.claude-deck/snippets.json` (sincroniza entre dispositivos); sin archivo responde los presets |
| `PUT /api/snippets` | Reemplaza la lista completa. Body JSON: `{ "snippets": ["…"] }` (máx 50 strings no vacíos de ≤500 chars). Escritura atómica |
| `GET /api/host/status` | Salud de la Mac anfitriona: `{ name, battery: { pct, state } \| null, ac, sleepDisabled, uptime, alert }` (parseado de `pmset`/`scutil`; en un desktop sin batería, `battery: null`) |
| `POST /api/host/alert` | Configura la alerta de batería del watcher server-side. Body JSON: `{ "enabled": bool }` y/o `{ "threshold": 5–95 }`. Persiste en `~/.claude-deck/host-alert.json` (escritura atómica) |
| `GET /api/config` | Sesión default y `DEFAULT_DIR` |

Al cerrar el WebSocket se mata **solo el attach** (pty); la sesión tmux sigue viva.

## Fase 2 (futuro — no implementado)

Reemplazar la pestaña Claude por un **chat nativo** (burbujas, botones Aprobar/Denegar) usando el [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript) (`@anthropic-ai/claude-agent-sdk`):

- `query()` streamea los mensajes del loop del agente; el mensaje `init` trae el `session_id`.
- `options.resume = sessionId` continúa una sesión previa — la CLI y el SDK comparten el almacenamiento en `~/.claude/projects/`.
- El callback `canUseTool` recibe cada pedido de permiso → se renderiza como botones Aprobar/Denegar en la UI.

**Limitación que motiva el diseño v1:** `resume` retoma una sesión *después*; no puede engancharse en vivo a la sesión interactiva que está corriendo en la CLI de VS Code. El flujo fase 2 sería: salir de `claude` en VS Code → la web reanuda ese `session_id`. Por eso v1 usa tmux: attach compartido, en vivo, sin copias.

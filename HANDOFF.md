# HANDOFF — claude-deck

**Fecha:** 2026-07-02 (5ª sesión) · **Estado:** v1 + fixes de UI + envío de imágenes en dos pasos + rediseño de controles + switchers de modo/modelo + stage/unstage desde Cambios + botón `\n` y shift+enter para salto de línea, todo funcionando y verificado por el usuario en el celular (incl. teclado Bluetooth). **Backlog activo en `TASKS.md`** (quedan tareas 6 y 7) — ese archivo es la fuente de verdad de qué se hizo y qué falta; este archivo cubre arquitectura y gotchas.

## Qué es y dónde está todo

Panel remoto móvil (PWA) para controlar sesiones de Claude Code corriendo en tmux, vía Tailscale. No dupliques contexto: requisitos en `SPEC.md`, uso/seguridad/API en `README.md` (la tabla de API está al día, incluye los endpoints nuevos).

- `server/index.ts` — todo el backend (Hono + ws + node-pty, un solo archivo)
- `public/` — frontend vanilla: `index.html`, `app.js`, `style.css`, PWA (`manifest.json`, `sw.js` passthrough sin caché, `icon.svg`)
- `test/ws-test.mjs` — E2E de WS/tmux/API (**26 checks**; sección 9b —stage/unstage— es de la 5ª sesión; acepta `DECK_PORT` para apuntar a otro puerto)
- `test/ui-test.mjs` — smoke de UI en Chromium headless, viewport iPhone (**32 checks**; deja `test/shot-*.png`. Ver `TASKS.md` para el backlog de features y lo ya hecho.)
- `test/shot-diff.mjs` — helper que screenshotea el diff (normal / h-scroll / v-scroll) para iterar UI sin celular
- `.claude/settings.example.json` + `scripts/notify.sh` — hooks ntfy (bonus §12), **inactivos** hasta que el usuario los renombre a `settings.json`

## Hecho en la 3ª sesión

1. **Envío de imágenes en dos pasos** (pedido del usuario: poder ver el preview antes de que llegue al terminal):
   - Cámara / pegar / Cmd+V ya **no suben nada**: `attachImage()` solo normaliza y muestra el chip de preview con clase `pending` y un hint ámbar ("Tocá la imagen para enviarla · ✕ para descartar", `#img-chip-hint`, visible solo en pending vía CSS).
   - **Tap en el chip** → `sendPendingImage()` hace el POST a `/api/paste-image`. El ✕ descarta sin enviar (su handler hace `stopPropagation` para no contar como tap de envío). Si el POST falla, el chip vuelve a `pending` → otro tap reintenta.
   - Se sacó la clase `busy` de los botones (ya no hay operación larga al adjuntar); el estado se comunica en el meta del chip (`pendiente → enviando… → enviada/error`).
   - `ui-test.mjs` sección 5b: 4 checks nuevos (chip pendiente + hint visible + 0 POSTs sin confirmar + ✕ descarta); deja `test/shot-img-pending.png`.

## Hecho en la 2ª sesión (además de la v1)

1. **Fixes de UI** (lista del usuario, todos verificados):
   - Botón ✕ en el chip activo para matar la sesión (con confirm) → `DELETE /api/tmux/sessions/:name` (mata también `name-shell`; la UI cae a otra sesión o recrea la default).
   - Texto "doblado" y flickering: eran **attaches WS duplicados** (reconnect no cancelaba el timer de retry). Ahora hay generación de conexión (`gen`) + `retryTimer` cancelable + `resume()` al volver de background. Además `sendResize` solo si cambian cols/rows y re-fit con debounce (120 ms).
   - Overscroll con teclado abierto: `body { position: fixed }` + `#app` pegado al visualViewport vía `--vvt/--vvh` (`updateViewportGeometry`).
   - Scrollback en terminales: tmux se crea/attachea con `mouse on` (chained en el spawn) y el frontend traduce drags táctiles a secuencias SGR de rueda (`wireTouchScroll`) → tmux entra en copy-mode. Esc sale.
   - Scroll del diff ya no arrastra la página: `overscroll-behavior: contain` + body fixed.
   - Números de línea del diff: ahora son celdas reales `position: sticky` (opacas, sin huecos, 52px), con `border-collapse: separate` en la tabla y `position: relative` en `.d2h-file-wrapper`. **No volver a absolute ni tocar ese trío sin re-verificar con `shot-diff.mjs`.**
2. **Envío de imágenes a Claude**: `POST /api/paste-image?session=` — valida magic bytes (PNG/JPEG, máx 15 MB), guarda en `$TMPDIR/claude-deck-uploads` (prune >1 h), pone la imagen en el **clipboard de la Mac** (osascript; JPEG→PNG con sips) y manda **Ctrl+V** a la sesión → Claude Code la ingiere como `[Image #N]`. Fallback: escribe la ruta del archivo en el prompt. El frontend re-encodea todo a PNG ≤1600px por canvas (cubre HEIC del iPhone).
3. **Rediseño de controles (solo pestaña Claude)**: la toolbar pasó de arriba a una `controlbar` abajo (zona del pulgar), arriba de la tab bar: cámara + pegar (SVGs monocromos 44×44), divisor, teclas `esc ↑ ↓ tab ctrl+c /` (sin Enter, a pedido). Botón pegar usa `navigator.clipboard.read()`. Chip de preview arriba de la fila (thumbnail, origen, dimensiones, estado enviando/enviada/error, ✕). El indicador de conexión se movió a la fila de chips de sesión. **Cambios y Shell quedaron como estaban** (Shell conserva su barra arriba con Enter).

## Estado del entorno

- **Repo con historia** (5 commits al cierre de la 4ª sesión; los cambios de la 5ª —stage/unstage— quedaron sin commitear). No commitear sin que lo pida. Los commits deben parecer del usuario: imperativo corto en minúsculas, **sin** Co-Authored-By.
- `.env` funciona (`AUTH_TOKEN` real adentro — no imprimirlo ni commitearlo). No define `PORT`.
- `tailscale serve --bg 7433` activo → `https://<maquina>.<tailnet>.ts.net`.
- El server suele correrlo **el usuario en su propia terminal** (`npm run dev`). Si el puerto 7433 está ocupado, verificar si la instancia es más vieja que `server/index.ts` (gotcha 12) antes de tocarla; avisar antes de matarla salvo que el usuario lo pida.
- `puppeteer-core` ya está instalado como devDependency (antes faltaba).
- El celular del usuario suele tener la PWA abierta: **recrea `deck`/`deck-shell` al toque de matarlas** (reconexión WS). Para correr `ws-test` limpio, matar las sesiones y correr el test en el MISMO comando (ver gotcha 9).

## Gotchas (los 7 de la v1 siguen valiendo; ver git log de este archivo si hace falta... no hay commits: quedan acá)

1. **node-pty 1.1.0**: prebuild sin bit de ejecución en `spawn-helper` → `posix_spawnp failed`; hay `postinstall` que lo arregla.
2. **CDN jsdelivr** (cdnjs no hostea estos paquetes): `@xterm/xterm@5.5.0`, `@xterm/addon-fit@0.10.0`, `diff2html@3.4.52`. Globals: `Terminal`, `FitAddon.FitAddon`, `Diff2Html`.
3. **tmux 3.7b targets**: `has-session`/`kill-session` aceptan `=nombre`, pero `show-options`, `capture-pane` y `send-keys` **no** — para comandos de pane usar `=nombre:` (así está en `tmuxPaneDir` y en paste-image). `display-message -p -t '=inexistente:'` devuelve vacío con exit 0 → por eso `resolveGitDir` hace `has-session` antes.
4. **Sandbox de Claude Code**: node-pty no crea ptys bajo el sandbox de Bash → correr server/tests con `dangerouslyDisableSandbox: true`.
5. **RTK** (hook del usuario): filtra output (usar `rtk proxy <cmd>` para JSON crudo) y **puede romper comandos compuestos con `;`** (síntoma: `(eval):1: ... not found`). Ante eso: comandos de a uno, o meterlos en un script `.sh` y ejecutarlo.
6. **Buffering**: el banner del server no aparece en logs de background (stdout bufferizado); verificar con `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7433/api/config` → `401` = vivo.
7. Un fallo de `pty.spawn` cierra solo ese WS (1011), nunca el proceso — el try/catch en `handleTerm` existe por eso.
8. **`ws-test` PISA el clipboard de la Mac** (el caso feliz de paste-image es así por diseño). Avisar/asumir.
9. **Carrera con la PWA del celu**: los checks `created=true` de ws-test fallan si el celular recrea las sesiones antes de que corra el test. Patrón que funciona: script que hace `tmux kill-session =deck` + `=deck-shell` y `exec node test/ws-test.mjs` en el mismo proceso.
10. **diff2html**: la tabla necesita `border-collapse: separate` (sticky no funciona con collapse) y el wrapper `position: relative` (si no, los números absolute/sticky se desalinean del scroll vertical — se probó y falló con `left: 0`).
11. **tmux `mouse on`** queda seteado en toda sesión que la app toque (incluye sesiones del usuario si las selecciona en la UI): en la terminal de la Mac, seleccionar texto pasa a necesitar Shift/Option.
12. **Server viejo = 404 fantasma** (mordió en la 5ª sesión): `npm run dev` es `tsx` SIN watch — tras editar `server/index.ts`, el proceso vivo sigue sirviendo el código viejo (los estáticos de `public/` sí salen frescos) → la UI muestra features nuevas pero sus endpoints dan 404. Además el perfil de shell del usuario exporta **`PORT=7434`** (lo hereda cualquier terminal, incluida la de Claude), así que un `npm run dev` descuidado bindea 7434 mientras tailscale apunta a 7433. Receta y fix propuesto: TASKS.md tarea 7. Relanzar siempre con `PORT=7433 npm run dev`.

## Cómo correr y verificar

```bash
PORT=7433 npm run dev          # server en http://127.0.0.1:7433 (PORT explícito: ver gotcha 12; banner: gotcha 6)
node test/ws-test.mjs          # 26 checks (server arriba; ver gotchas 8 y 9; DECK_PORT para otro puerto)
node test/ui-test.mjs          # 32 checks + screenshots test/shot-*.png (correrlo lo prefiere el usuario)
node test/shot-diff.mjs        # screenshots del diff view
```

`ui-test`/`shot-diff` usan el Chromium de Playwright en `~/Library/Caches/ms-playwright/chromium_headless_shell-1223/` (path hardcodeado). Lo que headless NO cubre: teclado virtual iOS, gestos táctiles, permiso de "Pegar" de iOS, WS muertos por background — eso lo verifica el usuario en el celular.

## Pendientes explícitos

1. Commitear solo cuando el usuario lo pida (al cierre de la 5ª sesión el árbol quedó limpio).
2. Usuario debe activar hooks ntfy si los quiere (`mv .claude/settings.example.json .claude/settings.json` + `NTFY_TOPIC` en `.env`).
3. Fase 2 (chat nativo con Agent SDK) — documentada en `README.md` y `SPEC.md` §11, **no implementar** sin pedido explícito.

# Port del frontend a React — plan de migración

> **Para sesiones nuevas de Claude Code:** este documento es el plan completo para portar
> el frontend vanilla (`public/app.js`, 2225 líneas) a React + TypeScript + Vite.
> Trabajá **una fase por vez**, en orden. Al terminar una fase: marcá sus checkboxes acá,
> verificá los criterios de aceptación, y frená para que Lucas pruebe en el teléfono.
> Lucas corre `test/ui-test.mjs` él mismo — no lo ejecutes; solo mantené/actualizá sus checks.

## Estado general

- [x] Fase 0 — Scaffolding (Vite + server dual-root)
- [x] Fase 1 — Shell: store, api, tabs, CSS, init
- [x] Fase 2 — Terminal + sesiones (el core)
- [x] Fase 3 — Controlbar: switchers, adjuntar/imagen, composer, snippets
- [x] Fase 4 — Overlays: scrollback legible + panel de host
- [x] Fase 5 — Pestañas Cambios y Archivos
- [ ] Fase 6 — PWA, swap de estáticos, tests y limpieza

---

## 0. Contexto

**Lo que hay hoy** (todo funciona; el port es 1:1, sin rediseños):

| Pieza | Archivo | Notas |
|---|---|---|
| Lógica | `public/app.js` (2225 líneas, vanilla, español) | única fuente de verdad del comportamiento |
| Markup | `public/index.html` (213 líneas) | ids/clases que usa app.js **y** `test/ui-test.mjs` |
| Estilos | `public/style.css` (1231 líneas) | variables CSS, tema oscuro, safe-areas iOS |
| Libs | CDN jsdelivr | xterm 5.5, addon-fit, diff2html, marked, dompurify, highlight.js |
| Server | `server/index.ts` | Hono + ws + node-pty; sirve `public/` con auth |
| Tests | `test/ui-test.mjs` (puppeteer) | depende de ids/clases del DOM y del global `claudeConn` |

**Objetivo:** mismo comportamiento, misma UI, mismo CSS, pero componentizado en React
para que editar sea cómodo. El server queda casi intacto (solo cambia de dónde sirve
estáticos). **Nada del protocolo WS, endpoints, localStorage keys ni UX cambia.**

**Reglas del port (no negociables):**

1. **Paridad de comportamiento primero, idiomático React después.** Si un patrón React
   "más limpio" rompe un matiz (focus de iOS, refit de xterm, anti-resurrección de
   sesiones), gana el matiz. Refactors estéticos van después de la paridad total.
2. **Conservar ids y clases del DOM** (`#term-claude`, `#session-chips`, `.chip.active`,
   `.quickkeys [data-k]`, etc.): el CSS se reusa verbatim y `ui-test.mjs` sigue andando.
3. **Conservar los strings en español** de la UI tal cual están.
4. **`public/` no se toca hasta la Fase 6**: la app vieja sigue siendo la desplegada
   (LaunchAgent) hasta que la nueva tenga paridad verificada en el teléfono.
5. Los comentarios "por qué" de app.js (los que explican bugs de iOS, tmux, etc.) se
   **migran junto con el código** — son la documentación de años de fixes.

---

## 1. Decisiones de stack (tomadas — no re-litigar)

- **Vite + React 19 + TypeScript**, todo el frontend nuevo en `web/`.
- **zustand** para estado global. Razón concreta: el módulo de terminal/WS necesita leer
  la sesión activa **fuera de React** (`useDeckStore.getState().session`) y disparar
  updates sin prop-drilling. Context+useReducer obligaría a un puente raro.
- **Sin router**: las tabs son estado (`activeTab`), igual que hoy.
- **Sin StrictMode**: el doble-mount de efectos en dev duplicaría attaches de WS/pty
  (texto "doblado", pelea de resize — exactamente el bug que el `gen` guard evita).
  El término singleton + StrictMode es pelea perdida; se documenta y listo.
- **CSS:** `style.css` copiado **verbatim** a `web/src/styles/app.css` e importado global.
  Nada de CSS modules / Tailwind en el port. (Refactor opcional post-paridad.)
- **Deps por npm** (chau CDN): `@xterm/xterm@^5.5`, `@xterm/addon-fit`, `diff2html`,
  `marked`, `dompurify`, `highlight.js` (usar `highlight.js/lib/common` — es el mismo
  bundle "common" del CDN que asume `HLJS_LANGS`).
- **Overlays siempre montados** (composer, scrollback, host-sheet, menús): se togglea la
  clase `hidden` como hoy. No montar/desmontar condicionalmente — ver §5 (focus iOS,
  refit de terminal, y el CSS ya está escrito para ese patrón).

---

## 2. Estructura objetivo

```
web/
  index.html              ← metas de public/index.html (viewport-fit, apple-*, theme-color)
  vite.config.ts          ← proxy /api y /ws al server; build → web/dist
  tsconfig.json
  public/                 ← se copian tal cual: manifest.json, sw.js, icon.svg
  src/
    main.tsx
    App.tsx               ← views + TabBar + overlays globales
    store.ts              ← zustand (ver §3, Fase 1)
    lib/
      api.ts              ← fetch con manejo de 401 (app.js:1421-1436)
      term.ts             ← port LITERAL de createTermConnection + wireTouchScroll (app.js:45-278)
      keys.ts             ← KEYS, MODELS, EFFORTS, SESSION_NAME_RE, constantes
      icons.ts            ← FT_ICONS, HOST_ICONS, ATTACH_OPTS svg (app.js:1811-1843, 1250-1256)
      format.ts           ← fmtSize, fmtUptime, extClass, fileIcon, HLJS_LANGS, highlightInto
      image.ts            ← normalizeImage (app.js:483-496)
    hooks/
      useTap.ts           ← onTap como props de pointer events (app.js:318-331)
      useViewportGeometry.ts ← visualViewport → --vvh/--vvt + kb-open (app.js:2100-2117)
    components/
      TabBar.tsx
      AuthError.tsx
      SnipTip.tsx
      claude/
        ClaudeView.tsx
        SessionRow.tsx    ← chips + botón + + host chip + conn dot
        Hint.tsx          ← hint de sesión nueva
        HostBanner.tsx
        Terminal.tsx      ← div contenedor + wiring del singleton de term.ts
        ControlBar.tsx    ← img-chip + switch-menu + pills + quickkeys
        SwitchMenu.tsx    ← popover compartido (modelo / adjuntar / snippets)
        Composer.tsx
        Snippets.tsx      ← paleta compartida (popover y composer)
        Scrollback.tsx
      changes/
        ChangesView.tsx   ← header + FileList + DiffView
      files/
        FilesView.tsx     ← header + FileTree (recursivo) + FileView
      host/
        HostSheet.tsx
```

El server pasa a servir `web/dist/` si existe, si no `public/` (transición sin riesgo).

---

## 3. Fases

### Fase 0 — Scaffolding

**Tareas:**

- [x] `web/` con Vite (`npm create vite` template react-ts, o a mano). Deps de §1.
- [x] `web/vite.config.ts` con proxy al server **inyectando el token** — en dev la raíz
  la sirve Vite, así que el flujo `/?token=` nunca llega al server; sin esto todo da 401:

  ```ts
  // lee AUTH_TOKEN de ../.env y lo manda como header x-deck-token en cada proxy req
  const token = fs.readFileSync('../.env', 'utf8').match(/^AUTH_TOKEN=(.+)$/m)![1].trim()
  const headers = { 'x-deck-token': token }
  export default defineConfig({
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:7433', headers },
        '/ws':  { target: 'ws://127.0.0.1:7433', ws: true, headers },
      },
    },
  })
  ```

- [x] Server (`server/index.ts`): `PUBLIC_DIR` pasa a resolverse al boot:
  `web/dist` si existe, si no `public/`. Agregar al `MIME` map `.woff2`/`.map` si Vite
  los emite, y `cache-control: public, max-age=31536000, immutable` para `/assets/*`
  (nombres hasheados); el resto sigue `no-cache`.
- [x] `package.json` scripts: `dev` (server, como hoy), `dev:web` (`vite` en `web/`),
  `build` (`vite build` en `web/`). `start` no cambia (sirve `web/dist` cuando exista).
- [x] `web/index.html`: copiar TODAS las metas de `public/index.html:4-12`
  (`viewport-fit=cover`, `interactive-widget=resizes-content`, `apple-mobile-web-app-*`,
  `theme-color`, manifest, icons). Sin los `<script>`/`<link>` de CDN.

**Aceptación:** `npm run dev` + `npm run dev:web` levantan; `http://127.0.0.1:5173`
muestra la app placeholder de Vite; `curl http://127.0.0.1:5173/api/config` responde
JSON (proxy + token OK). `npm run build` genera `web/dist` y el server lo sirve en 7433.

### Fase 1 — Shell: store, api, tabs, CSS, init

**Tareas:**

- [x] `src/styles/app.css` = `public/style.css` verbatim, más los imports de libs:
  `@xterm/xterm/css/xterm.css`, `diff2html/bundles/css/diff2html.min.css`,
  `highlight.js/styles/github-dark.css` (importarlos en `main.tsx` antes del css propio,
  mismo orden en cascada que los `<link>` actuales).
- [x] `lib/api.ts`: port de `api()` + estado `authError` en el store en vez de
  `showAuthError()` imperativo → componente `<AuthError/>` (mismo markup/id `#auth-error`).
- [x] `store.ts` — forma inicial:

  ```ts
  {
    defaultSession: 'deck', session: null, expectCreate: null,   // app.js:7-13
    activeTab: 'claude', inDiff: false,
    sessions: [],                       // GET /api/tmux/sessions (con .state del semáforo)
    git: null,                          // GET /api/git/summary → badge + lista
    hostStatus: null, hostBannerDismissed: false,
    snippets: null, snippetsEditing: false,
    authError: false,
    // overlays: composerOpen, scrollbackOpen, hostSheetOpen, switchMenu: 'model'|'attach'|'snippets'|null
  }
  ```

- [x] `App.tsx`: las tres `<section class="view">` **siempre montadas** con toggle de
  `.active` (como hoy — la vista Claude no puede desmontarse jamás, ver §5.1), TabBar,
  overlays, `<SnipTip/>`, `<AuthError/>`. (Contenido de vistas + composer/scrollback/
  host-sheet quedan como shells vacíos — los llenan las Fases 2-5.)
- [x] Port de `init()` (app.js:2122-2156) a un efecto de arranque en `App`/`main`:
  1. `GET /api/config` → `defaultSession`;
  2. restaurar `localStorage['deck-active-session']` (validada con `SESSION_NAME_RE`
     y sin sufijo `-shell`);
  3. deep-link `?session=` (validar, seleccionar, y **sacar el param de la URL** con
     `history.replaceState` — app.js:2144-2155);
  4. persistir la elección inicial.
- [x] `hooks/useTap.ts`: mismas semánticas que `onTap` (app.js:318-331) —
  **`preventDefault()` en pointerdown** (mantiene el foco → no se cierra el teclado
  virtual), acción en pointerup solo si el movimiento ≤ `TAP_SLOP=12px`, y
  pointercancel resetea. Devolver `{onPointerDown, onPointerUp, onPointerCancel}`.
- [x] `hooks/useViewportGeometry.ts`: port de `updateViewportGeometry` (app.js:2100-2117)
  — setea `--vvh`/`--vvt` en `documentElement`, togglea `kb-open` en `document.body`
  (umbral 100px), y llama `fit()` del terminal con debounce de 120ms. Listeners:
  `visualViewport.resize/scroll`, `window.resize`, `orientationchange` (+300ms).
- [x] Polling de 8s (app.js:2187-2194) en un efecto top-level: solo si
  `document.visibilityState === 'visible'`; re-afirma presencia (`sendVis`), refresca
  git (badge corre en cualquier tab), host, y sessions/tree según tab activa.
  `visibilitychange` (app.js:2196-2208): manda `vis` también al pasar a hidden
  (última chance antes del freeze de iOS), y al volver: refrescos + `resume()`.
  (Fase 1 cablea presencia + git; host/sessions/tree se suman cuando existan sus
  refreshers — Fases 2/4/5.)

**Aceptación:** app carga con el look actual (tabs, tema, safe-areas), tab bar cambia
vistas, badge de Cambios funciona contra el server real. Sin terminal todavía.

### Fase 2 — Terminal + sesiones (el core, la fase más delicada)

**Tareas:**

- [x] `lib/term.ts`: **port literal** de `createTermConnection` (app.js:45-231) y
  `wireTouchScroll` (app.js:239-278). Es TypeScript plano sin React — cambiar solo:
  - `getSession` → `() => useDeckStore.getState().session`
  - los efectos DOM (`setConn`, `showHint`, guard anti-resurrección, fallback) →
    callbacks/acciones del store inyectadas al crear la conexión.
  - **Singleton de módulo**: `let claudeConn` creado una sola vez (lazy) — nunca por
    render. Exponerlo como `window.claudeConn` (puente para `ui-test.mjs`, que espía
    `claudeConn.sendKeys` y `claudeConn.term.paste`).
  - Preservar TODO: `gen` guard, backoff `min(1000*2^n, 15000)`, resize solo-si-cambió,
    `refresh` watchdog de 2s post-resume, `meta gone` → fallback, guard anti-resurrección
    (`m.created && !== defaultSession && !== expectCreate` → DELETE + fallback),
    shift+enter → `\x1b\r`, `create=1` solo si `session === expectCreate`.
- [x] `Terminal.tsx`: div `#term-claude`, en un efecto (una vez) crea el singleton,
  `term.open(el)`, wirea touch-scroll. El indicador `#conn-claude` sale del store
  (la conexión setea `connected` vía callback).
- [x] `SessionRow.tsx` + chips: port de `refreshSessions/selectSession/killSession/
  renameSession/createSession/fallbackToLiveSession/nextSessionName` (app.js:1441-1628).
  En React el `chipsKey` anti-parpadeo ya no hace falta (reconciliación), pero el
  **orden y estructura del DOM sí**: `.chip` con `.chip-dot chip-dot-<estado>` opcional
  + `span` label; el activo suma `.chip-name` (tap → rename) y `.chip-x` (tap → kill).
  Rename/kill/confirm siguen con `window.prompt/confirm` (low-fi a propósito).
  - `selectSession`: persistir en localStorage, cerrar hint/menú/composer (guardando
    borrador), re-render pills, `claudeConn.reconnect()`, refrescar git/sessions/tree.
  - `killSession`: limpia `deck-switch:<name>` y `draft:<name>` de localStorage.
  - `renameSession`: migra esas dos keys al nombre nuevo, **sin reconectar el WS**
    (el attach tmux sobrevive al rename), sigue al composer abierto si era esa sesión.
- [x] `Hint.tsx`: port de show/hide con timer de 15s (app.js:285-296) + `fit()` en rAF.
- [x] QuickKeys en `ControlBar.tsx`: botones `[data-k]` con `useTap` → `sendKeys(KEYS[k])`
  (app.js:301-339). Mantener el orden: `nl` primero, `slash` segundo.

**Aceptación (en el teléfono, contra sesiones reales):** attach a `deck` en vivo,
escribir/aprobar permisos funciona, quickkeys OK, scroll táctil entra a copy-mode,
crear/renombrar/matar sesiones con fallback correcto, matar una sesión desde otro
dispositivo no la resucita, volver de background repinta (o reconecta si el WS quedó
zombie), rotación/teclado re-fitean sin texto doblado.

### Fase 3 — Controlbar completa

**Tareas:**

- [x] `SwitchMenu.tsx`: un solo popover con `kind: 'model'|'attach'|'snippets'` en el
  store (hoy `dataset.kind`, app.js:421-464, 630-654, 1027-1043). Mismo toggle: tap en
  el botón del kind abierto lo cierra; tap en otro lo re-renderiza. Tap-afuera cierra
  (listener global en pointerdown que ignora `#switch-menu, #btn-mode, #btn-model,
  #btn-attach, #btn-snippets` — app.js:470-472).
- [x] Pills modo/modelo (app.js:348-474): `cycleMode` manda `\x1b[Z`; menú de modelo
  manda `/model <id>` y efforts `/effort <id>` vía `sendSlashCommand` (texto, pausa
  150ms, `\r` — app.js:386-390). Estado persistido **por sesión** en
  `deck-switch:<sesión>` (mismas keys; se recarga a `switchState` en cada cambio de sesión).
- [x] Imagen/adjuntar (app.js:481-687): `normalizeImage` (canvas → PNG, lado máx 1600),
  chip de preview en dos pasos (mostrar → tap confirma y sube a
  `POST /api/paste-image`, ✕ descarta), estados de error/reintento en el meta del chip,
  `URL.revokeObjectURL` al limpiar, paste global de Cmd/Ctrl+V (imagen desde cualquier
  lado; texto **solo si el foco no está en `.term-wrap`** — xterm ya pega solo),
  `pasteFromClipboard` con prioridad imagen > texto, `pasteTextToPrompt` =
  `claudeConn.term.paste(text)` (bracketed paste: multilínea sin submit).
- [x] `Composer.tsx` (app.js:696-781): **siempre montado**, toggle con clase; el
  textarea es un ref no-controlado (los borradores se guardan con debounce 500ms en
  `draft:<sesión>`, no re-render por tecla). Al abrir: `ta.focus()` **sincrónico dentro
  del pointerup** (iOS no abre teclado desde timers) + fit en rAF. `composer-open` en
  `document.body`. Cancelar guarda borrador; enviar = `paste` + `\r` diferido 150ms +
  limpia borrador. `composerNewline` inserta `\n` con `setRangeText` (+ save manual:
  no dispara `input`).
- [x] `Snippets.tsx` (app.js:792-1076): paleta compartida popover/composer, lista global
  server-synced (GET al abrir con cache + refresh en background que solo re-pinta si
  cambió y no hay edición en curso), modo edición (rename/borrar/mover-uno-antes con
  `prompt/confirm`), `PUT /api/snippets` con manejo de error. Insertar **nunca envía**:
  en composer `setRangeText` en el cursor; si no, `term.paste`. ☰ ámbar mientras la
  paleta esté abierta.
- [x] `SnipTip.tsx` (app.js:887-930): tooltip de texto completo — hover en desktop
  (solo si el span está truncado: `scrollWidth > clientWidth+1`), long-press 450ms en
  touch, y el flag `snipTipSuppressTap` para que el release de un peek **no** inserte.
  Posicionamiento fixed clampeado al viewport, sobre el chip.

**Aceptación:** todos los flujos de la controlbar idénticos a la app actual, probados
en iOS: dictado/autocorrección en composer, borrador sobrevive a matar la pestaña,
snippets sincronizan entre dispositivos, foto de la cámara llega como `[Image #N]`.

### Fase 4 — Overlays: scrollback + host

**Tareas:**

- [x] `Scrollback.tsx` (app.js:1088-1231): overlay siempre montado. Fuente primaria
  `GET /api/claude/transcript` (turnos; asistente renderizado con
  `DOMPurify.sanitize(marked.parse(text, {breaks:true}))` en `dangerouslySetInnerHTML`
  + clase `md-body`; user/tool como texto plano), fallback `GET /api/tmux/scrollback`
  (pane, `<pre>`). Preservar: pasos de fetch (2MB→x2 hasta 32MB / 500→+500 hasta 5000),
  "Cargar más" se oculta al llegar al techo **o si el re-fetch no creció**
  (`sbTurnCount`), tamaño de letra A−/A+ persistido (`deck-sb-font`, 10-20px, var
  `--sb-font`), y el **anclaje de lectura**: capturar `scrollHeight/scrollTop` antes de
  pintar y restaurar en `useLayoutEffect` (fondo en carga inicial; compensado en "cargar
  más" — app.js:1110-1112). Cerrar suelta el contenido del DOM.
- [x] `HostSheet.tsx` + chip + banner (app.js:1241-1416): chip 🔋 solo si
  `hostStatus.battery` (con la barrita SVG proporcional y `.warn` bajo umbral), banner
  ámbar descartable **por episodio** (`hostBannerDismissed` se re-arma al salir del
  episodio de descarga), bottom sheet con filas (batería/energía/reposo/uptime,
  `BATT_STATES` traducidos), toggle + umbral (prompt 5-95) → `POST /api/host/alert`
  y el `alert` de la respuesta pisa el estado local. Tap en el fondo cierra.
  Mostrar/ocultar banner → `fit()` en rAF (roba filas a la terminal).

**Aceptación:** scrollback abre al fondo, "cargar más" no salta la posición de lectura,
markdown del asistente renderiza sanitizado (el ui-test tiene un check de XSS con
`<img onerror>`), fallback a pane en un shell pelado; panel de host refleja
`deck away` y el banner aparece/desaparece con el umbral.

### Fase 5 — Pestañas Cambios y Archivos

**Tareas:**

- [x] `ChangesView.tsx` (app.js:1633-1785): summary → header (`⎇ rama`, `↑↓ upstream`),
  grupos Staged/Sin stagear, filas con badge + path + botón `+/−` (stage/unstage con
  `stopPropagation`, disabled mientras corre, `POST /api/git/stage`), badge de la tab
  (`99+` cap), fallback a `/api/git/summary` sin `?session=` si la sesión no tiene repo.
  Diff: `Diff2Html.html(text, {drawFileList:false, matching:'lines',
  outputFormat:'line-by-line'})` en `dangerouslySetInnerHTML`, botón ← vuelve.
  `inDiff` bloquea el auto-refresh (no pisar la vista).
- [x] `FilesView.tsx` (app.js:1791-2081): árbol recursivo `<TreeNode>` con estado local
  `{expanded, loaded, entries}` — expandir la primera vez fetchea (`/api/fs/list`),
  colapsar **conserva** lo cargado; carpetas primero (ya viene del server), iconos de
  `lib/icons.ts` + tinte de `extClass`/`fileIcon`, notas de truncado/vacío.
  Lógica de caché por sesión/raíz (app.js:1950-1988): re-listar la raíz en cada
  refresh; si `data.root` no cambió, **no tocar el árbol** (expansión y archivo abierto
  sobreviven); guards de respuestas viejas (`ses !== state.session`).
- [x] Vista de archivo (app.js:2036-2081): `/api/fs/file`, binario → nota, código →
  `highlightInto` (límite 200KB, fallback texto plano), `.md` → toggle 👁 fuente ↔
  renderizado (`DOMPurify.sanitize(marked.parse(...))`), nota de truncado a 512KB.
  Registrar el hook de DOMPurify (links → `target=_blank rel=noopener`) **una vez** en
  `main.tsx` (app.js:1994-2001).

**Aceptación:** paridad total con las dos pestañas actuales: stage/unstage, diffs
legibles line-by-line, árbol lazy con expansión persistente entre polls, markdown
renderizado, seguimiento del cwd de la sesión al hacer `cd`.

### Fase 6 — PWA, swap de estáticos, tests y limpieza

**Tareas:**

- [x] `web/public/`: `manifest.json`, `sw.js`, `icon.svg` copiados de `public/`
  (Vite los emite a `web/dist/`). SW registrado en `main.tsx` igual que hoy
  (app.js:2220-2222). Verificado: server sirve `/manifest.json` `/sw.js` (no-cache)
  `/icon.svg` con 200 y MIME correcto desde `web/dist`.
- [ ] Verificación de paridad completa (checklist §6) hecha por Lucas en el teléfono
  con `npm run build` servido por el server real + tailscale. **(pendiente — Lucas)**
- [x] `test/ui-test.mjs`: revisado — no requiere cambios. Apunta al server real
  (`:7433`, ahora sirviendo `web/dist`) y depende solo de ids/clases y `window.claudeConn`,
  todos preservados. **Lucas lo corre.**
- [x] `test/shot-diff.mjs`: revisado — sigue útil sin cambios (usa `#diff-view`,
  `.file-row`, `.d2h-*`, presentes en `ChangesView`).
- [ ] Borrar `public/` (el server ya solo sirve `web/dist`); simplificar el dual-root
  del server si se quiere, o dejarlo (inofensivo). **(pendiente — recién tras la
  verificación de paridad de Lucas; hasta entonces `public/` es el fallback seguro.)**
- [x] Docs: README §Setup (`npm --prefix web install` + `npm run build` antes de
  `deck start`/LaunchAgent, y `dev:web` para iterar), `docs/SETUP.md` (idem), y nota en
  `docs/SPEC.md` §3 de que el stack de frontend quedó obsoleto (ahora React).
- [x] `.gitignore`: ya tenía `web/dist` y `web/node_modules`.

---

## 4. Contratos que NO pueden romperse (referencia rápida)

Protocolo y datos — idénticos byte a byte:

- **WS** `/ws/term?session=<s>[&create=1]`: mensajes `in/resize/refresh/vis` ⇄ `out/meta`.
  `create=1` **solo** cuando este cliente pidió crear (botón +).
- **localStorage keys**: `deck-active-session`, `deck-switch:<sesión>`, `draft:<sesión>`,
  `deck-sb-font`. Migración en rename, limpieza en kill.
- **Secuencias de teclado**: `KEYS` (app.js:301-311), shift+enter = `\x1b\r`,
  mode = `\x1b[Z`, rueda SGR `\x1b[<64/65;col;rowM`, `\r` diferido 150ms tras
  slash-commands y composer-send.
- **Presencia**: `{t:'vis', visible}` al conectar, en cada visibilitychange (incluido
  → hidden) y re-afirmado en el poll de 8s.

Matices de comportamiento (el "por qué" está comentado en app.js — migrar comentarios):

- Anti-resurrección de sesiones + `expectCreate` + fallback a sesión viva (app.js:150-166, 1535-1553).
- `resume()` con watchdog de refresh 2s → detecta WS zombie de iOS (app.js:199-228).
- Resize solo-si-cambió + fit con debounce (tmux repinta todo en cada resize).
- Un solo attach vivo por terminal (cerrar el socket viejo antes de abrir otro).
- Bracketed paste para multilínea (nunca `\r` crudo por línea).
- Borradores por sesión con debounce; Cancelar conserva, Enviar limpia.
- Long-press de snippet = peek, su release no inserta (`snipTipSuppressTap`).
- Banner de batería descartable por episodio, con re-arme.
- Scrollback: anclaje de lectura al cargar más; techo por bytes Y por no-crecimiento.
- Refresh de árbol/git que nunca pisa: `inDiff`, `treeRoot` sin cambio, respuestas viejas.
- Sanitizado DOMPurify **obligatorio** en todo HTML derivado de contenido
  (transcript, .md del repo, y el hook global de links `target=_blank`).

## 5. Pitfalls específicos de React (leer antes de codear)

1. **La vista Claude no se desmonta jamás.** xterm + WS viven en un singleton de módulo;
   las tabs togglean `.active` por CSS (como hoy). Si React desmonta `#term-claude`,
   se pierde el buffer y se duplica el attach al volver.
2. **Sin StrictMode** (ver §1). Si alguien lo activa, el doble-effect crea dos WS y el
   pty pelea el tamaño del pane — el síntoma es texto doblado y flickering.
3. **Focus de iOS es sincrónico**: `focus()` de textarea/input tiene que correr dentro
   del handler del gesto (pointerup), nunca tras `setState`+render diferido ni timers.
   Con overlays siempre montados esto es trivial (el nodo ya existe).
4. **`useTap` debe hacer `preventDefault()` en pointerdown** — es lo que evita que el
   teclado virtual se cierre al tocar quickkeys. No reemplazar por `onClick`.
5. **`fit()` tras cambios de layout va en `requestAnimationFrame`** (hint, banner,
   composer, img-chip, cambio a tab claude): el DOM tiene que estar pintado antes de
   medir. En React: `useLayoutEffect` + rAF, o rAF tras el toggle de clase.
6. **Scrollback**: capturar `scrollHeight/scrollTop` ANTES del setState que pinta los
   turnos nuevos y restaurar en `useLayoutEffect` — con effects normales la restauración
   llega tarde y la vista salta.
7. **`dangerouslySetInnerHTML` solo en cuatro lugares**, siempre con la misma fuente
   que hoy: diff2html (salida de git, ya escapada por la lib), hljs (`.value` escapado),
   y marked+DOMPurify (transcript y .md). Nada más.
8. **El textarea del composer es no-controlado** (ref + eventos): controlarlo re-rendería
   por tecla y complica `setRangeText` (snippets/\n insertados en el cursor).
9. **`window.claudeConn`** debe existir con la misma forma (`term`, `sendKeys`, `fit`,
   `reconnect`, `sendVis`, `resume`, `currentSession`) — `ui-test.mjs` lo parchea.
10. **El árbol de archivos guarda estado en cada nodo** (expandido + hijos cargados);
    las keys de React deben ser el path relativo para que un re-render de la raíz no
    resetee la expansión cuando `data.root` no cambió.

## 6. Checklist de paridad final (Fase 6, en el teléfono)

- [ ] Auth: `?token=` → cookie → recarga sin token; 401 muestra `#auth-error`.
- [ ] Terminal en vivo bidireccional con VS Code; teclado/rotación/background-resume.
- [ ] Quickkeys, mode switcher, modelo/esfuerzo por sesión.
- [ ] Multi-sesión: crear (+), renombrar (tap en nombre), matar (✕), fallback,
  semáforo (verde/ámbar/gris), deep-link `?session=` desde push.
- [ ] Composer: borrador por sesión, dictado iOS, \n, snippets en cursor, enviar.
- [ ] Snippets: popover, edición, orden, sync entre dispositivos, tooltip long-press.
- [ ] Imagen: cámara/galería/portapapeles → chip → confirmar → `[Image #N]`.
- [ ] Scrollback: transcript con markdown, cargar más sin saltos, A−/A+, fallback pane.
- [ ] Host: chip batería, sheet, toggle/umbral de alerta, banner por episodio.
- [ ] Cambios: badge, staged/unstaged, +/−, diff line-by-line, auto-refresh 8s.
- [ ] Archivos: árbol lazy, iconos, syntax highlight, .md renderizado, sigue el cwd.
- [ ] PWA: instalable, presencia suprime push (mirando la app no llega push).
- [ ] `test/ui-test.mjs` verde (lo corre Lucas).

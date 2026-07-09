# claude-deck

Panel remoto móvil (PWA) para controlar, desde el celular vía Tailscale, **la misma sesión interactiva de Claude Code** que corre en la Mac dentro de tmux: terminal en vivo, no un resume. Suma estado git (diffs legibles) y un explorador de archivos de solo lectura. Todo corre local; el celular es solo una ventana.

## Arquitectura (decisión clave, no cambiar)

La sesión de Claude Code corre dentro de **tmux**. VS Code y el celular hacen `attach` a la misma sesión tmux: ambos ven y controlan lo mismo en tiempo real, y cerrar el navegador nunca mata la sesión. **No usar el Claude Agent SDK para esto**: `resume()` solo puede retomar una sesión *después*, no engancharse en vivo a la que ya corre en la CLI de VS Code (queda documentado como fase 2, no implementada, ver README).

## Stack

- Server: Node 20+/TypeScript vía `tsx`, **Hono** + **ws** + **node-pty** + `web-push` (VAPID). Sin base de datos. Un solo archivo: `server/index.ts`.
- Frontend: **React 19 + TypeScript + Vite 6** (`web/`), zustand, `@xterm/xterm`, `diff2html`, `marked`/`dompurify`/`highlight.js`.
- `scripts/deck`: LaunchAgent de macOS + `tailscale serve` para el modo remoto.

## Build / dev

- `npm run build`: **obligatorio** tras tocar `web/src/`, genera `web/dist`, lo único que sirve el server (single-root; el server frena al boot si falta el build).
- `npm run dev`: server en `:7433` con watch.
- `npm run dev:web`: Vite en `:5173` con hot-reload, proxea `/api` y `/ws` al server con el token.
- El server de producción **no corre a mano**: es un LaunchAgent sin watch. `scripts/deck stop` + `npm run dev` para desarrollar; `launchctl kickstart -k gui/$(id -u)/com.claude-deck` para que un LaunchAgent activo tome cambios de `server/index.ts` sin pasar por eso.

## Seguridad (no negociable)

Bind solo a `127.0.0.1`; la única exposición es `tailscale serve` (HTTPS + WireGuard, tailnet propio, jamás `0.0.0.0` ni abrir puertos al router). `AUTH_TOKEN` obligatorio incluso dentro del tailnet. `WORKSPACES_ROOT` es el perímetro de seguridad: ningún endpoint git/fs opera fuera de esa raíz. Sin ejecución arbitraria por HTTP, solo subcomandos fijos de `git`/`tmux`, sin shell. Detalle completo en el README, sección "Seguridad".

## Gotchas críticos

1. **Si esta sesión corre dentro de la sesión tmux `deck`** (chequeá `echo $TMUX`), **nunca la mates** (`tmux kill-session =deck`): te suicidás vos mismo a mitad de tarea. Antes de matar `deck` para testear algo, confirmá que no sea la sesión actual.
2. **node-pty no crea ptys bajo el sandbox de Bash**: correr server/tests con `dangerouslyDisableSandbox: true`.
3. El server lee `DECK_PORT`, **no** `PORT` (se ignora a propósito: los perfiles de shell suelen exportar `PORT`).

## Pitfalls de React (leer antes de tocar `web/src/`)

1. La vista Claude **nunca se desmonta**: xterm+WS son singleton de módulo, las tabs togglean `.active` por CSS.
2. **Sin StrictMode**: el doble-effect duplicaría el attach del WS (texto doblado, pelea de resize).
3. El focus en iOS debe ser **sincrónico dentro del gesto** (pointerup), nunca tras `setState` + render diferido.
4. `useTap` hace `preventDefault()` en pointerdown (si no, el teclado virtual se cierra al tocar las quickkeys). No reemplazar por `onClick`.
5. `fit()` de xterm tras cambios de layout va en `requestAnimationFrame`: el DOM tiene que estar pintado antes de medir.
6. `window.claudeConn` debe mantener su forma (`term`, `sendKeys`, `fit`, `reconnect`, `sendVis`, `resume`, `currentSession`): `ui-test.mjs` lo parchea.
7. `dangerouslySetInnerHTML` solo en diff2html/hljs/marked+DOMPurify: todo HTML derivado de contenido externo (transcript, `.md`) se sanitiza.

## Convenciones

- `design-refs/*.png` (gitignoreado): mockups de referencia visual, nunca commitear ni editar.
- Tests: `test/ws-test.mjs` y los scripts scratch de puppeteer los corre el agente, siempre contra sesiones/repos **scratch**, nunca contra la sesión `deck` real ni su git. `test/ui-test.mjs` el agente lo actualiza pero **lo corre el usuario**.

## Dónde mirar según lo que necesites

- **Estado reciente, última sesión, gotchas puntuales**: `docs/HANDOFF.md`, si existe (bitácora local, gitignoreada: no viene en un clone nuevo).
- **Backlog activo**: `docs/TASKS2.md`, si existe (también gitignoreado).
- **Instalación paso a paso**: `docs/SETUP.md`.
- **Referencia completa de API, UX y seguridad**: `README.md`.

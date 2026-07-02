# HANDOFF — claude-deck

**Fecha:** 2026-07-02 · **Estado:** v1 completa y funcionando; el usuario la probó desde el celular. **Próximo foco: arreglar issues de UI** (el usuario dijo "there are several UI issues but the app is working" — **no los enumeró; pedirle la lista antes de tocar nada**).

## Qué es y dónde está todo

Panel remoto móvil (PWA) para controlar sesiones de Claude Code corriendo en tmux, vía Tailscale. No dupliques contexto: los requisitos completos están en `SPEC.md` (los 10 criterios de aceptación de §10 fueron implementados y verificados) y la documentación de uso/seguridad/API en `README.md`.

- `server/index.ts` — todo el backend (Hono + ws + node-pty, un solo archivo)
- `public/` — frontend vanilla: `index.html`, `app.js` (lógica), `style.css` (tema), PWA (`manifest.json`, `sw.js`, `icon.svg`)
- `test/ws-test.mjs` — suite E2E de WS/tmux/API (14 checks, todos PASS)
- `test/ui-test.mjs` — smoke test de UI en Chromium headless, viewport iPhone (15 checks, todos PASS; saca screenshots)
- `.claude/settings.example.json` + `scripts/notify.sh` — hooks ntfy (bonus §12), **inactivos** hasta que el usuario los renombre a `settings.json` (un guard de permisos impidió crearlo activo)

## Estado del entorno

- **Repo git inicializado pero sin ningún commit** — todo está untracked. El usuario no pidió commitear; no lo hagas sin preguntar.
- `.env` existe y funciona (REPO_DIR apunta a este mismo repo; `AUTH_TOKEN` real adentro — **no imprimirlo ni commitearlo**, ya está en `.gitignore`).
- `tailscale serve --bg 7433` quedó **activo y persistente** → `https://<maquina>.<tailnet>.ts.net` (verificar con `tailscale serve status`).
- El server (`npm run dev`) corría en background de la sesión anterior — probablemente muerto; relanzarlo.
- Sesiones tmux de prueba: limpiadas. El usuario pudo haber creado nuevas al probar desde el celu (`tmux ls`).

## Gotchas descubiertos (no están en el README)

1. **node-pty 1.1.0**: el prebuild trae `spawn-helper` sin bit de ejecución → `posix_spawnp failed`. Hay un `postinstall` en `package.json` que lo arregla. Si aparece ese error, correr `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
2. **CDN**: la spec pedía cdnjs, pero cdnjs ya no hostea `@xterm/addon-fit` ni los bundles de diff2html (verificado contra su API). Se usa **jsdelivr**: `@xterm/xterm@5.5.0`, `@xterm/addon-fit@0.10.0`, `diff2html@3.4.52`. Globals UMD: `Terminal`, `FitAddon.FitAddon`, `Diff2Html`.
3. **tmux 3.7b**: `display-message -p -t '=sesion-inexistente:'` devuelve string vacío con **exit 0** (no error). Está manejado en `resolveGitDir` con `has-session` previo — no "simplificar" eso.
4. **Sandbox de Claude Code**: node-pty no puede crear ptys bajo el sandbox de Bash. Para correr el server o los tests desde el agente hay que usar `dangerouslyDisableSandbox: true`.
5. **RTK** (hook del usuario que filtra output de comandos): rompe la inspección de JSON de `curl`. Usar `rtk proxy <cmd>` para ver salida cruda.
6. **Buffering**: el banner de arranque del server tarda en aparecer en logs de background (stdout bufferizado al pipear); en TTY real sale al instante.
7. Un fallo de `pty.spawn` cierra solo ese WS (código 1011), nunca el proceso — ese try/catch en `handleTerm` existe por una razón (antes tumbaba el server entero).

## Cómo correr y verificar

```bash
npm run dev                    # server en http://127.0.0.1:7433 (imprime URLs con token)
node test/ws-test.mjs          # E2E de WS/tmux/API (necesita server arriba; crea/usa sesiones tmux deck*)
node test/ui-test.mjs          # UI headless (necesita: npm i -D puppeteer-core)
```

`ui-test.mjs` usa el Chromium cacheado de Playwright en `~/Library/Caches/ms-playwright/chromium_headless_shell-1223/` (path hardcodeado en el script; ajustar si cambia la versión). Deja screenshots en `test/shot-*.png` — útiles para iterar sobre los fixes de UI sin celular. Para reproducir condiciones móviles reales (teclado virtual, `visualViewport`, safe-areas) el screenshot headless no alcanza; pedirle al usuario que verifique en el dispositivo.

## Sugerencias para los UI issues (a confirmar con el usuario)

Zonas candidatas típicas dado el diseño actual: manejo del teclado virtual con `visualViewport` (función `updateViewportHeight` en `app.js`), re-fit de xterm al rotar/cambiar de pestaña, safe-area insets en iPhone, tamaño/scroll del diff en pantallas chicas, y el hint de sesión nueva tapando la terminal. Todos se tocan en `public/app.js` y `public/style.css`.

## Suggested skills

- **`/verify`** — después de cada fix de UI, para exercitar el flujo real (levantar server, driver headless, screenshots) en vez de asumir que el CSS quedó bien.
- **`/run`** — para levantar la app y sacar screenshots rápidos al iterar en la UI.
- **`/code-review`** — antes del primer commit (todo el proyecto está sin commitear; sería buen momento para una pasada).
- **`/simplify`** — opcional tras los fixes, para limpiar `app.js`/`style.css` si crecieron desprolijos.

## Pendientes explícitos

1. **UI issues** (foco de la próxima sesión — pedir lista al usuario).
2. Primer commit del proyecto (solo si el usuario lo pide).
3. Usuario debe activar hooks ntfy si los quiere (`mv .claude/settings.example.json .claude/settings.json` + `NTFY_TOPIC` en `.env`).
4. Fase 2 (chat nativo con Agent SDK) — documentada en `README.md` y `SPEC.md` §11, **no implementar** sin pedido explícito.

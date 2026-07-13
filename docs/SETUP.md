# Setup — claude-deck

Guía de instalación desde cero en una Mac propia.

## 1. Requisitos previos

- macOS con `tmux` y `git` instalados
- Node.js 20 o superior (`engines` exige `>=20`)
- Cuenta de [Tailscale](https://tailscale.com), con la app instalada e iniciada sesión en la Mac **y** en el teléfono (misma cuenta)
- Claude Code CLI instalado y autenticado (`claude` debe funcionar en la terminal)

## 2. Instalación

```bash
git clone <este-repo> && cd claude-deck
npm install                 # deps del server
npm --prefix web install    # deps del frontend (React/Vite)
cp .env.example .env
```

Editar `.env` con las dos variables obligatorias:

```bash
WORKSPACES_ROOT=/ruta/que/contiene/tus/proyectos   # ej: /Users/vos/proyectos
AUTH_TOKEN=<salida de: openssl rand -hex 32>       # mínimo 32 caracteres
```

`WORKSPACES_ROOT` es el **perímetro de seguridad**: el server no lee archivos ni opera git fuera de esa ruta, sin importar en qué directorio esté parada una sesión tmux. Cualquier repo adentro funciona sin configurar nada más.

Opcionales (una línea cada una): `DEFAULT_DIR` (directorio "home" del panel — dónde nacen las sesiones tmux nuevas; default `WORKSPACES_ROOT`, debe caer adentro de él), `DECK_PORT` (puerto local, default `7433`), `TMUX_SESSION` (nombre de la sesión tmux, default `deck`).

## 3. Prueba local

El frontend es React + Vite (código en `web/`); el server sirve `web/dist` si existe, si no cae a `public/`. Buildealo una vez y arrancá el server:

```bash
npm run build   # genera web/dist (lo que sirve el server)
npm run dev     # server en :7433, con watch sobre server/index.ts
```

La consola imprime la URL local con `?token=` lista para abrir en el navegador.

Para iterar sobre el frontend sin re-buildear, corré además `npm run dev:web` (Vite en `:5173`, proxya `/api` y `/ws` al server) y abrí `http://127.0.0.1:5173`.

## 4. Servicio permanente y exposición al tailnet

**Antes de instalar el servicio, buildeá el frontend** (`npm run build`): el LaunchAgent corre `tsx server/index.ts`, que sirve el `web/dist` ya generado y no buildea nada por su cuenta. Re-corré `npm run build` cada vez que cambie el frontend.

Una sola vez (**nunca ejecutar con sudo**; el script pide sudo solo cuando lo necesita):

```bash
npm run build
scripts/deck install
```

Esto instala el server como LaunchAgent de macOS (arranca al iniciar sesión y se reinicia automáticamente si se cae), configura `tailscale serve` — la exposición queda limitada al tailnet propio y es persistente — y al final imprime la URL para el teléfono con el token incluido, junto con un código QR si `qrencode` está instalado (`brew install qrencode`, opcional pero recomendado).

## 5. Configurar el teléfono

Ejecutar `scripts/deck url` y escanear el QR con la cámara del teléfono (o tipear la URL impresa):

```
https://<maquina>.<tailnet>.ts.net/?token=<AUTH_TOKEN>
```

La primera visita deja una cookie; después ya no hace falta el token en la URL. Desde el menú del navegador, instalar como PWA con **Add to Home Screen**.

## 6. Uso diario

Alias recomendado en `~/.zshrc`:

```bash
alias deck='<ruta-al-repo>/scripts/deck'
```

- `deck claude [flags]` — lanza Claude Code en una sesión tmux nombrada según el directorio actual, visible al instante en el teléfono. Los flags se pasan a claude (ej. `deck claude --continue`). Las variantes `deck cc` / `deck ccw` requieren tener esos alias propios definidos.
- `deck shellinit`: para que tus `cc`/`ccw` **nunca queden fuera de tmux** (una sesión de Claude fuera de tmux no se puede seguir desde el celu). Agregá una línea a tu `~/.zshrc`, reemplazando los aliases `cc`/`ccw`:
  ```bash
  eval "$(deck shellinit)"
  ```
  Convierte `cc`/`ccw` en funciones: interactivo y fuera de tmux, la sesión nace en tmux (la ves de una en el celu); ya adentro de tmux, en pipes/scripts o con `-p`/`--print`, corren claude directo sin envolver. Preservan la cuenta de cada alias (`ccw` = `CLAUDE_CONFIG_DIR=~/.claude-work`). Para volver atrás, comentá el `eval` y devolvé los aliases.
  - **Atajo opcional de VS Code** (para quien clone y viva en la terminal integrada): un `.vscode/tasks.json` en el proyecto con una task que abra una terminal ya corriendo `deck cc`, disparable desde la Command Palette (`Tasks: Run Task`) o con un keybinding. No viene en el repo; snippet base:
    ```json
    { "version": "2.0.0", "tasks": [ {
        "label": "Claude en tmux (deck)", "type": "shell",
        "command": "deck cc", "presentation": { "reveal": "always", "panel": "dedicated" },
        "problemMatcher": [] } ] }
    ```
- `deck expose <puerto>` / `deck unexpose <puerto>`: abrir en el celu **otra** app local (un dev server, un Storybook), no el panel. Publica `localhost:<puerto>` en el tailnet por HTTPS y te da la URL + QR; `deck expose` sin puerto lista lo expuesto. Ojo: la app queda visible a todo tu tailnet y **sin** el `AUTH_TOKEN` del panel (ver sección 8). Si es un dev server, activá `server.allowedHosts: true` en la config de dev para que ande por el hostname del tailnet.
- `deck attach [nombre]`: seguir en la Mac una sesión que arrancaste desde el celu (dispatch o worktree crean sesiones tmux planas; el nombre es el mismo que ves como chip de sesión en el panel). Con nombre, attachea directo; sin nombre, lista las vivas y elegís por número. Es un atajo de `tmux ls` + `tmux attach -t <nombre>` (desde otro tmux hace `switch-client`, no anida).
- `deck adopt`: rescata una **sesión huérfana**, un `claude` interactivo que quedó fuera de tmux (típico: arrancado a secas en la terminal integrada de VS Code) y que por eso el celu no ve. Lista los huérfanos vivos con su cwd y estado (idle/working); con uno solo confirma sí/no y nunca mata sin confirmar. Si está trabajando espera a que termine el turno (Ctrl-C cancela), lo cierra limpio y relanza `claude --continue` en una sesión tmux del mismo directorio: se conserva la conversación entera, solo se pierde el turno en vuelo. Es el plan B de `deck shellinit` (que evita crear huérfanos de entrada): mejor prevenir con aquél que rescatar con este.
- `deck away` — al irse: verifica todo de punta a punta y desactiva el sueño. Cerrar la tapa **con la Mac enchufada**. Lo mismo se puede disparar **desde la PWA**: chip 🔋 → switch "Modo away" (además revive el host de Chrome Remote Desktop si estaba caído).
- `deck back` — al volver: la Mac vuelve a dormir normalmente.
- `deck status` / `deck log` — diagnóstico.
- `deck help` — referencia completa de subcomandos.
- **Pantalla de la Mac en el celu**: se resuelve con **Chrome Remote Desktop**, no con el panel (el razonamiento, en `docs/adr/0001`). Setup una vez: `remotedesktop.google.com/access` en Chrome de la Mac → instalar el host → nombre + PIN → permisos de Grabación de pantalla y Accesibilidad; app de CRD en el celu con la misma cuenta de Google (protegela con 2FA fuerte: es una llave de la Mac). El deck vigila que el host no quede caído (watchdog + fila en el panel de host + switch "Modo away").

## 7. Notificaciones push (opcional)

Para recibir un push en el teléfono cuando Claude pide un permiso o termina una tarea. Son **Web Push nativas de la PWA** (el server local firma con VAPID y se las manda al push service de Apple/Google; sin servicios de terceros — ntfy se retiró): tocarlas abre la app instalada con esa sesión seleccionada.

1. Suscribirse desde el teléfono: con la PWA instalada (*Add to Home Screen*, requisito de iOS 16.4+), tocar la **campanita 🔔** en la fila de sesiones y aceptar el permiso. Campanita ámbar = suscripto. Sin suscripción **no hay push**: si el server tuvo avisos sin entregar, el panel muestra un banner (y queda en `deck log`).

2. Activar los hooks de Claude Code para este repo:

   ```bash
   mv .claude/settings.example.json .claude/settings.json
   ```

   Para tener push en **cualquier** repo, en cambio, definir los hooks `Notification`, `PermissionRequest` y `Stop` en el `settings.json` global (`~/.claude/settings.json`) apuntando a la ruta absoluta de `scripts/notify.sh` (no combinar ambos: el hook local y el global mandarían la notificación dos veces). `PermissionRequest` es el que hace que el push diga el comando exacto que Claude quiere correr; con `Notification` solo, el cuerpo queda genérico.

   > Aunque los hooks vivan en el `settings.json` global, siguen dependiendo de este repo: `notify.sh` lee el `AUTH_TOKEN` del `.env` de claude-deck para hablarle al server local. O sea, la ruta global no es autocontenida — este repo tiene que seguir existiendo en la máquina con su `.env`.

   El mismo archivo de ejemplo registra también `scripts/state.sh` en `UserPromptSubmit`, `PreToolUse`, `Notification`, `PermissionRequest` y `Stop`: es el que alimenta el **semáforo** de los chips (verde = trabajando, ámbar = espera input, gris = idle) y no manda push. Para verlo en cualquier repo va igual que notify.sh: los mismos cinco eventos en el settings global, con la ruta absoluta (`state.sh working` en los dos primeros, `state.sh waiting` en los de permiso, `state.sh idle` en Stop).

   Y registra `scripts/statusline.sh` como el `statusLine` del perfil: alimenta la **statusline del panel** (% de contexto, tokens, modelo, costo). A diferencia de los hooks, `statusLine` es **un único objeto** por `settings.json` (no una lista), así que si ya tenés una statusline propia hay que encadenarla, no duplicar el campo: `statusline.sh` le pasa el mismo stdin a la statusline previa (`DECK_STATUSLINE_CHAIN`, default `~/.claude/statusline-command.sh`) y muestra su salida, agregando solo la escritura del `.status.json` que consume el panel. Para el global va igual: `{ "statusLine": { "type": "command", "command": "bash /ruta/abs/scripts/statusline.sh" } }` (registralo con `jq` + backup si ya tenías un `statusLine`). Sin este hook, la statusline del panel simplemente no aparece.

Probar con `TMUX=1 scripts/notify.sh 'prueba'` (con el teléfono bloqueado o la Mac idle — el push se suprime si ya estás mirando): la notificación debe llegar al teléfono. Nota: `notify.sh` solo notifica sesiones que corren dentro de tmux (las controlables remoto) y necesita `jq`; un `claude` en una terminal común no manda push.

El push lleva la sesión tmux como título y un deep-link relativo que el service worker resuelve contra su propio scope: el tap abre la PWA con esa sesión seleccionada, sin depender de `DECK_URL` (que sí usa el server como contacto VAPID — Apple valida ese subject).

## 8. Seguridad

El server escucha únicamente en `127.0.0.1`; la única exposición es vía `tailscale serve` (HTTPS + WireGuard, visible solo para los dispositivos del tailnet propio). El `AUTH_TOKEN` no se comparte ni se sube al repositorio: `.env` queda fuera del control de versiones.

Una excepción deliberada la abre `deck expose <puerto>` (sección 6): publica **otra** app local (`localhost:<puerto>`) en el tailnet vía `tailscale serve`, **fuera** del `AUTH_TOKEN` del panel y de `WORKSPACES_ROOT`. La protege solo el tailnet (WireGuard); no es un endpoint del server ni un proxy, sino un comando que corrés vos a mano. Exponé solo lo que quieras que vea tu tailnet, y bajá cada mapeo con `deck unexpose <puerto>` al terminar (son persistentes).

La otra dependencia asumida es Chrome Remote Desktop para ver la pantalla (sección 6): identidad y señalización por Google, a propósito fuera del tailnet (sirve de acceso de emergencia si Tailscale se cae). Tu cuenta de Google pasa a ser una llave de la Mac: 2FA fuerte obligatoria. El detalle y la alternativa all-local quedaron en `docs/adr/0001` del repo y en la sección Seguridad del README.

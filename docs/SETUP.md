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
- `deck away` — al irse: verifica todo de punta a punta y desactiva el sueño. Cerrar la tapa **con la Mac enchufada**.
- `deck back` — al volver: la Mac vuelve a dormir normalmente.
- `deck status` / `deck log` — diagnóstico.
- `deck help` — referencia completa de subcomandos.

## 7. Notificaciones push (opcional)

Para recibir un push en el teléfono cuando Claude pide un permiso o termina una tarea:

1. Generar un topic secreto y agregarlo al `.env`:

   ```bash
   echo "NTFY_TOPIC=$(openssl rand -hex 16)" >> .env
   ```

2. Activar los hooks de Claude Code para este repo:

   ```bash
   mv .claude/settings.example.json .claude/settings.json
   ```

   Para tener push en **cualquier** repo, en cambio, definir los hooks `Notification`, `PermissionRequest` y `Stop` en el `settings.json` global (`~/.claude/settings.json`) apuntando a la ruta absoluta de `scripts/notify.sh` (no combinar ambos: el hook local y el global mandarían la notificación dos veces). `PermissionRequest` es el que hace que el push diga el comando exacto que Claude quiere correr; con `Notification` solo, el cuerpo queda genérico.

   El mismo archivo de ejemplo registra también `scripts/state.sh` en `UserPromptSubmit`, `PreToolUse`, `Notification`, `PermissionRequest` y `Stop`: es el que alimenta el **semáforo** de los chips (verde = trabajando, ámbar = espera input, gris = idle) y no manda push. Para verlo en cualquier repo va igual que notify.sh: los mismos cinco eventos en el settings global, con la ruta absoluta (`state.sh working` en los dos primeros, `state.sh waiting` en los de permiso, `state.sh idle` en Stop).

   Y registra `scripts/statusline.sh` como el `statusLine` del perfil: alimenta la **statusline del panel** (% de contexto, tokens, modelo, costo). A diferencia de los hooks, `statusLine` es **un único objeto** por `settings.json` (no una lista), así que si ya tenés una statusline propia hay que encadenarla, no duplicar el campo: `statusline.sh` le pasa el mismo stdin a la statusline previa (`DECK_STATUSLINE_CHAIN`, default `~/.claude/statusline-command.sh`) y muestra su salida, agregando solo la escritura del `.status.json` que consume el panel. Para el global va igual: `{ "statusLine": { "type": "command", "command": "bash /ruta/abs/scripts/statusline.sh" } }` (registralo con `jq` + backup si ya tenías un `statusLine`). Sin este hook, la statusline del panel simplemente no aparece.

3. Suscribirse al topic en el teléfono: con la app [ntfy](https://ntfy.sh), o sin instalar nada abriendo `https://ntfy.sh/<topic>` en el navegador y tocando **Subscribe** (en iPhone hace falta *Add to Home Screen* primero — iOS solo entrega web push a PWAs instaladas).

Probar con `TMUX=1 scripts/notify.sh 'prueba'`: la notificación debe llegar al teléfono. Nota: `notify.sh` solo notifica sesiones que corren dentro de tmux (las controlables remoto); un `claude` en una terminal común no manda push.

El push lleva la sesión tmux como título y, si `DECK_URL` está en el `.env` (la escriben solos `deck install`/`deck url`), un deep-link que abre el panel con esa sesión seleccionada. Ojo en iOS (confirmado): con ntfy por web push, "Abrir enlace" cae en un navegador interno de la PWA de ntfy con cookies propias → 401 siempre. Para que el deep-link funcione hace falta la app nativa de ntfy (el tap abre Safari) y haber abierto la URL de `deck url` una vez en Safari.

## 8. Seguridad

El server escucha únicamente en `127.0.0.1`; la única exposición es vía `tailscale serve` (HTTPS + WireGuard, visible solo para los dispositivos del tailnet propio). El `AUTH_TOKEN` no se comparte ni se sube al repositorio: `.env` queda fuera del control de versiones.

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
npm install
cp .env.example .env
```

Editar `.env` con las dos variables obligatorias:

```bash
REPO_DIR=/ruta/absoluta/del/repo/a/monitorear
AUTH_TOKEN=<salida de: openssl rand -hex 32>   # mínimo 32 caracteres
```

Opcionales (una línea cada una): `DECK_PORT` (puerto local, default `7433`), `WORKSPACES_ROOT` (raíz permitida para multi-sesión, default el directorio padre de `REPO_DIR`), `TMUX_SESSION` (nombre de la sesión tmux, default `deck`).

## 3. Prueba local

```bash
npm run dev
```

La consola imprime la URL local con `?token=` lista para abrir en el navegador. `dev` corre con watch: editar `server/index.ts` reinicia el server automáticamente.

## 4. Servicio permanente y exposición al tailnet

Una sola vez (**nunca ejecutar con sudo**; el script pide sudo solo cuando lo necesita):

```bash
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

## 7. Seguridad

El server escucha únicamente en `127.0.0.1`; la única exposición es vía `tailscale serve` (HTTPS + WireGuard, visible solo para los dispositivos del tailnet propio). El `AUTH_TOKEN` no se comparte ni se sube al repositorio: `.env` queda fuera del control de versiones.

# El tailnet como perímetro suficiente para servicios anexos al panel

La postura del README (bind 127.0.0.1 + `tailscale serve` + `AUTH_TOKEN`
obligatorio + `WORKSPACES_ROOT` como perímetro de filesystem) aplica al **panel**:
su server, sus endpoints, su WS. Para los **servicios anexos** que el celu también
consume decidimos que **la membresía del tailnet (WireGuard, tailnet single-user)
alcanza como única frontera**: no van detrás del `AUTH_TOKEN` y `WORKSPACES_ROOT`
no les aplica.

Casos cubiertos:

- **`deck expose <puerto>`** (tarea 35): apps locales
  (dev servers, dashboards) publicadas por puerto vía `tailscale serve`. La
  alternativa (reverse proxy in-deck detrás del token) se descartó por frágil:
  reescritura de paths que rompe SPAs, WS a mano, y habría exigido allowlist.
- **Screen Sharing nativo en 5900** (tarea 31): el servicio de Apple ya estaba
  activo antes de esta decisión y escucha en todas las interfaces (no
  configurable a una sola); se acepta como status quo porque la exposición extra
  es solo la LAN doméstica detrás de NAT y la auth es el usuario+password de
  macOS. El deck no lo abre ni lo gestiona.

Fuera de este ADR: el caso de uso "ver la pantalla + click" en sí se resolvió con
**Chrome Remote Desktop**, que a propósito NO depende del tailnet: identidad y
señalización por Google, video cifrado punta a punta y directo cuando hay camino
P2P. Esa dependencia de tercero es una decisión aparte, documentada en README
(Seguridad); no convierte a Google en perímetro de nada más. La alternativa
all-local, si algún día molesta Google, ya quedó medida: un cliente VNC que hable
la auth de Apple (tipo 30, p. ej. Mocha VNC o noVNC vía websockify + `deck
expose`) contra ese mismo Screen Sharing por la IP del tailnet; el server de
Apple no ofrece la password VNC clásica, solo su auth propia con las credenciales
de macOS.

Límites de la decisión: vale solo mientras el tailnet sea single-user y nada se
publique con funnel/internet público; el panel mismo sigue con `AUTH_TOKEN` porque
su token viaja en URLs/QRs que pueden filtrarse fuera del tailnet. Cada carve-out
nuevo se documenta en README (Seguridad) y se suma acá.

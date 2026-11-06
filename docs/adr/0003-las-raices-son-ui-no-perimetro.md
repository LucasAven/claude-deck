# Las raíces son un concepto de UI (`PROJECT_ROOTS`), no un perímetro

La 0002 reencuadró `WORKSPACES_ROOTS` como una frontera de blast-radius de los
endpoints estructurados (git/fs/dispatch/worktree/dirs) y la justificó como
defense-in-depth: acotaba lo que un bug de path-traversal en esos lectores
no-shell podía alcanzar. Esa cuenta no cierra. Cada uno de esos endpoints exige
`AUTH_TOKEN`, y el MISMO token abre la terminal tmux por WS, que es un shell
libre. Quien pudiera explotar un bug de path en los lectores ya puede `cat`
cualquier cosa de la Mac por la vía normal, asi que el perímetro no sacaba nada
del alcance de un atacante: solo del alcance de Lucas. Y el costo era real: una
sesión de trabajo parada en `~/Desktop/sporttrade/*` se quedaba sin vistas de
git ni de archivos (403), que es justo lo que el panel existe para dar.

**Decisión**: quitar el gate. Los endpoints operan sobre cualquier ruta absoluta
que exista, con el mismo manejo de ENOENT de siempre. Las raíces se quedan, pero
solo como concepto de UI (dónde viven mis proyectos), y por eso la variable pasa
a llamarse `PROJECT_ROOTS` (mismo formato, lista separada por ":"): alimenta las
raíces del árbol de EXPLORAR, los dirs del sheet de despacho y la etiqueta de
raíz de cada proyecto. `WORKSPACES_ROOTS`/`WORKSPACES_ROOT` no siguen como alias:
si están seteadas y `PROJECT_ROOTS` no, el server frena al boot avisando del
rename.

## Considered Options

- **Dejar el perímetro y agregar raíces a mano** (lo de hoy): cada carpeta nueva
  de trabajo pide editar el `.env` y reiniciar el LaunchAgent, a cambio de una
  propiedad que el token ya regala igual.
- **Quitar el gate y borrar las raíces**: perdíamos los puntos de entrada de la
  pestaña Proyectos (EXPLORAR tiene que arrancar en algún lado) y la etiqueta que
  desambigua homónimos.
- **Quitar el gate y quedarse con las raíces como UI** (elegida): el panel sigue
  arrancando donde Lucas tiene sus proyectos, y nada le impide navegar afuera.

## Consequences

- Se van `insideUnion`, `resolveInside` y `resolveInsideOrNull`. Los callers
  realpath-ean y listo. Queda `insideDir` como primitiva, y `resolveWithin` para
  las contenciones LOCALES que siguen teniendo motivo propio: el subárbol de un
  repo (`checkRepoPath`), las raíces de transcripts, el filtro de symlinks de
  cada listado y el directorio de estáticos.
- Ningún endpoint devuelve 403 por ruta. `/api/dirs/browse` lista cualquier dir
  que exista, y los pins/recientes aceptan cualquier ruta válida.
- La seguridad del panel queda enunciada sin ambigüedad: `AUTH_TOKEN`, bind a
  `127.0.0.1`, `tailscale serve` como única exposición y cero ejecución
  arbitraria por HTTP (solo subcomandos fijos de `git`/`tmux`, sin shell).
- `~/.ssh`, `~/.aws` y los transcripts quedan al alcance de los lectores, igual
  que ya lo estaban desde la terminal. El transcript sigue acotado a
  `~/.claude*/projects` por otro motivo (el path lo anotan los hooks, no el
  cliente).
- Hay que renombrar la variable en el `.env` de la instalación viva, o el server
  no arranca. Es a propósito: un alias silencioso dejaría dos nombres dando
  vueltas para siempre.

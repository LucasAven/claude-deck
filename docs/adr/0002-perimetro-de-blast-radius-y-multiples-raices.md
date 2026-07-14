# WORKSPACES_ROOT es perímetro de blast-radius (no de confinamiento) y admite múltiples raíces

El README describía `WORKSPACES_ROOT` como "el perímetro de seguridad". Al diseñar
el selector de directorios de la PWA (que quita el `cd` a mano) quedó claro que esa
frase se leía como confinamiento del usuario, y no lo es: el celu tiene una terminal
tmux con un shell **sin restricciones**, asi que un usuario autenticado ya puede
`ls`/`cat` cualquier cosa de la Mac. El perímetro nunca confinó al usuario.

**Decisión**: reencuadrar `WORKSPACES_ROOT` como una frontera de **blast-radius de los
endpoints estructurados** (`/api/git/*`, `/api/fs/raw`, `/api/fs/list`, dispatch,
worktree), que toman una ruta del cliente y leen bytes del disco **sin pasar por un
shell**. Ahi el perímetro sí tiene valor real: acota lo que un bug de path-traversal
en esos lectores podria alcanzar (mantiene `~/.ssh`, `~/.aws`, y los transcripts de
`~/.claude*/projects` fuera de su alcance). Y para cubrir el caso de proyectos en
varias ubicaciones sin debilitar esa propiedad, `WORKSPACES_ROOT` pasa a
`WORKSPACES_ROOTS` (lista; el perímetro es la **union** de las raíces). Se conserva
`WORKSPACES_ROOT` (singular) como alias de compatibilidad para instalaciones viejas.

## Considered Options

- **Quitar el perímetro** (la terminal ya es libre, "es teatro"): descartado. No
  desbloquea ninguna capacidad que al usuario le falte (ya tiene shell); solo amplia
  lo que un bug en los lectores no-shell puede leer. Cambia una propiedad de
  defense-in-depth por nada.
- **Dejar una sola raíz**: no resuelve el pedido (proyectos en `~/Desktop/projects`
  y `~/work`, p. ej.); el selector quedaria limitado a un subárbol.
- **Ampliar a múltiples raíces** (elegida): cubre el caso de uso moviendo la frontera,
  no removiéndola.

## Consequences

- `insideDir`/`checkInsideWorkspaces` validan contra la union de raíces, no contra una
  ruta única.
- El selector de directorios y el dispatch pueden ofrecer cualquier ruta dentro de la
  union (a cualquier profundidad), pero **nunca fuera**: una sesión que hace `cd`
  afuera del perímetro deja de tener vistas de git/archivos (siguen dando 403, como
  hoy), y el selector no ofrece rutas de afuera.
- El README (Seguridad) y `CONTEXT.md` (términos "Raíz de workspaces" y "Perímetro de
  filesystem") se actualizan para que "perímetro de seguridad" ya no se lea como
  confinamiento.

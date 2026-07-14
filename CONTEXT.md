# claude-deck

Panel remoto móvil (PWA) para controlar desde el celular, vía Tailscale, la misma
sesión interactiva de Claude Code que corre en la Mac dentro de tmux.

## Language

**Panel**:
El deck en sí: server + PWA que exponen la sesión de Claude Code al celular. Lo
que queda detrás del `AUTH_TOKEN`.
_Avoid_: app, dashboard, la web

**Sesión**:
Una sesión tmux nombrada en la Mac, attacheable a la vez desde VS Code y el celu.
Es la unidad que el panel lista, crea y mata.
_Avoid_: pestaña, ventana, terminal (esas son vistas de una sesión)

**Servicio anexo**:
Algo que el celu consume por el tailnet pero que no es el panel: una app expuesta
con `deck expose`, el Screen Sharing nativo. No va detrás del `AUTH_TOKEN`.
_Avoid_: feature del deck (no lo es: el deck no lo gestiona)

**Carve-out de perímetro**:
Excepción explícita y documentada (README Seguridad + `docs/adr/`) a la postura de
seguridad del README para un servicio anexo.
_Avoid_: excepción informal, "caso especial"

**Tailnet-solo**:
Postura de exposición donde la única frontera es la membresía del tailnet
(WireGuard, single-user). Es el perímetro de los servicios anexos.

**Exponer**:
Publicar un puerto local de la Mac en el tailnet (`deck expose <puerto>`).
_Avoid_: abrir el puerto (sugiere router/internet, que jamás)

**Sesión huérfana**:
Un Claude Code vivo que corre fuera de tmux (p. ej. lanzado con `claude` a secas
en una terminal). Invisible para el panel: no es una sesión hasta que se adopta.
_Avoid_: sesión perdida, sesión rota (está sana, solo que el panel no la ve)

**Adoptar**:
Llevar una sesión huérfana adentro de una sesión tmux para que el panel pueda
seguirla, sin perder la conversación. Dos grados: adopción real (mover el proceso
vivo) y rescate suave (relanzarla continuando la conversación, esperando a que
termine el turno en curso).
_Avoid_: migrar, resucitar

**Proyecto**:
Un directorio (a cualquier profundidad) dentro del perímetro al que una sesión
queda atada: donde nace y sobre el que operan sus vistas de git y archivos. La
pestaña Proyectos agrupa las sesiones por proyecto.
_Avoid_: carpeta, workspace, repo (un proyecto puede no ser un repo git)

**Raíz de workspaces**:
Cada directorio tope configurado en `WORKSPACES_ROOTS` que contiene proyectos. El
perímetro de filesystem es la union de todas las raíces.
_Avoid_: WORKSPACES_ROOT (era una sola; el plural es la forma canónica ahora)

**Perímetro de filesystem**:
La union de las raíces de workspaces. Es la frontera de blast-radius de los
endpoints estructurados de git/fs (ninguno lee ni opera fuera de ella), NO una
frontera de confinamiento del usuario: la terminal tmux da un shell sin
restricciones, asi que el perímetro acota el alcance de un bug en los lectores,
no lo que el usuario autenticado puede hacer.
_Avoid_: jaula, sandbox, confinamiento

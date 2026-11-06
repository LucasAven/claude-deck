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

**Transición de Sesión**:
El acto de cambiar cuál Sesión está activa en el panel: reconecta el WS a la
nueva, marca stale el árbol de files y refresca git/sesiones/status. Un solo
ritual (`transitionTo`, en store.ts) que comparten seleccionar, el fallback y
crear. Renombrar NO es una transición (cambia el nombre de la MISMA Sesión,
mismo dir, no toca el árbol); restaurar tampoco (es el set inicial del arranque,
con App orquestando los fetches).
_Avoid_: seleccionar (seleccionar es UNA de las transiciones), cambiar de pestaña

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
Un directorio (cualquiera, a cualquier profundidad) al que una sesión queda
atada: donde nace y sobre el que operan sus vistas de git y archivos. Lo normal
es que cuelgue de una raíz de proyectos, pero no hace falta. La pestaña
Proyectos agrupa las sesiones por proyecto.
_Avoid_: carpeta, workspace, repo (un proyecto puede no ser un repo git)

**Raíz de proyectos**:
Cada directorio tope configurado en `PROJECT_ROOTS` que contiene proyectos. Es
un concepto de UI: de ahí salen los puntos de entrada de la pestaña Proyectos
(raíces del árbol de EXPLORAR, dirs del sheet de despacho, etiqueta de raíz de
cada proyecto). No limita a dónde puede operar el panel.
_Avoid_: raíz de workspaces (nombre viejo), perímetro de filesystem (ya no hay)

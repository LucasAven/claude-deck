# LANES — plan de orquestación por worktrees — Ronda 3 (2026-07-07)

Plan para fanear las tareas 19–23 de `TASKS2.md` (Round 3 — UX & bugs, pedidas
2026-07-07) en worktrees paralelos: un orquestador (Fable 5) en la sesión
`deck` sobre el checkout principal, y un agente (Opus 4.8) por lane en su
worktree. La ronda anterior (tareas 6, 16, 11a, 12–15, 2) está **mergeada y en
Done** — este documento la reemplaza; el histórico queda en git.

Novedad operativa: la tarea 6 ya está mergeada → los lanes se pueden despachar
desde el celu con CREAR → "Despachar con prompt…" (o los crea el orquestador
por git/tmux como siempre). La 5 también: worktree en un tap.

## Estado de decisiones (Lucas, 2026-07-07)

- **Tarea 19** (dónde persistir el orden de chips): lo decide el agente con
  criterio (localStorage `deck-chip-order` alcanza si solo importa en el
  teléfono) — documentando el porqué. [de TASKS2]
- **Tarea 21**: además del fix de paste, va la quita del botón `\n` del pie del
  composer (`#composer-nl`); el `\n` de la barra de quickkeys de la terminal SE
  QUEDA. [de TASKS2]
- **Tarea 22**: opción (a) — hook statusLine de Claude Code — salvo evidencia
  en contra; el formato REAL del JSON se documenta con probe, no se asume.
  [de TASKS2]
- **Tarea 23** (decidido por Lucas 2026-07-07): arquitectura **dual** — web
  push nativo para las pushes planas (Stop, "Claude te necesita"), ntfy
  conserva las que llevan Actions de la tarea 2 (iOS web push no soporta
  action buttons custom); y **SÍ a la dep `web-push`** para VAPID (nada de
  JWT a mano).
- Tareas **8** y **18**: siguen PARKEADAS. **11b** (quickkeys configurables):
  tarea futura separada, fuera de esta ronda.

## Estructura de lanes (conflictos analizados)

| Lane | Tarea | Rama | Puerto scratch | Archivos calientes |
|---|---|---|---|---|
| 1 | 20 — bug: HostSheet visible al cerrar scrollback | `feat/task20-scrollback-hostsheet` | 7444 | `store.ts` (poquito), `lib/scrollback.ts`, `HostSheet.tsx` |
| 2 | 21 — bug: paste en composer va a la terminal + quitar `\n` | `feat/task21-composer-paste` | 7445 | `lib/image.ts`, `Composer.tsx` |
| 3 | 19 — drag para reordenar chips | `feat/task19-chip-drag` | 7446 | `SessionRow.tsx`, `useTap.ts`, `app.css`, `store.ts` (poquito) |
| 4 | 22 — statusline (contexto/tokens) | `feat/task22-statusline` | 7447 | server (sección nueva), `scripts/statusline.sh` (nuevo), UI (línea nueva), `store.ts` (poll) |
| 5 | 23 — push abre la PWA (web push, dual con ntfy) | `feat/task23-webpush` | 7448 | server (sección nueva), `notify.sh`, `web/` (SW + manifest + opt-in) |

Cruces reales: `store.ts` lo tocan los lanes 1/3/4 en secciones distintas y
chicas (un flag de sheet, orden de chips, piggyback del poll) → conflictos
triviales si los hay. `server/index.ts` lo tocan 4 y 5 (secciones nuevas,
append). `notify.sh` es solo del lane 5. Todos appendean en `test/ws-test.mjs`,
`test/ui-test.mjs` y la tabla API del README → **conflictos de merge esperados
y triviales** (quedarse con ambos lados y renumerar). `docs/*` y `design-refs/`
están gitignoreados: los agentes NO deben editarlos (editarían una copia); el
Done-note de TASKS2 va en su mensaje final y lo pega el orquestador.

## Bootstrap de cada worktree (lo hace el ORQUESTADOR al crearlo)

```bash
# desde el checkout principal; <wt> = path del worktree recién creado
cp -R docs design-refs .env <wt>/
cd <wt> && npm install && npm install --prefix web && npm run build
```

Sin esto el agente arranca ciego (docs gitignoreados → no existen en el
worktree) y sin server verificable (no hay build ni node_modules).

## Reglas comunes (van al final de cada prompt)

> Reglas del entorno: (1) Leé PRIMERO docs/HANDOFF.md (gotchas — la 13 puede
> matarte la sesión), docs/REACT-PORT.md §5 si tocás UI, y tu tarea en
> docs/TASKS2.md. (2) El server real corre en 7433 — NO lo toques ni lo
> kickstartees: levantá el tuyo con `DECK_PORT=<puerto> npm run dev` (la env
> var le gana al .env) y buildeá con `npm run build` antes. (3) Verificación
> SOLO contra sesiones tmux / repos scratch, jamás la sesión `deck` ni el git
> vivo de un checkout real; datos de ~/.claude-deck con backup/restore.
> (4) test/ui-test.mjs se ACTUALIZA pero NO se corre — lo corre Lucas.
> (5) Commiteá en TU rama por hito, estilo Lucas: imperativo corto en
> minúsculas, sin Co-Authored-By, y NUNCA merges a main. (6) Tu mensaje final:
> qué quedó hecho y verificado (con números), el borrador del Done-note para
> TASKS2, y las preguntas abiertas si las hay.

## Prompts de despacho

### Lane 1 — tarea 20 (bug: HostSheet queda visible al cerrar el scrollback)

```
Arreglá el bug de la tarea 20 de docs/TASKS2.md: abrir el overlay 📜
(scrollback), cerrarlo para volver a la terminal → el sheet del host (batería,
HostSheet de la tarea 17) queda visible sin que nadie lo haya abierto.
REPRODUCILO PRIMERO en puppeteer scratch (abrir scrollback → cerrar → assert de
HostSheet visible = bug confirmado, guardá evidencia) y recién después el fix
MÍNIMO — nada de refactors alrededor. Sospechas de arranque que lista la
tarea: interacción entre scrollbackOpen y hostSheetOpen en web/src/store.ts
(~líneas 134/136), closeScrollback en web/src/lib/scrollback.ts tocando estado
de más, o el tap de cierre cayendo en el backdrop/handler del host
(HostSheet.tsx). Verificación: el mismo script scratch verde después del fix
(abrir scrollback → cerrar → HostSheet NO visible; abrir HostSheet a propósito
sigue andando; cerrar HostSheet sigue andando); +1 check de regresión en
ui-test. [+ Reglas comunes]
```

### Lane 2 — tarea 21 (paste en el composer + quitar el `\n` del composer)

```
Implementá la tarea 21 de docs/TASKS2.md (bug: con el composer ✎ abierto,
pegar texto lo manda directo a la terminal en vez de quedar en el textarea).
Regla que quiere Lucas: paste con foco en el composer = comportamiento nativo
del textarea (queda ahí, editable); pegar EN LA TERMINAL es solo vía botón `+`
→ "Pegar portapapeles". Causa probable (de la tarea): el listener global de
paste en web/src/lib/image.ts (flujo pasteTextToPrompt/pasteFromClipboard,
~líneas 104–137) agarra el evento sin chequear target/foco. Fix esperado:
guard por target (e.target es input/textarea, o composerOpen del store) en el
handler global; NO toques el flujo de imágenes. De paso (mismo lane, pedido de
Lucas): quitá el botón `\n` del pie del composer (#composer-nl en
web/src/components/claude/Composer.tsx ~línea 55 y su nlTap) — ahí el Enter
del teclado virtual ya hace salto de línea nativo. OJO: es SOLO el del
composer; el `\n` de la barra de quickkeys de la terminal SE QUEDA (ese manda
ESC+CR sin submitear). Limpiá el CSS y los checks de ui-test que referencien
#composer-nl / composerNewline. Verificación: puppeteer scratch (paste
sintético con composer abierto → el texto queda en el textarea y NO llega al
pty, espiando el WS/term.paste; paste con composer cerrado → flujo actual
intacto: texto → prompt, imagen → paste-image); +checks ui-test.
[+ Reglas comunes]
```

### Lane 3 — tarea 19 (drag para reordenar los chips de sesión)

```
Implementá la tarea 19 de docs/TASKS2.md (drag para reordenar los chips de
#session-chips, web/src/components/claude/SessionRow.tsx). Hoy el orden viene
del server (/api/tmux/sessions). Cuidados de la tarea: el row scrollea
horizontal y el tap attachea — el drag no puede pelear con ninguno de los dos;
long-press para "levantar" el chip es el candidato natural (useTap ya tiene
onLongPress de la tarea 5, y el patrón slop del diff como referencia). El
orden persiste y las sesiones nuevas van al final; dónde persistir
(localStorage deck-chip-order vs server-side en ~/.claude-deck) lo decidís VOS
con criterio — localStorage alcanza si solo importa en el teléfono — y
documentás el porqué en un comentario. Verificación: puppeteer scratch con
pointer events sintéticos (long-press + drag reordena, tap simple sigue
attacheando, scroll horizontal sigue andando, orden sobrevive reload, sesión
nueva aparece al final); +checks ui-test (el feel del drag en el celu lo juzga
Lucas). [+ Reglas comunes]
```

### Lane 4 — tarea 22 (statusline: % de contexto y tokens en la PWA)

```
Implementá la tarea 22 de docs/TASKS2.md (statusline tipo Claude Code en el
panel: % de context window usado y tokens; modelo y costo del turno si vienen
gratis). NO asumas campos: probe PRIMERO contra un claude vivo en sesión tmux
scratch documentando el formato REAL del JSON que recibe el hook statusLine
por stdin. Elegí la opción (a) salvo evidencia en contra: scripts/
statusline.sh que escriba ~/.claude-deck/state/<sesión>.status.json (mismo
patrón atómico y guard $TMUX que scripts/state.sh), GET /api/claude/status?
session= en el server, y piggyback en el poll existente del frontend (nada de
poll nuevo). UI: línea fina y discreta (mono, arriba de la barra de quickkeys
o en el header) con color de alerta cuando el contexto se acerca al límite. El
hook statusLine se registra en los DOS perfiles globales (~/.claude y
~/.claude-work) con jq + backup, como hizo la tarea 4; actualizá también
.claude/settings.example.json, README y SETUP.md. Verificación: probe
documentado del JSON; ws-test del endpoint (status presente/ausente → contrato
tipo {status:null} con 200, nunca error; sesión inválida 400); puppeteer
scratch con el JSON mockeado (render del %, umbral de color); +checks ui-test.
[+ Reglas comunes]
```

### Lane 5 — tarea 23 (tap en la push abre la PWA instalada)

```
Implementá la tarea 23 de docs/TASKS2.md (que el tap en la notificación abra
la PWA instalada, no una pestaña nueva de Safari). Decisiones ya tomadas por
Lucas (2026-07-07): arquitectura DUAL ntfy+web-push — web push SOLO para las
pushes planas (Stop, "Claude te necesita"); las que llevan Actions
Permitir/Denegar de la tarea 2 siguen por ntfy — y VAPID con la dep `web-push`
(sí a la dep, nada de JWT a mano). Camino (a) de la tarea: web push nativo de
la PWA (iOS ≥16.4, requiere app instalada y permiso otorgado DESDE la PWA):
service
worker con handlers push + notificationclick → clients.focus()/openWindow();
endpoint nuevo en el server que guarde la subscription en ~/.claude-deck/
(contrato y validación en ws-test). REGLA DURA: NO romper la tarea 2 — los
botones Permitir/Denegar viven en ntfy Actions y el web push de iOS NO soporta
action buttons custom; las pushes con Actions siguen yendo por ntfy (el dual
de arriba). scripts/notify.sh gana la rama nueva con degradación
silenciosa como siempre (sin suscripción o fallo → ntfy como hoy); el
AUTH_TOKEN jamás viaja afuera. El probe (b) (¿el click de ntfy con la URL
exacta del start_url enruta a la PWA?) y el E2E real (permiso, push, tap que
abre la app) son del celu de Lucas: dejá los pasos de prueba anotados en tu
reporte, aunque el resultado esperado sea negativo, para no re-investigarlo.
Verificación: ws-test del endpoint de suscripción (guardar/validar/contrato
con subscription ausente/rota); +checks ui-test del flujo de opt-in en la UI
(botón/estado de suscripción). [+ Reglas comunes]
```

## Orden de merge (lo maneja el orquestador en main)

1. **Lane 1** (fix mínimo, chico) → 2. **Lane 2** → 3. **Lane 3** →
   4. **Lane 4** → 5. **Lane 5**.
   Tras CADA merge: `npm run build` + `npx tsc --noEmit` (root y web) + ws-test
   limpio (deck matada desde AFUERA de tmux, gotcha 13/9) + kickstart. ui-test
   completo lo corre Lucas al final de todo.
2. Conflictos esperados: appends en ws-test/ui-test/README → conservar ambos
   lados y renumerar checks; `store.ts` entre lanes 1/3/4 → secciones
   distintas, se resuelve a mano en segundos.
3. Después del merge de cada lane: `git worktree remove <path>` + `git branch
   -d <rama>` (ya mergeada, -d seguro).

## Notas operativas

- **Excepción al "no commitear"**: los agentes commitean EN SUS RAMAS (sin eso
  no hay merge posible); main no se toca sin ok de Lucas. Mismo estilo de
  siempre.
- **Modo de permisos**: Auto-edits (acceptEdits) recomendado — los Bash llegan
  como push contextual (tarea 1) y se aprueban desde el celu (tarea 2, un tap).
  Autorun es más fluido pero el aislamiento del worktree NO limita al agente:
  usalo solo en lanes que te den confianza.
- **Ojo lane 4**: registra el hook statusLine en los settings globales REALES
  (~/.claude y ~/.claude-work) — es el precedente de la tarea 4, con backups,
  pero afecta a las sesiones de Claude que arranquen después; si preferís que
  solo lo proponga sin tocar los perfiles, decilo antes de despachar.
- **Los chips con semáforo (tarea 4) son el tablero**: verde = trabajando,
  ámbar = esperando permiso/input, gris = terminó. La pestaña Cambios de cada
  sesión muestra el diff de SU worktree — code review desde el celu.

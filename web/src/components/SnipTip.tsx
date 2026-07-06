// Tooltip de texto completo de un snippet (index.html:188). Siempre montado,
// oculto por defecto. La lógica de hover/long-press llega en la Fase 3
// (app.js:887-930) — por ahora es el contenedor vacío para que el CSS aplique.
export function SnipTip() {
  return <div id="snip-tip" className="snip-tip hidden" />
}

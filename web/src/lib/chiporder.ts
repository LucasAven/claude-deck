// Orden manual de los chips de sesión (tarea 19). Lucas arrastra los decks al
// orden que quiera con un long-press + drag sobre #session-chips.
//
// POR QUÉ localStorage y NO server-side (~/.claude-deck): el orden de los chips
// es una preferencia de PRESENTACIÓN que solo importa en el teléfono de Lucas.
// No hay ningún consumidor fuera de esta PWA (a diferencia de snippets.json o
// host-alert.json, que el server lee/escribe y sincroniza Mac↔celu). Guardarlo
// server-side sería sobre-ingeniería: otro endpoint, otra escritura de app-data,
// para un dato que nadie más mira y que no pierde nada si se resetea al limpiar
// el navegador. localStorage alcanza y sobra. Key: `deck-chip-order`.
//
// Regla: las sesiones nuevas (no presentes en el orden guardado) van SIEMPRE al
// final. Si el orden guardado está vacío (primer uso) el resultado es idéntico
// al alfabético de antes — compatible hacia atrás.

const KEY = 'deck-chip-order'

export function loadChipOrder(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
  } catch {
    /* localStorage roto (modo privado) o JSON inválido — sin orden guardado */
  }
  return []
}

export function saveChipOrder(names: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(names))
  } catch {
    /* no es crítico si falla */
  }
}

// Ordena `names` (los que existen ahora) según el orden guardado: primero los
// conocidos en su orden persistido, después los nuevos al final (alfabético
// entre ellos para ser determinista). Los nombres guardados que ya no existen se
// ignoran (se podan recién cuando un drag reescribe el orden).
export function orderNames(names: string[]): string[] {
  const saved = loadChipOrder()
  const present = new Set(names)
  const known = saved.filter((n) => present.has(n))
  const knownSet = new Set(known)
  const fresh = names.filter((n) => !knownSet.has(n)).sort()
  return [...known, ...fresh]
}

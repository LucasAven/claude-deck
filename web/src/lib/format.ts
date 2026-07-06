import hljs from 'highlight.js/lib/common'

// Formato y resaltado compartidos por las vistas Cambios/Archivos (app.js:1795-1878).
// fmtUptime vive en lib/host.ts (lo usa el bottom sheet).

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// tinte de un archivo por extensión (los iconos salen de lib/icons.tsx)
export function extClass(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'ft-js'
  if (['ts', 'tsx'].includes(ext)) return 'ft-ts'
  if (ext === 'json') return 'ft-json'
  if (['md', 'txt'].includes(ext)) return 'ft-md'
  if (['css', 'scss', 'less'].includes(ext)) return 'ft-css'
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) return 'ft-html'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'heic'].includes(ext)) return 'ft-img'
  if (['sh', 'bash', 'zsh', 'env'].includes(ext)) return 'ft-sh'
  return 'ft-plain'
}

// ext → lenguaje del bundle "common" de highlight.js (los que no están acá se
// muestran en texto plano). Archivos grandes tampoco se resaltan: hljs es O(n)
// pero con constantes feas — 200 KB ya se siente en el celular.
const HLJS_LANGS: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash', env: 'bash',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', swift: 'swift', kt: 'kotlin', lua: 'lua', pl: 'perl',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', diff: 'diff',
}
const HL_SIZE_LIMIT = 200 * 1024

// devuelve el HTML resaltado (escapado por hljs → seguro para dangerouslySetInnerHTML,
// §5.7) o null si no hay lenguaje / es muy grande / el lenguaje no está en el bundle;
// en ese caso el caller pinta el contenido como texto plano.
export function highlightCode(name: string, content: string): string | null {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const lang = HLJS_LANGS[ext]
  if (lang && content.length <= HL_SIZE_LIMIT) {
    try {
      return hljs.highlight(content, { language: lang }).value
    } catch {
      /* lenguaje no cargado en el bundle: caer a texto plano */
    }
  }
  return null
}

export function canRenderMd(rel: string): boolean {
  return /\.md$/i.test(rel)
}

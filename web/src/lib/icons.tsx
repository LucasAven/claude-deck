import type { ReactNode } from 'react'
import { extClass } from './format'

// Iconos SVG del árbol de Archivos (estilo explorador de VS Code, mismo trazo que
// los botones de cámara/pegar). app.js:1808-1843. En el vanilla eran strings que
// iban por innerHTML; acá son JSX (los dangerouslySetInnerHTML se reservan para
// diff2html/hljs/marked — §5.7). Markup 100% constante: nunca se interpola
// contenido ni nombres de archivo.
const ftSvg = (body: ReactNode): ReactNode => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {body}
  </svg>
)

export const FT_ICONS: Record<string, ReactNode> = {
  folder: ftSvg(<path d="M3 18.5V7a2 2 0 0 1 2-2h4.2l2 2.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  folderOpen: ftSvg(<><path d="M3 18.5V7a2 2 0 0 1 2-2h4.2l2 2.5H19" /><path d="M3 18.5l2.6-7h15.4l-2.5 7z" /></>),
  js: ftSvg(<><rect x="3" y="3" width="18" height="18" rx="3.5" /><text x="12" y="16.2" textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace" fontSize="9.5" fontWeight="700" fill="currentColor" stroke="none">JS</text></>),
  ts: ftSvg(<><rect x="3" y="3" width="18" height="18" rx="3.5" /><text x="12" y="16.2" textAnchor="middle" fontFamily="ui-monospace,Menlo,monospace" fontSize="9.5" fontWeight="700" fill="currentColor" stroke="none">TS</text></>),
  json: ftSvg(<><path d="M9.5 4.5c-2 0-3 1-3 2.8v2c0 1.4-.9 2.2-2.5 2.7 1.6.5 2.5 1.3 2.5 2.7v2c0 1.8 1 2.8 3 2.8" /><path d="M14.5 4.5c2 0 3 1 3 2.8v2c0 1.4.9 2.2 2.5 2.7-1.6.5-2.5 1.3-2.5 2.7v2c0 1.8-1 2.8-3 2.8" /></>),
  md: ftSvg(<><path d="M3.5 16.5v-9l3.75 4.5L11 7.5v9" /><path d="M17 7.5v9" /><path d="M14 13.5l3 3 3-3" /></>),
  css: ftSvg(<path d="M9.5 4l-2 16M16.5 4l-2 16M4.5 9.3h16M3.5 14.7h16" />),
  html: ftSvg(<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5" />),
  img: ftSvg(<><rect x="3" y="4.5" width="18" height="15" rx="2" /><circle cx="8.8" cy="9.8" r="1.7" /><path d="M4.5 17.5l5-5 3 3 3.5-3.5 3.5 3.5" /></>),
  sh: ftSvg(<><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M6.8 9.3l3.2 2.7-3.2 2.7M12.5 15h4.5" /></>),
  pkg: ftSvg(<><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>),
  git: ftSvg(<><path d="M6.5 3.5v11" /><circle cx="17.5" cy="6.5" r="2.8" /><circle cx="6.5" cy="17.5" r="2.8" /><path d="M17.5 9.3a8.7 8.7 0 0 1-8.2 8.2" /></>),
  env: ftSvg(<><circle cx="7.8" cy="16.2" r="4.3" /><path d="M10.8 13.2l9.7-9.7M15.6 8.4l2.9 2.9" /></>),
  file: ftSvg(<><path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z" /><path d="M13.5 3.5v5h5" /></>),
}

// icono según la clase de tinte de extClass (lo que no matchea → página genérica)
const FT_ICON_BY_CLASS: Record<string, string> = {
  'ft-js': 'js', 'ft-ts': 'ts', 'ft-json': 'json', 'ft-md': 'md',
  'ft-css': 'css', 'ft-html': 'html', 'ft-img': 'img', 'ft-sh': 'sh',
}

// tinte + icono de un archivo; nombres especiales primero, después la extensión
export function fileIcon(name: string): { cls: string; icon: ReactNode } {
  const lower = name.toLowerCase()
  if (lower === 'package.json' || lower === 'package-lock.json') return { cls: 'ft-json', icon: FT_ICONS.pkg }
  if (lower.startsWith('.git')) return { cls: 'ft-html', icon: FT_ICONS.git }
  if (lower.startsWith('.env')) return { cls: 'ft-sh', icon: FT_ICONS.env }
  const cls = extClass(name)
  return { cls, icon: FT_ICONS[FT_ICON_BY_CLASS[cls]] || FT_ICONS.file }
}

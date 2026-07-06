import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// En dev la raíz la sirve Vite (5173), así que el flujo `/?token=` que setea la
// cookie httpOnly nunca llega al server (7433). Sin inyectar el token en cada
// request proxeada, TODO da 401. Leemos AUTH_TOKEN del .env del repo (../) y lo
// mandamos como header x-deck-token, que el middleware de auth ya acepta.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const token = fs
  .readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .match(/^AUTH_TOKEN=(.+)$/m)![1]
  .trim()
const headers = { 'x-deck-token': token }

export default defineConfig({
  plugins: [react()],
  build: {
    // el server sirve web/dist si existe (ver server/index.ts, PUBLIC_DIR)
    outDir: 'dist',
  },
  server: {
    // expuesto a la red para testear en el teléfono vía tailnet; allowedHosts
    // deshabilita el host-check de Vite para que ande también por MagicDNS
    // (macbook-pro-de-lucas), no solo por IP. Solo dev, tailnet privado.
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7433', headers },
      '/ws': { target: 'ws://127.0.0.1:7433', ws: true, headers },
    },
  },
})

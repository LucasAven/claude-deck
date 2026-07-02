// Screenshot del diff view (verificación visual de números de línea + scroll)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = '/path/to/claude-deck';
const TOKEN = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/AUTH_TOKEN=(.+)/)[1].trim();
const OUT = process.argv[2] || path.join(ROOT, 'test');

const shell = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

const browser = await puppeteer.launch({
  executablePath: shell,
  headless: true,
  args: ['--no-sandbox', '--window-size=390,844'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

await page.goto(`http://127.0.0.1:7433/?token=${TOKEN}`, { waitUntil: 'networkidle2', timeout: 20000 });
await page.click('.tab[data-tab="changes"]');
await page.waitForSelector('.file-row', { timeout: 10000 });
await page.click('.file-row');
await page.waitForSelector('#diff-view .d2h-file-wrapper', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: path.join(OUT, 'shot-diff.png') });

// scrollear horizontalmente el contenido del diff para ver los números "pegados"
await page.$eval('#diff-view .d2h-file-diff', (el) => { el.scrollLeft = 200; });
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: path.join(OUT, 'shot-diff-hscroll.png') });

// scroll combinado (vertical + horizontal): los números deben seguir alineados
await page.$eval('#diff-view', (el) => { el.scrollTop = 150; });
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: path.join(OUT, 'shot-diff-vscroll.png') });

await browser.close();
console.log('ok');

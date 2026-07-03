# TASKS — claude-deck

Feature requests from the user (2026-07-02). A new session should read `HANDOFF.md` first (architecture, gotchas, how to run tests), then work through these. **Mark each checkbox when done and verified**, and move finished tasks to the Done section at the bottom.

Key files: `public/index.html` (markup), `public/app.js` (all frontend logic), `public/style.css`, `server/index.ts` (backend). Verify with `node test/ui-test.mjs` (+ update it if you add UI) and let the user confirm touch/keyboard behavior on the phone — headless Chromium can't simulate the iOS virtual keyboard.

## Backlog

### 11. Garbled terminal rendering (hard to reproduce)

- [ ] Bug seen occasionally on the phone (screenshot from 2026-07-02 20:21): the Claude terminal renders corrupted — lines interleaved/overlapping (words mashed together like "toaupdate.Now verifyt heendpointcworksoend-to-end"), spinner/status lines duplicated, and a large block of repeated tmux status-bar lines (`[deck] 0:2.1.198*` many times) painted with the copy-mode/selection highlight in the middle of the scrollback. No known repro yet.
- [ ] Likely suspects to investigate: resize/re-fit races (cols/rows mismatch between xterm and tmux after keyboard open/close or backgrounding), a stale/duplicate WS attach slipping past the `gen` guard (this exact symptom — doubled/flickering text — was a duplicate-attach bug fixed in session 2, see HANDOFF), or tmux copy-mode entered via the touch-scroll SGR sequences leaving the pane in a weird state. Worth adding cheap diagnostics (e.g. log attach gen + resize events) if it can't be reproduced directly.

## Done

(move completed items here, with a one-line note on how they were verified)

### 9c. Markdown render toggle in the Archivos header — DONE (2026-07-03)

Follow-up requested after 9b ("it looks great").

- [x] Eye button `#btn-md-render` in the Archivos header, left of the refresh button, **visible only while a non-binary `.md` file is open** (hidden in tree view, for other extensions, and again on back/refresh). Tap toggles between the raw source view (`.file-pre` + hljs) and rendered markdown (`.md-body`), repainting from the in-memory `openedFile` — no refetch. Amber `.active` state on the button while rendered; default stays source.
- [x] Rendering: `marked@15.0.12` + `dompurify@3.2.6` from jsdelivr. Output is **always sanitized** (`DOMPurify.sanitize(marked.parse(...))` — the browser can open node_modules READMEs, so raw markdown HTML would be an XSS into the app origin) and links get `target="_blank" rel="noopener noreferrer"` via an `afterSanitizeAttributes` hook. If the CDN globals are missing (offline), the button just stays hidden. Dark-theme `.md-body` styles in `style.css` (bordered h1/h2, accent links, panel-bg code/pre with internal h-scroll, tables, blockquotes).

Verified (subagent scratch puppeteer, 22/22 PASS): button hidden in tree/non-md/back, visible on HANDOFF.md, toggle both ways repeatedly, scroll reset, and a real XSS probe — a scratch `.md` with `<script>` + `<img onerror>` opened rendered: `window.__pwned` stayed undefined, no script/onerror in the DOM, probe file deleted after. ui-test +5 checks (→ **45**, updated NOT run — user runs it). Task-9 regression (17/17) and hljs (6/6) suites re-run clean after the change. Pending: user's look on the phone.

### 9b. File browser polish: syntax highlighting + VS Code-style icons — DONE (2026-07-02)

Follow-up requested after task 9 shipped ("is working perfectly").

- [x] **Syntax highlighting** in the file view: highlight.js 11.11.1 from jsdelivr (common bundle + `github-dark` theme, background overridden to the app's). `HLJS_LANGS` in `app.js` maps ~40 extensions to bundle languages; unmapped extensions and files > 200 KB (`HL_SIZE_LIMIT`, hljs is slow on phones) fall back to plain text, as does any hljs error.
- [x] **VS Code-style icons** in the tree (replaced the colored dots): hand-rolled inline SVGs in `FT_ICONS` (`app.js`), stroke style matching the app's existing button SVGs, tinted via the existing `ft-*` color classes (`currentColor`). Folders get closed/open variants that swap on expand/collapse; files get per-type icons (JS/TS badges, `{}` json, `M↓` md, `#` css, `<>` html/svg/xml, photo, terminal for sh/env-ext) plus filename special cases (package box for package*.json, git branch for `.git*`, key for `.env*`) and a generic page icon as default. No new dependencies for the icons.

Verified: ui-test +2 checks (→ **40**; hljs spans present on a highlightable file, every tree row has an SVG icon — updated, NOT run: the user runs it). Headless scratch scripts: hljs suite 6/6 (real spans on .md/.js, transparent background, plain-text fallback for `.gitignore`), icons suite 13/13 by the subagent that drew them (per-type icons, folder swap on expand/collapse, 40px rows, dir/file name alignment), plus the task-9 regression suite 17/17 re-run after both changes. Screenshots eyeballed. Pending: user's look on the phone.

### 9. File browser section (replaces the Shell tab) — DONE (2026-07-02)

- [x] New tab **Archivos** (replaces Shell): VS Code-style tree of the session's root — collapsible folders (carets ▸/▾), folders first, per-extension colored dot icons, lazy loading per level (`GET /api/fs/list`, non-recursive, excludes `.git`, 500-entry cap). Tapping a file opens a read-only view (`GET /api/fs/file`, 512 KB cap, binary detection); ← returns to the tree with expanded state preserved. Root = the pane's git toplevel (stable even if the shell cd'd), or the pane dir if not a repo; everything confined to `WORKSPACES_ROOT` and `checkRepoPath` (no absolute paths, no `..`, no escaping symlinks).
- [x] Shell retired: `#view-shell`/`shellConn`/`KEYS.enter` removed from the frontend, `target=shell` branch removed from the WS handler (`/ws/term?session=` only). Kill/rename still clean up legacy `<name>-shell` pairs and the `-shell` suffix stays reserved/excluded from the session list — existing deck-shell sessions on the Mac die with their pair instead of leaking. Tree state is per session: invalidated on select/kill (and remapped on rename).

Verified: ws-test replaced the shell-WS check with a 9c fs section (+6 → **36 checks**; 35 PASS + the known gotcha-13 noise `created=true`, run from inside `deck`). ui-test rewritten for the Files tab (**38 checks**, updated but NOT run — the user runs it himself); instead a scratch puppeteer script (not committed) passed 17/17: tab swap, tree renders, folders first, expand/collapse/re-expand of `public`, open `HANDOFF.md` with real content, back preserves expansion, terminal still connected, 0 JS errors. Endpoint edge cases curl-checked: traversal → 400, missing → 404, list-a-file → 400. Pending: user's look on the phone. `test/shot-shell.png` deleted (ui-test now saves `shot-files.png`).

### 10. Per-deck model switcher state — DONE (2026-07-02)

- [x] The per-session tracking **already existed and works** (`deck-switch:${state.session}` in localStorage since task 3; `selectSession()` re-renders the pills) — verified with a scratch puppeteer repro switching between two scratch tmux sessions: labels restore correctly per chip. The reproducible leak was **`killSession()`**: killing the ACTIVE session falls back to another session by mutating `state.session` directly, without `renderSwitchPills()` → the pill keeps showing the dead session's model (repro: pick Haiku in `swtest-b`, tap ✕ → falls back to `deck`, label still "Haiku 4.5"). That matches the reported "create deck2, change model, back in deck1 it shows deck2's model" if the way back was the ✕.
- [x] Fix in `killSession()` (`app.js`): after the fallback, `closeSwitchMenu()` + `renderSwitchPills()`; also `localStorage.removeItem('deck-switch:<name>')` on every kill so dead sessions don't leave orphan keys.

Verified with two scratch puppeteer scripts (not committed) against scratch tmux sessions `swtest-a/b` running plain bash — picking models there is harmless (`/model` lands in a bash prompt, and no real Claude default gets changed). Chip-switch restore: PASS before and after the fix. Kill-fallback: BUG before (label stuck on dead session's model), fixed after (label shows the fallback session's state). No ui-test change: the flow needs killing sessions and picking real models, neither is safe against the live deck. Reminder from task 3 stands: the label tracks what was last SENT per deck; `/model` itself saves a global default in Claude.

### 8. Changes-tab badge (dot or count) — DONE (2026-07-02)

- [x] Amber count pill (`#tab-changes-badge`, `.tab-badge` in `style.css`) on the "Cambios" tab, top-right of the Δ icon. `refreshGit()` sets it via `setChangesBadge(data.files.length)` — hidden when 0 or on fetch error, `99+` cap. To keep it fresh outside the Cambios tab, the 8 s poll and the visibilitychange handler now call `refreshGit()` on **every** tab (before: only when Cambios was active; the summary endpoint is cheap and the hidden file-list re-render is harmless), plus one `refreshGit()` at init so the badge shows on load. Stale-while-in-diff is accepted: `refreshGit` still early-returns when `state.inDiff`.

Verified with a scratch puppeteer script (not committed): badge visible with the right count from the Claude tab on load, count == number of `.file-row`s after switching to Cambios, badge inside the tab bounds, 0 JS console errors. ui-test gained 2 checks (→ 35): badge visible before entering Cambios, and badge == row count after (compared post-switch, NOT against the pre-switch value — the test overwrites tracked `shot-*.png`s mid-run so the count can move). Pending: user's visual check on the phone.

### 7. Dev server watch mode + pinned port — DONE (2026-07-02)

- [x] `dev` script is now `tsx watch server/index.ts` (`start` same without watch): editing `server/index.ts` hot-restarts the server (no more stale-server 404s, HANDOFF gotcha 12). And the server reads **`DECK_PORT`** (from `.env` or the environment, default 7433) instead of `PORT`, so the shell profile's `PORT=7434` export can't hijack it — `PORT` is ignored entirely. Same variable name ws-test already uses for its client. (First iteration pinned `PORT` inside the npm script; renaming the server-side variable made that indirection unnecessary — user's call.)

Verified with a scratch script (not committed): server started with `PORT=7434` exported → bound 7433 regardless (and `DECK_PORT=7436` → 7436); then WS attach → `touch server/index.ts` → old WS closes, server back up, **0 leaked tmux clients** (`tmux list-clients` empty — the pty's tmux attach exits when the master fd closes), re-attach to the same tmux session works with `created=false`. The phone PWA reconnects on its own after each reload (same retry path as backgrounding).

### 6. Rename deck sessions — DONE (2026-07-02)

- [x] Tapping the active chip's **name** (dotted underline as affordance) opens a `prompt()` and renames the session via `PATCH /api/tmux/sessions/:name` with `{ newName }`; the paired `<name>-shell` is renamed too. ✕ still kills; inactive chips still just select.

Implementation: `tmuxRenameSession()` + PATCH handler in `server/index.ts` (validates both names with `SESSION_RE`, rejects the reserved `-shell` suffix, 404 if missing, 409 if `newName` or `newName-shell` already exists, returns `{ renamed: [...] }`). Frontend: `renameSession()` in `app.js` — client-side validation mirrors the server, migrates the per-session switcher state in localStorage, updates `state.session` and refreshes chips/git. **No WS reconnect needed**: tmux does not disconnect attached clients on rename, so the live pty keeps flowing; only the name the API talks to changes.

Verified: ws-test section 12b (+5 checks → 31: rename ok + shell pair, 409 duplicate, 400 invalid, 400 `-shell` suffix, 404 missing; uses its own `deck-rn`/`deck-rn-shell` pair and cleans up in a `finally`). ui-test asserts the active chip name has the rename affordance without clicking (+1 → 33; clicking would open a real `prompt()`). Confirmed by the user renaming from the phone ("rename works from the phone").

Note: this task was implemented by a session that then **killed itself** verifying it — it ran the gotcha-9 "kill deck + run ws-test" pattern while itself running inside the `deck` tmux session (launched from the phone). See HANDOFF gotcha 13.

### 5. Newline (line break) input on mobile — DONE (2026-07-02)

- [x] Quickkeys button `\n` — FIRST in the Claude key row, before `/` (user's request: quick access). Sends `\x1b\r` via `KEYS.nl` in `app.js`. Verified by the user on the phone.
- [x] shift+enter from a physical/Bluetooth keyboard → soft newline instead of submit: `term.attachCustomKeyEventHandler` in `createTermConnection` (`app.js`, Claude terminal only; keydown sends `\x1b\r`, returns `false` so xterm never emits the plain `\r`). Verified by the user on the BT keyboard.

Notes / decisions:
- The sequence `\x1b\r` (ESC CR, what alt/option+enter produces) was verified against a real `claude` inside a scratch tmux session BEFORE wiring (text + `send-keys -H 1b 0d` + text → two-line prompt). `\` + Enter wasn't needed.
- Label history: started as `↵`, but the user flagged it could be misread as an enter/send button; briefly `nl`, final label is **`\n`** (user asked for "/n to make it clearer" — interpreted as the `\n` newline escape, since a leading `/` would read as a slash command).
- ui-test asserts the row order is `nl`, `/`, … and that Shell has no nl button (32 checks). The nl button is never tapped in tests — it would inject a newline into the real deck session's prompt.

### 2. Stage / unstage buttons in the diff (Cambios) section — DONE (2026-07-02)

- [x] Each row in `#file-list` has a `+`/`−` button (`.file-act`) that stages/unstages the file and refreshes the list. Verified by the user from the phone ("its working now").

Implementation: one endpoint `POST /api/git/stage?session=` with body `{ path, action: 'stage' | 'unstage' }` (`server/index.ts`), backed by `gitStage()`; path validation extracted from `gitDiff` into shared `checkRepoPath()`. Unstage uses `git restore --staged`, with `git rm -r --cached` fallback when the repo has no HEAD yet. Frontend: file rows became `div`s (buttons can't nest); `stageFile()` in `app.js` calls the endpoint and `refreshGit()`. Tests: ws-test section 9b (+4 checks → 26: stage, unstage, path traversal → 400, bad action → 400; creates+cleans a temp file in the deck-2 repo) and ws-test now honors `DECK_PORT`; ui-test asserts every row has its button without clicking (+1 check → 31). Gotcha found while testing: the dev server has no watch mode, so the new endpoint 404'd until restart — see task 7.

### 1. Hide tab bar while the virtual keyboard is open — DONE (2026-07-02)

- [x] `updateViewportGeometry()` (`app.js`) toggles `kb-open` on `body` when `window.innerHeight − visualViewport.height > 100` (`KB_THRESHOLD`); `body.kb-open .tabbar { display: none; }` in `style.css`. The toggle runs before the debounced 120 ms re-fit, so the terminal gains/returns the rows automatically. ui-test check 5d (30 total) simulates the class and asserts the tabbar collapses/restores; the real keyboard heuristic was verified by the user on the phone ("works great").

### 4. Move the `/` button to the first position in the key row — DONE (2026-07-02)

- [x] `<button data-k="slash">/</button>` moved from last to first among the key buttons in `index.html` (right after the divider, before `esc`); camera/paste buttons and divider untouched. The ui-test check was upgraded from "/" present to "/" is the FIRST `button[data-k]` in the Claude quickkeys row. Verified by the user.
- **Superseded later the same day by task 5**: the new `nl` (newline) button now takes the first position and `/` is second; the ui-test check asserts that order.

### 3. Mode switcher + model/effort switcher — DONE (2026-07-02)

- [x] Mode switcher (shift+tab) — fixed-label pill "Mode switcher ⇄", tap-to-cycle
- [x] Model + effort switcher — dropdown pill "✦ <modelo> · <esfuerzo> ▾"

Implemented per mockup (`docs/mockup-mode-model-switcher.png`): a `switchrow` with two pills above the quickkeys row in the Claude controlbar (`index.html`), popover `#switch-menu` (model/effort) opening upward. All logic in `app.js` (section "Switchers de modo y modelo/esfuerzo"), styles in `style.css`.

Decisions / gotchas for future sessions:
- **Mode** is tap-to-cycle with a **fixed label** (user's explicit choice): each tap sends exactly ONE shift+tab (`\x1b[Z`), nothing more. The pill always reads "Mode switcher" — the app does NOT try to track/guess Claude's current mode (an earlier optimistic-state + output-resync approach was removed as unreliable); the user sees the actual mode in the terminal itself.
- **Model/effort** send `/model <alias>` and `/effort <level>` (text first, `\r` 150 ms later so the `/` autocomplete doesn't eat the submit). Verified against a real `claude` (2.1.198) in a scratch tmux session: both confirmed with "Set model to…" / "Set effort level to…". ⚠️ `/model <alias>` **saves as the user's global default for new sessions** (session-only requires the interactive picker's `s` key) — the pill therefore changes the default, acceptable for now.
- Model list (`MODELS`) and effort levels (`EFFORTS`) are static consts at the top of the switcher section in `app.js` — update there when Anthropic ships new models.
- `ui-test.mjs` section 5c: 5 new checks (29 total, all PASS) + `test/shot-switchers.png`. The mode check does a full 3-tap cycle so the real deck session's mode is left unchanged, asserting the label stays "Mode switcher". The model menu is only opened, never selected (selecting would change the user's real default model).
- Pending: quick visual check by the user on the phone (headless can't validate touch feel).

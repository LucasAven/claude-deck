# TASKS — claude-deck

Feature requests from the user (2026-07-02). A new session should read `HANDOFF.md` first (architecture, gotchas, how to run tests), then work through these. **Mark each checkbox when done and verified**, and move finished tasks to the Done section at the bottom.

Key files: `public/index.html` (markup), `public/app.js` (all frontend logic), `public/style.css`, `server/index.ts` (backend). Verify with `node test/ui-test.mjs` (+ update it if you add UI) and let the user confirm touch/keyboard behavior on the phone — headless Chromium can't simulate the iOS virtual keyboard.

## Done

(move completed items here, with a one-line note on how they were verified)

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

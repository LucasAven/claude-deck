# TASKS — claude-deck

Feature requests from the user (2026-07-02). A new session should read `HANDOFF.md` first (architecture, gotchas, how to run tests), then work through these. **Mark each checkbox when done and verified**, and move finished tasks to the Done section at the bottom.

Key files: `public/index.html` (markup), `public/app.js` (all frontend logic), `public/style.css`, `server/index.ts` (backend). Verify with `node test/ui-test.mjs` (+ update it if you add UI) and let the user confirm touch/keyboard behavior on the phone — headless Chromium can't simulate the iOS virtual keyboard.

## 5. Newline (line break) input on mobile

- [ ] There's currently no way to type a line break within a prompt on mobile: the virtual keyboard's Enter, and even shift+enter on an external Bluetooth keyboard, all reach Claude Code as a plain Enter (submits the prompt). Provide a way to insert a newline.

Context: Claude Code accepts `\` + Enter, and also treats **alt/option+enter** or `\x1b\r` (ESC CR) as a soft newline in most terminals — verify which sequence works inside tmux on this setup before wiring it. Two parts:
  1. Add a quickkeys button (e.g. `↵` labeled "nl" or similar) that sends the soft-newline sequence via the `KEYS` map in `app.js`.
  2. If feasible, intercept shift+enter from physical/Bluetooth keyboards in the xterm.js `attachCustomKeyEventHandler` (or the key handler in `app.js`) and translate it to the soft-newline sequence instead of `\r`.
  This one needs on-device verification by the user (headless tests can't reproduce the iOS keyboard or a BT keyboard).

## 6. Rename deck sessions

- [ ] In the session chips row, tapping the session **name** (as opposed to the ✕, which kills it) should let the user rename the session, to make it easier to distinguish multiple sessions.

Context: chips render into `#session-chips` (`app.js:425`); the ✕ kill handler calls `DELETE /api/tmux/sessions/:name` (`app.js:461`) — the new name-tap handler must not conflict with it (the ✕ already uses `stopPropagation` patterns elsewhere, follow that). Needs a new server endpoint, e.g. `PATCH /api/tmux/sessions/:name` with `{ newName }`, that runs `tmux rename-session`. **Important:** every deck session has a paired `<name>-shell` session (see the DELETE handler in `server/index.ts`, which kills both) — rename both to keep the pairing convention, and validate the new name (no spaces/colons/dots; tmux rejects `.` and `:` in names, and the `=name:` target syntax from HANDOFF gotcha 3 depends on clean names). Also make sure open WS terminals survive or reconnect after the rename (the WS attach targets the session by name — likely need the frontend to re-attach with the new name). Simple UX: `prompt()` on tap, or an inline input in the chip.

## 7. Dev server has no watch mode → stale-server 404s (improve later)

- [ ] `npm run dev` is plain `tsx server/index.ts` — **no watch/reload**. After editing `server/index.ts` the running server keeps serving the OLD code (static files in `public/` ARE fresh, they're read per request), so new endpoints 404 from the phone while the UI already shows the new buttons. This bit us on 2026-07-02 testing task 2.
- Second trap from the same incident: the user's shell profile exports **`PORT=7434`** (inherited by any terminal, including Claude's), so a casual `npm run dev` binds 7434 while `tailscale serve` points at 7433 → phone hits a stale/absent server.
- How we fixed it that day: kill whatever holds the ports (`lsof -tnP -iTCP:7433 -sTCP:LISTEN`), relaunch with `PORT=7433 npm run dev`, re-run `tailscale serve --bg 7433`, verify with `curl -s -o /dev/null -w "%{http_code}" https://<maquina>.<tailnet>.ts.net/api/config` → `401` = alive and reachable.
- Proper fix ideas: change dev script to `tsx watch server/index.ts` (check node-pty/ws survive reloads without leaking ptys), and/or pin the port in the script (`PORT=7433 tsx …`) or in `.env` so the profile export can't hijack it. Quick diagnosis: compare the process start time (`ps -p <pid> -o lstart`) against the mtime of `server/index.ts` — if the file is newer, the server is stale.

## Done

(move completed items here, with a one-line note on how they were verified)

### 2. Stage / unstage buttons in the diff (Cambios) section — DONE (2026-07-02)

- [x] Each row in `#file-list` has a `+`/`−` button (`.file-act`) that stages/unstages the file and refreshes the list. Verified by the user from the phone ("its working now").

Implementation: one endpoint `POST /api/git/stage?session=` with body `{ path, action: 'stage' | 'unstage' }` (`server/index.ts`), backed by `gitStage()`; path validation extracted from `gitDiff` into shared `checkRepoPath()`. Unstage uses `git restore --staged`, with `git rm -r --cached` fallback when the repo has no HEAD yet. Frontend: file rows became `div`s (buttons can't nest); `stageFile()` in `app.js` calls the endpoint and `refreshGit()`. Tests: ws-test section 9b (+4 checks → 26: stage, unstage, path traversal → 400, bad action → 400; creates+cleans a temp file in the deck-2 repo) and ws-test now honors `DECK_PORT`; ui-test asserts every row has its button without clicking (+1 check → 31). Gotcha found while testing: the dev server has no watch mode, so the new endpoint 404'd until restart — see task 7.

### 1. Hide tab bar while the virtual keyboard is open — DONE (2026-07-02)

- [x] `updateViewportGeometry()` (`app.js`) toggles `kb-open` on `body` when `window.innerHeight − visualViewport.height > 100` (`KB_THRESHOLD`); `body.kb-open .tabbar { display: none; }` in `style.css`. The toggle runs before the debounced 120 ms re-fit, so the terminal gains/returns the rows automatically. ui-test check 5d (30 total) simulates the class and asserts the tabbar collapses/restores; the real keyboard heuristic was verified by the user on the phone ("works great").

### 4. Move the `/` button to the first position in the key row — DONE (2026-07-02)

- [x] `<button data-k="slash">/</button>` moved from last to first among the key buttons in `index.html` (right after the divider, before `esc`); camera/paste buttons and divider untouched. The ui-test check was upgraded from "/" present to "/" is the FIRST `button[data-k]` in the Claude quickkeys row. Verified by the user.

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

# TASKS — claude-deck

Feature requests from the user (2026-07-02). A new session should read `HANDOFF.md` first (architecture, gotchas, how to run tests), then work through these. **Mark each checkbox when done and verified**, and move finished tasks to the Done section at the bottom.

Key files: `public/index.html` (markup), `public/app.js` (all frontend logic), `public/style.css`, `server/index.ts` (backend). Verify with `node test/ui-test.mjs` (+ update it if you add UI) and let the user confirm touch/keyboard behavior on the phone — headless Chromium can't simulate the iOS virtual keyboard.

## 1. Hide tab bar while the virtual keyboard is open

- [ ] When the mobile virtual keyboard opens, hide the bottom sections navbar (`<nav class="tabbar">`, `index.html:91`) so the terminal gets more vertical space; show it again when the keyboard closes.

Context: keyboard open/close is already detected via `visualViewport` in `updateViewportGeometry()` (`app.js:628`) — the app pins itself to the visible area with `--vvt/--vvh`. A reasonable heuristic: keyboard is open when `window.innerHeight - visualViewport.height` exceeds some threshold (~100px). Toggle a class on `body` or `.tabbar` and let CSS hide it. Make sure the terminal re-fits (there's already a debounced re-fit, 120 ms) so it actually gains the rows.

## 2. Stage / unstage buttons in the diff (Cambios) section

- [ ] The Cambios tab already splits files into staged/unstaged lists. Add a button per file (and/or per group) to stage or unstage it.

Context: file list renders into `#file-list` (`index.html`, section `view-changes`); git data comes from the server (`server/index.ts` — look for the git status/diff endpoints, they resolve the session's cwd via `tmuxPaneDir`). You'll need new endpoints, e.g. `POST /api/git/stage` / `POST /api/git/unstage` (or one endpoint with an action param) that run `git add -- <file>` / `git restore --staged -- <file>` in the session's repo dir. Refresh the file list after the action. Mind tmux gotcha 3 in HANDOFF (`=name:` target syntax) if you shell out via the pane dir helper. Add checks to `test/ws-test.mjs` if practical.

## 5. Newline (line break) input on mobile

- [ ] There's currently no way to type a line break within a prompt on mobile: the virtual keyboard's Enter, and even shift+enter on an external Bluetooth keyboard, all reach Claude Code as a plain Enter (submits the prompt). Provide a way to insert a newline.

Context: Claude Code accepts `\` + Enter, and also treats **alt/option+enter** or `\x1b\r` (ESC CR) as a soft newline in most terminals — verify which sequence works inside tmux on this setup before wiring it. Two parts:
  1. Add a quickkeys button (e.g. `↵` labeled "nl" or similar) that sends the soft-newline sequence via the `KEYS` map in `app.js`.
  2. If feasible, intercept shift+enter from physical/Bluetooth keyboards in the xterm.js `attachCustomKeyEventHandler` (or the key handler in `app.js`) and translate it to the soft-newline sequence instead of `\r`.
  This one needs on-device verification by the user (headless tests can't reproduce the iOS keyboard or a BT keyboard).

## 6. Rename deck sessions

- [ ] In the session chips row, tapping the session **name** (as opposed to the ✕, which kills it) should let the user rename the session, to make it easier to distinguish multiple sessions.

Context: chips render into `#session-chips` (`app.js:425`); the ✕ kill handler calls `DELETE /api/tmux/sessions/:name` (`app.js:461`) — the new name-tap handler must not conflict with it (the ✕ already uses `stopPropagation` patterns elsewhere, follow that). Needs a new server endpoint, e.g. `PATCH /api/tmux/sessions/:name` with `{ newName }`, that runs `tmux rename-session`. **Important:** every deck session has a paired `<name>-shell` session (see the DELETE handler in `server/index.ts`, which kills both) — rename both to keep the pairing convention, and validate the new name (no spaces/colons/dots; tmux rejects `.` and `:` in names, and the `=name:` target syntax from HANDOFF gotcha 3 depends on clean names). Also make sure open WS terminals survive or reconnect after the rename (the WS attach targets the session by name — likely need the frontend to re-attach with the new name). Simple UX: `prompt()` on tap, or an inline input in the chip.

## Done

(move completed items here, with a one-line note on how they were verified)

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

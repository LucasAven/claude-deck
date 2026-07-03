# TASKS — claude-deck

Feature requests from the user (2026-07-02). A new session should read `HANDOFF.md` first (architecture, gotchas, how to run tests), then work through these. **Mark each checkbox when done and verified**, and move finished tasks to the Done section at the bottom.

Key files: `public/index.html` (markup), `public/app.js` (all frontend logic), `public/style.css`, `server/index.ts` (backend). Verify with `node test/ui-test.mjs` (+ update it if you add UI) and let the user confirm touch/keyboard behavior on the phone — headless Chromium can't simulate the iOS virtual keyboard.

## Backlog

(empty)

## Done

(move completed items here, with a one-line note on how they were verified)

### 16. Phantom `_0` sessions + delete-respawns-another + broken chips layout — DONE (2026-07-03)

User report (2026-07-03, right after adopting the launchd agent): chips named `deck-2_0_0` / `deck-t7-shell_0`, killing one spawns another, layout broken. Root cause chain, fully confirmed live:

- [x] **Origin of the `_0` names (the launchd bug)**: `tmuxListSessions` used `\t` as the `-F` separator. Under launchd there's **no `LANG`** in the environment → tmux (C locale) sanitizes control chars in its output → the tab becomes `_`, fusing name and attached-flag: the API returned `deck_0`, `deck-2_0`… The UI rendered those phantom names as chips, and attach-or-create **created** them on selection/fallback; each kill triggered a fallback to another mangled name → the snowball. Even the hidden legacy `deck-t7-shell` leaked (its mangled name no longer ends in `-shell`). Fixes: separator is now a **space** (printable in every locale; `SESSION_RE` guarantees names can't contain one), the server defaults `process.env.LANG = 'en_US.UTF-8'` when missing (the pty shells inherit it too), and `scripts/deck`'s plist sets `LANG` explicitly. **Never use `\t` in a tmux `-F` format here.**
- [x] **Delete-respawns (independent bug, reproduced with 2 WS clients)**: any second client (Safari tab + PWA both open) blindly reconnects when its WS dies and attach-or-create resurrected the killed session. New WS contract: only `&create=1` (sent by the UI just for the `+` flow, tracked via `state.expectCreate`) or the default session may create; otherwise a missing session answers `{"t":"meta","gone":true}` + close, and the client calls the new `fallbackToLiveSession()` (extracted from `killSession`). A client-side guard also kills-back a session it unexpectedly `created` (belt for the create-race). Server now logs ws attach / kill / rename with timestamps to `~/Library/Logs/claude-deck.log` for future forensics.
- [x] **Layout**: only `#session-chips` scrolls now; the `+` button and the connection dot are pinned at the right of `.session-row` (before, the whole row scrolled and they landed anywhere, overlapping chips).

Verified: tab-mangling reproduced with `env -i tmux list-sessions -F` (tab → `_`) and gone after the fix (curl shows clean names); scratch 2-page puppeteer script (not committed) **8/8 PASS** — killed session does NOT resurrect (was FAIL before the create=1 contract: the guard's DELETE raced the in-flight create), both pages fall back to a live session, `+`-style create still works, externally-killed session doesn't resurrect either, 0 page errors; ws-test updated (**39 checks**: deck-2 connect now uses `&create=1`, +2 checks for meta gone + not-created) — run from OUTSIDE tmux: 37 PASS + the 2 known `created=true` noise checks (sessions pre-existed). Junk sessions cleaned. **User must reload the page on the phone** (old JS ignores `gone` and lacks the guard).

### 15. One-command remote mode: `scripts/deck` (away/back + LaunchAgent) — DONE (2026-07-03)

Requested 2026-07-03: "one command or button" to leave the laptop working and continue from the phone. Analysis first: of the three moving parts, `tailscale serve --bg` is already persistent (nothing to activate); the real gaps were the server lifecycle (manual `npm run dev`) and keeping the Mac awake with the lid closed (plain caffeinate/Amphetamine do NOT survive lid-close; `pmset -a disablesleep 1` is the reliable lever — same thing Amphetamine's Closed-Display Mode does). **pake was evaluated and rejected**: it only wraps a web UI into a desktop window — the phone already has the PWA, and the hard part (node-pty + tmux + tailscale on the host) can't be bundled, so it adds a Dock icon and zero value.

- [x] `scripts/deck` (bash, subcommands): `install` writes a LaunchAgent (`com.claude-deck`, RunAtLoad + KeepAlive, node from nvm resolved at install time, PATH with homebrew for tmux/git/osascript, logs to `~/Library/Logs/claude-deck.log`, plist `plutil -lint`ed) + a scoped sudoers rule (`/etc/sudoers.d/claude-deck`, `visudo -cf` validated, NOPASSWD for exactly the two `pmset -a disablesleep` commands); it detects a manually-run server on the port and defers the takeover to `deck start` instead of crash-looping against it. `away` = health-check the server (kickstart via launchd if down), end-to-end curl of the tailnet URL, battery warning, `disablesleep 1` + verify. `back` = `disablesleep 0` + verify. Plus `status` / `start` / `stop` (free the port for `npm run dev`) / `log` / `uninstall`. README section "Modo remoto".

Verified: `bash -n`, `deck status` (all 5 lines correct against the live env), usage output, plist generation extracted+linted OK in scratchpad (correct nvm node path), sudoers line `visudo -cf` parsed OK. NOT run end-to-end: `install`/`away` need the user's sudo password and touch launchd/sudoers (permission classifier also blocks Claude from self-running them, correctly) — **user must run `scripts/deck install` once in his terminal**, then `deck away`/`deck back`. Note: while the manual `npm run dev` terminal is up, install defers the agent takeover; close it and run `scripts/deck start`.

### 14. Archivos follows the pane's current directory (per deck) — DONE (2026-07-03)

Requested 2026-07-03. User repro: `cd ../maria-delia/` in the deck's terminal → the Archivos tab kept showing the OLD project's tree. Server was never the problem (`resolveFsDir()` resolves the pane's cwd fresh per request); the frontend cache was: `refreshTree(false)` early-returned when `treeSession === state.session`, so the 8 s poll and tab switches never noticed the root changed.

- [x] `refreshTree(false)` no longer trusts the session-name cache blindly: it always relists the root (`/api/fs/list` is cheap, same cadence as `refreshGit`) and compares `data.root` against the new `treeRoot` (full path, tracked alongside `treeSession`). **Same root → return without touching the DOM** (expanded folders and the open file survive every poll); different root → full re-render with `closeFileView()` + expansion reset + `#files-title` update. The "root = git toplevel" rule is untouched (server-side), so `cd` into a subdir of the same repo still doesn't reroot. Stale-response guard: aborts if `state.session` changed while the fetch was in flight.
- [x] Root check runs when entering Archivos (existing `switchTab` call), on the 8 s poll and on visibilitychange→visible (both new, only while the Archivos tab is active). On fetch error with a rendered tree (e.g. cwd resolved outside `WORKSPACES_ROOT` → 403) the tree is replaced by the error note and `treeSession` resets, so the next poll retries from scratch.

Verified: scratch puppeteer script (not committed) **10/10 PASS** against a scratch tmux session `deck14` cd-ing between two scratch git repos `deck14-a`/`deck14-b` under the workspaces root (all cleaned up after): initial tree, poll with unchanged root preserves a DOM marker + expanded folder + open file, `cd` to a subdir of the same repo doesn't reroot, `cd` to the other project reroots (new entries, file view closed, expansion reset), tab-switch away and back picks up the new root, 0 page errors. ui-test +1 check (→ **53**, NOT run — user runs it): poll with unchanged root keeps the DOM marker and expansion.

### 13. Unified attach button (+) replacing camera + paste, and text paste support — DONE (2026-07-03)

Requested 2026-07-03. Two related changes to the Claude controlbar attach flow:

- [x] **Single `+` button** (`#btn-attach`, plus-glyph SVG matching the reference image) replaces `#btn-img`/`#btn-paste` in the quickkeys row. Tapping it opens a **popover chooser** (chosen over a modal: it reuses the `#switch-menu` element/pattern the model switcher already has, and a modal would cover the terminal to pick between 2 options) with two `.mi` items carrying the old buttons' icons: **Cámara o galería** (→ `#img-input` click) and **Pegar del portapapeles** (→ `pasteFromClipboard()`). The menu element now tracks `dataset.kind` (`attach`/`model`) so each opener toggles its own menu and replaces the other's; `#btn-attach` was added to the outside-tap-close exclusion selector. Button and menu items use `onTap` (task 12), so scrolling the row over the `+` doesn't fire it.
- [x] **Text paste**: `pasteFromClipboard()` falls back to `text/plain` when the clipboard has no image (image wins if both types are present, e.g. some copied screenshots) → `pasteTextToPrompt()` → `claudeConn.term.paste(text)`. xterm's `paste()` normalizes `\n`→`\r` and wraps in **bracketed paste** when the inner app enabled it (Claude Code does; tmux propagates), so multi-line text lands in the prompt WITHOUT submitting. The Cmd+V document handler also pastes text now, but only when focus is outside the terminal (xterm already handles the focused case natively — intercepting would double-paste). Images keep the two-step chip preview flow untouched.

Verified: scratch puppeteer script (not committed) **19/19 PASS** — button present/old ones gone, chooser opens with both options+icons, toggle + outside-tap close, model-menu interplay (each opener replaces the other's content), Cámara fires the file input, image-attach regression (chip pending, 0 uploads), mocked clipboard text → `term.paste` called with the text, image+text clipboard prioritizes the image, Cmd+V text with focus outside the term, and a REAL end-to-end paste against a scratch tmux session `deck13`: `term.paste('echo A\necho B')` through the live WS landed both lines at the zsh prompt **unexecuted** (bracketed paste passthrough confirmed via `capture-pane`), 0 page errors. ui-test updated (→ **52 checks**, NOT run — user runs it): the 2 old button checks became `#btn-attach` present + old buttons gone, and new section 5b2 (+5) covers chooser open/items/outside-close and the mocked text-paste path. Pending: user's look on the phone (incl. the iOS "Pegar" permission bubble on the new menu item).

### 12. Scrolling the quickkeys row no longer triggers the button under the thumb — DONE (2026-07-03)

User report: placing the thumb on a shortcut button to scroll the horizontal quickkeys row fired that button even though no tap was intended.

- [x] Cause: all control buttons fired on **`pointerdown`** (chosen so `preventDefault()` keeps the virtual keyboard open), so the first touch of a scroll gesture was already a "click". Fix: new `onTap(el, fn)` helper in `app.js` — still `preventDefault()`s on pointerdown (keyboard stays open) but fires on **pointerup**, only if the finger moved ≤ `TAP_SLOP` (12 px) and the gesture wasn't `pointercancel`ed (iOS fires that when the scroll takes over). Applied to the 5 pointerdown users: quickkeys, mode pill, model pill, model menu items, effort buttons. The document-level close-menu-on-outside-tap stays on pointerdown (correct there).

Verified: scratch puppeteer script (not committed) 8/8 PASS with `claudeConn.sendKeys` spied (nothing reached the real session): tap fires exactly once, micro-movement (<slop) still counts as tap, horizontal drag from a quickkey fires nothing, tap/drag on the mode pill fire/don't-fire, model menu still opens and closes on outside tap, 0 page errors. ui-test updated (→ **47 checks**, NOT run — user runs it): +2 checks (tap-with-slop fires once / drag doesn't, via the same spy) and the existing simulated taps (`esc`, `pd()` helper) now dispatch the pointerdown+pointerup pair the new handler needs. Pending: user's feel check on the phone.

### 11. Garbled terminal rendering after backgrounding — DONE (2026-07-03)

Original report: the Claude terminal occasionally renders corrupted — lines interleaved/overlapping (words mashed like "toaupdate.Nowverify…"), duplicated spinner/status lines, repeated tmux status-bar blocks. User's decisive clue: it happens **when coming back to the app after switching apps / locking the phone**, and it **fixes itself when the virtual keyboard opens**.

- [x] Diagnosis: opening the keyboard "fixes" it because the viewport change forces a re-fit → resize → SIGWINCH → **tmux repaints the whole screen**; the repaint is the real cure. After an iOS freeze/thaw, several paths leave junk in xterm's buffer (a reconnect's initial 80×24 paint before the real size lands — `pty.spawn` is hardcoded 80×24 and the `onopen` fit runs inside a `requestAnimationFrame` that doesn't fire while frozen; or a zombie WS whose `readyState` still says OPEN so `resume()` did nothing). Coming back with the **same viewport**, `sendResize` dedups on unchanged cols/rows → nothing ever repaints → the garble sticks until the keyboard changes the size.
- [x] Fix: on `resume()` (visibilitychange → visible), don't trust an OPEN socket. It now does `doFit(true)` + sends a new WS message `{t:'refresh'}` — the server (`tmuxRefreshClients` in `server/index.ts`) runs `tmux refresh-client` on every client of the session (gotcha: `refresh-client -t` takes a *client tty* from `list-clients`, not a session), forcing a full repaint that overwrites any junk. A 2 s watchdog (`refreshTimer`) treats "no output at all after refresh" as a zombie socket → `connect()` (a repaint always produces output, so a healthy socket always cancels it; any `out` clears it in `onmessage`). `connect()` clears the watchdog so it can't fire across generations.

Verified: ws-test +1 check (→ **37**; `{t:'refresh'}` on an idle deck-2 pane produces an `out` — an idle pane emits nothing on its own, so the output can only be the forced repaint; run from inside `deck`, 36 PASS + the known gotcha-13 `created=true` noise). Scratch puppeteer script (not committed) 13/13 PASS against a scratch `deck-N` session: healthy resume sends `refresh`, repaint arrives, NO reconnect, no zombie warn; zombie resume (WebSocket.send monkeypatched to drop) → no premature reconnect at 1.2 s, watchdog reconnects at ~2 s with console warn, new socket repaints, connection indicator back on, 0 page errors. Pending: user confirming on the phone over the next days that the garble no longer appears after backgrounding (iOS freeze behavior can't be simulated headless).

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

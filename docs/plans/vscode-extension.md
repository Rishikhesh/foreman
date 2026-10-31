# Foreman VS Code extension: build brief

**Goal:** show Foreman's live state inside VS Code (function ownership, other agents' cursors, waiting lines, handoffs) and run onboarding (create or join a room) from the command palette. It is a viewer and onboarding client only. The Claude Code and git hooks stay the engine.

**Work in:** `vscode-ext/`, inside this repo. Strict TDD: write the failing test first, for every pure function.

## What already exists (read these first)
- `src/core/types.ts`: `RepoState`, `Lock`, `LockKey` (`file#symbol`, `file#<top>`, `file#<file>`), `AgentRef`, `Notice`, `Person`, `Cursor`.
- `src/core/symbols.ts`: `functionsIn(file, source)` returns each function's 1-based line range. Reuse it to turn a lock key into a range in the **local** copy of the file.
  - Match by function name, never by line number. Each laptop's copy of a file may differ.
- `src/server.ts`: the HTTP API. Every route is POST JSON with a `repoId`:
  - `/api/status` → `RepoState`
  - `/api/join {person:{name,color}}` → `{ok}` or `{ok:false, taken}`
  - `/api/notices`, `/api/claim`, `/api/release`, `/api/release-all`, `/api/touch`
  - `GET /api/health`
- Terse streams the live state: an actor socket sends `state`, then `state_update` messages, with `changes.state`.
  - The server needs a `GET /grant?repo=<id>` route returning `{websocketUrl}`, built with `actors.RepoActor.prepareWebsocket`.
  - **Add this route first, test-first**, if it doesn't exist yet. The web board needs it too.
- Repo ID and agent identity rules: see `docs/superpowers/plans/2026-10-31-foreman.md`, Global Constraints.
- Use the same normalization as the hooks' git helper, **reused, not copied**.

## Features

### 1. Connection
- Settings: `foreman.serverUrl` (default `http://127.0.0.1:7300`) and `foreman.repoId`, computed from git origin when empty.
- On activation: fetch `/grant`, open the WebSocket, and keep the latest `RepoState` in memory.
- Reconnect with backoff.
- Show a status bar item: `Foreman · N agents · M locks`, or `Foreman · offline`.

### 2. Ownership decorations, per open editor
- One decoration type per person colour, with:
  - a left border plus a light background over the function's range;
  - `after.contentText` on its first line: `🔒 claude@rishi · 2m`.
- `<top>` locks decorate the import and top-of-file lines. `<file>` locks decorate the whole file.
- Recompute when the state changes, when the active editor changes, and when the document changes.

### 3. CodeLens above every function
- `Locked by X · Y waiting`, or `Free`.
- Clicking it reveals the lock in the sidebar.

### 4. Agent cursors
For each `state.cursors[agentId]` whose `file` is open in an editor, draw a 2px coloured caret on that line plus a name tag (`claude@friend · editing`). Fade it out after 30s without an update.

### 5. Handoff notifications
On a state update where a lock's holder changes to an agent of **this** person, show:
- `"validateToken is yours. <summary>"`
- a **Pull commit** button that runs `git fetch origin refs/foreman/<sha> && git merge <sha>` in a VS Code terminal.

Heads-up locks on files this person has open show as a quiet status-bar flash, not a pop-up.

### 6. Sidebar tree view
- **Room:** each person, with a colour dot and their agents.
- **Locks:** grouped by file, showing the holder and the waiting line.
- Right-click a lock to **Revoke** it. This needs a server `/api/revoke` route; add it test-first.

### 7. Onboarding commands
- **Foreman: Create room**
  1. Checks: git repo, origin remote, dry-run push to `refs/foreman/test`, server reachable.
  2. Input box for a name; quick pick for a colour.
  3. `/api/join`.
  4. Write the hooks (call the same installer the CLI uses).
  5. Copy the invite (server URL + repoId + room key) to the clipboard.
- **Foreman: Join room:** paste the invite, check the local repo ID matches, pick a free colour (taken colours are hidden; use `/api/status`), join, install the hooks.
- **Foreman: Leave room:** remove the hooks.

### 8. Repo map panel (optional)
A webview that loads the web board's `/board?repo=` page.

## Tests (bun test, pure functions in `vscode-ext/src/view.ts`)
- `rangesForLocks(state, file, source)`: a lock key maps to the right range in local source. A missing function maps to nothing, not a crash. `<top>` maps to the lines before the first function.
- `lensText(lock, queue)`: the exact strings above.
- `newHandoffs(prev, next, myAgentIds)`: only holder changes **to** my agents count.
- `freeColors(state, palette)`
- `parseInvite(str)`: round-trips with `makeInvite`. Garbage input is rejected with a clear error.

Then do a manual check in the Extension Development Host. Two windows on two clones; one Claude edits `validateToken`, and the other window shows the stripe, the CodeLens and the cursor within about a second.

## Local dev and install: no build, no `.vsix`
Teammates get updates with `git pull` plus **Developer: Reload Window**. Nothing is packaged or sent around.

- **The extension runs straight from the repo folder.** Write it as plain JavaScript (ES modules are fine in recent VS Code; otherwise CommonJS), with JSDoc types. There is no compile step, and `package.json` `main` points at the `.js` file.
  - If it must be TypeScript, commit the built `dist/` instead. Plain JS is simpler.
- **Zero npm dependencies.** Use VS Code's built-in global `WebSocket` and `fetch` (VS Code ships Node 22). Then there's no `node_modules` to install after pulling.
- **One-time setup per laptop:** link the repo folder into VS Code's extensions folder. `foreman init` and `foreman join` do this automatically:
  `ln -sfn "$PWD/vscode-ext" ~/.vscode/extensions/foreman.foreman-dev`
  - Use `~/.cursor/extensions` for Cursor.
  - Restart VS Code once after creating the link.
- **After that:** `git pull`, then Command Palette → **Developer: Reload Window**, and the new extension code is live. Add a `foreman.reload` command that runs `git pull` and then reloads.
- **While developing it yourself:** `code --extensionDevelopmentPath=$PWD/vscode-ext`.
- The pure functions in `vscode-ext/src/view.js` are still tested with `bun test` (JS test files).

## Not in scope
- Editing or claiming locks from the editor (the hooks own that)
- Marketplace publishing
- JetBrains

# Foreman: the plan, as built

**Google Docs for coding agents.** Teammates on their own laptops, each with their own clone and their own Claude Code, work on one repo at the same time:

- **Function locks:** an agent editing a function locks only that function.
- **Handoff:** the next agent waiting for it gets the function with the commit already merged.
- **Caller warnings:** agents working on code that calls a changed function are warned.
- **VS Code:** shows it all live.

## How it fits together

```
 Each laptop                                   Host laptop                              GitHub
 ───────────                                   ───────────                              ──────
 Claude Code ── hooks ─┐                       Foreman server (Bun, :7300)
 git ───────── hooks ──┼── https ──▶ foreman.rishikhesh.com ─▶ Terse actors (room state)
 VS Code extension ────┘   (Cloudflare named tunnel)         Relay #foreman (hosted)
                                                                                  refs/foreman/<sha>
 handoff commits travel through GitHub as hidden refs ─────────────────────────────▶ (not branches)
```

| Piece | What it does | Where |
|---|---|---|
| **Terse Durable Actors** | **`RepoActor`**, one per room: locks, waiting lines, mailboxes, cursors, members, caller warnings. One request at a time, so there are no races. Its timer frees idle locks. Streams state live.<br>**`RoomCode`**, one per code: maps the code to its room, and its timer deletes it after 24 hours. | `src/actors.ts`, `src/core/` |
| **Foreman server** | HTTP API, room keys, GitHub check, `/live` relay of the room's state. | `src/server.ts` |
| **Claude Code hooks** | Find the function an edit touches, lock it, report cursors, deliver news, wait instead of quitting, and auto-merge handoffs. | `cli/foreman.ts`, `cli/hook.ts` |
| **Git hooks** | `pre-commit` refuses changes to functions someone else holds. `post-commit` pushes the commit to `refs/foreman/<sha>`, then releases. `post-merge` reports pulls. | `cli/foreman.ts`, `cli/git.ts` |
| **VS Code extension** | Live stripes per holder, info line above each function, cursor bars, caller warnings, Room sidebar, Start / Join, Allow requests. | `vscode-ext/` |
| **Agent Relay** | Posts every lock, wait, handoff, join and warning to `#foreman`, threaded per function. | `src/relay.ts` |
| **Cloudflare** | A named tunnel gives the host laptop the fixed address `foreman.rishikhesh.com`. | `~/.cloudflared/config.yml` |
| **Supabase** (optional) | Event history and the most fought-over functions. On only when `SUPABASE_*` is set. | `src/history.ts`, `supabase/schema.sql` |
| **Freestyle** (optional) | Script to host the server on an always-on VM instead of the host laptop. | `deploy/freestyle.ts` |

## The flow

1. **Host:**
   1. In VS Code, open the Foreman sidebar and click **Start a room**.
   2. Sign in with GitHub and pick a colour.
   3. Get a short code like `F9CS-JFS7`.

   Start a room brings up Terse, the server and the tunnel if they aren't running.
2. **Teammate:**
   1. `git clone …`, then `bun install`, then `bun cli/foreman.ts install-extension`, then reopen VS Code.
   2. In the Foreman sidebar, click **Join a room**, sign in with GitHub, enter the code and pick a colour.
   3. Wait until the host clicks **Allow**.
3. **Working:** both start Claude Code in their clones. Every edit locks its function (`file#function`; imports and new top-level code use `file#<top>`).
   - **Refused:** an agent is refused any function someone else holds and joins that function's waiting line.
   - **Heads-up:** agents that have the file open get a heads-up.
4. **Signature change:** if an edit changes a function's name or parameters, every agent working on code that calls it is warned. Callers get an amber underline and a ⚠ line in VS Code.
5. **Commit:** the commit is pushed to `refs/foreman/<sha>`, and the holder's locks pass to whoever is waiting.
   - **Automatic merge:** the receiving agent's hook fetches that commit and merges it with `--autostash`, which keeps its own work, before telling it "it's yours". Conflicts are cancelled cleanly.
   - **Warning cleared:** the merge clears the caller warning.
6. **Lock lifetime:** a lock lasts as long as its agent is active. It's freed on commit, when the session ends, when the host revokes it, or after 15 idle minutes.

## Security

- **Identity:** GitHub verifies who you are. The server checks the token with `api.github.com/user` once and never stores it.
- **Room keys:** each laptop makes its own 32-byte room key and sends only its SHA-256. Every API call and `/live` needs a valid key for that room, or the server answers 401.
- **Agent identity:** the server sets each agent's name and colour from the key's identity, so nobody can pose as someone else.
- **Joining:** joiners stay pending until the host clicks **Allow**. The host can remove people.
- **Demo identities:** `dev:<name>` is accepted only from the server's own laptop, never through the tunnel.

## Status

**Built and tested (109 tests):**
- function locks, queues, mailbox and presence
- function finder and signature diff
- Terse actors
- the secure server
- hooks
- handoff with automatic merge
- caller warnings
- Relay
- the VS Code extension
- GitHub sign-in with room codes
- the demo reset (`bun run demo:reset`)

**Demo:** each person uses their own clone. Run `bun run demo:reset`, then give both Claudes overlapping tasks on `demo/sample/src/auth.ts`. One of them holds its change until you say "commit".

**Not done or not live yet:**
- **Supabase history:** needs project keys.
- **Freestyle hosting:** the script exists but hasn't run.
- **Languages:** only TypeScript and JavaScript; other languages would need their own parsers.
- **Stale agents:** an agent whose session closed without signalling stays listed until the room is idle.
- **Relay:** its hosted service sometimes rejects posts when busy. Locks don't depend on it.

**Dropped along the way:**
- **Crash recovery:** dropped as staged.
- **Mastra handoff notes:** dropped by choice.
- **Browser board and Graphify map:** the VS Code view replaced them.
- **Long `fm_` invites and hidden room refs:** replaced by sign-in, short codes and Allow.

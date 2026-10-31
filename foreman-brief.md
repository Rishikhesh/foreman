# Foreman — brief

**One line:** a lease desk for coding agents. Before an agent edits a file it takes a lease on it. If another agent holds that file, the agent is told who holds it and is queued. When the holder commits, the waiting agent gets a message with the commit SHA and a summary of the change. It merges that commit first, then edits. Merges stay trivial.

Goal: by Monday you run this on your own laptop with your own Claude Code and Codex sessions. Crash recovery is out of scope.

---

## 1. Core loop

```
Agent A (worktree wt-a)            RepoActor (one per repo)               Agent B (worktree wt-b)
  Edit auth.ts ──PreToolUse──▶ claim(auth.ts, A) → granted
                                                           ◀──PreToolUse── Edit auth.ts
                                claim(auth.ts, B) → held by A, B queued
                                                           ──deny──▶ "auth.ts held by A (task: add OAuth).
                                                                      You're queued. Work on other files."
  git commit ──post-commit──▶ release(files in commit, sha=abc123,
                                       summary="added refreshToken(), renamed getUser→fetchUser")
                                grant auth.ts to B, notify B over Relay
                                                           ◀── Relay DM / hook context:
                                                               "auth.ts is yours. First: git merge abc123.
                                                                A changed: renamed getUser→fetchUser"
```

The point of the notification: B merges A's commit before touching the file. Two agents editing the same file one after the other, each starting from the other's latest version, cannot produce a merge conflict on it.

### When a lease is released
| Trigger | How |
|---|---|
| Holder commits the file | git `post-commit` hook in each worktree → `release(files, sha)` |
| Holder's session ends | Claude Code `SessionEnd` hook → release everything it holds, without a SHA. The waiting agent is told the holder left uncommitted work |
| Human override | "Revoke" button on the board |
| Stale lease | Alarm on the actor. A lease untouched for N minutes (default 20) is released and the holder is told. This is housekeeping, not a demo beat |

### How a waiting agent finds out
Claude Code reads Relay messages only between turns. So there are three ways in:
1. **PostToolUse hook.** After every tool call, the hook asks the actor for pending notices and injects them as `additionalContext`. An agent that is busy elsewhere learns within one tool call.
2. **Stop hook.** When an agent is about to stop but is still queued for a file, the hook long-polls the actor (timeout of about 10 minutes). On release it returns `{"decision":"block","reason":"auth.ts is free; merge abc123 and continue"}`, and the agent keeps going. This is the key trick: the agent waits for the file instead of ending the task.
3. **Relay DM.** The same notice also goes over Relay. Codex and other MCP agents get it there, and you see it in the channel.

---

## 2. Components (smallest version that works)

| Piece | What it is | Size |
|---|---|---|
| `RepoActor` (Durable Actors) | ID = hash of the repo's origin URL. Holds the leases map, a FIFO wait queue per file, and a notice outbox per agent. Uses its single alarm for the earliest lease expiry. `@Emittable` state drives the board | ~150 lines |
| `foreman` CLI / hook script | One Bun script with subcommands: `pre-edit`, `post-tool`, `stop`, `session-end`, `post-commit`, `status`. Reads hook JSON from stdin and calls the actor over HTTP | ~150 lines |
| Claude Code hooks | `.claude/settings.json` in the repo wires PreToolUse (`Edit|Write|MultiEdit|NotebookEdit`), PostToolUse, Stop and SessionEnd to the script | config |
| git hooks | `post-commit` (release) and `pre-commit` (refuse commits that touch files leased by someone else, which is the backstop for agents with no edit hook) | 10 lines |
| Relay | One channel per repo, `#foreman-<repo>`. Actions `lease.claim`, `lease.release`, `lease.status` so any MCP agent (Codex included) can use them. DMs carry notices and agent-to-agent asks | thin glue |
| Board | One page with a live list of leases and queues per file, recent notices and the Relay channel. Has a Revoke button | ~100 lines |

Agent identity: the hook's stdin JSON gives `session_id` and `cwd`, so agent ID = `claude:<session_id>`, labelled with the worktree name. Codex agents register through the Relay Action with their own name.

Claude Code hook outputs:
- PreToolUse deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
- PostToolUse inject: `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`
- Stop keep-going: `{"decision":"block","reason":"…"}`
- Set `"timeout": 600` on the Stop hook.

Check these against the current Claude Code hooks docs on the day.

**Codex:** use the MCP route, a line in AGENTS.md ("call lease.claim before editing a file") and the git `pre-commit` backstop. If your Codex version has edit hooks, wire them the same way as Claude's. Check this before the event.

**Honest note on Relay:** on one laptop, the actor plus hooks already do the leasing. What Relay adds is cross-vendor agents (Codex has no Claude hooks), agents asking each other things directly, more than one machine, and one channel where you watch it all happen.

---

## 3. What else to add (ranked by how much it helps you day to day)

1. **Change digest on release.** The release notice carries `git show --stat` plus a one-line summary from the holder ("renamed getUser→fetchUser"). The waiting agent's context gets updated, not just its files. This stops the conflicts that compile fine but break at runtime.
2. **Lease more than files.** These are the conflicts worktrees actually cause on a local machine:
   - **Dev-server ports.** Every worktree wants :3000. `foreman port` returns a free leased port per agent.
   - **Migration numbers.** Two agents both create `0042_*.sql`. The actor hands out the next number, and single-writer means no duplicates.
   - **Lockfile / `npm install`.** Serialize installs. Two agents changing `package.json` and the lockfile are the most common conflict.
   - **The local test database.** One agent runs tests at a time, or each gets its own schema name.
3. **Ask the holder.** A blocked agent does not have to wait. It can DM the holder over Relay: "while you're in auth.ts, add an `isExpired()` export". The holder sees it at its next tool call.
4. **Plan-time claims.** At the start of a task an agent can declare the files it expects to touch (`foreman intent auth.ts session.ts`). You then see overlaps before work starts and can re-split the tasks yourself. These claims are soft: they warn, they don't block.
5. **Hot-file detection.** The actor counts waits per file. A file that is always contended (a routes table, an index of exports) is a signal to split it. The board shows the top 3.
6. **Merge-order hint.** Releases form a chain of commit SHAs per file, so the actor knows which branches must merge in which order. `foreman merge-order` prints it.

Skip for now: function-level (symbol) leases, multiple repos per actor, auth. Add them when file-level leases prove too coarse in real use.

---

## 4. Build plan, 11:00–16:00

| Time | Work | Done when |
|---|---|---|
| 11:00–11:30 | `bunx durable-actors dev` and local Relay running, versions pinned. Two worktrees of a small sample repo | hello-world actor responds; a Relay message gets through |
| 11:30–12:30 | `RepoActor`: claim, release, queue, notices outbox, alarm for stale leases. One `assert` self-check script | the script shows claim → deny → release → grant |
| 12:30–13:30 | Hook script plus `.claude/settings.json`: PreToolUse deny, PostToolUse inject, Stop long-poll. git `post-commit` and `pre-commit` | two Claude Code sessions: the second is blocked, then continues after the first commits |
| 13:30–14:15 | Relay: channel, `lease.*` Actions, release DMs. Codex via MCP | Codex gets a lease and a notice |
| 14:15–15:00 | Change digest, port leases, migration numbers | waiting agent's notice shows the rename; two dev servers start on different ports |
| 15:00–15:40 | Board (@Emittable): leases, queues, notices, Revoke | it updates live |
| 15:40–16:00 | Rehearse the demo twice | |

Cut order if you fall behind: board → migration numbers → port leases → Codex. The core is the leases plus the Claude hooks.

---

## 5. Demo (90 s, all real)

1. Two tasks with a deliberate overlap: Claude in wt-a "add OAuth refresh", Codex in wt-b "add session expiry". Both need `auth.ts`.
2. Claude takes `auth.ts`. Codex's edit is refused, and the board shows Codex queued. Codex works on `session.ts` meanwhile.
3. Codex DMs Claude over Relay: "export isExpired() from auth.ts". Claude adds it.
4. Claude commits. The notice reaches Codex: "merge abc123; added isExpired(), renamed getUser→fetchUser". Codex merges and then edits.
5. Merge both branches into main: **zero conflicts**. Then show a pre-recorded run of the same tasks without Foreman: a conflict in `auth.ts`.
6. Closer: both dev servers are running on their own ports, and the migrations are numbered 0042 and 0043.

**Pitch line:** "Worktrees move the conflict to merge time. Foreman removes it: one agent per file at a time, and every agent starts from the last one's commit."

---

# Combined plan: Foreman + agent review (added after checking Entire)

## What Entire does, and what's missing (checked Oct 31)

| Entire | The gap |
|---|---|
| Checkpoints record transcripts at commit time and share them at push. Trails (launched Oct 26) has review agents score each push. Gates decide when a merge is allowed | Nothing happens **while** agents run. Merge conflicts aren't addressed at all. Live sessions are only on the roadmap |
| Transcripts are stored on a git branch | Their most-upvoted open issue is entireio/cli#340: this is "architecturally problematic for privacy". Storage also blows up: entireio/cli#2663 reports 168 GB on one branch |
| Links commits to sessions after the fact | With parallel worktrees it attaches the wrong session: entireio/cli#2612 (Codex), entireio/cli#2979 (a sibling worktree), entireio/cli#2062 (parallel subagents) |

## The idea: Foreman is the live layer, and review comes out of it for free

1. **Leases plus notify** (unchanged). This prevents the conflicts.
2. **Every handoff is a review.** When B inherits `auth.ts`, it has to merge A's commit anyway. The release notice asks B to review that commit before building on it, and B posts the review in the Relay thread for that file. Since B often runs on a different vendor, this is cross-vendor review that costs almost nothing extra.
3. **Ask the author, without sharing transcripts.** A reviewer, human or agent, asks a question in the Relay thread for the commit ("why rename getUser?"):
   - If the author's session is still running, the question reaches it at its next tool call.
   - If the session has ended, Foreman resumes it locally in headless mode to answer (`claude --resume <id> -p "…"`).
   - Only the answer goes to the thread. The transcript never leaves the author's machine.
4. **Exact attribution.** The actor knows which agent held each file when each commit was made, so the history of each file is exact even with ten worktrees running.

**One-liner:** "Entire records what agents did after they're done. Foreman coordinates them while they work, so conflicts don't happen, every handoff gets reviewed, and the author agent answers questions without its transcript ever leaving your laptop."

## 5-hour scope
- 11:00–13:30: leases, notify and the Claude Code hooks. This is the core and doesn't change.
- 13:30–14:15: Relay channel and a thread per file. Codex joins over MCP.
- 14:15–14:45: the handoff review prompt goes into the release notice, and the review is posted to the thread.
- 14:45–15:20: ask-the-author: `foreman ask <sha> "…"` sends a DM to the live session, or falls back to `--resume -p`.
- 15:20–15:40: the board shows, per file, the lease, the queue, and the thread of reviews and Q&A.
- 15:40–16:00: rehearse.

Cut order if you fall behind: board → ask-the-author fallback → handoff review. Leases and notify ship regardless.

## Risks
- Entire supports Claude Code and Codex, and live sessions are on its roadmap. Live coordination is our lead, but it could close.
- The handoff review is only as good as the prompt, so check it on real commits before the demo.
- Check that `claude --resume <id> -p` works on a session that has ended, and check whether Codex has an equivalent.

---

# Hosting on Freestyle, history in Supabase

**Freestyle (do today):** one VM runs the Terse local runtime, the Relay server and the board.
- Expose it on a `*.style.dev` domain mapping, and create the VM with `idleTimeoutSeconds: null` so it stays up.
- Hooks on every laptop point at that URL, so agents on different machines share leases.
- Actor SQLite lives on the VM's disk. Take a Freestyle snapshot as the backup.
- Ceiling: this is a single node running Terse's dev runtime.

**Terse's production self-host is not for today.** It is GCP only: GKE + gVisor + Postgres + a GCS bucket. The sandbox providers are `gke` and `modal`.
- A `freestyle` provider modeled on `src/sandbox/modal.rs` (275 lines of Rust) would make Freestyle a data plane for Terse.
- Use it as a pitch slide or a later contribution. Building it alongside Foreman in 5h is too risky.

**Supabase:**
- **Cross-repo history (do today).** Each RepoActor also appends its events to one Postgres table: lease, release, handoff review, Q&A, commit attribution.
  - That fills Terse's known gap (no queries across actors). One table gives you hot files across all repos, an agent's history, "which agent wrote this", and review search.
  - Live state stays in the actors; history goes to Postgres.
- **Team login on the board (do today):** Supabase Auth with GitHub sign-in.
- **The Postgres for Terse's production control plane** (`DURABLE_ACTORS_POSTGRES_URL`). Only matters with the production setup above.
- **Skip Supabase Realtime** for the board, since `@Emittable` already streams state.

Schedule cost: about 30 min for the Freestyle deploy and about 40 min for the Supabase event table plus one query view. Take that time from the board polish and the ask-the-author fallback.

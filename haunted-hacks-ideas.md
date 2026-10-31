# Haunted Hacks 2026: the final 5 ideas from a 5-agent debate

Five agents each pitched ideas, then argued over them in a second round: ACTOR (knows the Terse durable-actors code), RELAY (knows the agent-relay code), PAIN (researched what developers complain about), SHOWRUNNER (judged what demos well) and SKEPTIC (checked what can actually be built).

The build window is 11am–4pm, 5 hours. Judging is by live demo. There's a bonus for using both tools. Prizes go to the best overall project (a YC interview), the best Durable Actors project, the best Agent Relay project, and the project most likely to "scale to millions".

## Ground rules all 5 agents agreed on
- **Don't use Relay's spawn, fleet, PTY or flows features.** They have more than 20 open bugs, including #1927 (spawn never reports ready), #1951 (Codex stuck on a trust prompt), #1938 (task text truncated) and #1865 (Codex hits "database is locked").
  - Run each worker yourself instead: an LLM loop that talks through `@agent-relay/sdk`, or a Claude Code session you open by hand with Relay's MCP tools.
- **Claude Code only sees Relay messages at the end of a turn, or when it next calls a Relay tool.** This is in `crates/probe/src/relay/claude/inbox.rs`. So if you need to reach an agent while it is busy, send the message through its PreToolUse hook response.
- **Run everything locally.** That means `bunx durable-actors dev` and `relay init`, which starts a Relaycast server on 127.0.0.1:8787. Self-hosting Durable Actors means running on GCP; skip that.
- **Pin versions the night before:** Node 22 or 24, and Bun 1.4.2 or newer. Pre-download the durable-actors runtime binary. Durable-actors ships releases daily, so pin its version too.
- **Durable Actors gotchas:**
  - Each actor gets only ONE alarm. If you need several timers, keep the soonest deadline in SQLite and set the alarm again after it fires.
  - Changing a `@Persisted` array or object in place (for example `.push()`) is not saved. Assign a new value instead.
  - Re-run `generate` after any change to an actor's API.
  - Actors shut down after 10 s idle by default, and waking one starts a new process. Keep hot actors alive with `@Compute({ idleTimeoutMs: 3_600_000 })`.
- **Expect the "kill the server and it resumes" demo to be everywhere tomorrow.** It's the hosts' own README pitch, so it isn't enough to stand out.

## Rejected
- **PR babysitter.** Anthropic already ships `/autofix-pr`.
- **Budget breaker.** LoopGuard, leash and others already do it, and a Relay "halt" only arrives after the agent's turn ends.
- **Durable inbox for Relay.** The Relay broker already persists deliveries and has a dead-letter queue.
- **Voice-driven agent factory.** It needs four integrations in 5 hours. Only its visualization survived.

---

## 1. FOREMAN, a.k.a. "Zombie Protocol" (all 5 agents ranked it #1)
**Pitch:** A coordination layer for multi-agent coding.
- Claiming a task also claims (leases) the files that task touches.
- Agents from different vendors (Claude Code, Codex) on different laptops never collide.
- If an agent dies, its task moves to another agent.
- If the dead agent comes back, its stale work is rejected.

**Pain, with evidence:**
- A study of 33,596 agent pull requests found merge conflicts in 41.7% of pairs from different vendors, versus 19.8% for same-vendor pairs. The study recommends a "claim protocol" to fix this.
- Relay's open issue #1766 is effectively a spec for this. Relay's own task ledger is one JSON file on one machine (`runtime/task_store.rs`).
- The closest existing tool is MCP Agent Mail. Its leases are only advisory and work on one host only.

**How it uses both tools:**
- **Durable Actors:**
  - A `RepoActor` holds the file leases with a TTL alarm.
  - One `TaskActor` per task moves through open → claimed → submitted → verified. It stores a generation number (a fencing token), and a heartbeat alarm puts the task back in the queue if the worker goes quiet.
  - `@Emittable` streams state to a live board.
- **Agent Relay:**
  - Relay Actions `task.claim`, `task.heartbeat` and `task.submit`.
  - DMs carry handoff negotiation between agents.
  - The board listens for `message.created` events.
- **Enforcement:** a Claude Code PreToolUse hook (a `curl` to the actor) blocks edits outside the agent's lease. The hook's response also carries any pending handoff requests to the agent that holds the lease.

**90-second demo:**
1. Two agents race for `auth.ts`. One is blocked and negotiates a handoff by DM. The merge comes out clean.
2. `kill -9` the Codex worker. Its leases turn grey, and Claude picks up the task from the last checkpoint.
3. **Zombie beat:** restart the dead worker. It submits its stale result and gets a **409** because its generation number is out of date. The judges see the zombie get "exorcised".
4. The judges' phones approve the final merge.

**Scale pitch:** one actor per repo and one per task, so it shards naturally.

**Build plan, team of 2:**
| Time | Person A | Person B |
|---|---|---|
| 11–12 | Both "hello world" setups, versions pinned | same |
| 12–2 | Repo and Task actors with alarms and 409 fencing | Relay Actions and the SDK worker loop |
| 2–3 | Hook script | Relay DMs |
| 3–3:40 | Board | Board |
| 3:40–4 | Rehearse the kill and zombie beats | same |

If you're short on time, cut the fancy board first and use observer-ui plus the Relay log side by side.

## 2. SÉANCE: a multiplayer permission gate for agents (proposed by ACTOR in round 2)
**Pitch:** A PreToolUse hook intercepts risky commands (`rm -rf`, `git push --force`, migrations) and holds them in a per-session actor.
- The actor pushes the request to teammates' phones over a WebSocket.
- The first approval wins, because the actor handles one call at a time.
- An alarm auto-denies at a deadline.
- A reviewer agent on Relay can veto with a written reason.

**Pain:** agents stall on permission prompts while the human is away from the keyboard.

**Demo:** the judges' phones decide on a live `git push --force`. Restart the server and the pending decision is still there.

**Feasibility:** the most buildable idea here, and doable solo.

**Weakness:** it uses Relay more lightly than Foreman.

## 3. Durable Task Ledger: contribute to Relay #1766 directly (SKEPTIC's and RELAY's pick)
**Pitch:** This is Foreman without the file leases and without the hook. It replaces Relay's single-file task store with one `TaskActor` per task.
- It stores results before acknowledging them.
- It ties each result to the generation number of the agent that produced it, and rejects stale or duplicate results.
- It survives losing the broker.

**Why build it:** the Relay team literally wrote this spec. It's the strongest pick for the "best Agent Relay" prize, and it's the safest fallback if the Foreman hook work slips.

**Demo:** kill the broker and the runtime mid-task, restart them, and the ledger resumes. Then show a duplicate submission rejected with a 409.

## 4. HAUNTED FLOORPLAN: a live, whole-swarm view of Relay and Durable Actors (the visualization pick)
**Gap:** nobody shows the whole swarm today.
- Durable Actors' observer-ui shows one actor at a time.
- Relay's viewer is the terminal `attach` command, one agent at a time.

**Pitch:**
- **Rooms** are actors and **ghosts** are agents.
- **Wisps** flying between rooms are real Relay messages (from the observer WebSocket `/v1/ws` and `message.created` events).
- Rooms go dark when an actor sleeps and flare when it wakes.
- A raw event-log toggle proves none of it is faked.

**Value:** a standalone fleet dashboard, which is a good entry for the "best Relay" prize. It's also the demo layer for ideas 1 and 3.

**Risk:** on its own it's "just" observability. You need a real swarm running underneath it.

## 5. HAUNTED HOUSE MMO: the fun pick (lowest pain score, highest audience energy)
**Pitch:**
- Rooms are actors holding WebSocket connections and state.
- AI ghost agents plot scares over a Relay channel, shown on screen as a "séance log".
- The audience joins by QR code.
- Restart the server mid-game and every room comes back intact.

**Strengths:** the easiest code, and the best Halloween fit.

**Weakness:** every agent called it a toy with no buyer, and Relay is decoration here.

**When to pick it:** only if you're going for crowd and costume energy rather than the YC interview.

## Scores, averaged across agents
Each of the five criteria is scored 1–10, so the maximum is 50.

| Idea | Pain | Uses both tools | Buildable in 5h | Demo wow | Startup | Total |
|---|---|---|---|---|---|---|
| Foreman / Zombie Protocol | 9 | 9 | 6 | 8.5 | 8.5 | ~41 |
| Task Ledger | 8 | 9 | 8 | 7 | 7.5 | ~39 |
| Séance gate | 8 | 7 | 8 | 8 | 7 | ~38 (one agent's score only) |
| Floorplan, as a layer over another idea | 5 | 7 | 4 | 9.5 | 5 | ~30 |
| Haunted MMO | 2 | 6.5 | 6.5 | 8 | 2 | ~25 |

## Closing line for the pitch
"Take off the costume and this is Chubby — Google's distributed lock service — for agent swarms: leases, fencing tokens and handoffs for every coding agent your team runs."

---

## Context and memory layer (plan as of Oct 30)

**What it adds to Foreman:** each agent keeps its own memory today, so a swarm has no shared memory.
- A durable actor per repo becomes the swarm's one serialized memory.
- Mastra's Observer and Reflector (observational memory) compress what every agent says on Relay into a short, dense log.
- A Freestyle VM snapshot gets forked together with that memory, so a branch carries both what the agent knew and the machine state it was in.

**How each tool is used:**
- **Durable Actors:**
  - one `MindActor` per repo or task holds the observation log, working memory and branch pointers;
  - it handles one call at a time, so concurrent agents can't overwrite each other's memory.
- **Mastra:** only its Observer and Reflector agents, used to compress memory. Mastra's built-in memory is per agent and stores working memory as a markdown blob, where the last write wins.
- **Freestyle:**
  - each worker runs in its own VM;
  - a VM can be paused with its memory intact, then resumed or snapshotted;
  - a snapshot takes under 50 ms (per their docs);
  - a snapshot can be forked into a new VM.
- **Agent Relay:** carries the agents' messages. Every message also feeds the Observer.

**Demo beats:**
1. **Possession:** kill the worker. A fresh agent starts from a fork of the dead worker's VM snapshot and receives the compressed log instead of the raw transcript.
2. **Shared memory:** agent B avoids a mistake that agent A already made, because both draw on the same memory.
3. **Multiverse:** fork the memory and the VM into two attempts, keep the one that wins, and the other's notes merge back into memory.

**Not verified yet:**
- Writing a custom Mastra storage adapter that sits on an actor touches many storage domains. Treat it as a stretch goal and call Observer/Reflector directly instead.
- Freestyle's API for forking a snapshot into a new VM: check the exact call first thing.

---

# Round 3: fresh panel (rules: no games, no payments, no Halloween, a real problem)
Earlier ideas were set aside as staged or already solved: file leases, crash/requeue, Living Plan, payments, and the game ideas.

**Final two (the panel split 3–2 on first place; average scores were within 0.2 of each other):**

## A. Fresh-Break Radar (world memory for broken releases)
- **How it works:**
  - Each `pkg@version` gets its own actor.
  - Agents from any vendor (Claude Code, Codex, ...) report a fresh breakage through a `reportBreak` Relay Action. The report carries the error fingerprint and the fix.
  - Other agents using that package get the fix pushed to them mid-session. They can DM the reporter with questions.
  - An alarm polls the registry. When a fixed version ships, the entry resolves and fades.
- **Trust:** a fix is shown as a hint only, until a second, independent agent (or a reproducer running in a Freestyle VM) reproduces it and verifies it.
- **Cold start:** seed the radar from GitHub issues opened in the first 48–72 hours after each release.
- **Demo:**
  - A local Verdaccio registry holding the real `is-promise@2.2.0` (broke create-react-app and angular-cli in 2020, fixed in 2.2.2 within hours). Fallback: `axios@1.0.0` under Jest.
  - Codex hits the error and reports it. Claude Code, in another repo, gets the fix pushed before it hits the error.
  - Publish 2.2.2 on stage and the entry fades.
- **Already exists:** Stack Overflow for Agents, Mozilla cq (curated and slow), Renovate Merge Confidence (needs 3 days of data, gives no workaround).
- **Gap:** live, pushed to agents mid-session, and expires by itself.
- **Risks:**
  - A 3-agent network doesn't show what a real network looks like.
  - Poisoning (bad fixes spreading).
  - Honest concession: Postgres + cron + pub/sub could also build this; actors make it simpler, not newly possible.
- **Panel votes:** first for JUDGE ("the one both founders would retweet") and ANYONE (best all-round for a dev); second for BUILDER, MEMORY and WORKFLOW.

## B. Contract Room (consumer agents sign off on API changes)
- **How it works:**
  - The provider's agent proposes a spec diff.
  - Each consumer team's own agent, scoped to its own repo, runs the `checkImpact` Action: oasdiff, a read through the code, and the team's tests.
  - The consumer signs off only once it has a migration PR ready, or proof it isn't affected.
  - One actor per contract holds the consumer registry, the sign-offs and a sunset alarm. The provider's merge is gated until everyone has signed off.
- **Demo:**
  - Consumer A's tests break; its agent opens the fix PR live.
  - Consumer B's break is on a path no test covers, so CI stays green. Its agent still catches it.
  - The provider proposes keeping both fields, and the gate goes green.
- **Already exists:**
  - Pact: fails because every party has to buy in (PactFlow's own words).
  - oasdiff and Optic: static checks, no knowledge of real usage.
  - CI dispatch: misses code paths no test covers.
  - Sourcegraph: needs org-wide access.
  - Gravitee: gateway policies only.
- **Risks:**
  - Monorepos don't need this.
  - A judge may ask "isn't this repository_dispatch with extra steps?". The demo has to show the break on the untested path.
  - Relay has no cross-org federation, so the demo runs in a single workspace.
- **Panel votes:** first for WORKFLOW, BUILDER and MEMORY; second for JUDGE.

**Killed in round 3:**
- Referral Loop: the specialist side has no agent, and HIPAA forces synthetic data.
- Clearance Room: buyers won't adopt it, and the demo looks like two LLMs chatting.
- Shared Agent Room: Cloudflare, Liveblocks and Electric already do it; Relay would be bolted on.
- LiftLine: rider reports would be staged, it isn't a dev problem, and Relay usage is weak.
- Author Proxy: a vendor could ship native PR transcripts.
- Ruled-Out Board: incident.io and PagerDuty already have it.

---

# Round 4: what people complain about in forums (Reddit, HN, GitHub issues, Cursor and OpenAI forums)

## 1. Ask the Author: the PR's own agent explains its changes (strongest evidence)
- **Pain:** reviewers get AI-written PRs that the author can't explain.
  - r/ExperiencedDevs "I won't be reviewing AI generated PRs": 1560 points, 406 comments. Other threads score 1902/143, 323/98 and 66/51.
  - Quote: "the author couldn't explain it either because they didn't write it".
  - LinearB: AI PRs wait 2.5–4.6x longer before a reviewer picks them up.
- **Current workarounds:** 15-minute screen-share walkthroughs, PR size caps, refusing to review, AI review bots. The bots judge the diff, but the reasoning behind it stayed in the author's agent session, which is gone by review time.
- **How it works:**
  - **Durable Actors:** when a PR opens, an actor for that PR builds an intent log from the author's session. It records which changes were deliberate, which were incidental churn, and the alternatives that were rejected.
  - **Agent Relay:** the reviewer, or the reviewer's own Claude or Codex, asks the author's agent questions directly. The author's agent answers from the log, pinned to the relevant line, or escalates to the human author.
  - **Alarm:** if more than N lines are still unexplained after 24 hours, the PR is marked "unexplained" or a split is proposed.
- **Risk:** GitHub or Anthropic may start attaching session transcripts to PRs. Answer: a raw transcript is thousands of lines nobody reads; what we sell is the Q&A interface on top of it.

## 2. Baton: an agent session that outlives your laptop (most upvotes; two research agents found it independently)
- **Evidence:**
  - claude-code #34255 (111 👍) and #32982 (87 👍): remote sessions die after 5–30 minutes idle.
  - #28791 (156 👍): session history doesn't sync between devices.
  - codex #23200 (68 👍): wants an always-on host so the laptop can sleep.
  - codex #37403 (67 comments): "already having an active writer", i.e. no way to hand a session to another device or person.
  - relay #789: "close my Mac laptop and hand off a running task to the VPS".
- **How it works:**
  - **Durable Actors:** each session is an actor that allows exactly one writer at a time. Viewers on phone or desktop connect to the actor over WebSocket.
  - **Agent Relay:** a worker process on the laptop, a VPS or a Freestyle VM attaches through Relay and passes write control on. Permission prompts are answered from any device.
  - **Alarm:** resumes the session when the usage limit resets.
- **Risks:**
  - The disconnects are vendor bugs, and Claude Code already has Remote Control and teleport.
  - Moving a live session between machines (transcript plus the working files) is hard to build in 5 hours.

## 3. Two-Key: production actions need a second sign-off (r/devops, three threads in one month; the top answer is "don't give agents prod access")
- **Durable Actors:** one actor per proposed action. It works out who has to sign, escalates on timeout, and on approval issues a 15-minute credential scoped to exactly that plan. Its log is the audit trail.
- **Prior art (not checked in this round, from memory):** Teleport access requests, Sym, Opal.

## 4. Benchmate: one hardware board shared by many people's agents (niche, creative)
- **Evidence:** agentic-hil, edesto and Embedder+SEGGER are tools for a single agent; Labgrid and university labs book boards for humans. Nothing handles queueing between agents.
- **Durable Actors:** one actor per board. It is the board's lock and queue, resets the board when a lease expires, and streams the serial console live.
- **Risk:** you need hardware at the venue. The fallback is a simulated board (Wokwi or QEMU).

## Also seen (weaker)
- **Ledger:** a shared plan and decision log across cofounders' agents (HN, low engagement).
- **Saturated:** "agents messaging each other". At least 7 HN launches, none with traction, and Claude Code #28300 has 60 comments of DIY hacks. This is Agent Relay's own pitch, so don't pitch it.
- **Feedback on the Terse HN launch:** no way to query across actors, and someone called 100ms writes "toys".

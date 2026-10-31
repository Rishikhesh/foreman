# Foreman: the plan in plain words

## The problem
You and your friend each run Claude Code on your own clone of the same repo. Both agents work fast and neither knows what the other is doing. Both edit `auth.ts`, and at merge time you get a conflict. You spend the next hour, and a pile of tokens, untangling it.

Worktrees or separate clones don't fix this. They only move the conflict from "while editing" to "when merging."

## The idea in one line
**One agent edits a file at a time. When it's done, the next agent gets the file together with the finished work, so there's nothing left to conflict.**

It works like a library checkout desk for code files:
- You check out `auth.ts`. Nobody else can edit it while you have it.
- Your friend's agent asks for it, is told who has it, and joins the waiting line. Meanwhile it works on other files.
- You commit. The desk hands `auth.ts` to your friend's agent with a note: "Here's the commit you need to pull first, and here's what changed."
- Your friend's agent pulls your change, reads it, and continues on top of your work. No conflict is possible on that file.

---

## The concepts, one by one

### 1. Lease: who holds which file
- The first time an agent tries to edit a file, it automatically takes a **lease** on it.
- If someone else already holds the file, the edit is politely refused, with a message: "auth.ts is held by claude@friend (task: add OAuth). You're #1 in line. Work on other files and you'll be told when it's yours."
- An agent editing a file it already holds just keeps going.
- Files outside the project, like notes or temp files, are never leased.

**Tools:**
- **Terse Durable Actors.** One "actor" per repo is the desk. It remembers every lease and every waiting line, and it handles one request at a time, so two agents can never both grab the same file.
- **Claude Code hooks.** A small script runs before every edit and asks the desk. The agent doesn't have to remember to do it.

### 2. Handoff: when the file moves on
- A file is released when its holder **commits** it.
- The commit is first pushed to GitHub, under a hidden name that doesn't touch any branch, so the other laptop can fetch it.
- The next agent in line receives the file plus three things:
  - the commit to pull;
  - a short summary of what changed (for example "renamed getUser to fetchUser");
  - the instruction to pull it before editing.
- If the push fails, for example when you're offline, the holder keeps the file. Nobody is handed work they can't fetch.

**Tools:**
- **Git hooks.** They run automatically after each commit to push it and release the file.
- **GitHub.** It carries the commit between the two laptops.

### 3. Getting the news to a waiting agent
An agent that's waiting has to find out the moment the file is free. There are three routes:
- **While it's busy elsewhere:** after each action, the agent is quietly told about any news.
- **When it's about to give up:** instead of stopping, it waits a few minutes for the file and then carries on by itself.
- **Through Relay:** the same news goes out as a message, so other kinds of agents (like Codex) and you get it too.

Other ways a file gets released:
- the holder's session ends;
- you press "revoke" on the board;
- the lease sits untouched for 20 minutes and expires on a timer.

**Tools:**
- **Claude Code hooks** for the first two routes.
- **Terse's built-in timer** for expiry.
- **Agent Relay** for messaging.

### 4. Every handoff is a review
The next agent has to read your commit anyway before building on it. So it's also asked to write a 3-line review, which is posted where everyone can see it. When a Claude agent takes over from a Codex agent, you get cross-vendor review almost for free.

**Tools:** **Agent Relay.** Each commit gets its own discussion thread in a shared `#foreman` channel.

### 5. Ask the author
Anyone, human or agent, can ask a question about a commit, like "why did you rename getUser?"
- **If the agent that wrote it is still running,** the question reaches it at its next step. It answers, and the answer goes into the commit's thread.
- **If that agent has finished,** you get the commit summary and the review thread instead. If you're on the same laptop where it ran, its session is resumed locally to answer.
- Either way, **its full conversation history never leaves the laptop.** Only answers are shared. This is the opposite of Entire, whose most-upvoted complaint is that it stores whole transcripts in git.

**Tools:** **Agent Relay** for the question and answer, and Claude Code's resume feature for finished sessions.

### 6. Leasing more than files
The same desk hands out other shared things that agents fight over:
- **Dev-server ports.** Each agent gets its own, so two agents don't both try to use port 3000.
- **Database migration numbers.** No more two agents both creating `0042_….sql`.

**Tools:** the same **Terse actor**.

### 7. History, and the most fought-over files
Every event (took a file, waited, released, reviewed, asked, answered) is also saved to a database. That lets you see, across all your repos:
- which files are fought over most, which is a sign they should be split;
- which agent wrote what;
- searchable reviews.

This also fills a known gap in Terse: you can't query across many actors, but you can query one table.

**Tools:** **Supabase** (Postgres).

### 8. The live board
One web page shows, for each file:
- who holds it and for how long;
- who's waiting;
- the most fought-over files;
- a revoke button.

It updates live with no refreshing.

**Tools:** **Terse's live state streaming.** The actor pushes every change to the page.

### 9. One shared server for both laptops
Both laptops talk to the same Foreman server.
- **During the build:** it runs on one laptop and the other connects over Wi-Fi.
- **For the demo and afterwards:** it runs on a Freestyle VM with a public web address, so it's always on and reachable from anywhere.

**Tools:**
- **Freestyle** for hosting.
- **Agent Relay's hosted workspace** so messages reach both laptops.

---

## How the pieces fit

```
 Your laptop                    Shared server (Freestyle)                Friend's laptop
 Claude Code ──hooks──┐         ┌───────────────────────────┐        ┌──hooks── Claude Code
 git commits ──hooks──┼──────▶  │  Foreman server           │  ◀─────┼──hooks── git commits
                      │         │   └ Terse actor per repo  │        │
                      │         │     (leases, lines, timer)│        │
                      │         └──────┬────────────┬───────┘        │
                      │                │            │                │
                      │        Agent Relay      Supabase             │
                      └──── #foreman channel,   (history,     ───────┘
                            DMs, threads        hot files)
                                   │
                              Live board (web)
```

## Who does what

| Tool | Its job in Foreman |
|---|---|
| **Terse Durable Actors** | The desk: one per repo. Holds leases and waiting lines, handles one request at a time, runs the expiry timer, streams the board |
| **Agent Relay** | The messaging: a shared channel, a thread per commit for reviews and Q&A, DMs to agents, and the way Codex takes part |
| **Claude Code hooks** | Makes it automatic: check before edit, deliver news, wait instead of quitting, release on session end |
| **Git hooks + GitHub** | Releases on commit and carries commits between laptops |
| **Supabase** | History and analytics across all repos |
| **Freestyle** | Hosts the shared server |

## Safety rules we're building in
- **If Foreman is down, agents carry on normally.** It never blocks your work.
- **Nobody is ever handed a commit they can't fetch.**
- **Transcripts stay on the laptop where they were made.**
- **It works the same with two laptops, or with two worktrees on one laptop.**

## Build order (11:00 to 16:00)
1. The desk: leases and waiting lines, with tests.
2. Putting it in a Terse actor, with the expiry timer.
3. The shared server.
4. Hooks: check before edit, release on commit, push commits.
5. Delivering the news: after each step, wait instead of quit, release on session end.
6. Relay: channel, threads, DMs.
7. Review on handoff, and ask the author.
8. Ports and migration numbers.
9. Supabase history.
10. The live board.
11. Hosting on Freestyle.
12. Rehearse the demo.

Steps 1–5 always ship. If time runs short, cut from the bottom: Freestyle first, then the board, and so on.

## The 90-second demo
1. Your Claude and your friend's Claude get tasks that both need `auth.ts`.
2. Yours gets the file. Your friend's is told to wait and works on another file meanwhile.
3. Your friend's agent asks yours over Relay: "while you're in there, add isExpired()". Yours does it.
4. You commit. Within seconds your friend's agent gets the file and the commit, pulls it, posts a 3-line review, and continues.
5. Merge both branches: **zero conflicts.** Then replay the same tasks without Foreman: a conflict.
6. Someone asks "why did you rename getUser?" and the author agent answers in the thread.

**Pitch:** "Worktrees move the conflict to merge time. Foreman removes it. One agent per file at a time, every agent builds on the last one's commit, and every handoff is a review."

## What we're deliberately not doing today
- Crash recovery.
- Leasing individual functions instead of whole files.
- Login for the board.
- Running Terse's full production setup on Freestyle. That's a good follow-up project, not today's work.

---

# Version 2: lock functions, not files, and show it live

## The idea
**Google Docs / Figma, but for coding agents.** Many agents from different people, on different laptops, all working on one repo at the same time. Everyone can see a live map of the code where each agent is a coloured cursor sitting on the function it's working on.

What already exists:
- **Zed and VS Code Live Share** let humans type into the same file at the same time.
- **Entire** records what agents did after they're done.

Nobody gives agents on separate machines a shared, live view of who's touching which function, or stops them from colliding on it.

## Locking functions instead of files
- Two agents can edit **the same file** at the same time, as long as they're in **different functions**.
- Only when both want **the same function** is the second one stopped. It's told who has the function and is queued.
- This matches how git merges. Git only conflicts when the same lines (or lines right next to each other) are changed on both sides. Different functions in one file merge cleanly.

**How we know which function an edit touches:**
- Every edit an agent makes says which file it's changing and the exact text it's replacing.
- The hook finds that text in the file and checks which function it sits inside. That function is what gets locked.
- An edit outside every function (imports, a brand-new function at the bottom) locks a small "top of file" slot for a moment. Both agents adding imports is the classic conflict.
- An agent rewriting the whole file locks every function in it.

**Tool:** the TypeScript parser (already part of TypeScript, nothing new to install) gives the exact start and end line of each function. That's for the demo repo; other languages can come later.

## When the function is done: tell everyone, with context
- The holder commits. The lock is released and the commit is pushed so the other laptop can fetch it.
- The next agent is told, through Relay and the hooks: "`validateToken` is yours now. Pull this commit first. What changed: added an expiry check and a new `isExpired()` helper."
- It pulls only that change, reads it, and builds on top of it.

### The bonus that only a code graph can give: who else is affected
If agent A changes **what a function looks like from the outside** (renames it, or changes its inputs), the agents working on code that **calls** that function need to know, even if they're in a different file. Without that they write code against the old version, and it breaks after merging even though git shows no conflict.

- Graphify knows who calls what, so the desk can warn exactly those agents: "`getUser` was renamed to `fetchUser` by claude@rishi. You're editing `login()`, which calls it. Pull commit abc123."
- That's a silent bug prevented. File locks can't do that, and git can't either.

**Tool:** **Graphify.** It reads the code without any AI and builds a graph of files and functions, plus the "calls" and "imports" links between them. It also has a built-in "what is affected if this changes" query.

## The live code map: the demo centrepiece
One web page for everyone:
- **The code as a map.** Files are clusters and functions are dots inside them. Lines between dots mean "this calls that".
- **Agents are coloured cursors.** Each agent has its own colour: you're blue, your friend is orange. A cursor moves to whatever the agent is **reading or editing**, live, so you can watch them work like cursors in Figma.
- **Locked functions glow** in the holder's colour. A waiting agent's cursor sits outside with a dotted line to the function it wants and a "waiting" badge.
- **The handoff is animated.** When a function is released, a pulse travels from one agent's colour to the other's, and the commit summary pops up.
- **Blast radius.** When a function's shape changes, the functions that call it flash, so you can see who got warned.
- **Side panel:** the Relay `#foreman` feed (messages, reviews, Q&A), plus a click-to-view source pane for any function, with the lines each agent changed tinted in that agent's colour.

**Tools:**
- **Graphify** builds the map from the repo at the start.
- **Terse** streams the live state: locks, queues, and where each cursor is. Cursor positions are kept in memory only, not saved, because they change every second.
- **Cytoscape.js** draws the map in the browser. It's a ready-made graph-drawing library loaded from a CDN, so there's no build step.
- **Relay** feeds the side panel.

**Where cursor positions come from:** the hooks report every time an agent reads or edits a file. Reads move the cursor, and edits take the lock.

## What changes in the build plan
Function locks and the map take about 2 extra hours. To make room, cut:
- port and migration-number leases;
- answering questions from a finished agent session (live Q&A stays);
- the Supabase history (it comes back later as "most fought-over functions").

| Time | What |
|---|---|
| 11:00–11:45 | The desk: function locks and queues, with tests |
| 11:45–12:15 | Terse actor + expiry timer + live cursor positions |
| 12:15–12:45 | Shared server + Graphify map of the demo repo |
| 12:45–13:30 | Hooks: find the function an edit touches, lock it, release on commit, push the commit |
| 13:30–14:00 | Hooks: deliver news, wait instead of quitting, report reads for cursors |
| 14:00–14:30 | Relay: channel, handoff notes, review threads |
| 14:30–15:30 | **The live map:** graph, coloured cursors, glowing locks, handoff animation, side panel |
| 15:30–15:45 | Blast-radius warning: changing a function warns the agents editing its callers |
| 15:45–16:00 | Rehearse |

Freestyle hosting goes in only if there's time. Otherwise the server runs on one laptop over Wi-Fi.

## The demo (90 seconds, all real)
1. The map is on the big screen. Blue (your Claude) and orange (your friend's Claude) cursors move around `auth.ts` as each agent reads.
2. Both agents edit **the same file**, in different functions. Both glow and both carry on. *"File locks would have blocked this."*
3. Orange reaches `validateToken`, which blue holds. Orange's cursor stops at the edge with "waiting", and it works on something else meanwhile.
4. Blue commits. A pulse goes from blue to orange, and the note pops up: "added expiry check; pull abc123". Orange pulls, posts a short review in Relay, and continues.
5. Blue renames `getUser`. Orange is editing `login()`, which calls it, in another file. `login()` flashes and orange gets the warning before it writes broken code.
6. Merge both: zero conflicts, and the tests pass.

**Pitch:** "Google Docs for coding agents: every agent on the team, on any laptop, on one live map. They work side by side down to the function, hand off with context, and get warned before they break each other's code."

## Honest limits
- Functions sitting right next to each other can still occasionally conflict in git if both edits touch the lines where they meet. That's rare; the "top of file" slot covers the most common case (imports).
- Function detection is TypeScript/JavaScript only for today.
- Graphify records where each function **starts**, not where it ends. That's fine for the map; exact locking uses the TypeScript parser.
- The map is built from `main` at the start. Changes since then show up through the live locks and cursors, not by re-drawing the map. Rebuilding it after each handoff is a stretch goal.

# Foreman: final plan

**Google Docs for coding agents.** Two people (more later), each with their own laptop, clone and Claude Code:
- they see each other's agents live on one map;
- they lock code down to the function;
- they hand off with context;
- they get warned before they break each other's code.

This replaces the earlier plans: it adds function-level locks, onboarding, Mastra and the live view.

---

## Milestone order
1. **Two harnesses share one picture.** Both Claude sessions are connected, see each other's presence and locks, and get each other's news. No visuals yet. This is the foundation; everything else sits on it.
2. **Onboarding.** Two people go from zero to connected in about 2 minutes.
3. **Handoff with context, powered by Mastra.**
4. **The live view:** file view first, repo map second.
5. **Warnings for affected callers.**
6. **Hosting.**

---

## 1. Two harnesses share one picture

**What happens:**
- Each Claude Code session, on either laptop, reports to the shared Foreman server through hooks: "I'm here", "I'm reading this file", "I want to edit this function", "I committed".
- The server keeps **one shared picture per repo**: who is connected, where each agent is, which functions are locked, and who is waiting.
- Every agent receives the parts of that picture that matter to it, at its next step:
  - "Heads-up: claude@rishi locked `validateToken` in a file you've opened."
  - "`validateToken` is yours now; pull abc123."

**Function locks:**
- Just before an edit, the hook looks at the text being replaced and uses the TypeScript parser to find the function it sits inside. That function is locked.
- Different functions in one file never block each other.
- Imports or a brand-new function take a short lock on the "top of file" slot.
- An edit that spans several functions, or a whole-file rewrite, locks every function it touches.

**Tools:**
- **Terse:** one actor per repo holds the shared picture. It handles one request at a time, so there are no races, it runs a timer to expire forgotten locks, and it streams changes live.
- **Claude Code hooks** report and deliver.
- **Agent Relay** carries the messages: a `#foreman` channel and DMs.
- **Git + GitHub:** each commit is pushed to a hidden ref so the other laptop can fetch it.

**Done when:** you and your friend open Claude on the same repo. Each agent is told when the other locks something it cares about. When both go for the same function, the second is stopped and then handed the function, with the commit, when the first commits.

---

## 2. Onboarding for two people

**Person 1 (host), in their clone:**
```
npx foreman init
```
1. Checks the basics:
   - this is a git repo with a GitHub remote;
   - you can push the hidden refs (a dry-run push);
   - Bun and Node are installed;
   - Claude Code is installed.

   Each check prints a plain fix if it fails.
2. Creates the room for this repo: picks the server (your laptop or the hosted one) and creates the shared Relay workspace.
3. You pick a name and a colour, for example "rishi, blue".
4. Installs the hooks: Claude Code's settings and git's commit hooks.
5. Prints an **invite command** to send to your friend privately, because it contains the room's key:
   `npx foreman join fm_7Hq2…`
6. Opens the board in your browser, showing a lobby: "Waiting for teammates. You: rishi (blue)."

**Person 2 (teammate), in their own clone:**
```
npx foreman join fm_7Hq2…
```
1. Runs the same basic checks.
2. **Confirms it's the same repo**, so an SSH clone and an HTTPS clone still match. A different repo is refused: "This clone is a different repo than the room you're joining."
3. Picks a name and colour. Colours already taken aren't offered.
4. Installs the same hooks.
5. The host's board shows "friend joined (orange)" live, and Relay posts it in `#foreman`.

**First run:** each person opens Claude Code. On the agent's first action its cursor appears on the board in that person's colour. The lobby turns into the live view.

**Other commands:**
- `foreman status` shows who's in the room and what's locked, from the terminal.
- `foreman leave` removes the hooks.

**Tools:**
- a small Bun command-line tool, published to npm so `npx` works;
- Relay's hosted workspace;
- the Terse actor, which keeps the member list and colours.

---

## 3. Handoff with context, powered by Mastra

**The problem it solves:**
- A commit message says *what* changed, not *why*, or what to watch out for.
- Shipping the full transcript to your teammate is too big, and it's a privacy problem; that's Entire's top complaint.

**What we use from Mastra:** only its **observational memory** pieces, as a library, running on **each person's own laptop**. We don't run the Mastra server.
- **Observer:** as your agent works, the hooks feed its turns to an Observer. The Observer keeps a short, running list of observations about this session, such as:
  - "chose to check expiry in validateToken, not in the middleware";
  - "tests in auth.test.ts are flaky on CI".
- **Reflector:** compresses those observations as they grow, so a long session stays small.
- **Storage:** observations are saved in a local SQLite file on your laptop (Mastra's LibSQL store).

**What it gives us:**
1. **Handoff notes.** When you commit and a function passes to your friend, the note is built from your observations plus the diff. It covers what changed, why, and what to watch out for. Only that short note leaves your laptop.
2. **Ask the author, even after the session has ended.** "Why did you rename getUser?" is answered from your saved observations on your laptop, even after your Claude session has closed. Only the answer is shared.

**Tools:**
- **Mastra:** `@mastra/memory` (ObservationalMemory) and `@mastra/libsql`, attached to a plain `@mastra/core` Agent.
- **OpenAI** as the Observer's model, using sponsor credit. Mastra's docs say Claude models don't work well as the Observer.

**Done when:** a handoff note shows a "why" that isn't in the commit message, and a question about a finished session gets a sensible answer.

---

## 4. The live view: what judges see

**File view (the main demo screen):**
- The file's code split into function blocks.
- Each locked block has a border and a coloured stripe down the left in its owner's colour, with a label: "locked by claude@rishi · 2m".
- Live cursors (a coloured caret and a name flag) on the line each agent is editing.
- The changed lines are tinted in the agent's colour as it works. They update after every edit.
- A "waiting · #1 in line" badge on a block another agent wants.
- The handoff, animated: the block's colour switches from blue to orange, and the handoff note pops up.
- Free blocks show what they call or what calls them ("free · calls validateToken").

**Repo map (the opening shot):**
- Graphify's graph of the repo: files are clusters, functions are dots, and lines show what calls what.
- Coloured cursors move between dots as the agents read and edit, and locked dots glow.
- Click a file to open its file view.

**Side panel:** the Relay `#foreman` feed (joins, locks, handoffs, reviews, questions and answers) and the room's member list.

**Tools:**
- **Terse** streams the shared picture to the page live. Cursor positions and live code are kept in memory only, never saved.
- **Graphify** builds the map. It reads code without AI or a key.
- **Cytoscape.js** draws the map.
- The page is plain HTML with no build step.

---

## 5. Warnings for affected callers
When an agent changes a function's name or inputs, Graphify's "what calls this" lookup finds the functions that use it. Any agent working on one of those is warned before it writes code against the old version, and those blocks flash on the board.

**Tools:** Graphify, and the Terse actor to send the warnings.

## 6. Hosting
- **During the build:** the server runs on one laptop and the other connects over Wi-Fi.
- **For the demo, if time allows:** one Freestyle VM with a public address.

---

## Build order, 11:00–16:00

| Time | What | Milestone |
|---|---|---|
| 11:00–11:45 | Shared picture: function locks, waiting lines, presence, with tests | 1 |
| 11:45–12:15 | Put it in a Terse actor with a timer and live streaming. Shared server | 1 |
| 12:15–13:00 | Hooks: find the function, lock it, report cursors, deliver news, release on commit and push | 1 |
| 13:00–13:20 | **Check:** two laptops, two Claudes, collision, then handoff | 1 ✔ |
| 13:20–13:50 | Onboarding: `init`, `join`, checks, invite, lobby | 2 |
| 13:50–14:30 | Mastra on each laptop: Observer, handoff note, ask-the-author | 3 |
| 14:30–15:25 | Live view: file view, then the repo map, then the side panel | 4 |
| 15:25–15:40 | Warnings for affected callers | 5 |
| 15:40–16:00 | Rehearse. Freestyle only if it's already done | 6 |

**If behind, cut in this order:**
1. Freestyle
2. The repo map (keep the file view)
3. Caller warnings
4. Ask-the-author (keep Mastra handoff notes)

Milestone 1 and the file view always ship.

## Demo (90 seconds)
1. **Onboarding, live:** you run `init` and your friend runs `join`. The board shows "friend joined (orange)". About 20 seconds.
2. Both Claudes start. Blue and orange cursors appear in `auth.ts`, in different functions, and both work.
3. Orange reaches `validateToken`, which blue holds. Orange is stopped, gets a "waiting" badge, and works elsewhere.
4. Blue commits. The block turns orange and the Mastra handoff note appears: "added expiry check; chose to do it here, not in middleware; watch flaky test X". Orange pulls and continues.
5. Blue renames `getUser`. Orange's `login()` flashes and orange is warned.
6. Merge both: zero conflicts.

**Pitch:** "Google Docs for coding agents. Every agent on the team, on any laptop, on one live map. They work side by side down to the function, hand off with real context, and the transcripts never leave your laptop."

## Not today
- Crash recovery
- Languages other than TypeScript/JavaScript
- Login on the board
- More than about 4 people per room (it should work; it just isn't tested)
- Running Terse's full production setup on Freestyle

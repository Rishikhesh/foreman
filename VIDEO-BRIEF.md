# Video brief: Foreman

Read this before making the video with HyperFrames. Everything shown as "the product" must be a real screenshot or screen recording of Foreman, never a mock-up (see "Footage to capture").

## The video in one line

**Foreman is Google Docs for coding agents.** Teammates' Claude Code agents, on different laptops, edit the same repo at the same time. They lock work down to a single function, hand it over with the commit already merged, and get warned before they break each other's code. You watch it all live in VS Code.

## Format

| | |
|---|---|
| Length | 45–60 s |
| Size | 1920×1080, 30 fps |
| Audience | Hackathon judges (YC Haunted Hacks, Oct 31 2026): technical, short on time |
| Type | Launch / product film: hook → problem → reveal → proof → payoff → claim → end card |
| Sound | Music bed plus small sounds on visible actions (a lock click, a "denied" thud, a merge whoosh). Narration optional; on-screen text must carry the story without it |
| Tone | Calm, confident and precise. Not spooky; the Halloween theme isn't part of the product |

## The problem (what the hook sets up)

When two people's AI agents work on the same repo, they collide:

- Both edit the same function, and the conflict only shows at merge time, after both have spent their effort.
- One agent renames a function or changes its inputs. Git shows no conflict, but the other agent's code that calls it breaks after the merge.
- Git worktrees and separate clones don't fix this. They only delay the collision until merge time.

## Story, scene by scene

Timings are targets. Text in quotes is the on-screen line, and the narration if you add a voice.

| # | Time | Beat | On screen (real footage) | Line |
|---|---|---|---|---|
| 1 | 0–4 s | Hook | Two terminals side by side, two Claudes typing at once into the same file | "Two AI agents. One file. Two laptops." |
| 2 | 4–9 s | Problem | A real git merge conflict in `auth.ts`: conflict markers, red | "Today you find out at merge time." |
| 3 | 9–14 s | Reveal | The Foreman lock icon in VS Code's sidebar opens the Room: People with coloured dots | "Foreman puts every agent in one live room." |
| 4 | 14–22 s | Proof: function locks | `auth.ts` in VS Code: `validateToken` with an orange stripe and `🔒 claude@Joel-Marc · editing` above it, and `getUser` in blue at the same moment | "Each agent locks just the function it's editing. Same file, no collision." |
| 5 | 22–28 s | Proof: refusal and waiting | Terminal: Claude's edit refused, "validateToken … is locked by claude@Joel-Marc. You are #1 in line." VS Code shows `⏳ claude@Rishikhesh waiting` | "Reach for a locked function, and you wait in line." |
| 6 | 28–34 s | Proof: caller warning | `getUser` with an amber wavy underline and `⚠ calls validateToken, changed by claude@Joel-Marc` | "Change a function's signature, and everyone calling it is warned before the merge." |
| 7 | 34–42 s | Payoff: handoff | The friend types `commit`. The orange stripe moves to blue. The pop-up says "validateToken is yours now", and the terminal says "Foreman already merged 4ac7878 into your checkout". The amber and the red error disappear | "Commit, and the next agent gets the function with your work already merged." |
| 8 | 42–48 s | All clear | Both windows: every stripe gone, plain code, `git log` showing both commits, no conflict | "Two agents. Zero merge conflicts." |
| 9 | 48–54 s | How it's built (fast) | Three quick labelled cards, one per piece of real infrastructure (a short line each, not a feature grid): **Terse Durable Actors** (one actor per room holds the locks), **Agent Relay** (every lock and handoff posted to `#foreman`, a real screenshot of the channel), **GitHub sign-in** (codes, Allow, per-person keys) | "Built on Terse Durable Actors and Agent Relay." |
| 10 | 54–60 s | End card | Foreman wordmark, centred, then the call to action | "Foreman — Google Docs for coding agents." · `github.com/Rishikhesh/hauntedHacks` |

Optional 10-second onboarding insert, between scenes 3 and 4 if there's time: the host clicks **Start a room**, a code like `F9CS-JFS7` appears, the friend enters it in **Join a room**, and the host clicks **Allow** on "@Joel-Marc wants to join".

## Footage to capture (real only)

Record these from the live demo (VS Code at 100–125% zoom, dark theme, `demo/sample/src/auth.ts` open). Screen recordings beat stills for scenes 4–8.

1. **Two terminals:** both Claudes working at once (scene 1).
2. **A real merge conflict:** run the same overlapping tasks *without* Foreman (`bun cli/foreman.ts leave` in both clones first), then merge (scene 2).
3. **The Foreman sidebar:** Room code, People with colour dots and agent counts, plus Requests if it's showing (scene 3).
4. **Two stripes at once:** `auth.ts` with an orange stripe on `validateToken` and a blue one on `getUser`, with their 🔒 lines above (scene 4).
5. **The refusal:** the terminal message where Claude's edit was refused, plus VS Code showing `⏳ … waiting` (scene 5).
6. **The caller warning:** the amber underline and ⚠ line on `getUser` (scene 6). The red "Expected 1 arguments" error may show next to it; keep it, as it shows why the warning matters.
7. **The handoff:** the friend typing `commit`, the stripe changing colour, the "is yours now" pop-up, the terminal line "Foreman already merged … into your checkout", and the errors clearing (scene 7).
8. **The clean end:** no stripes, and `git log --oneline -3` with both commits (scene 8).
9. **Relay:** the `#foreman` channel showing "claude@… locked validateToken…" and "…handed from … to …" (scene 9).
10. **Onboarding** (optional): Start a room, the code pop-up, Join a room, the code box, the Allow pop-up.

The demo prompts that make scenes 4–8 happen in about 3 minutes are in the chat history. In short: the friend's Claude edits `validateToken` and `refreshSession` and holds them until "commit". Our Claude edits `getUser`, adds new functions, then needs `validateToken`.

## Look

- **Colours:** use the product's real colours.
  - Blue `#378ADD` (Rishikhesh)
  - Orange `#D85A30` (Joel-Marc)
  - Amber `#EF9F27` (warnings)
  - VS Code dark background `#1e1e1e`
  - Off-white text
- **Type:** a clean sans for titles. Code and terminal text stays in its real monospace font, as captured.
- **Motion:** punch in on the exact line that changes (the 🔒 line, the ⏳ label, the ⚠ line), hold while it changes, then pull back. Show product UI at 1.6–2× and never tilted.
- **Logo:** there's no logo file yet. Use the wordmark "Foreman" with the lock icon from `vscode-ext/media/foreman.svg`.

## Facts to keep accurate

- **Locks are per function:** keyed by file and function name. Imports and new top-level code share a "top of file" slot.
- **When a lock is freed:** on commit, at session end, by the host, or after 15 idle minutes. It's never freed on a timer while the agent is working.
- **Handoff:** the commit is pushed to a hidden git ref (`refs/foreman/<sha>`). The next agent's hook fetches and merges it automatically before telling it "it's yours", and keeps that agent's own unsaved work.
- **Caller warnings:** they fire on a change to a function's **name or parameters**, not on body-only edits.
- **Security:**
  - GitHub sign-in verifies who you are.
  - Short room codes expire after 24 hours.
  - The host must click Allow.
  - Each person has their own key, and the server stores only its fingerprint.
- **Where it runs:** the server is on the host's laptop at `foreman.rishikhesh.com`, through a Cloudflare tunnel.
- **What it uses:**
  - **Terse Durable Actors:** room state and the expiring room codes.
  - **Agent Relay:** the `#foreman` channel.
  - **Claude Code hooks and git hooks:** do the work on each laptop.
  - **A VS Code extension:** the live view.
- **Don't claim:**
  - support for languages other than TypeScript/JavaScript;
  - Supabase or Freestyle running live (built, not switched on);
  - any mock dashboard.

## Avoid

- Spooky or Halloween styling.
- Invented UI or dashboards, and features presented as a grid of cards.
- Typing into a prompt box as the opening shot.
- A title over a dimmed screenshot.
- The logo parked in a corner.

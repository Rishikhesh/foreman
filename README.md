# Foreman

Google Docs for coding agents. Several people's Claude Code agents work on one repo at once:

- **Function locks:** an agent editing a function locks just that function. Others can still edit the rest of the file.
- **Handoff:** when it commits, the next agent waiting for that function gets it, with the commit already merged into its checkout.
- **Caller warnings:** if a function's name or parameters change, agents working on code that calls it are warned.
- **VS Code:** shows it all live, with coloured stripes, the holder and who's waiting above each function, and a Room sidebar.

Built on [Terse Durable Actors](https://github.com/TerseAI/durable-actors) (one actor per repo holds the room) and [Agent Relay](https://github.com/AgentWorkforce/relay) (every lock and handoff is posted to `#foreman`).

## Needs

[Bun](https://bun.sh) 1.4+, git, VS Code, and Claude Code.

## Host: run the server (one laptop)

```bash
git clone git@github.com:Rishikhesh/hauntedHacks.git && cd hauntedHacks && bun install
bun run dev                 # Terse, keep it running
bun src/server.ts           # Foreman server on :7300, in a second terminal
cloudflared tunnel --url http://localhost:7300   # public https address, in a third terminal
```

Then, in your clone:

```bash
bun cli/foreman.ts init --url http://127.0.0.1:7300 --name <you> --color blue
bun cli/foreman.ts invite --url https://<your-tunnel>.trycloudflare.com    # send the printed line to your teammate
```

Add your teammate as a collaborator on the GitHub repo. Handoffs push commits to hidden `refs/foreman/*` refs, so both of you need push access.

## Teammate: join

```bash
git clone git@github.com:Rishikhesh/hauntedHacks.git && cd hauntedHacks && bun install
ln -sfn "$PWD/vscode-ext" ~/.vscode/extensions/foreman.foreman-dev   # then restart VS Code once
bun cli/foreman.ts join fm_…  --name <you> --color orange
```

Or, in VS Code: Command Palette → **Foreman: Join room**, then paste the invite.

Then both of you open the repo in VS Code, trust the folder, and start Claude Code in it. Try `demo/sample/src/auth.ts`.

## Try it alone first

```bash
bun demo/setup.ts       # two worktrees in .demo/ stand in for two people
code -n .demo/rishi && code -n .demo/friend   # open demo/sample/src/auth.ts in both
bun demo/simulate.ts    # two fake agents run the full flow; every colour clears at the end
```

## Commands

`foreman init | join | invite | leave | status`

Hooks run on their own once you're in a room.

To update, run `git pull`, then **Foreman: Update and reload** in VS Code.

## Tests

`bun run test`. Needs `bun run dev` running for the server tests.

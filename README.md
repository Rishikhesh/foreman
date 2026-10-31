# Foreman

Google Docs for coding agents. Several people's Claude Code agents work on one repo at once:

- **Function locks:** an agent editing a function locks just that function. Others can still edit the rest of the file.
- **Handoff:** when it commits, the next agent waiting for that function gets it, with the commit already merged into its checkout.
- **Caller warnings:** if a function's name or parameters change, agents working on code that calls it are warned.
- **VS Code:** shows it all live, with coloured stripes, the holder and who's waiting above each function, and a Room sidebar.

Built on [Terse Durable Actors](https://github.com/TerseAI/durable-actors) (one actor per repo holds the room) and [Agent Relay](https://github.com/AgentWorkforce/relay) (every lock and handoff is posted to `#foreman`).

## Needs

[Bun](https://bun.sh) 1.4+, git, VS Code, and Claude Code.

## Host (the laptop that runs the server)

```bash
git clone git@github.com:Rishikhesh/hauntedHacks.git && cd hauntedHacks && bun install
bun cli/foreman.ts install-extension      # then quit and reopen VS Code
```

In VS Code, open the repo, then go to the Foreman sidebar and click **Start a room**.

1. Sign in with GitHub.
2. Pick a colour.
3. You get a code like `K7QM-2XPA`.

Start a room also starts Terse, the server and your Cloudflare tunnel if they aren't running. The address is `foreman.rishikhesh.com`, set by `foreman.serverUrl`.

To invite someone, click the room line in the sidebar. It copies a ready-to-paste message.

When your teammate asks to join, you get an **Allow** button.

Add your teammate as a collaborator on the GitHub repo. Handoffs push commits to hidden `refs/foreman/*` refs, so both of you need push access.

## Teammate

```bash
git clone https://github.com/Rishikhesh/hauntedHacks.git && cd hauntedHacks && bun install
bun cli/foreman.ts install-extension      # then quit and reopen VS Code
```

Open the folder in VS Code and click **Trust**. Then go to the Foreman sidebar and click **Join a room**.

1. Sign in with GitHub.
2. Enter the code.
3. Pick a colour.
4. Wait for the host to allow you.
5. Start Claude Code in that folder.

## Security

- **Identity:** GitHub verifies who you are. The server checks your token with GitHub once and never stores it.
- **Room key:** each person's laptop makes its own room key. The server keeps only its SHA-256 fingerprint.
- **Every request is checked:** each request and the live view must carry a valid key for that room. Without one, the server answers 401.
- **The host decides:** nobody gets in without the host clicking Allow, and the host can remove people.
- **Room codes:** a code opens one room and expires after 24 hours.
- **Demo identities:** `--dev <name>` is accepted only from the server's own laptop, never through the tunnel.

## Run the demo together

Each person uses their own clone, on their own laptop.

1. Both run `bun run demo:reset`. It puts `demo/sample` back to the GitHub version without touching anything else.
2. Both open `demo/sample/src/auth.ts` in VS Code.
3. Both start a new Claude Code session in the clone. Hooks load when a session starts.
4. Give the two Claudes tasks that overlap on one function, e.g. `validateToken`. Have one of them hold its change until you say "commit".

## Commands

`foreman init | join <code> | allow <login> | invite | leave | status | install-extension`

Hooks run on their own once you're in a room.

To update, run `git pull`, then **Foreman: Update and reload** in VS Code.

## Tests

`bun run test`. Needs `bun run dev` running for the server tests.

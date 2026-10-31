/** The public https address in cloudflared's quick-tunnel log, once it has one. */
export const tunnelUrl = (log: string): string | null => log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null

/** Any git remote (ssh, scp-style, host alias, https) → a clonable https link, case kept. */
export function shareUrl(remote: string): string {
  let s = remote.trim().replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):/, "$1/")
  // ponytail: SSH host aliases like `github-personal` are assumed to mean github.com, same as repoKey
  s = s.replace(/^github[^/]*\//, "github.com/")
  return `https://${s.replace(/\.git$/, "")}.git`
}

/** Everything a teammate needs, in one message to paste into chat. */
export function teammateMessage(o: { host: string; cloneUrl: string; invite: string; freeColors: string[] }): string {
  const folder = o.cloneUrl.replace(/\.git$/, "").split("/").pop()
  return `${o.host} invited you to a Foreman room: our Claude Code agents share live function locks and handoffs.

1. Install Bun if you don't have it: https://bun.sh
2. In a terminal:
   git clone ${o.cloneUrl} && cd ${folder} && bun install
   bun cli/foreman.ts join ${o.invite} --name <your name> --color ${o.freeColors[0] ?? "green"}
   (free colours: ${o.freeColors.join(", ")})
3. Quit and reopen VS Code, open the ${folder} folder, click Trust, and start Claude Code in it.

Keep the invite private: anyone with it can join the room.`
}

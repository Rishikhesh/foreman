import { formatCode } from "./code.js"

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
export function teammateMessage(o: { host: string; cloneUrl: string; code: string }): string {
  const folder = o.cloneUrl.replace(/\.git$/, "").split("/").pop()
  const code = formatCode(o.code)
  return `${o.host} invited you to a Foreman room. Room code: ${code}

1. Install Bun if you don't have it: https://bun.sh
2. In a terminal:
   git clone ${o.cloneUrl} && cd ${folder} && bun install
   bun cli/foreman.ts install-extension
3. Quit and reopen VS Code, open the ${folder} folder, and click Trust.
4. In the Foreman sidebar: Join a room → sign in with GitHub → enter ${code} → pick a colour.
5. When ${o.host} lets you in, start Claude Code in that folder.`
}

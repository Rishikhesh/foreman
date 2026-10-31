import { expect, test } from "bun:test"
import { shareUrl, teammateMessage, tunnelUrl } from "./share.js"

test("tunnelUrl reads the public address out of cloudflared's log", () => {
  const log = "2026 INF Requesting new quick Tunnel\n2026 INF |  https://thee-pollution-amazing-investments.trycloudflare.com  |\n"
  expect(tunnelUrl(log)).toBe("https://thee-pollution-amazing-investments.trycloudflare.com")
  expect(tunnelUrl("starting…")).toBeNull()
})

test("shareUrl turns any git remote into a clonable https link, keeping case", () => {
  expect(shareUrl("git@github-personal:Rishikhesh/hauntedHacks.git")).toBe("https://github.com/Rishikhesh/hauntedHacks.git")
  expect(shareUrl("git@github.com:org/Repo.git")).toBe("https://github.com/org/Repo.git")
  expect(shareUrl("https://github.com/org/repo")).toBe("https://github.com/org/repo.git")
  expect(shareUrl("ssh://git@gitlab.com/a/b.git")).toBe("https://gitlab.com/a/b.git")
})

test("teammateMessage walks the friend from clone to joined, with the short code", () => {
  const msg = teammateMessage({ host: "rishi", cloneUrl: "https://github.com/Rishikhesh/hauntedHacks.git", code: "K7QM2XPA" })
  expect(msg).toBe(`rishi invited you to a Foreman room. Room code: K7QM-2XPA

1. Install Bun if you don't have it: https://bun.sh
2. In a terminal:
   git clone https://github.com/Rishikhesh/hauntedHacks.git && cd hauntedHacks && bun install
   bun cli/foreman.ts install-extension
3. Quit and reopen VS Code, open the hauntedHacks folder, and click Trust.
4. In the Foreman sidebar: Join a room → sign in with GitHub → enter K7QM-2XPA → pick a colour.
5. When rishi lets you in, start Claude Code in that folder.`)
})

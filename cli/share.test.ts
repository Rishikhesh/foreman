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

test("teammateMessage gives the friend everything in one paste", () => {
  const msg = teammateMessage({ host: "rishi", cloneUrl: "https://github.com/Rishikhesh/hauntedHacks.git", invite: "fm_abc", freeColors: ["green", "purple"] })
  expect(msg).toBe(`rishi invited you to a Foreman room: our Claude Code agents share live function locks and handoffs.

1. Install Bun if you don't have it: https://bun.sh
2. In a terminal:
   git clone https://github.com/Rishikhesh/hauntedHacks.git && cd hauntedHacks && bun install
   bun cli/foreman.ts join fm_abc --name <your name> --color green
   (free colours: green, purple)
3. Quit and reopen VS Code, open the hauntedHacks folder, click Trust, and start Claude Code in it.

Keep the invite private: anyone with it can join the room.`)
})

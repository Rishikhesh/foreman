// Drives two fake agents through the real Foreman hooks and git, so the VS Code windows show live activity.
// Usage: bun demo/simulate.ts [demoDir]   (default ~/personal/foreman-demo)
import { readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const demo = process.argv[2] ?? path.join(os.homedir(), "personal/foreman-demo")
const CLI = path.join(import.meta.dir, "..", "cli", "foreman.ts")
const rishi = { dir: path.join(demo, "rishi"), session: `sim-rishi-${Date.now()}` }
const friend = { dir: path.join(demo, "friend"), session: `sim-friend-${Date.now()}` }
const file = (who: typeof rishi) => path.join(who.dir, "src/auth.ts")

async function hook(who: typeof rishi, sub: string, tool: string, input: Record<string, unknown>) {
  const p = Bun.spawn(["bun", CLI, "hook", sub], {
    cwd: who.dir,
    stdin: new Response(JSON.stringify({ session_id: who.session, cwd: who.dir, tool_name: tool, tool_input: input })),
    stdout: "pipe",
  })
  const out = await new Response(p.stdout).text()
  return out ? JSON.parse(out) : null
}
const step = async (msg: string) => {
  console.log(`\n▶ ${msg}`)
  await Bun.sleep(3000)
}

await step("blue (rishi) reads auth.ts")
await hook(rishi, "pre-tool", "Read", { file_path: file(rishi), offset: 3 })
await step("orange (friend) reads auth.ts")
await hook(friend, "pre-tool", "Read", { file_path: file(friend), offset: 8 })
await step("blue starts editing validateToken → locked blue")
await hook(rishi, "pre-tool", "Edit", { file_path: file(rishi), old_string: "  return claims" })
await step("orange edits refreshSession in the same file → allowed, locked orange")
await hook(friend, "pre-tool", "Edit", { file_path: file(friend), old_string: "  return { ...session, refreshedAt: Date.now() }" })
console.log("  orange mailbox:", (await hook(friend, "post-tool", "Edit", {}))?.hookSpecificOutput?.additionalContext ?? "(empty)")
await step("orange tries validateToken → refused, queued behind blue")
const deny = await hook(friend, "pre-tool", "Edit", { file_path: file(friend), old_string: "  return claims" })
console.log("  orange was told:", deny?.hookSpecificOutput?.permissionDecisionReason)
await step("blue finishes: adds an expiry check and commits")
const src = readFileSync(file(rishi), "utf8").replace("  return claims\n", "  if (claims.exp && claims.exp * 1000 < Date.now()) return null\n  return claims\n")
writeFileSync(file(rishi), src)
await $`git -C ${rishi.dir} commit -qam "validateToken: reject expired tokens"`.quiet().nothrow()
await step("orange's next step picks up the handoff")
console.log("  orange was told:", (await hook(friend, "post-tool", "Read", {}))?.hookSpecificOutput?.additionalContext ?? "(empty)")
console.log("\nDone. Watch the orange window for the 'validateToken is yours' pop-up with Pull commit.")

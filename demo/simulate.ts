// Full Foreman flow with two fake agents driving the real hooks and git, so both VS Code windows show it live:
// lock → edit → blocked → caller warning → commit → handoff with automatic merge → finish → every colour clears.
// Usage: bun demo/simulate.ts [demoDir]   (default ~/personal/foreman-demo)
import { readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const demo = process.argv[2] ?? path.join(os.homedir(), "personal/foreman-demo")
const CLI = path.join(import.meta.dir, "..", "cli", "foreman.ts")
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS ?? 3500)
type Who = { name: string; dir: string; session: string }
const blue: Who = { name: "blue (rishi)", dir: path.join(demo, "rishi"), session: `sim-rishi-${Date.now()}` }
const orange: Who = { name: "orange (friend)", dir: path.join(demo, "friend"), session: `sim-friend-${Date.now()}` }
const authFile = (w: Who) => path.join(w.dir, "src/auth.ts")

async function hook(w: Who, sub: string, tool: string, input: Record<string, unknown>) {
  const p = Bun.spawn(["bun", CLI, "hook", sub], {
    cwd: w.dir,
    stdin: new Response(JSON.stringify({ session_id: w.session, cwd: w.dir, tool_name: tool, tool_input: input })),
    stdout: "pipe",
  })
  const out = await new Response(p.stdout).text()
  return out ? JSON.parse(out) : null
}
const step = async (msg: string) => {
  console.log(`\n▶ ${msg}`)
  await Bun.sleep(PAUSE_MS)
}
const told = (w: Who, r: any) => {
  const text = r?.hookSpecificOutput?.additionalContext ?? r?.hookSpecificOutput?.permissionDecisionReason
  if (text) console.log(`  ${w.name} was told: ${text}`)
}

/** What Claude does for one Edit: ask Foreman (pre-tool), change the file if allowed, then post-tool. */
async function edit(w: Who, oldText: string, newText: string) {
  const input = { file_path: authFile(w), old_string: oldText }
  const pre = await hook(w, "pre-tool", "Edit", input)
  if (pre?.hookSpecificOutput?.permissionDecision === "deny") return told(w, pre), false
  const src = readFileSync(authFile(w), "utf8")
  if (!src.includes(oldText)) throw new Error(`${w.name}: text not found: ${oldText}`)
  writeFileSync(authFile(w), src.replace(oldText, newText))
  told(w, await hook(w, "post-tool", "Edit", input))
  return true
}
const commit = (w: Who, msg: string) => $`git -C ${w.dir} commit -qam ${msg}`.quiet().nothrow()

// ---------- fresh start: empty room, both worktrees on the first demo commit ----------
const cfg = JSON.parse(readFileSync(path.join(blue.dir, ".git/foreman.json"), "utf8"))
const api = (route: string, body: object) => fetch(`${cfg.url}${route}`, { method: "POST", body: JSON.stringify({ repoId: cfg.repoId, ...body }) }).then(r => r.json())
for (const agent of Object.values((await api("/api/status", {})).members ?? {})) await api("/api/release-all", { agent })
const base = (await $`git -C ${blue.dir} rev-list --max-parents=0 HEAD`.text()).trim()
for (const w of [blue, orange]) await $`git -C ${w.dir} reset -q --hard ${base}`.quiet()
console.log(`Room cleared, both worktrees reset to ${base.slice(0, 7)}. Open src/auth.ts in both windows.`)

await step("1. Both agents open auth.ts (cursors appear)")
await hook(blue, "pre-tool", "Read", { file_path: authFile(blue), offset: 3 })
await hook(orange, "pre-tool", "Read", { file_path: authFile(orange), offset: 9 })

await step("2. Blue edits validateToken → it locks blue, and the edit appears in the left window")
await edit(blue, "  return claims\n", "  if (claims.exp && claims.exp * 1000 < Date.now()) return null\n  return claims\n")

await step("3. Orange edits refreshSession in the same file → allowed (different function), locks orange")
await edit(orange, "  return { ...session, refreshedAt: Date.now() }", "  return { ...session, refreshedAt: Date.now(), ttlMs: 15 * 60_000 }")

await step("4. Orange tries validateToken → refused and queued behind blue (label shows ⏳)")
await edit(orange, "  const claims = JSON.parse(", "  const claims: { exp?: number; sub: string } = JSON.parse(")

await step("5. Orange works on getUser instead (it calls validateToken)")
await edit(orange, "  return db.user(claims.sub)", "  if (!claims) return null\n  return db.user(claims.sub)")

await step("6. Blue changes validateToken's parameters → orange is warned, getUser turns amber")
await edit(blue, "export function validateToken(token: string) {", "export function validateToken(token: string, now = Date.now()) {")
await edit(blue, "claims.exp * 1000 < Date.now()", "claims.exp * 1000 < now")

await step("7. Blue commits → blue's colour clears; validateToken is handed to orange with the commit")
await commit(blue, "validateToken: reject expired tokens, injectable clock")

await step("8. Orange's next step: Foreman merges blue's commit into orange's checkout by itself; the amber clears")
told(orange, await hook(orange, "post-tool", "Read", {}))

await step("9. Orange finishes validateToken on top of blue's version")
await edit(orange, "  const claims = JSON.parse(", "  const claims: { exp?: number; sub: string } = JSON.parse(")

await step("10. Orange commits → every lock is released, all colours go away")
await commit(orange, "auth: typed claims, session ttl, null-safe getUser")

const end = await api("/api/status", {})
console.log(`\nDone. Locks left: ${Object.keys(end.locks).length}. Caller warnings left: ${Object.keys(end.changes ?? {}).length}.`)
console.log("Both windows should now show plain code: no stripes, no labels, no amber.")

import { afterAll, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

const CLI = path.join(import.meta.dir, "foreman.ts")
const calls: { path: string; body: any }[] = []
let reply: Record<string, unknown> = {}
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const body = await req.json().catch(() => null)
    calls.push({ path: p, body })
    return Response.json(reply[p] ?? {})
  },
})
afterAll(() => stub.stop())
beforeEach(() => {
  calls.length = 0
  reply = {}
})

async function repo(origin?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "foreman-"))
  await $`git init -q -b main ${dir} && git -C ${dir} config user.name "Rishi K" && git -C ${dir} config user.email r@x && git -C ${dir} config commit.gpgsign false`.quiet()
  if (origin) await $`git -C ${dir} remote add origin ${origin}`.quiet()
  writeFileSync(path.join(dir, "auth.ts"), "export function validateToken(t: string) {\n  return t\n}\n")
  return dir
}

function run(args: string[], stdin: unknown, cwd: string, url = stub.url.href) {
  return Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdin: new Response(typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FOREMAN_URL: url, FOREMAN_REPO_ID: "r1" },
  })
}
const out = async (p: ReturnType<typeof run>) => ({ code: await p.exited, stdout: await new Response(p.stdout).text() })

const edit = (dir: string) => ({ session_id: "s1", cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, "auth.ts"), old_string: "  return t" } })

test("pre-tool fails open when the server is unreachable", async () => {
  const dir = await repo()
  const t0 = Date.now()
  const r = await out(run(["hook", "pre-tool"], edit(dir), dir, "http://127.0.0.1:9"))
  expect(r.code).toBe(0)
  expect(r.stdout).toBe("")
  expect(Date.now() - t0).toBeLessThan(3500)
})

test("pre-tool touches, claims the function and denies when blocked", async () => {
  const dir = await repo()
  const holder = { id: "claude:x", label: "claude@friend" }
  reply["/api/claim"] = { granted: [], blocked: [{ key: "auth.ts#validateToken", holder, position: 1 }] }
  const r = await out(run(["hook", "pre-tool"], edit(dir), dir))
  expect(r.code).toBe(0)
  expect(calls.map(c => c.path)).toEqual(["/api/touch", "/api/claim"])
  expect(calls[1].body).toMatchObject({ repoId: "r1", agent: { id: "claude:s1", label: "claude@rishi" }, keys: ["auth.ts#validateToken"] })
  expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
})

test("pre-tool allows silently when granted, and ignores non-file tools", async () => {
  const dir = await repo()
  reply["/api/claim"] = { granted: ["auth.ts#validateToken"], blocked: [] }
  expect((await out(run(["hook", "pre-tool"], edit(dir), dir))).stdout).toBe("")
  calls.length = 0
  await out(run(["hook", "pre-tool"], { session_id: "s1", cwd: dir, tool_name: "Bash", tool_input: { command: "ls" } }, dir))
  expect(calls).toEqual([])
})

test("post-tool delivers mailbox notices as context", async () => {
  const dir = await repo()
  reply["/api/notices"] = [{ kind: "heads-up", key: "auth.ts#validateToken", by: { id: "claude:x", label: "claude@friend" } }]
  const r = await out(run(["hook", "post-tool"], { session_id: "s1", cwd: dir, tool_name: "Read", tool_input: {} }, dir))
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("Heads-up: claude@friend locked validateToken")
})

test("post-commit keeps the lock when the push fails", async () => {
  const dir = await repo("/nonexistent/origin.git")
  await out(run(["hook", "pre-tool"], edit(dir), dir))
  calls.length = 0
  await $`git -C ${dir} add -A && git -C ${dir} commit -qm "add auth"`.quiet()
  const r = await out(run(["git", "post-commit"], "", dir))
  expect(r.code).toBe(0)
  expect(calls.find(c => c.path === "/api/release")).toBeUndefined()
})

test("post-commit pushes a hidden ref then releases the committed files with the commit", async () => {
  const bare = mkdtempSync(path.join(tmpdir(), "foreman-bare-"))
  await $`git init -q --bare ${bare}`.quiet()
  const dir = await repo(bare)
  await out(run(["hook", "pre-tool"], edit(dir), dir))
  calls.length = 0
  await $`git -C ${dir} add -A && git -C ${dir} commit -qm "add expiry check"`.quiet()
  const sha = (await $`git -C ${dir} rev-parse HEAD`.text()).trim()
  await out(run(["git", "post-commit"], "", dir))
  const release = calls.find(c => c.path === "/api/release")!
  expect(release.body).toMatchObject({ repoId: "r1", agent: { id: "claude:s1" }, files: ["auth.ts"], commit: { sha, summary: "add expiry check" } })
  expect((await $`git -C ${bare} rev-parse refs/foreman/${sha}`.text()).trim()).toBe(sha)
})

test("pre-commit refuses staged files locked by another agent", async () => {
  const dir = await repo()
  await out(run(["hook", "pre-tool"], edit(dir), dir))
  reply["/api/status"] = { locks: { "auth.ts#validateToken": { holder: { id: "claude:x", label: "claude@friend" } } } }
  await $`git -C ${dir} add -A`.quiet()
  const r = run(["git", "pre-commit"], "", dir)
  expect(await r.exited).toBe(1)
  expect(await new Response(r.stderr).text()).toContain("validateToken in auth.ts is locked by claude@friend")
})

test("pre-commit allows a commit that only touches functions nobody else holds, even in a shared file", async () => {
  const dir = await repo()
  writeFileSync(path.join(dir, "auth.ts"), "export function validateToken(t: string) {\n  return t\n}\n\nexport function refresh(id: string) {\n  return id\n}\n")
  await $`git -C ${dir} add -A && git -C ${dir} commit -qm base --no-verify`.quiet()
  await out(run(["hook", "pre-tool"], edit(dir), dir))
  reply["/api/status"] = { locks: { "auth.ts#refresh": { holder: { id: "claude:x", label: "claude@friend" } } } }
  writeFileSync(path.join(dir, "auth.ts"), "export function validateToken(t: string) {\n  return t.trim()\n}\n\nexport function refresh(id: string) {\n  return id\n}\n")
  await $`git -C ${dir} add -A`.quiet()
  expect(await run(["git", "pre-commit"], "", dir).exited).toBe(0)
})

test("post-tool spots a changed signature and reports the callers found in the repo", async () => {
  const dir = await repo()
  writeFileSync(path.join(dir, "login.ts"), 'import { validateToken } from "./auth"\nexport function login(t: string) {\n  return validateToken(t)\n}\n')
  await $`git -C ${dir} add -A && git -C ${dir} commit -qm base --no-verify`.quiet()
  await out(run(["hook", "pre-tool"], edit(dir), dir))
  writeFileSync(path.join(dir, "auth.ts"), "export function validateToken(t: string, now: number) {\n  return t\n}\n")
  calls.length = 0
  reply["/api/notices"] = []
  await out(run(["hook", "post-tool"], { ...edit(dir), tool_response: {} }, dir))
  const sig = calls.find(c => c.path === "/api/signature")
  expect(sig?.body).toMatchObject({ repoId: "r1", agent: { id: "claude:s1" }, key: "auth.ts#validateToken", callers: ["login.ts#login"] })
})

test("post-tool reports nothing when only a function body changed", async () => {
  const dir = await repo()
  await out(run(["hook", "pre-tool"], edit(dir), dir))
  writeFileSync(path.join(dir, "auth.ts"), "export function validateToken(t: string) {\n  return t.trim()\n}\n")
  calls.length = 0
  reply["/api/notices"] = []
  await out(run(["hook", "post-tool"], edit(dir), dir))
  expect(calls.find(c => c.path === "/api/signature")).toBeUndefined()
})

async function pair() {
  const bare = mkdtempSync(path.join(tmpdir(), "foreman-pair-"))
  await $`git init -q --bare -b main ${bare}`.quiet()
  const one = await repo(bare)
  await $`git -C ${one} add -A && git -C ${one} commit -qm base --no-verify && git -C ${one} push -q origin main`.quiet()
  const two = mkdtempSync(path.join(tmpdir(), "foreman-two-"))
  await $`git clone -q ${bare} ${two} && git -C ${two} config user.name Friend && git -C ${two} config user.email f@x && git -C ${two} config commit.gpgsign false`.quiet()
  return { one, two }
}
async function handoffCommit(one: string, content: string) {
  writeFileSync(path.join(one, "auth.ts"), content)
  await $`git -C ${one} commit -qam "add expiry check" --no-verify`.quiet()
  const sha = (await $`git -C ${one} rev-parse HEAD`.text()).trim()
  await $`git -C ${one} push -q origin HEAD:refs/foreman/${sha}`.quiet()
  return sha
}

test("post-tool auto-merges a handed-off commit into the agent's checkout and says so", async () => {
  const { one, two } = await pair()
  const sha = await handoffCommit(one, "export function validateToken(t: string) {\n  return t || null\n}\n")
  reply["/api/notices"] = [{ kind: "granted", key: "auth.ts#validateToken", from: { id: "claude:a", label: "claude@rishi" }, commit: { sha, summary: "add expiry check", stat: "" } }]
  const r = await out(run(["hook", "post-tool"], { session_id: "s2", cwd: two, tool_name: "Read", tool_input: {} }, two))
  expect((await $`git -C ${two} merge-base --is-ancestor ${sha} HEAD`.nothrow().quiet()).exitCode).toBe(0)
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(`Foreman already merged ${sha.slice(0, 7)} into your checkout`)
})

test("a conflicting auto-merge is cancelled and the agent is told to merge by hand", async () => {
  const { one, two } = await pair()
  const sha = await handoffCommit(one, "export function validateToken(t: string) {\n  return t || null\n}\n")
  writeFileSync(path.join(two, "auth.ts"), "export function validateToken(t: string) {\n  return t.trim()\n}\n")
  await $`git -C ${two} commit -qam mine --no-verify`.quiet()
  reply["/api/notices"] = [{ kind: "granted", key: "auth.ts#validateToken", from: { id: "claude:a", label: "claude@rishi" }, commit: { sha, summary: "add expiry check", stat: "" } }]
  const r = await out(run(["hook", "post-tool"], { session_id: "s2", cwd: two, tool_name: "Read", tool_input: {} }, two))
  expect(existsSync(path.join(two, ".git/MERGE_HEAD"))).toBe(false)
  expect((await $`git -C ${two} status --porcelain`.text()).trim()).toBe("")
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("automatic merge failed")
})

test("post-merge reports the commits that just came in", async () => {
  const { one, two } = await pair()
  const sha = await handoffCommit(one, "export function validateToken(t: string) {\n  return t || null\n}\n")
  await $`git -C ${two} fetch -q origin refs/foreman/${sha} && git -C ${two} merge -q --no-edit ${sha}`.quiet()
  calls.length = 0
  await out(run(["git", "post-merge"], "", two))
  expect(calls.find(c => c.path === "/api/pulled")?.body).toMatchObject({ repoId: "r1", head: sha, shas: [sha] })
})

test("auto-merge keeps the agent's uncommitted work in other functions of the same file", async () => {
  const { one, two } = await pair()
  const base = "export function validateToken(t: string) {\n  return t\n}\n\nexport function refresh(id: string) {\n  return id\n}\n"
  writeFileSync(path.join(one, "auth.ts"), base)
  await $`git -C ${one} commit -qam two-fns --no-verify && git -C ${one} push -q origin main && git -C ${two} pull -q --no-rebase origin main`.quiet()
  const sha = await handoffCommit(one, base.replace("  return t\n", "  return t || null\n"))
  writeFileSync(path.join(two, "auth.ts"), base.replace("  return id\n", "  return id.trim()\n"))
  reply["/api/notices"] = [{ kind: "granted", key: "auth.ts#validateToken", from: { id: "claude:a", label: "claude@rishi" }, commit: { sha, summary: "x", stat: "" } }]
  const r = await out(run(["hook", "post-tool"], { session_id: "s2", cwd: two, tool_name: "Read", tool_input: {} }, two))
  const now = await Bun.file(path.join(two, "auth.ts")).text()
  expect(now).toContain("return t || null")
  expect(now).toContain("return id.trim()")
  expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("Foreman already merged")
})

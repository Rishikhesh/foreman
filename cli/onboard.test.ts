import { afterAll, beforeEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import { COLORS, mergeHooks, removeHooks } from "./onboard.js"

const CLI = path.join(import.meta.dir, "foreman.ts")

test("mergeHooks adds every Foreman hook once and keeps the user's own hooks", () => {
  const mine = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }] }, model: "opus" }
  const once = mergeHooks(mine, "/x/foreman.ts")
  const twice = mergeHooks(once, "/x/foreman.ts")
  expect(twice).toEqual(once)
  expect(once.model).toBe("opus")
  expect(once.hooks.PreToolUse).toContainEqual({ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] })
  expect(once.hooks.PreToolUse).toContainEqual({ matcher: "Edit|Write|MultiEdit|NotebookEdit|Read", hooks: [{ type: "command", command: "bun /x/foreman.ts hook pre-tool" }] })
  expect(once.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "bun /x/foreman.ts hook stop", timeout: 600 })
  for (const e of ["PostToolUse", "UserPromptSubmit", "SessionEnd"]) expect(once.hooks[e].length).toBe(1)
})

test("removeHooks drops only Foreman's entries", () => {
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, "/x/foreman.ts")
  expect(removeHooks(merged)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } })
})

// A stand-in Foreman server for the rooms API.
const calls: { path: string; body: any; auth: string | null }[] = []
let reply: Record<string, { status?: number; body: unknown }> = {}
let meCalls = 0
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    if (p === "/api/health") return new Response("ok")
    const body = await req.json().catch(() => null)
    calls.push({ path: p, body, auth: req.headers.get("authorization") })
    if (reply[p]) return typeof reply[p].body === "string" ? new Response(reply[p].body as string, { status: reply[p].status }) : Response.json(reply[p].body, { status: reply[p].status ?? 200 })
    if (p === "/api/rooms/create") return Response.json({ room: `${body.repoId}-ABCD2345`, code: "ABCD2345", login: "rishi" })
    if (p === "/api/rooms/join") return Response.json({ ok: true, status: "pending", room: `${body.repoId}-ABCD2345` })
    if (p === "/api/me") return Response.json({ login: "pal", role: "member", color: "green", status: ++meCalls < 3 ? "pending" : "allowed" })
    return Response.json({ ok: true, granted: [], blocked: [] })
  },
})
afterAll(() => stub.stop())
beforeEach(() => {
  calls.length = 0
  reply = {}
  meCalls = 0
})
const URL_ = stub.url.href.replace(/\/$/, "")

async function clone(origin: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "foreman-onb-"))
  await $`git init -q -b main ${dir} && git -C ${dir} remote add origin ${origin} && git -C ${dir} config user.name "Rishi K"`.quiet()
  return dir
}
const BUN_DIR = path.dirname(process.execPath)
const run = async (args: string[], cwd: string, env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FOREMAN_URL: "", FOREMAN_POLL_MS: "20", FOREMAN_GITHUB_TOKEN: "gh-test", HOME: mkdtempSync(path.join(tmpdir(), "foreman-h-")), ...env },
  })
  return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

test("init creates the room with your GitHub sign-in, keeps only your copy of the key, installs hooks, prints the code", async () => {
  const host = await clone("git@github.com:Org/Repo.git")
  const r = await run(["init", "--url", URL_, "--color", "blue"], host)
  expect(r.code).toBe(0)
  expect(r.stdout).toContain("Room code: ABCD-2345")
  const create = calls.find(c => c.path === "/api/rooms/create")!
  expect(create.body).toMatchObject({ githubToken: "gh-test", color: "blue" })
  expect(create.body.repoId).toMatch(/^[0-9a-f]{16}$/)
  const cfg = JSON.parse(readFileSync(path.join(host, ".git/foreman.json"), "utf8"))
  expect(cfg).toMatchObject({ url: URL_, room: `${create.body.repoId}-ABCD2345`, code: "ABCD2345", login: "rishi", color: "blue" })
  expect(sha(cfg.key)).toBe(create.body.keyHash)
  expect(JSON.stringify(create.body)).not.toContain(cfg.key)
  const settings = JSON.parse(readFileSync(path.join(host, ".claude/settings.local.json"), "utf8"))
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`bun ${CLI} hook pre-tool`)
  for (const h of ["post-commit", "pre-commit", "post-merge"]) {
    const f = path.join(host, ".git/hooks", h)
    expect(readFileSync(f, "utf8")).toContain(`${CLI} git ${h}`)
    expect(statSync(f).mode & 0o111).toBeTruthy()
  }
})

test("every hook call carries the room key", async () => {
  const host = await clone("git@github.com:org/keyed.git")
  await run(["init", "--url", URL_, "--color", "blue"], host)
  const key = JSON.parse(readFileSync(path.join(host, ".git/foreman.json"), "utf8")).key
  calls.length = 0
  const p = Bun.spawn(["bun", CLI, "hook", "post-tool"], { cwd: host, stdin: new Response(JSON.stringify({ session_id: "s1", cwd: host, tool_name: "Read", tool_input: {} })), stdout: "pipe", env: { ...process.env, FOREMAN_URL: "" } })
  await p.exited
  expect(calls.find(c => c.path === "/api/notices")!.auth).toBe(`Bearer ${key}`)
})

test("join asks with the code, waits until the host allows, then you're in (and the extension is installed)", async () => {
  const friend = await clone("https://github.com/org/repo")
  const home = mkdtempSync(path.join(tmpdir(), "foreman-h-"))
  const j = await run(["join", "abcd-2345", "--url", URL_, "--color", "green"], friend, { HOME: home })
  expect(j.code).toBe(0)
  const req = calls.find(c => c.path === "/api/rooms/join")!
  expect(req.body).toMatchObject({ code: "ABCD2345", color: "green", githubToken: "gh-test" })
  expect(j.stdout).toContain("Asked to join. Waiting for the host to let you in")
  expect(j.stdout).toContain("You're in")
  expect(calls.filter(c => c.path === "/api/me").length).toBe(3)
  const cfg = JSON.parse(readFileSync(path.join(friend, ".git/foreman.json"), "utf8"))
  expect(sha(cfg.key)).toBe(req.body.keyHash)
  expect(cfg.login).toBe("pal")
  expect(realpathSync(path.join(home, ".vscode/extensions/foreman.foreman-dev"))).toBe(realpathSync(path.join(import.meta.dir, "..", "vscode-ext")))
})

test("join explains a taken colour, an unknown code, a different repo, and a bad code", async () => {
  const friend = await clone("git@github.com:org/repo.git")
  reply["/api/rooms/join"] = { body: { ok: false, reason: "colour taken", taken: ["blue"] } }
  const taken = await run(["join", "ABCD2345", "--url", URL_, "--color", "blue"], friend)
  expect(taken.code).toBe(1)
  expect(taken.stderr).toContain(`Colour blue is taken. Free: ${COLORS.filter(c => c !== "blue").join(", ")}`)
  reply["/api/rooms/join"] = { status: 404, body: "No room with code ZZZZ-ZZZZ. Check the code with whoever sent it." }
  expect((await run(["join", "ZZZZ-ZZZZ", "--url", URL_, "--color", "green"], friend)).stderr).toContain("No room with code ZZZZ-ZZZZ")
  reply["/api/rooms/join"] = { status: 409, body: "This clone is a different repo than the room you're joining." }
  expect((await run(["join", "ABCD2345", "--url", URL_, "--color", "green"], friend)).stderr).toContain("different repo")
  expect((await run(["join", "hello", "--url", URL_], friend)).stderr).toContain("isn't a room code")
})

test("without a GitHub sign-in, init says how to get one", async () => {
  const host = await clone("git@github.com:org/nogh.git")
  const r = await run(["init", "--url", URL_, "--color", "blue"], host, { FOREMAN_GITHUB_TOKEN: "", PATH: `/usr/bin:/bin:${BUN_DIR}` })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("Sign in with GitHub first")
})

test("--dev <name> uses a demo identity", async () => {
  const host = await clone("git@github.com:org/dev.git")
  await run(["init", "--url", URL_, "--color", "blue", "--dev", "alice"], host, { FOREMAN_GITHUB_TOKEN: "" })
  expect(calls.find(c => c.path === "/api/rooms/create")!.body.githubToken).toBe("dev:alice")
})

test("init refuses a folder that is not a git repo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foreman-nogit-"))
  const r = await run(["init", "--url", URL_], dir)
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("Not a git repo")
})

test("invite repeats the room code; allow lets someone in with the host's key", async () => {
  const host = await clone("git@github.com:org/invite.git")
  await run(["init", "--url", URL_, "--color", "teal"], host)
  expect((await run(["invite"], host)).stdout).toContain("Room code: ABCD-2345")
  calls.length = 0
  const a = await run(["allow", "pal"], host)
  expect(a.code).toBe(0)
  const key = JSON.parse(readFileSync(path.join(host, ".git/foreman.json"), "utf8")).key
  expect(calls[0]).toMatchObject({ path: "/api/rooms/allow", body: { login: "pal" }, auth: `Bearer ${key}` })
})

test("leave removes Foreman's hooks and config but keeps the user's own hooks", async () => {
  const host = await clone("git@github.com:org/leave.git")
  await run(["init", "--url", URL_, "--color", "green"], host)
  const settingsFile = path.join(host, ".claude/settings.local.json")
  const s = JSON.parse(readFileSync(settingsFile, "utf8"))
  s.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] })
  await Bun.write(settingsFile, JSON.stringify(s))
  const r = await run(["leave"], host)
  expect(r.code).toBe(0)
  const after = JSON.parse(readFileSync(settingsFile, "utf8"))
  expect(after.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }])
  expect(after.hooks.Stop).toBeUndefined()
  expect(existsSync(path.join(host, ".git/hooks/post-commit"))).toBe(false)
  expect(existsSync(path.join(host, ".git/foreman.json"))).toBe(false)
})

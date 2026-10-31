import { afterAll, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import { COLORS, decodeInvite, encodeInvite, mergeHooks, removeHooks } from "./onboard.js"

const CLI = path.join(import.meta.dir, "foreman.ts")

test("invite codes round-trip and reject garbage", () => {
  const inv = { url: "http://10.0.0.5:7300", repoId: "abcd1234abcd1234" }
  const code = encodeInvite(inv)
  expect(code.startsWith("fm_")).toBe(true)
  expect(decodeInvite(code)).toEqual(inv)
  expect(() => decodeInvite("fm_nope")).toThrow("invalid invite")
})

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

const calls: { path: string; body: any }[] = []
let reply: Record<string, unknown> = {}
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname
    if (p === "/api/health") return new Response("ok")
    calls.push({ path: p, body: await req.json().catch(() => null) })
    return Response.json(reply[p] ?? { ok: true })
  },
})
afterAll(() => stub.stop())
beforeEach(() => {
  calls.length = 0
  reply = {}
})

async function clone(origin: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "foreman-onb-"))
  await $`git init -q -b main ${dir} && git -C ${dir} remote add origin ${origin} && git -C ${dir} config user.name "Rishi K"`.quiet()
  return dir
}
const run = async (args: string[], cwd: string) => {
  const p = Bun.spawn(["bun", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, FOREMAN_URL: "" } })
  return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() }
}

test("init sets up the room, installs hooks, and prints an invite that join accepts from an https clone", async () => {
  const host = await clone("git@github.com:Org/Repo.git")
  const r = await run(["init", "--url", stub.url.href.replace(/\/$/, ""), "--color", "blue"], host)
  expect(r.code).toBe(0)
  expect(calls[0]).toMatchObject({ path: "/api/join", body: { person: { name: "rishi", color: "blue" } } })
  const settings = JSON.parse(readFileSync(path.join(host, ".claude/settings.local.json"), "utf8"))
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`bun ${CLI} hook pre-tool`)
  for (const h of ["post-commit", "pre-commit", "post-merge"]) {
    const f = path.join(host, ".git/hooks", h)
    expect(readFileSync(f, "utf8")).toContain(`${CLI} git ${h}`)
    expect(statSync(f).mode & 0o111).toBeTruthy()
  }
  const code = r.stdout.match(/foreman join (fm_\S+)/)![1]
  const repoId = decodeInvite(code).repoId

  const friend = await clone("https://github.com/org/repo")
  calls.length = 0
  const j = await run(["join", code, "--name", "friend", "--color", "orange"], friend)
  expect(j.code).toBe(0)
  expect(calls[0]).toMatchObject({ path: "/api/join", body: { repoId, person: { name: "friend", color: "orange" } } })
  expect(existsSync(path.join(friend, ".git/hooks/post-commit"))).toBe(true)
})

test("join refuses a clone of a different repo", async () => {
  const code = encodeInvite({ url: stub.url.href.replace(/\/$/, ""), repoId: "0000000000000000" })
  const other = await clone("git@github.com:org/other.git")
  const j = await run(["join", code], other)
  expect(j.code).toBe(1)
  expect(j.stderr).toContain("This clone is a different repo than the room you're joining")
  expect(calls).toEqual([])
})

test("join with a taken colour says which colours are free", async () => {
  const host = await clone("git@github.com:org/repo.git")
  const code = (await run(["init", "--url", stub.url.href.replace(/\/$/, ""), "--color", "blue"], host)).stdout.match(/(fm_\S+)/)![1]
  const friend = await clone("git@github.com:org/repo.git")
  reply["/api/join"] = { ok: false, taken: ["blue"] }
  const j = await run(["join", code, "--name", "friend", "--color", "blue"], friend)
  expect(j.code).toBe(1)
  expect(j.stderr).toContain(`Colour blue is taken. Free: ${COLORS.filter(c => c !== "blue").join(", ")}`)
})

test("init refuses a folder that is not a git repo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foreman-nogit-"))
  const r = await run(["init", "--url", stub.url.href], dir)
  expect(r.code).toBe(1)
  expect(r.stderr).toContain("Not a git repo")
})

test("leave removes Foreman's hooks and config but keeps the user's own hooks", async () => {
  const host = await clone("git@github.com:org/leave.git")
  await run(["init", "--url", stub.url.href.replace(/\/$/, ""), "--color", "green"], host)
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

test("removeHooks drops only Foreman's entries", () => {
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, "/x/foreman.ts")
  expect(removeHooks(merged)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } })
})

test("invite prints a join command for this room, optionally with a public server address", async () => {
  const host = await clone("git@github.com:org/invite.git")
  await run(["init", "--url", stub.url.href.replace(/\/$/, ""), "--color", "teal"], host)
  const pub = await run(["invite", "--url", "https://abc.trycloudflare.com"], host)
  expect(pub.code).toBe(0)
  const code = pub.stdout.match(/foreman join (fm_\S+)/)![1]
  expect(decodeInvite(code).url).toBe("https://abc.trycloudflare.com")
  const same = await run(["invite"], host)
  expect(decodeInvite(same.stdout.match(/(fm_\S+)/)![1]).url).toBe(stub.url.href.replace(/\/$/, ""))
})

import { afterAll, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { startServer } from "./server.js"

// Integration: needs `bun run dev` (Terse on :7111) running.
const users: Record<string, { login: string; id: number }> = { "gh-rishi": { login: "rishi", id: 1 }, "gh-pal": { login: "pal", id: 2 }, "gh-eve": { login: "eve", id: 3 } }
const server = startServer({ port: 0, github: async token => users[token] ?? null })
afterAll(() => server.stop())

const repoId = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
const newKey = () => randomBytes(32).toString("hex")
const hash = (k: string) => createHash("sha256").update(k).digest("hex")
const call = (path: string, body: unknown, key?: string) =>
  fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body), headers: key ? { authorization: `Bearer ${key}` } : {} })
const json = async (r: Promise<Response> | Response) => (await r).json()

test("full flow: host creates, friend asks with the code, waits, host allows, friend's key now works", async () => {
  const hostKey = newKey()
  const created = await json(call("/api/rooms/create", { githubToken: "gh-rishi", repoId, color: "blue", keyHash: hash(hostKey) }))
  expect(created.code).toMatch(/^[A-Z0-9]{8}$/)
  expect(created.room).toBe(`${repoId}-${created.code}`)
  expect(created.login).toBe("rishi")
  const room = created.room

  expect(await json(call("/api/rooms/peek", { code: created.code }))).toEqual({ host: "rishi", taken: ["blue"], repoId })

  const palKey = newKey()
  const joined = await json(call("/api/rooms/join", { githubToken: "gh-pal", code: created.code.toLowerCase(), repoId, color: "green", keyHash: hash(palKey) }))
  expect(joined).toEqual({ ok: true, status: "pending", room })

  expect(await json(call("/api/me", { repoId: room }, palKey))).toEqual({ login: "pal", role: "member", status: "pending", color: "green" })
  expect((await call("/api/status", { repoId: room }, palKey)).status).toBe(403)

  expect((await call("/api/rooms/allow", { repoId: room, login: "pal" }, palKey)).status).toBe(403)
  expect(await json(call("/api/rooms/allow", { repoId: room, login: "pal" }, hostKey))).toEqual({ ok: true })
  expect((await call("/api/status", { repoId: room }, palKey)).status).toBe(200)
})

test("no key, a wrong key, or a key for another room gets 401", async () => {
  const hostKey = newKey()
  const { room } = await json(call("/api/rooms/create", { githubToken: "gh-rishi", repoId, color: "blue", keyHash: hash(hostKey) }))
  const other = await json(call("/api/rooms/create", { githubToken: "gh-eve", repoId, color: "pink", keyHash: hash(newKey()) }))
  expect((await call("/api/status", { repoId: room })).status).toBe(401)
  expect((await call("/api/status", { repoId: room }, newKey())).status).toBe(401)
  expect((await call("/api/status", { repoId: other.room }, hostKey)).status).toBe(401)
  const ws = new WebSocket(new URL(`/live?repo=${room}`, server.url.href.replace("http", "ws")))
  const closed = await new Promise<string>(res => ((ws.onerror = () => res("refused")), (ws.onopen = () => res("opened"))))
  expect(closed).toBe("refused")
})

test("the server names agents from the key's GitHub identity, so nobody can pose as someone else", async () => {
  const hostKey = newKey()
  const { room } = await json(call("/api/rooms/create", { githubToken: "gh-rishi", repoId, color: "blue", keyHash: hash(hostKey) }))
  await call("/api/claim", { repoId: room, agent: { id: "claude:s1", label: "claude@pal", color: "green" }, keys: ["a.ts#f"] }, hostKey)
  const s = await json(call("/api/status", { repoId: room }, hostKey))
  expect(s.locks["a.ts#f"].holder).toEqual({ id: "claude:s1", label: "claude@rishi", color: "blue" })
})

test("bad GitHub token, unknown code, or a different repo are refused with a clear reason", async () => {
  expect((await call("/api/rooms/create", { githubToken: "forged", repoId, color: "blue", keyHash: "x" })).status).toBe(401)
  const { code } = await json(call("/api/rooms/create", { githubToken: "gh-rishi", repoId, color: "blue", keyHash: hash(newKey()) }))
  const unknown = await call("/api/rooms/join", { githubToken: "gh-pal", code: "ZZZZZZZZ", repoId, color: "green", keyHash: "x" })
  expect(unknown.status).toBe(404)
  expect(await unknown.text()).toContain("No room with code ZZZZ-ZZZZ")
  const wrongRepo = await call("/api/rooms/join", { githubToken: "gh-pal", code, repoId: "0000000000000000", color: "green", keyHash: "x" })
  expect(wrongRepo.status).toBe(409)
})

test("the host can remove someone, and their key stops working", async () => {
  const hostKey = newKey()
  const palKey = newKey()
  const { room, code } = await json(call("/api/rooms/create", { githubToken: "gh-rishi", repoId, color: "blue", keyHash: hash(hostKey) }))
  await call("/api/rooms/join", { githubToken: "gh-pal", code, repoId, color: "green", keyHash: hash(palKey) })
  await call("/api/rooms/allow", { repoId: room, login: "pal" }, hostKey)
  expect((await call("/api/status", { repoId: room }, palKey)).status).toBe(200)
  expect(await json(call("/api/rooms/remove", { repoId: room, login: "pal" }, hostKey))).toEqual({ ok: true })
  expect((await call("/api/status", { repoId: room }, palKey)).status).toBe(401)
})

test("demo identities (dev:<name>) only work from this laptop, never through the tunnel", async () => {
  const dev = startServer({ port: 0 })
  const body = { githubToken: "dev:alice", repoId, color: "teal", keyHash: hash(newKey()) }
  expect((await fetch(new URL("/api/rooms/create", dev.url), { method: "POST", body: JSON.stringify(body) })).status).toBe(200)
  const viaTunnel = await fetch(new URL("/api/rooms/create", dev.url), { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": "203.0.113.9" } })
  expect(viaTunnel.status).toBe(401)
  dev.stop()
})

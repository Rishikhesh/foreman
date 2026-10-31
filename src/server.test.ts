import { afterAll, expect, test } from "bun:test"
import { startServer } from "./server.js"
import type { FEvent } from "./core/types.js"

// Integration: needs `bun run dev` (Terse on :7111) running.
const seen: FEvent[] = []
const server = startServer({ port: 0, onEvents: async (_repo, events) => void seen.push(...events) })
afterAll(() => server.stop())

const repoId = `test-${crypto.randomUUID().slice(0, 8)}`
const A = { id: "claude:a", label: "claude@rishi" }
const B = { id: "claude:b", label: "claude@friend" }
const V = "src/auth.ts#validateToken"
const post = async (path: string, body: unknown) => {
  const res = await fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body) })
  expect(res.status).toBe(200)
  return res.json()
}

test("two agents: heads-up, block, commit hand-off, mailbox delivery", async () => {
  await post("/api/touch", { repoId, agent: B, file: "src/auth.ts", line: 3, mode: "read" })
  expect((await post("/api/claim", { repoId, agent: A, keys: [V], task: "add expiry" })).granted).toEqual([V])
  expect(await post("/api/notices", { repoId, agentId: B.id })).toEqual([{ kind: "heads-up", key: V, by: A }])

  const blocked = await post("/api/claim", { repoId, agent: B, keys: [V] })
  expect(blocked.blocked[0]).toMatchObject({ key: V, position: 1, holder: { id: A.id } })
  expect((await post("/api/waiting", { repoId, agentId: B.id })).waiting).toBe(true)

  const commit = { sha: "abc123", summary: "add expiry check", stat: "1 file" }
  expect((await post("/api/release", { repoId, agent: A, files: ["src/auth.ts"], commit })).released).toEqual([V])
  expect(await post("/api/notices", { repoId, agentId: B.id })).toEqual([{ kind: "granted", key: V, from: A, commit }])
  expect((await post("/api/waiting", { repoId, agentId: B.id })).waiting).toBe(false)

  const status = await post("/api/status", { repoId })
  expect(status.locks[V].holder.id).toBe(B.id)
  expect(seen.map(e => e.type)).toEqual(["claimed", "blocked", "released", "granted"])
})

test("release-all frees everything the agent holds", async () => {
  await post("/api/claim", { repoId, agent: A, keys: ["src/x.ts#f"] })
  expect((await post("/api/release-all", { repoId, agent: A })).released).toEqual(["src/x.ts#f"])
})

test("unknown route is 404 and bad JSON is 400", async () => {
  expect((await fetch(new URL("/api/nope", server.url), { method: "POST", body: "{}" })).status).toBe(404)
  expect((await fetch(new URL("/api/claim", server.url), { method: "POST", body: "not json" })).status).toBe(400)
  expect(await (await fetch(new URL("/api/health", server.url))).text()).toBe("ok")
})

test("join adds people to the room and refuses a taken colour", async () => {
  const room = `test-${crypto.randomUUID().slice(0, 8)}`
  expect(await post("/api/join", { repoId: room, person: { name: "rishi", color: "blue" } })).toEqual({ ok: true })
  expect(await post("/api/join", { repoId: room, person: { name: "friend", color: "blue" } })).toEqual({ ok: false, taken: ["blue"] })
  expect((await post("/api/status", { repoId: room })).people.rishi.color).toBe("blue")
})

test("a slow Relay never delays the agents: events are posted in the background, in order", async () => {
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const slow = startServer({ port: 0, onEvents: async (_r, events) => { await gate; order.push(...events.map(e => e.type)) } })
  const room = `test-${crypto.randomUUID().slice(0, 8)}`
  const t0 = Date.now()
  for (const keys of [["a.ts#f"], ["a.ts#g"]])
    await fetch(new URL("/api/claim", slow.url), { method: "POST", body: JSON.stringify({ repoId: room, agent: A, keys }) })
  expect(Date.now() - t0).toBeLessThan(2000)
  expect(order).toEqual([])
  release()
  await Bun.sleep(50)
  expect(order).toEqual(["claimed", "claimed"])
  slow.stop()
})

test("grant gives a live socket that streams the room state; revoke frees a lock", async () => {
  const room = `test-${crypto.randomUUID().slice(0, 8)}`
  await post("/api/claim", { repoId: room, agent: A, keys: [V] })
  const { websocketUrl } = await (await fetch(new URL(`/grant?repo=${room}`, server.url))).json()
  const ws = new WebSocket(websocketUrl)
  const first = await new Promise<any>((res, rej) => {
    ws.onmessage = e => res(JSON.parse(String(e.data)))
    ws.onerror = rej
  })
  expect(first.type).toBe("state")
  expect(first.state.state.locks[V].holder.id).toBe(A.id)
  const update = new Promise<any>(res => (ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.type === "state_update") res(m) }))
  expect(await post("/api/revoke", { repoId: room, key: V })).toEqual({ revoked: true })
  expect((await update).changes.state.locks).toEqual({})
  ws.close()
})

test("signature route warns caller holders", async () => {
  const room = `test-${crypto.randomUUID().slice(0, 8)}`
  await post("/api/claim", { repoId: room, agent: B, keys: ["src/login.ts#login"] })
  await post("/api/signature", { repoId: room, agent: A, key: V, callers: ["src/login.ts#login"] })
  expect(await post("/api/notices", { repoId: room, agentId: B.id })).toEqual([{ kind: "signature", key: V, by: A, callers: ["src/login.ts#login"] }])
})

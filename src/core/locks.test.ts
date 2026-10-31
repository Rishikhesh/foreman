import { expect, test } from "bun:test"
import { claim, emptyState, expire, isWaiting, joinRoom, releaseAll, releaseFiles, revoke, takeNotices, touch, TTL_MS } from "./locks.js"
import type { AgentRef } from "./types.js"

const A: AgentRef = { id: "claude:a", label: "claude@rishi" }
const B: AgentRef = { id: "claude:b", label: "claude@friend" }
const C: AgentRef = { id: "claude:c", label: "claude@third" }
const V = "src/auth.ts#validateToken"
const R = "src/auth.ts#refreshSession"
const commit = { sha: "abc123", summary: "add expiry check", stat: "1 file" }

test("claim grants a free function", () => {
  const r = claim(emptyState(), A, [V], 1)
  expect(r.value.granted).toEqual([V])
  expect(r.state.locks[V].holder.id).toBe("claude:a")
  expect(r.events.map(e => e.type)).toEqual(["claimed"])
})

test("claim is idempotent for the holder and refreshes touched", () => {
  const s = claim(emptyState(), A, [V], 1).state
  const r = claim(s, A, [V], 5)
  expect(r.value.granted).toEqual([V])
  expect(r.state.locks[V].touched).toBe(5)
  expect(r.state.queues[V] ?? []).toEqual([])
  expect(r.events).toEqual([])
})

test("different functions in the same file never block each other", () => {
  const s = claim(emptyState(), A, [V], 1).state
  const r = claim(s, B, [R], 2)
  expect(r.value.granted).toEqual([R])
  expect(r.value.blocked).toEqual([])
})

test("same function blocks and queues the other agent once", () => {
  let s = claim(emptyState(), A, [V], 1, "add expiry").state
  const r1 = claim(s, B, [V], 2)
  expect(r1.value.blocked).toEqual([{ key: V, holder: A, task: "add expiry", position: 1 }])
  const r2 = claim(r1.state, B, [V], 3)
  expect(r2.value.blocked[0].position).toBe(1)
  expect(r2.state.queues[V].length).toBe(1)
  expect(claim(r2.state, C, [V], 4).value.blocked[0].position).toBe(2)
})

test("claim sends a heads-up only to agents that have seen the file", () => {
  let s = touch(emptyState(), B, "src/auth.ts", 3, "read", 1).state
  s = touch(s, C, "src/other.ts", 1, "read", 1).state
  s = claim(s, A, [V], 2).state
  expect(s.outbox[B.id]).toEqual([{ kind: "heads-up", key: V, by: A }])
  expect(s.outbox[C.id] ?? []).toEqual([])
  expect(s.outbox[A.id] ?? []).toEqual([])
})

test("releaseFiles hands each function in the committed files to the head waiter with the commit", () => {
  let s = claim(emptyState(), A, [V, R], 1).state
  s = claim(s, B, [V], 2).state
  const r = releaseFiles(s, A, ["src/auth.ts"], 3, commit)
  expect(r.value.released.sort()).toEqual([R, V].sort())
  expect(r.state.locks[V].holder.id).toBe("claude:b")
  expect(r.state.locks[R]).toBeUndefined()
  expect(r.state.outbox[B.id]).toContainEqual({ kind: "granted", key: V, from: A, commit })
  expect(r.events).toContainEqual({ type: "granted", agent: A, key: V, to: B, sha: "abc123" })
})

test("releaseFiles ignores files the agent does not hold", () => {
  const s = claim(emptyState(), A, [V], 1).state
  const r = releaseFiles(s, B, ["src/auth.ts", "README.md"], 2, commit)
  expect(r.value.released).toEqual([])
  expect(r.state.locks[V].holder.id).toBe("claude:a")
  expect(r.events).toEqual([])
})

test("releaseAll marks the handoff uncommitted and removes the agent from queues", () => {
  let s = claim(emptyState(), A, [V], 1).state
  s = claim(s, B, [V], 2).state
  s = claim(s, C, [V], 3).state
  s = releaseAll(s, B, 4).state
  const r = releaseAll(s, A, 5)
  expect(r.state.locks[V].holder.id).toBe("claude:c")
  expect(r.state.outbox[C.id]).toContainEqual({ kind: "granted", key: V, from: A, uncommitted: true })
  expect(r.state.members[A.id]).toBeUndefined()
})

test("expire releases stale locks and grants the next waiter", () => {
  let s = claim(emptyState(), A, [V], 0).state
  s = claim(s, B, [V], 1).state
  const r = expire(s, TTL_MS, TTL_MS)
  expect(r.value.expired).toEqual([V])
  expect(r.state.outbox[A.id]).toContainEqual({ kind: "expired", key: V })
  expect(r.state.locks[V].holder.id).toBe("claude:b")
})

test("takeNotices returns and clears the mailbox; isWaiting tracks queues", () => {
  let s = claim(emptyState(), A, [V], 1).state
  s = claim(s, B, [V], 2).state
  expect(isWaiting(s, B.id)).toBe(true)
  s = releaseFiles(s, A, ["src/auth.ts"], 3, commit).state
  expect(isWaiting(s, B.id)).toBe(false)
  const r = takeNotices(s, B.id)
  expect(r.value.length).toBe(1)
  expect(r.state.outbox[B.id]).toEqual([])
})

test("touch records the cursor, membership and seen files", () => {
  const r = touch(emptyState(), A, "src/auth.ts", 6, "edit", 9)
  expect(r.state.cursors[A.id]).toEqual({ file: "src/auth.ts", line: 6, mode: "edit", at: 9 })
  expect(r.state.members[A.id]).toEqual(A)
  expect(r.state.seen[A.id]).toEqual(["src/auth.ts"])
})

test("does not mutate its input", () => {
  const s = Object.freeze(emptyState())
  expect(() => claim(s, A, [V], 1)).not.toThrow()
  expect(s.locks).toEqual({})
})

test("joinRoom adds a person and refuses a colour another person holds", () => {
  let r = joinRoom(emptyState(), { name: "rishi", color: "blue" })
  expect(r.value).toEqual({ ok: true })
  expect(r.state.people).toEqual({ rishi: { name: "rishi", color: "blue" } })
  expect(joinRoom(r.state, { name: "rishi", color: "blue" }).value).toEqual({ ok: true })
  const taken = joinRoom(r.state, { name: "friend", color: "blue" })
  expect(taken.value).toEqual({ ok: false, taken: ["blue"] })
  expect(taken.state.people.friend).toBeUndefined()
  r = joinRoom(r.state, { name: "friend", color: "orange" })
  expect(Object.keys(r.state.people)).toEqual(["rishi", "friend"])
  expect(r.events).toEqual([{ type: "joined", agent: { id: "person:friend", label: "friend", color: "orange" } }])
})

test("any activity by the holder keeps all its locks alive; only an idle agent loses them", () => {
  let s = claim(emptyState(), A, [V], 0).state
  s = claim(s, B, [V], 1).state
  // A works elsewhere for longer than the idle limit, touching other files
  for (let t = 60_000; t <= TTL_MS + 60_000; t += 60_000) s = touch(s, A, "src/other.ts", 1, "edit", t).state
  expect(expire(s, TTL_MS + 60_000).value.expired).toEqual([])
  expect(s.locks[V].holder.id).toBe("claude:a")
  // A goes silent: after the idle limit the lock passes to B
  const r = expire(s, TTL_MS + 60_000 + TTL_MS)
  expect(r.value.expired).toEqual([V])
  expect(r.state.locks[V].holder.id).toBe("claude:b")
})

test("the idle limit is 15 minutes", () => expect(TTL_MS).toBe(15 * 60_000))

test("checking the mailbox (after any tool, e.g. Bash) also counts as activity", () => {
  let s = claim(emptyState(), A, [V], 0).state
  s = takeNotices(s, A.id, TTL_MS - 1).state
  expect(expire(s, TTL_MS + 1).value.expired).toEqual([])
})

test("revoke frees a lock, tells the holder, and hands it to the next waiter", () => {
  let s = claim(emptyState(), A, [V], 1).state
  s = claim(s, B, [V], 2).state
  const r = revoke(s, V, 3)
  expect(r.value).toEqual({ revoked: true })
  expect(r.state.outbox[A.id]).toContainEqual({ kind: "revoked", key: V })
  expect(r.state.locks[V].holder.id).toBe("claude:b")
  expect(r.events[0]).toEqual({ type: "revoked", agent: A, key: V })
  expect(revoke(r.state, "nope#x", 4).value).toEqual({ revoked: false })
})

test("a handed-off lock remembers who it came from and the commit", () => {
  let s = claim(emptyState(), A, [V], 1).state
  s = claim(s, B, [V], 2).state
  s = releaseFiles(s, A, ["src/auth.ts"], 3, commit).state
  expect(s.locks[V]).toMatchObject({ holder: B, from: A, commit })
})

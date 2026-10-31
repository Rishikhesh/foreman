import { expect, test } from "bun:test"
import { allow, authorize, openRoom, removeMember, requestJoin } from "./access.js"
import { emptyState } from "./locks.js"

const host = { login: "rishi", id: 1 }
const pal = { login: "pal", id: 2 }

test("openRoom makes the GitHub user the host, allowed, with their key fingerprint", () => {
  const r = openRoom(emptyState(), host, "blue", "h-rishi")
  expect(r.state.access.rishi).toEqual({ login: "rishi", githubId: 1, color: "blue", role: "host", status: "allowed", keyHash: "h-rishi" })
  expect(r.state.people.rishi).toEqual({ name: "rishi", color: "blue" })
  expect(authorize(r.state, "h-rishi")).toEqual({ login: "rishi", role: "host", status: "allowed", color: "blue" })
  expect(authorize(r.state, "nope")).toBeNull()
})

test("a join request waits until the host allows it", () => {
  let s = openRoom(emptyState(), host, "blue", "h-rishi").state
  const req = requestJoin(s, pal, "green", "h-pal")
  expect(req.value).toEqual({ ok: true, status: "pending" })
  expect(req.events).toEqual([{ type: "join-requested", agent: { id: "person:pal", label: "pal", color: "green" } }])
  s = req.state
  expect(authorize(s, "h-pal")).toMatchObject({ login: "pal", status: "pending" })
  const ok = allow(s, "rishi", "pal")
  expect(ok.value).toEqual({ ok: true })
  expect(authorize(ok.state, "h-pal")).toMatchObject({ login: "pal", status: "allowed", role: "member" })
  expect(ok.state.people.pal).toEqual({ name: "pal", color: "green" })
  expect(ok.events[0]).toMatchObject({ type: "joined", agent: { label: "pal" } })
})

test("only the host can allow or remove people", () => {
  let s = openRoom(emptyState(), host, "blue", "h-rishi").state
  s = requestJoin(s, pal, "green", "h-pal").state
  s = requestJoin(s, { login: "eve", id: 3 }, "pink", "h-eve").state
  expect(allow(s, "eve", "pal").value).toEqual({ ok: false, reason: "only the host can do that" })
  s = allow(s, "rishi", "pal").state
  expect(removeMember(s, "pal", "rishi").value).toEqual({ ok: false, reason: "only the host can do that" })
  const r = removeMember(s, "rishi", "pal")
  expect(r.value).toEqual({ ok: true })
  expect(authorize(r.state, "h-pal")).toBeNull()
  expect(r.state.people.pal).toBeUndefined()
})

test("a colour held or requested by someone else is refused", () => {
  const s = openRoom(emptyState(), host, "blue", "h-rishi").state
  expect(requestJoin(s, pal, "blue", "h-pal").value).toEqual({ ok: false, reason: "colour taken", taken: ["blue"] })
})

test("asking again replaces your own pending request (new key), never someone else's", () => {
  let s = openRoom(emptyState(), host, "blue", "h-rishi").state
  s = requestJoin(s, pal, "green", "h-pal-1").state
  s = requestJoin(s, pal, "teal", "h-pal-2").state
  expect(authorize(s, "h-pal-1")).toBeNull()
  expect(authorize(s, "h-pal-2")).toMatchObject({ login: "pal", color: "teal", status: "pending" })
  expect(requestJoin(s, host, "green", "h-x").value).toEqual({ ok: false, reason: "you are already in this room" })
})

test("openRoom on a room that already has a host is refused", () => {
  const s = openRoom(emptyState(), host, "blue", "h-rishi").state
  expect(openRoom(s, pal, "green", "h-pal").value).toEqual({ ok: false, reason: "room already exists" })
})

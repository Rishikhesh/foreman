import { expect, test } from "bun:test"
import { emptyState } from "../../src/core/locks.js"
import type { AgentRef, RepoState } from "../../src/core/types.js"
import { COLOR_HEX, cursorsInFile, freeColors, lensText, newHandoffs, rangesForLocks, statusText } from "./view.js"

const A: AgentRef = { id: "claude:a", label: "claude@rishi", color: "blue" }
const B: AgentRef = { id: "claude:b", label: "claude@friend", color: "orange" }
const SRC = `import { db } from "./db"

export function validateToken(t: string) {
  return t
}

export function refreshSession(id: string) {
  return db.session(id)
}
`

const withLocks = (locks: Record<string, Partial<RepoState["locks"][string]>>, queues: RepoState["queues"] = {}): RepoState => ({
  ...emptyState(),
  locks: Object.fromEntries(Object.entries(locks).map(([key, l]) => [key, { key, since: 0, touched: 0, holder: A, ...l }])) as RepoState["locks"],
  queues,
})

test("rangesForLocks maps lock keys to line ranges in the local copy of the file", () => {
  const s = withLocks(
    { "src/auth.ts#validateToken": { holder: A }, "src/auth.ts#<top>": { holder: B }, "src/auth.ts#gone": { holder: B }, "other.ts#x": {} },
    { "src/auth.ts#validateToken": [{ agent: B, since: 1 }] },
  )
  expect(rangesForLocks(s, "src/auth.ts", SRC)).toEqual([
    { key: "src/auth.ts#validateToken", name: "validateToken", holder: A, start: 3, end: 5, waiting: [B] },
    { key: "src/auth.ts#<top>", name: "top of file", holder: B, start: 1, end: 2, waiting: [] },
  ])
})

test("a <file> lock covers every line", () => {
  const s = withLocks({ "README.md#<file>": { holder: B } })
  expect(rangesForLocks(s, "README.md", "a\nb\nc\n")).toEqual([{ key: "README.md#<file>", name: "whole file", holder: B, start: 1, end: 4, waiting: [] }])
})

test("lensText", () => {
  expect(lensText(undefined, [])).toBe("Free")
  expect(lensText({ holder: A, since: 0 }, [], 125_000)).toBe("Locked by claude@rishi · 2m")
  expect(lensText({ holder: A, since: 0 }, [B], 30_000)).toBe("Locked by claude@rishi · <1m · 1 waiting")
})

test("newHandoffs reports only locks that just became mine, with the commit", () => {
  const commit = { sha: "abc123", summary: "add expiry check", stat: "" }
  const prev = withLocks({ "src/auth.ts#validateToken": { holder: A }, "x.ts#f": { holder: A } })
  const next = withLocks({ "src/auth.ts#validateToken": { holder: B, from: A, commit }, "x.ts#f": { holder: A }, "y.ts#g": { holder: B } })
  expect(newHandoffs(prev, next, [B.id])).toEqual([{ key: "src/auth.ts#validateToken", from: A, commit }])
  expect(newHandoffs(prev, next, [A.id])).toEqual([])
})

test("freeColors hides colours other people hold", () => {
  const s = { ...emptyState(), people: { rishi: { name: "rishi", color: "blue" } } }
  expect(freeColors(s, "friend")).toEqual(Object.keys(COLOR_HEX).filter(c => c !== "blue"))
  expect(freeColors(s, "rishi")).toEqual(Object.keys(COLOR_HEX))
})

test("cursorsInFile shows other agents in this file and drops ones idle over 30s", () => {
  const s: RepoState = {
    ...emptyState(),
    members: { [A.id]: A, [B.id]: B },
    cursors: {
      [A.id]: { file: "src/auth.ts", line: 4, mode: "edit", at: 100_000 },
      [B.id]: { file: "src/auth.ts", line: 8, mode: "read", at: 10_000 },
    },
  }
  expect(cursorsInFile(s, "src/auth.ts", 110_000)).toEqual([{ agent: A, line: 4, mode: "edit" }])
  expect(cursorsInFile(s, "other.ts", 110_000)).toEqual([])
})

test("statusText", () => {
  expect(statusText(null)).toBe("$(circle-slash) Foreman · offline")
  const s = withLocks({ "a.ts#f": {}, "a.ts#g": {} })
  s.members = { [A.id]: A, [B.id]: B }
  expect(statusText(s)).toBe("$(organization) Foreman · 2 agents · 2 locks")
})

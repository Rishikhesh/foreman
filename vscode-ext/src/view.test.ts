import { expect, test } from "bun:test"
import { emptyState } from "../../src/core/locks.js"
import type { AgentRef, RepoState } from "../../src/core/types.js"
import { callerWarnings, COLOR_HEX, cursorsInFile, freeColors, gitDirOf, lensText, newHandoffs, newRequests, pendingRequests, rangesForLocks, statusText } from "./view.js"

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

test("lensText puts everything about a function on one line above it", () => {
  expect(lensText(undefined, [])).toBe("○ Free")
  expect(lensText({ holder: A, since: 0 }, [], 125_000)).toBe("🔒 claude@rishi · 2m")
  expect(lensText({ holder: A, since: 0 }, [B], 30_000, "editing")).toBe("🔒 claude@rishi · editing · <1m · ⏳ claude@friend waiting")
  expect(lensText({ holder: A, since: 0 }, [B, { id: "c", label: "claude@third" }], 30_000)).toBe("🔒 claude@rishi · <1m · ⏳ claude@friend, claude@third waiting")
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

test("gitDirOf follows a worktree's .git file to its real git dir", () => {
  const files: Record<string, string> = { "/w/friend/.git": "gitdir: /w/main/.git/worktrees/friend\n" }
  const isFile = (p: string) => p in files
  expect(gitDirOf("/w/friend", isFile, p => files[p])).toBe("/w/main/.git/worktrees/friend")
  expect(gitDirOf("/w/main", isFile, p => files[p])).toBe("/w/main/.git")
})

test("callerWarnings marks functions in this file that call a recently changed function", () => {
  const s: RepoState = { ...emptyState(), changes: { "src/auth.ts#validateToken": { by: A, at: 1000, callers: ["src/auth.ts#refreshSession", "src/login.ts#login"] } } }
  expect(callerWarnings(s, "src/auth.ts", SRC)).toEqual([
    { name: "refreshSession", start: 7, end: 9, message: "⚠ calls validateToken, changed by claude@rishi" },
  ])
  expect(callerWarnings(s, "src/other.ts", SRC)).toEqual([])
})

const member = (login: string, color: string, role: "host" | "member", status: "pending" | "allowed") => ({ login, githubId: 1, color, role, status, keyHash: "h" })

test("pendingRequests lists people waiting to be let in; newRequests only the ones that just arrived", () => {
  const before: RepoState = { ...emptyState(), access: { rishi: member("rishi", "blue", "host", "allowed"), pal: member("pal", "green", "member", "pending") } }
  const after: RepoState = { ...before, access: { ...before.access, eve: member("eve", "pink", "member", "pending") } }
  expect(pendingRequests(after)).toEqual([{ login: "pal", color: "green" }, { login: "eve", color: "pink" }])
  expect(newRequests(before, after)).toEqual([{ login: "eve", color: "pink" }])
  expect(newRequests(null, before)).toEqual([{ login: "pal", color: "green" }])
})

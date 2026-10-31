import { expect, test } from "bun:test"
import { historySink, hotFunctions, toRows } from "./history.js"
import type { FEvent } from "./core/types.js"

const A = { id: "claude:a", label: "claude@rishi", color: "blue" }
const B = { id: "claude:b", label: "claude@friend", color: "orange" }
const V = "src/auth.ts#validateToken"

test("toRows turns events into flat history rows", () => {
  const events: FEvent[] = [
    { type: "blocked", agent: B, key: V },
    { type: "granted", agent: A, key: V, to: B, sha: "abc123" },
    { type: "left", agent: A },
  ]
  expect(toRows("repo1", events)).toEqual([
    { repo_id: "repo1", type: "blocked", agent_id: B.id, agent_label: B.label, key: V, to_label: null, sha: null },
    { repo_id: "repo1", type: "granted", agent_id: A.id, agent_label: A.label, key: V, to_label: B.label, sha: "abc123" },
    { repo_id: "repo1", type: "left", agent_id: A.id, agent_label: A.label, key: null, to_label: null, sha: null },
  ])
})

test("hotFunctions ranks functions by how often someone had to wait", () => {
  const rows = [
    { key: V, type: "blocked" },
    { key: V, type: "blocked" },
    { key: "src/db.ts#user", type: "blocked" },
    { key: "src/db.ts#user", type: "claimed" },
    { key: "a.ts#x", type: "blocked" },
    { key: "b.ts#y", type: "blocked" },
  ]
  expect(hotFunctions(rows, 3)).toEqual([
    { key: V, waits: 2 },
    { key: "src/db.ts#user", waits: 1 },
    { key: "a.ts#x", waits: 1 },
  ])
})

test("historySink inserts rows and never throws when the database is down", async () => {
  const inserted: unknown[] = []
  await historySink(async rows => void inserted.push(...rows))("repo1", [{ type: "claimed", agent: A, key: V }])
  expect(inserted.length).toBe(1)
  await expect(historySink(async () => { throw new Error("down") })("repo1", [{ type: "claimed", agent: A, key: V }])).resolves.toBeUndefined()
})

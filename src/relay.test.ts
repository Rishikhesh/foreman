import { expect, test } from "bun:test"
import { formatEvent, relaySink } from "./relay.js"
import type { FEvent } from "./core/types.js"

const A = { id: "claude:a", label: "claude@rishi" }
const B = { id: "claude:b", label: "claude@friend" }
const V = "src/auth.ts#validateToken"

test("formatEvent writes one plain line per event", () => {
  const lines = ([
    { type: "joined", agent: { id: "person:friend", label: "friend", color: "orange" } },
    { type: "claimed", agent: A, key: V },
    { type: "blocked", agent: B, key: V },
    { type: "released", agent: A, key: V, sha: "abc123" },
    { type: "granted", agent: A, key: V, to: B, sha: "abc123" },
    { type: "granted", agent: A, key: V, to: B },
    { type: "expired", agent: A, key: V },
    { type: "left", agent: A },
    { type: "signature", agent: A, key: V },
  ] as FEvent[]).map(formatEvent)
  expect(lines).toEqual([
    "friend joined the room (orange)",
    "claude@rishi locked validateToken in src/auth.ts",
    "claude@friend is waiting for validateToken in src/auth.ts",
    "claude@rishi committed abc123 and released validateToken in src/auth.ts",
    "validateToken in src/auth.ts handed from claude@rishi to claude@friend with abc123",
    "validateToken in src/auth.ts handed from claude@rishi to claude@friend (uncommitted)",
    "claude@rishi's lock on validateToken in src/auth.ts expired after being idle",
    "claude@rishi left",
    "claude@rishi changed the name or parameters of validateToken in src/auth.ts; callers were warned",
  ])
})

test("relaySink posts to the channel and threads later events for a function under its lock message", async () => {
  const sent: { text: string; replyTo?: string }[] = []
  const sink = relaySink({
    post: async text => (sent.push({ text }), `m${sent.length}`),
    reply: async (replyTo, text) => (sent.push({ text, replyTo }), `m${sent.length}`),
  })
  await sink("repo1", [{ type: "claimed", agent: A, key: V }])
  await sink("repo1", [{ type: "blocked", agent: B, key: V }, { type: "granted", agent: A, key: V, to: B, sha: "abc123" }])
  await sink("repo1", [{ type: "left", agent: B }])
  expect(sent).toEqual([
    { text: "claude@rishi locked validateToken in src/auth.ts" },
    { text: "claude@friend is waiting for validateToken in src/auth.ts", replyTo: "m1" },
    { text: "validateToken in src/auth.ts handed from claude@rishi to claude@friend with abc123", replyTo: "m1" },
    { text: "claude@friend left" },
  ])
})

test("relaySink never throws when Relay is down", async () => {
  const sink = relaySink({ post: async () => { throw new Error("down") }, reply: async () => { throw new Error("down") } })
  await expect(sink("repo1", [{ type: "claimed", agent: A, key: V }])).resolves.toBeUndefined()
})

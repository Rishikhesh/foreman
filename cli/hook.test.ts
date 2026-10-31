import { expect, test } from "bun:test"
import { agentFor, contextOutput, denyOutput, editPlan, renderDeny, renderNotice, repoKey, stopDecision, stopOutput, toRepoPath } from "./hook.js"
import type { Notice } from "../src/core/types.js"

const SRC = "export function validateToken(t: string) {\n  return t\n}\n"
const read = (p: string) => (p === "/w/repo/src/auth.ts" ? SRC : null)

test("repoKey normalizes ssh and https remotes to host/owner/repo", () => {
  for (const url of [
    "git@github.com:Org/Repo.git",
    "https://github.com/org/repo",
    "https://github.com/org/repo.git",
    "ssh://git@github.com/org/repo",
  ])
    expect(repoKey(url)).toBe("github.com/org/repo")
  expect(repoKey("git@github-personal:Rishikhesh/hauntedHacks.git")).toBe("github.com/rishikhesh/haunted" + "hacks")
})

test("toRepoPath keeps files inside the checkout and rejects the rest", () => {
  expect(toRepoPath("/w/repo/src/a.ts", "/w/repo", "/w/repo")).toBe("src/a.ts")
  expect(toRepoPath("./src/a.ts", "/w/repo", "/w/repo")).toBe("src/a.ts")
  expect(toRepoPath("src/../src/a.ts", "/w/repo", "/w/repo")).toBe("src/a.ts")
  expect(toRepoPath("/Users/x/.claude/plans/p.md", "/w/repo", "/w/repo")).toBeNull()
  expect(toRepoPath("/tmp/x", "/w/repo", "/w/repo")).toBeNull()
})

test("agentFor labels by git user name", () => {
  expect(agentFor("s1", "Rishi Kesh")).toEqual({ id: "claude:s1", label: "claude@rishi", sessionId: "s1" })
})

test("editPlan maps each tool to a cursor and lock keys", () => {
  const root = "/w/repo"
  expect(editPlan({ tool_name: "Edit", tool_input: { file_path: "/w/repo/src/auth.ts", old_string: "  return t" } }, root, read))
    .toEqual({ file: "src/auth.ts", line: 2, mode: "edit", keys: ["src/auth.ts#validateToken"] })
  expect(editPlan({ tool_name: "MultiEdit", tool_input: { file_path: "/w/repo/src/auth.ts", edits: [{ old_string: "  return t" }] } }, root, read))
    .toEqual({ file: "src/auth.ts", line: 2, mode: "edit", keys: ["src/auth.ts#validateToken"] })
  expect(editPlan({ tool_name: "Write", tool_input: { file_path: "/w/repo/src/new.ts", content: "x" } }, root, read))
    .toEqual({ file: "src/new.ts", line: 1, mode: "edit", keys: ["src/new.ts#<top>"] })
  expect(editPlan({ tool_name: "Read", tool_input: { file_path: "/w/repo/src/auth.ts", offset: 2 } }, root, read))
    .toEqual({ file: "src/auth.ts", line: 2, mode: "read", keys: [] })
  expect(editPlan({ tool_name: "Bash", tool_input: { command: "ls" } }, root, read)).toBeNull()
  expect(editPlan({ tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts", old_string: "a" } }, root, read)).toBeNull()
})

test("deny and notice copy", () => {
  const A = { id: "claude:a", label: "claude@rishi" }
  expect(renderDeny({ key: "src/auth.ts#validateToken", holder: A, task: "add expiry", position: 1 })).toBe(
    "validateToken in src/auth.ts is locked by claude@rishi (task: add expiry). You are #1 in line. Work on something else; you will be told here when it is yours.",
  )
  const notices: Notice[] = [
    { kind: "heads-up", key: "src/auth.ts#validateToken", by: A },
    { kind: "granted", key: "src/auth.ts#validateToken", from: A, commit: { sha: "abc123", summary: "add expiry check", stat: "" } },
    { kind: "granted", key: "src/auth.ts#<top>", from: A, uncommitted: true },
    { kind: "expired", key: "src/auth.ts#validateToken" },
    { kind: "signature", key: "src/auth.ts#validateToken", by: A, callers: ["src/login.ts#login"] },
  ]
  expect(notices.map(renderNotice)).toEqual([
    "Heads-up: claude@rishi locked validateToken in src/auth.ts, a file you have opened. Avoid editing it.",
    "validateToken in src/auth.ts is yours now. claude@rishi committed abc123: add expiry check. Before editing, run `git fetch origin refs/foreman/abc123 && git merge abc123`.",
    "the top of src/auth.ts is yours now. claude@rishi left without committing; its changes are not in any commit.",
    "Your lock on validateToken in src/auth.ts expired. It will be re-taken on your next edit if free.",
    "Watch out: claude@rishi changed the name or parameters of validateToken in src/auth.ts. You work on code that calls it (login in src/login.ts); update those calls after pulling their commit.",
  ])
})

test("hook outputs match Claude Code's shapes", () => {
  expect(denyOutput("r")).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r" } })
  expect(contextOutput("PostToolUse", "t")).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "t" } })
  expect(stopOutput("r")).toEqual({ decision: "block", reason: "r" })
})

test("stopDecision: block with notices, poll while waiting, otherwise allow", () => {
  const g: Notice = { kind: "granted", key: "a.ts#f", commit: { sha: "abc123", summary: "s", stat: "" } }
  expect(stopDecision(false, [])).toEqual({ keepPolling: false })
  expect(stopDecision(true, [])).toEqual({ keepPolling: true })
  const r = stopDecision(true, [g])
  expect(r.keepPolling).toBe(false)
  expect(r.output?.reason).toContain("git merge abc123")
})

import path from "node:path"
import { keysForEdit, keysForWrite } from "../src/core/symbols.js"
import type { AgentRef, Blocked, LockKey, Notice } from "../src/core/types.js"

/** `git@github.com:Org/Repo.git`, `https://github.com/org/repo` … → `github.com/org/repo`. */
export function repoKey(url: string): string {
  let s = url.trim().toLowerCase().replace(/\.git$/, "").replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "")
  s = s.replace(/^([^/:]+):/, "$1/")
  // ponytail: SSH host aliases like `github-personal` are assumed to mean github.com; add a real alias map if another host shows up
  return s.replace(/^github[^/]*\//, "github.com/")
}

/** Repo-relative POSIX path, or null when the file is outside the checkout. */
export function toRepoPath(file: string, cwd: string, root: string): string | null {
  const rel = path.relative(root, path.resolve(cwd, file))
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/")
}

export const agentFor = (sessionId: string, userName: string): AgentRef => ({
  id: `claude:${sessionId}`,
  label: `claude@${(userName.trim().split(/\s+/)[0] || "agent").toLowerCase()}`,
  sessionId,
})

export interface HookInput { tool_name: string; tool_input: Record<string, any> }
export interface EditPlan { file: string; line: number; mode: "read" | "edit"; keys: LockKey[] }

const lineOf = (src: string | null, text: string) => {
  const i = src && text ? src.indexOf(text) : -1
  return i < 0 ? 1 : src!.slice(0, i).split("\n").length
}

/** What a tool call means for Foreman: where the cursor goes and which locks an edit needs. */
export function editPlan(input: HookInput, root: string, readFile: (abs: string) => string | null): EditPlan | null {
  const t = input.tool_input ?? {}
  const raw = t.file_path ?? t.notebook_path
  if (typeof raw !== "string") return null
  const file = toRepoPath(raw, root, root)
  if (!file) return null
  const abs = path.resolve(root, raw)
  switch (input.tool_name) {
    case "Read":
      return { file, line: Number(t.offset ?? 1), mode: "read", keys: [] }
    case "Edit": {
      const src = readFile(abs) ?? ""
      return { file, line: lineOf(src, t.old_string), mode: "edit", keys: keysForEdit(file, src, t.old_string ?? "", !!t.replace_all) }
    }
    case "MultiEdit": {
      const src = readFile(abs) ?? ""
      const edits: { old_string: string; replace_all?: boolean }[] = t.edits ?? []
      const keys = [...new Set(edits.flatMap(e => keysForEdit(file, src, e.old_string ?? "", !!e.replace_all)))]
      return { file, line: lineOf(src, edits[0]?.old_string ?? ""), mode: "edit", keys }
    }
    case "Write":
      return { file, line: 1, mode: "edit", keys: keysForWrite(file, readFile(abs)) }
    case "NotebookEdit":
      return { file, line: 1, mode: "edit", keys: [`${file}#<file>`] }
    default:
      return null
  }
}

export const describe = (key: LockKey) => {
  const i = key.lastIndexOf("#")
  const file = key.slice(0, i)
  const sym = key.slice(i + 1)
  return sym === "<top>" ? `the top of ${file}` : sym === "<file>" ? file : `${sym} in ${file}`
}

export const renderDeny = (b: Blocked) =>
  `${describe(b.key)} is locked by ${b.holder.label}${b.task ? ` (task: ${b.task})` : ""}. You are #${b.position} in line. Work on something else; you will be told here when it is yours.`

export function renderNotice(n: Notice): string {
  switch (n.kind) {
    case "heads-up":
      return `Heads-up: ${n.by.label} locked ${describe(n.key)}, a file you have opened. Avoid editing it.`
    case "granted":
      return n.commit
        ? `${describe(n.key)} is yours now. ${n.from?.label ?? "Its holder"} committed ${n.commit.sha}: ${n.commit.summary}. Before editing, run \`git fetch origin refs/foreman/${n.commit.sha} && git merge ${n.commit.sha}\`.`
        : `${describe(n.key)} is yours now. ${n.from?.label ?? "Its holder"} left without committing; its changes are not in any commit.`
    case "expired":
      return `Your lock on ${describe(n.key)} expired. It will be re-taken on your next edit if free.`
    case "signature": {
      const where = n.callers.map(k => k.slice(k.lastIndexOf("#") + 1) + " in " + k.slice(0, k.lastIndexOf("#"))).join(", ")
      return `Watch out: ${n.by.label} changed the name or parameters of ${describe(n.key)}. You work on code that calls it (${where}); update those calls after pulling their commit.`
    }
    case "revoked":
      return `Your lock on ${describe(n.key)} was revoked by a teammate. Stop editing it; it will be re-taken on your next edit if free.`
  }
}

export const denyOutput = (reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
})
export const contextOutput = (event: "PostToolUse" | "UserPromptSubmit", text: string) => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: text },
})
export const stopOutput = (reason: string) => ({ decision: "block", reason })

export function stopDecision(waiting: boolean, notices: Notice[]): { output?: { decision: string; reason: string }; keepPolling: boolean } {
  if (notices.length) return { output: stopOutput(notices.map(renderNotice).join("\n")), keepPolling: false }
  return { keepPolling: waiting }
}

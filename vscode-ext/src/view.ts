import { fileOf } from "../../src/core/locks.js"
import { functionsIn } from "../../src/core/symbols.js"
import type { AgentId, AgentRef, CommitInfo, Lock, LockKey, RepoState } from "../../src/core/types.js"

/** Person colour name → hex; same names the CLI offers. */
export const COLOR_HEX: Record<string, string> = {
  blue: "#378ADD",
  orange: "#D85A30",
  green: "#639922",
  purple: "#7F77DD",
  pink: "#D4537E",
  teal: "#1D9E75",
}

export interface LockRange { key: LockKey; name: string; holder: AgentRef; start: number; end: number; waiting: AgentRef[] }

/** Lock keys for `file`, placed on this laptop's copy of the source by function name (line numbers differ between laptops). */
export function rangesForLocks(state: RepoState, file: string, source: string): LockRange[] {
  const fns = functionsIn(file, source)
  const lastLine = source.split("\n").length
  const out: LockRange[] = []
  for (const lock of Object.values(state.locks)) {
    if (fileOf(lock.key) !== file) continue
    const sym = lock.key.slice(lock.key.lastIndexOf("#") + 1)
    const waiting = (state.queues[lock.key] ?? []).map(w => w.agent)
    const base = { key: lock.key, holder: lock.holder, waiting }
    if (sym === "<file>") out.push({ ...base, name: "whole file", start: 1, end: lastLine })
    else if (sym === "<top>") out.push({ ...base, name: "top of file", start: 1, end: Math.max(1, (fns[0]?.start ?? lastLine + 1) - 1) })
    else {
      const fn = fns.find(f => f.name === sym)
      if (fn) out.push({ ...base, name: sym, start: fn.start, end: fn.end })
    }
  }
  return out
}

const age = (ms: number) => (ms < 60_000 ? "<1m" : `${Math.floor(ms / 60_000)}m`)

export function lensText(lock: Pick<Lock, "holder" | "since"> | undefined, waiting: AgentRef[], now = Date.now()): string {
  if (!lock) return "Free"
  return `Locked by ${lock.holder.label} · ${age(now - lock.since)}${waiting.length ? ` · ${waiting.length} waiting` : ""}`
}

/** Locks whose holder just changed to one of my agents. */
export function newHandoffs(prev: RepoState | null, next: RepoState, mine: AgentId[]): { key: LockKey; from?: AgentRef; commit?: CommitInfo }[] {
  return Object.values(next.locks)
    .filter(l => mine.includes(l.holder.id) && prev?.locks[l.key]?.holder.id !== l.holder.id && l.from)
    .map(l => ({ key: l.key, from: l.from, ...(l.commit && { commit: l.commit }) }))
}

export const freeColors = (state: RepoState, me: string) => {
  const taken = Object.values(state.people ?? {}).filter(p => p.name !== me).map(p => p.color)
  return Object.keys(COLOR_HEX).filter(c => !taken.includes(c))
}

const CURSOR_FADE_MS = 30_000

export function cursorsInFile(state: RepoState, file: string, now = Date.now()) {
  return Object.entries(state.cursors)
    .filter(([, c]) => c.file === file && now - c.at <= CURSOR_FADE_MS && c.line !== undefined)
    .map(([id, c]) => ({ agent: state.members[id] ?? { id, label: id }, line: c.line!, mode: c.mode }))
}

export function statusText(state: RepoState | null): string {
  if (!state) return "$(circle-slash) Foreman · offline"
  return `$(organization) Foreman · ${Object.keys(state.members).length} agents · ${Object.keys(state.locks).length} locks`
}

/** The real git dir for a checkout: `.git` is a folder in a clone but a `gitdir:` pointer file in a worktree. */
export function gitDirOf(root: string, isFile: (p: string) => boolean, read: (p: string) => string): string {
  const dotGit = `${root}/.git`
  if (!isFile(dotGit)) return dotGit
  const target = read(dotGit).replace(/^gitdir:\s*/, "").trim()
  return target.startsWith("/") ? target : `${root}/${target}`
}

/** Functions in this file that call something whose name or parameters just changed. */
export function callerWarnings(state: RepoState, file: string, source: string) {
  const fns = functionsIn(file, source)
  const out: { name: string; start: number; end: number; message: string }[] = []
  for (const [key, c] of Object.entries(state.changes ?? {}))
    for (const caller of c.callers) {
      if (fileOf(caller) !== file) continue
      const fn = fns.find(f => `${file}#${f.name}` === caller)
      if (fn) out.push({ name: fn.name, start: fn.start, end: fn.end, message: `⚠ calls ${key.slice(key.lastIndexOf("#") + 1)}, changed by ${c.by.label}` })
    }
  return out
}

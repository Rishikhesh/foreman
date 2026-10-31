import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import type { AgentRef, CommitInfo } from "../src/core/types.js"
import { repoKey } from "./hook.js"

const git = (cwd: string, ...args: string[]) => $`git -C ${cwd} ${args}`.quiet().nothrow()
const text = async (cwd: string, ...args: string[]) => {
  const r = await git(cwd, ...args)
  return r.exitCode === 0 ? r.stdout.toString().trim() : ""
}

export const worktreeRoot = (cwd: string) => text(cwd, "rev-parse", "--show-toplevel")
export const userName = async (cwd: string) => (await text(cwd, "config", "user.name")) || process.env.USER || "agent"
const gitDir = async (cwd: string) => path.resolve(cwd, await text(cwd, "rev-parse", "--git-dir"))

export interface Config { url?: string; repoId?: string; room?: string; code?: string; name?: string; color?: string }
export const configFile = async (cwd: string) => path.join(await gitDir(cwd), "foreman.json")
export async function readConfig(cwd: string): Promise<Config> {
  const f = path.join(await gitDir(cwd), "foreman.json")
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}
}
export async function writeConfig(cwd: string, c: Config) {
  writeFileSync(path.join(await gitDir(cwd), "foreman.json"), JSON.stringify(c, null, 2))
}

/** Same id for every clone of a repo (ssh or https): sha1 of host/owner/repo. */
export async function repoId(cwd: string): Promise<string> {
  const origin = await text(cwd, "remote", "get-url", "origin")
  const basis = origin ? repoKey(origin) : await text(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
  return createHash("sha1").update(basis).digest("hex").slice(0, 16)
}

const agentFile = async (cwd: string) => path.join(await gitDir(cwd), "foreman-agent.json")
export async function readAgent(cwd: string): Promise<AgentRef | null> {
  const f = await agentFile(cwd)
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null
}
export async function writeAgent(cwd: string, a: AgentRef) {
  writeFileSync(await agentFile(cwd), JSON.stringify(a))
}

export async function headCommit(cwd: string): Promise<{ info: CommitInfo; files: string[] }> {
  const sha = await text(cwd, "rev-parse", "HEAD")
  const summary = (await text(cwd, "log", "-1", "--format=%B")).slice(0, 500)
  const stat = await text(cwd, "show", "--stat", "--format=", "HEAD")
  const files = (await text(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD")).split("\n").filter(Boolean)
  return { info: { sha, summary, stat }, files }
}

/** Push HEAD to a hidden ref so the other laptop can fetch exactly this commit. */
export const pushCommit = async (cwd: string, sha: string) => (await git(cwd, "push", "-q", "origin", `HEAD:refs/foreman/${sha}`)).exitCode === 0

export const stagedFiles = async (cwd: string) => (await text(cwd, "diff", "--cached", "--name-only")).split("\n").filter(Boolean)

export const hooksDir = async (cwd: string) => path.resolve(cwd, await text(cwd, "rev-parse", "--git-path", "hooks"))

/** Staged diff (zero context) and staged content of one file; content is null for a deleted file. */
export async function stagedChange(cwd: string, file: string): Promise<{ diff: string; source: string | null }> {
  const diff = await text(cwd, "diff", "--cached", "-U0", "--", file)
  const shown = await git(cwd, "show", `:${file}`)
  return { diff, source: shown.exitCode === 0 ? shown.stdout.toString() : null }
}

const STASH = "foreman-before.json"
/** Remember a file's content before an edit, so the post-edit hook can tell whether a signature changed. */
export async function stashBefore(cwd: string, file: string, content: string | null) {
  const f = path.join(await gitDir(cwd), STASH)
  const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}
  all[file] = content
  writeFileSync(f, JSON.stringify(all))
}
export async function takeBefore(cwd: string, file: string): Promise<string | null | undefined> {
  const f = path.join(await gitDir(cwd), STASH)
  if (!existsSync(f)) return undefined
  const all = JSON.parse(readFileSync(f, "utf8"))
  const v = all[file]
  delete all[file]
  writeFileSync(f, JSON.stringify(all))
  return v
}

const CODE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/
/** Contents of the repo's tracked code files (capped), for finding callers. */
export async function codeSources(root: string, cap = 3000): Promise<Record<string, string>> {
  const files = (await text(root, "ls-files", "--cached", "--others", "--exclude-standard")).split("\n").filter(f => CODE.test(f)).slice(0, cap)
  const out: Record<string, string> = {}
  for (const f of files) {
    try {
      out[f] = readFileSync(path.join(root, f), "utf8")
    } catch {}
  }
  return out
}

/** Fetch a handed-off commit and merge it; a refused or conflicting merge is fully undone. */
export async function autoMerge(cwd: string, sha: string): Promise<{ ok: boolean; reason?: string }> {
  const fetched = await git(cwd, "fetch", "-q", "origin", `refs/foreman/${sha}`)
  if (fetched.exitCode !== 0) return { ok: false, reason: "could not fetch the commit" }
  if ((await git(cwd, "merge-base", "--is-ancestor", sha, "HEAD")).exitCode === 0) return { ok: true }
  // --autostash: uncommitted edits in other functions are set aside and put back (locks keep them from overlapping)
  const merged = await git(cwd, "merge", "-q", "--no-edit", "--autostash", sha)
  if (merged.exitCode === 0) return { ok: true }
  if (existsSync(path.join(await gitDir(cwd), "MERGE_HEAD"))) await git(cwd, "merge", "--abort")
  const why = (merged.stderr.toString() + merged.stdout.toString()).split("\n").find(l => /conflict|overwritten|error/i.test(l))
  return { ok: false, reason: why?.trim() || "git refused the merge" }
}

/** HEAD and the commits the last merge brought in. */
export async function lastMerge(cwd: string): Promise<{ head: string; shas: string[] }> {
  const head = await text(cwd, "rev-parse", "HEAD")
  const shas = (await text(cwd, "rev-list", "ORIG_HEAD..HEAD")).split("\n").filter(Boolean)
  return { head, shas }
}

export interface RoomInfo { url: string; room: string; repoId: string }

/** Publish a room under refs/foreman-rooms/<code> (a one-file commit), so teammates' clones can look it up by code. */
export async function publishRoom(cwd: string, code: string, info: RoomInfo): Promise<boolean> {
  const blob = (await $`git -C ${cwd} hash-object -w --stdin < ${new Response(JSON.stringify(info))}`.quiet().nothrow()).stdout.toString().trim()
  const tree = (await $`git -C ${cwd} mktree < ${new Response(`100644 blob ${blob}\troom.json\n`)}`.quiet().nothrow()).stdout.toString().trim()
  const commit = await text(cwd, "commit-tree", tree, "-m", `foreman room ${code}`)
  if (!commit) return false
  return (await git(cwd, "push", "-q", "-f", "origin", `${commit}:refs/foreman-rooms/${code}`)).exitCode === 0
}

export async function readRoom(cwd: string, code: string): Promise<RoomInfo | null> {
  if ((await git(cwd, "fetch", "-q", "origin", `refs/foreman-rooms/${code}`)).exitCode !== 0) return null
  try {
    return JSON.parse(await text(cwd, "show", "FETCH_HEAD:room.json"))
  } catch {
    return null
  }
}

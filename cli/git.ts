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

export interface Config { url?: string; repoId?: string; name?: string; color?: string }
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

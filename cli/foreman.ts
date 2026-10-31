#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import type { AgentRef, Blocked, Notice, RepoState } from "../src/core/types.js"
import { fileOf } from "../src/core/locks.js"
import * as g from "./git.js"
import { agentFor, contextOutput, denyOutput, describe, editPlan, renderDeny, renderNotice, stopDecision } from "./hook.js"

const CLI_TIMEOUT_MS = 2000
const STOP_POLL_MS = 3000
const STOP_MAX_MS = 540_000

class Unreachable extends Error {}

async function ctx(cwd: string) {
  const cfg = await g.readConfig(cwd)
  return {
    url: process.env.FOREMAN_URL ?? cfg.url ?? "http://127.0.0.1:7300",
    repoId: process.env.FOREMAN_REPO_ID ?? cfg.repoId ?? (await g.repoId(cwd)),
    cfg,
  }
}

async function call<T>(url: string, route: string, body: object): Promise<T> {
  try {
    const res = await fetch(new URL(route, url), { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(CLI_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${route} ${res.status}`)
    return (await res.json()) as T
  } catch (e) {
    throw new Unreachable(String(e))
  }
}

/** Resolve symlinks (macOS /var → /private/var) so paths compare equal to git's toplevel. */
function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.join(real(path.dirname(p)), path.basename(p))
  }
}

const print = (o: object) => process.stdout.write(JSON.stringify(o))

async function hookAgent(cwd: string, sessionId: string): Promise<AgentRef> {
  const { cfg } = await ctx(cwd)
  const agent = { ...agentFor(sessionId, cfg.name ?? (await g.userName(cwd))), ...(cfg.color && { color: cfg.color }) }
  await g.writeAgent(cwd, agent)
  return agent
}

async function notices(cwd: string, sessionId: string): Promise<Notice[]> {
  const { url, repoId } = await ctx(cwd)
  return call<Notice[]>(url, "/api/notices", { repoId, agentId: `claude:${sessionId}` })
}

const commands: Record<string, (args: string[], stdin: () => any) => Promise<number | void>> = {
  async "hook pre-tool"(_, stdin) {
    const input = stdin()
    const root = await g.worktreeRoot(input.cwd)
    if (!root) return
    for (const k of ["file_path", "notebook_path"]) if (typeof input.tool_input?.[k] === "string") input.tool_input[k] = real(path.resolve(input.cwd, input.tool_input[k]))
    const plan = editPlan(input, root, f => {
      try {
        return readFileSync(f, "utf8")
      } catch {
        return null
      }
    })
    if (!plan) return
    const { url, repoId } = await ctx(root)
    const agent = await hookAgent(root, input.session_id)
    await call(url, "/api/touch", { repoId, agent, file: plan.file, line: plan.line, mode: plan.mode })
    if (!plan.keys.length) return
    const r = await call<{ blocked: Blocked[] }>(url, "/api/claim", { repoId, agent, keys: plan.keys })
    if (r.blocked?.length) print(denyOutput(r.blocked.map(renderDeny).join("\n")))
  },

  async "hook post-tool"(_, stdin) {
    const input = stdin()
    const n = await notices(input.cwd, input.session_id)
    if (n.length) print(contextOutput("PostToolUse", n.map(renderNotice).join("\n")))
  },

  async "hook prompt"(_, stdin) {
    const input = stdin()
    const n = await notices(input.cwd, input.session_id)
    if (n.length) print(contextOutput("UserPromptSubmit", n.map(renderNotice).join("\n")))
  },

  async "hook stop"(_, stdin) {
    const input = stdin()
    const { url, repoId } = await ctx(input.cwd)
    const agentId = `claude:${input.session_id}`
    for (const t0 = Date.now(); Date.now() - t0 < STOP_MAX_MS; await Bun.sleep(STOP_POLL_MS)) {
      const { waiting } = await call<{ waiting: boolean }>(url, "/api/waiting", { repoId, agentId })
      const d = stopDecision(waiting, await call<Notice[]>(url, "/api/notices", { repoId, agentId }))
      if (d.output) return print(d.output)
      if (!d.keepPolling) return
    }
  },

  async "hook session-end"(_, stdin) {
    const input = stdin()
    const { url, repoId } = await ctx(input.cwd)
    const agent = await g.readAgent(input.cwd)
    if (agent?.id === `claude:${input.session_id}`) await call(url, "/api/release-all", { repoId, agent })
  },

  async "git post-commit"() {
    const cwd = process.cwd()
    const agent = await g.readAgent(cwd)
    if (!agent) return
    const { info, files } = await g.headCommit(cwd)
    if (!(await g.pushCommit(cwd, info.sha))) {
      console.error("foreman: push failed, keeping your locks (they expire if idle)")
      return
    }
    const { url, repoId } = await ctx(cwd)
    await call(url, "/api/release", { repoId, agent, files, commit: info })
  },

  async "git pre-commit"() {
    const cwd = process.cwd()
    if (process.env.FOREMAN_FORCE === "1") return
    const me = await g.readAgent(cwd)
    const staged = await g.stagedFiles(cwd)
    const { url, repoId } = await ctx(cwd)
    const s = await call<RepoState>(url, "/api/status", { repoId })
    const clash = Object.entries(s.locks ?? {}).filter(([key, l]) => staged.includes(fileOf(key)) && l.holder.id !== me?.id)
    if (!clash.length) return
    for (const [key, l] of clash) console.error(`foreman: ${describe(key)} is locked by ${l.holder.label}`)
    console.error("foreman: commit refused. Wait for the handoff, or set FOREMAN_FORCE=1.")
    return 1
  },

  async status() {
    const cwd = process.cwd()
    const { url, repoId } = await ctx(cwd)
    const s = await call<RepoState>(url, "/api/status", { repoId })
    const locks = Object.values(s.locks ?? {})
    if (!locks.length) console.log("No locks.")
    for (const l of locks) {
      const q = (s.queues?.[l.key] ?? []).map(w => w.agent.label)
      console.log(`${describe(l.key)} — ${l.holder.label}${q.length ? `, waiting: ${q.join(", ")}` : ""}`)
    }
  },
}

async function main() {
  const argv = process.argv.slice(2)
  const name = [argv.slice(0, 2).join(" "), argv[0]].find(n => n in commands)
  if (!name) {
    console.error(`usage: foreman <${Object.keys(commands).join(" | ")}>`)
    return 2
  }
  let cached: unknown
  const stdin = () => (cached ??= JSON.parse(readFileSync(0, "utf8") || "{}"))
  try {
    return (await commands[name](argv.slice(name.split(" ").length), stdin)) ?? 0
  } catch (e) {
    if (e instanceof Unreachable) {
      console.error(`foreman: server unreachable, allowing (${e.message})`)
      return 0
    }
    throw e
  }
}

process.exit(await main())

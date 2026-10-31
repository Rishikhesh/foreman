#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentRef, Blocked, Notice, RepoState } from "../src/core/types.js"
import { callersOf, changedLines, keysForLines, signatureChanges } from "../src/core/symbols.js"
import * as g from "./git.js"
import { formatCode, normalizeCode } from "./code.js"
import { COLORS, GIT_HOOKS, gitHookScript, mergeHooks, removeHooks } from "./onboard.js"
import { agentFor, contextOutput, denyOutput, describe, editPlan, renderDeny, renderNotice, stopDecision } from "./hook.js"

const CLI_TIMEOUT_MS = 2000
const STOP_POLL_MS = 3000
const STOP_MAX_MS = 540_000

class Unreachable extends Error {}

async function ctx(cwd: string) {
  const cfg = await g.readConfig(cwd)
  return {
    url: process.env.FOREMAN_URL || cfg.url || DEFAULT_SERVER,
    repoId: process.env.FOREMAN_REPO_ID || cfg.room || cfg.repoId || (await g.repoId(cwd)),
    key: cfg.key,
    cfg,
  }
}

async function call<T>(url: string, route: string, body: object, key?: string): Promise<T> {
  try {
    const res = await fetch(new URL(route, url), { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(CLI_TIMEOUT_MS), headers: key ? { authorization: `Bearer ${key}` } : {} })
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
  const agent = { ...agentFor(sessionId, cfg.login ?? cfg.name ?? (await g.userName(cwd))), ...(cfg.color && { color: cfg.color }) }
  await g.writeAgent(cwd, agent)
  return agent
}

async function notices(cwd: string, sessionId: string): Promise<Notice[]> {
  const { url, repoId, key } = await ctx(cwd)
  return withMerges(cwd, await call<Notice[]>(url, "/api/notices", { repoId, agentId: `claude:${sessionId}` }, key))
}

/** For each function handed over with a commit, merge that commit into this checkout before the agent hears about it. */
async function withMerges(cwd: string, ns: Notice[]): Promise<Notice[]> {
  const root = (await g.worktreeRoot(cwd)) || cwd
  const out: Notice[] = []
  for (const n of ns) out.push(n.kind === "granted" && n.commit ? { ...n, merged: await g.autoMerge(root, n.commit.sha) } : n)
  return out
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
    const { url, repoId, key } = await ctx(root)
    const agent = await hookAgent(root, input.session_id)
    await call(url, "/api/touch", { repoId, agent, file: plan.file, line: plan.line, mode: plan.mode }, key)
    if (!plan.keys.length) return
    const abs = path.join(root, plan.file)
    await g.stashBefore(root, plan.file, existsSync(abs) ? readFileSync(abs, "utf8") : null)
    const r = await call<{ blocked: Blocked[] }>(url, "/api/claim", { repoId, agent, keys: plan.keys }, key)
    if (r.blocked?.length) print(denyOutput(r.blocked.map(renderDeny).join("\n")))
  },

  async "hook post-tool"(_, stdin) {
    const input = stdin()
    await reportSignatureChanges(input)
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
    const { url, repoId, key } = await ctx(input.cwd)
    const agentId = `claude:${input.session_id}`
    for (const t0 = Date.now(); Date.now() - t0 < STOP_MAX_MS; await Bun.sleep(STOP_POLL_MS)) {
      const { waiting } = await call<{ waiting: boolean }>(url, "/api/waiting", { repoId, agentId }, key)
      const d = stopDecision(waiting, await withMerges(input.cwd, await call<Notice[]>(url, "/api/notices", { repoId, agentId }, key)))
      if (d.output) {
        print(d.output)
        return
      }
      if (!d.keepPolling) return
    }
  },

  async "hook session-end"(_, stdin) {
    const input = stdin()
    const { url, repoId, key } = await ctx(input.cwd)
    const agent = await g.readAgent(input.cwd)
    if (agent?.id === `claude:${input.session_id}`) await call(url, "/api/release-all", { repoId, agent }, key)
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
    const { url, repoId, key } = await ctx(cwd)
    await call(url, "/api/release", { repoId, agent, files, commit: info }, key)
  },

  async "git post-merge"() {
    const cwd = process.cwd()
    const { head, shas } = await g.lastMerge(cwd)
    const { url, repoId, key } = await ctx(cwd)
    await call(url, "/api/pulled", { repoId, head, shas }, key)
  },

  async "git pre-commit"() {
    const cwd = process.cwd()
    if (process.env.FOREMAN_FORCE === "1") return
    const me = await g.readAgent(cwd)
    const staged = await g.stagedFiles(cwd)
    const { url, repoId, key } = await ctx(cwd)
    const s = await call<RepoState>(url, "/api/status", { repoId }, key)
    const touched = new Set<string>()
    for (const file of staged) {
      const { diff, source } = await g.stagedChange(cwd, file)
      const keys = source === null ? [`${file}#<file>`] : keysForLines(file, source, changedLines(diff))
      keys.forEach(k => touched.add(k))
      // a whole-file lock covers every function in it
      touched.add(`${file}#<file>`)
    }
    const clash = Object.entries(s.locks ?? {}).filter(([key, l]) => touched.has(key) && l.holder.id !== me?.id)
    if (!clash.length) return
    for (const [key, l] of clash) console.error(`foreman: ${describe(key)} is locked by ${l.holder.label}`)
    console.error("foreman: commit refused. Wait for the handoff, or set FOREMAN_FORCE=1.")
    return 1
  },

  async init(args) {
    const root = await requireRepo(process.cwd())
    const url = serverUrl(args)
    const color = flag(args, "--color") ?? COLORS[0]
    const githubToken = await signIn(args)
    const key = newKey()
    const repoId = await g.repoId(root)
    const r = await rooms<{ room: string; code: string; login: string }>(url, "/api/rooms/create", { githubToken, repoId, color, keyHash: sha256(key) })
    await g.writeConfig(root, { url, repoId, room: r.room, code: r.code, key, login: r.login, color })
    installHooks(root)
    console.log(`You're ${r.login} (${color}). Hooks installed for Claude Code and git.`)
    console.log(`\nRoom code: ${formatCode(r.code)}\nSend it to your teammate. They use Join a room in VS Code (or \`foreman join ${formatCode(r.code)}\`), and you click Allow.`)
  },

  async join(args) {
    const root = await requireRepo(process.cwd())
    const code = normalizeCode(args[0] ?? "")
    if (!code) throw new UserError(`"${args[0] ?? ""}" isn't a room code. It looks like K7QM-2XPA.`)
    const url = serverUrl(args)
    let color = flag(args, "--color")
    if (!color) {
      const peek = await rooms<{ taken: string[] }>(url, "/api/rooms/peek", { code })
      color = COLORS.find(c => !peek.taken.includes(c)) ?? COLORS[0]
    }
    const githubToken = await signIn(args)
    const key = newKey()
    const repoId = await g.repoId(root)
    const r = await rooms<{ ok: boolean; room?: string; reason?: string; taken?: string[] }>(url, "/api/rooms/join", { githubToken, code, repoId, color, keyHash: sha256(key) })
    if (!r.ok) throw new UserError(r.taken ? `Colour ${color} is taken. Free: ${COLORS.filter(c => !r.taken!.includes(c)).join(", ")}. Pass --color <name>.` : `Couldn't join: ${r.reason}`)
    await g.writeConfig(root, { url, repoId, room: r.room!, code, key, color })
    installHooks(root)
    console.log("Asked to join. Waiting for the host to let you in…")
    if (args.includes("--no-wait")) return
    for (const t0 = Date.now(); Date.now() - t0 < 15 * 60_000; await Bun.sleep(POLL_MS)) {
      const me = await rooms<{ login: string; status: string; color: string }>(url, "/api/me", { repoId: r.room }, key).catch(e => {
        throw new UserError(e instanceof UserError && /room key/.test(e.message) ? "The host didn't let you in." : (e as Error).message)
      })
      if (me.status === "allowed") {
        await g.writeConfig(root, { url, repoId, room: r.room!, code, key, color: me.color, login: me.login })
        console.log(`You're in as ${me.login} (${me.color}). Open this folder in VS Code and start Claude Code here.`)
        return
      }
    }
    throw new UserError("Still waiting after 15 minutes. Ask the host to click Allow, then run join again.")
  },

  async invite() {
    const cfg = await g.readConfig(await requireRepo(process.cwd()))
    if (!cfg.code) throw new UserError("Not in a room yet. Run `foreman init` first.")
    console.log(`Room code: ${formatCode(cfg.code)}`)
  },

  async allow(args) {
    const root = await requireRepo(process.cwd())
    const cfg = await g.readConfig(root)
    const r = await rooms<{ ok: boolean; reason?: string }>(cfg.url ?? serverUrl([]), "/api/rooms/allow", { repoId: cfg.room, login: args[0] }, cfg.key)
    if (!r.ok) throw new UserError(`Couldn't allow ${args[0]}: ${r.reason}`)
    console.log(`${args[0]} is in.`)
  },

  async "install-extension"() {
    linkExtension(path.resolve(import.meta.path), true)
    console.log("Foreman's VS Code extension is installed. Quit and reopen VS Code to load it.")
  },

  async leave() {
    const root = await requireRepo(process.cwd())
    const settingsFile = path.join(root, ".claude", "settings.local.json")
    if (existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify(removeHooks(JSON.parse(readFileSync(settingsFile, "utf8"))), null, 2))
    const hooksDir = await g.hooksDir(root)
    for (const h of GIT_HOOKS) {
      const f = path.join(hooksDir, h)
      if (existsSync(f) && readFileSync(f, "utf8").includes("installed by foreman")) rmSync(f)
    }
    rmSync(await g.configFile(root), { force: true })
    console.log("Left the room. Foreman's hooks are removed from this checkout.")
  },

  async status() {
    const cwd = process.cwd()
    const { url, repoId, key } = await ctx(cwd)
    const s = await call<RepoState>(url, "/api/status", { repoId }, key)
    const locks = Object.values(s.locks ?? {})
    if (!locks.length) console.log("No locks.")
    for (const l of locks) {
      const q = (s.queues?.[l.key] ?? []).map(w => w.agent.label)
      console.log(`${describe(l.key)} — ${l.holder.label}${q.length ? `, waiting: ${q.join(", ")}` : ""}`)
    }
  },
}

/** After an edit: if a function's name or parameters changed, tell the room who calls it. */
async function reportSignatureChanges(input: any) {
  const raw = input.tool_input?.file_path
  if (!["Edit", "MultiEdit", "Write"].includes(input.tool_name) || typeof raw !== "string") return
  const root = await g.worktreeRoot(input.cwd)
  if (!root) return
  const absPath = real(path.resolve(input.cwd, raw))
  const file = path.relative(real(root), absPath).split(path.sep).join("/")
  const before = await g.takeBefore(root, file)
  if (!before || !existsSync(absPath)) return
  const changed = signatureChanges(file, before, readFileSync(absPath, "utf8"))
  if (!changed.length) return
  const sources = await g.codeSources(root)
  const { url, repoId, key } = await ctx(root)
  const agent = (await g.readAgent(root)) ?? agentFor(input.session_id, await g.userName(root))
  for (const name of changed)
    await call(url, "/api/signature", { repoId, agent, key: `${file}#${name}`, callers: callersOf(name.split(".").pop()!, sources) }, key)
}

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function requireRepo(cwd: string) {
  const root = await g.worktreeRoot(cwd)
  if (!root) throw new UserError("Not a git repo. Run this inside your clone of the project.")
  return root
}

class UserError extends Error {}

const DEFAULT_SERVER = process.env.FOREMAN_DEFAULT_URL || "https://foreman.rishikhesh.com"
const POLL_MS = Number(process.env.FOREMAN_POLL_MS ?? 2000)
const serverUrl = (args: string[]) => (flag(args, "--url") ?? (process.env.FOREMAN_URL || DEFAULT_SERVER)).replace(/\/$/, "")
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
/** Your room key: made on this laptop; the server only ever sees its SHA-256. */
const newKey = () => randomBytes(32).toString("hex")

/** Onboarding calls: readable errors instead of failing open. */
async function rooms<T>(url: string, route: string, body: object, key?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(new URL(route, url), { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), headers: key ? { authorization: `Bearer ${key}` } : {} })
  } catch {
    throw new UserError(`Can't reach the Foreman server at ${url}. Is it running?`)
  }
  if (!res.ok) throw new UserError((await res.text()) || `${route} failed (${res.status})`)
  return (await res.json()) as T
}

/** A GitHub token to prove who you are: --dev <name> (demo, this laptop only), FOREMAN_GITHUB_TOKEN (VS Code passes it), or the GitHub CLI. */
async function signIn(args: string[]): Promise<string> {
  const dev = flag(args, "--dev")
  if (dev) return `dev:${dev}`
  if (process.env.FOREMAN_GITHUB_TOKEN) return process.env.FOREMAN_GITHUB_TOKEN
  try {
    const r = Bun.spawnSync(["gh", "auth", "token"])
    const token = r.stdout.toString().trim()
    if (r.exitCode === 0 && token) return token
  } catch {}
  throw new UserError("Sign in with GitHub first: use Start a room / Join a room in the Foreman sidebar in VS Code, or install the GitHub CLI and run `gh auth login`.")
}

/** Claude Code hooks (this checkout) and git hooks (all worktrees), plus the VS Code extension. */
function installHooks(root: string) {
  const cli = path.resolve(import.meta.path)
  const settingsFile = path.join(root, ".claude", "settings.local.json")
  mkdirSync(path.dirname(settingsFile), { recursive: true })
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {}
  writeFileSync(settingsFile, JSON.stringify(mergeHooks(settings, cli), null, 2))
  const hooksDir = Bun.spawnSync(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-path", "hooks"]).stdout.toString().trim()
  mkdirSync(hooksDir, { recursive: true })
  for (const h of GIT_HOOKS) {
    const f = path.join(hooksDir, h)
    if (existsSync(f) && !readFileSync(f, "utf8").includes("installed by foreman")) {
      console.error(`foreman: ${f} already exists and isn't ours; add \`bun ${cli} git ${h}\` to it yourself.`)
      continue
    }
    writeFileSync(f, gitHookScript(cli, h))
    chmodSync(f, 0o755)
  }
  if (linkExtension(cli)) console.log("Foreman's VS Code extension is installed. Quit and reopen VS Code once to load it.")
}

/** Link this repo's VS Code extension into ~/.vscode/extensions (no packaging). Returns true when it was newly linked. */
function linkExtension(cli: string, force = false): boolean {
  const target = path.join(path.dirname(cli), "..", "vscode-ext")
  const dir = path.join(process.env.HOME ?? os.homedir(), ".vscode", "extensions")
  const link = path.join(dir, "foreman.foreman-dev")
  try {
    if (existsSync(link) && realpathSync(link) === realpathSync(target)) return force
    mkdirSync(dir, { recursive: true })
    rmSync(link, { force: true })
    symlinkSync(realpathSync(target), link)
    return true
  } catch (e) {
    console.error(`foreman: couldn't install the VS Code extension (${(e as Error).message}); link ${target} into ${dir} yourself.`)
    return false
  }
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
    if (e instanceof UserError) {
      console.error(e.message)
      return 1
    }
    if (e instanceof Unreachable && (name === "init" || name === "join")) {
      console.error(`Can't reach the Foreman server (${e.message}). Is it running?`)
      return 1
    }
    if (e instanceof Unreachable) {
      console.error(`foreman: server unreachable, allowing (${e.message})`)
      return 0
    }
    throw e
  }
}

process.exit(await main())

import { execFile, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"
import { formatCode, normalizeCode } from "../../cli/code.js"
import { shareUrl, teammateMessage } from "../../cli/share.js"
import { functionsIn } from "../../src/core/symbols.js"
import type { AgentRef, RepoState } from "../../src/core/types.js"
import { callerWarnings, COLOR_HEX, cursorsInFile, gitDirOf, lensText, newHandoffs, newRequests, pendingRequests, rangesForLocks, statusText } from "./view.js"

interface Config { url: string; room: string; code?: string; key: string; login?: string; color: string }

let state: RepoState | null = null
let hot: { key: string; waits: number }[] = []
let config: Config | null = null
let root = ""
let cli = ""
const changed = new vscode.EventEmitter<void>()

const configFile = () => path.join(gitDirOf(root, p => existsSync(p) && statSync(p).isFile(), p => readFileSync(p, "utf8")), "foreman.json")

function readConfig(): Config | null {
  if (!root || !existsSync(configFile())) return null
  const c = JSON.parse(readFileSync(configFile(), "utf8"))
  return c.key && c.room ? c : null
}

const serverUrl = () => (vscode.workspace.getConfiguration("foreman").get<string>("serverUrl") || "https://foreman.rishikhesh.com").replace(/\/$/, "")

/** Authenticated call to the room's server with this person's room key. */
async function api<T>(route: string, body: object = {}): Promise<T> {
  if (!config) throw new Error("not in a room")
  const r = await fetch(`${config.url}${route}`, { method: "POST", body: JSON.stringify({ repoId: config.room, ...body }), headers: { authorization: `Bearer ${config.key}` } })
  if (!r.ok) throw new Error((await r.text()) || `${route} ${r.status}`)
  return (await r.json()) as T
}

const isHost = () => !!(state && config?.login && state.access?.[config.login]?.role === "host")

const myAgents = () => (state && config?.login ? Object.values(state.members).filter(a => a.label === `claude@${config!.login}`).map(a => a.id) : [])
const relPath = (doc: vscode.TextDocument) => path.relative(root, doc.uri.fsPath).split(path.sep).join("/")
const hex = (a: AgentRef) => COLOR_HEX[a.color ?? ""] ?? "#888780"

// ---------- live connection ----------

let socket: WebSocket | undefined
let poll: ReturnType<typeof setInterval> | undefined
let retry = 1000

function setState(next: RepoState | null) {
  const prev = state
  state = next
  if (next) for (const h of newHandoffs(prev, next, myAgents())) announceHandoff(h)
  if (next) announceSignatureChanges(prev, next)
  if (next && isHost()) for (const r of newRequests(prev, next)) askToAllow(r)
  changed.fire()
}

async function connect() {
  socket?.close()
  clearInterval(poll)
  config = readConfig()
  if (!config) return setState(null)
  try {
    if (typeof WebSocket === "undefined") throw new Error("no WebSocket")
    // the Foreman server relays Terse's socket, so this works from any laptop that can reach the server
    const ws = new WebSocket(`${config.url.replace(/^http/, "ws")}/live?repo=${encodeURIComponent(config.room)}&key=${config.key}`)
    socket = ws
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data))
      if (m.type === "state") setState(m.state.state)
      else if (m.type === "state_update" && m.changes.state) setState(m.changes.state)
      retry = 1000
    }
    ws.onclose = () => {
      if (socket !== ws) return
      setState(null)
      setTimeout(connect, (retry = Math.min(retry * 2, 30_000)))
    }
  } catch {
    // ponytail: polling fallback for editors without a global WebSocket
    poll = setInterval(async () => {
      try {
        setState(await api<RepoState>("/api/status"))
      } catch {
        setState(null)
      }
    }, 1000)
  }
}

// ---------- editor decorations ----------

const lockStyles = new Map<string, vscode.TextEditorDecorationType>()
const cursorStyles = new Map<string, vscode.TextEditorDecorationType>()
const style = (cache: Map<string, vscode.TextEditorDecorationType>, color: string, make: (c: string) => vscode.DecorationRenderOptions) => {
  if (!cache.has(color)) cache.set(color, vscode.window.createTextEditorDecorationType(make(color)))
  return cache.get(color)!
}

function decorate(editor: vscode.TextEditor) {
  const file = relPath(editor.document)
  const locks = new Map<string, vscode.DecorationOptions[]>()
  const cursors = new Map<string, vscode.DecorationOptions[]>()
  if (state) {
    const now = Date.now()
    for (const r of rangesForLocks(state, file, editor.document.getText())) {
      const color = hex(r.holder)
      const range = new vscode.Range(r.start - 1, 0, r.end - 1, 0)
      locks.set(color, [...(locks.get(color) ?? []), { range, hoverMessage: `${r.name} is locked by ${r.holder.label}` }])
    }
    for (const c of cursorsInFile(state, file, now)) {
      const line = Math.min(c.line, editor.document.lineCount) - 1
      const color = hex(c.agent)
      cursors.set(color, [...(cursors.get(color) ?? []), { range: new vscode.Range(line, 0, line, 0), hoverMessage: `${c.agent.label} is ${c.mode === "edit" ? "editing" : "reading"} here` }])
    }
  }
  for (const color of Object.values(COLOR_HEX).concat("#888780")) {
    editor.setDecorations(style(lockStyles, color, c => ({ isWholeLine: true, backgroundColor: `${c}1f`, borderWidth: "0 0 0 3px", borderStyle: "solid", borderColor: c, overviewRulerColor: c })), locks.get(color) ?? [])
    editor.setDecorations(style(cursorStyles, color, () => ({ isWholeLine: true, backgroundColor: `${color}40`, borderWidth: "0 0 0 6px", borderStyle: "solid", borderColor: color })), cursors.get(color) ?? [])
  }
}

const warnStyle = vscode.window.createTextEditorDecorationType({
  textDecoration: "underline wavy #EF9F27",
  overviewRulerColor: "#EF9F27",
})

function decorateWarnings(editor: vscode.TextEditor) {
  if (!state) return editor.setDecorations(warnStyle, [])
  const doc = editor.document
  editor.setDecorations(
    warnStyle,
    callerWarnings(state, relPath(doc), doc.getText()).map(w => {
      const eol = doc.lineAt(w.start - 1).range.end
      return { range: new vscode.Range(w.start - 1, doc.lineAt(w.start - 1).firstNonWhitespaceCharacterIndex, w.start - 1, eol.character), hoverMessage: w.message }
    }),
  )
}

const redraw = () => vscode.window.visibleTextEditors.forEach(e => (decorate(e), decorateWarnings(e)))

// ---------- CodeLens ----------

const lenses: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: changed.event,
  provideCodeLenses(doc) {
    if (!state) return []
    const file = relPath(doc)
    const now = Date.now()
    const here = cursorsInFile(state, file, now)
    const warnings = callerWarnings(state, file, doc.getText())
    return functionsIn(file, doc.getText()).flatMap(fn => {
      const key = `${file}#${fn.name}`
      const lock = state!.locks[key]
      const waiting = (state!.queues[key] ?? []).map(w => w.agent)
      const cur = lock && here.find(c => c.agent.id === lock.holder.id && c.line >= fn.start && c.line <= fn.end)
      const at = new vscode.Range(fn.start - 1, 0, fn.start - 1, 0)
      const lenses = [new vscode.CodeLens(at, { title: lensText(lock, waiting, now, cur ? (cur.mode === "edit" ? "editing" : "reading") : undefined), command: "workbench.view.extension.foreman" })]
      for (const w of warnings.filter(w => w.name === fn.name)) lenses.push(new vscode.CodeLens(at, { title: w.message, command: "workbench.view.extension.foreman" }))
      return lenses
    })
  },
}

// ---------- sidebar ----------

type Node = { label: string; description?: string; children?: Node[]; color?: string; lockKey?: string; icon?: string; command?: string; login?: string }

const tree: vscode.TreeDataProvider<Node> = {
  onDidChangeTreeData: changed.event,
  getTreeItem(n) {
    const item = new vscode.TreeItem(n.label, n.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
    item.description = n.description
    if (n.lockKey) item.contextValue = "lock"
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon)
    if (n.command) item.command = { command: n.command, title: n.label, arguments: [n] }
    if (n.color) item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`charts.${n.color === "teal" ? "green" : n.color === "pink" ? "red" : n.color}`))
    return item
  },
  getChildren(n) {
    if (n) return n.children ?? []
    if (!config) return []
    if (!state) return [{ label: "Offline", description: config.url }]
    const people: Node[] = Object.values(state.access ?? {})
      .filter(m => m.status === "allowed")
      .map(m => ({
        label: `@${m.login}`,
        color: m.color,
        description: `${m.role === "host" ? "host · " : ""}${Object.values(state!.members).filter(a => a.label === `claude@${m.login}`).length} agent(s)`,
      }))
    const requests: Node[] = isHost() ? pendingRequests(state).map(r => ({ label: `@${r.login}`, description: `wants to join (${r.color}) · click to allow`, icon: "person-add", command: "foreman.reviewRequest", login: r.login })) : []
    const byFile = new Map<string, Node[]>()
    for (const l of Object.values(state.locks)) {
      const i = l.key.lastIndexOf("#")
      const waiting = (state.queues[l.key] ?? []).map(w => w.agent.label)
      byFile.set(l.key.slice(0, i), [...(byFile.get(l.key.slice(0, i)) ?? []), { label: l.key.slice(i + 1), description: `${l.holder.label}${waiting.length ? ` · waiting: ${waiting.join(", ")}` : ""}`, color: l.holder.color, lockKey: l.key }])
    }
    const hotNodes: Node[] = hot.map(h => ({ label: h.key.slice(h.key.lastIndexOf("#") + 1), description: `${h.key.slice(0, h.key.lastIndexOf("#"))} · waited on ${h.waits}×` }))
    return [
      { label: `Room ${config.code ? formatCode(config.code) : ""}`, description: "click to copy an invite for a teammate", icon: "key", command: "foreman.inviteTeammate" },
      ...(requests.length ? [{ label: "Requests", description: `${requests.length} waiting`, children: requests }] : []),
      { label: "People", children: people },
      ...(hotNodes.length ? [{ label: "Most fought-over", description: "consider splitting these", children: hotNodes }] : []),
      { label: "Locks", description: byFile.size ? "" : "none", children: [...byFile].map(([file, children]) => ({ label: file, children })) },
    ]
  },
}

// ---------- handoffs ----------

function announceHandoff(h: { key: string; from?: AgentRef; commit?: { sha: string; summary: string } }) {
  const name = h.key.slice(h.key.lastIndexOf("#") + 1)
  const msg = `${name} is yours now${h.from ? ` (from ${h.from.label})` : ""}. ${h.commit ? `"${h.commit.summary}" — your agent merges ${h.commit.sha.slice(0, 7)} automatically at its next step.` : "Not committed yet."}`
  const actions = h.commit ? ["Merge now"] : []
  vscode.window.showInformationMessage(msg, ...actions).then(a => a && pullCommit(h.commit!.sha))
}

/** Pop up once when someone else changes a function that code I'm holding calls. */
function announceSignatureChanges(prev: RepoState | null, next: RepoState) {
  const mine = myAgents()
  for (const [key, c] of Object.entries(next.changes ?? {})) {
    if (prev?.changes?.[key]?.at === c.at || mine.includes(c.by.id)) continue
    const affected = c.callers.filter(k => mine.includes(next.locks[k]?.holder.id ?? ""))
    if (affected.length)
      vscode.window.showWarningMessage(`${c.by.label} changed ${key.slice(key.lastIndexOf("#") + 1)}. Your agent's ${affected.map(k => k.slice(k.lastIndexOf("#") + 1)).join(", ")} calls it.`)
  }
}

function pullCommit(sha: string) {
  const t = vscode.window.createTerminal({ name: "Foreman", cwd: root })
  t.show()
  t.sendText(`git fetch origin refs/foreman/${sha} && git merge ${sha}`)
}

// ---------- joining: requests and Allow ----------

async function askToAllow(r: { login: string; color: string }) {
  const pick = await vscode.window.showInformationMessage(`@${r.login} wants to join your room (${r.color}).`, "Allow", "Decline")
  if (pick === "Allow") await api("/api/rooms/allow", { login: r.login }).catch(e => vscode.window.showErrorMessage(`Foreman: ${e.message}`))
  if (pick === "Decline") await api("/api/rooms/remove", { login: r.login }).catch(e => vscode.window.showErrorMessage(`Foreman: ${e.message}`))
}

// ---------- onboarding: GitHub sign-in, then the same CLI the hooks use ----------

const runCli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<string>((resolve, reject) =>
    execFile("bun", [cli, ...args], { cwd: root, env: { ...process.env, PATH: toolPath(), ...env } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim().split("\n").pop() || err.message)) : resolve(stdout),
    ),
  )

/** VS Code's built-in GitHub sign-in (username only); the token goes to our server once and is never stored. */
const githubToken = async () => (await vscode.authentication.getSession("github", ["read:user"], { createIfNone: true })).accessToken

const pickColor = (taken: string[] = []) =>
  vscode.window.showQuickPick(
    Object.keys(COLOR_HEX).filter(c => !taken.includes(c)),
    { placeHolder: "Pick your colour" },
  )

// ---------- hosting: Terse + Foreman server + your Cloudflare tunnel, started on demand and left running ----------

const LOCAL = "http://127.0.0.1:7300"
const home = () => path.resolve(path.dirname(cli), "..")
const toolPath = () => [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".bun", "bin")].join(":")

async function reachable(url: string, healthPath = "/api/health") {
  try {
    await fetch(url + healthPath, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}
async function healthy(url: string) {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) })).ok
  } catch {
    return false
  }
}
async function waitFor(check: () => Promise<boolean>, ms: number) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 1000))) if (await check()) return true
  return false
}

/** Start a long-running process that outlives this window; output goes to .foreman-logs/<name>.log. */
function launch(name: string, cmd: string, args: string[]) {
  const dir = path.join(home(), ".foreman-logs")
  mkdirSync(dir, { recursive: true })
  const out = openSync(path.join(dir, `${name}.log`), "w")
  spawn(cmd, args, { cwd: home(), detached: true, stdio: ["ignore", out, out], env: { ...process.env, PATH: toolPath() } }).unref()
}

/** Make sure the room server answers at `url`; on the host's laptop, start Terse, the server and the named tunnel as needed. */
async function ensureServer(url: string, progress: (m: string) => void) {
  if (await healthy(url)) return
  if (!(await healthy(LOCAL))) {
    if (!(await reachable("http://127.0.0.1:7111", "/"))) {
      progress("Starting Terse (durable actors)…")
      launch("terse", "bun", ["run", "dev"])
      if (!(await waitFor(() => reachable("http://127.0.0.1:7111", "/"), 120_000))) throw new Error("Terse didn't start; see .foreman-logs/terse.log")
    }
    progress("Starting the Foreman server…")
    launch("server", "bun", ["src/server.ts"])
    if (!(await waitFor(() => healthy(LOCAL), 60_000))) throw new Error("The Foreman server didn't start; see .foreman-logs/server.log")
  }
  if (url === LOCAL || (await healthy(url))) return
  if (!existsSync(path.join(os.homedir(), ".cloudflared", "config.yml"))) throw new Error(`${url} isn't reachable, and there's no Cloudflare tunnel set up on this laptop.`)
  progress(`Opening ${url}…`)
  launch("tunnel", "cloudflared", ["tunnel", "--no-autoupdate", "run", "foreman"])
  if (!(await waitFor(() => healthy(url), 60_000))) throw new Error(`${url} didn't come up; see .foreman-logs/tunnel.log`)
}

async function originUrl() {
  return new Promise<string>(res => execFile("git", ["remote", "get-url", "origin"], { cwd: root }, (_e, out) => res(String(out).trim())))
}

async function inviteTeammate() {
  config = readConfig()
  if (!config?.code) return vscode.window.showWarningMessage("Start a room first.")
  const origin = await originUrl()
  const msg = teammateMessage({ host: config.login ?? "Your teammate", cloneUrl: origin ? shareUrl(origin) : "<your repo URL>", code: config.code })
  await vscode.env.clipboard.writeText(msg)
  const choice = await vscode.window.showInformationMessage(`Invite copied (room code ${formatCode(config.code)}). Paste it to your teammate.`, "Show message")
  if (choice) vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: msg, language: "markdown" }))
}

async function createRoom() {
  if (!root) return vscode.window.showErrorMessage("Open your project folder first.")
  try {
    const token = await githubToken()
    const color = await pickColor()
    if (!color) return
    const url = serverUrl()
    let out = ""
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Foreman" }, async p => {
      const progress = (message: string) => p.report({ message })
      await ensureServer(url, progress)
      progress("Creating your room…")
      out = await runCli(["init", "--url", url, "--color", color], { FOREMAN_GITHUB_TOKEN: token })
    })
    connect()
    const code = out.match(/Room code: (\S+)/)?.[1] ?? "?"
    const pick = await vscode.window.showInformationMessage(`Room code: ${code}. Send it to your teammate; you'll get an Allow button when they ask to join.`, "Copy code", "Copy full invite")
    if (pick === "Copy code") await vscode.env.clipboard.writeText(code)
    if (pick === "Copy full invite") await inviteTeammate()
  } catch (e) {
    vscode.window.showErrorMessage(`Foreman: ${(e as Error).message}`)
  }
}

async function joinRoom() {
  if (!root) return vscode.window.showErrorMessage("Open your clone of the project first.")
  try {
    const token = await githubToken()
    const raw = await vscode.window.showInputBox({ prompt: "Room code from your teammate", placeHolder: "K7QM-2XPA", validateInput: v => (normalizeCode(v) ? null : "Codes look like K7QM-2XPA") })
    const code = raw && normalizeCode(raw)
    if (!code) return
    const url = serverUrl()
    const peek = await fetch(`${url}/api/rooms/peek`, { method: "POST", body: JSON.stringify({ code }) })
    if (!peek.ok) throw new Error(await peek.text())
    const room = (await peek.json()) as { host: string; taken: string[] }
    const color = await pickColor(room.taken)
    if (!color) return
    await runCli(["join", code, "--url", url, "--color", color, "--no-wait"], { FOREMAN_GITHUB_TOKEN: token })
    config = readConfig()
    const me = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Waiting for @${room.host} to let you in…`, cancellable: true },
      async (_p, cancel) => {
        while (!cancel.isCancellationRequested) {
          const m = await api<{ login: string; status: string; color: string }>("/api/me").catch(() => null)
          if (!m) throw new Error(`@${room.host} didn't let you in.`)
          if (m.status === "allowed") return m
          await new Promise(r => setTimeout(r, 2000))
        }
        return null
      },
    )
    if (!me) return
    writeFileSync(configFile(), JSON.stringify({ ...readConfig(), login: me.login, color: me.color }, null, 2))
    connect()
    vscode.window.showInformationMessage(`You're in as @${me.login} (${me.color}). Start Claude Code in this folder.`)
  } catch (e) {
    vscode.window.showErrorMessage(`Foreman: ${(e as Error).message}`)
  }
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext) {
  root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  cli = path.join(realpathSync(context.extensionPath), "..", "cli", "foreman.ts")
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  status.command = "workbench.view.extension.foreman"
  status.show()
  changed.event(() => {
    status.text = config ? statusText(state) : "$(organization) Foreman · not in a room"
    redraw()
  })
  context.subscriptions.push(
    status,
    vscode.window.onDidChangeVisibleTextEditors(redraw),
    vscode.workspace.onDidChangeTextDocument(e => vscode.window.visibleTextEditors.filter(ed => ed.document === e.document).forEach(decorate)),
    vscode.languages.registerCodeLensProvider([{ language: "typescript" }, { language: "javascript" }, { language: "typescriptreact" }, { language: "javascriptreact" }], lenses),
    vscode.window.registerTreeDataProvider("foreman.room", tree),
    vscode.commands.registerCommand("foreman.createRoom", createRoom),
    vscode.commands.registerCommand("foreman.joinRoom", joinRoom),
    vscode.commands.registerCommand("foreman.inviteTeammate", inviteTeammate),
    vscode.commands.registerCommand("foreman.copyInvite", async () => {
      if (!config?.code) return vscode.window.showWarningMessage("Not in a room you started.")
      await vscode.env.clipboard.writeText(formatCode(config.code))
      vscode.window.showInformationMessage(`Room code ${formatCode(config.code)} copied.`)
    }),
    vscode.commands.registerCommand("foreman.reviewRequest", (n: Node) => n?.login && askToAllow({ login: n.login, color: state?.access?.[n.login]?.color ?? "" })),
    vscode.commands.registerCommand("foreman.leaveRoom", async () => {
      await runCli(["leave"]).catch(e => vscode.window.showErrorMessage(`Foreman: ${e.message}`))
      connect()
    }),
    vscode.commands.registerCommand("foreman.revoke", async (n: Node) => {
      if (!config || !n?.lockKey) return
      await api("/api/revoke", { key: n.lockKey }).catch(e => vscode.window.showErrorMessage(`Foreman: ${e.message}`))
    }),
    vscode.commands.registerCommand("foreman.pullCommit", async () => {
      const sha = await vscode.window.showInputBox({ prompt: "Commit SHA to pull" })
      if (sha) pullCommit(sha)
    }),
    vscode.commands.registerCommand("foreman.reload", () => {
      execFile("git", ["pull", "--ff-only"], { cwd: path.dirname(cli) }, () => vscode.commands.executeCommand("workbench.action.reloadWindow"))
    }),
    { dispose: () => (socket?.close(), clearInterval(poll)) },
  )
  const refreshHot = async () => {
    if (!config) return
    try {
      hot = await api<typeof hot>("/api/hot")
      changed.fire()
    } catch {}
  }
  const hotTimer = setInterval(refreshHot, 10_000)
  context.subscriptions.push({ dispose: () => clearInterval(hotTimer) })
  // cursors fade after 30s without new events, so repaint periodically
  const fade = setInterval(redraw, 5000)
  context.subscriptions.push({ dispose: () => clearInterval(fade) })
  changed.fire()
  connect()
}

export function deactivate() {
  socket?.close()
}

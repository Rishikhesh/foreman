import { execFile } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import * as vscode from "vscode"
import { decodeInvite, encodeInvite } from "../../cli/onboard.js"
import { functionsIn } from "../../src/core/symbols.js"
import type { AgentRef, RepoState } from "../../src/core/types.js"
import { callerWarnings, COLOR_HEX, cursorsInFile, freeColors, gitDirOf, lensText, newHandoffs, rangesForLocks, statusText } from "./view.js"

interface Config { url: string; repoId: string; name: string; color: string }

let state: RepoState | null = null
let hot: { key: string; waits: number }[] = []
let config: Config | null = null
let root = ""
let cli = ""
const changed = new vscode.EventEmitter<void>()

function readConfig(): Config | null {
  const gitDir = gitDirOf(root, p => existsSync(p) && statSync(p).isFile(), p => readFileSync(p, "utf8"))
  const f = path.join(gitDir, "foreman.json")
  if (!existsSync(f)) return null
  const c = JSON.parse(readFileSync(f, "utf8"))
  const override = vscode.workspace.getConfiguration("foreman").get<string>("serverUrl")
  return { ...c, url: override || c.url }
}

const myAgents = () => (state && config ? Object.values(state.members).filter(a => a.label === `claude@${config!.name}`).map(a => a.id) : [])
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
  changed.fire()
}

async function connect() {
  socket?.close()
  clearInterval(poll)
  config = readConfig()
  if (!config) return setState(null)
  try {
    if (typeof WebSocket === "undefined") throw new Error("no WebSocket")
    const { websocketUrl } = (await (await fetch(`${config.url}/grant?repo=${config.repoId}`)).json()) as { websocketUrl: string }
    const ws = new WebSocket(websocketUrl)
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
        const r = await fetch(`${config!.url}/api/status`, { method: "POST", body: JSON.stringify({ repoId: config!.repoId }) })
        setState((await r.json()) as RepoState)
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

type Node = { label: string; description?: string; children?: Node[]; color?: string; lockKey?: string }

const tree: vscode.TreeDataProvider<Node> = {
  onDidChangeTreeData: changed.event,
  getTreeItem(n) {
    const item = new vscode.TreeItem(n.label, n.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
    item.description = n.description
    if (n.lockKey) item.contextValue = "lock"
    if (n.color) item.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(`charts.${n.color === "teal" ? "green" : n.color === "pink" ? "red" : n.color}`))
    return item
  },
  getChildren(n) {
    if (n) return n.children ?? []
    if (!config) return []
    if (!state) return [{ label: "Offline", description: config.url }]
    const people: Node[] = Object.values(state.people ?? {}).map(p => ({
      label: p.name,
      color: p.color,
      description: Object.values(state!.members).filter(a => a.label === `claude@${p.name}`).length + " agent(s)",
    }))
    const byFile = new Map<string, Node[]>()
    for (const l of Object.values(state.locks)) {
      const i = l.key.lastIndexOf("#")
      const waiting = (state.queues[l.key] ?? []).map(w => w.agent.label)
      byFile.set(l.key.slice(0, i), [...(byFile.get(l.key.slice(0, i)) ?? []), { label: l.key.slice(i + 1), description: `${l.holder.label}${waiting.length ? ` · waiting: ${waiting.join(", ")}` : ""}`, color: l.holder.color, lockKey: l.key }])
    }
    const hotNodes: Node[] = hot.map(h => ({ label: h.key.slice(h.key.lastIndexOf("#") + 1), description: `${h.key.slice(0, h.key.lastIndexOf("#"))} · waited on ${h.waits}×` }))
    return [
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

// ---------- onboarding (runs the same CLI the hooks use) ----------

const runCli = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile("bun", [cli, ...args], { cwd: root }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))),
  )

async function pickPerson(url: string, repoId: string) {
  const name = await vscode.window.showInputBox({ prompt: "Your name in the room", value: process.env.USER ?? "" })
  if (!name) return
  let colors = Object.keys(COLOR_HEX)
  try {
    const s = (await (await fetch(`${url}/api/status`, { method: "POST", body: JSON.stringify({ repoId }) })).json()) as RepoState
    colors = freeColors(s, name.toLowerCase())
  } catch {}
  const color = await vscode.window.showQuickPick(colors, { placeHolder: "Your colour" })
  return color ? { name, color } : undefined
}

async function createRoom() {
  const url = await vscode.window.showInputBox({ prompt: "Foreman server URL (use your LAN IP so teammates can reach it)", value: "http://127.0.0.1:7300" })
  if (!url) return
  const who = await pickPerson(url, "")
  if (!who) return
  try {
    const out = await runCli(["init", "--url", url, "--name", who.name, "--color", who.color])
    const code = out.match(/foreman join (fm_\S+)/)?.[1]
    if (code) await vscode.env.clipboard.writeText(code)
    vscode.window.showInformationMessage(`Room ready. Invite copied to your clipboard; send it to your teammate privately.`)
    connect()
  } catch (e) {
    vscode.window.showErrorMessage(`Foreman: ${(e as Error).message}`)
  }
}

async function joinRoom() {
  const code = await vscode.window.showInputBox({ prompt: "Paste the invite (fm_…)" })
  if (!code) return
  let invite
  try {
    invite = decodeInvite(code.trim())
  } catch {
    return vscode.window.showErrorMessage("That isn't a Foreman invite.")
  }
  const who = await pickPerson(invite.url, invite.repoId)
  if (!who) return
  try {
    await runCli(["join", code.trim(), "--name", who.name, "--color", who.color])
    vscode.window.showInformationMessage(`Joined as ${who.name} (${who.color}). Open Claude Code in this repo and your agent appears here.`)
    connect()
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
    vscode.commands.registerCommand("foreman.copyInvite", async () => {
      if (!config) return vscode.window.showWarningMessage("Not in a room yet.")
      await vscode.env.clipboard.writeText(encodeInvite({ url: config.url, repoId: config.repoId }))
      vscode.window.showInformationMessage("Invite copied.")
    }),
    vscode.commands.registerCommand("foreman.leaveRoom", async () => {
      await runCli(["leave"]).catch(e => vscode.window.showErrorMessage(`Foreman: ${e.message}`))
      connect()
    }),
    vscode.commands.registerCommand("foreman.revoke", async (n: Node) => {
      if (!config || !n?.lockKey) return
      await fetch(`${config.url}/api/revoke`, { method: "POST", body: JSON.stringify({ repoId: config.repoId, key: n.lockKey }) })
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
      hot = (await (await fetch(`${config.url}/api/hot`, { method: "POST", body: JSON.stringify({ repoId: config.repoId }) })).json()) as typeof hot
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

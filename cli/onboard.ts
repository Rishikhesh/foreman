export const COLORS = ["blue", "orange", "green", "purple", "pink", "teal"]

export interface Invite { url: string; repoId: string }

export const encodeInvite = (inv: Invite) => "fm_" + Buffer.from(JSON.stringify(inv)).toString("base64url")

export function decodeInvite(code: string): Invite {
  try {
    const inv = JSON.parse(Buffer.from(code.replace(/^fm_/, ""), "base64url").toString())
    if (typeof inv.url === "string" && typeof inv.repoId === "string") return { url: inv.url, repoId: inv.repoId }
  } catch {}
  throw new Error("invalid invite code")
}

type Settings = Record<string, any> & { hooks?: Record<string, any[]> }

const isOurs = (entry: any) => entry.hooks?.some((h: any) => /foreman\.ts hook /.test(h.command ?? ""))

/** Settings with Foreman's hooks taken out; empty events are dropped. */
export function removeHooks(settings: Settings): Settings {
  const hooks: Record<string, any[]> = {}
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const kept = entries.filter(e => !isOurs(e))
    if (kept.length) hooks[event] = kept
  }
  return { ...settings, hooks }
}

/** Claude Code settings with Foreman's hooks added once; the user's other settings and hooks are kept. */
export function mergeHooks(settings: Settings, cli: string): Settings & { hooks: Record<string, any[]> } {
  const cmd = (sub: string) => `bun ${cli} hook ${sub}`
  const ours: Record<string, any> = {
    PreToolUse: { matcher: "Edit|Write|MultiEdit|NotebookEdit|Read", hooks: [{ type: "command", command: cmd("pre-tool") }] },
    PostToolUse: { matcher: ".*", hooks: [{ type: "command", command: cmd("post-tool") }] },
    UserPromptSubmit: { hooks: [{ type: "command", command: cmd("prompt") }] },
    Stop: { hooks: [{ type: "command", command: cmd("stop"), timeout: 600 }] },
    SessionEnd: { hooks: [{ type: "command", command: cmd("session-end") }] },
  }
  const hooks: Record<string, any[]> = { ...settings.hooks }
  for (const [event, entry] of Object.entries(ours)) hooks[event] = [entry, ...(hooks[event] ?? []).filter(e => !isOurs(e))]
  return { ...settings, hooks }
}

export const GIT_HOOKS = ["post-commit", "pre-commit", "post-merge"] as const
export const gitHookScript = (cli: string, name: (typeof GIT_HOOKS)[number]) => `#!/bin/sh\n# installed by foreman\nexec bun ${cli} git ${name}\n`

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { AgentRelay } from "@agent-relay/sdk"
import type { FEvent, LockKey } from "./core/types.js"

const describe = (key: LockKey) => {
  const i = key.lastIndexOf("#")
  const sym = key.slice(i + 1)
  const file = key.slice(0, i)
  return sym === "<top>" ? `the top of ${file}` : sym === "<file>" ? file : `${sym} in ${file}`
}

export function formatEvent(e: FEvent): string {
  const who = e.agent.label
  const what = e.key ? describe(e.key) : ""
  switch (e.type) {
    case "joined": return `${who} joined the room (${e.agent.color})`
    case "claimed": return `${who} locked ${what}`
    case "blocked": return `${who} is waiting for ${what}`
    case "released": return e.sha ? `${who} committed ${e.sha} and released ${what}` : `${who} released ${what}`
    case "granted": return `${what} handed from ${who} to ${e.to?.label}${e.sha ? ` with ${e.sha}` : " (uncommitted)"}`
    case "expired": return `${who}'s lock on ${what} expired after being idle`
    case "left": return `${who} left`
    case "signature": return `${who} changed the name or parameters of ${what}; callers were warned`
    case "revoked": return `${who}'s lock on ${what} was revoked`
  }
}

export interface Channel {
  post(text: string): Promise<string>
  reply(messageId: string, text: string): Promise<string>
}

/** onEvents handler: one channel line per event; everything about a function threads under the message that announced its lock. */
export function relaySink(channel: Channel) {
  // ponytail: thread map is in memory; a server restart starts new threads
  const threads = new Map<string, string>()
  return async (repoId: string, events: FEvent[]) => {
    for (const e of events) {
      try {
        const text = formatEvent(e)
        const thread = e.key && threads.get(`${repoId}:${e.key}`)
        const id = thread ? await channel.reply(thread, text) : await channel.post(text)
        if (e.key && e.type === "claimed") threads.set(`${repoId}:${e.key}`, id)
      } catch (err) {
        console.warn("relay:", (err as Error).message)
      }
    }
  }
}

const KEY_FILE = ".foreman-relay.json"

/** Connect to Relay as `foreman` in channel #foreman, creating a hosted workspace on first run. */
export async function connectRelay(): Promise<Channel> {
  const saved: { workspaceKey?: string; agentToken?: string } = existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, "utf8")) : {}
  const workspaceKey = process.env.RELAY_WORKSPACE_KEY ?? saved.workspaceKey
  const relay = workspaceKey ? new AgentRelay({ workspaceKey }) : await AgentRelay.createWorkspace({ name: "foreman" })
  let me
  if (saved.agentToken && workspaceKey === saved.workspaceKey) me = await relay.workspace.reconnect({ apiToken: saved.agentToken })
  else {
    // Relay names are create-only, so the token must be kept to come back as `foreman`
    me = await relay.workspace.register({ name: "foreman", type: "agent" })
    writeFileSync(KEY_FILE, JSON.stringify({ workspaceKey: relay.workspaceKey, agentToken: (me as any).token }))
    await me.channels.create({ name: "foreman", topic: "Locks, handoffs and joins from Foreman" }).catch(() => {})
    await me.channels.join("foreman").catch(() => {})
    console.log(`relay: workspace ready; key saved to ${KEY_FILE} (keep it private)`)
  }
  return {
    post: async text => (await me.sendMessage({ to: "#foreman", text })).messageId,
    reply: async (messageId, text) => (await me.reply({ messageId, text })).messageId,
  }
}

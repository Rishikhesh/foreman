import { actors } from "../generated/index.js"
import type { FEvent } from "./core/types.js"

export interface ServerOptions {
  port?: number
  /** Called after every call that produced events; Relay and history hang off this. */
  onEvents?: (repoId: string, events: FEvent[]) => Promise<void>
}

type Body = Record<string, any>
const repo = (b: Body) => actors.RepoActor.get(String(b.repoId))

const routes: Record<string, (b: Body) => Promise<{ value: unknown; events?: FEvent[] }>> = {
  "/api/claim": b => repo(b).claim(b.agent, b.keys, b.task),
  "/api/release": b => repo(b).releaseFiles(b.agent, b.files, b.commit),
  "/api/release-all": b => repo(b).releaseAll(b.agent),
  "/api/touch": b => repo(b).touch(b.agent, b.file, b.line ?? null, b.mode),
  "/api/join": b => repo(b).join(b.person),
  "/api/notices": b => repo(b).takeNotices(b.agentId),
  "/api/waiting": async b => ({ value: { waiting: await repo(b).isWaiting(b.agentId) } }),
  "/api/status": async b => ({ value: await repo(b).status() }),
}

export function startServer({ port = Number(process.env.FOREMAN_PORT ?? 7300), onEvents }: ServerOptions = {}) {
  // Relay is slow (seconds per post): deliver events in the background, one batch after another
  let outbox = Promise.resolve()
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === "/api/health") return new Response("ok")
      const route = routes[pathname]
      if (!route || req.method !== "POST") return new Response("not found", { status: 404 })
      let body: Body
      try {
        body = await req.json()
      } catch {
        return new Response("bad json", { status: 400 })
      }
      if (!body.repoId) return new Response("repoId required", { status: 400 })
      const { value, events = [] } = await route(body)
      if (events.length && onEvents) outbox = outbox.then(() => onEvents(String(body.repoId), events)).catch(e => console.warn("onEvents:", e))
      return Response.json(value)
    },
  })
}

if (import.meta.main) {
  const { connectRelay, relaySink } = await import("./relay.js")
  const onEvents = await connectRelay()
    .then(relaySink)
    .catch(e => (console.warn(`relay disabled: ${e.message}`), undefined))
  const s = startServer({ onEvents })
  console.log(`foreman server on ${s.url}${onEvents ? " (relay: #foreman)" : ""}`)
}

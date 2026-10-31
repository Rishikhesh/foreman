import { createHash } from "node:crypto"
import { actors } from "../generated/index.js"
import { formatCode, makeCode, normalizeCode } from "../cli/code.js"
import type { GitHubUser } from "./core/access.js"
import type { FEvent, Member, RepoState } from "./core/types.js"

export interface ServerOptions {
  port?: number
  /** Called after every call that produced events; Relay and history hang off this. */
  onEvents?: (repoId: string, events: FEvent[]) => Promise<void>
  /** Most fought-over functions for a room, from history (Supabase). */
  hot?: (repoId: string) => Promise<{ key: string; waits: number }[]>
  /** Who a GitHub token belongs to (null if invalid). Defaults to asking api.github.com. */
  github?: (token: string) => Promise<GitHubUser | null>
  /** Tests of lock behaviour only: skip room keys. */
  auth?: boolean
}

type Body = Record<string, any>
type Who = Pick<Member, "login" | "role" | "status" | "color">
const room = (id: string) => actors.RepoActor.get(id)
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/** Ask GitHub who owns this token; the token is used once here and never stored. */
async function githubUser(token: string): Promise<GitHubUser | null> {
  const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, "user-agent": "foreman" } })
  if (!r.ok) return null
  const u = (await r.json()) as { login: string; id: number }
  return { login: u.login, id: u.id }
}

/** Room routes; `me` is the verified member when auth is on. The agent's name and colour always come from `me`. */
const routes: Record<string, (b: Body, me: Who | null) => Promise<{ value: unknown; events?: FEvent[] }>> = {
  "/api/claim": b => room(b.repoId).claim(b.agent, b.keys, b.task),
  "/api/release": b => room(b.repoId).releaseFiles(b.agent, b.files, b.commit),
  "/api/release-all": b => room(b.repoId).releaseAll(b.agent),
  "/api/touch": b => room(b.repoId).touch(b.agent, b.file, b.line ?? null, b.mode),
  "/api/join": b => room(b.repoId).join(b.person),
  "/api/revoke": b => room(b.repoId).revoke(b.key),
  "/api/signature": b => room(b.repoId).signatureChanged(b.agent, b.key, b.callers ?? []),
  "/api/pulled": b => room(b.repoId).pulled(b.head, b.shas ?? []),
  "/api/notices": b => room(b.repoId).takeNotices(b.agentId),
  "/api/waiting": async b => ({ value: { waiting: await room(b.repoId).isWaiting(b.agentId) } }),
  "/api/status": async b => ({ value: await room(b.repoId).status() }),
  "/api/rooms/allow": (b, me) => room(b.repoId).allow(me?.login ?? "", b.login),
  "/api/rooms/remove": (b, me) => room(b.repoId).removeMember(me?.login ?? "", b.login),
}

const fail = (status: number, msg: string) => new Response(msg, { status })

export function startServer({ port = Number(process.env.FOREMAN_PORT ?? 7300), onEvents, hot, github = githubUser, auth = true }: ServerOptions = {}) {
  // Relay is slow (seconds per post): deliver events in the background, one batch after another
  let outbox = Promise.resolve()
  const emit = (id: string, events: FEvent[] = []) => {
    if (events.length && onEvents) outbox = outbox.then(() => onEvents(id, events)).catch(e => console.warn("onEvents:", e))
  }

  /** `dev:<name>` identities are for the one-laptop demo: accepted only from this machine, never via the tunnel. */
  async function verify(token: unknown, req: Request, srv: { requestIP(r: Request): { address: string } | null }) {
    if (typeof token !== "string" || !token) return null
    if (token.startsWith("dev:")) {
      const ip = srv.requestIP(req)?.address ?? ""
      const local = !req.headers.get("cf-connecting-ip") && /^(127\.|::1$|::ffff:127\.)/.test(ip)
      return local ? { login: token.slice(4), id: 0 } : null
    }
    return github(token).catch(() => null)
  }

  async function member(roomId: string, key: string | null): Promise<Who | null> {
    if (!roomId || !key) return null
    return room(roomId).authorize(sha256(key))
  }

  return Bun.serve<{ upstream: string; socket?: WebSocket; queue: (string | Buffer)[] }>({
    port,
    hostname: "0.0.0.0",
    // /live relays the room's Terse socket, so editors only ever need to reach this server (Terse stays on localhost)
    websocket: {
      open(ws) {
        const up = new WebSocket(ws.data.upstream)
        ws.data.socket = up
        up.onopen = () => ws.data.queue.splice(0).forEach(m => up.send(m))
        up.onmessage = e => ws.send(String(e.data))
        up.onclose = () => ws.close()
        up.onerror = () => ws.close()
      },
      message(ws, msg) {
        const up = ws.data.socket
        if (up?.readyState === WebSocket.OPEN) up.send(msg)
        else ws.data.queue.push(msg)
      },
      close(ws) {
        ws.data.socket?.close()
      },
    },
    async fetch(req, srv) {
      const url = new URL(req.url)
      const { pathname } = url
      if (pathname === "/api/health") return new Response("ok")

      if (pathname === "/live") {
        const roomId = url.searchParams.get("repo") ?? ""
        // ponytail: the key rides in the query string because WebSockets can't send headers from every client
        if (auth && (await member(roomId, url.searchParams.get("key")))?.status !== "allowed") return fail(401, "room key required")
        const { websocketUrl } = await actors.RepoActor.prepareWebsocket({ actorId: roomId, metadata: {} })
        return srv.upgrade(req, { data: { upstream: websocketUrl, queue: [] } }) ? undefined : fail(400, "upgrade failed")
      }

      if (req.method !== "POST") return fail(404, "not found")
      let body: Body
      try {
        body = await req.json()
      } catch {
        return fail(400, "bad json")
      }

      // ---- rooms: create / peek / join (identity by GitHub token, no room key yet) ----
      if (pathname === "/api/rooms/create") {
        const user = await verify(body.githubToken, req, srv)
        if (!user) return fail(401, "GitHub sign-in failed")
        if (!body.repoId || !body.keyHash || !body.color) return fail(400, "repoId, color and keyHash required")
        let code = makeCode()
        while (!(await actors.RoomCode.get(code).create(`${body.repoId}-${code}`))) code = makeCode()
        const id = `${body.repoId}-${code}`
        const r = await room(id).openRoom(user, body.color, body.keyHash)
        emit(id, r.events)
        return Response.json({ room: id, code, login: user.login })
      }
      if (pathname === "/api/rooms/peek" || pathname === "/api/rooms/join") {
        const code = normalizeCode(String(body.code ?? ""))
        const id = code ? await actors.RoomCode.get(code).resolve() : null
        if (!id) return fail(404, `No room with code ${code ? formatCode(code) : body.code}. Check the code with whoever sent it.`)
        const s: RepoState = await room(id).status()
        const host = Object.values(s.access ?? {}).find(m => m.role === "host")?.login
        const repoId = id.split("-")[0]
        if (pathname === "/api/rooms/peek") return Response.json({ host, taken: Object.values(s.access ?? {}).map(m => m.color), repoId })
        const user = await verify(body.githubToken, req, srv)
        if (!user) return fail(401, "GitHub sign-in failed")
        if (body.repoId !== repoId) return fail(409, "This clone is a different repo than the room you're joining.")
        const r = await room(id).requestJoin(user, body.color, body.keyHash)
        emit(id, r.events)
        return Response.json({ ...r.value, ...(r.value.ok && { room: id }) })
      }

      // ---- everything else needs a room key ----
      if (!routes[pathname] && pathname !== "/api/me" && pathname !== "/api/hot") return fail(404, "not found")
      if (!body.repoId) return fail(400, "repoId required")
      const roomId = String(body.repoId)
      let me: Who | null = null
      if (auth) {
        me = await member(roomId, req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null)
        if (!me) return fail(401, "room key required")
        if (pathname === "/api/me") return Response.json(me)
        if (me.status !== "allowed") return fail(403, "waiting for the host to allow you")
        if (body.agent) body.agent = { id: String(body.agent.id), label: `claude@${me.login}`, color: me.color }
      }
      if (pathname === "/api/hot") return Response.json(hot ? await hot(roomId).catch(() => []) : [])
      const route = routes[pathname]
      if (!route) return fail(404, "not found")
      const { value, events } = await route(body, me)
      emit(roomId, events)
      return Response.json(value)
    },
  })
}

if (import.meta.main) {
  const { connectRelay, relaySink } = await import("./relay.js")
  const { connectHistory } = await import("./history.js")
  const relay = await connectRelay()
    .then(relaySink)
    .catch(e => (console.warn(`relay disabled: ${e.message}`), undefined))
  const history = connectHistory()
  const sinks = [relay, history?.sink].filter(Boolean) as NonNullable<ServerOptions["onEvents"]>[]
  const s = startServer({ onEvents: async (r, e) => void (await Promise.all(sinks.map(f => f(r, e)))), hot: history?.hot })
  console.log(`foreman server on ${s.url}${relay ? " · relay #foreman" : ""}${history ? " · supabase history" : " · history off (set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)"}`)
}

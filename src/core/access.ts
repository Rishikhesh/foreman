import type { FEvent, Member, RepoState, Result } from "./types.js"

export interface GitHubUser { login: string; id: number }
type Outcome = { ok: true } | { ok: false; reason: string }

const person = (m: Pick<Member, "login" | "color">) => ({ id: `person:${m.login}`, label: m.login, color: m.color })
const isHost = (s: RepoState, login: string) => s.access?.[login]?.role === "host"

/** A new room: the verified GitHub user becomes its host. */
export function openRoom(s0: RepoState, user: GitHubUser, color: string, keyHash: string): Result<Outcome> {
  if (Object.values(s0.access ?? {}).some(m => m.role === "host")) return { state: s0, events: [], value: { ok: false, reason: "room already exists" } }
  const s = structuredClone(s0)
  s.access = { [user.login]: { login: user.login, githubId: user.id, color, role: "host", status: "allowed", keyHash } }
  s.people = { ...s.people, [user.login]: { name: user.login, color } }
  return { state: s, events: [{ type: "joined", agent: person({ login: user.login, color }) }], value: { ok: true } }
}

/** Ask to join; the request waits for the host. Asking again replaces your own pending request. */
export function requestJoin(s0: RepoState, user: GitHubUser, color: string, keyHash: string): Result<{ ok: true; status: "pending" } | { ok: false; reason: string; taken?: string[] }> {
  const mine = s0.access?.[user.login]
  if (mine?.status === "allowed") return { state: s0, events: [], value: { ok: false, reason: "you are already in this room" } }
  const taken = Object.values(s0.access ?? {}).filter(m => m.login !== user.login).map(m => m.color)
  if (taken.includes(color)) return { state: s0, events: [], value: { ok: false, reason: "colour taken", taken } }
  const s = structuredClone(s0)
  s.access[user.login] = { login: user.login, githubId: user.id, color, role: "member", status: "pending", keyHash }
  const events: FEvent[] = [{ type: "join-requested", agent: person({ login: user.login, color }) }]
  return { state: s, events, value: { ok: true, status: "pending" } }
}

export function allow(s0: RepoState, by: string, login: string): Result<Outcome> {
  if (!isHost(s0, by)) return { state: s0, events: [], value: { ok: false, reason: "only the host can do that" } }
  const m = s0.access[login]
  if (!m) return { state: s0, events: [], value: { ok: false, reason: "no such request" } }
  const s = structuredClone(s0)
  s.access[login].status = "allowed"
  s.people = { ...s.people, [login]: { name: login, color: m.color } }
  return { state: s, events: [{ type: "joined", agent: person(m) }], value: { ok: true } }
}

export function removeMember(s0: RepoState, by: string, login: string): Result<Outcome> {
  if (!isHost(s0, by) || login === by) return { state: s0, events: [], value: { ok: false, reason: "only the host can do that" } }
  const m = s0.access[login]
  if (!m) return { state: s0, events: [], value: { ok: false, reason: "no such member" } }
  const s = structuredClone(s0)
  delete s.access[login]
  delete s.people[login]
  return { state: s, events: [{ type: "removed", agent: person(m) }], value: { ok: true } }
}

/** Who holds this key fingerprint, if anyone. */
export function authorize(s: RepoState, keyHash: string): Pick<Member, "login" | "role" | "status" | "color"> | null {
  const m = Object.values(s.access ?? {}).find(m => m.keyHash === keyHash)
  return m ? { login: m.login, role: m.role, status: m.status, color: m.color } : null
}

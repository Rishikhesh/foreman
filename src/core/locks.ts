import type { AgentId, AgentRef, Blocked, CommitInfo, FEvent, LockKey, Notice, Person, RepoState, Result } from "./types.js"

/** A lock is freed only after its holder has been completely idle (no hook activity at all) this long. */
export const TTL_MS = 15 * 60_000

export const emptyState = (): RepoState => ({ locks: {}, queues: {}, outbox: {}, seen: {}, members: {}, cursors: {}, people: {} })

export const fileOf = (key: LockKey) => key.slice(0, key.lastIndexOf("#"))

function notify(s: RepoState, id: AgentId, n: Notice) {
  s.outbox[id] = [...(s.outbox[id] ?? []), n]
}

/** Hand `key` to the head of its queue, or free it. Mutates the working copy `s`. */
function handOff(s: RepoState, key: LockKey, from: AgentRef, now: number, events: FEvent[], commit?: CommitInfo) {
  delete s.locks[key]
  const [next, ...rest] = s.queues[key] ?? []
  s.queues[key] = rest
  if (!next) return
  s.locks[key] = { key, holder: next.agent, since: now, touched: now, from, ...(commit && { commit }) }
  notify(s, next.agent.id, commit ? { kind: "granted", key, from, commit } : { kind: "granted", key, from, uncommitted: true })
  events.push({ type: "granted", agent: from, key, to: next.agent, ...(commit && { sha: commit.sha }) })
}

export function claim(s0: RepoState, agent: AgentRef, keys: LockKey[], now: number, task?: string): Result<{ granted: LockKey[]; blocked: Blocked[] }> {
  const s = structuredClone(s0)
  const events: FEvent[] = []
  const granted: LockKey[] = []
  const blocked: Blocked[] = []
  s.members[agent.id] = agent
  for (const key of keys) {
    const lock = s.locks[key]
    if (!lock) {
      s.locks[key] = { key, holder: agent, since: now, touched: now, ...(task && { task }) }
      granted.push(key)
      events.push({ type: "claimed", agent, key })
      for (const [id, files] of Object.entries(s.seen))
        if (id !== agent.id && files.includes(fileOf(key))) notify(s, id, { kind: "heads-up", key, by: agent })
    } else if (lock.holder.id === agent.id) {
      lock.touched = now
      granted.push(key)
    } else {
      const queue = s.queues[key] ?? []
      if (!queue.some(w => w.agent.id === agent.id)) {
        s.queues[key] = [...queue, { agent, since: now }]
        events.push({ type: "blocked", agent, key })
      }
      const position = s.queues[key].findIndex(w => w.agent.id === agent.id) + 1
      blocked.push({ key, holder: lock.holder, ...(lock.task && { task: lock.task }), position })
    }
  }
  return { state: s, events, value: { granted, blocked } }
}

export function releaseFiles(s0: RepoState, agent: AgentRef, files: string[], now: number, commit?: CommitInfo): Result<{ released: LockKey[] }> {
  const s = structuredClone(s0)
  const events: FEvent[] = []
  const released = Object.values(s.locks)
    .filter(l => l.holder.id === agent.id && files.includes(fileOf(l.key)))
    .map(l => l.key)
  for (const key of released) {
    events.push({ type: "released", agent, key, ...(commit && { sha: commit.sha }) })
    handOff(s, key, agent, now, events, commit)
  }
  return { state: s, events, value: { released } }
}

export function releaseAll(s0: RepoState, agent: AgentRef, now: number): Result<{ released: LockKey[] }> {
  const s = structuredClone(s0)
  const events: FEvent[] = [{ type: "left", agent }]
  for (const key of Object.keys(s.queues)) s.queues[key] = s.queues[key].filter(w => w.agent.id !== agent.id)
  const released = Object.values(s.locks).filter(l => l.holder.id === agent.id).map(l => l.key)
  for (const key of released) handOff(s, key, agent, now, events)
  delete s.members[agent.id]
  delete s.cursors[agent.id]
  delete s.seen[agent.id]
  return { state: s, events, value: { released } }
}

export function expire(s0: RepoState, now: number, ttlMs = TTL_MS): Result<{ expired: LockKey[] }> {
  const s = structuredClone(s0)
  const events: FEvent[] = []
  const stale = Object.values(s.locks).filter(l => l.touched + ttlMs <= now)
  for (const lock of stale) {
    notify(s, lock.holder.id, { kind: "expired", key: lock.key })
    events.push({ type: "expired", agent: lock.holder, key: lock.key })
    handOff(s, lock.key, lock.holder, now, events)
  }
  return { state: s, events, value: { expired: stale.map(l => l.key) } }
}

export function takeNotices(s0: RepoState, id: AgentId, now?: number): Result<Notice[]> {
  const s = structuredClone(s0)
  if (now !== undefined) for (const l of Object.values(s.locks)) if (l.holder.id === id) l.touched = now
  const value = s.outbox[id] ?? []
  s.outbox[id] = []
  return { state: s, events: [], value }
}

export const isWaiting = (s: RepoState, id: AgentId) => Object.values(s.queues).some(q => q.some(w => w.agent.id === id))

export function touch(s0: RepoState, agent: AgentRef, file: string, line: number | undefined, mode: "read" | "edit", now: number): Result<null> {
  const s = structuredClone(s0)
  s.members[agent.id] = agent
  s.cursors[agent.id] = { file, ...(line !== undefined && { line }), mode, at: now }
  for (const l of Object.values(s.locks)) if (l.holder.id === agent.id) l.touched = now
  if (!(s.seen[agent.id] ?? []).includes(file)) s.seen[agent.id] = [...(s.seen[agent.id] ?? []), file]
  return { state: s, events: [], value: null }
}

export function nextAlarm(s: RepoState, ttlMs = TTL_MS): number | null {
  const t = Object.values(s.locks).map(l => l.touched)
  return t.length ? Math.min(...t) + ttlMs : null
}

/** A person (not an agent) joins the room with a colour no one else holds. */
export function joinRoom(s0: RepoState, person: Person): Result<{ ok: true } | { ok: false; taken: string[] }> {
  const s = structuredClone(s0)
  s.people ??= {}
  const taken = Object.values(s.people).filter(p => p.name !== person.name).map(p => p.color)
  if (taken.includes(person.color)) return { state: s0, events: [], value: { ok: false, taken } }
  const isNew = !s.people[person.name]
  s.people[person.name] = person
  const events: FEvent[] = isNew ? [{ type: "joined", agent: { id: `person:${person.name}`, label: person.name, color: person.color } }] : []
  return { state: s, events, value: { ok: true } }
}

/** A person frees a lock from the editor; the holder is told and the next waiter gets it. */
export function revoke(s0: RepoState, key: LockKey, now: number): Result<{ revoked: boolean }> {
  const lock = s0.locks[key]
  if (!lock) return { state: s0, events: [], value: { revoked: false } }
  const s = structuredClone(s0)
  const events: FEvent[] = [{ type: "revoked", agent: lock.holder, key }]
  notify(s, lock.holder.id, { kind: "revoked", key })
  handOff(s, key, lock.holder, now, events)
  return { state: s, events, value: { revoked: true } }
}

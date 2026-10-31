import { Actor, Emittable, Persisted } from "durable-actors"
import * as core from "./core/locks.js"
import type { AgentId, AgentRef, CommitInfo, FEvent, LockKey, Person, RepoState, Result } from "./core/types.js"

const TTL = Number(process.env.FOREMAN_TTL_MS ?? core.TTL_MS)

type Out = { type: "events"; events: FEvent[] }

/** One per repo: the shared picture of who holds which function, who waits, and where every agent is. */
export class RepoActor extends Actor<Record<string, never>, never, Out> {
  @Persisted @Emittable state: RepoState = core.emptyState()

  #apply<T>(r: Result<T>): { value: T; events: FEvent[] } {
    this.state = r.state
    const next = core.nextAlarm(this.state, TTL)
    if (next === null) this.alarm.delete()
    else this.alarm.set(next)
    if (r.events.length) this.broadcast({ type: "events", events: r.events })
    return { value: r.value, events: r.events }
  }

  async claim(agent: AgentRef, keys: LockKey[], task?: string) {
    return this.#apply(core.claim(this.state, agent, keys, Date.now(), task))
  }
  async releaseFiles(agent: AgentRef, files: string[], commit?: CommitInfo) {
    return this.#apply(core.releaseFiles(this.state, agent, files, Date.now(), commit))
  }
  async releaseAll(agent: AgentRef) {
    return this.#apply(core.releaseAll(this.state, agent, Date.now()))
  }
  async touch(agent: AgentRef, file: string, line: number | null, mode: "read" | "edit") {
    return this.#apply(core.touch(this.state, agent, file, line ?? undefined, mode, Date.now()))
  }
  async join(person: Person) {
    return this.#apply(core.joinRoom(this.state, person))
  }
  async takeNotices(agentId: AgentId) {
    return this.#apply(core.takeNotices(this.state, agentId, Date.now()))
  }
  async isWaiting(agentId: AgentId): Promise<boolean> {
    return core.isWaiting(this.state, agentId)
  }
  async status(): Promise<RepoState> {
    return this.state
  }
  async onAlarm(): Promise<void> {
    this.#apply(core.expire(this.state, Date.now(), TTL))
  }
}

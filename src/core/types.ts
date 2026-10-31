export type AgentId = string
export interface AgentRef { id: AgentId; label: string; color?: string; sessionId?: string }
/** A lock key is `file#symbol`, e.g. `src/auth.ts#validateToken`; `file#<top>` covers imports and new code. */
export type LockKey = string
export interface Lock { key: LockKey; holder: AgentRef; task?: string; since: number; touched: number; from?: AgentRef; commit?: CommitInfo }
export interface Waiter { agent: AgentRef; since: number }
export interface CommitInfo { sha: string; summary: string; stat: string }
export type Notice =
  | { kind: "heads-up"; key: LockKey; by: AgentRef }
  | { kind: "granted"; key: LockKey; from?: AgentRef; commit?: CommitInfo; uncommitted?: boolean; merged?: { ok: boolean; reason?: string } }
  | { kind: "expired"; key: LockKey }
  | { kind: "revoked"; key: LockKey }
  | { kind: "signature"; key: LockKey; by: AgentRef; callers: LockKey[] }
export interface Person { name: string; color: string }
export interface Member { login: string; githubId: number; color: string; role: "host" | "member"; status: "pending" | "allowed"; keyHash: string }
export interface Cursor { file: string; line?: number; mode: "read" | "edit"; at: number }
export interface RepoState {
  locks: Record<LockKey, Lock>
  queues: Record<LockKey, Waiter[]>
  outbox: Record<AgentId, Notice[]>
  /** files each agent has read or edited, so heads-ups only go to agents that care */
  seen: Record<AgentId, string[]>
  members: Record<AgentId, AgentRef>
  cursors: Record<AgentId, Cursor>
  people: Record<string, Person>
  /** recent name/parameter changes, so editors can flag the callers */
  changes: Record<LockKey, { by: AgentRef; at: number; callers: LockKey[]; sha?: string }>
  /** who may use this room, by GitHub login; keys are stored only as SHA-256 fingerprints */
  access: Record<string, Member>
}
export type EventType = "claimed" | "blocked" | "released" | "granted" | "expired" | "left" | "joined" | "revoked" | "signature" | "join-requested" | "removed"
export interface FEvent { type: EventType; agent: AgentRef; key?: LockKey; to?: AgentRef; sha?: string }
export interface Result<T> { state: RepoState; events: FEvent[]; value: T }
export interface Blocked { key: LockKey; holder: AgentRef; task?: string; position: number }

import type { FEvent, LockKey } from "./core/types.js"

export interface Row { repo_id: string; type: string; agent_id: string; agent_label: string; key: string | null; to_label: string | null; sha: string | null }

export const toRows = (repoId: string, events: FEvent[]): Row[] =>
  events.map(e => ({
    repo_id: repoId,
    type: e.type,
    agent_id: e.agent.id,
    agent_label: e.agent.label,
    key: e.key ?? null,
    to_label: e.to?.label ?? null,
    sha: e.sha ?? null,
  }))

/** Functions people waited on most: a sign they should be split or owned by one agent. */
export function hotFunctions(rows: { key: string | null; type: string }[], limit = 5): { key: LockKey; waits: number }[] {
  const waits = new Map<string, number>()
  for (const r of rows) if (r.type === "blocked" && r.key) waits.set(r.key, (waits.get(r.key) ?? 0) + 1)
  return [...waits].map(([key, n]) => ({ key, waits: n })).sort((a, b) => b.waits - a.waits).slice(0, limit)
}

/** onEvents handler that appends every event to the history table; a database outage never reaches the agents. */
export const historySink = (insert: (rows: Row[]) => Promise<void>) => async (repoId: string, events: FEvent[]) => {
  try {
    await insert(toRows(repoId, events))
  } catch (e) {
    console.warn("history:", (e as Error).message)
  }
}

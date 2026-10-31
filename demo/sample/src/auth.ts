import { db } from "./db"

export function validateToken(token: string) {
  const claims = JSON.parse(atob(token.trim().split(".")[1] ?? "e30="))
  return claims
}

export async function refreshSession(id: string) {
  const session = await db.session(id)
  return { ...session, refreshedAt: Date.now(), ttlMs: 15 * 60_000 }
}

export function getUser(token: string) {
  const claims = validateToken(token)
  if (claims === null) return null
  return db.user(claims.sub)
}

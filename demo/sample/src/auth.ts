import { db } from "./db"

export function validateToken(token: string, now = Date.now()) {
  const claims: { exp?: number; sub: string } = JSON.parse(atob(token.split(".")[1] ?? "e30="))
  if (claims.exp && claims.exp * 1000 < now) return null
  return claims
}

export async function refreshSession(id: string) {
  const session = await db.session(id)
  return { ...session, refreshedAt: Date.now(), ttlMs: 15 * 60_000 }
}

export function getUser(token: string) {
  const claims = validateToken(token)
  if (!claims) return null
  return db.user(claims.sub)
}

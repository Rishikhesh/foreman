import { db } from "./db"

export function validateToken(token: string) {
  const claims = JSON.parse(atob(token.split(".")[1] ?? "e30="))
  if (!claims.sub) return null
  return claims
}

export async function refreshSession(id: string) {
  const session = await db.session(id)
  return { ...session, refreshedAt: Date.now() }
}

export function getUser(token: string) {
  const claims = validateToken(token)
  if (!claims) return null
  return db.user(claims.sub)
}

export async function revokeSession(id: string) {
  return { ...(await db.session(id)), revokedAt: Date.now() }
}

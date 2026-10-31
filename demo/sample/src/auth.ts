import { db } from "./db"

export function validateToken(token: string, expectedIssuer: string) {
  const claims = JSON.parse(atob(token.split(".")[1] ?? "e30="))
  if (claims.iss !== expectedIssuer) return null
  if (claims.exp * 1000 < Date.now()) return null
  if (!claims.sub) return null
  return claims
}

export async function refreshSession(id: string) {
  const session = await db.session(id)
  if (!session) throw new Error("session not found")
  return { ...session, refreshedAt: Date.now(), rotatedAt: Date.now() }
}

export function getUser(token: string) {
  const claims = validateToken(token)
  return db.user(claims.sub)
}

import { db } from "./db"

export function validateToken(token: string, expectedIssuer: string) {
  const claims = JSON.parse(atob(token.split(".")[1] ?? "e30="))
  if (claims.iss !== expectedIssuer) return null
  if (claims.exp * 1000 < Date.now()) return null
  if (!claims.sub) return null
  if (claims.role !== undefined && claims.role !== "user" && claims.role !== "admin") return null
  return claims
}

export async function refreshSession(id: string) {
  const session = await db.session(id)
  if (!session) throw new Error("session not found")
  return { ...session, refreshedAt: Date.now(), rotatedAt: Date.now() }
}

export function getUser(token: string) {
  const claims = validateToken(token, "foreman")
  if (!claims) return null
  const user = db.user(claims.sub)
  return { ...user, checkedAt: Date.now() }
}

export async function revokeSession(id: string) {
  return { ...(await db.session(id)), revokedAt: Date.now() }
}

export function sessionExpiresAt(createdAt: number) {
  return createdAt + 15 * 60_000
}

export function isAdmin(token: string) {
  return validateToken(token, "foreman")?.role === "admin"
}

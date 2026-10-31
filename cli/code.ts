import { randomInt } from "node:crypto"

/** No 0/O, 1/I/L, so codes survive being read aloud or retyped. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

export const makeCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

export function normalizeCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "")
  return c.length === 8 && [...c].every(ch => CODE_ALPHABET.includes(ch)) ? c : null
}

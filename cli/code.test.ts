import { expect, test } from "bun:test"
import { CODE_ALPHABET, formatCode, makeCode, normalizeCode } from "./code.js"

test("makeCode gives 8 unambiguous characters, shown as XXXX-XXXX (9 chars)", () => {
  const code = makeCode()
  expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`))
  expect(formatCode(code)).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  expect(formatCode(code).length).toBeLessThanOrEqual(10)
  for (const c of "01IOL") expect(CODE_ALPHABET).not.toContain(c)
  expect(new Set(Array.from({ length: 200 }, makeCode)).size).toBe(200)
})

test("normalizeCode accepts what people actually type", () => {
  expect(normalizeCode("k7qm-2xpa")).toBe("K7QM2XPA")
  expect(normalizeCode(" K7QM 2XPA ")).toBe("K7QM2XPA")
  expect(normalizeCode("K7QM2XPA")).toBe("K7QM2XPA")
  expect(normalizeCode("nope")).toBeNull()
  expect(normalizeCode("K7QM-2XP0")).toBeNull()
})

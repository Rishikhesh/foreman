import { expect, test } from "bun:test"
import { callersOf, changedLines, functionsIn, keysForEdit, keysForLines, keysForWrite, signatureChanges } from "./symbols.js"

const SRC = `import { db } from "./db.js"
import { verify } from "./jwt.js"

export function validateToken(t: string) {
  const claims = verify(t)
  return claims
}

export const refreshSession = async (id: string) => {
  return db.session(id)
}

class AuthService {
  login(u: string) {
    return validateToken(u)
  }
}
`

test("functionsIn finds functions, arrow consts and class methods with 1-based line ranges", () => {
  expect(functionsIn("src/auth.ts", SRC)).toEqual([
    { name: "validateToken", start: 4, end: 7 },
    { name: "refreshSession", start: 9, end: 11 },
    { name: "AuthService.login", start: 14, end: 16 },
  ])
})

test("an edit inside a function locks that function", () => {
  expect(keysForEdit("src/auth.ts", SRC, "  return claims")).toEqual(["src/auth.ts#validateToken"])
})

test("an edit spanning two functions locks both", () => {
  expect(keysForEdit("src/auth.ts", SRC, "  return claims\n}\n\nexport const refreshSession")).toEqual([
    "src/auth.ts#validateToken",
    "src/auth.ts#refreshSession",
  ])
})

test("an edit outside every function locks the top-of-file slot", () => {
  expect(keysForEdit("src/auth.ts", SRC, `import { verify } from "./jwt.js"`)).toEqual(["src/auth.ts#<top>"])
})

test("replace-all locks every function containing the text", () => {
  expect(keysForEdit("src/auth.ts", SRC, "return", true)).toEqual([
    "src/auth.ts#validateToken",
    "src/auth.ts#refreshSession",
    "src/auth.ts#AuthService.login",
  ])
})

test("text not found falls back to the whole file", () => {
  expect(keysForEdit("src/auth.ts", SRC, "nope")).toEqual(["src/auth.ts#<file>"])
})

test("non-code files lock the whole file", () => {
  expect(keysForEdit("README.md", "# hi\n", "# hi")).toEqual(["README.md#<file>"])
})

test("a whole-file write locks every function plus the top slot; a new file locks the top slot", () => {
  expect(keysForWrite("src/auth.ts", SRC)).toEqual([
    "src/auth.ts#<top>",
    "src/auth.ts#validateToken",
    "src/auth.ts#refreshSession",
    "src/auth.ts#AuthService.login",
  ])
  expect(keysForWrite("src/new.ts", null)).toEqual(["src/new.ts#<top>"])
})

test("signatureChanges reports renamed or re-parameterised functions, not body edits", () => {
  const body = SRC.replace("return claims", "return claims ?? null")
  expect(signatureChanges("src/auth.ts", SRC, body)).toEqual([])
  const renamed = SRC.replace("validateToken(t: string)", "checkToken(t: string)")
  expect(signatureChanges("src/auth.ts", SRC, renamed)).toEqual(["validateToken"])
  const params = SRC.replace("validateToken(t: string)", "validateToken(t: string, now: number)")
  expect(signatureChanges("src/auth.ts", SRC, params)).toEqual(["validateToken"])
})

test("changedLines reads new-side line numbers from a zero-context diff", () => {
  const diff = "diff --git a/x b/x\n@@ -5 +5,2 @@ fn\n-a\n+b\n+c\n@@ -12,3 +13,0 @@\n-x\n@@ -20 +21 @@\n-q\n+r\n"
  expect(changedLines(diff)).toEqual([5, 6, 13, 21])
})

test("keysForLines maps changed lines to the functions (or top slot) they fall in", () => {
  expect(keysForLines("src/auth.ts", SRC, [5])).toEqual(["src/auth.ts#validateToken"])
  expect(keysForLines("src/auth.ts", SRC, [1, 10, 15])).toEqual(["src/auth.ts#<top>", "src/auth.ts#refreshSession", "src/auth.ts#AuthService.login"])
  expect(keysForLines("README.md", "x", [1])).toEqual(["README.md#<file>"])
})

test("callersOf finds every function that calls a name, across files, excluding the function itself", () => {
  const sources = {
    "src/auth.ts": SRC,
    "src/login.ts": `import { validateToken } from "./auth"\n\nexport function login(t: string) {\n  return auth.validateToken(t)\n}\n\nexport const logout = () => {\n  return null\n}\n`,
    "README.md": "validateToken(x)",
  }
  expect(callersOf("validateToken", sources)).toEqual(["src/auth.ts#AuthService.login", "src/login.ts#login"])
  expect(callersOf("nobodyCallsMe", sources)).toEqual([])
})

import ts from "typescript"
import type { LockKey } from "./types.js"

export interface FnRange { name: string; start: number; end: number }

const CODE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/
const isCode = (file: string) => CODE.test(file)

/** Top-level functions, arrow/function-expression consts, and class methods, with 1-based inclusive line ranges. */
export function functionsIn(file: string, source: string): FnRange[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const range = (name: string, node: ts.Node): FnRange => ({ name, start: line(node.getStart(sf)), end: line(node.getEnd()) })
  const out: FnRange[] = []
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.push(range(st.name.text, st))
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
          out.push(range(d.name.text, st))
    } else if (ts.isClassDeclaration(st) && st.name) {
      for (const m of st.members)
        if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body)
          out.push(range(`${st.name.text}.${m.name ? m.name.getText(sf) : "constructor"}`, m))
    }
  }
  return out
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length

/** Lock keys for replacing `oldText` in `source` (Claude's Edit / MultiEdit). */
export function keysForEdit(file: string, source: string, oldText: string, replaceAll = false): LockKey[] {
  if (!isCode(file)) return [`${file}#<file>`]
  const offsets: number[] = []
  for (let i = source.indexOf(oldText); i !== -1 && oldText; i = source.indexOf(oldText, i + 1)) {
    offsets.push(i)
    if (!replaceAll) break
  }
  if (!offsets.length) return [`${file}#<file>`]
  const fns = functionsIn(file, source)
  const lines = source.split("\n")
  const keys = new Set<LockKey>()
  for (const off of offsets) {
    const from = lineAt(source, off)
    const to = lineAt(source, off + oldText.length)
    const hit = fns.filter(f => f.start <= to && f.end >= from)
    for (let l = from; l <= to; l++)
      if (lines[l - 1].trim() && !fns.some(f => f.start <= l && l <= f.end)) keys.add(`${file}#<top>`)
    for (const f of hit) keys.add(`${file}#${f.name}`)
  }
  const order = (k: LockKey) => (k.endsWith("#<top>") ? -1 : fns.findIndex(f => k === `${file}#${f.name}`))
  return [...keys].sort((a, b) => order(a) - order(b))
}

/** Lock keys for writing a whole file; `existing` is null for a new file. */
export function keysForWrite(file: string, existing: string | null): LockKey[] {
  if (!isCode(file)) return [`${file}#<file>`]
  return [`${file}#<top>`, ...(existing ? functionsIn(file, existing).map(f => `${file}#${f.name}`) : [])]
}

/** Names of functions whose name or parameter list changed between two versions of a file. */
export function signatureChanges(file: string, before: string, after: string): string[] {
  const sigs = (src: string) => {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
    const map = new Map<string, string>()
    const visit = (n: ts.Node, prefix = "") => {
      if (ts.isFunctionDeclaration(n) && n.name) map.set(n.name.text, n.parameters.map(p => p.getText(sf)).join(","))
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))
        map.set(n.name.text, n.initializer.parameters.map(p => p.getText(sf)).join(","))
      else if (ts.isClassDeclaration(n) && n.name) return n.members.forEach(m => visit(m, `${n.name!.text}.`))
      else if (ts.isMethodDeclaration(n)) map.set(prefix + n.name.getText(sf), n.parameters.map(p => p.getText(sf)).join(","))
      ts.forEachChild(n, c => visit(c, prefix))
    }
    visit(sf)
    return map
  }
  const a = sigs(before)
  const b = sigs(after)
  return [...a].filter(([name, params]) => b.get(name) !== params).map(([name]) => name)
}

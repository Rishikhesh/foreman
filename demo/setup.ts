// One-time demo setup inside this repo: two git worktrees stand in for two people.
//   .demo/rishi  (blue)   and   .demo/friend (orange), both on their own demo branches.
// Creates the room from rishi, joins from friend, and links the VS Code extension.
// Usage: bun demo/setup.ts [serverUrl]   (default http://127.0.0.1:7300; the Foreman server must be running)
import { existsSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const repo = path.resolve(import.meta.dir, "..")
const url = process.argv[2] ?? "http://127.0.0.1:7300"
const cli = path.join(repo, "cli", "foreman.ts")
const people = [
  { name: "rishi", color: "blue", dir: path.join(repo, ".demo/rishi"), branch: "demo-rishi" },
  { name: "friend", color: "orange", dir: path.join(repo, ".demo/friend"), branch: "demo-friend" },
]

if (!existsSync(path.join(repo, "demo/sample/src/auth.ts"))) throw new Error("demo/sample is missing; commit it first")
const base = (await $`git -C ${repo} rev-parse HEAD`.text()).trim()
for (const p of people) {
  if (!existsSync(p.dir)) await $`git -C ${repo} worktree add -q -B ${p.branch} ${p.dir} ${base}`
}
writeFileSync(path.join(repo, ".demo/base"), base)

const [host, guest] = people
const init = await $`bun ${cli} init --url ${url} --name ${host.name} --color ${host.color}`.cwd(host.dir).text()
const invite = init.match(/foreman join (fm_\S+)/)?.[1]
if (!invite) throw new Error(`init did not print an invite:\n${init}`)
await $`bun ${cli} join ${invite} --name ${guest.name} --color ${guest.color}`.cwd(guest.dir).quiet()

const extDir = path.join(os.homedir(), ".vscode/extensions/foreman.foreman-dev")
await $`ln -sfn ${path.join(repo, "vscode-ext")} ${extDir}`

console.log(`Demo ready (base ${base.slice(0, 7)}).
  Blue window:   code -n ${host.dir}
  Orange window: code -n ${guest.dir}
Open demo/sample/src/auth.ts in both (trust the folder if VS Code asks), then run:  bun demo/simulate.ts
Invite for a real teammate's clone:  foreman join ${invite}`)

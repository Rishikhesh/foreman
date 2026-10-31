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

// A fresh room every run, with demo identities (accepted only from this laptop)
for (const p of people) await $`bun ${cli} leave`.cwd(p.dir).quiet().nothrow()
const [host, guest] = people
const init = await $`bun ${cli} init --url ${url} --color ${host.color} --dev ${host.name}`.cwd(host.dir).text()
const code = init.match(/Room code: (\S+)/)?.[1]
if (!code) throw new Error(`init did not print a room code:\n${init}`)
await $`bun ${cli} join ${code} --url ${url} --color ${guest.color} --dev ${guest.name} --no-wait`.cwd(guest.dir).quiet()
await $`bun ${cli} allow ${guest.name}`.cwd(host.dir).quiet()

const extDir = path.join(os.homedir(), ".vscode/extensions/foreman.foreman-dev")
await $`ln -sfn ${path.join(repo, "vscode-ext")} ${extDir}`

console.log(`Demo ready (base ${base.slice(0, 7)}).
  Blue window:   code -n ${host.dir}
  Orange window: code -n ${guest.dir}
Room ${code}: rishi (blue) is the host and has let friend (orange) in.
Open demo/sample/src/auth.ts in both (trust the folder if VS Code asks), then run:  bun demo/simulate.ts`)

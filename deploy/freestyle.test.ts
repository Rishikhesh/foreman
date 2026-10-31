import { expect, test } from "bun:test"
import { vmSpec } from "./freestyle.js"

test("vmSpec: always-on VM that clones the repo, installs Bun, runs Terse then the Foreman server on 443", () => {
  const spec = vmSpec("https://github.com/o/foreman", { RELAY_WORKSPACE_KEY: "rk", SUPABASE_URL: undefined })
  expect(spec.idleTimeoutSeconds).toBeNull()
  expect(spec.persistence).toEqual({ type: "persistent" })
  expect(spec.gitRepos).toEqual([{ repo: "https://github.com/o/foreman", path: "/foreman" }])
  expect(spec.ports).toEqual([{ port: 443, targetPort: 7300 }])
  const [install, terse, server] = spec.systemd.services
  expect(install).toMatchObject({ name: "foreman-install", mode: "oneshot" })
  expect(terse).toMatchObject({ name: "foreman-terse", mode: "service", after: ["foreman-install.service"], requires: ["foreman-install.service"] })
  expect(server).toMatchObject({ name: "foreman-server", mode: "service", after: ["foreman-terse.service"], env: { RELAY_WORKSPACE_KEY: "rk", FOREMAN_PORT: "7300" } })
  expect(server.env).not.toHaveProperty("SUPABASE_URL")
})

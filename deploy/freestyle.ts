// Host the shared Foreman server (Terse + HTTP + Relay + history) on an always-on Freestyle VM.
// Usage: FREESTYLE_API_KEY=… bun deploy/freestyle.ts <public git URL of this repo>
// Prints the public https URL to pass to `foreman init --url`.

const BUN = "/root/.bun/bin/bun"

/** The VM create request; env values that are unset are left out. */
export function vmSpec(repoUrl: string, env: Record<string, string | undefined>) {
  const secrets = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>
  const restart = { policy: "always" as const, restartSec: 3 }
  return {
    idleTimeoutSeconds: null,
    persistence: { type: "persistent" as const },
    gitRepos: [{ repo: repoUrl, path: "/foreman" }],
    ports: [{ port: 443, targetPort: 7300 }],
    workdir: "/foreman",
    systemd: {
      services: [
        { name: "foreman-install", mode: "oneshot" as const, workdir: "/foreman", exec: ["/bin/sh -c 'curl -fsSL https://bun.sh/install | bash'", `${BUN} install`], remainAfterExit: true },
        {
          name: "foreman-terse",
          mode: "service" as const,
          workdir: "/foreman",
          exec: [`${BUN} run dev`],
          after: ["foreman-install.service"],
          requires: ["foreman-install.service"],
          restartPolicy: restart,
        },
        {
          name: "foreman-server",
          mode: "service" as const,
          workdir: "/foreman",
          exec: [`/bin/sh -c 'sleep 20; ${BUN} run generate && exec ${BUN} src/server.ts'`],
          after: ["foreman-terse.service"],
          env: { ...secrets, FOREMAN_PORT: "7300" },
          restartPolicy: restart,
        },
      ],
    },
  }
}

if (import.meta.main) {
  const repoUrl = process.argv[2]
  if (!repoUrl || !process.env.FREESTYLE_API_KEY) {
    console.error("usage: FREESTYLE_API_KEY=… bun deploy/freestyle.ts <public git URL of this repo>")
    process.exit(2)
  }
  const { freestyle } = await import("freestyle-sandboxes")
  const spec = vmSpec(repoUrl, {
    RELAY_WORKSPACE_KEY: process.env.RELAY_WORKSPACE_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  })
  const res: any = await (freestyle.vms as any).create(spec)
  const domain = res.domains?.[0] ?? res.vm?.domains?.[0]
  console.log(`VM ${res.id ?? res.vmId ?? res.vm?.id} is starting (about a minute).`)
  console.log(domain ? `Server: https://${domain}\nCreate the room with:  foreman init --url https://${domain}` : JSON.stringify(res, null, 2))
}

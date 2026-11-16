# Deployment templates

Templates for running mcp-server-sevdesk in remote mode (Streamable HTTP) from the published image
`ghcr.io/jaylann/mcp-server-sevdesk`. How to use them, the image, volumes and verifying the image
are in [docs/remote/deployment.md](../docs/remote/deployment.md); the guide to remote mode starts at
[docs/remote.md](../docs/remote.md).

| Template                                 | Runs                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| [compose/](compose/)                     | Docker Compose on your own host, with Caddy for automatic HTTPS |
| [fly/fly.toml](fly/fly.toml)             | Fly.io: one Machine with a volume, suspended while idle         |
| [render/render.yaml](render/render.yaml) | Render Blueprint: one web service with a disk (paid instance)   |
| [Railway](#railway)                      | Railway: one service with a volume, from the file below         |

Every template uses OAuth mode and runs exactly one instance. Release PRs bump the image version in
these files, so a template always names the release it ships with.

## Railway

Railway reads no `railway.json` for new services any more. Describe the service in a
[Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) file in your own
project (`.railway/railway.ts`, with `npm install railway`), or create it in the dashboard as
described in [docs/remote/deployment.md](../docs/remote/deployment.md#railway):

```ts
import { defineRailway, image, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("sevdesk-data", { sizeMB: 1024 });
  const mcp = service("mcp-server-sevdesk", {
    source: image(
      "ghcr.io/jaylann/mcp-server-sevdesk:1.6.0", // x-release-please-version
      { autoUpdates: { type: "patch" } },
    ),
    healthcheck: "/healthz",
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      PORT: "8080",
      // Railway mounts volumes owned by root; see docs/remote/deployment.md.
      RAILWAY_RUN_UID: "0",
      SEVDESK_HTTP_AUTH: "oauth",
      SEVDESK_HTTP_PUBLIC_URL: "https://<service>.up.railway.app",
      SEVDESK_HTTP_TRUST_PROXY: "1",
      SEVDESK_OAUTH_ACCOUNTS: "<sevDesk account id>",
      // Set it once in the dashboard (a sealed variable) to the output of `generate-secret`.
      SEVDESK_HTTP_SECRET: preserve(),
      SEVDESK_ALLOW: "read",
      SEVDESK_CONFIRM: "browser",
      SEVDESK_AUDIT_LOG: "/data/audit.jsonl",
    },
  });
  return project("mcp-server-sevdesk", { resources: [mcp, data] });
});
```

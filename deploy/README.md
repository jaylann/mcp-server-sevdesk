# Deployment templates

Templates for running mcp-server-sevdesk in remote mode (Streamable HTTP) from the published image
`ghcr.io/jaylann/mcp-server-sevdesk`. The guide to remote mode (concepts, every setting, clients,
the approvals inbox, `grants` commands, key rotation, troubleshooting) is
[docs/remote.md](../docs/remote.md).

| Template                                 | Runs                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| [compose/](compose/)                     | Docker Compose on your own host, with Caddy for automatic HTTPS |
| [fly/fly.toml](fly/fly.toml)             | Fly.io: one Machine with a volume, suspended while idle         |
| [render/render.yaml](render/render.yaml) | Render Blueprint: one web service with a disk (paid instance)   |
| [Railway](#railway)                      | Railway: one service with a volume, from the snippet below      |

Every template uses OAuth mode (claude.ai custom connectors and other OAuth clients) and runs
exactly one instance: grants and sessions live in `/data`, pending approvals in memory. Release
PRs bump the image version in these files, so a template always names the release it ships with.

## The image

- Tags: the exact version (`0.4.1`), the minor line (`0.4`) and `latest`, for `linux/amd64` and
  `linux/arm64`. Each release carries a build provenance attestation and an SBOM:
  `gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann`.
- Distroless, runs as uid 65532 with a read-only root filesystem; `/data` is the only writable
  path (a volume, owned by 65532). Listens on port 8080; `GET /healthz` is the health check.
- The default command is `--http`. `--stdio`, `--version`, `generate-secret`, `account-id` and
  `grants …` replace it, for example
  `docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret`.

## Volumes and the container user

Docker named volumes (compose) take the owner of `/data` from the image, so they work as they are.
A platform disk that is mounted owned by root is not writable for uid 65532, and the server then
refuses to start because `SEVDESK_HTTP_STATE_DIR` is not writable. Railway documents this case
and its fix (`RAILWAY_RUN_UID=0`, which runs the container as root). Without a writable disk, set
`SEVDESK_HTTP_STATE_DIR` to an empty value: state is then kept in memory, and clients have to
reconnect after every restart.

## Railway

Railway reads no `railway.json` for new services any more (config as code is deprecated and is
no longer read after 2026-12-01). Create the service from the image in the dashboard (New >
Docker Image), add a volume at `/data` and set the variables below, or describe it in a
[Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) file in your own
project (`.railway/railway.ts`, with `npm install railway`):

```ts
import { defineRailway, image, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const data = volume("sevdesk-data", { sizeMB: 1024 });
  const mcp = service("mcp-server-sevdesk", {
    source: image(
      "ghcr.io/jaylann/mcp-server-sevdesk:1.0.0", // x-release-please-version
      { autoUpdates: { type: "patch" } },
    ),
    healthcheck: "/healthz",
    replicas: 1,
    volumeMounts: { "/data": data },
    env: {
      PORT: "8080",
      // Railway mounts volumes owned by root (see "Volumes and the container user").
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

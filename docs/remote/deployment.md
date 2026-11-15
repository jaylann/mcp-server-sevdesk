# Deployment

How to run the server in [remote mode](../remote.md) from the published image: on your own host
with Docker Compose and Caddy, on Fly.io, Render or Railway, or behind a tunnel for a test. Read the
[concepts](../remote.md#concepts) first; every variable named here is described in
[Configuration](configuration.md).

## The image

The image is `ghcr.io/jaylann/mcp-server-sevdesk`, for `linux/amd64` and `linux/arm64`, with the
tags `<version>` (the exact version), `<major>.<minor>` (the minor line, which moves to each new
patch release) and `latest` (not for pre-releases). Each release carries a build provenance
attestation and an SBOM ([Verifying the image](#verifying-the-image)).

- It runs as uid 65532 on a distroless Node.js base (no shell), with a root filesystem that can be
  read-only: only `/data` is written, a volume owned by 65532 (`SEVDESK_HTTP_STATE_DIR=/data`).
- It starts `--http`, listens on `0.0.0.0:8080`, and has a health check that runs the
  `healthcheck` command (`GET /healthz`).
- Any other command replaces `--http`: `--stdio`, `--version`, `generate-secret`, `account-id`
  and `grants …`, for example
  `docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret`.

## The templates

The [`deploy/`](../../deploy/) folder holds templates that run the image in OAuth mode, as exactly
one instance with a volume at `/data` (grants and sessions live there, pending approvals in
memory), `SEVDESK_CONFIRM=browser`, the audit log in `/data/audit.jsonl` and `SEVDESK_ALLOW=read`:
raise `SEVDESK_ALLOW` to the most you want any connection to get. Release PRs bump the image
version in these files, so a template always names the release it ships with.

Every deployment needs at least `SEVDESK_HTTP_PUBLIC_URL` and either `SEVDESK_HTTP_SECRET` plus
`SEVDESK_OAUTH_ACCOUNTS` (OAuth) or `SEVDESK_HTTP_BEARER_TOKEN` plus `SEVDESK_API_TOKEN` (bearer).

| Template                                                       | Runs                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| [`deploy/compose/`](../../deploy/compose/)                     | Docker Compose on your own host, with Caddy for automatic HTTPS |
| [`deploy/fly/fly.toml`](../../deploy/fly/fly.toml)             | Fly.io: one Machine with a volume, suspended while idle         |
| [`deploy/render/render.yaml`](../../deploy/render/render.yaml) | Render Blueprint: one web service with a disk (paid instance)   |
| [Railway](#railway)                                            | Railway: one service with a volume, from the dashboard or code  |

## Docker Compose with Caddy (`deploy/compose/`)

For a VM or a home server with a domain name.
[`deploy/compose/compose.yaml`](../../deploy/compose/compose.yaml) runs two services:

- **`mcp`**, the server: read-only root filesystem, all Linux capabilities dropped,
  `no-new-privileges`, memory and process limits, the server secret from a file through Compose
  secrets (`SEVDESK_HTTP_SECRET_FILE`), a named volume at `/data`, and no port published to the
  host;
- **`caddy`** (pinned by digest): gets and renews the TLS certificate for your domain, keeps the
  `Host` header, sets `X-Forwarded-For`, and passes streamed responses on at once
  (`flush_interval -1`). It writes no access log on purpose: OAuth redirect URLs carry
  authorization codes.

Point the domain's DNS at the machine and open ports 80 and 443. Then, in `deploy/compose/`:

```bash
cp .env.example .env      # SEVDESK_DOMAIN, SEVDESK_OAUTH_ACCOUNTS, SEVDESK_ALLOW
install -d -m 0700 secrets
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret > secrets/http_secret
sudo chown 65532:65532 secrets/http_secret && sudo chmod 0400 secrets/http_secret
docker compose up -d
```

Compose mounts a secret file as it is on the host, so it must be readable by uid 65532 (the
`chown`). `secrets/` is git-ignored. Caddy is the one proxy in front, so the template sets
`SEVDESK_HTTP_TRUST_PROXY=1`. For bearer mode, follow the commented lines in `compose.yaml`. Run
the operator commands in a one-off container of the same service, for example
`docker compose run --rm mcp grants list`.

## Fly.io (`deploy/fly/fly.toml`)

[`deploy/fly/fly.toml`](../../deploy/fly/fly.toml) runs one Machine in Frankfurt with a 1 GB volume
(`sevdesk_data`) at `/data`. Fly terminates TLS and forces https; the Machine suspends when idle
(`auto_stop_machines = "suspend"`, which keeps its memory) and starts on the next request.

```bash
fly apps create <app>
# In fly.toml: set `app`, SEVDESK_HTTP_PUBLIC_URL (https://<app>.fly.dev or your domain) and
# SEVDESK_OAUTH_ACCOUNTS.
fly secrets set --app <app> --stage \
  SEVDESK_HTTP_SECRET="$(docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret)"
fly deploy --config deploy/fly/fly.toml --ha=false
```

Keep it at one Machine (`--ha=false`): a second one would have its own volume and its own grants.
The Fly proxy is one hop (`SEVDESK_HTTP_TRUST_PROXY=1`).

## Render (`deploy/render/render.yaml`)

[`deploy/render/render.yaml`](../../deploy/render/render.yaml) is a Blueprint: one web service from
the image in Frankfurt, with a 1 GB disk at `/data` and `/healthz` as its health check. In the
Render dashboard choose New → Blueprint, pick this repository (or your fork) and set the Blueprint
path to `deploy/render/render.yaml`. Render generates `SEVDESK_HTTP_SECRET` itself
(`generateValue`, never shown in the file) and asks for `SEVDESK_HTTP_PUBLIC_URL`
(`https://<service>.onrender.com` or your domain) and `SEVDESK_OAUTH_ACCOUNTS` when you create
it. A disk needs a paid instance type and keeps the service at one instance. The template sets
`PORT=8080`, the port Render routes to.

## Railway

Railway reads no `railway.json` for new services any more (its config as code is deprecated and is
no longer read after 2026-12-01). Either:

- create the service from the image in the dashboard (New → Docker Image), add a volume at
  `/data`, set `/healthz` as the health check, keep one replica and set the variables; or
- describe it in a
  [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) file in your
  own project (`.railway/railway.ts`, with `npm install railway`). A ready file, pinned to the
  current release, is in [`deploy/README.md`](../../deploy/README.md#railway).

The variables are those of the other templates: `PORT=8080` (the image listens on 8080),
`SEVDESK_HTTP_AUTH=oauth`, `SEVDESK_HTTP_PUBLIC_URL=https://<service>.up.railway.app`,
`SEVDESK_HTTP_TRUST_PROXY=1`, `SEVDESK_OAUTH_ACCOUNTS`, `SEVDESK_ALLOW`,
`SEVDESK_CONFIRM=browser`, `SEVDESK_AUDIT_LOG=/data/audit.jsonl`, and `SEVDESK_HTTP_SECRET` set
once in the dashboard as a sealed variable to the output of `generate-secret`. Railway mounts
volumes owned by root, so also set `RAILWAY_RUN_UID=0`
([Volumes and the container user](#volumes-and-the-container-user)).

## A tunnel, for testing

`cloudflared tunnel --url http://localhost:8080` gives a local server a temporary public https URL.
Set it as `SEVDESK_HTTP_PUBLIC_URL` (restart when it changes) and `SEVDESK_HTTP_TRUST_PROXY=1`.
The tunnel provider terminates TLS and sees the traffic, including tokens; use it for tests, not
for your books.

## Volumes and the container user

Docker named volumes (Compose) take the owner of `/data` from the image, so they work as they are.
A bind mount needs a directory that uid 65532 can write:
`sudo install -d -o 65532 -g 65532 -m 700 ./data`.

A platform disk that is mounted owned by root is not writable for uid 65532, and the server then
refuses to start because `SEVDESK_HTTP_STATE_DIR` is not writable. Railway documents this case and
its fix (`RAILWAY_RUN_UID=0`, which runs the container as root). Without a writable disk, set
`SEVDESK_HTTP_STATE_DIR` to an empty value: state is then kept in memory, and clients have to
reconnect after every restart.

## Verifying the image

Each release image carries a build-provenance attestation from GitHub Actions and BuildKit's SBOM
and provenance. Check that an image was built from this repository by its release workflow:

```bash
gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann
```

Read the SBOM and the provenance:

```bash
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .Provenance }}'
```

Then pin the digest you verified (`ghcr.io/jaylann/mcp-server-sevdesk@sha256:…`) in your
deployment. How the release pipeline produces these is in
[security/supply-chain.md](../security/supply-chain.md).

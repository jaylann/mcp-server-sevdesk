# M5 remote check

A manual check of the remote mode against the trial account of the
[recording session](../recording-session.md), about 60 to 90 minutes. It is for maintainers before
a release that touches the HTTP mode.

The remote mode ([Remote mode](../remote.md)) is checked by hand once: the image built locally, a
temporary tunnel, a claude.ai custom connector and Claude Code over HTTP. The automated tests cover
the protocol; this run checks the real clients, the proxy in front and the logs. Run it while the
trial is still active, and never against a production account: the connector gets the `commit`
tier.

## What you need

- Docker running, `cloudflared` installed, a claude.ai account and Claude Code.
- The trial token file from
  [step 2](../recording-session.md#2-create-an-api-token-about-5-minutes)
  (`~/.config/sevdesk-trial.token`) and `pnpm build` done.
- A run tag for everything you create, in the same form as the scripted runs:
  `MCP-E2E <yyyymmdd-hhmm>-m5`.

## Setup

```bash
# 1. The image, built from this checkout.
docker build -t mcp-server-sevdesk:m5 .

# 2. A tunnel. Leave it running and note the https://….trycloudflare.com origin it prints.
cloudflared tunnel --url http://localhost:8080

# 3. In a second terminal: the trial account id and a fresh server secret, in an env file only you
#    can read, outside the repository.
SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token node dist/index.js account-id
umask 077
{
  echo "SEVDESK_HTTP_SECRET=$(node dist/index.js generate-secret)"
  echo "SEVDESK_OAUTH_ACCOUNTS=<the account id>"
  echo "SEVDESK_HTTP_PUBLIC_URL=https://<random>.trycloudflare.com"
} > ~/.config/sevdesk-m5.env

# 4. The server in OAuth mode, read-only, with a 5-minute access token so a refresh happens soon.
docker volume create sevdesk-m5-data
docker run -d --name sevdesk-m5 --read-only -p 127.0.0.1:8080:8080 \
  --env-file ~/.config/sevdesk-m5.env -v sevdesk-m5-data:/data \
  -e SEVDESK_HTTP_AUTH=oauth -e SEVDESK_HTTP_TRUST_PROXY=1 \
  -e SEVDESK_CONFIRM=browser -e SEVDESK_ALLOW=read,write,commit \
  -e SEVDESK_AUDIT_LOG=/data/audit.jsonl -e SEVDESK_OAUTH_ACCESS_TTL=5m \
  mcp-server-sevdesk:m5
docker logs -f sevdesk-m5     # in a third terminal, for the whole run
curl -sS https://<random>.trycloudflare.com/healthz
```

The tunnel's address changes every time `cloudflared` starts. If you restart it, update
`SEVDESK_HTTP_PUBLIC_URL` and recreate the container (and the connector).

## Steps

1. **claude.ai connector.** Settings → Connectors → Add custom connector, named
   `sevDesk MCP-E2E`, URL `https://<random>.trycloudflare.com/mcp`. On the consent page check that
   the client is `claude.ai` and the redirect goes to `claude.ai`, tick `write` and `commit`, paste
   the trial token and confirm.
2. **A read.** In a new chat with the connector on, ask:

   > Which bookkeeping system version does my sevDesk account use, and how many open invoices are
   > there?

   The answer comes from the trial account; `docker logs` shows `/mcp` requests with a grant
   prefix and no token.

3. **A draft.** Ask for a contact and an invoice draft named after the run tag (as in the M3 and M4
   runs):

   > Create a contact `MCP-E2E <tag> Kunde` and a draft invoice for it, one position, 100 EUR net,
   > 19 %

4. **Finalize through the inbox.** Ask Claude to finalize that draft. The tool answers
   `approval_pending` with a reference code and the inbox address. Open
   `https://<random>.trycloudflare.com/approvals` in the browser that did the consent: it is
   already signed in. Open the request with that reference code, check the preview (customer,
   amounts, "cannot be undone"), approve, and ask Claude to try again. The result is `done`.
5. **Refresh.** Wait more than 5 minutes, then ask another read question. It works without a new
   consent; the log shows a `/token` request with status 200 (a refresh with rotation).
6. **Claude Code over OAuth.**
   `claude mcp add --transport http sevdesk-m5 https://<random>.trycloudflare.com/mcp`, then `/mcp`
   in Claude Code and authenticate: the consent page opens with Claude Code's client and a loopback
   redirect warning. Its metadata document is on `claude.ai`, so the default client allowlist
   accepts it; if the page refuses the client anyway, note the host it names. Ask for one read.
7. **Negative checks** (each must be refused with the status in the comment; note anything
   else):

   ```bash
   T=https://<random>.trycloudflare.com
   # No Authorization header: 401 with WWW-Authenticate naming the resource metadata.
   curl -sS -i -X POST "$T/mcp" -H 'content-type: application/json' -d '{}' | head -n 20
   # A foreign Origin: 403, before authentication.
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$T/mcp" -H 'Origin: https://evil.example' \
     -H 'content-type: application/json' -d '{}'
   # A wrong Host, straight at the container: 403; /healthz is exempt and answers 200.
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/mcp \
     -H 'Host: evil.example' -H 'content-type: application/json' -d '{}'
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://localhost:8080/healthz
   ```

   Then the account allowlist: recreate the container with `SEVDESK_OAUTH_ACCOUNTS=1` (an id that
   is not the trial's), start a new consent from Claude Code (`/mcp`, re-authenticate) and paste the
   trial token. The page refuses it and shows the trial's account id; the log has an
   `account_refused` warning. The existing claude.ai connection stops working too: the allowlist
   applies to every request, so its grant is revoked on the next message (a `grant_revoked` warning
   with reason `account_removed`). Recreate the container with the right id afterwards and connect
   claude.ai again.

8. **Restart.** Ask Claude to finalize something that needs approval (or to cancel the invoice
   from step 4) so that an approval is pending, then `docker restart sevdesk-m5`. The connector
   keeps working without a new consent (the grants are in the volume), and the inbox no longer
   lists the pending approval: the model has to ask again. Reject that new request in the inbox.
9. **Grants.** List the grants, revoke the claude.ai one, and check that claude.ai asks to
   reconnect on the next message:

   ```bash
   docker run --rm -v sevdesk-m5-data:/data mcp-server-sevdesk:m5 grants list
   docker run --rm -v sevdesk-m5-data:/data mcp-server-sevdesk:m5 grants revoke <grant id>
   ```

10. **Claude Code in bearer mode.** Keep the OAuth container's log, replace the container with a
    bearer-mode one and connect Claude Code with a header:

    ```bash
    mkdir -p ~/.config/sevdesk-m5-logs
    docker logs sevdesk-m5 > ~/.config/sevdesk-m5-logs/oauth.log 2>&1
    docker rm -f sevdesk-m5
    umask 077
    {
      echo "SEVDESK_HTTP_BEARER_TOKEN=$(node dist/index.js generate-secret)"
      echo "SEVDESK_API_TOKEN=$(cat ~/.config/sevdesk-trial.token)"
      echo "SEVDESK_HTTP_PUBLIC_URL=https://<random>.trycloudflare.com"
    } > ~/.config/sevdesk-m5-bearer.env
    docker run -d --name sevdesk-m5 --read-only -p 127.0.0.1:8080:8080 \
      --env-file ~/.config/sevdesk-m5-bearer.env -v sevdesk-m5-data:/data \
      -e SEVDESK_HTTP_AUTH=bearer -e SEVDESK_HTTP_TRUST_PROXY=1 mcp-server-sevdesk:m5
    claude mcp add --transport http sevdesk-m5-bearer https://<random>.trycloudflare.com/mcp \
      --header "Authorization: Bearer $(sed -n 's/^SEVDESK_HTTP_BEARER_TOKEN=//p' ~/.config/sevdesk-m5-bearer.env)"
    ```

    Ask for one read. A wrong bearer value gets 401.

11. **No secret in any log.** Copy the logs out of the container and the volume, and search them
    for every secret of the run and for sealed tokens. Both searches must print nothing:

    ```bash
    cd ~/.config/sevdesk-m5-logs
    docker logs sevdesk-m5 > bearer.log 2>&1
    docker cp sevdesk-m5:/data/audit.jsonl . && docker cp sevdesk-m5:/data/grants.jsonl .
    printf '%s\n' "$(cat ~/.config/sevdesk-trial.token)" > patterns.txt
    sed -n 's/^SEVDESK_HTTP_SECRET=//p' ~/.config/sevdesk-m5.env >> patterns.txt
    sed -n 's/^SEVDESK_HTTP_BEARER_TOKEN=//p' ~/.config/sevdesk-m5-bearer.env >> patterns.txt
    rg -n -F -f patterns.txt oauth.log bearer.log audit.jsonl grants.jsonl
    rg -n 'sdmcp_' oauth.log bearer.log audit.jsonl grants.jsonl
    ```

## Cleanup

1. Clean up the tagged records as after the scripted runs: delete the contact and any drafts in
   the web app; a finalized invoice cannot be deleted, so cancel it (through the connector, with
   the inbox) or leave it to disappear with the trial
   ([End the trial](../recording-session.md#7-end-the-trial-about-5-minutes)).
2. Remove the connector in claude.ai (Settings → Connectors) and the Claude Code servers
   (`claude mcp remove sevdesk-m5`, `claude mcp remove sevdesk-m5-bearer`).
3. `docker rm -f sevdesk-m5`, `docker volume rm sevdesk-m5-data`, stop `cloudflared`.
4. `rm -r ~/.config/sevdesk-m5.env ~/.config/sevdesk-m5-bearer.env ~/.config/sevdesk-m5-logs`.

## What to commit from M5, and what never

- Commit: fixes the run calls for (code, tests, the [remote docs](../remote.md)), and the findings
  (which steps passed, the status codes of the negative checks, anything a client did differently
  than documented) in the PR description.
- Never commit: the env files, the server secret, bearer values, the trial token, the copied logs,
  `audit.jsonl` or `grants.jsonl`, the tunnel URL next to the account id, or screenshots of
  claude.ai or the inbox that show account data.

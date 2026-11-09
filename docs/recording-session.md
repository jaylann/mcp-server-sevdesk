# Recording session runbook

sevDesk has no sandbox and no test account: every write is real, and finalized documents cannot be
deleted. This project therefore checks its assumptions about the API in **one recording session
on a free 14-day trial account**, with three tools:

| Command                | What it does                                                                                                                | Writes?                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm probe`           | Asks sevDesk the open questions of `spec/deviations.md` and writes a Markdown report with scrubbed evidence.                | Only with `--allow-writes` (tagged data)        |
| `pnpm fixtures:record` | Records scrubbed read responses as test fixtures into `test/fixtures/recorded/<date>/`.                                     | Never                                           |
| `pnpm test:live`       | Calls every read tool through the real server and checks the output; optionally runs the write lifecycle through the tools. | Only with the two lifecycle flags (tagged data) |

**Never point any of this at a production account.** The read-only parts are harmless anywhere, but
the write parts create, finalize, pay and cancel real documents.

## Safety rails (built in)

- The tools read only these variables: `SEVDESK_API_TOKEN` (or `SEVDESK_API_TOKEN_FILE`),
  `SEVDESK_BASE_URL`, `SEVDESK_RATE_LIMIT`, `SEVDESK_TIMEOUT_MS`. Tier switches in your shell
  (`SEVDESK_ALLOW`, `SEVDESK_CONFIRM`, `SEVDESK_READ_ONLY`, …) are ignored.
- Read-only runs force `SEVDESK_READ_ONLY=1`: the HTTP client refuses every request that changes
  data before it is sent. PDFs are always fetched with `preventSendBy=true`.
- Write runs need an explicit flag **and** `SEVDESK_LIVE_I_UNDERSTAND_WRITES=1`, print a warning,
  and refuse an account that already holds more than 60 invoices plus contacts they did not create
  (`SEVDESK_LIVE_MAX_EXISTING_RECORDS` changes the limit). They enable the `write` and `commit`
  tiers. The `external` tier (e-mail) is enabled only when you pass an address of your own
  (`pnpm probe --probe-email`, `SEVDESK_LIVE_EMAIL_TO` for `test:live`), and then exactly one
  e-mail goes to that address, never to a contact. Nothing is enshrined. The only export is the
  DATEV CSV job of the M4 probe and scenario (it starts a job; never with `enshrineDocuments`).
- Everything written is named after a run tag such as `MCP-E2E 20261120-1432-k3f9` and listed in a
  cleanup list (end of the probe report, end of the `test:live` log).
- Recordings and reports are scrubbed (`scripts/lib/scrub.ts`): names, e-mails, phones,
  IBAN/BIC, VAT and tax ids, addresses, free texts, bank purposes, file names, URLs, document
  numbers and the account id are replaced by obvious fakes; the token is refused at write time.

## 1. Create the trial account (about 10 minutes)

1. Sign up for the free 14-day trial on sevdesk.de with an e-mail alias you use for nothing
   else. The trial includes the API (Buchhaltung Pro features).
2. Use fake company data (Musterfirma GmbH, Musterstraße 1, 10115 Berlin). Do not enter real
   customers, real bank accounts or real receipts: whatever the account holds can end up in a
   recording, scrubbed or not.
3. Check the bookkeeping system version in the settings: a new account should be on
   **Update 2.0** (the probe report states it too).
4. **Switch the account to standard VAT** (required for everything after finalizing): Einstellungen
   → Unternehmen → "Buchhaltung & Steuern" → Umsatzsteuer **"Standard 19%"**. The 2026-11-07
   trial started as a Kleinunternehmer (small-business scheme): drafts with tax rule 1 were saved,
   but every `sendBy` failed with 422 "Tax rule 'USTPFL_UMS_EINN' is not valid for account '4400'
   with taxation scope 'SMALL_BUSINESS'" (`spec/deviations.md` D-067), so the payment,
   cancellation, reminder and credit-note probes all came back inconclusive. `GET /SevClient`
   shows the setting as `smallSettlement` (`"1"` = small business).
5. **Confirm the account's e-mail address in sevDesk** before any e-mail probe: until it is
   confirmed, `sendViaEmail` answers 400 "Confirm your email address to send mails." (D-069).
6. Add a cash register (Kasse) or an offline bank account: **required** for the payment probes and
   the lifecycle scenario. Give the cash register a **positive opening balance** (one cash entry
   is enough): a credit note payout takes money out of it.
7. Optional, so more read probes give an answer instead of "inconclusive":
   - add one person contact (not only organisations);
   - enter two or three cash entries or import a small CSV of bank transactions with different
     value and entry dates;
   - upload one fake receipt as a voucher (Beleg);
   - mark one invoice as an e-invoice (E-Rechnung) and finalize it, for the `getXml` shape.

## 2. Create an API token (about 5 minutes)

1. If the trial allows more users, create a dedicated user (e.g. "MCP API") and use its token, so
   the token can be revoked without touching your login. Otherwise use the owner's token: it is a
   trial account.
2. In the web app: Settings → Users → the user → API token. sevDesk tokens never expire and have
   no scopes: treat it like a password.
3. Store it in a file only you can read, outside the repository:

   ```bash
   umask 077 && pbpaste > ~/.config/sevdesk-trial.token   # or paste with an editor
   export SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token
   ```

   Never put it into `.env` files of this repository, shell history, issues or chat.

## 3. Run the session (about 20 minutes)

Run everything from the repository root after `pnpm install`. Each step takes a few minutes at
the client's pace of about 4 requests per second. Behind a filtering HTTP proxy, add
`NODE_USE_ENV_PROXY=1` to every command: Node's `fetch` ignores `HTTPS_PROXY` without it, and the
requests fail with network errors.

```bash
# 3.1 See every probe and what is never probed (no token needed, nothing sent).
pnpm probe --list

# 3.2 Read-only probes: harmless, run them first.
pnpm probe --out probe-report-read-only.md

# 3.3 Write probes: create tagged drafts, finalize/pay/cancel some of them, then re-run the reads.
#     --probe-email (optional) also sends ONE invoice e-mail to an address you own, to record the
#     sendViaEmail answer; without it nothing is e-mailed. On a trial account only the account's
#     own login address works (see the notes below).
SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm probe --allow-writes --probe-email login@example.org \
  --out probe-report.md

# 3.4 Optional: a burst of 40 requests to see whether sevDesk rate-limits (D-022).
pnpm probe --only read-rate-limit-burst --out probe-report-rate-limit.md

# 3.5 Fixtures: first the plan, then the recording (read-only; PDFs only of finalized documents).
pnpm fixtures:record --dry-run
pnpm fixtures:record            # writes test/fixtures/recorded/<date>/…

# 3.6 Live read-only checks of every read tool through the real server.
pnpm test:live

# 3.7 Lifecycle through the write tools (contact → draft → PDF preview stays a draft → finalize →
#     partial + full payment → reminder → cancellation → credit note). Add
#     SEVDESK_LIVE_EMAIL_TO=login@example.org (the account's login address) to also e-mail the
#     paid invoice to yourself.
SEVDESK_LIVE_LIFECYCLE=1 SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm test:live
```

Notes:

- Step 3.3 runs the write probes first and then every read probe again, so the read probes find
  the documents the write probes created. Each write probe creates its own data; one failing probe
  does not stop the others (it is reported as `error`).
- Step 3.7 drives the M3 write tools with the arguments in `ARGS` at the top of
  `test/live/lifecycle.test.ts`. If a tool's arguments change, adjust them there; the other steps
  do not depend on it.
- The write probes cover: draft numbering (B4/D-027: what sevDesk does with documents saved
  without a number; the write tools themselves leave only invoices unnumbered and reserve the next
  order and credit note number, D-066) and `getNextOrderNumber`;
  getPdf previews of 2.0 drafts (B1); position price fields per `showNet` (B8); updates through
  `save*` with an id and omitted fields; the address of API-created drafts; credit notes without
  `deliveryDate`; payments (answer, date formats, the calendar day of a 12:00 Berlin date, credit
  note payout sign, bookings on a cash register and `resetToOpen`, payments on a reminder, foreign
  currency); cancellation; credit notes from invoices; reminders (query vs body); invoices from
  orders (RE or ER for a full invoice); `DELETE` of a draft; parts (`price` vs net/gross); contacts (assigned customer number,
  partial `PUT`, unknown fields); the `sendViaEmail` answer (only with `--probe-email`).
  The read probes then also check what the write run created, e.g. that every cancellation
  invoice (SR) points to its original and whether `origin[id]` filters work. `pnpm probe --list`
  shows each question.
- A step that fails with `Refusing to write: the account already holds …` means the account does
  not look like a fresh trial. Stop and check which account the token belongs to.
- E-mail on a trial account: `sendViaEmail` first needs the confirmed sender address (step 1.5);
  after that, a trial account can only e-mail its own login address. Any other recipient, even an
  address of yours, is refused with 400 "During the test phase, you can only send emails to your
  own email address." (D-069). A refused send changes nothing, so the probe can simply be run
  again with `--only write-send-email-shape`.
- Finalizing (`sendBy`) enshrined every invoice and credit note on the 2026-11-07 trial
  (automatic Festschreibung was on): finalized test documents cannot be reset to draft or
  deleted, only cancelled or left alone. Payments and `resetToOpen` still work on them (D-059,
  D-060).
- The 2026-11-07 session needed three write runs: one on the Kleinunternehmer account (most
  lifecycle probes inconclusive, D-067), one after switching to standard VAT, and e-mail re-runs
  after confirming the sender address. Doing steps 1.4 and 1.5 first saves the extra runs.

## 3a. M4: receipts, reconciliation, exports, e-invoices (about 30 minutes)

The M4 probes (`m4-*-probes.ts`) and the M4 lifecycle scenario need a little more preparation.

### What to prepare

1. **Company data** (Einstellungen → Unternehmen): street, zip, city, IBAN and BIC, contact
   e-mail and phone, Steuernummer or USt-IdNr. sevDesk needs them to finalize an e-invoice; the
   probe `write-einvoice-xml` names the empty `GET /SevClient` fields when `sendBy` refuses. Fake
   values are fine (Musterfirma, a test IBAN such as `DE02120300000000202051`).
2. **DATEV export configuration** (accountant number, client number, start of the fiscal year).
   Without it sevDesk refuses the export job. Either enter fake values in the web app (DATEV
   settings) or let the opt-in probe `write-export-datev-config` set accountant 1001, client 1 and
   1 January; it checks first that the account looks like a fresh trial and refuses otherwise.
3. **Nothing for reconciliation.** sevDesk refuses hand-made transactions on offline accounts and
   cash registers (422 "You can only create transactions on online checkaccounts", recorded
   2026-11-08). The probes and the M4 scenario therefore create **one tagged file-import bank
   account** per run (`POST /CheckAccount/Factory/fileImportAccount`, named `MCP-E2E … Import`,
   type CSV, default booking account) and enter their test transactions there. It is in the
   cleanup list; delete it in the web app at the end.
4. The booking accounts come from ReceiptGuidance (SKR04 6815 Bürobedarf with tax rule 9 at 19 %,
   4400 with rule 1, or the first account that fits), so a standard chart of accounts needs no
   setup.

### Runs, in this order

```bash
export SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token
W="SEVDESK_LIVE_I_UNDERSTAND_WRITES=1"

# 1. Read-only: SevClient keys, AccountDatev paging, CSV exports, transaction log.
pnpm probe --only read-sevclient-keys,read-account-datev-paging,read-export-csv,read-transaction-log,read-voucher-pos-account-datev \
  --out probe-report-m4-read.md

# 2. Writes: vouchers (upload, save, update, delete, finalize, payments, reset), transactions on
#    the file-import account (create, split, booking types, private), the DATEV job (refused
#    without a configuration), a ZUGFeRD receipt; then the reads that now have data.
env $W pnpm probe --allow-writes --only write-voucher-upload-temp-file,write-voucher-save-with-file,write-voucher-net-gross,write-voucher-open-directly,write-voucher-update-draft,write-voucher-invalid-account-rule,write-voucher-revenue,write-voucher-delete,write-voucher-finalize,write-voucher-book-amount,write-voucher-reset,write-transaction-create,write-transaction-split-booking,write-transaction-split-variants,write-transaction-private-status,write-export-datev-csv,write-voucher-zugferd-upload,read-transaction-log,read-sevclient-keys,read-account-datev-paging,read-voucher-pos-account-datev,read-export-csv,read-voucher-document-key,read-transaction-date-filters,read-transaction-status-filter,read-update-after,read-list-defaults \
  --out probe-report-m4-write.md

# 3. Opt-in: a fake DATEV configuration, then the export job again (job id, progress, the
#    download link's host and expiry format, the ZIP's entry names).
env $W pnpm probe --allow-writes --only write-export-datev-config,write-export-datev-csv \
  --out probe-report-m4-datev.md

# 4. Opt-in, after the company data (step 1 above): one e-invoice, FINALIZED (it cannot be
#    deleted). Attaches the scrubbed getXml answer to the report as a fixture candidate; after
#    a review it goes to test/fixtures/einvoice/sevdesk/ (see the README there).
env $W pnpm probe --allow-writes --only write-einvoice-xml --out probe-report-m4-einvoice.md

# 5. Fixtures (read-only), then the live checks and the scenarios (M3 and M4).
pnpm fixtures:record
pnpm test:live
SEVDESK_LIVE_LIFECYCLE=1 SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm test:live
```

Behind a filtering proxy the DATEV download also needs the S3 host that `jobDownloadInfo` names
(the probe report states it); the probe fetches the ZIP without credentials.

### What the M4 runs create and how they stay safe

- Generated files only: one-page PDFs and a 1×1 PNG with the run tag, and a minimal Factur-X PDF
  (EN 16931 CII inside). Never upload real receipts.
- Vouchers (drafts, open, paid and reset ones; the scenario deletes its own draft), transactions
  on the file-import account (status 100 again after the resets), finalized invoices for the
  booking probes, one contact, the file-import account. All tagged and in the cleanup list.
- `saveVoucher` for anything but a draft (status 50) needs the `commit` tier; the client refuses it
  otherwise. Bookings, resets and transaction status changes are `commit` as well.
- The DATEV job is a `POST` (the spec's GET answers 500 "wrong HTTP Type"), never with
  `enshrineDocuments`; the XML job is never started. The report keeps only the download link's
  host and the expiry format; ZIP entry names have long digit runs (accountant and client numbers)
  masked. Neither the ZIP nor the link is ever written to the repository.
- CSV exports: only the header row reaches the report (the evidence keeps the first line of a
  non-JSON body), never data rows.
- `read-sevclient-keys` shows only key names, booleans, `0`/`1` flags and short codes, never names,
  addresses, IBAN or numbers.
- The e-invoice fixture candidate is scrubbed by a structure-keeping XML scrubber (element names,
  codes, amounts, dates and the BT-24 profile stay; names, addresses, contact data, bank and tax ids,
  document numbers and free text become fakes; embedded files become a placeholder) and once more
  by the report's scrubber. It has no XML declaration: add `<?xml version="1.0" encoding="UTF-8"?>`
  back when it becomes a fixture.
- The M4 scenario's local folders (`SEVDESK_FILE_DIRS` with the generated PDFs, `SEVDESK_OUTPUT_DIR`
  for the DATEV ZIP) are temporary and removed at the end.

### What to commit from M4

- New recordings: `meta/sev-client.json`, `banking/transaction-by-id.json`,
  `banking/transaction-log.json`, `banking/transaction-log-unfiltered.json`,
  `vouchers/voucher-positions-embed-account.json` (after the review in section 4).
- The e-invoice fixture candidate, after review, as a fixture with `_provenance` (source
  `recorded`, the date, the probe id) and the declaration added back.
- Findings in `spec/deviations.md` (probe ids as the source).
- Never: export ZIPs or CSVs, the presigned link, uploaded test files, the probe reports' raw
  answers outside the scrubbed reports.

## 3b. M5 remote check (about 60 to 90 minutes)

The remote mode ([docs/remote.md](remote.md)) is checked by hand once, against the trial account:
the image built locally, a temporary tunnel, a claude.ai custom connector and Claude Code over
HTTP. The automated tests cover the protocol; this run checks the real clients, the proxy in front
and the logs. Run it while the trial is still active, and never against a production account: the
connector gets the `commit` tier.

### What you need

- Docker running, `cloudflared` installed, a claude.ai account and Claude Code.
- The trial token file from step 2 (`~/.config/sevdesk-trial.token`) and `pnpm build` done.
- A run tag for everything you create, in the same form as the scripted runs:
  `MCP-E2E <yyyymmdd-hhmm>-m5`.

### Setup

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

### Steps

1. **claude.ai connector.** Settings → Connectors → Add custom connector, named
   `sevDesk MCP-E2E`, URL `https://<random>.trycloudflare.com/mcp`. On the consent page check that
   the client is `claude.ai` and the redirect goes to `claude.ai`, tick `write` and `commit`, paste
   the trial token and confirm.
2. **A read.** In a new chat with the connector on: "Which bookkeeping system version does my
   sevDesk account use, and how many open invoices are there?" The answer comes from the trial
   account; `docker logs` shows `/mcp` requests with a grant prefix and no token.
3. **A draft.** Ask for a contact and an invoice draft named after the run tag (as in the M3 and M4
   runs: "Create a contact `MCP-E2E <tag> Kunde` and a draft invoice for it, one position, 100 EUR
   net, 19 %").
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
   redirect warning. If it refuses the client, add the host it names to `SEVDESK_OAUTH_CLIENTS`,
   recreate the container and try again. Ask for one read.
7. **Negative checks** (each must be refused; note the status codes):

   ```bash
   T=https://<random>.trycloudflare.com
   # No Authorization header: 401 with WWW-Authenticate naming the resource metadata.
   curl -sS -i -X POST "$T/mcp" -H 'content-type: application/json' -d '{}' | head -n 20
   # A foreign Origin: refused before authentication.
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$T/mcp" -H 'Origin: https://evil.example' \
     -H 'content-type: application/json' -d '{}'
   # A wrong Host, straight at the container: refused; /healthz is exempt and answers 200.
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/mcp \
     -H 'Host: evil.example' -H 'content-type: application/json' -d '{}'
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://localhost:8080/healthz
   ```

   Then the account allowlist: recreate the container with `SEVDESK_OAUTH_ACCOUNTS=1` (an id that
   is not the trial's), start a new consent from Claude Code (`/mcp`, re-authenticate) and paste the
   trial token. The page refuses it and shows the trial's account id; the log has an
   `account_refused` warning. Recreate the container with the right id afterwards.

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

### Cleanup

1. Clean up the tagged records as after the scripted runs: delete the contact and any drafts in
   the web app; a finalized invoice cannot be deleted, so cancel it (through the connector, with
   the inbox) or leave it to disappear with the trial ([section 7](#7-end-the-trial-about-5-minutes)).
2. Remove the connector in claude.ai (Settings → Connectors) and the Claude Code servers
   (`claude mcp remove sevdesk-m5`, `claude mcp remove sevdesk-m5-bearer`).
3. `docker rm -f sevdesk-m5`, `docker volume rm sevdesk-m5-data`, stop `cloudflared`.
4. `rm -r ~/.config/sevdesk-m5.env ~/.config/sevdesk-m5-bearer.env ~/.config/sevdesk-m5-logs`.

### What to commit from M5, and what never

- Commit: fixes the run calls for (code, tests, [docs/remote.md](remote.md)), and the findings
  (which steps passed, the status codes of the negative checks, anything a client did differently
  than documented) in the PR description.
- Never commit: the env files, the server secret, bearer values, the trial token, the copied logs,
  `audit.jsonl` or `grants.jsonl`, the tunnel URL next to the account id, or screenshots of
  claude.ai or the inbox that show account data.

## 4. Review before anything is shared (about 15 minutes)

1. Read the end of the `fixtures:record` output: `Review: text under these keys was replaced by
the default rule` lists keys the scrubber did not know. Check that nothing useful was lost and
   nothing personal kept.
2. Search the recordings and reports for anything of yours (name, e-mail domain, company, street,
   IBAN, phone):

   ```bash
   rg -n -i 'yourname|yourcompany|@yourdomain|DE\d{2} ?\d{4}' test/fixtures/recorded probe-report*.md
   ```

3. Open a few fixtures: keys, `null`s and string scalars (`"100"`, `"0"`/`"1"`) must look exactly
   like sevDesk sends them; names should read `Musterfirma 1 GmbH`, e-mails `person1@example.com`,
   PDF content a tiny fake PDF, XML only its root element.
4. Skim the probe report: every `contradicted` and `error` result needs a follow-up in
   `spec/deviations.md` (the "By deviation entry" section groups the findings per entry).

## 5. What to commit, and what never

Commit (after the review, in a PR):

- `test/fixtures/recorded/<date>/**` (the recorder refuses to overwrite existing files; `--force`
  replaces a session's files);
- updates to `spec/deviations.md`, tests and code that the probe findings call for;
- the findings themselves in the PR description (or the scrubbed report as a PR attachment).

Never commit:

- the token, a token file, `.env` files, shell history excerpts;
- unscrubbed responses (`test/fixtures/_raw/` is git-ignored for that reason), raw PDFs or XML
  from the account, screenshots of the trial;
- the cleanup list's account ids next to any personal data.

Recorded fixtures do not replace the committed community/spec fixtures automatically: each
recorded file says in its `_provenance.note` which committed fixture it mirrors, and replacing one
is a normal code change with its tests. Every recorded file must run through its production parser
in a contract test (`test/contract/recorded-fixtures.test.ts` for the 2026-11-07 session, which
fails when a recorded file has no contract); a recorded shape a parser rejects is a contract break
to fix in the parser, pinned with `it.fails` until then. Findings go into `spec/deviations.md` with
the source "recorded <date>, trial account, Update 2.0 (probe `<id>`)".

## 6. Optional: the `live` environment for the CI workflow

`.github/workflows/live-e2e.yml` runs `pnpm test:live` by hand (Actions → Live E2E → Run
workflow; tick `lifecycle` for the write scenario). It skips with a notice when no token is set.
To use it during the trial:

1. Repository settings → Environments → New environment `live`: required reviewer (you),
   deployment branches `main` only.
2. Add the environment secret `SEVDESK_API_TOKEN` (the trial token).
3. Remove the secret when the trial ends.

## 7. End the trial (about 5 minutes)

1. Revoke the API token in the web app (or delete the dedicated API user).
2. Delete the `SEVDESK_API_TOKEN` secret of the `live` environment and the local token file
   (`rm ~/.config/sevdesk-trial.token`).
3. Let the trial expire without booking a plan, or delete the account in the web app's account
   settings (contact sevDesk support if the option is missing). Finalized test documents cannot be
   deleted one by one; they disappear with the account.

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
  e-mail goes to that address, never to a contact. Nothing is enshrined or exported.
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

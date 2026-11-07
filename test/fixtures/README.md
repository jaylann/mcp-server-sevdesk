# Test fixtures

sevDesk responses used by unit and contract tests. There is no sevDesk sandbox and no paid test
account, so every fixture says where its shape comes from.

## Format

One JSON file per response, grouped by toolset (`meta/`, `contacts/`, …):

```json
{
  "_provenance": {
    "source": "spec",
    "ref": "spec/openapi.yaml#/paths/~1Tools~1bookkeepingSystemVersion/get/responses/200",
    "date": "2026-11-07",
    "systemVersion": "2.0",
    "note": "optional: what was changed or inferred"
  },
  "status": 200,
  "body": { "objects": { "version": "2.0" } }
}
```

- `body` is the **complete response body in sevDesk's real envelope**: `{"objects": …}` (plus
  `"total"` when the request had `countAll=true`), with scalars typed the way sevDesk sends them:
  ids, amounts and status codes as strings (`"1001"`, `"100"`), booleans as `"0"`/`"1"`, unset
  fields as `null`. Do not "clean up" these types: the lenient parsers exist because of them.
- `status` is the HTTP status (2xx). Error responses are simulated in tests by throwing a
  `SevdeskError` from the route, not with fixtures.
- `test/helpers/fake-client.ts` (`loadFixture`) validates this format; a fixture without
  provenance fails every test that loads it.

### Lists

For `list`/`listAll` the fake client treats `body.objects` as the **whole collection** and pages
it by `limit`/`offset` itself (`total` = its length). A fixture that has `"total"` is instead a
**recorded single page** and is returned unchanged with its `total` (use it to test paging maths
such as `hasMore` against a larger collection). `"total": null` simulates a page without a usable
count. Recorded single pages are answered the same for every offset, so do not use them with
`listAll`.

## Provenance

| `source`    | Meaning                                                                                                                                       | `ref`                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `spec`      | Built from the OpenAPI spec (`spec/openapi.yaml`), corrected by `spec/deviations.md`.                                                         | JSON pointer or section of the spec |
| `community` | Shape documented by others: recordings or models published by other projects (e.g. sevDesk.NET's recorded responses, j-mastr's patched spec). | URL of the source                   |
| `recorded`  | Recorded by us against a real account (`pnpm fixtures:record`).                                                                               | Endpoint and recording session      |

`date` is when the fixture was written or recorded; `systemVersion` is the bookkeeping system
version (`1.0` or `2.0`) of the account the shape belongs to. Use `note` for anything that is
inferred or illustrative rather than observed, so nobody mistakes it for ground truth.

## Recorded sessions (`recorded/<date>/`)

`recorded/2026-11-07/` holds the read responses of the recording session on a sevDesk trial
account (Update 2.0, SKR04, standard VAT; see `docs/recording-session.md`), written by
`pnpm fixtures:record` and scrubbed. Each file's `ref` names the request (`GET /Invoice?…
(recording session 2026-11-07)`) and its `note` names the committed fixture it mirrors
(`scripts/lib/fixture-plan.ts`). They are evidence, not test data to edit:

- Do not change them by hand. A new session goes into a new date folder.
- Lists are recorded single pages: they carry `total` (a JSON number, as sevDesk sends it), so the
  fake client returns them unchanged for every offset. Code that falls back to `listAll` needs the
  rows without `total` (see `rowsOnly` in the contract test).
- Every file runs through the production code that reads its endpoint in
  `test/contract/recorded-fixtures.test.ts`, which also checks the provenance and fails when a
  recorded file has no contract. Write answers (POST/PUT) are not fixtures here: their scrubbed
  shapes are in the probe reports and in `spec/deviations.md`.
- Scrubbing replaces each distinct value with one fake, so equal fakes mean equal real values
  (two credit notes with the same fake number really shared a number, `spec/deviations.md`
  D-068).

## Data rules

- **Fake data only.** Use obviously fake values: Musterfirma GmbH, Max Mustermann, Erika
  Musterfrau, `example.com` addresses, VAT ids like `DE000000000`, phone numbers like
  `+49 30 0000000`, IPs from `192.0.2.0/24`. Never commit real names, emails, addresses, IBANs,
  tax numbers or tokens.
- **Recorded fixtures must be scrubbed** before they are committed: replace personal and company
  data, ids that identify the account (`sevClient`), IPs, tokens and document numbers with fake
  values, keeping every key, every `null` and every scalar type exactly as recorded. System
  reference data (tax rules, units, categories, communication way keys) may stay verbatim.
- Keep fixtures small: only the rows a test needs, but always the full set of keys of a row.

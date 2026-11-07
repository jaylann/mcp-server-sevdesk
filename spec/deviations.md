# Known deviations: sevDesk OpenAPI spec vs. real API behavior

This register lists the places where the
[official sevDesk OpenAPI spec](https://api.sevdesk.de/openapi.yaml) and the real API disagree, or
where the spec is silent about behavior that our code depends on. Our hand-written zod schemas in
`src/sevdesk/` follow the **actual behavior** described here, not the spec. See
[README.md](README.md) for why.

Every entry was checked against the vendored snapshot in [`openapi.yaml`](openapi.yaml)
(`Last-Modified: Tue, 06 Oct 2026 09:58:55 GMT`, fetched 2026-11-07).

## Rules for this file

- Each entry has a stable id (`D-001`, `D-002`, …). Ids are never reused or renumbered. New
  entries take the next free id.
- **Status** is one of:
  - `Open`: the spec is still wrong or silent.
  - `Partly fixed upstream`: the spec improved, but some of the deviation remains.
  - `Fixed upstream`: the current spec is correct. The entry stays so its id and history survive,
    and so code that handles older behavior keeps a reference.
- **Evidence** says how sure we are: `spec` (visible in the snapshot), `community` (reported by
  other integrators, linked), or `recorded` (seen in our own fixture recordings).
- **Test** names the test that pins our handling of the deviation. Every open entry gets one.
- When the drift check (`scripts/check-spec-drift.ts`) reports a spec change, re-check the
  entries it touches and update their status.

## Index

| Id                                                                               | Title                                                                | Status                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| [D-001](#d-001-most-write-and-pdf-responses-are-wrapped-in-objects)              | Most write and PDF responses are wrapped in `{objects: …}`           | Open                  |
| [D-002](#d-002-scalars-come-back-as-strings)                                     | Scalars come back as strings                                         | Open                  |
| [D-003](#d-003-unknown-request-fields-are-silently-ignored)                      | Unknown request fields are silently ignored                          | Open                  |
| [D-004](#d-004-saveinvoice-and-savevoucher-require-properties-that-do-not-exist) | `saveInvoice` and `saveVoucher` require properties that do not exist | Open                  |
| [D-005](#d-005-model_invoice-requires-tax-fields-of-both-system-versions)        | `Model_Invoice` requires tax fields of both system versions          | Open                  |
| [D-006](#d-006-taxrule-id-enums-are-incomplete)                                  | `taxRule` id enums are incomplete                                    | Partly fixed upstream |
| [D-007](#d-007-voucher-status-and-recurringinterval-enums-are-too-narrow)        | Voucher `status` and `recurringInterval` enums are too narrow        | Open                  |
| [D-008](#d-008-two-response-fields-typed-string-are-numbers)                     | Two response fields typed `string` are numbers                       | Open                  |
| [D-009](#d-009-sendtype-can-be-an-empty-string-or-0)                             | `sendType` can be an empty string or `"0"`                           | Open                  |
| [D-010](#d-010-createinvoicefromorder-required-a-bogus-invoice-id)               | `createInvoiceFromOrder` required a bogus invoice id                 | Fixed upstream        |
| [D-011](#d-011-uploadtempfile-media-type-and-filename-type-are-wrong)            | `uploadTempFile` media type and `filename` type are wrong            | Open                  |
| [D-012](#d-012-export-endpoints-return-raw-csv-or-zip-with-downloadtrue)         | Export endpoints return raw CSV or ZIP with `download=true`          | Open                  |
| [D-013](#d-013-invoice-bookamount-response-has-copy-paste-errors)                | Invoice `bookAmount` response has copy-paste errors                  | Open                  |
| [D-014](#d-014-accountintervall-example-is-a-date)                               | `accountIntervall` example is a date                                 | Open                  |
| [D-015](#d-015-invoice-type-filters-use-re-instead-of-re)                        | Invoice type filters use `Re` instead of `RE`                        | Open                  |
| [D-016](#d-016-valuedate-and-entrydate-descriptions-are-swapped)                 | `valueDate` and `entryDate` descriptions are swapped                 | Open                  |
| [D-017](#d-017-originobjectname-only-allowed-invoice)                            | `origin.objectName` only allowed `Invoice`                           | Fixed upstream        |
| [D-018](#d-018-document-dates-are-typed-date-time-but-take-unix-or-ddmmyyyy)     | Document dates are typed `date-time` but take Unix or `dd.mm.yyyy`   | Open                  |
| [D-019](#d-019-pagination-limits-and-silent-truncation-at-100)                   | Pagination limits and silent truncation at 100                       | Partly fixed upstream |
| [D-020](#d-020-list-filters-behave-differently-from-their-declared-types)        | List filters behave differently from their declared types            | Open                  |
| [D-021](#d-021-validation-errors-can-come-back-as-500)                           | Validation errors can come back as 500                               | Open                  |
| [D-022](#d-022-rate-limiting-is-undocumented)                                    | Rate limiting is undocumented                                        | Open                  |
| [D-023](#d-023-some-gets-change-state)                                           | Some GETs change state                                               | Open                  |
| [D-024](#d-024-undocumented-endpoints-we-rely-on)                                | Undocumented endpoints we rely on                                    | Open                  |
| [D-025](#d-025-pdf-rendering-returns-one-base64-pdf-since-2026-04-07)            | PDF rendering returns one base64 `pdf` since 2026-04-07              | Partly fixed upstream |
| [D-026](#d-026-savevoucher-key-order-and-top-level-filename)                     | `saveVoucher` key order and top-level `filename`                     | Open                  |
| [D-027](#d-027-document-numbers-can-contain-unexpanded-placeholders)             | Document numbers can contain unexpanded placeholders                 | Open                  |
| [D-028](#d-028-kleinunternehmer-tax-rule-id-differs-between-spec-sections)       | Kleinunternehmer tax rule id differs between spec sections           | Open                  |
| [D-029](#d-029-tax-rule-21-has-two-different-names)                              | Tax rule 21 has two different names                                  | Open                  |
| [D-030](#d-030-undocumented-tax-rules-15-16-and-22)                              | Undocumented tax rules 15, 16 and 22                                 | Open                  |
| [D-031](#d-031-transaction-status-350-exists-only-in-the-response-model)         | Transaction status 350 exists only in the response model             | Open                  |
| [D-032](#d-032-the-contactid-filter-on-contactaddress-is-undocumented)           | The `contact[id]` filter on `/ContactAddress` is undocumented        | Open                  |

## Entries

### D-001: Most write and PDF responses are wrapped in `objects`

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** List GETs and GET-by-id declare `{objects: [...]}`. But 43 of the 75 non-GET
  operations declare a bare object, including `Invoice/Factory/saveInvoice`
  (`saveInvoiceResponse`), `Voucher/Factory/saveVoucher` (`saveVoucherResponse`),
  `Invoice/Factory/createInvoiceReminder`, `POST /Contact` and `PUT /Contact/{contactId}`. The
  three `getPdf` GETs (invoice, order, credit note) declare
  `{filename, mimeType, base64encoded, content}` without a wrapper.
- **Actual behavior:** These responses are wrapped in `{objects: …}` too. GET-by-id returns an
  array, which can be empty when the id does not exist.
- **Sources:** [j-mastr/sevdesk-api#12](https://github.com/j-mastr/sevdesk-api/pull/12)
  (createInvoiceReminder), [#28](https://github.com/j-mastr/sevdesk-api/pull/28) (saveVoucher),
  [#53](https://github.com/j-mastr/sevdesk-api/pull/53) (all create/update responses),
  [#66](https://github.com/j-mastr/sevdesk-api/pull/66) (PDF retrievals),
  [j-mastr/sevdesk-php-sdk#70](https://github.com/j-mastr/sevdesk-php-sdk/issues/70).
- **Impact:** `src/sevdesk/envelope.ts` unwraps every response. It accepts both an object and an
  array of one under `objects`, and maps an empty array from a GET-by-id to a not-found error.
- **Test:** `test/unit/sevdesk/envelope.test.ts`, `test/unit/sevdesk/client.test.ts` (unwrapping for every method). Per-endpoint fixtures follow with the write tools (M3).

### D-002: Scalars come back as strings

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** Request models type ids and amounts as `integer`/`number`. Response models
  (`Model_*Response`) mostly declare `string`, but not consistently: `showNet` and
  `smallSettlement` are `boolean`, `paidAmount` is `number`. No operation declares `countAll`; the
  overview text shows `"total": "157"`.
- **Actual behavior:** Ids, sums and statuses arrive as strings, booleans as `"0"`/`"1"`. Some
  fields are real JSON numbers (for example `paidAmount`, and the two in D-008). The `countAll`
  `total` is a string.
- **Sources:** spec overview, section "Pagination";
  [j-mastr/sevdesk-api#90](https://github.com/j-mastr/sevdesk-api/pull/90);
  [genz-its/sevdesk](https://github.com/genz-its/sevdesk) docs.
- **Impact:** Incoming zod schemas are lenient and coerce: numeric strings and numbers both parse
  into the decimal money type or integers, `"0"`/`"1"`/`0`/`1`/booleans parse into booleans. We
  never rely on the declared JSON type of a response field.
- **Test:** `test/unit/sevdesk/schema.test.ts` (lenient `zId`/`zIntish`/`zNumberish`/`zDecimalString`/`zBool01`), `test/unit/domain/contacts.test.ts`.

### D-003: Unknown request fields are silently ignored

- **Status:** Open. **Evidence:** community.
- **Spec says:** Nothing. No schema sets `additionalProperties: false`, and no text says what
  happens to unknown fields.
- **Actual behavior:** sevDesk drops unknown fields and still reports success. Example: a
  `fileName` inside the `voucher` object of `saveVoucher` is dropped, and the voucher is created
  without its document.
- **Sources:** [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2) (verified
  against a live account).
- **Impact:** Outgoing zod schemas are strict. Tool inputs reject unknown parameters with a message
  that names them. Writes are read back and compared.
- **Test:** pending (M3): strict outgoing schemas for every write tool.

### D-004: `saveInvoice` and `saveVoucher` require properties that do not exist

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `saveInvoice.required` is `[invoice, invoicePos]`, but the properties are
  `invoicePosSave` and `invoicePosDelete`. `saveVoucher.required` is `[voucher, voucherPos]`, but
  the properties are `voucherPosSave` and `voucherPosDelete`. The response schemas use
  `invoicePos`/`voucherPos`.
- **Actual behavior:** The API reads `invoicePosSave`/`voucherPosSave` (and `*PosDelete`). A client
  that follows `required` and sends `invoicePos` loses its positions without an error (see D-003).
- **Sources:** spec (`components.schemas.saveInvoice`, `components.schemas.saveVoucher`).
- **Impact:** Request builders send `invoicePosSave`/`voucherPosSave` only. Our schemas do not
  copy the spec's `required` lists.
- **Test:** pending (M3): invoice/voucher write payloads.

### D-005: `Model_Invoice` requires tax fields of both system versions

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `Model_Invoice.required` contains `taxRate`, `taxRule`, `taxText` and `taxType`
  together (plus `invoiceDate`, `contact`, `discount`, `status`, `addressCountry`,
  `contactPerson`, `invoiceType`, `currency`, `mapAll`). `taxType` is described as "Use this in
  sevdesk-Update 1.0 (instead of taxRule)", `taxRule` as the 2.0 replacement, and the
  invoice-level `taxRate` as "not used anymore". The `taxType` description lists five types
  including `ss`, but its enum only allows `default`, `eu`, `noteu` and `custom`.
- **Actual behavior:** What is needed depends on the account's bookkeeping system version
  (`GET /Tools/bookkeepingSystemVersion`). On 2.0, `taxRule` is used; `taxType` `default`, `eu`
  and `ss` are only mapped for a transition period and `custom` is rejected. On 1.0, `taxType`
  (and `taxSet` for `custom`) apply. The invoice-level `taxRate` is ignored; positions carry the
  rate.
- **Sources:** spec overview, section "sevdesk-Update 2.0 → Tax Rules".
- **Impact:** `src/sevdesk/system-version.ts` decides which fields a request carries. Schemas
  model the two versions separately instead of the spec's merged `required` list.
- **Test:** pending (M3): invoice write payloads per system version.

### D-006: `taxRule` id enums are incomplete

- **Status:** Partly fixed upstream. **Evidence:** spec + community.
- **Spec says:** `taxRule.id` is a string enum. On invoices, orders and credit notes it is now
  `1, 2, 3, 4, 5, 11, 17, 18, 19, 20, 21`. On vouchers (`Model_Voucher`, `Model_VoucherResponse`,
  `Model_VoucherUpdate`) it is still `1, 2, 3, 4, 5, 11`: the revenue rules only. The spec's own
  "Tax Rules" overview lists the expense rules `8, 9, 10, 12, 13, 14`, which no enum allows.
- **Actual behavior:** Vouchers are usually expenses and use rules 8–10 and 12–14; ReceiptGuidance
  also returns 16. A Kleinunternehmer expense account allows exactly 10 and 13. Rule 22 has been
  reported too (unverified).
- **Sources:** [j-mastr/sevdesk-api#68](https://github.com/j-mastr/sevdesk-api/pull/68),
  [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2), spec overview.
- **Impact:** Tax rule ids are checked against the cached ReceiptGuidance for the chosen account,
  not a static enum. Response schemas accept any id string.
- **Test:** `test/regressions/b9-reference-ids.test.ts` (all tax-rule ids, checked against the recorded `GET /TaxRule`).

### D-007: Voucher `status` and `recurringInterval` enums are too narrow

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `Model_Voucher.status` is a number enum `50, 100, 1000`. `recurringInterval` is
  an enum of ten values from `P0Y0M1W` to `P5Y0M0W`. The spec's own voucher status table also
  documents 150 (transferred) and 750 (partially paid).
- **Actual behavior:** Vouchers have status 150 and 750 as well. `recurringInterval` can hold
  other, equivalent ISO-8601 spellings (for example `P0Y1M` next to the listed `P0Y1M0W`).
- **Sources:** [j-mastr/sevdesk-api#68](https://github.com/j-mastr/sevdesk-api/pull/68), spec tag
  description "Types and status of vouchers".
- **Impact:** Response schemas accept any status and map unknown codes to a generic state instead
  of failing. Intervals are parsed as durations, not matched against a list.
- **Test:** `test/regressions/b9-reference-ids.test.ts` (voucher statuses 50/100/150/750/1000). `recurringInterval`: pending (M2).

### D-008: Two response fields typed `string` are numbers

- **Status:** Open. **Evidence:** community.
- **Spec says:** `Model_CheckAccountTransactionResponse.amount` is `type: string`, and
  `Model_ContactResponse.defaultDiscountAmount` is `type: string, format: float`.
- **Actual behavior:** Both come back as JSON numbers, unlike most other scalars (D-002).
- **Sources:** [j-mastr/sevdesk-api#90](https://github.com/j-mastr/sevdesk-api/pull/90).
- **Impact:** Covered by the lenient number coercion from D-002. Fixtures include both forms.
- **Test:** pending (M2): banking and contact detail DTOs.

### D-009: `sendType` can be an empty string or `"0"`

- **Status:** Open. **Evidence:** community.
- **Spec says:** `sendType` is a nullable enum `VPR, VPDF, VM, VP`.
- **Actual behavior:** Orders, invoices and credit notes can also return `""` or `"0"`.
- **Sources:** [j-mastr/sevdesk-api#45](https://github.com/j-mastr/sevdesk-api/issues/45).
- **Impact:** `""`, `"0"` and `null` all normalize to "not sent".
- **Test:** pending (M3): `sendBy`.

### D-010: `createInvoiceFromOrder` required a bogus invoice id

- **Status:** Fixed upstream (checked 2026-11-07). **Evidence:** spec + community.
- **Spec says:** The current `Model_CreateInvoiceFromOrder` requires only an `order` reference,
  with optional `type`, `amount` and `partialType`. Earlier versions also required an invoice id,
  which cannot exist before the invoice is created.
- **Actual behavior:** Only the order reference is needed. The response, like D-001, is wrapped
  in `objects`.
- **Sources:** [j-mastr/sevdesk-api#57](https://github.com/j-mastr/sevdesk-api/issues/57).
- **Impact:** None beyond D-001. Kept for history.
- **Test:** none needed (fixed upstream).

### D-011: `uploadTempFile` media type and `filename` type are wrong

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `POST /Voucher/Factory/uploadTempFile` declares the request media type
  `form-data`, which is not a valid media type. The `filename` that `saveVoucher` and
  `saveInvoice` take is declared `type: string, format: binary`, as if it were file content.
- **Actual behavior:** The upload is `multipart/form-data` with a `file` part. The response
  (`objects.filename`) is a plain string token such as `f019bec36c65f5a0e7d2c63cc33f0681.pdf`, and
  `saveVoucher` takes that string. The response also carries a base64 JPEG preview in
  `objects.content` that can be about 100 KB even for tiny files.
- **Sources:** spec; [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2)
  (preview size).
- **Impact:** The client sends `multipart/form-data`. `filename` is modeled as a string. The
  preview is stripped before anything reaches the model.
- **Test:** pending (M4): receipt upload.

### D-012: Export endpoints return raw CSV or ZIP with `download=true`

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** The `/Export/*` endpoints declare only an `application/json` response
  (`{objects: {filename, mimetype, base64Encoded, content}}`, described as "Successful operation
  without download") although they take a `download` parameter. `/Export/datevCSV` is
  `deprecated` and declares a bare `object`.
- **Actual behavior:** With `download=true` the body is the raw CSV or ZIP file, not JSON.
- **Sources:** spec; [peerigon/sevdesk README](https://github.com/peerigon/sevdesk#readme).
- **Impact:** The client picks the response parser from `Content-Type`, not from the endpoint.
  Export tools write files to `SEVDESK_OUTPUT_DIR` or return resources; the bytes never go through
  the model.
- **Test:** pending (M2): CSV/ZIP exports via `client.download`.

### D-013: Invoice `bookAmount` response has copy-paste errors

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The `PUT /Invoice/{invoiceId}/bookAmount` response (an `InvoiceLog`) has a
  property `creditNote` whose description says "The id of the invoice", a property
  `ammountPayed` (sic), and a `create` field described as "Date of email creation".
- **Actual behavior:** Not yet recorded. The property names are likely copied from the credit-note
  endpoint.
- **Sources:** spec.
- **Impact:** We do not model this response from the spec. After booking we read the invoice back
  (`paidAmount`, `status`) instead of trusting the log entry.
- **Test:** pending (M3): payment booking.

### D-014: `accountIntervall` example is a date

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `Model_InvoiceResponse.accountIntervall` is described as "The interval in which
  recurring invoices are due as ISO-8601 duration", but its example is `'2022-03-14'`.
  `accountNextInvoice` is a `string` in the response model and an `integer` in the request model.
- **Actual behavior:** Not yet recorded; we expect an ISO-8601 duration as described.
- **Sources:** spec.
- **Impact:** Recurring-invoice fields are parsed leniently and shown as text if they do not parse.
- **Test:** pending (M2): recurring invoices.

### D-015: Invoice type filters use `Re` instead of `RE`

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The `invoiceType` filter enums of `/Export/invoiceCsv`, `/Export/invoiceZip` and
  `/Report/invoicelist` contain `Re`, while their own descriptions and `Model_Invoice.invoiceType`
  use `RE`.
- **Actual behavior:** Invoice types are upper case (`RE`).
- **Sources:** spec.
- **Impact:** Our filter schemas use `RE`.
- **Test:** pending (M2): invoice list filters.

### D-016: `valueDate` and `entryDate` descriptions are swapped

- **Status:** Open. **Evidence:** spec.
- **Spec says:** In `Model_CheckAccountTransaction`, `valueDate` is "Date the check account
  transaction was booked" and `entryDate` "was imported". In
  `Model_CheckAccountTransactionResponse` the two descriptions are the other way round.
- **Actual behavior:** At most one of the two can be right; to be confirmed with recorded data.
  The response model also has status 350 ("Auto-booked without user confirmation"), which the
  request model lacks.
- **Sources:** spec.
- **Impact:** The transaction DTO exposes both dates under neutral names and documents the
  uncertainty until a recording settles it.
- **Test:** pending (M2): bank transactions.

### D-017: `origin.objectName` only allowed `Invoice`

- **Status:** Fixed upstream (checked 2026-11-07). **Evidence:** community.
- **Spec says:** `Model_InvoiceResponse.origin.objectName` used to be an enum of `Invoice` only.
  The current spec has no enum ("Could f.e. be 'Order'").
- **Actual behavior:** Invoices created from an order have `origin.objectName: "Order"`.
- **Sources:** [j-mastr/sevdesk-api#55](https://github.com/j-mastr/sevdesk-api/issues/55).
- **Impact:** `origin` is parsed as a generic `{id, objectName}` reference. Kept for history.
- **Test:** none needed (fixed upstream).

### D-018: Document dates are typed `date-time` but take Unix or `dd.mm.yyyy`

- **Status:** Open. **Evidence:** spec.
- **Spec says:** Fields such as `voucherDate`, `deliveryDate` and `invoiceDate` are
  `type: string, format: date-time`, with the description "Needs to be provided as timestamp or
  dd.mm.yyyy" and examples like `01.01.2022`, which are not RFC 3339 date-times.
- **Actual behavior:** Document writes take a Unix timestamp or `dd.mm.yyyy`. Filters and exports
  take Unix timestamps. Responses return ISO 8601 date-times.
- **Sources:** spec.
- **Impact:** `src/sevdesk/dates.ts` has per-endpoint serializers and anchors calendar dates to
  Europe/Berlin. Responses are parsed as ISO 8601.
- **Test:** `test/unit/sevdesk/dates.test.ts` (`toSevdeskDate`, `toUnixSeconds`, `toBerlinDate`).

### D-019: Pagination limits and silent truncation at 100

- **Status:** Partly fixed upstream. **Evidence:** spec + API news.
- **Spec says:** The overview now says `limit` must be between 1 and 1000 and documents `offset`
  and `countAll`. But `limit`/`offset` are declared on only three operations
  (`Invoice/{invoiceId}/getPositions`, `Order/{orderId}/getPositions`,
  `Order/{orderId}/getDiscounts`), and `countAll` and `embed` on none. The default of 100 appears
  only in passing in an overview example.
- **Actual behavior:** Since 2025-05-30 a `limit` outside 1–1000 returns 400. An omitted `limit`
  silently returns at most 100 records.
- **Sources:**
  [API news 2025-03-11, "new API pagination limits"](https://tech.sevdesk.com/api_news/posts/2025_03_11-api_pagination_limits/);
  [j-mastr/sevdesk-api#21](https://github.com/j-mastr/sevdesk-api/pull/21).
- **Impact:** The client always sends an explicit `limit` (1–1000) and pages until an empty page.
  Tools that truncate say how many records they left out.
- **Test:** `test/regressions/limit-truncation.test.ts`.

### D-020: List filters behave differently from their declared types

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `GET /Contact` declares `depth` as a string enum `'0'`/`'1'` ("'0' -> only
  organizations") without a default. Boolean filters such as `isBooked`, `onlyCredit` and
  `onlyDebit` on `GET /CheckAccountTransaction` are `type: boolean`; `isBooked` is "Only retrieve
  booked transactions".
- **Actual behavior:** Without `depth=1`, `GET /Contact` returns organisations only. Boolean query
  parameters must be sent as `1`/`0`; a literal `false` is ignored. `isBooked=false` does not
  return unbooked transactions.
- **Sources:** [genz-its/sevdesk](https://github.com/genz-its/sevdesk) docs.
- **Impact:** The client serializes booleans as `1`/`0` and always sends `depth=1` for contact
  lists. "Unbooked" transactions are selected by `status` (100 created, 200 linked) instead of
  `isBooked`.
- **Test:** `test/unit/tools/contacts/search.test.ts` (`depth=1`), `test/regressions/b16-zero-values.test.ts` (booleans as `1`/`0`). `isBooked`: pending (M2 banking).

### D-021: Validation errors can come back as 500

- **Status:** Open. **Evidence:** spec + API news + community.
- **Spec says:** Only 16 responses declare `422`. Not-found GETs declare `400` ("Bad request.
  Invoice was not found"); no operation declares `404`.
- **Actual behavior:** Some validation failures still return 500 instead of 422, sometimes with a
  raw PHP `TypeError` message. Missing objects can return 400 (or, for GET-by-id, an empty array,
  see D-001) rather than 404.
- **Sources:**
  [API news 2024-04-08, "Changing some 500 HTTP status codes to 422"](https://tech.sevdesk.com/api_news/posts/2024_04_08-changes_http_error_codes/);
  [n8n community: create an invoice with sevDesk](https://community.n8n.io/t/create-an-invoice-with-sevdesk/46146).
- **Impact:** `src/sevdesk/errors.ts` classifies a 500 whose body looks like a validation message
  as a validation error and gives an actionable message. A 500 on a write is never retried.
- **Test:** `test/unit/sevdesk/errors.test.ts` (500s that read like validation are `validation`).

### D-022: Rate limiting is undocumented

- **Status:** Open. **Evidence:** community (secondary).
- **Spec says:** No `429` response and no `Retry-After` header anywhere.
- **Actual behavior:** Integrators report 429 responses under load. No limit is published.
- **Sources:**
  [nordflux.de: Connecting Lexoffice, sevDesk, or DATEV](https://nordflux.de/en/insights/connecting-lexoffice-sevdesk-or-datev-which-interface-carries-your-automation);
  [Chift rate-limit docs](https://docs.chift.eu/developer-guide/core-concepts/rate-limits)
  (a unified-API vendor that retries connector 429s). To be confirmed during the M3 recording
  session.
- **Impact:** The client paces requests (about 4 per second), honors `Retry-After` if present, and
  retries 429 only for GETs.
- **Test:** `test/unit/sevdesk/client.test.ts` (429 retry with `Retry-After`), `test/unit/sevdesk/pacing.test.ts` (client-side pacing).

### D-023: Some GETs change state

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `GET /Invoice/{invoiceId}/getPdf` (and the order and credit-note variants) has a
  `preventSendBy` parameter described as "Defines if u want to send the invoice". It does not say
  what happens without it. `GET /CreditNote/{creditNoteId}/sendByWithRender` is a GET that marks
  the document as sent. The DATEV export GETs `/Export/createDatevCsvZipExportJob`
  (`enshrineDocuments`) and the deprecated `/Export/datevCSV` (`enshrine`) take a flag that
  enshrines every exported document, which is irreversible.
- **Actual behavior:** `getPdf` without `preventSendBy` marks the document as sent (status
  change). It must be called with `preventSendBy` set to true.
- **Sources:** spec; [joosthel/sevdesk-mcp v0.5.0](https://github.com/joosthel/sevdesk-mcp/releases/tag/v0.5.0)
  changelog.
- **Impact:** The client recognizes these endpoints by path (`resolveGetSafety` in
  `src/sevdesk/paths.ts`), not only through the caller's `sideEffect` flag. A `getPdf` that is not
  declared a side effect always goes out with `preventSendBy=1`; an explicit `preventSendBy` of
  false/0 makes it a side effect. `sendByWithRender` and any GET with a truthy `enshrine` or
  `enshrineDocuments` flag are always side effects. Side-effect GETs count as writes: they need a
  declared tier that `SEVDESK_ALLOW` enables, are refused in read-only and dry-run mode, and are
  never retried. Which literal sevDesk accepts (`true` or `1`, see D-020) is confirmed in the M3
  recording session.
- **Test:** `test/regressions/getpdf-side-effect-blocked.test.ts` (flagged and unflagged
  side-effect GETs), `test/unit/sevdesk/client.test.ts` ("state-changing GET endpoints"),
  `test/unit/sevdesk/paths.test.ts` (`resolveGetSafety`). The `getPdf` tool itself: pending (M2),
  plus regression test B1.

### D-024: Undocumented endpoints we rely on

- **Status:** Open. **Evidence:** community.
- **Spec says:** None of these endpoints appear in the spec.
- **Actual behavior:** They exist and other integrations use them. "Known" means community SDKs
  use the endpoint routinely; "uncertain" means we found only isolated uses. None of them has been
  recorded by this project yet.

  | Endpoint                                      | Used for                                                       | Standing  |
  | --------------------------------------------- | -------------------------------------------------------------- | --------- |
  | `GET /SevUser`                                | `contactPerson`, required on invoices, orders and credit notes | known     |
  | `GET /StaticCountry`                          | country ids for addresses                                      | known     |
  | `GET /PaymentMethod`                          | payment method ids                                             | known     |
  | `GET /Unity`                                  | units for positions                                            | known     |
  | `GET /AccountDatev`                           | booking accounts (update 2.0)                                  | known     |
  | `GET /Category`                               | categories                                                     | known     |
  | `GET /TextTemplate`                           | head and foot texts                                            | known     |
  | `GET /PartUnity`                              | units for parts                                                | known     |
  | `GET /Document`, document download            | attached documents and receipts                                | known     |
  | `GET /SevSequence/Factory/getByType`          | next document number (see D-027)                               | known     |
  | `DELETE /Voucher/{voucherId}`                 | deleting draft vouchers (the spec has only GET and PUT)        | uncertain |
  | `POST /Voucher/Factory/createVoucherFromFile` | voucher from an uploaded file                                  | uncertain |

  The 2026 PDF post (D-025) also names `render`, `changeParameter` and `sendByWithRender`
  endpoints for orders, credit notes and letters that the spec does not list.

- **Sources:** [genz-its/sevdesk](https://github.com/genz-its/sevdesk),
  [exlo89/laravel-sevdesk-api](https://github.com/exlo89/laravel-sevdesk-api),
  [lippoliv/paperlessngx-to-sevdesk](https://github.com/lippoliv/paperlessngx-to-sevdesk)
  (`createVoucherFromFile`).
- **Impact:** Each undocumented endpoint gets a hand-written schema, a smoke test, and lives in
  the `advanced` toolset or behind a lookup until a recording confirms its shape. `uncertain`
  endpoints are not used by default tools.
- **Test:** `test/unit/tools/meta/reference-lookup.test.ts`, `test/unit/tools/meta/account-info.test.ts` (`/SevUser`, `/StaticCountry`, `/Unity`, `/PaymentMethod`). Others: pending with their tools.

### D-025: PDF rendering returns one base64 `pdf` since 2026-04-07

- **Status:** Partly fixed upstream. **Evidence:** spec + API news.
- **Spec says:** `POST /Invoice/{invoiceId}/render`, the `changeParameter` endpoints
  (`Model_ChangeLayoutResponse`) and `CreditNote/{creditNoteId}/sendByWithRender` now return
  `pdf` ("Base64-encoded PDF"); `thumbs` and `pages` are gone. This matches the change. But the
  responses are declared without the `objects` wrapper, and the `render`/`sendByWithRender`
  variants for orders, credit notes and letters are missing (D-024).
- **Actual behavior:** Since 2026-04-07 these endpoints return `{objects: {…, pdf: "<base64>"}}`.
  The `getAsPdf=true` opt-in from the transition period is ignored.
- **Sources:**
  [API news 2026-02-19, "Breaking Changes Q1 2026"](https://tech.sevdesk.com/api_news/posts/2026_02_breaking_changes_q1_2026/).
- **Impact:** Render schemas expect `pdf` only. The PDF is written to a file or returned as a
  resource, never inlined as base64 text.
- **Test:** pending (M2): PDF rendering.

### D-026: `saveVoucher` key order and top-level `filename`

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** The `saveVoucher` description says "the order of the last two attributes always
  needs to be kept" (`voucherPosDelete`, then `filename`), and `uploadTempFile` says the file is
  attached only if all parameters are "in the right order". `filename` is a top-level property of
  `saveVoucher`.
- **Actual behavior:** `filename` must be top-level, next to `voucher`. Inside `voucher` it is
  dropped silently (D-003), and the voucher has no document.
- **Sources:** spec; [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2).
- **Impact:** The `saveVoucher` builder emits keys in a fixed order (`voucher`, `voucherPosSave`,
  `voucherPosDelete`, `filename`) and the read-back checks that `document` is set.
- **Test:** pending (M4): voucher upload, plus regression test B5.

### D-027: Document numbers can contain unexpanded placeholders

- **Status:** Open. **Evidence:** community.
- **Spec says:** Nothing about number formats.
- **Actual behavior:** When sevDesk assigns the number (for example `invoiceNumber: null`), it has
  returned the raw pattern with placeholders, such as `RE-%YYYY%MM1038`.
- **Sources:**
  [exlo89/laravel-sevdesk-api#16](https://github.com/exlo89/laravel-sevdesk-api/issues/16).
- **Impact:** After creating a document we read it back and warn if the number still contains
  `%…%` placeholders, so the user can fix the number range in sevDesk.
- **Test:** pending (M3): document numbering.

### D-028: Kleinunternehmer tax rule id differs between spec sections

- **Status:** Open. **Evidence:** spec, recorded (community recording).
- **Spec says:** The Voucher section lists the Kleinunternehmer (§19 UStG) rule as id `1`.
- **Actual behavior:** The spec's tax-rule tables and a recorded `GET /TaxRule` response both use
  id `11`; id `1` is "Umsatzsteuerpflichtige Umsätze".
- **Sources:** `spec/openapi.yaml` (Voucher and tax-rule sections);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (2026-02-19).
- **Impact:** `src/domain/reference-data.ts` uses `11`; the Voucher-section value is treated as a
  typo.
- **Test:** `test/regressions/b9-reference-ids.test.ts`.

### D-029: Tax rule 21 has two different names

- **Status:** Open. **Evidence:** spec, recorded (community recording).
- **Spec says:** Rule 21 is "§18b UStG (field 21)".
- **Actual behavior:** `GET /TaxRule` names it "§13b Abs. 1 USTG EU Umsätze". Both describe
  services to businesses in other EU states.
- **Sources:** `spec/openapi.yaml`; the recording linked in D-028.
- **Impact:** Reference data keeps both names so either wording maps to rule 21.
- **Test:** `test/regressions/b9-reference-ids.test.ts`.

### D-030: Undocumented tax rules 15, 16 and 22

- **Status:** Open. **Evidence:** recorded (community recording).
- **Spec says:** Nothing about ids 15, 16 or 22.
- **Actual behavior:** `GET /TaxRule` returns 15 "Nicht Steuerbar (Steuer)", 16 "Nicht Steuerbar
  (Ausgabe)" and 22 "Nicht Steuerbar (Einnahme)".
- **Sources:** the recording linked in D-028; joosthel/sevdesk-mcp lists 16 and 22.
- **Impact:** Included in reference data with `documented: false`. Write tools (M3) will warn when
  one is used until it is verified against a live account.
- **Test:** `test/regressions/b9-reference-ids.test.ts`.

### D-031: Transaction status 350 exists only in the response model

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The CheckAccountTransaction tag docs list statuses 100, 200, 300 and 400.
- **Actual behavior:** The transaction response model also allows 350 ("auto-booked without
  confirmation").
- **Sources:** `spec/openapi.yaml` (`Model_CheckAccountTransactionResponse`).
- **Impact:** Reference data includes 350; the banking DTOs (M2) will accept it.
- **Test:** `test/regressions/b9-reference-ids.test.ts` (status list). Banking DTOs: pending (M2).

### D-032: The `contact[id]` filter on `/ContactAddress` is undocumented

- **Status:** Open. **Evidence:** community.
- **Spec says:** `GET /ContactAddress` declares no contact filter.
- **Actual behavior:** Integrators filter with `contact[id]=…&contact[objectName]=Contact`; whether
  sevDesk always honors it is not verified.
- **Sources:** used by other sevDesk integrations; not yet verified in a recording of our own.
- **Impact:** `getContactDetails` sends the filter and also filters the result by contact id, so an
  ignored filter can never leak another contact's addresses.
- **Test:** `test/unit/tools/contacts/get.test.ts` (defensive filter).

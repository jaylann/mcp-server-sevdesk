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
  "Pending: M3 recording session" names the probe of `pnpm probe` (`scripts/probe-api.ts`,
  probes in `scripts/lib/probes/`) that checks the behavior against a real account; its report
  groups the results by entry id.
- When the drift check (`scripts/check-spec-drift.ts`) reports a spec change, re-check the
  entries it touches and update their status.

## Index

| Id                                                                                     | Title                                                                     | Status                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------- |
| [D-001](#d-001-most-write-and-pdf-responses-are-wrapped-in-objects)                    | Most write and PDF responses are wrapped in `{objects: …}`                | Open                  |
| [D-002](#d-002-scalars-come-back-as-strings)                                           | Scalars come back as strings                                              | Open                  |
| [D-003](#d-003-unknown-request-fields-are-silently-ignored)                            | Unknown request fields are silently ignored                               | Open                  |
| [D-004](#d-004-the-save-factories-require-properties-that-do-not-exist)                | The `save*` factories require properties that do not exist                | Open                  |
| [D-005](#d-005-model_invoice-requires-tax-fields-of-both-system-versions)              | `Model_Invoice` requires tax fields of both system versions               | Open                  |
| [D-006](#d-006-taxrule-id-enums-are-incomplete)                                        | `taxRule` id enums are incomplete                                         | Partly fixed upstream |
| [D-007](#d-007-voucher-status-and-recurringinterval-enums-are-too-narrow)              | Voucher `status` and `recurringInterval` enums are too narrow             | Open                  |
| [D-008](#d-008-two-response-fields-typed-string-can-be-numbers)                        | Two response fields typed `string` can be numbers                         | Open                  |
| [D-009](#d-009-sendtype-can-be-an-empty-string-or-0)                                   | `sendType` can be an empty string or `"0"`                                | Open                  |
| [D-010](#d-010-createinvoicefromorder-required-a-bogus-invoice-id)                     | `createInvoiceFromOrder` required a bogus invoice id                      | Fixed upstream        |
| [D-011](#d-011-uploadtempfile-media-type-and-filename-type-are-wrong)                  | `uploadTempFile` media type and `filename` type are wrong                 | Open                  |
| [D-012](#d-012-export-endpoints-return-raw-csv-or-zip-with-downloadtrue)               | Export endpoints return raw CSV or ZIP with `download=true`               | Open                  |
| [D-013](#d-013-invoice-bookamount-response-has-copy-paste-errors)                      | Invoice `bookAmount` response has copy-paste errors                       | Open                  |
| [D-014](#d-014-accountintervall-example-is-a-date)                                     | `accountIntervall` example is a date                                      | Open                  |
| [D-015](#d-015-invoice-type-filters-use-re-instead-of-re)                              | Invoice type filters use `Re` instead of `RE`                             | Open                  |
| [D-016](#d-016-valuedate-and-entrydate-descriptions-are-swapped)                       | `valueDate` and `entryDate` descriptions are swapped                      | Open                  |
| [D-017](#d-017-originobjectname-only-allowed-invoice)                                  | `origin.objectName` only allowed `Invoice`                                | Fixed upstream        |
| [D-018](#d-018-document-dates-are-typed-date-time-but-take-unix-or-ddmmyyyy)           | Document dates are typed `date-time` but take Unix or `dd.mm.yyyy`        | Open                  |
| [D-019](#d-019-pagination-limits-and-silent-truncation-at-100)                         | Pagination limits and silent truncation at 100                            | Partly fixed upstream |
| [D-020](#d-020-list-filters-behave-differently-from-their-declared-types)              | List filters behave differently from their declared types                 | Open                  |
| [D-021](#d-021-validation-errors-can-come-back-as-500)                                 | Validation errors can come back as 500                                    | Open                  |
| [D-022](#d-022-rate-limiting-is-undocumented)                                          | Rate limiting is undocumented                                             | Open                  |
| [D-023](#d-023-some-gets-change-state)                                                 | Some GETs change state                                                    | Open                  |
| [D-024](#d-024-undocumented-endpoints-we-rely-on)                                      | Undocumented endpoints we rely on                                         | Open                  |
| [D-025](#d-025-pdf-rendering-returns-one-base64-pdf-since-2026-04-07)                  | PDF rendering returns one base64 `pdf` since 2026-04-07                   | Partly fixed upstream |
| [D-026](#d-026-savevoucher-key-order-and-top-level-filename)                           | `saveVoucher` key order and top-level `filename`                          | Open                  |
| [D-027](#d-027-document-numbers-are-assigned-on-finalizing-and-can-show-placeholders)  | Document numbers are assigned on finalizing and can show placeholders     | Open                  |
| [D-028](#d-028-kleinunternehmer-tax-rule-id-differs-between-spec-sections)             | Kleinunternehmer tax rule id differs between spec sections                | Open                  |
| [D-029](#d-029-tax-rule-21-has-two-different-names)                                    | Tax rule 21 has two different names                                       | Open                  |
| [D-030](#d-030-undocumented-tax-rules-15-16-and-22)                                    | Undocumented tax rules 15, 16 and 22                                      | Open                  |
| [D-031](#d-031-transaction-status-350-exists-only-in-the-response-model)               | Transaction status 350 exists only in the response model                  | Open                  |
| [D-032](#d-032-the-contactid-filter-on-contactaddress-is-undocumented)                 | The `contact[id]` filter on `/ContactAddress` is undocumented             | Open                  |
| [D-033](#d-033-getxml-refusals-for-invoices-without-xml-are-undocumented)              | `getXml` refusals for invoices without XML are undocumented               | Open                  |
| [D-034](#d-034-invoice-reads-do-not-say-whether-an-invoice-is-an-e-invoice)            | Invoice reads do not say whether an invoice is an e-invoice               | Open                  |
| [D-035](#d-035-unknown-or-misspelled-list-filters-are-ignored)                         | Unknown or misspelled list filters are ignored                            | Open                  |
| [D-036](#d-036-getrelatedobjects-is-declared-to-return-order-positions)                | `getRelatedObjects` is declared to return order positions                 | Open                  |
| [D-037](#d-037-cancelled-invoices-keep-status-1000)                                    | Cancelled invoices keep status 1000                                       | Open                  |
| [D-038](#d-038-the-credit-note-status-filter-allows-order-statuses)                    | The credit note status filter allows order statuses                       | Open                  |
| [D-039](#d-039-credit-note-and-position-responses-have-undeclared-fields)              | Credit note and position responses have undeclared fields                 | Open                  |
| [D-040](#d-040-the-creditnotepos-filter-names-the-wrong-objectname)                    | The `CreditNotePos` filter names the wrong `objectName`                   | Open                  |
| [D-041](#d-041-bookamount-on-vouchers-and-credit-notes-takes-a-signed-amount)          | `bookAmount` on vouchers and credit notes takes a signed amount           | Open                  |
| [D-042](#d-042-part-price-is-documented-as-net-but-holds-the-gross-price)              | Part `price` is documented as net but holds the gross price               | Open                  |
| [D-043](#d-043-the-currency-of-document-sums-is-undocumented)                          | The currency of document sums is undocumented                             | Open                  |
| [D-044](#d-044-voucher-reads-can-omit-document)                                        | Voucher reads can omit `document`                                         | Open                  |
| [D-045](#d-045-voucher-positions-can-lack-accountdatev-on-update-20)                   | Voucher positions can lack `accountDatev` on Update 2.0                   | Open                  |
| [D-046](#d-046-date-range-filters-on-document-lists-are-described-two-ways)            | Date-range filters on document lists are described two ways               | Open                  |
| [D-047](#d-047-transaction-date-filters-compare-entrydate)                             | Transaction date filters compare `entryDate`                              | Open                  |
| [D-048](#d-048-change-filters-are-documented-only-in-tag-texts)                        | Change filters are documented only in tag texts                           | Open                  |
| [D-049](#d-049-whether-lists-include-templates-and-reminders-is-undocumented)          | Whether lists include templates and reminders is undocumented             | Open                  |
| [D-050](#d-050-a-position-price-is-read-by-the-documents-shownet)                      | A position `price` is read by the document's `showNet`                    | Open                  |
| [D-051](#d-051-savecreditnote-needs-other-fields-than-model_creditnote-requires)       | `saveCreditNote` needs other fields than `Model_creditNote` requires      | Open                  |
| [D-052](#d-052-draft-requests-use-fields-the-request-models-do-not-declare)            | Draft requests use fields the request models do not declare               | Open                  |
| [D-053](#d-053-the-trailing-factory-parameters-are-optional)                           | The trailing factory parameters are optional                              | Open                  |
| [D-054](#d-054-updating-a-draft-through-the-save-factories-is-barely-documented)       | Updating a draft through the save factories is barely documented          | Open                  |
| [D-055](#d-055-the-saveinvoice-answer-has-undeclared-and-oddly-typed-fields)           | The `saveInvoice` answer has undeclared and oddly typed fields            | Open                  |
| [D-056](#d-056-which-day-a-bookamount-date-means-is-undocumented)                      | Which day a `bookAmount` date means is undocumented                       | Open                  |
| [D-057](#d-057-transactions-report-no-assigned-or-remaining-amount)                    | Transactions report no assigned or remaining amount                       | Open                  |
| [D-058](#d-058-cancelinvoice-answers-and-refusals-are-undocumented)                    | `cancelInvoice` answers and refusals are undocumented                     | Open                  |
| [D-059](#d-059-enshrine-is-idempotent-and-does-not-block-payments)                     | `enshrine` is idempotent and does not block payments                      | Open                  |
| [D-060](#d-060-resettoopen-works-on-enshrined-documents-and-unlinks-payments-silently) | `resetToOpen` works on enshrined documents and unlinks payments silently  | Open                  |
| [D-061](#d-061-post-contact-assigns-the-next-customer-number)                          | `POST /Contact` assigns the next customer number                          | Open                  |
| [D-062](#d-062-put-on-contacts-addresses-and-communication-ways-is-a-partial-update)   | PUT on contacts, addresses and communication ways is a partial update     | Open                  |
| [D-063](#d-063-createinvoicefromorder-amount-is-described-as-the-amount-already-paid)  | `createInvoiceFromOrder` `amount` is described as the amount already paid | Open                  |
| [D-064](#d-064-answers-of-the-derived-document-factories-are-unrecorded)               | Answers of the derived-document factories are unrecorded                  | Open                  |
| [D-065](#d-065-receiptguidance-tax-rate-words-and-paging-are-unspecified)              | ReceiptGuidance tax rate words and paging are unspecified                 | Open                  |

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
  array, which can be empty when the id does not exist. Recorded write answers all carry the
  wrapper, with the record itself (not an array of one) under `objects`: `POST /Contact`,
  `POST /ContactAddress`, `POST /CommunicationWay`, `saveInvoice`, `saveCreditNote` and
  `cancelInvoice` (jernoxit/sevdesk-rs), `POST /Part` (emuuu/sevDesk.NET). `enshrine` answers
  `{objects: null}`, as the spec declares. The answers of `sendViaEmail`, `sendBy`,
  `resetToOpen`/`resetToDraft`, `createInvoiceFromOrder` and `bookAmount` on invoices and credit
  notes are not recorded anywhere; the only recorded `bookAmount` answer is the voucher's (D-013).
- **Sources:** [j-mastr/sevdesk-api#12](https://github.com/j-mastr/sevdesk-api/pull/12)
  (createInvoiceReminder), [#28](https://github.com/j-mastr/sevdesk-api/pull/28) (saveVoucher),
  [#53](https://github.com/j-mastr/sevdesk-api/pull/53) (all create/update responses),
  [#66](https://github.com/j-mastr/sevdesk-api/pull/66) (PDF retrievals),
  [j-mastr/sevdesk-php-sdk#70](https://github.com/j-mastr/sevdesk-php-sdk/issues/70);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) recorded fixtures
  (`tests/fixtures/write_contact_create.json`, `write_contact_address_create.json`,
  `write_communication_way_create.json`, `write_invoice_save.json`, `write_credit_note_save.json`,
  `write_invoice_cancel.json`; live test account, 2026-10-01) and `src/endpoints/invoice.rs`
  (`enshrine_invoice`, measured, not recorded);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (`POST /Part`,
  2026-02-19).
- **Impact:** `src/sevdesk/envelope.ts` unwraps every response. It accepts both an object and an
  array of one under `objects`, and maps an empty array from a GET-by-id to a not-found error.
  Write tools take only the new record's id from the unwrapped answer and read the record back
  with a GET; the lifecycle tools ignore the answer apart from the envelope, except that
  cancelling reads the cancellation invoice's id from it (D-058).
- **Test:** `test/unit/sevdesk/envelope.test.ts`, `test/unit/sevdesk/client.test.ts` (unwrapping
  for every method), `test/unit/domain/document-files.test.ts` (`getPdf` fixtures
  `test/fixtures/documents/*-pdf.json` wrapped in `objects`, as an object or an array of one).
  Write answers: the fixtures in `test/fixtures/lifecycle/`, `test/fixtures/drafts/` and
  `test/fixtures/masterdata/` (each states whether it is recorded or built from the spec), used by
  `test/unit/tools/lifecycle/*.test.ts`, `test/unit/tools/drafts/*.test.ts` and
  `test/unit/tools/masterdata/*.test.ts`; `test/unit/domain/drafts/payloads.test.ts` ("reads the
  id from an object or an array of one"); `test/regressions/b7-payment-linking.test.ts` (an
  enveloped `bookAmount` answer through the real HTTP client). Unrecorded answers: pending: M3
  recording session, probes `write-send-email-shape`, `write-book-amount`,
  `write-invoice-from-order`.

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
- **Test:** `test/unit/sevdesk/schema.test.ts` (lenient
  `zId`/`zIntish`/`zNumberish`/`zDecimalString`/`zBool01`), `test/unit/domain/contacts.test.ts`,
  `test/unit/domain/invoices.test.ts` (`showNet` and `smallSettlement` as `"0"`/`"1"`),
  `test/unit/tools/invoices/list.test.ts` (`paidAmount` as a JSON number).

### D-003: Unknown request fields are silently ignored

- **Status:** Open. **Evidence:** community.
- **Spec says:** Nothing. No schema sets `additionalProperties: false`, and no text says what
  happens to unknown fields.
- **Actual behavior:** sevDesk drops unknown fields and still reports success. Example: a
  `fileName` inside the `voucher` object of `saveVoucher` is dropped, and the voucher is created
  without its document.
- **Sources:** [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2) (verified
  against a live account).
- **Impact:** Outgoing zod schemas are strict: every write body is parsed with a `strictObject`
  schema right before it is sent (`src/domain/drafts/payloads.ts`,
  `src/domain/lifecycle/payments.ts`, `src/domain/lifecycle/email.ts`,
  `src/tools/lifecycle/finalize.ts`, `src/domain/contacts-write.ts`, `src/domain/parts-write.ts`,
  `src/domain/derived-documents.ts`), so a misspelled key is a bug that fails before sending. Tool
  inputs reject unknown parameters with a message that names them. Writes are read back; the
  draft tools compare the stored totals with the preview (D-050).
- **Test:** `test/unit/domain/drafts/payloads.test.ts` ("draft payloads: strict outgoing schemas
  (D-003, D-004, B8)": unknown and derived keys are refused as internal errors),
  `test/integration/metadata-lint.test.ts` ("has a strict, flat object-root input JSON Schema",
  every tool). sevDesk's own behavior: pending: M3 recording session, probe `write-unknown-field`.

### D-004: The `save*` factories require properties that do not exist

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `saveInvoice.required` is `[invoice, invoicePos]`, but the properties are
  `invoicePosSave` and `invoicePosDelete`. `saveVoucher.required` is `[voucher, voucherPos]`, but
  the properties are `voucherPosSave` and `voucherPosDelete`. The same holds for
  `saveCreditNote` (`required: [creditNote, creditNotePos]`, properties `creditNotePosSave`,
  `creditNotePosDelete`) and `saveOrder` (`required: [order, orderPos]`, properties
  `orderPosSave`, `orderPosDelete`). The response schemas use `invoicePos`/`voucherPos`/
  `creditNotePos`/`orderPos`, and the InvoicePos tag's update example sends `"invoicePos"` too.
- **Actual behavior:** The API reads `invoicePosSave`/`creditNotePosSave`/`orderPosSave`/
  `voucherPosSave` (and `*PosDelete`). A client that follows `required` and sends `invoicePos`
  loses its positions without an error (see D-003).
- **Sources:** spec (`components.schemas.saveInvoice`, `saveCreditNote`, `saveOrder`,
  `saveVoucher`; tag `InvoicePos`, "How to create/update an invoice position");
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`invoicePosSave` and
  `creditNotePosSave` requests whose answers are recorded in `tests/fixtures/write_invoice_save.json`
  and `write_credit_note_save.json`); `orderPosSave` in the working order bodies of
  [codestra/sevdesk-mcp](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts)
  (community, not recorded).
- **Impact:** The draft builders send `invoicePosSave`/`creditNotePosSave`/`orderPosSave` only;
  the strict body schemas in `src/domain/drafts/payloads.ts` have no `*Pos` key, and our schemas
  do not copy the spec's `required` lists. `voucherPosSave` follows with the voucher writes (M4).
  How `*PosDelete` is typed: D-054.
- **Test:** `test/unit/domain/drafts/payloads.test.ts` ("refuses the spec's non-existent
  invoicePos as an internal error"), `test/regressions/b8-price-fields.test.ts` (positions under
  `invoicePosSave`, `creditNotePosSave`, `orderPosSave`),
  `test/unit/tools/drafts/invoice-update-draft.test.ts` ("replaces all positions in one request
  (deletes the stored ones)"). `saveVoucher`: pending (M4).

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
- **Sources:** spec overview, section "sevdesk-Update 2.0 → Tax Rules";
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (Update 2.0 `saveInvoice` and
  `saveCreditNote` requests with `taxRule`, `taxRate: 0`, `taxText` and no `taxType`; answers
  recorded in `tests/fixtures/write_invoice_save.json`, `write_credit_note_save.json`).
- **Impact:** `getBookkeepingSystemVersion` (`src/sevdesk/system-version.ts`) reads the version,
  and `src/domain/drafts/tax.ts` writes the tax setting for it: on 2.0 `taxRule`, on 1.0 the
  rule's legacy `taxType` (`default`, `eu`, `noteu`, `ss`; rules without one are refused,
  `custom` tax sets are not offered). The document-level `taxRate` is always 0. The strict body
  schemas (`src/domain/drafts/payloads.ts`) allow exactly one of `taxRule` and `taxType` instead
  of the spec's merged `required` list.
- **Test:** `test/unit/domain/drafts/tax.test.ts` ("writes taxRule on Update 2.0 and the legacy
  taxType on 1.0", "maps stored legacy tax types back to rules"),
  `test/unit/tools/drafts/invoice-create-draft.test.ts` ("writes the legacy taxType on a
  bookkeeping 1.0 account"), `test/unit/domain/drafts/payloads.test.ts` ("refuses both taxRule
  and taxType", "refuses neither taxRule nor taxType", as internal errors).

### D-006: `taxRule` id enums are incomplete

- **Status:** Partly fixed upstream. **Evidence:** spec + community.
- **Spec says:** `taxRule.id` is a string enum. On invoices, orders and credit notes it is now
  `1, 2, 3, 4, 5, 11, 17, 18, 19, 20, 21`. On vouchers (`Model_Voucher`, `Model_VoucherResponse`,
  `Model_VoucherUpdate`) it is still `1, 2, 3, 4, 5, 11`: the revenue rules only. The spec's own
  "Tax Rules" overview lists the expense rules `8, 9, 10, 12, 13, 14`, which no enum allows.
- **Actual behavior:** Vouchers are usually expenses and use rules 8–10 and 12–14; ReceiptGuidance
  also returns 16. A Kleinunternehmer expense account allows exactly 10 and 13. Rule 22 has been
  reported too (unverified). Credit notes with booking category `PROVISION` take the expense rule
  9 and refuse rule 1 ("Invalid tax rule"), although the credit note enum allows only revenue
  rules.
- **Sources:** [j-mastr/sevdesk-api#68](https://github.com/j-mastr/sevdesk-api/pull/68),
  [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2), spec overview;
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) `src/endpoints/credit_note.rs`
  (PROVISION and rule 9, measured 2026-09-29, not recorded).
- **Impact:** Response schemas accept any id string. Sales drafts (invoices, orders, credit
  notes) accept the rules of the spec's sales-document enum (`SALES_TAX_RULE_IDS` in
  `src/domain/drafts/tax.ts`); provision credit notes accept rule 9 only
  (`src/domain/drafts/credit-note.ts`). For receipts, `validateAccountTaxRule`
  (`src/domain/receipt-guidance.ts`) checks account × tax rule × tax rate against the cached
  ReceiptGuidance instead of a static enum (D-065); the voucher writes that call it follow in M4.
- **Test:** `test/regressions/b9-reference-ids.test.ts` (all tax-rule ids, checked against the
  recorded `GET /TaxRule`), `test/unit/domain/drafts/tax.test.ts` ("covers exactly the spec's
  sales-document rule enum"), `test/unit/tools/drafts/credit-note-create-draft.test.ts` ("uses
  tax rule 9 for a provision credit note without a source invoice", "a provision credit note with
  tax rule 1"), `test/unit/domain/receipt-guidance.test.ts` ("checkAccountTaxRule",
  "validateAccountTaxRule").

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
- **Test:** `test/regressions/b9-reference-ids.test.ts` (voucher statuses 50/100/150/750/1000),
  `test/unit/domain/vouchers.test.ts` (`recurringInterval` in several ISO 8601 spellings).

### D-008: Two response fields typed `string` can be numbers

- **Status:** Open. **Evidence:** community, recorded (community recording).
- **Spec says:** `Model_CheckAccountTransactionResponse.amount` is `type: string`, and
  `Model_ContactResponse.defaultDiscountAmount` is `type: string, format: float`.
- **Actual behavior:** Both have been reported as JSON numbers, unlike most other scalars (D-002).
  The recorded `GET /CheckAccountTransaction` row has `amount` as the string `"-250"`, so both
  forms occur.
- **Sources:** [j-mastr/sevdesk-api#90](https://github.com/j-mastr/sevdesk-api/pull/90);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (2026-02-19).
- **Impact:** Covered by the lenient number coercion from D-002. The transaction fixture
  (`test/fixtures/banking/transactions-list.json`) has both forms. No tool reads
  `defaultDiscountAmount`.
- **Test:** `test/unit/tools/banking/transactions.test.ts` (`amount` as a string and as a number).

### D-009: `sendType` can be an empty string or `"0"`

- **Status:** Open. **Evidence:** community.
- **Spec says:** `sendType` is a nullable enum `VPR, VPDF, VM, VP`.
- **Actual behavior:** Orders, invoices and credit notes can also return `""` or `"0"`.
- **Sources:** [j-mastr/sevdesk-api#45](https://github.com/j-mastr/sevdesk-api/issues/45).
- **Impact:** `""`, `"0"`, `null` and unknown codes all count as "no send type". The read tools
  show a document as sent only with a documented send type or a `sendDate`. The finalize tools
  write only the four documented codes (`VPDF` by default, `VP`, `VPR`, `VM`; strict `sendBy`
  body in `src/tools/lifecycle/finalize.ts`).
- **Test:** `test/unit/domain/document-positions.test.ts` ("treats empty, '0' and unknown send
  types as not sent"), `test/unit/tools/invoices/list.test.ts`. Writing:
  `test/unit/tools/lifecycle/finalize.test.ts` ("marks the draft as sent with sendDraft false,
  then reads it back").

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
- **Impact:** `client.download` (`src/sevdesk/client.ts`) returns the raw body with its
  `Content-Type` instead of parsing JSON, so the caller decides by the type, not by the endpoint.
  The export tools are to write files to `SEVDESK_OUTPUT_DIR` or return resources; the bytes never
  go through the model.
- **Test:** `test/unit/sevdesk/client.test.ts` ("download": raw bytes and their content type).
  Export tools: pending (M4, with DATEV).

### D-013: Invoice `bookAmount` response has copy-paste errors

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The `PUT /Invoice/{invoiceId}/bookAmount` response (an `InvoiceLog`) has a
  property `creditNote` whose description says "The id of the invoice", a property
  `ammountPayed` (sic), and a `create` field described as "Date of email creation".
- **Actual behavior:** Neither the invoice nor the credit note answer (`CreditNoteLog`, which has
  the same `ammountPayed` and "Date of email creation") has been recorded anywhere; the property
  names look copied from the credit-note endpoint. The only recorded booking answer is the
  voucher's: a `VoucherLog` wrapped in `objects` (D-001), with `amountPayed` (one m) and
  `bookingDate` at 12:00 Berlin time.
- **Sources:** spec (`bookInvoice`, `bookCreditNote`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  `tests/fixtures/write_voucher_book_amount.json` (recorded `PUT /Voucher/{id}/bookAmount`).
- **Impact:** We do not model this response. The booking tools
  (`src/tools/lifecycle/book-payment.ts`) ignore the answer apart from the envelope and read the
  invoice or credit note back (`paidAmount`, `status`) instead of trusting the log entry.
- **Test:** `test/unit/tools/lifecycle/book-payment.test.ts` ("books the full open amount linked
  to the bank transaction and reads the invoice back"),
  `test/regressions/b7-payment-linking.test.ts`; fixtures
  `test/fixtures/lifecycle/invoice-book-amount.json` and `credit-note-book-amount.json` (built from
  the recorded VoucherLog). The real answer: pending: M3 recording session, probe
  `write-book-amount`.

### D-014: `accountIntervall` example is a date

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `Model_InvoiceResponse.accountIntervall` is described as "The interval in which
  recurring invoices are due as ISO-8601 duration", but its example is `'2022-03-14'`.
  `accountNextInvoice` is a `string` in the response model and an `integer` in the request model.
- **Actual behavior:** Not yet recorded; we expect an ISO-8601 duration as described.
- **Sources:** spec.
- **Impact:** The invoice tools show `accountIntervall` as text, exactly as sevDesk sent it, and do
  not parse it. `accountNextInvoice` is read as a date given as Unix seconds (number or string), ISO
  8601 or `dd.mm.yyyy`; any other value fails the call instead of being dropped.
- **Test:** `test/unit/domain/invoices.test.ts` ("maps the schedule of a recurring invoice (WKR)
  as sevDesk sent it").

### D-015: Invoice type filters use `Re` instead of `RE`

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The `invoiceType` filter enums of `/Export/invoiceCsv`, `/Export/invoiceZip` and
  `/Report/invoicelist` contain `Re`, while their own descriptions and `Model_Invoice.invoiceType`
  use `RE`.
- **Actual behavior:** Invoice types are upper case (`RE`). Whether `GET /Invoice` honors the
  `invoiceType` filter at all has not been measured (jernoxit/sevdesk-rs leaves it out for that
  reason; see also D-035).
- **Sources:** spec; [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs).
- **Impact:** `sevdesk_invoices_list` sends upper-case codes (`RE`, `AR`, `SR`, …) and checks the
  type of every returned row again, so an ignored filter cannot return other invoice types. Like
  the number re-check (D-035), this switches the list to a local scan (`filteredLocally`, no
  total). The order list (`orderType`) and the voucher list (`voucherType`) re-check their types
  the same way.
- **Test:** `test/unit/tools/invoices/list.test.ts` ("maps readable filters to sevDesk's codes and
  parameter names", "re-checks the invoice type on every row, so an ignored filter cannot leak"),
  `test/unit/tools/orders/list.test.ts` ("re-checks the order type on every row, so an ignored
  filter cannot leak"), `test/unit/tools/vouchers/list.test.ts` ("re-checks the voucher type on
  every row, so an ignored filter cannot leak").

### D-016: `valueDate` and `entryDate` descriptions are swapped

- **Status:** Open. **Evidence:** spec.
- **Spec says:** In `Model_CheckAccountTransaction`, `valueDate` is "Date the check account
  transaction was booked" and `entryDate` "was imported". In
  `Model_CheckAccountTransactionResponse` the two descriptions are the other way round.
- **Actual behavior:** At most one of the two can be right. The recorded transaction has both
  dates equal, so it does not settle the question. The list filters `startDate`/`endDate` compare
  `entryDate` (D-047). The response model also has status 350 (D-031).
- **Sources:** spec;
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (2026-02-19).
- **Impact:** The transaction DTO keeps both dates and describes each one. `valueDate` is treated
  as the transaction's date because the request model requires it, and date ranges apply to it by
  default. `entryDate` is an optional second date (the import date per the request model); a range
  applies to it with `dateField: "entry"` (D-047).
- **Test:** `test/unit/tools/banking/transactions.test.ts` (both dates, `entryDate` missing).

### D-017: `origin.objectName` only allowed `Invoice`

- **Status:** Fixed upstream (checked 2026-11-07). **Evidence:** community.
- **Spec says:** `Model_InvoiceResponse.origin.objectName` used to be an enum of `Invoice` only.
  The current spec has no enum ("Could f.e. be 'Order'").
- **Actual behavior:** Invoices created from an order have `origin.objectName: "Order"`.
- **Sources:** [j-mastr/sevdesk-api#55](https://github.com/j-mastr/sevdesk-api/issues/55).
- **Impact:** `origin` is parsed as a generic `{id, objectName}` reference. Kept for history.
- **Test:** none needed (fixed upstream); `test/unit/tools/invoices/get.test.ts` reads an invoice
  with `origin` `Order`.

### D-018: Document dates are typed `date-time` but take Unix or `dd.mm.yyyy`

- **Status:** Open. **Evidence:** spec.
- **Spec says:** Fields such as `voucherDate`, `deliveryDate` and `invoiceDate` are
  `type: string, format: date-time`, with the description "Needs to be provided as timestamp or
  dd.mm.yyyy" and examples like `01.01.2022`, which are not RFC 3339 date-times.
- **Actual behavior:** Document writes take a Unix timestamp or `dd.mm.yyyy`. Filters and exports
  take Unix timestamps. Responses return ISO 8601 date-times.
- **Sources:** spec.
- **Impact:** `src/sevdesk/dates.ts` has per-endpoint serializers and anchors calendar dates to
  Europe/Berlin. Responses are parsed as ISO 8601. The draft tools send document dates
  (`invoiceDate`, `creditNoteDate`, `orderDate`) as `dd.mm.yyyy` and delivery dates as Unix
  seconds of 00:00 Berlin time (`wireDocumentDate`, `wireTimestamp` in
  `src/domain/drafts/fields.ts`), the forms of the sevdesk-rs requests whose answers are recorded.
  Booking dates: D-056.
- **Test:** `test/unit/sevdesk/dates.test.ts` (`toSevdeskDate`, `toUnixSeconds`, `toBerlinDate`),
  `test/unit/tools/drafts/invoice-create-draft.test.ts` ("prepares the recorded body with
  defaults and reads only": `invoiceDate` `07.11.2026`, `deliveryDate` as Unix seconds).

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
  parameters must be sent as `1`/`0`; a literal `false` is ignored. `isBooked=true` returns only
  booked transactions, but `isBooked=false` is ignored and returns everything. A `status` filter,
  which the spec does not declare for `GET /CheckAccountTransaction`, works: `status=100` returns
  only transactions in that status.
- **Sources:** [genz-its/sevdesk](https://github.com/genz-its/sevdesk) docs and
  [`CLAUDE.md`](https://github.com/genz-its/sevdesk/blob/main/CLAUDE.md);
  [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs)
  (measured).
- **Impact:** The client serializes booleans as `1`/`0` and always sends `depth=1` for contact
  lists. `sevdesk_transactions_list` never sends `isBooked`. With exactly one status (for example
  `created`) it sends `status=<code>` to narrow the read; several statuses cannot go into one
  filter and are not sent. Either way it checks every row's status itself, so a server that
  ignores the filter changes nothing, and its output says that it filtered locally.
- **Test:** `test/unit/tools/contacts/search.test.ts` (`depth=1`),
  `test/regressions/b16-zero-values.test.ts` (booleans as `1`/`0`),
  `test/unit/tools/banking/transactions.test.ts` ("filters unbooked (created) transactions locally
  and counts sevDesk rows, not matches", "combines several statuses and a direction").

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
- **Actual behavior:** `getPdf` without `preventSendBy` marks the document as sent: a draft
  invoice or credit note is finalized (status 200), and if the account enshrines documents
  automatically on completion, it is enshrined too. It must be called with `preventSendBy` set to
  true. With `preventSendBy=true`, a credit note draft stays a draft (jernoxit/sevdesk-rs), and
  seven Update 1.0 orders (AN, AB, LI) kept their status, send date, send type and update time
  (firsttris/haben; not checked on Update 2.0). The account setting "Automatische Festschreibung
  von Dokumenten bei Fertigstellung" decides the enshrining for `getPdf` and for `PUT …/sendBy`
  alike: with it on, both set `enshrined`; with it off, `enshrined` stays `null` (sevdesk-rs,
  measured 2026-11-05 on invoices and credit notes). The spec's `invoiceSendBy` only says "Marks
  an invoice as sent".
- **Sources:** spec; [joosthel/sevdesk-mcp v0.5.0](https://github.com/joosthel/sevdesk-mcp/releases/tag/v0.5.0)
  changelog; [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README and
  `src/endpoints/invoice.rs`, measured 2026-11-05);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md).
- **Impact:** The client recognizes these endpoints by path (`resolveGetSafety` in
  `src/sevdesk/paths.ts`), not only through the caller's `sideEffect` flag. A `getPdf` that is not
  declared a side effect always goes out with the literal `preventSendBy=true`, the form both
  community sources verified, even though other booleans go out as `1`/`0` (D-020). A caller's
  `preventSendBy` of `true`, `1`, `"1"` or `"true"` keeps it a read and is sent as `true`; any
  other value makes it a side effect. `sendByWithRender` and any GET with a truthy `enshrine` or
  `enshrineDocuments` flag are always side effects. Side-effect GETs count as writes: they need a
  declared tier that `SEVDESK_ALLOW` enables, are refused in read-only and dry-run mode, and are
  never retried. The PDF tools (`sevdesk_invoice_pdf`, `sevdesk_credit_note_pdf`,
  `sevdesk_order_pdf`) and the `sevdesk://…/pdf` resources pass `preventSendBy` explicitly as
  well and never send `download`. The finalize and send-email tools
  (`src/tools/lifecycle/finalize.ts`, `src/tools/lifecycle/send-email.ts`) warn in their previews
  that an invoice or credit note is also enshrined if the account enshrines on completion.
- **Test:** `test/regressions/getpdf-side-effect-blocked.test.ts` (flagged and unflagged
  side-effect GETs), `test/regressions/b1-getpdf-prevent-send.test.ts` (PDF tools and resources
  through the real client in read-only mode: one GET with `preventSendBy=true`, no `download`),
  `test/unit/sevdesk/client.test.ts` ("state-changing GET endpoints"),
  `test/unit/sevdesk/paths.test.ts` (`resolveGetSafety`: the literal `true` for every accepted
  spelling), `test/unit/tools/documents/file-tools.test.ts`,
  `test/unit/tools/lifecycle/finalize.test.ts` ("warns that the invoice becomes binding and may
  be enshrined automatically"). Drafts on Update 2.0: pending: M3 recording session, probe
  `write-getpdf-preview-drafts`.

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
- **Test:** `test/unit/tools/meta/reference-lookup.test.ts`,
  `test/unit/tools/meta/account-info.test.ts` (`/SevUser`, `/StaticCountry`, `/Unity`,
  `/PaymentMethod`), `test/regressions/b3-contact-person.test.ts` (`/SevUser` for the contact
  person of drafts). Others: pending with their tools.

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
  resource, never inlined as base64 text. `getPdf` is not among the changed endpoints, and the
  current spec still declares `content` for it: the PDF tools use `getPdf`, parse `content`, and
  reject a `pdf`-only body as `unexpected_response`.
- **Test:** `test/unit/domain/document-files.test.ts` (the render shape is rejected for `getPdf`).
  `render` and `changeParameter`: pending until a tool uses them (no M3 tool does).

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
  `voucherPosDelete`, `filename`) and the read-back checks that `document` is set (but see D-044:
  voucher reads can omit `document`).
- **Test:** pending (M4): voucher upload, plus regression test B5.

### D-027: Document numbers are assigned on finalizing and can show placeholders

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** The Invoice and CreditNote tags say the number "is not an attribute that must be
  supplied when creating" the document, and point to `SevSequence/Factory/getByType` (not an
  operation of the spec, D-024) for the next number. `Model_Invoice.required` has no
  `invoiceNumber`, but `Model_creditNote.required` lists `creditNoteNumber` and
  `Model_Order.required` lists `orderNumber`. Nothing says when sevDesk assigns a number to a
  document saved without one, or what number formats look like.
- **Actual behavior:**
  - Invoices: a `saveInvoice` draft without `invoiceNumber` is saved with `invoiceNumber: null`;
    `sendBy` finalizes it and assigns the number from the number range (recorded answer and
    measurement of jernoxit/sevdesk-rs, Update 2.0).
  - Credit notes: sevdesk-rs takes a number from the sequence and sends it, and states that a
    credit note "needs a number from its sequence" (the recorded answer carries `GU-1048`). Not
    verified whether a credit note saved without one can be finalized.
  - Orders: codestra/sevdesk-mcp states that `saveOrder` without `orderNumber` is rejected with
    400, unlike `saveInvoice` (community, not recorded).
  - Placeholders: in exlo89/laravel-sevdesk-api#16 an invoice got the number `RE-%YYYY%MM1038`.
    The library filled the number itself from the number range, whose format comes back with the
    date parts unexpanded (maintainer: "Die Formate mit Datum werden aber nicht mit ausgegeben");
    with the library's numbering commented out, sending no number worked for the reporter. So
    the placeholders came from a client that copied the raw format, not from sevDesk assigning
    the number, as this entry used to say. The maintainer's own claim in that thread, that
    sevDesk does not generate a number when `null` is sent, contradicts the reporter and the
    sevdesk-rs measurement.
- **Sources:** spec (Invoice tag, "The invoice number"; `Model_Invoice`, `Model_creditNote`,
  `Model_Order`); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  "Documents get their number on `sendBy`"; recorded `tests/fixtures/write_invoice_save.json` and
  `write_credit_note_save.json`);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts);
  [exlo89/laravel-sevdesk-api#16](https://github.com/exlo89/laravel-sevdesk-api/issues/16).
- **Impact:** No tool ever sends a number it made up (B4): the create inputs do not accept one,
  creates send none for invoices, credit notes and orders, and updates send the stored number
  unchanged, or none when none is stored. The draft read-back notes a missing number (sevDesk
  assigns it at the latest when finalizing) and a number with `%…%` placeholders (`readBackNotes`
  in `src/domain/drafts/read-back.ts`); the finalize preview warns when the stored number contains
  `%` (`src/tools/lifecycle/finalize.ts`). Credit notes and orders without a number are
  unverified: if the recording session confirms the community claims, orders will fetch the next
  number first.
- **Test:** `test/regressions/b4-numbering.test.ts`, `test/unit/domain/drafts/payloads.test.ts`
  ("notes unexpanded placeholders in a number (D-027)"),
  `test/unit/tools/lifecycle/finalize.test.ts` ("warns about unexpanded placeholders in the number
  (D-027)"). Pending: M3 recording session, probes `write-numbering-invoice`,
  `write-numbering-credit-note`, `write-numbering-order-draft`, `write-next-order-number`,
  `read-number-placeholders`.

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
- **Impact:** Included in reference data with `documented: false`. The draft tools refuse 15 and
  22, which are not in the spec's sales-document enum (`SALES_TAX_RULE_IDS` in
  `src/domain/drafts/tax.ts`); 16 is an expense rule and refused there too. Receipts are checked
  against the ReceiptGuidance (D-006, D-065), which lists 16 for some accounts.
- **Test:** `test/regressions/b9-reference-ids.test.ts`, `test/unit/domain/drafts/tax.test.ts`
  ("refuses rules outside the scope, naming expense rules": rule 22).

### D-031: Transaction status 350 exists only in the response model

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The CheckAccountTransaction tag docs list statuses 100, 200, 300 and 400.
- **Actual behavior:** The transaction response model also allows 350 ("auto-booked without
  confirmation").
- **Sources:** `spec/openapi.yaml` (`Model_CheckAccountTransactionResponse`).
- **Impact:** Reference data includes 350. `sevdesk_transactions_list` labels it ("Auto-booked
  without user confirmation") and can filter for it (`auto_booked`).
- **Test:** `test/regressions/b9-reference-ids.test.ts` (status list),
  `test/unit/tools/banking/transactions.test.ts` (filter `auto_booked`).

### D-032: The `contact[id]` filter on `/ContactAddress` is undocumented

- **Status:** Open. **Evidence:** community.
- **Spec says:** `GET /ContactAddress` declares no contact filter.
- **Actual behavior:** Integrators filter with `contact[id]=…&contact[objectName]=Contact`; whether
  sevDesk always honors it is not verified.
- **Sources:** used by other sevDesk integrations; not yet verified in a recording of our own.
- **Impact:** `getContactDetails` sends the filter and also filters the result by contact id, so an
  ignored filter can never leak another contact's addresses.
- **Test:** `test/unit/tools/contacts/get.test.ts` (defensive filter).

### D-033: `getXml` refusals for invoices without XML are undocumented

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `GET /Invoice/{invoiceId}/getXml` ("Retrieves the XML of an e-invoice") declares
  `200` with `{objects: "<?xml …"}`, `400` ("Bad request. Invoice was not found"), `401` and
  `500`. It does not say what happens for an invoice that is not an e-invoice, or for an e-invoice
  that is still a draft.
- **Actual behavior:** sevDesk refuses the call. jernoxit/sevdesk-rs measured `400` with error
  code 832 ("ZUGFeRD generation failed") for `getXml` and `getPdf` on an e-invoice draft
  (2026-11-05), and documents a `400` that lists the missing fields when e-invoice data is
  incomplete.
  firsttris/haben treats a refused `getXml` as "not an e-invoice". The answer for an ordinary
  invoice, and the response `Content-Type`, have not been recorded.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/error.rs`); [firsttris/haben](https://github.com/firsttris/haben)
  (`packages/import/src/sevdesk/client.ts`).
- **Impact:** `fetchDocumentFile` (`src/domain/document-files.ts`) calls `getXml` without a
  pre-check (see D-034). A 4xx refusal that is classified as a validation error, or an empty body
  (`null`, `""`, `[]`, `false`), becomes a `not_found` error with our own message: XML exists only
  for invoices marked as e-invoices with complete e-invoice data, and only once they are finalized
  (a draft e-invoice gets its XML after finalizing). sevDesk's status, message and exception id
  stay on the error for the logs. A body that is not XML text (or is HTML) is an
  `unexpected_response`.
- **Test:** `test/unit/domain/document-files.test.ts` ("fetchDocumentFile: e-invoice XML").

### D-034: Invoice reads do not say whether an invoice is an e-invoice

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `propertyIsEInvoice` ("If true, the invoice will be created as e-invoice")
  exists only in the request model `Model_Invoice` and the Invoice tag docs.
  `Model_InvoiceResponse` does not have it, and no invoice filter selects e-invoices.
- **Actual behavior:** The recorded `POST /Invoice` response carries `propertyIsEInvoice` (as
  `null`), but the recorded `GET /Invoice` row has no such key. A client cannot tell from a read
  whether an invoice has e-invoice XML.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19).
- **Impact:** The XML tool and the `sevdesk://invoices/{id}/xml` resource call `getXml` directly
  and rely on its refusal (D-033) instead of checking the invoice first. The invoice tools set
  `eInvoice` only when sevDesk sends `propertyIsEInvoice` as true or false; when it is missing or
  `null` they leave `eInvoice` out (unknown) and never infer it. The invoice fixtures follow the
  recording and have no `propertyIsEInvoice`.
- **Test:** `test/unit/domain/document-files.test.ts` (`getXml` is the only request),
  `test/unit/tools/invoices/list.test.ts` ("shows eInvoice only when sevDesk sends
  propertyIsEInvoice").

### D-035: Unknown or misspelled list filters are ignored

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** The filter tables of the Invoice and CreditNote tags list
  `customerIntenalNote={note}` (sic). Nothing says what happens to a query filter the API does not
  know, or how the document number filters match.
- **Actual behavior:** sevDesk ignores unknown or misspelled query filters without an error and
  returns the unfiltered list. jernoxit/sevdesk-rs measured this for the misspelled name the spec
  documents (the correct `customerInternalNote` works) and for `externalId`. Whether
  `invoiceNumber`, `creditNoteNumber` and `orderNumber` match exactly is not measured, nor whether
  `origin[id]` on `/Invoice` and `/CreditNote` and `type` on `/CommunicationWay` are honored.
  `customerNumber` on `/Contact` matches exactly (sevdesk-rs README).
- **Sources:** [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs).
  Related: D-003 (unknown fields in request bodies), D-032 (`contact[id]` on `/ContactAddress`).
- **Impact:** The document number filters are sent to sevDesk and checked again on every returned
  row (trimmed, case-insensitive; `matchesNumber` in `src/domain/document-positions.ts`), so an
  ignored filter cannot return other documents. The invoice, order and voucher types are checked
  again the same way (D-015). Position lists are filtered by their parent id again for the same
  reason. The duplicate checks of the write tools do the same with the filters they rely on:
  `origin[id]`/`origin[objectName]` on `/Invoice` and `/CreditNote` (documented only in the filter
  tables of the Invoice and CreditNote tags; `src/domain/derived-documents.ts`), `type=EMAIL` on
  `/CommunicationWay` and `customerNumber` on `/Contact` (`src/domain/contacts-write.ts`). The
  `origin` and e-mail scans read a capped number of rows and warn when they were cut, since an
  ignored filter would make them read everything.
- **Test:** `test/unit/tools/invoices/list.test.ts` ("re-checks the invoice number on every
  row…"), `test/unit/tools/credit-notes/list.test.ts`, `test/unit/tools/orders/list.test.ts`
  ("re-checks the order number on every row", "re-checks the order type on every row…"),
  `test/unit/tools/vouchers/list.test.ts` ("re-checks the voucher type on every row…"),
  `test/unit/domain/document-positions.test.ts` ("re-checks document numbers trimmed and
  case-insensitively"), `test/unit/tools/invoices/get.test.ts` (positions of other invoices).
  Duplicate checks: `test/unit/tools/masterdata/credit-note-from-invoice.test.ts`,
  `test/unit/tools/masterdata/invoice-reminder.test.ts`,
  `test/unit/tools/masterdata/contact-create.test.ts` (cut scans warn). Pending: M3 recording
  session, probes `read-origin-filter`, `read-communication-way-type-filter`,
  `read-invoice-filters`.

### D-036: `getRelatedObjects` is declared to return order positions

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `GET /Order/{orderId}/getRelatedObjects` ("Get related objects of a specified
  order") declares `objects` as an array of `Model_OrderPosResponse`, that is, order positions.
- **Actual behavior:** It returns the linked documents (invoices made from the order, other
  orders, and the order itself unless `includeItself` is false), either as a list or as an object
  whose keys are numeric indexes with gaps (`{"0": …, "3": …}`). Observed on an Update 1.0
  account.
- **Sources:** [firsttris/haben#346](https://github.com/firsttris/haben/issues/346);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md).
- **Impact:** `sevdesk_order_get` calls it with `includeItself=0`, reads both forms, drops the
  order itself and shows each document's kind, id, number, type and status. If the call fails or
  the answer has another shape, the order is still returned without `related`, and the summary
  says that the related documents could not be read.
- **Test:** `test/unit/tools/orders/get.test.ts` ("lists related documents from a numeric-key
  object…", "reads related documents sent as a list…", "still returns the order when related
  documents cannot be read").

### D-037: Cancelled invoices keep status 1000

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `POST /Invoice/{invoiceId}/cancelInvoice` says "The cancellation invoice will be
  automatically paid and the source invoices status will change to 'cancelled'". Neither the
  invoice status table nor `Model_InvoiceResponse.status` (`50, 100, 200, 750, 1000`) has a code
  for "cancelled".
- **Actual behavior:** The original invoice stays at status 1000 with `paidAmount` 0 and
  `payDate` null, and does not point to its cancellation. The cancellation invoice (type `SR`) is
  paid (status 1000) and has negative sums. Its `origin` (`objectName` `Invoice`, the original's
  id) is the only link between the two.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) recorded fixtures
  (`tests/fixtures/invoice_list.json`, `tests/fixtures/write_invoice_cancel.json`).
- **Impact:** Invoice rows of type `SR` carry `cancelsInvoiceId` (from `origin`), and its
  description says that the cancelled invoice itself keeps status 1000. There is no "cancelled"
  status filter. `sevdesk_records_summarize` keeps `cancelsInvoiceId` on SR rows and says in its
  notes how many SR invoices cancel an invoice that is also counted (each pair nets to zero) and
  how many cancel one outside the summary. It also flags counted invoices with status paid and a
  paid amount of 0 whose SR is not counted, since that is how a cancelled original looks.
  `sevdesk_receivables_aging` leaves SR invoices out and counts them: neither they nor the
  originals are open. The cancel tool's preview says the original will show status paid with
  nothing paid. An invoice at 1000 with `paidAmount` 0 is treated as a possibly cancelled
  original (`src/domain/lifecycle/transitions.ts`): cancelling it is refused with a pointer to the
  cancellation invoice, and a reset to open is refused.
- **Test:** `test/unit/tools/invoices/list.test.ts` ("links a cancellation invoice (SR) to the
  invoice it cancels"), `test/unit/tools/lifecycle/cancel.test.ts` ("shows an irreversible
  preview with the offsetting amount"), `test/unit/domain/lifecycle/transitions.test.ts`
  ("assertCancellable": "refuses a paid invoice"), `test/unit/tools/lifecycle/reset.test.ts`
  ("refuses resets sevDesk would refuse or that make no sense"), `test/unit/tools/reports/summarize.test.ts` ("says when a cancellation
  invoice's original is not in the summary", "flags paid invoices with nothing paid as cancelled
  originals whose SR is missing"), `test/unit/tools/reports/aging.test.ts` ("explains
  approximate, unknown and left-out rows in its notes"). Pending: M3 recording session, probe
  `write-cancel-invoice`.

### D-038: The credit note status filter allows order statuses

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The `status` parameter of `GET /CreditNote` is a string enum
  `100, 200, 300, 500, 750, 1000`. The CreditNote tag's status table and
  `Model_creditNoteResponse.status` have only `100, 200, 750, 1000`; 300 and 500 are order
  statuses (rejected, accepted).
- **Actual behavior:** Not recorded. We assume credit notes only have the four statuses of the
  status table.
- **Sources:** spec (`getCreditNotes`, tag "Status of credit notes", `Model_creditNoteResponse`).
- **Impact:** `sevdesk_credit_notes_list` offers only `draft`, `open`, `partially_paid` and `paid`
  (100, 200, 750, 1000); any other status is rejected before anything is sent.
- **Test:** `test/unit/tools/credit-notes/list.test.ts` ("rejects unknown statuses and
  parameters").

### D-039: Credit note and position responses have undeclared fields

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `Model_creditNoteResponse` has no `bookingCategory`, `refSrcInvoice`, `origin`,
  `payDate`, `enshrined`, `creditNoteType` or `isTransferred`; only the request model has
  `bookingCategory`, and only the tag docs mention `refSrcInvoice`. `Model_creditNotePosResponse`
  and `Model_OrderPosResponse` have no `sumNet`, `sumTax` or `sumGross`. `Model_creditNoteResponse`
  has no `paidAmount` either, although the credit note status table has 750 (partially paid).
- **Actual behavior:** Recorded credit notes carry all of these fields, with `refSrcInvoice` as
  `{id, objectName}` and `creditNoteType` `"CN"`; `origin` is set only on credit notes created
  from an invoice. Credit notes have no `paidAmount`, so how much of a partially paid credit note
  is paid cannot be read from it. Recorded credit note and order positions carry `sumNet`,
  `sumTax` and `sumGross`.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) recorded fixtures
  (`tests/fixtures/credit_note.json`, `tests/fixtures/write_credit_note_save.json`);
  [TomDixon63/OrderManager2](https://github.com/TomDixon63/OrderManager2)
  (`front/src/app/model/order.ts`, a pasted `GET /Order?embed=positions` response, 2023).
- **Impact:** The credit note tools read `bookingCategory`, `refSrcInvoice` (as a reference or a
  bare id), `origin`, `payDate` and `enshrined` leniently and show no paid amount. Position totals
  come from the positions' own `sumNet`/`sumTax`/`sumGross`. The payout tool treats an open
  credit note (200) without `paidAmount` as unpaid and refuses a partially paid one (750), whose
  open amount it cannot know (`openAmount` in `src/domain/lifecycle/payments.ts`).
- **Test:** `test/unit/tools/credit-notes/list.test.ts` ("returns compact rows with booking
  category and source invoice", "reads refSrcInvoice as a bare id too…"),
  `test/unit/tools/credit-notes/get.test.ts`, `test/unit/tools/orders/get.test.ts`,
  `test/unit/domain/lifecycle/payments.test.ts` ("treats an open credit note without paid amount
  as unpaid", "refuses when the open amount cannot be known"),
  `test/unit/tools/lifecycle/book-payment.test.ts` ("refuses a partially paid credit note (sevDesk
  reports no paid amount)").

### D-040: The `CreditNotePos` filter names the wrong `objectName`

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** For `GET /CreditNotePos`, `creditNote[objectName]` is "Only required if
  creditNote[id] was provided. 'creditNote' should be used as value." The CreditNotePos tag's own
  examples use `"objectName": "CreditNote"`.
- **Actual behavior:** Recorded credit note positions refer to their parent as
  `{objectName: "CreditNote"}`, and other clients filter with `creditNote[objectName]=CreditNote`.
  Whether the lower-case value works too has not been recorded.
- **Sources:** spec; [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  (`tests/fixtures/write_credit_note_save.json`).
- **Impact:** Credit note positions are requested with `creditNote[objectName]=CreditNote` and
  filtered by parent id again (D-035), so an ignored filter cannot mix in other positions.
- **Test:** `test/unit/tools/credit-notes/get.test.ts`.

### D-041: `bookAmount` on vouchers and credit notes takes a signed amount

- **Status:** Open. **Evidence:** community.
- **Spec says:** `PUT /Voucher/{voucherId}/bookAmount`, `PUT /CreditNote/{creditNoteId}/bookAmount`
  and `PUT /Invoice/{invoiceId}/bookAmount` take `amount`: "Amount which should be booked. Can
  also be a partial amount." Nothing about its sign. Booking a credit note is "exactly the same as
  the process for invoices and vouchers".
- **Actual behavior:** The amount is signed as the money moves on the check account: negative for
  an expense voucher (`creditDebit` `C`), positive for revenue (`D`). A positive amount on an
  expense voucher is accepted without an error and stored as a negative `paidAmount`; the voucher
  then stays partially paid (750) with no `payDate`. A credit note is paid out with a negative
  amount: "−58.31 pays a credit note of 58.31". What a positive amount does on a credit note is
  not measured. Invoices take positive amounts.
- **Sources:** [genz-its/sevdesk `CLAUDE.md`](https://github.com/genz-its/sevdesk/blob/main/CLAUDE.md)
  (vouchers, verified against a live account); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  README (credit notes, measured, not recorded).
- **Impact:** `bookingAmountSign` in `src/domain/vouchers.ts` gives the sign for each voucher
  kind. The payment tools send invoice payments positive and credit note payouts negative
  (`paymentSign` in `src/domain/lifecycle/payments.ts`, via `bookingAmountSign`), and link a
  credit note payout only to an outgoing transaction. The voucher tools already warn about a
  negative `paidAmount`, the trace a wrongly signed booking leaves; booking vouchers follows with
  the voucher writes (M4).
- **Test:** `test/regressions/expense-sign.test.ts`, `test/unit/domain/lifecycle/payments.test.ts`
  ("sends a credit note payout as a negative amount (money out)"),
  `test/unit/tools/lifecycle/book-payment.test.ts` ("sends the payout as a negative amount and
  says so in the preview", "links only an outgoing transaction"),
  `test/regressions/b7-payment-linking.test.ts` ("links an outgoing transaction to a credit note
  payout with the negative amount"). Credit notes: pending: M3 recording session, probe
  `write-credit-note-payout-sign`. Vouchers: pending (M4).

### D-042: Part `price` is documented as net but holds the gross price

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `Model_Part.price` is the "Net price for which the part is sold. we will change
  this parameter so that the gross price is calculated automatically, until then the priceGross
  parameter must be used." `priceNet` and `priceGross` are separate fields.
- **Actual behavior:** In the recorded `GET /Part` row, `price` (`49.99`) equals `priceGross`;
  `priceNet` is `42.01`.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19).
- **Impact:** The parts tools ignore `price` and show `priceNet`, `priceGross` and
  `pricePurchase` only. Part writes (`src/domain/parts-write.ts`) never send `price`: a price is
  sent as `priceNet` and `priceGross` together with the `taxRate` they were computed with (the
  other price computed exactly and rounded half-up to cents, like the recorded 42.01 / 49.99 at
  19 %), as JSON numbers checked to round-trip exactly. Whether sevDesk then fills `price` itself
  is not recorded.
- **Test:** `test/unit/tools/parts/list.test.ts` ("returns compact parts with exact prices; price
  (= gross in the recording) is ignored"), `test/unit/tools/masterdata/part-create.test.ts`
  ("sends net and gross price with the tax rate, never price, and reads the part back"),
  `test/unit/tools/masterdata/part-update.test.ts` ("recomputes the gross price when only the tax
  rate changes"), `test/unit/domain/parts-write.test.ts` ("pricePair"). Pending: M3 recording
  session, probe `write-part-price-fields`.

### D-043: The currency of document sums is undocumented

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `sumNet`, `sumTax` and `sumGross` are the "Net sum of the invoice" (voucher,
  order, credit note) without a currency. Invoices, orders and credit notes also declare
  `sumNetForeignCurrency` and friends ("Net sum of the invoice in the foreign currency").
  `Model_VoucherResponse` declares only `sumDiscountsForeignCurrency`. The currency of
  `paidAmount` is not stated.
- **Actual behavior:** For a document in a foreign currency, `sumNet`/`sumTax`/`sumGross` hold the
  EUR base and `sum…ForeignCurrency` the amounts in the document's currency. For EUR documents the
  `…ForeignCurrency` sums are `"0"`. Recorded voucher rows carry `sumNetForeignCurrency`,
  `sumTaxForeignCurrency` and `sumGrossForeignCurrency` although the model lacks them. No public
  recording of a foreign-currency document exists, and the currency of `paidAmount` on one is
  unknown.
- **Sources:** [numtide/freelancer-toolbox](https://github.com/numtide/freelancer-toolbox)
  (`sevdesk-cli`, vouchers);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md)
  (orders); EUR rows recorded by [emuuu/sevDesk.NET](https://github.com/emuuu/sevDesk.NET) and
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs).
- **Impact:** For EUR documents the tools use the plain sums and never the `…ForeignCurrency`
  fields. For another currency with non-zero `…ForeignCurrency` sums, amounts are shown in the
  document's currency and the EUR base separately (`base` on vouchers, `totalsEur` on invoices,
  credit notes and orders). Without such sums, the plain sums are shown in the document's currency
  and no EUR figure is claimed. Invoices show `paid` only in EUR; vouchers label a foreign-currency
  `paidAmount` as EUR and say that this is not verified.
- **Test:** `test/unit/domain/vouchers.test.ts` ("shows foreign-currency vouchers in their own
  currency with the EUR base apart", "uses the plain sums when a foreign-currency voucher has no
  foreign sums"), `test/unit/domain/document-positions.test.ts` ("splits foreign-currency
  documents into document currency and EUR", "does not claim an EUR figure…"),
  `test/unit/tools/invoices/list.test.ts` ("reports foreign-currency invoices in their currency
  and EUR").

### D-044: Voucher reads can omit `document`

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `Model_VoucherResponse.document` is a nullable `{id, objectName: "Document"}`
  reference to the attached file.
- **Actual behavior:** The recorded `GET /Voucher` row has no `document` key at all, not even
  `null`. Whether `GET /Voucher/{voucherId}` includes it has not been recorded.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19).
- **Impact:** The voucher tools report `hasDocument` only when the key is present; otherwise they
  leave it out instead of saying `false`. The `saveVoucher` read-back planned for D-026 cannot
  rely on `document` until a recording shows it.
- **Test:** `test/unit/tools/vouchers/get.test.ts` ("renders the recorded mix…": no
  `hasDocument`), `test/unit/domain/vouchers.test.ts`.

### D-045: Voucher positions can lack `accountDatev` on Update 2.0

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `Model_VoucherPos` and `Model_VoucherPosResponse` both list `accountDatev` ("Use
  this in sevdesk-Update 2.0 (replaces accountingType)") and `accountingType` as required.
- **Actual behavior:** A position carries one of the two. The recorded `GET /VoucherPos` row,
  which belongs to a voucher with the Update 2.0 tax rule 9, has `accountingType` and no
  `accountDatev` key. genz-its reports `accountDatev: null` on legacy 1.0 positions, which carry
  `accountingType` instead.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19); [genz-its/sevdesk `CLAUDE.md`](https://github.com/genz-its/sevdesk/blob/main/CLAUDE.md).
- **Impact:** The bookkeeping generation is detected per object: for a voucher from
  `taxRule`/`taxType`, for a position from `accountDatev`/`accountingType`
  (`detectPositionGeneration` in `src/sevdesk/system-version.ts`). A 2.0 voucher can therefore
  show a 1.0 position with its `accountingType` id. Our schemas do not copy the spec's `required`
  lists.
- **Test:** `test/unit/tools/vouchers/get.test.ts` ("renders the recorded mix: a 2.0 voucher with
  a legacy 1.0 position").

### D-046: Date-range filters on document lists are described two ways

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The `startDate`/`endDate` parameters of `GET /Invoice`, `GET /Order`,
  `GET /CreditNote` and `GET /Voucher` select documents "with a date equal or higher" / "equal or
  lower". The filter tables of the same tags say the date must be "bigger than" / "smaller than"
  the timestamp. The parameters are `type: integer` with examples like `01.01.2020`.
- **Actual behavior:** Not recorded. Document dates sit at 00:00 Berlin time (for example the
  recorded `voucherDate` `2026-02-19T00:00:00+01:00`), so under the strict reading a filter that
  starts at 00:00 of the first day leaves that day out.
- **Sources:** spec.
- **Impact:** `documentDateFilter` (`src/domain/common.ts`) serves all four lists. It sends the
  Berlin calendar days as Unix seconds, with `startDate` one second before the first day and
  `endDate` at the last second of the last day, so the first day is included under either
  reading. Every returned document's date is then checked against the inclusive range, which
  drops anything the earlier bound let in; a document without a date never matches a range. The
  re-check does not start a scan: sevDesk's paging and total stay.
- **Test:** `test/unit/domain/common.test.ts` ("documentDateFilter"),
  `test/unit/tools/invoices/list.test.ts` ("re-checks the date range on every row without a local
  scan"), `test/unit/tools/credit-notes/list.test.ts`, `test/unit/tools/orders/list.test.ts`,
  `test/unit/tools/vouchers/list.test.ts` ("re-checks the voucher date against the range, keeping
  sevDesk's paging").

### D-047: Transaction date filters compare `entryDate`

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `GET /CheckAccountTransaction` declares `startDate` ("Only retrieve transactions
  from this date on") and `endDate` ("Only retrieve transactions up to this date") as
  `type: string, format: date-time`. It does not say which of the transaction's two dates they
  compare (see D-016).
- **Actual behavior:** jernoxit/sevdesk-rs measured on a test account (2026-10-01) that both
  filters cut by `entryDate`, not `valueDate`, and that they accept Unix timestamps as well as ISO
  dates.
- **Sources:** [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs).
- **Impact:** `sevdesk_transactions_list` has `dateField: "value" | "entry"` (default `value`).
  For a value-date range it sends no `startDate`/`endDate` and filters `valueDate` itself, reading
  sevDesk pages up to its scan cap (5,000 rows per call; `filteredLocally`, no total). For an
  entry-date range it sends `startDate`/`endDate` as ISO date-times with the Berlin offset
  (00:00:00 to 23:59:59) and checks `entryDate` again; that re-check does not start a scan, so
  sevDesk's total stays.
- **Test:** `test/unit/tools/banking/transactions.test.ts` ("filters a value-date range here only,
  since sevDesk's date filters cut by entryDate", "lets sevDesk filter an entry-date range and
  re-checks entryDate", "defaults dateField to value"), `test/unit/domain/banking.test.ts` ("drops
  rows without a value date when a date range is given").

### D-048: Change filters are documented only in tag texts

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `createBefore`, `createAfter`, `updateBefore` and `updateAfter` (`={timestamp}`,
  for example "Only retrieve all invoices updated last after timestamp") appear only in the filter
  tables of the Contact, Invoice, Order and Voucher tags; no operation declares them as
  parameters. The spec does not define "timestamp" (seconds, milliseconds or a date string) or
  say whether "after" includes the given instant. The CreditNote filter table and
  `GET /CheckAccountTransaction` have no change filter at all.
- **Actual behavior:** Not recorded. Whether sevDesk applies `updateAfter` in Unix seconds,
  strictly or inclusively, and whether `/CreditNote` and `/CheckAccountTransaction` accept it
  anyway, is checked in the M3 recording session. A filter sevDesk does not understand is ignored
  (D-035).
- **Sources:** spec (tag descriptions of Contact, Invoice, Order, Voucher and CreditNote;
  `getTransactions`).
- **Impact:** `sevdesk_changed_since` sends `updateAfter` as Unix seconds, one second before
  `since`, for contacts, invoices, orders and vouchers, and checks every returned row itself: a
  row counts when its update time, or its creation time if it has none, is at or after `since`;
  rows with neither are counted but not listed. When a page shows that sevDesk did not apply the
  filter, it reads full pages from then on. Credit notes and transactions are read without a
  server filter and checked the same way. Each subject's scan reads at most 5,000 rows per call
  and continues with `nextOffset`.
- **Test:** `test/unit/tools/reports/changed-since.test.ts` ("checks every subject by default,
  sending updateAfter only where the spec documents it", "keeps rows updated at or after since
  (creation time as fallback), newest first", "switches to full pages when sevDesk evidently
  ignored the filter", "caps the scan of subjects sevDesk cannot filter and continues with
  nextOffset").

### D-049: Whether lists include templates and reminders is undocumented

- **Status:** Open. **Evidence:** spec.
- **Spec says:** The Invoice tag's filter table offers `showWkr=all` ("Retrieve all recurring
  invoices"), `showMa=all` ("Retrieve all invoices which are payment reminders") and
  `showAll=true` ("Retrieve all invoices of all types"). That suggests `GET /Invoice` leaves
  recurring invoice templates (`WKR`) and reminders (`MA`) out by default. The Voucher tag's table
  offers `noRv=true` ("Only retrieve vouchers which are not of type RV"), which suggests
  `GET /Voucher` includes recurring voucher templates (`RV`) by default. No operation declares
  these parameters, and neither default is stated.
- **Actual behavior:** Not recorded.
- **Sources:** spec (filter tables of the Invoice and Voucher tags).
- **Impact:** Templates and reminders are not documents of their own, so the tools keep them out
  of totals whatever the default is. `sevdesk_invoices_list` sends `showWkr=all` or `showMa=all`
  only when the caller asks for type `recurring` or `reminder`, and re-checks the type on every
  row (D-015). `sevdesk_records_summarize` leaves WKR and MA invoices out and counts them in its
  notes unless `invoiceType` asks for them. `sevdesk_receivables_aging` leaves them out and
  reports them under `excluded` (`recurringTemplates`, `reminders`). The summary and
  `sevdesk_payables_aging` read vouchers with `voucherType=VOU` (not `noRv`) and drop RV rows that
  sevDesk returns anyway; the payables aging reports those as `excluded.recurringTemplates`.
  `sevdesk_cash_position` leaves all three out of its outlook and counts them in a note.
- **Test:** `test/unit/tools/invoices/list.test.ts` ("asks sevDesk to show recurring templates
  and reminders when that type is requested"), `test/unit/tools/reports/summarize.test.ts`
  ("leaves recurring templates (WKR) and reminders (MA) out unless asked for", "counts reminders
  when invoiceType asks for them", "totals expense and revenue in separate lines, foreign ones
  with their EUR base"), `test/unit/tools/reports/aging.test.ts` ("explains approximate, unknown
  and left-out rows in its notes", "flags wrong-signed payments, foreign paid amounts and
  left-out rows"), `test/unit/tools/reports/cash-position.test.ts` ("adds an expected outlook
  from open items by due date, never mixing currencies").

### D-050: A position `price` is read by the document's `showNet`

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `Model_InvoicePos.price`, `Model_creditNotePos.price` and `Model_OrderPos.price`:
  "Price of the article/part. Is either gross or net, depending on the sevdesk account setting."
  (`type: number`). `priceNet` is `readOnly` in all three models; `priceGross` and `priceTax` are
  writable. The Invoice tag's attribute table says instead that the document's `showNet`
  "determines, if the price you give the invoice positions will be regarded as gross or net".
- **Actual behavior:** The document's `showNet` decides, not an account setting. With
  `showNet: true`, prices 3 × 10 + 25 gave `sumNet` 55; with `showNet: false`, 11.90 + 2 × 5.00
  gave `sumGross` 21.90 (jernoxit/sevdesk-rs on Update 2.0, 2026-10-01; the first answer is
  recorded, the second is a live test assertion). That request sends `price` as a decimal string
  (`"10.00"`), which sevDesk accepts. Answers carry the derived `priceNet`, `priceTax` and
  `priceGross`; reads show them unrounded to four decimals (recorded `GET /InvoicePos` row:
  `price` and `priceNet` 42.01, `priceGross` 49.9919, `priceTax` 7.9819). What a lone `priceNet`
  or `priceGross` does on create is not recorded. codestra/sevdesk-mcp reports that
  `PUT /OrderPos/{id}` ignores a lone `price` and keeps the old value (community, not recorded).
- **Sources:** spec (position models; Invoice tag, attribute table);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (request built by
  `src/document_payload/position.rs`, answer recorded in `tests/fixtures/write_invoice_save.json`);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (`GET /InvoicePos`,
  2026-02-19);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts).
- **Impact:** Draft positions carry `price` only, as an exact decimal string with at least two
  decimals, and the document's `showNet` says how sevDesk reads it (price mode `net` → `true`,
  `gross` → `false`; `positionPayload` in `src/domain/drafts/positions.ts`). The strict body
  schemas refuse `priceNet`, `priceGross`, `priceTax` and every `sum*` field (B8). The read-back
  compares sevDesk's gross total with the preview and adds a note when they differ
  (`readBackNotes` in `src/domain/drafts/read-back.ts`). An update that changes the price mode
  must send the positions again. Order positions are replaced through `saveOrder` (D-054), never
  through `PUT /OrderPos`. Part prices: D-042.
- **Test:** `test/regressions/b8-price-fields.test.ts`, `test/unit/domain/drafts/positions.test.ts`
  ("sends price as an exact decimal string with at least two decimals"),
  `test/unit/tools/drafts/invoice-create-draft.test.ts` ("sends gross prices with showNet false
  and computes the net from the gross", "adds a note when sevDesk's total differs from the preview
  (B8 safety net)"). Pending: M3 recording session, probe `write-position-price-fields`.

### D-051: `saveCreditNote` needs other fields than `Model_creditNote` requires

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `Model_creditNote.required` lists `creditNoteNumber`, `creditNoteDate`,
  `contact`, `status`, `deliveryDate`, `addressCountry`, `contactPerson`, `taxRate`, `taxRule`,
  `taxText`, `taxType`, `bookingCategory`, `invoiceType`, `currency`, `header`, `mapAll` and
  `objectName`. `deliveryDate` and `invoiceType` are not among the model's properties, and neither
  are `deliveryDateUntil`, `discount`, `creditNoteType` and `refSrcInvoice`. The CreditNote tag
  lists `deliveryDate` as optional, says `refSrcInvoice` "has to be used" with booking category
  `UNDERACHIEVEMENT`, and says `ACCOUNTING_TYPE` is not supported on Update 2.0.
- **Actual behavior:**
  - A working Update 2.0 request sends `creditNoteType: "CN"`, `discount: 0`, `deliveryDate`
    (Unix seconds) and `bookingCategory`, and no `invoiceType`; it also sends a
    `creditNoteNumber` from the number range (D-027). sevDesk accepted it (jernoxit/sevdesk-rs,
    2026-10-01, answer recorded).
  - Without `deliveryDate`, sevDesk answers 422, code 460, "Must set deliveryDate" (recorded by
    emuuu/sevDesk.NET).
  - `UNDERACHIEVEMENT` needs `refSrcInvoice`; a source invoice that is still a draft is refused
    (422, code 251), and every position must carry one of the source invoice's tax rates (else
    456, "Different taxRate than origin document").
  - `PROVISION` takes tax rule 9 and refuses rule 1 (D-006).
  - What the royalty categories need is not recorded.
- **Sources:** spec (`Model_creditNote`; CreditNote tag, "Credit note booking categories" and
  attribute table); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README; request
  built by `src/document_payload/credit_note.rs`, answer recorded in
  `tests/fixtures/write_credit_note_save.json`; codes measured in `src/endpoints/credit_note.rs`,
  2026-09-29, not recorded);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (the 422).
- **Impact:** The strict `saveCreditNote` body (`saveCreditNoteBodySchema` in
  `src/domain/drafts/payloads.ts`) requires `creditNoteType: "CN"`, `deliveryDate`, `discount: 0`
  and `bookingCategory`, and has no `invoiceType` or number. `src/domain/drafts/credit-note.ts`
  defaults the delivery date to the document date. Underachievement needs `sourceInvoiceId` (sent
  as `refSrcInvoice`): the invoice must exist, not be a draft, belong to the same contact and have
  the same currency, and position rates are limited to the invoice's. Provision credit notes take
  rule 9 only; royalty credit notes take the sales rules with a warning that their requirements
  are unverified; `ACCOUNTING_TYPE` is not offered.
- **Test:** `test/unit/tools/drafts/credit-note-create-draft.test.ts` ("prepares the recorded
  underachievement body: source invoice, its rule and rate", "uses tax rule 9 for a provision
  credit note without a source invoice", "warns that royalty credit notes are not verified", and
  the cases under "refuses before sending anything"), `test/unit/domain/drafts/payloads.test.ts`
  ("refuses ACCOUNTING_TYPE credit notes (not supported on Update 2.0)"). Pending: M3 recording
  session, probe `write-credit-note-without-delivery-date`.

### D-052: Draft requests use fields the request models do not declare

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:**
  - Address: `Model_Invoice`, `Model_creditNote` and `Model_Order` declare the recipient as
    `address`, the complete multi-line text, plus `addressCountry` ("Can be omitted as complete
    address is defined in address attribute"). `addressStreet`, `addressZip` and `addressCity`
    appear only in the description of `propertyIsEInvoice`, as invoice data an e-invoice needs;
    `addressName` appears nowhere, and no response model declares any of them. The `saveInvoice`
    and `saveCreditNote` descriptions offer `takeDefaultAddress` to copy "the first address of the
    contact", but no request schema has it.
  - `Model_Invoice` has no `discountTime` and no `costCentre`, although `Model_InvoiceResponse`
    and the Invoice tag's attribute table have both.
  - `Model_OrderPos` has no `mapAll`, which the save factories say must always be sent and which
    `Model_InvoicePos` and `Model_creditNotePos` declare.
  - Fields of credit notes: D-051.
- **Actual behavior:** `saveInvoice` and `saveCreditNote` take `addressName`, `addressStreet`,
  `addressZip` and `addressCity` with `addressCountry`. A draft created this way reads back with
  `address: null` and only the structured fields; sevDesk does not copy the contact's address
  onto a document saved without one (jernoxit/sevdesk-rs, Update 2.0, answers recorded).
  codestra/sevdesk-mcp reports that `takeDefaultAddress: true` leaves an order's recipient block
  empty. Every working order body sends `mapAll` on its positions (codestra/sevdesk-mcp and a
  production product configurator; community, not recorded). Not recorded: which address is
  printed when the text and the structured fields are both sent, and whether `saveInvoice` keeps
  `discountTime` and `costCentre`.
- **Sources:** spec (`Model_Invoice`, `Model_creditNote`, `Model_Order`, `Model_OrderPos`,
  `Model_InvoiceResponse`; `saveInvoice` and `saveCreditNote` descriptions);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (requests built by
  `src/document_payload/`, answers recorded in `tests/fixtures/write_invoice_save.json` and
  `write_credit_note_save.json`);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts).
- **Impact:** Invoice and credit note drafts send the structured address fields with
  `addressCountry`; order drafts send the multi-line `address` with `addressCountry`
  (`src/domain/drafts/document.ts`, `src/domain/drafts/order.ts`). Unless an address is given,
  drafts take the contact's billing address (category 47), else its first address; a contact
  without any address is refused (`src/domain/drafts/recipient.ts`). Invoice updates write a
  changed address so that the text and the structured fields agree, and carry the stored
  `discountTime` and `costCentre` over with the other stored fields (D-054). Order positions carry
  `mapAll: true` like the others. The read tools compose the address text from the structured
  fields when `address` is null (`addressDto` in `src/domain/document-positions.ts`).
- **Test:** `test/unit/tools/drafts/invoice-create-draft.test.ts` ("prepares the recorded body
  with defaults and reads only", "a contact without any address"),
  `test/unit/tools/drafts/credit-note-create-draft.test.ts` ("prepares the recorded
  underachievement body: source invoice, its rule and rate"),
  `test/unit/tools/drafts/order-drafts.test.ts` ("prepares an offer: version 0, multi-line
  address, type header, no number"), `test/unit/tools/drafts/invoice-update-draft.test.ts`,
  `test/unit/domain/drafts/recipient.test.ts` ("prefers the invoice address (category 47) over the
  first one"), `test/unit/domain/document-positions.test.ts` ("composes the text from the
  structured parts when sevDesk sent no address (API drafts)"). Pending: M3 recording session,
  probes `write-draft-address-fields`, `write-save-update-omitted-fields`.

### D-053: The trailing factory parameters are optional

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** The `saveInvoice` description says the body ends with `invoicePosDelete`,
  `discountSave`, `discountDelete` and `takeDefaultAddress`, that "the order of the last four
  attributes always needs to be kept" and "You will also always need to provide all of them, as
  otherwise the request won't work properly". The same description begins with "you can omit all
  parameters which are not required and nullable". `saveCreditNote` says the same of five
  parameters (`creditNotePosDelete`, `discountSave`, `discountDelete`, `takeDefaultAddress`,
  `forCashRegister`). Neither request schema declares `takeDefaultAddress` or `forCashRegister`.
- **Actual behavior:** Requests that end with `invoicePosDelete: null` or
  `creditNotePosDelete: null` and send none of the other trailing parameters are accepted
  (jernoxit/sevdesk-rs, Update 2.0, answers recorded). Working `saveOrder` bodies leave
  `orderPosDelete` out entirely (community, not recorded). `saveVoucher` is different: its key
  order matters (D-026).
- **Sources:** spec (`createInvoiceByFactory`, `createcreditNote`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`tests/fixtures/write_invoice_save.json`,
  `write_credit_note_save.json`); the order bodies named in D-052.
- **Impact:** Draft bodies end with `*PosDelete` (null on create) and never send `discountSave`,
  `discountDelete`, `takeDefaultAddress` or `forCashRegister`; the strict body schemas in
  `src/domain/drafts/payloads.ts` have no such keys.
- **Test:** `test/unit/tools/drafts/invoice-create-draft.test.ts` ("prepares the recorded body
  with defaults and reads only"), `test/unit/tools/drafts/credit-note-create-draft.test.ts`
  ("prepares the recorded underachievement body: source invoice, its rule and rate"),
  `test/unit/tools/drafts/order-drafts.test.ts` ("prepares an offer: version 0, multi-line
  address, type header, no number"). Every write probe that creates a draft (`draft()` in
  `scripts/lib/probes/core.ts`) sends this shape in the M3 recording session.

### D-054: Updating a draft through the save factories is barely documented

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** The `saveInvoice` description: `invoicePosDelete` deletes positions "as this
  request can also be used to update invoices", and for updates "feel free to contact our
  support". `Model_Invoice.id` is "Required if you want to create or update an invoice position
  for an existing invoice"; the InvoicePos tag shows an update as
  `{"invoice": {"id", "objectName", "mapAll": true}, "invoicePos": [...]}` (but see D-004).
  `saveCreditNote` says the same of credit notes. `saveOrder` says only "Creates an order to which
  positions can be added later", and `Model_Order.id` is `readOnly`. `invoicePosDelete`,
  `creditNotePosDelete` and `orderPosDelete` are declared as one `{id, objectName}` object, not as
  a list. Nothing says whether fields left out of an update keep their values.
- **Actual behavior:** FSCreative/fs-creative updates invoice drafts in production with
  `saveInvoice` and `invoice.id`, and replaces all positions by sending `invoicePosDelete` as an
  array of `{id, objectName: "InvoicePos"}` (community, not recorded). For orders nothing is
  verified: codestra/sevdesk-mcp changes an order's own fields with `PUT /Order/{orderId}` and its
  positions one by one (`PUT /OrderPos/{id}` ignores a lone `price`, D-050). Whether a save with an
  id keeps or nulls the fields it does not send is unrecorded for both.
- **Sources:** spec (`createInvoiceByFactory`, `createcreditNote`, `createOrder`, `saveInvoice`,
  `saveOrder`, `Model_Invoice`, `Model_Order`; tag `InvoicePos`);
  [FSCreative/fs-creative](https://github.com/FSCreative/fs-creative) (`server.js`,
  `sevdesk-ops.js` at `2d776fa`, 2026-11-07);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts).
- **Impact:** `sevdesk_invoice_update_draft` and `sevdesk_order_update_draft` update drafts with
  one `saveInvoice`/`saveOrder` request carrying the draft's id (not `PUT /Order/{orderId}` plus
  position requests, which can fail half-way). Every writable field the tools know is carried
  over from the stored draft (`src/domain/drafts/current.ts`), so the result does not depend on
  whether sevDesk keeps omitted fields; the stored number goes along unchanged (D-027). Positions
  are either left alone (`*PosSave` and `*PosDelete` null) or replaced as a whole: all stored
  positions in `*PosDelete` as an array of `{id, objectName}` and the new ones in `*PosSave`, in
  the same request. Only drafts are updated. If sevDesk's answer names another id, the call fails
  and names that document as written.
- **Test:** `test/unit/tools/drafts/invoice-update-draft.test.ts` ("changes one field and carries
  every stored field over, positions untouched", "replaces all positions in one request (deletes
  the stored ones)", "fails loudly when sevDesk saved a different invoice"),
  `test/unit/tools/drafts/order-drafts.test.ts` ("carries the stored order over, keeps its number
  and replaces the positions", "fails loudly when sevDesk saved a different order"),
  `test/unit/tools/drafts/update-edges.test.ts`. Pending: M3 recording session, probe
  `write-save-update-omitted-fields`.

### D-055: The `saveInvoice` answer has undeclared and oddly typed fields

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `saveInvoiceResponse` has `invoice` (`Model_InvoiceResponse`), `invoicePos`
  (`Model_InvoicePosResponse` items) and `filename`; `saveCreditNoteResponse` has `creditNote` and
  `creditNotePos`, `saveOrderResponse` `order` and `orderPos`. All are declared without the
  `objects` wrapper (D-001).
- **Actual behavior:** The recorded `saveInvoice` answer is `{objects: {invoice, invoicePos,
vatdrop}}`: an undeclared top-level `vatdrop` (recorded as the string `"not relevant"`) and no
  `filename`. Unlike most scalars (D-002), the positions' amounts are JSON numbers, a quantity of 1
  comes back as JSON `true`, `positionNumber` is 1000 (the request sent none), and every position
  embeds the whole invoice. The invoice has `invoiceNumber: null` (D-027) and `address: null`
  (D-052). The `saveOrder` answer is not recorded.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  `tests/fixtures/write_invoice_save.json` (live test account, Update 2.0, 2026-10-01).
- **Impact:** `savedDocumentId` (`src/domain/drafts/payloads.ts`) reads only the saved
  document's id (`invoice.id`, `creditNote.id`, `order.id`), from an object or an array of one, and
  ignores the rest; the draft is then read back with GET by id, positions included. An answer
  without an id is an `unexpected_response` error that says the draft may exist.
- **Test:** `test/unit/domain/drafts/payloads.test.ts` ("reads the id from an object or an array
  of one", "says the document may exist when the id is missing"),
  `test/unit/tools/drafts/invoice-create-draft.test.ts` ("saves once with the write tier, reads
  the invoice back and reports it as affected", "explains an answer without an id instead of
  guessing"); fixtures `test/fixtures/drafts/save-invoice-response.json` (recorded shape),
  `save-order-response.json` (built from the spec). `saveOrder`: pending: M3 recording session,
  probe `write-numbering-order-draft`.

### D-056: Which day a `bookAmount` date means is undocumented

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `PUT /Invoice/{invoiceId}/bookAmount`, `PUT /CreditNote/{creditNoteId}/bookAmount`
  (and the voucher variant) take `date`: "The booking date. Most likely the current date."
  (`type: integer`). The unit and the time zone in which the timestamp becomes a calendar day are
  not stated; the answer's `bookingDate` is a date-time.
- **Actual behavior:** jernoxit/sevdesk-rs sends Unix seconds at 12:00 Berlin time
  (`1787652000` = 2026-08-25 12:00 CEST in its request test), and the recorded voucher booking
  answer has `bookingDate` at 12:00+02:00. Whether sevDesk cuts the day in Berlin time or in UTC
  is not measured; a timestamp at 00:00 Berlin is still the previous day in UTC. sevdesk-rs
  measured that `getBalanceAtDate` cuts days in Berlin time.
- **Sources:** spec (`bookInvoice`, `bookCreditNote`, `bookVoucher`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`tests/requests.rs`; README;
  recorded `tests/fixtures/write_voucher_book_amount.json`). Document dates: D-018.
- **Impact:** `bookingTimestamp` (`src/domain/lifecycle/payments.ts`) sends Unix seconds of 12:00
  Europe/Berlin on the booking day, so the calendar day is the same under either reading,
  including on daylight-saving changes. The date defaults to today in Berlin, and a future date
  draws a warning. `amount` goes out as a JSON number that is checked to equal the decimal exactly
  (`exactNumber`).
- **Test:** `test/unit/domain/lifecycle/payments.test.ts` ("bookingTimestamp": "is 12:00 Berlin
  time in winter and summer", "keeps the calendar day on DST transition days"; "books the whole
  open amount as FULL_PAYMENT, signed positive, at noon Berlin"),
  `test/regressions/b7-payment-linking.test.ts` ("sends the transaction as an {id, objectName}
  reference next to the check account": `date` 1793617200),
  `test/unit/tools/lifecycle/book-payment.test.ts` ("defaults the booking date to today (Berlin)
  and warns about future dates"). Pending: M3 recording session, probes
  `write-book-amount-noon-date`, `write-book-amount`.

### D-057: Transactions report no assigned or remaining amount

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `Model_CheckAccountTransactionResponse.status` is "100 Created, 200 Linked, 300
  Private, 350 Auto-booked without user confirmation, 400 Booked" (350: D-031). No field says how
  much of a transaction is already assigned to documents, and nothing says what separates 200 from 400. The tag says a transaction can be linked to one or several documents.
  `CheckAccountTransactionLog`, which holds the assignments, is not in the spec.
- **Actual behavior:** 200 means partly assigned and 400 fully assigned: in a recorded transaction
  log (firsttris/haben, Update 1.0), a transaction split over two documents moved to `toStatus`
  200 with the first share and to 400 with the second. The assigned amounts are only in the
  undocumented `GET /CheckAccountTransactionLog?checkAccountTransaction[id]=…` (`amountPaid` per
  entry); its transaction filter works, a document filter does not exist (sevdesk-rs, measured).
- **Sources:** [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md)
  ("Zahlungen", real answers in firsttris/haben#343) and its transaction-log fixture;
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/transaction.rs`).
- **Impact:** The payment tools link only a free transaction: status 100, not enshrined, on the
  chosen check account, in the document's currency, moving money in the right direction, and at
  least as large as the payment (`checkPaymentTransaction` in `src/domain/lifecycle/payments.ts`).
  A transaction at 200 is refused with the reason that sevDesk does not report how much of it is
  left. A larger transaction draws a warning that the rest stays unassigned and that the tool
  cannot book more on a partly assigned transaction later. Reading the log is left to the bank
  reconciliation work (M4).
- **Test:** `test/unit/domain/lifecycle/payments.test.ts` ("checkPaymentTransaction": "refuses a
  partly assigned transaction", "warns when the transaction is larger than the payment"),
  `test/regressions/b7-payment-linking.test.ts` ("refuses a transaction that is partly assigned,
  without writing"). No probe yet.

### D-058: `cancelInvoice` answers and refusals are undocumented

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `POST /Invoice/{invoiceId}/cancelInvoice` declares 201 "Created - Returns
  cancellation invoice" with a bare `Model_InvoiceResponse`, and 400, 401 and 500. It documents
  no refusal. What happens to the original: D-037.
- **Actual behavior:** The answer is 201 with the cancellation invoice (type SR, negated sums,
  status 1000, `origin` = the original) as one object, not an array, under `objects` (recorded).
  Measured refusals: a draft gets an error body inside HTTP 200 (code 423), a partly paid invoice
  likewise (code 390), an invoice that is already cancelled 422 (code 421), and an invoice a
  credit note refers to 422 (code 170).
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (recorded
  `tests/fixtures/write_invoice_cancel.json`; refusal codes in `src/error.rs`,
  `src/endpoints/invoice.rs` and the README, measured, not recorded).
- **Impact:** `assertCancellable` (`src/domain/lifecycle/transitions.ts`) refuses drafts, partly
  paid invoices (750, or 200 with payments), paid invoices (including cancelled originals,
  D-037), cancellation invoices, reminders, recurring templates and unknown types before anything
  is sent. The client treats a 2xx body with `objects: null` and an `error` member, or without
  `objects`, as `unexpected_response` (`src/sevdesk/client.ts`), so a refusal in HTTP 200 never
  passes as success. The cancel tool needs the cancellation invoice's id in the answer; without
  one it fails with `unexpected_response`, names the original as already changed and says not to
  cancel again. Invoices with a credit note (170) are not checked locally; sevDesk's refusal is
  passed on.
- **Test:** `test/unit/tools/lifecycle/cancel.test.ts` ("posts an empty cancelInvoice and returns
  both invoices read back", "says the cancellation happened when sevDesk's answer names no
  invoice", "also handles an empty answer, and reports both invoices if a read-back fails"),
  `test/unit/domain/lifecycle/transitions.test.ts` ("assertCancellable"),
  `test/unit/sevdesk/client.test.ts` ("treats objects null next to an error as
  unexpected_response"). Pending: M3 recording session, probe `write-cancel-invoice`.

### D-059: `enshrine` is idempotent and does not block payments

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `PUT /Invoice/{invoiceId}/enshrine` and `PUT /CreditNote/{creditNoteId}/enshrine`
  are "only possible if the status is 'Open' (200) or higher"; "Enshrined invoices cannot be
  changed. This operation cannot be undone." The answer is `{objects: null}`; 422 is declared
  without codes. Nothing says what a second call does or whether payments can still be booked.
- **Actual behavior:** On a draft, sevDesk answers 422 ("at least status open (200) is
  required"). From status 200 on it enshrines; on an enshrined document it answers 200 and keeps
  the timestamp. `bookAmount` still works on enshrined documents (they become paid, `enshrined`
  unchanged). An enshrined invoice refuses content changes and `resetToDraft` (422, code 322) and
  deletion (409, code 159); credit notes stay editable, and only `resetToDraft` on an enshrined
  one is refused (422, code 322). All measured 2026-11-05 with automatic enshrinement on and off.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/invoice.rs` `enshrine_invoice`; measured, not recorded).
- **Impact:** `assertEnshrinable` (`src/domain/lifecycle/transitions.ts`) refuses drafts, lower
  statuses, recurring templates and documents that are already enshrined (nothing to do) before
  anything is sent. The preview is marked irreversible and says payments can still be booked
  afterwards. The tool reads the document back and ignores the answer. Enshrining is never
  probed, being irreversible (`NOT_PROBED` in `scripts/lib/probes/catalog.ts`).
- **Test:** `test/unit/domain/lifecycle/transitions.test.ts` ("accepts open and paid documents
  that are not enshrined", "refuses enshrined documents, drafts, low statuses and templates"),
  `test/unit/tools/lifecycle/enshrine.test.ts`.

### D-060: `resetToOpen` works on enshrined documents and unlinks payments silently

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `resetToOpen` (invoices and credit notes): "Linked transactions will be unlinked.
  This is not possible if the invoice itself or one of its transactions (CheckAccountTransaction)
  is already enshrined." `resetToDraft` is "only possible if the invoice has the status Open
  (200)". Nothing says what happens to the transactions, the booking log, `paidAmount` or
  `payDate`, and the declared 422 has no codes.
- **Actual behavior:**
  - `resetToOpen` works on a paid, enshrined document as long as its payment transactions are not
    enshrined; with an enshrined payment transaction it answers 422, code 322, "Already enshrined
    by payment" (sevdesk-rs, measured 2026-11-05).
  - `resetToDraft` on an enshrined document answers 422, code 322 (sevdesk-rs).
  - `resetToOpen` on an invoice a credit note refers to is refused with code 170 (sevdesk-rs).
  - Payments are taken back without a counter-booking: the linked transactions return to status
    100, their `CheckAccountTransactionLog` entries are deleted and `paidAmount` goes back to 0
    (sevdesk-rs). firsttris/haben observed on Update 1.0 that `payDate` stays on the day of the
    removed payment.
  - Whether a transaction that sevDesk created for a booking on an offline or cash account
    (without a linked transaction) is removed again is not measured.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/invoice.rs`, `src/endpoints/transaction.rs`; measured, not recorded);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md)
  ("Aufgehobene Zuordnungen").
- **Impact:** `assertResettable` (`src/domain/lifecycle/transitions.ts`): to open, it accepts paid
  and partially paid documents and open ones that still show payments, and refuses drafts,
  cancelled originals (1000 with `paidAmount` 0, D-037), cancellation invoices and recurring
  templates. It does not refuse enshrined documents; the preview warns that sevDesk may refuse.
  To draft, it accepts only open documents without payments that are not enshrined. The preview
  of a reset to open says that every payment is unlinked without a counter-booking, that
  transactions sevDesk created for offline or cash bookings may stay, and that sevDesk refuses
  when a payment transaction is enshrined. Code 170 is not checked locally.
- **Test:** `test/unit/domain/lifecycle/transitions.test.ts` ("resets paid and partially paid
  documents to open, enshrined ones included", "resets an open invoice that still shows payments
  (pre-4.181 partial payment) to open", "resets an open document without payments to draft",
  "tells credit notes to use a new document instead of resetting an enshrined one"),
  `test/unit/tools/lifecycle/reset.test.ts` ("resets a paid invoice to open and says its payments
  are unlinked", "allows resetting an enshrined paid invoice to open, with a warning", "refuses
  resets sevDesk would refuse or that make no sense"). Pending: M3 recording session, probe
  `write-offline-booking-transaction`. The enshrined cases are not probed (irreversible).

### D-061: `POST /Contact` assigns the next customer number

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** The Contact tag: "The customer number is not an attribute that must be supplied
  when creating a contact", and numbering by hand "is not the best idea"; it offers
  `Contact/Mapper/checkCustomerNumberAvailability` and `Contact/Factory/getNextCustomerNumber`. It
  does not say what sevDesk does when `customerNumber` is left out.
- **Actual behavior:** sevDesk assigns the next free customer number itself (jernoxit/sevdesk-rs,
  measured 2026-10-01; the answer is recorded). The `customerNumber` list filter matches exactly
  (sevdesk-rs).
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/contact.rs`, recorded `tests/fixtures/write_contact_create.json`).
- **Impact:** `sevdesk_contact_create` sends no `customerNumber` unless one is given
  (`src/domain/contacts-write.ts`). The preview shows the number `getNextCustomerNumber` announces
  and warns that sevDesk assigns the number on save. A given number that another contact has is
  refused (exact filter, checked again on every row).
- **Test:** `test/unit/tools/masterdata/contact-create.test.ts` ("previews an organisation with
  address and e-mail", "creates the contact, its billing address and e-mail, then reads it back":
  no `customerNumber` in the body, "refuses a customer number that is taken"). Pending: M3
  recording session, probe `write-contact-customer-number`.

### D-062: PUT on contacts, addresses and communication ways is a partial update

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `PUT /Contact/{contactId}` (`Model_ContactUpdate`),
  `PUT /ContactAddress/{contactAddressId}` (`Model_ContactAddressUpdate`) and
  `PUT /CommunicationWay/{communicationWayId}` (`Model_CommunicationWayUpdate`) have no required
  fields, and nothing says whether fields left out keep their values. `Model_ContactUpdate.name`
  says "the type of contact will depend on this attribute. If it holds a value, the contact will
  be regarded as an organization."
- **Actual behavior:** All three are partial updates: fields left out stay as they are. Sending
  `name` for a person sets `name`, but the contact stays a person (jernoxit/sevdesk-rs, measured
  2026-10-01, not recorded). Nobody has measured `PUT /Part/{partId}` (`Model_PartUpdate`, no
  required fields either).
- **Sources:** spec (the three update models); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  (`src/endpoints/contact.rs`, `src/document_payload/contact.rs`).
- **Impact:** `sevdesk_contact_update` sends only the fields that change, to the contact, its
  billing address and its main communication ways (`src/domain/contacts-write.ts`). Nothing can be
  cleared (empty strings are rejected by the input schema), an update without changes is a
  validation error, and a person never gets an organisation name or an organisation a first or
  last name. `sevdesk_part_update` relies on the same reading for `PUT /Part/{partId}`
  (`src/domain/parts-write.ts`).
- **Test:** `test/unit/tools/masterdata/contact-update.test.ts` ("changes only the given fields of
  contact, billing address and main entries", "sends no contact PUT when only a communication way
  changes", "refuses an update that changes nothing", "never mixes the kinds of contacts"),
  `test/unit/tools/masterdata/part-update.test.ts` ("changes name, number, price and unit and
  keeps everything else"). Pending: M3 recording session, probe `write-contact-partial-update`.

### D-063: `createInvoiceFromOrder` `amount` is described as the amount already paid

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `Model_CreateInvoiceFromOrder.amount`: "Amount which has already been paid for
  this Invoice". `type` "defines the type of amount" (`percentage`, `net`, `gross`), and
  `partialType` "defines the type of the invoice": "RE - Schlussrechnung", "TR - Teilrechnung",
  "AR - Abschlagsrechnung" (elsewhere RE is a normal invoice and ER the final invoice). An amount
  "already paid" with a type `percentage` makes little sense; nothing says how much of the order
  a TR or AR invoice covers. The 200 answer is declared as a bare `Model_InvoiceResponse` (D-001,
  D-064).
- **Actual behavior:** Not recorded anywhere. We read `amount` with `type` as the part of the order
  to invoice.
- **Sources:** spec (`Model_CreateInvoiceFromOrder`, `createInvoiceFromOrder`). D-010 for the
  earlier required invoice id.
- **Impact:** `sevdesk_order_to_invoice` (`src/domain/derived-documents.ts`) always sends
  `partialType` (whole order RE, partial TR, advance AR) and sends `type` and `amount` only for TR
  and AR, as the part to invoice: a percentage up to 100, or a net or gross amount up to the
  order's total. The preview shows that amount. TR and AR invoices are offered only with tax rule
  1 or 11 (spec section "sevdesk-Update 2.0").
- **Test:** `test/unit/tools/masterdata/order-to-invoice.test.ts` ("creates partial and advance
  invoices with amount and amount type", "checks amounts against the mode and the order totals",
  "allows partial invoices only with tax rule 1 or 11"). Pending: M3 recording session, probe
  `write-invoice-from-order`.

### D-064: Answers of the derived-document factories are unrecorded

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `POST /CreditNote/Factory/createFromInvoice` answers 201 with
  `{objects: {creditNote, creditNotePos, discount}}`. `POST /Invoice/Factory/createInvoiceFromOrder`
  and `POST /Invoice/Factory/createInvoiceReminder` answer 200 with a bare `Model_InvoiceResponse`.
  `createInvoiceReminder` requires `invoice[id]` and `invoice[objectName]` in the query and
  `{invoice}` in the body. Nothing says whether a payment can be booked on a reminder (type MA).
- **Actual behavior:** The reminder answer is wrapped in `objects` (j-mastr/sevdesk-api#12).
  jernoxit/sevdesk-rs reads the id of a credit note made from an invoice from `creditNote.id` or
  from `id`, so it allows both shapes (live, not recorded). No answer of
  `createInvoiceFromOrder` is recorded anywhere. Whether the reminder needs the query, the body or
  both is not measured, nor whether reminders can be paid.
- **Sources:** spec (`createCreditNoteFromInvoice`, `createInvoiceFromOrder`,
  `createInvoiceReminder`); [j-mastr/sevdesk-api#12](https://github.com/j-mastr/sevdesk-api/pull/12);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`tests/number_probe/calls.rs`).
- **Impact:** `createdDocumentId` (`src/domain/derived-documents.ts`) takes the new document's id
  from the record itself, from a nested `creditNote` or `invoice` member, or from either inside an
  array of one; an answer without an id is an `unexpected_response` error. The document is then
  read back by id. Reminders are requested with the invoice in the query and in the body. Before
  creating, the tools look for documents already derived from the same source and refuse another
  one unless `allowDuplicate` (filters: D-035). The payment tool refuses to book on a reminder and points
  to the invoice it reminds of (`assertBookable` in `src/domain/lifecycle/transitions.ts`).
- **Test:** `test/unit/tools/masterdata/credit-note-from-invoice.test.ts` ("accepts a plain credit
  note answer and reports it when the read-back fails"),
  `test/unit/tools/masterdata/order-to-invoice.test.ts` ("reads the id of a nested answer and
  reports the invoice when the read-back fails", "fails as unexpected_response when the answer has
  no id"), `test/unit/tools/masterdata/invoice-reminder.test.ts` ("creates the reminder with the
  invoice in query and body, and reads it back"), `test/unit/domain/lifecycle/transitions.test.ts`
  ("assertBookable": "refuses a reminder"). Pending: M3 recording session, probes
  `write-credit-note-from-invoice`, `write-invoice-from-order`, `write-reminder`,
  `write-reminder-payment`.

### D-065: ReceiptGuidance tax rate words and paging are unspecified

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `ReceiptGuideDto.allowedTaxRules[].taxRates` is "An array of tax rates which are
  combinable with this tax rule", typed as strings, with only the example `ZERO`, `SEVEN`,
  `NINETEEN`; there is no enum. `allowedReceiptTypes` has only the example `EXPENSE`.
  `GET /ReceiptGuidance/forAllAccounts` declares no parameters, so no `limit` or `offset`, and no
  total.
- **Actual behavior:** A recorded `forAllAccounts` answer (Update 2.0) uses the words `ZERO`,
  `SEVEN` and `NINETEEN`, the receipt types `EXPENSE` and `REVENUE`, and ids as JSON numbers.
  Words for other rates (5 %, 16 %) have not been seen. Whether `forAllAccounts` honors `limit`, or
  always returns every account, is not measured.
- **Sources:** spec (`ReceiptGuideDto`, `forAllAccounts`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) `tests/fixtures/receipt_guidance.json`.
- **Impact:** `src/domain/receipt-guidance.ts` maps `ZERO`, `FIVE`, `SEVEN`, `SIXTEEN` and
  `NINETEEN` and numeric strings to rates and keeps unknown words apart (`unknownTaxRates`), so
  `checkAccountTaxRule` warns instead of failing on them; ids may be strings or numbers. It reads
  one page with an explicit `limit=1000` (D-019) and reports a full page or a larger total as
  truncated; `validateAccountTaxRule` then downgrades an unknown account to a warning. The guidance
  serves `sevdesk_reference_lookup` (`kind: receipt_guidance`) now and the voucher writes in M4
  (D-006).
- **Test:** `test/unit/domain/receipt-guidance.test.ts` ("parses the recorded forAllAccounts
  response into compact guides", "accepts string ids, numeric rates, null lists and keeps unknown
  rate words apart", "warns instead of failing when the allowed rates contain unknown words",
  "reports a full page or a larger total as truncated", "downgrades an unknown account to a
  warning when the guidance was truncated"), `test/unit/tools/meta/reference-lookup.test.ts`.
  Pending: M3 recording session, probe `read-receipt-guidance-limit`.

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
  other integrators, linked), or `recorded` (seen in our own recordings; "community recording"
  marks a recording published by another project).
- **Sources** cite our own measurements as "recorded 2026-11-07, trial account, Update 2.0 (probe
  `<id>`)": a probe of `pnpm probe` (`scripts/probe-api.ts`, probes in `scripts/lib/probes/`) run
  in the M3 recording session on a sevDesk trial account (SKR04), whose scrubbed report groups the
  results by entry id. "manual check (lead)" marks a one-off script the maintainer ran on the
  same account. Recorded read responses are in `test/fixtures/recorded/2026-11-07/`; every one of
  them runs through its production parser in `test/contract/recorded-fixtures.test.ts`.
- The M4 session (2026-11-08) ran the M4 probes (`scripts/lib/probes/m4-*-probes.ts`) on the same
  account, by then on standard VAT, in four runs: a read-only run with a first write run, a second
  write run (it also created a file-import bank account for hand-made transactions), an opt-in
  DATEV run that set a fake DATEV configuration on the trial, and a run of split bookings. Its
  measurements are cited as "recorded 2026-11-08, trial account, Update 2.0 (probe `<id>`)". Its
  recorded reads are in `test/fixtures/recorded/2026-11-08/`, checked by
  `test/contract/recorded-fixtures-m4.test.ts`.
- **Test** names the test that pins our handling of the deviation. Every open entry gets one.
  "Pending: recording session, probe `<id>`" names the probe that checks the behavior against a
  real account and says why the 2026-11-07 session left it open.
- "(fix in this PR)" in an Impact marks a change made together with the recording findings; it
  describes the behavior after that change.
- When the drift check (`scripts/check-spec-drift.ts`) reports a spec change, re-check the
  entries it touches and update their status.

## Index

| Id                                                                                                 | Title                                                                                  | Status                |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| [D-001](#d-001-most-write-and-pdf-responses-are-wrapped-in-objects)                                | Most write and PDF responses are wrapped in `{objects: …}`                             | Open                  |
| [D-002](#d-002-scalars-come-back-as-strings)                                                       | Scalars come back as strings                                                           | Open                  |
| [D-003](#d-003-unknown-request-fields-are-silently-ignored)                                        | Unknown request fields are silently ignored                                            | Open                  |
| [D-004](#d-004-the-save-factories-require-properties-that-do-not-exist)                            | The `save*` factories require properties that do not exist                             | Open                  |
| [D-005](#d-005-model_invoice-requires-tax-fields-of-both-system-versions)                          | `Model_Invoice` requires tax fields of both system versions                            | Open                  |
| [D-006](#d-006-taxrule-id-enums-are-incomplete)                                                    | `taxRule` id enums are incomplete                                                      | Partly fixed upstream |
| [D-007](#d-007-voucher-status-and-recurringinterval-enums-are-too-narrow)                          | Voucher `status` and `recurringInterval` enums are too narrow                          | Open                  |
| [D-008](#d-008-two-response-fields-typed-string-can-be-numbers)                                    | Two response fields typed `string` can be numbers                                      | Open                  |
| [D-009](#d-009-sendtype-can-be-an-empty-string-or-0)                                               | `sendType` can be an empty string or `"0"`                                             | Open                  |
| [D-010](#d-010-createinvoicefromorder-required-a-bogus-invoice-id)                                 | `createInvoiceFromOrder` required a bogus invoice id                                   | Fixed upstream        |
| [D-011](#d-011-uploadtempfile-media-type-and-filename-type-are-wrong)                              | `uploadTempFile` media type and `filename` type are wrong                              | Open                  |
| [D-012](#d-012-export-endpoints-return-raw-csv-or-zip-with-downloadtrue)                           | Export endpoints return raw CSV or ZIP with `download=true`                            | Open                  |
| [D-013](#d-013-invoice-bookamount-response-has-copy-paste-errors)                                  | Invoice `bookAmount` response has copy-paste errors                                    | Open                  |
| [D-014](#d-014-accountintervall-example-is-a-date)                                                 | `accountIntervall` example is a date                                                   | Open                  |
| [D-015](#d-015-invoice-type-filters-use-re-instead-of-re)                                          | Invoice type filters use `Re` instead of `RE`                                          | Open                  |
| [D-016](#d-016-valuedate-and-entrydate-descriptions-are-swapped)                                   | `valueDate` and `entryDate` descriptions are swapped                                   | Open                  |
| [D-017](#d-017-originobjectname-only-allowed-invoice)                                              | `origin.objectName` only allowed `Invoice`                                             | Fixed upstream        |
| [D-018](#d-018-document-dates-are-typed-date-time-but-take-unix-or-ddmmyyyy)                       | Document dates are typed `date-time` but take Unix or `dd.mm.yyyy`                     | Open                  |
| [D-019](#d-019-pagination-limits-and-silent-truncation-at-100)                                     | Pagination limits and silent truncation at 100                                         | Partly fixed upstream |
| [D-020](#d-020-list-filters-behave-differently-from-their-declared-types)                          | List filters behave differently from their declared types                              | Open                  |
| [D-021](#d-021-validation-errors-can-come-back-as-500)                                             | Validation errors can come back as 500                                                 | Open                  |
| [D-022](#d-022-rate-limiting-is-undocumented)                                                      | Rate limiting is undocumented                                                          | Open                  |
| [D-023](#d-023-some-gets-change-state)                                                             | Some GETs change state                                                                 | Open                  |
| [D-024](#d-024-undocumented-endpoints-we-rely-on)                                                  | Undocumented endpoints we rely on                                                      | Open                  |
| [D-025](#d-025-pdf-rendering-returns-one-base64-pdf-since-2026-04-07)                              | PDF rendering returns one base64 `pdf` since 2026-04-07                                | Partly fixed upstream |
| [D-026](#d-026-savevoucher-key-order-and-top-level-filename)                                       | `saveVoucher` key order and top-level `filename`                                       | Open                  |
| [D-027](#d-027-document-numbers-are-assigned-on-finalizing-and-can-show-placeholders)              | Document numbers are assigned on finalizing and can show placeholders                  | Open                  |
| [D-028](#d-028-kleinunternehmer-tax-rule-id-differs-between-spec-sections)                         | Kleinunternehmer tax rule id differs between spec sections                             | Open                  |
| [D-029](#d-029-tax-rule-21-has-two-different-names)                                                | Tax rule 21 has two different names                                                    | Open                  |
| [D-030](#d-030-undocumented-tax-rules-15-16-and-22)                                                | Undocumented tax rules 15, 16 and 22                                                   | Open                  |
| [D-031](#d-031-transaction-status-350-exists-only-in-the-response-model)                           | Transaction status 350 exists only in the response model                               | Open                  |
| [D-032](#d-032-the-contactid-filter-on-contactaddress-is-undocumented)                             | The `contact[id]` filter on `/ContactAddress` is undocumented                          | Open                  |
| [D-033](#d-033-getxml-refusals-for-invoices-without-xml-are-undocumented)                          | `getXml` refusals for invoices without XML are undocumented                            | Open                  |
| [D-034](#d-034-invoice-reads-do-not-say-whether-an-invoice-is-an-e-invoice)                        | Invoice reads do not say whether an invoice is an e-invoice                            | Open                  |
| [D-035](#d-035-unknown-or-misspelled-list-filters-are-ignored)                                     | Unknown or misspelled list filters are ignored                                         | Open                  |
| [D-036](#d-036-getrelatedobjects-is-declared-to-return-order-positions)                            | `getRelatedObjects` is declared to return order positions                              | Open                  |
| [D-037](#d-037-cancelled-invoices-keep-status-1000)                                                | Cancelled invoices keep status 1000                                                    | Open                  |
| [D-038](#d-038-the-credit-note-status-filter-allows-order-statuses)                                | The credit note status filter allows order statuses                                    | Open                  |
| [D-039](#d-039-credit-note-and-position-responses-have-undeclared-fields)                          | Credit note and position responses have undeclared fields                              | Open                  |
| [D-040](#d-040-the-creditnotepos-filter-names-the-wrong-objectname)                                | The `CreditNotePos` filter names the wrong `objectName`                                | Open                  |
| [D-041](#d-041-bookamount-on-vouchers-and-credit-notes-takes-a-signed-amount)                      | `bookAmount` on vouchers and credit notes takes a signed amount                        | Open                  |
| [D-042](#d-042-part-price-can-hold-the-net-or-the-gross-price)                                     | Part `price` can hold the net or the gross price                                       | Open                  |
| [D-043](#d-043-the-currency-of-document-sums-is-undocumented)                                      | The currency of document sums is undocumented                                          | Open                  |
| [D-044](#d-044-voucher-reads-can-omit-document)                                                    | Voucher reads can omit `document`                                                      | Open                  |
| [D-045](#d-045-voucher-positions-can-lack-accountdatev-on-update-20)                               | Voucher positions can lack `accountDatev` on Update 2.0                                | Open                  |
| [D-046](#d-046-date-range-filters-on-document-lists-are-described-two-ways)                        | Date-range filters on document lists are described two ways                            | Open                  |
| [D-047](#d-047-transaction-date-filters-compare-entrydate)                                         | Transaction date filters compare `entryDate`                                           | Open                  |
| [D-048](#d-048-change-filters-are-documented-only-in-tag-texts)                                    | Change filters are documented only in tag texts                                        | Open                  |
| [D-049](#d-049-whether-lists-include-templates-and-reminders-is-undocumented)                      | Whether lists include templates and reminders is undocumented                          | Open                  |
| [D-050](#d-050-a-position-price-is-read-by-the-documents-shownet)                                  | A position `price` is read by the document's `showNet`                                 | Open                  |
| [D-051](#d-051-savecreditnote-needs-other-fields-than-model_creditnote-requires)                   | `saveCreditNote` needs other fields than `Model_creditNote` requires                   | Open                  |
| [D-052](#d-052-draft-requests-use-fields-the-request-models-do-not-declare)                        | Draft requests use fields the request models do not declare                            | Open                  |
| [D-053](#d-053-the-trailing-factory-parameters-are-optional)                                       | The trailing factory parameters are optional                                           | Open                  |
| [D-054](#d-054-updating-a-draft-through-the-save-factories-is-barely-documented)                   | Updating a draft through the save factories is barely documented                       | Open                  |
| [D-055](#d-055-the-saveinvoice-answer-has-undeclared-and-oddly-typed-fields)                       | The `saveInvoice` answer has undeclared and oddly typed fields                         | Open                  |
| [D-056](#d-056-which-day-a-bookamount-date-means-is-undocumented)                                  | Which day a `bookAmount` date means is undocumented                                    | Open                  |
| [D-057](#d-057-transactions-report-no-assigned-or-remaining-amount)                                | Transactions report no assigned or remaining amount                                    | Open                  |
| [D-058](#d-058-cancelinvoice-answers-and-refusals-are-undocumented)                                | `cancelInvoice` answers and refusals are undocumented                                  | Open                  |
| [D-059](#d-059-enshrine-is-idempotent-and-does-not-block-payments)                                 | `enshrine` is idempotent and does not block payments                                   | Open                  |
| [D-060](#d-060-resettoopen-works-on-enshrined-documents-and-unlinks-payments-silently)             | `resetToOpen` works on enshrined documents and unlinks payments silently               | Open                  |
| [D-061](#d-061-post-contact-assigns-the-next-customer-number)                                      | `POST /Contact` assigns the next customer number                                       | Open                  |
| [D-062](#d-062-put-on-contacts-addresses-and-communication-ways-is-a-partial-update)               | PUT on contacts, addresses and communication ways is a partial update                  | Open                  |
| [D-063](#d-063-createinvoicefromorder-amount-is-described-as-the-amount-already-paid)              | `createInvoiceFromOrder` `amount` is described as the amount already paid              | Open                  |
| [D-064](#d-064-answers-of-the-derived-document-factories-are-partly-undocumented)                  | Answers of the derived-document factories are partly undocumented                      | Open                  |
| [D-065](#d-065-receiptguidance-tax-rate-words-and-paging-are-unspecified)                          | ReceiptGuidance tax rate words and paging are unspecified                              | Open                  |
| [D-066](#d-066-undocumented-next-number-endpoints-peek-or-reserve)                                 | Undocumented next-number endpoints peek or reserve                                     | Open                  |
| [D-067](#d-067-get-sevclient-tells-the-taxation-regime-and-sevdesk-checks-it-only-when-finalizing) | `GET /SevClient` tells the taxation regime, and sevDesk checks it only when finalizing | Open                  |
| [D-068](#d-068-finalizing-a-credit-note-without-a-number-fails-with-500-or-repeats-a-number)       | Finalizing a credit note without a number fails with 500 or repeats a number           | Open                  |
| [D-069](#d-069-sendviaemail-answers-an-email-record-refusals-leave-the-document-unchanged)         | `sendViaEmail` answers an `Email` record; refusals leave the document unchanged        | Open                  |
| [D-070](#d-070-a-payment-on-a-reminder-ma-pays-only-the-reminder)                                  | A payment on a reminder (MA) pays only the reminder                                    | Open                  |
| [D-071](#d-071-a-booking-without-a-transaction-creates-one-and-resettoopen-deletes-it)             | A booking without a transaction creates one, and `resetToOpen` deletes it              | Open                  |
| [D-072](#d-072-getpdf-answers-mimetype-and-base64encoded-not-the-specs-casing)                     | `getPdf` answers `mimetype` and `base64Encoded`, not the spec's casing                 | Open                  |
| [D-073](#d-073-vouchers-are-finalized-through-savevoucher-put-voucher-refuses-a-status)            | Vouchers are finalized through `saveVoucher`; `PUT /Voucher` refuses a status          | Open                  |
| [D-074](#d-074-delete-voucher-deletes-only-drafts)                                                 | `DELETE /Voucher` deletes only drafts                                                  | Open                  |
| [D-075](#d-075-a-full_payment-must-use-the-whole-linked-transaction-type-n-splits-it)              | A `FULL_PAYMENT` must use the whole linked transaction; type `N` splits it             | Open                  |
| [D-076](#d-076-marking-a-transaction-private-changes-only-its-status)                              | Marking a transaction private changes only its status                                  | Open                  |
| [D-077](#d-077-the-datev-export-job-starts-with-a-post-and-its-answers-differ-from-the-spec)       | The DATEV export job starts with a POST, and its answers differ from the spec          | Open                  |
| [D-078](#d-078-receiptguidance-allows-only-0--for-intra-eu-acquisitions-and-reverse-charge)        | ReceiptGuidance allows only 0 % for intra-EU acquisitions and reverse charge           | Open                  |
| [D-079](#d-079-get-accountdatev-ignores-its-filters-and-lists-fewer-accounts-than-receiptguidance) | `GET /AccountDatev` ignores its filters and lists fewer accounts than ReceiptGuidance  | Open                  |
| [D-080](#d-080-a-voucher-is-booked-only-with-a-belegnummer)                                        | A voucher is booked only with a Belegnummer                                            | Open                  |
| [D-081](#d-081-converting-a-voucher-draft-to-eur-clears-foreign-sums)                              | Converting a voucher draft to EUR clears foreign sums                                  | Open                  |
| [D-082](#d-082-voucher-exchange-rates-are-not-returned-and-updates-reconvert-positions)            | Voucher exchange rates are not returned and updates reconvert positions                | Open                  |
| [D-083](#d-083-parent-on-a-contact-is-stored-without-checks-and-clearing-it-drops-the-key)         | `parent` on a contact is stored without checks, and clearing it drops the key          | Open                  |
| [D-084](#d-084-deleting-a-contact-deletes-its-addresses-and-communication-ways)                    | Deleting a contact deletes its addresses and communication ways                        | Open                  |
| [D-085](#d-085-refused-deletes-of-referenced-contacts-and-cost-centres-arrive-as-http-200)         | Refused deletes of referenced contacts and cost centres arrive as HTTP 200             | Open                  |
| [D-086](#d-086-custom-contact-fields-30-character-names-no-contact-embed-cascading-deletes)        | Custom contact fields: 30-character names, no contact embed, cascading deletes         | Open                  |
| [D-087](#d-087-checkcustomernumberavailability-answers-a-bare-boolean-and-needs-a-number)          | `checkCustomerNumberAvailability` answers a bare boolean and needs a number            | Open                  |
| [D-088](#d-088-tags-are-added-by-name-through-tagfactorycreate-which-reuses-a-tag)                 | Tags are added by name through `Tag/Factory/create`, which reuses a tag                | Open                  |
| [D-089](#d-089-delete-tagrelationid-removes-a-tag-from-a-document-the-last-one-the-tag)            | `DELETE /TagRelation/{id}` removes a tag from a document, the last one the tag         | Open                  |
| [D-090](#d-090-document-lists-filter-by-tag-only-with-tags0id-tagid-is-ignored)                    | Document lists filter by tag only with `tags[0][id]`; `tag[id]` is ignored             | Open                  |
| [D-091](#d-091-cost-centres-are-managed-through-the-undocumented-costcentre-endpoints)             | Cost centres are managed through the undocumented `/CostCentre` endpoints              | Open                  |
| [D-092](#d-092-saveorder-drops-costcentre-invoices-vouchers-and-credit-notes-keep-it)              | `saveOrder` drops `costCentre`; invoices, vouchers and credit notes keep it            | Open                  |
| [D-095](#d-095-on-a-cash-register-resettoopen-books-a-counter-entry-instead-of-deleting)           | On a cash register `resetToOpen` books a counter-entry instead of deleting             | Open                  |
| [D-096](#d-096-deleting-a-transaction-is-a-soft-delete-and-works-only-at-status-100)               | Deleting a transaction is a soft delete and works only at status 100                   | Open                  |
| [D-097](#d-097-check-accounts-come-only-from-two-factories-and-delete-archives-them)               | Check accounts come only from two factories, and `DELETE` archives them                | Open                  |
| [D-098](#d-098-an-enshrined-transaction-locks-itself-and-the-payment-it-books)                     | An enshrined transaction locks itself and the payment it books                         | Open                  |
| [D-099](#d-099-private-transaction-rules-did-not-mark-hand-made-transactions)                      | Private-transaction rules did not mark hand-made transactions                          | Open                  |
| [D-100](#d-100-a-receipts-contenthash-is-the-sha-256-of-the-file-rendered-pdfs-have-none)          | A receipt's `contentHash` is the SHA-256 of the file; rendered PDFs have none          | Open                  |
| [D-101](#d-101-the-zip-exports-answer-files-only-with-downloadtrue-and-change-no-document)         | The ZIP exports answer files only with `download=true` and change no document          | Open                  |
| [D-102](#d-102-the-datev-xml-job-works-like-the-csv-job-and-marks-nothing-as-exported)             | The DATEV XML job works like the CSV job and marks nothing as exported                 | Open                  |
| [D-103](#d-103-createvoucherfromfile-makes-a-draft-that-sevdesk-fills-in-within-seconds)           | `createVoucherFromFile` makes a draft that sevDesk fills in within seconds             | Open                  |
| [D-107](#d-107-order-factories-copy-the-order-a-confirmation-marks-the-offer-accepted)             | Order factories copy the order; a confirmation marks the offer accepted                | Open                  |
| [D-108](#d-108-put-orderid-sets-an-offers-status-on-a-draft-it-also-renumbered-it)                 | `PUT /Order/{id}` sets an offer's status; on a draft it also renumbered it             | Open                  |
| [D-109](#d-109-delete-order-and-delete-creditnote-delete-only-drafts)                              | `DELETE /Order` and `DELETE /CreditNote` delete only drafts                            | Open                  |
| [D-110](#d-110-savecreditnote-with-an-id-updates-a-draft-creditnoteposdelete-is-a-list)            | `saveCreditNote` with an id updates a draft; `creditNotePosDelete` is a list           | Open                  |
| [D-111](#d-111-recurring-templates-run-from-accountstartdate-accountnextinvoice-is-ignored)        | Recurring templates run from `accountStartDate`; `accountNextInvoice` is ignored       | Open                  |
| [D-112](#d-112-recurring-templates-status-50-ends-status-200-blocks-delete-lists-hide-them)        | Recurring templates: status 50 ends, status 200 blocks `DELETE`, lists hide them       | Open                  |
| [D-113](#d-113-changeparameter-answers-the-layout-in-metadata-orders-need-a-preview-first)         | `changeParameter` answers the layout in `metaData`; orders need a preview first        | Open                  |
| [D-114](#d-114-docserver-layout-lists-sit-under-objects-and-carry-large-base64-fields)             | DocServer layout lists sit under `objects` and carry large base64 fields               | Open                  |
| [D-115](#d-115-post-and-delete-texttemplate-create-and-delete-text-templates)                      | `POST` and `DELETE /TextTemplate` create and delete text templates                     | Open                  |
| [D-116](#d-116-document-discounts-discountsave-takes-a-list-getdiscounts-reads-them)               | Document discounts: `discountSave` takes a list; `getDiscounts` reads them             | Open                  |
| [D-119](#d-119-the-account-factories-refuse-an-accountingnumber-in-use-or-not-allowed-422)         | The account factories refuse an `accountingNumber` in use or not allowed (422)         | Open                  |
| [D-130](#d-130-privatetransactionrule-cuts-texts-over-255-characters-without-notice)               | `PrivateTransactionRule` cuts texts over 255 characters without notice                 | Open                  |
| [D-132](#d-132-recurring-templates-generation-and-auto-sending-are-switches-read-by-embed)         | Recurring templates: generation and auto-sending are switches read by `embed`          | Open                  |
| [D-135](#d-135-saveinvoice-keeps-the-price-of-a-position-sent-by-its-id-without-an-error)          | `saveInvoice` keeps the price of a position sent by its id, without an error           | Open                  |
| [D-140](#d-140-languages-invoices-store-en-orders-and-credit-notes-the-locale-or-german)           | Languages: invoices store `en`, orders and credit notes the locale or German           | Open                  |
| [D-141](#d-141-put-checkaccount-answers-200-also-for-keys-it-ignores)                              | `PUT /CheckAccount` answers 200 also for keys it ignores                               | Open                  |
| [D-142](#d-142-an-account-with-booked-transactions-is-not-archived-the-refusal-is-http-200)        | An account with booked transactions is not archived; the refusal is HTTP 200           | Open                  |
| [D-143](#d-143-an-archived-account-cannot-be-restored-and-archiving-clears-its-iban)               | An archived account cannot be restored, and archiving clears its IBAN                  | Open                  |
| [D-144](#d-144-put-checkaccount-refuses-a-booking-account-in-use-with-400-not-422)                 | `PUT /CheckAccount` refuses a booking account in use with 400, not 422                 | Open                  |
| [D-145](#d-145-transaction-lists-run-newest-first-by-valuedate)                                    | Transaction lists run newest first by `valueDate`                                      | Open                  |
| [D-146](#d-146-list-order-ties-are-broken-per-page-so-offset-paging-skips-and-repeats-rows)        | List order ties are broken per page, so offset paging skips and repeats rows           | Open                  |

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
  array of one; an id that does not exist is answered with 404 ("No Model_Invoice with the id …
  was found"), not with an empty array (recorded for `/Contact` and `/Invoice`, D-021). Recorded
  write answers all carry the wrapper, with the record itself (not an array of one) under
  `objects`: `POST /Contact` (its `sevClient` is the whole account record, D-067),
  `POST /ContactAddress`, `POST /CommunicationWay`, `saveInvoice`, `saveCreditNote` and
  `cancelInvoice` (jernoxit/sevdesk-rs, and our recording), `POST /Part` (emuuu/sevDesk.NET, and
  our recording), `PUT …/sendBy` and `PUT /Invoice/{id}/resetToOpen` (the document),
  `bookAmount` on invoices and credit notes (an `InvoiceLog` or `CreditNoteLog`, D-013),
  `createFromInvoice` (`{creditNote, creditNotePos, discount}`), `createInvoiceReminder` (the
  reminder invoice, D-064) and `sendViaEmail` (an `Email` record, D-069). `enshrine` answers
  `{objects: null}`, as the spec declares. The next-number endpoints answer a bare string under
  `objects` (D-066). Only the answer of `createInvoiceFromOrder` is still unrecorded. The M4
  recordings add the voucher and banking writes, all wrapped as well: `saveVoucher`
  (`{voucher, voucherPos, vatdrop}`, D-073), `uploadTempFile` (D-011), the voucher `bookAmount` (a
  `VoucherLog`, D-013), `resetToOpen` and `resetToDraft` on vouchers (the voucher),
  `DELETE /Voucher/{voucherId}` (`[null]`, D-074), `POST /CheckAccountTransaction` and
  `PUT /CheckAccountTransaction/{checkAccountTransactionId}` (the transaction; the spec declares
  both bare) and the DATEV job start (the job id as a string, D-077).
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
  2026-02-19); recorded 2026-11-07, trial account, Update 2.0 (probes `read-unknown-id`,
  `write-book-amount`, `write-cancel-invoice`, `write-credit-note-from-invoice`,
  `write-reminder`, `write-offline-booking-transaction`, `write-part-price-fields`,
  `write-send-email-shape`, `write-next-order-number`; every read in
  `test/fixtures/recorded/2026-11-07/`); recorded 2026-11-08, trial account, Update 2.0 (probes
  `write-voucher-open-directly`, `write-voucher-book-amount`, `write-voucher-reset`,
  `write-voucher-delete`, `write-transaction-create`, `write-transaction-private-status`,
  `write-export-datev-csv`).
- **Impact:** `src/sevdesk/envelope.ts` unwraps every response. It accepts both an object and an
  array of one under `objects`, and maps an empty array from a GET-by-id to a not-found error
  (kept as a safety net; sevDesk's 404 is classified as `not_found` by `src/sevdesk/errors.ts`).
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
  enveloped `bookAmount` answer through the real HTTP client); `test/contract/recorded-fixtures.test.ts`
  (every recorded read through its parser). `createInvoiceFromOrder`: pending: recording session,
  probe `write-invoice-from-order` (its order could not be created: `saveOrder` without a number
  is refused, D-027).

### D-002: Scalars come back as strings

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** Request models type ids and amounts as `integer`/`number`. Response models
  (`Model_*Response`) mostly declare `string`, but not consistently: `showNet` and
  `smallSettlement` are `boolean`, `paidAmount` is `number`. No operation declares `countAll`; the
  overview text shows `"total": "157"`.
- **Actual behavior:** Ids, sums and statuses arrive as strings, booleans as `"0"`/`"1"`
  (`showNet`, `smallSettlement`, `stockEnabled`). Two exceptions were recorded: the `countAll`
  `total` is a JSON number (`"total": 39`), not a string as the overview shows, and an invoice's
  `paidAmount` is a JSON number (`0`, `10`) or `null` (an open invoice after `resetToOpen`, D-060).
  The scalar answers of `getNextCustomerNumber` (`"1008"`), `getBalanceAtDate` (`"249"`),
  `getStock` (`"0"`) and the next-number endpoints (`"AN-1000"`, D-066) are strings. Other JSON
  numbers: D-008, D-055.
- **Sources:** spec overview, section "Pagination";
  [j-mastr/sevdesk-api#90](https://github.com/j-mastr/sevdesk-api/pull/90);
  [genz-its/sevdesk](https://github.com/genz-its/sevdesk) docs; recorded 2026-11-07, trial account,
  Update 2.0 (probe `read-scalar-types`: "countAll total: number", `paidAmount` number/null over
  39 invoices; the recorded lists in `test/fixtures/recorded/2026-11-07/`).
- **Impact:** Incoming zod schemas are lenient and coerce: numeric strings and numbers both parse
  into the decimal money type or integers, `"0"`/`"1"`/`0`/`1`/booleans parse into booleans, and
  `parseTotal` takes the total as a number or a numeric string. We never rely on the declared JSON
  type of a response field. The newly used answers are read the same way: `smallSettlement` of
  `GET /SevClient` with `zBool01` (`src/domain/account-settings.ts`, D-067), the next-number
  strings in `src/domain/drafts/numbering.ts` (D-066) (fix in this PR).
- **Test:** `test/unit/sevdesk/schema.test.ts` (lenient
  `zId`/`zIntish`/`zNumberish`/`zDecimalString`/`zBool01`), `test/unit/domain/contacts.test.ts`,
  `test/unit/domain/invoices.test.ts` (`showNet` and `smallSettlement` as `"0"`/`"1"`),
  `test/unit/tools/invoices/list.test.ts` (`paidAmount` as a JSON number),
  `test/contract/recorded-fixtures.test.ts` ("carries the countAll total of every recorded page
  as a JSON number (D-002)", "lists invoices, including a paidAmount of 0 and of null (D-002)"),
  `test/unit/domain/recorded-scalars.test.ts` (recorded responses through the real client and the
  mappers).

### D-003: Unknown request fields are silently ignored

- **Status:** Open. **Evidence:** community + recorded.
- **Spec says:** Nothing. No schema sets `additionalProperties: false`, and no text says what
  happens to unknown fields.
- **Actual behavior:** sevDesk drops unknown fields and still reports success. Example: a
  `fileName` inside the `voucher` object of `saveVoucher` is dropped, and the voucher is created
  without its document. `POST /Contact` with an unknown field is accepted and the field is absent
  on read-back (recorded).
- **Sources:** [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2) (verified
  against a live account); recorded 2026-11-07, trial account, Update 2.0 (probe
  `write-unknown-field`).
- **Impact:** Outgoing zod schemas are strict: every write body is parsed with a `strictObject`
  schema right before it is sent (`src/domain/drafts/payloads.ts`,
  `src/domain/lifecycle/payments.ts`, `src/domain/lifecycle/email.ts`,
  `src/tools/lifecycle/finalize.ts`, `src/domain/contacts-write.ts`, `src/domain/parts-write.ts`,
  `src/domain/derived-documents.ts`, `src/domain/drafts/voucher-payload.ts`,
  `src/domain/reconciliation/transaction-status.ts`), so a misspelled key is a bug that fails
  before sending. Tool
  inputs reject unknown parameters with a message that names them. Writes are read back; the
  draft tools compare the stored totals with the preview (D-050).
- **Test:** `test/unit/domain/drafts/payloads.test.ts` ("draft payloads: strict outgoing schemas
  (D-003, D-004, B8)": unknown and derived keys are refused as internal errors),
  `test/unit/domain/vouchers-write.test.ts` ("saveVoucher body (D-003, D-004, D-026)"),
  `test/integration/metadata-lint.test.ts` ("has a strict, flat object-root input JSON Schema",
  every tool). sevDesk's own behavior: probe `write-unknown-field`.

### D-004: The `save*` factories require properties that do not exist

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `saveInvoice.required` is `[invoice, invoicePos]`, but the properties are
  `invoicePosSave` and `invoicePosDelete`. `saveVoucher.required` is `[voucher, voucherPos]`, but
  the properties are `voucherPosSave` and `voucherPosDelete`. The same holds for
  `saveCreditNote` (`required: [creditNote, creditNotePos]`, properties `creditNotePosSave`,
  `creditNotePosDelete`) and `saveOrder` (`required: [order, orderPos]`, properties
  `orderPosSave`, `orderPosDelete`). The response schemas use `invoicePos`/`voucherPos`/
  `creditNotePos`/`orderPos`, and the InvoicePos tag's update example sends `"invoicePos"` too.
- **Actual behavior:** The API reads `invoicePosSave`/`creditNotePosSave`/`orderPosSave`/
  `voucherPosSave` (and `*PosDelete`). A client that follows `required` and sends `invoicePos`
  loses its positions without an error (see D-003). Every voucher saved by the M4 write probes sent
  its positions in `voucherPosSave` and got them (recorded); `voucherPos` was not tried.
- **Sources:** spec (`components.schemas.saveInvoice`, `saveCreditNote`, `saveOrder`,
  `saveVoucher`; tag `InvoicePos`, "How to create/update an invoice position");
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`invoicePosSave` and
  `creditNotePosSave` requests whose answers are recorded in `tests/fixtures/write_invoice_save.json`
  and `write_credit_note_save.json`); `orderPosSave` in the working order bodies of
  [codestra/sevdesk-mcp](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts)
  (community, not recorded); recorded 2026-11-08, trial account, Update 2.0 (probes
  `write-voucher-save-with-file`, `write-voucher-update-draft`).
- **Impact:** The draft builders send `invoicePosSave`/`creditNotePosSave`/`orderPosSave` only;
  the strict body schemas in `src/domain/drafts/payloads.ts` have no `*Pos` key, and our schemas
  do not copy the spec's `required` lists. The voucher writes send `voucherPosSave` only
  (`saveVoucherBodySchema` in `src/domain/drafts/voucher-payload.ts` has no `voucherPos`). How
  `*PosDelete` is typed: D-054.
- **Test:** `test/unit/domain/drafts/payloads.test.ts` ("refuses the spec's non-existent
  invoicePos as an internal error"), `test/regressions/b8-price-fields.test.ts` (positions under
  `invoicePosSave`, `creditNotePosSave`, `orderPosSave`),
  `test/unit/tools/drafts/invoice-update-draft.test.ts` ("replaces all positions in one request
  (deletes the stored ones)"). `saveVoucher`: `test/unit/domain/vouchers-write.test.ts` ("refuses
  the spec's non-existent voucherPos as an internal error"),
  `test/unit/tools/vouchers/create-draft.test.ts` ("creates an expense draft with tax rule 9 and
  the exact body (D-004: voucherPosSave)").

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
  recorded in `tests/fixtures/write_invoice_save.json`, `write_credit_note_save.json`); recorded
  2026-11-07, trial account, Update 2.0 (every draft of the write probes has this shape, e.g.
  probe `write-numbering-invoice`). Which rules an account accepts also depends on its taxation
  regime (D-067).
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

- **Status:** Partly fixed upstream. **Evidence:** spec + community + recorded.
- **Spec says:** `taxRule.id` is a string enum. On invoices, orders and credit notes it is now
  `1, 2, 3, 4, 5, 11, 17, 18, 19, 20, 21`. On vouchers (`Model_Voucher`, `Model_VoucherResponse`,
  `Model_VoucherUpdate`) it is still `1, 2, 3, 4, 5, 11`: the revenue rules only. The spec's own
  "Tax Rules" overview lists the expense rules `8, 9, 10, 12, 13, 14`, which no enum allows.
- **Actual behavior:** Vouchers are usually expenses and use rules 8–10 and 12–14; ReceiptGuidance
  also returns 16. A Kleinunternehmer expense account allows exactly 10 and 13: on a
  small-business account, finalizing a `PROVISION` credit note with rule 9 was refused with 422
  "Tax rule 'VORST_ABZUGSF_AUFW' is not valid for account '6770' with taxation scope
  'SMALL_BUSINESS'. Allowed tax rules: TaxRule(id=10, …), TaxRule(id=13, …)" (recorded, D-067).
  The recorded `GET /TaxRule` lists 20 rules, 1–5 and 8–22, rule 22 included. Credit notes with
  booking category `PROVISION` take the expense rule 9 and refuse rule 1 ("Invalid tax rule"),
  although the credit note enum allows only revenue rules. sevDesk does not check the rule against
  the booking account on a voucher draft: an expense voucher on the expense account 6815 with the
  revenue rule 1 was saved as a draft (status 50) without complaint (recorded 2026-11-08). Whether
  finalizing it would be refused was not tried.
- **Sources:** [j-mastr/sevdesk-api#68](https://github.com/j-mastr/sevdesk-api/pull/68),
  [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2), spec overview;
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) `src/endpoints/credit_note.rs`
  (PROVISION and rule 9, measured 2026-09-29, not recorded); recorded 2026-11-07, trial account,
  Update 2.0 (probe `write-numbering-credit-note` while the account was still a Kleinunternehmer;
  `test/fixtures/recorded/2026-11-07/meta/tax-rules.json`); recorded 2026-11-08, trial account,
  Update 2.0 (probe `write-voucher-invalid-account-rule`).
- **Impact:** Response schemas accept any id string. Sales drafts (invoices, orders, credit
  notes) accept the rules of the spec's sales-document enum (`SALES_TAX_RULE_IDS` in
  `src/domain/drafts/tax.ts`), narrowed to the account's taxation regime (D-067); provision credit
  notes accept rule 9 only, or rule 10 (default) or 13 on a Kleinunternehmer account
  (`src/domain/drafts/credit-note.ts`; the regime part is a fix in this PR). For receipts, `validateAccountTaxRule`
  (`src/domain/receipt-guidance.ts`) checks account × tax rule × tax rate against the cached
  ReceiptGuidance instead of a static enum (D-065). Every voucher write (create, an update that
  changes the rule, finalize, the e-invoice import) calls it for each position before sending
  (`checkVoucherAccounts` in `src/domain/drafts/voucher-checks.ts`); since sevDesk accepts any
  combination on a draft, this check is the only guard (B2).
- **Test:** `test/regressions/b9-reference-ids.test.ts` (all tax-rule ids, checked against the
  recorded `GET /TaxRule`), `test/unit/domain/drafts/tax.test.ts` ("covers exactly the spec's
  sales-document rule enum"), `test/unit/tools/drafts/credit-note-create-draft.test.ts` ("uses
  tax rule 9 for a provision credit note without a source invoice", "a provision credit note with
  tax rule 1"), `test/unit/domain/receipt-guidance.test.ts` ("checkAccountTaxRule",
  "validateAccountTaxRule"), `test/contract/recorded-fixtures.test.ts` ("knows exactly the tax
  rules of the recorded GET /TaxRule, with the same codes"). Vouchers:
  `test/regressions/b2-account-datev.test.ts` ("refuses a revenue account on an expense voucher,
  with the allowed alternatives", "checks the stored positions again when an update changes the
  tax rule", "checks a stored draft once more before it is finalized"),
  `test/unit/tools/vouchers/create-draft.test.ts` ("refuses account × rule × rate combinations
  the ReceiptGuidance rejects (B2)"). Live: probe `write-voucher-invalid-account-rule`.

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
  forms occur. In our recording every transaction `amount` is a string (`"119"`, `"-119"`) and
  `defaultDiscountAmount` is `null` on every contact.
- **Sources:** [j-mastr/sevdesk-api#90](https://github.com/j-mastr/sevdesk-api/pull/90);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (2026-02-19);
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-scalar-types`;
  `test/fixtures/recorded/2026-11-07/banking/transactions-list.json`).
- **Impact:** Covered by the lenient number coercion from D-002. The transaction fixture
  (`test/fixtures/banking/transactions-list.json`) has both forms. No tool reads
  `defaultDiscountAmount`.
- **Test:** `test/unit/tools/banking/transactions.test.ts` (`amount` as a string and as a number).

### D-009: `sendType` can be an empty string or `"0"`

- **Status:** Open. **Evidence:** community + recorded.
- **Spec says:** `sendType` is a nullable enum `VPR, VPDF, VM, VP`.
- **Actual behavior:** Orders, invoices and credit notes can also return `""` or `"0"`. Recorded:
  every draft (invoice, credit note) has `"0"`; `sendBy` with `VPR` sets `"VPR"` on invoices and
  credit notes; a successful `sendViaEmail` changes it to `"VM"` (D-069). An offer finalized with
  `sendBy` (`sendType` `VPR`) reads back with `sendType` `"0"` next to its `sendDate`, so on orders
  `"0"` does not mean "not sent".
- **Sources:** [j-mastr/sevdesk-api#45](https://github.com/j-mastr/sevdesk-api/issues/45);
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-scalar-types`: values `"0"` and
  `"VPR"`; the order in `test/fixtures/recorded/2026-11-07/orders/order-by-id.json`, finalized by a
  manual check (lead)).
- **Impact:** `""`, `"0"`, `null` and unknown codes all count as "no send type". The read tools
  show a document as sent only with a documented send type or a `sendDate`, and name the send
  type readably (`sent.via`: `pdf_download`, `post`, `print`, `email`). The finalize tools
  write only the four documented codes (`VPDF` by default, `VP`, `VPR`, `VM`; strict `sendBy`
  body in `src/tools/lifecycle/finalize.ts`).
- **Test:** `test/unit/domain/document-positions.test.ts` ("treats empty, '0' and unknown send
  types as not sent"), `test/unit/tools/invoices/list.test.ts`. Writing:
  `test/unit/tools/lifecycle/finalize.test.ts` ("marks the draft as sent with sendDraft false,
  then reads it back"), `test/contract/recorded-fixtures.test.ts` ("D-009: a finalized order
  keeps sendType '0' next to its sendDate").

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

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /Voucher/Factory/uploadTempFile` declares the request media type
  `form-data`, which is not a valid media type, and an answer with `pages`, `mimeType`,
  `originMimeType`, `filename`, `contentHash` and `content`. The `filename` that `saveVoucher` and
  `saveInvoice` take is declared `type: string, format: binary`, as if it were file content.
- **Actual behavior:** The upload is `multipart/form-data` with one part `file`. Recorded
  2026-11-08: the answer, wrapped in `objects` (D-001), has the six declared keys plus an
  undeclared `isEInvoice`. `filename` is a plain string token (32 hex characters and the file's
  extension, like the spec's `f019bec36c65f5a0e7d2c63cc33f0681.pdf`), and `saveVoucher` takes that
  string (D-026). For a PDF, `mimeType` is `image/jpg` (the preview's) and `originMimeType`
  `application/pdf`; `content` is a list of one base64 JPEG preview of 110,000 to 116,000
  characters even for a PDF of 1.5 KB (a 70-byte PNG: 96 characters). `isEInvoice` is `false` for
  a plain PDF or PNG and `true` for a Factur-X PDF; when that file is saved as a voucher, nothing
  of its XML is taken over (supplier, sums and dates stay as sent, and the voucher has no
  e-invoice key). Plain text is refused with 415 "File type not supported".
- **Sources:** spec; [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2)
  (preview size); recorded 2026-11-08, trial account, Update 2.0 (probes
  `write-voucher-upload-temp-file`, `write-voucher-zugferd-upload`, in both write runs).
- **Impact:** `uploadForm` (`src/domain/drafts/voucher-payload.ts`) sends one multipart part
  `file`; `filename` is modeled as a string token. `readUploadAnswer` keeps only the token, the
  page count and `isEInvoice`; the preview is never parsed and never reaches the model (B6). A
  receipt must be a PDF, PNG or JPEG, checked by content before the upload (`RECEIPT_FILE_KINDS`
  in `src/domain/drafts/voucher-checks.ts`), so the 415 is not reached; XML goes only through the
  e-invoice import, which reads the XML itself. When sevDesk flags an upload as an e-invoice, the
  create tool points to `sevdesk_voucher_import_einvoice`.
- **Test:** `test/unit/domain/vouchers-write.test.ts` ("builds one multipart part `file` with the
  sniffed MIME type", "keeps the token and page count, never the preview content"),
  `test/regressions/b5-voucher-filename.test.ts` (the multipart part on the wire),
  `test/regressions/b6-upload-preview-stripped.test.ts`,
  `test/unit/tools/vouchers/create-draft.test.ts` ("hints at the e-invoice import when sevDesk
  recognizes the file as an e-invoice"), `test/unit/tools/vouchers/update-draft.test.ts` ("refuses
  an XML file as a receipt (only the e-invoice import takes XML)"). Live: probes
  `write-voucher-upload-temp-file`, `write-voucher-zugferd-upload`.

### D-012: Export endpoints return raw CSV or ZIP with `download=true`

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** The `/Export/*` endpoints declare only an `application/json` response
  (`{objects: {filename, mimetype, base64Encoded, content}}`, described as "Successful operation
  without download") although they take a `download` parameter. `/Export/datevCSV` is
  `deprecated` and declares a bare `object`.
- **Actual behavior:** With `download=true` the body is the raw CSV or ZIP file, not JSON.
  Recorded 2026-11-08 for `invoiceCsv`, `voucherListCsv`, `transactionsCsv` and `contactListCsv`:
  `Content-Type: text/csv; charset=UTF-8`, UTF-8 with a byte order mark, `;` as separator, a
  quoted German header row and LF line ends; the headers have 15, 14, 6 and 38 columns, counting
  unnamed ones at the end (each line ends with a separator). Without `download`, `invoiceCsv`
  answers the declared JSON with `mimetype` `text/csv` and `base64Encoded` `true`. `creditNoteCsv`
  was not probed. The `sevQuery[filter][startDate|endDate]` date filters take **Unix seconds**
  although the spec says date-time: filtered to one day, `invoiceCsv` returned exactly that day's
  7 of 88 invoices with Unix seconds, and 0 rows with ISO date-time or `dd.mm.yyyy`. The DATEV
  export is a job with a download link instead (D-077, D-102). The ZIP exports `invoiceZip` and
  `voucherZip` behave alike with `download=true` (a raw ZIP; its media type
  `application/zip; charset=UTF-8'` has a stray apostrophe), but their JSON form answers
  `content: null`, never the file (recorded 2026-11-16, D-101).
- **Sources:** spec; [peerigon/sevdesk README](https://github.com/peerigon/sevdesk#readme);
  recorded 2026-11-08, trial account, Update 2.0 (probes `read-export-csv`, two runs, and
  `read-export-csv-date-filter`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-export-invoice-zip`, `write-export-voucher-zip`).
- **Impact:** `client.download` (`src/sevdesk/client.ts`) returns the raw body with its
  `Content-Type` instead of parsing JSON, so the caller decides by the type, not by the endpoint.
  `sevdesk_csv_export` (`exportCsv` in `src/domain/exports/csv.ts`) asks for `download=true`,
  writes the bytes unchanged (byte order mark included) to `SEVDESK_OUTPUT_DIR` and returns only
  the file's size and row count; a JSON answer is decoded from its base64 `content` instead. The
  bytes never go through the model.
- **Test:** `test/unit/sevdesk/client.test.ts` ("download": raw bytes and their content type),
  `test/unit/domain/exports/csv.test.ts` ("keeps the bytes as sent and counts the data rows": a
  sample in the recorded format; "decodes the JSON form with base64 content"),
  `test/unit/tools/reports/export-tools.test.ts` ("saves sevDesk's CSV as it is and reports size
  and rows, never the content"), `test/unit/domain/exports/csv.test.ts` ("the date filter": "is
  sent as Unix seconds (verified for invoiceCsv) …"; "checkCsvPeriod": the downloaded rows are
  checked against the period). Live: probes `read-export-csv`, `read-export-csv-date-filter`.

### D-013: Invoice `bookAmount` response has copy-paste errors

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `PUT /Invoice/{invoiceId}/bookAmount` response (an `InvoiceLog`) has a
  property `creditNote` whose description says "The id of the invoice", a property
  `ammountPayed` (sic), and a `create` field described as "Date of email creation".
- **Actual behavior:** The invoice answer is an `InvoiceLog` wrapped in `objects` (D-001) with
  the keys `id`, `objectName`, `additionalInformation`, `create`, `invoice` (an `{id, objectName}`
  reference, not `creditNote`), `fromStatus`, `toStatus`, `ammountPayed` (sic, as a string such as
  `"50"`), `bookingDate` and `sevClient`. The credit note answer is a `CreditNoteLog` with the same
  keys and `creditNote` instead of `invoice`; its `ammountPayed` carries the sign that was sent
  (`"-119"`). `fromStatus`/`toStatus` show the status change (200 → 750 → 1000 for a partial and a
  final payment). `bookingDate` is 12:00 Berlin for a Unix timestamp of 12:00 and 00:00 Berlin for
  `dd.mm.yyyy` (D-056). The voucher's answer is a `VoucherLog` with `id`, `objectName`,
  `additionalInformation`, `create`, `voucher`, `fromStatus`, `toStatus`, `amountPayed` (one m),
  `bookingDate` and `sevClient` (recorded by another project and by us, 2026-11-08); unlike the
  credit note's, its `amountPayed` is unsigned (`"10"` for a booking of −10, `"119"` for −119 and
  for +119).
- **Sources:** spec (`bookInvoice`, `bookCreditNote`, `bookVoucher`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  `tests/fixtures/write_voucher_book_amount.json` (recorded `PUT /Voucher/{id}/bookAmount`);
  recorded 2026-11-07, trial account, Update 2.0 (probes `write-book-amount`,
  `write-credit-note-payout-sign`); recorded 2026-11-08 (probe `write-voucher-book-amount`).
- **Impact:** We do not model this response. The booking tools
  (`src/tools/lifecycle/book-payment.ts`, and `sevdesk_transaction_book` through
  `src/domain/reconciliation/allocate.ts`) ignore the answer apart from the envelope and read the
  invoice, credit note or voucher back (`paidAmount`, `status`) instead of trusting the log entry,
  so the misnamed keys and the voucher's unsigned amount do not matter.
- **Test:** `test/unit/tools/lifecycle/book-payment.test.ts` ("books the full open amount linked
  to the bank transaction and reads the invoice back"),
  `test/regressions/b7-payment-linking.test.ts`,
  `test/unit/tools/lifecycle/voucher-lifecycle.test.ts`; fixtures
  `test/fixtures/lifecycle/invoice-book-amount.json` (the recorded `InvoiceLog` keys, values
  fake), `credit-note-book-amount.json` (still built from the community `VoucherLog`, so it spells
  `amountPayed` where the recorded `CreditNoteLog` has `ammountPayed`; harmless while the answer is
  ignored) and `test/fixtures/vouchers/voucher-book-amount.json` (the spec's `VoucherLog`, the
  recorded keys without `additionalInformation`). The real answers: probes `write-book-amount`,
  `write-credit-note-payout-sign`, `write-voucher-book-amount`.

### D-014: `accountIntervall` example is a date

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `Model_InvoiceResponse.accountIntervall` is described as "The interval in which
  recurring invoices are due as ISO-8601 duration", but its example is `'2022-03-14'`.
  `accountNextInvoice` is a `string` in the response model and an `integer` in the request model.
- **Actual behavior:** Recorded 2026-11-16: sevDesk stores `accountIntervall` as any string sent
  (`P0Y1M0W`, `P1M`, but also `monthly`) and returns it unchanged. `accountNextInvoice` reads
  back as an ISO date-time (`2026-11-15T00:00:00+01:00`), set from `accountStartDate`; sent on its
  own it is ignored (D-111).
- **Sources:** spec; recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-recurring-interval-formats`, `write-recurring-schedule-fields`;
  `test/fixtures/recorded/2026-11-16/invoices/recurring-templates.json`).
- **Impact:** The invoice tools show `accountIntervall` as text, exactly as sevDesk sent it, and do
  not parse it. `accountNextInvoice` is read as a date given as Unix seconds (number or string), ISO
  8601 or `dd.mm.yyyy`; any other value fails the call instead of being dropped.
- **Test:** `test/unit/domain/invoices.test.ts` ("maps the schedule of a recurring invoice (WKR)
  as sevDesk sent it"), `test/contract/recorded-gaps-documents.test.ts` ("reads through the
  invoice parser: interval as sent, next run as a Berlin date").

### D-015: Invoice type filters use `Re` instead of `RE`

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `invoiceType` filter enums of `/Export/invoiceCsv`, `/Export/invoiceZip` and
  `/Report/invoicelist` contain `Re`, while their own descriptions and `Model_Invoice.invoiceType`
  use `RE`.
- **Actual behavior:** Invoice types are upper case (`RE`). `GET /Invoice` honors the upper-case
  `invoiceType` filter: of 39 invoices, `invoiceType=RE` returned the 38 RE rows and
  `invoiceType=SR` the one cancellation invoice (recorded). jernoxit/sevdesk-rs had left the filter
  out as unmeasured (see also D-035). The export and report filters with `Re` are not measured.
- **Sources:** spec; [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs);
  recorded 2026-11-07, trial account, Update 2.0 (probes `read-invoice-filters`,
  `write-cancel-invoice`).
- **Impact:** `sevdesk_invoices_list` sends upper-case codes (`RE`, `AR`, `SR`, …) and checks the
  type of every returned row again, so an ignored filter cannot return other invoice types. Like
  the number re-check (D-035), this switches the list to a local scan (`filteredLocally`, no
  total). The re-check stays although the filter works: it costs nothing on a correct answer.
  The order list (`orderType`) and the voucher list (`voucherType`) re-check their types the same
  way.
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
  dates equal, so it does not settle the question; so do all eight transactions of our recording
  (created by bookings, D-071, and one cash entry). A transaction created through
  `POST /CheckAccountTransaction` with a `valueDate` three days before its `entryDate` reads both
  back as sent (recorded 2026-11-08); that does not tell which description is right either. A
  row created without an `entryDate` key, or with `entryDate: null`, gets the value day as its
  `entryDate` (12:00, like the `valueDate` sent), not the day it was created (recorded
  2026-11-18). On the trial's 55 existing rows `entryDate` was the same instant as `valueDate`
  on 54 (20 on CSV file-import accounts, 29 on the clearing account, 5 on the cash register) and
  later on one CSV row; the trial has no bank-connected account. The list filters
  `startDate`/`endDate` compare `entryDate` (D-047). The response model also has status 350
  (D-031).
- **Sources:** spec;
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (2026-02-19);
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-transaction-date-filters`:
  inconclusive); recorded 2026-11-08 (probe `write-transaction-create`); recorded 2026-11-18,
  trial account, Update 2.0 (probes `write-transaction-entry-date`, `read-transaction-entry-dates`).
  Settling which description is right needs imported bank transactions with different dates
  (open: real account).
- **Impact:** The transaction DTO keeps both dates and describes each one. `valueDate` is treated
  as the transaction's date because the request model requires it, and date ranges apply to it by
  default. `entryDate` is an optional second date (the import date per the request model); a range
  applies to it with `dateField: "entry"` (D-047). `sevdesk_transaction_create` sends both dates
  (the same noon), so it does not depend on the default.
- **Test:** `test/unit/tools/banking/transactions.test.ts` (both dates, `entryDate` missing).
  Live: probes `write-transaction-entry-date` (observed 2026-11-18: the value day) and
  `read-transaction-entry-dates` (observed 2026-11-18: no imported rows on the trial;
  `test/unit/scripts/gaps-banking-probes.test.ts`, #136).

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

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** Fields such as `voucherDate`, `deliveryDate` and `invoiceDate` are
  `type: string, format: date-time`, with the description "Needs to be provided as timestamp or
  dd.mm.yyyy" and examples like `01.01.2022`, which are not RFC 3339 date-times.
- **Actual behavior:** Document writes take a Unix timestamp or `dd.mm.yyyy` (recorded: drafts
  with `invoiceDate` `07.11.2026` and `deliveryDate` in Unix seconds; `bookAmount` with either,
  D-056). Filters and exports take Unix timestamps; the `startDate` of `GET /Invoice` also took
  `dd.mm.yyyy` (recorded, D-046). Responses return ISO 8601 date-times.
- **Sources:** spec; recorded 2026-11-07, trial account, Update 2.0 (probes `write-book-amount`,
  `read-document-date-strictness`).
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

- **Status:** Partly fixed upstream. **Evidence:** spec + API news + recorded.
- **Spec says:** The overview now says `limit` must be between 1 and 1000 and documents `offset`
  and `countAll`. But `limit`/`offset` are declared on only three operations
  (`Invoice/{invoiceId}/getPositions`, `Order/{orderId}/getPositions`,
  `Order/{orderId}/getDiscounts`), and `countAll` and `embed` on none. The default of 100 appears
  only in passing in an overview example.
- **Actual behavior:** The API news announced that from 2025-05-30 a `limit` outside 1–1000
  returns 400. Measured on 2026-11-07, it does not: `GET /Contact?depth=1&limit=1001` and
  `…&limit=0` were both answered 2xx with contact rows. So the documented range is not enforced,
  and nothing says what `limit=0` means. `GET /ReceiptGuidance/forAllAccounts` ignores `limit`
  altogether (D-065). An omitted `limit` reportedly returns at most 100 records; the trial account
  had too few contacts (8) to show the cut.
- **Sources:**
  [API news 2025-03-11, "new API pagination limits"](https://tech.sevdesk.com/api_news/posts/2025_03_11-api_pagination_limits/);
  [j-mastr/sevdesk-api#21](https://github.com/j-mastr/sevdesk-api/pull/21); recorded 2026-11-07,
  trial account, Update 2.0 (probe `read-limit-range`: contradicted, in three runs).
- **Impact:** The client always sends an explicit `limit` (1–1000) and pages until an empty page;
  it refuses other values itself instead of relying on a 400 that does not come. Tools that
  truncate say how many records they left out.
- **Test:** `test/regressions/limit-truncation.test.ts`. The 100-row default: pending: recording
  session, probe `read-limit-range` (needs more than 100 contacts).

### D-020: List filters behave differently from their declared types

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `GET /Contact` declares `depth` as a string enum `'0'`/`'1'` ("'0' -> only
  organizations") without a default. Boolean filters such as `isBooked`, `onlyCredit` and
  `onlyDebit` on `GET /CheckAccountTransaction` are `type: boolean`; `isBooked` is "Only retrieve
  booked transactions".
- **Actual behavior:** Without `depth=1`, `GET /Contact` returns organisations only. Boolean query
  parameters must be sent as `1`/`0`; a literal `false` is ignored. `isBooked=true` returns only
  booked transactions, but `isBooked=false` is ignored and returns everything. A `status` filter,
  which the spec does not declare for `GET /CheckAccountTransaction`, works: `status=100` returns
  only transactions in that status. Recorded: on eight booked (400) transactions, `isBooked=1`,
  `isBooked=0` and `isBooked=false` all returned the eight (so `0` and `false` do not select
  unbooked rows), and `status=400` returned only rows with that status; on 2026-11-08 `status=100`
  returned only the 3 rows at 100 of 28. The `depth` default could not be checked at first (the
  trial account had no person contact); the name search below shows it leaves persons out. The
  `name` filter of `GET /Contact` is a case-insensitive search
  for a part of the shown name (recorded 2026-11-18): an organisation is found by its full name,
  in lower and upper case and by a middle part, also without `depth`; a person by its
  familyname, in lower case, by a middle part of it, by the shown name "first last" and by its
  first name alone, but by its familyname only with `depth=1` (without it, persons are left out).
- **Sources:** [genz-its/sevdesk](https://github.com/genz-its/sevdesk) docs and
  [`CLAUDE.md`](https://github.com/genz-its/sevdesk/blob/main/CLAUDE.md);
  [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs)
  (measured); recorded 2026-11-07, trial account, Update 2.0 (probes
  `read-transaction-boolean-filters`, `read-transaction-status-filter`; `read-contact-depth`
  inconclusive); recorded 2026-11-08 (probe `read-transaction-status-filter`); recorded
  2026-11-18, trial account, Update 2.0 (probe `write-contact-name-search`).
- **Impact:** The client serializes booleans as `1`/`0` and always sends `depth=1` for contact
  lists, so `sevdesk_contacts_search` `query` and the contact name suggestions of the prompts
  find persons too, by any part of the name, in any letter case. The suggestions answer a typed
  name from a complete search for its beginning, without a new request. `sevdesk_transactions_list`
  never sends `isBooked`. With exactly one status (for example
  `created`) it sends `status=<code>` to narrow the read; several statuses cannot go into one
  filter and are not sent. Either way it checks every row's status itself, so a server that
  ignores the filter changes nothing, and its output says that it filtered locally.
- **Test:** `test/unit/tools/contacts/search.test.ts` (`depth=1`),
  `test/unit/prompts/completions.test.ts` ("contact searches reused for a longer typed name"),
  `test/regressions/b16-zero-values.test.ts` (booleans as `1`/`0`),
  `test/unit/tools/banking/transactions.test.ts` ("filters unbooked (created) transactions locally
  and counts sevDesk rows, not matches", "combines several statuses and a direction"). Live:
  probe `read-contact-depth` (inconclusive on 2026-11-07: no person contact in the account), and
  `write-contact-name-search` for the name search and `depth` (observed 2026-11-18;
  `test/unit/scripts/gaps-contacts-probes.test.ts`).

### D-021: Validation errors can come back as 500

- **Status:** Open. **Evidence:** spec + API news + community + recorded.
- **Spec says:** Only 16 responses declare `422`. Not-found GETs declare `400` ("Bad request.
  Invoice was not found"); no operation declares `404`.
- **Actual behavior:** Other integrators report validation failures that come back as 500 instead
  of 422. The status codes depend on the endpoint; recorded on 2026-11-07:
  - 404 for GET by an unknown id (`/Contact`, `/Invoice`): "No Model_Contact with the id … was
    found". Not 400, and not an empty array (D-001).
  - 422 for field validation in the save factories: `saveInvoice` with an unknown type ("Invalid
    invoiceType. Must be one of: RE, AR, TR, ER, MA, SR, WKR."), `saveCreditNote` without
    `deliveryDate` ("Must set deliveryDate", D-051), and `sendBy` with a tax rule the account's
    regime does not allow (D-067).
  - 400 "Bad Request" without details for `saveOrder` without `orderNumber` (D-027); 400 with a
    message for `getXml` on an invoice that is not an e-invoice (D-033) and for refused e-mails
    (D-069).
  - 500 with a raw PHP `TypeError` for `sendBy` on a credit note without a number. The write was
    not refused: the credit note was finalized anyway (D-068). Also 500 for the filter value
    `creditNote[objectName]=creditNote` (D-040).
- **Sources:**
  [API news 2024-04-08, "Changing some 500 HTTP status codes to 422"](https://tech.sevdesk.com/api_news/posts/2024_04_08-changes_http_error_codes/);
  [n8n community: create an invoice with sevDesk](https://community.n8n.io/t/create-an-invoice-with-sevdesk/46146);
  recorded 2026-11-07, trial account, Update 2.0 (probes `read-unknown-id`,
  `write-validation-status`, `write-credit-note-without-delivery-date`,
  `write-numbering-order-draft`, `write-numbering-credit-note`, `read-getxml-shapes`,
  `read-credit-note-pos-objectname`, `write-send-email-shape`).
- **Impact:** `src/sevdesk/errors.ts` maps 404 (and a 400 "… not found") to `not_found`, other 4xx
  to `validation`, and a 500 whose body looks like a validation message (the `TypeError` above
  included) to `validation` with an actionable message. A 500 on a write is never retried. Because
  a 500 can come after sevDesk already changed the record, the credit note finalize and send-email
  tools refuse a draft without a number before sending (`src/domain/lifecycle/transitions.ts`; fix
  in this PR, D-068).
- **Test:** `test/unit/sevdesk/errors.test.ts` (500s that read like validation are `validation`).

### D-022: Rate limiting is undocumented

- **Status:** Open. **Evidence:** community (secondary).
- **Spec says:** No `429` response and no `Retry-After` header anywhere.
- **Actual behavior:** Integrators report 429 responses under load. No limit is published.
- **Sources:**
  [nordflux.de: Connecting Lexoffice, sevDesk, or DATEV](https://nordflux.de/en/insights/connecting-lexoffice-sevdesk-or-datev-which-interface-carries-your-automation);
  [Chift rate-limit docs](https://docs.chift.eu/developer-guide/core-concepts/rate-limits)
  (a unified-API vendor that retries connector 429s). Not measured on 2026-11-07: the opt-in
  probe `read-rate-limit-burst` was not run (pending: recording session).
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

  Recorded on Update 2.0 (2026-11-07): `getPdf` with `preventSendBy=true` left a fresh invoice
  draft and a fresh credit note draft at status 100 with no `sendDate`, no send type and an
  unchanged `update`, and left a finalized invoice and credit note unchanged. Order drafts could
  not be checked, since `saveOrder` refuses a draft without a number (D-027); the PDF of a
  finalized offer was recorded with `preventSendBy=true`. `download=true` switches `getPdf` to a
  raw `application/pdf` body without changing the document. On the trial account, every invoice
  and credit note finalized with `sendBy` carried an `enshrined` timestamp within seconds, so
  automatic enshrining was on there; orders have no `enshrined` field.

  The DATEV export job is not a GET at all (recorded 2026-11-08): a GET of
  `/Export/createDatevCsvZipExportJob` is refused with 500 "Function createDatevCsvZipExportJob
  was called with wrong HTTP Type", and the job starts with a POST carrying the same query (D-077).
  Started without `enshrineDocuments`, it left an invoice and a voucher of the exported period
  unchanged. The XML job (POST as well; it has no enshrine flag) changed no invoice and no
  voucher of the account either (recorded 2026-11-16, D-102). The deprecated `/Export/datevCSV`
  was not probed.

  The ZIP exports `GET /Export/invoiceZip` and `/Export/voucherZip` render every document they
  export, drafts included, but changed nothing: a draft invoice kept its status, `sendDate`,
  `sendType` and `update`, and no invoice or voucher of the account changed any key (recorded
  2026-11-16, D-101). They are not like `getPdf` without `preventSendBy`.

- **Sources:** spec; [joosthel/sevdesk-mcp v0.5.0](https://github.com/joosthel/sevdesk-mcp/releases/tag/v0.5.0)
  changelog; [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README and
  `src/endpoints/invoice.rs`, measured 2026-11-05);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md);
  recorded 2026-11-07, trial account, Update 2.0 (probes `write-getpdf-preview-drafts`,
  `read-getpdf-preview-finalized`, `read-getpdf-download`; `enshrined` in the recorded invoice and
  credit note lists); recorded 2026-11-08 (probe `write-export-datev-csv`, first write run and the
  DATEV run); recorded 2026-11-16, trial account, Update 2.0 (probes `write-export-invoice-zip`,
  `write-export-voucher-zip`, `write-export-datev-xml`).
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
  that an invoice or credit note is also enshrined if the account enshrines on completion. The
  DATEV export (`startDatevExportJob` in `src/domain/exports/datev.ts`) sends the job start as a
  POST, a `write` that is never retried, with a query built from a fixed key list that never holds
  `enshrineDocuments`. The client still treats the spec's GET form as a side effect
  (`EXPORT_JOB_ENDPOINTS` in `src/sevdesk/paths.ts`) and any `enshrine`/`enshrineDocuments` flag as
  `commit`, so neither form can pass as a read.

  The generic read `sevdesk_api_get` (advanced toolset, off by default) lets the model choose the
  path, so it adds a stricter list (`genericGetRefusal` in `src/sevdesk/paths.ts`) that refuses
  before anything is sent: `getPdf`, `getXml`, `render`, `sendByWithRender`, every endpoint of the
  tier table (`sendBy`, `bookAmount`, `enshrine`, …) and every next-number endpoint (also when it
  would only peek) anywhere in the path; everything under `Export`, `ExportJob`, `Progress`,
  `Report`, `DocServer` and `SevSequence`; a segment after the first that starts with a verb that
  changes data (`save…`, `create…`, `book…`, `send…`); and the query keys `preventSendBy`,
  `enshrine…`, `useNextNumber`, `download`, credentials (`token`, …) and HTTP method overrides,
  compared the way PHP reads keys (case-insensitive, `.` as `_`, the name before `[`). The request
  then still goes through `readOnlyClient` and the HTTP client, which refuse any side effect
  `resolveGetSafety` finds. Since sevDesk's routing of extra trailing segments is unknown,
  `resolveGetSafety` also treats `getPdf`, `sendByWithRender`, an export job or a next-number
  endpoint before the last segment (`/Invoice/1/getPdf/2`) as that endpoint's side effect, and
  `minimumWriteTier` takes the highest tier of every segment.

- **Test:** `test/regressions/api-get-side-effects.test.ts` (`sevdesk_api_get`: refused paths and
  query keys make zero `fetch` calls with every tier enabled; with the refusal list bypassed the
  read-only guard blocks, and with both bypassed the HTTP client does),
  `test/unit/sevdesk/paths.test.ts` (`genericGetRefusal`; "endpoint names before the last
  segment"), `test/regressions/getpdf-side-effect-blocked.test.ts` (flagged and unflagged
  side-effect GETs), `test/regressions/b1-getpdf-prevent-send.test.ts` (PDF tools and resources
  through the real client in read-only mode: one GET with `preventSendBy=true`, no `download`),
  `test/unit/sevdesk/client.test.ts` ("state-changing GET endpoints"),
  `test/unit/sevdesk/paths.test.ts` (`resolveGetSafety`: the literal `true` for every accepted
  spelling), `test/unit/tools/documents/file-tools.test.ts`,
  `test/unit/tools/lifecycle/finalize.test.ts` ("warns that the invoice becomes binding and may
  be enshrined automatically"), `test/contract/recorded-fixtures.test.ts` ("fetches the %s from
  the recorded answer", for each kind; "D-023, D-059: finalizing enshrined invoices and credit
  notes on the trial account…"). DATEV job: `test/unit/domain/exports/datev.test.ts` ("starts the
  job with a POST and the query, and reads the id", "builds the scope in the spec's order and
  never sends enshrineDocuments"), `test/unit/sevdesk/paths.test.ts` ("treats the DATEV export job
  %s as a side effect", "treats DATEV exports with an enshrine flag as commit"),
  `test/unit/sevdesk/client.test.ts` ("treats starting a DATEV export job with %j as a write (it
  starts a job)", "never retries a DATEV export job (a retry would start a second job)"). Order
  drafts on Update 2.0: pending: recording session, probe `write-getpdf-preview-drafts` (no order
  draft without a number, D-027).

### D-024: Undocumented endpoints we rely on

- **Status:** Open. **Evidence:** community + recorded.
- **Spec says:** None of these endpoints appear in the spec.
- **Actual behavior:** They exist and other integrations use them. "Recorded" means our recording
  sessions read or measured the endpoint on a trial account (2026-11-07, -08 or -10); "known"
  means community SDKs use it routinely; "uncertain" means we found only isolated uses.

  | Endpoint                                                                               | Used for                                                                                                           | Standing |
  | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
  | `GET /SevUser`                                                                         | `contactPerson`, required on invoices, orders and credit notes                                                     | recorded |
  | `GET /StaticCountry`                                                                   | country ids for addresses                                                                                          | recorded |
  | `GET /PaymentMethod`                                                                   | payment method ids                                                                                                 | recorded |
  | `GET /Unity`                                                                           | units for positions                                                                                                | recorded |
  | `GET /AccountDatev`                                                                    | booking accounts (Update 2.0): names and kinds for previews (D-079)                                                | recorded |
  | `GET /Category`                                                                        | categories                                                                                                         | recorded |
  | `GET /TaxRule`                                                                         | tax rule ids and codes (D-006)                                                                                     | recorded |
  | `GET /SevClient`                                                                       | the account's taxation regime, chart of accounts, company data and DATEV settings (D-067)                          | recorded |
  | `GET /Order/Factory/getNextOrderNumber`, `/CreditNote/Factory/getNextCreditNoteNumber` | the next order and credit note numbers (D-066)                                                                     | recorded |
  | `GET /CheckAccountTransactionLog`                                                      | what a bank transaction was booked against, and how much (D-057)                                                   | recorded |
  | `DELETE /Invoice/{invoiceId}`                                                          | deleting draft invoices (`sevdesk_document_delete_draft`; D-109)                                                   | recorded |
  | `DELETE /Voucher/{voucherId}`                                                          | deleting draft vouchers (the spec has only GET and PUT; D-074)                                                     | recorded |
  | `GET`, `POST /CostCentre`, `GET`, `DELETE /CostCentre/{costCentreId}`                  | cost centres of documents (D-091)                                                                                  | recorded |
  | `DELETE /TagRelation/{tagRelationId}`                                                  | removing one tag from one document (D-089)                                                                         | recorded |
  | `GET /TextTemplate`                                                                    | head and foot texts of drafts by name and the `text_templates` lookup (D-115); also through `sevdesk_api_get`      | recorded |
  | `POST /Order/{orderId}/render`, `POST /CreditNote/{creditNoteId}/render`               | reading the layout of an order or credit note with `{forceReload: false}` (D-113)                                  | recorded |
  | `GET /PartUnity`                                                                       | alternative units of parts, with their own price and factor (`sevdesk_api_get`)                                    | known    |
  | `GET /Document`, document download                                                     | attached documents and receipts (metadata through `sevdesk_api_get`, files through `sevdesk_voucher_receipt_save`) | recorded |
  | `GET /SevSequence/Factory/getByType`                                                   | next document number (see D-027); `sevdesk_api_get` refuses it                                                     | known    |
  | `POST /Voucher/Factory/createVoucherFromFile`                                          | voucher draft from a file, filled in by sevDesk's recognition (D-103; `sevdesk_voucher_recognize_receipt`)         | recorded |

  Recorded shapes: `GET /AccountDatev` rows have 28 keys (`number`, `name`, `accountDatevCategory`,
  `accountCategory`, …), scalars as strings, and GET by id answers one row; the list ignores every
  filter (D-079). `DELETE` on a draft invoice answers 2xx, after which GET answers 404;
  `DELETE /Voucher/{voucherId}` on a draft answers `{objects: [null]}` and then 404 too, and
  refuses an open voucher with 409 (D-074). The 2026 PDF post (D-025) also names `render`,
  `changeParameter` and `sendByWithRender` endpoints for orders, credit notes and letters that the
  spec does not list.

  Recorded 2026-11-10 (probes `read-text-template`, `read-document`): `GET /TextTemplate` answers
  every row whatever `limit` and `offset` say (9 rows for `limit=2`), with `total`; its rows carry
  `additionalInformation` and no `sevUser`, and the `textType` filter is honoured. `GET /Document`
  honours `limit` and `offset` and has the community model's keys; `GET /Document/{id}` adds none
  and no field holds file content. `GET /PartUnity` answered an empty list (no alternative units
  on the trial), so its shape stays "known". `GET /Voucher/{voucherId}` names the attached receipt
  as `document: {id, objectName: "Document"}` (`null` without one), and
  `GET /Document/{documentId}/download` answers the `getPdf` envelope (`filename` a hash such as
  `a9e6….pdf`, `mimetype: null`, `base64Encoded: true`, `content`); the uploaded 1,503-byte PDF came
  back byte for byte. `/Document/{id}/getContent` and `/Voucher/{id}/getDocument` answer 404.

  Recorded 2026-11-16 (probes `write-voucher-from-file`, `write-receipt-hash`,
  `read-document-hash`): `createVoucherFromFile` takes a multipart body (`creditDebit`, file part
  `voucher`) and answers a draft voucher that sevDesk's recognition fills in seconds later
  (D-103). A Document's `contentHash` is the SHA-256 of the uploaded receipt, and null for PDFs
  sevDesk renders; the receipt of a draft voucher is readable by id but not listed by
  `GET /Document`, and goes when the draft is deleted (D-100).

  Community model (j-mastr/sevdesk-api, not recorded by us): `GET /TextTemplate` rows carry
  `name`, `text`, `category` (`DOCUMENT`, `LETTER`, `MAIL`), `objectType` (`RE`, `AN`, `AB`, `LI`,
  `CN`, `MA`, `PAYMENT_CONFIRMATION`, `ALL`), `textType` (`HEAD`, `FOOT`, `SUBJECT`, `TEXT`,
  `SIGNATURE`), `main` and a `sevUser`, filterable by those three enums. `GET /PartUnity` holds a
  part's alternative units (`part`, `unity`, `factor`, `price`), filterable by `part[id]`. The
  rows of `GET /Document` describe files in the document archive (`filename`, `extension`,
  `mimeType`, `filesize`, `contentHash`, `folder`, `baseObject`, `object`), without the file
  content. All three take `limit`, `offset`, `countAll` and `embed`.

  Recorded 2026-11-16 (probes `read-cost-centre-list`, `write-cost-centre-create`,
  `write-cost-centre-delete`, `write-tag-relation-remove`): `/CostCentre` answers GET (list with
  `total`; by id one row), POST and DELETE (D-091);
  `DELETE /TagRelation/{tagRelationId}` removes one tag from one document (D-089). The spec has
  `GET /TagRelation`, but no way to remove a relation.

- **Sources:** [genz-its/sevdesk](https://github.com/genz-its/sevdesk),
  [exlo89/laravel-sevdesk-api](https://github.com/exlo89/laravel-sevdesk-api),
  [lippoliv/paperlessngx-to-sevdesk](https://github.com/lippoliv/paperlessngx-to-sevdesk)
  (`createVoucherFromFile`); [j-mastr/sevdesk-api](https://github.com/j-mastr/sevdesk-api)
  `openapi.yaml` v1.10.0 (`/TextTemplate`, `/PartUnity`, `/Document` and their response models,
  read 2026-11-09); recorded 2026-11-07, trial account, Update 2.0 (the reads in
  `test/fixtures/recorded/2026-11-07/meta/`; probes `read-account-datev`,
  `write-delete-draft-invoice`, `write-next-order-number`; `GET /SevClient` and the credit note
  numbers: manual check (lead)); recorded 2026-11-08, trial account, Update 2.0 (probes
  `read-account-datev-paging`, `read-sevclient-keys`, `read-transaction-log`,
  `write-voucher-delete`); recorded 2026-11-10, trial account, Update 2.0 (probes
  `read-text-template`, `read-part-unity`, `read-document`; `pnpm fixtures:record`); recorded
  2026-11-16, trial account, Update 2.0 (probes `read-cost-centre-list`, `write-cost-centre-create`,
  `write-cost-centre-delete`, `write-tag-relation-remove`, `write-voucher-from-file`,
  `write-receipt-hash`, `read-document-hash`).
- **Impact:** Each undocumented endpoint gets a hand-written schema, a smoke test, and lives in
  the `advanced` toolset or behind a lookup until a recording confirms its shape. `uncertain`
  endpoints are not used by default tools: receipts go through `uploadTempFile` and `saveVoucher`
  (D-011, D-026); the recorded `createVoucherFromFile` is used only by
  `sevdesk_voucher_recognize_receipt` (D-103). `GET /TextTemplate`,
  `/PartUnity` and `/Document`
  have no curated tool; the generic read `sevdesk_api_get` (advanced toolset, off by default)
  reads them without a schema of its own: it returns the raw `objects` sanitized as untrusted
  text, drops binary fields and `sevClient` echoes, and always sends `limit`, `offset` and
  `countAll`. It refuses `/SevSequence` and the next-number endpoints, which may reserve a number
  (D-066).
- **Test:** `test/unit/tools/meta/reference-lookup.test.ts`,
  `test/unit/tools/meta/account-info.test.ts` (`/SevUser`, `/StaticCountry`, `/Unity`,
  `/PaymentMethod`), `test/regressions/b3-contact-person.test.ts` (`/SevUser` for the contact
  person of drafts), `test/contract/recorded-fixtures.test.ts` (the recorded reference lists
  through their readers, `/AccountDatev` included). `/AccountDatev`:
  `test/unit/domain/accounts-datev.test.ts` (D-079). `DELETE /Voucher/{voucherId}`:
  `test/unit/tools/vouchers/finalize-delete.test.ts` (D-074). Next-number endpoints,
  `/CheckAccountTransactionLog` and `/SevClient`: D-066, D-057, D-067. `GET /TextTemplate`,
  `/PartUnity`, `/Document`: `test/contract/undocumented-endpoints.test.ts` (the community
  fixtures in `test/fixtures/advanced/` through `apiGet` and through their probes, and the
  recorded answers in `test/fixtures/recorded/2026-11-10/advanced/` against them, the ignored
  `limit` included); the receipt download: `test/unit/tools/vouchers/receipt-save.test.ts`. `/SevSequence/Factory/getByType`: no tool uses it, and `sevdesk_api_get` refuses it
  (`test/unit/sevdesk/paths.test.ts`, `genericGetRefusal`). `/CostCentre` and
  `DELETE /TagRelation/{tagRelationId}`: D-091 and D-089. `createVoucherFromFile`:
  `test/unit/tools/vouchers/recognize-receipt.test.ts` (D-103).

### D-025: PDF rendering returns one base64 `pdf` since 2026-04-07

- **Status:** Partly fixed upstream. **Evidence:** spec + API news.
- **Spec says:** `POST /Invoice/{invoiceId}/render`, the `changeParameter` endpoints
  (`Model_ChangeLayoutResponse`) and `CreditNote/{creditNoteId}/sendByWithRender` now return
  `pdf` ("Base64-encoded PDF"); `thumbs` and `pages` are gone. This matches the change. But the
  responses are declared without the `objects` wrapper, and the `render`/`sendByWithRender`
  variants for orders, credit notes and letters are missing (D-024).
- **Actual behavior:** Since 2026-04-07 these endpoints return `{objects: {…, pdf: "<base64>"}}`.
  The `getAsPdf=true` opt-in from the transition period is ignored. `getPdf` was not part of the
  change: on 2026-11-07 it still answered `{objects: {filename, mimetype, base64Encoded,
content}}` for invoices, credit notes and orders (recorded; key casing: D-072). Recorded
  2026-11-16: `changeParameter` answers `{objects: {metaData: {docId, parameters, pdf}}}` on
  invoices and `{objects: {result, metaData}}` on orders and credit notes, not the spec's
  `metadaten`; `POST /Invoice/{id}/render` answers `{objects: {docId, pdf, parameters}}` (D-113).
- **Sources:**
  [API news 2026-02-19, "Breaking Changes Q1 2026"](https://tech.sevdesk.com/api_news/posts/2026_02_breaking_changes_q1_2026/);
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-getpdf-download`;
  `test/fixtures/recorded/2026-11-07/documents/*-pdf.json`); recorded 2026-11-16, trial account,
  Update 2.0 (probes `write-change-parameter-draft`, `write-change-parameter-read-back`).
- **Impact:** Render schemas expect `pdf` only. The PDF is written to a file or returned as a
  resource, never inlined as base64 text. `getPdf` is not among the changed endpoints, and the
  current spec still declares `content` for it: the PDF tools use `getPdf`, parse `content`, and
  reject a `pdf`-only body as `unexpected_response`.
- **Test:** `test/unit/domain/document-files.test.ts` (the render shape is rejected for `getPdf`),
  `test/contract/recorded-fixtures.test.ts` (the recorded `getPdf` answers through
  `fetchDocumentFile`). `render` and `changeParameter`: pending until a tool uses them (no M3 tool
  does; the #94 tools, D-113).

### D-026: `saveVoucher` key order and top-level `filename`

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** The `saveVoucher` description says "the order of the last two attributes always
  needs to be kept" (`voucherPosDelete`, then `filename`), and `uploadTempFile` says the file is
  attached only if all parameters are "in the right order". `filename` is a top-level property of
  `saveVoucher`.
- **Actual behavior:** `filename` must be top-level, next to `voucher`. Inside `voucher` it is
  dropped silently (D-003), and the voucher has no document. Recorded 2026-11-08: a draft saved
  with the upload token at the top level got its document both in the spec's key order and with
  `filename` as the first key, so the key order does not matter; the same token inside `voucher`
  gave a draft without a document (and without a `document` key, D-044).
- **Sources:** spec; [joosthel/sevdesk-mcp#2](https://github.com/joosthel/sevdesk-mcp/pull/2);
  recorded 2026-11-08, trial account, Update 2.0 (probe `write-voucher-save-with-file`).
- **Impact:** The `saveVoucher` builder (`saveVoucherBodySchema` in
  `src/domain/drafts/voucher-payload.ts`) emits the keys in the spec's order (`voucher`,
  `voucherPosSave`, `voucherPosDelete`, `filename`), which costs nothing although the order does
  not matter, and refuses a `filename` inside `voucher` as an internal error. After a write with a
  receipt, the read-back notes a missing or `null` `document` (D-044).
- **Test:** `test/regressions/b5-voucher-filename.test.ts` ("uploads the file as multipart, then
  saves with filename after voucherPosDelete"), `test/unit/domain/vouchers-write.test.ts` ("keeps
  the key order voucher, voucherPosSave, voucherPosDelete, filename", "refuses a filename inside
  voucher as an internal error"), `test/unit/tools/vouchers/create-draft.test.ts` ("attaches a
  receipt: uploads first, then sends filename at the top level, last (B5)"). Live: probe
  `write-voucher-save-with-file`.

### D-027: Document numbers are assigned on finalizing and can show placeholders

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** The Invoice and CreditNote tags say the number "is not an attribute that must be
  supplied when creating" the document, and point to `SevSequence/Factory/getByType` (not an
  operation of the spec, D-024) for the next number. `Model_Invoice.required` has no
  `invoiceNumber`, but `Model_creditNote.required` lists `creditNoteNumber` and
  `Model_Order.required` lists `orderNumber`. Nothing says when sevDesk assigns a number to a
  document saved without one, or what number formats look like.
- **Actual behavior:** Recorded on Update 2.0 (2026-11-07), the three document kinds behave
  differently:
  - Invoices: a `saveInvoice` draft without `invoiceNumber` is saved with `invoiceNumber: null`;
    `sendBy` finalizes it and assigns the next number of the range (`RE-1000` on a fresh account),
    as jernoxit/sevdesk-rs had measured. This is the only kind where leaving the number to sevDesk
    works.
  - Orders: `saveOrder` without `orderNumber` is refused with 400 "Bad Request" (as
    codestra/sevdesk-mcp reported), which also blocks `createInvoiceFromOrder` without an order.
    An offer saved with the number `getNextOrderNumber` peeks (`useNextNumber=false`) keeps that
    number, but neither saving nor finalizing advances the order counter: sevDesk handed out
    `AN-1000` twice. Only `useNextNumber=true` reserves a number (D-066), as the web app does.
  - Credit notes: a `saveCreditNote` draft without `creditNoteNumber` is accepted with no number.
    Finalizing it is unreliable (D-068): the first `sendBy` failed with HTTP 500 and still left
    the credit note finalized without a number; later ones assigned a number, the first of them
    one that a draft from `createFromInvoice` already held. A credit note saved with a number
    from `getNextCreditNoteNumber` finalizes normally, and finalizing it advanced the counter.
    `createFromInvoice` gives its draft a number itself (`GU-1000`) without advancing the
    counter.
  - Derived orders (recorded 2026-11-16): `createContractNoteFromOrder` and
    `createPackingListFromOrder` give the new `AB` or `LI` the number `getNextOrderNumber` peeks
    for its type without advancing the counter, so consecutive ones share a number (D-107).
    Saving or deleting a draft with a peeked number does not move the counter either; a draft
    that leaves status 100 through `PUT /Order/{id}` gets a new number (D-108). Recorded again on
    2026-11-18 for an `AB` and an `LI` made from a draft offer: each took the peeked number, the
    counter did not move, and deleting the copy left the counter where it was.
  - Placeholders: none of the 48 invoice, credit note and order numbers of the trial account
    contained `%…%`. In exlo89/laravel-sevdesk-api#16 an invoice got the number `RE-%YYYY%MM1038`
    because the library filled the number itself from the number range, whose format comes back
    with the date parts unexpanded (maintainer: "Die Formate mit Datum werden aber nicht mit
    ausgegeben"); with the library's numbering commented out, sending no number worked for the
    reporter. So placeholders come from a client that copies the raw format, not from sevDesk.
- **Sources:** spec (Invoice tag, "The invoice number"; `Model_Invoice`, `Model_creditNote`,
  `Model_Order`); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  "Documents get their number on `sendBy`"; recorded `tests/fixtures/write_invoice_save.json` and
  `write_credit_note_save.json`);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts);
  [exlo89/laravel-sevdesk-api#16](https://github.com/exlo89/laravel-sevdesk-api/issues/16);
  recorded 2026-11-07, trial account, Update 2.0 (probes `write-numbering-invoice`,
  `write-numbering-order-draft`, `write-numbering-credit-note`, `write-next-order-number`,
  `write-credit-note-from-invoice`, `write-credit-note-payout-sign`, `read-number-placeholders`);
  recorded 2026-11-16, trial account, Update 2.0 (probes `write-order-contract-note-from-order`,
  `write-order-packing-list-from-order`, `write-delete-draft-order-credit-note`,
  `write-order-status-accept-reject`);
  manual check (lead) of saving and finalizing with peeked and reserved numbers; recorded
  2026-11-18, trial account, Update 2.0 (probe `write-reserved-number-ab-li`, opt-in).
- **Impact:** No tool ever sends a number it made up (B4): the create inputs do not accept one,
  and updates send the stored number unchanged, or none when none is stored. Invoices are created
  without a number and get it from `sendBy`. Orders and credit notes take their number from
  sevDesk's own sequence instead (`src/domain/drafts/numbering.ts`): the preview peeks the next
  number (`useNextNumber=false`), and execute reserves it (`useNextNumber=true`) right before
  `saveOrder` or `saveCreditNote` (D-066). For credit notes, `reserveFreeCreditNoteNumber` checks
  the reserved number against the existing credit notes (a scan of up to 5,000; a cut scan draws a
  warning) and reserves again, up to five times, if it is taken; skipped numbers are reported.
  `sevdesk_credit_note_create_from_invoice` advances the counter once when the next number equals
  the one sevDesk gave the new draft (`src/domain/derived-documents.ts`), and the credit note
  finalize and send-email tools refuse a draft without a number
  (`src/domain/lifecycle/transitions.ts`) (fix in this PR). `sevdesk_order_create_confirmation`
  and `sevdesk_order_create_delivery_note` do the same for the `AB` and `LI` counters
  (`src/domain/order-follow-ups.ts`, #134): after the factory request, when the peek still offers
  the new order's number, it is reserved once, which advances the `AB` or `LI` counter by one
  (recorded 2026-11-18, D-066), so consecutive confirmations or delivery notes no longer share a
  number. Every real create therefore reserves a number, also for a draft that
  is deleted later, which can leave a gap in the range (D-066 recorded the number coming back only
  for the draft saved with the number reserved last; for a factory draft it is not recorded). The
  two tools, and `sevdesk_order_create_draft` for an `AB` or `LI` draft, hold the range's
  account-wide lock (`ACCOUNT_ORDER_NUMBERS`) from `prepare` to the end, so this server's calls
  cannot take the same number between a factory request and the reservation; the other orders of
  the type with the same number are still looked up as a safety net (numbers shared from before,
  or taken in the web app). The draft
  read-back notes a missing number and a number with `%…%` placeholders (`readBackNotes` in
  `src/domain/drafts/read-back.ts`); the finalize preview warns when the stored number contains
  `%` (`src/tools/lifecycle/finalize.ts`).
- **Test:** `test/regressions/b4-numbering.test.ts`,
  `test/regressions/order-factory-number-counter.test.ts` (#134: two confirmations or delivery
  notes made at once get different numbers, the counter moves once per create, the lock, no
  repeated request), `test/unit/domain/order-follow-ups.test.ts`,
  `test/unit/domain/drafts/payloads.test.ts` ("notes unexpanded placeholders in a number (D-027)"),
  `test/unit/tools/lifecycle/finalize.test.ts` ("warns about unexpanded placeholders in the number
  (D-027)"); `test/unit/domain/drafts/numbering.test.ts`, `test/unit/tools/drafts/numbering.test.ts`
  (peek, reservation, collisions); `test/contract/recorded-fixtures.test.ts` ("lists credit notes,
  including one without a number"). Live: probes `write-numbering-invoice`, `write-numbering-credit-note`,
  `write-numbering-order-draft`, `write-next-order-number`, and `write-reserved-number-ab-li`
  (opt-in; observed 2026-11-18: factory copies do not move the counter).

### D-028: Kleinunternehmer tax rule id differs between spec sections

- **Status:** Open. **Evidence:** spec, recorded (community recording).
- **Spec says:** The Voucher section lists the Kleinunternehmer (§19 UStG) rule as id `1`.
- **Actual behavior:** The spec's tax-rule tables and a recorded `GET /TaxRule` response both use
  id `11`; id `1` is "Umsatzsteuerpflichtige Umsätze".
- **Sources:** `spec/openapi.yaml` (Voucher and tax-rule sections);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (2026-02-19);
  recorded 2026-11-07, trial account, Update 2.0 (`GET /TaxRule`: 11 is `KLEINUNTERNEHMER_P19`,
  "Steuer nicht erhoben nach §19UStG").
- **Impact:** `src/domain/reference-data.ts` uses `11`; the Voucher-section value is treated as a
  typo.
- **Test:** `test/regressions/b9-reference-ids.test.ts`, `test/contract/recorded-fixtures.test.ts`
  ("knows exactly the tax rules of the recorded GET /TaxRule, with the same codes").

### D-029: Tax rule 21 has two different names

- **Status:** Open. **Evidence:** spec, recorded (community recording).
- **Spec says:** Rule 21 is "§18b UStG (field 21)".
- **Actual behavior:** `GET /TaxRule` names it "Reverse Charge gem. §13b Abs. 1 USTG EU Umsätze"
  (code `REV_CHARGE_13B_1_USTG`). Both describe services to businesses in other EU states.
- **Sources:** `spec/openapi.yaml`; the recordings linked in D-028 (ours, 2026-11-07, has the
  full name above).
- **Impact:** Reference data keeps both names so either wording maps to rule 21.
- **Test:** `test/regressions/b9-reference-ids.test.ts`.

### D-030: Undocumented tax rules 15, 16 and 22

- **Status:** Open. **Evidence:** recorded (community recording).
- **Spec says:** Nothing about ids 15, 16 or 22.
- **Actual behavior:** `GET /TaxRule` returns 15 "Nicht Steuerbar (Steuer)", 16 "Nicht Steuerbar
  (Ausgabe)" and 22 "Nicht Steuerbar (Einnahme)".
- **Sources:** the recordings linked in D-028 (ours, 2026-11-07, has all three, with the codes
  `NICHT_STEUERBAR_TAX`, `NICHT_STEUERBAR_EXPENSE` and `NICHT_STEUERBAR_REVENUE`);
  joosthel/sevdesk-mcp lists 16 and 22.
- **Impact:** Included in reference data with `documented: false`. The draft tools refuse 15 and
  22, which are not in the spec's sales-document enum (`SALES_TAX_RULE_IDS` in
  `src/domain/drafts/tax.ts`); 16 is an expense rule and refused there too. Receipts are checked
  against the ReceiptGuidance (D-006, D-065), which lists 16 for some accounts.
- **Test:** `test/regressions/b9-reference-ids.test.ts`, `test/unit/domain/drafts/tax.test.ts`
  ("refuses rules outside the scope, naming expense rules": rule 22).

### D-031: Transaction status 350 exists only in the response model

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The CheckAccountTransaction tag docs list statuses 100, 200, 300 and 400.
- **Actual behavior:** The transaction response model also allows 350 ("auto-booked without
  confirmation"). Not seen yet from sevDesk itself: every transaction of the trial account was at
  400 (recorded 2026-11-07), and at 100 or 400 on 2026-11-08. A `PUT {status: 350}` on an open
  hand-made row of a file-import account is accepted, and the row reads back at 350 (recorded
  2026-11-18, D-098). No tool sets a status of 350.
- **Sources:** `spec/openapi.yaml` (`Model_CheckAccountTransactionResponse`); recorded 2026-11-07
  and 2026-11-08, trial account, Update 2.0 (probe `read-transaction-status-filter`); recorded
  2026-11-18, trial account, Update 2.0 (probe `write-transaction-enshrine-statuses`, opt-in).
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
- **Test:** `test/unit/tools/contacts/get.test.ts` (defensive filter). sevDesk's behavior:
  pending: recording session, probe `read-contact-address-filter` (no contact address in the
  trial account; the recorded filtered and unfiltered reads are both empty).

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
  firsttris/haben treats a refused `getXml` as "not an e-invoice". For an ordinary finalized
  invoice sevDesk answers 400 "This invoice is not an electronic invoice." (recorded). A
  finalized e-invoice answers `200` with `Content-Type: application/json` and the XML as a string
  in `objects`: XRechnung 3.0 in CII syntax (BT-24
  `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`), and its `getPdf`
  embeds the same XML as `xrechnung.xml` (recorded). Finalizing an e-invoice while the company
  address (`GET /SevClient` street, postcode, city) is empty fails with 400 "Could not generate
  ZUGFeRD Invoice since there are validations errors" without naming the fields (recorded).
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/error.rs`); [firsttris/haben](https://github.com/firsttris/haben)
  (`packages/import/src/sevdesk/client.ts`); recorded 2026-11-07 and 2026-11-08, trial account,
  Update 2.0 (probes `read-getxml-shapes`, `write-einvoice-xml`).
- **Impact:** `fetchDocumentFile` (`src/domain/document-files.ts`) calls `getXml` without a
  pre-check (see D-034). A 4xx refusal that is classified as a validation error, or an empty body
  (`null`, `""`, `[]`, `false`), becomes a `not_found` error with our own message: XML exists only
  for invoices marked as e-invoices with complete e-invoice data, and only once they are finalized
  (a draft e-invoice gets its XML after finalizing). sevDesk's status, message and exception id
  stay on the error for the logs. A body that is not XML text (or is HTML) is an
  `unexpected_response`.
- **Test:** `test/unit/domain/document-files.test.ts` ("fetchDocumentFile: e-invoice XML");
  `test/unit/domain/einvoice/parse.test.ts` and `preflight.test.ts` read the recorded XML
  (`test/fixtures/einvoice/sevdesk/xrechnung-3.0-cii.xml`) without findings.

### D-034: Invoice reads do not say whether an invoice is an e-invoice

- **Status:** Open. **Evidence:** spec + recorded (community recording).
- **Spec says:** `propertyIsEInvoice` ("If true, the invoice will be created as e-invoice")
  exists only in the request model `Model_Invoice` and the Invoice tag docs.
  `Model_InvoiceResponse` does not have it, and no invoice filter selects e-invoices.
- **Actual behavior:** The recorded `POST /Invoice` response carries `propertyIsEInvoice` (as
  `null`), but the recorded `GET /Invoice` row has no such key. A client cannot tell from a read
  whether an invoice has e-invoice XML. Our recording agrees: the `saveInvoice` and
  `cancelInvoice` answers carry `propertyIsEInvoice: null`, `GET /Invoice/{id}` has no such key,
  also not for a finalized e-invoice (probe `write-einvoice-xml`, 2026-11-08).
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19); recorded 2026-11-07, trial account, Update 2.0 (probes `read-getxml-shapes`,
  `write-send-email-shape`, `write-cancel-invoice`).
- **Impact:** The XML tool and the `sevdesk://invoices/{id}/xml` resource call `getXml` directly
  and rely on its refusal (D-033) instead of checking the invoice first. The invoice tools set
  `eInvoice` only when sevDesk sends `propertyIsEInvoice` as true or false; when it is missing or
  `null` they leave `eInvoice` out (unknown) and never infer it. The invoice fixtures follow the
  recording and have no `propertyIsEInvoice`.
- **Test:** `test/unit/domain/document-files.test.ts` (`getXml` is the only request),
  `test/unit/tools/invoices/list.test.ts` ("shows eInvoice only when sevDesk sends
  propertyIsEInvoice").

### D-035: Unknown or misspelled list filters are ignored

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** The filter tables of the Invoice and CreditNote tags list
  `customerIntenalNote={note}` (sic). Nothing says what happens to a query filter the API does not
  know, or how the document number filters match.
- **Actual behavior:** sevDesk ignores unknown or misspelled query filters without an error and
  returns the unfiltered list. jernoxit/sevdesk-rs measured this for the misspelled name the spec
  documents (the correct `customerInternalNote` works) and for `externalId`. `customerNumber` on
  `/Contact` matches exactly (sevdesk-rs README). Recorded on 2026-11-07:
  - `invoiceNumber` matches the whole number, ignoring case: the exact number and its lower-case
    form each found the invoice, the number without its last character found nothing.
  - `origin[id]` with `origin[objectName]=Invoice` is honored on `/Invoice` and `/CreditNote`:
    the filtered answers equal a local filter of the unfiltered lists.
  - `creditNoteNumber`, `orderNumber` and `type` on `/CommunicationWay` are not measured (no
    communication way in the account).
- **Sources:** [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs);
  recorded 2026-11-07, trial account, Update 2.0 (probes `read-invoice-filters`,
  `read-origin-filter`; `read-communication-way-type-filter` inconclusive). Related: D-003
  (unknown fields in request bodies), D-032 (`contact[id]` on `/ContactAddress`).
- **Impact:** The document number filters are sent to sevDesk and checked again on every returned
  row (trimmed, case-insensitive; `matchesNumber` in `src/domain/document-positions.ts`), so an
  ignored filter cannot return other documents. The invoice, order and voucher types are checked
  again the same way (D-015). Position lists are filtered by their parent id again for the same
  reason. The duplicate checks of the write tools do the same with the filters they rely on:
  `origin[id]`/`origin[objectName]` on `/Invoice` and `/CreditNote` (documented only in the filter
  tables of the Invoice and CreditNote tags; `src/domain/derived-documents.ts`), `type=EMAIL` on
  `/CommunicationWay` and `customerNumber` on `/Contact` (`src/domain/contacts-write.ts`). The
  `origin` and e-mail scans read a capped number of rows and warn when they were cut, since an
  ignored filter would make them read everything. The re-checks stay where the filters were
  measured to work: they cost nothing on a correct answer, and the case-insensitive matching is
  the same as sevDesk's.
- **Test:** `test/unit/tools/invoices/list.test.ts` ("re-checks the invoice number on every
  row…"), `test/unit/tools/credit-notes/list.test.ts`, `test/unit/tools/orders/list.test.ts`
  ("re-checks the order number on every row", "re-checks the order type on every row…"),
  `test/unit/tools/vouchers/list.test.ts` ("re-checks the voucher type on every row…"),
  `test/unit/domain/document-positions.test.ts` ("re-checks document numbers trimmed and
  case-insensitively"), `test/unit/tools/invoices/get.test.ts` (positions of other invoices).
  Duplicate checks: `test/unit/tools/masterdata/credit-note-from-invoice.test.ts`,
  `test/unit/tools/masterdata/invoice-reminder.test.ts`,
  `test/unit/tools/masterdata/contact-create.test.ts` (cut scans warn). `type` on
  `/CommunicationWay`: pending: recording session, probe `read-communication-way-type-filter`
  (no communication way in the trial account).

### D-036: `getRelatedObjects` is declared to return order positions

- **Status:** Open. **Evidence:** spec + community.
- **Spec says:** `GET /Order/{orderId}/getRelatedObjects` ("Get related objects of a specified
  order") declares `objects` as an array of `Model_OrderPosResponse`, that is, order positions.
- **Actual behavior:** It returns the linked documents (invoices made from the order, other
  orders, and the order itself unless `includeItself` is false), either as a list or as an object
  whose keys are numeric indexes with gaps (`{"0": …, "3": …}`). Observed on an Update 1.0
  account. On Update 2.0, an offer without linked documents answered `{objects: []}` with
  `includeItself=0` (recorded); the shape of a non-empty 2.0 answer is not recorded.
- **Sources:** [firsttris/haben#346](https://github.com/firsttris/haben/issues/346);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md);
  recorded 2026-11-07, trial account, Update 2.0
  (`test/fixtures/recorded/2026-11-07/orders/order-related.json`; probe
  `read-related-objects-shape` inconclusive, no order at probe time).
- **Impact:** `sevdesk_order_get` calls it with `includeItself=0`, reads both forms, drops the
  order itself and shows each document's kind, id, number, type and status. If the call fails or
  the answer has another shape, the order is still returned without `related`, and the summary
  says that the related documents could not be read.
- **Test:** `test/unit/tools/orders/get.test.ts` ("lists related documents from a numeric-key
  object…", "reads related documents sent as a list…", "still returns the order when related
  documents cannot be read"), `test/contract/recorded-fixtures.test.ts` ("reads one order with
  its positions and the Update 2.0 related-documents list"). A non-empty 2.0 answer: pending:
  recording session, probe `read-related-objects-shape` (needs an invoice made from an order,
  D-063).

### D-037: Cancelled invoices keep status 1000

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /Invoice/{invoiceId}/cancelInvoice` says "The cancellation invoice will be
  automatically paid and the source invoices status will change to 'cancelled'". Neither the
  invoice status table nor `Model_InvoiceResponse.status` (`50, 100, 200, 750, 1000`) has a code
  for "cancelled".
- **Actual behavior:** The original invoice goes from 200 to status 1000 (paid) with `paidAmount`
  0 and `payDate` null; of the fields the probe compared only the status changes, and it does not
  point to its cancellation. The
  cancellation invoice (type `SR`) is paid (status 1000) and has negative sums (`sumGross` −119
  for 119). Its `origin` (`objectName` `Invoice`, the original's id) is the only link between the
  two. `invoiceType=SR` finds the SR invoice, `status=1000` the original.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) recorded fixtures
  (`tests/fixtures/invoice_list.json`, `tests/fixtures/write_invoice_cancel.json`); recorded
  2026-11-07, trial account, Update 2.0 (probes `write-cancel-invoice`,
  `read-cancellation-origin`).
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
  approximate, unknown and left-out rows in its notes"). Live: probe `write-cancel-invoice`.

### D-038: The credit note status filter allows order statuses

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `status` parameter of `GET /CreditNote` is a string enum
  `100, 200, 300, 500, 750, 1000`. The CreditNote tag's status table and
  `Model_creditNoteResponse.status` have only `100, 200, 750, 1000`; 300 and 500 are order
  statuses (rejected, accepted).
- **Actual behavior:** `status=300` and `status=500` are accepted and return no rows; the nine
  credit notes of the trial account (drafts, open, partially paid, paid) had only 100, 200, 750
  and 1000 (recorded). Credit notes have the four statuses of the status table.
- **Sources:** spec (`getCreditNotes`, tag "Status of credit notes", `Model_creditNoteResponse`);
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-credit-note-statuses`).
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
  from an invoice, and those carry both `origin` and `refSrcInvoice` pointing to the invoice
  (recorded, D-064). Credit notes have no `paidAmount`, also not when partially paid (750,
  recorded), so how much of a partially paid credit note is paid cannot be read from it. Recorded
  credit note and order positions carry `sumNet`, `sumTax` and `sumGross`.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) recorded fixtures
  (`tests/fixtures/credit_note.json`, `tests/fixtures/write_credit_note_save.json`);
  [TomDixon63/OrderManager2](https://github.com/TomDixon63/OrderManager2)
  (`front/src/app/model/order.ts`, a pasted `GET /Order?embed=positions` response, 2023);
  recorded 2026-11-07, trial account, Update 2.0 (probe `write-credit-note-from-invoice`;
  `test/fixtures/recorded/2026-11-07/credit-notes/`).
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
  reports no paid amount)"), `test/contract/recorded-fixtures.test.ts` ("D-039: credit notes
  carry no paidAmount, also when partially paid (750)").

### D-040: The `CreditNotePos` filter names the wrong `objectName`

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** For `GET /CreditNotePos`, `creditNote[objectName]` is "Only required if
  creditNote[id] was provided. 'creditNote' should be used as value." The CreditNotePos tag's own
  examples use `"objectName": "CreditNote"`.
- **Actual behavior:** Recorded credit note positions refer to their parent as
  `{objectName: "CreditNote"}`, and other clients filter with `creditNote[objectName]=CreditNote`.
  That value works (only the credit note's own positions); the spec's lower-case `creditNote` is
  refused with HTTP 500 (recorded).
- **Sources:** spec; [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  (`tests/fixtures/write_credit_note_save.json`); recorded 2026-11-07, trial account, Update 2.0
  (probe `read-credit-note-pos-objectname`).
- **Impact:** Credit note positions are requested with `creditNote[objectName]=CreditNote` and
  filtered by parent id again (D-035), so an ignored filter cannot mix in other positions.
- **Test:** `test/unit/tools/credit-notes/get.test.ts`, `test/contract/recorded-fixtures.test.ts`
  ("reads one credit note with its positions": the recorded answer to the `CreditNote` filter).

### D-041: `bookAmount` on vouchers and credit notes takes a signed amount

- **Status:** Open. **Evidence:** community + recorded.
- **Spec says:** `PUT /Voucher/{voucherId}/bookAmount`, `PUT /CreditNote/{creditNoteId}/bookAmount`
  and `PUT /Invoice/{invoiceId}/bookAmount` take `amount`: "Amount which should be booked. Can
  also be a partial amount." Nothing about its sign. Booking a credit note is "exactly the same as
  the process for invoices and vouchers".
- **Actual behavior:** The amount is signed as the money moves on the check account: negative for
  an expense voucher (`creditDebit` `C`), positive for revenue (`D`). genz-its reports that a
  positive amount on an expense voucher is accepted without an error and stored as a negative
  `paidAmount`, the voucher then staying partially paid (750) with no `payDate`. Credit notes
  behave that way (recorded): −119 on an open credit note of 119 pays it out (200 → 1000,
  `payDate` set), while +119 is accepted without an error and leaves it partially paid (200 → 750,
  no `payDate`). Invoices take positive amounts. Recorded for vouchers (2026-11-08): on an expense
  voucher of 119, three bookings of −10 (type `N`) moved it to 750 with `paidAmount` 10, 20 and 30
  (positive), and −119 `FULL_PAYMENT` paid another one in full (1000). A +119 `FULL_PAYMENT` on an
  expense voucher was accepted as well and paid it in full (1000, `paidAmount` 119, `payDate`
  set): for a full payment sevDesk does not enforce the sign. The positive partial booking
  genz-its describes was not repeated.
- **Sources:** [genz-its/sevdesk `CLAUDE.md`](https://github.com/genz-its/sevdesk/blob/main/CLAUDE.md)
  (vouchers, verified against a live account); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  README (credit notes, measured, not recorded); recorded 2026-11-07, trial account, Update 2.0
  (probe `write-credit-note-payout-sign`); recorded 2026-11-08 (probe `write-voucher-book-amount`,
  second write run).
- **Impact:** `bookingAmountSign` in `src/domain/vouchers.ts` gives the sign for each voucher
  kind. The payment tools send invoice payments positive and credit note payouts negative
  (`paymentSign` in `src/domain/lifecycle/payments.ts`, via `bookingAmountSign`), and link a
  credit note payout only to an outgoing transaction. Voucher payments
  (`sevdesk_voucher_book_payment`, and `sevdesk_transaction_book` in bank reconciliation) are
  signed by the voucher's `creditDebit` the same way, expenses negative and revenue positive,
  although sevDesk would take either sign for a full payment; they link only a transaction that
  moves money in that direction. A voucher with a negative `paidAmount`, the trace a wrongly signed
  booking leaves, is refused for further payments.
- **Test:** `test/regressions/expense-sign.test.ts`, `test/unit/domain/lifecycle/payments.test.ts`
  ("sends a credit note payout as a negative amount (money out)"),
  `test/unit/tools/lifecycle/book-payment.test.ts` ("sends the payout as a negative amount and
  says so in the preview", "links only an outgoing transaction"),
  `test/regressions/b7-payment-linking.test.ts` ("links an outgoing transaction to a credit note
  payout with the negative amount"). Credit notes live: probe `write-credit-note-payout-sign`.
  Vouchers: `test/unit/domain/lifecycle/vouchers.test.ts` ("signs by the voucher's own direction
  (D-041)"), `test/unit/tools/lifecycle/voucher-lifecycle.test.ts` ("pays an expense voucher with
  a negative amount, linked to an outgoing transaction (D-041)", "pays a revenue voucher with a
  positive amount and refuses an outgoing transaction", "refuses a negative paid amount (the trace
  of a wrongly signed booking)"), `test/regressions/transaction-partial-use.test.ts` ("pays an
  expense voucher from a larger outgoing transaction with type N and a negative amount"),
  `test/unit/domain/reconciliation/allocate.test.ts` ("pays an expense voucher from an outgoing
  transaction with a negative amount"). Live: probe `write-voucher-book-amount`.

### D-042: Part `price` can hold the net or the gross price

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_Part.price` is the "Net price for which the part is sold. we will change
  this parameter so that the gross price is calculated automatically, until then the priceGross
  parameter must be used." `priceNet` and `priceGross` are separate fields.
- **Actual behavior:** It depends on how the part was written. A part created through
  `POST /Part` with `priceNet` 42.01, `priceGross` 49.99 and `taxRate` 19 but no `price` is
  accepted and stores `price` = 42.01, the net price (recorded twice; `GET /Part` shows the same).
  This contradicts what this entry used to say from a community recording, in which `price`
  (`49.99`) equals `priceGross` next to `priceNet` 42.01, for a part written another way. So
  `price` is not reliably net or gross.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19); recorded 2026-11-07, trial account, Update 2.0 (probe `write-part-price-fields`:
  contradicted; `test/fixtures/recorded/2026-11-07/parts/`).
- **Impact:** The parts tools ignore `price` and show `priceNet`, `priceGross` and
  `pricePurchase` only, which is right under either reading. Part writes
  (`src/domain/parts-write.ts`) never send `price`: a price is sent as `priceNet` and `priceGross`
  together with the `taxRate` they were computed with (the other price computed exactly and
  rounded half-up to cents, like the recorded 42.01 / 49.99 at 19 %), as JSON numbers checked to
  round-trip exactly; sevDesk then fills `price` with the net price itself.
- **Test:** `test/unit/tools/parts/list.test.ts` ("returns compact parts with exact prices; price
  (= gross in the recording) is ignored"), `test/unit/tools/masterdata/part-create.test.ts`
  ("sends net and gross price with the tax rate, never price, and reads the part back"),
  `test/unit/tools/masterdata/part-update.test.ts` ("recomputes the gross price when only the tax
  rate changes"), `test/unit/domain/parts-write.test.ts` ("pricePair"),
  `test/contract/recorded-fixtures.test.ts` ("D-042: a part written with priceNet and priceGross
  stores the net price in price"). Live: probe `write-part-price-fields`.

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
  `sumTaxForeignCurrency` and `sumGrossForeignCurrency` although the model lacks them. Our
  recording has a USD invoice of 100 net at 19 %: `sumGross` 106.77 (EUR) and
  `sumGrossForeignCurrency` 119 (USD). After booking 10 on it, `paidAmount` is 10 and the status
  750: `paidAmount` holds the booked amount as sent, unconverted. Whether sevDesk counts booked
  amounts in USD or EUR toward "paid" (a full payment of 119 or of 106.77) is not measured.
  The 2026-11-13 voucher probes independently confirmed the split on both the voucher and its
  positions: sending USD net 100 at 19 % with rate `"0.9"` stores EUR sums `"90"`, `"17.1"`,
  `"107.1"` and foreign sums `"100"`, `"19"`, `"119"`. Position amounts returned in plain
  `sum…` fields are therefore EUR, even though the amounts sent to `saveVoucher` are USD (D-082).
  A CHF invoice draft with a fixed 10.00 discount (recorded 2026-11-18, D-116) shows the same
  split for the discount: `sumDiscountsForeignCurrency` -10 (CHF), `sumDiscounts` -10.81 (EUR).
- **Sources:** [numtide/freelancer-toolbox](https://github.com/numtide/freelancer-toolbox)
  (`sevdesk-cli`, vouchers);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md)
  (orders); EUR rows recorded by [emuuu/sevDesk.NET](https://github.com/emuuu/sevDesk.NET) and
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs); recorded 2026-11-07, trial
  account, Update 2.0 (probes `write-paid-amount-foreign-currency`, `read-paid-amount-currency`).
  Recorded 2026-11-13, trial account, Update 2.0 (probes `write-voucher-usd-rate`,
  `write-voucher-usd-deadline`, `write-voucher-usd-rate-update`, `write-voucher-convert-to-eur`).
  Recorded 2026-11-18, trial account, Update 2.0 (probe `write-discount-foreign-currency`).
- **Impact:** For EUR documents the tools use the plain sums and never the `…ForeignCurrency`
  fields. For another currency with non-zero `…ForeignCurrency` sums, amounts are shown in the
  document's currency and the EUR base separately (`base` on vouchers, `totalsEur` on invoices,
  credit notes and orders). Without such sums, the plain sums are shown in the document's currency
  and no EUR figure is claimed. Invoices show `paid` only in EUR, and vouchers label a
  foreign-currency `paidAmount` as EUR and say that this is not verified; since `paidAmount` is
  the booked amount unconverted, the currency of that figure on a foreign-currency document
  remains open.
- **Test:** `test/unit/domain/vouchers.test.ts` ("shows foreign-currency vouchers in their own
  currency with the EUR base apart", "uses the plain sums when a foreign-currency voucher has no
  foreign sums"), `test/unit/domain/document-positions.test.ts` ("splits foreign-currency
  documents into document currency and EUR", "does not claim an EUR figure…"),
  `test/unit/tools/invoices/list.test.ts` ("reports foreign-currency invoices in their currency
  and EUR"). The currency of `paidAmount`: pending: recording session, probe
  `write-paid-amount-foreign-currency` (it books only a partial amount, which cannot tell USD from
  EUR).

### D-044: Voucher reads can omit `document`

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_VoucherResponse.document` is a nullable `{id, objectName: "Document"}`
  reference to the attached file.
- **Actual behavior:** The key is there exactly when a file is attached. The community-recorded
  `GET /Voucher` row has no `document` key at all, not even `null`. Recorded 2026-11-08: vouchers
  saved with a file carry `document: {id, objectName: "Document"}` in the list rows and in
  `GET /Voucher/{voucherId}`; vouchers without a file have no `document` key, in both reads (the
  recorded voucher list of that day has both kinds). `null` was never seen.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19); recorded 2026-11-08, trial account, Update 2.0 (probes
  `read-voucher-document-key`, `write-voucher-save-with-file`;
  `test/fixtures/recorded/2026-11-08/vouchers/vouchers-list.json`).
- **Impact:** The voucher tools report `hasDocument` only when the key is present (a reference:
  `true`, `null`: `false`); otherwise they leave it out instead of saying `false`, although the
  recording suggests that a missing key means "no file". After a write with a receipt, the
  read-back notes a `null` `document` as a missing file and a missing key as unknown
  (`src/domain/drafts/voucher.ts`).
- **Test:** `test/unit/tools/vouchers/get.test.ts` ("renders the recorded mix…": no
  `hasDocument`), `test/unit/domain/vouchers.test.ts`,
  `test/regressions/b5-voucher-filename.test.ts` (`hasDocument` true after the upload, no note),
  `test/unit/tools/vouchers/create-draft.test.ts` ("notes when the read-back does not say whether
  the file is attached (D-044)"). Live: probes `read-voucher-document-key`,
  `write-voucher-save-with-file`.

### D-045: Voucher positions can lack `accountDatev` on Update 2.0

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `Model_VoucherPos` and `Model_VoucherPosResponse` both list `accountDatev` ("Use
  this in sevdesk-Update 2.0 (replaces accountingType)") and `accountingType` as required.
- **Actual behavior:** A position carries one of the two. The community-recorded
  `GET /VoucherPos` row, which belongs to a voucher with the Update 2.0 tax rule 9, has
  `accountingType` and no `accountDatev` key. genz-its reports `accountDatev: null` on legacy 1.0
  positions, which carry `accountingType` instead. Recorded 2026-11-08: positions written through
  the API on Update 2.0 carry `accountDatev` (`{id, objectName: "AccountDatev"}`) and no
  `accountingType` key (`estimatedAccountingType` is `null`), and `GET /VoucherPos` with
  `embed=accountDatev` expands the account (number, name and its flags). They also carry keys
  `Model_VoucherPosResponse` lacks, such as `isGwg`, `isPercentage`, `assetMemoValue` and the
  `sum…ForeignCurrency` sums.
- **Sources:** [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET)
  (2026-02-19); [genz-its/sevdesk `CLAUDE.md`](https://github.com/genz-its/sevdesk/blob/main/CLAUDE.md);
  recorded 2026-11-08, trial account, Update 2.0 (probes `write-voucher-net-gross`,
  `read-voucher-pos-account-datev`;
  `test/fixtures/recorded/2026-11-08/vouchers/voucher-positions-embed-account.json`).
- **Impact:** The bookkeeping generation is detected per object: for a voucher from
  `taxRule`/`taxType`, for a position from `accountDatev`/`accountingType`
  (`detectPositionGeneration` in `src/sevdesk/system-version.ts`). A 2.0 voucher can therefore
  show a 1.0 position with its `accountingType` id. Our schemas do not copy the spec's `required`
  lists and ignore the undeclared keys. The voucher writes send `accountDatev` only, and refuse to
  carry over a stored position that has only an `accountingType` where its account must be
  checked (an update with a new tax rule, the finalize), since ReceiptGuidance knows only
  `accountDatev` ids (`storedPositionsFor` in `src/domain/drafts/voucher-current.ts`). No tool
  uses `embed=accountDatev`.
- **Test:** `test/unit/tools/vouchers/get.test.ts` ("renders the recorded mix: a 2.0 voucher with
  a legacy 1.0 position"), `test/unit/tools/vouchers/update-draft.test.ts` ("refuses a stored
  legacy position when the tax rule changes (D-045)"),
  `test/unit/tools/vouchers/finalize-delete.test.ts` ("refuses a draft without positions or with a
  legacy position (D-045)"), `test/contract/recorded-fixtures-m4.test.ts` ("reads Update 2.0
  positions with their booking account (D-045)").

### D-046: Date-range filters on document lists are described two ways

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `startDate`/`endDate` parameters of `GET /Invoice`, `GET /Order`,
  `GET /CreditNote` and `GET /Voucher` select documents "with a date equal or higher" / "equal or
  lower". The filter tables of the same tags say the date must be "bigger than" / "smaller than"
  the timestamp. The parameters are `type: integer` with examples like `01.01.2020`.
- **Actual behavior:** The bounds are inclusive, as the parameter descriptions say (recorded on
  `GET /Invoice`): for an invoice dated `2026-11-07T00:00:00+01:00`, `startDate` = 00:00 Berlin of
  that day includes it and 00:00:01 excludes it; `endDate` = 00:00 includes it and 23:59:59 of the
  day before excludes it. `startDate` also accepted `dd.mm.yyyy`. Document dates sit at 00:00
  Berlin time. The other three lists are not measured.
- **Sources:** spec; recorded 2026-11-07, trial account, Update 2.0 (probe
  `read-document-date-strictness`).
- **Impact:** `documentDateFilter` (`src/domain/common.ts`) serves all four lists. It sends the
  Berlin calendar days as Unix seconds, with `startDate` one second before the first day and
  `endDate` at the last second of the last day, so the first day is included under either
  reading. Every returned document's date is then checked against the inclusive range, which
  drops anything the earlier bound let in; a document without a date never matches a range. The
  re-check does not start a scan: sevDesk's paging and total stay. With inclusive bounds the
  one-second margin only lets in documents dated at 23:59:59 of the day before, which the re-check
  drops.
- **Test:** `test/unit/domain/common.test.ts` ("documentDateFilter"),
  `test/unit/tools/invoices/list.test.ts` ("re-checks the date range on every row without a local
  scan"), `test/unit/tools/credit-notes/list.test.ts`, `test/unit/tools/orders/list.test.ts`,
  `test/unit/tools/vouchers/list.test.ts` ("re-checks the voucher date against the range, keeping
  sevDesk's paging").

### D-047: Transaction date filters compare `entryDate`

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `GET /CheckAccountTransaction` declares `startDate` ("Only retrieve transactions
  from this date on") and `endDate` ("Only retrieve transactions up to this date") as
  `type: string, format: date-time`. It does not say which of the transaction's two dates they
  compare (see D-016).
- **Actual behavior:** jernoxit/sevdesk-rs measured on a test account (2026-10-01) that both
  filters cut by `entryDate`, not `valueDate`, and that they accept Unix timestamps as well as ISO
  dates. Our recordings confirm both. On 2026-11-07 a one-day window found the transaction in
  either format, while every transaction had equal dates. On 2026-11-08 a transaction with
  `valueDate` 2026-11-05 and `entryDate` 2026-11-08 (created on a file-import account, D-071) was
  not found by a window on its value day, with Unix seconds or ISO dates, and was found by a window
  on its entry day.
- **Sources:** [jernoxit/sevdesk-rs `src/query.rs`](https://github.com/jernoxit/sevdesk-rs/blob/main/src/query.rs);
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-transaction-date-filters`); recorded
  2026-11-08 (probes `write-transaction-create`, `read-transaction-date-filters`).
- **Impact:** `sevdesk_transactions_list` has `dateField: "value" | "entry"` (default `value`).
  For a value-date range it sends no `startDate`/`endDate` and filters `valueDate` itself, reading
  sevDesk pages up to its scan cap (5,000 rows per call; `filteredLocally`, no total) or, since
  sevDesk lists rows newest first by value date (D-145), up to the first row before the range. For an
  entry-date range it sends `startDate`/`endDate` as ISO date-times with the Berlin offset
  (00:00:00 to 23:59:59) and checks `entryDate` again; that re-check does not start a scan, so
  sevDesk's total stays.
- **Test:** `test/unit/tools/banking/transactions.test.ts` ("filters a value-date range here only,
  since sevDesk's date filters cut by entryDate", "lets sevDesk filter an entry-date range and
  re-checks entryDate", "defaults dateField to value"), `test/unit/domain/banking.test.ts` ("drops
  rows without a value date when a date range is given"). Live: probe
  `read-transaction-date-filters` (2026-11-08: the dates differ).

### D-048: Change filters are documented only in tag texts

- **Status:** Open. **Evidence:** spec.
- **Spec says:** `createBefore`, `createAfter`, `updateBefore` and `updateAfter` (`={timestamp}`,
  for example "Only retrieve all invoices updated last after timestamp") appear only in the filter
  tables of the Contact, Invoice, Order and Voucher tags; no operation declares them as
  parameters. The spec does not define "timestamp" (seconds, milliseconds or a date string) or
  say whether "after" includes the given instant. The CreditNote filter table and
  `GET /CheckAccountTransaction` have no change filter at all.
- **Actual behavior:** Recorded: `updateAfter` takes Unix seconds (the same instant in
  milliseconds returned nothing) and is inclusive (an invoice updated at a given second is found
  with `updateAfter` at that second). A future value empties `/Contact`, `/Invoice` and
  `/CreditNote`, so `/CreditNote` honors it although its filter table does not list it;
  `/CheckAccountTransaction` ignores it (D-035). A second run (2026-11-08) found that a future
  value empties `/Order` and `/Voucher` too, and repeated the rest: Unix seconds, inclusive,
  ignored by `/CheckAccountTransaction`.
- **Sources:** spec (tag descriptions of Contact, Invoice, Order, Voucher and CreditNote;
  `getTransactions`); recorded 2026-11-07 and 2026-11-08, trial account, Update 2.0 (probe
  `read-update-after`).
- **Impact:** `sevdesk_changed_since` sends `updateAfter` as Unix seconds, one second before
  `since`, for contacts, invoices, orders and vouchers, and checks every returned row itself: a
  row counts when its update time, or its creation time if it has none, is at or after `since`;
  rows with neither are counted but not listed. When a page shows that sevDesk did not apply the
  filter, it reads full pages from then on. Credit notes and transactions are read without a
  server filter and checked the same way. Each subject's scan reads at most 5,000 rows per call
  and continues with `nextOffset`. The recording shows that credit notes could take the server
  filter too; that is an optimization, not a correctness issue, and is left for later.
- **Test:** `test/unit/tools/reports/changed-since.test.ts` ("checks every subject by default,
  sending updateAfter only where the spec documents it", "keeps rows updated at or after since
  (creation time as fallback), newest first", "switches to full pages when sevDesk evidently
  ignored the filter", "caps the scan of subjects sevDesk cannot filter and continues with
  nextOffset"). Live: probe `read-update-after`.

### D-049: Whether lists include templates and reminders is undocumented

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The Invoice tag's filter table offers `showWkr=all` ("Retrieve all recurring
  invoices"), `showMa=all` ("Retrieve all invoices which are payment reminders") and
  `showAll=true` ("Retrieve all invoices of all types"). That suggests `GET /Invoice` leaves
  recurring invoice templates (`WKR`) and reminders (`MA`) out by default. The Voucher tag's table
  offers `noRv=true` ("Only retrieve vouchers which are not of type RV"), which suggests
  `GET /Voucher` includes recurring voucher templates (`RV`) by default. No operation declares
  these parameters, and neither default is stated.
- **Actual behavior:** Recorded on `GET /Invoice`: the default list leaves reminders out (39 rows,
  types RE and SR); `showMa=all` returns only the 4 reminders, not the default list plus them;
  `showAll=true` returns all 43. `showWkr=all` returned 0 rows (no recurring templates in the
  account), so whether templates are hidden by default is not shown. Reminders carry
  `sumGross` 0 and `origin` = the invoice they remind of, so their sums would not double-count
  (D-064). A second run (2026-11-08) repeated this (default 74 rows of types RE, AR and SR,
  `showMa=all` the 10 reminders only, `showAll=true` 84, `showWkr=all` 0). The voucher default
  (`noRv`) is still not shown: the account then had 11 vouchers, all of type VOU, and
  `noRv=true` returned the same 11. Recorded 2026-11-16 with recurring templates on the account:
  the default list leaves them out; `showWkr=all` and `invoiceType=WKR` return only templates,
  and `showAll=true` includes them (D-112).
- **Sources:** spec (filter tables of the Invoice and Voucher tags); recorded 2026-11-07 and
  2026-11-08, trial account, Update 2.0 (probes `read-list-defaults`, `write-reminder`); recorded
  2026-11-16, trial account, Update 2.0 (probes `write-recurring-template-create`,
  `read-recurring-generated`; `test/fixtures/recorded/2026-11-16/invoices/recurring-templates.json`).
- **Impact:** Templates and reminders are not documents of their own, so the tools keep them out
  of totals whatever the default is. `sevdesk_invoices_list` sends `showWkr=all` or `showMa=all`
  only when the caller asks for type `recurring` or `reminder`, together with `invoiceType` (`WKR`
  or `MA`), and re-checks the type on every row (D-015). Each parameter is recorded on its own;
  their combination is not, which the re-check covers: rows of another type are dropped, and the
  filter could at worst list too few. `sevdesk_records_summarize` leaves WKR and MA invoices out and counts them in its
  notes unless `invoiceType` asks for them. `sevdesk_receivables_aging` leaves them out and
  reports them under `excluded` (`recurringTemplates`, `reminders`). The summary and
  `sevdesk_payables_aging` read vouchers with `voucherType=VOU` (not `noRv`) and drop RV rows that
  sevDesk returns anyway; the payables aging reports those as `excluded.recurringTemplates`.
  `sevdesk_cash_position` leaves all three out of its outlook and counts them in a note.
  `sevdesk_changed_since` is the exception: a changed reminder is a change, so it reads invoices
  with `showAll=true` and reports every type (the row's `type` says which).
- **Test:** `test/regressions/changed-since-reminders.test.ts`,
  `test/unit/tools/reports/changed-since.test.ts` ("reports a reminder that sevDesk's default
  invoice list hides"), `test/unit/tools/invoices/list.test.ts` ("asks sevDesk to show
  recurring templates and reminders when that type is requested", "re-checks the invoice type on
  every row, so an ignored filter cannot leak (D-015)"),
  `test/unit/tools/reports/summarize.test.ts`
  ("leaves recurring templates (WKR) and reminders (MA) out unless asked for", "counts reminders
  when invoiceType asks for them", "totals expense and revenue in separate lines, foreign ones
  with their EUR base"), `test/unit/tools/reports/aging.test.ts` ("explains approximate, unknown
  and left-out rows in its notes", "flags wrong-signed payments, foreign paid amounts and
  left-out rows"), `test/unit/tools/reports/cash-position.test.ts` ("adds an expected outlook
  from open items by due date, never mixing currencies"). Templates:
  `test/contract/recorded-gaps-documents.test.ts` ("lists only templates, active ones (status 200) included, with total and paging"). RV vouchers: pending: recording session, probe
  `read-list-defaults` (the trial account has no RV voucher).

### D-050: A position `price` is read by the document's `showNet`

- **Status:** Open. **Evidence:** spec + community + recorded.
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
  `price` and `priceNet` 42.01, `priceGross` 49.9919, `priceTax` 7.9819). Our recording
  confirms it on `saveInvoice` (19 %): `price` 100 with `showNet: true` and `price` 119 with
  `showNet: false` both give `sumNet` 100 and `sumGross` 119; the stored position keeps `price` as
  sent and derives `priceNet` 100 and `priceGross` 119. A lone `priceNet` 100 (with `showNet:
true`) and a lone `priceGross` 119 (with `showNet: false`) give the same totals. This held on a
  small-business account as well (drafts only, D-067). codestra/sevdesk-mcp reports that
  `PUT /OrderPos/{id}` ignores a lone `price` and keeps the old value (community, not recorded).
- **Sources:** spec (position models; Invoice tag, attribute table);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (request built by
  `src/document_payload/position.rs`, answer recorded in `tests/fixtures/write_invoice_save.json`);
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (`GET /InvoicePos`,
  2026-02-19);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts);
  recorded 2026-11-07, trial account, Update 2.0 (probe `write-position-price-fields`, in both
  write runs).
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
  (B8 safety net)"). Live: probe `write-position-price-fields`.

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
    emuuu/sevDesk.NET, and by us on 2026-11-07).
  - A draft without `creditNoteNumber` is accepted, but finalizing it is unreliable (D-027,
    D-068). On a small-business account, a `PROVISION` credit note with rule 9 cannot be finalized
    (D-067).
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
  [emuuu/sevDesk.NET recorded responses](https://github.com/emuuu/sevDesk.NET) (the 422);
  recorded 2026-11-07, trial account, Update 2.0 (probes
  `write-credit-note-without-delivery-date`, `write-numbering-credit-note`).
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
  ("refuses ACCOUNTING_TYPE credit notes (not supported on Update 2.0)"). Live: probe
  `write-credit-note-without-delivery-date`. Royalty categories: pending (no probe).

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
  onto a document saved without one (jernoxit/sevdesk-rs, Update 2.0, answers recorded; confirmed
  by our recording: with the fields, `address` null and the street, zip, city and name stored;
  without them, all of them null).
  codestra/sevdesk-mcp reports that `takeDefaultAddress: true` leaves an order's recipient block
  empty. Every working order body sends `mapAll` on its positions (codestra/sevdesk-mcp and a
  production product configurator; community, not recorded). `saveInvoice`, `saveVoucher` and
  `saveCreditNote` keep `costCentre` on create and on updates with the id, also when an update
  leaves it out; `saveOrder` drops it (recorded 2026-11-16, D-092). Not recorded: which address
  is printed when the text and the structured fields are both sent, and whether `saveInvoice`
  keeps `discountTime`.
- **Sources:** spec (`Model_Invoice`, `Model_creditNote`, `Model_Order`, `Model_OrderPos`,
  `Model_InvoiceResponse`; `saveInvoice` and `saveCreditNote` descriptions);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (requests built by
  `src/document_payload/`, answers recorded in `tests/fixtures/write_invoice_save.json` and
  `write_credit_note_save.json`);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts);
  recorded 2026-11-07, trial account, Update 2.0 (probe `write-draft-address-fields`); recorded
  2026-11-16, trial account, Update 2.0 (probe `write-cost-centre-documents`).
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
  address, type header, the peeked number"), `test/unit/tools/drafts/invoice-update-draft.test.ts`,
  `test/unit/domain/drafts/recipient.test.ts` ("prefers the invoice address (category 47) over the
  first one"), `test/unit/domain/document-positions.test.ts` ("composes the text from the
  structured parts when sevDesk sent no address (API drafts)"). Live: probe
  `write-draft-address-fields`; `costCentre`: probe `write-cost-centre-documents` (D-092). Which
  address is printed when text and fields are both sent, and `discountTime` on `saveInvoice`:
  pending (no probe).

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
  (jernoxit/sevdesk-rs, Update 2.0, answers recorded; every draft of our write probes on
  2026-11-07 had this shape and was accepted). Working `saveOrder` bodies leave
  `orderPosDelete` out entirely (community, not recorded). For `saveVoucher` the spec insists on
  the order of `voucherPosDelete` and `filename`; the recording shows that the order does not
  matter there either (D-026). Recorded 2026-11-16: `saveOrder` accepts `orderPosDelete: null`,
  and `discountSave` (as a list) followed by `discountDelete: null` after the position keys is
  accepted by all three factories (D-116).
- **Sources:** spec (`createInvoiceByFactory`, `createcreditNote`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`tests/fixtures/write_invoice_save.json`,
  `write_credit_note_save.json`); the order bodies named in D-052; recorded 2026-11-16, trial
  account, Update 2.0 (probe `write-document-discount`).
- **Impact:** Draft bodies end with `*PosDelete` (null on create) and never send
  `takeDefaultAddress` or `forCashRegister`; the strict body schemas in
  `src/domain/drafts/payloads.ts` have no such keys. `discountSave` and `discountDelete` follow
  the position keys only when the call sets, replaces or removes a discount on the whole document,
  in the recorded form of D-116; otherwise they are left out.
- **Test:** `test/unit/tools/drafts/invoice-create-draft.test.ts` ("prepares the recorded body
  with defaults and reads only"), `test/unit/tools/drafts/credit-note-create-draft.test.ts`
  ("prepares the recorded underachievement body: source invoice, its rule and rate"),
  `test/unit/tools/drafts/order-drafts.test.ts` ("prepares an offer: version 0, multi-line
  address, type header, the peeked number"). Every write probe that creates a draft (`draft()` in
  `scripts/lib/probes/core.ts`) sends this shape in the M3 recording session.

### D-054: Updating a draft through the save factories is barely documented

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** The `saveInvoice` description: `invoicePosDelete` deletes positions "as this
  request can also be used to update invoices", and for updates "feel free to contact our
  support". `Model_Invoice.id` is "Required if you want to create or update an invoice position
  for an existing invoice"; the InvoicePos tag shows an update as
  `{"invoice": {"id", "objectName", "mapAll": true}, "invoicePos": [...]}` (but see D-004).
  `saveCreditNote` says the same of credit notes. `saveOrder` says only "Creates an order to which
  positions can be added later", and `Model_Order.id` is `readOnly`. `saveVoucher` "can also be
  used to update draft vouchers". `invoicePosDelete`, `creditNotePosDelete`, `orderPosDelete` and
  `voucherPosDelete` are declared as one `{id, objectName}` object, not as a list. Nothing says
  whether fields left out of an update keep their values.
- **Actual behavior:** FSCreative/fs-creative updates invoice drafts in production with
  `saveInvoice` and `invoice.id`, and replaces all positions by sending `invoicePosDelete` as an
  array of `{id, objectName: "InvoicePos"}` (community, not recorded). For orders nothing is
  verified: codestra/sevdesk-mcp changes an order's own fields with `PUT /Order/{orderId}` and its
  positions one by one (`PUT /OrderPos/{id}` ignores a lone `price`, D-050). Recorded for
  invoices: `saveInvoice` with an existing draft's id and only a new `header` updates that draft
  in place (the answer names the same id) and keeps the fields it was not sent (head and foot
  text, payment term, note, contact). For orders it is unrecorded: the probe could not create an
  order draft (D-027). Recorded for vouchers (2026-11-08): `saveVoucher` with
  `voucher: {id, objectName, mapAll, status: 50}` and no other header field updated the draft in
  place and kept its header (description, supplier name, dates, tax rule); only the sums changed
  with the new position. `voucherPosDelete` must be an array: one `{id, objectName}` object was
  refused with 400 "voucherPosDelete expected array with 'id' and 'objectName'. integer given",
  while an array of them deleted the stored position, saved the new one and recomputed the
  voucher's sums in the same request. Recorded 2026-11-16: credit notes behave like invoices
  (header-only update in place, `creditNotePosDelete` only as an array; D-110), and a `saveOrder`
  with the order's id and no other header field was accepted (the `discountDelete` step of
  `write-document-discount`, D-116); omitted order fields are still unrecorded.
- **Sources:** spec (`createInvoiceByFactory`, `createcreditNote`, `createOrder`, `saveInvoice`,
  `saveOrder`, `voucherFactorySaveVoucher`, `Model_Invoice`, `Model_Order`; tag `InvoicePos`);
  [FSCreative/fs-creative](https://github.com/FSCreative/fs-creative) (`server.js`,
  `sevdesk-ops.js` at `2d776fa`, 2026-11-07);
  [codestra/sevdesk-mcp `src/tools/orders.ts`](https://github.com/codestra/sevdesk-mcp/blob/5de1725c4758ea102fce079329a05b26e5b0f1bb/src/tools/orders.ts);
  recorded 2026-11-07, trial account, Update 2.0 (probe `write-save-update-omitted-fields`);
  recorded 2026-11-08 (probe `write-voucher-update-draft`, second write run); recorded
  2026-11-16, trial account, Update 2.0 (probes `write-credit-note-update-draft`,
  `write-document-discount`).
- **Impact:** `sevdesk_invoice_update_draft` and `sevdesk_order_update_draft` update drafts with
  one `saveInvoice`/`saveOrder` request carrying the draft's id (not `PUT /Order/{orderId}` plus
  position requests, which can fail half-way). Every writable field the tools know is carried
  over from the stored draft (`src/domain/drafts/current.ts`), so the result does not depend on
  whether sevDesk keeps omitted fields; the stored number goes along unchanged (D-027). Positions
  are either left alone (`*PosSave` and `*PosDelete` null) or replaced as a whole: all stored
  positions in `*PosDelete` as an array of `{id, objectName}` and the new ones in `*PosSave`, in
  the same request. Only drafts are updated. If sevDesk's answer names another id, the call fails
  and names that document as written. `sevdesk_voucher_update_draft` works the same way with one
  `saveVoucher`: the stored header is carried over (`carriedVoucher` in
  `src/domain/drafts/voucher-current.ts`), and replaced positions go out with `voucherPosDelete`
  as an array (`voucherPosDelete` in `src/domain/drafts/voucher-payload.ts`).
- **Test:** `test/unit/tools/drafts/invoice-update-draft.test.ts` ("changes one field and carries
  every stored field over, positions untouched", "replaces all positions in one request (deletes
  the stored ones)", "fails loudly when sevDesk saved a different invoice"),
  `test/unit/tools/drafts/order-drafts.test.ts` ("carries the stored order over, keeps its number
  and replaces the positions", "fails loudly when sevDesk saved a different order"),
  `test/unit/tools/drafts/update-edges.test.ts`. Credit notes:
  `test/unit/tools/drafts/credit-note-update-draft.test.ts` ("changes one field and carries every
  stored field over, positions untouched", "replaces all positions in one request and checks them
  against the source invoice"), `test/regressions/credit-note-pos-delete-list.test.ts`. Vouchers:
  `test/unit/tools/vouchers/update-draft.test.ts` ("changes the Belegnummer and carries every
  stored field over, positions untouched", "replaces all positions in one request
  (voucherPosDelete lists the stored ones)", "fails loudly when sevDesk saved another voucher"),
  `test/unit/domain/vouchers-write.test.ts` ("deletes stored positions as an array of refs
  (assumption, D-054)"); live: probe `write-voucher-update-draft`. Orders and `orderPosDelete`:
  pending: recording session, probe `write-save-update-omitted-fields` (its order draft was
  refused without a number, D-027).

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
  `save-order-response.json` (built from the spec). `saveOrder`: pending: recording session, probe
  `write-numbering-order-draft` (the probe's order drafts were refused without a number, D-027;
  the manual save with a number was not recorded).

### D-056: Which day a `bookAmount` date means is undocumented

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `PUT /Invoice/{invoiceId}/bookAmount`, `PUT /CreditNote/{creditNoteId}/bookAmount`
  (and the voucher variant) take `date`: "The booking date. Most likely the current date."
  (`type: integer`; the voucher variant types it `type: string, format: date-time`). The unit and
  the time zone in which the timestamp becomes a calendar day are not stated; the answer's
  `bookingDate` is a date-time.
- **Actual behavior:** jernoxit/sevdesk-rs sends Unix seconds at 12:00 Berlin time
  (`1787652000` = 2026-08-25 12:00 CEST in its request test), and the recorded voucher booking
  answer has `bookingDate` at 12:00+02:00. sevdesk-rs measured that `getBalanceAtDate` cuts days
  in Berlin time. Recorded on 2026-11-07: a booking with the Unix seconds of 12:00 Berlin three
  days earlier (`1793790000`, 2026-11-04) set the invoice's `payDate` to
  `2026-11-04T12:00:00+01:00` and created a transaction with value and entry date 2026-11-04, so
  the noon timestamp keeps its calendar day. `bookAmount` also takes `dd.mm.yyyy`; the booking
  date is then 00:00 Berlin of that day. Vouchers (recorded 2026-11-08) took Unix seconds, an ISO
  date-time and `dd.mm.yyyy` alike: Unix seconds of 12:00 Berlin and the ISO date-time of that
  instant gave a `bookingDate` (and a created transaction, D-071) at 12:00 Berlin of that day,
  `dd.mm.yyyy` at 00:00. Whether sevDesk cuts a timestamp near midnight in Berlin time or in UTC
  is still not measured.
- **Sources:** spec (`bookInvoice`, `bookCreditNote`, `bookVoucher`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`tests/requests.rs`; README;
  recorded `tests/fixtures/write_voucher_book_amount.json`); recorded 2026-11-07, trial account,
  Update 2.0 (probes `write-book-amount-noon-date`, `write-book-amount`); recorded 2026-11-08
  (probe `write-voucher-book-amount`). Document dates: D-018.
- **Impact:** `bookingTimestamp` (`src/domain/lifecycle/payments.ts`) sends Unix seconds of 12:00
  Europe/Berlin on the booking day, so the calendar day is the same under either reading,
  including on daylight-saving changes. Vouchers get the same Unix noon, although their spec says
  date-time (`BOOKING_DATE_FORMATS` and `wireBookingDate` keep the format per kind). The date
  defaults to today in Berlin, and a future date draws a warning. `amount` goes out as a JSON
  number that is checked to equal the decimal exactly (`exactNumber`).
- **Test:** `test/unit/domain/lifecycle/payments.test.ts` ("bookingTimestamp": "is 12:00 Berlin
  time in winter and summer", "keeps the calendar day on DST transition days"; "books the whole
  open amount as FULL_PAYMENT, signed positive, at noon Berlin"),
  `test/regressions/b7-payment-linking.test.ts` ("sends the transaction as an {id, objectName}
  reference next to the check account": `date` 1793617200),
  `test/unit/tools/lifecycle/book-payment.test.ts` ("defaults the booking date to today (Berlin)
  and warns about future dates"), `test/unit/domain/lifecycle/vouchers.test.ts` ("writes the
  booking date as Unix noon, or as ISO when a kind is switched to it"). Live: probes
  `write-book-amount-noon-date`, `write-book-amount`, `write-voucher-book-amount`.

### D-057: Transactions report no assigned or remaining amount

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `Model_CheckAccountTransactionResponse.status` is "100 Created, 200 Linked, 300
  Private, 350 Auto-booked without user confirmation, 400 Booked" (350: D-031). No field says how
  much of a transaction is already assigned to documents, and nothing says what separates the
  statuses 200 and 400. The tag says a transaction can be linked to one or several documents.
  `CheckAccountTransactionLog`, which holds the assignments, is not in the spec.
- **Actual behavior:** 200 means partly assigned and 400 fully assigned: in a recorded transaction
  log (firsttris/haben, Update 1.0), a transaction split over two documents moved to `toStatus`
  200 with the first share and to 400 with the second. The assigned amounts are only in the
  undocumented `GET /CheckAccountTransactionLog?checkAccountTransaction[id]=…` (`amountPaid` per
  entry); its transaction filter works, a document filter does not exist (sevdesk-rs, measured).
  Recorded on Update 2.0 (2026-11-08):
  - Without a filter the log lists every entry of the account, with a `countAll` total and
    `limit`/`offset` paging. An entry has `id`, `objectName`, `additionalInformation`, `create`,
    `checkAccountTransaction`, `fromStatus`, `toStatus`, `amountPaid`, `bookingDate`, `sevClient`
    and `object`: the booked document (`Invoice`, `Voucher`, …), not the transaction.
  - `amountPaid` is a JSON number signed like the transaction: −119 for an expense voucher paid
    from an outgoing transaction, 119 for invoices paid from an incoming one.
  - A +238 transaction split over two invoices of 119 (type `N`, D-075) went to 200 after the first
    booking and to 400 after the second, one entry each. Both entries say `fromStatus` 100 (the
    second one not 200); `toStatus` is 200 and 400.
  - The filter `checkAccountTransaction[id]` was honored (totals 1, then 2, in an account log of
    more than 20 entries); `object[id]`, `invoice[id]` and `createAfter` were ignored; `startDate`
    was honored (a date in the future returned no entry). Marking a transaction private writes no
    entry (D-076).
- **Sources:** [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md)
  ("Zahlungen", real answers in firsttris/haben#343) and its transaction-log fixture;
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/transaction.rs`); recorded 2026-11-08, trial account, Update 2.0 (probes
  `read-transaction-log`, `write-transaction-split-booking`, `write-transaction-split-variants`,
  `write-voucher-book-amount`; `test/fixtures/recorded/2026-11-08/banking/transaction-log.json`,
  `transaction-log-unfiltered.json`).
- **Impact:** The payment tools (`sevdesk_{invoice,credit_note,voucher}_book_payment`) link only a
  free transaction: status 100, not enshrined, on the chosen check account, in the document's
  currency, moving money in the right direction, and at least as large as the payment
  (`checkPaymentTransaction` in `src/domain/lifecycle/payments.ts`). A transaction at 200 is
  refused there. A larger transaction is booked with type `N` (D-075), and the preview says that
  the rest stays assignable to other documents. Bank reconciliation reads the log instead
  (`readTransactionLog`, `entryShare` and `remainingAmount` in
  `src/domain/reconciliation/transaction-log.ts`): it sends the transaction filter but re-checks
  every entry's transaction itself, takes the absolute `amountPaid` of entries in the
  transaction's direction as the assigned shares, and books a partly assigned transaction up to
  its rest (`planAllocation` in `src/domain/reconciliation/allocate.ts`). A log it cannot read
  completely or attribute makes the rest unknown, and the booking is refused.
  `sevdesk_transaction_get` shows the assignments, and the cash-basis reports take their payments
  from the log (`paymentsInPeriod`). `fromStatus` and `toStatus` are read but not relied on.
- **Test:** `test/unit/domain/lifecycle/payments.test.ts` ("checkPaymentTransaction": "refuses a
  partly assigned transaction", "warns when the transaction is larger than the payment"),
  `test/regressions/b7-payment-linking.test.ts` ("refuses a transaction that is partly assigned,
  without writing"). The log: `test/unit/domain/reconciliation/transaction-log.test.ts` ("reads
  the recorded entry shape", "drops entries of other transactions and then also those without a
  reference", "returns the absolute share of an entry in the transaction's direction", "subtracts
  the entries exactly for a partly linked transaction"),
  `test/unit/domain/reconciliation/allocate.test.ts` ("books the rest of a partly linked
  transaction (status 200) from its log", "refuses a transaction whose remaining amount is unknown
  or zero"), `test/regressions/over-booking.test.ts` ("refuses more than the rest of a partly
  linked transaction (remaining from the log)"), `test/unit/tools/banking/transaction-get.test.ts`
  ("shows the assignments with their documents and the remaining amount"),
  `test/contract/recorded-fixtures-m4.test.ts` ("reads the log of one transaction: signed
  amountPaid, object = the document", "parses every entry of the unfiltered log"). Live: probes
  `read-transaction-log`, `write-transaction-split-variants`.

### D-058: `cancelInvoice` answers and refusals are undocumented

- **Status:** Open. **Evidence:** spec + community + recorded (community recording).
- **Spec says:** `POST /Invoice/{invoiceId}/cancelInvoice` declares 201 "Created - Returns
  cancellation invoice" with a bare `Model_InvoiceResponse`, and 400, 401 and 500. It documents
  no refusal. What happens to the original: D-037.
- **Actual behavior:** The answer is 2xx (201 per sevdesk-rs) with the cancellation invoice (type
  SR, negated sums, status 1000, `origin` = the original) as one object, not an array, under
  `objects` (recorded by sevdesk-rs and by us; ours also carries `additionalInformation:
{creditVoucher: false}`). Measured refusals: a draft gets an error body inside HTTP 200 (code
  423), a partly paid invoice likewise (code 390), an invoice that is already cancelled 422 (code
  421), and an invoice a credit note refers to 422 (code 170).
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (recorded
  `tests/fixtures/write_invoice_cancel.json`; refusal codes in `src/error.rs`,
  `src/endpoints/invoice.rs` and the README, measured, not recorded); recorded 2026-11-07, trial
  account, Update 2.0 (probe `write-cancel-invoice`).
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
  unexpected_response"). Live: probe `write-cancel-invoice`. The refusals: not probed (they need a
  partly paid or credited invoice; sevdesk-rs measured them).

### D-059: `enshrine` is idempotent and does not block payments

- **Status:** Open. **Evidence:** spec + community + recorded.
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
  Our recording shows the payment part: on the trial account `sendBy` enshrined invoices and
  credit notes automatically (D-023), and payments booked afterwards still went through (a credit
  note paid out to 1000, an invoice paid and reset, D-060). `enshrine` itself is not probed.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/invoice.rs` `enshrine_invoice`; measured, not recorded); recorded 2026-11-07,
  trial account, Update 2.0 (`enshrined` and statuses in the recorded invoice and credit note
  lists; probes `write-credit-note-payout-sign`, `write-offline-booking-transaction`).
- **Impact:** `assertEnshrinable` (`src/domain/lifecycle/transitions.ts`) refuses drafts, lower
  statuses, recurring templates and documents that are already enshrined (nothing to do) before
  anything is sent. The preview is marked irreversible and says payments can still be booked
  afterwards. The tool reads the document back and ignores the answer. Enshrining is never
  probed, being irreversible (`NOT_PROBED` in `scripts/lib/probes/catalog.ts`).
- **Test:** `test/unit/domain/lifecycle/transitions.test.ts` ("accepts open and paid documents
  that are not enshrined", "refuses enshrined documents, drafts, low statuses and templates"),
  `test/unit/tools/lifecycle/enshrine.test.ts`, `test/contract/recorded-fixtures.test.ts`
  ("D-023, D-059: finalizing enshrined invoices and credit notes on the trial account, and
  payments were still booked").

### D-060: `resetToOpen` works on enshrined documents and unlinks payments silently

- **Status:** Open. **Evidence:** spec + community + recorded.
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
  - Recorded on Update 2.0: a paid invoice that `sendBy` had enshrined (D-023) was reset to open
    (status 200); afterwards its `paidAmount` was `null` (not 0) and its `payDate` null. The
    transaction sevDesk had created for the booking on an offline account was deleted (D-071).
  - Recorded for vouchers (2026-11-08): `resetToOpen` on an expense voucher paid on an offline
    account without a transaction answered the voucher (in `objects`) at status 100 with
    `paidAmount` 0 (a number, not `null` as on invoices) and no `payDate`; the transaction sevDesk
    had created for the booking was deleted (D-071). `resetToDraft` then set it to 50.
  - Recorded on invoices paid from file-import transactions (2026-11-08, D-075): after
    `resetToOpen` every linked transaction was back at 100. The account's unfiltered log had 24
    entries after the second write run and again after the split run, which booked four entries
    and reset all four invoices; that fits sevdesk-rs's finding that the entries are deleted.
  - Recorded with an enshrined payment transaction (2026-11-16, D-098): `resetToOpen` on the
    voucher it paid is refused with **400** "Already enshrined by transaction" (not 422 code 322
    as sevdesk-rs measured for invoices); the voucher stays paid.
  - Recorded on a cash register (2026-11-16, D-095): `resetToOpen` on a voucher paid there
    without a transaction keeps the transaction sevDesk created and books a counter-entry dated
    at the reset, instead of deleting it as on offline accounts.
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/invoice.rs`, `src/endpoints/transaction.rs`; measured, not recorded);
  [firsttris/haben `docs/sevdesk.md`](https://github.com/firsttris/haben/blob/main/docs/sevdesk.md)
  ("Aufgehobene Zuordnungen"); recorded 2026-11-07, trial account, Update 2.0 (probe
  `write-offline-booking-transaction`; the invoice in
  `test/fixtures/recorded/2026-11-07/invoices/invoices-list.json`); recorded 2026-11-08 (probes
  `write-voucher-reset`, `write-transaction-split-variants`, `read-transaction-log`); recorded
  2026-11-16, trial account, Update 2.0 (probes `write-transaction-enshrine`,
  `write-cash-register-transaction`).
- **Impact:** `assertResettable` (`src/domain/lifecycle/transitions.ts`): to open, it accepts paid
  and partially paid documents and open ones that still show payments, and refuses drafts,
  cancelled originals (1000 with `paidAmount` 0, D-037), cancellation invoices and recurring
  templates. It does not refuse enshrined documents; the preview warns that sevDesk may refuse.
  To draft, it accepts only open documents without payments that are not enshrined. The preview
  of a reset to open says that every payment is unlinked without a counter-booking, that
  transactions sevDesk created for payments on offline accounts are deleted (recorded, D-071)
  while a cash register keeps them and books a counter-entry dated at the reset (recorded,
  D-095), and that sevDesk refuses when a payment transaction is enshrined. That refusal (400
  "Already enshrined by transaction", recorded, D-098; 422 "… by payment", sevdesk-rs) becomes
  our own explanation (`resetDocument`). Code 170 is not checked locally.
  Vouchers follow the same rules (`sevdesk_voucher_reset`, with the voucher status codes).
  `sevdesk_transaction_reset` undoes a transaction's bookings by resetting each document it paid
  to open, and its preview names the other payments each reset removes as well
  (`planTransactionReset` in `src/domain/reconciliation/transaction-status.ts`).
- **Test:** `test/unit/domain/lifecycle/transitions.test.ts` ("resets paid and partially paid
  documents to open, enshrined ones included", "resets an open invoice that still shows payments
  (pre-4.181 partial payment) to open", "resets an open document without payments to draft",
  "tells credit notes to use a new document instead of resetting an enshrined one"),
  `test/unit/tools/lifecycle/reset.test.ts` ("resets a paid invoice to open and says its payments
  are unlinked", "allows resetting an enshrined paid invoice to open, with a warning", "refuses
  resets sevDesk would refuse or that make no sense"), `test/contract/recorded-fixtures.test.ts`
  ("D-060: an enshrined invoice reset to open reads back with paidAmount null and no payDate").
  Vouchers: `test/unit/domain/lifecycle/vouchers.test.ts` ("resets paid vouchers to open and open
  ones to draft"), `test/unit/tools/lifecycle/voucher-lifecycle.test.ts` ("resets a paid voucher to
  open (resetToOpen) with the voucher codes", "resets an open voucher without payments to draft
  (resetToDraft)"). Transactions: `test/unit/domain/reconciliation/transaction-status.test.ts`
  ("finds the other transactions on a document in the whole log and names them"),
  `test/unit/tools/banking/transaction-reset.test.ts` ("resets each document to open in order and
  reads everything back"). Live: probes `write-offline-booking-transaction`,
  `write-voucher-reset`, `write-transaction-split-variants`. Enshrined payment transactions are
  not probed (irreversible).

### D-061: `POST /Contact` assigns the next customer number

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** The Contact tag: "The customer number is not an attribute that must be supplied
  when creating a contact", and numbering by hand "is not the best idea"; it offers
  `Contact/Mapper/checkCustomerNumberAvailability` and `Contact/Factory/getNextCustomerNumber`. It
  does not say what sevDesk does when `customerNumber` is left out.
- **Actual behavior:** sevDesk assigns the next free customer number itself (jernoxit/sevdesk-rs,
  measured 2026-10-01; the answer is recorded). It is the number `getNextCustomerNumber` announced
  just before (recorded: announced 1006, the new contact got 1006; reading it does not reserve
  it). The `customerNumber` list filter matches exactly (sevdesk-rs).
- **Sources:** [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (README,
  `src/endpoints/contact.rs`, recorded `tests/fixtures/write_contact_create.json`); recorded
  2026-11-07, trial account, Update 2.0 (probe `write-contact-customer-number`, in both write
  runs).
- **Impact:** `sevdesk_contact_create` sends no `customerNumber` unless one is given
  (`src/domain/contacts-write.ts`). The preview shows the number `getNextCustomerNumber` announces
  and warns that sevDesk assigns the number on save. A given number that another contact has is
  refused (exact filter, checked again on every row).
- **Test:** `test/unit/tools/masterdata/contact-create.test.ts` ("previews an organisation with
  address and e-mail", "creates the contact, its billing address and e-mail, then reads it back":
  no `customerNumber` in the body, "refuses a customer number that is taken"),
  `test/contract/recorded-fixtures.test.ts` ("reads the next customer number"). Live: probe
  `write-contact-customer-number`.

### D-062: PUT on contacts, addresses and communication ways is a partial update

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `PUT /Contact/{contactId}` (`Model_ContactUpdate`),
  `PUT /ContactAddress/{contactAddressId}` (`Model_ContactAddressUpdate`) and
  `PUT /CommunicationWay/{communicationWayId}` (`Model_CommunicationWayUpdate`) have no required
  fields, and nothing says whether fields left out keep their values. `Model_ContactUpdate.name`
  says "the type of contact will depend on this attribute. If it holds a value, the contact will
  be regarded as an organization."
- **Actual behavior:** All three are partial updates: fields left out stay as they are. Sending
  `name` for a person sets `name`, but the contact stays a person (jernoxit/sevdesk-rs, measured
  2026-10-01, not recorded). Recorded for contacts: `PUT /Contact/{id}` with only `description`
  changed the description and kept name, customer number, category and status. `PUT /Contact/{id}`
  with only `parent` sets, changes and, with `parent: null`, clears a person's organisation
  (recorded 2026-11-16, D-083). Addresses, communication ways and `PUT /Part/{partId}`
  (`Model_PartUpdate`, no required fields either) are not measured by us.
- **Sources:** spec (the three update models); [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs)
  (`src/endpoints/contact.rs`, `src/document_payload/contact.rs`); recorded 2026-11-07, trial
  account, Update 2.0 (probe `write-contact-partial-update`, in both write runs); recorded
  2026-11-16, trial account, Update 2.0 (probe `write-contact-parent`).
- **Impact:** `sevdesk_contact_update` sends only the fields that change, to the contact, its
  billing address and its main communication ways (`src/domain/contacts-write.ts`). A text field
  is never cleared (empty strings are rejected by the input schema); what an update takes away is
  named in its `remove` argument: the link to a person's organisation (`PUT` with `parent: null`,
  D-083) and single addresses and communication ways (`DELETE`, D-084, sent after every other
  change). An update without changes is a validation error, and a person never gets an
  organisation name or an organisation a first or last name. `sevdesk_part_update` relies on the
  same reading for `PUT /Part/{partId}` (`src/domain/parts-write.ts`).
- **Test:** `test/unit/tools/masterdata/contact-update.test.ts` ("changes only the given fields of
  contact, billing address and main entries", "sends no contact PUT when only a communication way
  changes", "refuses an update that changes nothing", "never mixes the kinds of contacts"),
  `test/unit/tools/masterdata/part-update.test.ts` ("changes name, number, price and unit and
  keeps everything else"). Live: probes `write-contact-partial-update`, `write-contact-parent`
  (D-083). `PUT /Part/{partId}`:
  pending (no probe).

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
  to invoice. The 2026-11-07 session could not measure it: its order drafts were refused because
  `saveOrder` needs an order number (D-027).
- **Sources:** spec (`Model_CreateInvoiceFromOrder`, `createInvoiceFromOrder`). D-010 for the
  earlier required invoice id.
- **Impact:** `sevdesk_invoice_create_from_order` (`src/domain/derived-documents.ts`) always sends
  `partialType` (whole order RE, partial TR, advance AR) and sends `type` and `amount` only for TR
  and AR, as the part to invoice: a percentage up to 100, or a net or gross amount up to the
  order's total. The preview shows that amount. TR and AR invoices are offered only with tax rule
  1 or 11 (spec section "sevdesk-Update 2.0").
- **Test:** `test/unit/tools/masterdata/invoice-from-order.test.ts` ("creates partial and advance
  invoices with amount and amount type", "checks amounts against the mode and the order totals",
  "allows partial invoices only with tax rule 1 or 11"). Pending: recording session, probe
  `write-invoice-from-order` (no order could be created without a number; the probe needs the
  number reservation of D-066).

### D-064: Answers of the derived-document factories are partly undocumented

- **Status:** Open. **Evidence:** spec + community + recorded.
- **Spec says:** `POST /CreditNote/Factory/createFromInvoice` answers 201 with
  `{objects: {creditNote, creditNotePos, discount}}`. `POST /Invoice/Factory/createInvoiceFromOrder`
  and `POST /Invoice/Factory/createInvoiceReminder` answer 200 with a bare `Model_InvoiceResponse`.
  `createInvoiceReminder` requires `invoice[id]` and `invoice[objectName]` in the query and
  `{invoice}` in the body. Nothing says whether a payment can be booked on a reminder (type MA).
- **Actual behavior:** Recorded on 2026-11-07:
  - `createFromInvoice` answers as declared, `{objects: {creditNote, creditNotePos, discount}}`.
    The new credit note is a draft (100) of type `CN` with `origin` and `refSrcInvoice` both
    pointing to the invoice, the invoice's sums, and a number that sevDesk assigned without
    advancing the credit note counter (D-068). jernoxit/sevdesk-rs also allows a bare credit note
    as the answer (live, not recorded).
  - `createInvoiceReminder` answers with the reminder invoice itself, wrapped in `objects` (as in
    j-mastr/sevdesk-api#12), not a bare record. It accepts the invoice in the query and the body,
    in the query only, or in the body only. The reminder is type `MA`, status 100, `sumGross` 0
    (the original: 119), `origin` the invoice and `dunningLevel` 1; the default invoice list leaves
    it out (D-049). A payment can be booked on it and pays only the reminder (D-070).
  - No answer of `createInvoiceFromOrder` is recorded anywhere (D-063).
- **Sources:** spec (`createCreditNoteFromInvoice`, `createInvoiceFromOrder`,
  `createInvoiceReminder`); [j-mastr/sevdesk-api#12](https://github.com/j-mastr/sevdesk-api/pull/12);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) (`tests/number_probe/calls.rs`);
  recorded 2026-11-07, trial account, Update 2.0 (probes `write-credit-note-from-invoice`,
  `write-reminder`, `write-reminder-payment`).
- **Impact:** `createdDocumentId` (`src/domain/derived-documents.ts`) takes the new document's id
  from the record itself, from a nested `creditNote` or `invoice` member, or from either inside an
  array of one; an answer without an id is an `unexpected_response` error. The document is then
  read back by id. Reminders are requested with the invoice in the query and in the body (both
  forms work, so sending both is safe). Before creating, the tools look for documents already
  derived from the same source and refuse another one unless `allowDuplicate` (filters: D-035).
  After `createFromInvoice` and the read-back, the tool peeks the next credit note number and
  advances the counter once (`useNextNumber=true`) when it equals the new draft's number
  (`advanceCreditNoteCounter`; fix in this PR, D-068). The payment tool refuses to book on a
  reminder and points to the invoice it reminds of (`assertBookable` in
  `src/domain/lifecycle/transitions.ts`), since such a payment would leave the invoice unpaid
  (D-070).
- **Test:** `test/unit/tools/masterdata/credit-note-from-invoice.test.ts` ("accepts a plain credit
  note answer and reports it when the read-back fails"),
  `test/unit/tools/masterdata/invoice-from-order.test.ts` ("reads the id of a nested answer and
  reports the invoice when the read-back fails", "fails as unexpected_response when the answer has
  no id"), `test/unit/tools/masterdata/invoice-reminder.test.ts` ("creates the reminder with the
  invoice in query and body, and reads it back"), `test/unit/domain/lifecycle/transitions.test.ts`
  ("assertBookable": "refuses a reminder"). Live: probes `write-credit-note-from-invoice`,
  `write-reminder`, `write-reminder-payment`. `createInvoiceFromOrder`: pending: recording
  session, probe `write-invoice-from-order` (D-063).

### D-065: ReceiptGuidance tax rate words and paging are unspecified

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `ReceiptGuideDto.allowedTaxRules[].taxRates` is "An array of tax rates which are
  combinable with this tax rule", typed as strings, with only the example `ZERO`, `SEVEN`,
  `NINETEEN`; there is no enum. `allowedReceiptTypes` has only the example `EXPENSE`.
  `GET /ReceiptGuidance/forAllAccounts` declares no parameters, so no `limit` or `offset`, and no
  total.
- **Actual behavior:** A recorded `forAllAccounts` answer (Update 2.0) uses the words `ZERO`,
  `SEVEN` and `NINETEEN`, the receipt types `EXPENSE` and `REVENUE`, and ids as JSON numbers. Our
  recording (652 accounts, SKR04) has exactly the same words, types and number ids; words for
  other rates (5 %, 16 %) have not been seen. `forAllAccounts` ignores `limit` and always returns
  every account, without a `total`: 647 rows without `limit`, with `limit=5` and with
  `limit=1000` alike (652 after the write run).
- **Sources:** spec (`ReceiptGuideDto`, `forAllAccounts`);
  [jernoxit/sevdesk-rs](https://github.com/jernoxit/sevdesk-rs) `tests/fixtures/receipt_guidance.json`;
  recorded 2026-11-07, trial account, Update 2.0 (probe `read-receipt-guidance-limit`, in three
  runs; `test/fixtures/recorded/2026-11-07/meta/receipt-guidance-all.json`).
- **Impact:** `src/domain/receipt-guidance.ts` maps `ZERO`, `FIVE`, `SEVEN`, `SIXTEEN` and
  `NINETEEN` and numeric strings to rates and keeps unknown words apart (`unknownTaxRates`), so
  `checkAccountTaxRule` warns instead of failing on them; ids may be strings or numbers. It reads
  one page with an explicit `limit=1000` (D-019) and reports a full page or a larger total as
  truncated; `validateAccountTaxRule` then downgrades an unknown account to a warning. Since
  sevDesk ignores the limit and sends everything, the list is complete in practice; only an
  account with 1,000 or more guidance rows would be flagged as truncated without being so, which
  errs on the safe side. The guidance serves `sevdesk_reference_lookup`
  (`kind: receipt_guidance`) and the account check of every voucher write (`checkVoucherAccounts`,
  D-006); since sevDesk accepts any account × rule on a voucher draft (recorded 2026-11-08, D-006),
  that check is the only guard. Its rates for intra-EU acquisitions and reverse charge: D-078.
- **Test:** `test/unit/domain/receipt-guidance.test.ts` ("parses the recorded forAllAccounts
  response into compact guides", "accepts string ids, numeric rates, null lists and keeps unknown
  rate words apart", "warns instead of failing when the allowed rates contain unknown words",
  "reports a full page or a larger total as truncated", "downgrades an unknown account to a
  warning when the guidance was truncated"), `test/unit/tools/meta/reference-lookup.test.ts`,
  `test/contract/recorded-fixtures.test.ts` ("parses every recorded ReceiptGuidance row without
  unknown tax rate words"), `test/regressions/b2-account-datev.test.ts` (voucher writes against
  the recorded guidance). Live: probes `read-receipt-guidance-limit`,
  `write-voucher-invalid-account-rule`.

### D-066: Undocumented next-number endpoints peek or reserve

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** No operation returns the next order, credit note or invoice number. The Invoice
  and CreditNote tags point to `SevSequence/Factory/getByType`, which is not in the spec either
  (D-024, D-027). Only `Contact/Factory/getNextCustomerNumber` is documented.
- **Actual behavior:** Three GET endpoints exist, which the web app uses. Each answers the number
  as a bare string under `objects`:
  - `GET /Order/Factory/getNextOrderNumber?orderType=AN&useNextNumber=…` (e.g. `"AN-1000"`);
  - `GET /CreditNote/Factory/getNextCreditNoteNumber?useNextNumber=…` (e.g. `"GU-1002"`; the
    optional `creditNoteType=CN` gives the same answer);
  - `GET /Invoice/Factory/getNextInvoiceNumber?invoiceType=RE&useNextNumber=…` (e.g.
    `"RE-1012"`).

  `useNextNumber=false` only peeks: two calls in a row return the same number. `useNextNumber=true`
  returns the current number and advances the counter (`true` → `AN-1000`, then `false` →
  `AN-1001`; the same for credit notes, `GU-1003` → `GU-1004`). A GET with `useNextNumber=true`
  therefore changes state, like the GETs of D-023. Saving or finalizing an order with a peeked
  number does not advance the order counter (D-027); finalizing a credit note saved with a peeked
  number did (`GU-1002` → `GU-1003`).

  Recorded 2026-11-16 (offers and credit notes alike): after `useNextNumber=true` the peek shows
  the following number; saving a draft with the reserved number does not move the counter again;
  after that draft is deleted (D-109), the peek shows the **reserved number again**. The number
  reserved last, held by a draft that is then deleted, is handed out once more, so deleting that
  draft leaves no gap. Whether a number from further back comes back once later numbers were
  reserved was not recorded. Saving or deleting a draft with a peeked number moves nothing.

  Recorded 2026-11-18 for order confirmations (`orderType=AB`) and delivery notes (`LI`) the
  same way: `useNextNumber=true` returned the peeked number and moved the counter by one
  (`AB-0001` → `AB-0002`, `LI-0003` → `LI-0004`); saving a draft with it did not move it again;
  deleting that draft gave the number back (the peek showed `AB-0001` and `LI-0003` again). An
  `AB` or `LI` made by `createContractNoteFromOrder` or `createPackingListFromOrder` took the
  peeked number without moving the counter (D-027), so deleting it gave nothing back. Whether
  deleting a factory draft whose number was reserved afterwards gives the number back is not
  recorded.

- **Sources:** recorded 2026-11-07, trial account, Update 2.0 (probe `write-next-order-number`:
  two peeks, the same number); manual check (lead) of `useNextNumber=true`, the credit note and
  invoice endpoints, and saving and finalizing with peeked numbers; recorded 2026-11-16, trial
  account, Update 2.0 (probes `write-reserved-number-delete-draft`,
  `write-delete-draft-order-credit-note`); recorded 2026-11-18, trial account, Update 2.0 (probe
  `write-reserved-number-ab-li`, opt-in).
- **Impact:** The order and credit note draft tools peek the number for the preview and reserve
  it in execute, right before `saveOrder`/`saveCreditNote` (`peekNextNumber`,
  `reserveNextNumber` in `src/domain/drafts/numbering.ts`; D-027); invoices are never reserved,
  since `sendBy` numbers them. The credit note and order factory tools reserve once after their
  request to move the counter past the number sevDesk handed out (D-027, D-107). That
  `useNextNumber=true` reserves and advances is recorded for `orderType=AN`, `AB` and `LI` and the
  credit note counter, so the `AB` and `LI` reservations of the order draft tool and the order
  factory tools say that the counter moves; the same-number check after a confirmation or
  delivery note stays as a safety net for numbers shared from before and for the web app. A
  failure that may still have reserved a number says that the
  number may stay unused (a gap in the Nummernkreis). `resolveGetSafety` (`src/sevdesk/paths.ts`)
  treats any `getNext…Number` GET whose `useNextNumber` is not clearly off as a side effect of the
  `write` tier ("it reserves the next document number"): it is refused in read-only and dry-run
  mode, needs the calling tool's tier and is never retried. Only `useNextNumber` false is a read
  (recorded); an absent flag is treated as reserving because it was never measured, except on the
  documented `getNextCustomerNumber` (fix in this PR). The preview of
  `sevdesk_document_delete_draft` says no more than was recorded: a numbered order or credit note
  draft's number comes back only if it was the last one handed out, otherwise the range keeps a
  gap (D-109).
- **Test:** `test/unit/sevdesk/paths.test.ts`, `test/unit/sevdesk/client.test.ts`,
  `test/unit/sevdesk/scoped-client.test.ts` (side-effect classification),
  `test/unit/domain/drafts/numbering.test.ts`, `test/unit/tools/drafts/numbering.test.ts`;
  `test/unit/tools/documents/delete-draft.test.ts` ("says that the number of a numbered … draft
  comes back only if it was the last (D-066)") and the German preview in
  `test/integration/__snapshots__/write-previews-de.test.ts.snap` ("delete a numbered credit note
  draft"). Live: probe `write-next-order-number`, and the opt-in probe
  `write-reserved-number-delete-draft` (it consumes a number of each sequence; the catalog test in
  `test/unit/scripts/probes.test.ts` allows `useNextNumber=true` only through its helper). Order
  confirmations (AB) and delivery notes (LI): the opt-in probe `write-reserved-number-ab-li`
  (observed 2026-11-18: reserving moves the counter by one, deleting the draft gives the number
  back, factory copies move nothing; #134, #136; `test/unit/scripts/gaps-documents-probes.test.ts`,
  "reserves AB and LI numbers only when named…"); `test/unit/domain/order-follow-ups.test.ts` and
  `test/regressions/order-factory-number-counter.test.ts` pin the reservation after the factory
  request.

### D-067: `GET /SevClient` tells the taxation regime, and sevDesk checks it only when finalizing

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The spec has no `GET /SevClient` (only `PUT /SevClient/{SevClientId}/updateExportConfig`)
  and no other way to learn whether the account uses the small-business scheme (Kleinunternehmer,
  §19 UStG) or which chart of accounts it has, nor where the DATEV settings that
  `updateExportConfig` writes can be read back. Documents carry `smallSettlement`: "Defines if the
  client uses the small settlement scheme. If yes, the invoice must not contain any vat".
- **Actual behavior:**
  - `GET /SevClient` answers the account record (92 fields; recorded 2026-11-08 as a list of one
    under `objects`) with `smallSettlement` `"1"` on a small-business account and `"0"` with
    standard VAT, and `chartOfAccounts` (`"skr04"` on the trial account). The same record is
    embedded as `sevClient` in the `POST /Contact` answer.
  - None of the 92 fields holds the Ist/Soll choice (VAT on payments or on invoices), which the
    web app keeps in the company settings (recorded 2026-11-08).
  - The DATEV settings are `accountantNumber`, `accountantClientNumber` and `accountingYearBegin`,
    all `null` on a fresh trial. `updateExportConfig` sets them (answer `{objects: null}`, as
    declared); they read back as numeric strings and a date-time. The client id is `id`; the
    company data are `name`, `addressStreet`, `addressZip`, `addressCity`, `addressCountry`,
    `vatNumber`, `taxNumber`, `bankIban`, `bankBic`, `contactEmail` and `contactPhone`, most of
    them `null` on the trial; `type` is `"TRIAL"`.
  - On a small-business account, drafts with tax rule 1 and 19 % positions are saved without
    complaint, get VAT sums (D-050) and read back with `smallSettlement` `"0"`: the document field
    does not reflect the account's regime.
  - Finalizing them fails. Every `sendBy` of a rule-1 invoice was refused with 422 "Tax rule
    'USTPFL_UMS_EINN' is not valid for account '4400' with taxation scope 'SMALL_BUSINESS'.
    Allowed tax rules:" (the list was empty). A provision credit note with rule 9 got the same
    error for account '6770', naming rules 10 and 13 as allowed (D-006). Every lifecycle step
    after finalizing (payments, cancellation, credit notes from invoices) was therefore
    impossible on that account.
  - After the account was switched to standard VAT, the same kind of drafts finalized normally.
- **Sources:** spec (`Model_Invoice.smallSettlement`, `/SevClient/{SevClientId}/updateExportConfig`);
  recorded 2026-11-07, trial account, Update 2.0 (the write run while the account was still a
  Kleinunternehmer: probes `write-numbering-invoice`, `write-numbering-credit-note`,
  `write-book-amount` and the other probes that finalize; `POST /Contact` answers in the
  evidence); manual check (lead) of `GET /SevClient` (field names and the two values only);
  recorded 2026-11-08 (probes `read-sevclient-keys`, `write-export-datev-config`;
  `test/fixtures/recorded/2026-11-08/meta/sev-client.json`).
- **Impact:** `src/domain/account-settings.ts` reads `smallSettlement` and `chartOfAccounts` from
  `GET /SevClient` (cached per configuration for five minutes); the regime is never taken from a
  document's `smallSettlement`. The draft tools use it before anything else
  (`src/domain/drafts/tax.ts`): the default rule 1 becomes rule 11 (Kleinunternehmer) on a
  small-business account (`regimeDefaultRuleId`), a rule that does not fit the regime is refused
  with the rules that do (`checkTaxRuleRegime`), and provision credit notes on such an account take
  rule 10 (default) or 13. An update that keeps a stored rule that does not fit only warns. When
  `GET /SevClient` cannot be read, the tools warn that the regime is unknown instead of guessing.
  `sevdesk_account_info` shows `taxRegime` and `chartOfAccounts` (fix in this PR). The record is
  read as an object or as the first row of a list. The same cached read gives the company data
  (`loadAccountCompany`, used by the e-invoice preflight and the e-invoice import). The DATEV
  export reads the three DATEV settings fresh (`readDatevExportConfig` in
  `src/domain/exports/datev.ts`) and refuses to start without them (D-077). The VAT summary cannot
  learn the Ist/Soll choice, so it takes a `basis` input and defaults to accrual, saying so
  (`DEFAULT_VAT_BASIS` in `src/domain/reports/vat.ts`). `sevdesk_datev_settings_update` (a
  `commit` tool, `src/domain/exports/datev-settings.ts`) writes the three DATEV settings in the
  recorded form (JSON numbers, the fiscal-year start as Unix seconds of Berlin midnight), fills the
  ones not given from the current values (the spec requires all three) and warns when such a kept
  number lies outside DATEV's range, warns when a given fiscal-year start is more than a year
  away from today, refuses a call that changes nothing, and reads them back, comparing the
  numbers by value (a stored `01001` goes out as 1001).
- **Test:** `test/unit/domain/account-settings.test.ts` (including "takes a single object as well
  as the first row of a list, and lenient scalars", "maps every recorded company key, cleans text
  and compacts the IBAN"), `test/unit/tools/drafts/regime.test.ts`,
  `test/unit/domain/drafts/tax.test.ts`, `test/unit/domain/exports/datev.test.ts` ("reads the
  DATEV settings from GET /SevClient", "names every missing setting (null, zero, not digits,
  unreadable date)"), `test/unit/tools/reports/export-tools.test.ts` ("refuses with guidance when
  sevDesk's DATEV settings are missing"), `test/unit/domain/reports/vat.test.ts` ("fills every
  line from a mixed quarter and estimates Kz 83": the default basis and its note),
  `test/contract/recorded-fixtures-m4.test.ts` ("reads the regime, the chart of accounts and the
  company fields", "reads the DATEV export configuration the M4 probe set (D-067)"),
  `test/unit/domain/exports/datev-settings.test.ts`,
  `test/unit/tools/reports/datev-settings.test.ts`. Live: the
  write probes on a small-business account (all finalizing probes then fail with the 422 above);
  the draft tools refuse rule-1 drafts there; probes `read-sevclient-keys`,
  `write-export-datev-config`.

### D-068: Finalizing a credit note without a number fails with 500 or repeats a number

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_creditNote.required` lists `creditNoteNumber`, but `saveCreditNote`
  accepts a draft without one (D-027). `PUT /CreditNote/{creditNoteId}/sendBy` says only that it
  marks the credit note as sent; nothing says how a credit note without a number gets one.
- **Actual behavior:** Recorded in one write run on a standard-VAT trial account, in this order:
  1. The first credit note finalized without a number failed with HTTP 500 and a raw PHP error
     ("Model_Document_Factory::getDocument(): Argument #3 ($fileName) must be of type string,
     null given"). The write was not undone: right after, the credit note read back at status 200
     with a `sendDate` and send type `VPR`, still without a number (and not enshrined), and it
     stayed so.
  2. Moments later, `createFromInvoice` gave its new draft the number `GU-1000` (D-064). The
     credit note counter did not move.
  3. The next two credit notes saved without a number finalized normally (`sendBy` 200) and got
     numbers: the first got the same number as the draft from step 2, the second the next one.
     A peek afterwards returned `GU-1002`.
  4. A credit note saved with the peeked `GU-1002` finalized normally, and the counter moved on
     (D-066).

  Why the first `sendBy` failed and the later ones did not is not known; it was the account's
  first credit note to be numbered. The 500 reads like a validation error to the client (D-021),
  so a caller may believe nothing happened. Equal numbers are visible although the evidence is
  scrubbed: the scrubber replaces every distinct number with one fake (`scripts/lib/scrub.ts`), and
  both the probe report and the recorded credit note list show the same fake for the draft of step
  2 and the first credit note of step 3.

- **Sources:** recorded 2026-11-07, trial account, Update 2.0 (probes `write-numbering-credit-note`,
  `write-credit-note-from-invoice`, `write-credit-note-payout-sign`;
  `test/fixtures/recorded/2026-11-07/credit-notes/credit-notes-list.json`); manual check (lead) of
  the counter.
- **Impact:** `sevdesk_credit_note_create_draft` reserves its number with `useNextNumber=true`;
  `reserveFreeCreditNoteNumber` (`src/domain/drafts/numbering.ts`) checks it against the existing
  credit note numbers and reserves again, up to five times, if it is taken, and reports the
  skipped numbers. After `createFromInvoice`, the counter is advanced once when the next number
  equals the new draft's number (`src/domain/derived-documents.ts`). The credit note finalize and
  send-email tools refuse a draft without a number before sending
  (`src/domain/lifecycle/transitions.ts`), so the 500 path is never taken (fix in this PR). A
  credit note that an earlier failure left open without a number has to be corrected in the web
  app.
- **Test:** `test/contract/recorded-fixtures.test.ts` ("D-068: the credit note whose sendBy failed
  with HTTP 500 is open (200), sent and has no number", "D-068: a draft from createFromInvoice and
  a later credit note finalized without a number share one number");
  `test/unit/domain/drafts/numbering.test.ts`, `test/unit/tools/drafts/numbering.test.ts`,
  `test/unit/tools/masterdata/credit-note-from-invoice.test.ts`,
  `test/unit/tools/lifecycle/finalize.test.ts`, `test/regressions/b4-numbering.test.ts`. Whether
  the counter advance after `createFromInvoice` prevents the collision live: pending: recording
  session (the lead's live re-run).

### D-069: `sendViaEmail` answers an `Email` record; refusals leave the document unchanged

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /Invoice/{invoiceId}/sendViaEmail` (and the credit note and order variants)
  answers 201 with a bare `Model_Email` (`id`, `objectName`, `create`, `update`, `object`, `from`,
  `to`, `subject`, `text`, `sevClient`). It documents no refusals and does not say what the call
  does to the document's status, send date or send type.
- **Actual behavior:** Recorded for invoices on a trial account, three outcomes:
  - Success (to the trial account's own login address): the answer is wrapped in `objects`
    (D-001): an `Email` record with `id`, `objectName`, `additionalInformation`, `create`,
    `update`, `object` (the whole invoice), `from`, `to`, `subject`, `text` and `sevClient`. On an
    invoice that was already finalized, `sendType` changed from `VPR` to `VM`; status and
    `sendDate` stayed.
  - The account's sevDesk sender address is not confirmed yet: 400 "Confirm your email address to
    send mails.".
  - After confirming, on the trial account, any other recipient (here the operator's own private
    address): 400 "During the test phase, you can only send emails to your own email address."
  - Both refusals left the invoice's status, `sendDate`, `sendType` and `update` unchanged: a
    refused send does not mark or finalize anything.

  Not recorded: e-mailing a draft (whether that finalizes it), and the credit note and order
  variants.

- **Sources:** spec (`sendInvoiceViaEMail`, `Model_Email`); recorded 2026-11-07, trial account,
  Update 2.0 (probe `write-send-email-shape`, three runs).
- **Impact:** The send-email tools (`src/tools/lifecycle/send-email.ts`) ignore the answer apart
  from the envelope and read the document back. A refusal is a 4xx and arrives as a validation
  error with sevDesk's message as untrusted text; since nothing changed, the call can be repeated
  once the cause is fixed. The tools treat e-mailing a draft as finalizing it and ask for the
  `commit` tier too, which stays the cautious reading until a recording shows otherwise.
- **Test:** `test/unit/tools/lifecycle/send-email.test.ts` ("posts exactly the email body, stamped
  external, and reads the invoice back", "refuses a draft when only external (not commit) is
  enabled: sending would finalize it"). Live: probe `write-send-email-shape` (only to the
  account's own address on a trial). Drafts, credit notes and orders: pending:
  recording session (not probed: the probe e-mails one finalized invoice only).

### D-070: A payment on a reminder (MA) pays only the reminder

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** Nothing about booking payments on a dunning invoice (`invoiceType` `MA`). The
  reminder's sums and its link to the invoice it reminds of are not described (D-049, D-064).
- **Actual behavior:** A reminder finalized with `sendBy` accepts `bookAmount`: booking 1.00
  moved the reminder to status 1000 with `paidAmount` 1, while the invoice it reminds of stayed
  open (200) with `paidAmount` 0. The reminder's own `sumGross` is 0, so the payment counts
  against the reminder, not the debt.
- **Sources:** recorded 2026-11-07, trial account, Update 2.0 (probe `write-reminder-payment`).
- **Impact:** The payment tool refuses to book on a reminder and points to the invoice it reminds
  of (`assertBookable` in `src/domain/lifecycle/transitions.ts`), so a customer's payment always
  lands on the invoice.
- **Test:** `test/unit/domain/lifecycle/transitions.test.ts` ("assertBookable": "refuses a
  reminder"). Live: probe `write-reminder-payment`.

### D-071: A booking without a transaction creates one, and `resetToOpen` deletes it

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `bookAmount` takes `checkAccount` and an optional `checkAccountTransaction`. Only
  the voucher variant says what happens without one: a transaction "is required for online
  checkaccounts"; for other account types "the transaction will be created automatically".
  `resetToOpen` says "Linked transactions will be unlinked" (D-060).
  `POST /CheckAccountTransaction` "should only be used with check account type online, preferably
  for csv import accounts" and declares no 422.
- **Actual behavior:** `bookAmount` on an offline account (type `offline`) without a transaction
  creates a booked `CheckAccountTransaction` itself: the booked amount, status 400, value and
  entry date on the booking day (D-056), the contact as counterparty. `resetToOpen` on the invoice
  deletes that transaction again (it is gone from the account), unlike a linked bank transaction,
  which only returns to status 100 (D-060). Cash registers (type `register`) create the
  transaction the same way, but `resetToOpen` does **not** delete it there: it books a
  counter-entry (recorded 2026-11-16, D-095). Recorded for vouchers (2026-11-08): every booking on the
  offline account without a transaction created one with the signed amount (−10, −119) at
  status 400, and `resetToOpen` deleted it. A transaction cannot be made by hand on such an
  account: `POST /CheckAccountTransaction` on the offline account is refused with 422 "You can
  only create transactions on online checkaccounts. Use document bookAmount to create
  transactions on other types." On a file-import account (created with
  `POST /CheckAccount/Factory/fileImportAccount`: type `online`, import type CSV) it creates the
  transaction at status 100. Cash registers and clearing accounts refuse the POST with the same
  422 (recorded 2026-11-16, D-095, D-097). The answer of that POST (recorded 2026-11-17, body
  with `mapAll: true`, both dates as UTC ISO at 11:00Z, `amount: -12.34`, `status: 100`, with and
  without `paymtPurpose`) is 2xx with `objects` as one object, the new row itself, with the keys
  of a GET row (`id` … `deletedAt`, `restoredAt`): `amount` the string `"-12.34"`, `status` 100,
  `valueDate` `…T12:00:00+01:00` (noon Berlin, as sent); without a purpose `paymtPurpose` is
  null. A GET by id of the new row answers an array of one, as usual (D-001).
- **Sources:** spec (`bookInvoice`, `bookVoucher`, `invoiceResetToOpen`, `createTransaction`);
  recorded 2026-11-07, trial account, Update 2.0 (probes `write-offline-booking-transaction`,
  `write-book-amount-noon-date`; `test/fixtures/recorded/2026-11-07/banking/transactions-list.json`,
  transactions created this way); recorded 2026-11-08 (probes `write-voucher-book-amount`,
  `write-voucher-reset`, `write-transaction-create`, in both write runs); recorded 2026-11-16,
  trial account, Update 2.0 (probes `write-cash-register-transaction`,
  `write-check-account-factories`); recorded 2026-11-17, trial account, Update 2.0 (one-off check
  by the orchestrator, run tag `MCP-E2E 20261117-0037-nb2e`; the answer of the POST).
- **Impact:** The payment preview says that sevDesk creates a new transaction on offline accounts
  and a cash book entry on cash registers (`src/domain/lifecycle/payments.ts`). The reset
  previews say that such transactions on offline (clearing) accounts are deleted and that a cash
  register keeps them and books a counter-entry (D-095, D-060); `sevdesk_transaction_reset` names
  a deleted transaction as deleted. `sevdesk_transaction_create` (#88) sends
  `POST /CheckAccountTransaction` only for file-import accounts and refuses offline accounts, cash
  registers and bank-connected accounts before anything is sent, naming the payment tools that
  book on the document instead; it reads the new id from the recorded answer (the row as one
  object, `createdTransactionId`; an array of one or a nested row are only tolerated) and reads
  the row back. `sevdesk_reconcile_suggest` says that offline and cash accounts get their
  transactions from bookings.
- **Test:** `test/unit/domain/lifecycle/payments.test.ts` ("warns that sevDesk creates a
  transaction on offline and cash accounts"),
  `test/unit/domain/reconciliation/transaction-status.test.ts` ("warns that sevDesk deletes
  transactions it created on offline and cash accounts"),
  `test/unit/tools/banking/transaction-reset.test.ts` ("reports a transaction sevDesk deleted with
  the reset"). The 422: `test/regressions/manual-transactions.test.ts` ("a transaction is never
  created on a cash register, offline or bank-connected account"),
  `test/unit/domain/reconciliation/manual-transactions.test.ts` (`assertManualEntryAccount`); the
  answer: `test/fixtures/banking/transaction-create-5401.json` in
  `test/unit/domain/reconciliation/manual-transactions.test.ts` ("creates the row once and reads
  its id from the recorded answer…") and `test/unit/tools/banking/transaction-create.test.ts`; the
  live M4 scenario creates its transaction on a file-import account (`test/live/lifecycle.test.ts`).
  Live: probes `write-offline-booking-transaction`, `write-voucher-reset`,
  `write-transaction-create`, `write-cash-register-transaction` (cash registers; the simulated
  register in `test/unit/scripts/gaps-banking-probes.test.ts` replays its answers),
  `write-transaction-create-answer` (the answer of the POST recorded on 2026-11-17, with and
  without a purpose; confirmed 2026-11-18; `test/unit/scripts/gaps-banking-probes.test.ts`,
  "re-checks the facts recorded on 2026-11-16/17…").

### D-072: `getPdf` answers `mimetype` and `base64Encoded`, not the spec's casing

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `getPdf` answers of invoices, credit notes and orders (`invoiceGetPdf` and
  friends) declare `filename`, `mimeType`, `base64encoded` and `content`.
- **Actual behavior:** sevDesk sends `filename`, `mimetype` (all lower case), `base64Encoded`
  (capital E) and `content`, wrapped in `objects` (D-001), for all three document kinds
  (recorded). The community fixture `test/fixtures/documents/invoice-pdf.json` follows the spec's
  casing.
- **Sources:** spec (`invoiceGetPdf`, `creditNoteGetPdf`, `orderGetPdf`); recorded 2026-11-07,
  trial account, Update 2.0 (probe `read-getpdf-download`;
  `test/fixtures/recorded/2026-11-07/documents/*-pdf.json`).
- **Impact:** `fetchDocumentFile` (`src/domain/document-files.ts`) reads both spellings, the
  recorded one first, so its media-type and base64 checks run on sevDesk's real answers. The
  content check runs as well: the decoded bytes must start with `%PDF-`.
- **Test:** `test/contract/recorded-fixtures.test.ts` ("sevDesk sends mimetype and
  base64Encoded…", "refuses a non-PDF media type sent with sevDesk's recorded key casing"),
  `test/unit/domain/document-files.test.ts` (the spec's spelling: "accepts objects as an array of
  one, line-wrapped base64, base64encoded '1' and no mimeType").

### D-073: Vouchers are finalized through `saveVoucher`; `PUT /Voucher` refuses a status

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** Vouchers have no finalize (`sendBy`) endpoint. `PUT /Voucher/{voucherId}` says
  "You can not change the status using this endpoint", yet its `Model_VoucherUpdate` declares
  `status` (50, 100, 1000; "Not supported in sevdesk-Update 2.0"). `saveVoucher` takes the
  statuses 50 and 100 and "can also be used to update draft vouchers", and `resetToDraft` says "To
  change to higher status use /Voucher/Factory/saveVoucher". That saving an existing draft with
  status 100 opens it is only implied. `saveVoucherResponse` declares `voucher`, `voucherPos` and
  `filename`, without the `objects` wrapper.
- **Actual behavior:** Recorded 2026-11-08:
  - `PUT /Voucher/{voucherId}` with `{status: 100}` on a draft answers 400 "You cannot change the
    status this way. Use /Voucher/Factory/saveVoucher instead." and changes nothing.
  - `saveVoucher` with the draft's `voucher.id` and `status: 100` (no other header field, no
    positions) moves it from 50 to 100. `saveVoucher` with status 100 and no id creates an open
    voucher directly; it reads back with `voucherNumber` and `enshrined` both `null`.
  - Both answers are `{objects: {voucher, voucherPos, vatdrop}}`: an undeclared `vatdrop`, as in
    the `saveInvoice` answer (D-055), and no `filename`.
  - sevDesk does not check the booking account against the tax rule on a draft (D-006).
- **Sources:** spec (`updateVoucher`, `Model_VoucherUpdate`, `voucherFactorySaveVoucher`,
  `saveVoucherResponse`, `voucherResetToDraft`); recorded 2026-11-08, trial account, Update 2.0
  (probes `write-voucher-finalize`, first write run; `write-voucher-open-directly`, second write
  run).
- **Impact:** `sevdesk_voucher_finalize` opens a draft with one `saveVoucher` carrying the draft's
  id, status 100 and every stored header field, positions untouched (`prepareVoucherFinalize` in
  `src/domain/drafts/voucher-finalize.ts`); it never sends `PUT /Voucher/{voucherId}`. Since sevDesk
  would not catch a wrong account × rule, the finalize checks the stored positions against
  ReceiptGuidance and the regime first. The HTTP client requires the `commit` tier for any
  `saveVoucher` body whose status is not 50 (`minimumWriteTier` in `src/sevdesk/paths.ts`), so a
  `write` tool cannot open a voucher. The voucher writes read only `voucher.id` from the answer
  (`savedDocumentId` in `src/domain/drafts/payloads.ts`) and read the voucher back.
- **Test:** `test/unit/tools/vouchers/finalize-delete.test.ts` ("books the draft with saveVoucher,
  its id, status 100 and the positions untouched", "is blocked for a write-tier client, and a draft
  body passes the write tier", "refuses a rule of the other direction and an account the guidance
  rejects (B2)"), `test/unit/sevdesk/paths.test.ts` ("needs commit for a saveVoucher that is not
  a draft (the voucher's finalize)"), `test/regressions/b2-account-datev.test.ts` ("checks a
  stored draft once more before it is finalized"). Live: probes `write-voucher-finalize`,
  `write-voucher-open-directly`.

### D-074: `DELETE /Voucher` deletes only drafts

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `/Voucher/{voucherId}` has only GET and PUT (D-024). Nothing says whether or when
  a voucher can be deleted.
- **Actual behavior:** Recorded 2026-11-08: `DELETE /Voucher/{voucherId}` on a draft (status 50)
  answers `{objects: [null]}`, after which GET answers 404. On an open voucher (100) it answers 409
  "Voucher can only be deleted in status 50 but is status 100", and the voucher stays. Whether
  the attached receipt file is deleted with a draft was not checked. Orders, credit notes and
  recurring invoice templates answer the same way (2026-11-16): `{objects: [null]}` for a draft,
  409 "… can only be deleted in status 100 but is status 200" otherwise (D-109, D-112).
- **Sources:** recorded 2026-11-08, trial account, Update 2.0 (probe `write-voucher-delete`: the
  draft case in both write runs, the open voucher in the second); recorded 2026-11-16, trial
  account, Update 2.0 (probes `write-delete-draft-order-credit-note`,
  `write-recurring-schedule-fields`).
- **Impact:** `sevdesk_voucher_delete_draft` refuses anything but a draft before sending
  (`prepareVoucherDelete` in `src/domain/drafts/voucher-finalize.ts`), sends the DELETE once,
  ignores its answer and confirms with a GET that the voucher is gone (`executeVoucherDelete`). A
  409 (the voucher was finalized in the meantime) becomes a trusted message that nothing was
  deleted. The preview warns that an attached receipt file may stay. `sevdesk_document_delete_draft`
  does the same for invoice, order and credit note drafts (D-109).
- **Test:** `test/unit/tools/vouchers/finalize-delete.test.ts` ("deletes a draft and confirms it is
  gone", "explains sevDesk's 409 for a voucher that is no draft anymore", "refuses an open
  voucher", "warns that an attached receipt may stay"); for invoices, orders and credit notes
  `test/unit/tools/documents/delete-draft.test.ts` and `test/regressions/delete-only-drafts.test.ts`
  (D-109). Live: probe `write-voucher-delete`.

### D-075: A `FULL_PAYMENT` must use the whole linked transaction; type `N` splits it

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `bookAmount` (invoices, credit notes, vouchers) takes a `type`: `FULL_PAYMENT`
  "Normal booking", `N` "Partial booking (historically used for normal booking)", `CB`, `CF`,
  `O`, `OF` and `MTC`, and an optional `checkAccountTransaction` to link. A transaction can be
  linked to several documents (D-057). Nothing says how the booked amount must relate to the
  linked transaction's amount, or which type books part of a transaction.
- **Actual behavior:** Recorded 2026-11-08 on a file-import (online) account:
  - `FULL_PAYMENT` of 119 on an invoice of 119, linked to a transaction of +238, is refused with
    422 "Payment difference amount must be 0.0 when using type 'NONE'"; nothing is booked and the
    transaction stays at 100. The same booking linked to a transaction of +119 works (invoice
    1000, transaction 400), as does a voucher paid with −119 from a transaction of −119.
  - Type `N` books part of a transaction and settles a document it covers: 119 of the +238
    transaction on invoice A (119) paid A (1000) and moved the transaction to 200; 119 more on
    invoice B (119) paid B and moved the transaction to 400, one log entry each (D-057).
  - `N` of 119 on an invoice of 238 with a +119 transaction left the invoice partly paid (750)
    and the transaction booked (400).

  Whether `CB`, `MTC`, `O` or `OF` work on part of a transaction was not measured.

- **Sources:** spec (`bookInvoice`, `bookCreditNote`, `bookVoucher`); recorded 2026-11-08, trial
  account, Update 2.0 (probes `write-transaction-split-booking`, second write run;
  `write-transaction-split-variants`, split run; `write-voucher-book-amount`).
- **Impact:** `planPayment` (`src/domain/lifecycle/payments.ts`) takes the linked transaction's
  amount: when the payment uses only part of it, a planned `FULL_PAYMENT` (or `N`) goes out as
  `N`, and Skonto, bank fees, other differences and reminder charges are refused, since their
  handling on part of a transaction is unknown (`transactionBookingType`). The payment tools and
  bank reconciliation share this rule; reconciliation books a split over several documents with
  `N` each (`planAllocation` in `src/domain/reconciliation/allocate.ts`). Payments from a larger
  transaction used to go out as `FULL_PAYMENT` and were refused live (fix in this PR).
- **Test:** `test/regressions/transaction-partial-use.test.ts` ("pays an invoice's open amount
  from a larger transaction with type N", "pays an expense voucher from a larger outgoing
  transaction with type N and a negative amount", "refuses a Skonto on part of a transaction
  before anything is sent"), `test/unit/domain/lifecycle/payments.test.ts` ("sends a payment of
  the whole open amount as N (FULL_PAYMENT would be refused, 422)", "keeps FULL_PAYMENT when the
  payment takes the whole transaction", "refuses a difference type on part of a transaction"),
  `test/unit/tools/lifecycle/book-payment.test.ts` ("pays the whole open amount from a larger
  transaction as N, the rest stays assignable", "refuses Skonto on part of a larger transaction"),
  `test/unit/domain/reconciliation/allocate.test.ts` ("books a transaction 1:1 as a full payment
  linked to it, amount defaulted", "splits one transaction over two invoices with type N, both
  settled"). Live: probe `write-transaction-split-variants`.

### D-076: Marking a transaction private changes only its status

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `PUT /CheckAccountTransaction/{checkAccountTransactionId}` takes
  `Model_CheckAccountTransactionUpdate`, whose `status` is 100, 200, 300 or 400 ("300 <->
  Private"). It does not say what setting a status does (a booking, a log entry), or whether 200
  and 400 may be set by hand. The answer is declared as a bare
  `Model_CheckAccountTransactionResponse`.
- **Actual behavior:** Recorded 2026-11-08 on an unlinked transaction (status 100) of a
  file-import account: `{status: 300}` is accepted and changes only `status`, with no log entry
  (D-057); `{status: 100}` restores the transaction exactly. The answer is the transaction,
  wrapped in `objects` (D-001). Setting 200 or 400 by hand, and status changes on booked
  transactions, were not tried: they would fake or change a booking.
- **Sources:** spec (`updateCheckAccountTransaction`, `Model_CheckAccountTransactionUpdate`);
  recorded 2026-11-08, trial account, Update 2.0 (probe `write-transaction-private-status`,
  second write run).
- **Impact:** `sevdesk_transaction_mark_private` sends exactly `{status: 300}` (the strict
  `statusPayload` in `src/domain/reconciliation/transaction-status.ts`), only for a transaction
  that is unbooked (100), not enshrined and not zero (`assertMarkablePrivate`);
  `sevdesk_transaction_reset` sets a private one back with `{status: 100}`. No other status is
  written by hand. A `PUT` on a transaction needs the `commit` tier (`minimumWriteTier` in
  `src/sevdesk/paths.ts`).
- **Test:** `test/unit/domain/reconciliation/transaction-status.test.ts` ("builds the strict
  private and unbooked bodies", "names a withdrawal for money out and a deposit for money in",
  "sets a private transaction back without reading its log"),
  `test/unit/tools/banking/transaction-private.test.ts` ("sends status 300 with the commit tier
  and reads the transaction back", "refuses what cannot be marked, before anything is sent"),
  `test/unit/tools/banking/transaction-reset.test.ts` ("sets a private transaction back to
  unbooked"), `test/unit/sevdesk/paths.test.ts` ("%s needs %s": `/CheckAccountTransaction/9`
  needs `commit`). Live: probe `write-transaction-private-status`.

### D-077: The DATEV export job starts with a POST, and its answers differ from the spec

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `GET /Export/createDatevCsvZipExportJob` (query `startDate` and `endDate` as Unix
  seconds, `scope`, `exportByPaydate`, `includeEnshrined`, `enshrineDocuments`,
  `includeDocumentImages`) answers the job id; "accountingYearBegin" must be set through
  `updateExportConfig` first. Then `GET /Progress/generateDownloadHash?jobId` and
  `GET /Progress/getProgress?hash` are declared to answer a list of `Export_Progress_Data`
  (integers `current` and `total`; done when `current` reaches `total`), and
  `GET /ExportJob/jobDownloadInfo?jobId` a list of `Export_Job_Download_Info` (`filename`, `link`,
  `linkExpireDate`; the description of `filename` is copied from the progress data). No error for
  a missing configuration is documented.
- **Actual behavior:** Recorded 2026-11-08:
  - A GET of the job start is refused with 500 "Function createDatevCsvZipExportJob was called
    with wrong HTTP Type". A POST with the same query parameters and no body starts the job;
    `objects` is the job id, a UUID string.
  - Without the DATEV settings (D-067) the POST fails with 500 "Call to a member function getIso()
    on null".
  - `generateDownloadHash` answers one object `{progressHash}`, not progress data; the hash is 40
    hex characters, `_` and the job id.
  - `getProgress` answers one object `{percent, current, errors, total, failure}`: `percent` and
    `current` are fractions on the way (35.29…, 82.35…), `total` is 100, `errors` a list and
    `failure` a boolean. A small export was done after four polls.
  - `jobDownloadInfo` answers one object `{jobId, linkExpireDate, link, filename}`:
    `linkExpireDate` an ISO date-time with offset about seven days ahead, `link` a presigned
    Amazon S3 URL on `sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com` (the host
    of the spec's example), `filename` like
    `BITTE-ENTPACKEN_Buchungsstapel_<accountant>_<client>_<from>_bis_<to>.zip`.
  - The link downloads without any credentials: 200, `Content-Type: binary/octet-stream`, a ZIP
    with `EXTF_Buchungsstapel_….csv` and `EXTF_GP_Stamm_….csv`.
  - An invoice and a voucher of the exported period read back unchanged (no visible "exported"
    mark).
  - The XML job (`createDatevXmlZipExportJob`, recorded 2026-11-16) starts with the same POST and
    answers the same job id, progress and download info with the same S3 host; its file is
    `BITTE-ENTPACKEN_Belegbilder_…zip` holding two inner `DATEV_…zip` files (D-102).
- **Sources:** spec (`exportDatevCSV`, `generateDownloadHash`, `getProgress`, `jobDownloadInfo`,
  `Export_Progress_Data`, `Export_Job_Download_Info`, `updateExportConfig`); recorded 2026-11-08,
  trial account, Update 2.0 (probe `write-export-datev-csv`: the GET in the first write run, the
  missing configuration in the second, the whole job in the opt-in DATEV run after
  `write-export-datev-config`); recorded 2026-11-16, trial account, Update 2.0 (probe
  `write-export-datev-xml`, opt-in).
- **Impact:** `sevdesk_datev_export` (`src/tools/reports/export-tools.ts`, a write tool) reads the
  DATEV settings first and refuses with guidance when one is missing (`readDatevExportConfig`),
  starts the job with a POST whose query comes from a fixed key list without `enshrineDocuments`
  (`startDatevExportJob`, `datevJobQuery` in `src/domain/exports/datev.ts`; never retried, D-023),
  polls the progress (a `failure` or errors end it) and the download info within a bounded wait
  (`waitForDatevExport`), and downloads the ZIP with `downloadPresignedExport`
  (`src/sevdesk/export-download.ts`): https only, exactly the recorded host, no redirects, no
  `Authorization` header, a size cap. The link is a secret for a week: it never appears in
  output, errors or logs. The file must start like a ZIP (`looksLikeZip`) and is written to
  `SEVDESK_OUTPUT_DIR`.
- **Test:** `test/unit/domain/exports/datev.test.ts` ("starts the job with a POST and the query,
  and reads the id", "builds the scope in the spec's order and never sends enshrineDocuments",
  "follows the progress to the end and returns the download info", "fails the job when sevDesk
  reports a failure: %j", "names every missing setting (null, zero, not digits, unreadable
  date)"), `test/unit/sevdesk/export-download.test.ts` ("accepts only https links to the recorded
  export host", "downloads without credentials, redirects or an Authorization header", "refuses
  redirects"), `test/unit/tools/reports/export-tools.test.ts` ("refuses with guidance when
  sevDesk's DATEV settings are missing", "starts the job with the write tier, downloads the ZIP
  and saves it under sevDesk's name", "refuses a download link to another host without fetching
  it"); fixtures `test/fixtures/exports/` (recorded shapes, fake values). Live: probe
  `write-export-datev-csv`; `test/live/lifecycle.test.ts` ("exports DATEV into the temporary
  output folder (or says the DATEV setup is missing)").

### D-078: ReceiptGuidance allows only 0 % for intra-EU acquisitions and reverse charge

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The expense table of the overview ("sevdesk-Update 2.0 → Tax Rules") allows the
  position rates 0, 7 and 19 % with rule 8 (Innergemeinschaftliche Erwerbe) and only 0 % with the
  reverse-charge rules 12, 13 and 14, whose names end in "0% (19%)". It does not say how the tax
  the recipient owes on such a purchase is recorded.
- **Actual behavior:** The recorded ReceiptGuidance (`forAllAccounts`, SKR04) allows only `ZERO`
  with rules 8, 12, 13 and 14 on every account that lists them, so an intra-EU acquisition cannot
  be booked at 7 or 19 % through the API either, contrary to the spec's table. Such positions
  carry 0 % and no tax, although the recipient owes the VAT (the "(19%)" in the names) and may
  deduct it as input VAT where the rule allows that. Where sevDesk records the owed tax is not
  visible through the API.
- **Sources:** spec overview (section "Tax Rules", expense table); recorded 2026-11-07, trial
  account, Update 2.0 (`test/fixtures/recorded/2026-11-07/meta/receipt-guidance-all.json`,
  `meta/tax-rules.json`).
- **Impact:** The voucher writes check every rate against the guidance (D-006, D-065), so rules 8
  and 12–14 are booked at 0 % only. The VAT summary (`src/domain/reports/ustva-boxes.ts`,
  `src/domain/reports/vat.ts`) puts a 0 % position under these rules into the acquisition or §13b
  lines and computes the tax the recipient owes at 19 % (`RECIPIENT_TAX_DEFAULT_RATE`), with the
  input VAT where the rule allows it; the report states this assumption. Positions with a real
  rate keep it.
- **Test:** `test/unit/domain/reports/ustva-boxes.test.ts` ("rule 8 (intra-EU acquisitions):
  89/93/95 with input VAT 61; 0 % taxed at 19 % (assumed)", "rules 12, 13, 14 (§13b): 84/85 + 67,
  84/85 without 67, 46/47 + 67"), `test/unit/domain/reports/vat.test.ts` ("reports a §13b service
  booked at 0 % under Kz 46/47 and 67"), `test/regressions/b2-account-datev.test.ts` ("refuses a
  rate the account does not allow with the rule": rule 8 at 19 % against the recorded guidance).
  That the recorded guidance allows only `ZERO` with rules 12–14 on every account: none yet — a
  contract test that collects the recorded guidance's rates per rule.

### D-079: `GET /AccountDatev` ignores its filters and lists fewer accounts than ReceiptGuidance

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** Nothing: the endpoint is undocumented (D-024). The Update 2.0 overview points to
  ReceiptGuidance for the accounts a receipt may use.
- **Actual behavior:** Recorded 2026-11-08 on the SKR04 trial: `countAll` gives a total of 100 (a
  JSON number); `limit=1000` reads 100 distinct rows, and `limit`/`offset` page. Every filter
  tried is ignored, the total staying 100: `deactivated=1`, `hidden=1`, `deprecated=1` (no row
  has these flags), `expenseAccount=1` (79 rows have it), `revenueAccount=1` (9),
  `assetAccount=1` (10) and `number=135` (1 row). ReceiptGuidance names 652 accounts on the same
  account, 569 of them not among the 100 `AccountDatev` rows (the recorded lists of 2026-11-07).
- **Sources:** recorded 2026-11-08, trial account, Update 2.0 (probe `read-account-datev-paging`);
  recorded 2026-11-07 (`test/fixtures/recorded/2026-11-07/meta/account-datev.json`,
  `meta/receipt-guidance-all.json`). Related: D-035 (ignored filters).
- **Impact:** `fetchAccountsDatev` (`src/domain/accounts-datev.ts`) sends no filter and pages with
  an explicit `limit` until the total, stopping at a page without new ids (an ignored `offset`)
  or at 10,000 rows; each row's kind and validity are read locally. `loadAccountsDatev` caches the
  list per configuration for 15 minutes. Previews name an account from this list and fall back to
  the guidance's number and name, then to the bare id (`voucherAccountLabel` in
  `src/domain/drafts/voucher-checks.ts`); which accounts a voucher may use comes from
  ReceiptGuidance only (D-006, D-065). When the list cannot be read, the voucher writes go on with
  the guidance's labels.
- **Test:** `test/unit/domain/accounts-datev.test.ts` ("pages until sevDesk's total with an
  explicit limit", "reports an ignored offset (no new ids) as truncated", "parses every recorded
  row through the production reader"), `test/unit/domain/vouchers-write.test.ts` ("falls back
  from AccountDatev to the guidance to the bare id"),
  `test/unit/tools/vouchers/create-draft.test.ts` ("keeps working when the undocumented
  AccountDatev list fails (labels from the guidance)"). Live: probe `read-account-datev-paging`.

### D-080: A voucher is booked only with a Belegnummer

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `Model_Voucher.description` ("the description of the voucher, essentially the
  voucher number") is optional, also in `saveVoucher`.
- **Actual behavior:** `saveVoucher` saves a draft (status 50) without `description`, but
  refuses to book it: status 100 answers 422 "Description must be given". Recorded 2026-11-10 on
  the trial account, Update 2.0: a draft created through the claude.ai connector without a
  Belegnummer, finalized after a browser approval.
- **Sources:** recorded 2026-11-10, trial account, Update 2.0 (M6 remote session, voucher
  160408733; sevDesk's message read from the client error).
- **Impact:** `prepareVoucherFinalize` (`src/domain/drafts/voucher-finalize.ts`) refuses a draft
  without a Belegnummer before the human is asked, naming `sevdesk_voucher_update_draft`
  (`number`). Creating a draft without one stays allowed (a receipt may lack a number until the
  user picks a reference), and its preview warns that finalizing will need it.
- **Test:** `test/unit/tools/vouchers/finalize-delete.test.ts` ("refuses a draft without a
  Belegnummer before anything is confirmed (D-080)"),
  `test/unit/tools/vouchers/create-draft.test.ts` ("warns that a draft without a Belegnummer
  cannot be finalized yet (D-080)").

### D-081: Converting a voucher draft to EUR clears foreign sums

- **Status:** Open (the spec remains silent; the draft conversion was verified).
  **Evidence:** spec + recorded.
- **Spec says:** `Model_Voucher` and `Model_VoucherUpdate` accept `currency`. A currency that
  differs from the account default needs `propertyExchangeRate` or
  `propertyForeignCurrencyDeadline` (the deadline takes precedence). `saveVoucher` can update
  draft vouchers. The spec does not say what is stored when the currency changes back to EUR,
  or whether old foreign sums and exchange-rate properties are cleared.
- **Actual behavior:** A tagged status-50 VOU draft was changed to USD with
  `propertyExchangeRate: 0.8`. Its GET returned EUR net/tax/gross `"80"`, `"15.2"`, `"95.2"`
  and foreign sums `"100"`, `"19"`, `"119"`. Resaving the full header with `currency: "EUR"`,
  all old positions deleted and one new gross EUR position of 119.50 stored `currency: "EUR"`,
  `status: "50"`, net `"100.42"`, tax `"19.08"`, gross `"119.5"`, and all three foreign
  sums `"0"`. The replacement position had those same EUR sums and zero foreign sums.
  `propertyExchangeRate` and `propertyForeignCurrencyDeadline` were absent from GET both before
  and after conversion: this verifies the resulting amounts, not whether hidden properties
  were cleared. No finalization, booking or export was performed.
- **Sources:** vendored spec (`Model_Voucher`, `Model_VoucherUpdate`, `voucherFactorySaveVoucher`),
  D-043, D-054; recorded 2026-11-13, trial account, Update 2.0
  (probe `write-voucher-convert-to-eur`).
- **Impact:** `sevdesk_voucher_update_draft` requires explicit `currency: "EUR"` and all positions
  with caller-supplied EUR amounts to convert a foreign-currency draft. It computes no exchange
  rate and never reuses stored amounts. The save carries the known writable header fields,
  replaces every position and omits the old foreign sums and exchange-rate properties. Both
  previews show the currency change, warn with the old foreign sums (zero and absent differ),
  and ask to check the saved EUR amounts. Read-back warns if the currency is still foreign.
  Non-EUR create, update and e-invoice import use the explicit rate/deadline and replacement
  position rules in D-082. Finalizing a foreign-currency voucher remains refused.
- **Test:** `test/regressions/voucher-convert-to-eur.test.ts` pins the outgoing payload, guards,
  bilingual warnings, decimal-safe totals and synthetic read-back/finalize path;
  `test/regressions/voucher-foreign-currency.test.ts` covers EUR-to-USD changes, the replacement
  requirement and the finalization refusal, including a currency change after preview;
  `test/integration/write-previews-de.test.ts` snapshots the German text.
  `test/unit/scripts/m4-probes.test.ts` checks the probe's replacement payload, draft guards and
  reporting of retained foreign fields. Live probe `write-voucher-convert-to-eur` ran on
  2026-11-13; its tagged draft is in the scrubbed report's cleanup list.

### D-082: Voucher exchange rates are not returned and updates reconvert positions

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_Voucher` and `Model_VoucherUpdate` accept a foreign `currency` with
  `propertyExchangeRate` or `propertyForeignCurrencyDeadline` (timestamp or `dd.mm.yyyy`, taking
  precedence over a rate). The rate direction, position amount currency and behavior when a
  save retains existing positions are not documented. The response model mentions the
  properties, but GET did not return either one.
- **Actual behavior:** The trial accepted a decimal string rate `"0.9"` for a new USD VOU
  draft with `creditDebit: "C"`, status 50 and one net-100 position at 19 %. Voucher and
  position GETs returned EUR sums net `"90"`, tax `"17.1"`, gross `"107.1"`, and foreign
  sums `"100"`, `"19"`, `"119"`. The rate therefore means **EUR per one USD**; input position
  amounts are USD, but plain stored position sums are EUR.
  Creating the same draft with only `propertyForeignCurrencyDeadline: "12.11.2026"` returned
  EUR sums `"90.18"`, `"17.13"`, `"107.31"` with the same USD foreign sums. A rate was applied,
  but its exact stored value is unknown: GET returned `currency` as the string `"USD"` and
  omitted both property fields in every case. Ratios of rounded totals do not establish the
  exact rate or a general rounding rule.
  Updating a rate-0.9 draft to string `"0.8"` with `voucherPosSave: null` and
  `voucherPosDelete: null` converted the existing EUR amounts again: EUR sums became `"72"`,
  `"13.68"`, `"85.68"`, and USD sums became `"90"`, `"17.1"`, `"107.1"`. A subsequent save
  with rate `"0.8"`, deletion of the original position and a replacement net-100 USD position
  stored the intended EUR `"80"`, `"15.2"`, `"95.2"` and USD `"100"`, `"19"`, `"119"`.
  Every observed voucher remained status 50.
- **Sources:** vendored spec (`Model_Voucher`, `Model_VoucherUpdate`, `Model_VoucherResponse`);
  recorded 2026-11-13, trial account, Update 2.0 (probes `write-voucher-usd-rate`,
  `write-voucher-usd-deadline`, `write-voucher-usd-rate-update`). The scrubbed report stays
  outside the repository; all four drafts from this run are listed there for cleanup.
- **Impact:** Create, update and e-invoice import accept foreign currencies with exactly one
  positive decimal-string rate (EUR per unit of the voucher currency) or exchange-rate date
  (serialized as `dd.mm.yyyy`). Explicit-rate previews show foreign totals and a decimal-safe,
  cent-rounded EUR equivalent labelled as computed by this server. Deadline-only previews say
  sevDesk chooses the rate and EUR amounts are known after saving. Both languages give the same
  facts and warnings. Read-back checks all three foreign sums exactly and each EUR sum against
  foreign × rate within one cent per sent position. This conservative tolerance covers possible
  per-position versus aggregate rounding: the probe returned cent-rounded values but did not
  establish a rounding order. Deadline saves and mismatches report the stored EUR totals and an
  approximate rate derived from rounded gross sums; this never claims to recover the exact rate.
  Every foreign-currency update requires a fresh rate or deadline and all positions in the target
  currency: GET omits the rate, and retaining positions on a save without a rate was not verified.
  Currency changes also require all positions. Finalizing foreign-currency vouchers remains
  refused. The probes never finalize, book, enshrine, e-mail or export; status-50 guards and cleanup
  registration apply to failed setup/read-back paths too.
- **Test:** `test/unit/scripts/m4-probes.test.ts` (D-082 cases) pins decimal string rate payloads,
  deadline-only payloads, updates with and without replacement positions, GET field reporting,
  cleanup registration and refusal to update after failed or non-draft setup. These synthetic
  tests check probe safety and reporting; the storage observations above come from the live run.
  `test/regressions/voucher-foreign-currency.test.ts` pins those recorded sums, exact string rates,
  deadline serialization, input validation, safe replacement updates, EUR rounding tolerance,
  bilingual mismatch notes and real-parser USD e-invoice imports. `test/write-cases/vouchers.ts`
  exercises USD creation, a rate change with all positions and USD import through the write flow;
  `test/integration/write-previews-de.test.ts` snapshots their German previews.

### D-083: `parent` on a contact is stored without checks, and clearing it drops the key

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_Contact.parent` and `Model_ContactUpdate.parent` (`{id, objectName:
"Contact"}`, nullable) are "the parent contact to which this contact belongs. Must be an
  organization." Nothing says what a person as parent, or a parent on an organisation, does, how
  a parent is removed, or how to list an organisation's contact persons (`GET /Contact` documents
  only `depth` and `customerNumber`).
- **Actual behavior:** `POST /Contact` with `parent: {id, objectName: "Contact"}` and
  `PUT /Contact/{contactId}` with only `parent` set and change it; a read shows
  `parent: {id, objectName: "Contact"}`, and `embed=parent` expands it to the whole contact. No
  other key names the parent. `PUT` with `parent: null` clears it: the `PUT` answer and every
  later read leave the key out entirely (absent, not `null`). sevDesk checks nothing: a person as
  parent (on `POST` and on `PUT`) and an organisation with an organisation as parent are accepted
  and stored as sent. `GET /Contact?depth=1&parent[id]=…&parent[objectName]=Contact` returns only
  the contacts of that parent. `PUT` answers the contact as one object.
- **Sources:** spec (`Model_Contact`, `Model_ContactUpdate`, `getContacts`); recorded 2026-11-16,
  trial account, Update 2.0 (probes `write-contact-parent`, `write-contact-parent-invalid`).
- **Impact:** `sevdesk_contact_create` and `sevdesk_contact_update` set `parent` from
  `parentOrganisationId` and refuse, before anything is sent, a parent that does not exist or is a
  person, the contact itself as parent and a parent on an organisation (sevDesk would store all of
  them). A missing `parent` key reads as "no organisation" (`parentOrganisationId` absent).
  `remove` kind `parentOrganisation` sends `PUT` with `parent: null`, after checking that the
  contact belongs to that organisation. `sevdesk_contact_delete` lists the contacts whose parent
  the contact is with the `parent[id]` filter and filters again locally (D-035), for persons too,
  since sevDesk stores a person as parent.
- **Test:** `test/unit/scripts/gaps-contacts-probes.test.ts` ("follows parent through create, set,
  change and clear and checks the parent filter", "reports wrong-sided parents as stored, as
  recorded, and a refusal with its message (D-083)"); its simulated account behaves as recorded.
  `test/unit/tools/masterdata/contact-create.test.ts` ("links a new person to its organisation and
  names it in the preview", "refuses %s (sevDesk would store it)"),
  `test/unit/tools/masterdata/contact-update.test.ts` ("moves a person to another organisation and
  names both", "removes the link with parent null and lists it as removed", "refuses %s (sevDesk
  would store it)"), `test/unit/tools/masterdata/contact-delete.test.ts` ("deletes an organisation
  and confirms with a read that it is gone (D-084)": the contact persons by the parent filter).
  Live: probes `write-contact-parent`, `write-contact-parent-invalid`.

### D-084: Deleting a contact deletes its addresses and communication ways

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `DELETE /Contact/{contactId}`, `/ContactAddress/{contactAddressId}` and
  `/CommunicationWay/{communicationWayId}` answer 200 with `objects` an array of `null` items, or
  400, 409 (Conflict) or 500. Nothing says what happens to a contact's addresses and communication
  ways, or whether the billing address, the main entry or the last entry may be deleted.
- **Actual behavior:** All three answer `{objects: [null]}`. Afterwards `GET` by id answers 404,
  and a second `DELETE` answers 404 "No Model_Contact with the id … was found" (the same pattern,
  `No Model_<name> with the id <id> was found`, for every resource probed in this session).
  Deleting a contact also deletes its addresses and communication ways (both 404 afterwards). An
  address can be deleted while it is the billing address (category 47) and while it is the last
  one; the contact stays. The main e-mail and then the last e-mail can be deleted; the other
  e-mail does not become main (`main` stays `"0"`), so a contact can be left without a main entry
  of a type. A contact a document references is not deleted (D-085). Deleting an organisation
  also deletes its contact persons (the persons whose `parent` it is): after `DELETE` of an
  organisation with one such person, neither referenced by a document, answered `[null]`, `GET` of
  the organisation and of the person both answered 404, and a `DELETE` of the person answered 404.
  Recorded again on 2026-11-18 with two persons: the `DELETE` answered a list of one, and the
  organisation and both persons read 404 afterwards. An organisation whose contact person a draft
  invoice names is not deleted at all: the `DELETE` is refused inside HTTP 200 ("Cannot delete
  because of existing necessary references", D-085), and afterwards the organisation, the person
  (still with the organisation as `parent`) and the invoice (status 100, still naming the person)
  are unchanged. Not measured: contact persons with addresses or communication ways of their own,
  and what deleting a person does to contacts stored with that person as `parent` (D-083).
- **Sources:** spec (`deleteContact`, `deleteContactAddress`, `deleteCommunicationWay`); recorded
  2026-11-16, trial account, Update 2.0 (probes `write-contact-delete`,
  `write-contact-delete-referenced`, `write-contact-address-delete`,
  `write-communication-way-delete`); the contact persons: recorded 2026-11-16, trial account,
  Update 2.0 (one-off check by the orchestrator, run tag `MCP-E2E 20261116-2319-p4jr`); recorded
  2026-11-18, trial account, Update 2.0 (probe `write-contact-delete-cascade`).
- **Impact:** `sevdesk_contact_delete` says in its preview that the addresses and communication
  ways go too, and for an organisation lists the contact persons that go with it (up to 20 by name
  and id, the rest counted; it refuses an organisation with more than 100, which it cannot all
  read) and says, in English and German, that sevDesk refuses the whole deletion and deletes
  nothing when a document uses the organisation or one of its persons. The refusal is reported
  as such (`stillReferenced`, D-085), never as a deletion. It reads the persons for a person too,
  since sevDesk stores a person as parent (D-083), and says that sevDesk may delete them with it
  (not measured). The approval is bound to the ids of
  those persons, so a person added in between asks again. Afterwards it reads each person back and
  says so when one is still there or could not be checked. A 404 on the DELETE counts as "already
  gone". Removing an address or way says when it removes the billing address or the main entry,
  since sevDesk elects no new one; when the same
  update gives a new value for that very entry, a new billing address or main entry is added
  instead of rewriting another one.
- **Test:** `test/unit/scripts/gaps-contacts-probes.test.ts` ("deletes contacts, addresses and
  communication ways and reports what is left"); `test/unit/tools/masterdata/contact-delete.test.ts`
  ("deletes an organisation with its contact persons and reads every one back (D-084)", "lists up
  to 20 contact persons by name and binds the approval to all of them", "refuses an organisation
  whose contact persons cannot all be read", "says so when a contact person is still there or
  could not be checked", "counts a 404 on the DELETE as already gone (D-084)", "shows, binds and
  reads back the contacts stored with a person as parent (D-083)");
  `test/unit/tools/masterdata/contact-update.test.ts` ("removes an address and the main e-mail
  last and says what is left", "warns when the billing address goes and nothing replaces it",
  "adds a new billing address when the billing address goes, and leaves the delivery address
  alone", "adds a new main e-mail when the main one goes, and leaves the other e-mail alone",
  "counts an entry sevDesk no longer has as already gone");
  `test/regressions/contact-delete-referenced.test.ts` ("refuses an organisation whose contact
  person a document uses: nothing deleted (D-084)": the preview warning in both languages and
  the HTTP 200 refusal through the real client). Live: the four probes above, and
  `write-contact-delete-cascade` for the contact-person cascade (observed 2026-11-18; #134,
  `test/unit/scripts/gaps-contacts-probes.test.ts`, "reports what deleting an organisation does
  to its contact persons (#134)").

### D-085: Refused deletes of referenced contacts and cost centres arrive as HTTP 200

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `DELETE /Contact/{contactId}` declares 409 (Conflict) next to 200. `/CostCentre`
  is not in the spec (D-091).
- **Actual behavior:** `DELETE /Contact/{contactId}` of a contact that a draft invoice
  references, and `DELETE /CostCentre/{costCentreId}` of a cost centre that a draft voucher uses,
  answer HTTP **200** with an error body ("Cannot delete because of existing necessary
  references") instead of `objects`. Nothing is deleted: the contact, the cost centre and the
  referencing document stay unchanged (the voucher keeps its `costCentre`). The same trap as the
  `cancelInvoice` refusals (D-058). The same HTTP 200 refusal comes for an organisation when a
  draft invoice names one of its contact persons; then the organisation and the person stay too
  (recorded 2026-11-18, D-084).
- **Sources:** spec (`deleteContact`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-contact-delete-referenced`, `write-cost-centre-delete`); recorded 2026-11-18, trial
  account, Update 2.0 (probe `write-contact-delete-cascade`).
- **Impact:** The client already turns a 2xx body with an `error` member and no `objects` into an
  `unexpected_response` error with status 200 and sevDesk's message as `upstreamMessage`
  (`readJsonEnvelope` in `src/sevdesk/client.ts`), so such a refusal never passes as a successful
  delete. `sevdesk_contact_delete` sends the `DELETE` once (never retried), reads the contact back
  and, while it is still there, reports `stillReferenced` with a note in its own words (sevDesk's
  text never reaches the result); when a contact person reads back as gone after the refusal, it
  no longer says that nothing was deleted. The cost-centre half stays for #87: its delete must
  report the refusal the same way.
- **Test:** `test/unit/sevdesk/client.test.ts` ("treats objects null next to an error as
  unexpected_response", "keeps sevDesk's error text from a 2xx error body as the upstream message
  only"); `test/unit/scripts/gaps-contacts-probes.test.ts` ("deletes contacts, addresses and
  communication ways and reports what is left", "deletes only its own cost centres, unused and in
  use"); `test/regressions/contact-delete-referenced.test.ts` ("is reported as a refusal in our
  words, not as a deletion, and never retried", through the real client);
  `test/unit/tools/masterdata/contact-delete.test.ts` ("reports sevDesk's refusal of a referenced
  contact in its own words (D-085)", "does not claim nothing was deleted when a contact person is
  gone after a refusal"); `test/regressions/contact-delete-referenced.test.ts` also for an
  organisation whose contact person is referenced (D-084). Live: probes
  `write-contact-delete-referenced`, `write-cost-centre-delete`, `write-contact-delete-cascade`.

### D-086: Custom contact fields: 30-character names, no contact embed, cascading deletes

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /ContactCustomFieldSetting` takes `name` (required, no length) and
  `description` and answers an array; the setting model has `name`, `identifier` and
  `description`. `POST /ContactCustomField` takes `contact`, `contactCustomFieldSetting`, `value`
  and `objectName`. `DELETE /ContactCustomFieldSetting/{id}` declares 409 (Conflict).
  `getReferenceCount` answers an integer. `findContactsByCustomFieldValue` requires `value` and
  `customFieldName`; `customFieldSetting[id]` is optional. Nothing says how a contact's values are
  read.
- **Actual behavior:**
  - Settings: a `name` longer than 30 characters is refused with 400 "Property 'name' is too long.
    Maximum for this property is 30"; exactly 30 is accepted. A second setting with the same name
    is accepted. `POST` and `PUT` answer one object (not an array) with `id`, `objectName`,
    `additionalInformation`, `create`, `update`, `sevClient`, `name`, `identifier` (filled by
    sevDesk), `description` and an undeclared `placeholder`. `PUT` with only `name` keeps the
    description. `getReferenceCount` answers a bare integer (`0`, `1`).
  - Values: `POST /ContactCustomField` answers one object with `contact` and
    `contactCustomFieldSetting` as `{id, objectName}` and `value`; `PUT` with only `objectName` and
    `value` changes the value and keeps both references. `GET /ContactCustomField` honours
    `contact[id]` + `contact[objectName]`, and `embed=contactCustomFieldSetting` expands the
    setting (name, identifier, …). No contact read shows custom fields: `GET /Contact/{id}` with
    `embed=contactCustomFields`, `customFields` or `contactCustomField` adds no key.
  - `findContactsByCustomFieldValue` answers a list of contacts and matches the whole value,
    ignoring case; a prefix finds nothing. It works with the setting id alone, the name alone, or
    both (the spec's required `customFieldName` is not needed with an id).
  - `DELETE` of a value or a setting answers `{objects: [null]}`; deleting a setting that a value
    uses succeeds and deletes the value too (no 409).
  - A `value` has at most 100 characters: `PUT /ContactCustomField/{id}` with 255 characters
    answers 400 "Property 'value' is too long. Maximum for this property is 100".
  - One value per setting and contact: a second `POST /ContactCustomField` for the same contact
    and setting answers 400 "Bad Request", and a read by contact shows one value.
  - Deleting a contact deletes its values: after `DELETE /Contact/{id}`,
    `GET /ContactCustomField/{valueId}` answers 404 ("No Model_ContactCustomField with the id …
    was found"), and the setting's `getReferenceCount` drops to the values other contacts still
    have.
  - `findContactsByCustomFieldValue` finds persons as well as organisations, and ignores `limit`
    and `offset`: with two matches, `limit=1` and `limit=1&offset=1` both answered both contacts.
  - Not measured: a length limit on `description`; whether `/ContactCustomField` answers on every
    sevDesk plan (only a trial account was available).
- **Sources:** spec (`ContactField` operations, `Model_ContactCustomField*`,
  `findContactsByCustomFieldValue`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-custom-field-settings`, `write-custom-field-values`; the settings list in
  `test/fixtures/recorded/2026-11-16/contacts/custom-field-settings.json`); the value limit, one
  value per setting, the contact delete and the search paging: recorded 2026-11-17, trial account,
  Update 2.0 (one-off check by the orchestrator, run tag `MCP-E2E 20261117-0019-efhb`).
- **Impact:** `src/domain/contact-custom-fields.ts`. `sevdesk_contact_get` reads a contact's
  values with one more request (`GET /ContactCustomField?contact[id]=…&contact[objectName]=Contact`
  and `embed=contactCustomFieldSetting`, filtered again locally, D-035) and shows each with the
  setting id and name; a failed read still returns the contact and says so. `customFields` of
  `sevdesk_contact_create` and `sevdesk_contact_update` names each field by setting id or name (a
  name at most 30 characters, matched ignoring case; one that no setting or two settings have is
  refused before any request; so is a value over 100 characters), `POST`s a value the contact
  lacks and `PUT`s only `objectName` and `value` of one it has, after the communication ways;
  `remove` kind `customField` deletes a value last, a 404 counting as already gone. Since a contact
  holds one value per setting, an update that sets a field and removes its value is refused (the
  new value would be added before the old one is gone); a contact with two values of one setting is
  refused for that setting as a defensive branch. `sevdesk_contacts_search` `customField` sends
  `customFieldSetting[id]` alone (exact value, any case, as the argument says), reads the answer
  once, cuts it at 1000 contacts with a note, and pages locally. `sevdesk_reference_lookup` kind
  `contact_custom_fields` lists the settings. Nothing writes a setting: deleting one would delete
  every value of it, so settings are defined in the sevDesk web app. The delete preview counts the
  values as deleted with the contact.
- **Test:** `test/contract/recorded-gaps-contacts.test.ts` (the recorded settings list: keys,
  scalar types, `identifier` and `placeholder`, through `sevdesk_api_get` and through
  `listCustomFieldSettings`); `test/unit/scripts/gaps-contacts-probes.test.ts` ("probes custom
  fields without putting their values into the report");
  `test/regressions/custom-field-settings-read-only.test.ts` ("no tool that works with custom
  fields sends anything but a GET to a setting"); `test/unit/tools/contacts/get.test.ts` ("returns
  the contact with addresses, communication ways and custom fields, GETs only", "drops other
  contacts' custom field values and cleans their text (D-035)");
  `test/unit/tools/masterdata/contact-custom-fields.test.ts` (create and update: values, order,
  refusals, partial writes, "refuses a value over 100 characters before any request, also past
  the schema", "refuses to set a field whose value the same update removes (one value per
  field)"); `test/unit/tools/contacts/search.test.ts` ("resolves the field by name and asks sevDesk
  with the setting id alone, GETs only", "reads the whole match set once and cuts a huge one at
  1000, saying so"); `test/unit/tools/masterdata/contact-delete.test.ts` ("says the custom field
  values go too, and when they could not be read (D-086)"); `test/unit/tools/meta/reference-lookup.test.ts`
  ("lists the account's custom contact fields with limit 1000, GET only (D-086)"). Live: probes
  `write-custom-field-settings`, `write-custom-field-values`, and `write-custom-field-limits`
  for the name and value limits, one value per setting, the search paging and both cascading
  deletes recorded on 2026-11-16/17 (confirmed 2026-11-18;
  `test/unit/scripts/gaps-contacts-probes.test.ts`, "re-checks the custom field facts of
  D-086…").

### D-087: `checkCustomerNumberAvailability` answers a bare boolean and needs a number

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `GET /Contact/Mapper/checkCustomerNumberAvailability` takes an optional
  `customerNumber` and answers `objects` as a boolean ("whether given customer number is
  available").
- **Actual behavior:** `objects` is a bare JSON boolean: `false` for a number a contact has, `true`
  for a free one. Without `customerNumber` it answers 400 "Invalid type of parameter". Whether the
  comparison ignores case is not measured (the used number had no letters).
- **Sources:** spec (`contactCustomerNumberAvailabilityCheck`); recorded 2026-11-16, trial
  account, Update 2.0 (probe `read-customer-number-availability`).
- **Impact:** No tool uses it yet. A check before creating a contact with a customer number must
  always send the number and read `true` as "free".
- **Test:** `test/unit/scripts/gaps-contacts-probes.test.ts` ("asks with the real customer number
  and keeps it out of the report"). Live: probe `read-customer-number-availability`.

### D-088: Tags are added by name through `Tag/Factory/create`, which reuses a tag

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /Tag/Factory/create` takes `name` and the required `object`
  (`{id, objectName}` of an Invoice, Voucher, Order or CreditNote) and answers a
  `Model_TagCreateResponse` (a TagRelation). Nothing says what an existing name does, or whether a
  tag can be given by id. `GET /Tag` takes `id` and `name`; `GET /TagRelation` documents no
  parameters. `Model_TagResponse` has no `objectType` and no usage count.
- **Actual behavior:**
  - The factory tags draft invoices, vouchers, orders (AN) and credit notes. The answer is one
    TagRelation object: `id`, `objectName: "TagRelation"`, `additionalInformation`, `create`,
    `tag: {id, objectName: "Tag"}`, `object: {id, objectName}`, `sevClient`.
  - It tags documents that are no longer drafts as well: an invoice at status 200 (type RE), a
    voucher at status 100 and a credit note at status 200; and the other order types: an order
    confirmation (AB, status 500) and a delivery note (LI, status 100).
  - A name that exists reuses that tag, ignoring case (the same name in upper case gave the same
    tag id) and accents (`… Café` on one document and `… Cafe` on another gave the same tag id);
    a new name creates the tag. Tagging a document that already has the tag answers its existing
    relation (same relation id): the call is idempotent.
  - Recorded 2026-11-18, each variant after its base name: `ß` for `ss`, the ligature U+FB01 for
    `fi` and a zero-width space inside the name reuse the base's tag (its name stays the base's);
    a soft hyphen inside the name and a doubled inner space create a new tag, named as sent.
    `GET /Tag?name=<variant>` found one row each time: the reused tag for the first three, the
    new tag (not the base's) for the last two.
  - An unfiltered `GET /TagRelation` is stable across offsets (recorded 2026-11-18, 23 rows):
    two reads with limit 1000 and pages of 3 gave the same ids in the same order, none missing or
    twice; the ids run neither ascending nor descending.
  - `{tag: {id, objectName: "Tag"}, object}` without `name` is refused with 400 "Invalid type of
    parameter": a tag is added by name only.
  - `GET /Tag` rows: `id`, `objectName`, `additionalInformation`, `create`, `name`, `objectType`
    (`null`), `sevClient`; no usage count. The `name` filter is honoured; `GET /Tag/{tagId}`
    answers one row.
  - `GET /TagRelation` honours `tag[id]` + `tag[objectName]`, `object[id]` + `object[objectName]`
    and `limit`, with `total`: a tag's usage count is the `countAll` total of its relations.
- **Sources:** spec (`createTag`, `getTags`, `getTagRelations`, `Model_TagResponse`,
  `Model_TagCreateResponse`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-tag-create-on-documents`, `write-tag-relation-filters`, `read-tag-lists`; the lists in
  `test/fixtures/recorded/2026-11-16/tags/`); recorded 2026-11-16, trial account, Update 2.0
  (one-off check by the orchestrator, run tag `MCP-E2E 20261116-2308-evj7`: finalized documents,
  AB and LI, accents); recorded 2026-11-18, trial account, Update 2.0 (probes
  `write-tag-name-matching`, `write-tag-relation-paging`).
- **Impact:** `sevdesk_document_tag` adds a tag by name to any document status and order type; its
  preview says whether the name is new or reuses a tag whose name differs only in case, accents
  or ß/ss (names are folded as measured: zero-width spaces dropped, NFKD, which also splits
  ligatures, combining marks dropped, lower case, ß as ss; `foldName` in `src/domain/tags.ts`).
  The same folding finds the tag to remove and the tag of the list filter (D-090); when several
  tags fold to one name, the exact spelling wins, otherwise the call is refused. Names are
  compared, and sent back, as sevDesk stores them, not in their cleaned form. A soft hyphen and
  inner spaces are kept, as sevDesk keeps them. When no tag matches but one does after also
  dropping the other invisible characters `cleanText` drops and spelling out æ, œ and ø (not
  measured), the preview says sevDesk may reuse it; whether the tag was created is decided
  afterwards by the tag id in sevDesk's answer. `sevdesk_tags_list` counts uses from the
  relations, read in pages of 1000, which the paging record makes safe.
- **Test:** `test/contract/recorded-gaps-contacts.test.ts` (both recorded lists: keys, references,
  no usage count, the object types; the probe `read-tag-lists` on them);
  `test/unit/scripts/gaps-contacts-probes.test.ts` ("tags documents of every kind, reuses a tag by
  name and removes one relation"). The tools: `test/unit/tools/documents/tag-tool.test.ts`
  ("previews a new tag as created by sevDesk and creates it with the factory", "reuses an existing
  tag in another letter case with its own spelling", "reuses an existing tag whose name differs
  only in accents (Café = Cafe, D-088)", "refuses a name two tags share, since sevDesk's pick is
  unknown, without naming it", "refuses to add when tags differ only in accents, since sevDesk's
  pick is unknown", "matches the name sevDesk stores and sends it back unchanged (invisible
  characters, spaces)", "does not take a cleaned name for the stored one, and says sevDesk may
  reuse that tag", "never matches the placeholder of a tag without a name", "reuses a tag spelled
  with ß for ss or with a zero-width space (recorded 2026-11-18, D-088)", "previews a soft hyphen
  and a doubled inner space as a new tag (recorded 2026-11-18, D-088)", "reports the tag sevDesk
  reused for a similar spelling, not a created one (Cæsar = Caesar)", "leaves tagCreated out when
  sevDesk used a tag beyond the tags read"),
  `test/unit/tools/documents/tags-list.test.ts`
  ("pages the recorded tags with an explicit limit and counts uses per kind from the relations",
  "says when the cap cut the counts short"). Live: the three probes above, and
  `write-tag-name-matching` for ß/ss, the fi ligature, invisible characters and inner spaces,
  and `write-tag-relation-paging` for the unfiltered relation list across offsets (both observed
  2026-11-18; #136;
  `test/unit/scripts/gaps-contacts-probes.test.ts`, "tells reused tags from new ones per
  spelling, and the rule of two tag filters (#105)", "compares the paged relation list with one
  read of 1000 (#119)").

### D-089: `DELETE /TagRelation/{id}` removes a tag from a document, the last one the tag

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** No operation removes a tag from a document. `PUT /Tag/{tagId}` renames a tag;
  `DELETE /Tag/{tagId}` deletes one and declares 409 (Conflict).
- **Actual behavior:** The undocumented `DELETE /TagRelation/{tagRelationId}` answers
  `{objects: [null]}` and removes that one relation; the tag and its other relations stay. When
  the last relation of a tag is removed, sevDesk deletes the tag itself (`GET /Tag/{id}` 404). A
  second `DELETE` answers 404. `PUT /Tag/{tagId}` with `name` answers the tag object and keeps its
  relations; a name another tag already has is accepted (two tags with one name).
  `DELETE /Tag/{tagId}` of a tag that documents use answers `{objects: [null]}` and removes all its
  relations; the documents stay. A second check removed 7 relations (on finalized invoices,
  vouchers and credit notes, and on AB and LI orders): each tag went with its last relation, no
  tag was left.
- **Sources:** spec (`updateTag`, `deleteTag`); recorded 2026-11-16, trial account, Update 2.0
  (probes `write-tag-relation-remove`, `write-tag-update-delete`); recorded 2026-11-16, trial
  account, Update 2.0 (one-off check by the orchestrator, run tag `MCP-E2E 20261116-2308-evj7`).
- **Impact:** #87 removes one tag from one document with `DELETE /TagRelation/{id}` (D-024) and
  says in the preview when that removes the tag altogether; it counts the tag's uses from its
  relations, every row checked again, so a tag filter sevDesk ignored cannot hide a last use. A
  rename must check for an existing name itself.
- **Test:** `test/unit/scripts/gaps-contacts-probes.test.ts` ("tags documents of every kind, reuses
  a tag by name and removes one relation"); `test/unit/tools/documents/tag-tool.test.ts` ("removes
  the document's relation and keeps the tag when others use it", "warns that removing the last use
  deletes the tag (D-089)", "still warns of the last use when sevDesk ignores the tag filter of the
  count (D-089)", "says when a tag's uses were counted only up to the cap", "refuses when an
  ignored filter leaves the uses uncounted and this may be the last", "finds the tag by a spelling
  with other accents and case (cafe → Café)", "uses the exact spelling among accent variants and
  refuses when none matches exactly"). Live: the two probes above.

### D-090: Document lists filter by tag only with `tags[0][id]`; `tag[id]` is ignored

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `GET /Invoice`, `/Voucher`, `/Order` and `/CreditNote` document no tag filter.
- **Actual behavior:** `tags[0][id]=<tagId>&tags[0][objectName]=Tag` filters all four lists on
  the server (only the tagged draft, not the untagged control). `tag[id]` + `tag[objectName]` and
  `tag=<id>` are ignored without an error: the whole list comes back. `tags=<id>` answers 400 "Bad
  Request". Two tags (`tags[0][…]` and `tags[1][…]`) on `GET /Invoice` select only documents that
  carry both (AND): of three drafts with the first tag, the second or both, and two untagged ones,
  only the draft with both came back (recorded 2026-11-18).
- **Sources:** recorded 2026-11-16, trial account, Update 2.0 (probe `write-tag-list-filters`,
  run twice); recorded 2026-11-18, trial account, Update 2.0 (probe `write-tag-name-matching`).
- **Impact:** #87's `tag` filter on the list tools must send `tags[0][id]` and
  `tags[0][objectName]`; an ignored filter would return every document, so the parameter names are
  pinned by tests and the rows are checked against the tag's relations where the tool can. The
  reports (#87): `sevdesk_records_summarize` resolves `tag` before any list read and filters the
  lists as the list tools do; `sevdesk_profit_and_loss` sends no list filter and checks every
  document against the keys of the tag's relations itself (more than 10,000 uses make the figures
  truncated). Their breakdown by tag reads all of the account's relations (up to 10,000; beyond
  that it is marked incomplete), counts a document with several tags in each tag group and says
  that the groups overlap.
- **Test:** `test/unit/scripts/gaps-contacts-probes.test.ts` ("tells honoured list filters from
  ignored ones, with an untagged control"); `test/regressions/tag-filter-never-unfiltered.test.ts`
  (per list tool: an unknown name is refused before any list request; `tags[0][id]` is sent and
  rows the tag's relations do not name are dropped even when every row comes back);
  `test/unit/tools/documents/tags-list.test.ts` ("keeps rows on sevDesk's word beyond 10,000 uses
  and says so", "finds the tag by a spelling with other accents and case (CAFE → Café)", "refuses
  a name several tags fold to when none is spelled exactly so");
  `test/regressions/report-filters-never-unfiltered.test.ts` (both reports: an unknown tag is
  refused before any document list, and only the tagged documents count when every row comes
  back); `test/unit/tools/reports/summarize-tags-cost-centres.test.ts` ("filters by tag with the
  measured list filter and checks every row", "counts a document with several tags in each tag
  group and says the groups overlap", "marks the breakdown incomplete when the account has more
  relations than were read"); `test/unit/domain/reports/pnl-tags-cost-centres.test.ts` ("limits
  the figures to the documents of every kind that carry the tag", "reports the figures as
  truncated when the tag has more uses than were read"). Live: probe `write-tag-list-filters`,
  and `write-tag-name-matching` for a filter by two tags (`tags[0]` and `tags[1]`, #136; observed
  2026-11-18: both tags). The tools filter by one tag; a filter by several would send them as
  `tags[n]` and get documents with all of them.

### D-091: Cost centres are managed through the undocumented `/CostCentre` endpoints

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** Nothing: `/CostCentre` is not in the spec; only `costCentre: {id, objectName:
"CostCentre"}` on invoices and vouchers is (D-052, D-092).
- **Actual behavior:** `GET /CostCentre` answers a list with `total` (paging not measured: the
  account had too few cost centres when the probe ran); rows have `id`, `objectName`,
  `additionalInformation`, `create`, `update`, `sevClient`, `number`, `name`, `color` (`null`),
  `postingAccount` (`null`) and `defaultCentre` (`"0"`). A read by id answers a list of one row.
  `POST /CostCentre` with `objectName`, `name` and `number` answers the new cost centre as one
  object. `number` must match
  `/^[a-zA-Z0-9 äöüßÄÖÜ]+$/u` and be at most 8 characters: otherwise 422 "The given number (0) is
  not allowed. Allowed values follow this pattern: … And cannot be longer than 8 characters." (the
  message says `(0)` whatever was sent). `DELETE /CostCentre/{id}` of an unused cost centre answers
  `{objects: [null]}`, then 404; of one a voucher uses it is refused inside HTTP 200 (D-085). A
  cost centre made in the web app has the same shape.
- **Sources:** recorded 2026-11-16, trial account, Update 2.0 (probes `read-cost-centre-list`,
  `write-cost-centre-create`, `write-cost-centre-delete`; the list in
  `test/fixtures/recorded/2026-11-16/cost-centres/cost-centres-list.json`).
- **Impact:** `sevdesk_reference_lookup` kind `cost_centres` lists them (id, number, name, the
  default flag) from one `GET /CostCentre` with `limit` 1000; a longer list is reported as
  `truncated` (`listCostCentres` in `src/domain/cost-centres.ts`). The `costCentre` argument of
  the draft tools and the list filters is checked against that list: an id, or a number or name
  compared ignoring case and accents; an unknown or ambiguous one is refused before any write.
  The get tools and the finalize, send and enshrine approvals show a stored cost centre with
  number and name from the same list; when sevDesk refuses that list (any error but a cancelled
  call or this server's own guard), they show the id alone and the approvals add a warning, in
  English and German (`showCostCentre`): the id is in the record the approval binds, so number
  and name are display only. Resolving a `costCentre` argument still fails then. Creating,
  renaming and deleting cost centres is not offered.
- **Test:** `test/contract/recorded-gaps-contacts.test.ts` (the recorded list: keys, the number
  pattern, `defaultCentre`, through `sevdesk_api_get`, the probe `read-cost-centre-list` and
  "listCostCentres reads the recorded cost centres with an explicit limit (D-091)");
  `test/unit/domain/cost-centres.test.ts` ("shows the id alone, flagged unread, when sevDesk
  refuses the list"); `test/regressions/approval-binds-document-content.test.ts` ("shows the id
  alone with a warning when the cost centres cannot be read (#87)");
  `test/unit/tools/meta/reference-lookup.test.ts` ("lists the account's cost centres
  (Kostenstellen) with an explicit limit (D-091)");
  `test/unit/scripts/gaps-contacts-probes.test.ts` ("checks costCentre on create and on updates
  with the id, per document kind", "deletes only its own cost centres, unused and in use"). Live:
  the three probes above; `pnpm test:live` runs the lookup kind.

### D-092: `saveOrder` drops `costCentre`; invoices, vouchers and credit notes keep it

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_Voucher` and `Model_VoucherUpdate` take `costCentre: {id, objectName:
"CostCentre"}`; `Model_InvoiceResponse` shows it, but `Model_Invoice` does not take it (D-052);
  the order and credit note models have none. The lists document no cost-centre filter.
- **Actual behavior:** `saveInvoice`, `saveVoucher` and `saveCreditNote` store `costCentre` on
  create, take it on an update with the id, and keep it when a later update with the id leaves it
  out; reads show `costCentre: {id, objectName: "CostCentre"}`. `saveOrder` accepts the field
  without an error and drops it: the order reads back without a `costCentre` key, after create and
  after updates (D-003). `GET /Invoice` and `/Voucher` honour `costCentre[id]` +
  `costCentre[objectName]=CostCentre` (every row carries that cost centre, the control without it
  is left out); `costCentre=<id>` alone answers 422 "Invalid costCentre given, must have id and
  objectName". An update with the id and `costCentre: null` removes the cost centre: a draft
  invoice (`saveInvoice`), voucher (`saveVoucher`, `status: 50`) and credit note
  (`saveCreditNote`) that had one each answered 2xx and read back with `costCentre` null.
  `GET /CreditNote` list rows carry `costCentre: {id, objectName}` when the credit note has one
  (43 rows, 4 with a cost centre; the tested draft's row matched its read by id), and the list
  honours `costCentre[id]` + `costCentre[objectName]=CostCentre` like the invoice and voucher
  lists: it answered exactly one row, the draft, carrying that cost centre.
  A voucher position sent with a cost centre of its own reads back without one (recorded
  2026-11-18): a draft
  voucher saved with cost centre A on the head and B on its one position read back with A on the
  head and none on the position (`GET /VoucherPos`), and one with B on the position only read
  back with none on the head and none on the position. sevDesk accepted both without an error
  (D-003).
- **Sources:** spec (`Model_Voucher`, `Model_VoucherUpdate`, `Model_InvoiceResponse`); recorded
  2026-11-16, trial account, Update 2.0 (probes `write-cost-centre-documents`,
  `write-cost-centre-list-filters`); recorded 2026-11-17, trial account, Update 2.0 (one-off check
  by the orchestrator: `costCentre: null` on updates); recorded 2026-11-17, trial account, Update
  2.0 (one-off check by the orchestrator: credit-note list rows and the credit-note list filter);
  recorded 2026-11-18, trial account, Update 2.0 (probe `write-voucher-position-cost-centre`).
- **Impact:** `costCentre` is an argument of the create and update draft tools of invoices,
  vouchers and credit notes (`sevdesk_invoice_create_draft`, `sevdesk_invoice_update_draft`,
  `sevdesk_voucher_create_draft`, `sevdesk_voucher_update_draft`,
  `sevdesk_credit_note_create_draft`, `sevdesk_credit_note_update_draft`) only, never of the
  order tools; the strict `saveOrder` body has no such key. An invoice or voucher update without
  it carries the stored one over (D-052, D-054); a credit-note update leaves the key out, and
  sevDesk keeps the stored one. `sevdesk_invoices_list`, `sevdesk_vouchers_list` and
  `sevdesk_credit_notes_list` filter with both keys and check every row's `costCentre` again, so
  a filter sevDesk ignored cannot answer the whole list; credit-note rows show `costCentreId`.
  The three update tools take `removeCostCentre: true`, which sends `costCentre: null` (refused
  together with `costCentre`); the preview names the cost centre that is removed
  (`costCentreUpdate` in `src/domain/cost-centres.ts`). No update saves a draft unchanged for it:
  `removeCostCentre: false` asks for nothing (a call with nothing else is refused as nothing to
  change), and `removeCostCentre: true` on a draft without a cost centre is refused ("This draft
  has no cost centre.") when the call asks for nothing else. Cost centres on voucher positions
  are not offered: a position reads back without one. The reports (#87) treat the cost centre as a
  property of the whole document, as sevDesk does, and say so: `sevdesk_records_summarize` filters invoices, vouchers and credit notes through
  these lists (both keys and the row check); `sevdesk_profit_and_loss` checks every document's
  head itself. Their breakdown by cost centre has one group per document ("none" without one), so
  the groups add up to the totals.
- **Test:** `test/unit/scripts/gaps-contacts-probes.test.ts` ("checks costCentre on create and on
  updates with the id, per document kind", "tells honoured list filters from ignored ones, with an
  untagged control"); `test/regressions/cost-centre-filter-never-unfiltered.test.ts` (per list
  tool, the credit-note list included: an unknown cost centre is refused before any list request;
  both keys are sent and rows on another cost centre or none are dropped);
  `test/regressions/order-never-sends-cost-centre.test.ts`;
  `test/unit/tools/drafts/cost-centre-drafts.test.ts` ("keeps the stored cost centre when the
  call leaves it out (D-052, D-054)", "removes the stored cost centre with removeCostCentre:
  costCentre null (D-092)", "removes the stored cost centre and shows which one, in both
  languages", "sends no costCentre key when none is stored and none is asked for", "refuses
  removeCostCentre alone on a draft without a cost centre, without writing", "refuses
  removeCostCentre: false alone as nothing to change, before any read", and in
  "sevdesk_credit_note_update_draft with costCentre": "leaves the key out when the call does not
  name one: sevDesk keeps it (D-092)", "removes the stored cost centre with removeCostCentre:
  costCentre null (D-092)");
  `test/unit/domain/cost-centres.test.ts` ("costCentreUpdate (set, remove or keep)");
  `test/unit/tools/documents/cost-centre-reads.test.ts` ("sevdesk_credit_notes_list, with the
  filter recorded on 2026-11-17 (D-092)");
  `test/regressions/report-filters-never-unfiltered.test.ts` (both reports: an unknown cost
  centre is refused before any document list, and only its documents count when every row comes
  back); `test/unit/tools/reports/summarize-tags-cost-centres.test.ts` ("answers this month's
  expenses for one cost centre (issue #87 acceptance)", "groups by cost centre with a none group,
  and the groups add up to the totals", "filters credit notes with the measured list filter and
  each row's own cost centre"); `test/unit/domain/reports/pnl-tags-cost-centres.test.ts` ("breaks
  the result down per cost centre; the groups, none included, add up", "answers through the tool
  with costCentre by name"). Live: the two probes above; the removal, the credit-note list rows
  and the credit-note list filter by the 2026-11-17 one-off checks (no probe); cost centres on
  voucher positions: probe `write-voucher-position-cost-centre` (observed 2026-11-18: not kept;
  #136;
  `test/unit/scripts/gaps-contacts-probes.test.ts`, "says which cost centre a voucher position
  keeps and deletes vouchers and cost centres (#119)").

### D-095: On a cash register `resetToOpen` books a counter-entry instead of deleting

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /CheckAccountTransaction` "should only be used with check account type
  online"; `bookAmount` creates a transaction by itself on other account types; `resetToOpen`
  says "Linked transactions will be unlinked" (D-060, D-071). Cash registers (type `register`)
  are not mentioned anywhere.
- **Actual behavior:** On the trial's cash register (Kasse), `POST /CheckAccountTransaction` is
  refused with 422 "You can only create transactions on online checkaccounts. Use document
  bookAmount to create transactions on other types.", like on offline and clearing accounts
  (D-071, D-097). A cash sale and a cash expense work through `bookAmount` without a transaction
  on a voucher: a revenue voucher booked `+23.8` and an expense voucher booked `-11.9`
  (`FULL_PAYMENT`, date 12:00 Berlin) each created a register transaction with that signed
  amount, status 400, value and entry date at 12:00 of the booking day, a counterparty and a
  purpose; the vouchers went to status 1000 and `getBalanceAtDate` went from `"500"` to
  `"511.9"`. `resetToOpen` on the vouchers set them back to 100 with `paidAmount` 0, but **did
  not delete** the register transactions, as it does on offline accounts (D-071): it booked a
  counter-entry for each, status 400, the negated amount (`-23.8`, `11.9`), value and entry date
  at the moment of the reset (not the booking day), and `payeePayerName` null. The balance went
  back to `"500"`; the register keeps four rows. The register's opening entry made in the web
  app carried an `enshrined` timestamp.
- **Sources:** spec (`createTransaction`, `bookVoucher`, `voucherResetToOpen`); recorded
  2026-11-16, trial account, Update 2.0 (probe `write-cash-register-transaction`).
- **Impact:** A cash sale or expense is recorded through `bookAmount` on a document, never with
  `POST /CheckAccountTransaction` (the tools of #88 must refuse cash registers before sending).
  Undoing a cash payment leaves two rows in the cash book: previews of a reset on a register must
  say that sevDesk books a counter-entry dated today, not that the row disappears. Handling
  (#88): a cash sale or expense is booked with the existing payment tools
  (`sevdesk_voucher_book_payment`, `sevdesk_invoice_book_payment`) on the register without a
  transaction, and their preview says that sevDesk adds a cash book entry that an undo keeps
  (`checkPaymentAccount`); `sevdesk_cash_position` shows the register's balance from
  `getBalanceAtDate`. `sevdesk_transaction_create` refuses a cash register before anything is
  sent and names those tools. The reset previews (`sevdesk_{invoice,credit_note,voucher}_reset`,
  `sevdesk_transaction_reset`, `transaction-status.ts`) say that a register keeps the row and
  books a counter-entry dated the day of the reset; only clearing (offline) accounts delete it.
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("answers the banking questions as
  recorded…": the simulated register books the recorded counter-entries and the balance returns
  to 500); `test/unit/tools/banking/cash-register.test.ts` (a cash sale of 23.80 and a cash
  expense of 11.90 booked with `sevdesk_voucher_book_payment`, the recorded bodies without a
  transaction, `sevdesk_cash_position` at 511.90; the reset preview; the register refused by
  `sevdesk_transaction_create`); `test/unit/domain/reconciliation/transaction-status.test.ts`
  ("says that a cash register keeps the row and books a counter-entry (D-095)");
  `test/unit/tools/lifecycle/reset.test.ts` ("resets a paid invoice to open and says its payments
  are unlinked"); `test/unit/domain/lifecycle/payments.test.ts` ("says that a payment on a cash
  register becomes a cash book entry that an undo keeps (D-095)");
  `test/regressions/manual-transactions.test.ts` (no transaction is created on a register).

### D-096: Deleting a transaction is a soft delete and works only at status 100

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `DELETE /CheckAccountTransaction/{checkAccountTransactionId}` "Deletes a check
  account transaction" and answers `{objects: [null]}`; 409 is declared without a reason. The
  response model has no `deletedAt`.
- **Actual behavior:** On a file-import account, DELETE of an unbooked row (status 100) answers
  2xx `{objects: [null]}`, but the row is not gone: `GET /CheckAccountTransaction/{id}` still
  answers it, unchanged, with `deletedAt` set to the time of the delete (and `restoredAt` null).
  A second DELETE of the same row answers 2xx again. Rows at any other status are refused with
  409 "CheckAccountTransaction can only be deleted in status 100 but is status 300" (private) or
  "… 400" (booked). A booked row can be deleted after `resetToOpen` on the document it paid has
  set it back to 100 (D-060). Every transaction carries `deletedAt` and `restoredAt` (null
  unless deleted), keys the spec does not declare. Lists and balances leave soft-deleted rows
  out: after the run, the unfiltered `GET /CheckAccountTransaction` (53 rows, total 53) held no
  row with `deletedAt`, and on each of the seven active accounts listed then (the six of the
  banking run and the file-import account of `write-transaction-enshrine`) `getBalanceAtDate`
  equalled the sum of the listed rows. A soft-deleted row stays readable only by id.
  On an archived file-import account (recorded 2026-11-18) the open row archiving had already
  marked deleted (`deletedAt` set, status 100, D-097) took a `DELETE` the same way: 2xx, answer
  a list of one, the row afterwards status 100 with `deletedAt`. The `DELETE`s of the run's other
  hand-made rows (2026-11-18) answered the same.
- **Sources:** spec (`deleteCheckAccountTransaction`); recorded 2026-11-16, trial account,
  Update 2.0 (probes `write-transaction-delete`, `write-check-account-factories`,
  `read-transaction-soft-delete`); recorded 2026-11-17, trial account, Update 2.0 (one-off check
  by the orchestrator, run tag `MCP-E2E 20261117-0037-nb2e`: two rows created by hand, each
  DELETE answered `[null]` and the read-back had `deletedAt` set); recorded 2026-11-18, trial
  account, Update 2.0 (probes `write-transaction-delete-archived-account`,
  `write-transaction-create-answer`).
- **Impact:** A delete tool (#88) must treat 2xx plus `deletedAt` as deleted, never a 404 or a
  missing row; it must refuse rows that are not at status 100 (and name the reset or "back to
  unbooked" step for private rows), and a read by id must not mistake a row with `deletedAt` for
  a live one. Lists and balances need no filtering of their own: sevDesk already leaves the rows
  out. Handling (#88): `sevdesk_transaction_delete` (tier `commit`) deletes only unbooked rows of
  a file-import account (the only kind deleting was recorded on), refuses private, booked,
  enshrined and deleted rows and the rows of cash registers, clearing and bank-connected accounts
  before anything is sent, and confirms the delete by `deletedAt` on the read-back; a row that
  reads back live, or not at all, is an error with the row as a completed write. The transaction
  DTO marks such a row (`deleted`, `deletedOn`), `sevdesk_transaction_get` reports it as deleted
  without reading its log, every tool that books, changes, locks or links a transaction refuses
  it (`assertTransactionNotDeleted`), `sevdesk_reconcile_suggest` skips it, and the read-back of
  `sevdesk_transaction_reset` reports it as `transactionDeleted`.
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("answers the banking questions as
  recorded…": the soft delete, the 409 texts, the cleanup of private and booked rows);
  `test/unit/domain/reconciliation/manual-transactions.test.ts` ("confirms the soft delete by
  deletedAt on the read-back (D-096)", "never takes a live read-back or a missing row for a
  deletion", the refusals of `planTransactionDelete`); `test/unit/tools/banking/transaction-delete.test.ts`;
  `test/unit/tools/banking/transaction-get.test.ts` ("reports a deleted row as deleted, never as a
  live one"); `test/regressions/manual-transactions.test.ts` ("a soft-deleted row is reported as
  deleted and never as live"). Live: probes `write-transaction-delete`,
  `read-transaction-soft-delete`, `write-transaction-create-answer` (the `[null]` answer and the
  read-back with `deletedAt` of the 2026-11-17 check; confirmed 2026-11-18),
  `write-transaction-delete-archived-account` (a row of an archived file-import account, #136;
  observed 2026-11-18: soft-deleted like any other).

### D-097: Check accounts come only from two factories, and `DELETE` archives them

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** Accounts are created with `POST /CheckAccount/Factory/fileImportAccount` or
  `/clearingAccount` (`accountingNumber` optional for the first, "ask your tax consultant" for
  the second); there is no way to create a cash register. `DELETE /CheckAccount/{checkAccountId}`
  "Deletes a check account". The response model declares `autoMapTransactions`.
- **Actual behavior:**
  - `POST /CheckAccount/Factory/clearingAccount {name}` without `accountingNumber` creates an
    account of type `offline`, `importType` null, with the next free number of the 18xx range
    (`"1803"` after 1800–1802), and answers it in `objects` with the whole `sevClient` embedded.
    It takes no hand-made transaction (422 as in D-095).
  - `POST /CheckAccount` (a cash register, type `register`) is refused with 400 "Use the factory
    endpoint fileImportAccount or clearingAccount to create new CheckAccounts": registers are
    made in the web app only.
  - `PUT /CheckAccount/{id} {name}` answers the account in `objects` (one object) and changes
    `name` and `update`. The other fields it takes, and the ones it ignores with 200: D-141.
  - `DELETE /CheckAccount/{id}` answers 2xx `{objects: [null]}` and **archives** the account:
    `GET /CheckAccount/{id}` still answers it with `status` `"0"`, and `GET /CheckAccount` leaves
    it out (`read-check-account-kinds` listed 6 accounts right after the banking run, all at 100;
    `read-transaction-soft-delete` and the fixture's `total` count 7, after
    `write-transaction-enshrine` had made its own file-import account). An account that still
    holds an open transaction (status 100) is archived just as well, and its transaction gets
    `deletedAt` (D-096). The unfiltered `GET /CheckAccountTransaction` lists no row of an archived
    account (`read-transaction-soft-delete`, 53 rows, none outside the active accounts). Recorded
    again on 2026-11-18 for an empty file-import account, one with an open transaction and a
    clearing account (type `offline`): all three archived the same way. An account with a booked
    transaction is not archived (D-142); what archiving does besides: D-143.
  - Rows carry `autoMapTransaction` (singular), not the spec's `autoMapTransactions`. A
    file-import account is type `online` with `importType` `CSV` and `bankServer` null; the
    offline base account and clearing accounts are `offline`; the Kasse is `register`. No
    account on the trial is bank-connected, so how a real connection reads (`bankServer`,
    `lastSync`, `importType` null) stays the spec's word.
- **Sources:** spec (`createClearingAccount`, `updateCheckAccount`, `deleteCheckAccount`,
  `Model_CheckAccountResponse`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-check-account-factories`, `read-check-account-kinds`, `read-transaction-soft-delete`;
  `test/fixtures/recorded/2026-11-16/banking/check-accounts.json`); recorded 2026-11-18, trial
  account, Update 2.0 (one-off check by the orchestrator, run tag `MCP-E2E 20261118-0925-lgtm`).
- **Impact:** The account tools of #88 offer file-import and clearing accounts only, say that a
  cash register is set up in the web app, describe "delete" as archiving (the account and its
  rows stay readable by id, but leave the transaction list), and tell a file-import account by `importType`, never by `type`
  alone. `listBankAccounts` already hides status 0 unless asked (`includeArchived`), which fits
  archived accounts that sevDesk's list leaves out anyway. Handling (#88):
  `sevdesk_bank_account_create` (tier `write`) creates file-import and clearing accounts through
  the two factories, says that a cash register is set up in the web app and that an account is
  only archived, refuses a name an active account has (no human confirms this tier, and a second
  account could not be deleted again), and takes the created account from sevDesk's answer.
  The account list's `fileImport` (with `importType`) is true only for an `online` account with
  `importType` `CSV` or `MT940` and no `bankServer` (how a connected account reads is not
  recorded, so one that names a data provider never counts as a file-import account); `type`
  keeps its meaning. Handling (#128): `sevdesk_bank_account_archive` (tier `commit`) sends the
  `DELETE` for a file-import or clearing account, calls it archiving, lists the open
  transactions it deletes, and confirms status 0 on the read-back; it refuses cash registers,
  the default account and bank-connected accounts (none of them recorded).
- **Test:** `test/unit/tools/banking/account-archive.test.ts` ("archives an account, names its
  open transactions and confirms status 0 on the read-back", "archives a clearing account that is
  not the default", "refuses cash registers, the default account, bank-connected and archived
  accounts", "fails when the read-back still shows the account active");
  `test/contract/recorded-gaps-banking.test.ts` (the recorded list through
  `listBankAccounts`: file-import accounts as `bank` with `fileImport` and `importType` `CSV`,
  the offline account as `clearing`, only active rows, an incomplete page);
  `test/unit/tools/banking/accounts.test.ts` ("tells file-import accounts by importType without a
  bankServer, never by type alone"); `test/unit/domain/bank-account-create.test.ts` (the two
  factories and their bodies, the account read from the answer, the refusal of a same-named
  active account); `test/unit/tools/banking/account-create.test.ts` (no cash register,
  archive-only wording); `test/regressions/concurrent-check-then-write.test.ts` (two creations at
  once make one account); `test/unit/scripts/gaps-banking-probes.test.ts` (archiving, the refusal
  text). Live: probes `write-check-account-factories`, `read-check-account-kinds`.

### D-098: An enshrined transaction locks itself and the payment it books

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `PUT /CheckAccountTransaction/{id}/enshrine` sets `enshrined`; it "is only
  possible if the status is 'Linked' (200) or higher", and "linked invoices, credit notes or
  vouchers cannot be changed" afterwards. It answers `{objects: null}`; 422 is a
  `validationError`.
- **Actual behavior:** On one tagged file-import transaction (the only record any probe
  enshrines):
  - at status 100: 422 "Cannot enshrine transaction with status created (100). At least status
    linked (200) is required.";
  - after booking an open voucher on it (status 400): 2xx `{objects: null}`; the transaction's
    `enshrined` became an ISO date-time with offset, nothing else but `update` changed, and the
    voucher did not change at all (its own `enshrined` stayed null);
  - a second enshrine answers 2xx and keeps the first timestamp (idempotent, like D-059);
  - `PUT /CheckAccountTransaction/{id} {status: 100}` is refused with 422 "Cannot set or change
    property 'enshrined'. Please use the dedicated endpoint instead." (any PUT on it, it seems);
  - DELETE is refused with 409 "… can only be deleted in status 100 but is status 400" (D-096);
  - booking a second voucher on it: 422 "Voucher is not bookable with given payment
    information" (the row was fully used as well, so this does not separate the two reasons);
  - `resetToOpen` on the paid voucher: **400** "Already enshrined by transaction", not the 422
    code 322 sevdesk-rs measured for invoices (D-060); the voucher stays paid (1000).
  - Recorded 2026-11-18 on three more tagged rows of a file-import account: one set to 300
    (private) by `PUT`, one linked (200) by booking 10 of its −22 on an open voucher (type `N`,
    D-075), and one set to 350 by `PUT` (sevDesk took it on a hand-made row, D-031). Each
    enshrine answered 2xx (`objects` null), set `enshrined` and kept the status; afterwards each
    `PUT {status: 100}` was refused with the same 422 and each `DELETE` with 409 "… can only be
    deleted in status 100 but is status 300" (200, 350). What sevDesk does with the unassigned
    rest of the row at 200 (booking it after locking) was not tried.
- **Sources:** spec (`checkAccountTransactionEnshrine`); recorded 2026-11-16, trial account,
  Update 2.0 (probe `write-transaction-enshrine`, opt-in); recorded 2026-11-18, trial account,
  Update 2.0 (probe `write-transaction-enshrine-statuses`, opt-in).
- **Impact:** An enshrine tool (#88) is `commit`, irreversible, and only offered for rows at 200
  or higher; its preview says that the row can no longer be changed, deleted or reset and that
  the document it pays can no longer be reset to open. A reset of a document whose payment is
  enshrined must expect 400 as well as 422. Handling (#88): `sevdesk_transaction_enshrine` (tier
  `commit`, `destructiveHint`, preview marked irreversible in English and German) refuses rows
  below 200, enshrined and deleted rows before anything is sent, names the documents from the
  booking log, says that the documents themselves are not enshrined, warns that the rest of a
  partly linked row may not be bookable afterwards (locking at 200, 300 and 350 is recorded, the
  rest's booking is not), and confirms `enshrined` on the read-back. `resetDocument` (`lifecycle/actions.ts`)
  turns sevDesk's 400 "Already enshrined by transaction" and 422 "Already enshrined by payment"
  into our own explanation (`SevdeskError.explained`, shown by the error rendering without
  sevDesk's text), for the document reset tools and `sevdesk_transaction_reset` alike.
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("runs the opt-in probes only when
  named…": the recorded refusal texts and statuses; only the probe's own transaction is ever
  enshrined), `test/unit/scripts/probes.test.ts` (one enshrine call site, opt-in);
  `test/unit/domain/reconciliation/manual-transactions.test.ts` (`planTransactionEnshrine` and
  `executeTransactionEnshrine`); `test/unit/tools/banking/transaction-enshrine.test.ts`;
  `test/regressions/manual-transactions.test.ts` ("no enshrine below status 200");
  `test/unit/tools/lifecycle/reset.test.ts` ("explains sevDesk's 400 refusal when a payment
  transaction is enshrined", the same for 422); `test/unit/tools/tool-errors.test.ts` ("shows our
  own explanation of a known sevDesk refusal, without sevDesk's text"). Live: probes
  `write-transaction-enshrine` (opt-in, status 400) and `write-transaction-enshrine-statuses`
  (opt-in, #136: 300, 200 and 350; observed 2026-11-18: all three locked;
  `gaps-banking-probes.test.ts`, "enshrines its own rows at 300 and 200 only when named…").

### D-099: Private-transaction rules did not mark hand-made transactions

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `GET /PrivateTransactionRule` lists the rules "for automated marking private
  transactions", `POST` creates one (`objectName`, `paymentPurpose`, `counterpartName`, both
  nullable) and answers 201 with the bare model, `DELETE /PrivateTransactionRule/{id}` deletes
  one. When and how a rule is applied is not said.
- **Actual behavior:**
  - `GET` with `limit`/`offset` answers `{objects: [...]}`; without `countAll` no `total` was
    seen, with `countAll=true` it reports one (0 before, 8 after eight creations), and
    `limit`/`offset` page properly (two pages of two, no shared id). It lists rules by ascending
    id, which is the order they were created in (oldest first), and pages of one give the same
    rows in the same order as one page (recorded 2026-11-18, three rules).
  - `POST` answers 2xx with the rule wrapped in `objects` (keys `id`, `objectName`,
    `additionalInformation`, `create`, `update`, `sevClient`, `paymentPurpose`, `counterpartName`;
    the field not sent is `null`; ids were small integers, `951`). It stores a text exactly as
    sent, without trimming (two leading spaces and one trailing kept: 37 characters for a
    34-character text). A text over 255 characters is **cut to 255 without notice** (D-130). A
    rule with both texts is accepted and stored with both; a second rule with exactly the same
    `counterpartName` is accepted and stored as a second row (no duplicate check); a rule with
    neither text is refused with 422 "At least one of the parameters must be set". `DELETE`
    answers `{objects: [null]}`.
  - Two tagged rules (one per field) turned **none** of five tagged open transactions on a
    file-import account private (exact and partial counterpart, exact and partial purpose,
    neither), nor a matching one created after the rules, and deleting the rules changed nothing.
    Rules probably act only when sevDesk imports bank transactions, which a trial cannot do; so
    how a rule matches (exact, contains, case, both texts or either) is not known, and whether a
    CSV file import applies rules cannot be tested through the API.
- **Sources:** spec (`listPrivateTransactionRules`, `createPrivateTransactionRule`,
  `deletePrivateTransactionRule`); recorded 2026-11-16, trial account, Update 2.0 (probe
  `write-private-transaction-rule`); recorded 2026-11-17, trial account, Update 2.0 (one-off
  checks by the orchestrator: `countAll`, paging, both texts, duplicates, spaces, lengths, no
  text; eight tagged rules, all deleted again); recorded 2026-11-18, trial account, Update 2.0
  (probes `write-private-transaction-rule-order`, and `write-private-transaction-rule-storage`,
  which confirmed the storage facts of 2026-11-17).
- **Impact:** The rule tools of #88 can list, create and delete rules, but a preview of which
  open transactions a new rule "would match" cannot rely on sevDesk applying it to existing or
  hand-made rows: it must say that sevDesk is expected to apply rules to imported transactions
  (descriptions, previews, summaries and docs hedge this, never state it as a fact), and mark any
  local matching as an estimate. Handling (#88): `sevdesk_private_transaction_rules_list` (read,
  explicit `limit`, texts cleaned), `sevdesk_private_transaction_rule_create` and
  `sevdesk_private_transaction_rule_delete` (both `commit`: a rule makes sevDesk mark imports
  private as `sevdesk_transaction_mark_private` does by hand); the client requires `commit` for
  `POST /PrivateTransactionRule` and `DELETE /PrivateTransactionRule/{id}` as well
  (`minimumWriteTier`, #131), so no `write` request reaches them. Create sends one trimmed text per
  rule (sevDesk would store a rule with both texts, but whether it then needs both or either is
  not known, so both are refused), at most 100 characters (sevDesk cuts a text over 255 without
  notice, D-130), refuses texts with fewer than four letters or digits and a rule whose text
  equals an existing one's (case and spaces ignored; sevDesk itself would store the duplicate),
  and lists up to ten of at most 500 open transactions whose counterparty or purpose contains the
  text, every time labelled as this server's estimate, never as sevDesk's matching, with the
  sentence that sevDesk is expected to act on bank imports and could not be tested on a trial
  account. Both tools confirm the write by reading the rule list back (no read by id is
  recorded); create compares the stored text exactly with the trimmed text it sent and notes any
  difference. The list runs oldest first, so a rule looked up by id or text can be on any page
  and every search of it (the duplicate check, the delete lookup and both read-backs, #132) reads
  up to five pages of 1000 with an explicit `limit`: a longer list makes the create preview say
  that the duplicate check read the oldest N rules, the delete refusal say "among the first N
  rules", and the create result show the rule as sevDesk answered the POST with a note that its
  stored text was not checked (a new rule is listed last). The estimate reads the newest open
  transactions by value date (D-145). The delete preview says that private transactions stay
  private.
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("answers the banking questions as
  recorded…": no row turns private, the rules are deleted);
  `test/unit/tools/banking/private-rules.test.ts` (list, refusals, the estimate and its labels,
  read-backs, also past the first 1000 rules, the trimmed text sent and a stored text with spaces
  or cut short noted); `test/unit/domain/private-transaction-rules.test.ts` (paging: a duplicate
  on page 2, a delete target on page 3, more than five pages, a short last page without a total,
  a total of 0, the delete read-back past page 1);
  `test/regressions/private-transaction-rules.test.ts` (no rule without a confirmation, no match
  stated as fact); `test/regressions/concurrent-check-then-write.test.ts` (two equal creations at
  once give one rule); `test/unit/sevdesk/paths.test.ts` ("minimumWriteTier for
  private-transaction rules": both requests need `commit`, the list stays a read). The recorded
  list was empty, so no fixture was kept; the tests build rows with the recorded keys. Live:
  probes `write-private-transaction-rule` and `write-private-transaction-rule-storage` (spaces
  kept, duplicates stored, the cut of D-130; confirmed 2026-11-18), and
  `write-private-transaction-rule-order` for the order of the list (#136; observed 2026-11-18:
  ascending id, stable pages; `test/unit/scripts/gaps-banking-probes.test.ts`, "asks the #136
  list-order, account, entryDate and image questions…").

### D-100: A receipt's `contentHash` is the SHA-256 of the file; rendered PDFs have none

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `uploadTempFile` answer declares `contentHash` without saying what it
  hashes. `GET /Document` is undocumented (D-024); the community model lists `contentHash`.
  `GET /Voucher` (`getVouchers`) declares no `embed` parameter.
- **Actual behavior:**
  - For a generated 1,507-byte receipt PDF, `uploadTempFile`'s `contentHash` is the lower-case
    hex SHA-256 of the uploaded bytes (not MD5 or SHA-1). A second upload of the same bytes got a
    new `filename` token and the same hash.
  - The draft voucher saved with it has no hash key; its `document` reference points to a
    Document whose `GET /Document/{id}` carries the same SHA-256, `filesize` equal to the upload,
    `status` `"50"`, `mimeType` null and no `object`/`baseObject`. This Document is **not**
    listed by `GET /Document` (80 rows, it was not among them), and `GET /Document/{id}/download`
    gives the uploaded bytes back.
  - Deleting the draft voucher deletes the Document too (404 afterwards).
  - Documents sevDesk renders itself (the PDF stored when an invoice is finalized, linked to the
    invoice as `baseObject`) are listed, at status 100, with `contentHash` **null**; so were the
    three newest documents of the account.
  - `GET /Voucher?embed=document` puts the whole Document into every list row in place of the
    `{id, objectName}` reference, `contentHash` included (53 rows, 13 with a document, 12 of them
    with a hash). It does so on later pages too (`limit=10` with `offset` 0, 10 and 40); more than
    1,000 vouchers were not tried. Without `embed` a row carries only the reference.
  - A receipt made by sevDesk's recognition (`Voucher/Factory/createVoucherFromFile`, D-103) gets
    a Document with `contentHash` **null**, for a PDF and a PNG alike, also when read 12 seconds
    later, by id and in the embedded list rows. Its `filesize` is the number of bytes sent (1,435
    for the PDF, 70 for the PNG), `extension` is `pdf` / `png` and `mimeType` null. So only
    receipts uploaded through `uploadTempFile` + `saveVoucher` carry a checksum.
  - Images are kept as uploaded (recorded 2026-11-18): for a 70-byte PNG and a 286-byte JPEG,
    the `uploadTempFile` answer (`mimeType` and `originMimeType` as sent) and the Document of the
    draft voucher carry the SHA-256 of the uploaded bytes, `filesize` is the upload's, `extension`
    `png` / `jpg`, and `GET /Document/{id}/download` gives the very bytes back. In
    `GET /Voucher?embed=document` both vouchers embed their Document with that hash.
  - The order of `GET /Voucher?embed=document` depends on the page size (recorded 2026-11-18, 57
    vouchers): pages of one (`limit=1`, offsets 0 to 4) did not give the rows of one page of 1000
    in the same order, from offset 0 on (the newest voucher came first with `limit=1000`, second
    with `limit=1`).
  - **Paging the voucher list skips and repeats vouchers** (recorded 2026-11-18, probe
    `read-voucher-paging-order`): over the 56 vouchers (VOU) dated two years before the run to 31
    days after it, with the filters the checks send (`voucherType=VOU`, `startDate`/`endDate`),
    one page of 1000 is sorted by `voucherDate` descending, and every voucher shared its
    `voucherDate` with another. Read again in pages of 5 from offset 0 to the end, the vouchers
    came in another order: 12 of the 56 never appeared and 12 others appeared twice, with and
    without `embed=document`. Two passes in pages of 5 gave the same ids in the same order, so the
    order is fixed for a given page but differs between pages: ties on the date are broken
    differently per request. `orderByVoucherNumber=ASC` (the order the spec documents for
    vouchers) changed the order and still lost one voucher and repeated another;
    `orderBy[0][field]=id` with `orderBy[0][arrangement]=asc` (not in the spec) was ignored (the
    same order as without it, and the same 12 lost). The client sends no order parameter (only
    the filters, `limit`, `offset` and `countAll`). The other lists were measured later the same
    way (#162, D-146): invoices, credit notes and orders sort by `create`, and ties are broken per
    page there too; they are read the same way here (see Impact).
- **Sources:** spec (`uploadTempFile`, `getVouchers`); recorded 2026-11-16, trial account, Update
  2.0 (probes `write-receipt-hash`, `read-document-hash`); recorded 2026-11-17, trial account,
  Update 2.0 (manual check (lead): `embed=document` on the voucher list and its later pages, two
  receipts made by `createVoucherFromFile`); recorded 2026-11-18, trial account, Update 2.0
  (probes `write-receipt-image-reencode`, `read-document-hash`: the three newest documents again
  had `contentHash` null; `read-voucher-paging-order`: paging skips and repeats vouchers).
- **Impact:** The receipt checks of #92 compare SHA-256 checksums with the `contentHash` sevDesk
  lists with each voucher (`GET /Voucher?embed=document`, no read by id), not with
  `GET /Document` (which leaves receipts of drafts out). A null or missing hash
  means "unknown", never "no match": rendered invoices and receipts made by the recognition have
  none, so a result counts such receipts and words an unmatched file accordingly, and counts a
  list row without the embedded document apart. A file matches a receipt by hash only; the same
  `filesize` and `extension` are a hint, never a match. Since images are not re-encoded, a PNG or
  JPEG uploaded through the API matches its local file like a PDF does. Because paging skips
  vouchers, `listDocumentHeaders` (every report and check that lists invoices, credit notes or
  vouchers by date) never reads past the first page of a query (#154): a period that fits one
  page of 1,000 is one request as before; a longer one is halved by date, each half counted with
  `limit=1`, until every window fits one page, and each window is read as a single page (at most
  3 requests per split plus 2, bounded by the row cap; see `src/domain/reports/date-windows.ts`).
  Only a single day with more than 1,000 documents of one kind is read page by page; the result
  then names the day in a note, says its documents may be missing and counts as incomplete
  (`coverage.truncated` of the reports and audit checks; the receipt folder check adds the note).
  Every listing also keeps a document once by id, as a guard. Invoices and credit notes get the
  same windows without a measurement of their own: they are sorted by date too, and the cost is
  nil while a period fits one page.
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("compares receipt hashes without
  showing them": SHA-256 match, new token per upload, Document gone with the draft, null hashes
  of rendered documents); `test/unit/domain/voucher-receipt-hash.test.ts` (the embedded
  document's checksum in lower case with size and extension; none for a plain reference, a
  rendered file or a recognized receipt); `test/unit/domain/reports/audit/receipt-folder.test.ts`
  (matches by the listed checksum, counts receipts without one and rows without the embedded
  document, never matches by size); `test/unit/domain/reports/audit/duplicates-check.test.ts`
  (checksums from the list with `embed=document`, no read by id);
  `test/unit/tools/vouchers/recognize-receipt.test.ts` ("the same file before the upload (#127)":
  one list read with `embed=document`, a refusal naming the voucher, `allowDuplicate`, a receipt
  with `contentHash` null never matched but counted, a row without the embedded document, partial
  and failed reads); `test/regressions/recognition-same-file.test.ts` (the refusal before the
  upload, and the same file recognised before not found);
  `test/unit/domain/reports/date-windows.test.ts` (windows of one page each, a busy day read page
  by page and named, the cap, a list without a count);
  `test/regressions/voucher-list-paging.test.ts` (a list whose order depends on the page: offset
  paging loses vouchers, the listing the checks use sees 2,430 vouchers exactly once, a busy day
  makes the checks say so). Handling: done,
  `sevdesk_receipt_folder_check` and the `duplicates` check of `sevdesk_records_audit` (#92), and
  the checksum check of `sevdesk_voucher_recognize_receipt` before its upload (#127, see D-103).
  Live: probes `write-receipt-hash`, `read-document-hash`, and `write-receipt-image-reencode`
  (whether a PNG and a JPEG come back as uploaded, and `embed=document` paged by one; #136,
  `test/unit/scripts/gaps-banking-probes.test.ts`; observed 2026-11-18: not re-encoded, pages of
  one in another order), `read-voucher-paging-order` and `write-voucher-paging-seed` (whether
  pages of five skip or repeat vouchers against one page of 1000, with the checks' date filter,
  with and without `embed=document`; #154, `test/unit/scripts/gaps-documents-probes.test.ts`,
  "voucher list paging probes (#154)"; observed 2026-11-18 with the read probe: 12 of 56 lost and
  12 repeated, the seed probe was not needed).

### D-101: The ZIP exports answer files only with `download=true` and change no document

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `GET /Export/invoiceZip` and `/Export/voucherZip` take `download` and a
  `sevQuery` (`limit`, `modelName`, `objectName`, `filter` with `startDate`/`endDate` as
  date-time, `contact`, `startAmount`/`endAmount`, and `invoiceType` for invoices) and declare
  only the JSON answer `{filename, mimetype, base64Encoded, content}`.
- **Actual behavior:**
  - Without `download`, both answer that JSON with `filename` like `Rechnungen_dd.mm.yy.zip` /
    `Belege_dd.mm.yy.zip`, `mimetype` `application/zip`, `base64Encoded` true and `content`
    **null**, also when invoices or vouchers match: the JSON form never carries the file.
  - With `download=true` the body is the raw ZIP, `Content-Type: application/zip; charset=UTF-8'`
    (with a stray apostrophe). Filtered to a fresh contact and the last 31 days (Unix seconds,
    as for the CSV exports, D-012), `invoiceZip` held exactly that contact's two invoices of 130;
    `voucherZip` filtered to today and 123–124 EUR held exactly the two tagged vouchers of 49.
  - Entries are one PDF per document, named `YYYY-MM-DD_Rechnung_<number>_<32 hex>.pdf`;
    **drafts are included**, with a seven-letter label in parentheses and no number
    (`YYYY-MM-DD_Rechnung(<label>)__<32 hex>.pdf`, presumably "Entwurf"); voucher entries carry
    the date, a label (again with the draft label for a draft), the voucher's description and a
    hash. A voucher entry is the uploaded receipt (1.5 KB), an invoice entry the rendered PDF
    (138 KB).
  - Nothing changed: the draft invoice kept status, `sendDate`, `sendType` and `update`, and no
    invoice (130) or voucher (49) changed any key. Unlike `getPdf` without `preventSendBy`
    (D-023), the export does not mark drafts as sent.
  - When nothing matches, `download=true` still answers a real ZIP (179 bytes) with one entry,
    `readme.txt` (62 bytes, "Es wurden keine Dateien hochgeladen, daher ist diese ZIP leer."),
    for `limit` 1 and 1000, a window in January 2000 and an amount range nothing falls into. (The
    probes' "JSON with content null" came from their own HTTP layer.)
  - `startAmount`/`endAmount` take decimals, bounds inclusive: on `voucherZip`, a voucher with a
    decimal gross amount g was in the archive for g..g and g−0.01..g+0.01, and not for
    g+0.01..g+0.02 (readme ZIP). `invoiceZip` honours them too: 110 entries for an amount range
    111 listed invoices fall into, against 130 entries unfiltered for 131 listed.
  - Entries can be fewer than documents: a voucher archive holds only vouchers with a receipt
    file (13 entries for 53 listed vouchers in the window, the 13 that had a `document`); both
    invoice runs held one invoice fewer than the list (130 of 131, 110 of 111).
  - Duration: sevDesk answers only once the ZIP is rendered. `invoiceZip` took 30 s for 110
    entries (21 MB), 46 s for 25 entries (6.6 MB, a first call) and 63 s for 130 entries
    (24.6 MB); `voucherZip` about 1 s for 13 small receipts.
  - Not measured: the contact filter on `voucherZip` (no voucher with a supplier contact in the
    window), which invoice the invoice archive leaves out, archives beyond 25 MB, whether
    sevDesk stops at `sevQuery[limit]` (only an empty archive was asked for, with limits 1 and
    1000), and whether sevDesk labels other states (a cancellation, say) in the draft label's
    place: only the draft's label was seen.
- **Sources:** spec (`exportInvoiceZip`, `exportVoucherZip`); recorded 2026-11-16, trial account,
  Update 2.0 (probes `write-export-invoice-zip`, `write-export-voucher-zip`); recorded 2026-11-16,
  trial account, Update 2.0 (one-off checks by the orchestrator).
- **Impact:** The archive export of #95 asks for `download=true`, parses the media type leniently
  (the stray apostrophe), checks that the body is a ZIP, always sends the filters and an explicit
  `limit`, says that drafts are included (or filters them out), and needs no `commit` tier: it
  changes no document. It stays a side-effect GET with the `write` tier in this repository's
  client until a tool settles it, since a ZIP of many PDFs is a heavy job on sevDesk's side. The
  readme-only ZIP is the empty case, a lower entry count is no error, and the default
  `SEVDESK_TIMEOUT_MS` of 30 s is too short for a month of invoices.
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("exports the ZIPs, describes entries
  as patterns and sees no change to documents": the null JSON content, the raw ZIP with drafts,
  unchanged documents; "keeps only the signature of a binary body in the evidence");
  `test/unit/domain/exports/archive.test.ts` ("accepts the recorded raw ZIP with the stray
  apostrophe and counts entries and drafts", "refuses %s and saves nothing", "is a side effect for
  the client, and never carries an enshrine flag"), `test/unit/domain/exports/zip.test.ts`,
  `test/unit/tools/reports/archive-export.test.ts` ("asks once with the write tier, saves the ZIP
  unchanged and counts entries and drafts": entry names and count read back from the saved file),
  `test/regressions/export-archives-no-enshrine.test.ts`, `test/unit/sevdesk/paths.test.ts`
  ("treats the document archive %s as a side effect"), `test/regressions/api-get-side-effects.test.ts`
  (`/Export/invoiceZip`, `/Export/voucherZip`); for the one-off checks:
  `test/unit/domain/exports/archive.test.ts` ("treats sevDesk's readme-only ZIP as empty",
  "never counts the readme next to documents", "sends the invoice amount filter, now recorded",
  "asks for the archive with a size cap and its own, longer time budget", "turns a timeout into
  the remedy", "treats %i files for a limit of %i as possibly cut: %s", "asks for a default that
  fits the time and size budgets at the recorded rates", "never counts another label in the
  draft's place as a draft: %s"),
  `test/unit/tools/reports/archive-export.test.ts` ("saves nothing for %s and says no document
  matched", "treats fewer entries than documents as normal, not as an error", "flags an archive
  a file short of the limit…"),
  `test/unit/sevdesk/client.test.ts` ("gives a download its own, longer time budget, and only a
  download", "bounds a request's own time budget…"). Handling: `sevdesk_archive_export`
  (`src/tools/reports/archive-export.ts`, `src/domain/exports/archive.ts`), a `write` tool:
  `download=true`, a fixed query with an explicit `limit` and only the recorded filters (contact
  for invoices, amounts for both), the media type parsed leniently, the body checked as a
  readable ZIP, the top-level `readme.txt` never counted and an archive without documents not
  saved (in our own words), drafts counted from their entry names (`draftEntries`, only the
  label `(Entwurf)`, so the advice to remove drafts never hits a document with another label), a
  note that fewer files than documents is normal, a default `limit` of 500 documents (up to 1000;
  500 invoices fit the time and size budgets at the recorded rates, 1000 do not),
  `mayBeTruncated` when the files come within 2 % of the limit (an archive cut at the limit can
  hold fewer files than documents; for vouchers it is no proof of completeness), 100 MiB at most,
  and its own time budget of 5 minutes
  (`ARCHIVE_TIMEOUT_MS`, through `SevdeskRequest.timeoutMs`, which only `download` honours,
  bounded by `requestTimeoutMs` in `src/sevdesk/client.ts`) with a timeout error that names the
  remedy; `resolveGetSafety` treats both endpoints as side effects (`ARCHIVE_ENDPOINTS` in
  `src/sevdesk/paths.ts`), and `sevdesk_api_get` refuses them anywhere in a path.

### D-102: The DATEV XML job works like the CSV job and marks nothing as exported

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `GET /Export/createDatevXmlZipExportJob` (`startDate`, `endDate`, `scope` of
  `E`/`X`, `exportByPaydate`, `includeEnshrined`, `includeExportedDocuments` "If set to false, the
  export excludes already exported documents", `includeDocumentXml`) answers the job id; the
  progress and download steps are those of the CSV job. It has no enshrine flag.
- **Actual behavior:** A POST with the query `startDate`/`endDate` (Unix seconds, the last 31
  days) and `scope=EX` started the job at once (the GET form was not tried; the CSV job's GET is
  refused, D-077). Job id, `generateDownloadHash`, `getProgress` (done after 6–9 polls at two
  seconds) and `jobDownloadInfo` answered exactly as for the CSV job (D-077), with a link to the
  same S3 host, which downloaded without credentials as `binary/octet-stream`. The file,
  `BITTE-ENTPACKEN_Belegbilder_…_bis_….zip`, is a ZIP of two inner ZIPs named `DATEV_…_bis_….zip`
  (5.6 MB and 6.7 KB for one month of the trial). No invoice (130) and no voucher (51) changed
  any key. A second job with `includeExportedDocuments=false` exported the same two entries of
  almost the same size: nothing was marked as exported in a way this flag reads. Not measured:
  `exportByPaydate` and `includeEnshrined` on this job (neither was sent). The spec leaves the
  default of `includeEnshrined` open, so whether an XML export holds enshrined documents is
  unknown.
- **Sources:** spec (`exportDatevXML`); recorded 2026-11-16, trial account, Update 2.0 (probe
  `write-export-datev-xml`, opt-in).
- **Impact:** `sevdesk_datev_export` can offer the XML format (#95) with the same job flow,
  downloader and host allowlist (`EXPORT_HOSTS`); its size cap must allow several MB of receipt
  images, and its preview need not warn that documents get marked as exported (but should not
  promise `includeExportedDocuments` has any effect).
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("runs the opt-in probes only when
  named…": a POST without enshrine flags, download only through `downloadPresignedExport`, nested
  ZIPs, unchanged documents, equal entries); `test/unit/domain/exports/datev.test.ts` ("builds the
  XML job's query from the recorded keys only: E/X scope, no image or export flags", "starts the
  XML job with a POST to its own path"), `test/unit/tools/reports/export-tools.test.ts`
  ("sevdesk_datev_export: format xml", including "refuses exportByPaydate %s with the XML export
  before sending anything"), `test/regressions/export-archives-no-enshrine.test.ts`
  ("DATEV XML export"). Handling: `sevdesk_datev_export` takes `format: "xml"` (default `csv`,
  unchanged): the same job flow, downloader, host allowlist and 100 MiB cap, a POST to
  `createDatevXmlZipExportJob` with only `startDate`, `endDate` and a scope of E/X
  (`datevJobQuery`), never `exportByPaydate` (refused with XML before anything is sent),
  `includeEnshrined` or `includeExportedDocuments`; the preview names the parts the XML export
  leaves out, does not warn about an "exported" mark, and says, like the result, that whether
  enshrined documents are included is not recorded.

### D-103: `createVoucherFromFile` makes a draft that sevDesk fills in within seconds

- **Status:** Open. **Evidence:** community + recorded.
- **Spec says:** Nothing: the endpoint is not in the spec (D-024).
- **Actual behavior:** A multipart `POST /Voucher/Factory/createVoucherFromFile` with the field
  `creditDebit` `C` and the PDF in the part `voucher` (as lippoliv/paperlessngx-to-sevdesk sends
  it) answers 2xx with the new voucher in `objects`: the full voucher keys plus
  `propertyCreationOrigin` and `propertyIsBookkeepingV1` (both null) and the whole `sevClient`.
  It is a **draft (status 50)** from the start, with placeholders: `voucherDate` the moment of
  creation, `supplierName` and `description` null, sums `"0"`, `showNet` `"1"`, `taxType`
  `"default"`, `inSource` set, and a `document`. About two seconds later (the second read,
  about 5 s after the upload) sevDesk's recognition had filled in `voucherDate` (the PDF's date),
  `description` (the PDF's "Rechnung Nr."), `sumNet` 100, `sumTax` 19, `sumGross` 119, `showNet`
  `"0"`, `supplierName` (a text, but not the PDF's supplier line, and no supplier contact) and
  `resultDisdar`; `taxRule` stayed null. It added one position: `taxRate` 19, `sum` 100, net
  `"0"`, the three sums, and `accountDatev` **null**.

  Recorded 2026-11-17 (generated test files, all drafts deleted again):
  - `creditDebit` `D` works: a draft (status 50, `voucherType` VOU) with `creditDebit` `D`, which
    the recognition filled in with net 200, tax 38, gross 238 and one position at 19 %; `taxRule`
    null.
  - A PNG (1x1, `image/png`, part `voucher`) is accepted and makes a draft; nothing was
    recognised from it (sums 0, no position after 8 s). JPEG and real photos are unmeasured.
  - For four PDFs the sums were there at the second read, about one second after the upload (the
    read right after the POST still had 0). Scans and long PDFs are unmeasured.
  - **Several tax rates are recognised wrongly:** a receipt with 100.00 net at 19 % and 50.00
    net at 7 % (gross 172.50) came back as ONE position at 7 % with net 161.21, tax 11.29, gross
    172.50. The gross total was right, the split was not.
  - **sevDesk does not deduplicate:** the same file sent twice made a second draft with the same
    recognised values, without a refusal or a reference to the first.

- **Sources:** [lippoliv/paperlessngx-to-sevdesk](https://github.com/lippoliv/paperlessngx-to-sevdesk)
  (`src/main.py`); recorded 2026-11-16, trial account, Update 2.0 (probe
  `write-voucher-from-file`, opt-in); recorded 2026-11-17, trial account, Update 2.0 (one-off
  check by the orchestrator, run tag `MCP-E2E 20261117-0035-y3q6`).
- **Impact:** Recognition can start a voucher draft (#96), but the result is incomplete: no tax
  rule, no booking account, an unreliable supplier. A tool must poll the draft until the sums
  appear (bounded, a few seconds), show which fields came from sevDesk, and complete tax rule and
  account through the normal update with ReceiptGuidance before anything is finalized. The
  draft exists even if recognition fails, so the tool must name it for cleanup.
- **Handling:** `sevdesk_voucher_recognize_receipt` (`write`;
  `src/domain/drafts/voucher-recognition.ts`) sends a receipt once (multipart, `creditDebit` `C`
  or, with `kind: revenue`, `D`, part `voucher` with the sniffed MIME type, never retried),
  reads the draft at once and then after waits of 1, 1, 2, 2, 3, 3 and 3 s (15 s at most, three
  times the slowest recorded 5 s) until `sumGross` is not 0, and reads the positions. The file
  comes through the shared resolver like any receipt (a path, an upload or an allowed https link);
  the preview shows its full SHA-256, and `fileSha256` refuses other bytes on the real call before
  anything is sent, since the draft it makes cannot be taken back. It takes the file kinds of a
  manual receipt (PDF, PNG, JPEG): sevDesk accepted the PNG, and a photo that is not recognised
  still gives a draft the tool names for completing; for an image the preview and the result say
  that its recognition is unmeasured. The result lists the fields sevDesk filled in
  (`recognition.filledIn`, unchecked), what is missing (`taxRule`, `bookingAccount`,
  `number`, `supplierContact`) and, in trusted notes that never quote recognised text, that
  positions and tax rates can be wrong even when the total is right (a receipt with several
  rates has to be entered again as one position per rate) and how to complete the draft with
  `sevdesk_voucher_update_draft` (`taxRuleId`, positions with `accountDatevId`, checked against
  the ReceiptGuidance) or delete it. Without sums after 15 s it says so and names the draft. An
  answer that does not name the new voucher is an error that says a draft probably exists and
  must be looked for, not created again; a failure after that names the draft as created. The
  answer already names the attached receipt (`document`), so a remote upload is released right
  then, not after the read-back: a read that fails afterwards cannot leave an upload id that a
  retry turns into a second draft.
  Because sevDesk does not deduplicate, the tool runs two duplicate checks of its own. Before the
  upload (#127, in `prepare`, so a dry run shows it too) it compares the file's
  SHA-256 with the `contentHash` of the receipts of the vouchers dated from 183 days before today
  to 31 days after it (`GET /Voucher?embed=document`, D-100; drafts included, both directions,
  one request of up to 1,000 rows) and refuses a match before anything is sent unless
  `allowDuplicate` (a waste guard, not a safety gate); the refusal names up to three vouchers with
  id, fenced Belegnummer, date, gross total and status (fewer when three would pass the
  500-character error cap and cut its closing instruction), and the result lists allowed matches in
  `sameFileCheck.vouchers`. A failed read does not block the upload (the result says it ran
  unchecked), a cut one is reported as partial, and receipts without a checksum are counted as
  not compared. After the recognition it looks for other vouchers of the same direction with the
  same date, gross total and recognised Belegnummer (the supplier text is not compared), reported,
  not refused. It reads one page of up to 1,000 vouchers; when sevDesk has more, when it failed,
  or when there was no recognised date and total to compare, the result says that the check was
  partial or did not run.
  The receipt of such a draft has a Document with `contentHash` null (D-100, recorded
  2026-11-17 for a PDF and a PNG), so the checksum check before a later upload of the same file
  cannot find it (only the scan after the recognition can), `sevdesk_receipt_folder_check`
  cannot match it (it counts it under `coverage.vouchers.withoutChecksum`) and the audit's
  same-receipt rule (`voucher_receipt_twice`) cannot see it; the audit's `duplicates` check still
  pairs two such drafts by direction, document number and gross amount across suppliers
  (`draft_twice`, or `draft_repeats_voucher` against a booked voucher). The preview, the
  description and the result say so.
  `sevdesk_voucher_finalize` refuses the draft, expense or revenue, until both the tax rule and
  every booking account are set (`storedRule`, `storedPositionsFor`).
- **Test:** `test/unit/scripts/gaps-banking-probes.test.ts` ("runs the opt-in probes only when
  named…": the multipart request, the placeholders, the recognised fields, `taxRule` and
  `accountDatev` null). The tool: `test/unit/tools/vouchers/recognize-receipt.test.ts` (the
  multipart body sent once; a revenue receipt with `D`; a PNG with its MIME type and the image
  note; a receipt from a link; `fileSha256` matching and refusing other bytes; recognised at
  once, after waits, and not within the bound; a partial recognition; the several-rates note;
  duplicates, a partial scan, a page without a count and a skipped scan; an unreadable answer; a
  refused upload; a cancelled wait and a failed read naming the draft; recognised text kept out
  of summary and notes; the checksum check before the upload: its query, the refusal in a dry
  run and a real call, at most three vouchers named with the number fenced, fewer when the error
  cap would cut the instruction, `allowDuplicate`, a
  receipt with `contentHash` null not found, partial, failed and cancelled reads);
  `test/regressions/recognition-same-file.test.ts` (the same file refused before the upload,
  sent with `allowDuplicate`, and not found when the earlier copy came from the recognition). The
  upload release: `test/unit/tools/remote-files.test.ts` (released
  from the answer also when the read fails, kept when neither the answer nor the read-back
  shows the receipt). The tier: `test/unit/sevdesk/paths.test.ts` (the multipart POST stays
  `write`). The safety net:
  `test/regressions/recognised-voucher-draft.test.ts` (the finalize refuses a draft shaped like
  the recorded one without a tax rule or a booking account, and accepts it once both are set;
  the normal update completes it, replaces the wrongly split 7 % position with one position per
  rate, and completes a recognised revenue draft that is then accepted). Fixtures
  `test/fixtures/vouchers/voucher-from-file-*.json`, `voucher-positions-from-file.json`.

### D-107: Order factories copy the order; a confirmation marks the offer accepted

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `POST /Order/Factory/createContractNoteFromOrder` and
  `createPackingListFromOrder` take `order[id]` and `order[objectName]` in the query and the order
  (`{id, objectName}`) in the body, and answer 200 with a bare `Model_OrderResponse`. Nothing says
  which source statuses they accept, what the new order copies, how it is numbered or what happens
  to the source.
- **Actual behavior:** Recorded on 2026-11-16 with the order in the query and the body:
  - Both answer the new order itself under `objects` (D-001), not a nested `order` member. The new
    order is a draft (100) of type `AB` (order confirmation) or `LI` (delivery note), with
    `origin: {id: <source>, objectName: "Order"}`, the source's contact, head and foot text, all
    positions (same names, quantities, prices) and the same `sumNet`.
  - Its `orderNumber` is the next number of its range, the one `getNextOrderNumber` peeks, and the
    counter does not move (D-027): two confirmations made in a row got the same `AB` number, three
    delivery notes the same `LI` number.
  - `createContractNoteFromOrder` worked from a **draft** offer (100) as well as a sent one (200),
    and set the source offer to status 500 (accepted) in both cases: creating a confirmation
    accepts the offer, even one that was never sent.
  - `createPackingListFromOrder` worked from a sent offer, a draft confirmation and a sent one,
    and left the source's status alone. A confirmation marked as sent with `sendBy` read back with
    status 500, not 200.
  - One-off check of the sources the probes had not tried: `createContractNoteFromOrder` from an
    offer that is already **accepted** (500) works, gives a draft `AB` with `origin` the offer, and
    the offer stays at 500. From a **rejected** offer (300) it works too and sets the offer to 500:
    the request silently turns a rejection into an acceptance. `createPackingListFromOrder` from a
    **draft** offer (100) works, gives a draft `LI` with `origin` the offer, and leaves the offer at 100.
  - Discounts (recorded 2026-11-18): from a sent offer of 150.00 net with 10 % off, the `AB` and
    the `LI` each got their own discount row (10 %, `isNet` "1") and the offer's sums (net
    135.00, gross 160.65). The numbers again: the copies took the peeked number and the counter
    did not move (D-066).
- **Sources:** spec (`createContractNoteFromOrder`, `createPackingListFromOrder`,
  `Model_CreatePackingListFromOrder`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-order-contract-note-from-order`, `write-order-packing-list-from-order`); recorded
  2026-11-16, trial account, Update 2.0 (one-off check by the orchestrator); recorded 2026-11-18,
  trial account, Update 2.0 (probes `write-discount-order-derived`, `write-reserved-number-ab-li`).
- **Impact:** `sevdesk_order_create_confirmation` (commit tier, because it accepts the offer)
  takes sent (200) and accepted (500) offers only, and its preview says whether the offer becomes
  accepted or stays so. It refuses drafts (that would accept an offer the customer never received)
  and rejected offers (reopening one is its own confirmed step,
  `sevdesk_order_set_offer_status`, D-108). `sevdesk_order_create_delivery_note` (write tier,
  the source stays as it is) takes sent and accepted offers and order confirmations that are
  drafts, sent or accepted; it refuses offer drafts although sevDesk accepts them (nothing was
  offered to the customer yet to deliver on) and rejected offers. An accepted offer as the source
  is not recorded; it is allowed because the factory left every recorded source alone, whatever
  its status (decided 2026-11-17). Both send the order in the query and the body, read the new
  order back (its id comes from the answer itself, `createdDocumentId`, D-064), check that it is
  a draft of the expected type that points to the source, move the counter of its range past its
  number (peek, then one reservation when the counter still offers it; #134, D-027) and look up
  other orders of the type with the same number for a trusted note. They hold the range's
  account-wide lock (`ACCOUNT_ORDER_NUMBERS`), so calls that number confirmations, or delivery
  notes, run one at a time per account. Every real create advances the counter, also for a draft
  deleted later (a possible gap); previews, tool descriptions and the invoices guide say so. A
  failure after the request lists the new order and, for a confirmation, the offer as completed
  writes; a counter step or number check that fails becomes a note. Both refuse a second document from the same
  source unless `allowDuplicate`; the delivery note refuses only a second draft and names
  finalized delivery notes from the same source in a warning (a further one can be a partial
  delivery). Both previews list the source's discounts on the whole document with the rest of its
  content (the shared reader and facts of D-116, so the confirmation's approval binds them too; a
  row of another record is refused), warn when there are several, and say that sevDesk copies a
  discount with the same totals (a surcharge was not checked). (#89)
- **Test:** `test/unit/tools/orders/create-confirmation.test.ts` ("creates the confirmation with
  the offer in query and body, and reads both back", "creates one from an accepted offer and says
  the offer stays accepted", "refuses a draft offer before any request (sevDesk would accept it
  unsent)", "refuses a rejected offer before any request (sevDesk would accept it silently)",
  "names another confirmation with the same number", "names the accepted offer too when the
  confirmation cannot be read back", "shows and binds the offer's document discounts in both
  languages (review of #112, L5)", "refuses when sevDesk lists another order's discount for the
  offer (D-116)"), `test/unit/tools/orders/create-delivery-note.test.ts` ("creates the delivery
  note with the source in query and body, and reads it back", "accepts sent and accepted offers
  and order confirmations that are drafts, sent or accepted", "refuses offer drafts, rejected
  offers and other statuses", "names finalized delivery notes from the order without refusing
  (review of #112, L1)", "shows the order's document discounts (review of #112, L5)"),
  `test/unit/domain/document-discounts.test.ts`,
  `test/regressions/offer-status-and-confirmation.test.ts` ("refuses a confirmation from an offer
  with status 100/300"), `test/regressions/order-factory-number-counter.test.ts`,
  `test/unit/domain/order-follow-ups.test.ts`, `test/integration/order-acceptance-path.test.ts`.
  Live: probes
  `write-order-contract-note-from-order`, `write-order-packing-list-from-order` (their reporting:
  `test/unit/scripts/gaps-documents-probes.test.ts`, "describes order confirmations and delivery
  notes against their source"), and `write-discount-order-derived` for the discounts (observed
  2026-11-18: copied to `AB` and `LI`).

### D-108: `PUT /Order/{id}` sets an offer's status; on a draft it also renumbered it

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `PUT /Order/{orderId}` updates an order with `Model_OrderUpdate`; `status` is a
  field of it. Nothing says which status changes are allowed. For vouchers the same kind of `PUT`
  refuses a status (D-073).
- **Actual behavior:** Recorded on 2026-11-16 with a body of only `{status}`:
  - On sent offers (200), `{status: 500}` (accepted) and `{status: 300}` (rejected) were
    accepted, and `{status: 200}` set both back. The answer is the order under `objects`, with the
    new status. No other field changed.
  - On a **draft** offer (100), `{status: 500}` was accepted too, and the order's `orderNumber`
    changed to another number of the range (in the scrubbed evidence `AN-0007` → `AN-0008`): sevDesk
    renumbers a draft that leaves status 100 this way.
- **Sources:** spec (`updateOrder`, `Model_OrderUpdate`); recorded 2026-11-16, trial account,
  Update 2.0 (probe `write-order-status-accept-reject`).
- **Impact:** Accepting or rejecting an offer is one `PUT /Order/{id}` with `{status}` only
  (`setOrderStatus`, strict body). `sevdesk_order_set_offer_status` (commit tier) accepts or
  rejects only a sent offer (200) and reopens only an accepted or rejected one (back to 200); it
  refuses drafts, so the renumbering never happens through it, and every order that is not an
  offer. The offer is read back afterwards. (#89)
- **Test:** `test/unit/tools/orders/offer-status.test.ts` ("accepts a sent offer with a body of
  only the status, and reads it back", "refuses a draft offer before any request: sevDesk would
  renumber it", "allows accept and reject only from sent, reopen only from accepted or rejected"),
  `test/regressions/offer-status-and-confirmation.test.ts` ("refuses to accept/reject/reopen a
  draft offer", "builds and sends only {status}"). Live: probe `write-order-status-accept-reject`
  (`test/unit/scripts/gaps-documents-probes.test.ts`, "sets offer statuses, sets them back, and
  records the renumbering of a draft").

### D-109: `DELETE /Order` and `DELETE /CreditNote` delete only drafts

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `DELETE /Order/{orderId}` and `DELETE /CreditNote/{creditNoteId}` delete the
  record; nothing says for which statuses, and the answers are not described in detail.
- **Actual behavior:** Recorded on 2026-11-16: on an offer draft and on credit note drafts (with
  and without a number) the DELETE answers `{objects: [null]}`, after which GET answers 404, as for
  vouchers (D-074) and invoices (D-024). A sent offer (200) is refused with 409 "Order can only be
  deleted in status 100 but is status 200" and stays. A finalized credit note was not at hand.
  Deleting a draft saved with a peeked number does not move the counter; deleting the one saved
  with the number reserved last gives that number back (D-066).
- **Sources:** spec (`deleteOrder`, `deletecreditNote`); recorded 2026-11-16, trial account,
  Update 2.0 (probe `write-delete-draft-order-credit-note`).
- **Impact:** The draft delete tool refuses anything but status 100 before sending, reads back
  with a plain GET to confirm, and turns a 409 into a trusted message that nothing was deleted
  (`deleteDocument` in `src/domain/lifecycle/actions.ts`). The GET maps nothing: an answer means
  the document is still there, a 404 or an empty answer that it is gone, and any other failure is
  reported with the deletion as a completed write. A draft can hold a number that was issued,
  since open invoices and credit notes can be reset to draft. So the preview of a numbered order
  or credit note draft says the number comes back only if it was the last one handed out, and the
  preview of an invoice draft with a number warns that deleting it leaves a gap if the number was
  issued (more strongly when sevDesk records it as sent) and that an issued invoice is cancelled
  instead. A warning, not a refusal: the record does not tell whether the number was issued.
  Where sevDesk enshrines on finalizing, an enshrined invoice refuses `resetToDraft` and deletion
  (D-023, D-059), so the gap cannot arise there. (#90)
- **Test:** `test/unit/tools/documents/delete-draft.test.ts` ("deletes a … draft and confirms
  with a GET that it is gone", "says so when sevDesk still returns … after the DELETE", "reports
  the deletion as done when the read-back …", "explains sevDesk's 409 for a document that is no
  draft anymore", "says that the number of a numbered … draft comes back only if it was the last
  (D-066)", "an invoice draft with a number …"), the German previews in
  `test/integration/__snapshots__/write-previews-de.test.ts.snap` ("delete a numbered credit note
  draft", "delete an invoice draft that has a number and was sent"),
  `test/regressions/delete-only-drafts.test.ts` (no DELETE for a non-draft or a template),
  `test/unit/domain/lifecycle/transitions.test.ts` (`assertDeletable`). Live: probe
  `write-delete-draft-order-credit-note` (`test/unit/scripts/gaps-documents-probes.test.ts`,
  "deletes drafts, records the refusal of non-drafts, and follows the counters").

### D-110: `saveCreditNote` with an id updates a draft; `creditNotePosDelete` is a list

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `saveCreditNote` can update credit notes like `saveInvoice` (D-054) and declares
  `creditNotePosDelete` as one `{id, objectName}` object.
- **Actual behavior:** Recorded on 2026-11-16:
  - `saveCreditNote` with `creditNote: {id, objectName, mapAll, header}` only (and
    `creditNotePosSave: []`, `creditNotePosDelete: null`) updates the draft in place: the answer
    names the same id, and only `header` changed; the other fields stayed.
  - `creditNotePosDelete` as an array of `{id, objectName: "CreditNotePos"}` together with a new
    position in `creditNotePosSave` replaced the position and recomputed the sums. As one object
    it is refused with 400 "creditNotePosDelete expected array with 'id' and 'objectName'. integer
    given" (as `voucherPosDelete`, D-054).
  - A credit note made by `createFromInvoice` keeps `origin`, `refSrcInvoice`, type `CN` and its
    number through a header-only update; its `discountTime` went from `null` to `"0"`.
- **Sources:** spec (`createcreditNote`, `Model_creditNote` request schema); recorded 2026-11-16,
  trial account, Update 2.0 (probe `write-credit-note-update-draft`).
- **Impact:** `sevdesk_credit_note_update_draft` works like the invoice update (D-054): one
  `saveCreditNote` with the id and every stored field carried over; replaced positions go out
  with `creditNotePosDelete` as an array. (#90)
- **Test:** `test/regressions/credit-note-pos-delete-list.test.ts` ("sends the stored positions
  as a list of refs when one position is removed", "refuses the spec's single-object form before
  sending"), `test/unit/tools/drafts/credit-note-update-draft.test.ts` ("changes one field and
  carries every stored field over, positions untouched", "keeps origin, refSrcInvoice, type and
  number of a credit note made from an invoice", "replaces all positions in one request and checks
  them against the source invoice", "fails loudly when sevDesk saved a different credit note").
  Live: probe `write-credit-note-update-draft` (`test/unit/scripts/gaps-documents-probes.test.ts`,
  "updates credit note drafts in place, replaces positions and keeps the invoice link").

### D-111: Recurring templates run from `accountStartDate`; `accountNextInvoice` is ignored

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** A recurring invoice template is an invoice with `invoiceType: "WKR"`;
  `accountIntervall` ("ISO-8601 duration", D-014) and `accountNextInvoice` are its schedule. The
  request model marks both read-only and names no start or end date. Issue #91 assumed the
  voucher fields `recurringInterval`, `recurringStartDate`, `recurringNextVoucher`.
- **Actual behavior:** Recorded on 2026-11-16 with `saveInvoice` (status 100):
  - `accountIntervall` is stored as any string sent: `P0Y1M0W`, `P1M`, `P0Y0M1W`, `P0Y3M`,
    `P1Y`, but also `1 month` and `monthly`; nothing is validated.
  - `accountNextInvoice` alone is not stored, as Unix seconds, `dd.mm.yyyy` or ISO.
  - `accountStartDate` (Unix seconds, ISO or `dd.mm.yyyy`) is stored and sets `accountNextInvoice`
    to the same date; sent together, both read back as the start date. A start date in the past
    (yesterday) was accepted. `accountEndDate` in the same three forms is stored on its own.
    `accountLastInvoice` stayed `null`. Dates read back as ISO date-times (`…T00:00:00+01:00`).
  - The same holds for an update with the template's id through `saveInvoice` and through
    `PUT /Invoice/{id}` (not in the spec; D-024).
  - `invoiceDate` does not drive the schedule, and the `recurring…` fields are dropped silently
    (D-003).
  - Recorded on 2026-11-17, updates through `saveInvoice` with
    `invoice: {id, objectName, mapAll, …}` and only the named fields: such a minimal body keeps
    type `WKR`, contact, header, status, schedule and positions (with no position keys, with
    `invoicePosSave: []` and `invoicePosDelete: null`, or both `null`). `accountIntervall` alone is
    stored and moves neither `accountStartDate` nor `accountNextInvoice`. `accountEndDate` alone is
    stored and moves nothing else; `accountEndDate: null` removes it, an empty string is refused
    with 500 "No date part in '' found.". A new `accountStartDate` moves both start and next run
    (for a template that has run, see below). A header alone is stored.
  - On a run date (recorded 2026-11-17): whether sevDesk generates anything is decided by
    automatic generation (D-132), not by the status (D-112). With it on and a run due, sevDesk
    created within about a minute (30–40 s
    observed) an invoice of type `RE` at status 100 (a draft) with `origin` the template,
    `sendDate` `null`, not enshrined and `sendType` copied (`"0"` from a template made through the
    API, `null` from one made in the web app). Its `invoiceDate` is the moment of generation,
    `deliveryDate` the run date and `deliveryDateUntil` the run date plus the interval minus one
    day. The head text gets the line "Berechnung für den Zeitraum vom 17.11.2026 bis zum
    16.12.2026", the placeholder `[%Rechnungsnummer%]` in the header becomes "Rechnung Nr. …", and
    positions, foot text and address are copied. The template then has `accountNextInvoice` one
    interval later, `accountLastInvoice` the moment of generation, and status 100.
  - All four forms this server sends are understood: `P0Y1M0W` (1 month), `P0Y3M0W` (3 months),
    `P0Y6M0W` (6 months), `P1Y0M0W` (1 year).
  - The number of a generated draft is provisional: five generated drafts all showed RE-1065;
    finalized with `sendBy` they got RE-1065, RE-1066, RE-1067 and so on, and the header followed.
    Generated drafts go through the lifecycle tools like any draft.
  - A start date three months in the past, generation on: sevDesk caught up one period a minute,
    four drafts (17.08.–16.09., 17.09.–16.10., 17.10.–16.11., 17.11.–16.12.), then set the next
    run to 17.12.2026.
  - A new start date on a template that had already run moved start and next run to it and
    cleared `accountLastInvoice`; with a start that was due, sevDesk generated a second draft for a
    period it had already billed.
  - The web app's own template: monthly is stored as `P0Y1M`, 7 days as `P0Y0M1W`;
    `accountStartDate` and `accountNextInvoice` carry the time of day
    (`2026-11-17T11:08:32+01:00`); `sendType` is `null` and `invoiceNumber` `""`. The web app
    sends `accountNextInvoice` together with `accountStartDate`, `taxType: "default"` and
    `taxRule` 1. Its form offers 7 and 14 days, monthly, 2 months, quarterly, half-yearly, yearly
    and 2 to 5 years (the stored forms of the others are not recorded), and "Nachfällig" (in
    arrears): the property `propertyIsDeferred`, read with `embed=propertyIsDeferred` (`null`
    without the tick). For the period it shows, the form asks
    `POST /Invoice/Factory/calculateInvoicingRange` with `{startDate, interval, isDeferred}`.
  - Invoices generated from a template are listed by `GET /Invoice` with `origin[id]`,
    `origin[objectName]=Invoice` and `showAll=true`: the listing returned exactly the invoices
    generated from that template (confirmed 2026-11-17). Each carries `deliveryDate` (its run
    date) and `deliveryDateUntil` (the last day of its period).
  - What sevDesk does when a template reaches its end date (whether it stops, and whether
    removing the end date later restarts it with a catch-up) is not recorded.
  - Recorded again on 2026-11-18 (`write-recurring-schedule-fields`): `accountStartDate` as Unix
    seconds, ISO or `dd.mm.yyyy` stores start and next run; `accountNextInvoice` alone (ISO) and
    `invoiceDate` alone store no schedule date; `accountEndDate` in all three forms stores the end
    alone; the same through an update with the id (`saveInvoice` and `PUT /Invoice/{id}`); an
    update to status 200 keeps the schedule, and such a template is deleted only after status 50.
  - Month ends (recorded 2026-11-18): monthly templates starting on 29, 30 or 31 January 2027
    store that day as start and next run; one starting on 31 January with an end on 28 February
    stores both. `POST /Invoice/Factory/calculateInvoicingRange` (monthly, not deferred, start
    31 January) answers the period 31 January to 27 February and the next invoice date 28
    February: the web app's computation moves the 31st to the month's last day. Whether the
    scheduler does the same, and whether it returns to the 31st in March, is not recorded.
  - A template saved with its start (and next run) yesterday and a 10 % discount had generated
    nothing right after the save (recorded 2026-11-18, `write-recurring-template-due`); the probe
    does not switch automatic generation on, which is off by default (D-132), so nothing is
    expected. What it shows the next day, and whether generated invoices carry a template's
    discount, is not recorded yet (`read-recurring-generated`, `read-recurring-generated-discounts`).
- **Sources:** spec (`Model_Invoice`, `Model_InvoiceResponse`); recorded 2026-11-16, trial
  account, Update 2.0 (probes `write-recurring-template-create`, `write-recurring-interval-formats`,
  `write-recurring-schedule-fields`, `write-recurring-template-due`;
  `test/fixtures/recorded/2026-11-16/invoices/recurring-templates.json`); recorded 2026-11-17,
  trial account, Update 2.0 (a template made in the web app by the account owner, a browser
  export of that session, and one-off checks by the orchestrator); recorded 2026-11-18, trial
  account, Update 2.0 (probes `write-recurring-schedule-fields`, `write-recurring-month-end`,
  `write-recurring-template-due`, opt-in).
- **Impact:** A recurring template is created with `invoiceType: "WKR"`, a validated
  `accountIntervall` (the server checks the ISO-8601 form itself, since sevDesk does not: one of
  `P0Y1M0W`, `P0Y3M0W`, `P0Y6M0W`, `P1Y0M0W`) and `accountStartDate`, optionally
  `accountEndDate`; never `accountNextInvoice` or `recurring…`, and never `propertyIsDeferred`.
  A start date in the past is refused (sevDesk would catch up). Reads show interval (any
  ISO-8601 duration, the four intervals in every spelling, others described), next run, start,
  end and last run as Berlin days: `sevdesk_invoice_get` and the rows of `sevdesk_invoices_list`
  carry the stored schedule of a template (`readStoredSchedule`). A template is changed with a
  minimal body (the id and only what changes, never `invoiceType` or `status`), and `null`
  removes the end date. Since a new start clears `accountLastInvoice`, whether a template has run
  is decided by the invoices that name it as `origin`: a new start must lie after today and after
  the period of the newest of them, else sevDesk would bill a period again. Their origin is
  re-checked locally all the same (D-015), and one without either delivery date refuses the new
  start, since its period cannot be told. An update that removes an end date, or moves it past a
  next run before today, on an active template with automatic generation on is refused unless it
  sets a new start: with the end date out of the way, nothing recorded keeps sevDesk from catching
  up (the end date's own effect is not recorded). A template made in the web app (an interval this
  server does not offer, a run time other than 00:00) can still be ended and changed: its interval
  is shown as stored, its later runs are not computed, no preview names midnight as its run time,
  and a next run today is said to come at its stored time. (#91)
- **Test:** `test/contract/recorded-gaps-documents.test.ts` ("carries the schedule fields the
  parser does not read yet", "reads through the invoice parser: interval as sent, next run as a
  Berlin date", "reads through the template reader: interval, start, next run and end as
  stored (D-111)", "shows the schedule in sevdesk_invoices_list rows of templates"); the create
  tool: `test/unit/domain/recurring/payload.test.ts` (never `accountNextInvoice` or `recurring…`,
  always `WKR`), `test/unit/domain/recurring/schedule.test.ts` ("refuses a start in the past:
  sevDesk catches up one missed period a minute (D-111)", "reads a template made in the web app:
  P0Y1M, dates with a time of day, the settings", "describes another duration … instead of
  failing"), `test/unit/tools/invoices/recurring-create.test.ts` ("prepares a WKR body with the
  schedule and reads only (D-111)", "says where sevDesk stored another schedule, type, status or
  total than was sent"); the update tool: `test/unit/domain/recurring/payload.test.ts` ("never
  sends a type, a status or the next run"), `test/unit/tools/invoices/recurring-update.test.ts`
  ("a new interval: accountIntervall alone, the next run stays", "an end date alone, and null to
  remove one", "a new start date moves the next run too", "a new start after the newest period
  the template generated (found by origin)", "schedule {"startDate":"2026-11-16"}", "schedule
  {"startDate":"2026-11-17"}", "a template made in the web app: its interval and run time as
  stored", "a new start when a generated invoice has no delivery date: its period cannot be
  told", "an end date change that lets a past next run happen (catch-up, D-111)", "switches it on
  for a next run today at a later stored time: names that time"),
  `test/unit/domain/invoices.test.ts` ("reads a template's switches with the settings embed
  (D-132)"), `test/unit/tools/invoices/recurring-status.test.ts` ("ends a template made in the web
  app (an interval this server does not offer)", "a template made in the web app: runs at its
  stored time, the later runs not listed", "names the stored run time of a next run today that is
  later than now (web app)"). Live (#136): probe `write-recurring-month-end` stores start dates
  on the 29th, 30th and 31st and an end date (`test/unit/scripts/gaps-documents-probes.test.ts`,
  "stores month-end start dates, asks for the invoicing range and deletes every template";
  observed 2026-11-18, see above); the run day in a shorter month and the effect of the end date
  need a template that runs for weeks (open). `src/domain/recurring/schedule.ts` therefore still
  says that a run on the 29th to 31st may move in a shorter month.

### D-112: Recurring templates: status 50 ends, status 200 blocks `DELETE`, lists hide them

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** Status 50 is "Deactivated recurring invoice". The Invoice tag's filter table
  offers `showWkr=all` (D-049). Nothing says how a template is started, ended or deleted.
- **Actual behavior:** Recorded on 2026-11-16:
  - A new template has status 100. `saveInvoice` with its id and `status: "50"` deactivates it,
    `status: "100"` sets it back; `status: "200"` is accepted too and keeps the schedule.
  - Status 100 is what the web app's "Speichern und aktivieren" stores, shown there as "Aktiv"
    (recorded 2026-11-17). The status does not decide generation: templates at 100 and at 200, due
    on 2026-11-15 and 2026-11-17, generated nothing in 36 hours while automatic generation was off
    (D-132).
  - An ended template (status 50) with automatic generation on and a run due generated nothing in
    two minutes; set back to status 100, it generated a draft within the next minute (recorded
    2026-11-17).
  - `DELETE /Invoice/{id}` deletes a template at status 100 and at 50 (`{objects: [null]}`, then
    404), but refuses one at 200 with 409 "Invoice can only be deleted in status 100 but is status
    200"; such a template has to be set to 50 or 100 first.
  - The default `GET /Invoice` leaves templates out; `showWkr=all` and `invoiceType=WKR` list
    them (only templates), `showAll=true` too. A template has no number and no `sendDate`.
  - Status 50 keeps every schedule field as it was, `accountNextInvoice` included, so an ended
    template's next run is no run that will happen. An update of other fields at status 50 is
    accepted; status back to 100 keeps the schedule unchanged (recorded 2026-11-17).
- **Sources:** spec (Invoice tag, status table and filters); recorded 2026-11-16, trial account,
  Update 2.0 (probes `write-recurring-template-update-end`, `write-recurring-schedule-fields`,
  `write-recurring-template-create`); recorded 2026-11-17, trial account, Update 2.0 (a template
  made in the web app by the account owner, a browser export of that session, and one-off checks
  by the orchestrator).
- **Impact:** A new template is saved with status 100. Ending a template is `saveInvoice` with its
  id and `status: "50"` alone (`sevdesk_invoice_end_recurring`): it generates nothing afterwards,
  even with automatic generation on, and keeps that switch. Reactivating sends the save status
  (`sevdesk_invoice_reactivate_recurring`); with automatic generation on, a due run generates
  within a minute, which its preview says, and a next run before today is refused (sevDesk would
  catch up). Reads mark a template at 50 as ended. sevDesk deletes a template only at 50 or 100;
  deleting one is left to the web app. The lifecycle tools keep refusing templates
  (`refuseTemplate`); invoices generated from one are not refused because of it.
  `sevdesk_document_delete_draft` refuses templates at every status, 100 and 50 included
  (`assertDeletable`): a template is no draft, and it is ended with
  `sevdesk_invoice_end_recurring`. (#91)
- **Test:** `test/contract/recorded-gaps-documents.test.ts` ("lists only templates, active ones
  (status 200) included, with total and paging", "marks an ended template's schedule"),
  `test/regressions/recurring-template-guards.test.ts` (no tool finalizes, sends, books, cancels,
  enshrines, resets, updates, sets the layout of, deletes, reminds of or credits a template, or
  books a bank transaction to it, at status 100, 200 or 50, nor after the template tools changed
  and ended it; an invoice generated from a template is not refused as one),
  `test/unit/domain/recurring/payload.test.ts` ("saves with the recorded status of a new template
  (D-112)", "sends status 50 or the save status as text, and nothing else"),
  `test/unit/domain/lifecycle/transitions.test.ts` (`assertDeletable`, "refuses recurring invoice
  templates, active or not"), `test/regressions/delete-only-drafts.test.ts` ("refuses an active
  recurring template / a recurring template at status 100 / a deactivated recurring template
  without a write"), `test/unit/tools/invoices/recurring-status.test.ts` ("sends status 50 and
  nothing else", "previews what ends and what stays, in English and German", "previews that
  sevDesk generates drafts again (generation on), with the run dates", "says that a next run today
  is due at once", "with generation off: reactivating alone generates nothing, also with a past
  next run", "refuses a next run in the past", "refuses no next run with generation on").

### D-113: `changeParameter` answers the layout in `metaData`; orders need a preview first

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `PUT /{Invoice,Order,CreditNote}/{id}/changeParameter` takes `{key, value}`
  (`Model_ChangeLayout`: `language`, `template`, `letterpaper`, `payPal`) and answers
  `Model_ChangeLayoutResponse` (`{result, metadaten: {pdf, docId}}`). `POST /Invoice/{id}/render`
  declares `{pdf, docId, parameters: [{key, name, values, visible, value}]}`.
- **Actual behavior:** Recorded on 2026-11-16 on drafts:
  - Invoices: each key is accepted. The answer is `{objects: {metaData: {docId, parameters,
pdf}}}`. `parameters` lists 15 print options with their current `value`, `values` (the choices)
    and `visible`: `language` (8 choices), `template` (21), `letterpaper` (2), `payPal`,
    `epcQrCode`, `printDeliveryReturn`, `printFooter`, `printPageNumbers`, `printCustomerNumber`,
    `printContactPerson`, `logoSize`, `color`, `printPosTax`, `printPartNumber`,
    `printFoldLines`. The chosen template and letterpaper read back as `value`; after `en_US` the
    language read `en`.
  - The record does not change: status, `sendDate`, `sendType`, number and even `update` stay, and
    no field of `GET /Invoice/{id}` (also with `embed=document|letterpaper|template|language`) nor
    of the `getPdf` answer holds the choices. They live in the rendered document (`docId`). A
    second call without a change answers the same `metaData`, and `POST /Invoice/{id}/render
{forceReload: false}` answers `{docId, pdf, parameters}` with the same values, also without
    changing the draft.
  - Orders and credit notes: every call was refused with 500 "Syntax error" until the draft had a
    `getPdf` preview (`preventSendBy=true`); after it the call is accepted and answers
    `{result, metaData}`. Orders list 17 options (no `payPal`; `qrCode`, `printAcceptance`,
    `sumBlock`; `letterpaper` without a value), credit notes 15 (`printSwissPaymentSlip`, no
    `printCustomerNumber`).
  - The trial has one letterpaper; the template list is in D-114.
  - Checked on 2026-11-17: `POST /Order/{id}/render` and `POST /CreditNote/{id}/render` (not in
    the spec) with `{forceReload: false}` answer `{docId, pdf, parameters}` at the top level, also
    on a draft without a preview, and leave the record unchanged; so does the invoice render on a
    finalized invoice. On one order draft a render was enough for a later `changeParameter`. An
    empty `letterpaper` value (`""`) on orders and credit notes means none was chosen. The
    language values differ per kind (D-140).
- **Sources:** spec (`updateInvoiceTemplate`, `updateOrderTemplate`, `updateCreditNoteTemplate`,
  `Model_ChangeLayout`, `Model_ChangeLayoutResponse`, `invoiceRender`); recorded 2026-11-16, trial
  account, Update 2.0 (probes `write-change-parameter-draft`, `write-change-parameter-read-back`);
  recorded 2026-11-17, trial account, Update 2.0 (one-off checks by the orchestrator).
- **Impact:** `sevdesk_document_set_layout` sets language, template and letterhead of drafts only,
  one `changeParameter` per key, never retried, and reads the layout back. It is a `commit` tool,
  because the HTTP client keeps requiring `commit` for the endpoint (`src/sevdesk/paths.ts`): the
  same request changes finalized documents. For orders and credit notes it first fetches a
  `getPdf` preview (`preventSendBy=true`, which leaves a draft a draft, B1), the step recorded on
  both kinds. Since the record does not show the layout, the tool and the finalize and send
  previews of drafts read it with `render` `{forceReload: false}`, which the client treats as a
  read (`src/sevdesk/read-posts.ts`: allowed in read-only mode and dry runs, never retried), and
  never show the base64 `pdf`. An empty letterpaper is shown as "none chosen". (#94)
- **Test:** `test/unit/tools/documents/layout-tool.test.ts` ("sends one changeParameter per key,
  in order, as commit, the language in the locale form", "names what was set when a later request
  fails, and never repeats one", "shows an empty letterhead as none chosen");
  `test/regressions/layout-getpdf-prevent-send.test.ts`;
  `test/regressions/approval-binds-document-layout.test.ts`; `test/unit/sevdesk/read-posts.test.ts`
  ("never retries the render read", "still blocks a forced re-render in read-only mode before
  sending"); `test/unit/domain/layouts.test.ts` ("reads render's top-level parameters and
  changeParameter's metaData alike"). Live: probes `write-change-parameter-draft`,
  `write-change-parameter-read-back` (`test/unit/scripts/gaps-documents-probes.test.ts`, "reads
  changeParameter choices back from metaData and render, and finds the order form").

### D-114: DocServer layout lists sit under `objects` and carry large base64 fields

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `GET /DocServer/getLetterpapersWithThumb` answers `{result, letterpapers: [{id,
pdf, sevClient, name, default, img}]}`, `GET /DocServer/getTemplatesWithThumb?type=…` answers
  `{result, templates: [{id, name, translationCode, sevClient, type, html, default, premium}]}`.
- **Actual behavior:** Recorded on 2026-11-16: both lists sit under `objects` (D-001).
  Letterpapers: `objects: {result: 1, letterpapers: [...]}`, rows with `id` (a string; 24 hex
  digits in the spec's example, scrubbed in the recording),
  `pdf` (base64, about 114 KB), `sevClient` (`"0"` for stock entries), `name`, `default` (a
  number), `isCustom` (boolean, undeclared) and `img` (base64 thumbnail, about 86 KB); the trial
  has one. Templates: `objects: {templates: [...]}`, 147 stock rows without a type and 21 per
  type (`Invoice`, `Order`, `Creditnote`), one default per type; rows add `isCustom`,
  `pdfreactorVersion` and sometimes `structure`, `default` is a boolean or a number, `img` holds
  up to 184 KB and `html` up to 74 KB. The whole template list is 3.2 MB even scrubbed, so it is
  not recorded as a fixture; the letterpaper list is.
- **Sources:** spec (`getLetterpapersWithThumb`, `getTemplates`); recorded 2026-11-16, trial
  account, Update 2.0 (probe `read-docserver-layouts`; `pnpm fixtures:record`,
  `test/fixtures/recorded/2026-11-16/layouts/letterpapers.json`).
- **Impact:** `sevdesk_reference_lookup` (`letterpapers`, `templates` with `documentType`) and
  `sevdesk_document_set_layout` read the lists (templates of one `type` only) through a capped
  download (16 MiB, `LAYOUT_LIST_MAX_BYTES` in `src/domain/layouts.ts`), keep only id, name, the
  default flag, `isCustom`, `premium`, `type` and whether `sevClient` is `"0"`, and drop `pdf`,
  `img`, `html` and `structure` before anything reaches the model. `default` is read as a boolean
  or a number. Both lists are sent without `limit`, an exception to the explicit-limit rule: the
  recorded untyped template call sent none and got all 147 rows, past sevDesk's usual cut at
  100, and the byte cap bounds the answer instead. `sevdesk_api_get` keeps its 1 MiB cap and keeps
  refusing `DocServer` (D-024). (#94)
- **Test:** `test/contract/recorded-gaps-documents.test.ts` ("answers result and letterpapers
  under objects, with the thumbnails scrubbed", "is what read-docserver-layouts describes, without
  any base64", "reads through the letterhead list parser: id, name and flags, no PDF or
  thumbnail"); `test/unit/domain/layouts.test.ts` ("reads `default` as a boolean or a number, as
  recorded (D-114)", "refuses a list larger than the cap without reading it, as an expected
  limit", and without `limit`: "reads letterheads as id, name and flags, without the PDF or the
  thumbnail", "reads the %s templates with type %s and keeps that type only");
  `test/unit/tools/meta/reference-lookup-layouts.test.ts`.

### D-115: `POST` and `DELETE /TextTemplate` create and delete text templates

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `/TextTemplate` is not in the spec (D-024).
- **Actual behavior:** Recorded on 2026-11-16: `POST /TextTemplate` with `{objectName:
"TextTemplate", mapAll: true, name, text, category: "DOCUMENT", objectType: "RE", textType:
"HEAD"}` answers the new row under `objects` (`id`, `objectName`, `additionalInformation`,
  `create`, `update`, `name`, `text`, `objectType`, `textType`, `sevClient`, `main` `"0"`,
  `category`); GET by id answers the same keys, and the `textType=HEAD` filter lists it.
  `DELETE /TextTemplate/{id}` answers `{objects: [null]}`, then GET answers 404.
  - Checked on 2026-11-17: `POST /TextTemplate` does not validate `objectType`. The rows recorded
    on 2026-11-10 (D-024) have `objectType` `RE`, `AN`, `MA`, `PAYMENT_CONFIRMATION` and `ALL`;
    none is `AB`, `LI` or a credit note's.
- **Sources:** recorded 2026-11-16, trial account, Update 2.0 (probe
  `write-text-template-create-delete`); recorded 2026-11-17, trial account, Update 2.0 (one-off
  checks by the orchestrator).
- **Impact:** Text templates are chosen by name, not created or deleted (no tool does that). The
  invoice and order draft tools take `headTextTemplate` and `footTextTemplate`: invoices resolve
  against `RE` rows, every order type (offer, order confirmation, delivery note) against `AN`
  rows, since no `AB` or `LI` rows were seen and a stored `objectType` proves nothing about where
  sevDesk uses a row; credit notes are not offered. An unknown or ambiguous name is refused, and the text is fenced in the
  preview. The lookup (`text_templates`) and the drafts read them with one `GET /TextTemplate`
  with an explicit `limit` of 1000, which sevDesk ignores (D-024). (#94)
- **Test:** `test/unit/domain/text-templates.test.ts` ("reads every text template with one
  request and an explicit limit", "finds the template of the place and type by name, in any
  case"); `test/unit/tools/drafts/template-texts.test.ts` ("create: an order confirmation takes the
  AN texts too (no AB rows exist)", "refuses an ambiguous name", "is offered by the invoice and
  order draft tools, not the credit note ones"); `test/unit/tools/meta/reference-lookup-layouts.test.ts`
  ("lists every text template, the text cut, with one request and an explicit limit"). Live:
  probe `write-text-template-create-delete` (`test/unit/scripts/gaps-documents-probes.test.ts`,
  "creates and deletes a text template").

### D-116: Document discounts: `discountSave` takes a list; `getDiscounts` reads them

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `saveInvoice` and `saveCreditNote` declare `discountSave` and `discountDelete` as
  one object each (`{discount, text, percentage, value, objectName: "Discounts", mapAll}` and
  `{id, objectName}`); `saveOrder` declares neither. Only `GET /Order/{orderId}/getDiscounts`
  reads discounts (`Model_Discount`: `object`, `text`, `percentage`, `value`, `isNet`).
- **Actual behavior:** Recorded on 2026-11-16 on invoice, order and credit note drafts with one
  position of 100.00 net at 19 %:
  - `discountSave` as a list of one object was accepted by all three factories, for 10 % and for
    a fixed 10.00. The save answer adds a `discount` list. Both gave `sumNet` 90, `sumTax` 17.1,
    `sumGross` 107.1 and **negative** `sumDiscounts` -10 (`sumDiscountNet` -10,
    `sumDiscountGross` -11.9). The stored row has `discount` `"1"`, `percentage` `"1"`/`"0"`,
    `value` `"10"`, `isNet` `"1"` (all strings) and `object: {id, objectName}`.
  - The raw `GET /<kind>/{id}` carries only the sums (`discount` and `discountTime` are Skonto).
    `GET /Invoice/{id}/getDiscounts`, `/Order/{id}/getDiscounts` and `/CreditNote/{id}/getDiscounts`
    (the first and last undocumented) list the rows; `GET /Discounts` (undocumented) lists every
    discount of the account and ignores the `object` filter. For an order without discounts,
    `getDiscounts` answers `{objects: [], total: null}`.
  - `discountDelete` as a list of `{id, objectName: "Discounts"}` in an update with the id
    (`discountSave: null`) removed the discount and the sums went back to 100/119.
  - Checked on 2026-11-17 on an invoice draft (one position of 100.00 net at 19 %): an update with
    `invoice: {id, objectName, mapAll: true, invoiceType: "RE"}`, `invoicePosSave: null`,
    `invoicePosDelete: null`, `discountSave` with a fixed 5 and `discountDelete` with the stored
    10 % row answered 2xx; `getDiscounts` then listed one row (the fixed 5) and the sums were 95,
    18.05, 113.05 (`sumDiscounts` -5). Adding 10 % with `invoicePosSave: null` gave 90, 17.1, 107.1.
  - **Several rows are stored, but the sums count only one.** A second `discountSave` (3 %)
    without a delete left two rows (the fixed 5 and the 3 %), yet the sums were 97, 18.43, 115.43
    (`sumDiscounts` -3): only the newer row counted. One update with both ids in `discountDelete`
    and `discountSave: null` removed both (100, 19, 119).
  - `POST /Invoice/Factory/createInvoiceFromOrder` copies the order's discount: a sent offer (status
    200; a `saveOrder` update with `orderPosSave: null` had put 10 % on it, 90/17.1/107.1) gave an
    invoice draft with the same row and the same sums, and the offer went to status 1000.
  - Recorded 2026-11-18 (the probe sent no `isNet` unless named; positions 100.00 net at 19 %,
    on gross prices 119.00):
    - `isNet` is stored as sent and `"1"` when left out. It does not decide what is deducted on
      gross prices: on an invoice, an order and a credit note with `showNet` false, a fixed
      10.00 gave `sumNet` 91.6, `sumTax` 17.4, `sumGross` 109 (`sumDiscountNet` -8.4,
      `sumDiscountGross` -10) with `isNet` `"1"`, and an invoice sent `isNet: false` (stored
      `"0"`) gave exactly the same: a fixed amount comes off the gross total there. With
      `showNet` true it comes off the net total (90, 17.1, 107.1), with `isNet` `"1"` and, sent
      `isNet: false` (stored `"0"`, probe `write-discount-mixed-tax-uneven`), alike.
    - 10 % on gross prices gave the same sums as on net prices (90, 17.1, 107.1).
    - 19 % and 7 % (100.00 each, net): sevDesk splits the discount by the rates' shares of the
      net total. 10 % gave 180, 23.4, 203.4 (`sumDiscountGross` -22.6); a fixed 10.00 gave 190,
      24.7, 214.7 (`sumDiscountGross` -11.3). The positions keep their undiscounted sums
      (`sumDiscount` 0 on each), and no field shows the tax per rate (the `…Accounting` sums
      equal the plain ones).
    - Uneven splits (probe `write-discount-mixed-tax-uneven`, invoice drafts, one position per
      rate, in this order; 0 % is accepted under tax rule 1). Net prices, `sumNet`/`sumTax`/
      `sumGross`:

      | Positions (net)                            | Discount | Sums                  |
      | ------------------------------------------ | -------- | --------------------- |
      | 70.00 at 19 %, 30.00 at 7 %                | 10 %     | 90, 13.86, 103.86     |
      | 70.00 at 19 %, 30.00 at 7 %                | 9.99     | 90.01, 13.86, 103.87  |
      | 33.33 at 19 %, 66.67 at 7 %, 0.01 at 0 %   | 10.00    | 90.01, 9.9, 99.91     |
      | 33.33 at 19 %, 66.67 at 7 %, 0.01 at 0 %   | 3 %      | 97.01, 10.67, 107.68  |
      | 26.92 at 7 %, 76.54 at 19 %                | 3 %      | 100.36, 15.94, 116.3  |
      | 60.42 at 19 %, 142.47 at 7 %               | 9.99     | 192.9, 20.4, 213.3    |
      | 119.46 at 7 %, 27.78 at 19 %               | 9.99     | 137.25, 12.71, 149.96 |
      | 69.15 at 19 %, 107.01 at 7 %               | 7 %      | 163.83, 19.19, 183.02 |
      | 101.75 at 7 %, 39.05 at 19 %, 80.66 at 0 % | 10.00    | 211.46, 13.89, 225.35 |
      | 76.24 at 0 %, 62.21 at 7 %, 32.45 at 19 %  | 9.99     | 160.91, 9.9, 170.81   |
      | 25.79 at 7 %, 40.18 at 19 %, 28.80 at 0 %  | 9.99     | 84.78, 8.44, 93.22    |
      | 95.72 at 19 %, 35.78 at 7 %, 34.47 at 0 %  | 9.99     | 155.98, 19.44, 175.42 |
      | 32.47 at 0 %, 89.92 at 7 %, 102.48 at 19 % | 9.99     | 214.88, 24.62, 239.5  |

      `sumDiscountNet` is the fixed amount, or the percentage of the net total rounded to cents
      (3 % of 103.46: -3.1). One rule gives all of these and the two even splits above: each rate
      gives up its share of the net deduction by net, rounded half-up to cents, with the cent left
      over on the rate with the largest net; its tax is the rest of its net times the rate,
      rounded to cents; the document's tax is the sum. Of the 48 roundings the cases were chosen
      to tell apart (share rounded or exact; tax rounded on the total, on the deduction, per rate
      on the deduction or per rate on the rest; the leftover cent on the largest, first, last,
      highest-rate or lowest-rate position; a percentage off the total or off each rate), no other
      fits all 15. Four of them (26.92/76.54 with 3 % and three of the three-rate ones) rule out
      the earlier one-rate formula, a rate's position tax less the tax of its share. No recorded
      share or tax lands on a half cent, so half-up at a tie is assumed, not recorded.

    - Gross prices, two rates: 119.00 at 19 % + 107.00 at 7 % with 10 % gave 180, 23.4, 203.4
      (`sumDiscountNet` -20), as on net prices; with a fixed 10.00 it gave 191.15, 24.85, 216
      (`sumDiscountNet` -8.85, `sumDiscountGross` -10); 83.30 at 19 % + 32.10 at 7 % with a fixed
      9.99 gave 91.34, 14.07, 105.41 (-8.66, -9.99). A fixed amount on gross prices is a gross
      amount and comes off the gross total exactly. How it is split into net and tax is not
      settled: three rules give the three gross cases (net less the net total × amount / gross
      total; or a gross share per rate, rounded, then each rate's net from its discounted gross;
      or the net of each gross share) and disagree in about a fifth of other cases.
    - Surcharges (`discount: false`), 100.00 net at 19 %: 10 % and a fixed 10.00 each gave 110,
      20.9, 130.9 (`sumDiscounts` +10, `sumDiscountGross` +11.9); the row reads `discount` `"0"`.
    - A fixed 10.00 on a CHF invoice is 10.00 CHF: the `…ForeignCurrency` sums were 90, 17.1,
      107.1 (`sumDiscountsForeignCurrency` -10); the plain sums are the EUR conversion (D-043).
    - From a sent offer with 10 % (150.00 net), the order confirmation and the delivery note got
      the same row and sums (D-107). A partial invoice (`partialType` TR) and an advance invoice
      (AR), each 50 % by percentage, got **no** discount row and sums 67.5, 12.83, 80.33: half of
      the discounted total.
    - A recurring template (WKR) takes a 10 % `discountSave`, `getDiscounts` reads it, and an
      update with the id that replaces every position (`invoicePosSave` a new one,
      `invoicePosDelete` the old ids, no discount keys) keeps the row (same id); the sums follow
      the new positions (72, 13.68, 85.68 for 2 × 40.00).
    - An e-invoice (finalized with `sendBy`) with 10 % on 100.00 net: `getXml` answered CII with
      the XRechnung 3.0 profile and one document-level `SpecifiedTradeAllowanceCharge`
      (`ChargeIndicator` false, amount 10.00), `AllowanceTotalAmount` 10.00 and
      `TaxBasisTotalAmount` 90.
- **Sources:** spec (`createInvoiceByFactory`, `createcreditNote`, `getDiscounts`,
  `Model_Discount`); recorded 2026-11-16, trial account, Update 2.0 (probes
  `write-document-discount`, `read-order-get-discounts`;
  `test/fixtures/recorded/2026-11-16/orders/order-discounts.json`); recorded 2026-11-17, trial
  account, Update 2.0 (one-off check by the orchestrator: replacement in one request, several
  rows, invoice from an offer; tagged test drafts, removed afterwards; no fixture); recorded
  2026-11-18, trial account, Update 2.0 (probes `write-discount-net-gross`,
  `write-discount-mixed-tax`, `write-discount-foreign-currency`, `write-discount-order-derived`,
  `write-recurring-template-discount`, the opt-in `write-einvoice-discount`, and
  `write-discount-mixed-tax-uneven`, run tag `MCP-E2E 20261118-1541-hdxr`, 19 drafts all
  deleted).
- **Impact:** A document discount goes out as `discountSave: [{…}]` on all three factories and is
  read back with `/<kind>/{id}/getDiscounts`; updates that change it delete the stored rows in
  `discountDelete` (a list) and save the new one in the same request. `sumDiscounts` is negative and
  must be shown as a deduction. With several rows sevDesk's totals do not reflect all of them, so a
  document carries one discount at most. Whatever discount a draft carries is part of the finalize
  approval. (#94) Built so (`src/domain/drafts/discount.ts`, `src/domain/document-discounts.ts`):
  the draft tools' `discount` argument (percent or a fixed amount, net on net prices and gross on
  gross prices, one per document; `null` removes it) reads the stored rows before every update;
  the get and draft tools return them with sevDesk's `sumDiscountNet`/`sumDiscountGross`;
  finalize, send and enshrine, the order
  confirmation and the offer status (`sevdesk_order_create_confirmation`,
  `sevdesk_order_set_offer_status`) bind the rows and list them in both languages, and the
  delivery note preview lists them (D-107); `sevdesk_invoice_create_from_order` shows the order's
  discounts in its preview and the invoice's in its result. Every one reads the rows with the same
  reader and writes each with the same text. The reader refuses a row of another record, a row
  without a value, and a row whose `discount` or `percentage` flag is missing or unreadable:
  recorded rows always carry both, and without one whether it deducts or adds, and whether its
  value is a percentage or an amount, would be a guess. A document with several rows is never
  replaced or removed by the draft tools (the refusal says that sevDesk's totals do not count all
  of them), and the get tools, the from-order tool and all of these approvals warn about it. A
  kept discount is never refused: when the totals cannot be computed with it, the draft update
  preview says that sevDesk computes them. With the 2026-11-18 answers (#134, #155), a new
  discount is accepted everywhere the argument allows: on e-invoices, in other currencies than
  EUR (a fixed amount in the document's currency, shown with that currency), on gross prices and
  over several tax rates. The preview's totals follow the rule above (`discountedTotals`, every
  recorded case a unit test), with the positions of one rate summed first (one position per rate
  is recorded; several are an assumption the read-back checks through the gross total). Not
  computed, with a preview warning instead: a fixed amount on gross prices (the preview shows the
  exact gross total, the read-back compares it, and net and tax are sevDesk's), a new or kept
  discount on stored positions with several rates (the stored sums do not show the net per
  rate), and kept surcharges or percentages stored with `isNet` "0" (not recorded beyond one
  rate; the tools never send either). A new amount above the total (the gross total for a fixed
  amount on gross prices) is still refused. The basis a preview and the DTO show for a fixed
  amount follows the document's price mode, not `isNet` (`appliedDiscount`): gross on gross
  prices, net on net prices. The from-order
  tool says that a partial or advance invoice gets no discount row. The replacement was checked
  on an invoice; orders and credit notes send the same discount keys. The read-back still says
  when sevDesk stored something other than what was sent. `sevdesk_invoice_update_recurring`
  reads a recurring template's discounts with the same reader and never sends discount keys:
  sevDesk keeps them when every position is replaced (recorded), which the preview says; the
  totals of new positions count a kept single discount as the invoice draft update does
  (`updateTotals`), and otherwise the preview says that sevDesk computes them; the read-back
  still compares the discounts with the ones before. Not recorded: whether the invoices a
  template generates carry its discount (`read-recurring-generated-discounts`, pending), a
  surcharge on several rates or on gross prices, how sevDesk splits a fixed gross amount into net
  and tax, and several positions at one rate.
- **Test:** `test/contract/recorded-gaps-documents.test.ts` ("answers an empty list with total
  null for an order without discounts", "reads through the document discount reader: no rows,
  nothing shown or bound"), `test/unit/domain/drafts/discount.test.ts` ("gives the recorded sums
  for 10 % and for a fixed 10.00 on 100.00 at 19 %", "removes the stored discount as recorded
  (discountSave null)", "refuses to remove a discount that is not there, and to change several"),
  `test/unit/tools/drafts/document-discount.test.ts` ("replaces the stored 10 % with a fixed 5.00
  in one request: the checked body and sums", "adds 10 % with invoicePosSave null: the checked
  sums"), `test/unit/tools/invoices/get.test.ts` ("shows a discount on the whole invoice with what
  sevDesk deducted (D-116)"), `test/unit/tools/masterdata/invoice-from-order.test.ts`
  ("sevdesk_invoice_create_from_order with a discount on the whole order"),
  `test/regressions/approval-binds-document-discount.test.ts` (Guard 3: "warns in English and
  German when the document has several discounts"), `test/unit/domain/document-discounts.test.ts`
  (the shared reader and row text; "refuses a row with no discount flag", "… no percentage
  flag"), `test/unit/tools/orders/create-confirmation.test.ts` ("shows
  and binds the offer's document discounts in both languages (review of #112, L5)"),
  `test/unit/tools/invoices/recurring-update.test.ts` ("a discount on the whole template (D-116;
  review of #124, M2)"); the 2026-11-18 answers: `test/unit/domain/drafts/discount.test.ts`
  ("gives the sums recorded on 2026-11-18 for 10 % on gross prices and 10.00 in CHF", "shows a
  stored fixed amount on gross prices as gross, whatever isNet says (D-116)"); #155:
  `test/unit/domain/drafts/discount.test.ts` ("gives the recorded sums for …", one per recorded
  split; "gives the recorded sums for a percentage on gross prices with two rates", "takes a fixed
  amount on gross prices off the gross total and leaves net and tax to sevDesk: …", "computes
  with a fixed amount whatever its isNet (recorded 2026-11-18)", "treats a surcharge as something
  it does not compute"), `test/unit/domain/document-discounts.test.ts` ("takes a fixed amount on
  net prices off the net total, whatever isNet says"),
  `test/unit/tools/drafts/document-discount.test.ts` ("splits a discount over several tax rates
  (recorded 2026-11-18, D-116)", "takes a fixed amount on gross prices as gross and leaves net and
  tax to sevDesk"). Live: probes `write-document-discount`,
  `read-order-get-discounts`, and (#136, #134; `test/unit/scripts/gaps-documents-probes.test.ts`;
  all observed 2026-11-18 but the last but one) `write-discount-net-gross`,
  `write-discount-mixed-tax`, `write-discount-foreign-currency`, `write-discount-order-derived`,
  `write-recurring-template-discount`, `read-recurring-generated-discounts` (invoices generated
  from the discounted template of `write-recurring-template-due`, the day after; pending) and
  `write-einvoice-discount` (opt-in: the allowance in the e-invoice XML); (#155, observed
  2026-11-18) `write-discount-mixed-tax-uneven` (rounding of uneven splits over two and three
  rates, two rates on gross prices, a fixed amount with `isNet` false on net prices, surcharges).

### D-119: The account factories refuse an `accountingNumber` in use or not allowed (422)

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `createFileImportAccount` and `createClearingAccount` take an optional integer
  `accountingNumber`, the booking account of the new account, which "must be unique among all
  your CheckAccounts" ("Ignore to use a sensible default" for a file-import account, "Ask your tax
  consultant what to choose" for a clearing account). Neither says that other numbers are
  refused, nor how a refusal reads. `createFileImportAccount` also takes `importType` (`CSV` or
  `MT940`) and `iban`.
- **Actual behavior:** On the trial account (active numbers 1800, 1801, 1802, 1805, 1806 for
  file-import accounts and 1820 for the offline account; archived test accounts held 1803 and
  1804):
  - A free, allowed number is stored as sent: `clearingAccount` with 1830 and with 1460 created
    an `offline` account (`importType` null, status 100) reading `accountingNumber` `"1830"` /
    `"1460"`; `fileImportAccount {name, importType: "CSV", accountingNumber: 1811}` created an
    `online` account with `importType` `CSV` and `"1811"`. The number reads back as a string.
  - A number in use is refused with 422 "The given account number is already used" (1800 on
    `clearingAccount`, 1801 on `fileImportAccount`).
  - Other numbers are refused with 422 "The given account number 3321 is invalid": 3321 (sent
    as a number and, as `"3322"`, as a string) and 99999, on both factories. sevDesk checks the
    number against a set of allowed booking accounts; that set is known only by these samples
    (1460, 1811, 1830 accepted; 3321, 3322, 99999 refused).
  - Without a number, `fileImportAccount` took `"1807"`, the next free number of the 18xx range;
    it skipped 1803 and 1804, which the archived accounts hold, so an archived account keeps its
    number (D-097: archived accounts are not listed).
  - `importType: "MT940"` is refused: `fileImportAccount` answered 422 "Invalid import type
    given" and created no account (recorded 2026-11-18), although the spec lists it. Whether
    `iban` is taken is still not recorded.
  - Both refusals of a number were confirmed on 2026-11-18 on both factories.
- **Sources:** spec (`createFileImportAccount`, `createClearingAccount`); recorded 2026-11-16,
  trial account, Update 2.0 (one-off checks by the orchestrator, run tags
  `MCP-E2E 20261116-2324-hg4n` and `MCP-E2E 20261116-2325-tgpq`; every account created was
  archived again); recorded 2026-11-16 (probe `write-check-account-factories`); recorded
  2026-11-18, trial account, Update 2.0 (probes `write-transaction-mt940-account`,
  `write-check-account-number-refusals`).
- **Impact:** `sevdesk_bank_account_create` (#88) sends `accountingNumber` only when the user
  gives one, as a JSON integer, after checking that no listed account has it (archived accounts
  hold their numbers but are not listed, so sevDesk's own check remains the last word). The two
  422 refusals become the tool's own sentences ("already used, possibly by an archived account";
  "not accepted as the booking account of a payment account"), without sevDesk's text but with
  the request and sevDesk's exception id; they advise leaving the number out so that sevDesk
  picks one, and name the 18xx range only as recorded on SKR04 (the trial account's chart; which
  number another chart gets is not recorded). The result takes the number from sevDesk's
  answer and reports a different or missing one. The tool always sends `importType` `CSV`, the
  only value sevDesk takes, and never `iban` or `MT940`. The account list still reads `MT940` as
  a file-import account should one exist (from the web app or an older API).
- **Test:** `test/unit/domain/bank-account-create.test.ts` ("sends a file-import account as CSV,
  with a booking account number when given", "refuses a booking account number another account
  (archived ones too) already has", "reads a given booking account back as stored, a string",
  "turns sevDesk's 'already used' refusal into its own sentence without sevDesk's text", "turns
  sevDesk's 'is invalid' refusal into its own sentence without sevDesk's text", "leaves other
  refusals, and refusals without a booking account, as sevDesk sent them"). Live: the one-off
  checks above, and the probe `write-check-account-number-refusals` (both refusals on both
  factories, with the number of the run's own file-import account and 3321;
  `test/unit/scripts/gaps-banking-probes.test.ts`; confirmed 2026-11-18), and
  `write-transaction-mt940-account` (observed 2026-11-18: `MT940` refused with 422; #136).
  `test/unit/domain/bank-account-create.test.ts` pins `CSV` as the only import type sent.

### D-130: `PrivateTransactionRule` cuts texts over 255 characters without notice

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `CreatePrivateTransactionRule` declares `paymentPurpose` and `counterpartName` as
  nullable strings without a `maxLength`, and so does the response model. No limit is mentioned.
- **Actual behavior:** A rule text of 100 or 255 characters is stored in full. Texts of 256 and
  1,000 characters are accepted with 2xx, without an error or a warning, and stored cut to 255
  characters.
- **Sources:** recorded 2026-11-17, trial account, Update 2.0 (one-off checks by the orchestrator,
  together with those of D-099; the rules were deleted again).
- **Impact:** A rule cut short is not the rule the user asked for (a shorter text may match other
  transactions), and nothing says so. `sevdesk_private_transaction_rule_create` (#88) accepts at
  most 100 characters per text, so it never sends a text that sevDesk would cut. Its read-back
  also compares the stored text exactly with the text it sent and notes any difference in the
  result, which would show a cut if that limit were ever raised.
- **Test:** `test/unit/tools/banking/private-rules.test.ts` ("refuses a text over 100 characters
  in its arguments", "notes a stored text cut short, as sevDesk cuts texts over 255 characters").
  Live: the one-off checks above, and the probe `write-private-transaction-rule-storage` (255
  characters kept, 256 cut; confirmed 2026-11-18; `test/unit/scripts/gaps-banking-probes.test.ts`).

### D-132: Recurring templates: generation and auto-sending are switches read by `embed`

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** Nothing: `propertyAutoGenerateRecurringInvoice`, `autoSendConfiguration`,
  `POST /Invoice/{id}/activateAutoSending` and `POST /Invoice/{id}/deactivateAutoSending` are not
  in the spec (D-024).
- **Actual behavior:** Recorded on 2026-11-17:
  - Automatic generation ("Automatische Generierung" in the web app) is the property
    `propertyAutoGenerateRecurringInvoice`, off by default ("deaktiviert"). It is not in the plain
    `GET /Invoice/{id}`; `embed=propertyAutoGenerateRecurringInvoice` adds it, by id and on every
    row of `GET /Invoice?invoiceType=WKR`: `null` when it was never set, `""` after it was switched
    off, `"1"` when on. Off, sevDesk generates nothing (the web app offers a "Rechnung erzeugen"
    button instead); on, see D-111. Combined with the contact,
    `embed=contact,propertyAutoGenerateRecurringInvoice,autoSendConfiguration` on
    `GET /Invoice?invoiceType=WKR` returned the contact and both settings on every row (14 of 14).
  - It is set with `invoice.propertyAutoGenerateRecurringInvoice: true` in a creating
    `saveInvoice` (reads `"1"`), in a `saveInvoice` update (`true` reads `"1"`, `false` reads
    `""`) and with `PUT /Invoice/{id}`. A `PUT` with the string `"0"` stores `"0"`, whose meaning
    is not recorded. `false` in a creating `saveInvoice` is not recorded.
  - Automatic sending ("Automatisches Versenden") is `autoSendConfiguration`, read with
    `embed=autoSendConfiguration`: `null` on every template made through the API. The web app
    switches it on with `POST /Invoice/{id}/activateAutoSending`, body `{sendType: "VM",
timeValue: "P0D", timeValueIsDate: false, textTemplate: {id, objectName: "TextTemplate"}}`,
    and off with `POST /Invoice/{id}/deactivateAutoSending` (no body; the public API accepted it
    with the API token, and the embed read `null` afterwards). The web app calls
    `deactivateAutoSending` right after it creates a template. When on, the embed reads `{id,
objectName: "AutoSendConfiguration", sendDate: null, sendIntervalAfterCreation: "P0D",
sendType: "VM", status: "HEAD", textTemplate: {id, objectName: "TextTemplate"}, sevClient,
object: {id: <template id>, objectName: "Invoice"}}`.
  - With both switches on, sevDesk generated the invoice 35 seconds after generation was switched
    on and about a minute later finalized it (status 200, number RE-1068), e-mailed it with the
    PDF attached (`sendType: "VM"`, `sendDate` 11:47:03) and enshrined it (11:47:04); the e-mail
    arrived at 11:47. Nobody sees such an invoice before the customer does, and it cannot be
    changed afterwards.
- **Sources:** recorded 2026-11-17, trial account, Update 2.0 (a template made in the web app by
  the account owner, a browser export of that session, and one-off checks by the orchestrator).
- **Impact:** The create tool sends `propertyAutoGenerateRecurringInvoice: true` (on by default)
  or leaves it out for off (it then reads `null`); never `false`, `"0"` or `autoSendConfiguration`,
  and the server never calls `activateAutoSending`. It reads both back with
  `embed=propertyAutoGenerateRecurringInvoice,autoSendConfiguration` and notes every difference.
  Reads expose automatic generation as on, off or unrecorded, and automatic sending as a boolean
  with its `sendType`, never the configuration's ids or texts: `sevdesk_invoice_get` reads a
  template once more with the embed, and `sevdesk_invoices_list` adds it to `embed=contact` for
  `type: recurring` (recorded on every row). The update tool sends `true` or `false` in a
  `saveInvoice` update (`autoGenerate`) and compares the switch read back. Switching it on with a
  next run before today is refused unless the same call sets a new start (sevDesk would catch
  up); with a next run today the preview says the first draft comes at once, or at the stored run
  time of a template made in the web app. The update
  and reactivate tools refuse a template with automatic sending on, or whose settings sevDesk
  did not return, since this server cannot preview the e-mails; the end tool is allowed and says
  that it stops them. (#91)
- **Test:** `test/unit/domain/recurring/payload.test.ts` ("sends automatic generation only as
  true, or not at all (D-132)", "never sends autoSendConfiguration: this server does not switch
  on automatic sending"), `test/unit/domain/recurring/schedule.test.ts` ("reads automatic
  generation stored as %j", "reads automatic sending as on only when sevDesk returns a
  configuration, with its sendType", "leaves the settings out of a record read without the
  embed"), `test/unit/tools/invoices/recurring-create.test.ts` ("automatic generation (D-132)",
  "compares automatic generation and sending as stored with what was sent (D-132)"),
  `test/unit/domain/invoices.test.ts` ("reads a template's switches with the settings embed
  (D-132)"), `test/unit/tools/invoices/list.test.ts` ("asks sevDesk to show recurring templates
  and reminders when that type is requested": the combined embed for `type: recurring`),
  `test/unit/tools/invoices/recurring-update.test.ts` ("switches automatic generation off, and
  says what that means", "switches automatic generation on for a next run after today", "switches
  it on for a next run today: the first draft comes at once", "switches it on for a past next run
  only together with a new start", "switching generation on with a next run before today, naming
  the catch-up", "a template with automatic sending on, or whose settings sevDesk did not
  return", "checks the switch read back after changing it"),
  `test/unit/tools/invoices/recurring-status.test.ts` ("ends a template with automatic sending
  on, saying that it stops the e-mails", "refuses automatic sending on", "refuses settings sevDesk
  did not return", "refuses a generation value whose meaning is not recorded").

### D-135: `saveInvoice` keeps the price of a position sent by its id, without an error

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** The `InvoicePos` tag says a document and its positions are changed through the
  save factory with the ids and `mapAll`; nothing says a field of a stored position cannot be
  changed that way.
- **Actual behavior:** Recorded on 2026-11-17 on recurring invoice templates (WKR), each with its
  id in one `saveInvoice`:
  - Position A sent by its id with only a new price (`{id, objectName: "InvoicePos", mapAll:
true, price: 200}`) in `invoicePosSave`, a new position C in `invoicePosSave` and position B
    in `invoicePosDelete`: C was added, B deleted and the sums recalculated, but A kept its old
    price.
  - A position sent by its id with all its fields (`quantity: 2`, a new `name`, `unity`,
    `taxRate: 19`, `price: 333`; stored price 300): name and quantity were stored, the price
    stayed 300, and the sums followed the old price (net 650 = 2 × 300 + 40 + 10).
  - Neither request got an error. So the price of a stored position is not changed in place in
    the forms tried, while other fields are.
  - Full replacement works: both stored rows in `invoicePosDelete` and three new rows in
    `invoicePosSave` left exactly the three new rows, each with the template as parent
    (`invoice.id`); the old rows answer 404 by id, and the sums are right (net 350, gross 416.50
    for 300 + 40 + 10 at 19 %).
- **Sources:** spec (tag `InvoicePos`, `createInvoiceByFactory`); recorded 2026-11-17, trial
  account, Update 2.0 (one-off checks by the orchestrator).
- **Impact:** Positions are never changed by id: whole replacement is the only recorded way to
  change a price. A change replaces all of them in one request (every stored row in
  `invoicePosDelete`, the new rows without ids in `invoicePosSave`), as the invoice draft update
  does (D-054), and `sevdesk_invoice_update_recurring` compares each stored position (name,
  quantity, unit price, tax rate) and the gross total with what was sent afterwards, so a change
  sevDesk ignored becomes a note. (#91)
- **Test:** `test/unit/domain/recurring/payload.test.ts` ("replaces positions as a whole: new rows
  to save, stored rows to delete": the schema has no place for a position with an id),
  `test/unit/tools/invoices/recurring-update.test.ts` ("positions replace every stored one in one
  request, never by id", "notices a position change sevDesk ignored", "compares name, quantity
  and tax rate of every position read back").

### D-140: Languages: invoices store `en`, orders and credit notes the locale or German

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_ChangeLayout` takes `language` as a string without a list of values;
  `invoiceRender` declares `parameters` with the choices (`values`) and the current `value`.
- **Actual behavior:** Recorded on 2026-11-16 and checked on 2026-11-17 on drafts:
  - The `language` parameter lists the same eight choices on invoices, orders and credit notes,
    each with a `translationCode` `SEVDOC_LANG_<XX>_<YY>`: `de_DE`, `de_AT`, `de_CH`, `en_US`,
    `es_ES`, `fr_FR`, `it_IT`, `el_GR`. All three kinds accept the locale form.
  - Invoices store `en` for `en_US` and `de` for `de_DE` (the other six as sent) and refuse a
    value they do not know with 500.
  - Orders and credit notes store the locale form, and store `de_DE` for a value they do not
    know, without an error.
- **Sources:** spec (`Model_ChangeLayout`, `invoiceRender`); recorded 2026-11-16, trial account,
  Update 2.0 (probe `write-change-parameter-read-back`); recorded 2026-11-17, trial account,
  Update 2.0 (one-off checks by the orchestrator).
- **Impact:** `sevdesk_document_set_layout` takes only the eight languages, sends them in the
  locale form and checks them against the choices the document lists before sending. A stored
  value is read through the choice that lists it, by its translation code, so `en` and `en_US`
  are the same language in the preview and in the approval binding. Since orders and credit notes
  fall back to German silently, the tool compares the language read back with the one sent and
  reports a difference as a failure that names the stored language. (#94)
- **Test:** `test/unit/domain/layouts.test.ts` ("offers the eight sevDesk lists, in the locale
  form", "reads an invoice's stored en and an order's en_US as the same language");
  `test/unit/tools/documents/layout-tool.test.ts` ("takes the eight languages sevDesk lists, and
  nothing unknown", "refuses a language the document does not list, naming the ones it does",
  "fails when sevDesk stores German instead of the language sent (D-140)").

### D-141: `PUT /CheckAccount` answers 200 also for keys it ignores

- **Status:** Open. **Evidence:** spec + recorded.
- **Spec says:** `Model_CheckAccountUpdate` takes `name`, `defaultAccount`, `autoMapTransactions`
  (plural), `accountingNumber` (string), `iban` and `bic`; the answer is the changed account.
- **Actual behavior:** On a file-import account, `PUT /CheckAccount/{id}` answered 200 and stored
  `name`, `iban`, `bic` (both as sent), a free `accountingNumber` (`"1809"`) and
  `autoMapTransaction: 0` (singular, the key the rows carry: read back `"0"`). It also answered
  200 for the spec's plural `autoMapTransactions: 0`, for `type: "offline"` and for `status: 0`,
  and stored none of them (`autoMapTransaction` stayed `"1"`, the type `online`, the status 100).
  A clearing account was renamed the same way. `defaultAccount` was not tried (it would move the
  trial's default account). A `name` another active account has (its exact name) was stored as
  well, with 200: sevDesk does not keep account names apart.
- **Sources:** spec (`updateCheckAccount`, `Model_CheckAccountUpdate`); recorded 2026-11-18,
  trial account, Update 2.0 (one-off check by the orchestrator, run tag
  `MCP-E2E 20261118-0925-lgtm`; the duplicate name in a follow-up check of the same run).
- **Impact:** A 200 to this `PUT` proves nothing about the fields sent. Handling (#128):
  `sevdesk_bank_account_update` (tier `commit`) sends only the fields that change, under the keys
  sevDesk stores (`autoMapTransaction` singular, `accountingNumber` as a string), never `type`,
  `status` or `defaultAccount`; it reads the account back and fails, naming the fields, when one
  was not stored as sent. Everything but the name is set only on file-import accounts, where it
  was recorded; clearing accounts and cash registers are only renamed. It refuses a name another
  active account has before sending (compared without case and spaces); since sevDesk stores
  such a name, this refusal is the only guard against two accounts of the same name.
- **Test:** `test/regressions/check-account-update-archive.test.ts` ("sends only the keys sevDesk
  stores, the singular autoMapTransaction included"); `test/unit/tools/banking/account-update.test.ts`
  ("refuses a name another active account has, ignoring case and spaces",
  "sends automatic assignment under sevDesk's singular key, never the spec's plural (D-141)",
  "fails when the read-back does not show a field as sent, though sevDesk answered 200 (D-141)",
  "sends only the fields that change and refuses a call that changes nothing", "sets IBAN and BIC
  only on a file-import account and shows the IBAN masked").

### D-142: An account with booked transactions is not archived; the refusal is HTTP 200

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `DELETE /CheckAccount/{checkAccountId}` "Deletes a check account"; 200 is
  success, refusals are 4xx.
- **Actual behavior:** `DELETE /CheckAccount/{id}` of an account with a booked transaction
  (status 200, linked to a voucher by `bookAmount`), and of one whose booked transaction was
  also enshrined, answered HTTP 200 with
  `{"objects": null, "error": {"message": "Cannot delete because of existing necessary
references", "code": 159, "errorCode": 0, "data": {"total": 1, "objects": [<the booked
transaction>], "objectToDelete": <the account>}, "responseCode": 200, "exceptionUUID": …}}`.
  Nothing changed: the account stayed at status 100, the transaction at 200, the voucher at 750
  with its paid amount. Three tries gave the same answer. Accounts with only open transactions
  are archived (D-097).
- **Sources:** recorded 2026-11-18, trial account, Update 2.0 (one-off check by the orchestrator,
  run tag `MCP-E2E 20261118-0925-lgtm`).
- **Impact:** The client raises a 2xx body with `objects: null` and an `error` as
  `unexpected_response` (as for contacts, D-085). Handling (#128): `sevdesk_bank_account_archive`
  reads the account's transactions first and refuses any row that is not open (status 100),
  naming up to five by id, and refuses an account with more rows than one check reads (1000).
  sevDesk's refusal stays the backstop for a booking made after the check and becomes a trusted
  sentence of our own (`isReferenceRefusal`, shared with the contact delete), without sevDesk's
  text. `sevdesk_bank_account_update` refuses a new booking account on an account with booked
  transactions the same way, since what sevDesk does with their bookings is not recorded.
- **Test:** `test/regressions/check-account-update-archive.test.ts` ("is a refusal in our words,
  not an archive, and the DELETE is sent once"); `test/unit/tools/banking/account-archive.test.ts`
  ("refuses an account with booked transactions before sending", "explains sevDesk's refusal
  inside HTTP 200 for a booking made after the check (D-142)");
  `test/unit/tools/banking/account-update.test.ts` ("refuses a booking account in use, and one on
  an account with booked transactions").

### D-143: An archived account cannot be restored, and archiving clears its IBAN

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** Nothing about archiving; `Model_CheckAccountUpdate` has no `status`.
- **Actual behavior:** `PUT /CheckAccount/{id} {status: 100}` on an archived account answered
  200 and changed nothing (status stayed 0, the account stayed out of the list); `{status: 0}` on
  an active account did not archive it either (D-141). No other way back was found through the
  API. `DELETE` set the stored `iban` to null and kept `bic`. A second `DELETE` on the archived
  account answered 200 and changed nothing. A `PUT {name}` on an archived account was stored, and
  the account stayed archived. Whether the web app restores an archived account was not checked.
  The rows of an archived account stay readable by id, and a `DELETE` of one is answered like on
  an active account (recorded 2026-11-18, D-096).
- **Sources:** recorded 2026-11-18, trial account, Update 2.0 (one-off check by the orchestrator,
  run tag `MCP-E2E 20261118-0925-lgtm`; probe `write-transaction-delete-archived-account`).
- **Impact:** Archiving is irreversible as far as the server can tell. Handling (#128):
  `sevdesk_bank_account_archive` marks its preview irreversible, says that the account cannot be
  restored through the API and, when the account has an IBAN, that sevDesk clears it; it refuses
  an archived account. `sevdesk_bank_account_update` refuses archived accounts too, and neither
  tool sends `status`.
- **Test:** `test/unit/tools/banking/account-archive.test.ts` ("is an irreversible commit tool
  that locks the accounts and the bookings", "archives an account, names its open transactions
  and confirms status 0 on the read-back": the IBAN warning); `test/unit/tools/banking/account-update.test.ts`
  ("refuses bank-connected and archived accounts before sending").

### D-144: `PUT /CheckAccount` refuses a booking account in use with 400, not 422

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `accountingNumber` "Must be unique among all your CheckAccounts"; the refusal is
  not described.
- **Actual behavior:** `PUT /CheckAccount/{id} {accountingNumber: "1800"}`, a number another
  active account uses, answered HTTP 400 with code 815 and "The given account number is already
  used", and changed nothing. The account factories refuse the same with 422 (D-119). A free
  number was stored as sent. The refusal covers the whole request: `{name, accountingNumber}` with
  a number another active account uses answered the same 400/815, and the name was not stored
  either. An archived account's number is free: a `PUT` of another account to the number of an
  archived one answered 200 and stored it.
- **Sources:** recorded 2026-11-18, trial account, Update 2.0 (one-off check by the orchestrator,
  run tag `MCP-E2E 20261118-0925-lgtm`; the whole-request refusal and the archived account's
  number in a follow-up check of the same run).
- **Impact:** Both statuses are the client's `validation` kind. Handling (#128):
  `sevdesk_bank_account_update` checks the number against the active accounts the list shows
  first (archived ones, which the list leaves out, do not block it) and turns sevDesk's refusal,
  for a number taken after that check or held by an account beyond the first 1000, into a
  sentence of its own without sevDesk's text, saying that nothing of the request was changed.
- **Test:** `test/unit/tools/banking/account-update.test.ts` ("explains sevDesk's 400 for a
  booking account in use: nothing of the request was stored (D-144)", "refuses a booking account
  in use, and one on an account with booked transactions", "takes the booking account number of
  an archived account (D-144)").

### D-145: Transaction lists run newest first by `valueDate`

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** `GET /CheckAccountTransaction` documents no order and no sort parameter.
- **Actual behavior:** The list runs by `valueDate`, newest first, and pages stably (recorded
  2026-11-18). Three tagged rows created in the order A (value day two days back), B (today), C
  (yesterday) on a file-import account were listed B, C, A with `checkAccount[id]`, with
  `checkAccount[id]` and `status=100`, with `status=100` alone (19 rows) and without a filter (58
  rows): `valueDate` descending in all four, while `id`, `create` and, without a filter,
  `entryDate` went up and down. Pages of one (offsets 0 to 2) gave the same rows in the same
  order as one page. The order among rows of the same value day was not measured. The trial has
  no bank-connected account, so a list with bank imports was not seen.
- **Sources:** recorded 2026-11-18, trial account, Update 2.0 (probe
  `write-transaction-list-order`).
- **Impact:** `listTransactions` (`src/domain/banking.ts`) ends a value-date range scan at the
  first row dated before the range instead of reading on to its cap of 5,000 rows; it checks
  that the rows it read came in that order and reads on when one did not. So the duplicate check
  of `sevdesk_transaction_create` (#118) reads the account's rows from the newest down to the
  day it checks and warns of its cap only when more than 5,000 rows are dated that day or later
  (`src/domain/reconciliation/manual-transactions.ts`); `sevdesk_transactions_list` with a value
  range answers `hasMore: false` once it passed the range. The estimate of
  `sevdesk_private_transaction_rule_create` (#122) examines the 500 newest open transactions and
  says so (D-099). The order of `GET /PrivateTransactionRule` is in D-099, that of
  `GET /TagRelation` in D-088.
- **Test:** `test/unit/tools/banking/transactions.test.ts` ("ends a value-date scan at the first
  older row without reading further pages (D-145)", "reads on past an older row once a row breaks
  the newest-first order"); `test/unit/domain/reconciliation/manual-transactions.test.ts` ("ends
  the scan at the first row before that day, without a cap warning (D-145)", "says the scan may
  not have reached that day when it stopped at its row cap"); `test/unit/tools/reports/summarize.test.ts`
  ("filters value dates and status here (sevDesk's date filter cuts by entry date)");
  `test/unit/tools/banking/private-rules.test.ts` (the estimate's "newest" wording).
  Live: probe `write-transaction-list-order` (#136; `test/unit/scripts/gaps-banking-probes.test.ts`,
  "asks the #136 list-order, account, entryDate and image questions…").

### D-146: List order ties are broken per page, so offset paging skips and repeats rows

- **Status:** Open. **Evidence:** recorded.
- **Spec says:** The list endpoints document `limit` and `offset` and no default order. The
  filter tables document `orderByInvoiceNumber`, `orderByCreditNoteNumber`, `orderByOrderNumber`,
  `orderByVoucherNumber` (each `ASC`/`DESC`), `orderByCustomerNumber` and some `orderBy…=true`
  switches; nothing says the order is the same for every page.
- **Actual behavior:** Each list is sorted by one field, and rows that tie on it come in an order
  that depends on `limit` and `offset`. Two passes with the same page size always gave the same
  ids in the same order, so paging is repeatable but can be lossy. Recorded 2026-11-18, one page
  of 1000 against two passes in pages of 5 from offset 0, with the filters each reader sends:
  - Rows lost and repeated: `GET /Voucher` (sorted by `voucherDate` descending; all 56 tie; 12
    lost, 12 twice; D-100); `GET /OrderPos` (by `positionNumber` ascending, all 49 tie; 1 lost,
    1 twice); 25 draft credit notes the seed probe created on one day (`GET /CreditNote` with
    `embed=contact` and that day's `startDate`/`endDate`; by `create` descending, all 25 tie; 2
    lost, 2 twice).
  - Every row once, in another order: `GET /CreditNote` (43 rows, by `create` descending, 6
    tie), `GET /Order` (36 rows, by `create` descending, 4 tie) and the seed probe's 26 draft
    invoices of one day (by `create` descending, 18 tie). A longer list ordered this way loses
    rows as soon as a tie straddles a page boundary differently.
  - The same rows in the same order: `GET /Invoice` (136 rows with `embed=contact`, also with
    `status=200` (38) and a date range; by `create` descending, 2 tie), `showAll=true` with
    `updateAfter` (164), `GET /CheckAccountTransaction` (58 rows, by `valueDate` descending, 54
    tie; also `status=100`, 16 rows, 14 tie), `GET /Contact?depth=1` (54 rows, by
    `customerNumber` descending, 6 tie, also with `updateAfter`; the seed probe's 26 contacts,
    no tie), `GET /CheckAccountTransactionLog` (34, by `bookingDate` ascending, 29 tie),
    `GET /InvoicePos` (151, by `positionNumber`, all tie), `GET /CreditNotePos` (44, by
    `positionNumber`, all tie), `GET /VoucherPos` (56, by id ascending), `GET /AccountDatev`
    (100, by `number` ascending, 3 tie) and `GET /TagRelation` (17). With ties on the key, stable
    here does not prove stable on a larger list.
  - Too few rows to tell (fewer than 12): `GET /Part`, `GET /Tag`, `GET /ContactAddress`,
    `GET /CommunicationWay?type=EMAIL`, `GET /PrivateTransactionRule` (none), open and partially
    paid invoices, open credit notes, open expense vouchers, `GET /Order?orderType=AB`.
  - Order parameters: `orderByOrderNumber=ASC` made the 36 orders page exactly like one page.
    `orderByInvoiceNumber=ASC` (seeded drafts: 4 lost), `orderByCreditNoteNumber=ASC` (5 of 43
    lost; seeded drafts: 10 of 25) and `orderByVoucherNumber=ASC` (1 of 56) made paging worse or
    no better: drafts carry no number, so they tie again. `orderBy[0][field]=id` with
    `orderBy[0][arrangement]=asc` was ignored on every list (the same order as without it).
- **Sources:** recorded 2026-11-18, trial account, Update 2.0 (probes `read-list-paging-order`,
  497 GETs, and `write-list-paging-seed`, 25 contacts, invoices and credit notes created and
  deleted again; earlier `read-voucher-paging-order`, D-100).
- **Impact (fix in this PR, #162):** Every read that goes past one page is either avoided or
  marked as possibly incomplete; a row that comes twice is kept once.
  - `listAll` (`src/sevdesk/client.ts`) keeps a row with an id once and reports `paged` when rows
    came from more than one page; `scanPages` (`src/domain/reports/shared.ts`) does the same
    (`paged`, `idOf`). Their callers treat a paged read as possibly incomplete: `listChildRows`
    (positions, a contact's addresses and custom field values, the uses of one tag) answers
    `complete: false`; the credit note number check, the derived-document and order follow-up
    checks say that not everything was checked; the duplicate check of a new contact and the
    e-invoice contact index (which then also searches by name) say that they read the list page by
    page; the aging and cash reports, open items of `sevdesk_reconcile_suggest` and the contact
    list of the VAT check set `truncated`, and the reports `pagedRead` and a note.
  - `sevdesk_records_summarize` over a whole date range reads invoices, credit notes and vouchers
    in date windows of one page each (`scanDateWindows`, as the tax reports and audits do since
    #154), so a long list is no longer paged; without a range it pages and says so. The voucher
    type (`voucherType=VOU`, which sevDesk might ignore, D-035) is re-checked per page there
    rather than scanned for, so sevDesk's `total` stays and the windows can be split by it.
  - The order follow-up scan sends `orderByOrderNumber=ASC` (every order has a number, D-027):
    one sample paged stably with it; it is still marked when it reads more than one page.
  - Lists the user pages (`sevdesk_invoices_list`, `sevdesk_credit_notes_list`,
    `sevdesk_orders_list`, `sevdesk_vouchers_list`, `sevdesk_changed_since`) say in their
    description that pages can skip or repeat a row and how to narrow the range instead.
  - Not marked: transactions (`listTransactions`, the payments of a period,
    `sevdesk_reconcile_suggest`'s transaction pages), the booking log, the tag list and the
    account-wide tag relations (`sevdesk_tags_list`, the breakdown by tag), booking accounts and
    private-transaction rules paged stably in every recording (D-145, D-088, D-099 and above) and
    are read in pages of 1,000; where their rows are collected, a row is kept once. The uses of
    one tag read through `listChildRows` are marked (above). Contacts sort by `customerNumber`,
    which is nearly unique (6 of 54 rows tied); no order parameter is sent for them, and the
    guard above covers the scans that page them.
  - The contact addresses of the VAT check (`GET /ContactAddress`, every address of the account)
    are not marked either: every address counts for every party, so a mark would leave every
    purchase and sale finding unjudged on an account with more than 1,000 addresses. Their paging
    is not measured (11 rows on the trial, too few to tell); a real account (#158) can answer it.
    Only the cap of that list counts as incomplete; its rows are kept once.
- **Test:** `test/regressions/list-paging-ties.test.ts` (a list whose ties are broken per page:
  `listAll` keeps rows once and says it paged, a credit note summary over a range sees 2,500
  credit notes once each from first pages only, so does a voucher summary of 2,500 vouchers with
  recurring templates mixed in, without a range it says rows may be missing, the credit note
  number check and an order with 1,200 positions are not called complete);
  `test/unit/domain/reports/date-windows.test.ts` (a re-checked page splits by sevDesk's count, an
  empty second page is not a paged range, repeats are counted);
  `test/unit/domain/reports/audit/vat-check.test.ts` ("still judges every party when the address
  list is read in two pages"); `test/unit/domain/document-positions.test.ts`,
  `test/unit/tools/contacts/get.test.ts` (rows read in two pages are not complete). Live: probes
  `read-list-paging-order` and
  `write-list-paging-seed` (`test/unit/scripts/list-paging-probes.test.ts`).

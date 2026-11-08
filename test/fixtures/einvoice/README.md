# E-invoice fixtures

Files read by the e-invoice parser tests (`test/unit/domain/einvoice/`,
`test/unit/tools/einvoice/`). They are raw files (XML, PDF), not sevDesk responses, so they carry
their provenance here instead of a `_provenance` member.

## `kosit/`: official XRechnung samples (third party, verbatim)

| File                          | Content                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `01.01a-INVOICE_ubl.xml`      | UBL invoice, standard rate 7 %, two lines                            |
| `01.01a-INVOICE_uncefact.xml` | the same as CII (also embedded in `generated/zugferd-xrechnung.pdf`) |
| `01.04a-INVOICE_ubl.xml`      | UBL invoice, category O (not subject to VAT)                         |
| `01.18a-INVOICE_uncefact.xml` | CII corrected invoice (type code 384)                                |
| `01.21a-INVOICE_ubl.xml`      | UBL invoice, reverse charge (AE) with a document charge              |
| `01.21a-INVOICE_uncefact.xml` | the same as CII                                                      |
| `03.06a-INVOICE_ubl.xml`      | UBL invoice, categories S and Z with allowances and charges          |
| `03.06a-INVOICE_uncefact.xml` | the same as CII                                                      |

- **Source:** KoSIT XRechnung test suite,
  <https://github.com/itplr-kosit/xrechnung-testsuite>, `src/test/business-cases/standard/`,
  commit `1ce1dafffd035e5ce59a7ab0d3bf44ac14af16c9` (2026-09-04), downloaded 2026-11-08.
- **License:** Apache License 2.0 (`kosit/LICENSE`, copied from the repository). The files are
  unmodified. Their data is the test suite's own sample data (placeholder names such as
  "[Seller name]", dummy IBAN `DE79000000001234567890`), not ours to change.
- All 66 standard business cases of that commit (UBL and CII) parse without findings; these eight
  are kept as regression samples.

## `generated/` and `attacks/`: written by `scripts/gen-einvoice-fixtures.ts`

Synthetic files with fake data (Musterfirma GmbH, Musterlieferant GmbH, VAT ids `DE000000000` /
`DE000000001`, example IBAN `DE89370400440532013000`), written 2026-11-08 by
`node --import tsx scripts/gen-einvoice-fixtures.ts`. The script is deterministic; the test
`fixtures.test.ts` fails when a committed file differs from what it builds, so change the script,
not the files.

| File                                   | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `generated/cii-en16931-invoice.xml`    | EN 16931 CII invoice: 19 % and 7 %, a document allowance                  |
| `generated/cii-creditnote.xml`         | CII credit note (381) referencing the invoice                             |
| `generated/ubl-creditnote.xml`         | the same credit note as UBL `CreditNote`                                  |
| `generated/cii-minimum.xml`            | MINIMUM profile without lines (booking aid, not an invoice)               |
| `generated/zugferd-en16931.pdf`        | PDF with `factur-x.xml` (`/AF`, relationship Alternative)                 |
| `generated/zugferd-xrechnung.pdf`      | PDF with `xrechnung.xml` (the KoSIT sample 01.01a CII, relationship Data) |
| `generated/zugferd-minimum.pdf`        | PDF with a MINIMUM `factur-x.xml`                                         |
| `generated/zugferd-name-tree-kids.pdf` | attachment only in a `/Kids` node of the name tree, no `/AF`, other name  |
| `generated/plain-receipt.pdf`          | PDF without attachment (a plain receipt)                                  |
| `attacks/xxe-doctype.xml`              | external entity to `/etc/passwd` (XXE)                                    |
| `attacks/billion-laughs.xml`           | nested entity expansion                                                   |
| `attacks/deep-nesting.xml`             | 10,000 nested elements                                                    |
| `attacks/pdf-huge-attachment.pdf`      | 8 KB PDF whose attachment inflates to 6 MiB                               |
| `attacks/polyglot.xml`                 | XML with a `%PDF-` header in its first kilobyte                           |
| `attacks/hidden-text.xml`              | bidi override and zero-width characters in names, an injected note        |
| `attacks/wrong-root.xml`               | UBL `Order`, not an invoice                                               |
| `attacks/zugferd-1.0.xml`, `.pdf`      | ZUGFeRD 1.0 `CrossIndustryDocument`, as XML and as PDF attachment         |
| `attacks/utf16.xml`                    | the EN 16931 invoice as UTF-16LE with a byte order mark                   |

Built at test time instead of committed (size or tooling): XML above the 5 MiB limit, an
encrypted PDF (trailer `/Encrypt` added to `generated/zugferd-en16931.pdf`), PDFs with hand-built
file specifications (filters, predictors, raw deflate, cyclic name trees) in
`pdf-attachment.test.ts`, and documents with more lines, notes or rows than the reader accepts in
`readers.test.ts`.

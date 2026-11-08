# GoBD: unalterable books, Festschreibung, retention

The GoBD (Grundsätze zur ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen
und Unterlagen in elektronischer Form sowie zum Datenzugriff) are the tax administration's rules
for electronic bookkeeping. They matter for every write in sevDesk.

> **Not tax advice.** This is a summary of the sources below for working safely in sevDesk.
> Questions about a specific case (retention of a particular document, a correction after
> filing) belong to the user's Steuerberater.

## Booked records stay as they were

- § 146 Abs. 4 AO: a booking (Buchung) or record (Aufzeichnung) must not be changed in a way that
  makes its original content unrecognizable, and changes must not leave it uncertain whether they
  were made originally or later.
- The GoBD spell this out (Rz. 58–59, 107–112): changes must stay traceable and be logged; later
  changes must keep both the original content and the fact of the change recognizable (Rz. 111);
  software can ensure this, for example by a Festschreibung (Rz. 110), and the Festschreibung
  itself has to be recorded (Rz. 85).
- Corrections are separate entries: "Korrektur- bzw. Stornobuchungen müssen auf die
  ursprüngliche Buchung rückbeziehbar sein" (Rz. 64).
- Timeliness: entries in the journal by the end of the following month are acceptable (Rz. 87);
  keeping provisional entries open until or beyond the annual accounts is listed as
  inadmissible (Rz. 109).

## What that means in sevDesk

| Situation                            | Do                                                                                                                          | Don't                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Draft invoice, order or voucher      | Change it (`…_update_draft`) or delete a voucher draft (`sevdesk_voucher_delete_draft`).                                    | –                                           |
| Finalized invoice, not paid          | Cancel it: `sevdesk_invoice_cancel` creates a Stornorechnung, the original gets status cancelled.                           | Delete it or edit it in place.              |
| Finalized invoice, paid              | Issue a credit note: `sevdesk_credit_note_create_from_invoice`. sevDesk creates a Storno only while the invoice is unpaid.  | Reset payments just to change the invoice.  |
| Finalized voucher, not enshrined     | Reset it to draft (`sevdesk_voucher_reset`, `commit`), correct, finalize again.                                             | Delete booked vouchers.                     |
| Enshrined (festgeschrieben) document | Leave it. Correct with a new document (credit note, correcting voucher).                                                    | Anything else: enshrining cannot be undone. |
| Wrong bank booking                   | `sevdesk_transaction_get`, then `sevdesk_transaction_reset` (`commit`; resets the paid documents to open), then book again. | –                                           |

**Festschreibung (enshrine).** `sevdesk_invoice_enshrine`, `sevdesk_voucher_enshrine` and
`sevdesk_credit_note_enshrine` lock a finalized document permanently (`commit`, irreversible,
always with a warning). sevDesk's help describes festgeschriebene data as no longer changeable;
a festgeschriebene invoice can only be offset by a credit note (or a Storno while unpaid),
a receipt only by a reversing entry. sevDesk can also lock documents itself (Einstellungen →
System → Festschreiben). Locked documents cannot be unlinked from bank transactions either.

When to enshrine is a practice question, not a GoBD paragraph: many businesses lock a period
once its Umsatzsteuer-Voranmeldung is filed, and at the latest with the annual accounts. Ask the
user (and their Steuerberater) before enshrining; never do it unasked.

## Retention periods (§ 147 AO, § 14b UStG)

| Records                                                                                                | Period   |
| ------------------------------------------------------------------------------------------------------ | -------- |
| Books and records, inventories, annual financial statements, management reports, opening balance sheet | 10 years |
| Buchungsbelege (receipts, invoices received and issued as booking vouchers)                            | 8 years  |
| Business letters received and sent, other tax-relevant documents                                       | 6 years  |
| Invoices for VAT purposes (§ 14b UStG)                                                                 | 8 years  |

- The period starts at the end of the calendar year of the last entry, the creation or the
  receipt of the document (§ 147 Abs. 4 AO; § 14b: end of the year the invoice was issued).
- The 8 years for Buchungsbelege apply since 1 January 2025 to every document whose period had
  not yet expired by then (Art. 97 § 19a EGAO). Banks, insurers and investment firms keep the old
  10 years.
- **E-invoices:** keep at least the structured part (the XML) unaltered in its original form;
  the human-readable PDF part of a hybrid invoice only when it carries additional or different
  tax-relevant information (BMF letter of 15 October 2025, Rn. 60; GoBD Rz. 119 as amended on
  14 July 2025). Attach the original file to the voucher (`file` argument, or
  `sevdesk_voucher_import_einvoice`) and keep the original as received.

## This server's part

- Writes are never retried and every write is read back; with `SEVDESK_AUDIT_LOG` each preview,
  confirmation and execution is logged locally (JSON Lines). That log documents what the
  assistant did; it does not replace sevDesk's own records or the business's
  Verfahrensdokumentation.
- There is no tool that deletes a finalized invoice or a booked voucher, on purpose.

## Sources

- § 146, § 147 AO: [gesetze-im-internet.de/ao_1977/__146](https://www.gesetze-im-internet.de/ao_1977/__146.html),
  [__147](https://www.gesetze-im-internet.de/ao_1977/__147.html); Art. 97 § 19a EGAO:
  [gesetze-im-internet.de/aoeg_1977/art_97__19a](https://www.gesetze-im-internet.de/aoeg_1977/art_97__19a.html)
- § 14b UStG: [gesetze-im-internet.de/ustg_1980/__14b](https://www.gesetze-im-internet.de/ustg_1980/__14b.html)
- GoBD, BMF letter of 28 November 2019 (BStBl I S. 1269), consolidated text with the amendment
  of 11 March 2024: [AO-Handbuch 2025, Anhang 33](https://esth.bundesfinanzministerium.de/ao/2025/Anhaenge/BMF-Schreiben-und-gleichlautende-Laendererlasse/Anhang-33/inhalt.html);
  amendments of [11 March 2024](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/AO-Anwendungserlass/2024-03-11-aenderung-gobd.html)
  and [14 July 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Weitere_Steuerthemen/Abgabenordnung/2025-07-14-GoBD-2-aenderung.html)
- BMF letter of 15 October 2025 on e-invoices (retention, Rn. 60):
  [bundesfinanzministerium.de](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-10-15-einfuehrung-obligatorische-e-rechnung.html)
- sevDesk help: [Festschreibung](https://hilfe.sevdesk.de/de/articles/15531427-festschreibung-steuerrechtliche-pflicht-anwendung),
  [Stornorechnung erstellen](https://hilfe.sevdesk.de/de/articles/9154465-stornorechnung-erstellen),
  [Rechnung bearbeiten](https://hilfe.sevdesk.de/de/articles/9064811-rechnung-bearbeiten),
  [Automatische Transaktionszuordnung](https://hilfe.sevdesk.de/de/articles/9382118-automatische-transaktionszuordnung)
- sevDesk API (enshrine cannot be undone): [api.sevdesk.de](https://api.sevdesk.de/#section/sevdesk-Update-2.0)

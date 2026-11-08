# Booking accounts for typical receipts (SKR03 / SKR04)

Common DATEV standard accounts for expense receipts, as a starting point when filing a voucher.
Numbers and names are from the DATEV charts valid for 2026 (SKR 03 Art.-Nr. 11174, SKR 04
Art.-Nr. 11175).

> **Not tax advice.** Which account fits a receipt, and how much of it is deductible, depends on
> the business and on the Steuerberater's conventions. Suggest an account, say why, and let the
> user decide. These lists cover only the most common cases.

## Always confirm in the user's account

- The chart is chosen per account in sevDesk (tax settings: SKR03 or SKR04; SKR07 for Austria).
  `sevdesk_account_info` shows which one is active. Both are general-purpose charts: SKR03 is
  ordered by business processes, SKR04 by balance sheet and P&L. Use the one the Steuerberater
  uses.
- Before booking, check the account with `sevdesk_reference_lookup`, `kind: "receipt_guidance"`
  (filters: `accountNumber`, `taxRuleId`, `receiptType: "expense"`). It returns the accounts this
  sevDesk account offers for receipts and which tax rules and VAT rates each one allows. The
  voucher tools check the same combination and refuse a mismatch before anything is sent.
- sevDesk's account labels can differ from DATEV's (for example "Telefax und Internetkosten" for
  DATEV's "Internetkosten", "laufende Gebühren für Lizenzen" for 4964/6837). The number is what
  counts.

## Expense receipts

| Receipt                                            | SKR03              | SKR04              | DATEV name (2026)                                                                         | Notes                                                                                       |
| -------------------------------------------------- | ------------------ | ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Office supplies (paper, pens, toner)               | 4930               | 6815               | Bürobedarf                                                                                |                                                                                             |
| Books, journals, digital media                     | 4940               | 6820               | Zeitschriften, Bücher, digitale Medien (Fachliteratur)                                    |                                                                                             |
| Postage                                            | 4910               | 6800               | Porto                                                                                     |                                                                                             |
| Phone (landline, mobile contract)                  | 4920               | 6805               | Telefon                                                                                   |                                                                                             |
| Internet access                                    | 4925               | 6810               | Internetkosten                                                                            |                                                                                             |
| Software bought (licence of unlimited duration)    | 0027               | 0135               | EDV-Software                                                                              | Asset account; see the note on software below.                                              |
| Software subscription, licence for a period (SaaS) | 4964               | 6837               | Aufwendungen für die zeitlich befristete Überlassung von Rechten (Lizenzen, Konzessionen) | No dedicated SaaS account exists; ask the Steuerberater.                                    |
| Hardware or software maintenance contract          | 4806               | 6495               | Wartungskosten für Hard- und Software                                                     |                                                                                             |
| Travel, owner: tickets, taxi, mileage              | 4673               | 6673               | Reisekosten Unternehmer Fahrtkosten                                                       |                                                                                             |
| Travel, owner: hotel and incidental costs          | 4676               | 6680               | Reisekosten Unternehmer Übernachtungsaufwand und Reisenebenkosten                         |                                                                                             |
| Travel, owner: meal allowance                      | 4674               | 6674               | Reisekosten Unternehmer Verpflegungsmehraufwand                                           |                                                                                             |
| Travel, employees: fares / hotel / meals           | 4663 / 4666 / 4664 | 6663 / 6660 / 6664 | Reisekosten Arbeitnehmer Fahrtkosten / Übernachtungsaufwand / Verpflegungsmehraufwand     |                                                                                             |
| Business meals with business partners              | 4650               | 6640               | Bewirtungskosten                                                                          | The non-deductible 30 % go to 4654 / 6644 (Nicht abzugsfähige Bewirtungskosten); see below. |
| Small courtesies (drinks, snacks for guests)       | 4653               | 6643               | Aufmerksamkeiten                                                                          |                                                                                             |
| Gifts to business partners, deductible             | 4630               | 6610               | Geschenke abzugsfähig ohne § 37b EStG                                                     | 4631 / 6611 with § 37b EStG flat-rate tax.                                                  |
| Rent for premises                                  | 4210               | 6310               | Miete (unbewegliche Wirtschaftsgüter)                                                     |                                                                                             |
| Gas, electricity, water                            | 4240               | 6325               | Gas, Strom, Wasser                                                                        |                                                                                             |
| Vehicle: fuel, car wash, running costs             | 4530               | 6530               | Laufende Fahrzeug-Betriebskosten                                                          |                                                                                             |
| Vehicle: insurance                                 | 4520               | 6520               | Fahrzeug-Versicherungen                                                                   |                                                                                             |
| Vehicle: repairs                                   | 4540               | 6540               | Fahrzeug-Reparaturen                                                                      |                                                                                             |
| Vehicle: leasing                                   | 4570               | 6560               | Mietleasing Kfz                                                                           |                                                                                             |
| Vehicle: motor vehicle tax                         | 4510               | 7685               | Kfz-Steuer                                                                                |                                                                                             |
| Vehicle: other costs                               | 4580               | 6570               | Sonstige Fahrzeugkosten                                                                   | 4500 / 6500 (Fahrzeugkosten) must not be used with an EÜR.                                  |
| Advertising, trade fairs                           | 4600               | 6600               | Werbekosten                                                                               |                                                                                             |
| Training, courses                                  | 4945               | 6821               | Fortbildungskosten                                                                        |                                                                                             |
| Low-value asset (GWG)                              | 0480               | 0670               | Geringwertige Wirtschaftsgüter                                                            | Asset account; see GWG below.                                                               |
| Pooled asset (Sammelposten)                        | 0485               | 0675               | Wirtschaftsgüter (Sammelposten)                                                           | See GWG below.                                                                              |
| Bank and card fees                                 | 4970               | 6855               | Nebenkosten des Geldverkehrs                                                              |                                                                                             |
| Legal and consulting fees                          | 4950               | 6825               | Rechts- und Beratungskosten                                                               |                                                                                             |
| Bookkeeping costs                                  | 4955               | 6830               | Buchführungskosten                                                                        |                                                                                             |
| Annual accounts, tax return preparation            | 4957               | 6827               | Abschluss- und Prüfungskosten                                                             |                                                                                             |
| Business insurance                                 | 4360               | 6400               | Versicherungen                                                                            |                                                                                             |
| Chamber and association fees                       | 4380               | 6420               | Beiträge                                                                                  |                                                                                             |
| Subcontractors, external services                  | 3100               | 5900               | Fremdleistungen                                                                           |                                                                                             |
| Goods for resale                                   | 3200               | 5200               | Wareneingang                                                                              |                                                                                             |

Summary accounts such as 4670 / 6670 (Reisekosten Unternehmer) are marked in the DATEV chart as
not to be used with an EÜR: pick the specific account.

## Private money (Privatentnahme, Privateinlage)

| Case                                                        | SKR03 | SKR04 | DATEV name                 |
| ----------------------------------------------------------- | ----- | ----- | -------------------------- |
| Owner takes money out of the business (Privatentnahme)      | 1800  | 2100  | Privatentnahmen allgemein  |
| Owner puts money into the business (Privateinlage)          | 1890  | 2180  | Privateinlagen             |
| Private use of business assets (unentgeltliche Wertabgaben) | 1880  | 2130  | Unentgeltliche Wertabgaben |

In sevDesk a private bank transaction is marked as private rather than filed as a receipt:
`sevdesk_transaction_mark_private`. sevDesk then books withdrawals to 1800 / 2100 and deposits
to 1890 / 2180 (the sign of the amount decides). In the recorded receipt guidance these accounts
carry the tax rules 16 (Nicht steuerbar, Ausgabe) and 22 (Nicht steuerbar, Einnahme). Private
accounts exist for sole proprietors and partnerships; a GmbH or UG has none.

## Notes for particular receipts

- **Business meals (Bewirtung):** 70 % of appropriate costs are deductible as business expenses,
  30 % are not (§ 4 Abs. 5 Satz 1 Nr. 2 EStG); the input VAT on appropriate, documented meals
  is deductible in full (§ 15 Abs. 1a Satz 2 UStG). Booking splits the net amount between
  4650 / 6640 and 4654 / 6644. The receipt has to name place, date, participants and occasion
  (§ 4 Abs. 5 Satz 1 Nr. 2 EStG). In the receipt guidance recorded from a sevDesk account
  (2026-11-07, SKR04) 6640 was not offered for receipts: check with `receipt_guidance` how the
  user's account expects meals to be booked.
- **GWG and Sammelposten:** assets up to 800 € net may be written off in the year of purchase as
  GWG (§ 6 Abs. 2 EStG); assets over 250 € and up to 1,000 € net may instead go into a pool
  written off over five years (§ 6 Abs. 2a EStG). The choice applies to all such assets of a
  fiscal year: ask the user or their Steuerberater.
- **Software and computers:** the BMF allows a useful life of one year for computer hardware and
  software (BMF letter of 22 February 2022), so purchases on 0027 / 0135 may be written off over
  one year.
- **Services from abroad (e.g. SaaS from an EU or US provider without German VAT):** the account
  stays the same; the tax rule changes (14 for EU services, 12 for non-EU services with reverse
  charge), see [tax-rules.md](tax-rules.md).
- **Kleinunternehmer:** the same accounts, but expenses use tax rule 10 (no input VAT deduction):
  book the gross amount.

## Sources

- DATEV, Kontenrahmen SKR 03 (Art.-Nr. 11174, valid for 2026):
  [11174 SKR03 BilRUG](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/zielgruppen/mandant/unternehmer/branche/bau/11174%20SKR03%20BilrUg.pdf),
  shop page [Kontenrahmen DATEV SKR 03](https://www.datev.de/web/de/datev-shop/material/kontenrahmen-datev-skr-03/)
- DATEV, Kontenrahmen SKR 04 (Art.-Nr. 11175, valid for 2026):
  [11175 SKR04 BilRUG](https://www.datev.de/content/dam/markenassets/themen-und-produktgruppen/zielgruppen/mandant/unternehmer/branche/bau/11175%20SKR04%20BilrUg.pdf),
  shop page [Kontenrahmen DATEV SKR 04](https://www.datev.de/web/de/datev-shop/material/kontenrahmen-datev-skr-04/)
- DATEV, [SKR Standard-Kontenrahmen](https://www.datev.de/web/de/m/ueber-datev/datev-im-web/datev-von-a-z/skr-standard-kontenrahmen/)
- sevDesk help: [Steuereinstellungen auf Firmenebene](https://hilfe.sevdesk.de/de/articles/9382213-steuereinstellungen-auf-firmenebene),
  [Verfügbare Buchungskonten](https://hilfe.sevdesk.de/de/articles/11325646-verfugbare-buchungskonten),
  [Privatentnahmen](https://hilfe.sevdesk.de/de/articles/9881023-privatentnahmen),
  [Privateinlagen](https://hilfe.sevdesk.de/de/articles/9947647-privateinlagen)
- sevDesk API, ReceiptGuidance:
  [forAllAccounts](https://api.sevdesk.de/#tag/Voucher/operation/forAllAccounts)
- § 4 Abs. 5 EStG: [__4](https://www.gesetze-im-internet.de/estg/__4.html); § 6 Abs. 2 and 2a EStG:
  [__6](https://www.gesetze-im-internet.de/estg/__6.html); § 15 Abs. 1a UStG:
  [__15](https://www.gesetze-im-internet.de/ustg_1980/__15.html)
- BMF letter of 22 February 2022 (useful life of computer hardware and software), official
  EStH annex: [Anhang 1 V](https://esth.bundesfinanzministerium.de/esth/2022/C-Anhaenge/Anhang-01/V/anhang-1-V.html)

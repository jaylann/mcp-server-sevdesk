# sevDesk tax rules (Steuerregeln)

With sevDesk Update 2.0 every document carries a **tax rule** instead of the old `taxType`. The
rule says how the transaction is treated for VAT; the positions carry the rates. The server
checks rule × rate (and on receipts rule × booking account) before anything is sent.
`sevdesk_reference_lookup` with `kind: "tax_rules"` lists the rules with their names and rates.

> **Not tax advice.** The table maps sevDesk's rules to the business cases they are meant for,
> following sevDesk's API documentation and the cited laws. Which case applies to a given
> transaction (place of supply, status of the customer, thresholds) is for the user or their
> Steuerberater to decide.

## Which rule for which case

Regime "regular" = Regelbesteuerung; "Klein" = Kleinunternehmer (§ 19 UStG). Rates in percent.

### Sales (invoices, credit notes, orders, revenue vouchers)

| Rule | sevDesk name                                  | Regime  | Rates              | Business case                                                                                                                                                                |
| ---- | --------------------------------------------- | ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Umsatzsteuerpflichtige Umsätze                | regular | 0, 7, 19           | Domestic taxable sales: the normal case.                                                                                                                                     |
| 2    | Ausfuhren                                     | regular | 0                  | Export of goods to a country outside the EU (§ 4 Nr. 1 Buchst. a, § 6 UStG); needs proof of export.                                                                          |
| 3    | Innergemeinschaftliche Lieferungen            | regular | 0 (7, 19 accepted) | Goods to a business in another EU state with a valid VAT ID (§ 4 Nr. 1 Buchst. b, § 6a UStG); also in the ZM.                                                                |
| 4    | Steuerfreie Umsätze § 4 UStG                  | regular | 0                  | Other tax-exempt sales under § 4 UStG (e.g. certain medical, financial or letting services).                                                                                 |
| 5    | Reverse Charge gem. § 13b UStG                | regular | 0                  | Domestic sales where the customer owes the VAT (e.g. construction services to construction businesses); UStVA field 60.                                                      |
| 11   | Steuer nicht erhoben nach § 19 UStG           | Klein   | 0                  | Every sale of a Kleinunternehmer: no VAT shown.                                                                                                                              |
| 17   | Nicht im Inland steuerbare Leistung           | regular | 0                  | Services whose place of supply is outside Germany and outside the EU rules, e.g. B2B services to Switzerland. Not for advance, partial or final invoices.                    |
| 18   | One-Stop-Shop: Warenverkauf in die EU         | regular | destination rate   | Distance sales of goods to consumers in other EU states above the EU threshold; VAT of the destination state, declared via OSS.                                              |
| 19   | One-Stop-Shop: elektronische Dienstleistungen | regular | destination rate   | Telecom, broadcasting and electronically supplied services to EU consumers (OSS).                                                                                            |
| 20   | One-Stop-Shop: sonstige Leistungen            | regular | destination rate   | Other services to EU consumers taxed in their state (OSS).                                                                                                                   |
| 21   | Reverse Charge, EU services (§ 18b UStG)      | regular | 0                  | Services to businesses in other EU states (place of supply there, customer owes the VAT); UStVA field 21 and the ZM. Not for vouchers or advance, partial or final invoices. |
| 22   | Nicht steuerbar (Einnahme)                    | both    | –                  | Not taxable receipts, e.g. transitory items (durchlaufende Posten) or a private deposit. Listed by `GET /TaxRule`, not in the documentation tables.                          |

Rules 18–20 cannot be used on vouchers, on e-invoices or with a custom revenue account; 17–21
not on advance, partial or final invoices; 18–21 not on vouchers.

### Purchases (expense vouchers)

| Rule | sevDesk name                                   | Regime  | Rates    | Business case                                                                                                                                 |
| ---- | ---------------------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 8    | Innergemeinschaftliche Erwerbe                 | regular | 0, 7, 19 | Goods bought from a business in another EU state (§ 1a UStG): acquisition VAT due and, as a rule, deductible.                                 |
| 9    | Vorsteuerabziehbare Aufwendungen               | regular | 0, 7, 19 | Normal domestic purchase with input VAT (the default for expenses).                                                                           |
| 10   | Nicht vorsteuerabziehbare Aufwendungen         | both    | 0        | No input VAT deduction: every expense of a Kleinunternehmer, or costs without deductible VAT. Book the gross amount.                          |
| 12   | Reverse Charge § 13b Abs. 2 mit Vorsteuerabzug | regular | 0        | Services from businesses outside the EU, construction services and other § 13b Abs. 2 cases received by a business that may deduct input VAT. |
| 13   | Reverse Charge § 13b ohne Vorsteuerabzug       | both    | 0        | Same cases when the recipient cannot deduct input VAT (Kleinunternehmer, exempt businesses): the VAT is owed but not deductible.              |
| 14   | Reverse Charge § 13b Abs. 1 EU-Umsätze         | regular | 0        | Services from businesses in other EU states (e.g. software subscriptions, online ads invoiced without German VAT).                            |
| 15   | Nicht steuerbar (Steuer)                       | both    | –        | Tax payments and refunds, e.g. VAT prepayments to the tax office. Only in `GET /TaxRule`.                                                     |
| 16   | Nicht steuerbar (Ausgabe)                      | both    | –        | Not taxable outflows, e.g. a private withdrawal. Only in `GET /TaxRule`.                                                                      |

Ids 6 and 7 do not exist. Reverse-charge documents carry 0 %: the VAT the recipient owes is not
part of the document amount (sevDesk's rule names say "0% (19%)").

## By situation

- **Kleinunternehmer (§ 19 UStG):** sales 11, expenses 10, services from abroad 13. No VAT on
  invoices and no input VAT deduction; the OSS rules are not available on such an account. The
  regime applies while the total turnover was at most 25,000 € in the previous year and stays at
  most 100,000 € in the current year (since 2025); the sale that crosses 100,000 € is already
  taxable. A Kleinunternehmer must still be able to receive e-invoices
  ([e-invoicing.md](e-invoicing.md)). The server picks 11 / 10 as defaults on such an account and
  refuses rules that do not fit the regime.
- **Reverse charge (§ 13b UStG):** the recipient, if a business, owes the VAT (§ 13b Abs. 5) and
  may deduct it as input VAT (§ 15 Abs. 1 Satz 1 Nr. 4). As supplier: 5 (domestic cases such as
  construction services to a business that itself provides construction services) or 21 (EU
  services); the invoice must say "Steuerschuldnerschaft des Leistungsempfängers" (§ 14a Abs. 1
  and 5). As recipient: 14 (services from EU businesses, § 13b Abs. 1), 12 (other § 13b cases,
  e.g. services from non-EU businesses or construction services received, with deduction) or 13
  (the same without deduction).
- **Selling within the EU:** goods to businesses 3: tax-free only with the customer's valid VAT
  ID from another member state and a correct Zusammenfassende Meldung (§ 4 Nr. 1 Buchst. b,
  § 6a Abs. 1 Nr. 4); the invoice shows both VAT IDs (§ 14a Abs. 3). Services to businesses 21,
  also in the ZM. To consumers: German VAT (1) while distance sales and electronic services to
  EU consumers stay at most 10,000 € net in the previous and the current year (§ 3c Abs. 4, for
  businesses established only in Germany), above that the destination state's VAT via the
  One-Stop-Shop (18–20; quarterly OSS return to the BZSt within one month after the quarter).
- **Exports outside the EU:** goods 2, tax-free with proof of export (§ 4 Nr. 1 Buchst. a, § 6
  UStG, §§ 8 ff. UStDV); B2B services taxable abroad usually 17.
- **Buying within the EU:** goods 8 (acquisition VAT under § 1a, deductible under § 15 Abs. 1
  Satz 1 Nr. 3), services 14.

## Where the amounts end up in the UStVA (form 2026)

| Field   | Content                                                                                                          | Typical tax rules |
| ------- | ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| 81 / 86 | Taxable sales at 19 % / 7 % (base)                                                                               | 1                 |
| 87      | Taxable sales at 0 %                                                                                             | 1                 |
| 41      | Intra-EU supplies to customers with a VAT ID                                                                     | 3                 |
| 43      | Other tax-free sales with input VAT deduction, e.g. exports                                                      | 2                 |
| 48      | Tax-free sales without input VAT deduction (incl. § 19 UStG)                                                     | 4, 11             |
| 21      | Non-taxable services under § 18b Satz 1 Nr. 2 (EU B2B services)                                                  | 21                |
| 45      | Other non-taxable sales (place of supply abroad, incl. OSS sales; the OSS tax goes into the separate OSS return) | 17, 18–20         |
| 60      | Sales under § 13b where the customer owes the tax                                                                | 5                 |
| 89 / 93 | Intra-EU acquisitions at 19 % / 7 %                                                                              | 8                 |
| 46 / 47 | Services from EU businesses, § 13b Abs. 1 (base / tax)                                                           | 14                |
| 84 / 85 | Other § 13b cases (base / tax)                                                                                   | 12, 13            |
| 66      | Input VAT from invoices                                                                                          | 9                 |
| 61      | Input VAT from intra-EU acquisitions                                                                             | 8                 |
| 67      | Input VAT from § 13b cases                                                                                       | 12, 14            |
| 39      | Deduction of the Sondervorauszahlung (Dauerfristverlängerung)                                                    | –                 |
| 83      | Amount payable or refundable                                                                                     | –                 |

The mapping column is a guide to where sevDesk's rules usually land, not sevDesk's own report;
`sevdesk_vat_summary` shows the amounts for a period.

Filing (§ 18 UStG, §§ 46–47 UStDV): quarterly by default, monthly when the previous year's VAT
exceeded 9,000 €, no pre-returns when it was at most 2,000 € (the tax office may waive them).
Due on the 10th day after the period; a Dauerfristverlängerung adds one month (monthly filers
pay a Sondervorauszahlung of 1/11 of the previous year's prepayments). The rule that new
businesses file monthly is suspended for 2021 to 2026. The Zusammenfassende Meldung (§ 18a) is
due on the 25th day after the month for intra-EU supplies of goods (quarterly while they stay at
most 50,000 € per quarter) and after the quarter for EU B2B services.

## Sources

- sevDesk API documentation, "sevdesk-Update 2.0", tax rules:
  [api.sevdesk.de/#section/sevdesk-Update-2.0/Tax-Rules](https://api.sevdesk.de/#section/sevdesk-Update-2.0/Tax-Rules)
- sevDesk API, ReceiptGuidance:
  [forAllAccounts](https://api.sevdesk.de/#tag/Voucher/operation/forAllAccounts)
- UStG: [§ 1a](https://www.gesetze-im-internet.de/ustg_1980/__1a.html),
  [§ 3c](https://www.gesetze-im-internet.de/ustg_1980/__3c.html),
  [§ 4](https://www.gesetze-im-internet.de/ustg_1980/__4.html),
  [§ 6](https://www.gesetze-im-internet.de/ustg_1980/__6.html),
  [§ 6a](https://www.gesetze-im-internet.de/ustg_1980/__6a.html),
  [§ 13b](https://www.gesetze-im-internet.de/ustg_1980/__13b.html),
  [§ 14a](https://www.gesetze-im-internet.de/ustg_1980/__14a.html),
  [§ 15](https://www.gesetze-im-internet.de/ustg_1980/__15.html),
  [§ 18](https://www.gesetze-im-internet.de/ustg_1980/__18.html),
  [§ 18a](https://www.gesetze-im-internet.de/ustg_1980/__18a.html),
  [§ 18j](https://www.gesetze-im-internet.de/ustg_1980/__18j.html),
  [§ 19](https://www.gesetze-im-internet.de/ustg_1980/__19.html)
- UStDV: [§ 8](https://www.gesetze-im-internet.de/ustdv_1980/__8.html),
  [§ 46](https://www.gesetze-im-internet.de/ustdv_1980/__46.html),
  [§ 47](https://www.gesetze-im-internet.de/ustdv_1980/__47.html)
- BMF letter of 18 March 2025 on the Kleinunternehmer rules:
  [bundesfinanzministerium.de](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-03-18-sonderregelung-kleinunternehmer.html)
- BMF letter of 29 December 2025, UStVA form 2026:
  [Vordruckmuster USt 1 A](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/2025-12-29-vordruckmuster-USt-voranmeldung-2026.pdf?__blob=publicationFile&v=7)

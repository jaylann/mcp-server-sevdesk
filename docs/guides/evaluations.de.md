<!-- translated-from: docs/guides/evaluations.md sha256:4af99a4fd764 -->

# Auswertungen und Exporte

Was dir der Assistent über deine Bücher sagen kann und wo seine Antworten enden: Summen, offene
Posten, Liquidität, die Umsatzsteuer-Auswertung, die Gewinn- und Verlustrechnung, die Prüfungen und
die Exporte für deine Steuerberatung. Diese Seite ist für alle, die Zahlen aus sevDesk haben wollen,
und für alle, die entscheiden, wie weit sie ihnen trauen. Jede Auswertung hier ist `read`; nur der DATEV-Export
braucht `write` ([Berechtigungen](../permissions.de.md#stufen)).

> [!IMPORTANT]
> Die Auswertungen berechnet dieser Server aus deinen sevDesk-Daten. Sie sind nicht die
> Auswertungen von sevDesk selbst, keine Steuererklärung und keine Steuerberatung. Verbindliche
> Antworten gibt dir deine Steuerberatung.

## Welche Auswertung was beantwortet

| Frage                                                     | Werkzeug                                                             | Stufe   |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ------- |
| Umsatz je Monat, Kosten je Lieferant, Summen              | [`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize) | `read`  |
| Wer uns was schuldet, und seit wann                       | [`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging) | `read`  |
| Was wir schulden, und wann es fällig ist                  | [`sevdesk_payables_aging`](../tools.md#sevdesk_payables_aging)       | `read`  |
| Wie viel Geld wir haben und haben werden                  | [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)         | `read`  |
| Was sich seit einem Datum geändert hat                    | [`sevdesk_changed_since`](../tools.md#sevdesk_changed_since)         | `read`  |
| Was ungefähr in der Umsatzsteuer-Voranmeldung stehen wird | [`sevdesk_vat_summary`](../tools.md#sevdesk_vat_summary)             | `read`  |
| Gewinn für einen Monat, ein Quartal oder ein Jahr         | [`sevdesk_profit_and_loss`](../tools.md#sevdesk_profit_and_loss)     | `read`  |
| Was falsch aussieht: Umsatzsteuer-Behandlung, § 13b       | [`sevdesk_records_audit`](../tools.md#sevdesk_records_audit)         | `read`  |
| Eine CSV-Datei für Excel oder die Steuerberatung          | [`sevdesk_csv_export`](../tools.md#sevdesk_csv_export)               | `read`  |
| Die DATEV-Buchungsdaten für die Steuerberatung            | [`sevdesk_datev_export`](../tools.md#sevdesk_datev_export)           | `write` |

Zwei Prompts kombinieren sie: [`vat_precheck`](../tools.md#vat_precheck) vor der
Umsatzsteuer-Voranmeldung und [`month_end_close`](../tools.md#month_end_close) für den
Monatsabschluss bis zur Übergabe an die Steuerberatung.

## Summen

> Fass die Umsätze für 2026 je Monat zusammen.

> Wie viel haben wir im dritten Quartal je Lieferant ausgegeben?

[`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize) zählt und summiert
Rechnungen, Gutschriften, Belege oder Kontoumsätze: exakte Netto-, Steuer- und Bruttobeträge je
Währung, gruppiert nach Monat, Quartal, Status, Kontakt oder Konto. Es liest bis zu 10.000 Zeilen
und sagt, wenn es mehr gab. Wiederkehrende Vorlagen und Mahnungen bleiben außen vor, außer du fragst
danach. Für einzelne Datensätze bleiben die Listenwerkzeuge der Weg, zum Beispiel
[`sevdesk_invoices_list`](../tools.md#sevdesk_invoices_list).

## Offene Posten und Liquidität

> Wer schuldet uns Geld, und wie viel ist mehr als 60 Tage überfällig?

> Welche Lieferantenrechnungen sind überfällig, und wem schulden wir am meisten?

[`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging) und
[`sevdesk_payables_aging`](../tools.md#sevdesk_payables_aging) sortieren die heute offenen
Rechnungen und Ausgabenbelege in nicht fällig, 1–30, 31–60, 61–90 und über 90 Tage, mit den
größten Kunden oder Lieferanten. sevDesk kennt nur die heute offenen Posten, deshalb wird ein
Stichtag in der Vergangenheit abgelehnt; ein späterer Stichtag lässt die heutigen Posten bis zu
diesem Tag altern. Beträge ohne verwertbaren bezahlten Betrag sind als ungefähr oder unbekannt
markiert.

> Wie ist unsere Liquidität, und wie sehen die nächsten 30 Tage aus?

[`sevdesk_cash_position`](../tools.md#sevdesk_cash_position) listet den Saldo jedes Zahlungskontos
so, wie sevDesk ihn aus den ihm bekannten Umsätzen berechnet; das ist nicht unbedingt der Stand der
Bank. Mit Ausblick ergänzt es Forderungen und Verbindlichkeiten nach Fälligkeit und einen
voraussichtlichen Saldo, gekennzeichnet als erwartet, nicht gebucht.

## Umsatzsteuer-Auswertung

> Schätz die Umsatzsteuer-Voranmeldung für Oktober 2026.

[`sevdesk_vat_summary`](../tools.md#sevdesk_vat_summary) schätzt die Umsatzsteuer-Voranmeldung
(UStVA) für einen Monat, ein Quartal oder ein Jahr: die Zeilen des Formulars (Kennzahlen, Formular 2026) mit Bemessungsgrundlage und Steuer, die erwartete Zahllast oder Erstattung (Kz 83), die
Zusammenfassende Meldung je USt-IdNr. des Abnehmers, OSS-Umsätze je Land und die Beträge, die sie
nicht zuordnen kann. Die Besteuerungsart des Kontos liest sie selbst; ein Kleinunternehmer-Konto
bekommt keine UStVA.

Grundlage ist die Sollversteuerung, außer du fragst nach der Istversteuerung. Die API von sevDesk
sagt nicht, welche davon dein Konto verwendet; nenn sie also, wenn du nach vereinnahmten Entgelten
versteuerst. Der Server übermittelt nichts: Die Voranmeldung geht aus sevDesk an ELSTER oder über
deine Steuerberatung.

## Gewinn- und Verlustrechnung

> Wie hoch war unser Gewinn im dritten Quartal?

[`sevdesk_profit_and_loss`](../tools.md#sevdesk_profit_and_loss) erstellt eine Übersicht im Stil
einer Einnahmenüberschussrechnung (EÜR): Nettoeinnahmen nach Steuerregel, Nettoausgaben nach
Buchungskonto, das Ergebnis und die Umsatzsteuerströme getrennt davon (vereinnahmte Umsatzsteuer,
gezahlte Vorsteuer, an das Finanzamt gezahlte oder von ihm erstattete Umsatzsteuer). Grundlage ist
standardmäßig das Zufluss- und Abflussprinzip (der Tag, an dem das Geld floss, aus den Zahlungen,
die sevDesk mit Dokumenten verknüpft) oder auf Wunsch das Dokumentdatum (periodengerecht).

## Prüfungen

> Prüf die Umsatzsteuer-Behandlung unserer Einkäufe und Verkäufe im dritten Quartal.

> Wie hoch ist unsere Bemessungsgrundlage nach § 13b für Oktober, je Steuerregel?

[`sevdesk_records_audit`](../tools.md#sevdesk_records_audit) beantwortet „Was ist falsch?“ statt
„Wie lauten die Zahlen?“. Es führt pro Aufruf eine Prüfung für einen Monat, ein Quartal, ein Jahr
oder einen Zeitraum aus und liefert Befunde. Jeder nennt seine Art (`code`) und wie sicher er ist
(`severity`: `warning`, wenn die Daten auf eine falsche Buchung deuten, `check`, wenn die Antwort
von Tatsachen abhängt, die sevDesk nicht kennt), begründet sich mit der Rechtsgrundlage und sagt,
was zu prüfen oder zu tun ist, mit dem Kontakt und den Belegen samt Links in sevDesk. Die Belege
einer Art und eines Kontakts bilden einen Befund. Befunde sind Hinweise, keine Steuerberatung, und
jedes Ergebnis sagt das auf Englisch und Deutsch. Das Werkzeug ändert nichts.

### Umsatzsteuer-Behandlung (`vat`)

Die Prüfung vergleicht die Steuerregel jedes Dokuments damit, wo die Gegenseite ansässig ist,
soweit sevDesk es weiß: die USt-IdNr. des Kontakts und die Länder seiner Adressen. Eine deutsche
USt-IdNr. oder eine deutsche Adresse gilt als in Deutschland registriert oder ansässig. Dokumente
werden nach Belegdatum ausgewählt; Verkäufe werden an Rechnungen geprüft.

| Code                                                                            | Bedeutet                                                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `foreign_supplier_charged_german_vat`                                           | Ein Lieferant im Ausland hat deutsche Umsatzsteuer berechnet, als Vorsteuer gebucht (Regel 9); meist schuldest du sie (§ 13b UStG) |
| `foreign_vat_deducted`                                                          | Umsatzsteuer zu einem Satz, den Deutschland nicht kennt, als Vorsteuer gebucht (Regel 9)                                           |
| `foreign_supplier_zero_rate`                                                    | Ein Lieferant im Ausland mit 0 % gebucht (Regel 9 oder 10), ohne Reverse Charge oder innergemeinschaftlichen Erwerb                |
| `eu_reverse_charge_for_domestic_supplier`, `acquisition_from_domestic_supplier` | Regel 14 oder 8 bei einem Lieferanten mit nur deutschen Daten                                                                      |
| `eu_reverse_charge_for_non_eu_supplier`, `acquisition_from_non_eu_supplier`     | Regel 14 oder 8 bei einem Lieferanten außerhalb der EU                                                                             |
| `eu_supplier_under_rule_12`                                                     | Eine Leistung aus einem anderen EU-Staat unter Regel 12 statt 14                                                                   |
| `german_vat_to_eu_business`                                                     | Deutsche Umsatzsteuer auf einer Rechnung an einen Kunden mit USt-IdNr. eines anderen EU-Staats                                     |
| `intra_eu_supply_without_eu_vat_id`, `eu_service_without_eu_vat_id`             | Regel 3 oder 21 ohne USt-IdNr. des Kunden aus einem anderen EU-Staat                                                               |

Bewusst nicht gemeldet: ein ausländischer Lieferant mit deutscher USt-IdNr. oder deutscher Adresse
(er darf deutsche Umsatzsteuer berechnen), ein Lieferant mit nur deutschen Daten, der keine
Umsatzsteuer berechnet (zum Beispiel ein Kleinunternehmer), ein Lieferant in der
EU-Kleinunternehmerregelung (USt-IdNr. endet auf EX) und Einfuhrumsatzsteuer auf dem Konto
Einfuhrumsatzsteuer. Ein Kontakt ohne USt-IdNr. und Adresse lässt sich nicht einordnen: Seine
Dokumente zählen als nicht beurteilt (`coverage.notJudged`); ergänz den Kontakt, damit sie geprüft
werden.

### Bemessungsgrundlage nach § 13b (`reverse_charge`)

Die Prüfung summiert die Bemessungsgrundlage nach § 13b des Zeitraums je Steuerregel: empfangen
(Regeln 12, 13 und 14, bei denen du die Steuer als Leistungsempfänger schuldest, mit der
geschuldeten Steuer und dem Teil, den du als Vorsteuer wieder abziehst) und ausgestellt (Regel 5,
Kz 60; Regel 21, Kz 21). Jede Summe nennt ihre UStVA-Kennzahlen und listet die Belege dahinter. Sie
nutzt dieselben Steuerzeitpunkte wie `sevdesk_vat_summary`, die Bemessungsgrundlagen stimmen also
mit deren Kz 46, 84, 60 und 21 überein. Die Steuerbeträge (Kz 47, 85, 67) können um einen Cent
abweichen, weil die Prüfung je Steuerregel rundet und die Auswertung je Formularzeile (Kz 84/85
fassen die Regeln 12 und 13 zusammen). Sie meldet Regel 13 (ohne Vorsteuerabzug) bei einem Konto mit
Regelbesteuerung (`reverse_charge_without_deduction`) und die Regeln 12 und 14 (mit
Vorsteuerabzug) bei einem Kleinunternehmer-Konto, das die Steuer schuldet, sie aber nicht abziehen
darf (`reverse_charge_deduction_on_small_business`).

Beide Prüfungen lesen die Dokumente des Zeitraums und, wo die Steuersätze entscheiden, deren
Positionen; `vat` liest außerdem die Kontakt- und die Adressliste je einmal. Wie die anderen
Auswertungen sagen sie, was sie ausgelassen haben (`coverage.truncated`,
`coverage.documentsLeftOut`), und über HTTP hören sie nach etwa 90 Sekunden auf zu lesen: Frag
nach einem Monat, wenn ein Quartal zu viel ist.

## Wie weit du dich darauf verlassen kannst

`sevdesk_vat_summary` und `sevdesk_profit_and_loss` sind Schätzungen zum Prüfen. Sie werden aus
deinen Dokumenten und deren Positionen berechnet, und jedes Ergebnis sagt, was es ausgelassen hat.
Was sie leisten und was bei dir bleibt:

- **Zeitpunkt (Sollversteuerung).** Umsätze zählen zum Ende der Leistung. Das gilt auch für
  Leistungen an Unternehmen in anderen EU-Staaten (Kz 21 und die Zusammenfassende Meldung): Sie
  gehören in den Zeitraum, in dem sie ausgeführt werden. Innergemeinschaftliche Lieferungen zählen
  nach dem Rechnungsdatum, spätestens im Monat nach der Lieferung. Dokumente werden nach Datum mit
  einem Puffer von 62 Tagen um den Zeitraum gelesen; ein Dokument, dessen Steuerzeitpunkt im
  Zeitraum liegt, dessen Datum aber weiter entfernt ist, fehlt, und die Hinweise sagen das.
- **Abschlagsrechnungen.** Ihre Umsatzsteuer entsteht, wenn die Zahlung eingeht. Bei der
  Sollversteuerung berechnet die Umsatzsteuer-Auswertung das nicht: Sie zählt eine
  Abschlagsrechnung wie jede Rechnung zum Leistungsdatum und listet die betroffenen auf
  (`coverage.advanceInvoices`, mit einem Hinweis), damit du sie von Hand prüfen kannst.
- **Istversteuerung.** Es zählen nur Zahlungen, die in sevDesk zugeordnet sind; eine Zahlung, die
  nicht gegen ihr Dokument gebucht ist, fehlt. In der Umsatzsteuer-Auswertung wandern nur
  steuerpflichtige Umsätze zum Zahlungsdatum; Vorsteuer, Steuer nach § 13b und auf
  innergemeinschaftliche Erwerbe sowie steuerfreie Umsätze bleiben bei der Sollversteuerung.
- **Einfuhrumsatzsteuer.** sevDesk bucht sie als Betrag einer Position auf dem Konto
  Einfuhrumsatzsteuer (SKR04 1433, SKR03 1588) mit Steuerregel 9. Solche Beträge gehen in Kz 62
  und zählen als Vorsteuer, nicht als Ausgabe. Auf einem anderen Konto gebuchte
  Einfuhrumsatzsteuer wird nicht erkannt.
- **Keine Anlage EÜR.** Die Gewinn- und Verlustrechnung arbeitet netto und zeigt die
  Umsatzsteuerströme getrennt; die amtliche Anlage EÜR arbeitet brutto, ihre Summen weichen also um
  diese Ströme ab. Anlagegüter werden getrennt aufgeführt und nicht abgeschrieben (keine AfA), und
  Privatnutzung und andere Korrekturen werden nicht berechnet.
- **Unvollständiges Lesen.** Beide Auswertungen lesen Positionen Dokument für Dokument, bis zu
  1.500 Dokumente, was bei langen Zeiträumen dauert. Wenn eine Obergrenze erreicht ist, wenn sich
  die Positionen eines Dokuments nicht vollständig lesen lassen oder wenn einem entfernten Server
  die Zeit ausgeht, sagt die Auswertung das (`coverage.truncated`, mit einem Hinweis), und die
  Umsatzsteuer-Auswertung schätzt Kz 83 nicht. Über HTTP hört eine Auswertung nach etwa 90 Sekunden
  auf, Dokumente zu lesen, weil eine Anfrage 120 Sekunden dauern darf
  ([Grenzen im Fernzugriff](../remote/operations.de.md)). Bei der voreingestellten Anfragerate sind
  das einige hundert Dokumente: Frag nach einem Monat statt nach einem Quartal oder Jahr.
- **Nur deutsche Konten.** Steuerregeln und UStVA-Zeilen folgen deutschem Recht; österreichische
  Konten werden in 1.0 nicht unterstützt.

Entwürfe zählen nie, und nicht gebuchte Kontoumsätze bedeuten oft fehlende Belege. Der Prompt
[`vat_precheck`](../tools.md#vat_precheck) prüft beides, bevor er die Auswertung startet.

## Exporte

### DATEV

> Erstell den DATEV-Export für Oktober 2026 für meine Steuerberaterin, mit den Belegbildern.

[`sevdesk_datev_export`](../tools.md#sevdesk_datev_export) (`write`, ohne Bestätigung) lässt
sevDesk die DATEV-Buchungsdaten (Buchungsstapel, CSV-Dateien in einem ZIP) für einen Monat, ein
Quartal, ein Jahr oder einen Zeitraum erstellen und speichert das ZIP in `SEVDESK_OUTPUT_DIR` (auf
einem entfernten Server: ein Download-Link). Du kannst es auf Einnahmen, Ausgaben, Kontoumsätze,
Kasse oder Anlagen beschränken, nur Dokumente behalten, die im Zeitraum bezahlt wurden, und die
Belegbilder hinzufügen, was die Datei deutlich größer macht. Es dauert bis zu einigen Minuten.

- Es braucht die DATEV-Einstellungen in sevDesk (Beraternummer, Mandantennummer, Beginn des
  Wirtschaftsjahres) und lehnt mit einem Hinweis ab, wenn sie fehlen.
- Es kann die Dokumente in sevDesk als exportiert markieren. Es schreibt sie nie fest.
- sevDesk liefert die Datei aus seinem eigenen Speicher bei Amazon S3 aus
  ([Datenschutz](../../PRIVACY.de.md)).

### CSV

> Exportier alle Belege aus 2026 als CSV.

[`sevdesk_csv_export`](../tools.md#sevdesk_csv_export) (`read`) speichert den CSV-Export von
sevDesk für Rechnungen, Gutschriften, Belege, Kontoumsätze oder Kontakte genau so, wie sevDesk ihn
schickt (UTF-8 mit BOM, durch `;` getrennt, deutsche Spaltenköpfe), höchstens 1.000 Zeilen pro
Datei; das Ergebnis sagt, wenn es mehr geben könnte. Es gibt den Pfad oder Link zurück, nie den
Inhalt, und ändert nichts in sevDesk. Für Summen ist `sevdesk_records_summarize` das bessere
Werkzeug.

Beide Exporte werden nur angeboten, wenn der Server Dateien ausliefern kann: mit
`SEVDESK_OUTPUT_DIR` über stdio ([Konfiguration](../configuration.de.md)) oder über Download-Links
auf einem entfernten Server ([Dateien über HTTP](../remote/files.de.md)). Jeder Aufruf erzeugt eine
neue Datei.

## Siehe auch

- [Rechnungen](invoices.de.md) und [Belege und Eingangsrechnungen](receipts.de.md): die Daten
  richtig erfassen, die diese Auswertungen lesen.
- [Glossar](../glossary.de.md): UStVA, Kennzahl, ZM, EÜR und die anderen Begriffe.

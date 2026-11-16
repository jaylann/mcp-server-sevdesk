<!-- translated-from: docs/guides/evaluations.md sha256:0d5cf7e13d75 -->

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

| Frage                                                       | Werkzeug                                                                   | Stufe   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| Umsatz je Monat, Kosten je Lieferant, Summen                | [`sevdesk_records_summarize`](../tools.md#sevdesk_records_summarize)       | `read`  |
| Wer uns was schuldet, und seit wann                         | [`sevdesk_receivables_aging`](../tools.md#sevdesk_receivables_aging)       | `read`  |
| Was wir schulden, und wann es fällig ist                    | [`sevdesk_payables_aging`](../tools.md#sevdesk_payables_aging)             | `read`  |
| Wie viel Geld wir haben und haben werden                    | [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)               | `read`  |
| Was sich seit einem Datum geändert hat                      | [`sevdesk_changed_since`](../tools.md#sevdesk_changed_since)               | `read`  |
| Was ungefähr in der Umsatzsteuer-Voranmeldung stehen wird   | [`sevdesk_vat_summary`](../tools.md#sevdesk_vat_summary)                   | `read`  |
| Gewinn für einen Monat, ein Quartal oder ein Jahr           | [`sevdesk_profit_and_loss`](../tools.md#sevdesk_profit_and_loss)           | `read`  |
| Was falsch aussieht: Umsatzsteuer, § 13b, Dubletten, Lücken | [`sevdesk_records_audit`](../tools.md#sevdesk_records_audit)               | `read`  |
| Welche Belege in meinem Ordner nicht gebucht sind           | [`sevdesk_receipt_folder_check`](../tools.md#sevdesk_receipt_folder_check) | `read`  |
| Eine CSV-Datei für Excel oder die Steuerberatung            | [`sevdesk_csv_export`](../tools.md#sevdesk_csv_export)                     | `read`  |
| Die DATEV-Buchungsdaten für die Steuerberatung              | [`sevdesk_datev_export`](../tools.md#sevdesk_datev_export)                 | `write` |

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

> Haben wir im dritten Quartal einen Beleg doppelt gebucht, und welche Entwürfe sind noch offen?

> Fehlt dieses Jahr eine Monatsrechnung?

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
nutzt dieselben Steuerzeitpunkte wie `sevdesk_vat_summary`, die Summen stimmen also mit deren Kz
46/47, 84/85, 67, 60 und 21 überein. Sie meldet Regel 13 (ohne Vorsteuerabzug) bei einem Konto mit
Regelbesteuerung (`reverse_charge_without_deduction`).

### Doppelt gebuchte Belege und liegen gebliebene Entwürfe (`duplicates`)

Die Prüfung vergleicht die Belege jedes Lieferanten, Ausgaben und Einnahmen getrennt. Lieferant
ist der Kontakt des Belegs oder, wenn er keinen hat, der Lieferantenname auf dem Beleg; ein Beleg
ohne beides wird nicht verglichen, die Hinweise zählen ihn. Ein Paar zählt im Zeitraum seines
späteren Belegs; für den früheren werden Belege bis 31 Tage vor dem Zeitraum gelesen.

| Code                    | Bedeutet                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `voucher_number_twice`  | Gebuchte Belege mit derselben Belegnummer (`warning`). Groß- und Kleinschreibung, Leerzeichen und `-_/.#` zählen nicht; eine Nummer braucht eine Ziffer, „Miete“ als Beschreibung ist keine |
| `voucher_receipt_twice` | Ein Paar mit gleichem Betrag, dessen Belegdateien dieselbe SHA-256-Prüfsumme haben: dieselbe Datei zweimal hochgeladen (`warning`)                                                          |
| `voucher_amount_twice`  | Gebuchte Belege mit demselben Bruttobetrag und derselben Währung, höchstens 5 Tage auseinander, nicht durch zwei verschiedene Nummern unterschieden (`check`)                               |
| `draft_repeats_voucher` | Ein Entwurf mit derselben Nummer wie ein gebuchter Beleg oder demselben Betrag innerhalb von 5 Tagen (`check`): lieber löschen als buchen                                                   |
| `voucher_draft_stuck`   | Ein Beleg mit Datum im Zeitraum, der 21 Tage oder länger nach dem Anlegen in sevDesk noch ein Entwurf ist (`check`)                                                                         |
| `sales_draft_stuck`     | Dasselbe für eine Rechnung oder Gutschrift: Der Kunde hat noch keine Rechnung (`check`)                                                                                                     |

Bewusst nicht gemeldet: Einkäufe mit gleichem Betrag im Abstand einer Woche, zwei Belege mit
verschiedenen Nummern, ein Beleg und seine Stornierung (+x und −x), dieselbe Nummer von einem
anderen Lieferanten oder in der anderen Richtung, ein Bruttobetrag von 0, zwei Entwürfe (jeder wird
gemeldet, sobald er liegen geblieben ist) und ein Entwurf, der vor weniger als 21 Tagen angelegt
wurde, wie alt sein Belegdatum auch ist. Ausgangsrechnungen werden nur auf liegen gebliebene
Entwürfe geprüft: Ihre Nummern kommen aus dem Nummernkreis von sevDesk, und eine doppelt gestellte
Rechnung wird mit einer Stornorechnung berichtigt.

Um ein Paar mit gleichem Betrag zu bestätigen, vergleicht die Prüfung die SHA-256-Prüfsummen der
Belegdateien seiner Belege, die sevDesk mit der Belegliste schickt (kein zusätzlicher Abruf je
Beleg). Verschiedene Prüfsummen oder eine Belegdatei ohne Prüfsumme beweisen nichts, denn dasselbe
Papier zweimal gescannt ergibt zwei Dateien; ein solches Paar bleibt ein `check`.

### Fehlende Rechnungen regelmäßiger Lieferanten (`recurring_gaps`)

Die Prüfung lernt aus den Ausgabenbelegen, welche Lieferanten jeden Monat, jedes Quartal oder jedes
Jahr abrechnen, und meldet einen Zeitraum innerhalb der Prüfung ohne einen Beleg dieses
Lieferanten: meist ein verlorener oder nicht gebuchter Beleg. Sie liest die Belege (Entwürfe
eingeschlossen) von 24 Monaten vor dem Zeitraum bis 12 Monate danach, aber nicht über heute
hinaus. Der Befund nennt die fehlenden Monate (`missing`) und listet die Rechnungen des Lieferanten
vor und nach jeder Lücke.

Ein Lieferant gilt als regelmäßig, wenn seine Rechnungen mindestens in drei von vier Fällen auf
ungefähr denselben Tag fallen (innerhalb von 7 Tagen), in der Regel eine Rechnung (oder seine
übliche Zahl an Rechnungen) je Zeitraum, mit höchstens einem von vier Zeiträumen ohne Rechnung;
Quartals- und Jahresrechnungen müssen in denselben Monat des Quartals oder Jahres fallen. Ein
Zeitraum gilt nur dann als fehlend, wenn davor mindestens drei Monate (bei Quartal und Jahr: zwei
Zeiträume) mit Rechnungen liegen und danach einer.

| Code                     | Bedeutet                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `monthly_bill_missing`   | Ein Monat ohne Rechnung eines Lieferanten, der monatlich abrechnet       |
| `quarterly_bill_missing` | Ein Quartal ohne Rechnung eines Lieferanten, der quartalsweise abrechnet |
| `yearly_bill_missing`    | Ein Jahr ohne Rechnung eines Lieferanten, der jährlich abrechnet         |

Bewusst nicht gemeldet: ein geänderter Betrag (Beträge werden nicht verglichen), eine Rechnung, die
sich um ein paar Tage über ein Monatsende verschoben hat, zwei Rechnungen in einem Monat neben einem
Monat ohne Rechnung (die Rechnung kam zu spät oder zu früh), ein Lieferant, der nicht mehr abrechnet,
und der letzte Zeitraum, solange die nächste Rechnung des Lieferanten noch nicht da ist.
Wiederkehrende Belegvorlagen (RV) von sevDesk sind keine Rechnungen und werden nicht gelesen; die
daraus gebuchten Belege zählen wie alle anderen. Hört die Liste an ihrer Obergrenze auf, meldet die
Prüfung gar keine Lücken, denn ein nicht gelesener Beleg sähe wie eine aus.

Die Prüfungen `vat` und `reverse_charge` lesen die Dokumente des Zeitraums und, wo die Steuersätze
entscheiden, deren Positionen; `vat` liest außerdem die Kontakt- und die Adressliste je einmal.
`duplicates` und `recurring_gaps` lesen nur Dokumentlisten. Wie die anderen Auswertungen sagen
sie, was sie ausgelassen haben (`coverage.truncated`, `coverage.documentsLeftOut`), und über HTTP
hören sie nach etwa 90 Sekunden auf zu lesen: Frag nach einem Monat, wenn ein Quartal zu viel ist.

### Belege im Ordner, die nie gebucht wurden

> Welche Belege in meinem Ordner für März 2026 sind nicht in sevDesk gebucht?

[`sevdesk_receipt_folder_check`](../tools.md#sevdesk_receipt_folder_check) vergleicht die
Belegdateien eines Ordners auf deinem Rechner mit den Belegdateien an den Belegen in sevDesk. Es
ist ein eigenes Werkzeug, weil es nur dort existiert, wo der Server lokale Ordner lesen kann: Es
wird nur mit `SEVDESK_FILE_DIRS` angeboten ([Konfiguration](../configuration.de.md)), und nicht
auf einem entfernten Server, wo ein Upload eine einzelne Datei bringt
([Dateien über HTTP](../remote/files.de.md)).

Es liest nur innerhalb von `SEVDESK_FILE_DIRS`: den Ordner, den du nennst, oder alle, Unterordner
bis drei Ebenen tief nur auf Wunsch. Es nimmt PDF-, PNG-, JPEG- und XML-Dateien (am Inhalt
erkannt) bis 20 MB, höchstens 500 Dateien und 1 GB je Aufruf, und berechnet die SHA-256-Prüfsumme
jeder Datei. Versteckte Dateien, symbolische Links und andere Dateitypen werden übersprungen und
gezählt; ist eine Grenze erreicht, sagt das Ergebnis, dass der Ordner abgeschnitten wurde. Kein
Dateiinhalt verlässt den Server und nichts wird hochgeladen: Das Ergebnis enthält Pfade, Größen,
Änderungsdaten und Prüfsummen. sevDesk speichert die Prüfsumme jeder hochgeladenen Belegdatei, also
liest die Prüfung aus sevDesk nur die Belegliste des Zeitraums, 62 Tage davor und danach, Entwürfe
eingeschlossen.

| Code                         | Bedeutet                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `receipt_file_booked_twice`  | Zwei oder mehr gebuchte Belege tragen die Datei (`warning`)                                          |
| `receipt_file_not_booked`    | Kein gelesener Beleg trägt die Datei: wohl nie gebucht (`check`)                                     |
| `receipt_file_before_period` | Ebenso, aber die Datei wurde vor den gelesenen Belegen zuletzt geändert: ein älterer Beleg (`check`) |
| `receipt_file_only_on_draft` | Nur ein Entwurf trägt die Datei: noch nicht gebucht (`check`)                                        |
| `receipt_file_draft_repeats` | Ein gebuchter Beleg und ein Entwurf tragen die Datei: den Entwurf löschen statt buchen (`check`)     |

Jede Datei mit Treffer wird mit ihren Belegen und deren Status aufgeführt (`matched`). Ein Treffer
beweist, dass genau diese Datei an diesem Beleg hängt. Kein Treffer ist ein Hinweis, kein Beweis:
Derselbe Beleg als andere Datei (ein Scan oder Foto des Papiers, eine von sevDesk oder einem
anderen Programm umgewandelte oder verkleinerte Kopie, ein Beleg, der per E-Mail oder über die App
kam) hat eine andere Prüfsumme, und ein Beleg mit einem Datum außerhalb des gelesenen Zeitraums
wird nicht verglichen. Beträge, Daten und Lieferanten werden nicht verglichen, denn dafür müsste
der Inhalt der Datei gelesen werden. Zwei schwache Hinweise helfen: der Tag der letzten Änderung
der Datei (`modified`, nicht das Belegdatum) und Belege, deren Belegnummer im Dateinamen steht
(`possibleVouchers`). Um eine fehlende Datei zu buchen, lege mit
[`sevdesk_voucher_create_draft`](../tools.md#sevdesk_voucher_create_draft) einen Entwurf mit der
Datei als `file` an (braucht `write`).

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

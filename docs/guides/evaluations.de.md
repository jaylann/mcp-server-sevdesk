<!-- translated-from: docs/guides/evaluations.md sha256:169b8940130e -->

# Auswertungen und Exporte

Was dir der Assistent über deine Bücher sagen kann und wo seine Antworten enden: Summen, offene
Posten, Liquidität, die Umsatzsteuer-Auswertung, die Gewinn- und Verlustrechnung und die Exporte für
deine Steuerberatung. Diese Seite ist für alle, die Zahlen aus sevDesk haben wollen, und für alle,
die entscheiden, wie weit sie ihnen trauen. Jede Auswertung hier ist `read`; der DATEV-Export und
das Belegarchiv brauchen `write`, das Setzen der DATEV-Einstellungen braucht `commit`
([Berechtigungen](../permissions.de.md#stufen)).

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
| Eine CSV-Datei für Excel oder die Steuerberatung          | [`sevdesk_csv_export`](../tools.md#sevdesk_csv_export)               | `read`  |
| Die DATEV-Buchungsdaten für die Steuerberatung            | [`sevdesk_datev_export`](../tools.md#sevdesk_datev_export)           | `write` |
| Alle Rechnungs- oder Beleg-PDFs eines Zeitraums           | [`sevdesk_archive_export`](../tools.md#sevdesk_archive_export)       | `write` |

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

Mit `format: "xml"` exportiert sevDesk statt des Buchungsstapels die Dokumente selbst als
DATEV-XML mit ihren Belegbildern, für eine Steuerberatung, die Belege importiert. Das umfasst nur
Einnahmen und Ausgaben (Kontoumsätze, Kasse und Anlagen fallen weg, und die Vorschau sagt das),
und die Belegbilder sind immer dabei: etwa 5,6 MB für einen Monat eines kleinen Kontos. Nur die im
Zeitraum bezahlten Dokumente zu behalten (`exportByPaydate`) geht nur beim CSV-Export: Der
XML-Export wurde ohne diese Option aufgezeichnet, daher lehnt das Werkzeug sie dort ab. Ob der
XML-Export festgeschriebene Dokumente enthält, wurde nicht aufgezeichnet; Vorschau und Ergebnis
sagen das, prüfe den Export also in sevDesk, wenn sie darin sein müssen. Der CSV-Export bleibt die
Voreinstellung.

- Es braucht die DATEV-Einstellungen in sevDesk (Beraternummer, Mandantennummer, Beginn des
  Wirtschaftsjahres) und lehnt mit einem Hinweis ab, wenn sie fehlen; siehe
  [DATEV-Einstellungen](#datev-einstellungen) unten.
- Es schreibt die Dokumente nie fest. Ein aufgezeichneter XML-Export hat nichts als exportiert
  markiert: Ein zweiter Export desselben Zeitraums enthielt dieselben Dokumente.
- sevDesk liefert die Datei aus seinem eigenen Speicher bei Amazon S3 aus
  ([Datenschutz](../../PRIVACY.de.md)).
- Dieser Server lädt höchstens 100 MiB herunter. Ein größerer Export (ein langer Zeitraum mit
  Belegbildern) wird nicht gespeichert: Exportiere Monat für Monat, oder lade ihn in sevDesk
  herunter.

### DATEV-Einstellungen

> Setz die DATEV-Mandantennummer auf 54321; die Beraternummer meiner Steuerberaterin ist 1234567.

[`sevdesk_datev_settings_update`](../tools.md#sevdesk_datev_settings_update) (`commit`, fragt
nach deiner Bestätigung) setzt die Beraternummer (1001 bis 9999999), die Mandantennummer (1 bis 99999) und den Beginn des Wirtschaftsjahres, die der DATEV-Export braucht. Gib nur an, was sich
ändert; die anderen behalten ihren Wert in sevDesk, weil sevDesk alle drei zusammen nimmt. Die
Bestätigung zeigt jeden bisherigen Wert neben dem neuen und warnt, wenn eine so behaltene Nummer
außerhalb des DATEV-Bereichs liegt oder der angegebene Beginn des Wirtschaftsjahres mehr als ein
Jahr vom heutigen Tag entfernt ist (gemeint ist der erste Tag des laufenden Wirtschaftsjahres).
Danach liest das Werkzeug die Einstellungen zurück und sagt, was sevDesk gespeichert hat.

Die Einstellungen gelten für das ganze Konto: Jeder spätere DATEV-Export trägt sie, und das DATEV
deiner Steuerberatung ordnet die Daten danach zu. Nimm die Nummern von deiner Steuerberatung; eine
falsche Nummer legt deine Buchungsdaten bei einem anderen Mandanten ab oder lässt den Import
scheitern.

### Rechnungs- und Belegarchiv

> Pack alle Rechnungs-PDFs aus 2026 für die Betriebsprüfung in ein ZIP.

[`sevdesk_archive_export`](../tools.md#sevdesk_archive_export) (`write`, ohne Bestätigung) lässt
sevDesk jedes Rechnungs-PDF (`subject: "invoices"`) oder jeden Beleg (`subject: "vouchers"`)
eines Monats, Quartals, Jahres oder Zeitraums in ein ZIP packen, eine Datei pro Dokument, und
speichert es wie den DATEV-Export. Rechnungen lassen sich auf einen Kunden eingrenzen, beide auf
einen Bereich von Beträgen (einschließlich der Grenzen; bei Belegen der Bruttobetrag).

- An keinem Dokument ändert sich etwas: kein Status, kein Versanddatum, nichts festgeschrieben. Es
  braucht `write`, weil sevDesk auf Anfrage jedes PDF erzeugt.
- **sevDesk nimmt Entwürfe mit.** Ihre Dateinamen tragen „(Entwurf)“ und keine Nummer; das
  Ergebnis zählt sie (`draftEntries`) und sagt es. Entferne sie, bevor du das Archiv weitergibst.
  Nur diese Kennzeichnung zählt: Ob sevDesk andere Zustände genauso markiert, wurde nicht
  beobachtet, nimm also nichts anderes allein auf das Wort des Werkzeugs heraus.
- **Das Archiv kann weniger Dateien enthalten, als du Dokumente hast.** Belege ohne hochgeladene
  Belegdatei fehlen darin (13 Dateien für 53 Belege auf dem Testkonto), und ein Rechnungsarchiv
  enthielt eine Rechnung weniger als die Rechnungsliste. So baut sevDesk das Archiv, das ist kein
  Fehler; vergleiche die Anzahl mit den Listen, wenn es auf Vollständigkeit ankommt.
- **Es dauert.** sevDesk erzeugt das ganze ZIP, bevor es antwortet: etwa 30 bis 60 Sekunden für
  100 bis 130 Rechnungen (20 bis 25 MB), etwa eine Sekunde für ein paar Belege. Die Anfrage für
  das Archiv bekommt bis zu 5 Minuten, unabhängig von `SEVDESK_TIMEOUT_MS`; danach bricht sie ab,
  ohne etwas zu speichern, und die Abhilfe ist ein kürzerer Zeitraum. Auf einem entfernten Server
  endet jede Anfrage nach 120 Sekunden ([Betrieb](../remote/operations.de.md)), und der
  Download-Link muss in den Anteil des Kontos am Dateispeicher passen, 20 MiB ohne
  Zustandsverzeichnis ([Dateien](../remote/files.de.md#grenzen-und-laufzeiten)): Exportiere dort
  ein bis zwei Wochen Rechnungen pro Aufruf.
- Es fragt sevDesk nach höchstens 500 Dokumenten (`limit`, bis 1.000) und speichert höchstens
  100 MiB pro ZIP (eine erzeugte Rechnung hat etwa 140 bis 190 KB): 500 Rechnungen passen in die
  5 Minuten und die 100 MiB, 1.000 nicht. Exportiere lange Zeiträume in Teilen. Enthält das ZIP
  fast `limit` Dateien, sagt das Ergebnis, dass sevDesk dort aufgehört haben kann
  (`mayBeTruncated`). Das ist ein Hinweis, keine Zählung: Belege ohne Belegdatei fehlen im ZIP,
  daher kann ein Belegarchiv abgeschnitten sein und trotzdem weit weniger Dateien als `limit`
  enthalten.
- Passt nichts, schickt sevDesk ein ZIP mit nur einem Hinweis darin; das Werkzeug speichert nichts
  und sagt, dass kein Dokument gepasst hat.

### CSV

> Exportier alle Belege aus 2026 als CSV.

[`sevdesk_csv_export`](../tools.md#sevdesk_csv_export) (`read`) speichert den CSV-Export von
sevDesk für Rechnungen, Gutschriften, Belege, Kontoumsätze oder Kontakte genau so, wie sevDesk ihn
schickt (UTF-8 mit BOM, durch `;` getrennt, deutsche Spaltenköpfe), höchstens 1.000 Zeilen pro
Datei; das Ergebnis sagt, wenn es mehr geben könnte. Es gibt den Pfad oder Link zurück, nie den
Inhalt, und ändert nichts in sevDesk. Für Summen ist `sevdesk_records_summarize` das bessere
Werkzeug.

Die Datei-Exporte werden nur angeboten, wenn der Server Dateien ausliefern kann: mit
`SEVDESK_OUTPUT_DIR` über stdio ([Konfiguration](../configuration.de.md)) oder über Download-Links
auf einem entfernten Server ([Dateien über HTTP](../remote/files.de.md)). Jeder Aufruf erzeugt eine
neue Datei.

## Siehe auch

- [Rechnungen](invoices.de.md) und [Belege und Eingangsrechnungen](receipts.de.md): die Daten
  richtig erfassen, die diese Auswertungen lesen.
- [Glossar](../glossary.de.md): UStVA, Kennzahl, ZM, EÜR und die anderen Begriffe.

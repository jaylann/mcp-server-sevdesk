<!-- translated-from: docs/guides/receipts.md sha256:195c5b11dc86 -->

# Belege und Eingangsrechnungen

Diese Anleitung behandelt das Geld, das hinausgeht (und Einnahmen ohne eigene Rechnung): eine
Quittung oder Lieferantenrechnung als Beleg erfassen, eine E-Rechnung importieren, den Beleg
verbuchen und bezahlen. Sie ist für alle, die ihre Buchhaltung selbst in sevDesk machen. Zu jedem
Schritt steht, was du fragst, das Werkzeug, die [Stufe](../permissions.de.md#stufen) und ob du
bestätigst.

## Überblick

| Schritt                                                               | Werkzeug                                                                                                                                               | Stufe             | Bestätigung     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------- |
| [Datei bereitstellen](#die-datei-bereitstellen)                       | `SEVDESK_FILE_DIRS`, oder [`sevdesk_upload_request`](../tools.md#sevdesk_upload_request) auf einem entfernten Server                                   | `read`            | nein            |
| [Auf Dubletten prüfen](#auf-dubletten-prüfen)                         | [`sevdesk_vouchers_list`](../tools.md#sevdesk_vouchers_list)                                                                                           | `read`            | nein            |
| [Konto und Steuerregel wählen](#buchungskonto-und-steuerregel-wählen) | [`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup) (`receipt_guidance`)                                                                | `read`            | nein            |
| [Belegentwurf anlegen](#den-belegentwurf-anlegen)                     | [`sevdesk_voucher_create_draft`](../tools.md#sevdesk_voucher_create_draft)                                                                             | `write`           | nein            |
| [Oder eine E-Rechnung importieren](#eine-e-rechnung-importieren)      | [`sevdesk_einvoice_parse`](../tools.md#sevdesk_einvoice_parse), [`sevdesk_voucher_import_einvoice`](../tools.md#sevdesk_voucher_import_einvoice)       | `read`, `write`   | nein            |
| [Entwurf korrigieren](#einen-entwurf-korrigieren)                     | [`sevdesk_voucher_update_draft`](../tools.md#sevdesk_voucher_update_draft), [`sevdesk_voucher_delete_draft`](../tools.md#sevdesk_voucher_delete_draft) | `write`, `commit` | Löschen: **ja** |
| [Fertigstellen](#fertigstellen)                                       | [`sevdesk_voucher_finalize`](../tools.md#sevdesk_voucher_finalize)                                                                                     | `commit`          | **ja**          |
| [Zahlung buchen](#die-zahlung-buchen)                                 | [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment)                                                                             | `commit`          | **ja**          |
| [Festschreiben](#festschreiben)                                       | [`sevdesk_voucher_enshrine`](../tools.md#sevdesk_voucher_enshrine)                                                                                     | `commit`          | **ja**          |

Der Prompt [`receipt_intake`](../tools.md#receipt_intake) führt diese Schritte der Reihe nach aus,
mit einem Probelauf vor jeder Änderung.

> [!IMPORTANT]
> Schreibende Zugriffe auf Belege brauchen sevDesk-Update 2.0. Konten im älteren
> Buchhaltungssystem 1.0 können Belege auflisten und lesen, aber nicht anlegen oder ändern.

## Die Datei bereitstellen

Die Beleg-Werkzeuge lesen nie von sich aus auf deiner Festplatte:

- **Über stdio** lesen sie Belegdateien (PDF, PNG, JPEG) und E-Rechnungen (XRechnung-XML, ZUGFeRD-
  oder Factur-X-PDF) nur aus den Ordnern in `SEVDESK_FILE_DIRS`, bis 20 MiB pro Datei
  ([Konfiguration](../configuration.de.md)). Ohne diese Einstellung lässt sich ein Belegentwurf
  trotzdem anlegen, nur ohne Datei, und die beiden E-Rechnungs-Werkzeuge werden nicht angeboten.
- **Auf einem entfernten Server** lädst du die Datei in deinem Browser hoch: Der Assistent ruft
  [`sevdesk_upload_request`](../tools.md#sevdesk_upload_request) auf, gibt dir einen Link und
  reicht den Upload weiter, sobald du sagst, dass du fertig bist. Auf eine Seite passen bis zu 10
  Dateien; siehe [Dateien über HTTP](../remote/files.de.md).
- **Von einem Link**, in beiden Modi, wenn die Hosts, von denen er kommen darf, in
  `SEVDESK_FILE_URL_HOSTS` stehen: Gib dem Assistenten einen https-Link zur Datei (den
  Download-Link eines Lieferantenportals, einen Speicher-Link). Der Server lädt sie nur für diesen
  Aufruf herunter, ohne sich irgendwo anzumelden; siehe
  [Dateien von einem Link](../configuration.de.md#dateien-von-einem-link).

Die Vorschau des Probelaufs zeigt die vollständige SHA-256 der Datei. Der echte Aufruf liest die
Datei erneut (ein Link wird erneut heruntergeladen); der Assistent kann diese SHA-256 deshalb als
`fileSha256` übergeben: Haben sich die Bytes dazwischen geändert, wird der Aufruf abgelehnt, bevor
etwas sevDesk erreicht.

> Erfasse den Beleg Belege/2026-11/tankstelle-shell.pdf.

## Auf Dubletten prüfen

> Gibt es schon einen Beleg von Hetzner mit der Nummer R-88231?

[`sevdesk_vouchers_list`](../tools.md#sevdesk_vouchers_list) (`read`) filtert nach Lieferant,
Belegnummer, Zeitraum und Status. Die Entwurfswerkzeuge prüfen selbst noch einmal: Ein Beleg mit
demselben Lieferanten, derselben Nummer, demselben Datum und demselben Bruttobetrag wird abgelehnt,
außer du sagst, dass es wirklich ein zweiter ist.

## Buchungskonto und Steuerregel wählen

> Welches Buchungskonto und welche Steuerregel passen zu einem Software-Abo, das aus Irland ohne Umsatzsteuer berechnet wird?

Jede Belegposition wird auf ein Buchungskonto mit einer Steuerregel gebucht, und sevDesk nimmt nur
bestimmte Kombinationen an. [`sevdesk_reference_lookup`](../tools.md#sevdesk_reference_lookup) mit
`kind: receipt_guidance` (`read`) listet, welches Konto welche Steuerregeln und Steuersätze
erlaubt, für Ausgaben- wie für Einnahmenbelege (sevDesks Kontierungshilfe). Wenn nichts anderes
gesagt ist, verwendet eine Ausgabe Steuerregel 9 (Vorsteuer abziehbar), auf einem
Kleinunternehmer-Konto 10. Frühere Belege desselben Lieferanten, gelesen mit
[`sevdesk_voucher_get`](../tools.md#sevdesk_voucher_get), zeigen, wie bisher gebucht wurde.

Welches Konto und welche Regel für einen Einkauf gelten, entscheidest du oder deine
Steuerberatung; die Werkzeuge prüfen nur, ob sevDesk die Kombination annimmt.

## Den Belegentwurf anlegen

> Buch diese Tankquittung: Shell, 14. November, 78,40 € brutto mit 19 %, mit Karte bezahlt.

[`sevdesk_voucher_create_draft`](../tools.md#sevdesk_voucher_create_draft) (`write`, ohne
Bestätigung) legt einen Belegentwurf an: Ausgabe (die Voreinstellung) oder Einnahme, den
Lieferanten als Kontakt oder nur mit Namen, Belegnummer, Daten und eine Position je Buchungskonto
und Steuersatz, standardmäßig brutto. Jede Kombination aus Konto, Steuerregel und Steuersatz wird
vor dem Speichern gegen die Kontierungshilfe geprüft, und die Datei, falls angegeben, wird
hochgeladen und angehängt. Der Beleg bleibt ein Entwurf: Gebucht ist noch nichts.

Fremdwährungen funktionieren mit einem Wechselkurs oder einem Kursdatum, aber solche Entwürfe lassen
sich über den Server nicht fertigstellen. Die Regeln für das Ändern stehen in der
[Werkzeugreferenz](../tools.md#sevdesk_voucher_update_draft).

## Eine E-Rechnung importieren

> Prüf die E-Rechnung Rechnungen/RE-4711.xml, bevor ich sie importiere.

[`sevdesk_einvoice_parse`](../tools.md#sevdesk_einvoice_parse) (`read`) liest eine XRechnung (UBL
oder CII) oder ein ZUGFeRD- / Factur-X-PDF, prüft Summen, die Aufschlüsselung der Umsatzsteuer und
einen Teil der Regeln aus EN 16931 und XRechnung und schlägt einen Beleg vor: Richtung, passenden
Kontakt (über USt-IdNr., IBAN oder exakten Namen), Steuerregel und eine Position je Steuersatz.
Nichts geht an sevDesk, und kein Kontakt wird angelegt. Ein einfaches PDF ohne eingebettetes XML
ist keine E-Rechnung und wird abgelehnt; erfasse es stattdessen als normalen Beleg.

> Importier sie als Beleg auf Konto 4930, für alle Steuersätze.

[`sevdesk_voucher_import_einvoice`](../tools.md#sevdesk_voucher_import_einvoice) (`write`, ohne
Bestätigung) legt aus der E-Rechnung den Belegentwurf an, mit der Originaldatei als Anhang. Das
Buchungskonto gibst du vor, eines für alle Steuersätze oder eines je Satz. Das Werkzeug lehnt Summen
oder Aufschlüsselungen der Umsatzsteuer ab, auf die es sich nicht verlassen kann, und Kombinationen
aus Konto und Steuerregel, die sevDesk ablehnen würde. Bewahre die Originaldatei auf: Bei einer
E-Rechnung ist das XML der Beleg, den du aufbewahren musst.

## Einen Entwurf korrigieren

> Die Belegerkennung hat bei Beleg 5521 das Datum falsch gelesen. Speicher die Belegdatei, damit wir vergleichen können.

> Setz bei Beleg 5521 das Datum auf den 3. November und den Betrag auf 249,90 € brutto.

[`sevdesk_voucher_receipt_save`](../tools.md#sevdesk_voucher_receipt_save) (`read`) speichert die
an einen Beleg angehängte Datei nach `SEVDESK_OUTPUT_DIR` (auf einem entfernten Server: ein
Download-Link), zum Beispiel um zu prüfen, was sevDesks eigene Belegerkennung gelesen hat.
[`sevdesk_voucher_update_draft`](../tools.md#sevdesk_voucher_update_draft) (`write`, ohne
Bestätigung) ändert Lieferant, Daten, Steuerregel, Positionen oder die Datei eines Entwurfs; neue
Positionen ersetzen alle gespeicherten.

> Lösch den Belegentwurf 5530, das ist eine Dublette.

[`sevdesk_voucher_delete_draft`](../tools.md#sevdesk_voucher_delete_draft) (`commit`, **du
bestätigst**) löscht einen Entwurf, der nicht festgeschrieben ist. Gebuchte Belege werden nie
gelöscht.

> [!WARNING]
> Das Löschen eines Entwurfs lässt sich nicht rückgängig machen, und eine angehängte Belegdatei
> kann mit verschwinden.

## Fertigstellen

> Verbuch den Shell-Beleg.

[`sevdesk_voucher_finalize`](../tools.md#sevdesk_voucher_finalize) (`commit`, **du bestätigst**)
verbucht den Beleg: vom Entwurf zu offen, sodass er ab jetzt in der Gewinn- und Verlustrechnung
und in der Umsatzsteuer-Voranmeldung zählt. Vorher prüft es, was sevDesk sonst erst spät ablehnen würde: eine
Steuerregel, die zu deiner Umsatzsteuerregelung passt, mindestens eine Position und jede
Kombination aus Konto, Regel und Steuersatz. Solange der Beleg nicht festgeschrieben ist, macht
[`sevdesk_voucher_reset`](../tools.md#sevdesk_voucher_reset) (`commit`, du bestätigst) ihn wieder
zum Entwurf.

## Die Zahlung buchen

> Die Hetzner-Rechnung wurde am 5. November vom Geschäftskonto bezahlt. Buch das.

[`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment) (`commit`, **du
bestätigst**) bucht einen Bruttobetrag auf ein Zahlungskonto: Geld hinaus bei einer Ausgabe, Geld
herein bei einem Einnahmenbeleg. Bei einem Konto, dessen Umsätze per Bankimport kommen, verknüpft
der Assistent den importierten Umsatz, damit nichts doppelt zählt. Skonto und Bankgebühren gleichen
den Beleg mit weniger aus; mehr als den offenen Betrag lehnt das Werkzeug ab, außer du sagst, dass
die Differenz gewollt ist. Bezahlen lassen sich nur offene oder teilweise bezahlte Belege; einen
Entwurf stellst du vorher fertig. Eine falsche Zahlung machst du mit `sevdesk_voucher_reset` auf
`open` rückgängig.

Von der Bankseite aus ordnet der Prompt [`bank_reconciliation`](../tools.md#bank_reconciliation)
nicht gebuchte Kontoumsätze über Belegnummer und Betrag den Belegen zu und bucht jede Zuordnung,
der du zustimmst, mit [`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book)
(`commit`). Eine Bankgebühr, zu der es noch keinen Beleg gibt, bekommt zuerst einen Beleg, dann
wird der Umsatz darauf gebucht.

Um die Belege zu finden, die überhaupt fehlen, geht der Prompt
[`missing_receipts`](../tools.md#missing_receipts) einen Monat oder ein Quartal durch: ausgehende
Umsätze, die kein Beleg erklärt, Lieferanten, die regelmäßig abrechnen und im Zeitraum keine
Rechnung haben, Belege nur im Entwurf oder doppelt gebucht und, mit `SEVDESK_FILE_DIRS`, die Dateien
in deinem Belegordner, die an keinem Beleg hängen. Seine Befunde sind Hinweise, keine
Steuerberatung; ein Beleg, der auftaucht, wird wie oben als Belegentwurf erfasst.

## Festschreiben

> Schreib die Belege des dritten Quartals fest.

[`sevdesk_voucher_enshrine`](../tools.md#sevdesk_voucher_enshrine) (`commit`, **du bestätigst**)
schreibt einen verbuchten Beleg dauerhaft fest (GoBD), eine Bestätigung je Beleg. Danach lässt er
sich nie mehr ändern, zurücksetzen oder löschen; eine Korrektur braucht einen neuen Beleg.

> [!WARNING]
> Die Festschreibung ist endgültig. Entscheide mit deiner Steuerberatung, wann ein Zeitraum
> abgeschlossen wird.

## Siehe auch

- [Rechnungen](invoices.de.md): die Ausgangsseite, vom Entwurf bis zur Zahlung.
- [Auswertungen und Exporte](evaluations.de.md): offene Verbindlichkeiten, Umsatzsteuer-Auswertung,
  DATEV-Export mit Belegbildern.
- [Glossar](../glossary.de.md): Beleg, Steuerregel, Buchungskonto und die anderen Begriffe mit
  ihren englischen Entsprechungen.

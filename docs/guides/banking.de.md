<!-- translated-from: docs/guides/banking.md sha256:19b1a9c2b52c -->

# Bank und Kasse

Diese Anleitung behandelt das Geld auf deinen Zahlungskonten: welches Konto was annimmt, einen
Barverkauf oder eine Barausgabe in der Kasse erfassen, einen Kontoumsatz von Hand eintragen, Umsätze
Dokumenten zuordnen und einen Umsatz löschen oder festschreiben. Zu jedem Schritt steht, was du
fragst, das Werkzeug, die [Stufe](../permissions.de.md#stufen) und ob du bestätigst.

## Überblick

| Schritt                                                                                | Werkzeug                                                                                                                                               | Stufe            | Bestätigung      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---------------- |
| [Konten und Bestände ansehen](#welches-konto-was-annimmt)                              | [`sevdesk_bank_accounts_list`](../tools.md#sevdesk_bank_accounts_list), [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)                   | `read`           | nein             |
| [Ein Konto anlegen](#welches-konto-was-annimmt)                                        | [`sevdesk_bank_account_create`](../tools.md#sevdesk_bank_account_create)                                                                               | `write`          | nein             |
| [Barverkauf oder Barausgabe erfassen](#einen-barverkauf-oder-eine-barausgabe-erfassen) | [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment), [`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment) | `commit`         | **ja**           |
| [Einen Umsatz von Hand erfassen](#einen-umsatz-von-hand-erfassen)                      | [`sevdesk_transaction_create`](../tools.md#sevdesk_transaction_create)                                                                                 | `commit`         | **ja**           |
| [Umsätze Dokumenten zuordnen](#umsätze-zuordnen)                                       | [`sevdesk_reconcile_suggest`](../tools.md#sevdesk_reconcile_suggest), [`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book)               | `read`, `commit` | Zuordnen: **ja** |
| [Einen Umsatz löschen](#einen-umsatz-löschen)                                          | [`sevdesk_transaction_delete`](../tools.md#sevdesk_transaction_delete)                                                                                 | `commit`         | **ja**           |
| [Einen Umsatz festschreiben](#einen-umsatz-festschreiben)                              | [`sevdesk_transaction_enshrine`](../tools.md#sevdesk_transaction_enshrine)                                                                             | `commit`         | **ja**           |

Der Prompt [`bank_reconciliation`](../tools.md#bank_reconciliation) führt durch die Schritte des
Zuordnens, mit einem Probelauf vor jeder Änderung.

## Welches Konto was annimmt

> Welche Zahlungskonten habe ich, und was liegt darauf?

[`sevdesk_bank_accounts_list`](../tools.md#sevdesk_bank_accounts_list) listet jedes Konto mit
seinem Saldo; [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position) ergänzt die Summen je
Währung. Woher die Umsätze eines Kontos kommen, hängt von seiner Art ab:

| Konto                                            | Seine Umsätze kommen aus                                            | Von Hand erfassen                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Bankkonto mit Anbindung an eine Bank oder PayPal | der Bank: sevDesk importiert sie                                    | nein                                                                             |
| Dateiimport-Konto (`fileImport: true`)           | CSV-Dateien, die du importierst, oder von Hand erfasst              | ja, `sevdesk_transaction_create`                                                 |
| Verrechnungskonto                                | Zahlungen, die auf Dokumenten gebucht werden: sevDesk legt sie an   | nein: die Zahlung auf dem Dokument buchen                                        |
| Kasse                                            | Zahlungen, die auf Dokumenten gebucht werden: sevDesk trägt sie ein | nein: [auf dem Dokument buchen](#einen-barverkauf-oder-eine-barausgabe-erfassen) |

[`sevdesk_bank_account_create`](../tools.md#sevdesk_bank_account_create) (`write`) legt ein
Dateiimport- oder ein Verrechnungskonto an. Eine Kasse richtest du in der sevDesk-Weboberfläche
ein; über die API lässt sie sich nicht anlegen.

## Einen Barverkauf oder eine Barausgabe erfassen

> Ich habe heute Ware für 23,80 EUR bar verkauft. Der Einnahmebeleg ist 2101.

Auf einer Kasse nimmt sevDesk keine von Hand erfassten Umsätze an. Ein Barverkauf oder eine
Barausgabe ist eine Zahlung, die auf dem Dokument gegen die Kasse gebucht wird:

1. Erfasse die Quittung als Beleg (Einnahme oder Ausgabe) und stelle ihn fertig, wie in der
   [Anleitung Belege](receipts.de.md); bei einem Verkauf mit Rechnung nimm die Rechnung.
2. Buche die Zahlung mit [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment)
   (oder [`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment)), mit der Kasse
   als `checkAccountId` und ohne `transactionId`.

sevDesk trägt den Eintrag dann selbst ins Kassenbuch ein, mit dem Vorzeichen aus der Richtung des
Dokuments, und der Kassenbestand ändert sich: Auf dem Testkonto ging er nach einem Barverkauf über
23,80 und einer Barausgabe über 11,90 von 500,00 auf 511,90.
[`sevdesk_cash_position`](../tools.md#sevdesk_cash_position) zeigt den neuen Bestand.

Um eine Barzahlung rückgängig zu machen, setze das Dokument auf offen zurück
([`sevdesk_voucher_reset`](../tools.md#sevdesk_voucher_reset)). Auf einer Kasse wird der Eintrag
dabei nicht gelöscht: sevDesk bucht eine Gegenbuchung mit dem umgekehrten Betrag und dem Datum des
Zurücksetzens, sodass das Kassenbuch beide Einträge zeigt und der Bestand wieder der alte ist. Die
Vorschauen sagen das.

## Einen Umsatz von Hand erfassen

> Trag die Überweisung von gestern über 119,00 EUR von der Musterfirma GmbH mit dem
> Verwendungszweck RE-1001 auf meinem Importkonto ein und ordne sie der Rechnung RE-1001 zu.

[`sevdesk_transaction_create`](../tools.md#sevdesk_transaction_create) (`commit`) trägt einen
Umsatz auf einem Dateiimport-Konto ein: das Datum (Standard heute), den Betrag mit seiner Richtung
(`in` oder `out`), den Auftraggeber oder Empfänger und den Verwendungszweck. Mit `allocations`
ordnet es den neuen Umsatz in derselben Bestätigung Dokumenten zu, mit denselben Prüfungen wie
[`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book).

- Jedes andere Konto wird abgelehnt, bevor etwas gesendet wird, mit dem, was stattdessen zu tun
  ist: Auf einer Kasse oder einem Verrechnungskonto die Zahlung auf dem Dokument buchen; ein Konto
  mit Bankanbindung bekommt seine Umsätze von der Bank.
- Die Vorschau nennt Umsätze desselben Kontos und Tages mit demselben Betrag und Verwendungszweck,
  damit ein Umsatz nicht versehentlich doppelt erfasst wird.
- Scheitert die Zuordnung, nachdem der Umsatz angelegt wurde, nennt das Ergebnis den neuen Umsatz
  (und jedes vorher gebuchte Dokument); ordne den Rest mit `sevdesk_transaction_book` zu, statt
  das Werkzeug erneut aufzurufen.

## Umsätze zuordnen

> Welche offenen Rechnungen könnten die Umsätze der letzten Woche bezahlen?

[`sevdesk_reconcile_suggest`](../tools.md#sevdesk_reconcile_suggest) (`read`) ordnet Treffer nach
Betrag, Rechnungsnummer im Verwendungszweck, Gegenpartei und Aufteilungen.
[`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book) (`commit`) ordnet einen Umsatz
einem oder mehreren Dokumenten zu.
[`sevdesk_transaction_mark_private`](../tools.md#sevdesk_transaction_mark_private) markiert ihn als
Privatentnahme oder Privateinlage, und
[`sevdesk_transaction_reset`](../tools.md#sevdesk_transaction_reset) macht beides rückgängig.
[`sevdesk_transaction_get`](../tools.md#sevdesk_transaction_get) zeigt, wem ein Umsatz zugeordnet
ist und was noch offen ist.

## Einen Umsatz löschen

> Lösch den Umsatz 5401, den habe ich doppelt erfasst.

[`sevdesk_transaction_delete`](../tools.md#sevdesk_transaction_delete) (`commit`) löscht einen
ungebuchten Umsatz (Status 100) eines Dateiimport-Kontos. Ein gebuchter Umsatz braucht vorher
`sevdesk_transaction_reset`, ein privater ebenso. Ein Eintrag einer Kasse oder eines
Verrechnungskontos stammt aus einer Zahlung: Mach stattdessen die Zahlung rückgängig, indem du das
Dokument zurücksetzt.

sevDesk markiert einen gelöschten Umsatz nur: Er verschwindet aus den Umsatzlisten und aus dem
Saldo, bleibt aber über seine ID lesbar.
[`sevdesk_transaction_get`](../tools.md#sevdesk_transaction_get) meldet ihn dann als gelöscht
(`deleted: true`), und kein Werkzeug ordnet ihn mehr zu, ändert ihn oder schreibt ihn fest. Das
Löschen lässt sich nicht rückgängig machen: Wird der Umsatz doch gebraucht, erfasse ihn neu.

## Einen Umsatz festschreiben

> Schreib den Umsatz 5101 fest.

[`sevdesk_transaction_enshrine`](../tools.md#sevdesk_transaction_enshrine) (`commit`) sperrt einen
verknüpften oder gebuchten Umsatz (Status 200 oder höher) dauerhaft (festschreiben, GoBD). Das
lässt sich nicht rückgängig machen: sevDesk lehnt danach jede Änderung am Umsatz ab (kein
Statuswechsel, kein Löschen, kein Zurücksetzen), und die Dokumente, die er bezahlt, lassen sich
nicht mehr auf offen zurücksetzen; ihre Zahlung bleibt bestehen. Die Dokumente selbst werden
dadurch nicht festgeschrieben, das tun ihre eigenen Werkzeuge. Trifft ein Zurücksetzen auf eine
festgeschriebene Zahlung, sagen die Werkzeuge das in eigenen Worten.

## Grenzen

- Konten mit Bankanbindung ließen sich nicht testen (ein Testkonto hat keine): Umsätze dort von
  Hand zu erfassen oder zu löschen wird abgelehnt.
- Konten umbenennen und archivieren sowie die Regeln, die wiederkehrende private Umsätze markieren,
  sind noch nicht abgedeckt.

<!-- translated-from: docs/guides/banking.md sha256:2074c304a84e -->

# Bank und Kasse

Diese Anleitung behandelt das Geld auf deinen Zahlungskonten: welches Konto was annimmt, ein Konto
umbenennen und archivieren, einen Barverkauf oder eine Barausgabe in der Kasse erfassen, einen Kontoumsatz von Hand eintragen, Umsätze
Dokumenten zuordnen, einen Umsatz löschen oder festschreiben und die Regeln, die Umsätze als privat
markieren. Zu jedem Schritt steht, was du fragst, das Werkzeug, die
[Stufe](../permissions.de.md#stufen) und ob du bestätigst.

## Überblick

| Schritt                                                                                | Werkzeug                                                                                                                                                                                           | Stufe            | Bestätigung      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| [Konten und Bestände ansehen](#welches-konto-was-annimmt)                              | [`sevdesk_bank_accounts_list`](../tools.md#sevdesk_bank_accounts_list), [`sevdesk_cash_position`](../tools.md#sevdesk_cash_position)                                                               | `read`           | nein             |
| [Ein Konto anlegen](#welches-konto-was-annimmt)                                        | [`sevdesk_bank_account_create`](../tools.md#sevdesk_bank_account_create)                                                                                                                           | `write`          | nein             |
| [Ein Konto umbenennen oder archivieren](#ein-konto-umbenennen-oder-archivieren)        | [`sevdesk_bank_account_update`](../tools.md#sevdesk_bank_account_update), [`sevdesk_bank_account_archive`](../tools.md#sevdesk_bank_account_archive)                                               | `commit`         | **ja**           |
| [Barverkauf oder Barausgabe erfassen](#einen-barverkauf-oder-eine-barausgabe-erfassen) | [`sevdesk_voucher_book_payment`](../tools.md#sevdesk_voucher_book_payment), [`sevdesk_invoice_book_payment`](../tools.md#sevdesk_invoice_book_payment)                                             | `commit`         | **ja**           |
| [Einen Umsatz von Hand erfassen](#einen-umsatz-von-hand-erfassen)                      | [`sevdesk_transaction_create`](../tools.md#sevdesk_transaction_create)                                                                                                                             | `commit`         | **ja**           |
| [Umsätze Dokumenten zuordnen](#umsätze-zuordnen)                                       | [`sevdesk_reconcile_suggest`](../tools.md#sevdesk_reconcile_suggest), [`sevdesk_transaction_book`](../tools.md#sevdesk_transaction_book)                                                           | `read`, `commit` | Zuordnen: **ja** |
| [Einen Umsatz löschen](#einen-umsatz-löschen)                                          | [`sevdesk_transaction_delete`](../tools.md#sevdesk_transaction_delete)                                                                                                                             | `commit`         | **ja**           |
| [Einen Umsatz festschreiben](#einen-umsatz-festschreiben)                              | [`sevdesk_transaction_enshrine`](../tools.md#sevdesk_transaction_enshrine)                                                                                                                         | `commit`         | **ja**           |
| [Regeln für private Umsätze ansehen](#regeln-für-private-umsätze)                      | [`sevdesk_private_transaction_rules_list`](../tools.md#sevdesk_private_transaction_rules_list)                                                                                                     | `read`           | nein             |
| [Eine Regel anlegen oder löschen](#regeln-für-private-umsätze)                         | [`sevdesk_private_transaction_rule_create`](../tools.md#sevdesk_private_transaction_rule_create), [`sevdesk_private_transaction_rule_delete`](../tools.md#sevdesk_private_transaction_rule_delete) | `commit`         | **ja**           |

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

## Ein Konto umbenennen oder archivieren

> Benenne Konto 4004 in „Sparkasse Import“ um und archiviere dann das alte Verrechnungskonto 4006.

[`sevdesk_bank_account_update`](../tools.md#sevdesk_bank_account_update) (`commit`) benennt ein
Dateiimport-Konto, ein Verrechnungskonto oder eine Kasse um. Bei einem Dateiimport-Konto ändert es
auch das Buchungskonto, IBAN und BIC und ob sevDesk importierte Umsätze selbst Dokumenten zuordnet.
Gib nur an, was sich ändert. Die Vorschau zeigt jede Änderung als „bisher → neu“ neben dem
Konto, wie es gespeichert ist. Eine IBAN zeigt nur ihre letzten vier Zeichen, dort und im
Audit-Log: Notiere dir die alte, bevor du sie ersetzt. sevDesk meldet eine Änderung auch für Felder als erfolgreich, die es
übergeht; das Werkzeug liest das Konto deshalb zurück und schlägt fehl, wenn ein Feld nicht
gespeichert wurde. Es lehnt einen Namen oder ein Buchungskonto ab, das ein anderes Konto hat, und
ein neues Buchungskonto auf einem Konto mit gebuchten Umsätzen (was sevDesk dann mit deren
Buchungen macht, ist nicht aufgezeichnet): Frag vor einer solchen Änderung deine Steuerberatung.

[`sevdesk_bank_account_archive`](../tools.md#sevdesk_bank_account_archive) (`commit`, unumkehrbar)
archiviert ein Dateiimport- oder Verrechnungskonto; die API von sevDesk nennt das Löschen. Das
Konto verschwindet aus den Kontolisten, bleibt aber über seine ID lesbar, seine offenen Umsätze
werden mitgelöscht (die Vorschau führt sie auf), und sevDesk entfernt seine IBAN. Über die API
lässt sich ein archiviertes Konto nicht wiederherstellen. Ein Konto mit gebuchten Umsätzen
archiviert sevDesk nicht, und das Werkzeug lehnt es schon ab, bevor etwas gesendet wird: Heb die
Buchungen zuerst auf ([`sevdesk_transaction_reset`](../tools.md#sevdesk_transaction_reset); ein
festgeschriebener Umsatz lässt sich nicht aufheben), oder behalte das Konto. Kassen, das
Standardkonto und Konten mit Bankanbindung archiviert der Server nicht.

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

## Regeln für private Umsätze

> Markiere die Zahlungen an meinen Vermieter ab jetzt als privat.

sevDesk kann Kontoumsätze selbst als privat markieren (Privatentnahme, Privateinlage), nach einer
Regel: einem Text, zu dem der Auftraggeber/Empfänger oder der Verwendungszweck eines Umsatzes
passt.
[`sevdesk_private_transaction_rules_list`](../tools.md#sevdesk_private_transaction_rules_list)
(`read`) listet die Regeln mit ihren Texten.
[`sevdesk_private_transaction_rule_create`](../tools.md#sevdesk_private_transaction_rule_create)
(`commit`) legt eine Regel mit einem Text an, `counterparty` oder `purpose`, und
[`sevdesk_private_transaction_rule_delete`](../tools.md#sevdesk_private_transaction_rule_delete)
(`commit`) löscht eine. Beide sind `commit`, weil eine Regel von selbst tun soll, was
[`sevdesk_transaction_mark_private`](../tools.md#sevdesk_transaction_mark_private) von Hand tut.

**Wo Regeln wirken, und was sich nicht testen ließ.** sevDesk soll eine Regel anwenden, wenn es
Umsätze von der Bank importiert. Ein Testkonto importiert nichts: Dort änderten zwei Regeln keinen
der vorhandenen offenen Umsätze, auch keinen, der nach den Regeln von Hand erfasst wurde, und das
Löschen der Regeln änderte ebenfalls nichts. Wie sevDesk eine Regel abgleicht (ganzer Text oder ein
Teil davon, Groß- und Kleinschreibung) und ob auch ein CSV-Dateiimport Regeln anwendet, ist daher
nicht bekannt.

**Die Schätzung in der Vorschau.** Die Vorschau beim Anlegen nennt offene Umsätze, die vermutlich
gemeint sind: bis zu zehn von höchstens 500 offenen (ungebuchten) Umsätzen, den neuesten nach
Wertstellung, deren Auftraggeber/Empfänger oder Verwendungszweck den Text enthält, ohne Rücksicht
auf Groß- und Kleinschreibung. Das ist eine eigene Schätzung des Servers und als solche gekennzeichnet, nicht
sevDesks Abgleich, und das Anlegen der Regel ändert keinen dieser Umsätze. Um einen davon jetzt als
privat zu markieren, nimm `sevdesk_transaction_mark_private`.

Das Werkzeug zum Anlegen lehnt ab, bevor etwas gesendet wird:

- eine Regel mit beiden Texten: Ob sevDesk dann beide Texte oder nur einen verlangt, wurde nicht
  getestet. Lege eine Regel je Text an, wenn jeder davon einen Umsatz privat machen soll;
- einen Text mit weniger als vier Buchstaben oder Ziffern: Ein kurzer Text wie „AG“ oder „dm“ kommt
  in sehr vielen fremden Auftraggebern und Verwendungszwecken vor, und sevDesk soll jeden Import,
  zu dem eine Regel passt, als privat markieren;
- einen Text, den eine vorhandene Regel schon hat (ohne Rücksicht auf Groß- und Kleinschreibung und
  zusätzliche Leerzeichen); die Ablehnung nennt diese Regel.

Das Löschen einer Regel lässt Umsätze, die schon privat sind, wie sie sind;
[`sevdesk_transaction_reset`](../tools.md#sevdesk_transaction_reset) setzt einen davon zurück. Eine
Regel lässt sich nicht ändern: Lösche sie und lege eine neue an. Eine Kapitalgesellschaft (GmbH,
UG, AG) kennt keine Privatentnahmen oder Privateinlagen, eine solche Regel gehört also nicht in
ihre Buchhaltung.

## Grenzen

- Konten mit Bankanbindung ließen sich nicht testen (ein Testkonto hat keine): Umsätze dort von
  Hand zu erfassen oder zu löschen sowie die Konten selbst zu ändern oder zu archivieren wird
  abgelehnt.
- Regeln für private Umsätze ließen sich dort, wo sie wirken, beim Bankimport, nicht testen (siehe
  [oben](#regeln-für-private-umsätze)).
- Welches Konto das Standardkonto ist, ändert der Server nicht, und ein archiviertes Konto lässt
  sich weder ändern noch wiederherstellen.

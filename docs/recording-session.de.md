<!-- translated-from: docs/recording-session.md sha256:8b5a29d01ede -->

# Runbook für die Aufnahmesitzung

sevDesk hat keine Testumgebung und kein eigenes Testkonto für Entwickler: Jeder Schreibvorgang ist
echt, und fertiggestellte Dokumente lassen sich nicht löschen. Dieses Projekt prüft seine Annahmen
über die API deshalb in **einer Aufnahmesitzung auf einem kostenlosen 14-tägigen Testkonto**, mit
drei Werkzeugen. Diese Seite ist das Runbook des Maintainers dafür.

| Befehl                 | Was er tut                                                                                                                                   | Schreibt?                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm probe`           | Stellt sevDesk die offenen Fragen aus `spec/deviations.md` und schreibt einen Markdown-Bericht mit bereinigten Nachweisen.                   | Nur mit `--allow-writes` (markierte Daten)              |
| `pnpm fixtures:record` | Zeichnet bereinigte Leseantworten als Test-Fixtures in `test/fixtures/recorded/<date>/` auf.                                                 | Nie                                                     |
| `pnpm test:live`       | Ruft jedes Lese-Werkzeug über den echten Server auf und prüft die Ausgabe; führt auf Wunsch den Schreib-Lebenszyklus über die Werkzeuge aus. | Nur mit den beiden Lebenszyklus-Flags (markierte Daten) |

> [!CAUTION]
> **Richte nichts davon je auf ein Produktivkonto.** Die lesenden Teile sind überall harmlos, aber
> die schreibenden Teile legen echte Dokumente an, stellen sie fertig, bezahlen und stornieren sie.

## Eingebaute Schutzmaßnahmen

- Die Werkzeuge lesen nur diese Variablen: `SEVDESK_API_TOKEN` (oder `SEVDESK_API_TOKEN_FILE`),
  `SEVDESK_BASE_URL`, `SEVDESK_RATE_LIMIT`, `SEVDESK_TIMEOUT_MS`. Stufenschalter in deiner Shell
  (`SEVDESK_ALLOW`, `SEVDESK_CONFIRM`, `SEVDESK_READ_ONLY`, …) werden ignoriert.
- Lesende Läufe erzwingen `SEVDESK_READ_ONLY=1`: Der HTTP-Client lehnt jede Anfrage, die Daten
  ändert, ab, bevor sie gesendet wird. PDFs werden immer mit `preventSendBy=true` abgerufen.
- Schreibende Läufe brauchen ein ausdrückliches Flag **und** `SEVDESK_LIVE_I_UNDERSTAND_WRITES=1`,
  geben eine Warnung aus und lehnen ein Konto ab, das schon mehr als 60 Rechnungen plus Kontakte
  enthält, die sie nicht selbst angelegt haben (`SEVDESK_LIVE_MAX_EXISTING_RECORDS` ändert die
  Grenze). Sie schalten die Stufen `write` und `commit` frei. Die Stufe `external` (E-Mail) wird
  nur freigeschaltet, wenn du eine eigene Adresse übergibst (`pnpm probe --probe-email`,
  `SEVDESK_LIVE_EMAIL_TO` für `test:live`), und dann geht genau eine E-Mail an diese Adresse, nie an
  einen Kontakt. Keine Anfrage zum Festschreiben wird gesendet, mit einer Ausnahme: Die
  Opt-in-Probe `write-transaction-enshrine` schreibt einen markierten Kontoumsatz fest, den sie
  selbst angelegt hat (unumkehrbar, nur auf dem Testkonto). Exporte: der DATEV-CSV-Job der
  M4-Probe und des M4-Szenarios (er startet einen Job; nie mit `enshrineDocuments`), die Rechnungs-
  und Beleg-ZIPs der Lückenproben (sie ändern kein Dokument, D-101) und der DATEV-XML-Job der
  Opt-in-Probe `write-export-datev-xml`. Die Opt-in-Probe `write-voucher-from-file` schickt einen
  erzeugten Beleg an `createVoucherFromFile`; der Entwurfsbeleg, den das anlegt, bleibt auf dem
  Konto. Die übrigen Lückenproben hinterlassen Datensätze, die sich nicht löschen lassen: Angebote
  und Auftragsbestätigungen, die als versendet markiert sind, und zwei fertiggestellte Rechnungen,
  eine für `createFromInvoice` und eine für den Rechnungs-ZIP-Export (das Testkonto schreibt
  Rechnungen beim Fertigstellen fest, D-023, D-059). Zwei von ihnen hinterlassen Vorlagen für
  Abo-Rechnungen, die du in der Web-App löschst. Drei weitere sind opt-in, weil sie etwas
  hinterlassen: `write-cash-register-transaction` (ihre Kassenbuchungen und die Gegenbuchungen
  ihrer Zurücksetzungen bleiben im Kassenbuch, D-095),
  `write-reserved-number-delete-draft` (reserviert eine Angebots- und eine Gutschriftsnummer;
  sevDesk hat sie wieder vergeben, nachdem die Entwürfe gelöscht waren, D-066) und
  `write-recurring-template-due` (hinterlässt mit Absicht EINE AKTIVE Vorlage für Abo-Rechnungen;
  beende und lösche sie nach `read-recurring-generated`).
- Alles Geschriebene trägt einen Lauf-Tag wie `MCP-E2E 20261120-1432-k3f9` im Namen und steht in
  einer Aufräumliste (am Ende des Probe-Berichts, am Ende des `test:live`-Logs).
- Aufzeichnungen und Berichte werden bereinigt (`scripts/lib/scrub.ts`): Namen, E-Mail-Adressen,
  Telefonnummern, IBAN/BIC, USt-IdNr. und Steuernummern, Adressen, Freitexte, Verwendungszwecke,
  Dateinamen, URLs, Belegnummern und die Konto-ID werden durch offensichtliche Fälschungen ersetzt;
  das Token wird schon beim Schreiben abgelehnt.

## 1. Das Testkonto anlegen (etwa 10 Minuten)

1. Melde dich auf sevdesk.de für die kostenlose 14-tägige Testphase an, mit einem E-Mail-Alias, den
   du für nichts anderes nutzt. Die Testphase enthält die API (Funktionen von Buchhaltung Pro).
2. Verwende erfundene Firmendaten (Musterfirma GmbH, Musterstraße 1, 10115 Berlin). Gib keine
   echten Kunden, keine echten Bankkonten und keine echten Belege ein: Was immer das Konto enthält,
   kann in einer Aufzeichnung landen, bereinigt oder nicht.
3. Prüfe in den Einstellungen die Version des Buchhaltungssystems: Ein neues Konto sollte auf
   **Update 2.0** sein (der Probe-Bericht nennt sie auch).
4. **Stelle das Konto auf Regelbesteuerung um** (nötig für alles nach dem Fertigstellen):
   Einstellungen → Unternehmen → „Buchhaltung & Steuern“ → Umsatzsteuer **„Standard 19%“**. Das
   Testkonto vom 2026-11-07 begann als Kleinunternehmer: Entwürfe mit Steuerregel 1 wurden
   gespeichert, aber jedes `sendBy` scheiterte mit 422 „Tax rule 'USTPFL_UMS_EINN' is not valid for
   account '4400' with taxation scope 'SMALL_BUSINESS'“ (D-067), deshalb lieferten die Proben für
   Zahlung, Storno, Mahnung und Gutschrift alle „inconclusive“. `GET /SevClient` zeigt die
   Einstellung als `smallSettlement` (`"1"` = Kleinunternehmer).
5. **Bestätige die E-Mail-Adresse des Kontos in sevDesk**, bevor du eine E-Mail-Probe startest:
   Solange sie nicht bestätigt ist, antwortet `sendViaEmail` mit 400 „Confirm your email address to
   send mails.“ (D-069).
6. Lege eine Kasse oder ein Offline-Bankkonto an: **nötig** für die Zahlungsproben und das
   Lebenszyklus-Szenario. Gib der Kasse einen **positiven Anfangsbestand** (ein Kasseneintrag
   reicht): Die Auszahlung einer Gutschrift nimmt Geld aus ihr heraus.
7. Optional, damit mehr Leseproben eine Antwort geben statt „inconclusive“: ein Personenkontakt
   (nicht nur Organisationen); zwei oder drei Kasseneinträge oder eine kleine CSV mit Kontoumsätzen
   mit unterschiedlichem Wertstellungs- und Buchungsdatum; ein erfundener Beleg; eine Rechnung, die
   als E-Rechnung markiert und fertiggestellt ist, für die Form von `getXml`.

## 2. Ein API-Token anlegen (etwa 5 Minuten)

1. Wenn die Testphase weitere Benutzer erlaubt, lege einen eigenen Benutzer an (z. B. „MCP API“)
   und nimm dessen Token, damit sich das Token widerrufen lässt, ohne deine Anmeldung anzufassen.
   Sonst nimm das Token des Inhabers.
2. In der Web-App: Einstellungen → Benutzer → der Benutzer → API-Token. sevDesk-Tokens laufen nie
   ab und haben keine Scopes: Behandle es wie ein Passwort.
3. Speichere es in einer Datei, die nur du lesen kannst, außerhalb des Repositorys, nie in
   `.env`-Dateien dieses Repositorys, in der Shell-Historie, in Issues oder im Chat:

   ```bash
   umask 077 && pbpaste > ~/.config/sevdesk-trial.token   # oder mit einem Editor einfügen
   export SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token
   ```

## 3. Die Sitzung durchführen (etwa 20 Minuten)

Führe alles aus der Wurzel des Repositorys aus, nach `pnpm install`. Jeder Schritt dauert ein paar
Minuten, beim Tempo des Clients von etwa 4 Anfragen pro Sekunde. Hinter einem filternden
HTTP-Proxy ergänze `NODE_USE_ENV_PROXY=1` bei jedem Befehl: Ohne das ignoriert Nodes `fetch` die
Variable `HTTPS_PROXY`.

```bash
# 3.1 Jede Probe ansehen und was nie geprüft wird (kein Token nötig, nichts wird gesendet).
pnpm probe --list

# 3.2 Lesende Proben: harmlos, führe sie zuerst aus.
pnpm probe --out probe-report-read-only.md

# 3.3 Schreibende Proben: markierte Entwürfe anlegen, einige davon fertigstellen/bezahlen/stornieren,
#     dann die Leseproben erneut ausführen.
#     --probe-email (optional) schickt außerdem EINE Rechnungs-E-Mail an die Login-Adresse des
#     Kontos, um die Antwort von sendViaEmail festzuhalten; ohne das wird nichts gemailt.
SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm probe --allow-writes --probe-email login@example.org \
  --out probe-report.md

# 3.4 Optional: ein Schwall von 40 Anfragen, um zu sehen, ob sevDesk die Rate begrenzt (D-022).
pnpm probe --only read-rate-limit-burst --out probe-report-rate-limit.md

# 3.5 Fixtures: erst der Plan, dann die Aufzeichnung (nur lesend; PDFs nur von fertiggestellten
#     Dokumenten).
pnpm fixtures:record --dry-run
pnpm fixtures:record            # schreibt test/fixtures/recorded/<date>/…

# 3.6 Live-Prüfungen jedes Lese-Werkzeugs über den echten Server, nur lesend.
pnpm test:live

# 3.7 Lebenszyklus über die Schreib-Werkzeuge (Kontakt → Entwurf → PDF-Vorschau bleibt Entwurf →
#     fertigstellen → Teil- und Vollzahlung → Mahnung → Storno → Gutschrift). Ergänze
#     SEVDESK_LIVE_EMAIL_TO=login@example.org, um die bezahlte Rechnung auch an dich zu mailen.
SEVDESK_LIVE_LIFECYCLE=1 SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm test:live
```

Hinweise:

- Schritt 3.3 führt zuerst die schreibenden Proben aus und dann jede Leseprobe erneut, damit die
  Leseproben die Dokumente finden, die die schreibenden Proben angelegt haben (zum Beispiel, dass
  jede Stornorechnung auf ihr Original verweist). Jede schreibende Probe legt ihre eigenen Daten an;
  eine fehlschlagende Probe hält die anderen nicht auf (sie wird als `error` gemeldet).
  `pnpm probe --list` zeigt die Frage jeder Probe.
- Die schreibenden Proben decken ab: Nummerierung von Entwürfen (B4/D-027: was sevDesk mit
  Dokumenten macht, die ohne Nummer gespeichert werden; die Schreib-Werkzeuge selbst lassen nur
  Rechnungen ohne Nummer und reservieren die nächste Auftrags- und Gutschriftsnummer, D-066) und
  `getNextOrderNumber`; getPdf-Vorschauen von 2.0-Entwürfen (B1); Preisfelder der Positionen je
  `showNet` (B8); Aktualisierungen über `save*` mit einer ID und ausgelassenen Feldern; die Adresse
  von Entwürfen, die über die API angelegt wurden; Gutschriften ohne `deliveryDate`; Zahlungen
  (Antwort, Datumsformate, der Kalendertag eines Berliner Datums um 12:00 Uhr, Vorzeichen der
  Auszahlung einer Gutschrift, Buchungen auf einer Kasse und `resetToOpen`, Zahlungen auf eine
  Mahnung, Fremdwährung); Storno; Gutschriften aus Rechnungen; Mahnungen (Query oder Body);
  Rechnungen aus Aufträgen (RE oder ER bei einer Vollrechnung); `DELETE` eines Entwurfs; Artikel
  (`price` oder netto/brutto); Kontakte (vergebene Kundennummer, teilweises `PUT`, unbekannte
  Felder); die Antwort von `sendViaEmail` (nur mit `--probe-email`).
- Schritt 3.7 steuert die M3-Schreib-Werkzeuge mit den Argumenten in `ARGS` oben in
  `test/live/lifecycle.test.ts`. Wenn sich die Argumente eines Werkzeugs ändern, passe sie dort an.
- `Refusing to write: the account already holds …` bedeutet, dass das Konto nicht wie ein frisches
  Testkonto aussieht. Halte an und prüfe, zu welchem Konto das Token gehört.
- E-Mail auf einem Testkonto: Nachdem die Absenderadresse bestätigt ist (Schritt 1.5), kann ein
  Testkonto nur an seine eigene Login-Adresse mailen; jeder andere Empfänger wird mit 400 „During
  the test phase, you can only send emails to your own email address.“ abgelehnt (D-069). Ein
  abgelehnter Versand ändert nichts: Führe die Probe mit `--only write-send-email-shape` erneut
  aus.
- Mit automatischer Festschreibung (wie auf dem Testkonto vom 2026-11-07) schreibt das
  Fertigstellen (`sendBy`) jede Rechnung und Gutschrift fest: Sie lassen sich nur noch stornieren
  oder in Ruhe lassen, nicht zurücksetzen oder löschen. Zahlungen und `resetToOpen` funktionieren
  auf ihnen weiterhin (D-059, D-060).
- Die Sitzung vom 2026-11-07 brauchte drei Schreibläufe: einen auf dem Kleinunternehmer-Konto,
  einen nach der Umstellung auf Regelbesteuerung und erneute E-Mail-Läufe nach der Bestätigung der
  Absenderadresse. Wer die Schritte 1.4 und 1.5 zuerst erledigt, spart die zusätzlichen Läufe.

## 3a. M4: Belege, Zuordnung, Exporte, E-Rechnungen (etwa 30 Minuten)

Die M4-Proben und das M4-Lebenszyklus-Szenario decken Belege, Kontoumsätze, den DATEV-Export und
E-Rechnungen ab. Sie brauchen vorher Firmendaten und eine DATEV-Konfiguration; Vorbereitung,
Läufe, was sie anlegen und was du committest, stehen auf einer eigenen Seite:
[M4-Läufe](recording-session/m4.de.md). Die Lückenproben vom 2026-11-16 laufen von derselben Seite
aus: [Banking, Exporte und Belegerkennung](recording-session/m4.de.md#lückenproben-banking-exporte-belegerkennung)
(Kassen und Verrechnungskonten, Kontoumsätze löschen und festschreiben, Regeln für private Umsätze,
Hashes von Belegdateien, ZIP-Exporte, der DATEV-XML-Job),
[Kontakte, Tags und Kostenstellen](recording-session/m4.de.md#lückenproben-kontakte-tags-und-kostenstellen)
und
[Aufträge, Entwürfe, Abo-Rechnungen und Layouts](recording-session/m4.de.md#lückenproben-aufträge-entwürfe-abo-rechnungen-und-layouts).

## 3b. M5: Prüfung des Fernzugriffs (etwa 60 bis 90 Minuten)

Der Fernzugriff wird einmal von Hand gegen dasselbe Testkonto geprüft: das Image, ein Tunnel, ein
Connector in claude.ai und Claude Code über HTTP. Die Schritte stehen auf einer eigenen Seite:
[M5: Prüfung des Fernzugriffs](recording-session/remote-check.de.md).

## 4. Prüfen, bevor etwas geteilt wird (etwa 15 Minuten)

1. Lies das Ende der Ausgabe von `fixtures:record`: Die Zeile, die mit `Review: text under these
keys` beginnt, listet Schlüssel, die der Bereiniger nicht kannte. Prüfe, dass nichts Nützliches
   verloren ging und nichts Persönliches blieb.
2. Durchsuche die Aufzeichnungen und Berichte nach allem, was von dir stammt (Name, E-Mail-Domain,
   Firma, Straße, IBAN, Telefon):

   ```bash
   rg -n -i 'yourname|yourcompany|@yourdomain|DE\d{2} ?\d{4}' test/fixtures/recorded probe-report*.md
   ```

3. Öffne ein paar Fixtures: Schlüssel, `null`-Werte und String-Skalare (`"100"`, `"0"`/`"1"`)
   müssen genau so aussehen, wie sevDesk sie sendet; Namen sollten `Musterfirma 1 GmbH` lauten,
   E-Mail-Adressen `person1@example.com`, PDF-Inhalt ein winziges falsches PDF, XML nur sein
   Wurzelelement.
4. Überfliege den Probe-Bericht: Jedes Ergebnis `contradicted` und `error` braucht eine Nacharbeit
   in `spec/deviations.md` (der Abschnitt „By deviation entry“ gruppiert die Befunde je Eintrag).

## 5. Was du committest, und was nie

Committe nach der Prüfung in einem PR: `test/fixtures/recorded/<date>/**` (der Recorder weigert
sich, vorhandene Dateien zu überschreiben; `--force` ersetzt die Dateien einer Sitzung); die
Änderungen an `spec/deviations.md`, Tests und Code, die die Befunde verlangen; und die Befunde
selbst in der PR-Beschreibung (oder den bereinigten Bericht als Anhang am PR).

Committe nie das Token, eine Token-Datei, `.env`-Dateien oder Auszüge aus der Shell-Historie;
unbereinigte Antworten (`test/fixtures/_raw/` ist deshalb von Git ignoriert), rohe PDFs oder XML
aus dem Konto, Screenshots des Testkontos; oder die Konto-IDs der Aufräumliste neben
personenbezogenen Daten.

Aufgezeichnete Fixtures ersetzen die committeten Community- und Spezifikations-Fixtures nicht
automatisch: Jede aufgezeichnete Datei nennt in ihrer `_provenance.note`, welche committete Fixture
sie spiegelt, und eine davon zu ersetzen ist eine normale Code-Änderung mit ihren Tests. Jede
aufgezeichnete Datei muss in einem Vertragstest durch ihren Produktiv-Parser laufen
(`test/contract/recorded-fixtures.test.ts` für die Sitzung vom 2026-11-07; er schlägt fehl, wenn
eine aufgezeichnete Datei keinen Vertrag hat); eine aufgezeichnete Form, die ein Parser ablehnt, ist
ein Vertragsbruch, der im Parser behoben wird, bis dahin mit `it.fails` festgehalten. Befunde kommen
nach `spec/deviations.md` mit der Quelle „recorded <date>, trial account, Update 2.0 (probe
`<id>`)“.

## 6. Optional: die Umgebung `live` für den CI-Workflow

`.github/workflows/live-e2e.yml` führt `pnpm test:live` von Hand aus (Actions → Live E2E → Run
workflow; hake `lifecycle` für das Schreibszenario an). Ohne gesetztes Token überspringt er mit
einem Hinweis. So nutzt du ihn während der Testphase:

1. Repository-Einstellungen → Environments → New environment `live`: Pflicht-Reviewer (du),
   Deployment-Branches nur `main`.
2. Lege das Environment-Secret `SEVDESK_API_TOKEN` an (das Token des Testkontos).
3. Entferne das Secret, wenn die Testphase endet.

## 7. Das Testkonto beenden (etwa 5 Minuten)

1. Widerrufe das API-Token in der Web-App (oder lösche den eigenen API-Benutzer).
2. Lösche das Secret `SEVDESK_API_TOKEN` der Umgebung `live` und die lokale Token-Datei
   (`rm ~/.config/sevdesk-trial.token`).
3. Lass die Testphase auslaufen, ohne einen Tarif zu buchen, oder lösche das Konto in den
   Kontoeinstellungen der Web-App (wende dich an den sevDesk-Support, wenn die Option fehlt).
   Fertiggestellte Testdokumente lassen sich nicht einzeln löschen; sie verschwinden mit dem Konto.

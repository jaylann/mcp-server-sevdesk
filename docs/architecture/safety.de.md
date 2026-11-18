<!-- translated-from: docs/architecture/safety.md sha256:8332d696a85e -->

# Sicherheitsmodell

Wie der Server verhindert, dass das Modell mehr ändert, als der Benutzer erlaubt hat: wo die Stufen
durchgesetzt werden, wie ein Schreibvorgang abläuft und wie der Zustand je Konto getrennt bleibt.
Die Seite richtet sich an Mitwirkende und Reviewer; wie du all das konfigurierst, steht in
[Berechtigungen und Bestätigung](../permissions.de.md).

## Stufen

Jedes Werkzeug gehört zu genau einer Stufe, und Lesen und Schreiben teilen sich nie ein Werkzeug.
Was jede Stufe abdeckt, ihre Voreinstellung und die Schalter (`SEVDESK_ALLOW`,
`SEVDESK_READ_ONLY`, Probelauf) stehen unter [Berechtigungen](../permissions.de.md#stufen).

## Durchsetzung an drei Stellen

1. Registrierung: Werkzeuge oberhalb der erlaubten Stufen werden nicht registriert.
2. Dispatcher: Jeder Aufruf prüft die Stufe erneut.
3. HTTP-Client: Jede Anfrage, die Daten ändert (jede Anfrage außer GET und die GETs, die Zustand
   ändern), muss ihre Stufe angeben und wird vor dem Senden abgelehnt: im Nur-Lesen- oder
   Probelauf-Modus, wenn sie keine Stufe angibt, wenn `SEVDESK_ALLOW` diese Stufe nicht aktiviert
   oder wenn die Stufe unter der Mindeststufe des Endpunkts liegt (`minimumWriteTier` in
   `paths.ts`: `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, `resetToDraft`, `resetToOpen`,
   `changeParameter`, ein versendendes `getPdf`, DATEV-Exporte mit `enshrine`, ein `saveVoucher`,
   dessen Beleg kein Entwurf ist (das Fertigstellen des Belegs),
   `PUT`/`DELETE /CheckAccountTransaction/{id}` (als privat markieren, zurücksetzen), eine
   Banktransaktion anlegen (`POST /CheckAccountTransaction`), der Status eines Dokuments direkt
   gesetzt (ein `status` im Body oder in der Query einer Anfrage an einen einzelnen
   Dokumentdatensatz; so nimmt `PUT /Order/{id}` ein Angebot an oder lehnt es ab) oder über ein
   Speichern (ein `saveInvoice`, `saveOrder` oder `saveCreditNote`, dessen Dokument einen anderen
   Status als den Entwurfsstatus 100 hat), `createContractNoteFromOrder` (nimmt das
   Ausgangsangebot an) und eine Abo-Vorlage speichern (ein `saveInvoice`, dessen Art `WKR` ist,
   fehlt oder kein Text ist, oder ein `PUT /Invoice/{id}`, das die Art oder den Zeitplan setzt)
   brauchen `commit`; `sendViaEmail` und `sendByWithRender` brauchen `external`). Diese Regeln
   lesen den Body so, wie er gesendet wird (seinen JSON-Text), und die Query-Schlüssel mit
   denselben Namen; ein Multipart-Formular an einen Dokumentdatensatz oder an eines dieser
   Speichern zählt als bindend. Warum jede davon bindet:
   [ADR 0003](../adr/0003-tiers-and-human-confirmation.de.md).

Schreibwerkzeuge setzen die Stufe nie selbst: Ihr `execute` bekommt einen Client, der sie
einstempelt (`tierScopedClient`, der auch die Regel des Endpunkts anwendet), ihr `prepare` einen,
der jeden Schreibvorgang ablehnt (`readOnlyClient`). Der Client erkennt die GETs, die Zustand
ändern, am Endpunkt, nicht nur am `sideEffect`-Flag des Aufrufers: Ein lesendes `getPdf` geht immer
mit dem festen Wert `preventSendBy=true` hinaus (aufgezeichnet: Entwürfe bleiben Entwürfe),
während `getPdf` ohne `preventSendBy`, `sendByWithRender`, DATEV-Exporte mit einem
`enshrine`-Flag (alle `commit`/`external`, siehe
[D-023](../../spec/deviations.md#d-023-some-gets-change-state)) und die Endpunkte für die nächste
Nummer, sofern nicht `useNextNumber=false` (sie reservieren eine Dokumentnummer; `write`; das
dokumentierte `getNextCustomerNumber` bleibt ein Lesezugriff), als Schreibvorgänge zählen.

## Schreibablauf

Ein Schreibwerkzeug (`src/tools/write-flow.ts`) hat `prepare` (liest, prüft, baut eine Vorschau:
Aktion, Angaben, Warnungen, unumkehrbar) und `execute`. Ein Werkzeug der Stufe `commit` oder
`external` baut die Vorschau zweimal aus denselben Daten, auf Englisch und auf Deutsch
(`previewDe`; der Typ von `defineWriteTool` verlangt es): Das Modell, Probeläufe, das Audit-Log
und die Elicitation zeigen den englischen Text, die Freigabeseiten zeigen einem Leser, dessen
Browser Deutsch anfragt, den deutschen. Der Ablauf lehnt ein Paar ab, das sich in der Zahl der
Angaben oder Warnungen oder in `irreversible` unterscheidet, und der Hash der Vorschau umfasst
beide Texte.

Jeder Aufruf führt `prepare` aus, dann endet ein Probelauf, Aufrufe der Stufen `commit`/`external`
werden bestätigt, das Audit-Log verzeichnet `executing`, und erst dann läuft `execute`. Ergebnisse
werden als
`{status: "done" | "dry_run" | "approval_pending" | "declined", result?, preview?, approval?}`
verpackt (`result` nur bei `done`); für `outputSchema` und `structuredContent` gelten dieselben
Regeln je Protokollgeneration wie bei Lesezugriffen.

## Bestätigung durch einen Menschen

`SEVDESK_CONFIRM` legt fest, wie ein Mensch die Vorschau eines Aufrufs der Stufe `commit` oder
`external` freigibt ([Bestätigungsarten](../permissions.de.md#bestätigungsarten),
[ADR 0003](../adr/0003-tiers-and-human-confirmation.de.md)); was die Vorschau zeigt und woran eine
Freigabe gebunden ist, steht unter [Bestätigung durch einen Menschen](../security/confirmation.de.md).
Im Code verwendet `elicit` den versiegelten `requestState` des SDK; `browser` hält Freigaben in
`src/safety/approval-store.ts` und zeigt sie über stdio auf der lokalen Freigabeseite
(`src/safety/approval-local.ts`, geöffnet von `src/safety/open-url.ts`) oder über HTTP im
[Freigabe-Postfach](../remote/approvals.de.md) (`src/http/approval-routes.ts`,
[ADR 0007](../adr/0007-approval-inbox-over-http.de.md)). Der Schlüssel, die Nonces, die Freigaben
und der Schreiber des Audit-Logs leben in einer `SafetyRuntime` (`src/safety/runtime.ts`) je
Server-Factory, geteilt von jeder Instanz, die die Factory baut.

Ein Argument `confirm: true` ist nie eine Schranke, weil das Modell es selbst setzen kann.
`enshrine` warnt immer, dass es unumkehrbar ist (GoBD).

## Seiten

Jede Seite, die ein Mensch sieht (Freigabe, Postfach, Anmeldung, Zustimmung, Upload, Ergebnisse und
Fehler), baut auf `src/pages/` auf: statisches HTML ohne Skript, jeder Wert vom Template-Tag
`markup` maskiert, ein Style-Block mit einer Nonce je Antwort, Deutsch oder Englisch nach
`Accept-Language`. Die Antwort-Header kommen von `htmlResponse` (`src/safety/web.ts`): `no-store`,
keine Einbettung in Frames und die Policy
`default-src 'none'; style-src 'nonce-…'; font-src <origin>/assets/; img-src <origin>/assets/;
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. Schriften und das Icon sind in den
Build eingebettet und werden vom Server selbst unter `/assets/` ausgeliefert (unveränderlich, nach
Inhalts-Hash); nichts wird von anderen geladen
([ADR 0010](../adr/0010-server-pages-in-two-languages.de.md)).

## Trennung nach Konto

Im OAuth-Modus bedient ein Prozess mehrere Konten und Zugänge; deshalb ist alles, was Zustand hält,
nach dem Prinzipal der Anfrage geschlüsselt (Zugang und Konto, aus `requestPrincipal`):

- Der Codec der Bestätigungen bindet den Prinzipal, sodass ein `requestState`, der für ein Konto
  ausgestellt wurde, für ein anderes abgelehnt wird;
- ein erneuter Versuch nimmt nur eine Freigabe an, die sein eigener Zugang angelegt hat; das
  Postfach listet und entscheidet je Konto, und die Freigaben eines Kontos können die eines anderen
  nicht aus dem Speicher drängen;
- jedes Konto bekommt seine eigene eingefrorene `Config` und seinen eigenen sevDesk-Client, und die
  Caches der Domäne (Kontoeinstellungen, ReceiptGuidance, Buchungskonten, die Version des
  Buchhaltungssystems, Ländercodes) sind nach diesem Konfigurationsobjekt geschlüsselt, sodass
  Konten nie zwischengespeicherte Daten teilen;
- das Audit-Log verzeichnet Konto und Zugang jeder Zeile.

## Annotationen

Jedes Werkzeug gibt alle vier MCP-Annotationen (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) ausdrücklich an; ein Test erzwingt das.

## Integrität von Schreibvorgängen

Suche nach Dubletten vor dem Anlegen (Nummer, Betrag, Datum, Beschreibung). Keine Wiederholungen
für Schreibvorgänge. Zurücklesen nach jedem Schreibvorgang. Optionales JSONL-Audit-Log über
`SEVDESK_AUDIT_LOG` (`src/safety/audit.ts`; sein Format und seine Integrität stehen unter
[Audit-Log](../permissions/audit-log.de.md#integrität)). Ein Schreibvorgang aus mehreren Schritten, der
mittendrin scheitert, meldet die Datensätze, die er bereits geändert hat
(`SevdeskError.completedWrites`), im Fehlertext und im Audit-Log.

Dokumententwürfe prüfen Steuerregel × Steuersatz gegen die Referenz-Steuerregeln, bevor die API
aufgerufen wird; Buchungskonten gegen ReceiptGuidance (`src/domain/receipt-guidance.ts`):
Belegentwürfe und das Fertigstellen prüfen jede Kombination aus Buchungskonto × Steuerregel ×
Steuersatz dagegen, weil sevDesk selbst bei einem Entwurf jede Kombination annimmt. Buchungen von
Kontoumsätzen planen jede Zuordnung gegen den offenen Betrag des Dokuments und den Restbetrag des
Umsatzes (aus dem Umsatzprotokoll), bevor etwas gesendet wird.

## Datensatzsperren

Eine Prüfung mit anschließendem Schreibvorgang ist wertlos, wenn zwei Aufrufe gleichzeitig laufen:
Beide lesen den Zustand, bevor einer geschrieben hat. Deshalb gibt ein Schreibwerkzeug `locks` an:
die Datensätze, von denen seine Prüfungen abhängen (das Dokument, den Kontoumsatz, den Kontakt, den
Artikel, den Auftrag oder die Rechnung, aus der ein Dokument abgeleitet ist), oder einen
kontoweiten Schlüssel (alle Buchungen; den Nummernkreis der Gutschriften, dessen Zähler sevDesk
bei `createFromInvoice` nicht weiterzählt; Kundennummern; Artikelnummern; neue Belegentwürfe, für
ihre Ablehnung von Dubletten). Aufrufe eines Kontos mit gemeinsamem Schlüssel laufen
nacheinander, von `prepare` bis zum Ende von `execute` (`src/safety/record-locks.ts`). Eine
Belegdatei von einem https-Link wird vor der Sperre heruntergeladen (`preload` des Werkzeugs,
`src/safety/link-prefetch.ts`): Der Download liest nur den fremden Host, nie sevDesk, und `prepare`
prüft genau diese Bytes wie bisher. So hält ein langsamer Host die anderen Aufrufe des Kontos
nicht auf. Je Konto wartet nur ein solcher Download auf seine Sperre, weil er bis dahin im
Speicher liegt; ein weiterer Aufruf lädt wie bisher innerhalb der Sperre herunter.

Die Sperren leben in einem Serverprozess; mehrere Replikate bräuchten eine gemeinsame Sperre. Der
Metadaten-Lint scheitert für ein Schreibwerkzeug ohne `locks`, außer es steht mit seiner
Begründung auf einer kurzen Liste: neue Rechnungs- und Auftragsentwürfe (ihre Dublettenprüfung
warnt nur) und der DATEV-Export.

## Nicht vertrauenswürdiger Text

Kontaktnamen, Beschreibungen, Verwendungszwecke von Überweisungen und Felder von E-Rechnungen
können von Dritten geschrieben sein und Prompt Injection enthalten. Unsichtbare und
Bidi-Zeichen werden aus ihnen entfernt, in der Ausgabe sind sie eingefasst, und sie werden nie in
Fehlermeldungen oder Anweisungen eingesetzt.

## Dateien

Werkzeuge greifen nie direkt auf das Dateisystem oder den Speicher der Dateiübertragung zu; jedes
Byte, das sie lesen oder herausgeben, läuft über den `FileAccess` ihres Kontexts
([Dateien](transports.de.md#dateien)). Jedes Werkzeug, das Dateien liest oder schreibt oder eine
Upload-Seite öffnet, gibt `localEffects` an und steht auf einer geprüften Liste im Metadaten-Lint;
ein `read`-Werkzeug, das Dateien herausgibt oder eine Upload-Seite öffnet (ein Ticket auf diesem
Server), setzt `readOnlyHint: false`, weil es Zustand außerhalb von sevDesk ändert. E-Rechnungs-XML
wird ohne Entitätsauflösung und ohne DOCTYPEs geparst, mit Grenzen für Größe und Tiefe.

## Generischer Lesezugriff

`sevdesk_api_get` (Werkzeuggruppe `advanced`, standardmäßig aus) lässt das Modell einen GET-Pfad
wählen; deshalb hat es vier unabhängige Schutzmechanismen, beschrieben unter
[Generischer Lesezugriff](../security/local.de.md#generischer-lesezugriff). Der Code ist `genericGetRefusal` in
`src/sevdesk/paths.ts` und `src/domain/api-get.ts`.

## Token

Das sevDesk-API-Token hat vollen Zugriff auf das Konto, keine einschränkbaren Rechte und kein
Ablaufdatum. Es wird überall geschwärzt, und ein 401 ist endgültig. Woher es kommt, hängt vom Modus
ab:

- **stdio:** aus der Umgebung, einer `*_FILE`-Datei oder, wahlweise, aus dem Schlüsselbund des
  Betriebssystems, beim Start mit `GET /Tools/bookkeepingSystemVersion` geprüft. `SEVDESK_PROFILE`
  legt zuerst ein benanntes Profil aus einer lokalen JSON-Datei über dieselben Variablen, bevor sie
  geprüft werden (`src/accounts/local-config.ts`,
  [ADR 0009](../adr/0009-local-profiles-and-os-keychain.de.md)). Der Schlüsselbund wird über die
  Hilfsprogramme des Betriebssystems gelesen (`/usr/bin/security` unter macOS, `secret-tool` unter
  Linux, Windows PowerShell mit WinRT `PasswordVault` unter Windows), unter dem festen Dienst
  `mcp-server-sevdesk`, sodass die Konfiguration nur eine Bezeichnung nennt. Wie du beides
  verwendest, steht unter [Profile und Schlüsselbund](../configuration/profiles.de.md).
- **Bearer:** aus der Umgebung oder einer `*_FILE`-Datei; der Server fragt beim Start sein Konto ab
  (`GET /SevClient`). Eine gescheiterte Abfrage wird als Warnung protokolliert und hält den Server
  nicht an (Freigaben und Zeilen des Audit-Logs verwenden dann den Kontobereich `bearer`).
- **OAuth:** Jeder Benutzer fügt es auf der Zustimmungsseite ein; es wird mit `GET /SevClient`
  geprüft, in die Tokens dieses Benutzers versiegelt und bei jeder Erneuerung erneut geprüft.

Das Bedrohungsmodell steht in der [Sicherheitsrichtlinie](../../SECURITY.de.md); die Ablage des Tokens auf
deinem eigenen Rechner wird unter [Sicherheit bei lokaler Nutzung](../security/local.de.md) untersucht.

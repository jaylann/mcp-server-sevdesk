<!-- translated-from: docs/compatibility.md sha256:3c27c1ef1e1b -->

# Kompatibilität

Ab 1.0.0 folgen Releases der [semantischen Versionierung](https://semver.org). Diese Seite legt die
öffentliche Oberfläche fest, die Versionsnummern schützen: worauf du, deine Skripte, deine
Client-Konfiguration und die Modelle, die den Server verwenden, sich innerhalb einer Hauptversion
verlassen können und was sich in jedem Release ändern darf.

## Was 1.0 einfriert

Eine Änderung, die etwas aus dieser Liste bricht, braucht eine neue Hauptversion, außer sie
durchläuft zuerst die [Regeln für Abkündigungen](#regeln-für-abkündigungen).

| Bereich                    | Was stabil ist                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Werkzeuge                  | Namen (`sevdesk_…`), die Werkzeuggruppe und die Stufe jedes Werkzeugs.                                                                                                                                                                                                                                                                            |
| Eingaben der Werkzeuge     | Namen und Typen der Argumente, ob sie Pflicht sind, angenommene Enum-Werte und die Bedeutung jedes Werts, einschließlich des Arguments `dryRun` der Schreibwerkzeuge und der Form `upload:<id>` von Dateiverweisen.                                                                                                                               |
| Ausgaben der Werkzeuge     | Feldnamen, Typen und Enum-Werte des JSON-Ergebnisses und von `structuredContent`, einschließlich der Status von Schreibvorgängen `done`, `dry_run`, `approval_pending` und `declined`.                                                                                                                                                            |
| Werkzeuggruppen, Stufen    | Die Namen (`meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced`; `read`, `write`, `commit`, `external`), die Schlüsselwörter `default` und `all` und die sicheren Voreinstellungen: nur `read` aktiv, `advanced` nicht geladen, Bestätigung per `elicit`.                              |
| Prompts                    | Namen (`month_end_close`, `receipt_intake`, `dunning_run`, `vat_precheck`, `bank_reconciliation`) und Namen der Argumente mit ihren Formaten.                                                                                                                                                                                                     |
| Umgebungsvariablen         | Namen, angenommene Werte und ihre Bedeutung, Standardwerte und die `_FILE`-Varianten von Geheimnissen ([Konfiguration](configuration.de.md#variablen), [Fernzugriff](remote/configuration.de.md)).                                                                                                                                                |
| Kommandozeile              | Befehle, ihre Argumente und Flags, die Exit-Codes `0`, `1` und `2` und die Felder von `grants list --json` mit ihren Werten ([Kommandozeile](configuration.de.md#kommandozeile), [Fernzugriff](remote/operations.de.md)).                                                                                                                         |
| Lokale Dateien             | Das Format der Profildatei (`"version": 1` und ihre Schlüssel), ihr Standardort und der Dienstname `mcp-server-sevdesk` im Schlüsselbund.                                                                                                                                                                                                         |
| Ressourcen                 | Die URI-Vorlagen `sevdesk://invoices/{id}/pdf`, `sevdesk://credit-notes/{id}/pdf`, `sevdesk://orders/{id}/pdf`, `sevdesk://invoices/{id}/xml` und die URIs `sevdesk://reference/tax-rules`, `sevdesk://reference/status-codes`.                                                                                                                   |
| Audit-Log                  | Namen der Ereignisse, Namen der Felder und die Bedeutung jedes Felds ([Audit-Log](permissions/audit-log.de.md)). Die Version des Zeilenformats `v` steigt, wenn ein Feld seine Bedeutung ändert oder entfällt.                                                                                                                                    |
| HTTP-Routen                | `POST /mcp`, `GET /healthz` und seine Antwort `{"status":"ok"}`, das Freigabe-Postfach unter `/approvals` (mit Anmeldung unter `/approvals/login`), die Upload-Seiten `/uploads/<id>` und die Download-Links `/files/<id>`.                                                                                                                       |
| Claude-Desktop-Erweiterung | Die Schlüssel der Einstellungen des `.mcpb`-Bundles (`api_token`, `allow`, `read_only`, `dry_run`, `confirm`, `toolsets`, `file_dir`, `output_dir`, `audit_log`, `vies_check`), unter denen Claude Desktop deine Werte speichert, und ihre Standardwerte (`confirm` ist dort `browser`, weil Claude Desktop keinen `elicit`-Dialog zeigt).        |
| Namen                      | Das npm-Paket `mcp-server-sevdesk` und sein Programm, das Image `ghcr.io/jaylann/mcp-server-sevdesk`, der Name in der MCP Registry `io.github.jaylann/mcp-server-sevdesk`, das Release-Asset `mcp-server-sevdesk-<version>.mcpb` und das Claude-Code-Plugin `sevdesk` mit seinem Skill `sevdesk-bookkeeping` im Marketplace `mcp-server-sevdesk`. |
| Docker-Image               | Der Standardbefehl `--http`, der Port `8080`, Zustandsverzeichnis und Volume `/data`, die User-ID `65532`, die Bind-Adresse `0.0.0.0` im Image und die Tags `X.Y.Z`, `X.Y` und `latest` (`latest` nie für eine Vorabversion).                                                                                                                     |
| Zustandsverzeichnis        | Seine Dateien (`grants.jsonl` und die übrigen) sind intern, und ihr Format ist nicht öffentlich, aber ein Release 1.x liest weiterhin, was frühere Releases 1.x geschrieben haben, sodass Zugänge ein Update innerhalb der Hauptversion überstehen.                                                                                               |

## Was 1.0 nicht einfriert

Das darf sich in jedem Release ändern, auch in Patch-Releases:

- **Aufbau der Schemas:** Ausgabeschemas dürfen lokale `$defs`/`$ref` verwenden; das Schema jedes
  Werkzeugs steht für sich.
- **Leerraum im JSON:** Einrückung und Zeilenumbrüche in den Textblöcken der Ergebnisse und in
  JSON-Ressourcen gehören nicht zum Vertrag; parse das JSON, statt seine Formatierung abzugleichen.
- **Text für Menschen oder Modelle:** Beschreibungen und Titel von Werkzeugen und Prompts,
  Beschreibungen von Argumenten, der Zusammenfassungstext von Ergebnissen, Fehlermeldungen,
  Warnungen, Hinweise, die Anweisungen des Servers, der erzeugte Text von Prompts und der Wortlaut
  von Bestätigungsvorschauen. Modelle lesen sie, deshalb werden sie mit der Zeit besser; parse sie
  nicht.
- **Logs:** die stderr-Zeilen des Servers, das JSON-Anfrage-Log des Fernzugriffs, seine Feldnamen
  und seine Ereignisnamen.
- **OAuth-Endpunkte:** Clients finden `/authorize`, `/token` und `/revoke` über die
  Metadaten-Dokumente, ihre Pfade dürfen sich also ändern. Die Metadaten-Dokumente
  (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) werden nicht
  eigens eingefroren: Pfade und Format sind die von RFC 8414 und RFC 9728, auf die sich Clients
  verlassen.
- **Annotationen der Werkzeuge** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) dürfen sich ändern, aber nur in Richtung mehr Vorsicht, zum Beispiel ein
  Werkzeug, das neu als destruktiv markiert wird.
- **HTML-Seiten:** die Zustimmungsseite, die Freigabeseiten, die Anmelde-, Upload- und
  Download-Seiten, ihr Layout, ihr Text, ihre Sprachen und Formularfelder und die Dateien, die sie
  von `/assets/` laden (Schriften und das Icon; die Namen tragen einen Inhalts-Hash und ändern sich
  mit den Dateien).
- **Der Modus für Einrichtungsprobleme:** Mit einer ungültigen Konfiguration startet der
  stdio-Server nur mit `sevdesk_setup_problem` ([Konfiguration](configuration.de.md#kommandozeile));
  Name und Ausgabe dieses Werkzeugs dürfen sich ändern.
- **Welche Werkzeuge eine Konfiguration anbietet**, über die Regeln oben hinaus: In einem
  Minor-Release können neue Werkzeuge in einer Werkzeuggruppe erscheinen, und Werkzeuge, die einen
  Ordner oder die Dateiübertragung im Fernzugriff brauchen, erscheinen nur, wenn diese konfiguriert
  sind.
- **Grenzen und Feinabstimmung:** Seitengrößen, Größengrenzen, Zeitlimits und die Drosselung der
  Anfragen, solange bestehende Argumente gültig bleiben.
- **Interna:** Das Paket exportiert keine Bibliotheks-API; seine Module, die Build-Ausgabe,
  Test-Fixtures, Skripte und die Evals können sich jederzeit ändern.

## Inkompatible und kompatible Änderungen

**Inkompatibel** (eine Hauptversion oder vorher eine Abkündigung):

- etwas aus der eingefrorenen Liste entfernen oder umbenennen;
- den Typ oder die Bedeutung eines Arguments, Ausgabefelds, Werts oder einer Variable ändern;
- ein optionales Argument zur Pflicht machen oder Werte ablehnen, die angenommen wurden;
- ein Werkzeug in eine andere Werkzeuggruppe oder eine höhere Stufe verschieben;
- eine Voreinstellung so ändern, dass der Server mehr erlaubt als vorher (mehr Stufen, mehr
  Werkzeuggruppen, schwächere Bestätigung).

**Kompatibel** (ein Minor-Release):

- neue Werkzeuge, Prompts, Werkzeuggruppen, Ressourcen, Variablen und Befehle;
- neue optionale Argumente, neue angenommene Eingabewerte, neue Ausgabefelder;
- neue Ereignisse oder Felder im Audit-Log;
- ein neuer Wert in einem Enum der Ausgabe, wenn sevDesk ihn selbst einführt (zum Beispiel einen
  neuen Dokumentstatus). Clients sollten einen Wert, den sie nicht kennen, als „sonstiger“
  behandeln.

**Ausnahmen.** Eine Korrektur für eine Sicherheitslücke darf die Kompatibilität in einem Minor-
oder Patch-Release brechen, wenn es keine sichere Alternative gibt; das Advisory und die
Release-Notes sagen das. Wenn sevDesk einen Endpunkt ändert oder entfernt, muss sich ein Werkzeug
eventuell mit ihm ändern; die Release-Notes sagen, was sich geändert hat und warum.

## Regeln für Abkündigungen

Ein Name, der wegfällt, wird zuerst abgekündigt (Deprecation):

1. Der alte Name funktioniert neben dem neuen weiter, mindestens bis zum nächsten Major-Release und
   mindestens drei Monate lang.
2. Die Abkündigung wird in den Release-Notes und im Changelog angekündigt. Ein abgekündigtes
   Werkzeug oder Argument sagt das am Anfang seiner Beschreibung (`Deprecated: use … instead.`),
   damit Modelle das neue bevorzugen; die [Werkzeugreferenz](tools.md) zeigt es. Eine abgekündigte
   Umgebungsvariable löst beim Start eine Warnung im Log des Servers aus.
3. Das nächste Major-Release entfernt ihn und führt das in seinen Release-Notes unter den
   inkompatiblen Änderungen auf.

Pull-Requests, die die öffentliche Oberfläche ändern, folgen denselben Regeln; wie du
innerhalb dieser Regeln bleibst, steht unter
[Änderungen vornehmen](contributing/changes.de.md#kompatibilität).

## Geplante Änderungen

Die Werkzeuge zum Auflisten und Suchen von Dokumenten und Datensätzen nehmen `detail: "summary"`
zum Durchsehen an. In 1.x ist `detail` standardmäßig `"full"` und behält die bisherige Ausgabe.
Zusammenfassungen lassen Detailfelder weg und ändern außerdem diese Formen:

| Feld                                                      | Vollständig                                                | Zusammenfassung                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `status` von Dokument/Umsatz; `type` von Rechnung/Auftrag | Objekte mit Codes, Bezeichnungen und optionalen Schlüsseln | Schlüssel als Zeichenketten; fehlt, wenn der Schlüssel unbekannt ist   |
| Bruttosumme eines Dokuments                               | `totals.gross: {amount, currency}`                         | `gross` als Dezimal-Zeichenkette und ein `currency` auf oberster Ebene |
| `amount` eines Umsatzes; `priceGross` eines Artikels      | `{amount, currency}`                                       | Dezimal-Zeichenkette und `currency` auf oberster Ebene                 |
| `category` eines Kontakts                                 | ID, Schlüssel und Name, wenn bekannt                       | Nur ID und Schlüssel                                                   |

Zusammenfassungen von Rechnungen ergänzen `openAmount` nur bei offenen oder teilweise bezahlten
Rechnungen, wenn Brutto- und bezahlter Betrag in derselben Währung bekannt sind. Zusammenfassungen
lassen andere Beträge, Bezeichnungen, Metadaten und Felder des vollständigen Datensatzes weg;
verwende das passende `*_get`-Werkzeug für einen ausgewählten Datensatz oder `detail: "full"` für
die bisherige Form der Liste. Blättern und Standardlimits bleiben unverändert.

Die nächste Hauptversion darf die Voreinstellung auf `"summary"` umstellen. Weil das Felder
entfernt und ihre Typen ändert, ist es eine inkompatible Änderung und muss den
[Regeln für Abkündigungen](#regeln-für-abkündigungen) folgen: Ankündigung in den Release-Notes und
im Changelog, mindestens drei Monate bis zur Umstellung in der Hauptversion und Aufführung unter den
inkompatiblen Änderungen dieses Releases. Ein ausdrückliches `detail: "full"` bleibt der Weg für
Aufrufer, die die bisherige Form brauchen. Dieser Hinweis ändert die Voreinstellung von 1.x nicht
und kündigt sie nicht ab.

## Änderungen gegenüber 0.x

Vor 1.0 hat ein Review diese Namen umbenannt, damit die eingefrorenen Namen einheitlich sind.
Konfigurationen und Skripte, die für 0.x geschrieben wurden, brauchen die neuen Namen.

| Vor 1.0                                                                                 | Ab 1.0                                                            |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `sevdesk_export_csv` (Eingabe `kind`, Ausgabe `contentType`)                            | `sevdesk_csv_export` (Eingabe `subject`, Ausgabe `mimeType`)      |
| `sevdesk_order_to_invoice` (Werkzeuggruppe `orders`)                                    | `sevdesk_invoice_create_from_order` (Werkzeuggruppe `invoices`)   |
| `transactionId` von `sevdesk_transaction_book`, `_mark_private`, `_reset`               | `id`                                                              |
| `taxRule` der Entwurfswerkzeuge für Rechnungen, Aufträge, Gutschriften und Belege       | `taxRuleId`                                                       |
| Artikel-Eingabe `priceType`, Dokument-Ausgabe `pricesEnteredAs`                         | `priceMode`                                                       |
| Belege `amountsAre`                                                                     | `amountMode`                                                      |
| `sevdesk_bank_accounts_list` `balanceDate`                                              | `asOf`                                                            |
| `sevdesk_records_summarize` `accountId`                                                 | `checkAccountId`                                                  |
| `sevdesk_reconcile_suggest` `matches` (Eingabe)                                         | `maxMatches`                                                      |
| `sevdesk_reconcile_suggest` Ausgabe `followUp.arguments.transactionId`                  | `followUp.arguments.id`                                           |
| Schreibwerkzeuge für Belege: Ausgabe `receipt.pages` als beliebige Zahl                 | eine ganze Zahl                                                   |
| `sevdesk_order_create_draft` `orderType`                                                | `type`                                                            |
| `sentVia`-Wert `own_email`; Ausgabe `sent.via` als sevDesk-Codes (`VM`, `VPDF`, …)      | `email`; `sent.via` als `pdf_download`, `post`, `print`, `email`  |
| Zahlungsausgabe `bookingType` (sevDesk-Codes)                                           | `paymentType` mit den Werten der Eingabe                          |
| E-Mail-Ausgabe `copyToMe`                                                               | `sendCopyToMe`                                                    |
| Textfeld `basis` der Auswertungen (Übersichten, Altersstruktur, Liquidität, Änderungen) | `source`                                                          |
| Belegbeträge `net`, `tax`, `gross`, `base`, `paidAmount`; `taxRule`, `taxType`          | `totals`, `totalsEur`, `paid`; ein `tax`-Block wie bei Rechnungen |
| Steuersätze und Bestand als JSON-Zahlen                                                 | Dezimal-Zeichenketten, wie Geld                                   |
| Audit-Zeilen ohne Version                                                               | `v: 1` nach `ts`                                                  |

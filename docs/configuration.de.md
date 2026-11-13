<!-- translated-from: docs/configuration.md sha256:3cbbec919733 -->

# Konfiguration

Alle Einstellungen sind Umgebungsvariablen. Über stdio setzen Sie sie im `env` des Servereintrags
Ihres MCP-Clients ([Clients](clients.de.md)); im [Fernzugriff](remote.de.md) gehören sie in die
Umgebung des Servers. Nur ein Token ist Pflicht. Alles andere steht standardmäßig auf der
sichersten Option: nur lesend, Bestätigung durch einen Menschen für bindende Schritte, kein Zugriff
auf lokale Dateien.

Der Server liest die Variablen einmal beim Start, meldet alle Probleme auf einmal und startet erst,
wenn alle behoben sind. Starten Sie nach einer Änderung den Client (oder den Server) neu.

Er prüft auch die Namen. Eine Variable, deren Name mit `SEVDESK_` beginnt und die keine der
Einstellungen auf dieser Seite oder im [Fernzugriff](remote.de.md) ist, wird nicht stillschweigend
ignoriert:

- Ein Name, der einer Einstellung fast gleicht, gilt als Problem, und der Server startet erst,
  wenn er umbenannt oder entfernt ist. Fast gleich heißt: dieselben Buchstaben mit anderen
  Trennzeichen oder anderer Groß- und Kleinschreibung (`SEVDESK_READONLY` oder
  `sevdesk_read_only` für `SEVDESK_READ_ONLY`) oder ein bis zwei Zeichen Unterschied
  (`SEVDESK_ALOW`). Die gemeinte Einstellung, womöglich ein Sicherheitsschalter wie
  `SEVDESK_READ_ONLY` oder `SEVDESK_DRY_RUN`, würde sonst nicht gelten. Das Problem nennt die
  Variable und die Einstellung, der sie ähnelt, nie den Wert.
- Jeder andere unbekannte Name mit `SEVDESK_…`, zum Beispiel eine Variable eines anderen Werkzeugs
  in Ihrer Shell, wird ignoriert; das Log des Servers nennt die Namen in einer Warnung.

Variablen mit leerem Wert werden nicht geprüft, und die Namen `SEVDESK_TOKEN_…`, aus denen ein
[Profil](#profile) sein Token lesen darf, sind bekannt.

Formate der Werte:

- **Schalter** nehmen `1`, `true`, `yes` oder `on` sowie `0`, `false`, `no` oder `off`.
- **Listen** sind durch Kommas getrennt, Groß- und Kleinschreibung spielt keine Rolle, zum Beispiel
  `write,commit`.
- **Ordnerlisten** werden wie `PATH` getrennt: `:` unter macOS und Linux, `;` unter Windows. Jeder
  Eintrag muss ein absoluter Pfad sein.
- Ein **leerer Wert** gilt als nicht gesetzt. Clients, die jede Variable übergeben (wie das
  Claude-Code-Plugin), können die nicht benötigten leer lassen.

## Variablen

### Token

Setzen Sie genau eine dieser drei, es sei denn, das [Profil](#profile), das Sie verwenden, gibt an,
wo das Token liegt.

| Variable                     | Standard | Bedeutung                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN`          |          | Ihr sevDesk-API-Token (sevDesk: Einstellungen → Benutzer → API-Token), am besten eines eigenen Benutzers. Das reine Token, ohne vorangestelltes `Bearer `. Pflicht über stdio und im Bearer-Modus; im OAuth-Modus nicht verwendet, dort fügt jeder Benutzer sein eigenes auf der Zustimmungsseite ein.                                                          |
| `SEVDESK_API_TOKEN_FILE`     |          | Das Token stattdessen aus dieser Datei lesen (ohne umgebende Leerzeichen). Für Docker- und Kubernetes-Secrets oder eine Datei, die nur Sie lesen können (`chmod 600`).                                                                                                                                                                                          |
| `SEVDESK_API_TOKEN_KEYCHAIN` |          | Über stdio: das Token aus dem Schlüsselbund des Betriebssystems lesen, abgelegt unter dieser Bezeichnung mit [`token set`](#das-token-im-schlüsselbund-ablegen). macOS, Linux und Windows (Windows PowerShell im FullLanguage-Modus). Eine Bezeichnung hat bis zu 64 Buchstaben, Ziffern, `.`, `_` oder `-` und beginnt mit einem Buchstaben oder einer Ziffer. |

Eine Variable mit `…_FILE` (diese und die des [Fernzugriffs](remote.de.md)) nimmt den Pfad einer
Datei, die den Wert enthält, nie den Wert selbst; verwenden Sie einen absoluten Pfad. Kann die
Datei nicht gelesen werden, nennt das Problem den Pfad nur, wenn er absolut ist. Alles andere wird
nicht gezeigt, weil es das Geheimnis selbst sein kann, in die falsche Variable eingefügt.

### Berechtigungen

| Variable                          | Standard        | Bedeutung                                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_ALLOW`                   | `read`          | Die [Berechtigungsstufen](permissions.de.md#stufen), die aktiviert werden: eine Liste aus `read`, `write`, `commit`, `external` oder `all`. `read` ist immer aktiv.                                                                                                               |
| `SEVDESK_READ_ONLY`               | `0`             | `1` erlaubt nur Lesewerkzeuge, unabhängig davon, was in `SEVDESK_ALLOW` steht.                                                                                                                                                                                                    |
| `SEVDESK_DRY_RUN`                 | `0`             | `1` macht jeden Schreibvorgang zum [Probelauf](permissions.de.md#probelauf): Schreibwerkzeuge prüfen den Aufruf und geben eine Vorschau zurück (Status `dry_run`); nichts wird gesendet, niemand wird gefragt. Pro Aufruf: `dryRun: true`.                                        |
| `SEVDESK_CONFIRM`                 | `elicit`        | Wie ein Mensch Aufrufe der Stufen `commit` und `external` bestätigt: `elicit` (eine Abfrage in Ihrem Client), `browser` (eine Freigabeseite in Ihrem Browser) oder `off`. Siehe [Bestätigungsarten](permissions.de.md#bestätigungsarten).                                         |
| `SEVDESK_I_UNDERSTAND_NO_CONFIRM` | `0`             | Muss `1` sein, damit `SEVDESK_CONFIRM=off` angenommen wird.                                                                                                                                                                                                                       |
| `SEVDESK_CONFIRM_OPEN`            | `1` (HTTP: `0`) | Browser-Modus über stdio: jede Freigabeseite in Ihrem Standardbrowser öffnen. `0` schreibt nur ihren Link in das Log des Servers (stderr). Der Link wird dem Modell nie gezeigt. Ohne Wirkung im Fernzugriff; dort wird `1` abgelehnt, außer der Server lauscht nur auf Loopback. |

### Werkzeuge und Ausgabe

| Variable                    | Standard  | Bedeutung                                                                                                                                                                                                                                                                  |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_TOOLSETS`          | `default` | Die [Werkzeuggruppen](#werkzeuggruppen), die geladen werden: eine Liste aus `meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced` oder `default` (alles außer `advanced`) oder `all`. `meta` wird immer geladen. |
| `SEVDESK_STRUCTURED_OUTPUT` | `auto`    | `auto`, `on` oder `off`: ob Werkzeuge ein Ausgabeschema angeben und neben dem JSON-Text typisierten `structuredContent` zurückgeben. Siehe [Strukturierte Ausgabe](#strukturierte-ausgabe).                                                                                |

### Dateien und Audit-Log

| Variable             | Standard | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_FILE_DIRS`  |          | Ordner, aus denen Belege und E-Rechnungen gelesen werden dürfen: für Belegentwürfe (`sevdesk_voucher_create_draft`, `sevdesk_voucher_update_draft`), `sevdesk_einvoice_parse` und `sevdesk_voucher_import_einvoice`. Symbolische Links müssen innerhalb bleiben; sonst kann nichts auf Ihrer Festplatte gelesen werden. Ohne die Variable nehmen diese Werkzeuge keine lokalen Dateien an (und die beiden E-Rechnungs-Werkzeuge werden nicht angeboten). |
| `SEVDESK_OUTPUT_DIR` |          | Der Ordner, in den `sevdesk_document_save`, `sevdesk_csv_export` und `sevdesk_datev_export` Dateien schreiben dürfen (PDFs, E-Rechnungs-XML, CSV- und DATEV-Exporte). Diese Werkzeuge werden nur angeboten, wenn die Variable gesetzt ist. Sie legen nur neue Dateien an, mit Modus 0600, und überschreiben nie eine.                                                                                                                                    |
| `SEVDESK_AUDIT_LOG`  |          | Pfad eines Protokolls im Format JSON Lines, an das nur angehängt wird, für jeden schreibenden Aufruf (Modus 0600): Vorschauen, Bestätigungen, Ausführungen und Fehlschläge. Ist die Variable gesetzt, die Datei aber nicht beschreibbar, werden Schreibvorgänge abgelehnt. Siehe [Audit-Log](permissions.de.md#audit-log).                                                                                                                               |

Im Fernzugriff liegen die Ordner auf dem Server. Der OAuth-Modus lehnt beide Ordnervariablen ab
und verwendet stattdessen Seiten zum Hochladen und Download-Links ([remote.de.md](remote.de.md#dateien-hochladen-und-herunterladen)).

### Verbindung

| Variable             | Standard                       | Bedeutung                                                                                                |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `SEVDESK_RATE_LIMIT` | `4`                            | Anfragen pro Sekunde an sevDesk, 0,1–50. sevDesk veröffentlicht keine Grenze.                            |
| `SEVDESK_TIMEOUT_MS` | `30000`                        | Zeitlimit einer Anfrage in Millisekunden, 1000–300000.                                                   |
| `SEVDESK_BASE_URL`   | `https://my.sevdesk.de/api/v1` | Die Basis-URL der API. Nur https, ohne Benutzername, Passwort, Query-String oder Fragment. Selten nötig. |

### Profilauswahl

| Variable                | Standard                                     | Bedeutung                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_PROFILE`       |                                              | Über stdio: dieses Profil aus der Profildatei verwenden ([Profile](#profile)).                                                                                                                                                  |
| `SEVDESK_PROFILES_PATH` | `~/.config/mcp-server-sevdesk/profiles.json` | Wo die Profildatei liegt, als absoluter Pfad. Standard unter Linux und macOS: `$XDG_CONFIG_HOME/mcp-server-sevdesk/profiles.json`, wenn diese Variable gesetzt ist; unter Windows `%APPDATA%\mcp-server-sevdesk\profiles.json`. |

`SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` und `SEVDESK_API_TOKEN_KEYCHAIN` funktionieren nur über
stdio; der HTTP-Server startet mit ihnen nicht.

### HTTP-Modus

`--http` liest weitere Variablen (`SEVDESK_HTTP_*`, `SEVDESK_OAUTH_*`) und ändert die Bedeutung
einiger der oben genannten Variablen. Beides beschreibt die
[Konfigurationsreferenz des Fernzugriffs](remote.de.md#konfigurationsreferenz).

Für die Dateiübertragung begrenzt `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` (Standard `10`, ganze
Zahlen von 1 bis 1000) die gemeinsame Anzahl gültiger Upload-Seiten, hochgeladener Dateien und
Download-Links je Konto. Erfolgreiches Anhängen gibt Uploads sofort frei; die Byte-Grenzen werden
weiterhin durch `SEVDESK_HTTP_FILES_MAX_MB` bestimmt. Alle Dateigrenzen stehen in der oben
verlinkten Referenz des Fernzugriffs.

## Werkzeuggruppen

Eine Werkzeuggruppe fasst die Werkzeuge für einen Bereich zusammen. `SEVDESK_TOOLSETS` wählt die
Werkzeuggruppen, `SEVDESK_ALLOW` die Stufen darin: Ein Werkzeug wird nur angeboten, wenn beide es
zulassen. Weniger Werkzeuggruppen machen die Werkzeugliste kürzer; das hilft Modellen bei der Wahl
und spart Tokens.

| Werkzeuggruppe | Umfang                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`         | Kontoübersicht, Stammdaten (Steuerregeln, Buchungskonten, Einheiten, Länder, …), Dokumente als Datei speichern, Upload-Anfragen im Fernzugriff. Wird immer geladen.                        |
| `contacts`     | Kunden und Lieferanten: suchen, abrufen, anlegen, ändern, nächste Kundennummer.                                                                                                            |
| `invoices`     | Rechnungen: auflisten, abrufen, Entwürfe, Rechnungen aus Aufträgen, Mahnungen, Fertigstellen bis Festschreiben, PDF, E-Rechnungs-XML und Tauglichkeitsprüfung.                             |
| `credit-notes` | Gutschriften: auflisten, abrufen, Entwürfe, Gutschriften aus Rechnungen, Fertigstellen bis Festschreiben, PDF.                                                                             |
| `orders`       | Aufträge (Angebote, Auftragsbestätigungen, Lieferscheine): auflisten, abrufen, Entwürfe, fertigstellen, versenden, PDF.                                                                    |
| `vouchers`     | Belege: auflisten, abrufen, Entwürfe mit angehängter Belegdatei, E-Rechnungen auslesen und importieren, Fertigstellen bis Festschreiben.                                                   |
| `banking`      | Zahlungskonten und Kontoumsätze, Zuordnungsvorschläge, Kontoumsätze Dokumenten zuordnen, private Umsätze.                                                                                  |
| `parts`        | Artikel einschließlich Lagerbestand: auflisten, abrufen, anlegen, ändern.                                                                                                                  |
| `reports`      | Zusammenfassungen, Altersstruktur offener Forderungen und Verbindlichkeiten, Liquidität, Änderungen seit einem Datum, Umsatzsteuer-Auswertung, Gewinn und Verlust, CSV- und DATEV-Exporte. |
| `advanced`     | `sevdesk_api_get`, ein reines Lese-GET auf jeden sevDesk-Endpunkt. Standardmäßig aus.                                                                                                      |

Jedes Werkzeug mit seiner Werkzeuggruppe, Stufe und seinen Argumenten steht in der
[Werkzeugreferenz](tools.md).

### Die Werkzeuggruppe advanced

`advanced` ist aus, solange Sie die Gruppe nicht nennen (`SEVDESK_TOOLSETS=default,advanced`) oder
`all` laden. Sie enthält ein Werkzeug, `sevdesk_api_get`: ein reines Lese-GET auf einen
sevDesk-Endpunkt, den kein anderes Werkzeug abdeckt, zum Beispiel die Textvorlagen
(`/TextTemplate`), die Einheiten von Artikeln (`/PartUnity`) oder angehängte Dokumente
(`/Document`).

- Es lehnt alles ab, was Daten ändern, Dateien liefern oder Hintergrundaufgaben starten könnte
  (`getPdf`, `sendBy`, `bookAmount`, `enshrine`, die Endpunkte für die nächste Nummer, Exporte und
  Berichte, …), bevor etwas gesendet wird, und es setzt nie ein Token in die URL.
- Antworten sind die rohen Objekte von sevDesk, bereinigt wie nicht vertrauenswürdiger Text:
  unsichtbare Zeichen entfernt, lange Zeichenketten gekürzt, Binärinhalte (Dateien in Base64,
  Vorschaubilder) entfernt und aufgeführt. Pro Aufruf werden höchstens etwa 100 KB zurückgegeben
  (Antworten über 1 MiB werden abgelehnt); `nextOffset` setzt eine längere Liste fort.
- Bevorzugen Sie die kuratierten Werkzeuge: Sie prüfen Eingaben, erklären Felder und formatieren
  Beträge und Datumsangaben.

Die Werkzeuggruppe ist standardmäßig aus, weil ein allgemeiner Lesezugriff nicht jeden Endpunkt so
gut kennen kann wie ein kuratiertes Werkzeug; siehe
[SECURITY.de.md](../SECURITY.de.md#generischer-lesezugriff).

## Strukturierte Ausgabe

Jedes Werkzeug gibt sein Ergebnis als JSON-Textblock zurück. Mit strukturierter Ausgabe gibt es
außerdem ein `outputSchema` in `tools/list` an und liefert dieselben Daten als typisierten
`structuredContent`, den Clients prüfen und anzeigen können.

| Wert   | Verhalten                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` | Strukturierte Ausgabe nur für Clients mit MCP-Protokollrevision 2026-07-28 oder neuer, weil einige ältere Clients damit falsch umgehen. |
| `on`   | Immer.                                                                                                                                  |
| `off`  | Nie; nur der JSON-Text.                                                                                                                 |

## Grenzen

| Was                                      | Grenze                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Listenwerkzeuge                          | Seiten mit 1–100 Datensätzen (Standard 25); Ergebnisse nennen, wie viele Datensätze ausgelassen wurden.                                 |
| Anfragen an sevDesk                      | `SEVDESK_RATE_LIMIT` pro Sekunde (Standard 4) und höchstens 4 gleichzeitig; Lesezugriffe können wiederholt werden, Schreibvorgänge nie. |
| Belege und E-Rechnungen aus einem Ordner | 20 MiB pro Datei; das XML in einem E-Rechnungs-PDF 5 MiB.                                                                               |
| Dokumentdateien (PDF, XML)               | 20 MiB.                                                                                                                                 |
| `sevdesk_api_get`                        | 1–1000 Zeilen pro Aufruf, etwa 100 KB Rückgabe, Antworten über 1 MiB abgelehnt.                                                         |
| Freigaben im Browser                     | je 10 Minuten, einmal verwendbar, höchstens 5 wartend.                                                                                  |
| Anweisungen des Servers                  | Höchstens 1.500 Zeichen.                                                                                                                |

Der Fernzugriff hat eigene Grenzen (Größe von Anfragen, Ratenbegrenzung je Client, Größe von
Uploads): siehe [remote.de.md](remote.de.md#grenzen).

## Das Token im Schlüsselbund ablegen

Statt das Token in die Konfiguration Ihres Clients zu schreiben, legen Sie es einmal im
Schlüsselbund Ihres Betriebssystems ab und geben dem Server nur seine Bezeichnung:

```sh
npx -y mcp-server-sevdesk token set work
```

Der Befehl fragt nach dem Token (die Eingabe ist verdeckt), prüft es bei sevDesk, legt es unter der
Bezeichnung `work` ab und gibt die Konto-ID aus. Lehnt sevDesk das Token ab, wird nichts abgelegt;
ist sevDesk nicht erreichbar, wird es mit einer Warnung abgelegt. Konfigurieren Sie den Server dann
mit `"SEVDESK_API_TOKEN_KEYCHAIN": "work"` statt `SEVDESK_API_TOKEN`.

- `token check work` prüft das abgelegte Token bei sevDesk; `token delete work` entfernt es.
- Das Token wird nie von der Kommandozeile übernommen, wo es in Ihrer Shell-Historie bliebe. Um es
  aus einer Datei abzulegen, leiten Sie es per Pipe ein:
  `npx -y mcp-server-sevdesk token set work < token.txt`, und löschen Sie die Datei danach.
  Diese Umleitung funktioniert in POSIX-Shells und `cmd.exe`; in PowerShell verwenden Sie
  `Get-Content -Raw token.txt | npx -y mcp-server-sevdesk token set work`.
- **macOS:** der Anmeldeschlüsselbund, Objekt `mcp-server-sevdesk`, Account = Ihre Bezeichnung.
- **Linux:** der Secret Service über `secret-tool` (Paket `libsecret-tools` unter Debian und
  Ubuntu, `libsecret` unter Fedora), mit laufendem und entsperrtem GNOME Keyring oder KWallet. Auf
  einem Server ohne grafische Oberfläche verwenden Sie `SEVDESK_API_TOKEN_FILE`.
- **Windows:** der Credential Locker über WinRT `PasswordVault`, Ressource
  `mcp-server-sevdesk`, Benutzername = Ihre Bezeichnung. Verwendet Windows PowerShell unter
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, ohne Profile oder Suche im
  `PATH`. Lassen Sie `SystemRoot` auf das Windows-Installationsverzeichnis zeigen. PowerShell 7
  (`pwsh`) wird nicht verwendet. Der Constrained Language Mode kann auch ohne `Add-Type` nicht
  auf diese API zugreifen; verwenden Sie `SEVDESK_API_TOKEN_FILE` oder die
  [Claude-Desktop-Erweiterung](clients.de.md#claude-desktop), wenn Windows PowerShell fehlt
  oder eingeschränkt ist. Einträge im Credential Locker können über Ihr Microsoft-Konto
  synchronisiert werden; verwenden Sie eine geschützte Token-Datei, wenn das Token auf diesem
  Gerät bleiben muss.

Der Schlüsselbund hält das Token aus Konfigurationsdateien, Backups und Screenshots heraus. Er
schützt nicht vor Programmen, die bereits unter Ihrem Benutzerkonto laufen (siehe
[SECURITY.de.md](../SECURITY.de.md#lokale-token-ablage-und-profile)).

## Profile

Profile halten mehrere Einrichtungen in einer Datei, zum Beispiel zwei sevDesk-Konten oder eine
nur lesende und eine buchende Einrichtung desselben Kontos, und wählen eine mit `SEVDESK_PROFILE`
aus. Legen Sie `~/.config/mcp-server-sevdesk/profiles.json` an (oder zeigen Sie mit
`SEVDESK_PROFILES_PATH` auf einen anderen Ort):

```json
{
  "version": 1,
  "profiles": {
    "work": {
      "token": { "keychain": "work" },
      "allow": ["write"],
      "fileDirs": ["/Users/me/Belege"],
      "auditLog": "/Users/me/.local/state/sevdesk-work.jsonl"
    },
    "client-a": {
      "token": { "file": "/Users/me/.config/sevdesk/client-a.token" },
      "readOnly": true
    }
  }
}
```

Setzen Sie dann `"SEVDESK_PROFILE": "work"` im `env` des Clients. Der Server schreibt beim Start
`using profile "work"` in sein Log.

| Schlüssel   | Setzt                | Wert                                                                                           |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `token`     | die Token-Quelle     | `{"keychain": "<label>"}`, `{"file": "/absolute/path"}` oder `{"env": "SEVDESK_TOKEN_<NAME>"}` |
| `allow`     | `SEVDESK_ALLOW`      | eine Liste oder eine durch Kommas getrennte Zeichenkette                                       |
| `readOnly`  | `SEVDESK_READ_ONLY`  | `true` oder `false`                                                                            |
| `dryRun`    | `SEVDESK_DRY_RUN`    | `true` oder `false`                                                                            |
| `confirm`   | `SEVDESK_CONFIRM`    | eine Zeichenkette                                                                              |
| `toolsets`  | `SEVDESK_TOOLSETS`   | eine Liste oder eine durch Kommas getrennte Zeichenkette                                       |
| `fileDirs`  | `SEVDESK_FILE_DIRS`  | eine Liste absoluter Pfade                                                                     |
| `outputDir` | `SEVDESK_OUTPUT_DIR` | eine Zeichenkette                                                                              |
| `auditLog`  | `SEVDESK_AUDIT_LOG`  | eine Zeichenkette                                                                              |
| `baseUrl`   | `SEVDESK_BASE_URL`   | eine Zeichenkette                                                                              |
| `rateLimit` | `SEVDESK_RATE_LIMIT` | eine Zahl                                                                                      |
| `timeoutMs` | `SEVDESK_TIMEOUT_MS` | eine Zahl                                                                                      |

Jeder Schlüssel setzt die Variable mit derselben Bedeutung und wird genauso geprüft. Regeln:

- **Die Datei enthält nie ein Token.** `token` sagt, wo es aufbewahrt wird: eine Bezeichnung im
  Schlüsselbund, ein absoluter Dateipfad oder eine Variable namens `SEVDESK_TOKEN_<NAME>`, die Sie
  im `env` des Clients setzen. Ohne `token` gelten die üblichen Token-Variablen.
- **Kein stilles Überschreiben.** Eine Variable, die sowohl in der Umgebung als auch im Profil
  gesetzt ist, ist ein Fehler, der beide nennt. Erlaubt ist nur das Verschärfen:
  `SEVDESK_READ_ONLY=1` und `SEVDESK_DRY_RUN=1` in der Umgebung haben immer Vorrang.
- **Die Datei muss Ihnen gehören.** Unter macOS und Linux müssen die Datei und ihr Ordner Ihnen
  (oder root) gehören und dürfen für Gruppe und andere nicht beschreibbar sein (`chmod go-w`), weil
  ein Profil Stufen und Ordner erweitern kann. Unter Windows wird das nicht geprüft.
- Die Datei ist striktes JSON mit höchstens 64 KiB und `"version": 1`; unbekannte Schlüssel werden
  abgelehnt.
- `npx -y mcp-server-sevdesk profiles list` zeigt jedes Profil mit dem Ort seines Tokens, seinen
  Stufen und Werkzeuggruppen und markiert das Profil, das `SEVDESK_PROFILE` nennt. Es gibt nie ein
  Token aus.
- Profile funktionieren nur über stdio, nicht mit `--http`.

## Kommandozeile

`mcp-server-sevdesk` ohne Argumente stellt MCP über stdio bereit; das führen MCP-Clients aus. Die
übrigen Befehle sind für Sie. Führen Sie sie mit `npx -y mcp-server-sevdesk <command>` aus oder mit
Docker als `docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:<version> <command>`.

| Befehl                              | Was er tut                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--stdio`                           | MCP über stdio bereitstellen (Standard).                                                                                                                 |
| `--http`                            | MCP über Streamable HTTP bereitstellen; braucht `SEVDESK_HTTP_AUTH` ([remote.de.md](remote.de.md)).                                                      |
| `token set <label>`                 | Ein sevDesk-Token im Schlüsselbund des Betriebssystems ablegen; fragt danach oder liest es von stdin. Siehe [oben](#das-token-im-schlüsselbund-ablegen). |
| `token check <label>`               | Das unter der Bezeichnung abgelegte Token bei sevDesk prüfen.                                                                                            |
| `token delete <label>`              | Das unter der Bezeichnung abgelegte Token löschen.                                                                                                       |
| `profiles list`                     | Die Profile der Profildatei auflisten.                                                                                                                   |
| `account-id`                        | Die sevDesk-Konto-ID des konfigurierten Tokens ausgeben (jede Token-Quelle oder ein Profil), für `SEVDESK_OAUTH_ACCOUNTS`.                               |
| `grants list [--json]`              | Fernzugriff: die OAuth-Zugänge (Grants) in `SEVDESK_HTTP_STATE_DIR` auflisten.                                                                           |
| `grants revoke <grant-id>`          | Fernzugriff: einen Zugang widerrufen; `--account <id>` widerruft alle Zugänge eines Kontos, `--all` alle.                                                |
| `generate-secret`                   | 32 zufällige Bytes für `SEVDESK_HTTP_SECRET` oder ein Bearer-Geheimnis ausgeben.                                                                         |
| `healthcheck`                       | Den lokalen HTTP-Server nach `/healthz` fragen (die Zustandsprüfung des Containers).                                                                     |
| `--version` (`-v`), `--help` (`-h`) | Die Version oder die Hilfe ausgeben.                                                                                                                     |

Exit-Codes: `0` Erfolg, `1` Fehlschlag (der Grund steht in stderr), `2` unbekannter Befehl oder
unbekanntes Argument. Die Befehle für den Fernzugriff beschreibt
[remote.de.md](remote.de.md#befehle) ausführlich.

Bei einer ungültigen Konfiguration schreibt der stdio-Server die Probleme nach stderr und startet
trotzdem, weil manche Clients (Claude Desktop) stderr nicht zeigen und nur „Server disconnected“
melden würden. Er bietet dann kein sevDesk-Werkzeug an, sendet nichts an sevDesk und nennt die
Probleme in seinen Anweisungen und in seinem einzigen Werkzeug, `sevdesk_setup_problem`, damit der
Assistent Ihnen sagen kann, welche Einstellung Sie korrigieren müssen. Der HTTP-Modus startet
weiterhin nicht.

<!-- translated-from: docs/troubleshooting.md sha256:7097fa1739c5 -->

# Fehlersuche

Lösungen für den Server, der auf deinem Computer läuft und von deinem MCP-Client gestartet wird
(stdio). Jeder Eintrag beginnt bei dem, was du siehst, und nennt dann Ursache und Lösung. Probleme
eines Servers, den du für claude.ai oder ein Team betreibst (OAuth, Proxys, Uploads, das
Freigabe-Postfach), stehen unter [Fehlersuche im Fernzugriff](remote/troubleshooting.de.md).

## Wo du zuerst nachsiehst

- **Das Log des Servers.** Der Server schreibt nach stderr, und die meisten Clients halten das in
  einem Log fest. Claude Desktop: `~/Library/Logs/Claude/mcp-server-sevdesk.log` unter macOS,
  `%APPDATA%\Claude\logs` unter Windows. Claude Code: `/mcp` zeigt den Server und seine Werkzeuge.
  Ein guter Start gibt
  `mcp-server-sevdesk: connected to sevDesk (bookkeeping system 2.0); tiers: read` aus; eine
  fehlgeschlagene Prüfung gibt `warning: startup check failed:` und den Grund aus.
- **Der Assistent.** Frag „Wie ist mein sevDesk-Konto eingerichtet?“.
  [`sevdesk_account_info`](tools.md#sevdesk_account_info) meldet die aktivierten Stufen,
  Werkzeuggruppen, Nur-Lesen, Probelauf und Bestätigungsart, sodass du siehst, was der Server
  erlaubt.
- **Ein Neustart.** Der Server liest seine Einstellungen einmal beim Start. Starte den Client nach
  jeder Änderung neu (oder aktualisiere seine Serverliste).

## Der Client zeigt den Server als fehlgeschlagen oder getrennt

**Ursache.** Der Client konnte das Programm nicht starten: `npx` wurde nicht gefunden, Node.js ist
älter als 22.12, oder das Paket ließ sich nicht herunterladen. Ein Konfigurationsproblem ist hier
nicht die Ursache; der Server startet auch mit einer fehlerhaften Konfiguration (nächster
Eintrag).

**Lösung.**

- Führe in einem Terminal `node --version` (22.12 oder neuer) und
  `npx -y mcp-server-sevdesk --version` aus.
- Clients, die über ein Desktop-Symbol starten, sehen den `PATH` deiner Shell unter Umständen
  nicht. Gib den vollen Pfad von `npx` als Befehl an (`which npx` unter macOS und Linux,
  `where npx` unter Windows).
- Der erste Start lädt das Paket herunter, was ein paar Sekunden dauern kann. Meldet der Client
  bei diesem ersten Start einen Fehler, starte ihn noch einmal.
- Um ganz ohne Node.js auszukommen, nimm die
  [Claude-Desktop-Erweiterung](clients/claude-desktop.de.md) oder
  [Docker](clients.de.md#docker-statt-npx).

## Der Assistent meldet eine ungültige Konfiguration

**Ursache.** Eine Einstellung ist falsch. Der Server startet dann trotzdem, bietet nur ein
Werkzeug an, `sevdesk_setup_problem`, sendet nichts an sevDesk und sagt dem Assistenten:
`mcp-server-sevdesk could not start: its configuration is invalid.`, gefolgt von jedem Problem.
Im Log steht dieselbe Liste unter `Invalid configuration:`.

**Lösung.** Korrigiere jede genannte Einstellung und starte neu. Häufige Probleme:

| Meldung                                                                                        | Lösung                                                                                        |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN is not set. Create a token in sevDesk under Settings → Users → API token …` | Trag das Token ein, oder `SEVDESK_API_TOKEN_KEYCHAIN` / `SEVDESK_API_TOKEN_FILE`.             |
| `SEVDESK_API_TOKEN must be the raw token, without a 'Bearer ' prefix.`                         | Entferne `Bearer `.                                                                           |
| `SEVDESK_API_TOKEN contains whitespace; paste only the token itself.`                          | Kopiere das Token noch einmal, ohne Leerzeichen oder Zeilenumbrüche.                          |
| `Set only one of SEVDESK_API_TOKEN, SEVDESK_API_TOKEN_FILE and SEVDESK_API_TOKEN_KEYCHAIN.`    | Behalte eine einzige Quelle für das Token.                                                    |
| `SEVDESK_API_TOKEN_FILE: cannot read …`                                                        | Gib den absoluten Pfad einer lesbaren Datei an, nie das Token selbst.                         |
| `SEVDESK_ALLOW: unknown tier "…"`                                                              | Verwende `read`, `write`, `commit`, `external` oder `all`.                                    |
| `SEVDESK_READONLY is not a setting of this server. Did you mean SEVDESK_READ_ONLY? …`          | Benenne die Variable um. Eine falsch geschriebene Einstellung würde sonst nicht greifen.      |
| `SEVDESK_CONFIRM=off disables human confirmation …`                                            | Bleib bei `elicit` oder `browser` ([Bestätigungsarten](permissions.de.md#bestätigungsarten)). |

Probleme mit dem Schlüsselbund und mit Profilen erscheinen in derselben Liste; siehe
[unten](#der-schlüsselbund-lässt-sich-nicht-lesen). Jede Variable ist in der
[Konfiguration](configuration.de.md) beschrieben.

## sevDesk lehnt das Token ab

**Symptom.** Ein Werkzeug antwortet: `sevDesk rejected the API token (HTTP 401). The token in
SEVDESK_API_TOKEN is wrong or revoked, or its user has no API access (the sevDesk API needs the
Buchhaltung Pro plan).` Im Log steht dasselbe beim Start.

**Ursache.** Das Token ist falsch eingegeben, wurde in sevDesk zurückgesetzt, oder der Tarif des
Kontos hat keinen API-Zugang.

**Lösung.** Kopiere das Token noch einmal aus sevDesk (Einstellungen → Benutzer → der Benutzer →
API-Token; 32 Zeichen, Ziffern und `a`–`f`). Liegt das Token im Schlüsselbund, leg es mit
`npx -y mcp-server-sevdesk token set <label>` neu ab und prüf es mit `token check <label>`. Ein
erneuter Versuch ohne Änderung hilft nicht.

## Schreibwerkzeuge fehlen

**Ursache.** Der Server zeigt dem Modell nur die Werkzeuge, die du aktiviert hast; Werkzeuge
oberhalb der aktivierten Stufen werden gar nicht erst aufgeführt. Prüf in dieser Reihenfolge:

1. **Stufen.** Voreingestellt ist `read`. Entwürfe brauchen `SEVDESK_ALLOW=write`, Fertigstellen
   und Zahlungen `commit`, E-Mail `external` ([Stufen](permissions.de.md#stufen)).
2. **Nur-Lesen.** `SEVDESK_READ_ONLY=1`, ein Profil mit `readOnly` oder der Schalter „Read only“
   der Erweiterung schalten jede schreibende Stufe ab, egal was in `SEVDESK_ALLOW` steht.
3. **Werkzeuggruppen.** `SEVDESK_TOOLSETS` begrenzt die Bereiche; ein Werkzeug außerhalb davon
   wird nicht angeboten ([Werkzeuggruppen](configuration.de.md#werkzeuggruppen)).
4. **Ordner.** Die E-Rechnungs-Werkzeuge brauchen `SEVDESK_FILE_DIRS`; das Speichern von PDFs,
   Belegdateien und Exporten braucht `SEVDESK_OUTPUT_DIR`. Ohne sie werden diese Werkzeuge nicht
   angeboten.

**Lösung.** Ändere die Einstellung und starte neu. Der Assistent darf ein fehlendes Werkzeug nicht
umgehen, und ein [Prompt](tools.md#prompts) nennt die Einstellung, die ein Schritt braucht, statt
ihn zu überspringen.

## Jeder Schreibvorgang liefert nur eine Vorschau

**Ursache.** `SEVDESK_DRY_RUN=1` ist gesetzt, im `env` des Clients oder im Profil. Jedes
Schreibwerkzeug gibt dann seine Vorschau mit dem Status `dry_run` zurück und sendet nichts. Ein
`dryRun: true` in einem einzelnen Aufruf bewirkt dasselbe für diesen Aufruf
([Probelauf](permissions.de.md#probelauf)).

**Lösung.** Entferne `SEVDESK_DRY_RUN`, sobald die Vorschauen stimmen, und starte neu.

## Kein Bestätigungsdialog erscheint

Werkzeuge der Stufe `write` und Probeläufe fragen nie: So ist es gewollt. Werkzeuge der Stufen
`commit` und `external` fragen immer, außer bei `SEVDESK_CONFIRM=off`. Wenn die Frage nicht bei dir
ankommt:

- **„this MCP client cannot show confirmation prompts“.** Das Werkzeug antwortet, dass `… needs the
user's approval, but this MCP client cannot show confirmation prompts (it does not support MCP
elicitation). Nothing was sent to sevDesk.` Setz `SEVDESK_CONFIRM=browser` (in der
  Claude-Desktop-Erweiterung: die Einstellung „Confirmation“) und starte neu. Welche Clients das
  brauchen: [Bestätigung je Client](clients.de.md#bestätigung-je-client).
- **Claude Code im Print-Modus** (`claude -p`) kann den Dialog nicht anzeigen. Arbeite dort mit
  Probeläufen oder mit `SEVDESK_CONFIRM=browser`.
- **Browser-Modus, aber keine Seite geöffnet.** Das Ergebnis sagt dann, dass der Link im Log des
  Servers steht. Öffne ihn von dort. Mit `SEVDESK_CONFIRM_OPEN=0` öffnet der Server die Seite nie
  selbst. In Docker würde die Seite innerhalb des Containers lauschen: Nimm dort einen Client mit
  Elicitation.
- **„approval requests are already waiting“.** Höchstens fünf Freigaben warten gleichzeitig. Gib
  die offenen frei oder lehne sie ab, oder warte, bis sie nach 10 Minuten ablaufen.
- **Nach der Freigabe wird erneut gefragt.** Nach der Freigabe im Browser bittest du den
  Assistenten, das Werkzeug noch einmal mit denselben Argumenten aufzurufen. Hat sich der Datensatz
  inzwischen geändert, verlangt der Server eine neue Freigabe
  (`The record changed since the last approval request`); außerdem gilt eine Freigabe nur einmal
  und 10 Minuten lang.
- **„the local approval page could not be started“.** Das Log nennt den Grund. Versuch es erneut,
  oder wechsle zu `SEVDESK_CONFIRM=elicit`, wenn dein Client das unterstützt.

Wie jede Art funktioniert: [Bestätigungsarten](permissions.de.md#bestätigungsarten).

## Ratenbegrenzung und Zeitüberschreitungen

**„sevDesk is rate-limiting requests (HTTP 429)“.** sevDesk veröffentlicht kein Limit. Der Server
sendet höchstens `SEVDESK_RATE_LIMIT` Anfragen pro Sekunde (voreingestellt 4) und 4 gleichzeitig
und wiederholt Lesezugriffe bis zu zweimal. Frag nicht nach vielen Dingen parallel, oder senke
`SEVDESK_RATE_LIMIT`, zum Beispiel auf `2`.

**„sevDesk did not answer within 30 s (SEVDESK_TIMEOUT_MS)“.** Grenz die Anfrage ein (ein kürzerer
Zeitraum, ein Monat statt eines Jahres), oder erhöhe `SEVDESK_TIMEOUT_MS` (bis `300000`). Die
Umsatzsteuer-Auswertung und die Gewinn- und Verlustrechnung lesen jedes Dokument einzeln und sind
bei langen Zeiträumen langsam
([Auswertungen](guides/evaluations.de.md#wie-weit-du-dich-darauf-verlassen-kannst)).

**Nach einer Zeitüberschreitung bei einem Schreibvorgang.** Schreibvorgänge werden nie wiederholt,
eine Zeitüberschreitung kann also keine Dublette erzeugen, aber die Änderung kann ausgeführt worden
sein oder auch nicht. Das Werkzeug sagt das; prüf den Datensatz mit einem Lesewerkzeug, bevor du
erneut fragst.

**„Could not reach sevDesk (network error)“.** Prüf die Internetverbindung und, falls du sie
gesetzt hast, `SEVDESK_BASE_URL`.

Beide Einstellungen: [Konfiguration](configuration.de.md#verbindung).

## Der Schlüsselbund lässt sich nicht lesen

Diese Meldungen erscheinen unter den Konfigurationsproblemen, mit dem Präfix
`SEVDESK_API_TOKEN_KEYCHAIN:`, oder bei den `token`-Befehlen.

| Meldung                                                                                    | Lösung                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `No token is stored under keychain label "work". …`                                        | Leg es mit `npx -y mcp-server-sevdesk token set work` ab; die Bezeichnung muss genau übereinstimmen.                |
| Linux: `… or the Secret Service (GNOME Keyring, KWallet) is locked or not running.`        | Entsperre oder starte den Schlüsselbund. Auf einem Rechner ohne grafische Oberfläche nimm `SEVDESK_API_TOKEN_FILE`. |
| `secret-tool was not found. …`                                                             | Installiere `libsecret-tools` (Debian, Ubuntu) oder `libsecret` (Fedora, Arch).                                     |
| macOS: `The macOS keychain refused access …`                                               | Versuch es erneut und wähle im Dialog „Erlauben“.                                                                   |
| macOS: `The macOS keychain is locked and cannot ask for its password here …`               | Entsperre ihn mit `security unlock-keychain` (zum Beispiel über SSH).                                               |
| Windows: `… requires Windows PowerShell in FullLanguage mode; Constrained Language Mode …` | Nimm `SEVDESK_API_TOKEN_FILE` oder die Claude-Desktop-Erweiterung.                                                  |
| Windows: `Windows PowerShell was not found …` oder `… needs SystemRoot …`                  | Stell Windows PowerShell oder die Variable `SystemRoot` wieder her; PowerShell 7 wird nicht verwendet.              |
| `The keychain did not answer in time. …`                                                   | Erlaube den Zugriffsdialog, falls einer offen ist; unter Linux prüf, ob der Secret Service läuft und entsperrt ist. |

Aus einem Docker-Container ist der Schlüsselbund nicht erreichbar; übergib dort eine Token-Datei.
Wie der Schlüsselbund verwendet wird:
[Das Token im Schlüsselbund ablegen](configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen).

## Ein Profil wird abgelehnt

| Meldung                                                                       | Lösung                                                                                         |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SEVDESK_PROFILE is set to "work", but there is no profiles file at …`        | Leg die Datei dort an, oder lass `SEVDESK_PROFILES_PATH` auf deine zeigen.                     |
| `SEVDESK_PROFILE: there is no profile "work" in … Available: …`               | Nimm einen der aufgeführten Namen.                                                             |
| `SEVDESK_ALLOW is set in the environment and by profile "work" (allow). …`    | Setz es nur an einer Stelle. Nur `SEVDESK_READ_ONLY=1` und `SEVDESK_DRY_RUN=1` dürfen bleiben. |
| `Other users can change the profiles file …` oder `… belongs to another user` | `chmod go-w` auf die Datei und ihren Ordner, und behalte beide in deinem eigenen Ordner.       |

`npx -y mcp-server-sevdesk profiles list` zeigt jedes Profil, ohne ein Token auszugeben. Profile
funktionieren nur über stdio. Details: [Profile](configuration/profiles.de.md#profile).

## Immer noch nicht gelöst

Frag in den [GitHub Discussions](https://github.com/jaylann/mcp-server-sevdesk/discussions/categories/q-a)
nach oder eröffne ein [Issue](https://github.com/jaylann/mcp-server-sevdesk/issues/new/choose) mit
der Version des Servers (`npx -y mcp-server-sevdesk --version`), deinem Client und dem Fehlertext.
Gib nie dein Token oder echte Kundendaten an.

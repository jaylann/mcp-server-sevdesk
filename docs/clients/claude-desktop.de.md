<!-- translated-from: docs/clients/claude-desktop.md sha256:503f30142ab6 -->

# Claude Desktop

Diese Seite richtet den Server in Claude Desktop unter macOS und Windows ein: mit der Erweiterung,
mit der Konfigurationsdatei oder als Connector zu einem Server, den du selbst betreibst. Die
anderen Clients findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge** des lokalen Servers, den Claude Desktop über stdio startet.
- **Bestätigungen:** Claude Desktop zeigt keine Bestätigung im Chat an (geprüft im November 2026).
  Verwende `SEVDESK_CONFIRM=browser`, eine Freigabeseite in deinem Browser; das ist der Standard
  der Erweiterung ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)).
- **Fernzugriff:** Ein benutzerdefinierter Connector aus claude.ai steht auch in Claude Desktop zur
  Verfügung, wenn es mit demselben Konto angemeldet ist ([Fernzugriff einrichten](#fernzugriff-einrichten)).

## Lokal einrichten

### Die Erweiterung

Die `.mcpb`-Erweiterung bündelt den Server mit allem, was er braucht, und läuft auf dem
eingebauten Node.js von Claude Desktop. Unter macOS und Windows ist sie der einfachste Weg zur
Installation.

1. Lade `mcp-server-sevdesk-<version>.mcpb` aus dem
   [neuesten Release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest) herunter.
2. Doppelklicke auf die Datei, ziehe sie in das Fenster von Claude Desktop oder wähle **Settings →
   Extensions → Advanced settings → Install Extension…** und dann die Datei.
3. Füge dein sevDesk-API-Token ein und aktiviere die Erweiterung. Alles andere ist optional: Die
   Erweiterung startet nur lesend.

Claude Desktop bewahrt das Token im sicheren Speicher deines Betriebssystems auf (Schlüsselbund
unter macOS, Anmeldeinformationsverwaltung unter Windows). Die Einstellungen änderst du später
unter **Settings → Extensions → sevDesk**:

| Einstellung       | Variable             | Bedeutung                                                                                                                                                                                                           |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sevDesk API token | `SEVDESK_API_TOKEN`  | Pflicht.                                                                                                                                                                                                            |
| Permission tiers  | `SEVDESK_ALLOW`      | `read` (Standard), `write`, `commit`, `external` oder `all`, durch Kommas getrennt.                                                                                                                                 |
| Read only         | `SEVDESK_READ_ONLY`  | Nur Lesewerkzeuge, unabhängig von den Stufen.                                                                                                                                                                       |
| Dry run           | `SEVDESK_DRY_RUN`    | Schreibwerkzeuge geben nur eine Vorschau zurück.                                                                                                                                                                    |
| Confirmation      | `SEVDESK_CONFIRM`    | `browser` (Standard: Eine Freigabeseite öffnet sich in deinem Browser) oder `elicit` (Claude Desktop zeigt dafür keinen Dialog). In der Erweiterung lässt sich die Bestätigung nicht abschalten.                    |
| Toolsets          | `SEVDESK_TOOLSETS`   | Leer lädt alle außer `advanced`.                                                                                                                                                                                    |
| Receipt folder    | `SEVDESK_FILE_DIRS`  | Ein Ordner, aus dem Belege und E-Rechnungen gelesen werden dürfen.                                                                                                                                                  |
| Output folder     | `SEVDESK_OUTPUT_DIR` | Ein Ordner, in dem PDFs und Exporte gespeichert werden dürfen.                                                                                                                                                      |
| Audit log         | `SEVDESK_AUDIT_LOG`  | Pfad eines lokalen Protokolls schreibender Aufrufe im Format JSON Lines; Einträge werden angehängt, Geheimnisse entfernt. Leer: kein Audit-Log. Ist die Datei nicht beschreibbar, werden Schreibvorgänge abgelehnt. |

So prüfst du einen Download vor der Installation:
`gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann`. Ein neueres Release
installierst du auf dieselbe Weise über das alte. Was das Paket enthält und wie das Token
übergeben wird: [Claude-Desktop-Erweiterung](../security/local.de.md#claude-desktop-erweiterung).

### Die Konfigurationsdatei

Ohne die Erweiterung startet Claude Desktop den Server aus seiner Konfigurationsdatei; dafür
brauchst du Node.js 22.12 oder neuer. Öffne sie mit **Settings → Developer → Edit Config**; sie
liegt unter

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>",
        "SEVDESK_CONFIRM": "browser"
      }
    }
  }
}
```

Beende Claude Desktop vollständig und starte es neu. Um das Token aus der Datei herauszuhalten,
verwende stattdessen `SEVDESK_API_TOKEN_KEYCHAIN` oder `SEVDESK_API_TOKEN_FILE`
([Profile und Schlüsselbund](../configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen)).

## Fernzugriff einrichten

Um einen Server zu nutzen, den du im [Fernzugriff](../remote.de.md) betreibst, fügst du ihn in
claude.ai als benutzerdefinierten Connector hinzu (OAuth-Modus). Der Connector steht dann in Claude
Desktop zur Verfügung, wenn es mit demselben Konto angemeldet ist. Die Schritte und was sich für
Bestätigungen und Dateien ändert, stehen unter [claude.ai und die Claude-Apps](claude-ai.de.md).

## Stolperfallen

- **Logs.** Das Log des Servers liegt unter macOS in
  `~/Library/Logs/Claude/mcp-server-sevdesk.log` und unter Windows in `%APPDATA%\Claude\logs`.
- **„Server disconnected“.** Claude Desktop zeigt stderr des Servers nicht an. Bei einer
  ungültigen Konfiguration startet der Server deshalb trotzdem und nennt die Probleme über sein
  einziges Werkzeug, `sevdesk_setup_problem`; frag den Assistenten, welche Einstellung du
  korrigieren musst ([Kommandozeile](../configuration.de.md#kommandozeile)).
- **Node.js nicht gefunden.** Über sein Symbol gestartet, sieht Claude Desktop den `PATH` deiner
  Shell unter Umständen nicht. Gib den vollständigen Pfad von `npx` als Befehl an oder verwende die
  Erweiterung.
- **Schlüsselbund unter Windows.** `SEVDESK_API_TOKEN_KEYCHAIN` braucht Windows PowerShell im
  FullLanguage-Modus. Fehlt es oder ist es eingeschränkt, verwende die Erweiterung oder
  `SEVDESK_API_TOKEN_FILE`.

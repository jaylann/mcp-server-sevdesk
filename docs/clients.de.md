<!-- translated-from: docs/clients.md sha256:6c6e9f02e833 -->

# Clients

Jeder MCP-Client, der ein lokales Programm starten kann, startet diesen Server auf dieselbe Weise:
mit dem Befehl `npx -y mcp-server-sevdesk` und deinem sevDesk-API-Token in der Umgebung. Clients,
die kein Programm starten können, etwa claude.ai und die mobilen Claude-Apps, verbinden sich mit
einem Server, den du im [Fernzugriff](remote.de.md) betreibst. Diese Seite zeigt, welche Clients
funktionieren und wie sie dich um Bestätigung bitten; jeder Client hat eine eigene Seite mit der
genauen Einrichtung, lokal und im Fernzugriff.

Bevor du beginnst:

- **Node.js 22.12 oder neuer** für `npx`. Die
  [Claude-Desktop-Erweiterung](clients/claude-desktop.de.md#die-erweiterung) und
  [Docker](#docker-statt-npx) brauchen keins.
- **Ein sevDesk-API-Token**, am besten eines eigenen Benutzers
  ([Schnellstart](quickstart.de.md#bevor-du-beginnst)).

Die Beispiele schreiben das Token selbst als `SEVDESK_API_TOKEN` in die Konfiguration. Um es aus
der Datei herauszuhalten, ersetze diese Zeile durch `"SEVDESK_API_TOKEN_KEYCHAIN": "<label>"`,
nachdem du das Token mit `npx -y mcp-server-sevdesk token set <label>` abgelegt hast (macOS,
Linux und Windows), oder durch `"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"`
([Profile und Schlüsselbund](configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen)).
Jede weitere Einstellung kommt in denselben `env`-Block ([Konfiguration](configuration.de.md));
ohne weitere Einstellungen liest der Server nur.

## Client-Seiten

| Client                                                   | Lokal (stdio)                        | Fernzugriff (HTTP)                    |
| -------------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| [Claude Desktop](clients/claude-desktop.de.md)           | Erweiterung oder Konfigurationsdatei | über einen Connector in claude.ai     |
| [Claude Code](clients/claude-code.de.md)                 | `claude mcp add` oder das Plugin     | OAuth oder Bearer                     |
| [claude.ai und die Claude-Apps](clients/claude-ai.de.md) | nicht möglich                        | OAuth (benutzerdefinierter Connector) |
| [Cursor](clients/cursor.de.md)                           | `mcp.json`                           | Bearer                                |
| [VS Code](clients/vscode.de.md)                          | `mcp.json`                           | Bearer                                |
| [Windsurf](clients/windsurf.de.md)                       | `mcp_config.json`                    | Bearer (allgemein)                    |
| [Codex](clients/codex.de.md)                             | `config.toml` oder `codex mcp add`   | Bearer (allgemein)                    |
| [Zed](clients/zed.de.md)                                 | `settings.json`                      | Bearer (allgemein)                    |

„Allgemein“ heißt: Jeder Client, der Streamable HTTP spricht und einen Header senden kann,
funktioniert, aber diese Dokumentation hat für diesen Client keinen getesteten Eintrag
([Andere Clients](#andere-clients)).

## Bestätigung je Client

Werkzeuge der Stufen `commit` und `external` (fertigstellen, buchen, stornieren, versenden) fragen
dich vorher ([Berechtigungen](permissions.de.md#bestätigungsarten)). Mit der Voreinstellung
`SEVDESK_CONFIRM=elicit` zeigt der Client die Frage im Chat an; dafür braucht er MCP-Elicitation.
Clients ohne diese Funktion brauchen `SEVDESK_CONFIRM=browser`, eine Freigabeseite in deinem
Browser.

| Client                                      | Bestätigung im Chat                | Einstellung                                   |
| ------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| Claude Code                                 | ja, in interaktiven Sitzungen      | `elicit` (Standard)                           |
| Cursor                                      | ja                                 | `elicit` (Standard)                           |
| VS Code (GitHub Copilot)                    | ja                                 | `elicit` (Standard)                           |
| Claude Desktop                              | nein (geprüft im November 2026)    | `browser` (Standard der Erweiterung)          |
| Codex                                       | nicht dokumentiert                 | `browser`                                     |
| Windsurf                                    | nicht dokumentiert                 | `browser`                                     |
| Zed                                         | nein                               | `browser`                                     |
| claude.ai und die Claude-Apps (Fernzugriff) | nein, zum Zeitpunkt des Schreibens | `browser` (das Freigabe-Postfach des Servers) |

Die Funktionen der Clients ändern sich häufig; diese Tabelle gibt ihre Dokumentation vom November
2026 wieder. Nichts geht unbemerkt schief: Kann ein Client nicht fragen, antwortet das Werkzeug mit
einem Fehler, der genau das sagt, und nichts wird an sevDesk gesendet. Werkzeuge der Stufe `write`
und Probeläufe brauchen in keinem Client eine Bestätigung.

Über HTTP braucht `elicit` außerdem einen Client, der das Protokoll 2026-07-28 spricht und
Formular-Elicitation unterstützt; bei jedem anderen Client setzt du `SEVDESK_CONFIRM=browser` auf
dem Server und gibst in seinem [Freigabe-Postfach](remote/approvals.de.md) frei
([Konfiguration des Fernzugriffs](remote/configuration.de.md)).

## Docker statt npx

Das Container-Image führt denselben Server aus, ohne Node.js auf deinem Rechner. `--stdio` ersetzt
das voreingestellte `--http` des Images:

<!-- x-release-please-start-version -->

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--read-only",
        "-e",
        "SEVDESK_API_TOKEN",
        "ghcr.io/jaylann/mcp-server-sevdesk:1.6.0",
        "--stdio"
      ],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

<!-- x-release-please-end -->

- `-e NAME` ohne Wert reicht die Variable aus `env` an den Container weiter. Ergänze ein `-e`
  pro Einstellung, zum Beispiel `"-e", "SEVDESK_ALLOW"`.
- Ordner müssen eingebunden und mit ihrem Pfad im Container angegeben werden, zum Beispiel
  `"-v", "/Users/me/Belege:/belege:ro", "-e", "SEVDESK_FILE_DIRS=/belege"`.
- Der Schlüsselbund des Betriebssystems ist aus einem Container nicht erreichbar; übergib das
  Token oder binde eine Token-Datei ein und setze `SEVDESK_API_TOKEN_FILE`.
- `SEVDESK_CONFIRM=browser` funktioniert auf diese Weise nicht: Die Freigabeseite würde im
  Container lauschen. Verwende einen Client mit Elicitation.
- Das Tag nennt genau ein Release, nämlich das, mit dem diese Seite veröffentlicht wurde: Das Image
  ändert sich erst, wenn du das Tag änderst. Nur das neueste Release erhält Sicherheitskorrekturen;
  passe das Tag also an, wenn ein neues Release erscheint. Das Image hat außerdem ein Tag für
  die Minor-Linie (nur Haupt- und Nebenversionsnummer), das zu jedem neuen Patch-Release
  weiterwandert, und `latest`; Docker holt ein weitergewandertes Tag erst bei `docker pull` neu.
  Prüfe das Image vorher ([Das Image prüfen](remote/deployment.de.md#das-image-prüfen)).

## Andere Clients

### Lokal

Jeder Client, der einen lokalen MCP-Server über stdio starten kann, funktioniert: Befehl `npx`,
Argumente `-y mcp-server-sevdesk`, das Token in der Umgebung. Prüfe zwei Dinge:

- **Bestätigungen.** Unterstützt der Client keine MCP-Elicitation, setze
  `SEVDESK_CONFIRM=browser`, bevor du `commit` oder `external` aktivierst.
- **Node.js.** `npx` muss Node.js 22.12 oder neuer finden. Clients, die über ein Desktop-Symbol
  gestartet werden, sehen den `PATH` deiner Shell unter Umständen nicht; gib dann den
  vollständigen Pfad von `npx` als Befehl an.

### Fernzugriff

Clients auf einem anderen Rechner oder solche, die ein Team gemeinsam nutzt, verbinden sich mit
einem Server im [Fernzugriff](remote.de.md). Der MCP-Endpunkt ist immer `<public URL>/mcp`, zum
Beispiel `https://mcp.example.com/mcp`.

- **Bearer-Modus:** Jeder Client, der Streamable HTTP spricht und einen Header senden kann
  (`Authorization: Bearer <secret>`), funktioniert.
- **OAuth-Modus:** Ein Client braucht Client ID Metadata Documents; nimm den Host seiner
  `client_id`-URL in `SEVDESK_OAUTH_CLIENTS` auf. Ein Client, der nur Dynamic Client Registration
  unterstützt, kann den OAuth-Modus nicht nutzen; verwende für ihn den Bearer-Modus
  ([Bearer oder OAuth](remote.de.md#bearer-oder-oauth)).

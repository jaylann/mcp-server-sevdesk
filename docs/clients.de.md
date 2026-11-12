<!-- translated-from: docs/clients.md sha256:2cb01a4bfa63 -->

# Clients

Jeder MCP-Client, der ein lokales Programm starten kann, startet diesen Server auf dieselbe Weise:
mit dem Befehl `npx -y mcp-server-sevdesk` und Ihrem sevDesk-API-Token in der Umgebung. Diese
Seite zeigt das genaue Format für jeden Client. Clients, die kein Programm starten können, etwa
claude.ai und die mobilen Claude-Apps, verbinden sich mit einem Server, den Sie im
[Fernzugriff](remote.de.md) betreiben.

Bevor Sie beginnen:

- **Node.js 22.12 oder neuer** für `npx`. Die [Claude-Desktop-Erweiterung](#die-erweiterung) und
  [Docker](#docker-statt-npx) brauchen keins.
- **Ein sevDesk-API-Token**, am besten eines eigenen Benutzers
  ([Schnellstart](quickstart.de.md#bevor-sie-beginnen)).

Die Beispiele schreiben das Token selbst als `SEVDESK_API_TOKEN` in die Konfiguration. Um es aus
der Datei herauszuhalten, ersetzen Sie diese Zeile durch `"SEVDESK_API_TOKEN_KEYCHAIN": "<label>"`,
nachdem Sie das Token mit `npx -y mcp-server-sevdesk token set <label>` abgelegt haben (macOS und
Linux), oder durch `"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"`
([Konfiguration](configuration.de.md#das-token-im-schlüsselbund-ablegen)). Jede weitere
Einstellung kommt in denselben `env`-Block; ohne weitere Einstellungen liest der Server nur.

## Bestätigung je Client

Werkzeuge der Stufen `commit` und `external` (fertigstellen, buchen, stornieren, versenden) fragen
Sie vorher ([Berechtigungen](permissions.de.md#bestätigungsarten)). Mit der Voreinstellung
`SEVDESK_CONFIRM=elicit` zeigt der Client die Frage im Chat an; dafür braucht er MCP-Elicitation.
Clients ohne diese Funktion brauchen `SEVDESK_CONFIRM=browser`, eine Freigabeseite in Ihrem
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

## Claude Desktop

### Die Erweiterung

Die `.mcpb`-Erweiterung bündelt den Server mit allem, was er braucht, und läuft auf dem
eingebauten Node.js von Claude Desktop. Unter macOS und Windows ist sie der einfachste Weg zur
Installation.

1. Laden Sie `mcp-server-sevdesk-<version>.mcpb` aus dem
   [neuesten Release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest) herunter.
2. Doppelklicken Sie auf die Datei, ziehen Sie sie in das Fenster von Claude Desktop oder wählen
   Sie **Settings → Extensions → Advanced settings → Install Extension…** und dann die Datei.
3. Fügen Sie Ihr sevDesk-API-Token ein und aktivieren Sie die Erweiterung. Alles andere ist
   optional: Die Erweiterung startet nur lesend.

Claude Desktop bewahrt das Token im sicheren Speicher Ihres Betriebssystems auf (Schlüsselbund
unter macOS, Anmeldeinformationsverwaltung unter Windows). Die Einstellungen ändern Sie später
unter **Settings → Extensions → sevDesk**:

| Einstellung       | Variable             | Bedeutung                                                                                                                                                                                                           |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sevDesk API token | `SEVDESK_API_TOKEN`  | Pflicht.                                                                                                                                                                                                            |
| Permission tiers  | `SEVDESK_ALLOW`      | `read` (Standard), `write`, `commit`, `external` oder `all`, durch Kommas getrennt.                                                                                                                                 |
| Read only         | `SEVDESK_READ_ONLY`  | Nur Lesewerkzeuge, unabhängig von den Stufen.                                                                                                                                                                       |
| Dry run           | `SEVDESK_DRY_RUN`    | Schreibwerkzeuge geben nur eine Vorschau zurück.                                                                                                                                                                    |
| Confirmation      | `SEVDESK_CONFIRM`    | `browser` (Standard: Eine Freigabeseite öffnet sich in Ihrem Browser) oder `elicit` (Claude Desktop zeigt dafür keinen Dialog). In der Erweiterung lässt sich die Bestätigung nicht abschalten.                     |
| Toolsets          | `SEVDESK_TOOLSETS`   | Leer lädt alle außer `advanced`.                                                                                                                                                                                    |
| Receipt folder    | `SEVDESK_FILE_DIRS`  | Ein Ordner, aus dem Belege und E-Rechnungen gelesen werden dürfen.                                                                                                                                                  |
| Output folder     | `SEVDESK_OUTPUT_DIR` | Ein Ordner, in dem PDFs und Exporte gespeichert werden dürfen.                                                                                                                                                      |
| Audit log         | `SEVDESK_AUDIT_LOG`  | Pfad eines lokalen Protokolls schreibender Aufrufe im Format JSON Lines; Einträge werden angehängt, Geheimnisse entfernt. Leer: kein Audit-Log. Ist die Datei nicht beschreibbar, werden Schreibvorgänge abgelehnt. |

So prüfen Sie einen Download vor der Installation:
`gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann`. Ein neueres Release
installieren Sie auf dieselbe Weise über das alte.

### Die Konfigurationsdatei

Ohne die Erweiterung startet Claude Desktop den Server aus seiner Konfigurationsdatei. Öffnen Sie
sie mit **Settings → Developer → Edit Config**; sie liegt unter

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

Beenden Sie Claude Desktop vollständig und starten Sie es neu. Das Log des Servers liegt unter
macOS in `~/Library/Logs/Claude/mcp-server-sevdesk.log` und unter Windows in
`%APPDATA%\Claude\logs`.

## Claude Code

Tragen Sie den Server für alle Ihre Projekte ein (`--scope user`), mit dem Token aus dem
Schlüsselbund:

```bash
npx -y mcp-server-sevdesk token set work
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Weitere Einstellungen sind weitere `--env NAME=value`-Optionen vor `--scope`. Alles nach `--` ist
der Befehl, den Claude Code ausführt. Vermeiden Sie `--env SEVDESK_API_TOKEN=<token>` auf der
Kommandozeile: Das Token bleibt sonst in Ihrer Shell-Historie. Mit `/mcp` sehen Sie in Claude Code
den Server und seine Werkzeuge.

In die gemeinsame `.mcp.json` eines Projekts gehört nie ein Token. Verweisen Sie stattdessen auf
eine Variable, die Claude Code aus der Umgebung einsetzt, in der es gestartet wurde; jede Person
exportiert dann die Bezeichnung ihres eigenen Schlüsselbund-Eintrags:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": { "SEVDESK_API_TOKEN_KEYCHAIN": "${SEVDESK_API_TOKEN_KEYCHAIN}" }
    }
  }
}
```

Die [Prompts](../README.de.md#prompts) des Servers erscheinen im `/`-Menü als
`/sevdesk:month_end_close (MCP)`; `/mcp__sevdesk__month_end_close 2026-10` führt einen mit einem
Argument aus. Bestätigungen erscheinen in interaktiven Sitzungen als Dialog; im Print-Modus
(`claude -p`) verwenden Sie Probeläufe oder `SEVDESK_CONFIRM=browser`.

### Das Plugin

Das Repository ist zugleich ein Plugin-Marktplatz für Claude Code. Das Plugin `sevdesk` startet
diesen Server und bringt einen Buchhaltungs-Skill mit: deutsche Steuerregeln und die passenden
Steuerregeln in sevDesk (einschließlich §13b Reverse Charge und §19 Kleinunternehmer), gängige
SKR03- und SKR04-Konten, GoBD, die E-Rechnungspflichten und Abläufe Schritt für Schritt.

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

Das Plugin startet das Release, zu dem es gehört (`npx -y mcp-server-sevdesk@<version>`), damit
nie eine neue npm-Version läuft, bevor Sie das Plugin aktualisieren. Es übergibt die
`SEVDESK_*`-Variablen der Umgebung, in der Claude Code gestartet wurde, zum Beispiel aus Ihrem
Shell-Profil:

```bash
export SEVDESK_API_TOKEN_KEYCHAIN=work   # oder SEVDESK_API_TOKEN / SEVDESK_API_TOKEN_FILE
export SEVDESK_ALLOW=write               # optional; ohne die Variable nur lesend
```

## claude.ai und die Claude-Apps

claude.ai kann kein Programm auf Ihrem Rechner starten und verbindet sich daher mit einem Server,
den Sie im Fernzugriff mit OAuth betreiben: auf einer VM, einer Plattform wie Fly.io oder Ihrem
eigenen Rechner hinter einem Tunnel. Die
[Anleitung zum Fernzugriff](remote.de.md#schnellstart-oauth-mit-einem-benutzerdefinierten-connector-in-claudeai) führt
Schritt für Schritt hindurch. Danach in claude.ai: **Einstellungen → Connectors →
Benutzerdefinierten Connector hinzufügen**, mit der URL `https://<your host>/mcp`. Der Connector
steht auch in Claude Desktop und den mobilen Apps zur Verfügung, die mit demselben Konto angemeldet
sind.

claude.ai kann zum Zeitpunkt des Schreibens keine Bestätigungen im Chat anzeigen. Setzen Sie daher
`SEVDESK_CONFIRM=browser` auf dem Server, wenn Sie `commit` oder `external` aktivieren: Sie geben
dann im Freigabe-Postfach des Servers frei. Belege laden Sie über Seiten auf Ihrem Server hoch und
Exporte dort herunter; Sie öffnen diese Seiten über Links im Chat ([remote.de.md](remote.de.md#dateien-hochladen-und-herunterladen)).

## Cursor

In `~/.cursor/mcp.json` (alle Projekte) oder `.cursor/mcp.json` in einem Projekt:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

Halten Sie das Token aus einer Projektdatei heraus, die eingecheckt wird: Verwenden Sie
`SEVDESK_API_TOKEN_KEYCHAIN` oder `"${env:SEVDESK_API_TOKEN}"`, um es aus der Umgebung zu lesen,
in der Cursor gestartet wurde.

## VS Code

In `.vscode/mcp.json` in einem Arbeitsbereich oder in Ihrer Benutzerkonfiguration
(Befehlspalette: **MCP: Open User Configuration**). Der Eintrag unter `inputs` fragt das Token
einmal verdeckt ab, und VS Code speichert es sicher:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sevdesk-token",
      "description": "sevDesk API token",
      "password": true
    }
  ],
  "servers": {
    "sevdesk": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "${input:sevdesk-token}"
      }
    }
  }
}
```

Prompts starten Sie im Chat als `/sevdesk.month_end_close`.

## Windsurf

Windsurf führt seine MCP-Server in `mcp_config.json`; öffnen Sie die Datei aus den
MCP-Einstellungen von Cascade (ihr Speicherort hat sich zwischen Versionen geändert). Ergänzen Sie:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

`"${env:SEVDESK_API_TOKEN}"` liest das Token stattdessen aus der Umgebung. Aktualisieren Sie die
Serverliste in den MCP-Einstellungen oder starten Sie Windsurf neu.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.sevdesk]
command = "npx"
args = ["-y", "mcp-server-sevdesk"]

[mcp_servers.sevdesk.env]
SEVDESK_API_TOKEN_KEYCHAIN = "work"
```

Oder über die Kommandozeile:
`codex mcp add sevdesk --env SEVDESK_API_TOKEN_KEYCHAIN=work -- npx -y mcp-server-sevdesk`. Um
stattdessen Variablen aus der Umgebung weiterzugeben, in der Codex läuft, führen Sie sie auf:
`env_vars = ["SEVDESK_API_TOKEN"]`.

## Zed

In der `settings.json` von Zed (oder über **Settings → AI → MCP Servers → Add Server → Add Local
Server**):

```json
{
  "context_servers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": {
        "SEVDESK_API_TOKEN": "<your sevDesk API token>"
      }
    }
  }
}
```

Zed unterstützt Werkzeuge und Prompts, aber keine Elicitation: Setzen Sie
`SEVDESK_CONFIRM=browser`, bevor Sie `commit` oder `external` aktivieren.

## Docker statt npx

Das Container-Image führt denselben Server aus, ohne Node.js auf Ihrem Rechner. `--stdio` ersetzt
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
        "ghcr.io/jaylann/mcp-server-sevdesk:1.3.0",
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

- `-e NAME` ohne Wert reicht die Variable aus `env` an den Container weiter. Ergänzen Sie ein `-e`
  pro Einstellung, zum Beispiel `"-e", "SEVDESK_ALLOW"`.
- Ordner müssen eingebunden und mit ihrem Pfad im Container angegeben werden, zum Beispiel
  `"-v", "/Users/me/Belege:/belege:ro", "-e", "SEVDESK_FILE_DIRS=/belege"`.
- Der Schlüsselbund des Betriebssystems ist aus einem Container nicht erreichbar; übergeben Sie das
  Token oder binden Sie eine Token-Datei ein und setzen Sie `SEVDESK_API_TOKEN_FILE`.
- `SEVDESK_CONFIRM=browser` funktioniert auf diese Weise nicht: Die Freigabeseite würde im
  Container lauschen. Verwenden Sie einen Client mit Elicitation.
- Das Tag nennt genau ein Release, nämlich das, mit dem diese Seite veröffentlicht wurde: Das Image
  ändert sich erst, wenn Sie das Tag ändern. Nur das neueste Release erhält Sicherheitskorrekturen;
  passen Sie das Tag also an, wenn ein neues Release erscheint. Das Image hat außerdem ein Tag für
  die Minor-Linie (nur Haupt- und Nebenversionsnummer), das zu jedem neuen Patch-Release
  weiterwandert, und `latest`; Docker holt ein weitergewandertes Tag erst bei `docker pull` neu.
  Prüfen Sie das Image vorher ([SECURITY.de.md](../SECURITY.de.md#lieferkette)).

## Andere Clients

Jeder Client, der einen lokalen MCP-Server über stdio starten kann, funktioniert: Befehl `npx`,
Argumente `-y mcp-server-sevdesk`, das Token in der Umgebung. Prüfen Sie zwei Dinge:

- **Bestätigungen.** Unterstützt der Client keine MCP-Elicitation, setzen Sie
  `SEVDESK_CONFIRM=browser`, bevor Sie `commit` oder `external` aktivieren.
- **Node.js.** `npx` muss Node.js 22.12 oder neuer finden. Clients, die über ein Desktop-Symbol
  gestartet werden, sehen den `PATH` Ihrer Shell unter Umständen nicht; geben Sie dann den
  vollständigen Pfad von `npx` als Befehl an.

Clients auf einem anderen Rechner oder solche, die ein Team gemeinsam nutzt, verbinden sich mit
einem Server im Fernzugriff, mit einem Bearer-Geheimnis oder OAuth: siehe
[Clients verbinden](remote.de.md#clients-verbinden).

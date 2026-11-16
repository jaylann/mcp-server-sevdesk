<!-- translated-from: docs/clients/cursor.md sha256:82781a48e8a8 -->

# Cursor

Diese Seite richtet den Server in Cursor ein: lokal gestartet oder verbunden mit einem Server, den
du selbst betreibst. Die anderen Clients findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge** des lokalen Servers, den Cursor über stdio startet.
- **Bestätigungen** erscheinen im Chat, mit der Voreinstellung `SEVDESK_CONFIRM=elicit`
  ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)).
- **Fernzugriff:** Bearer-Modus ([Fernzugriff einrichten](#fernzugriff-einrichten)).

## Lokal einrichten

Cursor braucht Node.js 22.12 oder neuer für `npx`. In `~/.cursor/mcp.json` (alle Projekte) oder
`.cursor/mcp.json` in einem Projekt:

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

Jede weitere Einstellung kommt in denselben `env`-Block ([Konfiguration](../configuration.de.md));
ohne weitere Einstellungen liest der Server nur.

## Fernzugriff einrichten

Verbinde Cursor mit einem Bearer-Geheimnis mit einem Server, den du im
[Fernzugriff](../remote.de.md) betreibst. In `~/.cursor/mcp.json` (oder `.cursor/mcp.json` in einem
Projekt):

```json
{
  "mcpServers": {
    "sevdesk": {
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_BEARER_SECRET}" }
    }
  }
}
```

`${env:MCP_BEARER_SECRET}` liest das Geheimnis aus der Umgebung, in der Cursor gestartet wurde; so
bleibt es aus der Datei heraus. Über HTTP braucht eine Bestätigung im Chat außerdem einen Client,
der das Protokoll 2026-07-28 mit Formular-Elicitation spricht; sonst setzt du
`SEVDESK_CONFIRM=browser` auf dem Server und gibst in seinem
[Freigabe-Postfach](../remote/approvals.de.md) frei.

## Stolperfallen

- **Eingecheckte Projektdateien.** Halte das Token aus einer `.cursor/mcp.json` heraus, die
  eingecheckt wird: Verwende `SEVDESK_API_TOKEN_KEYCHAIN`
  ([Profile und Schlüsselbund](../configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen))
  oder `"${env:SEVDESK_API_TOKEN}"`, um es aus der Umgebung zu lesen, in der Cursor gestartet wurde.
- **Node.js nicht gefunden.** Über ein Desktop-Symbol gestartet, sieht Cursor den `PATH` deiner
  Shell unter Umständen nicht; gib dann den vollständigen Pfad von `npx` als Befehl an.

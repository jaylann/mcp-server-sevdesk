<!-- translated-from: docs/clients/vscode.md sha256:96f96c6fd3b9 -->

# VS Code

Diese Seite richtet den Server in VS Code mit GitHub Copilot ein: lokal gestartet oder verbunden
mit einem Server, den du selbst betreibst. Die anderen Clients findest du unter
[Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge und Prompts** des lokalen Servers, den VS Code über stdio startet. Prompts startest
  du im Chat als `/sevdesk.month_end_close`.
- **Bestätigungen** erscheinen im Chat, mit der Voreinstellung `SEVDESK_CONFIRM=elicit`
  ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)).
- **Fernzugriff:** Bearer-Modus ([Fernzugriff einrichten](#fernzugriff-einrichten)).

## Lokal einrichten

VS Code braucht Node.js 22.12 oder neuer für `npx`. Trage den Server in `.vscode/mcp.json` in einem
Arbeitsbereich ein oder in deiner Benutzerkonfiguration (Befehlspalette: **MCP: Open User
Configuration**). Der Eintrag unter `inputs` fragt das Token einmal verdeckt ab, und VS Code
speichert es sicher:

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

Jede weitere Einstellung kommt in denselben `env`-Block ([Konfiguration](../configuration.de.md));
ohne weitere Einstellungen liest der Server nur.

## Fernzugriff einrichten

Verbinde VS Code mit einem Bearer-Geheimnis mit einem Server, den du im
[Fernzugriff](../remote.de.md) betreibst. In `.vscode/mcp.json`, mit einer Passwortabfrage, damit
das Geheimnis nicht in der Datei steht:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sevdesk-mcp-bearer",
      "description": "Bearer secret of your sevDesk MCP server",
      "password": true
    }
  ],
  "servers": {
    "sevdesk": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${input:sevdesk-mcp-bearer}" }
    }
  }
}
```

Über HTTP braucht eine Bestätigung im Chat außerdem einen Client, der das Protokoll 2026-07-28 mit
Formular-Elicitation spricht; sonst setzt du `SEVDESK_CONFIRM=browser` auf dem Server und gibst in
seinem [Freigabe-Postfach](../remote/approvals.de.md) frei.

## Stolperfallen

- **Das JSON sieht anders aus.** VS Code verwendet `servers` mit einem `type` (`stdio` oder
  `http`), nicht das `mcpServers` der meisten anderen Clients.
- **Node.js nicht gefunden.** Über ein Desktop-Symbol gestartet, sieht VS Code den `PATH` deiner
  Shell unter Umständen nicht; gib dann den vollständigen Pfad von `npx` als Befehl an.

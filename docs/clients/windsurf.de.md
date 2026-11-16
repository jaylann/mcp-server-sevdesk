<!-- translated-from: docs/clients/windsurf.md sha256:fc3132e14885 -->

# Windsurf

Diese Seite richtet den Server in Windsurf ein: lokal gestartet oder verbunden mit einem Server, den
du selbst betreibst. Die anderen Clients findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge** des lokalen Servers, den Windsurf über stdio startet.
- **Bestätigungen:** Ob Windsurf Bestätigungen im Chat anzeigt (MCP-Elicitation), ist nicht
  dokumentiert. Setze `SEVDESK_CONFIRM=browser`, eine Freigabeseite in deinem Browser, bevor du
  `commit` oder `external` aktivierst ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)).
  Kann ein Client nicht fragen, antwortet das Werkzeug mit einem Fehler, der genau das sagt, und
  nichts wird an sevDesk gesendet.

## Lokal einrichten

Windsurf braucht Node.js 22.12 oder neuer für `npx`. Es führt seine MCP-Server in
`mcp_config.json`; öffne die Datei aus den MCP-Einstellungen von Cascade (ihr Speicherort hat sich
zwischen Versionen geändert). Ergänze:

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

`"${env:SEVDESK_API_TOKEN}"` liest das Token stattdessen aus der Umgebung. Aktualisiere die
Serverliste in den MCP-Einstellungen oder starte Windsurf neu. Jede weitere Einstellung kommt in
denselben `env`-Block ([Konfiguration](../configuration.de.md)).

## Fernzugriff einrichten

Ein Server, den du im [Fernzugriff](../remote.de.md) betreibst, funktioniert im Bearer-Modus mit
jedem Client, der Streamable HTTP spricht und einen Header senden kann: Die URL ist
`https://<host>/mcp`, der Header `Authorization: Bearer <secret>`. Diese Dokumentation hat dafür
keinen getesteten Eintrag für Windsurf; das Format für einen entfernten Server findest du in der
Dokumentation von Windsurf. Setze auf dem Server `SEVDESK_CONFIRM=browser` und gib in seinem
[Freigabe-Postfach](../remote/approvals.de.md) frei.

## Stolperfallen

- **Die Datei wandert.** Der Speicherort von `mcp_config.json` hat sich zwischen Windsurf-Versionen
  geändert; öffne sie über die MCP-Einstellungen statt über ihren Pfad.
- **Node.js nicht gefunden.** Über ein Desktop-Symbol gestartet, sieht Windsurf den `PATH` deiner
  Shell unter Umständen nicht; gib dann den vollständigen Pfad von `npx` als Befehl an.

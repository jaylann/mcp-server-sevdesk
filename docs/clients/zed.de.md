<!-- translated-from: docs/clients/zed.md sha256:c590d23945c4 -->

# Zed

Diese Seite richtet den Server in Zed ein: lokal gestartet oder verbunden mit einem Server, den du
selbst betreibst. Die anderen Clients findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge und Prompts** des lokalen Servers, den Zed über stdio startet.
- **Bestätigungen:** Zed unterstützt keine MCP-Elicitation und kann daher keine Bestätigungen im
  Chat anzeigen. Setze `SEVDESK_CONFIRM=browser`, eine Freigabeseite in deinem Browser, bevor du
  `commit` oder `external` aktivierst ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)).
  Kann ein Client nicht fragen, antwortet das Werkzeug mit einem Fehler, der genau das sagt, und
  nichts wird an sevDesk gesendet.

## Lokal einrichten

Zed braucht Node.js 22.12 oder neuer für `npx`. In der `settings.json` von Zed (oder über
**Settings → AI → MCP Servers → Add Server → Add Local Server**):

```json
{
  "context_servers": {
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

Jede weitere Einstellung kommt in denselben `env`-Block ([Konfiguration](../configuration.de.md));
ohne weitere Einstellungen liest der Server nur. Um das Token aus der Datei herauszuhalten,
verwende `SEVDESK_API_TOKEN_KEYCHAIN` oder `SEVDESK_API_TOKEN_FILE`
([Profile und Schlüsselbund](../configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen)).

## Fernzugriff einrichten

Ein Server, den du im [Fernzugriff](../remote.de.md) betreibst, funktioniert im Bearer-Modus mit
jedem Client, der Streamable HTTP spricht und einen Header senden kann: Die URL ist
`https://<host>/mcp`, der Header `Authorization: Bearer <secret>`. Diese Dokumentation hat dafür
keinen getesteten Eintrag für Zed; das Format für einen entfernten Server findest du in der
Dokumentation von Zed. Setze auf dem Server `SEVDESK_CONFIRM=browser` und gib in seinem
[Freigabe-Postfach](../remote/approvals.de.md) frei.

## Stolperfallen

- **`context_servers`, nicht `mcpServers`.** Zed benennt seine MCP-Server anders als die meisten
  anderen Clients.
- **Node.js nicht gefunden.** Über ein Desktop-Symbol gestartet, sieht Zed den `PATH` deiner Shell
  unter Umständen nicht; gib dann den vollständigen Pfad von `npx` als Befehl an.

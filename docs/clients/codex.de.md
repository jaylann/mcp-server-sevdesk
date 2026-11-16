<!-- translated-from: docs/clients/codex.md sha256:cb95d9d31f2a -->

# Codex

Diese Seite richtet den Server in Codex ein: lokal gestartet oder verbunden mit einem Server, den
du selbst betreibst. Die anderen Clients findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge** des lokalen Servers, den Codex über stdio startet.
- **Bestätigungen:** Ob Codex Bestätigungen im Chat anzeigt (MCP-Elicitation), ist nicht
  dokumentiert. Setze `SEVDESK_CONFIRM=browser`, eine Freigabeseite in deinem Browser, bevor du
  `commit` oder `external` aktivierst ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)).
  Kann ein Client nicht fragen, antwortet das Werkzeug mit einem Fehler, der genau das sagt, und
  nichts wird an sevDesk gesendet.

## Lokal einrichten

Codex braucht Node.js 22.12 oder neuer für `npx`. Lege das Token im Schlüsselbund ab
([Profile und Schlüsselbund](../configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen)):

```bash
npx -y mcp-server-sevdesk token set work
```

Dann in `~/.codex/config.toml`:

```toml
[mcp_servers.sevdesk]
command = "npx"
args = ["-y", "mcp-server-sevdesk"]

[mcp_servers.sevdesk.env]
SEVDESK_API_TOKEN_KEYCHAIN = "work"
SEVDESK_CONFIRM = "browser"
```

Oder über die Kommandozeile:

```bash
codex mcp add sevdesk --env SEVDESK_API_TOKEN_KEYCHAIN=work -- npx -y mcp-server-sevdesk
```

Um stattdessen Variablen aus der Umgebung weiterzugeben, in der Codex läuft, führe sie auf:
`env_vars = ["SEVDESK_API_TOKEN"]`. Jede weitere Einstellung kommt in dieselbe `env`-Tabelle
([Konfiguration](../configuration.de.md)).

## Fernzugriff einrichten

Ein Server, den du im [Fernzugriff](../remote.de.md) betreibst, funktioniert im Bearer-Modus mit
jedem Client, der Streamable HTTP spricht und einen Header senden kann: Die URL ist
`https://<host>/mcp`, der Header `Authorization: Bearer <secret>`. Diese Dokumentation hat dafür
keinen getesteten Eintrag für Codex; das Format für einen entfernten Server findest du in der
Dokumentation von Codex. Setze auf dem Server `SEVDESK_CONFIRM=browser` und gib in seinem
[Freigabe-Postfach](../remote/approvals.de.md) frei.

## Stolperfallen

- **`env` oder `env_vars`.** `[mcp_servers.sevdesk.env]` setzt Werte in der Datei; `env_vars`
  nennt nur Variablen, die Codex aus seiner eigenen Umgebung weitergibt.
- **Node.js nicht gefunden.** `npx` muss Node.js 22.12 oder neuer finden; sieht Codex den `PATH`
  deiner Shell nicht, gib den vollständigen Pfad von `npx` als Befehl an.

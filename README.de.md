# mcp-server-sevdesk (Deutsch)

**Ein auf Sicherheit ausgelegter [MCP](https://modelcontextprotocol.io)-Server für die
[sevDesk](https://sevdesk.de)-API.** KI-Assistenten (Claude, ChatGPT, Cursor, VS Code, …) können
damit Rechnungen, Belege, Banktransaktionen und Auswertungen lesen und bearbeiten – mit
Berechtigungen, die Sie festlegen, und einer menschlichen Bestätigung für alles, was rechtlich
bindend ist.

> [!WARNING]
> **Vorabversion, in aktiver Entwicklung.** Noch nichts veröffentlicht.

> [!NOTE]
> Inoffizielles Community-Projekt, nicht mit der sevdesk GmbH verbunden.

## Grundprinzipien

- **Standardmäßig nur lesend.** Schreibrechte werden stufenweise freigeschaltet
  (`write` → `commit` → `external`).
- **Echte Bestätigung durch Sie** vor dem Festschreiben, Verbuchen, Stornieren oder Versenden.
- **Keine versteckten Nebenwirkungen:** Eine PDF-Vorschau markiert keine Rechnung als versendet.
- **Probelauf:** Jedes Schreib-Tool versteht `dryRun: true` und zeigt dann nur genau an, was es
  tun würde. Schreibvorgänge werden nie wiederholt und auf Wunsch lokal protokolliert
  (`SEVDESK_AUDIT_LOG`).
- **sevDesk-Update 2.0:** Steuerregeln und Buchungskonten werden vor dem Senden geprüft.

## Claude-Code-Plugin

Das Repository ist zugleich ein Plugin-Marktplatz für Claude Code. Das Plugin `sevdesk` startet
diesen Server (in der zum Plugin passenden, festen Version) und bringt einen Buchhaltungs-Skill mit (Steuerregeln inkl. §13b und §19,
SKR03/SKR04-Konten, GoBD, E-Rechnung, Abläufe wie Beleg erfassen, Bankabgleich und
Umsatzsteuer-Voranmeldung prüfen):

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

Die Einstellungen (mindestens `SEVDESK_API_TOKEN`) kommen aus der Umgebung, in der Claude Code
gestartet wird; ohne `SEVDESK_ALLOW` bleibt der Server nur lesend.

## Fernzugriff (HTTP)

Mit `--http` läuft der Server als Webdienst, den Sie selbst betreiben (Docker-Image
`ghcr.io/jaylann/mcp-server-sevdesk`, Vorlagen für Docker Compose mit Caddy, Fly.io, Render und
Railway). So lässt er sich als benutzerdefinierter Connector in claude.ai (auch in den Claude-Apps)
oder aus Claude Code, Cursor und VS Code auf einem anderen Rechner nutzen. Ohne Anmeldeverfahren
(`SEVDESK_HTTP_AUTH`) startet er nicht:

- **`bearer`:** ein gemeinsames Geheimnis schützt ein sevDesk-Konto (das `SEVDESK_API_TOKEN` des
  Servers). Für Clients, die Sie selbst einrichten.
- **`oauth`:** der Server ist sein eigener OAuth-2.1-Autorisierungsserver. Wer sich verbindet,
  wählt auf einer Zustimmungsseite die Berechtigungsstufen und fügt sein sevDesk-Token einmal ein.
  Das Token steckt verschlüsselt in den Tokens des Clients; der Server speichert keins. Nur die
  Konten in `SEVDESK_OAUTH_ACCOUNTS` dürfen sich verbinden. claude.ai braucht diesen Modus.

In claude.ai: Einstellungen → Connectors → benutzerdefinierten Connector hinzufügen, mit der URL
`https://<Ihr Host>/mcp`.

Bindende Aktionen (Festschreiben, Verbuchen, Versenden) bestätigen Sie im Fernzugriff mit
`SEVDESK_CONFIRM=browser` im **Freigabe-Postfach** des Servers (`https://<Ihr Host>/approvals`).
Es zeigt nur dann etwas an, wenn der Browser das Konto nachgewiesen hat: über die
Zustimmungsseite oder durch Einfügen des sevDesk-Tokens.

Einrichtung, alle Einstellungen und Fehlersuche (auf Englisch): [docs/remote.md](docs/remote.md).

Die vollständige Dokumentation ist auf Englisch: [README.md](README.md).

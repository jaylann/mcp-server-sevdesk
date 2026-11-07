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

Die vollständige Dokumentation ist auf Englisch: [README.md](README.md).

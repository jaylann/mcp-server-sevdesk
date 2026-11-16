<!-- translated-from: docs/clients/claude-ai.md sha256:be86bdb479e2 -->

# claude.ai und die Claude-Apps

Diese Seite verbindet claude.ai, und damit auch Claude Desktop und die mobilen Claude-Apps, die mit
demselben Konto angemeldet sind, mit einem Server, den du selbst betreibst. Die anderen Clients
findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge**, über einen benutzerdefinierten Connector zu deinem Server im Fernzugriff.
- **Bestätigungen:** claude.ai kann zum Zeitpunkt des Schreibens keine Bestätigungen im Chat
  anzeigen. Setze `SEVDESK_CONFIRM=browser` auf dem Server, wenn du `commit` oder `external`
  aktivierst: Du gibst dann im [Freigabe-Postfach](../remote/approvals.de.md) des Servers frei.
- **Dateien:** Belege lädst du über Seiten auf deinem Server hoch und Exporte dort herunter; du
  öffnest diese Seiten über Links im Chat ([Dateien über HTTP](../remote/files.de.md)).
- **Jede App des Kontos:** Der Connector steht auch in Claude Desktop und den mobilen Apps zur
  Verfügung, die mit demselben Konto angemeldet sind.

## Lokal einrichten

Das gibt es nicht: claude.ai kann kein Programm auf deinem Rechner starten. Für Claude Desktop auf
deinem eigenen Rechner ist ein [lokaler Server](claude-desktop.de.md) die einfachere Wahl.

## Fernzugriff einrichten

claude.ai verbindet sich mit einem Server, den du im Fernzugriff mit OAuth betreibst
(`SEVDESK_HTTP_AUTH=oauth`): auf einer VM, einer Plattform wie Fly.io oder deinem eigenen Rechner
hinter einem Tunnel. Eine gehostete Instanz gibt es nicht.

1. Starte den Server. Der
   [Schnellstart für den Fernzugriff](../remote.de.md#schnellstart-oauth-mit-einem-benutzerdefinierten-connector-in-claudeai)
   führt Schritt für Schritt hindurch; die [Anleitung zur Bereitstellung](../remote/deployment.de.md)
   hat Vorlagen.
2. In claude.ai: **Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen**, mit der
   URL `https://<your host>/mcp`. Der MCP-Endpunkt ist immer `<public URL>/mcp`.
3. claude.ai öffnet die Zustimmungsseite auf deinem Server. Wähle die Stufen für diese Verbindung
   und füge dein sevDesk-API-Token einmal ein.

Der Connector steht dann in den Claude-Apps zur Verfügung, die mit demselben Konto angemeldet sind.

Um die Verbindung zu beenden, entfernst du den Connector in claude.ai; claude.ai verwirft dann
seine Tokens. [Den Zugang zu widerrufen](../remote/operations.de.md#zugriff-entziehen) beendet sie auch auf dem
Server.

## Stolperfallen

- **Nur OAuth.** Benutzerdefinierte Connectoren in claude.ai brauchen den OAuth-Modus; der
  Bearer-Modus ist für Clients, die du selbst einrichtest
  ([Bearer oder OAuth](../remote.de.md#bearer-oder-oauth)).
- **Nur aufgeführte Konten.** Im OAuth-Modus können sich nur die sevDesk-Konten in
  `SEVDESK_OAUTH_ACCOUNTS` verbinden; ein abgelehnter Benutzer sieht seine eigene Konto-ID auf der
  Zustimmungsseite ([Konfiguration des Fernzugriffs](../remote/configuration.de.md)).
- **Warnung beim Start.** Der Server warnt beim Start, wenn die Voreinstellung
  `SEVDESK_CONFIRM=elicit` mit `commit` oder `external` zusammentrifft, weil claude.ai über
  zustandsloses HTTP nicht gefragt werden kann.
- **Lange Auswertungen.** Über HTTP hört eine Auswertung nach etwa 90 Sekunden auf, Dokumente zu
  lesen, und sagt das; frag nach einem Monat statt nach einem Quartal oder Jahr.

<!-- translated-from: docs/quickstart.md sha256:cbf57934d030 -->

# Schnellstart

Diese Seite führt dich in etwa zehn Minuten von einem sevDesk-Konto zur ersten Antwort. Der Server
läuft auf deinem Rechner und wird von deinem MCP-Client gestartet (stdio). Um stattdessen claude.ai,
die mobilen Claude-Apps oder ein Team mit einem Server zu verbinden, lies
[Fernzugriff](remote.de.md).

## Bevor du beginnst

- **sevDesk mit API-Zugang.** Die sevDesk-API ist im Tarif Buchhaltung Pro enthalten; die
  kostenlose Testphase von sevDesk enthält sie ebenfalls.
- **Ein eigener sevDesk-Benutzer.** Ein sevDesk-API-Token hat vollen Zugriff auf das gesamte
  Konto, ohne einschränkbare Rechte und ohne Ablaufdatum. Lege einen Benutzer nur für den
  Assistenten an, damit du sein Token jederzeit zurücksetzen kannst, ohne deine eigene Anmeldung
  anzurühren.
- **Dessen API-Token.** Öffne in sevDesk Einstellungen → Benutzer, wähle diesen Benutzer
  und kopiere sein API-Token (32 Zeichen, Ziffern und `a`–`f`). Behandle es wie ein
  Passwort.
- **Node.js 22.12 oder neuer**, das `npx` mitbringt. Prüfe das mit `node --version`. Wer
  Claude Desktop nutzt, kommt mit der [Erweiterung](clients.de.md#die-erweiterung) ohne Node.js
  aus.
- **Ein MCP-Client**, zum Beispiel Claude Desktop, Claude Code, Cursor oder VS Code. Die
  [Anleitung für Clients](clients.de.md) nennt für jeden das genaue Format.

## 1. Den Server im Client eintragen

Dein Client startet den Server mit `npx -y mcp-server-sevdesk` und übergibt das Token in seiner
Umgebung. Die meisten Clients nehmen dieses JSON (der Dateiname unterscheidet sich je Client, siehe
[Clients](clients.de.md)):

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

In Claude Code ist es ein Befehl (Schritt 4 zeigt, wie das Token nicht in deiner Shell-Historie
landet):

```bash
claude mcp add --env SEVDESK_API_TOKEN=<your sevDesk API token> --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Starte den Client neu. Beim ersten Start wird das Paket heruntergeladen, was einige Sekunden
dauern kann. Um bei 1.x zu bleiben, wenn 2.0 erscheint, schreibe `mcp-server-sevdesk@1` statt
`mcp-server-sevdesk`.

## 2. Eine erste Frage stellen

Frag etwa:

> Wie ist mein sevDesk-Konto eingerichtet?

Der Assistent ruft `sevdesk_account_info` auf: die Version des Buchhaltungssystems (sevDesk-Update
2.0 oder das ältere System 1.0), ob du Kleinunternehmer bist, den Kontenrahmen (SKR03 oder SKR04),
die sevDesk-Benutzer und was der Server erlaubt. Er sollte melden, dass nur die Stufe `read`
aktiviert ist.

Probiere dann ein paar Lesezugriffe:

> Welche Rechnungen sind überfällig, und um wie viel?
>
> Fasse Umsatz und Kosten pro Monat für dieses Jahr zusammen.
>
> Welche Belege sind noch nicht bezahlt?

Nichts, was du in dieser Einrichtung fragst, kann deine Buchhaltung verändern: Der Server startet
nur lesend, und Werkzeuge, die schreiben, bekommt das Modell gar nicht erst zu sehen.

## 3. Schreiben freischalten, zuerst im Probelauf

Ergänze zwei Einstellungen, sodass der `env`-Block so aussieht, und starte den Client
neu:

```json
{
  "SEVDESK_API_TOKEN": "<your sevDesk API token>",
  "SEVDESK_ALLOW": "write",
  "SEVDESK_DRY_RUN": "1"
}
```

`write` ergänzt die Werkzeuge, die Entwürfe, Kontakte und Artikel anlegen und ändern. Mit
`SEVDESK_DRY_RUN=1` gibt jeder Schreibvorgang nur eine Vorschau dessen zurück, was er genau senden
würde. Frag:

> Erstelle einen Rechnungsentwurf für <einen Kunden> über 2 Stunden Beratung zu 120 EUR pro
> Stunde.

Die Antwort hat den Status `dry_run` und zeigt die Rechnung, die das Werkzeug anlegen würde. Wenn
die Vorschauen stimmen, entferne `SEVDESK_DRY_RUN` (einen Probelauf kannst du weiterhin für
jede einzelne Anfrage verlangen).

Die nächsten Stufen sind `commit` (fertigstellen, Zahlungen buchen, stornieren, festschreiben) und
`external` (per E-Mail versenden). Sie fragen dich vor jedem Aufruf. Dein Client muss diese Frage
anzeigen können, sonst wechselst du zu Freigaben im Browser: Prüfe
[Bestätigung je Client](clients.de.md#bestätigung-je-client), bevor du diese Stufen aktivierst,
und lies [Berechtigungen](permissions.de.md).

## 4. Das Token sicher aufbewahren

Ein Token in einer Konfigurationsdatei landet in Backups, auf Screenshots und manchmal in
Repositorys. Besser sind:

- **Der Schlüsselbund des Betriebssystems** (macOS, Linux, Windows). Lege das Token einmal ab und
  nenne danach nur noch seine Bezeichnung:

  ```bash
  npx -y mcp-server-sevdesk token set work
  ```

  und verwende `"SEVDESK_API_TOKEN_KEYCHAIN": "work"` statt `SEVDESK_API_TOKEN`. In Claude
  Code:
  `claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk`.

- **Eine Token-Datei**, die nur du lesen kannst:
  `"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"` (funktioniert überall, auch unter
  Windows).
- **Die Claude-Desktop-Erweiterung** bewahrt das Token im sicheren Speicher des Betriebssystems
  auf.
- **Profile** halten mehrere Konten oder Einrichtungen in einer Datei, jeweils mit eigener
  Token-Quelle, und wählen eines mit `SEVDESK_PROFILE` aus.

Einzelheiten: [Konfiguration](configuration.de.md#das-token-im-schlüsselbund-ablegen). Falls ein
Token nach außen gelangt sein könnte, setze es in sevDesk zurück; das alte Token funktioniert
dann sofort nicht mehr.

## Nächste Schritte

- [Clients](clients.de.md): die Einrichtung für deinen Client und welche Clients Bestätigungen
  anzeigen.
- [Berechtigungen](permissions.de.md): Stufen, Bestätigungen, Probelauf und Audit-Log.
- [Konfiguration](configuration.de.md): alle Einstellungen, Werkzeuggruppen, Profile und die
  Kommandozeile.
- [Werkzeugreferenz](tools.md): jedes Werkzeug und jeder Prompt mit seinen Argumenten.
- [Fernzugriff](remote.de.md): den Server für claude.ai, die mobilen Apps oder ein Team betreiben.
- [Häufige Fragen](faq.de.md): Daten und Datenschutz, Update 2.0, E-Rechnungen, DATEV.

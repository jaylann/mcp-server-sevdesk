<!-- translated-from: docs/quickstart.md sha256:d3168926564b -->

# Schnellstart

Diese Seite führt Sie in etwa zehn Minuten von einem sevDesk-Konto zur ersten Antwort. Der Server
läuft auf Ihrem Rechner und wird von Ihrem MCP-Client gestartet (stdio). Um stattdessen claude.ai,
die mobilen Claude-Apps oder ein Team mit einem Server zu verbinden, lesen Sie
[Fernzugriff](remote.de.md).

## Bevor Sie beginnen

- **sevDesk mit API-Zugang.** Die sevDesk-API ist im Tarif Buchhaltung Pro enthalten; die
  kostenlose Testphase von sevDesk enthält sie ebenfalls.
- **Ein eigener sevDesk-Benutzer.** Ein sevDesk-API-Token hat vollen Zugriff auf das gesamte
  Konto, ohne einschränkbare Rechte und ohne Ablaufdatum. Legen Sie einen Benutzer nur für den
  Assistenten an, damit Sie sein Token jederzeit zurücksetzen können, ohne Ihre eigene Anmeldung
  anzurühren.
- **Dessen API-Token.** Öffnen Sie in sevDesk Einstellungen → Benutzer, wählen Sie diesen Benutzer
  und kopieren Sie sein API-Token (32 Zeichen, Ziffern und `a`–`f`). Behandeln Sie es wie ein
  Passwort.
- **Node.js 22.12 oder neuer**, das `npx` mitbringt. Prüfen Sie das mit `node --version`. Wer
  Claude Desktop nutzt, kommt mit der [Erweiterung](clients.de.md#die-erweiterung) ohne Node.js
  aus.
- **Ein MCP-Client**, zum Beispiel Claude Desktop, Claude Code, Cursor oder VS Code. Die
  [Anleitung für Clients](clients.de.md) nennt für jeden das genaue Format.

## 1. Den Server im Client eintragen

Ihr Client startet den Server mit `npx -y mcp-server-sevdesk` und übergibt das Token in seiner
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

In Claude Code ist es ein Befehl (Schritt 4 zeigt, wie das Token nicht in Ihrer Shell-Historie
landet):

```bash
claude mcp add --env SEVDESK_API_TOKEN=<your sevDesk API token> --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Starten Sie den Client neu. Beim ersten Start wird das Paket heruntergeladen, was einige Sekunden
dauern kann. Um bei 1.x zu bleiben, wenn 2.0 erscheint, schreiben Sie `mcp-server-sevdesk@1` statt
`mcp-server-sevdesk`.

## 2. Eine erste Frage stellen

Fragen Sie etwa:

> Wie ist mein sevDesk-Konto eingerichtet?

Der Assistent ruft `sevdesk_account_info` auf: die Version des Buchhaltungssystems (sevDesk-Update
2.0 oder das ältere System 1.0), ob Sie Kleinunternehmer sind, den Kontenrahmen (SKR03 oder SKR04),
die sevDesk-Benutzer und was der Server erlaubt. Er sollte melden, dass nur die Stufe `read`
aktiviert ist.

Probieren Sie dann ein paar Lesezugriffe:

> Welche Rechnungen sind überfällig, und um wie viel?
>
> Fasse Umsatz und Kosten pro Monat für dieses Jahr zusammen.
>
> Welche Belege sind noch nicht bezahlt?

Nichts, was Sie in dieser Einrichtung fragen, kann Ihre Buchhaltung verändern: Der Server startet
nur lesend, und Werkzeuge, die schreiben, bekommt das Modell gar nicht erst zu sehen.

## 3. Schreiben freischalten, zuerst im Probelauf

Ergänzen Sie zwei Einstellungen, sodass der `env`-Block so aussieht, und starten Sie den Client
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
würde. Fragen Sie:

> Erstelle einen Rechnungsentwurf für <einen Kunden> über 2 Stunden Beratung zu 120 EUR pro
> Stunde.

Die Antwort hat den Status `dry_run` und zeigt die Rechnung, die das Werkzeug anlegen würde. Wenn
die Vorschauen stimmen, entfernen Sie `SEVDESK_DRY_RUN` (einen Probelauf können Sie weiterhin für
jede einzelne Anfrage verlangen).

Die nächsten Stufen sind `commit` (fertigstellen, Zahlungen buchen, stornieren, festschreiben) und
`external` (per E-Mail versenden). Sie fragen Sie vor jedem Aufruf. Ihr Client muss diese Frage
anzeigen können, sonst wechseln Sie zu Freigaben im Browser: Prüfen Sie
[Bestätigung je Client](clients.de.md#bestätigung-je-client), bevor Sie diese Stufen aktivieren,
und lesen Sie [Berechtigungen](permissions.de.md).

## 4. Das Token sicher aufbewahren

Ein Token in einer Konfigurationsdatei landet in Backups, auf Screenshots und manchmal in
Repositorys. Besser sind:

- **Der Schlüsselbund des Betriebssystems** (macOS, Linux). Legen Sie das Token einmal ab und
  nennen Sie danach nur noch seine Bezeichnung:

  ```bash
  npx -y mcp-server-sevdesk token set work
  ```

  und verwenden Sie `"SEVDESK_API_TOKEN_KEYCHAIN": "work"` statt `SEVDESK_API_TOKEN`. In Claude
  Code:
  `claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk`.

- **Eine Token-Datei**, die nur Sie lesen können:
  `"SEVDESK_API_TOKEN_FILE": "/absolute/path/to/token"` (funktioniert überall, auch unter
  Windows).
- **Die Claude-Desktop-Erweiterung** bewahrt das Token im sicheren Speicher des Betriebssystems
  auf.
- **Profile** halten mehrere Konten oder Einrichtungen in einer Datei, jeweils mit eigener
  Token-Quelle, und wählen eines mit `SEVDESK_PROFILE` aus.

Einzelheiten: [Konfiguration](configuration.de.md#das-token-im-schlüsselbund-ablegen). Falls ein
Token nach außen gelangt sein könnte, setzen Sie es in sevDesk zurück; das alte Token funktioniert
dann sofort nicht mehr.

## Nächste Schritte

- [Clients](clients.de.md): die Einrichtung für Ihren Client und welche Clients Bestätigungen
  anzeigen.
- [Berechtigungen](permissions.de.md): Stufen, Bestätigungen, Probelauf und Audit-Log.
- [Konfiguration](configuration.de.md): alle Einstellungen, Werkzeuggruppen, Profile und die
  Kommandozeile.
- [Werkzeugreferenz](tools.md): jedes Werkzeug und jeder Prompt mit seinen Argumenten.
- [Fernzugriff](remote.de.md): den Server für claude.ai, die mobilen Apps oder ein Team betreiben.
- [Häufige Fragen](faq.de.md): Daten und Datenschutz, Update 2.0, E-Rechnungen, DATEV.

<!-- translated-from: README.md sha256:13141cf1d2a1 -->

<img src="https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk/main/assets/icon.svg" alt="" width="96" height="96" align="right">

# mcp-server-sevdesk

[![npm](https://img.shields.io/npm/v/mcp-server-sevdesk)](https://www.npmjs.com/package/mcp-server-sevdesk)
[![CI](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jaylann/mcp-server-sevdesk/badge)](https://scorecard.dev/viewer/?uri=github.com/jaylann/mcp-server-sevdesk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Ein auf Sicherheit ausgelegter [Model-Context-Protocol](https://modelcontextprotocol.io)-Server
für die [sevDesk](https://sevdesk.de)-API.** KI-Assistenten (Claude, Cursor, VS Code, Codex, …)
lesen und bearbeiten damit Ihre Rechnungen, Belege, Kontoumsätze und Auswertungen, mit
Berechtigungen, die Sie festlegen, und einer Bestätigung durch einen Menschen für alles, was
rechtlich bindend ist.

**[Dokumentation](https://sevdeskmcp.lanfermann.dev)** · [Schnellstart](#schnellstart) ·
[Werkzeugreferenz](docs/tools.md) · [Releases](https://github.com/jaylann/mcp-server-sevdesk/releases) ·
🇬🇧 [English](README.md)

> [!NOTE]
> Dies ist ein **inoffizielles** Community-Projekt. Es ist nicht mit der sevdesk GmbH verbunden und
> wird von ihr weder empfohlen noch unterstützt. „sevDesk“ ist eine Marke ihres Inhabers.

## Auf einen Blick

Ein sevDesk-API-Token hat **vollen Zugriff auf das gesamte Konto**, und sevDesk hat keine
Testumgebung. Dieser Server ist um diese Tatsache herum gebaut:

- **Standardmäßig nur lesend.** Schreiben schalten Sie stufenweise frei (`write` → `commit` →
  `external`); Werkzeuge oberhalb Ihrer Stufe bekommt das Modell gar nicht erst zu sehen.
- **Echte Bestätigung durch einen Menschen.** Fertigstellen, Buchen, Stornieren oder Versenden
  fragt _Sie_: in Ihrem Client oder auf einer Freigabeseite in Ihrem Browser. Das Modell kann sich
  nicht selbst freigeben.
- **Keine überraschenden Nebenwirkungen.** Eine PDF-Vorschau markiert eine Rechnung nie als
  versendet, Schreibvorgänge werden nie wiederholt, und jeder Schreibvorgang wird zurückgelesen
  und kann in ein lokales Audit-Log geschrieben werden.
- **Korrekt für sevDesk-Update 2.0.** Steuerregeln und Buchungskonten werden geprüft, bevor
  etwas gesendet wird.
- **Kompakte, typisierte Ausgabe.** Zusammenfassungen rechnet der Server, damit das Modell nicht
  durch Hunderte Datensätze blättert.

## Schnellstart

Sie brauchen einen sevDesk-Tarif mit API-Zugang (Buchhaltung Pro; die kostenlose Testphase
enthält ihn), das API-Token eines sevDesk-Benutzers (Einstellungen → Benutzer → API-Token; am
besten ein Benutzer nur für den Assistenten) und, außer für die Claude-Desktop-Erweiterung,
Node.js 22.12 oder neuer.

### Claude Desktop

Laden Sie `mcp-server-sevdesk-<version>.mcpb` aus dem
[neuesten Release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest) herunter,
öffnen Sie die Datei und fügen Sie Ihr Token ein. Die Erweiterung braucht kein Node.js und
bewahrt das Token im sicheren Speicher Ihres Systems auf.

### Claude Code

```bash
npx -y mcp-server-sevdesk token set work   # legt das Token im Schlüsselbund des Betriebssystems ab (macOS, Linux)
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Oder installieren Sie das [Claude-Code-Plugin](#claude-code-plugin), das einen
Buchhaltungs-Skill mitbringt.

### Cursor, VS Code, Windsurf, Codex, Zed und andere

Jeder Client startet den Server so; [Clients](docs/clients.de.md) nennt für jeden die genaue
Datei und das Format:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": { "SEVDESK_API_TOKEN": "<your sevDesk API token>" }
    }
  }
}
```

### Erste Schritte

Fragen Sie _„Wie ist mein sevDesk-Konto eingerichtet?“_. Der Server startet nur lesend; die
[Schnellstart-Anleitung](docs/quickstart.de.md) zeigt die nächsten Schritte: Schreiben
freischalten, zuerst im Probelauf, und das Token sicher aufbewahren. claude.ai und die mobilen
Claude-Apps verbinden sich mit einem Server, den Sie im [Fernzugriff](#fernzugriff) selbst
betreiben.

## Was er kann

75 Werkzeuge in 10 Werkzeuggruppen. Die 38 Lesewerkzeuge füllen die erste Spalte; mit den
Schreibstufen kommen 37 weitere Werkzeuge hinzu, die Daten anlegen und ändern.

| Bereich                                | Lesen                                                                                                                                                                                                                                        | Schreiben (`write`, `commit`, `external`)                                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Konto**                              | Kontoübersicht und Stammdaten: Steuerregeln, Buchungskonten, Einheiten, Länder                                                                                                                                                               |                                                                                                                                                                                                                                                              |
| **Rechnungen, Gutschriften, Aufträge** | Auflisten und abrufen; PDFs und E-Rechnungs-XML als MCP-Ressourcen; eine **Prüfung auf E-Rechnungs-Tauglichkeit** für ausgehende Rechnungen                                                                                                  | Entwürfe, auch von Aufträgen (Angebot, Auftragsbestätigung, Lieferschein), Rechnungen aus Aufträgen, Gutschriften aus Rechnungen und Mahnungen. Fertigstellen, Zahlungen buchen, festschreiben (unumkehrbar), zurücksetzen, stornieren. Per E-Mail versenden |
| **Belege**                             | Auflisten und abrufen; **empfangene E-Rechnungen** lokal auslesen (XRechnung UBL/CII, ZUGFeRD/Factur-X)                                                                                                                                      | Entwürfe mit angehängter Belegdatei, **Import aus einer E-Rechnung**. Fertigstellen, Zahlungen buchen, festschreiben, zurücksetzen, Entwürfe löschen                                                                                                         |
| **Bank**                               | Konten und Umsätze; **Vorschläge für den Bankabgleich** aus Betrag, Rechnungsnummer im Verwendungszweck, Gegenpartei und Aufteilungen                                                                                                        | Einen Umsatz einem oder mehreren Dokumenten zuordnen (Teilzahlungen, gegen Überbuchung abgesichert), als privat markieren (Privatentnahme/-einlage), eine Zuordnung aufheben                                                                                 |
| **Auswertungen**                       | Zusammenfassungen, Altersstruktur offener Forderungen und Verbindlichkeiten, Liquidität, Änderungen seit einem Datum, eine **Umsatzsteuer-Auswertung** (UStVA-Kennzahlen, ZM, OSS) und eine **Gewinn- und Verlustrechnung nach Art der EÜR** | Der **DATEV-Export** (Buchungsstapel als ZIP, schreibt nie fest)                                                                                                                                                                                             |
| **Kontakte und Artikel**               | Suchen und abrufen, Artikel mit ihrem Lagerbestand                                                                                                                                                                                           | Anlegen und ändern, auch `stock` und `stockEnabled` eines Artikels                                                                                                                                                                                           |
| **Advanced** (standardmäßig aus)       | `sevdesk_api_get`: ein reines Lese-GET auf jeden sevDesk-Endpunkt, den kein anderes Werkzeug abdeckt, etwa Textvorlagen. Es lehnt alles ab, was Daten ändern, Dateien liefern oder Hintergrundaufgaben starten könnte                        |                                                                                                                                                                                                                                                              |

Die Umsatzsteuer-Auswertung ist deutlich als Schätzung gekennzeichnet (Soll- oder
Istversteuerung). Jedes Schreibwerkzeug akzeptiert `dryRun: true` und gibt dann nur genau das
zurück, was es tun würde. Die vollständige, generierte Referenz ist [docs/tools.md](docs/tools.md).

## Prompts

Fertige Arbeitsabläufe als MCP-Prompts. Clients zeigen sie neben den Werkzeugen an; in Claude Code
sind es Slash-Befehle wie `/mcp__sevdesk__month_end_close`.

| Prompt                | Was er tut                                                                                                                                                                  | Argumente                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `month_end_close`     | Monatsabschluss: Änderungen, nicht zugeordnete Kontoumsätze, Entwürfe, offene Forderungen und Verbindlichkeiten, Umsatzsteuer-Vorprüfung, Gewinn, Übergabe per DATEV-Export | `month` (YYYY-MM, Standard: der Vormonat) |
| `receipt_intake`      | Beleg erfassen, E-Rechnung importieren: Dublettenprüfung, Buchungskonto und Steuerregel, Belegentwurf, fertigstellen, Zahlung                                               | `file` (optional)                         |
| `dunning_run`         | Mahnlauf: überfällige Rechnungen, nicht zugeordnete Zahlungseingänge, Mahnungsentwürfe                                                                                      | keine                                     |
| `vat_precheck`        | UStVA-Vorprüfung: nicht zugeordnete Kontoumsätze und Entwürfe, Umsatzsteuer-Auswertung (Kennzahlen), ZM                                                                     | `period` (YYYY-MM oder YYYY-Qn)           |
| `bank_reconciliation` | Kontoabgleich: Vorschläge, Zuordnungen, private Umsätze, Korrekturen                                                                                                        | keine                                     |

Ein Prompt erscheint nur, wenn die Werkzeuge, die er braucht, aktiviert sind; Schritte, die eine
deaktivierte Stufe, Werkzeuggruppe oder einen fehlenden Ordner brauchen, werden mit der
Einstellung aufgeführt, die sie freischaltet. Prompts erzeugen nur Text für den Assistenten: Jede
Änderung läuft weiter über die Werkzeuge, zuerst im Probelauf und mit Ihrer Bestätigung für
bindende Schritte. Keine Steuerberatung.

## Berechtigungen

| Stufe      | Was sie erlaubt                                                                                                                                                  | Bestätigung |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `read`     | Auflisten, abrufen, suchen, Auswertungen, PDF-Vorschauen, Dokumentdateien und CSV-Exporte im Ausgabeordner speichern (oder als Download-Link)                    | nein        |
| `write`    | Kontakte, Artikel, Entwürfe von Rechnungen, Gutschriften, Aufträgen und Belegen, Mahnungen, DATEV-Export                                                         | nein        |
| `commit`   | Fertigstellen, Zahlungen buchen, Kontoumsätze zuordnen, Kontoumsätze als privat markieren, stornieren, festschreiben (GoBD), zurücksetzen, Belegentwürfe löschen | **ja**      |
| `external` | Dokumente per E-Mail versenden                                                                                                                                   | **ja**      |

Die Stufen schalten Sie mit `SEVDESK_ALLOW` frei (zum Beispiel `write,commit`). Bevor etwas
Bindendes gesendet wird, zeigt Ihnen der Server genau, was passieren wird (Beträge, Empfänger, der
vollständige E-Mail-Text), und wartet auf Ihre Freigabe; ändert sich der Datensatz vor Ihrer
Freigabe, fragt er erneut. [Berechtigungen](docs/permissions.de.md) erklärt die Stufen, die
Bestätigungsarten, den Probelauf und das Audit-Log; [Clients](docs/clients.de.md#bestätigung-je-client)
zeigt, welche Clients Sie im Chat fragen können.

## Konfiguration

Alle Einstellungen sind Umgebungsvariablen in der Serverkonfiguration Ihres MCP-Clients. Nur ein
Token ist Pflicht; alles andere steht standardmäßig auf der sichersten Option.

| Variable                                  | Zweck                                                                                                                | Standard  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
| `SEVDESK_API_TOKEN`                       | Das Token. Oder aus einer Datei (`SEVDESK_API_TOKEN_FILE`) oder dem Schlüsselbund des Betriebssystems (`…_KEYCHAIN`) | Pflicht   |
| `SEVDESK_ALLOW`                           | Die Stufen: `write`, `commit`, `external` oder `all`                                                                 | `read`    |
| `SEVDESK_DRY_RUN`                         | `1`: Jeder Schreibvorgang gibt nur eine Vorschau zurück                                                              | `0`       |
| `SEVDESK_CONFIRM`                         | `elicit` (im Client) oder `browser` (eine Freigabeseite)                                                             | `elicit`  |
| `SEVDESK_TOOLSETS`                        | Nur die Werkzeuggruppen laden, die Sie brauchen; `advanced` ist standardmäßig aus                                    | `default` |
| `SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR` | Ordner, aus denen Belege gelesen und in die PDFs und Exporte gespeichert werden. Ohne sie keine lokalen Dateien      |           |
| `SEVDESK_AUDIT_LOG`                       | Ein lokales Protokoll jedes Schreibvorgangs im Format JSON Lines                                                     |           |
| `SEVDESK_PROFILE`                         | Eines von mehreren Konten oder Einrichtungen aus einer Profildatei wählen                                            |           |

Alle Variablen, die Werkzeuggruppen, Profile, Grenzen und die Kommandozeile:
[Konfiguration](docs/configuration.de.md).

## Fernzugriff

Über stdio läuft der Server auf Ihrem Rechner, gestartet von Ihrem MCP-Client. Mit `--http` läuft
er als Webdienst, den Sie selbst betreiben (eine VM mit Docker Compose und Caddy, Fly.io, Render,
Railway oder Ihr eigener Rechner; eine gehostete Instanz gibt es nicht), um claude.ai und die
Claude-Apps, einen Editor auf einem anderen Rechner oder ein kleines Team zu verbinden. Ohne
Authentifizierung (`SEVDESK_HTTP_AUTH`) startet er nicht:

- **`oauth`**: Der Server ist sein eigener OAuth-2.1-Autorisierungsserver. Jeder Benutzer verbindet
  sich über eine Zustimmungsseite, wählt die Stufen für diese Verbindung und fügt sein
  sevDesk-Token einmal ein; das Token steckt verschlüsselt in den Tokens, die der Client hält, und
  der Server speichert keins. Nur die sevDesk-Konten, die Sie aufführen, können sich verbinden.
  claude.ai braucht diesen Modus.
- **`bearer`**: Ein gemeinsames Geheimnis schützt ein sevDesk-Konto, das `SEVDESK_API_TOKEN` des
  Servers. Für Clients, die Sie selbst einrichten, etwa Claude Code, Cursor oder VS Code.

claude.ai kann (zum Zeitpunkt des Schreibens) keine Bestätigungen im Chat erfragen, daher geben
Sie bindende Schritte im Freigabe-Postfach des Servers frei (`SEVDESK_CONFIRM=browser`). Belege
und E-Rechnungen laden Sie über Seiten auf Ihrem Server hoch, PDFs und Exporte laden Sie dort
herunter; der Assistent verlinkt diese Seiten. Für mehrere Belege öffnet `sevdesk_upload_request`
mit `count: 2` bis `10` eine gemeinsame Seite. Danach ordnet `sevdesk_uploads_list` die bereinigten
Dateinamen den `uploadId`s für die Entwurfswerkzeuge zu. Größenlimit, Speicherplatz und Ablauf
werden weiterhin für jede Datei einzeln geprüft. Claude Code verbinden Sie so:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp                     # OAuth: danach mit /mcp anmelden
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"                          # Bearer
```

Die vollständige Anleitung mit Docker-Schnellstart, Vorlagen für das Deployment und dem Betrieb
steht in [docs/remote.de.md](docs/remote.de.md); das Bedrohungsmodell in
[SECURITY.de.md](SECURITY.de.md#fernzugriff).

## Claude-Code-Plugin

Das Repository ist zugleich ein Plugin-Marktplatz für Claude Code. Das Plugin `sevdesk` startet
diesen Server, fest auf das Release, zu dem das Plugin gehört (eine neue npm-Version läuft nie,
bevor das Plugin aktualisiert ist), und bringt einen Buchhaltungs-Skill mit: deutsche Steuerregeln
und die passenden Steuerregeln in sevDesk (inkl. §13b Reverse Charge und §19 Kleinunternehmer),
gängige SKR03/SKR04-Konten, GoBD, die E-Rechnungspflichten und Abläufe Schritt für Schritt für
Belege, E-Rechnungen, den Bankabgleich, die Umsatzsteuer-Vorprüfung, den Monats- und
Jahresabschluss.

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

Ab Claude Code 2.1.275 genügt ein Schritt:
`/plugin install sevdesk --marketplace jaylann/mcp-server-sevdesk`. Das Plugin übergibt die
`SEVDESK_*`-Variablen aus der Umgebung, in der Claude Code gestartet wurde (mindestens eine
Token-Variable; ohne `SEVDESK_ALLOW` bleibt es nur lesend).

## Dokumentation

| Seite                                                      | Inhalt                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Schnellstart](docs/quickstart.de.md)                      | Vom sevDesk-Konto zur ersten Antwort, dann Schreiben und ein sicheres Token        |
| [Clients](docs/clients.de.md)                              | Einrichtung für Claude Desktop, Claude Code, claude.ai, Cursor, VS Code u. a.      |
| [Berechtigungen](docs/permissions.de.md)                   | Stufen, Bestätigungsarten, Probelauf, Audit-Log                                    |
| [Konfiguration](docs/configuration.de.md)                  | Alle Einstellungen, Werkzeuggruppen, Profile, Schlüsselbund, Kommandozeile         |
| [Werkzeugreferenz](docs/tools.md)                          | Jedes Werkzeug und jeder Prompt mit Argumenten (generiert)                         |
| [Fernzugriff](docs/remote.de.md)                           | Den Server über HTTP betreiben: OAuth, Bearer, Deployment, Betrieb                 |
| [Häufige Fragen](docs/faq.de.md)                           | Daten und Datenschutz, Update 2.0, E-Rechnungen, DATEV, Hilfe                      |
| [Kompatibilität](docs/compatibility.md)                    | Was 1.0 stabil hält, und die Regeln für Abkündigungen                              |
| [Architektur](docs/architecture.md)                        | Wie der Server gebaut ist, und die [Architekturentscheidungen](docs/adr/README.md) |
| [Sicherheit](SECURITY.de.md), [Datenschutz](PRIVACY.de.md) | Bedrohungsmodell, Schwachstellen melden, was wo gespeichert wird                   |

**Als Nächstes** in 1.x: Briefe per Post versenden, sevDesk-Konten in Österreich und die
Windows-Anmeldeinformationsverwaltung. Das [Changelog](CHANGELOG.md) listet jedes Release.

## Mitwirken

Beiträge sind willkommen. Beginnen Sie mit [CONTRIBUTING.md](CONTRIBUTING.md), und melden Sie
Sicherheitslücken bitte vertraulich, wie in [SECURITY.de.md](SECURITY.de.md) beschrieben.

## Lizenz

[MIT](LICENSE) © 2026 Justin Lanfermann

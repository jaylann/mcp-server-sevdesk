<!-- translated-from: README.md sha256:fda15b4c6ba4 -->

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

> [!NOTE]
> Dies ist ein **inoffizielles** Community-Projekt. Es ist nicht mit der sevdesk GmbH verbunden und
> wird von ihr weder empfohlen noch unterstützt. „sevDesk“ ist eine Marke ihres Inhabers.

🇬🇧 [English version](README.md) · Dokumentation: <https://sevdesk-mcp.lanfermann.dev>

## Installation

Sie brauchen einen sevDesk-Tarif mit API-Zugang (Buchhaltung Pro; die kostenlose Testphase
enthält ihn), das API-Token eines sevDesk-Benutzers (Einstellungen → Benutzer → API-Token; am
besten ein Benutzer nur für den Assistenten) und, außer für die Claude-Desktop-Erweiterung,
Node.js 22.12 oder neuer.

**Claude Desktop:** Laden Sie `mcp-server-sevdesk-<version>.mcpb` aus dem
[neuesten Release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest) herunter,
öffnen Sie die Datei und fügen Sie Ihr Token ein. Die Erweiterung braucht kein Node.js und
bewahrt das Token im sicheren Speicher Ihres Systems auf.

**Claude Code:**

```bash
npx -y mcp-server-sevdesk token set work   # legt das Token im Schlüsselbund des Betriebssystems ab (macOS, Linux)
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

**Jeder andere MCP-Client** (Cursor, VS Code, Windsurf, Codex, Zed, …) startet den Server so;
[Clients](docs/clients.de.md) nennt für jeden die genaue Datei und das Format:

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

Fragen Sie dann _„Wie ist mein sevDesk-Konto eingerichtet?“_. Der Server startet nur lesend. Der
[Schnellstart](docs/quickstart.de.md) zeigt die nächsten Schritte: Schreiben freischalten, zuerst
im Probelauf, und das Token sicher aufbewahren. claude.ai und die mobilen Claude-Apps verbinden
sich mit einem Server, den Sie im [Fernzugriff](#fernzugriff-http) selbst betreiben.

## Warum dieser Server

Ein sevDesk-API-Token hat **vollen Zugriff auf das gesamte Konto**, und sevDesk hat keine
Testumgebung. Dieser Server ist um diese Tatsache herum gebaut:

- **Standardmäßig nur lesend.** Schreiben schalten Sie stufenweise frei (`write` → `commit` →
  `external`). Werkzeuge oberhalb Ihrer Stufe bekommt das Modell gar nicht erst zu sehen.
- **Echte Bestätigung durch einen Menschen.** Bevor eine Rechnung fertiggestellt, gebucht,
  storniert oder per E-Mail versendet wird, fragt der Server _Sie_: in Ihrem Client
  (MCP-Elicitation) oder auf einer Freigabeseite in Ihrem Browser. Das Modell kann sich nicht
  selbst freigeben.
- **Keine überraschenden Nebenwirkungen.** Eine PDF-Vorschau markiert eine Rechnung nie als
  versendet; Schreibvorgänge werden nie wiederholt; jeder Schreibvorgang wird zurückgelesen und
  kann in ein lokales Audit-Log geschrieben werden.
- **Korrekt für sevDesk-Update 2.0.** Steuerregeln und Buchungskonten werden geprüft, bevor
  etwas gesendet wird.
- **Kompakte, typisierte Ausgabe.** Zusammenfassungen rechnet der Server, damit das Modell nicht
  durch Hunderte Datensätze blättert.

## Werkzeuge

73 Werkzeuge in 10 Werkzeuggruppen. Die 36 Lesewerkzeuge decken Kontoinformationen und
Stammdaten ab, Kontakte, Rechnungen, Gutschriften, Aufträge, Belege, Bank, Artikel, PDFs und
E-Rechnungs-XML (als MCP-Ressourcen) sowie Auswertungen, die der Server selbst berechnet:
Zusammenfassungen, Altersstruktur offener Forderungen und Verbindlichkeiten, Liquidität,
Änderungen seit einem Datum, eine **Umsatzsteuer-Auswertung** (Kennzahlen der
Umsatzsteuer-Voranmeldung, Zusammenfassende Meldung und OSS, nach Soll- oder Istversteuerung,
deutlich als Schätzung gekennzeichnet) und eine **Gewinn- und Verlustrechnung nach Art der EÜR**.
Außerdem **lesen sie empfangene E-Rechnungen** (XRechnung UBL/CII, ZUGFeRD/Factur-X) lokal aus,
**prüfen ausgehende Rechnungen auf E-Rechnungs-Tauglichkeit** und **schlagen Zuordnungen für den
Bankabgleich vor** (Betrag, Rechnungsnummer im Verwendungszweck, Gegenpartei, Aufteilungen). Mit
den Schreibstufen kommen 37 weitere Werkzeuge hinzu, die Daten anlegen und ändern:

- **Entwürfe** (`write`): Rechnungen, Gutschriften und Aufträge (Angebot, Auftragsbestätigung,
  Lieferschein), Rechnungen aus Aufträgen, Gutschriften aus Rechnungen, Mahnungen, Kontakte und
  Artikel; **Belege** mit angehängter Belegdatei und Belege, die **aus einer E-Rechnung
  importiert** werden; der **DATEV-Export** (Buchungsstapel als ZIP, schreibt nie fest).
- **Buchen** (`commit`, fragt Sie vorher): fertigstellen, Zahlungen buchen (wahlweise mit
  einem Kontoumsatz verknüpft), festschreiben (unumkehrbar) und auf Entwurf oder offen
  zurücksetzen, jeweils für Rechnungen, Gutschriften und Belege; Rechnungen stornieren (Storno);
  Aufträge fertigstellen; Belegentwürfe löschen; **einen Kontoumsatz einem oder mehreren
  Dokumenten zuordnen** (Teilzahlungen, gegen Überbuchung abgesichert), einen Umsatz als privat
  markieren (Privatentnahme/-einlage) und eine Zuordnung aufheben.
- **E-Mail** (`external`, fragt Sie vorher): Rechnungen, Gutschriften und Aufträge per E-Mail
  versenden.

Artikel enthalten ihren Lagerbestand: `sevdesk_part_get` meldet den aktuellen Bestand, und
`sevdesk_part_update` setzt `stock` und `stockEnabled`. Die Werkzeuggruppe `advanced`
(standardmäßig aus) ergänzt `sevdesk_api_get`, ein reines Lese-GET auf jeden sevDesk-Endpunkt,
den kein anderes Werkzeug abdeckt, etwa Textvorlagen; es lehnt alles ab, was Daten ändern, Dateien
liefern oder Hintergrundaufgaben starten könnte.

Jedes Schreibwerkzeug akzeptiert `dryRun: true` und gibt dann nur genau das zurück, was es tun
würde. Die vollständige, generierte Referenz ist [docs/tools.md](docs/tools.md).

## Prompts

Der Server bietet außerdem fertige Arbeitsabläufe als MCP-Prompts an. Clients zeigen sie neben den
Werkzeugen an; in Claude Code sind es Slash-Befehle wie `/mcp__sevdesk__month_end_close`.

| Prompt                | Was er tut                                                                                                                                                                  | Argumente                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `month_end_close`     | Monatsabschluss: Änderungen, nicht zugeordnete Kontoumsätze, Entwürfe, offene Forderungen und Verbindlichkeiten, Umsatzsteuer-Vorprüfung, Gewinn, Übergabe per DATEV-Export | `month` (YYYY-MM, Standard: der Vormonat) |
| `receipt_intake`      | Beleg erfassen, E-Rechnung importieren: Dublettenprüfung, Buchungskonto und Steuerregel, Belegentwurf, fertigstellen, Zahlung                                               | `file` (optional)                         |
| `dunning_run`         | Mahnlauf: überfällige Rechnungen, nicht zugeordnete Zahlungseingänge, Mahnungsentwürfe                                                                                      | keine                                     |
| `vat_precheck`        | UStVA-Vorprüfung: nicht zugeordnete Kontoumsätze und Entwürfe, Umsatzsteuer-Auswertung (Kennzahlen), ZM                                                                     | `period` (YYYY-MM oder YYYY-Qn)           |
| `bank_reconciliation` | Kontoabgleich: Vorschläge, Zuordnungen, private Umsätze, Korrekturen                                                                                                        | keine                                     |

Prompts richten sich nach Ihren Einstellungen: Ein Prompt erscheint nur, wenn die Werkzeuge, die er
braucht, aktiviert sind, und Schritte, die eine deaktivierte Stufe, Werkzeuggruppe oder einen
fehlenden Ordner brauchen, werden mit der Einstellung aufgeführt, die sie freischaltet. Prompts
erzeugen nur Text für den Assistenten; jede Änderung läuft weiter über die Werkzeuge, zuerst im
Probelauf und mit Ihrer Bestätigung für bindende Schritte. Keine Steuerberatung.

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
Freigabe, fragt er erneut. Schreibvorgänge werden nie wiederholt, jedes Ergebnis wird aus sevDesk
zurückgelesen, und mit `SEVDESK_AUDIT_LOG` wird jeder Schritt lokal protokolliert.
[Berechtigungen](docs/permissions.de.md) erklärt die Stufen, die Bestätigungsarten, den Probelauf
und das Audit-Log; [Clients](docs/clients.de.md#bestätigung-je-client) zeigt, welche Clients Sie
im Chat fragen können.

## Konfiguration

Alle Einstellungen sind Umgebungsvariablen in der Serverkonfiguration Ihres MCP-Clients. Nur ein
Token ist Pflicht; alles andere steht standardmäßig auf der sichersten Option. Die wichtigsten:

- `SEVDESK_ALLOW`: die Stufen (standardmäßig `read`). `SEVDESK_DRY_RUN=1`: nur Vorschauen.
- `SEVDESK_CONFIRM`: `elicit` (Standard, im Client) oder `browser` (eine Freigabeseite).
- `SEVDESK_TOOLSETS`: nur die Werkzeuggruppen laden, die Sie brauchen; `advanced` ist
  standardmäßig aus.
- `SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR`: Ordner, aus denen der Server Belege lesen und in die
  er PDFs und Exporte speichern darf. Ohne sie greift er auf keine lokalen Dateien zu.
- `SEVDESK_AUDIT_LOG`: ein lokales Protokoll jedes Schreibvorgangs im Format JSON Lines.
- **Token:** `SEVDESK_API_TOKEN`, eine Datei (`SEVDESK_API_TOKEN_FILE`) oder der Schlüsselbund
  des Betriebssystems (`SEVDESK_API_TOKEN_KEYCHAIN`, abgelegt mit
  `mcp-server-sevdesk token set <label>`).
- **Profile:** mehrere Konten oder Einrichtungen in einer Datei, ausgewählt mit
  `SEVDESK_PROFILE`.

Alle Variablen, Werkzeuggruppen, Profile, Grenzen und die Kommandozeile:
[Konfiguration](docs/configuration.de.md).

## Fernzugriff (HTTP)

Über stdio läuft der Server auf Ihrem Rechner, gestartet von Ihrem MCP-Client. Mit `--http` läuft
er stattdessen als Webdienst. So verbinden Sie claude.ai (benutzerdefinierte Connectoren, die auch
die Desktop- und Mobil-Apps von Claude nutzen), Claude Code oder einen Editor auf einem anderen
Rechner oder ein kleines Team mit einem Server. Sie betreiben ihn selbst: auf einer VM mit Docker
Compose und Caddy, bei Fly.io, Render oder Railway oder auf Ihrem eigenen Rechner. Eine gehostete
Instanz gibt es nicht.

Über HTTP startet der Server nicht ohne Authentifizierung (`SEVDESK_HTTP_AUTH`):

- **`bearer`**: Ein gemeinsames Geheimnis schützt ein sevDesk-Konto, das `SEVDESK_API_TOKEN` des
  Servers. Für Clients, die Sie selbst einrichten, etwa Claude Code, Cursor oder VS Code.
- **`oauth`**: Der Server ist sein eigener OAuth-2.1-Autorisierungsserver. Jeder Benutzer verbindet
  sich über eine Zustimmungsseite auf Ihrem Server, wählt die Stufen für diese Verbindung und fügt
  sein sevDesk-Token einmal ein. Das Token steckt verschlüsselt in den Tokens, die der Client hält;
  der Server speichert keins. Nur die sevDesk-Konten, die Sie aufführen, können sich verbinden.
  claude.ai braucht diesen Modus.

claude.ai kann (zum Zeitpunkt des Schreibens) keine Bestätigungen im Chat erfragen, daher geben
Sie bindende Schritte im Freigabe-Postfach des Servers frei (`SEVDESK_CONFIRM=browser`). Belege
und E-Rechnungen laden Sie über Seiten auf Ihrem Server hoch, PDFs und Exporte laden Sie dort
herunter; der Assistent verlinkt diese Seiten. Claude Code verbinden Sie so:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp                     # OAuth: danach mit /mcp anmelden
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"                          # Bearer
```

Die Anleitung mit Docker-Schnellstart, Vorlagen für das Deployment, allen HTTP-Einstellungen, dem
Freigabe-Postfach, der Dateiübertragung und dem Betrieb steht in [docs/remote.de.md](docs/remote.de.md);
das Bedrohungsmodell in [SECURITY.de.md](SECURITY.de.md#fernzugriff).

## Claude-Code-Plugin

Das Repository ist zugleich ein Plugin-Marktplatz für Claude Code. Das Plugin `sevdesk` startet
diesen Server (fest auf das Release, zu dem das Plugin gehört, damit nie eine neue npm-Version
läuft, bevor das Plugin aktualisiert ist) und bringt einen Buchhaltungs-Skill mit: deutsche
Steuerregeln und die passenden Steuerregeln in sevDesk (inkl. §13b Reverse Charge und §19
Kleinunternehmer), gängige SKR03/SKR04-Konten, GoBD, die E-Rechnungspflichten und Abläufe Schritt
für Schritt (Beleg erfassen, E-Rechnung importieren, Bankabgleich, Umsatzsteuer-Vorprüfung,
Monats- und Jahresabschluss).

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

Ab Claude Code 2.1.275 geht das auch in einem Schritt:
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

## Meilensteine

| Meilenstein | Umfang                                                                                                                        | Status   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| M0          | Repository, Entwicklungsumgebung, CI, Sicherheits- und Release-Pipeline                                                       | erledigt |
| M1          | API-Client, Sicherheitsrahmen, Kontakte und Kontoinformationen (lesen)                                                        | erledigt |
| M2          | Alle Lesewerkzeuge, PDFs/XML als Ressourcen, Auswertungen und Zusammenfassungen                                               | erledigt |
| M3          | Vollständiger Rechnungsablauf mit Stufen und Bestätigung durch einen Menschen                                                 | erledigt |
| M4          | Belege und E-Rechnungen (XRechnung/ZUGFeRD) erfassen, Bankabgleich, Umsatzsteuer-Auswertung, DATEV                            | erledigt |
| M5          | Fernzugriff: Streamable HTTP mit OAuth 2.1, Freigabe-Postfach, Docker-Image, Vorlagen für das Deployment                      | erledigt |
| M6          | 1.0: Claude-Desktop-Erweiterung, Prompts, Profile und Schlüsselbund, Dateiübertragung im Fernzugriff, generisches Lesen, Doku | erledigt |

Als Nächstes, in 1.x: Briefe per Post versenden, sevDesk-Konten in Österreich, die
Windows-Anmeldeinformationsverwaltung.

## Mitwirken

Beiträge sind willkommen. Beginnen Sie mit [CONTRIBUTING.md](CONTRIBUTING.md), und melden Sie
Sicherheitslücken bitte vertraulich, wie in [SECURITY.de.md](SECURITY.de.md) beschrieben.

## Lizenz

[MIT](LICENSE) © 2026 Justin Lanfermann

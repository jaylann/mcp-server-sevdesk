<!-- translated-from: README.md sha256:a4c2fdbf37f9 -->

<!-- Nur die Breite: mit einer Höhe dazu zeichnet GitHub einen getönten Kasten hinter das Bild. -->
<p align="center"><img src="https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk/main/assets/logo.svg" alt="" width="96"></p>

# mcp-server-sevdesk

[![npm](https://img.shields.io/npm/v/mcp-server-sevdesk)](https://www.npmjs.com/package/mcp-server-sevdesk)
[![CI](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/jaylann/mcp-server-sevdesk/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jaylann/mcp-server-sevdesk/badge)](https://scorecard.dev/viewer/?uri=github.com/jaylann/mcp-server-sevdesk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Ein auf Sicherheit ausgelegter [Model-Context-Protocol](https://modelcontextprotocol.io)-Server
für die [sevDesk](https://sevdesk.de)-API.** KI-Assistenten (Claude, Cursor, VS Code, Codex, …)
lesen und bearbeiten damit deine Rechnungen, Belege, Kontoumsätze und Auswertungen, mit
Berechtigungen, die du festlegst, und einer Bestätigung durch einen Menschen für alles, was
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

- **Standardmäßig nur lesend.** Schreiben schaltest du stufenweise frei (`write` → `commit` →
  `external`); Werkzeuge oberhalb deiner Stufe bekommt das Modell gar nicht erst zu sehen.
- **Echte Bestätigung durch einen Menschen.** Fertigstellen, Buchen, Stornieren oder Versenden
  fragt _dich_: in deinem Client oder auf einer Freigabeseite in deinem Browser. Das Modell kann
  sich nicht selbst freigeben.
- **Keine überraschenden Nebenwirkungen.** Eine PDF-Vorschau markiert eine Rechnung nie als
  versendet, Schreibvorgänge werden nie wiederholt, und jeder Schreibvorgang wird zurückgelesen
  und kann in ein lokales Audit-Log geschrieben werden.
- **Korrekt für sevDesk-Update 2.0.** Steuerregeln und Buchungskonten werden geprüft, bevor
  etwas gesendet wird.
- **Kompakte, typisierte Ausgabe.** Zusammenfassungen rechnet der Server, damit das Modell nicht
  durch Hunderte Datensätze blättert; die Felder beschreibt die [Werkzeugreferenz](docs/tools.md).

## Schnellstart

Du brauchst einen sevDesk-Tarif mit API-Zugang (Buchhaltung Pro; die kostenlose Testphase
enthält ihn), das API-Token eines sevDesk-Benutzers (Einstellungen → Benutzer → API-Token; am
besten ein Benutzer nur für den Assistenten) und, außer für die Claude-Desktop-Erweiterung,
Node.js 22.12 oder neuer.

- **Claude Desktop:** Lade `mcp-server-sevdesk-<version>.mcpb` aus dem
  [neuesten Release](https://github.com/jaylann/mcp-server-sevdesk/releases/latest) herunter,
  öffne die Datei und füge dein Token ein ([Einzelheiten](docs/clients/claude-desktop.de.md)).
- **Claude Code:** Lege das Token im Schlüsselbund des Betriebssystems ab und trage dann den Server
  ein, oder installiere das [Plugin](#claude-code-plugin):

  ```bash
  npx -y mcp-server-sevdesk token set work
  claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
  ```

- **Cursor, VS Code, Windsurf, Codex, Zed und andere** starten `npx -y mcp-server-sevdesk` mit dem
  Token in der Umgebung; [Clients](docs/clients.de.md) nennt für jeden die genaue Datei.
- **claude.ai und die mobilen Claude-Apps** verbinden sich mit einem Server, den du im
  [Fernzugriff](#fernzugriff) selbst betreibst.

Frag dann _„Wie ist mein sevDesk-Konto eingerichtet?“_. Der Server startet nur lesend; die
[Schnellstart-Anleitung](docs/quickstart.de.md) zeigt die nächsten Schritte: Schreiben
freischalten, zuerst im Probelauf, und das Token sicher aufbewahren.

## Was er kann

99 Werkzeuge in 10 Werkzeuggruppen. Die 43 Lesewerkzeuge füllen die erste Spalte; mit den
Schreibstufen kommen 56 weitere Werkzeuge hinzu, die Daten anlegen und ändern.

| Bereich                                | Lesen                                                                                                                                                                                                                                                                                                                 | Schreiben (`write`, `commit`, `external`)                                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Konto**                              | Kontoübersicht und Stammdaten: Steuerregeln, Buchungskonten, Einheiten, Länder                                                                                                                                                                                                                                        |                                                                                                                                                                                                                                                              |
| **Rechnungen, Gutschriften, Aufträge** | Auflisten und abrufen; PDFs und E-Rechnungs-XML als MCP-Ressourcen; eine **Prüfung auf E-Rechnungs-Tauglichkeit** für ausgehende Rechnungen                                                                                                                                                                           | Entwürfe, auch von Aufträgen (Angebot, Auftragsbestätigung, Lieferschein), Rechnungen aus Aufträgen, Gutschriften aus Rechnungen und Mahnungen. Fertigstellen, Zahlungen buchen, festschreiben (unumkehrbar), zurücksetzen, stornieren. Per E-Mail versenden |
| **Belege**                             | Auflisten und abrufen; **empfangene E-Rechnungen** lokal auslesen (XRechnung UBL/CII, ZUGFeRD/Factur-X)                                                                                                                                                                                                               | Entwürfe mit angehängter Belegdatei, **Import aus einer E-Rechnung**, Entwürfe aus sevDesks eigener Belegerkennung. Fertigstellen, Zahlungen buchen, festschreiben, zurücksetzen, Entwürfe löschen                                                           |
| **Bank**                               | Konten und Umsätze; **Vorschläge für den Bankabgleich** aus Betrag, Rechnungsnummer im Verwendungszweck, Gegenpartei und Aufteilungen                                                                                                                                                                                 | Umsätze Dokumenten zuordnen (Teilzahlungen, gegen Überbuchung abgesichert), als privat markieren (Privatentnahme/-einlage), Zuordnung aufheben. Umsätze auf Dateiimport-Konten erfassen, löschen, festschreiben. Dateiimport- oder Verrechnungskonto anlegen |
| **Auswertungen**                       | Zusammenfassungen, Altersstruktur offener Forderungen und Verbindlichkeiten, Liquidität, Änderungen seit einem Datum, eine **Umsatzsteuer-Auswertung** (UStVA-Kennzahlen, ZM, OSS), eine **Gewinn- und Verlustrechnung nach Art der EÜR**, eine **Steuerregel-Hilfe** für Verkäufe und eine **Prüfung der USt-IdNr.** | Der **DATEV-Export** (Buchungsstapel als ZIP oder XML mit Belegbildern, schreibt nie fest) und seine Einstellungen; Rechnungs- oder Beleg-PDFs als ein **ZIP-Archiv**                                                                                        |
| **Kontakte und Artikel**               | Suchen und abrufen, Artikel mit ihrem Lagerbestand                                                                                                                                                                                                                                                                    | Anlegen und ändern, auch die Organisation einer Person (Ansprechpartner), einzelne Adressen und E-Mail-Adressen entfernen sowie `stock` und `stockEnabled` eines Artikels. Kontakte löschen                                                                  |
| **Advanced** (standardmäßig aus)       | `sevdesk_api_get`: ein reines Lese-GET auf jeden sevDesk-Endpunkt, den kein anderes Werkzeug abdeckt, etwa Textvorlagen. Es lehnt alles ab, was Daten ändern, Dateien liefern oder Hintergrundaufgaben starten könnte                                                                                                 |                                                                                                                                                                                                                                                              |

Rechnungen, Gutschriften, Aufträge und Belege können Tags tragen (Projekte, Kunden, Filialen):
`sevdesk_tags_list` zeigt jeden Tag mit seinen Verwendungen, die vier Listenwerkzeuge filtern nach
Tag, und `sevdesk_document_tag` (Stufe `write`) fügt einem Dokument einen Tag hinzu oder entfernt
ihn. Rechnungs-, Beleg- und Gutschriftsentwürfe nehmen eine Kostenstelle mit ID, Nummer oder Namen
an, und ihre drei Listen filtern danach. Die Summen und die Gewinn- und
Verlustrechnung filtern und gruppieren nach Tag und nach Kostenstelle („Was hat Projekt X
gekostet?“).

Die Umsatzsteuer-Auswertung ist deutlich als Schätzung gekennzeichnet (Soll- oder
Istversteuerung). Die **Prüfungen** (`sevdesk_records_audit`) beantworten „Was ist falsch?“:
ausländische Lieferanten und Kunden, deren Umsatzsteuer-Behandlung nicht passt, die
Bemessungsgrundlage nach § 13b je Steuerregel, doppelt gebuchte Belege und liegen gebliebene
Entwürfe sowie fehlende Rechnungen von Lieferanten, die jeden Monat, jedes Quartal oder jedes Jahr
abrechnen, jeder Befund mit seinen Belegen, seiner Rechtsgrundlage und dem, was zu prüfen ist; es
sind Hinweise, keine Steuerberatung. Wo der Server einen lokalen Ordner liest
(`SEVDESK_FILE_DIRS`), vergleicht `sevdesk_receipt_folder_check` dessen Belegdateien anhand der
Prüfsumme mit denen an den Belegen in sevDesk und nennt die Dateien, die wohl nie gebucht wurden.
Jedes
Schreibwerkzeug akzeptiert `dryRun: true` und gibt dann nur genau das zurück, was es tun würde. Belegentwürfe können in Fremdwährung sein, mit einem Wechselkurs oder
einem Wechselkursdatum; solche Entwürfe lassen sich über den Server nicht fertigstellen
([Belege](docs/guides/receipts.de.md)). Die vollständige, generierte Referenz ist
[docs/tools.md](docs/tools.md).

## Prompts

Fertige Arbeitsabläufe als MCP-Prompts. Clients zeigen sie neben den Werkzeugen an; in Claude Code
sind es Slash-Befehle wie `/mcp__sevdesk__month_end_close`.

| Prompt                | Was er tut                                                                                                                                                                  | Argumente                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `month_end_close`     | Monatsabschluss: Änderungen, nicht zugeordnete Kontoumsätze, Entwürfe, offene Forderungen und Verbindlichkeiten, Umsatzsteuer-Vorprüfung, Gewinn, Übergabe per DATEV-Export | `month` (YYYY-MM, Standard: der Vormonat)                                 |
| `receipt_intake`      | Beleg erfassen, E-Rechnung importieren: Dublettenprüfung, Buchungskonto und Steuerregel, Belegentwurf, fertigstellen, Zahlung                                               | `file` (optional)                                                         |
| `dunning_run`         | Mahnlauf: überfällige Rechnungen, nicht zugeordnete Zahlungseingänge, Mahnungsentwürfe                                                                                      | `contact` (Name/ID), `minDaysOverdue` (0–3650 Tage); beide optional       |
| `vat_precheck`        | UStVA-Vorprüfung: nicht zugeordnete Kontoumsätze und Entwürfe, Umsatzsteuer-Auswertung (Kennzahlen), ZM                                                                     | `period` (YYYY-MM oder YYYY-Qn)                                           |
| `bank_reconciliation` | Kontoabgleich: Vorschläge, Zuordnungen, private Umsätze, Korrekturen                                                                                                        | `checkAccount` (Name/ID), `month` (YYYY-MM); beide optional               |
| `missing_receipts`    | Fehlende Belege: ausgehende Umsätze ohne Beleg, regelmäßige Lieferanten ohne Rechnung, Belege nur im Entwurf oder doppelt gebucht, nicht gebuchte Dateien im Belegordner    | `period` (YYYY-MM oder YYYY-Qn), `checkAccount` (Name/ID); beide optional |
| `year_end_handoff`    | Übergabe an die Steuerberatung: Entwürfe und nicht zugeordnete Umsätze, Gewinn- und Verlustrechnung, Prüfungen, offene Posten, DATEV-Export, Belegarchiv in Teilen          | `year` (YYYY, Standard: das Vorjahr)                                      |
| `offer_follow_up`     | Angebote nachfassen: versendete Angebote ohne Antwort, dann annehmen oder ablehnen, Auftragsbestätigung, Lieferschein, Rechnung                                             | `minAgeDays` (0–3650, Standard 14), `contact` (Name/ID); beide optional   |

Ein Prompt erscheint nur, wenn die Werkzeuge, die er braucht, aktiviert sind; Schritte, die eine
deaktivierte Stufe, Werkzeuggruppe oder einen fehlenden Ordner brauchen, werden mit der
Einstellung aufgeführt, die sie freischaltet. Prompts erzeugen nur Text für den Assistenten: Jede
Änderung läuft weiter über die Werkzeuge, zuerst im Probelauf und mit deiner Bestätigung für
bindende Schritte. Keine Steuerberatung.

Clients, die Argumente vervollständigen können, schlagen beim Tippen Werte vor: Monate und
Quartale, die jüngsten zuerst, und die Namen deiner Kontakte und Zahlungskonten. Die Namen kommen
aus sevDesk (nur lesend, eine Minute zwischengespeichert) und nur, wenn die Werkzeuge für Kontakte
oder Bankkonten aktiviert sind.

## Berechtigungen und Konfiguration

Der Server liest nur, bis du mit `SEVDESK_ALLOW` mehr freischaltest: `write` (Entwürfe, Kontakte,
Artikel, DATEV-Export), `commit` (fertigstellen, buchen, stornieren, festschreiben) und `external`
(per E-Mail versenden). Bevor etwas Bindendes gesendet wird, zeigt dir der Server genau, was
passieren wird (Beträge, Empfänger, der vollständige E-Mail-Text), und wartet auf deine Freigabe;
ändert sich der Datensatz vor deiner Freigabe, fragt er erneut
([Berechtigungen](docs/permissions.de.md);
[welche Clients im Chat fragen können](docs/clients.de.md#bestätigung-je-client)). Alle
Einstellungen sind Umgebungsvariablen in der Serverkonfiguration deines Clients; nur ein Token ist
Pflicht, alles andere steht standardmäßig auf der sichersten Option
([Konfiguration](docs/configuration.de.md)).

## Fernzugriff

Mit `--http` läuft der Server als Webdienst, den du selbst betreibst (eine gehostete Instanz gibt
es nicht), für claude.ai und die Claude-Apps, einen Editor auf einem anderen Rechner oder ein
kleines Team. Ohne Authentifizierung startet er nicht: OAuth, bei dem sich jeder Benutzer über eine
Zustimmungsseite verbindet und der Server kein sevDesk-Token speichert, oder ein gemeinsames
Bearer-Geheimnis für ein Konto. [Fernzugriff](docs/remote.de.md) enthält die Schnellstarts, die
Bereitstellung, die Konfiguration und den Betrieb.

## Claude-Code-Plugin

Das Repository ist zugleich ein Plugin-Marktplatz für Claude Code: Das Plugin `sevdesk` startet
diesen Server und bringt einen Buchhaltungs-Skill für deutsche Steuerregeln, SKR03/SKR04, GoBD und
E-Rechnungen mit. Installation und Einrichtung: [Das Plugin](docs/clients/claude-code.de.md#das-plugin).

## Dokumentation

- **Start:** [Schnellstart](docs/quickstart.de.md) · [Fehlersuche](docs/troubleshooting.de.md) ·
  [Häufige Fragen](docs/faq.de.md) · [Glossar](docs/glossary.de.md)
- **Clients:** [Übersicht](docs/clients.de.md) · [Claude Desktop](docs/clients/claude-desktop.de.md) ·
  [Claude Code](docs/clients/claude-code.de.md) · [claude.ai](docs/clients/claude-ai.de.md) ·
  [Cursor](docs/clients/cursor.de.md) · [VS Code](docs/clients/vscode.de.md) ·
  [Windsurf](docs/clients/windsurf.de.md) · [Codex](docs/clients/codex.de.md) ·
  [Zed](docs/clients/zed.de.md)
- **Anleitungen:** [Rechnungen](docs/guides/invoices.de.md) · [Belege](docs/guides/receipts.de.md) ·
  [Bank und Kasse](docs/guides/banking.de.md) · [Auswertungen](docs/guides/evaluations.de.md)
- **Referenz:** [Berechtigungen](docs/permissions.de.md) ·
  [Audit-Log](docs/permissions/audit-log.de.md) · [Konfiguration](docs/configuration.de.md) ·
  [Profile](docs/configuration/profiles.de.md) · [Werkzeuge](docs/tools.md) ·
  [Kompatibilität](docs/compatibility.de.md)
- **Fernzugriff:** [Übersicht](docs/remote.de.md) · [Bereitstellung](docs/remote/deployment.de.md) ·
  [Konfiguration](docs/remote/configuration.de.md) · [Freigaben](docs/remote/approvals.de.md) ·
  [Dateien](docs/remote/files.de.md) · [Betrieb](docs/remote/operations.de.md) ·
  [Fehlersuche](docs/remote/troubleshooting.de.md)
- **Sicherheit:** [Richtlinie](SECURITY.de.md) · [Bestätigung](docs/security/confirmation.de.md) ·
  [Lokal](docs/security/local.de.md) · [Sicherheit im Fernzugriff](docs/security/remote.de.md) ·
  [Lieferkette](docs/security/supply-chain.de.md) · [Datenschutz](PRIVACY.de.md)
- **Projekt:** [Architektur](docs/architecture.de.md) · [Absicherung](docs/architecture/safety.de.md) ·
  [Transporte](docs/architecture/transports.de.md) ·
  [Bauen und Testen](docs/architecture/build-and-test.de.md) ·
  [Architekturentscheidungen](docs/adr/README.de.md) · [Mitwirken](CONTRIBUTING.de.md) ·
  [Änderungen](docs/contributing/changes.de.md) · [Tests](docs/contributing/testing.de.md) ·
  [Aufnahmesitzung](docs/recording-session.de.md)

**Als Nächstes** in 1.x: Briefe per Post versenden und sevDesk-Konten in Österreich.
Das [Changelog](CHANGELOG.md) listet jedes Release.

## Mitwirken

Beiträge sind willkommen. Beginne mit [Mitwirken](CONTRIBUTING.de.md), und melde
Sicherheitslücken bitte vertraulich, wie in der [Sicherheitsrichtlinie](SECURITY.de.md) beschrieben.

## Lizenz

[MIT](LICENSE) © 2026 Justin Lanfermann

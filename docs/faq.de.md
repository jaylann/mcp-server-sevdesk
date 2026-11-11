<!-- translated-from: docs/faq.md sha256:7f726a6e7dff -->

# Häufige Fragen

## Allgemeines

### Ist das ein offizielles sevDesk-Produkt?

Nein. mcp-server-sevdesk ist ein inoffizielles Open-Source-Projekt und nicht mit der sevdesk GmbH
verbunden und wird von ihr weder empfohlen noch unterstützt. Es nutzt die öffentliche sevDesk-API mit
Ihrem eigenen API-Token.

### Was kostet das?

Nichts; der Code steht unter der [MIT-Lizenz](../LICENSE). Sie brauchen einen sevDesk-Tarif mit
API-Zugang (Buchhaltung Pro; die kostenlose Testphase enthält ihn) und einen KI-Client, der MCP
unterstützt. Was Ihr Modellanbieter berechnet, regeln Sie mit ihm.

### Welche KI-Clients funktionieren?

Jeder MCP-Client: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex, Zed und andere
über stdio; claude.ai und die mobilen Claude-Apps über einen Server, den Sie im Fernzugriff selbst
betreiben. Die Einrichtung für jeden steht unter [Clients](clients.de.md).

### Ersetzt das meine Steuerberatung?

Nein. Auswertungen wie die Umsatzsteuer-Auswertung und die Gewinn- und Verlustrechnung sind
Schätzungen auf Grundlage Ihrer sevDesk-Daten und als solche gekennzeichnet. Der Server hilft beim
Erfassen, Prüfen und Vorbereiten; verbindliche Antworten gibt Ihre Steuerberatung. Nichts, was er
sagt, ist Steuerberatung.

## Daten und Datenschutz

### Sieht die KI mein API-Token?

Nein. Das Token steht in der Konfiguration des Servers (oder in Ihrem Schlüsselbund), wird nie an
das Modell gegeben und aus jeder Logzeile, jedem Fehler und jedem Eintrag im Audit-Log
geschwärzt. Weil es vollen Zugriff auf das Konto hat, legen Sie es für einen eigenen
sevDesk-Benutzer an.

### Wohin gehen meine Daten?

Der Server läuft auf Ihrem Rechner (oder im Fernzugriff auf Ihrem eigenen Server) und spricht nur
mit der sevDesk-API. Es gibt zwei Ausnahmen: den DATEV-Export, den sevDesk als Download aus seinem
eigenen Speicher (bei Amazon S3) ausliefert, und einen Server im Fernzugriff mit OAuth, der das
Metadaten-Dokument eines Clients, der sich verbindet, vom Host dieses Clients abruft. Ergebnisse
gehen an Ihren MCP-Client und von dort an Ihren
Modellanbieter: Rechnungen, Kontakte und Kontoumsätze sind dann Teil Ihrer Unterhaltung, zu den
Bedingungen dieses Anbieters. Buchhaltungsdaten enthalten personenbezogene Daten Ihrer Kunden;
prüfen Sie daher die Bedingungen Ihres Anbieters zur Auftragsverarbeitung, bevor Sie ein echtes
Konto verbinden.

Das Projekt betreibt keinen Dienst und erhebt keine Telemetrie. Einzelheiten:
[PRIVACY.de.md](../PRIVACY.de.md).

### Kann die KI ohne mich Rechnungen fertigstellen oder versenden?

Nein. Standardmäßig liest der Server nur. Fertigstellen, Buchen, Stornieren und Festschreiben
(`commit`) sowie Versenden (`external`) müssen Sie erst freischalten, und dann fragt jeder Aufruf
Sie: im Client oder auf einer Freigabeseite in Ihrem Browser. Das Modell kann diese Bestätigung
nicht selbst geben ([Berechtigungen](permissions.de.md)).

### Was passiert, wenn etwas schiefgeht?

Jeder Schreibvorgang wird geprüft, bevor etwas gesendet wird (Status, Beträge, Steuerregel und
Steuersatz, Buchungskonten, Dubletten), nie automatisch wiederholt und danach aus sevDesk
zurückgelesen. Ein Probelauf zeigt, was passieren würde, ohne etwas zu senden, und das optionale
Audit-Log auf Ihrem Rechner hält jeden Schritt fest. Fertiggestellte und festgeschriebene Dokumente
lassen sich in sevDesk nicht einfach löschen; deshalb brauchen diese Schritte Ihre Bestätigung.

### Warum gibt es keine gehostete Version?

Ein gehosteter Dienst würde die API-Tokens aller Benutzer halten, und jedes Token kann in seinem
Konto alles, ohne einschränkbare Rechte und ohne Ablaufdatum. Er würde außerdem die
Buchhaltungsdaten aller Benutzer sehen und nach der DSGVO zu ihrem Auftragsverarbeiter. Betreiben
Sie den Server selbst, bleiben Ihre Daten zwischen Ihnen, sevDesk und Ihrem Modellanbieter. Für
claude.ai oder ein Team können Sie ihn im [Fernzugriff](remote.de.md) selbst betreiben: auf einer
kleinen VM, einer Plattform wie Fly.io oder Ihrem eigenen Rechner.

### Kann ich mehrere sevDesk-Konten verwenden?

Ja. Über stdio tragen Sie den Server einmal pro Konto unter verschiedenen Namen ein, oder Sie halten
die Konten in einer Profildatei und wählen eines mit `SEVDESK_PROFILE`
([Konfiguration](configuration.de.md#profile)). Im Fernzugriff mit OAuth bedient ein Server jedes
Konto, das Sie in `SEVDESK_OAUTH_ACCOUNTS` aufführen.

## Funktionen in sevDesk

### Welchen sevDesk-Tarif brauche ich?

Einen Tarif mit API-Zugang: sevDesk enthält die API im Tarif Buchhaltung Pro, und die kostenlose
Testphase hat sie.

### Unterstützt der Server sevDesk-Update 2.0?

Ja, er ist dafür gebaut. Update 2.0 hat Steuerarten durch Steuerregeln und Buchungskonten durch
DATEV-Konten ersetzt. Der Server erkennt das Buchhaltungssystem je Konto, schreibt die
Steuerfelder, die das Konto erwartet, und prüft jede Kombination aus Steuerregel und Steuersatz
(und bei Belegen jedes Buchungskonto), bevor etwas gesendet wird, weil sevDesk selbst
Kombinationen annimmt, die es später nicht fertigstellt.

Konten im älteren System 1.0 können alles lesen und Entwürfe von Rechnungen, Aufträgen und
Gutschriften anlegen; schreibende Zugriffe auf Belege brauchen Update 2.0.

### Funktioniert es für Kleinunternehmer?

Ja. Der Server liest Ihre Umsatzsteuerregelung aus sevDesk. Bei einem Kleinunternehmer-Konto
(§19 UStG) erhalten neue Dokumente standardmäßig die Steuerregel für Kleinunternehmer ohne
Umsatzsteuer, und Steuerregeln für die reguläre Umsatzsteuer werden abgelehnt, bevor etwas
gespeichert wird, weil sevDesk solche Dokumente nicht fertigstellen würde. `sevdesk_account_info`
sagt dem Assistenten, welche Regelung gilt.

### Kann es mit E-Rechnungen umgehen?

Ja, in beide Richtungen:

- **Empfangen:** Es liest XRechnung (UBL und CII) und ZUGFeRD / Factur-X lokal aus, prüft Summen
  und Aufschlüsselung der Umsatzsteuer, schlägt einen Beleg vor (Lieferant, Steuerregel, eine
  Position je Steuersatz) und importiert die E-Rechnung als Belegentwurf mit angehängter
  Originaldatei.
- **Versenden:** Es prüft eine ausgehende Rechnung vor dem Fertigstellen auf
  E-Rechnungs-Tauglichkeit (Ihre Firmendaten, den Kunden, Leitweg-ID, Zahlungsbedingungen,
  Einheiten, Steuerregel) und holt das XML, das sevDesk für eine E-Rechnung erzeugt.

Über stdio kommen die Dateien aus einem Ordner, den Sie erlauben (`SEVDESK_FILE_DIRS`); im
Fernzugriff laden Sie sie über eine Seite auf Ihrem Server hoch.

### Kann es nach DATEV exportieren?

Ja. `sevdesk_datev_export` lässt sevDesk den DATEV-Buchungsstapel (CSV-Dateien in einem ZIP) für
einen Monat, ein Quartal, ein Jahr oder einen Zeitraum erstellen und speichert ihn in Ihrem
Ausgabeordner oder bietet ihn im Fernzugriff als Download-Link an. Es schreibt die Dokumente nie
fest. Es braucht die DATEV-Einstellungen in sevDesk (Beraternummer, Mandantennummer, Beginn des
Wirtschaftsjahres). `sevdesk_csv_export` speichert die CSV-Exporte von sevDesk für Rechnungen,
Gutschriften, Belege, Kontoumsätze oder Kontakte, zum Beispiel für Excel.

### Wie weit kann ich mich auf die Umsatzsteuer-Auswertung und die Gewinn- und Verlustrechnung verlassen?

`sevdesk_vat_summary` und `sevdesk_profit_and_loss` sind Schätzungen zum Prüfen. Der Server
berechnet sie aus Ihren Dokumenten und deren Positionen; sie sind weder die Auswertungen von
sevDesk noch eine Steuererklärung. Was sie leisten und was bei Ihnen bleibt:

- **Zeitpunkt (Sollversteuerung).** Umsätze zählen zum Ende der Leistung. Das gilt auch für
  Leistungen an Unternehmen in anderen EU-Staaten (Kz 21 und die Zusammenfassende Meldung): Sie
  gehören in den Zeitraum, in dem sie ausgeführt werden. Innergemeinschaftliche Lieferungen zählen
  nach dem Rechnungsdatum, spätestens im Monat nach der Lieferung.
- **Abschlagsrechnungen.** Ihre Umsatzsteuer entsteht, wenn die Zahlung eingeht. Bei der
  Sollversteuerung berechnet die Umsatzsteuer-Auswertung das nicht: Sie zählt eine
  Abschlagsrechnung wie jede Rechnung zum Leistungsdatum und listet die betroffenen auf
  (`coverage.advanceInvoices`, mit einem Hinweis), damit Sie sie von Hand prüfen können.
- **Einfuhrumsatzsteuer.** sevDesk bucht sie als Betrag einer Position auf dem Konto
  Einfuhrumsatzsteuer (SKR04 1433, SKR03 1588) mit Steuerregel 9. Solche Beträge gehen in Kz 62
  und zählen als Vorsteuer, nicht als Ausgabe. Auf einem anderen Konto gebuchte
  Einfuhrumsatzsteuer wird nicht erkannt.
- **Unvollständiges Lesen.** Wenn eine Obergrenze erreicht ist, wenn sich die Positionen eines
  Dokuments nicht vollständig lesen lassen oder wenn einem Server im Fernzugriff die Zeit ausgeht,
  sagt die Auswertung das (`coverage.truncated`, mit einem Hinweis), und die
  Umsatzsteuer-Auswertung schätzt Kz 83 nicht. Über HTTP hört eine Auswertung nach etwa
  90 Sekunden auf, Dokumente zu lesen, weil eine Anfrage 120 Sekunden dauern darf. Bei der
  voreingestellten Anfragerate sind das einige hundert Dokumente: Fragen Sie nach einem Monat
  statt nach einem Quartal oder Jahr.

### Unterstützt es sevDesk in Österreich?

Nicht in 1.0. Steuerregeln, die Umsatzsteuer-Auswertung (Kennzahlen der UStVA), die Prüfungen für
E-Rechnungen und der Buchhaltungs-Skill folgen deutschem Recht, und der Server ist nur mit
deutschen Konten getestet. Lesen kann mit einem österreichischen Konto funktionieren, aber dort ist
nichts überprüft. Unterstützung für Österreich ist für ein späteres 1.x-Release vorgesehen.

### Kann es Briefe per Post versenden?

Nicht in 1.0. Dokumente lassen sich per E-Mail versenden (Stufe `external`), und beim
Fertigstellen wird festgehalten, wie ein Dokument versendet wurde (zum Beispiel per Post), aber der
Server nutzt den Briefversand von sevDesk nicht.

### Deckt es den Lagerbestand ab?

Ja. `sevdesk_part_get` meldet den aktuellen Bestand, wenn die Bestandsführung aktiv ist,
`sevdesk_parts_list` und `sevdesk_part_get` zeigen `stock` und `stockEnabled`, und
`sevdesk_part_create` und `sevdesk_part_update` setzen sie. Die sevDesk-API hat keine weiteren
Endpunkte für den Lagerbestand.

## Hilfe

### Wo bekomme ich Hilfe?

- **Fragen und Hilfe bei der Einrichtung:**
  [GitHub Discussions](https://github.com/jaylann/mcp-server-sevdesk/discussions/categories/q-a).
- **Fehler und Wünsche:** die
  [Formulare für Issues](https://github.com/jaylann/mcp-server-sevdesk/issues/new/choose). Geben
  Sie die Version des Servers an (`npx -y mcp-server-sevdesk --version`), Ihren Client und den
  Fehlertext, nie Ihr Token oder echte Kundendaten.
- **Sicherheitslücken:** melden Sie sie vertraulich, wie in [SECURITY.de.md](../SECURITY.de.md)
  beschrieben.
- **Ihr sevDesk-Konto** (Tarife, Tokens, Daten in sevDesk): der Support von sevDesk.
- **Steuerfragen:** Ihre Steuerberatung.

Hilfe leisten Freiwillige, so gut es ihnen möglich ist.

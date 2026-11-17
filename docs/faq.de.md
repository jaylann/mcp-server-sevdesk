<!-- translated-from: docs/faq.md sha256:829b1abfd782 -->

# Häufige Fragen

Kurze Antworten auf die Fragen, die vor und während der Arbeit mit dem Server aufkommen, jeweils
mit einem Link zur Seite, die es ausführlich erklärt.

## Allgemeines

### Ist das ein offizielles sevDesk-Produkt?

Nein. mcp-server-sevdesk ist ein inoffizielles Open-Source-Projekt und nicht mit der sevdesk GmbH
verbunden und wird von ihr weder empfohlen noch unterstützt. Es nutzt die öffentliche sevDesk-API
mit deinem eigenen API-Token.

### Was kostet das?

Nichts; der Code steht unter der [MIT-Lizenz](../LICENSE). Du brauchst einen sevDesk-Tarif mit
API-Zugang (Buchhaltung Pro; die kostenlose Testphase enthält ihn) und einen KI-Client, der MCP
unterstützt. Was dein Modellanbieter berechnet, regelst du mit ihm.

### Welche KI-Clients funktionieren?

Jeder MCP-Client: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex, Zed und andere
über stdio; claude.ai und die mobilen Claude-Apps über einen Server, den du im Fernzugriff selbst
betreibst. Jeder Client hat eine eigene Seite zur Einrichtung; die Liste steht unter
[Clients](clients.de.md#client-seiten).

### Ersetzt das meine Steuerberatung?

Nein. Auswertungen wie die Umsatzsteuer-Auswertung und die Gewinn- und Verlustrechnung sind
Schätzungen auf Grundlage deiner sevDesk-Daten und als solche gekennzeichnet. Der Server hilft beim
Erfassen, Prüfen und Vorbereiten; verbindliche Antworten gibt deine Steuerberatung. Nichts, was er
sagt, ist Steuerberatung.

## Daten und Datenschutz

### Sieht die KI mein API-Token?

Nein. Das Token steht in der Konfiguration des Servers (oder in deinem Schlüsselbund), wird nie an
das Modell gegeben und aus jeder Logzeile, jedem Fehler und jedem Eintrag im Audit-Log geschwärzt.
Weil es vollen Zugriff auf das Konto hat, lege es für einen eigenen sevDesk-Benutzer an.

### Wohin gehen meine Daten?

Der Server läuft auf deinem Rechner (oder im Fernzugriff auf deinem eigenen Server) und spricht nur
mit der sevDesk-API. Es gibt drei Ausnahmen: den DATEV-Export, den sevDesk als Download aus seinem
eigenen Speicher (bei Amazon S3) ausliefert, die Prüfung einer USt-IdNr. bei VIES, dem Dienst der
Europäischen Kommission, nur wenn du sie mit `SEVDESK_VIES_CHECK` einschaltest, und einen Server im
Fernzugriff mit OAuth, der das Metadaten-Dokument eines Clients, der sich verbindet, vom Host dieses
Clients abruft. Ergebnisse
gehen an deinen MCP-Client und von dort an deinen Modellanbieter: Rechnungen, Kontakte und
Kontoumsätze sind dann Teil deiner Unterhaltung, zu den Bedingungen dieses Anbieters.
Buchhaltungsdaten enthalten personenbezogene Daten deiner Kunden; prüfe daher die Bedingungen
deines Anbieters zur Auftragsverarbeitung, bevor du ein echtes Konto verbindest.

Das Projekt betreibt keinen Dienst und erhebt keine Telemetrie. Einzelheiten:
[Datenschutz](../PRIVACY.de.md).

### Kann die KI ohne mich Rechnungen fertigstellen oder versenden?

Nein. Standardmäßig liest der Server nur. Fertigstellen, Buchen, Stornieren und Festschreiben
(`commit`) sowie Versenden (`external`) musst du erst freischalten, und dann fragt jeder Aufruf
dich: im Client oder auf einer Freigabeseite in deinem Browser. Das Modell kann diese Bestätigung
nicht selbst geben ([Berechtigungen](permissions.de.md)).

### Was passiert, wenn etwas schiefgeht?

Jeder Schreibvorgang wird geprüft, bevor etwas gesendet wird (Status, Beträge, Steuerregel und
Steuersatz, Buchungskonten, Dubletten), nie automatisch wiederholt und danach aus sevDesk
zurückgelesen. Ein Probelauf zeigt, was passieren würde, ohne etwas zu senden, und das optionale
Audit-Log auf deinem Rechner hält jeden Schritt fest
([Wie ein Schreibvorgang abläuft](permissions.de.md#wie-ein-schreibvorgang-abläuft),
[Audit-Log](permissions/audit-log.de.md)). Fertiggestellte und festgeschriebene Dokumente lassen
sich in sevDesk nicht einfach löschen; deshalb brauchen diese Schritte deine Bestätigung.

### Warum gibt es keine gehostete Version?

Ein gehosteter Dienst würde die API-Tokens aller Benutzer halten, und jedes Token kann in seinem
Konto alles, ohne einschränkbare Rechte und ohne Ablaufdatum. Er würde außerdem die
Buchhaltungsdaten aller Benutzer sehen und nach der DSGVO zu ihrem Auftragsverarbeiter. Betreibst
du den Server selbst, bleiben deine Daten zwischen dir, sevDesk und deinem Modellanbieter. Für
claude.ai oder ein Team kannst du ihn im [Fernzugriff](remote.de.md) selbst betreiben: auf einer
kleinen VM, einer Plattform wie Fly.io oder deinem eigenen Rechner.

### Kann ich mehrere sevDesk-Konten verwenden?

Ja. Über stdio trägst du den Server einmal pro Konto unter verschiedenen Namen ein, oder du hältst
die Konten in einer Profildatei und wählst eines mit `SEVDESK_PROFILE`
([Profile](configuration/profiles.de.md#profile)). Im Fernzugriff mit OAuth bedient ein Server
jedes Konto, das du in `SEVDESK_OAUTH_ACCOUNTS` aufführst.

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

Ja. Der Server liest deine Umsatzsteuerregelung aus sevDesk. Bei einem Kleinunternehmer-Konto
(§19 UStG) erhalten neue Dokumente standardmäßig die Steuerregel für Kleinunternehmer ohne
Umsatzsteuer, und Steuerregeln für die reguläre Umsatzsteuer werden abgelehnt, bevor etwas
gespeichert wird, weil sevDesk solche Dokumente nicht fertigstellen würde. `sevdesk_account_info`
sagt dem Assistenten, welche Regelung gilt.

### Kann es einen Rabatt auf die ganze Rechnung geben?

Ja, auf Entwürfen von Rechnungen, Angeboten, Auftragsbestätigungen und Gutschriften: einen
Prozentsatz vom Nettobetrag oder einen festen Nettobetrag in EUR, mit seinem Text, gesetzt,
ersetzt oder entfernt mit den Entwurfswerkzeugen
([Ein Rabatt auf die ganze Rechnung](guides/invoices.de.md#ein-rabatt-auf-die-ganze-rechnung)).
Vorerst nur bei Nettopreisen mit einem einzigen Steuersatz und nicht auf E-Rechnungen, den Fällen,
die gegen sevDesk geprüft sind. Welchen Rabatt ein Entwurf auch trägt, die Freigabe zeigt ihn,
bevor du fertigstellst oder versendest, und eine Rechnung aus einem Angebot übernimmt dessen
Rabatt.

### Kann es eine englische Rechnung schreiben oder anderes Briefpapier nehmen?

Ja, auf Entwürfen von Rechnungen, Aufträgen und Gutschriften: `sevdesk_document_set_layout` setzt
die Sprache (acht, darunter Englisch), die Vorlage und das Briefpapier
([Eine englische Rechnung auf anderem Briefpapier](guides/invoices.de.md#eine-englische-rechnung-auf-anderem-briefpapier)).
Es braucht die Stufe `commit` und deine Bestätigung, weil sevDesk mit derselben Anfrage auch
fertige Dokumente ändert. Kopf- und Fußtexte können über ihren Namen aus deinen Textvorlagen
kommen; Textvorlagen anlegen oder löschen bleibt in sevDesk. Die Freigabe vor dem Fertigstellen
oder Versenden eines Entwurfs zeigt Sprache, Vorlage und Briefpapier.

### Kann es mit E-Rechnungen umgehen?

Ja, in beide Richtungen. Empfangene XRechnungen (UBL und CII) und ZUGFeRD-/Factur-X-Dateien werden
lokal ausgelesen, geprüft und als Belegentwürfe mit angehängter Originaldatei importiert
([Eine E-Rechnung importieren](guides/receipts.de.md#eine-e-rechnung-importieren)). Ausgehende Rechnungen lassen sich vor dem
Fertigstellen auf E-Rechnungs-Tauglichkeit prüfen, und das XML, das sevDesk erzeugt, lässt sich
abrufen ([Bereit für die E-Rechnung](guides/invoices.de.md#bereit-für-die-e-rechnung)). Über stdio kommen die Dateien aus
einem Ordner, den du erlaubst (`SEVDESK_FILE_DIRS`); im Fernzugriff lädst du sie über eine Seite
auf deinem Server hoch.

### Kann es nach DATEV exportieren?

Ja. [`sevdesk_datev_export`](tools.md#sevdesk_datev_export) lässt sevDesk den
DATEV-Buchungsstapel (CSV-Dateien in einem ZIP) für einen Monat, ein Quartal, ein Jahr oder einen
Zeitraum erstellen, gespeichert in deinem Ausgabeordner oder im Fernzugriff als Download-Link
angeboten. Es schreibt die Dokumente nie fest und braucht die DATEV-Einstellungen in sevDesk
(Beraternummer, Mandantennummer, Beginn des Wirtschaftsjahres), die
[`sevdesk_datev_settings_update`](tools.md#sevdesk_datev_settings_update) nach deiner Bestätigung
setzt. Mit `format: "xml"` exportiert es stattdessen die Dokumente als DATEV-XML mit ihren
Belegbildern. [`sevdesk_csv_export`](tools.md#sevdesk_csv_export) speichert die CSV-Exporte von
sevDesk, zum Beispiel für Excel.

### Bekomme ich alle Rechnungs- oder Beleg-PDFs auf einmal, für die Steuerberatung oder eine Betriebsprüfung?

Ja. [`sevdesk_archive_export`](tools.md#sevdesk_archive_export) lässt sevDesk die Rechnungs-PDFs
oder die Belege eines Zeitraums in ein ZIP packen, standardmäßig höchstens 500 Dokumente (bis
1.000) und 100 MiB pro Datei, und ändert nichts an den Dokumenten. sevDesk nimmt Entwürfe mit (das Ergebnis zählt sie,
damit du sie herausnehmen kannst) und lässt Belege ohne Belegdatei weg. Ein großes Archiv dauert
Minuten; die Abhilfe ist ein kürzerer Zeitraum. Mehr dazu:
[Auswertungen und Exporte](guides/evaluations.de.md#rechnungs--und-belegarchiv).

### Wie weit kann ich mich auf die Umsatzsteuer-Auswertung und die Gewinn- und Verlustrechnung verlassen?

Sie sind Schätzungen zum Prüfen, die der Server aus deinen Dokumenten berechnet; sie sind weder die
Auswertungen von sevDesk noch eine Steuererklärung. Jedes Ergebnis sagt, was es ausgelassen hat.
Was sie abdecken und was bei dir bleibt, steht unter
[Auswertungen und Exporte](guides/evaluations.de.md#wie-weit-du-dich-darauf-verlassen-kannst).

### Findet es doppelt gebuchte Belege oder fehlende Rechnungen?

Ja, als Hinweise. `sevdesk_records_audit` mit `check: duplicates` sucht doppelt gebuchte Belege
(derselbe Lieferant und dieselbe Belegnummer, dieselbe Belegdatei oder derselbe Betrag innerhalb
weniger Tage) und Entwürfe, die drei Wochen oder länger offen liegen; `check: recurring_gaps` lernt,
welche Lieferanten jeden Monat, jedes Quartal oder jedes Jahr abrechnen, und nennt die Zeiträume
ohne Rechnung, meist ein verlorener Beleg. Beide lesen nur deine Daten und ändern nichts. Was sie
melden und was sie bewusst auslassen, steht unter
[Auswertungen und Exporte](guides/evaluations.de.md#prüfungen).

### Erkennt es, welche Belege in meinem Ordner nie gebucht wurden?

Ja, wenn der Server diesen Ordner lesen darf (`SEVDESK_FILE_DIRS`: nicht auf einem entfernten
Server mit OAuth; im Bearer-Modus nur für Ordner auf dem Server). `sevdesk_receipt_folder_check`
vergleicht die SHA-256-Prüfsummen der PDF-, PNG-, JPEG- und XML-Dateien im Ordner mit denen der
Belegdateien an deinen Belegen, für einen Monat, ein Quartal oder ein Jahr. Eine Datei, die kein
Beleg trägt, wurde wohl nie gebucht; das ist ein
Hinweis, kein Beweis, denn derselbe Beleg als andere Datei (ein Scan, ein Foto aus der App) hat
eine andere Prüfsumme, und eine Belegdatei, die die Belegerkennung von sevDesk aus einem Upload
angelegt hat, hat gar keine (das Ergebnis zählt sie und nennt solche derselben Größe als
schwachen Hinweis). Die Prüfung holt keinen Dateiinhalt ins Gespräch und lädt nichts hoch
([Auswertungen und Exporte](guides/evaluations.de.md#belege-im-ordner-die-nie-gebucht-wurden)).

### Unterstützt es sevDesk in Österreich?

Nicht in 1.0. Steuerregeln, die Umsatzsteuer-Auswertung (Kennzahlen der UStVA), die Prüfungen für
E-Rechnungen und der Buchhaltungs-Skill folgen deutschem Recht, und der Server ist nur mit
deutschen Konten getestet. Lesen kann mit einem österreichischen Konto funktionieren, aber dort ist
nichts überprüft. Unterstützung für Österreich ist für ein späteres 1.x-Release vorgesehen.

### Kann es Abo-Rechnungen einrichten?

Ja. [`sevdesk_invoice_create_recurring`](tools.md#sevdesk_invoice_create_recurring) (Stufe
`commit`, du bestätigst) speichert eine Vorlage für wiederkehrende Rechnungen, monatlich, vierteljährlich,
halbjährlich oder jährlich, mit eingeschalteter automatischer Generierung, außer du willst sie aus
([Abo-Rechnungen](guides/invoices.de.md#abo-rechnungen)). sevDesk erzeugt daraus dann an jedem
Ausführungstag selbst einen Rechnungsentwurf, innerhalb etwa einer Minute: nicht fertiggestellt,
nicht versendet, mit einer vorläufigen Nummer, die beim Fertigstellen endgültig wird. Du prüfst
jeden Entwurf und stellst ihn mit den üblichen Rechnungswerkzeugen fertig und versendest ihn. Das
automatische Versenden von sevDesk, das jede erzeugte Rechnung fertigstellen, per E-Mail versenden
und festschreiben würde, bevor jemand sie sieht, schaltet der Server nie ein.
[`sevdesk_invoice_update_recurring`](tools.md#sevdesk_invoice_update_recurring) ändert eine Vorlage
(auch ihre automatische Generierung),
[`sevdesk_invoice_end_recurring`](tools.md#sevdesk_invoice_end_recurring) beendet eine und
[`sevdesk_invoice_reactivate_recurring`](tools.md#sevdesk_invoice_reactivate_recurring) startet sie
wieder, jeweils Stufe `commit` mit deiner Bestätigung. Eine Vorlage mit eingeschaltetem
automatischem Versenden wird hier nur beendet; Ändern oder Aktivieren bleibt der sevDesk-Web-App
überlassen. Löschen lässt sich eine Vorlage nur in der sevDesk-Web-App.

### Kann es mit Angeboten, Auftragsbestätigungen und Lieferscheinen umgehen?

Ja. Neben Angebotsentwürfen hält es die Antwort des Kunden fest (angenommen oder abgelehnt,
`commit`), legt aus einem Angebot die Auftragsbestätigung an (`commit`, weil sevDesk das Angebot
dabei als angenommen markiert) und aus einer Auftragsbestätigung einen Lieferschein (`write`) und
danach die Rechnung aus dem Auftrag ([Rechnungen](guides/invoices.de.md#angebote-annehmen-bestätigen-liefern)).
Einen eigenen Filter für liegengebliebene Angebote gibt es nicht; frag nach versendeten Angeboten
in einem Zeitraum.

### Kann es Briefe per Post versenden?

Nicht in 1.0. Dokumente lassen sich per E-Mail versenden (Stufe `external`), und beim
Fertigstellen wird festgehalten, wie ein Dokument versendet wurde (zum Beispiel per Post), aber der
Server nutzt den Briefversand von sevDesk nicht.

### Deckt es den Lagerbestand ab?

Ja. `sevdesk_part_get` meldet den aktuellen Bestand, wenn die Bestandsführung aktiv ist,
`sevdesk_parts_list` und `sevdesk_part_get` zeigen `stock` und `stockEnabled`, und
`sevdesk_part_create` und `sevdesk_part_update` setzen sie. Die sevDesk-API hat keine weiteren
Endpunkte für den Lagerbestand.

### Kann es mit Zusatzfeldern von Kontakten umgehen?

Ja, mit ihren Werten. `sevdesk_contact_get` zeigt die Zusatzfelder eines Kontakts mit ihren
Namen, `sevdesk_contact_create` und `sevdesk_contact_update` setzen sie (`customFields`, über die
ID oder den Namen des Felds), `sevdesk_contact_update` entfernt einen Wert (`remove` mit kind
`customField`), und `sevdesk_contacts_search` findet Kontakte über einen Wert (`customField`; der
ganze Wert, Groß- und Kleinschreibung egal). `sevdesk_reference_lookup` mit kind
`contact_custom_fields` listet die Felder deines Kontos. Die Felder selbst legst du in der
sevDesk-Weboberfläche an: Wer dort ein Feld löscht, löscht seinen Wert bei jedem Kontakt, darum
legt der Server nie ein Feld an, benennt keins um und löscht keins.

## Hilfe

### Wo bekomme ich Hilfe?

- **Der Server startet nicht, oder ein Werkzeug scheitert:** [Fehlersuche](troubleshooting.de.md)
  und, für einen Server, den du selbst betreibst,
  [Fehlersuche im Fernzugriff](remote/troubleshooting.de.md).
- **Fragen und Hilfe bei der Einrichtung:**
  [GitHub Discussions](https://github.com/jaylann/mcp-server-sevdesk/discussions/categories/q-a).
- **Fehler und Wünsche:** die
  [Formulare für Issues](https://github.com/jaylann/mcp-server-sevdesk/issues/new/choose). Gib
  die Version des Servers an (`npx -y mcp-server-sevdesk --version`), deinen Client und den
  Fehlertext, nie dein Token oder echte Kundendaten.
- **Sicherheitslücken:** melde sie vertraulich, wie in der [Sicherheitsrichtlinie](../SECURITY.de.md)
  beschrieben.
- **Dein sevDesk-Konto** (Tarife, Tokens, Daten in sevDesk): der Support von sevDesk.
- **Steuerfragen:** deine Steuerberatung.

Hilfe leisten Freiwillige, so gut es ihnen möglich ist.

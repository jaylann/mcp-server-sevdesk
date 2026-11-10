<!-- translated-from: PRIVACY.md sha256:c99c09377cd5 -->

# Datenschutz

mcp-server-sevdesk ist Software, die Sie selbst betreiben. Das Projekt betreibt keinen Dienst und
erhebt **keine Telemetrie**.

- **Datenfluss.** Der Server spricht nur mit der sevDesk-API (`https://my.sevdesk.de/api/v1`), mit
  Ihrem Token, und gibt Ergebnisse an den MCP-Client zurück, den Sie verbunden haben (zum Beispiel
  Claude Desktop). Was Ihr Client oder Ihr Modellanbieter mit diesen Daten tut, regeln deren
  Bedingungen.
- **Lokale Speicherung.** Nichts wird gespeichert, solange Sie es nicht aktivieren: Das optionale
  Audit-Log (`SEVDESK_AUDIT_LOG`) und der Ausgabeordner (`SEVDESK_OUTPUT_DIR`) sind Dateien
  auf Ihrem Rechner.
- **Ihr Token.** Nutzen Sie `token set`, wird das Token im Schlüsselbund Ihres Betriebssystems
  (macOS-Schlüsselbund oder Linux Secret Service) unter dem Dienst `mcp-server-sevdesk` abgelegt
  und nirgends sonst. Eine Profildatei enthält Einstellungen und den Ort jedes Tokens (eine
  Bezeichnung im Schlüsselbund, einen Dateipfad oder einen Variablennamen), nie ein Token. Die
  Einstellungen der Claude-Desktop-Erweiterung, einschließlich des Tokens, speichert Claude
  Desktop, das Token im sicheren Speicher des Betriebssystems.
- **Buchhaltungsdaten sind personenbezogene Daten.** Rechnungen und Kontakte enthalten
  personenbezogene Daten Ihrer Kunden. Prüfen Sie die Bedingungen Ihres Modellanbieters zur
  Auftragsverarbeitung, bevor Sie ein echtes Konto verbinden.

## Fernzugriff

Betreiben Sie den HTTP-Transport selbst ([docs/remote.de.md](docs/remote.de.md)), sind Sie der
Betreiber und für die dort verarbeiteten personenbezogenen Daten verantwortlich (DSGVO). Mit
`SEVDESK_OAUTH_ACCOUNTS=any` können dazu auch die Konten anderer Leute gehören.

- **Was der Server speichert.** Im OAuth-Modus enthält das Zustandsverzeichnis
  (`SEVDESK_HTTP_STATE_DIR`, oder der Speicher) je Verbindung eine zufällige ID des Zugangs, die
  sevDesk-Konto-ID, die `client_id`-URL des Clients und ihren Host, die gewährten Stufen,
  Zeitstempel und den Status; je Browser-Anmeldung (das Freigabe-Postfach und die Seiten zum Hoch-
  und Herunterladen) eine zufällige Sitzungs-ID, die Konto-ID und den Zugang, aus dem sie stammt.
  Es enthält **keine Tokens**: keine sevDesk-Tokens, keine Access- oder Refresh-Tokens, keine
  Cookies. Das sevDesk-Token ist verschlüsselt in den Tokens enthalten, die der Client hält. Im
  Bearer-Modus enthält die eigene Umgebung des Servers das eine sevDesk-Token.
- **Dokumente werden kurz und verschlüsselt gehalten.** Mit Dateiübertragung
  (`SEVDESK_HTTP_FILES`, standardmäßig an) hält der Server die Belege und E-Rechnungen, die
  Benutzer hochladen, und die PDFs und Exporte, die Werkzeuge als Download-Links ausgeben, für
  `SEVDESK_HTTP_FILES_TTL` (standardmäßig 30 Minuten, höchstens 24 Stunden). Sie sind unter einem
  Schlüssel verschlüsselt, den es nur im laufenden Prozess gibt, liegen im Speicher oder im Ordner
  `files/` des Zustandsverzeichnisses, werden gelöscht, wenn sie ablaufen, und beim
  Herunterfahren, und der Ordner wird bei jedem Start geleert: Ein Neustart macht sie alle
  ungültig. Im Speicher hält der Server außerdem fest, wem jede Datei gehört, ihren bereinigten
  Namen, Größe, SHA-256 und Ablauf; das Audit-Log vermerkt jeden Upload und Download ohne Namen und
  Inhalt. Hoch- und Herunterladen brauchen eine Browser-Sitzung des Kontos. Mit
  `SEVDESK_OAUTH_ACCOUNTS=any` betrifft das die Dokumente jedes Kontos, das sich verbindet.
- **Das Audit-Log umfasst jedes Konto.** Mit `SEVDESK_AUDIT_LOG` hält eine Datei die schreibenden
  Aufrufe jedes verbundenen Kontos fest, mit Vorschauen, die Kundennamen, Beträge und E-Mail-Texte
  enthalten, und nennt in jeder Zeile das Konto und den Zugang.
- **Dritte.** Startet jemand eine OAuth-Verbindung, ruft der Server das Metadaten-Dokument des
  Clients von dessen Host ab (bei claude.ai: `claude.ai`); dieser Host sieht die IP-Adresse des
  Servers und den Zeitpunkt. Wer TLS vor dem Server terminiert (ein Tunnel wie der von Cloudflare
  oder eine Plattform wie Fly.io, Render oder Railway), verarbeitet den gesamten Verkehr,
  einschließlich Tokens und Buchhaltungsdaten, und ist ein Auftragsverarbeiter, den Sie wählen.
  Das Anfrage-Log des Servers enthält Client-IP-Adressen.

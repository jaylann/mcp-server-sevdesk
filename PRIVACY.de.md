<!-- translated-from: PRIVACY.md sha256:723c362e9f98 -->

# Datenschutz

mcp-server-sevdesk ist Software, die Sie selbst betreiben. Das Projekt betreibt keinen Dienst und
erhebt **keine Telemetrie**.

- **Datenfluss.** Der Server sendet seine Anfragen an die sevDesk-API
  (`https://my.sevdesk.de/api/v1`, oder die von Ihnen gesetzte `SEVDESK_BASE_URL`), mit Ihrem
  Token, und gibt Ergebnisse an den MCP-Client zurück, den Sie verbunden haben (zum Beispiel
  Claude Desktop). Was Ihr Client oder Ihr Modellanbieter mit diesen Daten tut, regeln deren
  Bedingungen. Einen anderen Host kontaktiert er nicht, mit zwei Ausnahmen:
  - **DATEV-Export.** `sevdesk_datev_export` (Stufe `write`) lädt das fertige ZIP aus dem
    Export-Speicher von sevDesk bei Amazon S3
    (`sevexport-filestorage-workload-prod.s3.eu-central-1.amazonaws.com`), über den vorsignierten
    Link, den sevDesk für den Export zurückgibt. Die Anfrage enthält diesen Link und kein
    sevDesk-Token; der Speicher-Host sieht die IP-Adresse des Servers und den Zeitpunkt. Ein Link
    zu einem anderen Host wird abgelehnt, und Weiterleitungen werden nicht verfolgt.
  - **Client-Metadaten im Fernzugriff mit OAuth**: siehe „Dritte“ unter
    [Fernzugriff](#fernzugriff).
- **Freigabeseite.** Mit `SEVDESK_CONFIRM=browser` (lokale Nutzung) wird die Vorschau einer Aktion
  auf einer Seite gezeigt, die der Server auf `127.0.0.1` bereitstellt und über den Öffner des
  Betriebssystems in Ihrem Standardbrowser öffnet; mit `SEVDESK_CONFIRM_OPEN=0` schreibt er den
  Link nur in sein Log. Die Seite lädt nichts von anderen Hosts.
- **Lokale Speicherung.** Nichts wird gespeichert, solange Sie es nicht aktivieren: Das optionale
  Audit-Log (`SEVDESK_AUDIT_LOG`) und der Ausgabeordner (`SEVDESK_OUTPUT_DIR`) sind Dateien
  auf Ihrem Rechner.
- **Ihr Token.** Nutzen Sie `token set`, wird das Token im Schlüsselbund Ihres Betriebssystems
  (macOS-Schlüsselbund, Linux Secret Service oder Windows Credential Locker über `PasswordVault`)
  unter dem Dienst `mcp-server-sevdesk` abgelegt. Unter Windows können Anmeldeinformationen
  [über Ihr Microsoft-Konto zwischen Geräten synchronisiert werden](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker).
  Soll das Token auf diesem Gerät bleiben, verwenden Sie `SEVDESK_API_TOKEN_FILE` mit einer Datei,
  die nur Ihr Benutzer lesen kann und die außerhalb synchronisierter Ordner liegt. Eine
  Profildatei enthält Einstellungen und den Ort jedes Tokens (eine Bezeichnung im Schlüsselbund,
  einen Dateipfad oder einen Variablennamen), nie ein Token. Die Einstellungen der
  Claude-Desktop-Erweiterung, einschließlich des Tokens, speichert Claude Desktop, das Token im
  sicheren Speicher des Betriebssystems.
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
  Aufrufe jedes verbundenen Kontos fest, mit Vorschauen, die Kundennamen, Beträge, E-Mail-Texte
  und die Namen von Belegdateien enthalten, und nennt in jeder Zeile das Konto und den Zugang.
- **Dritte.** Startet jemand eine OAuth-Verbindung, ruft der Server das Metadaten-Dokument des
  Clients von dessen Host ab (bei claude.ai: `claude.ai`); dieser Host sieht die IP-Adresse des
  Servers und den Zeitpunkt. Wer TLS vor dem Server terminiert (ein Tunnel wie der von Cloudflare
  oder eine Plattform wie Fly.io, Render oder Railway), verarbeitet den gesamten Verkehr,
  einschließlich Tokens und Buchhaltungsdaten, und ist ein Auftragsverarbeiter, den Sie wählen.
  Das Anfrage-Log des Servers enthält Client-IP-Adressen.

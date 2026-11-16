<!-- translated-from: docs/security/local.md sha256:eac86a3e10d7 -->

# Lokale Nutzung

Die Sicherheitsanalyse dessen, was der Server auf deinem eigenen Rechner anfasst: lokale Dateien, das
generische Lesewerkzeug, das Token im Schlüsselbund, Profile und die Claude-Desktop-Erweiterung. Wie
du das einrichtest, steht unter [Konfiguration](../configuration.de.md) und
[Profile](../configuration/profiles.de.md); die Integrität des Audit-Logs ist beim Log selbst
beschrieben ([Audit-Log](../permissions/audit-log.de.md#integrität)).

## Lokale Dateien

Das Modell nennt Dateien; der Server darf also nicht zu einem Weg werden, beliebige Dateien zu lesen
oder zu schreiben. Ohne `SEVDESK_FILE_DIRS` und `SEVDESK_OUTPUT_DIR` liest oder schreibt kein
Werkzeug lokale Dateien.

- **Lesen** geschieht nur innerhalb von `SEVDESK_FILE_DIRS` (absolute Ordner). Echte Pfade werden
  geprüft, symbolische Links dürfen nicht nach außen führen, die Datei wird geöffnet, ohne einem
  Link zu folgen, und über ihre Inode geprüft, ihr Typ wird am Inhalt erkannt, und Größen sind
  begrenzt.
- **Schreiben** geschieht nur innerhalb von `SEVDESK_OUTPUT_DIR`: nur neue Dateien, Modus 0600, nie
  überschreibend.

Empfangene E-Rechnungen sind feindliche Eingaben. Der XML-Parser lehnt DOCTYPEs und Entitäten ab,
begrenzt Größe und Verschachtelungstiefe und liest ein Element nur in dem Namensraum, den das
Rechnungsformat dafür festlegt. Der Leser für PDF-Anhänge begrenzt die entpackten Größen, die Zahl
der Werte, die er aus einem PDF aufbaut (eine Million), die Länge von Namen, Zahlen und
Zeichenketten und den Leseaufwand je Byte der Datei. Jedes ausgelesene Textfeld gilt als nicht
vertrauenswürdig. Ein PDF wird weiterhin im Serverprozess gelesen; eine feindliche Datei an diesen
Grenzen kann ihn also mehrere Sekunden beschäftigen, aber nicht länger.

Das ZIP des DATEV-Exports wird über einen vorsignierten Link geholt, den sevDesk zurückgibt. Der
Server akzeptiert dafür genau einen https-Host, folgt keinen Weiterleitungen, sendet keine
Zugangsdaten, begrenzt die Größe und zeigt den Link nie dem Modell.

## Dateien von einem Link

Ist `SEVDESK_FILE_URL_HOSTS` gesetzt (standardmäßig ist die Variable leer und die Funktion aus),
nehmen die Werkzeuge, die einen Beleg oder eine E-Rechnung lesen, als `file` auch einen https-Link
an. Der Link kommt vom Modell, das manipuliert werden kann; der Server darf also nicht zu einem Weg
in sein eigenes Netz werden und nicht von überall laden (`src/safety/url-files.ts`):

- Vor jeder Netzwerkanfrage: nur https, der Standardport, kein Benutzername oder Passwort, ein
  Hostname statt einer IP-Adresse (auch nicht in Formen wie `0x7f.1` oder `2130706433`, die Parser
  zu einer machen), und der Host steht auf der Liste des Betreibers (genau, oder `*.example.com`
  für dessen Subdomains). Mit leerer Liste wird jeder Link abgelehnt, mit dem Namen der
  Einstellung.
- Der Host wird je Download einmal aufgelöst, und jede Adresse muss öffentlich sein, nach
  denselben Regeln wie beim Abruf der Client-Metadaten im OAuth-Modus
  ([SSRF](remote.de.md#metadaten-von-clients-abrufen-ssrf)): Private, Loopback-, Link-Local-,
  CGNAT-, Unique-Local-, Dokumentations- und Multicast-Bereiche werden abgelehnt, auch innerhalb
  von NAT64-, 6to4- und IPv4-gemappten Adressen. Die Verbindung geht an die geprüfte Adresse
  (festgelegte Auflösung, SNI und Zertifikatsprüfung für den Namen), eine zweite DNS-Antwort wird
  also nie verwendet (DNS-Rebinding).
- Weiterleitungen werden höchstens dreimal verfolgt, weil Cloud-Speicher und Portale Links
  ausgeben, die weiterleiten; jedes Ziel durchläuft dieselben Prüfungen samt Liste, und ein Host,
  der im Download schon aufgelöst wurde, behält seine Adresse.
- Die Anfrage enthält nur `Accept` und `User-Agent`: kein Cookie, kein `Authorization`, nie das
  sevDesk-Token. Eine Antwort muss 200 sein, unkomprimiert, mit einem Inhaltstyp, der zu einer
  PDF-, PNG-, JPEG- oder XML-Datei passt und zum Inhalt stimmt, höchstens 20 MiB (geprüft an
  `Content-Length` und während der Body ankommt), innerhalb von 60 Sekunden; höchstens vier
  Downloads laufen gleichzeitig.
- Nach dem Aufruf bleibt nichts. Ablehnungen sind vertrauenswürdiger Text: Sie nennen die
  Einstellung und die erlaubten Hosts, nie den Link, seinen Pfad oder seine Query, ein
  Weiterleitungsziel oder etwas, das der Host gesendet hat. Vorschau und Ergebnis zeigen die
  SHA-256 der Datei und den Host; das Audit-Log hält den Link ohne Benutzerangaben, Query und
  Fragment fest.

Das verbleibende Risiko ist die Liste selbst: Ein Host darauf, der Dateien ausliefert, die jeder
hochladen kann (eine geteilte Cloud-Speicher-Domain, besonders unter `*.`), lässt das Modell eine
solche Datei als Beleg anhängen.

## Generischer Lesezugriff

`sevdesk_api_get` (Werkzeuggruppe `advanced`, standardmäßig aus) lässt das Modell einen GET-Pfad
wählen, was ein kuratiertes Werkzeug nie tut. Es hat vier unabhängige Schutzmechanismen:

1. Das konfigurierte sevDesk-Token irgendwo im Pfad oder in der Query wird abgelehnt, und die
   Ablehnung wiederholt den Pfad nicht.
2. `genericGetRefusal` lehnt, bevor etwas gesendet wird, Endpunkte ab, die Zustand ändern, Dateien
   liefern oder Hintergrundaufgaben starten (`getPdf`, `getXml`, `render`, `sendBy`, `bookAmount`,
   `enshrine`, `cancelInvoice`, die Endpunkte zum Zurücksetzen, `getNext…Number`, Segmente, die mit
   einem verändernden Verb beginnen, und alles unter `Export`, `ExportJob`, `Progress`, `Report`,
   `DocServer` und `SevSequence`), sowie gefährliche Query-Schlüssel: Zugangsdaten (sevDesk nimmt
   `?token=` an), Schlüssel zum Blättern, die das Werkzeug selbst setzt, `download`,
   `preventSendBy`, `enshrine…`, `useNextNumber` und Methoden-Overrides. Query-Schlüssel werden so
   normalisiert, wie PHP sie liest; so werden auch `Api.Key` oder `token[0]` erkannt.
3. Der Client ohne Schreibrechte lehnt jedes GET mit einer Nebenwirkung ab, das
   `resolveGetSafety` erkennt.
4. Der HTTP-Client lehnt es erneut ab, weil ein Lesezugriff keine Stufe angibt.

Antworten werden mit einer Grenze von 1 MiB gelesen, müssen JSON in der `{objects: …}`-Hülle von
sevDesk sein und werden wie nicht vertrauenswürdiger Text bereinigt: unsichtbare Zeichen entfernt,
Zeichenketten begrenzt, Binärinhalte (Dateien in Base64, Vorschaubilder) und Echos von `sevClient`
entfernt und aufgeführt, höchstens etwa 100 KB zurückgegeben. Das verbleibende Risiko ist ein
undokumentiertes GET mit einer Nebenwirkung, das keine dieser Regeln erfasst; deshalb ist die
Werkzeuggruppe standardmäßig aus.

## Lokale Token-Ablage und Profile

Über stdio kommt das Token aus der Umgebung, einer Datei (`SEVDESK_API_TOKEN_FILE`) oder dem
Schlüsselbund des Betriebssystems (`SEVDESK_API_TOKEN_KEYCHAIN`). Es wird nie protokolliert,
ausgegeben oder in Fehler aufgenommen.

### Schlüsselbund

Einträge liegen unter dem festen Dienst `mcp-server-sevdesk`; die Konfiguration nennt nur die
Bezeichnung, sodass eine feindliche Konfiguration den Server nicht dazu bringen kann, einen anderen
Schlüsselbund-Eintrag (ein Passwort, ein anderes Token) zu lesen und an eine eigene
`SEVDESK_BASE_URL` zu senden. Der Server führt das Hilfsprogramm des Betriebssystems
(`/usr/bin/security` unter macOS, `secret-tool` unter Linux, Windows PowerShell mit WinRT
`PasswordVault` unter Windows) mit einem Argument-Array aus, nie über eine Shell. Beim Ablegen reist
das Token über stdin des Hilfsprogramms, nie in seinen Argumenten, die andere lokale Benutzer in der
Prozessliste sehen könnten. Die Ausgabe des Hilfsprogramms ist begrenzt, wird nie protokolliert oder
ausgegeben, und Fehler sind feste Texte.

Der Schlüsselbund schützt das Token im Ruhezustand, in Konfigurationsdateien, Backups und
Screenshots; er schützt nicht vor Code, der bereits als derselbe Benutzer läuft. Unter macOS
vertraut der Eintrag `/usr/bin/security`, das ihn angelegt hat; jeder Prozess des Benutzers kann ihn
also auf diesem Weg ohne Dialog lesen.

Unter Windows ist das Skript konstant; Operation, Bezeichnung und Token reisen nur über stdin. Das
Programm wird ausschließlich unter einem validierten, vertrauenswürdigen `SystemRoot` aufgelöst, nie
über `PATH` oder das aktuelle Verzeichnis. Windows PowerShell muss im `FullLanguage`-Modus laufen;
der Constrained Language Mode wird ohne Änderung der Richtlinie abgelehnt, mit einem Hinweis auf
`SEVDESK_API_TOKEN_FILE` oder das `.mcpb`-Bundle. Einträge im Credential Locker können über das
Microsoft-Konto synchronisiert werden; eine geschützte Token-Datei ist die Alternative, wenn das
Token auf diesem Gerät bleiben muss.

### Die Kommandozeile

`token set` liest das Token von stdin (in einem Terminal verdeckt), nie aus einem Argument, wo es in
der Shell-Historie bliebe. Es prüft das Token bei sevDesk und legt nichts ab, was sevDesk ablehnt.
Bezeichnungen, Profilnamen und unbekannte Argumente, die wie ein Token aussehen, werden nie
ausgegeben.

### Profile

Ein Profil kann Stufen und Ordner erweitern; unter macOS und Linux müssen die Profildatei und ihr
Ordner (auch der echte Ordner hinter einem symbolischen Link) daher dem Benutzer oder root gehören
und dürfen für Gruppe und andere nicht beschreibbar sein; sonst wird die Datei abgelehnt. Unter
Windows wird das nicht geprüft.

Profile enthalten nie ein Token, nur den Ort, an dem es aufbewahrt wird, und das `token.env` eines
Profils darf nur `SEVDESK_TOKEN_*`-Variablen nennen, sodass ein Profil kein beliebiges Geheimnis aus
der Umgebung an eine eigene Basis-URL senden kann. Eine Variable, die sowohl in der Umgebung als
auch im Profil gesetzt ist, ist ein Fehler; nur `SEVDESK_READ_ONLY=1` und `SEVDESK_DRY_RUN=1` in der
Umgebung dürfen ein Profil stillschweigend verschärfen. Meldungen über die Datei zitieren nie ihren
Inhalt.

Der HTTP-Modus lehnt `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` und `SEVDESK_API_TOKEN_KEYCHAIN` ab:
Ein Server hat keinen Benutzer-Schlüsselbund, und seine Konfiguration gehört in seine Umgebung.

## Claude-Desktop-Erweiterung

Das `.mcpb`-Bundle betreibt denselben Server über stdio auf dem eingebauten Node.js von Claude
Desktop. Claude Desktop speichert das Token, eine als sensibel markierte Einstellung, im sicheren
Speicher des Betriebssystems (Schlüsselbund unter macOS, Anmeldeinformationsverwaltung unter
Windows) und übergibt es dem Server beim Start als `SEVDESK_API_TOKEN`; das Token erscheint nie in
der Kommandozeile.

Das Bundle enthält den Server und alle seine Abhängigkeiten in einer Datei, die nur eingebaute
Module von Node.js importiert, mit den Lizenzhinweisen jedes gebündelten Pakets. Die Bestätigung
lässt sich in der Erweiterung nicht abschalten: Sie bietet keine Möglichkeit,
`SEVDESK_I_UNDERSTAND_NO_CONFIRM` zu setzen. Das Bundle ist noch nicht signiert; prüfe einen
Download mit seiner Provenance-Attestierung
([Lieferkette](supply-chain.de.md#die-claude-desktop-erweiterung)).

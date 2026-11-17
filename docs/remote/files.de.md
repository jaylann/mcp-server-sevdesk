<!-- translated-from: docs/remote/files.md sha256:22814b0bdaff -->

# Dateien: Uploads und Download-Links

Ein entfernter Server kann keine Dateien auf deinem Rechner lesen, und die Dateien, die er erzeugt,
gelangen nicht von selbst dorthin. Mit `SEVDESK_HTTP_FILES=on` (der Standard) wandern Dateien über
Seiten des Servers, die du in deinem Browser öffnest. Diese Seite erklärt diese Seiten, ihre
Grenzen und was ein Proxy für sie braucht. Das Modell sieht und sendet nie den Inhalt dieser
Dateien. (Dokument-PDFs und -XML, die ein Client als `sevdesk://`-Ressource anfordert, nehmen einen
anderen Weg: Sie gehen per MCP an den Client.)

## Einen Beleg oder eine E-Rechnung hochladen

1. Das Modell ruft `sevdesk_upload_request` auf (Zweck `receipt` oder `einvoice`) und gibt dir
   einen Link, `<public URL>/uploads/<id>`, mit einem kurzen Referenzcode und einem Ablauf.
2. Du öffnest den Link. Die Seite zeigt nur, was der Server weiß: was sie annimmt, die größte
   Datei, bis wann sie gültig ist, das Konto und den Referenzcode. Das Modell kann keinen Text
   darauf setzen.
3. Du wählst die Datei und drückst Upload. Der Server prüft den Dateityp am Inhalt, nicht am
   Namen, und behält einen bereinigten Namen (Buchstaben, Ziffern, `.`, `_`, `-`; Umlaute
   ausgeschrieben; höchstens 100 Zeichen; die Endung aus dem Inhalt).
4. Du sagst dem Modell, dass der Upload erledigt ist. Es übergibt die erhaltene `uploadId`
   (`upload:<id>`) als `file` an `sevdesk_voucher_create_draft`, `sevdesk_voucher_update_draft`,
   `sevdesk_einvoice_parse` oder `sevdesk_voucher_import_einvoice`. Nur die Verbindung, die den
   Upload angefordert hat, kann ihn nutzen.

Sobald das Erstellen, Ändern oder Importieren gelingt und das Zurücklesen aus sevDesk einen Anhang
bestätigt, gibt der Server den Upload frei und löscht seine gespeicherte Datei; der Platz ist
sofort wieder verfügbar. Das Auslesen einer E-Rechnung, Probeläufe, fehlgeschlagene Aufrufe und ein
fehlender oder unklarer Anhang im zurückgelesenen Beleg behalten den Upload bis zum Ablauf für einen
weiteren Versuch. Beim Ändern muss sich die Anhang-ID gegenüber dem unmittelbar vor dem Speichern
geprüften Stand ändern (oder erstmals ein Anhang vorliegen, wenn vorher ausdrücklich keiner
vorhanden war); bei gleicher ID oder unbekanntem vorherigem Stand bleibt der Upload bis zum Ablauf
verfügbar. Um eine erfolgreich angehängte Datei nach der Freigabe ihres Uploads erneut zu
verwenden, fordere einen neuen Upload an.

Einen ganzen Ordner mit Belegen mit den Belegen in sevDesk zu vergleichen
(`sevdesk_receipt_folder_check`), geht auf einem entfernten Server mit OAuth nicht: Das liest einen
lokalen Ordner, und ein Upload bringt einzelne Dateien. Im Bearer-Modus mit `SEVDESK_FILE_DIRS`
wird es für die Ordner auf dem Server angeboten.

## Mehrere Dateien auf einer Seite

Übergib `sevdesk_upload_request` das optionale `count` (1–10, Standard 1). Bei `count > 1` gibt es
statt `uploadId` eine `batchId`, `count` und eine einzige Seiten-URL zurück. Wähle mehrere Dateien
und sende sie einmal ab. Das Modell ruft danach `sevdesk_uploads_list` mit der `batchId` auf: Jeder
Platz hat eine `uploadId` und einen Status; hochgeladene Plätze haben zusätzlich ihren bereinigten
Namen, die Art, die Größe, SHA-256 und ihren eigenen Ablauf. Das Modell ordnet diese Namen den
vorgesehenen Entwürfen zu und verwendet nur Plätze mit dem Status `uploaded`. Gleiche bereinigte
Namen bleiben getrennte Dateien; reichen Größe und SHA-256 zur Unterscheidung nicht aus, klärt es
die gewünschte Zuordnung. Die Abfrage ändert nichts und ist nur für die Verbindung sichtbar, die
den Stapel-Upload angefordert hat.

- Der ganze Stapel reserviert vorab einen Eintrag je Datei. Passt er nicht mehr in die
  verbleibenden Einträge des Kontos oder des Servers, wird kein Platz angelegt; die Ablehnung nennt
  den nächsten bekannten Ablaufzeitpunkt dieses Kontos. Ein Stapel zählt als eine der fünf
  wartenden Seiten.
- Du kannst weniger Dateien hochladen und vor Ablauf der ursprünglichen 15 Minuten auf dieselbe
  Seite zurückkehren, um den Rest nachzureichen. Scheitert eine spätere Datei, bleiben die zuvor
  erfolgreich hochgeladenen verfügbar, und die Seite listet, was noch fehlt; wähle beim erneuten
  Versuch nur die fehlenden Dateien. Ein älteres Formular erneut abzusenden füllt die übrigen
  Plätze nicht: Die Seite zeigt den aktuellen Stand und bittet dich, die fehlenden Dateien erneut
  auszuwählen.
- Nach einem erfolgreichen Stapel-Upload führt eine Weiterleitung zur Fortschrittsseite; sie neu
  zu laden sendet also keine Dateien erneut.
- Laufen ungenutzte Plätze ab, bleiben bereits hochgeladene Dateien bis zu ihrem eigenen Ablauf
  verfügbar. Sobald jeder Platz genutzt oder abgelaufen ist, werden die Abfrage und die Seite
  entfernt.

Ohne `count` oder mit `1` bleiben Ergebnis und Ablauf für eine einzelne Datei unverändert.

## Herunterladen

`sevdesk_document_save`, `sevdesk_voucher_receipt_save`, `sevdesk_csv_export` und
`sevdesk_datev_export` geben statt eines Dateipfads einen Download-Link zurück,
`<public URL>/files/<id>`. Der Server hat die Datei während des Werkzeugaufrufs von sevDesk geholt;
das Öffnen des Links sendet nichts an sevDesk. Der Browser speichert die Datei als Download; sie
wird nie auf der Seite des Servers angezeigt.

## Was eine Browser-Sitzung braucht

Jede Upload-Seite und jeder Download-Link. Die Links sind nicht geheim: Ohne Sitzung zeigen sie nur
das Anmeldeformular, und ein Link eines anderen Kontos sieht genauso aus wie einer, den es nicht
gibt. Die Sitzung ist die des [Freigabe-Postfachs](approvals.de.md#anmelden):

- Der Browser, der die OAuth-Zustimmung abgeschlossen hat, ist 12 Stunden angemeldet, auch wenn
  das Postfach aus ist;
- jeder andere Browser meldet sich im Formular mit dem sevDesk-API-Token des Kontos an
  (OAuth-Modus: bei sevDesk und gegen `SEVDESK_OAUTH_ACCOUNTS` geprüft; Bearer-Modus: das
  `SEVDESK_API_TOKEN` des Servers, nie das Bearer-Geheimnis) und landet wieder auf der Seite, von
  der er kam.

Das Formular sendet an `/approvals/login`, auch wenn das Freigabe-Postfach aus ist. An einem Konto
angemeldet, sieht ein Browser die Upload-Seiten und Links aller Verbindungen dieses Kontos; die
Werkzeuge verwenden nur die Uploads ihrer eigenen Verbindung.

**Auf dem Telefon** öffnen die Claude-Apps einen Link unter Umständen in einem Browser, der die
Cookies desjenigen nicht teilt, in dem du zugestimmt hast: Du siehst dann das Anmeldeformular.
Melde dich dort mit dem sevDesk-API-Token an oder öffne den Link in dem Browser, in dem du
zugestimmt hast.

## Grenzen und Laufzeiten

| Was                      | Grenze                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload-Seite             | 15 Minuten gültig, nimmt 1–10 Dateien an, je nach Anfrage; ungenutzte Plätze laufen gemeinsam ab.                                                                                                                                                          |
| Angenommene Dateien      | Belege: PDF, PNG oder JPEG. E-Rechnungen: XML (XRechnung) oder PDF (ZUGFeRD, Factur-X). Am Inhalt geprüft.                                                                                                                                                 |
| Ein Upload               | 20 MiB, oder die Hälfte von `SEVDESK_HTTP_FILES_MAX_MB`, falls das weniger ist.                                                                                                                                                                            |
| Hochgeladene Datei, Link | Höchstens `SEVDESK_HTTP_FILES_TTL` (30 Minuten) gültig; ein Upload wird nach bestätigtem Anhängen freigegeben. Ein Link liefert höchstens 5 Downloads.                                                                                                     |
| Je Konto                 | 5 Upload-Seiten, die auf eine Datei warten; `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` reservierte Dateiplätze, Uploads und Links zusammen (Standard 10, Bereich 1–1000); ein Viertel von `SEVDESK_HTTP_FILES_MAX_MB` (mindestens 20 MiB, höchstens die Hälfte). |
| Alle Konten              | `SEVDESK_HTTP_FILES_MAX_MB` (256 MiB mit Zustandsverzeichnis, 64 MiB ohne), 1.000 Uploads und Links. Platz für einen Upload bleibt für Konten frei, die noch keine Dateien halten.                                                                         |
| Anfragen je Client       | 60 pro Minute an die Upload- und Download-Seiten zusammen; 10 Uploads pro Minute und 60 pro Stunde (IPv6 je /64-Netz).                                                                                                                                     |
| Gleichzeitige Uploads    | 2 für den ganzen Server, 1 je Konto; ein weiterer bekommt „Server busy“ oder „Upload in progress“ (503): Versuche es gleich noch einmal.                                                                                                                   |
| Upload-Tempo             | Die Datei muss innerhalb von 90 Sekunden eintreffen, ohne 10 Sekunden Pause und nach den ersten 10 Sekunden mit durchschnittlich mindestens 16 KB/s; sonst 408.                                                                                            |
| Download-Tempo           | Der Browser muss die Datei laufend abnehmen: Ein Download, von dem er in einer Minute weniger als 64 KiB abnimmt, wird abgebrochen und zählt trotzdem als einer der 5 des Links.                                                                           |
| Ein Neustart             | Macht jede Upload-Seite, jeden Upload und jeden Link ungültig. Das Modell fordert einen neuen an.                                                                                                                                                          |

Nichts wird verdrängt, um Platz zu schaffen: Ist eine Grenze erreicht, werden neue Uploads und
Links abgelehnt, bis ältere ablaufen oder freigegeben werden. Bei einer erreichten Anzahlgrenze
nennt die Ablehnung den frühesten bekannten Ablaufzeitpunkt des anfragenden Kontos, niemals Zeiten
anderer Konten; Dateien, die noch gespeichert werden, haben noch keinen festen Ablaufzeitpunkt, und
wenn keiner bekannt ist, sagt die Ablehnung das. Für mehr gleichzeitige Einträge erhöhe
`SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`; die Byte-Kontingente ändern sich dadurch nicht.

Download-Links zählen gegen denselben Platz wie Uploads; ein großer DATEV-Export passt daher unter
Umständen nicht (mit 64 MiB im Speicher hat ein Konto 20 MiB). Das Werkzeug sagt dann, dass sevDesk
den Export gestartet hat, und du lädst ihn stattdessen in sevDesk herunter; oder du erhöhst
`SEVDESK_HTTP_FILES_MAX_MB`, am besten mit einem Zustandsverzeichnis, damit die Dateien auf die
Festplatte gehen.

## Speicher

Ohne Zustandsverzeichnis werden Dateien im Speicher gehalten. Während ein Upload eintrifft, liegt
er etwa dreifach im Speicher; deshalb werden höchstens zwei Bodys gleichzeitig angenommen. Der Body
eines Stapel-Uploads ist schon vor dem Lesen begrenzt: auf das Kleinere aus seinen freien Plätzen
mal der Grenze je Datei und dem verbleibenden Byte-Anteil des Kontos, plus 64 KiB für die
Multipart-Rahmung (absolute Obergrenze: 200 MiB plus Rahmung). Beim Standard von 256 MiB
Speicherplatz hat ein leeres Konto 64 MiB für einen Stapel; ohne Zustandsverzeichnis beträgt der
Standardanteil 20 MiB. Plane Speicher für das Einlesen dieser Bodys ebenso ein wie für die
gehaltenen Dateien, besonders wenn du die Speichergrenze erhöhst. Dateien werden nacheinander
gespeichert, wobei Byte-Kontingente und Ablauf für jede erneut geprüft werden; eine gleichzeitige
Reservierung für einen Download kann trotzdem zu einem teilweisen Fehlschlag führen.

## Reverse Proxys

Der Body eines Uploads muss innerhalb von 90 Sekunden ohne 10 Sekunden Pause eintreffen und
`Content-Length` tragen; ein Upload in Chunks ohne diesen Header wird mit 411 abgelehnt. Setze die
Body-Grenze des Proxys auf die Stapelgröße, die du zulässt, plus Rahmung: zum Beispiel nginx
`client_max_body_size 65m;` für den Kontoanteil von 64 MiB beim Standard mit Zustandsverzeichnis,
oder `201m` für die absolute Obergrenze von 200 MiB. Sein Standard von 1 MB lehnt die meisten
Belege ab; seine standardmäßige Pufferung von Anfragen sendet `Content-Length`. Caddy, wie in der
[Compose-Vorlage](deployment.de.md#docker-compose-mit-caddy-deploycompose), braucht nichts. Jede
Datei hat weiterhin die Grenze von 20 MiB; eine große Auswahl braucht unter Umständen mehrere
Durchgänge über denselben Link.

## Abschalten

`SEVDESK_HTTP_FILES=off` entfernt `sevdesk_upload_request`, `sevdesk_uploads_list` und die Seiten.
Im OAuth-Modus werden dann die Werkzeuge nicht angeboten, die eine Datei zum Lesen oder einen Ort
zum Speichern brauchen (`sevdesk_einvoice_parse`, `sevdesk_voucher_import_einvoice`,
`sevdesk_document_save`, `sevdesk_voucher_receipt_save`, `sevdesk_csv_export`,
`sevdesk_datev_export`), und das Argument `file` der Belegentwurf-Werkzeuge wird abgelehnt; der
Bearer-Modus nutzt weiterhin `SEVDESK_FILE_DIRS` und `SEVDESK_OUTPUT_DIR`, wenn sie gesetzt sind.
Die PDF- und XML-Werkzeuge und die `sevdesk://`-Ressourcen sind nicht betroffen: Ein Client liest
Dokumentdateien über sie per MCP.

## Grenzen des Entwurfs

Ein Agent, der deinen angemeldeten Browser steuern kann, könnte selbst hoch- oder herunterladen,
so wie er im Postfach freigeben könnte. Eine heruntergeladene Datei ist das, was sevDesk geliefert
hat; öffne sie wie jedes Dokument aus deiner Buchhaltung. Bei einer Einrichtung mit einfachem http
auf `localhost` erhalten auch andere lokale Webserver das Sitzungs-Cookie. Wie Links, Uploads,
Downloads und die Speicherung gehärtet sind, steht unter [Sicherheit im Fernzugriff](../security/remote.de.md#dateien); der Entwurf ist [ADR 0008](../adr/0008-file-transfer-over-http.de.md).

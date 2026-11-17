<!-- translated-from: docs/adr/0008-file-transfer-over-http.md sha256:a78abd7dbd11 -->

# ADR 0008: Dateiübertragung über HTTP

- **Status:** Angenommen; Aussehen, Sprache und Richtlinie der Seiten geändert durch
  [ADR 0010](0010-server-pages-in-two-languages.de.md); Freigabe von Uploads und einstellbare
  Anzahl geändert am 2026-11-12 ([#35](https://github.com/jaylann/mcp-server-sevdesk/issues/35));
  Stapel-Uploads geändert am 2026-11-12
  ([#34](https://github.com/jaylann/mcp-server-sevdesk/issues/34)); Dateien von einem https-Link
  geändert am 2026-11-16 ([#96](https://github.com/jaylann/mcp-server-sevdesk/issues/96))
- **Datum:** 2026-11-09
- **Ändert:** [ADR 0007](0007-approval-inbox-over-http.de.md) (seine Browser-Sitzung öffnet jetzt
  auch die Seiten zum Hoch- und Herunterladen)
- **Bezieht sich auf:** [ADR 0006](0006-built-in-authorization-server-and-grant-store.de.md) (kein
  sevDesk-Token außerhalb einer MCP-Anfrage)

## Kontext

Mehrere Werkzeuge nehmen oder erzeugen Dateien: Belegentwürfe hängen eine Belegdatei (Belegbild)
an, die E-Rechnungs-Werkzeuge lesen eine XRechnung- oder ZUGFeRD-Datei, und
`sevdesk_document_save`, `sevdesk_csv_export` und `sevdesk_datev_export` geben PDFs, XML-, CSV- und
ZIP-Dateien aus. Über stdio laufen diese über zwei Ordner, die der Benutzer ausdrücklich freigibt,
`SEVDESK_FILE_DIRS` und `SEVDESK_OUTPUT_DIR`. Ein entfernter Server hat keinen davon:

- Die Ordner lägen auf dem Server, nicht auf dem Rechner des Benutzers, und im OAuth-Modus teilten
  sich alle verbundenen Konten eine Platte; der OAuth-Modus hat sie deshalb abgelehnt.
- claude.ai und die Claude-Apps, die wichtigsten entfernten Clients, konnten also weder eine
  Belegdatei an einen Beleg hängen noch eine E-Rechnung importieren oder überhaupt einen Export
  bekommen.
- Das Modell kann die Bytes nicht tragen: Argumente von MCP-Werkzeugen sind JSON, das das Modell
  schreibt, und eine mehrere Megabyte große Belegdatei als Base64 im Kontext wäre langsam, teuer und
  leicht zu beschädigen.
- [ADR 0007](0007-approval-inbox-over-http.de.md) hat Links, die das Modell sieht, als Berechtigung
  bereits verworfen: Ein durch Prompt Injection gesteuertes Modell kann einen Link weitergeben.
- Im OAuth-Modus hält der Server außerhalb einer MCP-Anfrage kein sevDesk-Token
  ([ADR 0006](0006-built-in-authorization-server-and-grant-store.de.md)); er kann sevDesk also nicht
  aufrufen, wenn jemand später einen Link öffnet.

## Entscheidung

**Im HTTP-Modus reisen Dateien über Seiten des Servers im Browser des Benutzers**
(`SEVDESK_HTTP_FILES`, standardmäßig an; `src/http/transfer-routes.ts`):

- **Uploads.** Ein neues Werkzeug der Stufe `read`, `sevdesk_upload_request` (Zweck `receipt` oder
  `einvoice`), öffnet eine Upload-Seite `<public URL>/uploads/<id>` und gibt ihre `uploadId`
  (`upload:<id>`), einen Referenzcode und den Ablauf zurück. Der Benutzer lädt dort eine Datei hoch;
  das Modell übergibt die `uploadId` dann als das bestehende Argument `file`. Die Seite zeigt nur
  vertrauenswürdige Werte (Zweck, angenommene Arten, Größengrenze, Konto, Referenz, Ablauf): Das
  Modell kann keinen Text darauf setzen. Der Dateityp wird am Inhalt geprüft, der Name bereinigt und
  nie als Pfad verwendet. Das Werkzeug bleibt in der Stufe `read` (es ändert nichts in sevDesk),
  gibt aber `readOnlyHint: false` an: Jeder Aufruf öffnet ein Ticket auf diesem Server, und ein
  Konto hält nur wenige gleichzeitig; ein Client darf es also nicht als frei von Wirkungen behandeln
  (dieselbe Regel wie für die Werkzeuge der Stufe `read`, die einen Download-Link anlegen).
- **Downloads.** Die ausliefernden Werkzeuge geben `download {url, reference, expiresAt}` statt
  `savedTo` zurück. Die Bytes werden **während des Werkzeugaufrufs** von sevDesk geholt (PDFs
  weiterhin mit `preventSendBy=true`) und aufbewahrt; `GET /files/<id>` liefert sie aus und stellt
  keine Anfrage an sevDesk. Downloads sind immer Anhänge (`Content-Disposition: attachment`) unter
  `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` und ohne Einbetten in Frames,
  sodass eine Datei nie auf dem Origin des Servers dargestellt wird.

**URLs sind keine Berechtigung; der Browser weist das Konto nach.** Jede Seite braucht die
Browser-Sitzung aus ADR 0007 für das Konto des Eintrags. Ohne sie zeigt sie das Anmeldeformular mit
einem `next` zurück zur Seite (nur die eigenen Eintragspfade des Servers kommen durch, es ist also
keine offene Weiterleitung). Ein Eintrag eines anderen Kontos antwortet genau wie eine unbekannte
ID. Die Sitzung wird bei der OAuth-Zustimmung gesetzt, sobald das Postfach oder die
Dateiübertragung aktiv ist, oder durch Anmelden mit dem sevDesk-Token des Kontos; im Bearer-Modus
öffnet sich der Zugangsspeicher für diese Sitzungen, sobald die Dateiübertragung aktiv ist. Uploads
sind POSTs mit einem an die Sitzung gebundenen CSRF-Token, von der Seite selbst (`Origin`), und
bestehen ihre Prüfungen (Sitzung, offenes Ticket dieses Kontos, angegebene `Content-Length`
innerhalb der Grenze, höchstens zwei gleichzeitig), bevor der Body gelesen wird.

**Werkzeuge verwenden nur die Uploads ihrer eigenen Verbindung; Seiten gehen nach Konto.** Ein
Upload gehört dem Prinzipal, der gefragt hat (Zugang und Konto): Ein anderer Zugang desselben Kontos
bekommt dieselbe Antwort wie für eine unbekannte ID. Die Seiten bedienen, wie das Postfach, jede
Sitzung des Kontos.

**Verschlüsselte Ablage für die Lebensdauer des Prozesses.** Einträge leben im Speicher
(`src/safety/transfer-store.ts`); die Bytes gehen nach `<stateDir>/files/` (oder in den Speicher
ohne Zustandsverzeichnis), verschlüsselt mit AES-256-GCM unter einem Schlüssel, der beim Start des
Prozesses zufällig gezogen und nie aufgeschrieben wird, mit Blob-ID, Konto und Art als zusätzlichen
Daten (`src/safety/blob-store.ts`). Der Ordner wird beim Start geleert, nachdem der Zugangsspeicher
seine Sperre genommen hat. Ein Neustart macht jede Upload-Seite, jeden Upload und jeden Link
ungültig, so wie er Freigaben ungültig macht.

**Ein Eingabefeld.** `file` nimmt einen Pfad oder ein `upload:<id>`, über einen `FileAccess`, den
die Registry je Aufruf baut (`src/safety/file-sources.ts`). Die Schemas bleiben statisch, sodass
`tools/list` je Konfiguration stabil ist. Der Bearer-Modus behält seine Ordner: Ein einfacher Pfad
liest weiterhin aus `SEVDESK_FILE_DIRS`, und `SEVDESK_OUTPUT_DIR` hat Vorrang vor Links.

**Begrenzt.** Eine Upload-Seite lebt 15 Minuten und nimmt 1–10 Dateien, jede höchstens 20 MiB;
Uploads und Links leben `SEVDESK_HTTP_FILES_TTL` (30 Minuten); ein Link liefert 5 Downloads. Je
Konto 5 offene Seiten, standardmäßig 10 lebende Einträge (`SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`,
ganze Zahlen 1–1000) und ein Viertel von `SEVDESK_HTTP_FILES_MAX_MB` (mindestens ein Upload von
20 MiB, höchstens die Hälfte); Platz für einen Upload bleibt frei für Konten, die noch nichts
halten. Nichts wird verdrängt, neue Einträge werden abgelehnt. Upload-Bodys: 2 gleichzeitig auf dem
Server und 1 je Konto, jeder innerhalb von 90 s, ohne eine Pause von 10 s und nach 10 s mit
durchschnittlich 16 KB/s, sodass ein tröpfelnder Body keinen Platz belegen kann. Das eigene
Anfrage-Timeout von Node liegt über dem längsten Body-Fenster aller Routen (die 90 s plus 30 s für
die Header und die Prüfungen vor dem Body), sodass es nie einen Upload abschneidet, den die Route
noch erlaubt; mit festen 30 s tat es das. Ein Download wird in Stücken von 64 KiB geschrieben, und
die Verbindung wird getrennt, wenn der Client eine Minute lang kein Stück abnimmt: Dieser Timer
misst einen Client, der aufgehört hat zu lesen, nicht die Größe der Datei. (In einem Stück
geschrieben, wurde jeder Download abgeschnitten, der länger als eine Minute dauerte, wie gleichmäßig
der Client auch las; Review 2026-11, Runde 3.) Logs und Audit-Zeilen tragen Referenz, Art, Größe
und SHA-256, nie IDs oder Dateinamen.

**Freigabe nach erfolgreichem Anhängen (2026-11-12, #35).** Benutzte Belegdateien die vollen
30 Minuten aufzubewahren begrenzte eine gewöhnliche Buchhaltungssitzung auf zehn Belegdateien.
Entwurf anlegen oder ändern und E-Rechnung importieren geben einen Upload jetzt sofort frei, nachdem
Speichern und Zurücklesen gelungen sind und das Zurücklesen ein angehängtes Dokument bestätigt. Beim
Ändern muss sich die Dokument-ID von dem Anhang unterscheiden, der unmittelbar vor dem Speichern
erneut geprüft wurde (oder auf einen ausdrücklich fehlenden Anhang folgen). Eine unveränderte ID
oder ein unbekannter vorheriger Anhangsstand ist mehrdeutig, der Upload wird also behalten; die
Anhangsidentität aus der Vorschau kann bereits veraltet sein. Das behält vorsichtshalber auch eine
Belegdatei, wenn sevDesk ihren Inhalt unter derselben Dokument-ID ersetzt (Nacharbeit zum Review,
2026-11-13). `FileAccess.release(ref)` gibt an das auf den Eigentümer beschränkte, idempotente
`TransferStore.releaseUpload(owner, id)` weiter: Es entfernt nur ein hochgeladenes Ticket desselben
Zugangs und Kontos und plant seinen Blob über die bestehende Bereinigung beim Ablauf zum Löschen
ein. Wartende oder empfangende Tickets, Download-Links und lokale Dateien bleiben unberührt.
Lesezugriffe, das Auslesen von E-Rechnungen, Probeläufe, gescheiterte Schreibvorgänge und
gescheiterte oder unsichere Zurücklesungen des Anhangs behalten den Upload bis zum Ablauf. Keine
Schonfrist: Erneute Versuche gescheiterter Aufrufe behalten ihre Datei; eine neue Verwendung nach
erfolgreichem Anhängen braucht einen neuen Upload. Das Löschen des Blobs folgt der bestehenden
Zusage beim Ablauf, nach bestem Bemühen, sodass ein Fehler beim Aufräumen des Speichers einen
abgeschlossenen Schreibvorgang in sevDesk nicht zu einem gescheiterten Aufruf machen kann.

Die Einstellung der Anzahl ändert nur die lebenden Einträge je Konto (Tickets, Uploads und Links
zusammen). Die fünf wartenden Seiten, 1.000 Einträge insgesamt, die Anteile an Bytes, das
Gesamtbudget an Bytes und die Reserve für leere Konten bleiben unverändert. Ablehnungen wegen der
Anzahl nennen den frühesten bekannten Ablauf nur des anfragenden Kontos, einschließlich wartender
Tickets und Links. Empfangende Tickets und Reservierungen für Downloads haben noch keinen festen
Ablauf und sind ausgenommen; ohne bekannten Ablauf sagt die Meldung, es erneut zu versuchen, sobald
ältere Dateien ablaufen oder Übertragungen enden. Globale Ablehnungen verraten nie die Abläufe eines
anderen Kontos. Ein Ablauf ist ein Zeitpunkt für einen erneuten Versuch, keine Reservierung: Einen
Upload zu verwenden oder einen Link auszuschöpfen kann einen Platz früher freigeben, während eine
andere Anfrage ihn zuerst belegen kann.

**Stapel-Uploads (2026-11-12, #34).** `sevdesk_upload_request` nimmt ein optionales ganzzahliges
`count` (1–10). Fehlt es oder ist es `1`, bleibt die Antwort für eine einzelne Datei genau
erhalten. Bei `count > 1` gibt es `batchId`, `count` und eine URL zurück, statt der einzelnen
`uploadId`. Das nur lesende Werkzeug der Stufe `read` `sevdesk_uploads_list(batchId)` löst den
Stapel dieser Verbindung in Dateiplätze auf, mit `uploadId`, Status und (nach dem Hochladen)
bereinigtem Namen, Art, Größe, SHA-256 und eigenem Ablauf. Keine Bytes reisen durch das Modell.
Namen bleiben nicht vertrauenswürdige Daten, nie vertrauenswürdige Anweisungen oder Log-Felder.
Gleiche bereinigte Namen bleiben getrennte Plätze; das Modell muss eine mehrdeutige Zuordnung
klären, statt zu raten. Das fügt ein Lesewerkzeug hinzu: Im Voraus vergebene IDs je Platz allein
können dem Modell nicht sagen, welchen bereinigten Namen der Mensch für welchen Platz gewählt hat,
ohne einen manuellen Zuordnungsschritt oder zusätzliche Abfrageparameter am vergebenden Werkzeug.
Lesen und Vergeben bleiben getrennt.

Das Anlegen reserviert alle N Einträge synchron oder keinen, gegen die Grenze der Einträge des
Kontos (einschließlich Reservierungen für Downloads) und die Grenze der Einträge insgesamt. Eine
Ablehnung meldet den verbleibenden Platz des Kontos und verwendet die oben beschriebene Angabe des
frühesten Ablaufs nur für dieses Konto. Wartende Seiten werden je Stapel gezählt, ein Stapel aus
zehn Dateien belegt also eine der fünf Seiten und zehn Plätze für Einträge. Jede Datei durchläuft
weiterhin die Erkennung am Inhalt, die Größe je Datei, die Kontingente an Bytes, die Prüfungen von
Sitzung und CSRF, die verschlüsselte Ablage und die Zuordnung zu Zugang und Konto. Erfolgreiches
Anhängen gibt nur den Platz dieser Datei frei.

Das native Eingabefeld `multiple` sendet wiederholte `file`-Teile neben genau einem `csrf`-Teil und
einem `slots`-Teil, ohne Skript. Letzterer bindet das Formular an die geordneten IDs der wartenden
Plätze, die beim Darstellen gezeigt wurden. Eine veraltete Bindung wird mit 409 abgelehnt, bevor
Dateien gespeichert werden, sodass das Wiederholen einer erfolgreichen oder teilweise erfolgreichen
Übermittlung neue Plätze nicht mit doppelten Dateien füllen kann. Erfolgreiche Stapel-POSTs leiten
mit 303 auf die GET-Fortschrittsseite weiter, was ein Neuladen sicher macht. Die Obergrenze für rohe
Multipart-Trenner wird vor dem Parsen auf verbleibende Plätze + 3 gesetzt; überzählige Teile werden
abgelehnt. Vor dem Lesen des Body werden der angegebene und der tatsächliche Body auf den kleineren
Wert begrenzt aus verbleibenden Plätzen mal Größengrenze je Datei und dem verbleibenden Byte-Anteil
des Kontos, plus 64 KiB für die Rahmung, nie über 200 MiB plus Rahmung. Dieselben zwei globalen und
ein Body-Platz je Konto, die Frist von 90 Sekunden und die Tempogrenzen gelten je Übermittlung.
Geparste Bodys können etwa das Dreifache dieses Rahmens im Speicher belegen; Betreiber müssen
Speicher und Grenzen des Proxys also für Stapel bemessen.

Dateien werden nacheinander gespeichert, mit Prüfung von Kontingenten und Ablauf für jede. Frühere
erfolgreiche Dateien überstehen einen späteren Fehler bei Prüfung, Speicherung oder Ablauf; die
Seite zeigt genau diese Erfolge und welche Plätze übrig sind. Derselbe Link nimmt bis zur
ursprünglichen Frist weitere Übermittlungen für wartende Plätze an. Eine Datei, die vor dem Ablauf
ihres Tickets zur Speicherung übernommen wurde, wird nach der bestehenden Regel für empfangende
Tickets fertig; spätere Dateien können ablaufen, während sie geschrieben wird. Jede erfolgreiche
Datei bekommt ihre eigene Laufzeit. Metadaten eines Stapels gibt es nur, solange mindestens ein
Platz ein lebendes Ticket oder eine Datei hat, was die Metadaten über die Obergrenze der Einträge
begrenzt; abgeschlossene oder vollständig abgelaufene Stapel werden unbekannt.

**Dateien von einem https-Link (2026-11-16, #96).** Belege liegen oft schon unter einer URL (in
einem Lieferantenportal, hinter einem Download-Link, in einem Cloud-Speicher), und sie nur
herunterzuladen, um sie wieder hochzuladen, kostet den Benutzer einen Umweg über den Browser. Das
Argument `file` nimmt deshalb auch einen https-Link an, in jedem Modus, auch über stdio, wenn der
Betreiber Hosts in `SEVDESK_FILE_URL_HOSTS` einträgt (standardmäßig leer: Jeder Link wird vor jeder
Netzwerkanfrage abgelehnt, mit dem Namen der Einstellung). Das Argument bleibt eine Zeichenkette,
die dritte Form neben einem Pfad und `upload:<id>` (alles, was wie eine URL beginnt, ist ein Link;
eine lokale Datei mit so einem Namen wird als `./https:…` übergeben); die Schemas bleiben also
statisch und `tools/list` stabil, wie oben. Der Link kommt vom Modell; der Download ist deshalb so
eingegrenzt wie der Abruf der Client-Metadaten im OAuth-Modus, dessen Schutz für beide nach
`src/safety/public-address.ts` und `src/safety/pinned-https.ts` umgezogen ist: nur https, der
Standardport, keine Benutzerangaben, ein Hostname auf der Liste (genau, oder `*.example.com` für
dessen Subdomains), je Download einmal aufgelöst und nur zu öffentlichen Adressen, die Verbindung
an die geprüfte Adresse gebunden; keine Cookies, Zugangsdaten oder sevDesk-Token; nur 200,
unkomprimiert, ein Inhaltstyp, der zum Inhalt passt (an den Headern geprüft, bevor der Body gelesen
wird), keine Webseite, wo XML erwartet wird, die Größengrenze des Aufrufers (20 MiB) an
`Content-Length` und während der Übertragung, 60 Sekunden insgesamt, zwei Downloads gleichzeitig
je Konto und vier im Prozess. **Weiterleitungen werden verfolgt**, höchstens drei, jedes Ziel nach
denselben Regeln geprüft samt Liste; ein Host behält innerhalb eines Downloads die Adresse seiner
ersten Auflösung. Cloud-Speicher und Portale geben Links aus, die weiterleiten (zu einem Speicher-
oder CDN-Host), und sie abzulehnen, machte die Funktion für sie nutzlos; die Liste begrenzt
trotzdem jeden Host, den eine Anfrage erreicht, und eine Weiterleitung daneben wird abgelehnt, ohne
das Ziel zu nennen. **Nichts wird behalten**: Die Bytes leben im Werkzeugaufruf, wie die einer
lokalen Datei; es gibt für `FileAccess.release` also nichts freizugeben, und der echte Aufruf lädt
die Datei nach einem Probelauf erneut. Die Vorschauen jeder Datei zeigen deren vollständige
SHA-256 als eigene Angabe (die eines Links auch den Host), die Ergebnisse ergänzen `sha256` (für
jede Quelle) und `downloadedFrom`. Der Name der Datei ist das letzte Pfadsegment des Links nur,
wenn es ein Dateiname von höchstens 64 Zeichen ist, der auf `.pdf`, `.png`, `.jpg`, `.jpeg` oder
`.xml` endet, sonst `download.<ext>`: Ein Link als Berechtigung kann sein Token im Pfad tragen, und
der Name wird gezeigt und in sevDesk gespeichert. Meldungen, Vorschauen und Ergebnisse zeigen
nichts weiter von einem Link, und das Audit-Log hält ein Link-Argument nur mit Schema und Host fest
(`https://host/…?[redacted]`). Die Werkzeuge, die eine Datei nehmen, erklären
`openWorldHint: true` (ihre Stufen bleiben), und `sevdesk_einvoice_parse` und
`sevdesk_voucher_import_einvoice` werden auch allein mit Link-Hosts angeboten.

**Den echten Aufruf an die geprüften Bytes binden (2026-11-17, Review von #101).** Ein Probelauf
und der echte Aufruf lesen die Datei getrennt: Ein Link wird erneut heruntergeladen, ein Upload
oder eine lokale Datei kann dazwischen ersetzt werden, und der echte Aufruf kann so andere Bytes
anhängen als die Vorschau, die ein Mensch geprüft hat. Jedes Werkzeug, das `file` nimmt, nimmt
deshalb auch ein optionales `fileSha256` (64 Hexadezimalzeichen, Groß- oder Kleinschreibung). Ist
es angegeben, berechnet der Aufruf die SHA-256 der Bytes, die er verwenden will, im Probelauf wie
im echten Aufruf, und lehnt ab, bevor etwas sevDesk erreicht, wenn sie abweicht; die Meldung nennt
beide Hashes gekürzt und nichts von der Datei oder ihrer Referenz. Die vollständige SHA-256 kommt
aus der Vorschau des Probelaufs (oder aus `file.sha256` von `sevdesk_einvoice_parse`). Ohne
`fileSha256` ändert sich nichts.

## Folgen

- Vorteil: claude.ai und die Claude-Apps können Belegdateien anhängen, E-Rechnungen importieren und
  PDFs und Exporte bekommen, mit denselben Werkzeugen und Argumenten wie über stdio.
- Vorteil: Ein Link, den das Modell weitergibt oder der in einem Log oder auf einem Screenshot
  landet, ist ohne eine Sitzung des Kontos nutzlos.
- Vorteil: Nichts überdauert den Prozess: Ein gestohlenes Volume enthält nur Chiffretext unter
  einem Schlüssel, der nie gespeichert wurde, und ein Neustart löscht alles.
- Vorteil: Einen Link zu öffnen hat keine Nebenwirkung in sevDesk.
- Nachteil: Der Benutzer braucht eine Browser-Sitzung des Kontos. Die Claude-Apps öffnen Links
  womöglich in einem Browser ohne das Cookie der Zustimmung; der Benutzer meldet sich dort mit dem
  sevDesk-Token an.
- Nachteil: Ein Neustart verliert Uploads und Links, und das Modell muss erneut fragen.
- Nachteil: Download-Bytes werden geholt, auch wenn niemand sie herunterlädt, und zählen gegen
  denselben Platz wie Uploads: Ein großes DATEV-ZIP passt womöglich nicht, nachdem sevDesk den
  Export schon begonnen hat (das Werkzeug sagt das und verweist auf sevDesk).
- Nachteil: Speicher. Ohne Zustandsverzeichnis liegen Dateien im Speicher; ein Upload wird beim
  Parsen etwa dreimal gehalten, daher höchstens zwei Uploads gleichzeitig. Einer je Konto verhindert,
  dass ein einzelnes Konto beide belegt; zwei Konten zusammen können andere trotzdem bis zu 90 s je
  Upload warten lassen.
- Nachteil: Uploads über eine sehr langsame Verbindung (unter 16 KB/s oder mit einem Stocken von
  10 s) scheitern mit 408.
- Nachteil: Ein Download, der stockt (unter 64 KiB in einer Minute), wird abgeschnitten und zählt
  trotzdem als einer der 5 des Links. Ein Client, der gerade schnell genug liest, kann eine
  Verbindung und die Datei im Speicher lange halten (eine Datei von 20 MiB stundenlang); der Platz
  der Anfrage wird trotzdem an der Frist von 120 s frei, und Verbindungen sind je Client-Adresse
  begrenzt.
- Nachteil: Reverse Proxys müssen Stapel-Bodys bis 200 MiB plus Rahmung und `Content-Length`
  durchlassen (nginx braucht `client_max_body_size`).
- Nachteil: Wie beim Postfach könnte ein Agent, der einen angemeldeten Browser steuert, selbst
  hoch- oder herunterladen.
- Nachteil: Mit `SEVDESK_OAUTH_ACCOUNTS=any` hält der Server kurz die Belegdateien und Exporte
  anderer Leute, und wenige Konten zusammen (3 mit dem Standard im Speicher, 4 mit 256 MiB auf der
  Platte) können den Platz für alle füllen, bis ihre Dateien ablaufen (der Start warnt).
- Vorteil (Links): Ein Beleg, der schon online liegt, braucht keinen Umweg über den Browser, und
  dasselbe Argument funktioniert über stdio und HTTP.
- Nachteil (Links): Der Server erreicht auf Wunsch des Modells Hosts außerhalb von sevDesk. Die
  Liste begrenzt sie, aber ein Host darauf, der Dateien ausliefert, die jeder hochladen kann (eine
  geteilte Speicher-Domain, besonders unter `*.`), lässt das Modell eine solche Datei anhängen.
  Langsame Downloads lassen andere bis zu einer Minute warten: zwei je Konto, im OAuth-Modus
  können zwei Konten zusammen also trotzdem die vier Plätze des Prozesses füllen.
- Nachteil (Links): Der echte Aufruf lädt die Datei erneut; ohne `fileSha256` kann er andere Bytes
  anhängen, als der Probelauf gezeigt hat.

## Erwogene Alternativen

- **Links als Berechtigung** (ein geheimer Link je Upload oder Download, keine Anmeldung). Aus dem
  Grund von ADR 0007 verworfen: Das Modell sieht den Link, eine Prompt Injection könnte einem
  Angreifer also einen Download schicken oder ihn eine gefälschte Belegdatei hochladen lassen.
- **Abruf beim Klick** (nur die Dokument-ID speichern, sevDesk beim Öffnen des Links aufrufen).
  Verworfen: Im OAuth-Modus hat der Server außerhalb einer MCP-Anfrage kein sevDesk-Token
  (ADR 0006), und ein GET, der sevDesk aufruft, könnte Nebenwirkungen haben und die Stufen des
  Zugangs überdauern.
- **Dauerhafte verschlüsselte Blobs** (ein Schlüssel, der aus dem Server-Geheimnis abgeleitet und
  über Neustarts behalten wird). Verworfen: Übrig gebliebene Blobs wären für jeden lesbar, der das
  Geheimnis und eine Kopie des Volumes hat, und es bräuchte einen dauerhaft gespeicherten Index der
  Einträge. Kurzlebige Dateien müssen keinen Neustart überstehen.
- **Ein eigenes Feld `uploadId`** neben `file`. Verworfen: zwei sich ausschließende Felder an jedem
  Dateiwerkzeug, und Schemas, die sich je Modus unterscheiden, würden `tools/list` instabil machen.
  Das Präfix `upload:` ist eindeutig; eine lokale Datei mit diesem Namen wird als `./upload:…`
  übergeben.
- **Bytes durch das Modell** (Base64-Argumente, eingebettete Ressourcen in Ergebnissen). Verworfen:
  Größe, Kosten und Beschädigung, und claude.ai speichert eingebettete Dateien nicht für den
  Benutzer.
- **Ein Serverordner je Konto im OAuth-Modus.** Verworfen: Die Dateien wären trotzdem auf dem Server,
  nicht beim Benutzer, und die Platte bräuchte ihre eigene Bereinigung und ihr eigenes
  Zugriffsmodell.
- **`file: {url}`, ein Objekt** (die erste Skizze im Issue). Aus dem Grund des eigenen Felds
  `uploadId` verworfen: eine Union in jedem Dateiargument; das Schema ist so eindeutig wie
  `upload:`.
- **Links ohne Weiterleitungen.** Verworfen: Die meisten Speicher-Links leiten weiter; jeden Schritt
  nach denselben Regeln zu prüfen, hält die Zusage.
- **Jeder Host, nur durch die Prüfung auf öffentliche Adressen geschützt.** Verworfen: Der Server
  würde laden, wohin eine Prompt Injection ihn schickt, und das Modell hängte an, was es dort fand.

<!-- translated-from: docs/security/remote.md sha256:612b5a727489 -->

# Fernzugriff

Die Bedrohungsanalyse des HTTP-Transports (`--http`): die Netzwerkgrenze, die Authentifizierung per
Bearer und OAuth, das Freigabe-Postfach und die Dateiübertragung. Sie richtet sich an Betreiber, die
wissen wollen, wogegen sich der Server wehrt und was ihre Aufgabe bleibt; die Schritte zur
Einrichtung stehen unter [Fernzugriff](../remote.de.md). Die Entscheidungen dahinter sind
[ADR 0006](../adr/0006-built-in-authorization-server-and-grant-store.de.md),
[ADR 0007](../adr/0007-approval-inbox-over-http.de.md) und
[ADR 0008](../adr/0008-file-transfer-over-http.de.md).

Der Fernzugriff fügt eine Netzwerkgrenze hinzu und im OAuth-Modus mehrere Konten und Verbindungen in
einem Prozess. Freigaben, Bestätigungen und Caches sind dem Konto und dem _Zugang_ (Grant) jeder
Anfrage zugeordnet.

## Netzwerk

Der Server startet nicht ohne Authentifizierung. Er lauscht standardmäßig auf `127.0.0.1` und
braucht für jede andere Adresse eine öffentliche URL, und eine öffentliche URL muss https verwenden,
außer ihr Host ist ein Loopback-Name.

- **Host und Origin.** Der `Host` jeder Anfrage muss einer der konfigurierten Namen sein (gegen
  DNS-Rebinding; nur `/healthz` ist ausgenommen, für die Zustandsprüfungen von Plattformen). Ein
  `Origin`-Header an `/mcp` muss einen erlaubten Host nennen (die Prüfung vergleicht Hostnamen;
  `/mcp` sendet keine CORS-Header, sodass Webseiten auf anderen Origins es nicht aufrufen können),
  und Formular-POSTs müssen von den eigenen Seiten des Servers kommen (`Origin: null` wird
  abgelehnt).
- **Bodys, Fristen und Ratenbegrenzungen.** Bodys sind je Route begrenzt und müssen in kurzer Zeit
  eintreffen, Anfragen haben Fristen, und Ratenbegrenzungen gelten je Client-Adresse (IPv6 je
  /64-Netz).
- **Gleichzeitige Anfragen.** Höchstens 64: 8 je Client-Adresse (32 mit
  `SEVDESK_OAUTH_ACCOUNTS=any`) und an `/mcp` 8 je sevDesk-Konto, gleich von welchen Adressen und
  Verbindungen sie kommen (darüber 429). 8 der 64 bleiben den anderen Routen vorbehalten, sodass
  Token-Erneuerung, Anmeldung, Freigabe-Postfach und Dateiseiten erreichbar bleiben, während `/mcp`
  ausgelastet ist. Sieben Konten, die je ihre 8 ausschöpfen, können `/mcp` für die anderen
  weiterhin füllen (503, bis eine Anfrage endet).
- **Batches.** Ein JSON-RPC-Batch, den nur Clients der Protokollversion 2025-03-26 senden, darf
  höchstens 8 Nachrichten enthalten und keine Anfrage-ID doppelt; sonst wird er abgelehnt, bevor
  etwas davon läuft.
- **Header.** Antworten tragen `nosniff`, `no-store, no-transform` (damit Proxys Seiten nicht
  umschreiben), eine Referrer-Policy und über https HSTS. URLs, die der Server ausgibt oder auf die
  er weiterleitet, werden aus der konfigurierten öffentlichen URL gebaut, nie aus Headern der
  Anfrage.
- **Proxys.** `SEVDESK_HTTP_TRUST_PROXY` muss der tatsächlichen Zahl der Proxys davor entsprechen:
  Ein höherer Wert lässt Clients die IP-Adresse wählen, die die Ratenbegrenzung sieht.

Einfaches http wird nur für eine öffentliche Loopback-URL angenommen; beschränke eine solche
Einrichtung auf kurze lokale Tests (siehe [Grenzen des Postfachs](#grenzen-des-postfachs)).

## Bearer-Modus

Ein gemeinsames Geheimnis (zwei während eines Wechsels), mindestens 32 Zeichen mit mindestens 16
verschiedenen und nie gleich dem sevDesk-Token. Der Server vergleicht ein HMAC des vorgelegten Werts
mit einem HMAC jedes konfigurierten Werts per `timingSafeEqual`, ohne beim ersten Treffer
aufzuhören. Wer das Geheimnis hält, kann die Stufen des Servers für dessen Konto nutzen. Der Start
warnt, wenn ein Bearer- oder Server-Geheimnis eher wie eine Passphrase als wie zufällige Bytes
aussieht.

## OAuth-Zustimmung und Erlaubnislisten

Die Zustimmungsseite zeigt den Host der `client_id` des Clients, den selbst angegebenen Namen des
Clients (bereinigt und als solcher gekennzeichnet) und den Host, auf den sie weiterleiten wird, mit
einer Warnung, wenn jede Weiterleitung auf eine Loopback-Adresse geht (eine App auf dem Rechner des
Benutzers). Nur `read` ist vorausgewählt; andere Stufen müssen angehakt werden.

- **Clients.** So weit kommen Clients nur, wenn ihr Metadaten-Dokument auf einem Host in
  `SEVDESK_OAUTH_CLIENTS` liegt (Standard `claude.ai`), geprüft, bevor etwas abgerufen wird: Ein
  Angreifer kann deine Zustimmungsseite nicht seinen eigenen Client präsentieren lassen
  (Consent-Phishing).
- **Konten.** Nur sevDesk-Konten in `SEVDESK_OAUTH_ACCOUNTS` können die Zustimmung abschließen; ein
  Server, dessen URL bekannt wird, wird so nicht zu einem Dienst für die Konten Fremder; ein
  abgelehntes Konto wird als `account_refused` protokolliert. Der Server speichert keine
  sevDesk-Tokens: Das Token jedes Benutzers reist versiegelt in den Tokens, die sein Client hält.
- **Bei jeder Anfrage.** Beide Erlaubnislisten gelten auch für jede Anfrage und Erneuerung: Wird ein
  Konto oder Client-Host entfernt und der Server neu gestartet, werden seine bestehenden Zugänge bei
  der nächsten Nutzung widerrufen, und die Postfach-Sitzungen des Kontos enden.
- **Grenzen für Zugänge.** Eine geprüfte Zustimmung lässt sich nur einmal abschließen, und jedes
  Konto hält eine begrenzte Zahl gültiger Zugänge (eine neue Zustimmung darüber hinaus ersetzt den
  ältesten des Kontos), damit ein Konto den Zugangsspeicher nicht für alle anderen füllen kann.

Die Seite verwendet ein `SameSite=Strict`-CSRF-Cookie mit einem passenden HMAC-Feld, nimmt POSTs nur
von sich selbst an, lässt sich nicht in Frames einbetten, und ihre Content Security Policy sendet
Formulare nur an sich selbst und an den geprüften Origin der Weiterleitung. Fehler im Client, seinen
Metadaten oder der Redirect-URI zeigen eine Fehlerseite und leiten nie weiter. Das eingefügte
sevDesk-Token wird bei sevDesk geprüft und nie wieder angezeigt.

## Metadaten von Clients abrufen (SSRF)

Eine `client_id`-URL abzurufen ist eine Anfrage, die der Server für jemand anderen stellt. Die URL
muss https auf einem DNS-Namen sein, ohne Query, Fragment, Zugangsdaten oder Punkt-Segmente, auf
einem Host der Erlaubnisliste. Der Name wird einmal aufgelöst, jede Adresse muss öffentlich sein
(private, Loopback-, Link-Local-, CGNAT-, Unique-Local-, Dokumentations- und Multicast-Bereiche
werden abgelehnt, auch innerhalb von NAT64-, 6to4- und IPv4-gemappten Adressen), und die Verbindung
geht an die geprüfte Adresse. Keine Weiterleitungen, 3 Sekunden für den Verbindungsaufbau und 5
insgesamt, nur `application/json`, höchstens 5 KiB. Das Dokument muss dieselbe `client_id` nennen,
1–10 Redirect-URIs aufführen und darf kein Client-Secret haben. Ablehnungen werden als
`cimd_blocked` protokolliert.

## OAuth-Tokens und Widerruf

Nur PKCE mit S256; der Hash des Verifiers wird in konstanter Zeit verglichen. Redirect-URIs müssen
genau übereinstimmen (Loopback-Weiterleitungen: der Host genau, beliebiger Port).

- Autorisierungscodes leben 60 Sekunden und werden einmal verwendet: Ein zweiter Austausch
  widerruft den Zugang (`code_replay`).
- Access-Tokens leben 1 Stunde und gelten nur für `<public URL>/mcp` (RFC 8707, genaue
  Übereinstimmung), und jede Anfrage schlägt den Zugang nach, sodass ein Widerruf mit der nächsten
  Anfrage wirkt.
- Refresh-Tokens werden bei jeder Nutzung ersetzt; das vorige wird nach einer Rotation noch 30
  Sekunden angenommen, jede spätere Nutzung widerruft den Zugang (`refresh_replay`). Jede Erneuerung
  prüft das sevDesk-Token erneut bei sevDesk, und ein 401 widerruft den Zugang.
- Ein Zugang endet spätestens nach 90 Tagen.

Alle Tokens sind mit AES-256-GCM unter einem Schlüssel je Zweck versiegelt, mit authentifiziertem
Typ, Issuer und Schlüssel-ID, und tragen ein lesbares Präfix `sdmcp_`, damit Schwärzung und
Secret-Scanner sie finden.

Der Zugriff endet mit `grants revoke` (ein Zugang, ein Konto oder alle), dem `/revoke`-Aufruf des
Clients (RFC 7009), einem neuen Server-Geheimnis ohne `_PREVIOUS` (alles) oder einem neu erzeugten
sevDesk-Token. Ein neu erzeugtes Token stoppt Werkzeugaufrufe sofort, weil sevDesk das alte
ablehnt, und widerruft jeden Zugang, der es hält, bei dessen nächster Erneuerung. Es beendet keine
Postfach-Sitzungen: Eine Anmeldung mit eingefügtem Token ist nicht an dieses Token gebunden (sie
gilt bis zu 12 Stunden), und eine Sitzung aus einer Zustimmung gilt, bis ihr Zugang widerrufen wird.
`grants revoke --account <id>` beendet die Zugänge und jede Postfach-Sitzung des Kontos auf einmal.

Ein Server, der seine Sperre auf das Zustandsverzeichnis an einen anderen verliert, vertraut seinem
Zugangsspeicher nicht mehr (OAuth-Anfragen scheitern mit einem Serverfehler) und beendet sich,
sodass er nie aus Zugängen antwortet, die er nicht mehr aktuell halten kann.

## Was das Server-Geheimnis entschlüsseln kann

Jeder Schlüssel stammt aus `SEVDESK_HTTP_SECRET`. Wer es hat und einen Autorisierungscode, ein
Access- oder Refresh-Token oder den Formularzustand einer Zustimmungsseite abfängt (von einem
Client, aus einem Proxy-Log, von einer Middlebox, die TLS terminiert), kann das sevDesk-Token darin
lesen. Das Geheimnis allein liefert kein sevDesk-Token, weil der Server keines speichert.

Bewahre es in einem Secret-Speicher auf (`SEVDESK_HTTP_SECRET_FILE`), nie im Image, im Repository
oder in einer Vorlage für die Bereitstellung, und schütze auch das Zustandsverzeichnis: Mit dem
Geheimnis und einer Kopie davon könnte jemand eine Postfach-Sitzung für eine aufgeführte Sitzungs-ID
fälschen. Wenn das Geheimnis nach außen gelangt sein könnte, ersetze es ohne `_PREVIOUS` (jeder
Client verbindet sich neu); wenn auch Tokens nach außen gelangt sein könnten, erzeuge die
sevDesk-Tokens neu und führe `grants revoke --account <id>` für die betroffenen Konten aus.

## Das Freigabe-Postfach

Im Fernzugriff stellt `SEVDESK_CONFIRM=browser` ein Postfach unter `<public URL>/approvals` bereit
([so verwendest du es](../remote/approvals.de.md)). Seine URL ist nicht geheim: Das Modell sieht sie
im Ergebnis des Werkzeugs, und ohne Sitzung zeigt das Postfach nur ein Anmeldeformular, keine Daten
von Freigaben.

- **Anmeldung.** Ein Browser erhält eine Sitzung bei der OAuth-Zustimmung oder durch Einfügen des
  sevDesk-Tokens (OAuth: bei sevDesk und gegen die Kontenliste geprüft; Bearer: in konstanter Zeit
  mit dem `SEVDESK_API_TOKEN` des Servers verglichen, nie mit dem Bearer-Geheimnis, das der Client
  hält). Anmeldungen sind auf 5 pro Minute und 20 pro Stunde je Client-Adresse begrenzt (IPv6 je
  /64-Netz).
- **Sitzungs-Cookie.** Versiegelt, enthält kein sevDesk-Token, `HttpOnly`, `Secure`, `SameSite=Lax`
  und mit `__Host-` präfixiert; gilt 12 Stunden, bekommt bei jeder Anmeldung eine neue ID und endet
  mit seinem Zugang oder mit `grants revoke --account`. `Lax` ist nötig, weil dem Link von claude.ai
  aus gefolgt wird, einer seitenübergreifenden Navigation.
- **Entscheidungen** sind POSTs, die außerdem ein an die Sitzung gebundenes CSRF-Token tragen und
  aus dem Postfach selbst kommen müssen (Origin oder `Sec-Fetch-Site: same-origin`; nie
  `Origin: null`). Jede Entscheidung prüft, dass die Freigabe zum Konto der Sitzung gehört.
- **Bindung.** Eine Freigabe gehört dem Zugang, der gefragt hat: Ein erneuter Versuch aus einer
  anderen Verbindung, auch desselben Kontos, kann sie nicht nutzen. Freigaben binden weiterhin,
  [was jede Freigabe bindet](confirmation.de.md#was-eine-freigabe-bindet), laufen nach 10 Minuten
  ab, werden einmal verwendet, und höchstens fünf je Konto warten gleichzeitig.
- **Platz.** Ein Konto behält höchstens 20 Freigaben, wartende und entschiedene, und schafft Platz
  unter seinen eigenen; der Server behält insgesamt 100. Ist das erreicht, kommt Platz nur von einem
  Konto, das mehr Freigaben hält als das anfragende: zuerst dessen älteste abgelehnte oder wartende,
  zuletzt eine erteilte, die noch nicht verwendet wurde (ihr Besitzer wird beim nächsten Versuch
  erneut gefragt). So verliert kein Konto eine Freigabe an eines, das gleich viele oder mehr hält.

## Grenzen des Postfachs

- Ein Agent, der einen angemeldeten Browser steuern kann (Browser-Automatisierung, ein Werkzeug zur
  Computersteuerung), kann trotzdem selbst freigeben: Wie die
  [lokale Seite](confirmation.de.md#grenzen-des-browser-modus) schützt das Postfach vor einem
  Modell, das nur redet.
- Eine nachgeahmte Seite könnte das sevDesk-Token abgreifen; füge es nur unter `/approvals` deines
  eigenen Servers ein (die meisten Benutzer müssen das nie, weil die Zustimmung den Browser
  anmeldet).
- Alle, die sich an einem Konto anmelden können, teilen sich sein Postfach und können über seine
  Freigaben entscheiden; sie halten ohnehin das Token dieses Kontos.
- Eine Sitzung bleibt in diesem Browser 12 Stunden gültig; melde dich an einem gemeinsam genutzten
  Rechner also ab. Ein neu erzeugtes sevDesk-Token beendet sie nicht (verwende
  `grants revoke --account`).
- Bei einer öffentlichen Loopback-URL über einfaches http (Entwicklung) hat das Cookie kein
  `__Host-`-Präfix und kein `Secure`-Flag, und Browser trennen Cookies nicht nach Port: Jeder andere
  Webserver, den der Browser unter diesem Hostnamen erreicht, erhält das Sitzungs-Cookie und könnte
  Freigaben lesen und entscheiden. Verwende für alles über einen kurzen lokalen Test hinaus https
  oder ein eigenes Browserprofil.
- Ein Neustart macht ausstehende Freigaben ungültig.

## Dateien

Mit aktivem `SEVDESK_HTTP_FILES` (der Standard) erreichen Dateien die Werkzeuge über Upload-Seiten
und verlassen den Server als Download-Links ([so verwendest du sie](../remote/files.de.md)). Das
Modell sieht und sendet nie den Inhalt einer Datei.

**Links sind keine Berechtigungen.** `sevdesk_upload_request` gibt `<public URL>/uploads/<id>`
zurück und die liefernden Werkzeuge `<public URL>/files/<id>`: Das Modell sieht beide, also ist
keiner geheim. Jede Seite braucht die Browser-Sitzung des Postfachs für das Konto des Eintrags. Ohne
Sitzung zeigt eine Seite nur das Anmeldeformular, dessen `next` nur die eigenen Eintragspfade des
Servers annimmt (keine offene Weiterleitung). Ein Eintrag eines anderen Kontos antwortet genau wie
eine unbekannte ID (404). Werkzeuge lesen nur Uploads, die ihr eigener Zugang angefordert hat; ein
anderer Zugang, auch desselben Kontos, erhält dieselbe Ablehnung. IDs sind 256 Bit zufällig;
Fehlermeldungen, Zusammenfassungen und Logs enthalten sie nie.

**Uploads.** Die Seite zeigt nur vertrauenswürdige Werte (Zweck, angenommene Arten, Größengrenze,
Konto, Referenz, Ablauf), sodass ein durch Prompt Injection gesteuertes Modell keine Anweisungen
darauf setzen kann. Ein Upload ist ein POST vom selben Origin (`Origin: null` abgelehnt) mit einem
an die Sitzung gebundenen CSRF-Token, genau den Feldern `csrf` und `file`, und besteht seine
Prüfungen, bevor der Body gelesen wird: Ratenbegrenzung, die Sitzung, ein offenes Ticket dieses
Kontos, ein angegebenes `Content-Length` (411 ohne) innerhalb der Grenze (413) und höchstens zwei
Bodys gleichzeitig (503). Der Dateityp wird am Inhalt geprüft; kein ZIP wird angenommen, Bilder
werden nie dekodiert, und der E-Rechnungs-Parser behält seine eigenen Schutzmechanismen gegen
feindliches XML und PDFs ([Lokale Dateien](local.de.md#lokale-dateien)). Namen werden auf
`[A-Za-z0-9._-]` bereinigt (Pfadanteile, Steuer- und unsichtbare Zeichen, Anführungszeichen und
Markup entfernt), immer maskiert und nie als Pfade verwendet. Uploads werden nie wieder
ausgeliefert.

**Downloads.** Die Bytes werden während des Werkzeugaufrufs von sevDesk geholt (PDFs mit
`preventSendBy=true`); das Öffnen eines Links stellt keine Anfrage an sevDesk und hat keine
Nebenwirkung. Antworten sind nur Anhänge (`Content-Disposition: attachment`), mit
`Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `X-Frame-Options: DENY`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` und
`Cache-Control: no-store`: Eine Datei wird nie auf dem Origin des Servers dargestellt, wo XML
Skripte ausführen könnte. HEAD wird abgelehnt. Ein Link liefert höchstens 5 Downloads, geschrieben
in Stücken von 64 KiB; ein Browser, der eine Minute lang keines davon abnimmt, wird getrennt, damit
er die Datei nicht lange im Speicher halten kann.

**Speicherung.** Einträge liegen nur im Speicher; die Bytes im Speicher oder in `<stateDir>/files/`
(Ordner 0700, Dateien 0600, exklusiv angelegt, ohne Links zu folgen, zufällige Namen), verschlüsselt
mit AES-256-GCM unter einem Schlüssel, der beim Start des Prozesses zufällig erzeugt und nirgends
gespeichert wird, mit authentifizierter Blob-ID, Konto und Art (ein zwischen Einträgen vertauschter
Blob lässt sich nicht öffnen). Dateien werden gelöscht, wenn sie ablaufen, und beim Herunterfahren,
und der Ordner wird bei jedem Start geleert, nachdem die Sperre des Zustandsverzeichnisses
übernommen wurde. Eine Kopie des Volumes oder des Server-Geheimnisses öffnet keine von ihnen.

**Erschöpfung.** Es gelten Grenzen je Upload, je Konto und für den ganzen Server
([Grenzen](../remote/files.de.md#grenzen-und-laufzeiten)). Nichts wird verdrängt, sodass ein Konto die Dateien eines
anderen nicht hinausdrängen kann; neue Anfragen werden abgelehnt, bis ältere ablaufen.

**Logs und Audit.** Logzeilen und die Dateiereignisse des [Audit-Logs](../permissions/audit-log.de.md)
tragen Konto, Zugang, Referenzcode, Art, Größe und SHA-256, nie IDs, Dateinamen oder Inhalt;
Anfragezeilen zeigen die Routen-Vorlagen `/uploads/*` und `/files/*`, und ein `upload:`-Argument
eines Werkzeugs wird als `upload:[REDACTED]` in das Audit-Log geschrieben.

**Grenzen.** Ein Agent, der einen angemeldeten Browser steuern kann, könnte selbst hoch- oder
herunterladen, so wie er im Postfach freigeben könnte. Bei einer öffentlichen Loopback-URL über
einfaches http erhalten andere lokale Webserver das Sitzungs-Cookie (der Start warnt). Wer TLS
terminiert, sieht die Dateien unterwegs. Mit `SEVDESK_OAUTH_ACCOUNTS=any` hält der Server kurzzeitig
Belege und Exporte anderer Leute (der Start warnt). Eine heruntergeladene Datei ist das, was sevDesk
geliefert hat.

## Logs

Eine JSON-Zeile pro Anfrage auf stderr: die Routen-Vorlage, Status, Dauer, Client-IP und die ersten
8 Zeichen der Zugangs-ID. Header, Bodys, Cookies und Query-Strings werden nie protokolliert, und
jede Zeile wird vom sevDesk-Token, den Bearer-Geheimnissen, dem Server-Geheimnis, versiegelten
Tokens und jeder Folge von 32 oder mehr Hex-Ziffern bereinigt (die Form eines sevDesk-Tokens).
Fehler, HTML-Seiten und Weiterleitungen enthalten nie ein Geheimnis, und das Zugangsobjekt im
Speicher lässt das sevDesk-Token aus, wenn es serialisiert oder inspiziert wird.
Sicherheitsereignisse werden mit Namen protokolliert (`refresh_replay`, `code_replay`,
`account_refused`, `cimd_blocked`).

## Was Aufgabe des Betreibers bleibt

TLS vor dem Server (ein Reverse Proxy, der Rand einer Plattform oder ein Tunnel; wer TLS terminiert,
kann Tokens unterwegs sehen, wähle also einen Anbieter, dem du vertraust, und nutze schnelle Tunnel
nur für Tests), das Server-Geheimnis, ein dauerhaftes Volume für das Zustandsverzeichnis, genau eine
Instanz, enge Erlaubnislisten und das Aktualisieren des Images.

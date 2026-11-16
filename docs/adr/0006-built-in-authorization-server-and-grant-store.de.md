<!-- translated-from: docs/adr/0006-built-in-authorization-server-and-grant-store.md sha256:599c67df628d -->

# ADR 0006: Eingebauter Autorisierungsserver und ein kleiner Zugangsspeicher

- **Status:** Angenommen
- **Datum:** 2026-11-09
- **Ersetzt:** [ADR 0004](0004-stateless-remote-oauth.de.md)

## Kontext

[ADR 0004](0004-stateless-remote-oauth.de.md) wählte standardmäßig stdio und einen zustandslosen
HTTP-Modus für den Fernzugriff mit OAuth, in dem das sevDesk-Token des Benutzers in den _Zugang_
(Grant) versiegelt statt gespeichert wird. Den Mechanismus für den Widerruf ließ es bis M5 offen. Der Bau
von M5 hat ihn und einige weitere Fragen geklärt:

- **Das SDK deckt nur den Ressourcenserver ab.** `@modelcontextprotocol/server` 2.4 prüft
  Bearer-Tokens (`requireBearerAuth` mit Prüfung der Zielgruppe), liefert die Metadaten-Dokumente
  aus und prüft Host und Origin. Einen Autorisierungsserver und einen HTTP-Adapter für Node hat es
  nicht.
- **Was die Spezifikation 2026-07-28 von einem Autorisierungsserver verlangt:** Metadaten der
  geschützten Ressource (RFC 9728) und ein 401, der darauf verweist; PKCE mit S256, in den Metadaten
  angegeben; eine Prüfung der Zielgruppe (RFC 8707); Rotation der Refresh-Tokens für öffentliche
  Clients; `iss` in der Autorisierungsantwort (RFC 9207, SHOULD). Sie kündigt Dynamic Client
  Registration (DCR) zugunsten von Client ID Metadata Documents (CIMD) ab und verlangt beim Abruf
  Vorsicht vor SSRF und eine Obergrenze von 5 KB.
- **Was Clients tun:** claude.ai verwendet CIMD nur, wenn die Metadaten des Servers
  `client_id_metadata_document_supported: true` und `"none"` in
  `token_endpoint_auth_methods_supported` enthalten; seine Redirect-URI ist
  `https://claude.ai/api/mcp/auth_callback`. Claude Code verwendet sein eigenes Metadaten-Dokument
  mit einer Loopback-Weiterleitung auf einem beliebigen Port, für `localhost` wie für `127.0.0.1`.
  Clients erneuern Tokens sowohl im Voraus als auch bei einem 401, manchmal beides gleichzeitig.
- **Der Widerruf in ADR 0004 war grob.** Ganz ohne Zustand lässt sich ein Zugang nur beenden, indem
  man den Server-Schlüssel wechselt, was alle abmeldet, und es gibt keine Liste der Verbindungen.
  Rotation der Refresh-Tokens mit Erkennung von Wiederverwendung muss die aktuelle Generation eines
  Zugangs kennen, und auch das ist Zustand.
- **Wer sich verbindet.** Die meisten Betreiber betreiben den Server für ihr eigenes Konto. Ein
  offener Server, der jedes sevDesk-Token annimmt, würde sie zu Verarbeitern der Buchhaltung
  anderer Leute machen und zu einem leichten Ziel für Consent-Phishing.

## Entscheidung

**Was aus ADR 0004 weiter gilt.** stdio ist der Standard-Transport. Streamable HTTP (`--http`)
bearbeitet MCP zustandslos und startet nicht ohne Authentifizierung, in einem von zwei Modi:

- `bearer`: ein statisches gemeinsames Geheimnis (bis zu zwei Werte, für einen Wechsel), als HMACs
  mit `timingSafeEqual` gegen jeden konfigurierten Wert verglichen. Der Server hält ein
  sevDesk-Token.
- `oauth`: Der Server ist sein eigener OAuth-2.1-Autorisierungsserver, mit PKCE, Clients, die sich
  über CIMD statt DCR ausweisen, und einer genauen Prüfung der Zielgruppe nach RFC 8707 bei jedem
  Token. Der Benutzer fügt sein sevDesk-Token einmal auf der Zustimmungsseite ein; es wird in die
  Tokens versiegelt, die der Client hält, und der Server speichert keine sevDesk-Tokens.

Prüfung von Host und Origin, standardmäßig eine Bindung an Loopback, Ratenbegrenzungen und
dieselben Stufen und Bestätigungen wie über stdio gelten. Wir veröffentlichen ein Docker-Image und
Vorlagen für die Bereitstellung und betreiben keine öffentliche Instanz.

**Ein eingebauter Autorisierungsserver** (`src/http/oauth/`), ohne neue Abhängigkeit:

- Metadaten der geschützten Ressource unter `/.well-known/oauth-protected-resource/mcp` und unter
  dem Wurzelpfad, Metadaten des Autorisierungsservers unter
  `/.well-known/oauth-authorization-server`: nur S256, `"none"` als einzige
  Client-Authentifizierung, CIMD unterstützt, `iss` in Antworten, Scopes `sevdesk:<tier>` und
  `offline_access`, kein Registrierungsendpunkt.
- `GET`/`POST /authorize` mit einer Zustimmungsseite in zwei Schritten, `POST /token` und
  `POST /revoke` (RFC 7009). Die Ressource muss genau `<public URL>/mcp` sein; der Präfixvergleich
  des SDK wird nicht verwendet.
- Fehler im Client, in seinem Metadaten-Dokument oder in der Redirect-URI zeigen eine Seite und
  leiten nie weiter. Redirect-URIs müssen genau übereinstimmen; Loopback-Weiterleitungen stimmen
  über den Host überein (`localhost`, `127.0.0.1` und `[::1]` jeweils für sich) mit beliebigem Port.

**Nur CIMD, mit einer Erlaubnisliste für Clients.** `SEVDESK_OAUTH_CLIENTS` (Standard `claude.ai`)
führt die Hosts auf, die eine `client_id` liefern dürfen, geprüft, bevor etwas abgerufen wird. Die
`client_id`-URL muss https auf einem DNS-Namen sein, ohne Query, Fragment, Zugangsdaten oder
Punkt-Segmente. Der Abruf löst den Namen einmal auf, lehnt jede Adresse ab, die nicht öffentlich ist
(private, Loopback-, Link-Local-, CGNAT-, ULA-, Dokumentations- und Multicast-Bereiche, auch hinter
NAT64-, 6to4- und IPv4-gemappten Formen), verbindet sich mit der geprüften Adresse, folgt keinen
Weiterleitungen, braucht höchstens 3 Sekunden für den Verbindungsaufbau und 5 insgesamt, nimmt nur
`application/json` bis 5 KiB an und hält Dokumente 60 Sekunden bis 24 Stunden im Cache (Fehler nie).
Das Dokument muss dieselbe `client_id` nennen, 1–10 Redirect-URIs, kein Client-Secret und keine
Client-Authentifizierung außer `none`.

**Versiegelte Tokens mit Schlüsseln je Zweck.** Codes, Access- und Refresh-Tokens, der
Formularzustand der Zustimmung und das Sitzungs-Cookie des Postfachs bestehen aus `sdmcp_<type>_`
und AES-256-GCM über einen JSON-Inhalt. Der Schlüssel für jeden Typ wird aus
`SEVDESK_HTTP_SECRET` über HKDF-SHA256 mit einer eigenen Zweckbezeichnung abgeleitet, und die
zusätzlichen Daten binden den Typ, den Aussteller und die Schlüssel-ID, sodass sich eine Art Token
nicht als eine andere oder an einem anderen Server verwenden lässt. Eine 4 Byte lange
Schlüssel-ID erlaubt `SEVDESK_HTTP_SECRET_PREVIOUS`, während eines Wechsels alte Tokens zu öffnen;
eine Erneuerung versiegelt sie neu mit dem aktuellen Schlüssel. Am lesbaren Präfix finden
Schwärzung in Logs und Secret-Scanner die Tokens.

**Laufzeiten.** Codes 60 Sekunden; Access-Tokens 1 Stunde; Refresh-Tokens 14 Tage ungenutzt;
Zugänge 90 Tage ab Zustimmung (einstellbar zwischen 5 Minuten und 24 Stunden, 1 und 90 Tagen
sowie 1 und 365 Tagen).

**Rotation und Wiederverwendung.** Jede Erneuerung liefert ein neues Refresh-Token der nächsten
Generation. Die vorige Generation wird nach einer Rotation noch 30 Sekunden angenommen und mit der
aktuellen Generation beantwortet, sodass ein Client, der zweimal gleichzeitig erneuert, weiter
funktioniert. Jede andere alte Generation gilt als Wiederverwendung und widerruft den Zugang, ebenso
ein zweiter Austausch eines Autorisierungscodes. Jeder Fehler an `/token` ist `invalid_grant`. Jede
Erneuerung prüft außerdem das sevDesk-Token mit `GET /SevClient`, bevor sie etwas rotiert, sodass ein
Client, der während der Prüfung abbricht, es mit demselben Token erneut versuchen kann: Ein 401 von
sevDesk widerruft den Zugang, ein neu erzeugtes Token in sevDesk beendet also den Zugriff.

**Ein kleiner Zugangsspeicher ohne Geheimnisse** (`grant-store.ts`). Ein Zugang ist eine
zugestimmte Verbindung eines Clients mit einem Konto. Der Speicher hält seine ID, das Konto, den
Client, die Stufen, Zeitstempel, den Status, die Generation des Refresh-Tokens und den Grund eines
Widerrufs, dazu die Sitzungen des Postfachs, und nie ein Token. Mit `SEVDESK_HTTP_STATE_DIR` ist er
eine nur angehängte `grants.jsonl` (Modus 0600, in einem Verzeichnis mit 0700), die beim Start und
im laufenden Betrieb verdichtet wird; ohne liegt er im Speicher. Access-Tokens werden bei jeder
Anfrage dagegen geprüft, was einen Widerruf sofort wirksam macht. Eine Sperrdatei mit
Lebenszeichen (nach 30 Sekunden verwaist, atomar übernommen) weist eine zweite laufende Instanz ab,
ohne einen Neustart nach einem Absturz zu blockieren; ein Server, der seine Sperre verliert, hört
auf, OAuth zu bedienen, und beendet sich, sodass er nie aus einem Zustand antwortet, den ein anderer
Prozess ersetzt hat. Eine beschädigte Datei verhindert den Start. Obergrenzen: 500 Zugänge
insgesamt, 20 je Konto (eine weitere Zustimmung darüber hinaus ersetzt den ältesten Zugang des
Kontos) und 1.000 Sitzungen. Ein geprüftes Zustimmungsformular wird einmal abgeschlossen. Die Befehle
`grants list` und `grants revoke` hängen an dieselbe Datei an, während der Server läuft; der Server
liest neue Ereignisse vor jeder Anfrage an `/token` und höchstens einmal pro Sekunde an `/mcp`.

Zwei Regeln für die Datei kamen nach dem Review 2026-11, Runde 3, hinzu:

- **Ganze Zeilen.** Ein Schreibvorgang kann weniger Bytes auf die Platte bringen als verlangt und
  trotzdem gelingen (ein fast volles Volume). Eine so abgeschnittene Zeile ist eine abgerissene
  letzte Zeile, die ein Leser überspringt; ein Widerruf konnte also verschwinden, während
  `grants revoke` Erfolg meldete. Jedes Anhängen (das des Servers, das des Befehls, die bei einer
  Verdichtung übernommenen Zeilen) schreibt jetzt die ganze Zeile oder scheitert, und beginnt auf
  einer neuen Zeile, wenn die Datei mit einer unvollendeten endet (gemeinsam mit dem Audit-Log,
  `src/safety/append-file.ts`). `grants revoke` liest die Datei so zurück, wie der Server es tut,
  und meldet Erfolg nur, wenn jeder seiner Widerrufe darin steht. Eine abgeschnittene Zeile, die ein
  späteres Anhängen abgeschlossen hat, ist eine kaputte Zeile mitten in der Datei, die ein Start und
  der Befehl `grants` ablehnen; ein laufender Server, der auf eine trifft oder dessen eigenes
  Anhängen gescheitert ist, schreibt die Datei bei seinem nächsten Abgleich aus dem neu, was er hält,
  statt auf die tägliche Verdichtung zu warten.
- **Eigentümer.** Der Server verwendet das Zustandsverzeichnis und `grants.jsonl` nur, wenn sie dem
  Benutzer gehören, als der er läuft (macOS und Linux). Der Modus allein klärt nicht, wer sie
  ändern darf: Der Eigentümer kann ihn wieder lockern, und unter macOS gewährt eine ACL Zugriff,
  den kein Modus-Bit zeigt. Der Befehl `grants` prüft das nicht, sodass ein Betreiber ihn als root
  ausführen kann.

**Standardmäßig nur für eigene Konten.** OAuth braucht `SEVDESK_OAUTH_ACCOUNTS`: die
sevDesk-Konto-IDs, die sich verbinden dürfen. `any` schaltet die Bedienung jedes Kontos ausdrücklich
ein und protokolliert eine Warnung. Beide Erlaubnislisten gelten bei jeder Nutzung, nicht nur bei
der Zustimmung: Ein Zugang, dessen Konto oder Client-Host nicht mehr aufgeführt ist, wird bei seiner
nächsten Anfrage oder Erneuerung widerrufen, und seine Sitzungen im Postfach enden.

**Stufen je Zugang.** Die Zustimmungsseite gewährt immer `read` und bietet die anderen Stufen an,
die `SEVDESK_ALLOW` aktiviert, nicht angehakt. Eine Anfrage bekommt die Stufen des Tokens ∩ die
Stufen des Zugangs ∩ `SEVDESK_ALLOW`; eine engere Einstellung des Servers engt also jeden Zugang
sofort ein.

**Eine Instanz.** Zugänge, Sitzungen, ausstehende Freigaben, Nonces der Bestätigungen und
Ratenbegrenzungen leben in einem Prozess und seinem Zustandsverzeichnis. Die Vorlagen für die
Bereitstellung betreiben eine Instanz mit einem Volume.

## Folgen

- Vorteil: Einzelne Verbindungen lassen sich auflisten und widerrufen, und ein Widerruf wirkt mit
  der nächsten Anfrage. Gestohlene Access-Tokens laufen innerhalb einer Stunde ab; ein gestohlenes
  Refresh-Token fällt auf, sobald eine der beiden Seiten es nach der anderen verwendet.
- Vorteil: weiterhin kein Speicher für sevDesk-Tokens. Eine Kopie des Zustandsverzeichnisses
  verrät, welche Konten und Clients verbunden sind, aber nichts, was Zugriff gewährt.
- Vorteil: Die Erlaubnislisten für Konten und Clients halten einen selbst betriebenen Server auf
  eigene Konten beschränkt, solange der Betreiber nichts anderes entscheidet, und erschweren
  Consent-Phishing über fremde Metadaten-Dokumente.
- Vorteil: funktioniert mit claude.ai und Claude Code, so wie sie sich heute verhalten, ohne
  Registrierung von Clients.
- Nachteil: Wir pflegen einen Autorisierungsserver selbst. Das ist sicherheitskritischer Code ohne
  Bibliothek dahinter, deshalb hat jede Regel oben einen Bedrohungstest.
- Nachteil: Das Server-Geheimnis öffnet jedes Token. Wer das Geheimnis und ein abgefangenes Token
  hat, liest das sevDesk-Token darin. Das Geheimnis gehört in einen Secret-Speicher, und es ohne
  `_PREVIOUS` zu wechseln meldet alle ab.
- Nachteil: Der Server hält Zustand: ein Volume zum Einbinden und Sichern, eine Sperre und keine
  horizontale Skalierung. Mehrere Instanzen bräuchten einen gemeinsamen Speicher oder Sticky
  Routing.
- Nachteil: Die Eigentümerregel lehnt Einrichtungen ab, die vorher allein über den Modus
  funktionierten: einen Server, der als root auf einem Zustandsverzeichnis (oder mit einem
  Audit-Log) läuft, das einem anderen Benutzer gehört. Das Verzeichnis muss dem Benutzer des
  Servers übergeben werden (`chown`).
- Nachteil: Läuft kein Server und scheitert ein Anhängen des Befehls `grants` auf halbem Weg, behält
  die Datei eine kaputte Zeile, die nichts repariert; der nächste Start lehnt die Datei ab (im
  Zweifel ablehnen), und der Betreiber muss sie wiederherstellen oder verschieben.
- Nachteil: Clients, die nur DCR unterstützen, können den OAuth-Modus nicht nutzen; sie müssen den
  Bearer-Modus verwenden.
- Nachteil: Das sevDesk-Token selbst läuft nie ab. Laufzeiten der Zugänge, Widerruf und die Prüfung
  bei der Erneuerung sind die einzigen Grenzen, die wir durchsetzen können.

## Erwogene Alternativen

- **Dynamic Client Registration.** Verworfen: von der Spezifikation 2026-07-28 abgekündigt, ein
  offener Registrierungsendpunkt mit Zustand je Client, und registrierte Namen beweisen nichts. CIMD
  bindet einen Client an einen Host, den wir auf eine Erlaubnisliste setzen können.
- **JWT als Access-Token.** Verworfen: Ein signiertes JWT kann der Client lesen und jeder, der es
  protokolliert; es kann also das sevDesk-Token nicht tragen. Verschlüsselte JWTs (JWE) brauchen eine
  Bibliothek oder viel Code. Wir sind unser einziger Ressourcenserver, interoperable Token-Formate
  bringen also nichts; undurchsichtige versiegelte Tokens sind kleiner und verschlüsselt.
- **Keine Refresh-Tokens.** Verworfen: Entweder leben Access-Tokens lange (ein längeres Fenster für
  ein gestohlenes Token und kein Zeitpunkt, an dem das sevDesk-Token erneut geprüft wird), oder der
  Benutzer stimmt jede Stunde zu.
- **Eine Token-Datenbank.** Verworfen wie in ADR 0004: Speichert der Server das sevDesk-Token jedes
  Benutzers, wird er zum lohnenden Ziel. Versiegelte Tokens lassen das Token beim Client; der
  Speicher hält nur, was zum Auflisten und Widerrufen nötig ist.
- **Widerruf nur durch Wechsel des Server-Schlüssels oder eine Sperrliste.** Verworfen: Ein Wechsel
  meldet alle ab, und eine Sperrliste ist derselbe Zustand wie ein Zugangsspeicher, nur ohne die
  Liste der Verbindungen.

<!-- translated-from: docs/remote/operations.md sha256:ba6e23355e30 -->

# Den Server betreiben

Die tägliche Arbeit für den Betreiber eines Servers im [Fernzugriff](../remote.de.md): die
Betriebsbefehle, wie du Zugriff entziehst und das Geheimnis wechselst, was die Logs zeigen,
Zustandsprüfung und Herunterfahren sowie die festen Grenzen.

## Befehle

Das Programm hat außer dem Bereitstellen einige Befehle. Mit Docker hängst du sie an
`docker run --rm <image>` an (der Standardbefehl des Images ist `--http`).

| Befehl                                   | Was er tut                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generate-secret`                        | Gibt 32 zufällige Bytes aus, base64url: ein Wert für `SEVDESK_HTTP_SECRET` oder ein Bearer-Geheimnis.                                                                                                                                                                                                                                                              |
| `account-id`                             | Fragt sevDesk, zu welchem Konto das konfigurierte Token gehört (`SEVDESK_API_TOKEN`, seine `_FILE`-Variante, der Schlüsselbund oder ein Profil), und gibt dessen ID aus, für `SEVDESK_OAUTH_ACCOUNTS`.                                                                                                                                                             |
| `grants list [--json]`                   | Listet die Zugänge in `SEVDESK_HTTP_STATE_DIR` auf, die neuesten zuerst: ID, Konto, Client-Host, Stufen, Status (mit dem Grund eines Widerrufs), angelegt, Ablauf und letzte Erneuerung. `--json` gibt JSON mit der vollständigen `client_id` aus (Felder unten).                                                                                                  |
| `grants revoke <grant-id>`               | Widerruft einen Zugang und seine Browser-Sitzungen.                                                                                                                                                                                                                                                                                                                |
| `grants revoke --account <id>` / `--all` | Widerruft alle Zugänge eines Kontos oder alle Zugänge.                                                                                                                                                                                                                                                                                                             |
| `healthcheck`                            | Fragt den Server unter `SEVDESK_HTTP_HOST` und seinem Port nach `/healthz` (unter 127.0.0.1, wenn er auf allen Schnittstellen lauscht) und endet mit 0, wenn er `{"status":"ok"}` antwortet; die Zustandsprüfung des Images nutzt ihn. Ohne `SEVDESK_HTTP_AUTH` (ein Image, das mit `--stdio` startet) endet er mit 0, ohne zu fragen; bei Port 0 schlägt er fehl. |

`grants list --json` gibt ein Array mit einem Objekt je Zugang aus, die neuesten zuerst: `id`,
`account` (die sevDesk-Konto-ID), `client` (die vollständige `client_id`-URL), `clientHost`,
`tiers`, `status` (`pending`, bis der Client seinen Autorisierungscode eingelöst hat, danach
`active`, `revoked` oder `expired`), `reason` (warum er widerrufen wurde, ein kurzer Code wie
`user`, `operator`, `superseded` oder `sevdesk_401`; sonst `null`) sowie die Zeitpunkte
`createdAt`, `expiresAt`, `lastRefreshAt` und `revokedAt` (ISO 8601, `null`, solange es nicht
geschehen ist).

Die `grants`-Befehle brauchen dasselbe `SEVDESK_HTTP_STATE_DIR` wie der Server und funktionieren,
während er läuft: Sie hängen an `grants.jsonl` an, und der Server übernimmt die Änderung innerhalb
von etwa einer Sekunde. Mit dem Image brauchen sie das Volume, zum Beispiel
`docker run --rm -v sevdesk-mcp-data:/data ghcr.io/jaylann/mcp-server-sevdesk:<version> grants list`.
Ohne Zustandsverzeichnis gibt es Zugänge nur im Serverprozess, und die Befehle sehen sie nicht. Das
Image hat keine Shell; eine Plattform-Konsole, die eine braucht, kann sie also nicht ausführen. Dort
entziehst du den Zugriff, indem du das Server-Geheimnis oder das sevDesk-Token ersetzt
([Zugriff entziehen](#zugriff-entziehen)).

## Zugriff entziehen

| Um zu beenden                   | Was du tust                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Eine Verbindung                 | `grants revoke <grant-id>`. Ihre nächste Anfrage bekommt 401, und der Client bittet um eine neue Verbindung. Clients, die den Widerruf von Tokens unterstützen (RFC 7009, `/revoke`), tun dasselbe, wenn du sie trennst.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Alle Verbindungen eines Kontos  | `grants revoke --account <id>`. Das beendet auch jede Browser-Sitzung des Kontos, einschließlich Anmeldungen mit eingefügtem Token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Alles                           | `grants revoke --all` (jeder Zugang und jede Browser-Sitzung, auch Anmeldungen mit einem Token), oder ersetze `SEVDESK_HTTP_SECRET`, ohne das alte als `_PREVIOUS` zu behalten: Kein zuvor ausgestelltes Token lässt sich dann noch öffnen.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Zugriff mit einem sevDesk-Token | Erzeuge das Token in sevDesk neu (Einstellungen → Benutzer → API-Token). sevDesk lehnt das alte sofort ab, Werkzeugaufrufe funktionieren also nicht mehr, und die nächste Erneuerung jedes Zugangs, der es hält (innerhalb der Laufzeit des Access-Tokens), widerruft diesen Zugang. Das wirkt auch, wenn das Server-Geheimnis oder die Tokens eines Clients nach außen gelangt sind. Browser-Sitzungen sind nicht an das Token gebunden: Eine Anmeldung mit dem alten Token bleibt bis zu 12 Stunden gültig und eine Sitzung aus einer Zustimmung, bis ihr Zugang widerrufen wird. Führe zusätzlich `grants revoke --account <id>` aus, um sie sofort zu beenden. |
| Bearer-Zugriff                  | Ersetze `SEVDESK_HTTP_BEARER_TOKEN` und starte neu. Browser-Anmeldungen überdauern einen Neustart, wenn `SEVDESK_HTTP_SECRET` und das Zustandsverzeichnis erhalten bleiben; `grants revoke --account <id>` beendet sie (die ID ist die, die der Server beim Start protokolliert hat, oder `bearer`, falls diese Abfrage fehlschlug).                                                                                                                                                                                                                                                                                                                               |

Uploads und Download-Links werden nicht mit einem Zugang widerrufen: Das Ende einer Sitzung sperrt
den Browser, der sie hielt, und die Dateien laufen innerhalb von `SEVDESK_HTTP_FILES_TTL` ab. Ein
Neustart macht sie alle auf einmal ungültig. Entfernst du einen Connector in claude.ai, verwirft
claude.ai seine Tokens; den Zugang zu widerrufen beendet ihn auch auf dem Server.

## Das Server-Geheimnis wechseln

1. Erzeuge mit `generate-secret` ein neues Geheimnis.
2. Setze es als `SEVDESK_HTTP_SECRET`, verschiebe das alte nach `SEVDESK_HTTP_SECRET_PREVIOUS` und
   starte neu. Mit dem alten Geheimnis versiegelte Tokens werden weiter angenommen; ihre Erneuerung
   versiegelt die neuen mit dem neuen Geheimnis.
3. Behalte `_PREVIOUS` so lange wie die Leerlaufzeit der Erneuerung
   (`SEVDESK_OAUTH_REFRESH_IDLE_TTL`, standardmäßig 14 Tage), entferne es dann und starte neu. Ein
   Client, der in dieser Zeit nicht erneuert hat, verbindet sich neu.

Wenn das Geheimnis nach außen gelangt sein könnte, überspringe die Wartezeit aus Schritt 3: Ersetze
es ohne `_PREVIOUS`. Jeder Client verbindet sich neu. Wenn auch Tokens nach außen gelangt sein
könnten (das Geheimnis öffnet sie und das sevDesk-Token darin), erzeuge außerdem die
sevDesk-Tokens neu und führe für jedes Konto `grants revoke --account <id>` aus, was auch seine
Browser-Sitzungen beendet.

Bearer-Geheimnisse wechselst du genauso: Setze `SEVDESK_HTTP_BEARER_TOKEN=<new>,<old>`,
aktualisiere die Clients und entferne dann den alten Wert.

## Logs

Der Server schreibt nach stderr: beim Start den MCP-Endpunkt, den er bereitstellt, dann ein
JSON-Objekt pro Anfrage mit der Route (als Vorlage, nicht der vollständige Pfad), dem Status, der
Dauer, der Client-IP und den ersten 8 Zeichen der Zugangs-ID. Header, Bodys, Cookies und
Query-Strings werden nie protokolliert, und jede Zeile wird vom sevDesk-Token, den Bearer- und
Server-Geheimnissen, allem, was wie ein versiegeltes Token aussieht (`sdmcp_…`), und jeder Folge
von 32 oder mehr Hex-Ziffern bereinigt (die Form eines sevDesk-Tokens, das der Server im
OAuth-Modus nicht im Voraus kennt).

Sicherheitsereignisse werden als Warnungen mit Namen protokolliert: `refresh_replay` und
`code_replay` (ein Token wurde zweimal verwendet; der Zugang wurde widerrufen), `account_refused`
(Zustimmung mit einem Konto, das nicht auf der Liste steht), `cimd_blocked` (ein Metadaten-Dokument
eines Clients wurde abgelehnt) und `grant_revoked` (mit seinem Grund, zum Beispiel
`account_removed`, wenn eine Erlaubnisliste den Zugang nicht mehr abdeckt).

Die Browser-Seiten protokollieren eigene Ereignisse. Anmeldungen (gemeinsam für das Postfach und
die Dateiseiten und nach dem Postfach benannt): `approval_login`, `approval_login_refused`,
`approval_login_limited`, `approval_login_unavailable` (sevDesk konnte nicht gefragt werden),
`approval_logout` und `approval_session_refused` (eine Sitzung eines Kontos, das nicht mehr erlaubt
ist). Dateiübertragung:

| Ereignis           | Stufe | Felder                                                                                                                                                                                                                                                                   |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `upload_received`  | info  | `account`, `reference`, `kind`, `bytes`                                                                                                                                                                                                                                  |
| `upload_refused`   | warn  | `reason` (`rate_limited`, `foreign_origin`, `signed_out`, `unknown`, `expired`, `already_received`, `unsupported_type`, `length_required`, `too_large`, `bad_form`, `stale_form`, `csrf`, `empty`, `wrong_kind`, `storage_full`, `failed`), `account` nach der Anmeldung |
| `download_served`  | info  | `account`, `reference`, `kind`, `bytes`                                                                                                                                                                                                                                  |
| `download_refused` | warn  | `reason` (`signed_out`, `unknown`, `expired`, `exhausted`), `account` nach der Anmeldung                                                                                                                                                                                 |
| `audit_failed`     | warn  | `event`: ein Dateiereignis konnte nicht in `SEVDESK_AUDIT_LOG` geschrieben werden                                                                                                                                                                                        |

Ihre Anfragezeilen zeigen die Routen als `/uploads/*` und `/files/*`. Upload- und Download-IDs und
Dateinamen werden nie protokolliert; der Referenzcode verbindet eine Logzeile mit der Seite, dem
Ergebnis des Werkzeugs und dem Audit-Log.

Jede Seite lädt ihre Schriften und ihr Symbol vom Server selbst: Anfragezeilen mit der Route
`/assets/*`, ohne Sitzung beantwortet und vom Browser dauerhaft zwischengespeichert (die
Dateinamen tragen einen Inhalts-Hash). Von anderen Servern laden die Seiten nichts; ein Proxy
braucht also keine eigene Regel, er reicht diese Pfade wie alle anderen durch.

## Zustandsprüfung und Herunterfahren

`GET /healthz` antwortet `{"status":"ok"}` ohne Authentifizierung und ohne Host-Prüfung, für die
Zustandsprüfungen von Plattformen. Bei SIGTERM antwortet der Server dort mit 503, gibt laufenden
Anfragen 10 Sekunden, löscht dann die Dateien der Uploads und Download-Links, schreibt den
Zugangsspeicher und gibt die Sperre frei.

## Grenzen

- **Eine Instanz** je Zustandsverzeichnis; keine horizontale Skalierung
  ([Eine Instanz](../remote.de.md#eine-instanz)).
- **Ein Neustart macht ausstehende Freigaben und Bestätigungen sowie jeden Upload und
  Download-Link ungültig.** Das Modell fragt erneut. Zugänge und Browser-Sitzungen überdauern ihn
  mit einem Zustandsverzeichnis (und im Bearer-Modus mit `SEVDESK_HTTP_SECRET`); ohne meldet ein
  Neustart jeden Client ab.
- **Höchstens 500 Zugänge** insgesamt: Darüber hinaus werden neue Zustimmungen abgelehnt, bis
  Zugänge widerrufen werden oder ablaufen. Jedes Konto hat außerdem eine kleinere Grenze für gültige
  Zugänge: Eine neue Zustimmung darüber hinaus widerruft den ältesten Zugang des Kontos (Grund
  `superseded`), damit ein Konto den Speicher nicht füllen kann. Widerrufene Zugänge bleiben 7 Tage
  gelistet. **Höchstens 1.000 Browser-Sitzungen**: Darüber hinaus endet die älteste.
- **Gleichzeitige Anfragen.** Der Server bearbeitet höchstens 64 Anfragen gleichzeitig. Eine
  Client-Adresse (IPv6: ihr /64-Netz) darf 8 laufende haben, mit `SEVDESK_OAUTH_ACCOUNTS=any` 32,
  weil sich dort viele Nutzer die Adressen von claude.ai teilen. Ein sevDesk-Konto darf 8 laufende
  Anfragen an `/mcp` haben, über alle seine Verbindungen und Adressen hinweg. Weitere bekommen 429
  mit `Retry-After: 1`. Von den 64 bleiben 8 der Token-Erneuerung, der Anmeldung, dem
  Freigabe-Postfach und den Dateiseiten vorbehalten, damit diese erreichbar bleiben, während `/mcp`
  ausgelastet ist; `/mcp` selbst antwortet mit 503, sobald seine 56 belegt sind, was sieben Konten
  an ihrer Grenze bewirken können. Eine Anfrage darf 120 Sekunden dauern; die Steuerberichte
  (`sevdesk_vat_summary`, `sevdesk_profit_and_loss`) und die Prüfungen (`sevdesk_records_audit`)
  hören nach 90 Sekunden auf zu lesen und geben zurück, was sie haben, als unvollständig markiert.
  Diese Zahlen sind fest.
- **JSON-RPC-Batches** (mehrere Nachrichten in einer Anfrage, nur von Clients der Protokollversion
  2025-03-26 gesendet) dürfen höchstens 8 Nachrichten enthalten und keine Anfrage-ID doppelt;
  sonst wird der ganze Batch mit 400 abgelehnt, und nichts davon läuft. Ein Batch zählt als eine
  Anfrage.
- **Freigaben** (`SEVDESK_CONFIRM=browser`): 5 wartende und 20 aufbewahrte je Konto, 100 für den
  ganzen Server. Hält der Server 100, kommt Platz von einem Konto, das mehr hält als das anfragende
  (zuerst dessen älteste abgelehnte oder wartende Anfrage, zuletzt eine erteilte, ungenutzte; zu
  diesem Aufruf wird dann erneut gefragt). Ein Konto verliert nie eine Anfrage an eines, das gleich
  viele oder mehr hält.
- **Keine Server-Ordner im OAuth-Modus.** `SEVDESK_FILE_DIRS` und `SEVDESK_OUTPUT_DIR` werden
  abgelehnt; Belege werden auf den Seiten des Servers hochgeladen und gespeicherte Dateien dort
  heruntergeladen, was eine Browser-Sitzung des Kontos braucht, und leben höchstens
  `SEVDESK_HTTP_FILES_TTL`. Ein Upload ist höchstens 20 MiB groß
  ([alle Dateigrenzen](files.de.md#grenzen-und-laufzeiten)). Das PDF einer Rechnung, einer
  Gutschrift oder eines Auftrags und das XML einer E-Rechnung erreichen den Client außerdem ohne
  den Browser, als MCP-Ressourcen (`sevdesk://…`), gleich wie `SEVDESK_HTTP_FILES` gesetzt ist.
- **Clients ohne Client ID Metadata Documents** können den OAuth-Modus nicht nutzen; für sie
  funktioniert der Bearer-Modus.
- **Keine gehostete Instanz.** Du betreibst, was du bereitstellst.

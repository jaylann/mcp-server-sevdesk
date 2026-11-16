<!-- translated-from: docs/remote.md sha256:423d7e895429 -->

# Fernzugriff (HTTP)

Mit `--http` spricht der Server MCP über Streamable HTTP statt über stdio. Dann können ihn auch
Clients nutzen, die keinen lokalen Prozess starten können: benutzerdefinierte Connectoren in
claude.ai (und die Claude-Apps, die mit demselben Konto angemeldet sind), Claude Code, Cursor oder
VS Code auf einem anderen Rechner oder ein kleines Team, das sich einen Server teilt. Eine gehostete
Instanz gibt es nicht: Du betreibst den Server selbst, auf deinem eigenen Rechner, einer VM oder
einer Plattform wie Fly.io. Für eine Person an einem Rechner bleibt stdio die einfachere Wahl.

Diese Seite erklärt die Konzepte und bringt einen ersten Server zum Laufen;
[Weiterlesen](#weiterlesen) führt zu den Einzelheiten. Der Entwurf steht in
[architecture/transports.de.md](architecture/transports.de.md), das Bedrohungsmodell in
[security/remote.de.md](security/remote.de.md).

## Konzepte

### Bearer oder OAuth

`SEVDESK_HTTP_AUTH` wählt einen von zwei Modi. Ohne die Variable startet `--http` nicht.

|                            | `bearer`                                                    | `oauth`                                                                                  |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Wer das sevDesk-Token hält | der Server (`SEVDESK_API_TOKEN`)                            | der Client jedes Benutzers, versiegelt in den Tokens, die der Server ihm ausgestellt hat |
| Konten                     | eines                                                       | jedes Konto in `SEVDESK_OAUTH_ACCOUNTS`                                                  |
| Was ein Client sendet      | ein gemeinsames Geheimnis: `Authorization: Bearer <secret>` | OAuth-2.1-Access-Tokens, nach einer Zustimmungsseite im Browser                          |
| Stufen                     | `SEVDESK_ALLOW`                                             | je Verbindung auf der Zustimmungsseite gewählt, höchstens `SEVDESK_ALLOW`                |
| Clients                    | alles, was einen Header senden kann                         | Clients mit Client ID Metadata Documents: claude.ai, Claude Code                         |
| Zugriff entziehen          | das Geheimnis ändern                                        | je Verbindung, je Konto oder alles (`grants revoke`)                                     |

**`bearer`** ist der einfache Modus: Ein gemeinsames Geheimnis (`SEVDESK_HTTP_BEARER_TOKEN`)
schützt ein sevDesk-Konto. Verwende ihn in einem privaten Netz, hinter einer anderen
Zugangskontrolle oder für Clients, die du selbst einrichtest. Wer das Geheimnis hat, kann die
Stufen des Servers für dieses Konto nutzen; behandle es also wie das sevDesk-Token.

**`oauth`** macht den Server zu seinem eigenen OAuth-2.1-Autorisierungsserver. Ein Client, der sich
verbindet, wird auf eine Zustimmungsseite auf deinem Server geleitet. Dort wählt der Benutzer die
Stufen für diese Verbindung und fügt sein sevDesk-API-Token einmal ein. Der Server prüft das Token
bei sevDesk, versiegelt es (AES-256-GCM) im Autorisierungscode und in den Access- und
Refresh-Tokens, die er dem Client gibt, und behält nur einen Vermerk, dass die Verbindung besteht:
einen _Zugang_ (Grant). Benutzerdefinierte Connectoren in claude.ai brauchen diesen Modus. Clients
weisen sich mit einem Client ID Metadata Document (CIMD) aus: Ihre `client_id` ist eine https-URL,
die ihren Namen und ihre Redirect-URIs liefert. Dynamic Client Registration wird nicht angeboten;
ein Client, der nur die Registrierung unterstützt, braucht den Bearer-Modus.

### Standardmäßig nur für deine Konten

Im OAuth-Modus können sich nur die sevDesk-Konten in `SEVDESK_OAUTH_ACCOUNTS` verbinden. Deine
Konto-ID findest du mit [`account-id`](remote/operations.de.md#befehle); ein abgelehnter Benutzer
sieht seine eigene Konto-ID auf der Zustimmungsseite. `SEVDESK_OAUTH_ACCOUNTS=any` lässt jeden mit
einem sevDesk-Token deinen Server nutzen, und der Start protokolliert eine Warnung: Du würdest dann
die Buchhaltungsdaten anderer Leute verarbeiten (siehe [PRIVACY.de.md](../PRIVACY.de.md)).

Auch Clients sind beschränkt: `SEVDESK_OAUTH_CLIENTS` führt die Hosts auf, die das
Metadaten-Dokument eines Clients liefern dürfen (Standard `claude.ai`), geprüft, bevor etwas
abgerufen wird. Sonst könnte ein Angreifer sein eigenes Metadaten-Dokument bereitstellen und dir
einen Link auf deine eigene Zustimmungsseite schicken, der echt aussieht (Consent-Phishing).

Beide Listen gelten für jede Anfrage und jede Erneuerung, nicht nur bei der Zustimmung. Entfernst
du ein Konto oder einen Client-Host und startest neu, werden dessen bestehende Zugänge bei der
nächsten Nutzung widerrufen (fügst du den Eintrag später wieder hinzu, stellt das sie nicht wieder
her; der Benutzer verbindet sich erneut), und die Browser-Sitzungen eines entfernten Kontos enden.

### Stufen je Zugang

Jede OAuth-Verbindung hat ihre eigenen [Stufen](permissions.de.md#stufen). Die Zustimmungsseite
gewährt immer `read` und bietet für jede weitere Stufe, die `SEVDESK_ALLOW` aktiviert, ein
Kästchen an, alle nicht angehakt; einem Client, der bestimmte `sevdesk:<tier>`-Scopes anfragt,
werden nur diese angeboten. Eine Anfrage bekommt die Stufen des Zugangs, die `SEVDESK_ALLOW` noch
aktiviert (nur `read` mit `SEVDESK_READ_ONLY=1`), und das Modell sieht nur die Werkzeuge dieser
Stufen. Ein engeres `SEVDESK_ALLOW` gilt sofort für alle Zugänge; ein weiteres erweitert bestehende
Zugänge nicht: Der Benutzer verbindet sich neu und hakt die neue Stufe an.

Im Bearer-Modus sind die Stufen `SEVDESK_ALLOW`, wie über stdio.

### Was der Server speichert und was nie

| Wo                                              | Was                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grants.jsonl` in `SEVDESK_HTTP_STATE_DIR`      | Je Zugang (OAuth): eine zufällige ID, die sevDesk-Konto-ID, die `client_id`-URL des Clients und ihr Host, die Stufen, Zeitstempel (angelegt, Ablauf, letzte Rotation, widerrufen), der Status, die Generation des Refresh-Tokens und der Grund eines Widerrufs. Je Browser-Sitzung (Freigabe-Postfach und Dateiseiten, auch im Bearer-Modus): eine zufällige ID, die Konto-ID, der Zugang, aus dem sie stammt, und wie sie geöffnet wurde. Nur angehängt, Modus 0600, beim Start und von Zeit zu Zeit verdichtet. Ohne Zustandsverzeichnis im Speicher. |
| `grants.lock` im Zustandsverzeichnis            | Kennzeichnet die laufende Instanz (ein Lebenszeichen alle 10 Sekunden).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `files/` im Zustandsverzeichnis (oder Speicher) | Hochgeladene Dateien und die Dateien hinter Download-Links, solange sie gültig sind, verschlüsselt mit AES-256-GCM unter einem Schlüssel, der beim Start des Prozesses zufällig erzeugt und nirgends gespeichert wird, unter zufälligen Namen (Ordner 0700, Dateien 0600). Gelöscht nach bestätigtem Anhängen, beim Ablauf und beim Herunterfahren; bei jedem Start geleert. Siehe [Dateien](remote/files.de.md).                                                                                                                                       |
| `SEVDESK_AUDIT_LOG`, falls gesetzt              | Jeder schreibende Aufruf jedes Kontos, mit Konto und Zugang, sowie jeder empfangene Upload, jeder angelegte Download-Link und jeder Download (Referenz, Art, Größe und SHA-256, kein Name und kein Inhalt). Siehe [Audit-Log](permissions/audit-log.de.md).                                                                                                                                                                                                                                                                                             |
| Nur im Speicher (beim Neustart verloren)        | Ausstehende Freigaben, ausstehende Bestätigungen (ihre Einmal-Nonces), Upload-Seiten und Download-Links, zwischengespeicherte Metadaten-Dokumente von Clients, Caches je Konto und Zähler der Ratenbegrenzung.                                                                                                                                                                                                                                                                                                                                          |

**Nie gespeichert**, weder in Dateien noch in Logs: sevDesk-API-Tokens, Autorisierungscodes,
Access- und Refresh-Tokens, Cookies, das Server-Geheimnis, die Bearer-Geheimnisse und der Schlüssel
der verschlüsselten Dateien. Die Geheimnisse kommen nur aus der Umgebung. Upload- und Download-IDs
erscheinen nie in einem Log, und das Log des Servers (stderr) enthält keine Dateinamen. Das
Audit-Log kann welche enthalten: Die Vorschau, die es festhält, enthält die Fakten des Aufrufs, bei
einem Belegentwurf mit Belegdatei den bereinigten Dateinamen und im Bearer-Modus mit
`SEVDESK_FILE_DIRS` einen `file`-Pfad ([Audit-Log](permissions/audit-log.de.md)).

### Tokens und Laufzeiten

| Was                               | Laufzeit                                             | Hinweise                                                                                                                         |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Autorisierungscode                | 60 Sekunden                                          | Einmal verwendbar. Ein zweiter Austausch widerruft den Zugang.                                                                   |
| Access-Token                      | `SEVDESK_OAUTH_ACCESS_TTL` (1 Stunde)                | Nur gültig für `<public URL>/mcp`. Jede Anfrage wird gegen den Zugangsspeicher geprüft.                                          |
| Refresh-Token                     | `SEVDESK_OAUTH_REFRESH_IDLE_TTL` (14 Tage ungenutzt) | Bei jeder Nutzung ersetzt; nie länger gültig als der Zugang.                                                                     |
| Zugang                            | `SEVDESK_OAUTH_GRANT_TTL` (90 Tage ab Zustimmung)    | Danach stimmt der Benutzer erneut zu.                                                                                            |
| Cookie der Browser-Sitzung        | 12 Stunden                                           | Freigabe-Postfach, Upload- und Download-Seiten. Enthält kein sevDesk-Token. Endet mit seinem Zugang.                             |
| Upload-Seite                      | 15 Minuten                                           | Nimmt 1–10 Dateien an, je nach Anfrage.                                                                                          |
| Hochgeladene Datei, Download-Link | `SEVDESK_HTTP_FILES_TTL` (30 Minuten)                | Uploads werden nach bestätigtem Anhängen freigegeben. Ein Link liefert höchstens 5 Downloads. Ein Neustart macht beide ungültig. |

Jedes Token ist mit Schlüsseln versiegelt, die aus `SEVDESK_HTTP_SECRET` abgeleitet sind. Das
vorige Refresh-Token funktioniert nach einer Erneuerung noch 30 Sekunden (Clients erneuern
manchmal zweimal gleichzeitig); danach gilt seine Vorlage als gestohlenes Token und widerruft den
Zugang. Bei jeder Erneuerung fragt der Server außerdem bei sevDesk, ob das sevDesk-Token noch
funktioniert: Eine 401 (das Token wurde neu erzeugt oder sein Benutzer entfernt) oder ein Token
eines anderen Kontos widerruft den Zugang. Ist sevDesk nicht erreichbar, gelingt die Erneuerung
trotzdem: Das neue Access-Token ist ohne funktionierendes sevDesk-Token ohnehin nutzlos.

### Eine Instanz

MCP-Anfragen werden zustandslos bearbeitet, aber betreibe **genau eine Instanz**, auch im
Bearer-Modus. Zugänge, Browser-Sitzungen, ausstehende Freigaben, Uploads und Download-Links, die
Einmal-Nonces der Bestätigungen und die Ratenbegrenzungen leben im Prozess und seinem
Zustandsverzeichnis, und eine zweite Instanz auf demselben Zustandsverzeichnis startet nicht.
Mehrere Instanzen bräuchten eine gemeinsame Datenbank, die dieses Projekt bewusst vermeidet
([ADR 0006](adr/0006-built-in-authorization-server-and-grant-store.de.md)). Eine Instanz bedient
ein kleines Team problemlos: Der Engpass ist das Tempo von sevDesk selbst (`SEVDESK_RATE_LIMIT`, je
Konto).

## Schnellstart: Bearer-Modus mit Docker

Für einen ersten Versuch auf deinem eigenen Rechner:

```bash
# 1. Ein zufälliges Client-Geheimnis (43 Zeichen).
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret

# 2. Die Einstellungen, in einer Datei, die nur du lesen kannst (außerhalb jedes Repositorys).
umask 077
cat > ~/sevdesk-mcp.env <<'EOF'
SEVDESK_HTTP_AUTH=bearer
SEVDESK_HTTP_PUBLIC_URL=http://localhost:8080
SEVDESK_HTTP_BEARER_TOKEN=<the secret from step 1>
SEVDESK_API_TOKEN=<your sevDesk API token>
EOF

# 3. Starten, nur von diesem Rechner aus erreichbar.
docker run --rm --read-only -p 127.0.0.1:8080:8080 --env-file ~/sevdesk-mcp.env \
  -v sevdesk-mcp-data:/data ghcr.io/jaylann/mcp-server-sevdesk:latest
```

Der Server schreibt den MCP-Endpunkt, den er bereitstellt, nach stderr. Verbinde einen Client mit
`http://localhost:8080/mcp` und dem Header `Authorization: Bearer <the secret>`
([Clients verbinden](#clients-verbinden)).

Das Image lauscht im Container auf `0.0.0.0`, und ein Lauschen außerhalb von Loopback braucht die
URL, die Clients verwenden (`SEVDESK_HTTP_PUBLIC_URL`; einfaches `http` ist für `localhost`
erlaubt). Verwende `localhost` auch im Client: Andere Hostnamen werden abgelehnt, sofern sie nicht
in `SEVDESK_HTTP_ALLOWED_HOSTS` stehen. Behalte das `127.0.0.1:` in `-p`: Auf allen Schnittstellen
veröffentlicht, nähme der Port Anfragen über einfaches http aus deinem Netz an, wo das Geheimnis
unverschlüsselt übertragen wird und jeder Rechner `Host: localhost` senden kann (der Start warnt
vor einer öffentlichen Loopback-URL bei einem Server, der auf allen Schnittstellen lauscht).

> [!WARNING]
> Einfaches http auf `localhost` ist nur für einen kurzen Test gedacht. Browser trennen Cookies
> nicht nach Port, daher geht das Sitzungs-Cookie der Seiten des Servers (Dateiübertragung,
> Freigabe-Postfach) auch an jeden anderen Webserver, den der Browser auf `localhost` erreicht;
> dieser könnte dann deine Dateien abrufen, in deinem Namen hochladen oder über deine Freigaben
> entscheiden. Verwende https (eine [Bereitstellung](remote/deployment.de.md)) oder zumindest ein
> Browserprofil, das du für nichts anderes nutzt.

Für alles, was länger als ein Test läuft, lege eine Version (`:<version>`) oder einen Digest statt
`latest` fest und übergib Geheimnisse als Dateien (`SEVDESK_HTTP_BEARER_TOKEN_FILE`,
`SEVDESK_API_TOKEN_FILE`) statt als Umgebungswerte, die `docker inspect` anzeigt.

## Schnellstart: OAuth mit einem benutzerdefinierten Connector in claude.ai

claude.ai verbindet sich von den Servern von Anthropic aus, nicht aus deinem Browser; der Server
braucht daher eine öffentliche https-URL.

1. **Wähle, wo er läuft** ([Bereitstellung](remote/deployment.de.md)): eine Domain hinter Caddy,
   Fly.io, Render oder Railway. Für einen kurzen Test geht auch ein Tunnel:
   `cloudflared tunnel --url http://localhost:8080` gibt eine `https://….trycloudflare.com`-URL
   aus.
2. **Erzeuge das Server-Geheimnis** mit `generate-secret`. Es schützt jede Verbindung: Bewahre es
   wie ein Passwort auf, im Secret-Speicher deiner Plattform oder in einer Datei.
3. **Ermittle deine Konto-ID**:
   `docker run --rm -e SEVDESK_API_TOKEN ghcr.io/jaylann/mcp-server-sevdesk:latest account-id`
   (`-e NAME` ohne Wert reicht die exportierte Variable weiter, ohne sie auf die Kommandozeile zu
   schreiben).
4. **Konfiguriere den Server**:

   ```bash
   SEVDESK_HTTP_AUTH=oauth
   SEVDESK_HTTP_PUBLIC_URL=https://mcp.example.com
   SEVDESK_HTTP_SECRET_FILE=/run/secrets/sevdesk_http_secret
   SEVDESK_OAUTH_ACCOUNTS=<your account id>
   # Ein Reverse Proxy vor dem Server.
   SEVDESK_HTTP_TRUST_PROXY=1
   # Das Höchste, was eine Verbindung bekommen darf.
   SEVDESK_ALLOW=read,write,commit
   # Freigaben im Postfach: claude.ai kann im Chat nicht fragen.
   SEVDESK_CONFIRM=browser
   SEVDESK_AUDIT_LOG=/data/audit.jsonl
   ```

   Es gibt kein `SEVDESK_API_TOKEN`: Im OAuth-Modus bringt jeder Benutzer sein eigenes auf der
   Zustimmungsseite mit. Jede Variable ist in der [Konfiguration](remote/configuration.de.md)
   beschrieben.

5. **Füge den Connector in claude.ai hinzu**: Einstellungen → Connectors → Benutzerdefinierten
   Connector hinzufügen, mit der URL `https://mcp.example.com/mcp`. claude.ai öffnet die
   Zustimmungsseite deines Servers:
   - Prüfe, dass der Client `claude.ai` ist und dass die Seite dich zu `claude.ai` zurückleitet;
   - hake die Stufen an, die diese Verbindung nutzen darf (`read` ist immer enthalten);
   - füge dein sevDesk-API-Token ein; der Server prüft es bei sevDesk und gegen
     `SEVDESK_OAUTH_ACCOUNTS` und zeigt dann das Konto, zu dem es gehört (nie wieder das Token);
   - bestätige dieses Konto. Du bist zurück in claude.ai, und dieser Browser ist jetzt für
     12 Stunden an den eigenen Seiten des Servers angemeldet: den
     [Upload- und Download-Seiten](remote/files.de.md) (standardmäßig an) und, mit
     `SEVDESK_CONFIRM=browser`, dem [Freigabe-Postfach](remote/approvals.de.md).

## Clients verbinden

Der MCP-Endpunkt ist immer `<public URL>/mcp`, zum Beispiel `https://mcp.example.com/mcp`. Im
Bearer-Modus funktioniert jeder Client, der Streamable HTTP spricht und den Header `Authorization`
senden kann; im OAuth-Modus muss der Host der `client_id`-URL des Clients in
`SEVDESK_OAUTH_CLIENTS` stehen. Die Einrichtung jedes Clients, lokal und entfernt, steht unter
[Clients](clients.de.md).

## Weiterlesen

- [Bereitstellung](remote/deployment.de.md): das Image, Compose mit Caddy, Fly.io, Render, Railway.
- [Konfiguration](remote/configuration.de.md): jede HTTP-Variable, Abbrüche und Warnungen beim
  Start.
- [Freigabe-Postfach](remote/approvals.de.md): Aufrufe der Stufen `commit` und `external` im
  Browser bestätigen.
- [Dateien](remote/files.de.md): Upload-Seiten für Belege und E-Rechnungen und Download-Links.
- [Den Server betreiben](remote/operations.de.md): Befehle, Widerruf, Geheimnis wechseln, Logs,
  Grenzen.
- [Fehlersuche](remote/troubleshooting.de.md): Probleme mit Verbindung, Proxy, Uploads und
  Zustimmung.

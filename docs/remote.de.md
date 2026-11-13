<!-- translated-from: docs/remote.md sha256:24e0dac351b9 -->

# Fernzugriff (HTTP)

Mit `--http` spricht der Server MCP über Streamable HTTP statt über stdio. Dann können ihn auch
Clients nutzen, die keinen lokalen Prozess starten können: benutzerdefinierte Connectoren in
claude.ai (und die Claude-Apps, die mit demselben Konto angemeldet sind), Claude Code, Cursor oder
VS Code auf einem anderen Rechner oder ein kleines Team, das sich einen Server teilt. Eine gehostete
Instanz gibt es nicht: Sie betreiben den Server selbst, auf Ihrem eigenen Rechner, einer VM oder
einer Plattform wie Fly.io. Für eine Person an einem Rechner bleibt stdio die einfachere Wahl.

Diese Seite ist die Anleitung für den Betrieb. Der Entwurf steht in
[architecture.md](architecture.md#transports) und in den ADRs
[0006](adr/0006-built-in-authorization-server-and-grant-store.md),
[0007](adr/0007-approval-inbox-over-http.md) und [0008](adr/0008-file-transfer-over-http.md); das
Bedrohungsmodell in [SECURITY.de.md](../SECURITY.de.md#fernzugriff).

## Konzepte

### Bearer oder OAuth

`SEVDESK_HTTP_AUTH` wählt einen von zwei Modi. Ohne die Variable startet `--http` nicht.

|                            | `bearer`                                                    | `oauth`                                                                                     |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Wer das sevDesk-Token hält | der Server (`SEVDESK_API_TOKEN`)                            | der Client jedes Benutzers, verschlüsselt in den Tokens, die der Server ihm ausgestellt hat |
| Konten                     | eines                                                       | jedes Konto in `SEVDESK_OAUTH_ACCOUNTS`                                                     |
| Was ein Client sendet      | ein gemeinsames Geheimnis: `Authorization: Bearer <secret>` | OAuth-2.1-Access-Tokens, nach einer Zustimmungsseite im Browser                             |
| Stufen                     | `SEVDESK_ALLOW`                                             | je Verbindung auf der Zustimmungsseite gewählt, höchstens `SEVDESK_ALLOW`                   |
| Clients                    | alles, was einen Header senden kann                         | Clients mit Client ID Metadata Documents: claude.ai, Claude Code                            |
| Zugriff entziehen          | das Geheimnis ändern                                        | je Verbindung, je Konto oder alles (`grants revoke`)                                        |

**`bearer`** ist der einfache Modus: Ein gemeinsames Geheimnis (`SEVDESK_HTTP_BEARER_TOKEN`)
schützt ein sevDesk-Konto. Verwenden Sie ihn in einem privaten Netz, hinter einer anderen
Zugangskontrolle oder für Clients, die Sie selbst einrichten. Wer das Geheimnis hat, kann die
Stufen des Servers für dieses Konto nutzen; behandeln Sie es also wie das sevDesk-Token.

**`oauth`** macht den Server zu seinem eigenen OAuth-2.1-Autorisierungsserver. Ein Client, der sich
verbindet, wird auf eine Zustimmungsseite auf Ihrem Server geleitet. Dort wählt der Benutzer die
Stufen für diese Verbindung und fügt sein sevDesk-API-Token einmal ein. Der Server prüft das Token
bei sevDesk, verschlüsselt es (AES-256-GCM) in den Autorisierungscode und in die Access- und
Refresh-Tokens, die er dem Client gibt, und behält nur einen Vermerk, dass die Verbindung besteht:
einen _Zugang_ (Grant). Benutzerdefinierte Connectoren in claude.ai brauchen diesen Modus.

Clients weisen sich mit einem Client ID Metadata Document (CIMD) aus: Ihre `client_id` ist eine
https-URL, die ihren Namen und ihre Redirect-URIs liefert. Dynamic Client Registration wird nicht
angeboten; ein Client, der nur die Registrierung unterstützt, kann den OAuth-Modus also nicht
nutzen. Verwenden Sie für ihn den Bearer-Modus.

### Standardmäßig nur für Ihre Konten

Im OAuth-Modus können sich nur die sevDesk-Konten in `SEVDESK_OAUTH_ACCOUNTS` verbinden. Ihre
Konto-ID finden Sie mit [`account-id`](#befehle); ein abgelehnter Benutzer sieht seine eigene
Konto-ID auf der Zustimmungsseite. `SEVDESK_OAUTH_ACCOUNTS=any` lässt jeden mit einem
sevDesk-Token Ihren Server nutzen, und der Start protokolliert eine Warnung: Sie würden dann die
Buchhaltungsdaten anderer Leute verarbeiten (siehe [PRIVACY.de.md](../PRIVACY.de.md)).

Auch Clients sind beschränkt. `SEVDESK_OAUTH_CLIENTS` führt die Hosts auf, die das
Metadaten-Dokument eines Clients liefern dürfen (Standard `claude.ai`). Der Server prüft das, bevor
er etwas abruft. Ohne diese Liste könnte ein Angreifer sein eigenes Metadaten-Dokument
bereitstellen und Ihnen einen Link auf Ihre eigene Zustimmungsseite schicken, der echt aussieht
(Consent-Phishing).

Beide Listen gelten für jede Anfrage und jede Erneuerung, nicht nur bei der Zustimmung. Entfernen
Sie ein Konto oder einen Client-Host und starten neu, werden dessen bestehende Zugänge bei der
nächsten Nutzung widerrufen (fügen Sie den Eintrag später wieder hinzu, stellt das sie nicht wieder
her; der Benutzer verbindet sich erneut), und die Browser-Sitzungen eines entfernten Kontos enden.

### Stufen je Zugang

Jede OAuth-Verbindung hat ihre eigenen Stufen. Die Zustimmungsseite gewährt immer `read` und bietet
für jede weitere Stufe, die `SEVDESK_ALLOW` aktiviert, ein Kästchen an, alle nicht angehakt; einem
Client, der bestimmte `sevdesk:<tier>`-Scopes anfragt, werden nur diese angeboten. Eine Anfrage
bekommt die Stufen des Zugangs, die `SEVDESK_ALLOW` noch aktiviert (nur `read` mit
`SEVDESK_READ_ONLY=1`), und das Modell sieht nur die Werkzeuge dieser Stufen. Ein engeres
`SEVDESK_ALLOW` gilt sofort für alle Zugänge; ein weiteres erweitert bestehende Zugänge nicht: Der
Benutzer verbindet sich neu und hakt die neue Stufe an.

Im Bearer-Modus sind die Stufen `SEVDESK_ALLOW`, wie über stdio.

### Was der Server speichert und was nie

| Wo                                                         | Was                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grants.jsonl` in `SEVDESK_HTTP_STATE_DIR` (oder Speicher) | Je Zugang (OAuth): eine zufällige ID, die sevDesk-Konto-ID, die `client_id`-URL des Clients und ihr Host, die Stufen, Zeitstempel (angelegt, Ablauf, letzte Rotation, widerrufen), der Status, die Generation des Refresh-Tokens und der Grund eines Widerrufs. Je Browser-Sitzung (die Anmeldung des Freigabe-Postfachs und der Seiten zum Hoch- und Herunterladen): eine zufällige ID, die Konto-ID, der Zugang, aus dem sie stammt, und wie sie geöffnet wurde. Nur angehängt, Modus 0600, beim Start und von Zeit zu Zeit im laufenden Betrieb verdichtet. Auch der Bearer-Modus hält seine Browser-Sitzungen hier, sobald das Postfach oder die Dateiübertragung aktiv ist. |
| `grants.lock` im Zustandsverzeichnis                       | Kennzeichnet die laufende Instanz (ein Lebenszeichen alle 10 Sekunden).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `files/` im Zustandsverzeichnis (oder Speicher)            | Hochgeladene Dateien und die Dateien hinter Download-Links, solange sie gültig sind ([Dateien](#dateien-hochladen-und-herunterladen)): verschlüsselt mit AES-256-GCM unter einem Schlüssel, der beim Start des Prozesses zufällig erzeugt und nirgends gespeichert wird, unter zufälligen Namen (Ordner 0700, Dateien 0600). Gelöscht nach bestätigtem Anhängen, beim Ablauf und beim Herunterfahren; der Ordner wird bei jedem Start geleert, sodass nichts den Prozess überdauert.                                                                                                                                                                                             |
| `SEVDESK_AUDIT_LOG`, falls gesetzt                         | Jeder schreibende Aufruf jedes Kontos, mit Konto und Zugang, sowie jeder empfangene Upload, jeder angelegte Download-Link und jeder Download (Referenz, Art, Größe und SHA-256, kein Name und kein Inhalt). Siehe [SECURITY.de.md](../SECURITY.de.md#audit-log).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Nur im Speicher (beim Neustart verloren)                   | Ausstehende Freigaben, ausstehende Bestätigungen (ihre Einmal-Nonces), Upload-Seiten und Download-Links (Eigentümer, Referenz, Zweck, der bereinigte Dateiname, Größe, SHA-256, Ablauf, verbleibende Downloads), zwischengespeicherte Metadaten-Dokumente von Clients, Caches je Konto und Zähler der Ratenbegrenzung.                                                                                                                                                                                                                                                                                                                                                           |

**Nie gespeichert**, weder in Dateien noch in Logs: sevDesk-API-Tokens, Autorisierungscodes,
Access- und Refresh-Tokens, Cookies, das Server-Geheimnis, die Bearer-Geheimnisse und der Schlüssel
der verschlüsselten Dateien. Die Geheimnisse kommen nur aus der Umgebung. Upload- und Download-IDs
erscheinen nie in einem Log, und das Log des Servers (stderr) enthält keine Dateinamen. Das
Audit-Log kann einen enthalten: Die Vorschau, die es bei einem Probelauf oder einer angefragten
Bestätigung festhält, enthält die Fakten des Aufrufs (Kundennamen, Beträge), und bei einem
Belegentwurf mit Belegdatei gehört dazu der bereinigte Name der hochgeladenen Datei, mit ihrer
Größe und dem Anfang ihres SHA-256. Im Bearer-Modus mit `SEVDESK_FILE_DIRS` wird ein als `file`
übergebener Pfad mit den übrigen Argumenten protokolliert.

### Tokens und Laufzeiten

| Was                               | Laufzeit                                             | Hinweise                                                                                                                         |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Autorisierungscode                | 60 Sekunden                                          | Einmal verwendbar. Ein zweiter Austausch widerruft den Zugang.                                                                   |
| Access-Token                      | `SEVDESK_OAUTH_ACCESS_TTL` (1 Stunde)                | Nur gültig für `<public URL>/mcp`. Jede Anfrage wird gegen den Zugangsspeicher geprüft.                                          |
| Refresh-Token                     | `SEVDESK_OAUTH_REFRESH_IDLE_TTL` (14 Tage ungenutzt) | Bei jeder Nutzung ersetzt; nie länger gültig als der Zugang.                                                                     |
| Zugang                            | `SEVDESK_OAUTH_GRANT_TTL` (90 Tage ab Zustimmung)    | Danach stimmt der Benutzer erneut zu.                                                                                            |
| Cookie der Browser-Sitzung        | 12 Stunden                                           | Freigabe-Postfach, Seiten zum Hoch- und Herunterladen. Enthält kein sevDesk-Token. Endet mit seinem Zugang.                      |
| Upload-Seite                      | 15 Minuten                                           | Nimmt eine Datei an.                                                                                                             |
| Hochgeladene Datei, Download-Link | `SEVDESK_HTTP_FILES_TTL` (30 Minuten)                | Uploads werden nach bestätigtem Anhängen freigegeben. Ein Link liefert höchstens 5 Downloads. Ein Neustart macht beide ungültig. |

Jedes Token ist mit Schlüsseln verschlüsselt, die aus `SEVDESK_HTTP_SECRET` abgeleitet sind. Jede
Erneuerung liefert ein neues Refresh-Token. Das vorige funktioniert noch 30 Sekunden, weil Clients
manchmal zweimal gleichzeitig erneuern; danach gilt seine Vorlage als gestohlenes Token und widerruft
den Zugang. Bei jeder Erneuerung fragt der Server außerdem bei sevDesk, ob das sevDesk-Token noch
funktioniert: Antwortet sevDesk mit 401 (das Token wurde neu erzeugt oder sein Benutzer entfernt)
oder gehört das Token jetzt zu einem anderen Konto, wird der Zugang widerrufen. Ist sevDesk nicht
erreichbar, gelingt die Erneuerung trotzdem: Das neue Access-Token ist ohne funktionierendes
sevDesk-Token ohnehin nutzlos.

### Eine Instanz

MCP-Anfragen werden zustandslos bearbeitet, aber betreiben Sie **genau eine Instanz**. Zugänge,
Browser-Sitzungen, ausstehende Freigaben, Uploads und Download-Links, die Einmal-Nonces der
Bestätigungen und die Ratenbegrenzungen leben im Prozess und seinem Zustandsverzeichnis, und eine
zweite Instanz auf demselben Zustandsverzeichnis startet nicht. Das gilt auch im Bearer-Modus,
sobald Browser-Seiten aktiv sind (die Dateiübertragung ist standardmäßig an). Mehrere Instanzen
bräuchten eine gemeinsame Datenbank, die dieses Projekt bewusst vermeidet
([ADR 0006](adr/0006-built-in-authorization-server-and-grant-store.md)). Eine Instanz bedient ein
kleines Team problemlos: Der Engpass ist das Tempo von sevDesk selbst (`SEVDESK_RATE_LIMIT`, je
Konto).

## Schnellstart: Bearer-Modus mit Docker

Für einen ersten Versuch auf Ihrem eigenen Rechner:

```bash
# 1. Ein zufälliges Client-Geheimnis (43 Zeichen).
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret

# 2. Die Einstellungen, in einer Datei, die nur Sie lesen können (außerhalb jedes Repositorys).
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

Der Server schreibt den MCP-Endpunkt, den er bereitstellt, nach stderr. Verbinden Sie einen Client
mit `http://localhost:8080/mcp` und dem Header `Authorization: Bearer <the secret>`
([Clients verbinden](#clients-verbinden)).

Warum hier `SEVDESK_HTTP_PUBLIC_URL`: Das Image lauscht im Container auf `0.0.0.0`, und ein
Lauschen außerhalb von Loopback braucht die URL, die Clients verwenden. Einfaches `http` ist
erlaubt, weil der Host `localhost` ist. Verwenden Sie `localhost` auch im Client: Andere Hostnamen
werden abgelehnt, sofern sie nicht in `SEVDESK_HTTP_ALLOWED_HOSTS` stehen. Behalten Sie das
`127.0.0.1:` in `-p`: Auf allen Schnittstellen veröffentlicht, nähme der Port Anfragen über
einfaches http aus Ihrem Netz an, wo das Geheimnis unverschlüsselt übertragen wird und jeder
Rechner `Host: localhost` senden kann. Der Start warnt genau vor dieser Kombination (ein Server,
der auf allen Schnittstellen lauscht, mit einer öffentlichen Loopback-URL); ist der Port nur auf
`127.0.0.1` veröffentlicht, trifft die Warnung nicht zu.

Einfaches http auf `localhost` ist nur für einen kurzen Test gedacht. Browser trennen Cookies
nicht nach Port, daher geht das Cookie der Browser-Sitzung (der Seiten zum Hoch- und Herunterladen,
standardmäßig an, und mit `SEVDESK_CONFIRM=browser` des Freigabe-Postfachs) auch an jeden anderen
Webserver, den der Browser auf `localhost` erreicht; dieser könnte dann Ihre Dateien abrufen, in
Ihrem Namen hochladen oder Ihre Freigaben lesen und entscheiden. Der Start warnt davor, solange die
Dateiübertragung aktiv ist. Verwenden Sie https (eine der Bereitstellungen unten) oder zumindest
ein Browserprofil, das Sie für nichts anderes nutzen.

Für alles, was länger als ein Test läuft, legen Sie eine Version (`:<version>`) oder einen Digest
statt `latest` fest und übergeben Geheimnisse als Dateien (`SEVDESK_HTTP_BEARER_TOKEN_FILE`,
`SEVDESK_API_TOKEN_FILE`) statt als Umgebungswerte, die `docker inspect` anzeigt.

## Schnellstart: OAuth mit einem benutzerdefinierten Connector in claude.ai

claude.ai verbindet sich von den Servern von Anthropic aus, nicht aus Ihrem Browser; der Server
braucht daher eine öffentliche https-URL.

1. **Wählen Sie, wo er läuft** ([Bereitstellung](#bereitstellung)): eine Domain hinter Caddy,
   Fly.io, Render oder Railway. Für einen kurzen Test geht auch ein Tunnel:
   `cloudflared tunnel --url http://localhost:8080` gibt eine `https://….trycloudflare.com`-URL
   aus.
2. **Erzeugen Sie das Server-Geheimnis** mit `generate-secret`. Es schützt jede Verbindung:
   Bewahren Sie es wie ein Passwort auf, im Secret-Speicher Ihrer Plattform oder in einer Datei.
3. **Ermitteln Sie Ihre Konto-ID**:
   `docker run --rm -e SEVDESK_API_TOKEN ghcr.io/jaylann/mcp-server-sevdesk:latest account-id`
   (mit `SEVDESK_API_TOKEN` in Ihrer Shell exportiert; `-e NAME` ohne Wert reicht die Variable
   weiter, ohne sie auf die Kommandozeile zu schreiben).
4. **Konfigurieren Sie den Server**:

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
   Zustimmungsseite mit.

5. **Fügen Sie den Connector in claude.ai hinzu**: Einstellungen → Connectors → Benutzerdefinierten
   Connector hinzufügen, mit der URL `https://mcp.example.com/mcp`. claude.ai öffnet die
   Zustimmungsseite Ihres Servers:
   - Prüfen Sie, dass der Client `claude.ai` ist und dass die Seite Sie zu `claude.ai` zurückleitet;
   - haken Sie die Stufen an, die diese Verbindung nutzen darf (`read` ist immer enthalten);
   - fügen Sie Ihr sevDesk-API-Token ein; der Server prüft es bei sevDesk und gegen
     `SEVDESK_OAUTH_ACCOUNTS` und zeigt dann das Konto, zu dem es gehört (nie wieder das Token);
   - bestätigen Sie dieses Konto. Sie sind zurück in claude.ai, und dieser Browser ist jetzt für
     12 Stunden an den eigenen Seiten des Servers angemeldet: den
     [Seiten zum Hoch- und Herunterladen](#dateien-hochladen-und-herunterladen) (standardmäßig an)
     und, mit `SEVDESK_CONFIRM=browser`, dem [Freigabe-Postfach](#das-freigabe-postfach).

## Bereitstellung

Das Image ist `ghcr.io/jaylann/mcp-server-sevdesk`, für amd64 und arm64, mit den Tags `<version>`,
`<major>.<minor>` und `latest`. Es läuft als uid 65532 auf einer distroless-Basis mit Node.js (ohne
Shell), startet `--http`, lauscht auf `0.0.0.0:8080`, hält seinen Zustand im Volume `/data`
(`SEVDESK_HTTP_STATE_DIR=/data`) und hat eine Zustandsprüfung, die den Befehl `healthcheck`
ausführt. Sein Root-Dateisystem kann schreibgeschützt sein: Nur `/data` wird beschrieben. Jeder
andere Befehl ersetzt `--http`, zum Beispiel `docker run --rm <image> generate-secret`.

Die Vorlagen unten betreiben das Image im OAuth-Modus, als eine Instanz mit einem Volume unter
`/data`, `SEVDESK_CONFIRM=browser`, dem Audit-Log in `/data/audit.jsonl` und `SEVDESK_ALLOW=read`:
Erhöhen Sie `SEVDESK_ALLOW` auf das Höchste, was eine Verbindung bekommen soll. release-please
aktualisiert ihren Image-Tag mit jedem Release. Jede Bereitstellung braucht mindestens
`SEVDESK_HTTP_PUBLIC_URL` und entweder `SEVDESK_HTTP_SECRET` plus `SEVDESK_OAUTH_ACCOUNTS` (OAuth)
oder `SEVDESK_HTTP_BEARER_TOKEN` plus `SEVDESK_API_TOKEN` (Bearer).

### Docker Compose mit Caddy (`deploy/compose/`)

Für eine VM oder einen Heimserver mit Domainnamen.
[`deploy/compose/compose.yaml`](../deploy/compose/compose.yaml) startet zwei Dienste:

- **`mcp`**, der Server: schreibgeschütztes Root-Dateisystem, alle Linux-Capabilities entzogen,
  `no-new-privileges`, Grenzen für Speicher und Prozesse, das Server-Geheimnis aus einer Datei über
  Compose-Secrets (`SEVDESK_HTTP_SECRET_FILE`), ein benanntes Volume unter `/data` und kein Port,
  der auf dem Host veröffentlicht ist;
- **`caddy`** (per Digest festgelegt): holt und erneuert das TLS-Zertifikat für Ihre Domain,
  behält den `Host`-Header bei, setzt `X-Forwarded-For` und gibt gestreamte Antworten sofort weiter
  (`flush_interval -1`). Er schreibt bewusst kein Access-Log: OAuth-Redirect-URLs enthalten
  Autorisierungscodes.

Richten Sie das DNS der Domain auf den Rechner und öffnen Sie die Ports 80 und 443. Dann, in
`deploy/compose/`:

```bash
cp .env.example .env      # SEVDESK_DOMAIN, SEVDESK_OAUTH_ACCOUNTS, SEVDESK_ALLOW
install -d -m 0700 secrets
docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret > secrets/http_secret
sudo chown 65532:65532 secrets/http_secret && sudo chmod 0400 secrets/http_secret
docker compose up -d
```

Compose bindet eine Secret-Datei so ein, wie sie auf dem Host liegt; sie muss daher für uid 65532
lesbar sein (das `chown`). `secrets/` ist in Git ignoriert. Caddy ist der eine Proxy davor, daher
setzt die Vorlage `SEVDESK_HTTP_TRUST_PROXY=1`. Für den Bearer-Modus folgen Sie den
auskommentierten Zeilen in `compose.yaml`. Die Betriebsbefehle führen Sie in einem einmaligen
Container desselben Dienstes aus, zum Beispiel `docker compose run --rm mcp grants list`.

### Fly.io (`deploy/fly/fly.toml`)

[`deploy/fly/fly.toml`](../deploy/fly/fly.toml) betreibt eine Machine in Frankfurt mit einem
1-GB-Volume (`sevdesk_data`) unter `/data`. Fly terminiert TLS und erzwingt https; die Machine
pausiert im Leerlauf (`auto_stop_machines = "suspend"`, das ihren Speicher behält) und startet bei
der nächsten Anfrage.

```bash
fly apps create <app>
# In fly.toml: `app`, SEVDESK_HTTP_PUBLIC_URL (https://<app>.fly.dev oder Ihre Domain) und
# SEVDESK_OAUTH_ACCOUNTS setzen.
fly secrets set --app <app> --stage \
  SEVDESK_HTTP_SECRET="$(docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret)"
fly deploy --config deploy/fly/fly.toml --ha=false
```

Bleiben Sie bei einer Machine (`--ha=false`): Eine zweite hätte ihr eigenes Volume und ihre
eigenen Zugänge. Der Fly-Proxy ist ein Hop (`SEVDESK_HTTP_TRUST_PROXY=1`).

### Render (`deploy/render/render.yaml`)

[`deploy/render/render.yaml`](../deploy/render/render.yaml) ist ein Blueprint: ein Webdienst aus
dem Image in Frankfurt, mit einer 1-GB-Disk unter `/data` und `/healthz` als Zustandsprüfung. Wählen
Sie im Render-Dashboard New → Blueprint, dieses Repository (oder Ihren Fork) und als
Blueprint-Pfad `deploy/render/render.yaml`. Render erzeugt `SEVDESK_HTTP_SECRET` selbst
(`generateValue`, nie in der Datei sichtbar) und fragt beim Anlegen nach `SEVDESK_HTTP_PUBLIC_URL`
(`https://<service>.onrender.com` oder Ihre Domain) und `SEVDESK_OAUTH_ACCOUNTS`. Eine Disk braucht
einen kostenpflichtigen Instanztyp und hält den Dienst bei einer Instanz. Die Vorlage setzt
`PORT=8080`, den Port, an den Render weiterleitet.

### Railway

Railway liest `railway.json` für neue Dienste nicht mehr (seine Konfiguration als Code ist
abgekündigt und wird ab dem 2026-12-01 nicht mehr gelesen). Legen Sie den Dienst im Dashboard aus
dem Image an, oder beschreiben Sie ihn in einer Railway-Datei für Infrastructure as Code
(`.railway/railway.ts`) in Ihrem eigenen Projekt: [`deploy/README.md`](../deploy/README.md#railway)
enthält beides, mit einem Volume unter `/data`, `/healthz` als Zustandsprüfung und einer Replica.
Railway bindet Volumes mit root als Eigentümer ein, daher läuft der Dienst mit
`RAILWAY_RUN_UID=0`. Das Image lauscht auf Port 8080.

### Ein Tunnel, zum Testen

`cloudflared tunnel --url http://localhost:8080` gibt einem lokalen Server eine vorübergehende
öffentliche https-URL. Setzen Sie sie als `SEVDESK_HTTP_PUBLIC_URL` (Neustart, wenn sie sich ändert)
und `SEVDESK_HTTP_TRUST_PROXY=1`. Der Tunnelanbieter terminiert TLS und sieht den Verkehr,
einschließlich der Tokens; verwenden Sie ihn für Tests, nicht für Ihre Buchhaltung.

## Konfigurationsreferenz

Alle Variablen werden beim Start gelesen. Der Start meldet alle Probleme auf einmal und verweigert
sich, bis alle behoben sind. Variablen, die auf `_FILE` enden, lesen den Wert stattdessen aus einer
Datei (Docker- und Kubernetes-Secrets); setzen Sie die eine oder die andere.

### HTTP-Variablen

| Variable                                 | Standard                              | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_HTTP_AUTH`                      | (Pflicht)                             | `bearer` oder `oauth`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SEVDESK_HTTP_HOST`                      | `127.0.0.1` (Image: `0.0.0.0`)        | Adresse, auf der der Server lauscht. Alles außer einer Loopback-Adresse braucht `SEVDESK_HTTP_PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SEVDESK_HTTP_PORT`                      | `$PORT`, sonst `8080` (Image: `8080`) | Port, 0–65535 (0 wählt einen freien Port, für Tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_PUBLIC_URL`                |                                       | Der Origin, den Clients verwenden, zum Beispiel `https://mcp.example.com`: nur Schema, Host und Port, ohne Pfad, Query, Fragment oder Zugangsdaten. https, außer der Host ist `localhost`, `127.0.0.1` oder `[::1]`. Pflicht für OAuth und wenn der Server nicht nur auf Loopback lauscht. Der MCP-Endpunkt (und die OAuth-Ressource) ist `<origin>/mcp`, der OAuth-Issuer ist der Origin. Jede URL, die der Server ausgibt oder auf die er weiterleitet, wird daraus gebaut, nie aus Headern der Anfrage.                   |
| `SEVDESK_HTTP_ALLOWED_HOSTS`             |                                       | Weitere Hostnamen, die im `Host`-Header angenommen werden, durch Kommas getrennt. Der Host der öffentlichen URL wird immer angenommen (bei Loopback ohne öffentliche URL die Loopback-Namen).                                                                                                                                                                                                                                                                                                                                |
| `SEVDESK_HTTP_ALLOWED_ORIGINS`           |                                       | Weitere Werte, die im `Origin`-Header von `/mcp`-Anfragen angenommen werden, durch Kommas getrennt; die Prüfung vergleicht nur Hostnamen (beliebiges Schema, beliebiger Port). Der öffentliche Origin wird immer angenommen, und Anfragen ohne `Origin` passieren. `/mcp` sendet keine CORS-Header und beantwortet kein Preflight (`OPTIONS`); MCP-Clients, die in einer Webseite auf einem anderen Origin laufen, werden also nicht unterstützt: Das lässt nur Clients zu, die selbst einen solchen `Origin`-Header senden. |
| `SEVDESK_HTTP_TRUST_PROXY`               | `0`                                   | Reverse Proxys vor dem Server, 0–5. Die Client-IP (Ratenbegrenzung, Logs) ist der Eintrag, der so viele Stellen von rechts in `X-Forwarded-For` steht.                                                                                                                                                                                                                                                                                                                                                                       |
| `SEVDESK_HTTP_BEARER_TOKEN` (`_FILE`)    |                                       | Bearer-Modus, Pflicht: das Client-Geheimnis, oder zwei durch Komma getrennte Geheimnisse während eines Wechsels. Jedes mindestens 32 Zeichen mit mindestens 16 verschiedenen, ohne Leerraum und nicht das sevDesk-Token.                                                                                                                                                                                                                                                                                                     |
| `SEVDESK_HTTP_SECRET` (`_FILE`)          |                                       | OAuth, Pflicht: das Server-Geheimnis, mit dem alle Tokens und Cookies verschlüsselt werden; mindestens 32 zufällige Bytes, hex oder base64/base64url (`generate-secret`). Optional im Bearer-Modus, wo es Browser-Anmeldungen über einen Neustart hinweg gültig hält.                                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_SECRET_PREVIOUS` (`_FILE`) |                                       | Das vorige Server-Geheimnis, während Sie [es wechseln](#das-server-geheimnis-wechseln): Damit verschlüsselte Tokens werden weiter angenommen und bei der Erneuerung neu verschlüsselt.                                                                                                                                                                                                                                                                                                                                       |
| `SEVDESK_HTTP_STATE_DIR`                 | Speicher (Image: `/data`)             | Absolutes Verzeichnis für den Zugangsspeicher und die verschlüsselten Dateien der Dateiübertragung (`files/`); angelegt mit Modus 0700 (ein bestehendes wird auf 0700 verschärft) und beim Start auf Schreibrechte geprüft. Ohne die Variable enden Zugänge und Browser-Sitzungen mit dem Prozess (der OAuth-Start warnt), und Dateien werden im Speicher gehalten.                                                                                                                                                          |
| `SEVDESK_HTTP_FILES`                     | `on`                                  | [Dateiübertragung](#dateien-hochladen-und-herunterladen): Upload-Seiten für Belege und E-Rechnungen und Download-Links für die Dateien, die Werkzeuge erzeugen. `on`/`off`, `1`/`0`, `true`/`false` oder `yes`/`no`. Aus: keine Seiten und kein `sevdesk_upload_request`; im OAuth-Modus außerdem kein Werkzeug, das eine Datei zum Lesen oder einen Ort zum Speichern braucht. Die PDF- und XML-Werkzeuge und die `sevdesk://`-Ressourcen bleiben: Ein Client liest Dokumentdateien weiterhin über MCP.                     |
| `SEVDESK_HTTP_FILES_MAX_MB`              | 256 mit Zustandsverzeichnis, sonst 64 | Mebibyte (MiB), die die hochgeladenen Dateien und Download-Links aller Konten zusammen belegen dürfen, 32 bis 4096. Ein Konto darf ein Viertel davon nutzen (mindestens 20 MiB, höchstens die Hälfte); Platz für einen Upload bleibt für Konten frei, die noch keine Dateien halten. Mit Zustandsverzeichnis liegen die Dateien auf der Festplatte, sonst im Speicher.                                                                                                                                                       |
| `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`     | `10`                                  | Gültige Upload-Seiten, hochgeladene Dateien und Download-Links zusammen je sevDesk-Konto, eine ganze Zahl von 1 bis 1000. Die separaten Grenzen von 5 wartenden Seiten und insgesamt 1.000 Einträgen gelten weiterhin; die Byte-Grenzen bleiben unverändert.                                                                                                                                                                                                                                                                 |
| `SEVDESK_HTTP_FILES_TTL`                 | `30m`                                 | Maximale Gültigkeit einer hochgeladenen Datei und eines Download-Links, 5 Minuten bis 24 Stunden. Erfolgreich angehängte Uploads werden früher freigegeben.                                                                                                                                                                                                                                                                                                                                                                  |
| `SEVDESK_OAUTH_ACCOUNTS`                 |                                       | OAuth, Pflicht: die sevDesk-Konto-IDs, die sich verbinden dürfen, durch Kommas getrennt, oder `any` (der Start warnt).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SEVDESK_OAUTH_CLIENTS`                  | `claude.ai`                           | Hosts, die das Metadaten-Dokument eines Clients (seine `client_id`-URL) liefern dürfen, durch Kommas getrennt, oder `any` (der Start warnt).                                                                                                                                                                                                                                                                                                                                                                                 |
| `SEVDESK_OAUTH_ACCESS_TTL`               | `1h`                                  | Laufzeit des Access-Tokens, 5 Minuten bis 24 Stunden. Unter 10 Minuten warnt der Start: Claude erneuert 5 Minuten vor Ablauf und würde dann bei fast jeder Anfrage erneuern.                                                                                                                                                                                                                                                                                                                                                 |
| `SEVDESK_OAUTH_REFRESH_IDLE_TTL`         | `14d`                                 | Ein Refresh-Token, das so lange ungenutzt bleibt, läuft ab; 1 bis 90 Tage.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SEVDESK_OAUTH_GRANT_TTL`                | `90d`                                 | Laufzeit eines Zugangs ab der Zustimmung; 1 bis 365 Tage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Dauern schreiben Sie als ganze Zahl mit der Einheit `s`, `m`, `h` oder `d` (`90s`, `30m`, `1h`,
`14d`) oder als bloße Anzahl Sekunden.

### Andere Variablen im HTTP-Modus

Die [Variablen des stdio-Modus](configuration.de.md#variablen) behalten ihre Bedeutung, mit diesen
Unterschieden:

- **`SEVDESK_API_TOKEN` (`_FILE`)**: Pflicht im Bearer-Modus; dort ist es das Konto, das der Server
  bedient, und das Token, mit dem sich ein Browser an den Seiten des Servers anmeldet
  (Freigabe-Postfach, Hoch- und Herunterladen). Im OAuth-Modus nicht verwendet (der Start warnt,
  wenn es gesetzt ist): Jeder Benutzer fügt sein eigenes Token auf der Zustimmungsseite ein.
- **`SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH`**: abgelehnt. Der
  Schlüsselbund des Betriebssystems und lokale Profile sind für lokale Installationen über stdio;
  ein Container hat keinen Schlüsselbund.
- **`SEVDESK_ALLOW`, `SEVDESK_READ_ONLY`**: das Höchste, was eine Verbindung bekommen darf. Im
  OAuth-Modus bekommt jeder Zugang die Schnittmenge mit den Stufen, die auf der Zustimmungsseite
  angehakt wurden.
- **`SEVDESK_CONFIRM`**: `elicit` (der Standard) funktioniert mit Clients, die das Protokoll
  2026-07-28 sprechen und Formular-Elicitation unterstützen. Clients aus der Zeit von 2025 können
  über zustandsloses HTTP nicht gefragt werden; dazu gehört zum Zeitpunkt des Schreibens auch
  claude.ai. Der Start warnt daher, wenn `elicit` mit der Stufe `commit` oder `external`
  kombiniert ist. `browser` nutzt das [Freigabe-Postfach](#das-freigabe-postfach) des Servers.
- **`SEVDESK_CONFIRM_OPEN`**: im HTTP-Modus aus, sofern nicht ausdrücklich gesetzt, und dort ohne
  Wirkung: Freigaben warten im Postfach, das Sie selbst öffnen. `1` zusammen mit einem Lauschen
  außerhalb von Loopback wird abgelehnt.
- **`SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR`**: im OAuth-Modus abgelehnt, weil sich alle
  Verbindungen die Festplatte des Servers teilen würden. Dateien erreichen die Werkzeuge
  stattdessen über [Upload-Seiten und Download-Links](#dateien-hochladen-und-herunterladen)
  (`SEVDESK_HTTP_FILES`, standardmäßig an). Der Bearer-Modus behält sie; die Ordner liegen auf dem
  Server, nicht auf dem Rechner des Clients. Dort kann ein Dateiargument ein Pfad in
  `SEVDESK_FILE_DIRS` oder ein Upload sein, und `SEVDESK_OUTPUT_DIR` hat, wenn gesetzt, Vorrang vor
  Download-Links: Dateien werden dann auf dem Server gespeichert.
- **`SEVDESK_AUDIT_LOG`**: ein Log für alle Konten; jede Zeile nennt das Konto und den Zugang. Es
  hält außerdem jeden empfangenen Upload, jeden angelegten Download-Link und jeden Download fest. Im
  Image ist das Root-Dateisystem schreibgeschützt; legen Sie es also unter `/data` ab.
- **`SEVDESK_RATE_LIMIT`**: gilt je sevDesk-Konto, geteilt von allen seinen Verbindungen.

### Abbrüche und Warnungen beim Start

Der Start verweigert sich unter anderem bei:

- `--http` ohne `SEVDESK_HTTP_AUTH`;
- Bearer-Modus ohne gültiges Bearer-Geheimnis oder ohne sevDesk-Token;
- OAuth ohne `SEVDESK_HTTP_SECRET`, `SEVDESK_HTTP_PUBLIC_URL` oder `SEVDESK_OAUTH_ACCOUNTS` oder
  mit einem Geheimnis, das zu kurz oder nicht zufällig genug ist;
- einem Lauschen außerhalb von Loopback ohne öffentliche URL oder einer öffentlichen
  `http://`-URL, deren Host nicht Loopback ist;
- OAuth zusammen mit `SEVDESK_FILE_DIRS` oder `SEVDESK_OUTPUT_DIR` (die Meldung verweist auf die
  Upload-Seiten und Download-Links);
- `SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE` oder `SEVDESK_PROFILES_PATH` (nur stdio);
- `SEVDESK_HTTP_FILES` mit einem Wert, der kein Schalterwert ist (siehe Tabelle),
  `SEVDESK_HTTP_FILES_MAX_MB` außerhalb von 32–4096, `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`,
  das keine ganze Zahl von 1 bis 1000 ist, oder `SEVDESK_HTTP_FILES_TTL` außerhalb von
  5 Minuten bis 24 Stunden;
- `SEVDESK_CONFIRM_OPEN=1` bei einem Lauschen außerhalb von Loopback;
- einem Zustandsverzeichnis, das nicht beschreibbar ist, einer beschädigten `grants.jsonl`, einem
  Zustandsverzeichnis, das eine andere laufende Instanz nutzt, oder einem Ordner `files/` darin,
  der sich nicht leeren lässt;
- jedem anderen Wert außerhalb dessen, was die Tabellen oben erlauben, etwa einer Variablen, die
  zusammen mit ihrer `_FILE`-Variante gesetzt ist, `SEVDESK_HTTP_SECRET_PREVIOUS` ohne
  `SEVDESK_HTTP_SECRET`, mehr als zwei Bearer-Geheimnissen, einem relativen Zustandsverzeichnis,
  einer OAuth-Lebensdauer außerhalb ihres Bereichs, einem ungültigen Host- oder Origin-Eintrag oder
  `any` gemischt mit IDs oder Hosts.

Der Start warnt (und startet) bei `SEVDESK_CONFIRM=elicit` mit der Stufe `commit` oder `external`,
`SEVDESK_OAUTH_ACCOUNTS=any` (mit aktiver Dateiübertragung auch, weil der Server dann kurzzeitig
die Belege und Exporte jedes verbundenen Kontos hält und einige Konten zusammen seinen Platz für
Dateien füllen können), `SEVDESK_OAUTH_CLIENTS=any`, OAuth ohne Zustandsverzeichnis, `SEVDESK_API_TOKEN` oder einem Bearer-Geheimnis im OAuth-Modus, einem Server-
oder Bearer-Geheimnis, das eher wie eine Passphrase als wie zufällige Bytes aussieht (verwenden Sie
`generate-secret`), einem Lauschen außerhalb von Loopback mit einer öffentlichen Loopback-URL (jeder,
der den Port erreicht, kann den Server nutzen; siehe den
[Docker-Schnellstart](#schnellstart-bearer-modus-mit-docker)), Dateiübertragung über einfaches
http (das Cookie der Browser-Sitzung erreicht jeden Server unter diesem Hostnamen),
Dateiübertragung ohne Zustandsverzeichnis (Dateien werden im Speicher gehalten, bis zu
`SEVDESK_HTTP_FILES_MAX_MB`) sowie `SEVDESK_HTTP_FILES_MAX_MB`,
`SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` oder `SEVDESK_HTTP_FILES_TTL`
zusammen mit `SEVDESK_HTTP_FILES=off` (sie haben dann keine Wirkung).

## Clients verbinden

Der MCP-Endpunkt ist immer `<public URL>/mcp`, zum Beispiel `https://mcp.example.com/mcp`.

### claude.ai, Claude Desktop und die mobilen Apps (OAuth)

Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen, mit der URL
`https://<host>/mcp`. claude.ai öffnet die Zustimmungsseite
([Schnellstart](#schnellstart-oauth-mit-einem-benutzerdefinierten-connector-in-claudeai)). Der
Connector steht dann in den Claude-Apps zur Verfügung, die mit demselben Konto angemeldet sind.
Entfernen Sie den Connector in claude.ai, verwirft claude.ai seine Tokens;
[den Zugang zu widerrufen](#zugriff-entziehen) beendet ihn auch auf dem Server.

### Claude Code

Mit OAuth:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp
```

Führen Sie dann `/mcp` in Claude Code aus und wählen Sie die Authentifizierung: Die
Zustimmungsseite öffnet sich in Ihrem Browser und leitet Sie zu Claude Code zurück. Claude Code
weist sich mit einem eigenen Metadaten-Dokument aus, das wie das von claude.ai unter `claude.ai`
liegt (der Standardwert von `SEVDESK_OAUTH_CLIENTS` deckt es also ab), und mit einer
Loopback-Weiterleitung, auf die die Zustimmungsseite hinweist.

Mit einem Bearer-Geheimnis (lesen Sie es aus einer Datei oder Ihrem Passwortmanager, statt es
einzutippen):

```bash
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"
```

### Cursor (Bearer)

In `~/.cursor/mcp.json` (oder `.cursor/mcp.json` in einem Projekt):

```json
{
  "mcpServers": {
    "sevdesk": {
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_BEARER_SECRET}" }
    }
  }
}
```

### VS Code (Bearer)

In `.vscode/mcp.json`, mit einer Passwortabfrage, damit das Geheimnis nicht in der Datei steht:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sevdesk-mcp-bearer",
      "description": "Bearer secret of your sevDesk MCP server",
      "password": true
    }
  ],
  "servers": {
    "sevdesk": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer ${input:sevdesk-mcp-bearer}" }
    }
  }
}
```

### Andere Clients

Jeder Client, der Streamable HTTP spricht und einen Header senden kann, funktioniert im
Bearer-Modus. Im OAuth-Modus braucht ein Client Client ID Metadata Documents; nehmen Sie den Host
seiner `client_id`-URL in `SEVDESK_OAUTH_CLIENTS` auf.

## Das Freigabe-Postfach

Mit `SEVDESK_CONFIRM=browser` warten Aufrufe der Stufen `commit` und `external` auf eine
Entscheidung im Freigabe-Postfach des Servers unter `<public URL>/approvals`. Es ersetzt die lokale
Freigabeseite des stdio-Modus, die ein entfernter Server nicht in Ihrem Browser öffnen kann.

So läuft eine Bestätigung ab:

1. Das Modell ruft etwa das Werkzeug auf, das eine Rechnung fertigstellt. Der Server bereitet den
   Aufruf vor und antwortet mit `approval_pending`, einem kurzen Referenzcode, dem Ablauf
   (10 Minuten) und der URL des Postfachs.
2. Sie öffnen das Postfach, suchen die Anfrage mit diesem Referenzcode und lesen die Vorschau: die
   Aktion, Warnungen, Beträge, Empfänger, Texte. In einem deutschen Browser sind das Postfach
   und die Vorschau deutsch ([Berechtigungen](permissions.de.md#browser)).
3. Sie drücken „Freigeben“ oder „Ablehnen“ (in einem englischen Browser „Approve“ oder
   „Reject“).
4. Sie bitten das Modell, es erneut zu versuchen. Es ruft das Werkzeug mit denselben Argumenten
   auf; der Server bereitet die Aktion noch einmal vor und führt sie nur aus, wenn Sie freigegeben
   haben und die Vorschau unverändert ist. Jede Freigabe wird einmal verwendet.

**Anmelden.** Das Postfach zeigt nichts außer einem Anmeldeformular, bis der Browser nachweist,
dass er für das Konto handeln darf:

- **nach der OAuth-Zustimmung** automatisch: Die Zustimmungsseite meldet den Browser an, der sie
  abgeschlossen hat (sobald das Postfach oder die
  [Dateiübertragung](#dateien-hochladen-und-herunterladen) aktiv ist; dieselbe Sitzung öffnet
  beides);
- **durch Einfügen des sevDesk-API-Tokens** in das Anmeldeformular. Im OAuth-Modus prüft der Server
  das Token bei sevDesk und gegen `SEVDESK_OAUTH_ACCOUNTS`. Im Bearer-Modus muss es das eigene
  `SEVDESK_API_TOKEN` des Servers sein; das Bearer-Geheimnis meldet nicht an, weil der Client es
  hält.

Eine Anmeldung gilt 12 Stunden oder bis Sie sich abmelden, der Zugang, aus dem sie stammt,
widerrufen wird oder `grants revoke --account <id>` alle Sitzungen des Kontos beendet. Eine
Anmeldung mit eingefügtem Token ist nicht an dieses Token gebunden: Wird das Token in sevDesk neu
erzeugt, endet sie nicht. Anmeldeversuche sind je Client-Adresse begrenzt, IPv6-Adressen je
/64-Netz gezählt (5 pro Minute, 20 pro Stunde). Setzen Sie im Bearer-Modus zusätzlich
`SEVDESK_HTTP_SECRET`, wenn Anmeldungen einen Neustart überdauern sollen.

**Was das Modell sieht.** Den Referenzcode, den Ablauf und die URL des Postfachs. Die URL ist
nicht geheim: Ohne Anmeldung zeigt sie nur das Formular. Das Modell sieht nie die eigene ID einer
Freigabe, ein Cookie oder irgendetwas, das freigeben könnte.

**Wer was sieht.** Freigaben gehören der Verbindung, die gefragt hat: Ein erneuter Versuch findet
nur Freigaben, die sein eigener Zugang angelegt hat. Das Postfach listet die Freigaben des ganzen
Kontos auf; jeder, der an diesem Konto angemeldet ist, sieht sie also und kann über sie
entscheiden. Höchstens fünf Freigaben je Konto warten gleichzeitig, und die Anfragen eines Kontos
können die Freigaben eines anderen Kontos nicht aus dem Speicher des Servers verdrängen.

**Grenzen.** Ein Agent, der Ihren Browser steuern kann, während er angemeldet ist
(Browser-Automatisierung, ein Werkzeug zur Computersteuerung), könnte selbst freigeben. Und das
Postfach fragt nach Ihrem sevDesk-Token; eine nachgeahmte Seite könnte also versuchen, es
abzugreifen: Fügen Sie es nur in eine Seite ein, deren Adresse `/approvals` Ihres Servers ist. Bei
einer Einrichtung mit einfachem http auf `localhost` erhalten auch andere lokale Webserver das
Sitzungs-Cookie ([Schnellstart](#schnellstart-bearer-modus-mit-docker)). Ausstehende Freigaben
enden, wenn der Server neu startet; das Modell fragt dann einfach erneut. Siehe
[ADR 0007](adr/0007-approval-inbox-over-http.md).

## Dateien: Hochladen und Herunterladen

Ein entfernter Server kann keine Dateien auf Ihrem Rechner lesen, und die Dateien, die er erzeugt,
gelangen nicht von selbst dorthin. Mit `SEVDESK_HTTP_FILES=on` (der Standard) wandern Dateien über
Seiten des Servers, die Sie in Ihrem Browser öffnen. Das Modell sieht und sendet nie den Inhalt
dieser Dateien. (Dokument-PDFs und -XML, die ein Client als `sevdesk://`-Ressource anfordert,
nehmen einen anderen Weg: Sie gehen per MCP an den Client.)

**Einen Beleg oder eine E-Rechnung hochladen:**

1. Das Modell ruft `sevdesk_upload_request` auf (Zweck `receipt` oder `einvoice`) und gibt Ihnen
   einen Link, `<public URL>/uploads/<id>`, mit einem kurzen Referenzcode und einem Ablauf.
2. Sie öffnen den Link. Die Seite zeigt nur, was der Server weiß: was sie annimmt, die größte
   Datei, bis wann sie gültig ist, das Konto und den Referenzcode. Das Modell kann keinen Text
   darauf setzen.
3. Sie wählen die Datei und drücken Upload. Der Server prüft den Dateityp am Inhalt, nicht am
   Namen, und behält einen bereinigten Namen (Buchstaben, Ziffern, `.`, `_`, `-`; Umlaute
   ausgeschrieben; höchstens 100 Zeichen; die Endung aus dem Inhalt).
4. Sie sagen dem Modell, dass der Upload erledigt ist. Es übergibt die erhaltene `uploadId`
   (`upload:<id>`) als `file` an `sevdesk_voucher_create_draft`, `sevdesk_voucher_update_draft`,
   `sevdesk_einvoice_parse` oder `sevdesk_voucher_import_einvoice`. Nur die Verbindung, die den
   Upload angefordert hat, kann ihn nutzen. Sobald das Erstellen, Ändern oder Importieren gelingt
   und das Zurücklesen aus sevDesk einen Anhang bestätigt, gibt der Server den Upload frei und
   löscht seine gespeicherte Datei; der Platz ist sofort wieder verfügbar. Das Auslesen einer
   E-Rechnung, Probeläufe und fehlgeschlagene Aufrufe behalten den Upload bis zum Ablauf für
   einen weiteren Versuch. Auch bei fehlendem oder unklarem Anhang im zurückgelesenen Beleg
   bleibt er erhalten. Beim Ändern muss sich die Anhang-ID gegenüber dem unmittelbar vor dem
   Speichern geprüften Stand ändern (oder erstmals ein Anhang vorliegen, wenn vorher ausdrücklich
   keiner vorhanden war). Bei gleicher ID oder unbekanntem vorherigem Anhang bleibt der Upload
   bis zum Ablauf verfügbar. Um eine erfolgreich angehängte Datei nach der Freigabe ihres
   Uploads erneut zu verwenden, fordern Sie einen neuen Upload an.

Bei Upload-Anfragen für mehrere Dateien ist jedes Formular an die darin angezeigten freien
Plätze gebunden. Das erneute Absenden eines veralteten Formulars belegt keine weiteren Plätze:
Die Seite zeigt den aktuellen Stand und fordert Sie auf, nur die noch fehlenden Dateien erneut
auszuwählen. Nach einem erfolgreichen Upload führt eine Weiterleitung zur Fortschrittsseite;
deren Aktualisierung sendet keine Dateien erneut.

**Herunterladen.** `sevdesk_document_save`, `sevdesk_voucher_receipt_save`, `sevdesk_csv_export`
und `sevdesk_datev_export` geben statt eines Dateipfads einen Download-Link zurück, `<public URL>/files/<id>`. Der Server hat die
Datei während des Werkzeugaufrufs von sevDesk geholt; das Öffnen des Links sendet nichts an
sevDesk. Der Browser speichert die Datei als Download; sie wird nie auf der Seite des Servers
angezeigt.

**Was eine Browser-Sitzung braucht.** Jede Upload-Seite und jeder Download-Link. Die Links sind
nicht geheim: Ohne Sitzung zeigen sie nur das Anmeldeformular, und ein Link eines anderen Kontos
sieht genauso aus wie einer, den es nicht gibt. Die Sitzung ist die des
[Freigabe-Postfachs](#das-freigabe-postfach):

- Der Browser, der die OAuth-Zustimmung abgeschlossen hat, ist 12 Stunden angemeldet, auch wenn
  das Postfach aus ist;
- jeder andere Browser meldet sich im Formular mit dem sevDesk-API-Token des Kontos an
  (OAuth-Modus: bei sevDesk und gegen `SEVDESK_OAUTH_ACCOUNTS` geprüft; Bearer-Modus: das
  `SEVDESK_API_TOKEN` des Servers, nie das Bearer-Geheimnis) und landet wieder auf der Seite, von
  der er kam.

Das Formular sendet an `/approvals/login`, auch wenn das Freigabe-Postfach aus ist. An einem Konto
angemeldet, sieht ein Browser die Upload-Seiten und Links aller Verbindungen dieses Kontos; die
Werkzeuge verwenden nur die Uploads ihrer eigenen Verbindung.

**Auf dem Telefon.** Die Claude-Apps öffnen einen Link unter Umständen in einem Browser, der die
Cookies desjenigen nicht teilt, in dem Sie zugestimmt haben: Sie sehen dann das Anmeldeformular.
Melden Sie sich dort mit dem sevDesk-API-Token an oder öffnen Sie den Link in dem Browser, in dem
Sie zugestimmt haben.

**Grenzen und Laufzeiten:**

| Was                      | Grenze                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload-Seite             | 15 Minuten gültig, nimmt eine Datei an.                                                                                                                                                                                                           |
| Angenommene Dateien      | Belege: PDF, PNG oder JPEG. E-Rechnungen: XML (XRechnung) oder PDF (ZUGFeRD, Factur-X). Am Inhalt geprüft.                                                                                                                                        |
| Ein Upload               | 20 MiB, oder die Hälfte von `SEVDESK_HTTP_FILES_MAX_MB`, falls das weniger ist.                                                                                                                                                                   |
| Hochgeladene Datei, Link | Höchstens `SEVDESK_HTTP_FILES_TTL` (30 Minuten) gültig; Uploads werden nach bestätigtem Anhängen freigegeben. Ein Link liefert höchstens 5 Downloads.                                                                                             |
| Je Konto                 | 5 Upload-Seiten, die auf eine Datei warten; `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` gültige Seiten, Uploads und Links zusammen (Standard 10, Bereich 1–1000); ein Viertel von `SEVDESK_HTTP_FILES_MAX_MB` (mindestens 20 MiB, höchstens die Hälfte). |
| Alle Konten              | `SEVDESK_HTTP_FILES_MAX_MB` (256 MiB mit Zustandsverzeichnis, 64 MiB ohne), 1.000 Uploads und Links. Platz für einen Upload bleibt für Konten frei, die noch keine Dateien halten.                                                                |
| Anfragen je Client       | 60 pro Minute an die Upload- und Download-Seiten zusammen; 10 Uploads pro Minute und 60 pro Stunde (IPv6 je /64-Netz).                                                                                                                            |
| Gleichzeitige Uploads    | 2 für den ganzen Server, 1 je Konto; ein weiterer bekommt „Server busy“ oder „Upload in progress“ (503): Versuchen Sie es gleich noch einmal.                                                                                                     |
| Upload-Tempo             | Die Datei muss innerhalb von 90 Sekunden eintreffen, ohne 10 Sekunden Pause und nach den ersten 10 Sekunden mit durchschnittlich mindestens 16 KB/s; sonst 408.                                                                                   |
| Download-Tempo           | Der Browser muss die Datei laufend abnehmen: Ein Download, von dem er in einer Minute weniger als 64 KiB abnimmt, wird abgebrochen und zählt trotzdem als einer der 5 des Links.                                                                  |
| Ein Neustart             | Macht jede Upload-Seite, jeden Upload und jeden Link ungültig. Das Modell fordert einen neuen an.                                                                                                                                                 |

Nichts wird verdrängt, um Platz zu schaffen: Ist eine Grenze erreicht, werden neue Uploads und
Links abgelehnt, bis ältere ablaufen oder freigegeben werden. Bei einer erreichten Anzahlgrenze
nennt die Meldung den frühesten bekannten Ablaufzeitpunkt des anfragenden Kontos, niemals Zeiten
anderer Konten. Noch laufende Speichervorgänge haben keinen festen Ablaufzeitpunkt; wenn keiner
bekannt ist, sagt die Meldung das. Für mehr gleichzeitige Einträge erhöhen Sie
`SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`; die Byte-Grenzen ändern sich dadurch nicht.
Download-Links zählen gegen denselben Platz wie Uploads; ein
großer DATEV-Export passt daher unter Umständen nicht (mit 64 MiB im Speicher hat ein Konto 20 MiB).
Das Werkzeug sagt dann, dass sevDesk den Export gestartet hat, und Sie laden ihn stattdessen in
sevDesk herunter; oder Sie erhöhen `SEVDESK_HTTP_FILES_MAX_MB`, am besten mit einem
Zustandsverzeichnis, damit die Dateien auf die Festplatte gehen.

**Speicher.** Ohne Zustandsverzeichnis werden Dateien im Speicher gehalten. Während ein Upload
eintrifft, liegt er etwa dreifach im Speicher; deshalb werden höchstens zwei gleichzeitig
angenommen. Auf einem kleinen Rechner (512 MB) behalten Sie ein Zustandsverzeichnis und die
Standardgrenzen bei.

**Reverse Proxys.** Der Body eines Uploads ist bis zu 20 MiB groß plus etwas Formular-Overhead, muss
innerhalb von 90 Sekunden ohne 10 Sekunden Pause eintreffen und `Content-Length` tragen; ein Upload
in Chunks ohne diesen Header wird mit 411 abgelehnt. nginx braucht `client_max_body_size 25m;` (sein Standard von 1 MB
lehnt die meisten Belege ab), und seine standardmäßige Pufferung von Anfragen sendet
`Content-Length`. Caddy, wie in der Compose-Vorlage, braucht nichts.

**Abschalten.** `SEVDESK_HTTP_FILES=off` entfernt `sevdesk_upload_request` und die Seiten. Im
OAuth-Modus werden dann die Werkzeuge nicht angeboten, die eine Datei zum Lesen oder einen Ort
zum Speichern brauchen (`sevdesk_einvoice_parse`, `sevdesk_voucher_import_einvoice`,
`sevdesk_document_save`, `sevdesk_voucher_receipt_save`, `sevdesk_csv_export`,
`sevdesk_datev_export`), und das Argument `file` der Belegentwurf-Werkzeuge wird abgelehnt; der
Bearer-Modus nutzt weiterhin `SEVDESK_FILE_DIRS` und `SEVDESK_OUTPUT_DIR`, wenn sie gesetzt sind.
Die PDF- und XML-Werkzeuge und die `sevdesk://`-Ressourcen sind nicht betroffen: Ein Client liest
Dokumentdateien über sie per MCP.

**Grenzen des Entwurfs.** Ein Agent, der Ihren angemeldeten Browser steuern kann, könnte selbst
hoch- oder herunterladen, so wie er im Postfach freigeben könnte. Eine heruntergeladene Datei ist
das, was sevDesk geliefert hat; öffnen Sie sie wie jedes Dokument aus Ihrer Buchhaltung. Bei einer
Einrichtung mit einfachem http auf `localhost` erhalten auch andere lokale Webserver das
Sitzungs-Cookie. Siehe [ADR 0008](adr/0008-file-transfer-over-http.md).

## Den Server betreiben

### Befehle

Das Programm hat außer dem Bereitstellen einige Befehle. Mit Docker hängen Sie sie an
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
entziehen Sie den Zugriff, indem Sie das Server-Geheimnis oder das sevDesk-Token ersetzen
([Zugriff entziehen](#zugriff-entziehen)).

### Zugriff entziehen

| Um zu beenden                   | Tun Sie                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eine Verbindung                 | `grants revoke <grant-id>`. Ihre nächste Anfrage bekommt 401, und der Client bittet um eine neue Verbindung. Clients, die den Widerruf von Tokens unterstützen (RFC 7009, `/revoke`), tun dasselbe, wenn Sie sie trennen.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Alle Verbindungen eines Kontos  | `grants revoke --account <id>`. Das beendet auch jede Browser-Sitzung des Kontos, einschließlich Anmeldungen mit eingefügtem Token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Alles                           | `grants revoke --all` (jeder Zugang und jede Browser-Sitzung, auch Anmeldungen mit einem Token), oder ersetzen Sie `SEVDESK_HTTP_SECRET`, ohne das alte als `_PREVIOUS` zu behalten: Kein zuvor ausgestelltes Token lässt sich dann noch öffnen.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Zugriff mit einem sevDesk-Token | Erzeugen Sie das Token in sevDesk neu (Einstellungen → Benutzer → API-Token). sevDesk lehnt das alte sofort ab, Werkzeugaufrufe funktionieren also nicht mehr, und die nächste Erneuerung jedes Zugangs, der es hält (innerhalb der Laufzeit des Access-Tokens), widerruft diesen Zugang. Das wirkt auch, wenn das Server-Geheimnis oder die Tokens eines Clients nach außen gelangt sind. Browser-Sitzungen sind nicht an das Token gebunden: Eine Anmeldung mit dem alten Token bleibt bis zu 12 Stunden gültig und eine Sitzung aus einer Zustimmung, bis ihr Zugang widerrufen wird. Führen Sie zusätzlich `grants revoke --account <id>` aus, um sie sofort zu beenden. |
| Bearer-Zugriff                  | Ersetzen Sie `SEVDESK_HTTP_BEARER_TOKEN` und starten Sie neu. Browser-Anmeldungen überdauern einen Neustart, wenn `SEVDESK_HTTP_SECRET` und das Zustandsverzeichnis erhalten bleiben; `grants revoke --account <id>` beendet sie (die ID ist die, die der Server beim Start protokolliert hat, oder `bearer`, falls diese Abfrage fehlschlug).                                                                                                                                                                                                                                                                                                                               |

Uploads und Download-Links werden nicht mit einem Zugang widerrufen: Das Ende einer Sitzung sperrt
den Browser, der sie hielt, und die Dateien laufen innerhalb von `SEVDESK_HTTP_FILES_TTL` ab. Ein
Neustart macht sie alle auf einmal ungültig.

### Das Server-Geheimnis wechseln

1. Erzeugen Sie mit `generate-secret` ein neues Geheimnis.
2. Setzen Sie es als `SEVDESK_HTTP_SECRET`, verschieben Sie das alte nach
   `SEVDESK_HTTP_SECRET_PREVIOUS` und starten Sie neu. Mit dem alten Geheimnis verschlüsselte Tokens
   werden weiter angenommen; ihre Erneuerung verschlüsselt die neuen mit dem neuen Geheimnis.
3. Behalten Sie `_PREVIOUS` so lange wie die Leerlaufzeit der Erneuerung
   (`SEVDESK_OAUTH_REFRESH_IDLE_TTL`, standardmäßig 14 Tage), entfernen Sie es dann und starten Sie
   neu. Ein Client, der in dieser Zeit nicht erneuert hat, verbindet sich neu.

Wenn das Geheimnis nach außen gelangt sein könnte, überspringen Sie die Wartezeit aus Schritt 3:
Ersetzen Sie es ohne `_PREVIOUS`. Jeder Client verbindet sich neu. Wenn auch Tokens nach außen
gelangt sein könnten (das Geheimnis öffnet sie und das sevDesk-Token darin), erzeugen Sie außerdem
die sevDesk-Tokens neu und führen für jedes Konto `grants revoke --account <id>` aus, was auch seine
Browser-Sitzungen beendet.

Bearer-Geheimnisse wechseln Sie genauso: Setzen Sie `SEVDESK_HTTP_BEARER_TOKEN=<new>,<old>`,
aktualisieren Sie die Clients und entfernen Sie dann den alten Wert.

### Logs

Der Server schreibt nach stderr: beim Start den MCP-Endpunkt, den er bereitstellt, dann ein
JSON-Objekt pro Anfrage mit der Route (als Vorlage, nicht der vollständige Pfad), dem Status, der
Dauer, der Client-IP und den ersten 8 Zeichen der Zugangs-ID. Header, Bodys, Cookies und
Query-Strings werden nie protokolliert, und jede Zeile wird vom sevDesk-Token, den Bearer- und
Server-Geheimnissen, allem, was wie ein verschlüsseltes Token aussieht (`sdmcp_…`), und jeder Folge
von 32 oder mehr Hex-Ziffern bereinigt (die Form eines sevDesk-Tokens, das der Server im
OAuth-Modus nicht im Voraus kennt). Sicherheitsereignisse werden als Warnungen mit Namen
protokolliert: `refresh_replay` und `code_replay` (ein Token wurde zweimal verwendet; der Zugang
wurde widerrufen), `account_refused` (Zustimmung mit einem Konto, das nicht auf der Liste steht),
`cimd_blocked` (ein Metadaten-Dokument eines Clients wurde abgelehnt) und `grant_revoked` (mit
seinem Grund, zum Beispiel `account_removed`, wenn eine Erlaubnisliste den Zugang nicht mehr
abdeckt).

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

### Zustandsprüfung und Herunterfahren

`GET /healthz` antwortet `{"status":"ok"}` ohne Authentifizierung und ohne Host-Prüfung, für die
Zustandsprüfungen von Plattformen. Bei SIGTERM antwortet der Server dort mit 503, gibt laufenden
Anfragen 10 Sekunden, löscht dann die Dateien der Uploads und Download-Links, schreibt den
Zugangsspeicher und gibt die Sperre frei.

## Fehlersuche

**claude.ai meldet, den Server nicht erreichen oder sich nicht verbinden zu können.** claude.ai
verbindet sich aus dem Internet; prüfen Sie also von außerhalb Ihres Netzes:

- `curl https://<host>/healthz` antwortet `{"status":"ok"}`;
- `curl https://<host>/.well-known/oauth-protected-resource/mcp` liefert JSON mit Ihrer
  öffentlichen URL;
- die URL des Connectors ist genau `SEVDESK_HTTP_PUBLIC_URL` plus `/mcp`;
- der Server läuft im OAuth-Modus (im Bearer-Modus antworten die Metadaten-Dokumente mit 404, und
  claude.ai kann sich nicht verbinden);
- das Zertifikat gilt für den Host, und nichts vor dem Server verlangt eine Anmeldung.

**Eine 401-Schleife: Die Zustimmung klappt, dann bittet claude.ai erneut um Verbindung.** Das
Access-Token gilt nur für `<public URL>/mcp`, ist mit dem aktuellen Geheimnis verschlüsselt und
wird gegen den Zugangsspeicher geprüft.

- Die URL des Connectors weicht von der öffentlichen URL ab (anderer Host, `http` statt `https`,
  ein abschließender Schrägstrich oder ein anderer Pfad): Korrigieren Sie die URL oder
  `SEVDESK_HTTP_PUBLIC_URL`.
- Das Geheimnis hat sich seit der Zustimmung geändert, oder zwei Instanzen mit verschiedenen
  Geheimnissen bedienen dieselbe URL.
- Das Zustandsverzeichnis ist nicht dauerhaft, ein Neustart hat die Zugänge also vergessen. Binden
  Sie dort ein Volume ein.
- Mehr als eine Instanz: Ein Zugang existiert nur im Speicher der Instanz, die ihn angelegt hat.

**Anfragen werden wegen `Host` oder `Origin` abgelehnt, hinter einem Proxy.** Der Server nimmt nur
den Host seiner öffentlichen URL an. Die meisten Proxys (Caddy, Fly, Render, Railway, cloudflared)
reichen den ursprünglichen `Host` weiter; sendet Ihrer einen eigenen (einen internen Namen wie
`localhost:8080`), stellen Sie ihn so ein, dass er den ursprünglichen Host weiterreicht, oder
nehmen Sie diesen Namen in `SEVDESK_HTTP_ALLOWED_HOSTS` auf. Ein Client, der einen anderen
`Origin`-Header als den öffentlichen Origin sendet, braucht ihn in `SEVDESK_HTTP_ALLOWED_ORIGINS`;
ein MCP-Client, der in einer Webseite auf einem anderen Origin läuft, kann gar nicht funktionieren,
weil `/mcp` kein CORS unterstützt. `/healthz` wird nie wegen seines Hosts abgelehnt. Beide
Ablehnungen antworten mit 403.

**Viele Antworten mit 429, oder jede Anfrage mit der IP des Proxys protokolliert.** Setzen Sie
hinter einem Proxy `SEVDESK_HTTP_TRUST_PROXY` auf die Anzahl der Proxys, die etwas an
`X-Forwarded-For` anhängen; sonst teilen sich alle Clients die Ratenbegrenzung der Adresse des
Proxys. Setzen Sie den Wert nie höher als die tatsächliche Anzahl: Clients könnten sonst ihre
eigene IP-Adresse wählen. Eine 429, deren Meldung das sevDesk-Konto nennt, ist eine andere Grenze:
Für dieses Konto laufen bereits 8 Anfragen an `/mcp`, gleich von welchen Adressen
([Grenzen](#grenzen)). Sie vergeht, sobald eine davon endet.

**Antworten hängen oder kommen alle auf einmal.** Ein Proxy puffert die gestreamten Antworten.
Schalten Sie die Pufferung für den Server ab: Caddy `flush_interval -1` (die Compose-Vorlage tut
das), nginx `proxy_buffering off`.

**Uploads scheitern hinter einem Proxy.** Die Upload-Seite antwortet mit den eigenen Worten des
Servers; alles andere kommt vom Proxy.

- „Size missing“ (411): Der Proxy hat den Upload ohne `Content-Length` weitergeleitet (in Chunks).
  Lassen Sie ihn das `Content-Length` des Browsers weiterreichen, oder lassen Sie ihn Request-Bodys
  puffern: nginx tut das standardmäßig (`proxy_request_buffering on`); Caddy reicht es unverändert
  weiter.
- Eine 413-Seite des Proxys, nicht das „File too large“ des Servers: Die Grenze des Proxys für den
  Body liegt unter der des Servers (etwas über 20 MiB). nginx: `client_max_body_size 25m;` (Standard
  1 MB). Caddy hat keine Grenze, sofern Sie keine setzen.
- Eine Zeitüberschreitung (408) bei großen Dateien über eine langsame Verbindung: Der Body muss
  innerhalb von 90 Sekunden eintreffen, mit durchschnittlich mindestens 16 KB/s und nie 10 Sekunden
  lang pausieren. Ein Proxy, der Anfragen puffert (nginx standardmäßig), reicht sie mit voller
  Geschwindigkeit weiter.

**Ein Link aus dem Chat zeigt das Anmeldeformular.** Der Browser hat keine Sitzung dieses Kontos:
Es ist nicht der Browser, in dem Sie zugestimmt haben (die Claude-Apps öffnen Links unter Umständen
in ihrem eigenen Browser), die 12 Stunden sind vorbei, Sie haben sich abgemeldet, oder er ist an
einem anderen Konto angemeldet. Melden Sie sich in diesem Formular mit dem sevDesk-API-Token des
Kontos an; es bringt Sie zur Seite zurück.

**„Upload page not found“ oder „File not found“.** Der Link ist unbekannt, gehört zu einem anderen
sevDesk-Konto, wurde bereits erfolgreich angehängt, oder der Server wurde inzwischen neu gestartet
(ein Neustart macht jeden Upload und jeden Link ungültig). „Expired“ und „used up“ bedeuten, was sie sagen. Bitten Sie das Modell um
einen neuen Upload-Link oder darum, die Datei erneut zu erzeugen.

**„No space for the file“ (507), oder das Modell meldet, dass die Grenze erreicht ist.** Die
Uploads und Links des Kontos füllen sein Viertel von `SEVDESK_HTTP_FILES_MAX_MB`, die Konten
zusammen füllen den Platz, oder das Konto hat `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` erreicht
(Standard 10). Erfolgreiches Anhängen gibt Uploads sofort frei. Bei einer erreichten Anzahlgrenze
warten Sie bis zum in der Meldung genannten Ablaufzeitpunkt des Kontos oder erhöhen diese
Einstellung; bei Platzmangel warten Sie auf den Ablauf von Dateien oder erhöhen
`SEVDESK_HTTP_FILES_MAX_MB`. „Server busy“ (503) heißt, dass gerade
zwei andere Uploads eintreffen, „Upload in progress“ (503), dass ein anderer Upload desselben
Kontos eintrifft; versuchen Sie es gleich noch einmal.

**Das Modell sagt, der Client könne nicht um Bestätigung gebeten werden.** Der Client hat über HTTP
keine Formular-Elicitation (claude.ai zum Zeitpunkt des Schreibens). Setzen Sie
`SEVDESK_CONFIRM=browser` und verwenden Sie das [Freigabe-Postfach](#das-freigabe-postfach).

**Die Zustimmungsseite lehnt das Konto oder den Client ab.** Sie nennt die Konto-ID oder den
Client-Host; nehmen Sie ihn in `SEVDESK_OAUTH_ACCOUNTS` oder `SEVDESK_OAUTH_CLIENTS` auf und
starten Sie neu, wenn Sie ihn zulassen wollen. Einen Eintrag zu entfernen und neu zu starten
widerruft auch die bestehenden Zugänge dieses Kontos oder Clients bei ihrer nächsten Nutzung und
beendet die Browser-Sitzungen des Kontos.

**Die Zustimmungsseite meldet zu viele Verbindungen.** Der Zugangsspeicher ist voll.
`grants list` zeigt die Zugänge; widerrufen Sie die, die niemand nutzt.

**Das Zustandsverzeichnis ist nicht beschreibbar.** Das Image läuft als uid 65532. Ein benanntes
Docker-Volume übernimmt seinen Eigentümer aus dem Image und funktioniert einfach. Ein Bind-Mount
braucht ein Verzeichnis, in das uid 65532 schreiben kann:
`sudo install -d -o 65532 -g 65532 -m 700 ./data`. Eine Plattform, die Volumes mit root als
Eigentümer einbindet, braucht ihre eigene Lösung: Railway dokumentiert `RAILWAY_RUN_UID=0`, das den
Container als root ausführt
([deploy/README.md](../deploy/README.md#volumes-and-the-container-user)). Ohne beschreibbares
Volume setzen Sie `SEVDESK_HTTP_STATE_DIR` auf einen leeren Wert: Der Zustand wird dann im
Speicher gehalten, und jeder Neustart meldet alle Clients ab.

**Der Start meldet, dass eine andere Instanz das Zustandsverzeichnis nutzt.** Nur ein laufender
Server darf es nutzen. Nach einem Absturz gilt die alte Sperre nach 30 Sekunden als veraltet, und
der nächste Start übernimmt sie. Laufen wirklich zwei (eine zweite Replica oder Machine),
reduzieren Sie auf eine. Ein laufender Server, der seine Sperre von einem anderen übernommen
findet, vertraut seinem Zugangsspeicher nicht mehr: OAuth-Anfragen scheitern mit einem
Serverfehler (Clients behalten ihre Tokens), und der Prozess beendet sich, sodass die Plattform ihn
neu startet.

## Das Image prüfen

Jedes Release-Image trägt eine Build-Provenance-Attestierung von GitHub Actions sowie die SBOM und
Provenance von BuildKit. So prüfen Sie, dass ein Image aus diesem Repository von seinem
Release-Workflow gebaut wurde:

```bash
gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann
```

SBOM und Provenance lesen:

```bash
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .Provenance }}'
```

Legen Sie dann den geprüften Digest (`ghcr.io/jaylann/mcp-server-sevdesk@sha256:…`) in Ihrer
Bereitstellung fest.

## Grenzen

- **Eine Instanz** je Zustandsverzeichnis; keine horizontale Skalierung
  ([Eine Instanz](#eine-instanz)).
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
  (`sevdesk_vat_summary`, `sevdesk_profit_and_loss`) hören nach 90 Sekunden auf zu lesen und
  geben zurück, was sie haben, als unvollständig markiert. Diese Zahlen sind fest.
- **JSON-RPC-Batches** (mehrere Nachrichten in einer Anfrage, nur von Clients der Protokollversion
  2025-03-26 gesendet) dürfen höchstens 8 Nachrichten enthalten und keine Anfrage-ID doppelt;
  sonst wird der ganze Batch mit 400 abgelehnt, und nichts davon läuft. Ein Batch zählt als eine
  Anfrage.
- **Freigaben** (`SEVDESK_CONFIRM=browser`): 5 wartende und 20 aufbewahrte je Konto, 100 für den
  ganzen Server. Hält der Server 100, kommt Platz von einem Konto, das mehr hält als das
  anfragende (zuerst dessen älteste abgelehnte oder wartende Anfrage, zuletzt eine erteilte,
  ungenutzte; zu diesem Aufruf wird dann erneut gefragt). Ein Konto verliert nie eine Anfrage an
  eines, das gleich viele oder mehr hält.
- **Keine Server-Ordner im OAuth-Modus.** `SEVDESK_FILE_DIRS` und `SEVDESK_OUTPUT_DIR` werden
  abgelehnt; Belege werden auf den Seiten des Servers hochgeladen und gespeicherte Dateien dort
  heruntergeladen, was eine Browser-Sitzung des Kontos braucht, und leben höchstens
  `SEVDESK_HTTP_FILES_TTL` ([Dateien](#dateien-hochladen-und-herunterladen)). Ein Upload ist
  höchstens 20 MiB groß. Das PDF einer Rechnung, einer Gutschrift oder eines Auftrags und das XML
  einer E-Rechnung erreichen den Client außerdem ohne den Browser, als MCP-Ressourcen
  (`sevdesk://…`), gleich wie `SEVDESK_HTTP_FILES` gesetzt ist.
- **Clients ohne Client ID Metadata Documents** können den OAuth-Modus nicht nutzen; für sie
  funktioniert der Bearer-Modus.
- **Keine gehostete Instanz.** Sie betreiben, was Sie bereitstellen.

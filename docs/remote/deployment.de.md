<!-- translated-from: docs/remote/deployment.md sha256:15ca2233026d -->

# Bereitstellung

So betreibst du den Server im [Fernzugriff](../remote.de.md) aus dem veröffentlichten Image: auf
deinem eigenen Host mit Docker Compose und Caddy, auf Fly.io, Render oder Railway oder für einen
Test hinter einem Tunnel. Lies zuerst die [Konzepte](../remote.de.md#konzepte); jede Variable, die
hier vorkommt, ist in der [Konfiguration](configuration.de.md) beschrieben.

## Das Image

Das Image ist `ghcr.io/jaylann/mcp-server-sevdesk`, für `linux/amd64` und `linux/arm64`, mit den
Tags `<version>` (die genaue Version), `<major>.<minor>` (die Minor-Linie, die mit jedem neuen
Patch-Release weiterrückt) und `latest` (nicht für Vorabversionen). Jedes Release trägt eine
Build-Provenance-Attestierung und eine SBOM ([Das Image prüfen](#das-image-prüfen)).

- Es läuft als uid 65532 auf einer distroless-Basis mit Node.js (ohne Shell), mit einem
  Root-Dateisystem, das schreibgeschützt sein kann: Nur `/data` wird beschrieben, ein Volume, das
  65532 gehört (`SEVDESK_HTTP_STATE_DIR=/data`).
- Es startet `--http`, lauscht auf `0.0.0.0:8080` und hat eine Zustandsprüfung, die den Befehl
  `healthcheck` ausführt (`GET /healthz`).
- Jeder andere Befehl ersetzt `--http`: `--stdio`, `--version`, `generate-secret`, `account-id`
  und `grants …`, zum Beispiel
  `docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret`.

## Die Vorlagen

Der Ordner [`deploy/`](../../deploy/) enthält Vorlagen, die das Image im OAuth-Modus betreiben, als
genau eine Instanz mit einem Volume unter `/data` (Zugänge und Sitzungen liegen dort, ausstehende
Freigaben im Speicher), `SEVDESK_CONFIRM=browser`, dem Audit-Log in `/data/audit.jsonl` und
`SEVDESK_ALLOW=read`: Erhöhe `SEVDESK_ALLOW` auf das Höchste, was eine Verbindung bekommen soll.
Release-PRs heben die Image-Version in diesen Dateien an; eine Vorlage nennt also immer das
Release, mit dem sie ausgeliefert wird.

Jede Bereitstellung braucht mindestens `SEVDESK_HTTP_PUBLIC_URL` und entweder
`SEVDESK_HTTP_SECRET` plus `SEVDESK_OAUTH_ACCOUNTS` (OAuth) oder `SEVDESK_HTTP_BEARER_TOKEN` plus
`SEVDESK_API_TOKEN` (Bearer).

| Vorlage                                                        | Betreibt                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`deploy/compose/`](../../deploy/compose/)                     | Docker Compose auf deinem eigenen Host, mit Caddy für automatisches HTTPS |
| [`deploy/fly/fly.toml`](../../deploy/fly/fly.toml)             | Fly.io: eine Machine mit Volume, im Leerlauf pausiert                     |
| [`deploy/render/render.yaml`](../../deploy/render/render.yaml) | Render-Blueprint: ein Webdienst mit Disk (kostenpflichtige Instanz)       |
| [Railway](#railway)                                            | Railway: ein Dienst mit Volume, aus dem Dashboard oder als Code           |

## Docker Compose mit Caddy (`deploy/compose/`)

Für eine VM oder einen Heimserver mit Domainnamen.
[`deploy/compose/compose.yaml`](../../deploy/compose/compose.yaml) startet zwei Dienste:

- **`mcp`**, der Server: schreibgeschütztes Root-Dateisystem, alle Linux-Capabilities entzogen,
  `no-new-privileges`, Grenzen für Speicher und Prozesse, das Server-Geheimnis aus einer Datei über
  Compose-Secrets (`SEVDESK_HTTP_SECRET_FILE`), ein benanntes Volume unter `/data` und kein Port,
  der auf dem Host veröffentlicht ist;
- **`caddy`** (per Digest festgelegt): holt und erneuert das TLS-Zertifikat für deine Domain,
  behält den `Host`-Header bei, setzt `X-Forwarded-For` und gibt gestreamte Antworten sofort weiter
  (`flush_interval -1`). Er schreibt bewusst kein Access-Log: OAuth-Redirect-URLs enthalten
  Autorisierungscodes.

Richte das DNS der Domain auf den Rechner und öffne die Ports 80 und 443. Dann, in
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
setzt die Vorlage `SEVDESK_HTTP_TRUST_PROXY=1`. Für den Bearer-Modus folgst du den
auskommentierten Zeilen in `compose.yaml`. Die Betriebsbefehle führst du in einem einmaligen
Container desselben Dienstes aus, zum Beispiel `docker compose run --rm mcp grants list`.

## Fly.io (`deploy/fly/fly.toml`)

[`deploy/fly/fly.toml`](../../deploy/fly/fly.toml) betreibt eine Machine in Frankfurt mit einem
1-GB-Volume (`sevdesk_data`) unter `/data`. Fly terminiert TLS und erzwingt https; die Machine
pausiert im Leerlauf (`auto_stop_machines = "suspend"`, das ihren Speicher behält) und startet bei
der nächsten Anfrage.

```bash
fly apps create <app>
# In fly.toml: `app`, SEVDESK_HTTP_PUBLIC_URL (https://<app>.fly.dev oder deine Domain) und
# SEVDESK_OAUTH_ACCOUNTS setzen.
fly secrets set --app <app> --stage \
  SEVDESK_HTTP_SECRET="$(docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:latest generate-secret)"
fly deploy --config deploy/fly/fly.toml --ha=false
```

Bleib bei einer Machine (`--ha=false`): Eine zweite hätte ihr eigenes Volume und ihre eigenen
Zugänge. Der Fly-Proxy ist ein Hop (`SEVDESK_HTTP_TRUST_PROXY=1`).

## Render (`deploy/render/render.yaml`)

[`deploy/render/render.yaml`](../../deploy/render/render.yaml) ist ein Blueprint: ein Webdienst aus
dem Image in Frankfurt, mit einer 1-GB-Disk unter `/data` und `/healthz` als Zustandsprüfung. Wähle
im Render-Dashboard New → Blueprint, dieses Repository (oder deinen Fork) und als Blueprint-Pfad
`deploy/render/render.yaml`. Render erzeugt `SEVDESK_HTTP_SECRET` selbst (`generateValue`, nie in
der Datei sichtbar) und fragt beim Anlegen nach `SEVDESK_HTTP_PUBLIC_URL`
(`https://<service>.onrender.com` oder deine Domain) und `SEVDESK_OAUTH_ACCOUNTS`. Eine Disk
braucht einen kostenpflichtigen Instanztyp und hält den Dienst bei einer Instanz. Die Vorlage setzt
`PORT=8080`, den Port, an den Render weiterleitet.

## Railway

Railway liest für neue Dienste keine `railway.json` mehr (seine Konfiguration als Code ist
abgekündigt und wird ab dem 2026-12-01 nicht mehr gelesen). Du hast zwei Wege:

- Lege den Dienst im Dashboard aus dem Image an (New → Docker Image), füge ein Volume unter
  `/data` hinzu, setze `/healthz` als Zustandsprüfung, behalte eine Replica und setze die
  Variablen; oder
- beschreibe ihn in einer Datei für
  [Railway Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) in deinem
  eigenen Projekt (`.railway/railway.ts`, mit `npm install railway`). Eine fertige Datei, auf das
  aktuelle Release festgelegt, steht in [`deploy/README.md`](../../deploy/README.md#railway).

Die Variablen sind die der anderen Vorlagen: `PORT=8080` (das Image lauscht auf 8080),
`SEVDESK_HTTP_AUTH=oauth`, `SEVDESK_HTTP_PUBLIC_URL=https://<service>.up.railway.app`,
`SEVDESK_HTTP_TRUST_PROXY=1`, `SEVDESK_OAUTH_ACCOUNTS`, `SEVDESK_ALLOW`,
`SEVDESK_CONFIRM=browser`, `SEVDESK_AUDIT_LOG=/data/audit.jsonl` und `SEVDESK_HTTP_SECRET`, einmal
im Dashboard als versiegelte Variable auf die Ausgabe von `generate-secret` gesetzt. Railway bindet
Volumes mit root als Eigentümer ein; setze daher auch `RAILWAY_RUN_UID=0`
([Volumes und der Container-Benutzer](#volumes-und-der-container-benutzer)).

## Ein Tunnel, zum Testen

`cloudflared tunnel --url http://localhost:8080` gibt einem lokalen Server eine vorübergehende
öffentliche https-URL. Setze sie als `SEVDESK_HTTP_PUBLIC_URL` (Neustart, wenn sie sich ändert) und
`SEVDESK_HTTP_TRUST_PROXY=1`. Der Tunnelanbieter terminiert TLS und sieht den Verkehr,
einschließlich der Tokens; verwende ihn für Tests, nicht für deine Buchhaltung.

## Volumes und der Container-Benutzer

Benannte Docker-Volumes (Compose) übernehmen den Eigentümer von `/data` aus dem Image und
funktionieren daher, wie sie sind. Ein Bind-Mount braucht ein Verzeichnis, in das uid 65532
schreiben kann: `sudo install -d -o 65532 -g 65532 -m 700 ./data`.

Eine Plattform-Disk, die mit root als Eigentümer eingebunden wird, ist für uid 65532 nicht
beschreibbar, und der Server startet dann nicht, weil `SEVDESK_HTTP_STATE_DIR` nicht beschreibbar
ist. Railway dokumentiert diesen Fall und seine Lösung (`RAILWAY_RUN_UID=0`, das den Container als
root ausführt). Ohne beschreibbare Disk setzt du `SEVDESK_HTTP_STATE_DIR` auf einen leeren Wert:
Der Zustand wird dann im Speicher gehalten, und Clients müssen sich nach jedem Neustart neu
verbinden.

## Das Image prüfen

Jedes Release-Image trägt eine Build-Provenance-Attestierung von GitHub Actions sowie die SBOM und
Provenance von BuildKit. So prüfst du, dass ein Image aus diesem Repository von seinem
Release-Workflow gebaut wurde:

```bash
gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann
```

SBOM und Provenance lesen:

```bash
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .Provenance }}'
```

Lege dann den geprüften Digest (`ghcr.io/jaylann/mcp-server-sevdesk@sha256:…`) in deiner
Bereitstellung fest. Wie die Release-Pipeline sie erzeugt, steht in
[security/supply-chain.de.md](../security/supply-chain.de.md).

<!-- translated-from: docs/contributing/testing.md sha256:ab27bbfa492c -->

# Testen

Wie du eine Änderung über `pnpm check` hinaus ausprobierst: der HTTP-Modus, die
Claude-Desktop-Erweiterung, der Schlüsselbund, Fixtures, Live-Tests gegen ein Testkonto und die
Evals zur Werkzeugauswahl. Die Seite ist für Mitwirkende; was jede Testschicht abdeckt, steht unter
[Builds und Tests](../architecture/build-and-test.de.md#tests).

## HTTP-Modus

Den Fernzugriff (`--http`) beschreibt [Fernzugriff](../remote.de.md) für Betreiber. So startest du
ihn lokal im Bearer-Modus gegen ein Testkonto:

```bash
pnpm build
export SEVDESK_HTTP_AUTH=bearer
export SEVDESK_HTTP_BEARER_TOKEN="$(node dist/index.js generate-secret)"
export SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token
node dist/index.js --http      # oder aus dem Quellcode: pnpm dev --http
```

Er lauscht auf `http://127.0.0.1:8080/mcp` (`SEVDESK_HTTP_PORT` ändert den Port). Verbinde einen
Client mit dem Bearer-Header, zum Beispiel Claude Code:

```bash
claude mcp add --transport http sevdesk-dev http://127.0.0.1:8080/mcp \
  --header "Authorization: Bearer $SEVDESK_HTTP_BEARER_TOKEN"
```

Übergib das Flag als `pnpm dev --http`, nicht als `pnpm dev -- --http`: pnpm reicht das `--` an den
Server weiter, und der lehnt unbekannte Argumente ab. Einfaches http auf Loopback ist nur für die
Entwicklung: Browser teilen Cookies über die Ports eines Hosts hinweg, ein anderer lokaler Webserver
könnte also das Sitzungs-Cookie des Freigabe-Postfachs bekommen. Probiere das Postfach in einem
Browser-Profil aus, das du für nichts anderes nutzt.

Der OAuth-Modus funktioniert auch lokal, mit einer öffentlichen URL auf Loopback
(`SEVDESK_HTTP_PUBLIC_URL=http://localhost:8080`, `SEVDESK_HTTP_SECRET`, `SEVDESK_OAUTH_ACCOUNTS`);
claude.ai erreicht sie nicht, deshalb läuft die Ende-zu-Ende-Prüfung mit claude.ai über einen
Tunnel ([Prüfung des Fernzugriffs](../recording-session/remote-check.de.md)).

- **HTTP-Smoke-Test:** `pnpm build && node scripts/smoke-http.ts --bin dist/index.js` startet den
  gebauten Server im Bearer-Modus auf einem freien Port (mit einem Platzhalter-Token für sevDesk,
  sodass nichts bei sevDesk ankommt) und prüft den Health-Endpunkt, die 401-Antworten, die
  Ablehnungen nach Host und Origin, den MCP-Handshake in beiden Protokollgenerationen und ein
  sauberes Herunterfahren. Gegen einen laufenden Server, mit exportiertem
  `SEVDESK_HTTP_BEARER_TOKEN` (das Skript liest das Token nur aus der Umgebung, damit es nie in der
  Prozessliste auftaucht): `node scripts/smoke-http.ts --url http://127.0.0.1:8080`.
- **Das Image:** `docker build -t mcp-server-sevdesk:dev .`, dann starte es schreibgeschützt wie
  im [Docker-Schnellstart](../remote.de.md#schnellstart-bearer-modus-mit-docker) und richte den
  Smoke-Test mit `--url` darauf. Die CI macht dasselbe in ihrem Job `docker`.
- **Tests:** Unit-Tests in `test/unit/http/` (OAuth in `test/unit/http/oauth/`),
  Integrationstests auf einem echten Socket in `test/integration/http-*.test.ts` (Bearer, OAuth mit
  dem echten SDK-Client, der ganze Ablauf durch das Freigabe-Postfach) und
  `test/integration/cross-account.test.ts`; Hilfen für die Zustimmungs- und die Postfachseite in
  `test/helpers/`. Jedes Modul mit Geheimnissen hat einen Test mit einem mitgeschnittenen Logger
  oder einer mitgeschnittenen Antwort, der prüft, dass kein Geheimnis darin vorkommt; so soll es
  bleiben.

## Die Claude-Desktop-Erweiterung

`pnpm mcpb` baut das `.mcpb`-Bundle nach `build/`: Es bündelt den Server mit allen Abhängigkeiten
in eine Datei (`tsdown.mcpb.config.ts`), erzeugt die Werkzeugliste des Manifests, schreibt die
Lizenzhinweise jedes gebündelten Pakets, validiert und packt das Bundle mit der Bibliothek `mcpb`
und startet dann den entpackten Server so, wie Claude Desktop es tut. Der CI-Job `mcpb` führt das
bei jedem Pull-Request aus und lädt das Bundle als Artefakt hoch; der Release-Job `publish-mcpb`
hängt es mit einer Provenance-Attestierung an das GitHub-Release.

Das eingecheckte `server.json` ist die npm/OCI-Vorlage. `publish-registry` wartet auf
`publish-mcpb`, lädt das öffentliche Bundle des Releases herunter und führt
`scripts/prepare-registry.ts` mit einfachem Node aus, um dessen MCPB-URL und SHA-256 in das
`server.json` einzutragen, das es veröffentlicht. Vor dem Schreiben prüft es den Namen und die
Manifest-Version des Bundles; in diesem privilegierten Job läuft keine Installation von
Abhängigkeiten. Der MCPB-Eintrag entsteht erst bei der Veröffentlichung, weil release-please den
Hash eines künftigen Assets nicht kennen kann. Im selben Schritt wandert die URL des Icons von
`main` auf das Tag des Releases: Die eingecheckte URL muss erreichbar sein, bevor es das Tag gibt,
die veröffentlichte behält das Icon dieses Releases. Die Tests des Generators validieren gegen das
offizielle Schema, das `server.json` festlegt (Snapshot und Herkunft in `spec/mcp-registry/`). Um
dieselbe Vorbereitung nach `pnpm mcpb` probeweise durchzuspielen:

```bash
version="$(node -p 'require("./package.json").version')"
node scripts/prepare-registry.ts "$version" "v$version" \
  "build/mcp-server-sevdesk-$version.mcpb" build/registry/server.json
```

Ändere die Einstellungen der Erweiterung nur in `mcpb/manifest.json`. Behalte ihr Layout von
`JSON.stringify` bei (release-please schreibt die Datei neu, wenn es die Version anhebt, deshalb
ignoriert Prettier sie), und gib jeder optionalen Einstellung einen Standardwert: Claude Desktop
übergibt eine leere Einstellung ohne Standardwert als wörtliches `${user_config.…}`, und der Build
lehnt ein solches Manifest ab. Die Einstellungsschlüssel gehören zum
[Kompatibilitätsvertrag](changes.de.md#kompatibilität), weil Claude Desktop die Werte des Benutzers
unter ihnen speichert. Um einen Build auszuprobieren, öffne
`build/mcp-server-sevdesk-<version>.mcpb` in Claude Desktop.

## Schlüsselbund und Profile

Der Schlüsselbund-Code (`src/safety/keychain.ts`) bekommt ein `spawn` übergeben, deshalb führen
Tests nie `security`, `secret-tool` oder Windows PowerShell aus; der Profil-Code bekommt Plattform,
Benutzer-ID und Home-Ordner übergeben. Ein echter Durchlauf ist eine Prüfung von Hand: `token set`,
`token check`, ein Serverstart mit `SEVDESK_API_TOKEN_KEYCHAIN` auf einer Wegwerf-Bezeichnung, dann
`token delete` (die Befehle beschreibt [Profile und Schlüsselbund](../configuration/profiles.de.md)).

Unter Windows, aus einer frischen PowerShell-Sitzung im Repository (nimm eine neue
Wegwerf-Bezeichnung und füge das Token nur in die verdeckte Eingabe ein):

```powershell
pnpm build
node dist/index.js token set windows-check-11
node dist/index.js token check windows-check-11
$env:SEVDESK_API_TOKEN_KEYCHAIN = 'windows-check-11'
node dist/index.js --stdio
# Nach der Startmeldung den Server mit Strg+C beenden, dann:
Remove-Item Env:SEVDESK_API_TOKEN_KEYCHAIN
node dist/index.js token delete windows-check-11
node dist/index.js token check windows-check-11 # muss melden, dass kein Token gespeichert ist
```

Wiederhole `token set` vor dem Löschen, um das Ersetzen zu prüfen, und stelle sicher, dass kein
Token in der Ausgabe oder in den Prozessargumenten von PowerShell erscheint. `PasswordVault`
braucht den Modus `FullLanguage` von Windows PowerShell; im Constrained Language Mode muss eine
sichere Ablehnung kommen, nie eine Umgehung der Richtlinie
([ADR 0009](../adr/0009-local-profiles-and-os-keychain.de.md)).

## Fixtures

Fixtures liegen in `test/fixtures/` und halten ihre Herkunft fest (`spec`, `community` oder
`recorded`, dazu Datum und Version des Buchhaltungssystems). Aufgezeichnete Fixtures müssen vor dem
Commit von personenbezogenen Daten und Tokens bereinigt sein; das erledigt der Recorder, prüfe den
Diff aber trotzdem.

## Live-Tests

sevDesk hat keine Testumgebung: Jeder Schreibvorgang ist echt, und fertiggestellte Dokumente lassen
sich nicht löschen. Die Live-Werkzeuge lesen deshalb nur eine kurze Liste von Variablen
(`SEVDESK_API_TOKEN` oder `SEVDESK_API_TOKEN_FILE`, `SEVDESK_BASE_URL`, `SEVDESK_RATE_LIMIT`,
`SEVDESK_TIMEOUT_MS`) und ignorieren Stufenschalter aus deiner Shell.

- `pnpm test:live` ruft jedes Lese-Werkzeug über den echten Server gegen dein Konto auf, im
  Nur-Lese-Modus (der HTTP-Client lehnt jede Anfrage ab, die Daten ändert), und prüft, dass jedes
  ohne Fehler und mit schemagültiger Ausgabe antwortet. Ohne Token wird jeder Test mit Begründung
  übersprungen. Es läuft mit eigener Konfiguration (`vitest.live.config.ts`) und nie in
  `pnpm test`.
- `SEVDESK_LIVE_LIFECYCLE=1 SEVDESK_LIVE_I_UNDERSTAND_WRITES=1 pnpm test:live` ergänzt ein
  Schreibszenario über die Schreib-Werkzeuge (Kontakt, Entwurf, fertigstellen, Zahlungen, Mahnung,
  Storno, Gutschrift). **Nur für Testkonten**: Es lehnt Konten ab, die schon viele Datensätze
  enthalten, verschickt keine E-Mail, außer `SEVDESK_LIVE_EMAIL_TO` nennt deine eigene Adresse,
  markiert, was es anlegt (`MCP-E2E <run id>`), und gibt eine Aufräumliste aus.
- `pnpm probe --out report.md` prüft die offenen Fragen aus `spec/deviations.md` gegen die API und
  meldet jeden Befund mit bereinigten Nachweisen; `--allow-writes` (plus
  `SEVDESK_LIVE_I_UNDERSTAND_WRITES=1`) ergänzt Proben, die ihre eigenen markierten Testdaten
  anlegen; `--probe-email <your address>` ergänzt eine E-Mail-Probe nur an diese Adresse.
  `pnpm probe --list` zeigt jede Probe.
- `pnpm fixtures:record` zeichnet bereinigte Leseantworten als Fixtures auf (nur lesend;
  `--dry-run` listet die Anfragen).

Das Schritt-für-Schritt-Runbook für eine Aufnahmesitzung auf einem kostenlosen Testkonto,
einschließlich dessen, was du committest und was nie, ist das
[Runbook für die Aufnahmesitzung](../recording-session.de.md). Der manuelle Workflow `Live E2E`
führt `pnpm test:live` in der CI hinter der geschützten Umgebung `live` aus.

## Evals zur Werkzeugauswahl

`test/evals/` prüft, welches Werkzeug ein Modell bei etwa 70 deutschen und englischen Anfragen
zuerst wählt. `pnpm evals` spielt aufgezeichnete Modellantworten ab (kein API-Schlüssel, keine
Kosten); Fälle ohne Aufzeichnung werden als „stale cassette“ übersprungen. Eine Kassette ist an die
ganze Anfrage gebunden, und die enthält jedes Werkzeug ihrer Konfiguration: Ändert sich Name,
Beschreibung oder Schema irgendeines Werkzeugs oder die Server-Anweisungen, veraltet jeder Fall
dieser Konfiguration. Nimm sie mit `ANTHROPIC_API_KEY=… pnpm evals:record` neu auf (etwa 1–2 $ je
vollem Lauf) und committe die Kassetten; wenn du ein Werkzeug umbenennst, passe auch die erwarteten
Werkzeugnamen in `test/evals/cases.ts` an. Bei Pull-Requests, die Werkzeuge berühren, spielt
`.github/workflows/evals.yml` sie nur ab, ohne Secrets und ohne Kosten. Das Aufnehmen ist ein
lokaler Schritt, vor einem Release oder nach Änderungen an Beschreibungen, nie in der CI. Die Evals
dienen der Information und sind keine Pflichtprüfung. Details:
[test/evals/README.md](../../test/evals/README.md).

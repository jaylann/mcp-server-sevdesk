<!-- translated-from: docs/contributing/changes.md sha256:ba3c910417ea -->

# Änderungen vornehmen

Wie du ein Werkzeug hinzufügst, eine Seite änderst, einen Prompt hinzufügst und eine Änderung
innerhalb des öffentlichen Vertrags hältst. Die Seite ist für Mitwirkende, die das Repository
eingerichtet haben ([Mitwirken](../../CONTRIBUTING.de.md#einrichtung)); wie du eine
Änderung testest, steht unter [Testen](testing.de.md).

## Bevor du anfängst

Lies zuerst [Architektur](../architecture.de.md): Dort stehen die Schichten (Werkzeuge
→ Domäne → sevDesk-Client), die Modulübersicht und der Lebenszyklus eines Werkzeugaufrufs.
Werkzeuge rufen HTTP nie direkt auf.

Handgeschriebene zod-Schemas sind die maßgebliche Quelle für sevDesk-Payloads, weil die offizielle
OpenAPI-Spezifikation unvollständig und stellenweise falsch ist. Jede bekannte Abweichung steht in
[spec/deviations.md](../../spec/deviations.md) und hat einen Test.

## Ein Werkzeug hinzufügen

1. Wähle die Werkzeuggruppe (`src/tools/<toolset>/`) und die **Stufe**: `read`, `write`
   (umkehrbar), `commit` (rechtlich bindend oder nicht umkehrbar) oder `external` (erreicht
   Dritte). Im Zweifel nimm die höhere Stufe.
2. Definiere es mit `defineTool`: Name, Titel, Beschreibung (nenne deutsche Begriffe wie Rechnung,
   Beleg), zod-Schemas für Ein- und Ausgabe und **alle vier Annotationen** (`readOnlyHint`,
   `destructiveHint`, `idempotentHint`, `openWorldHint`). Sonst schlägt der Metadaten-Lint-Test
   fehl.
3. Implementiere den Handler über die Domänenschicht. Gib kompakte DTOs zurück, nie rohe
   sevDesk-Payloads. Ein Werkzeug der Stufe `commit` oder `external` schreibt seine Vorschau für
   die Bestätigung auf Englisch und auf Deutsch, weil ein Mensch sie auf der Freigabeseite liest:
   Baue beide mit `bothPreviews` aus denselben Daten (`src/domain/preview-text.ts`; ohne die
   deutsche kompiliert das Werkzeug nicht). Halte dieselben Fakten und Warnungen in derselben
   Reihenfolge und verwende sevDesks eigene deutsche Begriffe (Rechnung, Beleg, festschreiben).
4. Ergänze Fixtures und Tests: Normalfall, Fehlerfälle und die Sperre nach Stufe. Aktualisiere den
   Snapshot von `tools/list` (`pnpm test -u`) und prüfe den Diff. Für ein Werkzeug mit deutscher
   Vorschau ergänze einen Fall in `test/write-cases/` und lies dessen deutschen Text im Snapshot
   von `test/integration/write-previews-de.test.ts`.
5. Erzeuge die Werkzeugreferenz mit `pnpm docs:tools` neu und committe `docs/tools.md` (ein Test
   schlägt fehl, wenn sie veraltet ist).

Neue Werkzeuge erscheinen von selbst im Manifest der Claude-Desktop-Erweiterung; der Build erzeugt
ihre Werkzeugliste.

## Eine Seite ändern

Die Seiten, die ein Mensch sieht (Freigabe, Postfach, Anmeldung, Zustimmung, Upload), teilen sich
`src/pages/`: Das Template-Tag `markup` maskiert jeden Wert, die Texte liegen in
`src/pages/text/en.ts` und `de.ts`, und ein einziges Stylesheet (`theme.ts`) gestaltet sie alle. Es
gibt kein Skript, kein `style=""`-Attribut und nichts, was von außerhalb von `/assets/` geladen
wird; ein Test rendert jede Seite in jedem Zustand und beiden Sprachen und schlägt bei jedem
dieser Punkte fehl.

```bash
pnpm pages:preview    # http://127.0.0.1:4173: jeder Seitenzustand, en/de, hell/dunkel, echte Header
pnpm pages:watch      # dasselbe, bei jedem Speichern neu gestartet (Tab neu laden)
pnpm pages:shots      # Screenshots jedes Zustands nach build/page-shots/; schlägt bei Seitenfehlern fehl
pnpm pages:assets     # nach einer Änderung an einer Datei in assets/: die eingebettete Kopie neu erzeugen
```

Trage einen neuen Zustand in `test/helpers/page-gallery.ts` ein, damit die Vorschau und die Tests
ihn abdecken. Die Seite `/texts` der Vorschau zeigt jeden Text in beiden Sprachen nebeneinander.

`pages:shots` fotografiert jeden Zustand in beiden Sprachen und beiden Farbschemata bei 1280 und
390 px (`--only <name>`, `--locale`, `--scheme` und `--width` grenzen das ein) und schlägt fehl,
wenn eine Seite einen Fehler meldet, auch alles, was ihre Content-Security-Policy abgelehnt hat. Es
steuert das installierte Google Chrome (`SEVDESK_CHROME=<Pfad>` für ein anderes); führe es
außerhalb einer Sandbox-Shell aus.

Um den Freigabeablauf selbst auszuprobieren, spielt `pnpm approvals:dev` einen Assistenten gegen
aufgezeichnete Fixtures: Tasten rufen die bestätigungspflichtigen Schreibwerkzeuge auf, der Server
öffnet seine lokale Freigabeseite wie für Claude Desktop, und du entscheidest im Browser. `r`
wiederholt die wartenden Aufrufe (freigegebene laufen gegen die Fixtures), `c` ändert einen
wartenden Datensatz, sodass der Server erneut fragt, `e`/`x` stellen die Uhr 9 oder 10 Minuten
vor, `f` füllt bis zur Grenze auf; `--scenario steady|burst` schickt Anfragen von selbst, und
`--no-open` schreibt die Links nur ins Log. Es braucht kein Token, und nichts verlässt den Rechner.

## Einen Prompt hinzufügen

Prompts sind Buchhaltungsabläufe, die der Benutzer im Client auswählt. Sie erzeugen nur Text und
rufen sevDesk nie auf.

1. Trage den Prompt mit `definePrompt` in `src/prompts/catalog.ts` ein: ein `name` in snake_case
   ohne Präfix `sevdesk_` (Clients ordnen Prompts je Server in einen eigenen Namensraum), Titel,
   Beschreibung, die Werkzeuge, die er zum Erscheinen voraussetzt (`requires`), und seine Schritte.
   Halte ihn im Einklang mit dem passenden Ablauf in
   `plugin/skills/sevdesk-bookkeeping/references/workflows.md`.
2. Jeder Schritt führt in `tools` jedes Werkzeug auf, das sein Text nennt (in Backticks); der
   Schritt erscheint nur, wenn alle registriert sind. Gib einen `fallback` an (was übersprungen
   wird, ohne ein Werkzeug zu nennen), wenn der Benutzer erfahren soll, dass eine Einstellung den
   Schritt freischalten würde; welche, ergänzt der Renderer.
3. Argumente sind optionale Strings mit einer Muster- oder Längenprüfung. Zeige ein rohes Argument
   nur über `fenceInline`, nie im vertrauenswürdigen Text.
4. Führe `test/unit/prompts/` und `test/integration/prompts-list.test.ts` aus: Der Lint rendert
   jeden Prompt in vielen Konfigurationen und schlägt fehl, wenn ein Schritt ein Werkzeug nennt,
   das diese Konfiguration nicht registriert. Aktualisiere den Snapshot von `prompts/list`
   (`pnpm test test/integration/prompts-list.test.ts -u`) und prüfe den Diff, danach
   `pnpm docs:tools`.

## Kompatibilität

Ab 1.0 ist die öffentliche Oberfläche ein Vertrag (Werkzeugnamen, Argumente, Ausgaben,
Werkzeuggruppen, Stufen, Prompts, Variablen, Befehle, Routen, Ressourcen, Felder des Audit-Logs,
die Einstellungsschlüssel der Erweiterung); die vollständige Liste und die Regeln für Abkündigungen
stehen auf der Seite [Kompatibilität](../compatibility.de.md). So bleibst du darin:

- Frei hinzufügen: neue Werkzeuge, optionale Argumente, Ausgabefelder, Variablen.
- Zum Umbenennen oder Entfernen folge den
  [Regeln für Abkündigungen](../compatibility.de.md#regeln-für-abkündigungen) und führe die Abkündigung im PR auf.
- Ein PR, der den Vertrag trotzdem bricht, markiert seinen Titel mit `!` (`feat(invoices)!: …`)
  und erklärt den Bruch in seiner Beschreibung.
- Beschreibungen, Ergebnistexte, Fehlermeldungen und Logs gehören nicht zum Vertrag; verbessere sie
  frei, aber nimm die Evals neu auf, wenn du änderst, was Modelle lesen
  ([Evals zur Werkzeugauswahl](testing.de.md#evals-zur-werkzeugauswahl)).

### Bericht „Tool surface“

Der PR-Workflow **Tool surface** vergleicht den Basis-Commit des Ereignisses mit dem PR, gemergt in
diese Basis (GitHubs Test-Merge-Commit); ein Branch, der hinter `main` liegt, zeigt also nur seine
eigenen Änderungen. Ein angehefteter Kommentar beginnt mit **Tokens im Modellkontext** und
**Tokens der Antworten**, Basis → Head mit vorzeichenbehaftetem Δ:

- Der Modellkontext ist die Sicht eines Claude-Clients aus der Zeit von 2025: `name`,
  `description` und `input_schema` der Werkzeuge und die Server-Anweisungen als System-Prompt, wie
  in `test/evals/tools.ts`. Achte darauf, wenn du Werkzeuge hinzufügst oder Beschreibungen und
  Eingabeschemas wachsen lässt. Gemessen wird in vier Konfigurationen: read, write, alle
  Werkzeuggruppen und Stufen (einschließlich advanced) und alles über HTTP mit OAuth und
  Dateiübertragung.
- Die Kosten der Antworten misst der Bericht, indem er ein Invoice-Get, eine Rechnungsübersicht
  nach Monat und Kontakt-, Kontoumsatz-, Beleg- und Rechnungslisten mit Standardlimit durch den
  echten Server auf **aufgezeichneten Fixtures** schickt. `transactions_list`, `vouchers_list` und
  `invoices_list` laufen zusätzlich mit `detail: "summary"`; `invoices_list` läuft außerdem mit
  beiden Detailstufen bei `limit: 100`. Jede aufgezeichnete Liste wird deterministisch auf 100
  Einträge erweitert, indem ihre bereinigten Zeilenformen mit eigenen IDs wiederholt werden (die
  ursprüngliche Gesamtzahl von sevDesk wird verworfen); Aufrufe mit Standardlimit liefern derzeit
  25 Zeilen. Tests prüfen diese Anzahlen, vergleichen volle und zusammengefasste Antworten (jede
  Zeile der Zusammenfassung direkt nach ihrem vollen Gegenstück) und prüfen, dass eine Senkung des
  Standards auf 10 die gemessenen Kosten ändert. Beide Revisionen verwenden denselben erzeugten
  Bestand; gemessen werden also Änderungen an Seitengröße und Formatierung, keine repräsentative
  Stichprobe echter Dokumente. Die Uhr steht fest auf 2026-11-13, damit Überfälligkeitsmarken nicht
  wandern. Ein fehlendes oder fehlschlagendes Werkzeug oder eine solche Fixture-Route lässt nur
  diese Antwort bei `n/a`; selbst ein Fehler beim Aufbau des Bestands behält die Werkzeuge,
  Prompts, Anweisungen und den Kompatibilitäts-Diff.
- Das vollständige moderne `tools/list`, einschließlich der Ausgabeschemas, ist zweitrangig und
  mit **not in model context for Claude clients** beschriftet; es wird in Unicode-Zeichen
  angegeben, nicht in Modell-Tokens. Der Kompatibilitäts-Diff deckt weiterhin vollständige
  Werkzeuge, Prompts und Anweisungen ab. Prüfe Namen und Schemas selbst: Der Bericht entscheidet
  nicht, welche Versionsanhebung nötig ist.

Lokale und PR-Zählungen sind als **estimated** beschriftet: Unicode-Zeichen ÷ 2,3, auf ganze
Tokens gerundet (das Verhältnis wurde in
[#61](https://github.com/jaylann/mcp-server-sevdesk/issues/61) gemessen). Der vertrauenswürdige
Publisher kann den vollständigen Vergleich auf **exact**-Zählungen mit `messages.countTokens` für
`claude-opus-5-5` hochstufen, über Workload Identity Federation (WIF). Zählungen des Modellkontexts
ziehen die ganze Kalibrierungsnachricht ab; Zählungen der Antworten ziehen nur deren Rahmen ab und
behalten die Nutzlast (der Kalibrierungstext `x` ist ein Token). Der Modellkontext zählt die
Werkzeugform der Messages API plus Systemtext; Antworten enthalten die tatsächlichen Textblöcke im
alten Format, Zusammenfassungen und Code-Zäune. Nachrichtenhüllen des Clients, gerenderte
Prompt-Texte und das verzögerte Laden von Werkzeugen liegen außerhalb dieses Vergleichs. Fehlende
Erfassungen in älteren Dumps zeigen `n/a`, auch beim Delta, statt null; der Publisher schließt
unbekannte Antwort-IDs aus, damit unterschiedliche Vokabulare von Harness und Publisher den Bericht
nicht brechen. Die CI kopiert das aktuelle Harness in die Basis; eine Basis, die
`detail: "summary"` schon unterstützt, erfasst diese Aufrufe also auch; ältere Werkzeuge, die
`detail` ablehnen, lassen sie bei `n/a`.

Lokal erfassen, vergleichen oder neu zählen, ohne Zugangsdaten und ohne Netzwerk:

```bash
node --import tsx scripts/tool-surface.ts dump /tmp/head-surface.json
node --import tsx scripts/tool-surface.ts diff /tmp/base-surface.json /tmp/head-surface.json
node --import tsx scripts/tool-surface.ts report /tmp/base-surface.json /tmp/head-surface.json /tmp/pr-event.json /tmp/report.json
node scripts/tool-surface-tokens.ts /tmp/base-surface.json /tmp/head-surface.json /tmp/report.json
```

Der Bericht nimmt ein JSON-Ereignis eines GitHub-PRs (`number`, `pull_request.base.sha`,
`pull_request.head.sha`). Dumps der Version 1 tragen optional `modelContext` je Konfiguration und
`responses`; Berichte ergänzen `tokenCost` mit der Methode, dem festen Modell und Zählungen für
Basis und Head, die null sein dürfen, und behalten `contextCost` (Zeichenzahlen des Protokolls)
für ältere Verbraucher. Die Serialisierung des Modellkontexts erhält die Schlüsselreihenfolge des
Clients bei Werkzeugen und Schemas; nur der Protokollkatalog wird kanonisiert.

Der Workflow ist per Pfadfilter auf relevanten Code, Fixtures und Workflows beschränkt und
überspringt Dependabot. Er führt PR-Code ohne Secrets und ohne Identitätsberechtigungen aus, auch
bei Forks: Die CI kopiert `scripts/tool-surface*.ts` und den aufgezeichneten Bestand in den
Checkout der Basis, beide Revisionen installieren ihre eigenen eingefrorenen Abhängigkeiten, und
das Artefakt `tool-surface-report` enthält `report.json`, `base.json` und `head.json` für sieben
Tage (lange Kommentare verlinken dorthin und sagen, wenn sie gekürzt sind).

Nur der `workflow_run`-Job **Tool surface comment** des Standard-Branches kann Zugangsdaten
bekommen (die Umgebung `token-count`, `id-token: write` auf Job-Ebene, Rechte zum Lesen von
Artefakten und zum Kommentieren von PRs). Er checkt keinen Code aus, installiert nichts und führt
keinen Inhalt eines Artefakts aus. Er prüft die Herkunft und die aktuellen Commits des PRs, lehnt
Behauptungen exakter Zählungen im Artefakt ab, validiert die Formen von Werkzeugen, System und
Antworten, begrenzt den Bericht auf 300 KB, jede Erfassung auf 20 MB und jeden gezählten Kontext
und jede gezählte Antwort auf 2 Millionen Zeichen, und liest Dateien über ein einziges offenes
Handle, ohne symbolischen Links zu folgen; Beschriftungen kommen nur vom Publisher. Nur die
validierten Werkzeugdefinitionen, System-Strings und Antworttexte gehen an den Zähl-Endpunkt. Sein
Inline-Skript tauscht ein frisches GitHub-OIDC-Token für `https://api.anthropic.com` (maskiert,
im Speicher, keine Token-Datei) bei `/v1/oauth/token` gegen ein kurzlebiges Bearer-Token und ruft
dann `/v1/messages/count_tokens` mit demselben Zähler und derselben Kalibrierung für Basis und
Head auf: natives `fetch`, feste Origins, keine Weiterleitungen, höchstens 90 Sekunden, und keine
Zugangsdaten und kein Fehler des Anbieters werden je geloggt oder hochgeladen.

Fehlende Repository-Variablen oder ein Fehler beim Tausch oder Zählen veröffentlichen den
**gesamten geschätzten** Vergleich. Exakte Zählungen ersetzen Schätzungen erst, wenn jede
verfügbare Erfassung gelungen ist; eine späte Schätzung ersetzt nie einen exakten Kommentar für
dieselbe Basis und denselben Head. Veraltete Berichte werden übersprungen, und Diff-Text steht in
Code-Zäunen. Weder ein echtes sevDesk-Konto noch ein Cache für Abhängigkeiten wird verwendet.
Änderungen am Publisher laufen erst, wenn sie auf dem Standard-Branch gelandet sind; prüfe bis
dahin die Artefakte des PRs.

### Maintainer-Einrichtung für exakte Zählungen

Ein API-Schlüssel als Secret ist nicht nötig.
[Das Zählen von Tokens ist kostenlos und ratenbegrenzt](https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing-and-rate-limits).
Folge der
[WIF-Einrichtung von Anthropic für GitHub Actions](https://platform.claude.com/docs/en/manage-claude/wif-providers/github-actions):

1. **Vor dem Merge** legst du die GitHub-Umgebung **`token-count`** an, beschränkst die
   Deployment-Branches auf **`main`** und setzt **keine Pflicht-Reviewer**. Lass nicht den ersten
   Lauf eine unbeschränkte Umgebung automatisch anlegen.
2. In der Claude Console → **Workload identity → Connect workload → GitHub Actions** setzt du:
   - Issuer: `https://token.actions.githubusercontent.com`, mit Discovery.
   - Exaktes Subject: `repo:jaylann@61842101/mcp-server-sevdesk@1449574146:environment:token-count`,
     **ohne `*` am Ende**.
   - Audience: `https://api.anthropic.com`.
   - Exakte Claims: `repository_owner: jaylann`, `repository_owner_id: 61842101`,
     `repository: jaylann/mcp-server-sevdesk`, `repository_id: 1449574146`,
     `event_name: workflow_run` und
     `workflow_ref: jaylann/mcp-server-sevdesk/.github/workflows/tool-surface-comment.yml@refs/heads/main`.
     Nimm `workflow_ref` für diesen Workflow der obersten Ebene, nicht den Claim
     `job_workflow_ref` für wiederverwendbare Workflows.
   - Ziel: ein **neues Service-Konto**, dem nur der eigene Workspace ausdrücklich hinzugefügt ist,
     mit dem niedrigsten verfügbaren Ausgabelimit. Binde die Regel und das getauschte Token nur an
     diesen Workspace; wegen Anthropics impliziter Mitgliedschaft im Default Workspace ist eine
     Mitgliedschaft allein keine Isolation.
   - Scope: der engste angebotene (Standard des Assistenten `workspace:developer`); Laufzeit
     **600 Sekunden**.
3. Setze diese vier **Repository-Variablen** mit den IDs aus der Console:
   `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
   `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`.
4. **Nach dem Merge und dem ersten relevanten PR-Lauf** prüfst du in der
   **Authentifizierungshistorie der Console** das tatsächliche Subject, die Audience und alle
   obigen Claim-Strings. Prüfe einen
   gelungenen Tausch und einen **Exact**-Kommentar; ein **Estimated**-Kommentar belegt nur den
   Rückfall. Prüfe unabhängig davon, dass `x` für `claude-opus-5-5` ein Token Nutzlast ist, wie
   `baseline - 1` annimmt.

Dieses Repository verwendet GitHubs
[unveränderliche Subject-Claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).
Bis die Federation eingerichtet ist, bleiben der echte Tausch, der Abgleich der Claims und die
Annahme der Ein-Token-Kalibrierung ungeprüft; der erste eingerichtete Lauf von `main` prüft sie.

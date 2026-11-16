<!-- translated-from: CONTRIBUTING.md sha256:f273b73aea6c -->

# Mitwirken an mcp-server-sevdesk

Danke, dass du hilfst, den besten MCP-Server für sevDesk zu bauen. Diese Anleitung bringt dich vom
Klonen bis zum gemergten PR; die ausführlichen Seiten stehen unter [Weiterlesen](#weiterlesen).

## Einrichtung

Voraussetzungen: Node 24 (siehe `.nvmrc`; Node ≥ 22.12 geht auch) und pnpm über corepack.

```bash
corepack enable
pnpm install        # richtet auch die Git-Hooks ein (core.hooksPath = githooks)
pnpm check          # alles, was die CI ausführt: Lint, Format, Typprüfung, Tests + Abdeckung, knip, Build, publint
```

Nützliche Skripte: `pnpm test:watch`, `pnpm dev` (startet den Server aus dem Quellcode über
stdio), `pnpm inspect` (öffnet den
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) für den gebauten Server).

Du brauchst **kein** sevDesk-Konto, um mitzuwirken: Die Tests laufen gegen aufgezeichnete und aus
der Spezifikation abgeleitete Fixtures. Wenn du eines hast, sieh dir die
[Live-Tests](docs/contributing/testing.de.md#live-tests) an.

## Branches und Pull-Requests

- Zweige von `main` ab und öffne deinen PR gegen `main`.
- PRs werden per **Squash-Merge** übernommen, deshalb **muss der PR-Titel ein
  [Conventional Commit](https://www.conventionalcommits.org/) sein**: `type(scope): subject` mit
  kleingeschriebenem Betreff. Typen: `feat fix chore docs refactor test perf style ci build revert`;
  Breaking Changes markierst du mit `!` (z. B. `feat(invoices)!: …`).
- Lokale Commits prüft der Hook `commit-msg`; vorgemerkte Dateien werden beim Commit gelintet und
  formatiert.
- Halte PRs fokussiert. Ergänze oder aktualisiere Tests für jede Verhaltensänderung.
- Ein PR, der die öffentliche Oberfläche ändert (Werkzeugnamen, Argumente, Ausgaben, Variablen und
  den Rest), folgt den [Kompatibilitätsregeln](docs/contributing/changes.de.md#kompatibilität).

## Releases

Releases laufen automatisch ([ADR 0005](docs/adr/0005-trunk-based-releases.de.md)). Nach jedem
Merge nach `main` öffnet oder aktualisiert release-please einen Release-PR mit der nächsten Version
und dem Changelog, abgeleitet aus den Conventional-Commit-Titeln. Der Merge dieses PRs setzt den Tag
des Releases und veröffentlicht npm, das Container-Image, den Eintrag in der MCP Registry und die
Claude-Desktop-Erweiterung.

Den Release-PR öffnet die GitHub App `lanfermann-release-bot`, deshalb läuft die CI darauf wie auf
jedem anderen PR. Maintainer richten das einmal je Repository ein: die App im Repository
installieren, ihren privaten Schlüssel als Actions-Secret `RP_APP_KEY` und ihre App-ID als
Actions-Variable `RP_APP_ID` hinterlegen. Ohne sie schlägt der Release-Workflow fehl, wenn er das
Token des Bots erzeugt.

## Weiterlesen

- [Architektur](docs/architecture.de.md): die Schichten, die Modulübersicht und der Lebenszyklus
  eines Werkzeugaufrufs. Lies sie zuerst.
- [Änderungen vornehmen](docs/contributing/changes.de.md): ein Werkzeug hinzufügen, eine Seite
  ändern, einen Prompt hinzufügen, im Kompatibilitätsvertrag bleiben, und der Bericht „Tool
  surface“ auf PRs.
- [Testen](docs/contributing/testing.de.md): der HTTP-Modus, die Claude-Desktop-Erweiterung,
  Schlüsselbund und Profile, Fixtures, Live-Tests und die Evals zur Werkzeugauswahl.
- [Runbook für die Aufnahmesitzung](docs/recording-session.de.md): die API auf einem kostenlosen
  Testkonto prüfen und Fixtures aufzeichnen.
- [Kompatibilität](docs/compatibility.de.md): was 1.0 einfriert, und die Regeln für
  Abkündigungen.
- [Architekturentscheidungen](docs/adr/README.de.md): warum die größeren Entscheidungen so
  gefallen sind.

## Fehler und Sicherheitslücken melden

Nutze die Issue-Formulare für Fehler und Feature-Wünsche. Melde Schwachstellen vertraulich, siehe
[Sicherheitsrichtlinie](SECURITY.de.md).

## Lizenz

Mit deinem Beitrag stimmst du zu, dass er unter der [MIT-Lizenz](LICENSE) steht.

<!-- translated-from: docs/adr/0005-trunk-based-releases.md sha256:4daf64adab3a -->

# ADR 0005: Trunk-basierte Entwicklung und automatisierte Releases

- **Status:** Angenommen
- **Datum:** 2026-11-07

## Kontext

Die anderen Projekte des Maintainers verwenden zwei langlebige Branches: Die Arbeit landet auf
`stage`, und `stage` wird für Releases nach `main` übernommen. Dieses Projekt ist Open Source und
rechnet mit externen Mitwirkenden:

- Forks und Pull-Requests zielen auf den Standard-Branch. Ein zweiter Integrations-Branch ist eine
  Sache mehr, die Mitwirkende falsch machen können.
- [release-please](https://github.com/googleapis/release-please) arbeitet mit einem einzigen
  Release-Branch und leitet Versionen und Changelog aus Conventional Commits ab.
- npm Trusted Publishing (OIDC, kein langlebiges `NPM_TOKEN`) und der Publisher der MCP Registry
  sind an einen bestimmten Workflow auf einem bestimmten Branch gebunden.

## Entscheidung

- **Ein langlebiger Branch, `main`.** Alle PRs zielen darauf. Ein Regelsatz verlangt einen PR und
  bestandene Prüfungen, erlaubt nur Squash-Merges, hält die Historie linear, verbietet Force-Pushes
  und schützt Tags.
- **PR-Titel sind Conventional Commits**, geprüft in der CI. Mit Squash-Merges wird der PR-Titel zur
  Commit-Nachricht auf `main`.
- **release-please** hält einen Release-PR mit der nächsten Version und dem Changelog offen. Sein
  Merge setzt den Tag des Releases und löst die Veröffentlichung aus:
  - npm mit Provenance über Trusted Publishing (die allererste Version wird von Hand veröffentlicht,
    danach wird der Trusted Publisher eingerichtet);
  - der Eintrag in der MCP Registry über `mcp-publisher` mit GitHub-OIDC;
  - das `.mcpb`-Bundle als Asset des Releases;
  - das Multi-Arch-Image auf GHCR mit einer Build-Provenance-Attestierung und einer SBOM.
- **Der MCPB-Eintrag in der Registry wird bei der Veröffentlichung erzeugt** (hinzugefügt
  2026-11-12). `publish-registry` wartet auf den Upload des Bundles, lädt das öffentliche Asset
  herunter und fügt dessen URL und SHA-256 mit `scripts/prepare-registry.ts` in die
  npm/OCI-Vorlage `server.json` ein. Sein eingebettetes Manifest muss zur Identität und Version des
  Releases passen. Die Prüfsumme eines künftigen Bundles ist noch nicht bekannt, wenn
  release-please die Versionen anhebt; die Vorlage im Quellcode trägt also nie einen Platzhalter
  oder einen veralteten Hash. Tests prüfen das erzeugte Dokument gegen das fest eingetragene
  offizielle Schema der Registry.
- **Den Release-PR öffnet eine GitHub App** (`lanfermann-release-bot`, hinzugefügt 2026-11-12),
  nicht `GITHUB_TOKEN`. GitHub führt für PRs, die mit `GITHUB_TOKEN` geöffnet wurden, keine
  Workflows aus, die verlangten Prüfungen würden auf dem Release-PR also nie starten. Das Token der
  App kann PRs öffnen, Branches pushen sowie Tags und Releases anlegen; veröffentlicht wird weiterhin
  nur über OIDC.
- **0.x-Releases ab dem ersten Meilenstein**, damit man den Server früh ausprobieren kann; 1.0.0 zum
  Start.

## Folgen

- Vorteil: Mitwirkende müssen nur „von `main` abzweigen, einen PR öffnen“ wissen.
- Vorteil: Jeder Merge nach `main` ist releasefähig; Versionen und Changelog entstehen automatisch.
- Vorteil: keine Geheimnisse zum Veröffentlichen im Repository; Releases tragen Provenance. Das
  einzige Release-Geheimnis, der private Schlüssel der App, kann nichts veröffentlichen.
- Nachteil: kein Staging-Branch, auf dem sich Änderungen vor einem Release sammeln. Der Release-PR
  ist der Sammelpunkt, und die CI-Prüfung (Lint, Typen, Tests mit Abdeckung, Smoke-Test des Pakets
  auf drei Betriebssystemen) muss stark genug sein, um `main` releasefähig zu halten.
- Nachteil: Es weicht von den anderen Repositorys des Maintainers ab.

## Erwogene Alternativen

- **Übernahme von `stage` nach `main`.** Für dieses Repository verworfen: Es verwirrt Mitwirkende,
  die über Forks arbeiten, und steht im Widerspruch zum Ein-Branch-Modell von release-please.
- **GitFlow.** Verworfen: zu viel Prozess für ein Paket.
- **changesets oder semantic-release.** Verworfen: changesets braucht von Mitwirkenden eine Datei je
  PR; semantic-release veröffentlicht bei jedem Merge ohne einen prüfbaren Release-PR.
- **Manuelle Tags und `NPM_TOKEN`.** Verworfen: fehleranfällig, und ein langlebiges Token zum
  Veröffentlichen ist ein Risiko für die Lieferkette.

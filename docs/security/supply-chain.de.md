<!-- translated-from: docs/security/supply-chain.md sha256:c9690958a578 -->

# Lieferkette

Wie Releases gebaut und veröffentlicht werden und wie du prüfst, dass das npm-Paket, das
Container-Image oder die Claude-Desktop-Erweiterung, die du betreibst, aus dem Release-Workflow
dieses Repositorys stammt. Lies die Seite, bevor du eine Version für den Produktivbetrieb festlegst
oder eine heruntergeladene Erweiterung installierst.

## Releases und das Repository

Releases werden aus der CI mit npm-Provenance veröffentlicht (Trusted Publishing, keine langlebigen
Tokens), GitHub Actions sind per Commit-SHA festgelegt, und das Repository wird von CodeQL,
Dependency Review und OpenSSF Scorecard geprüft.

## Das Container-Image

Das Container-Image `ghcr.io/jaylann/mcp-server-sevdesk` wird vom Release-Workflow aus Basis-Images
gebaut, die per Digest festgelegt sind. Es läuft als Benutzer ohne root-Rechte (uid 65532) auf
einer distroless-Basis mit Node.js, und jedes Release trägt eine Build-Provenance-Attestierung
sowie die SBOM und Provenance von BuildKit. Prüfe ein Image, bevor du es betreibst, und lege dann
den geprüften Digest fest; die Befehle stehen unter
[Bereitstellung](../remote/deployment.de.md#das-image-prüfen).

## Die Claude-Desktop-Erweiterung

Auch die Claude-Desktop-Erweiterung (`mcp-server-sevdesk-<version>.mcpb`) baut der
Release-Workflow. Jedes neue GitHub-Release hängt die Erweiterung an und versucht, zwei Dateien aus
ihrer Build-Provenance-Attestierung anzuhängen:

- `<asset>.sigstore.json`: das vollständige Sigstore-Bundle mit Signatur, Zertifikat und
  Prüfmaterial aus dem Transparenzprotokoll.
- `<asset>.intoto.jsonl`: die signierte DSSE-Hülle als eine JSON-Zeile mit der
  in-toto-Provenance-Aussage. Das ist kein vollständiges Sigstore-Bundle; verwende mit `gh` die
  Datei `.sigstore.json`.

Der Upload der Begleitdateien wird einmal wiederholt. Scheitert der Schritt weiterhin, gibt der
Workflow eine Warnung aus und lässt die Veröffentlichung in der MCP Registry weiterlaufen. Jede der
beiden Begleitdateien kann fehlen, bis ein Maintainer sie nachträglich anhängt; die Attestierung im
Speicher von GitHub bleibt verfügbar.

Prüfe die heruntergeladene Erweiterung gegen den Attestierungsspeicher von GitHub:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann
```

Oder lade die passende Release-Datei `.sigstore.json` herunter und prüfe mit diesem Bundle:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb \
  --bundle mcp-server-sevdesk-<version>.mcpb.sigstore.json --owner jaylann
```

Beide Befehle prüfen den Digest des Artefakts, die Signatur und die Identität des Signierenden. Die
Variante mit `--bundle` verwendet die lokale Attestierung; `gh` kann trotzdem Vertrauensanker von
Sigstore abrufen. Prüfregeln und Offline-Vertrauensanker beschreibt die
[Prüfreferenz der GitHub CLI](https://cli.github.com/manual/gh_attestation_verify).

## Attestierungsdateien nachträglich anhängen

Maintainer verwenden `node scripts/attach-release-attestation.ts [--dry-run] <tag> <asset> [bundle]`
im Release-Job und zum nachträglichen Anhängen. Das Skript verlangt eine SLSA-Provenance-Aussage und
prüft den SHA-256 des Subjekts, bevor es eine der Dateien schreibt oder hochlädt. Ein angegebenes
Bundle bleibt unverändert; andernfalls fragt es nach Digest ab, filtert nach SLSA-v1-Provenance und
verlangt genau eine Attestierung über alle API-Seiten hinweg. `--dry-run` schreibt beide Dateien
neben das Artefakt und zeigt den geplanten Upload an, ohne das Release zu ändern. Das Skript prüft
nur, ob die Digests übereinstimmen; verwende vor dem nachträglichen Anhängen
`gh attestation verify` für die kryptografische Prüfung.

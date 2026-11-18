<!-- translated-from: docs/architecture/build-and-test.md sha256:5be97a3bb5e3 -->

# Builds und Tests

Die drei Formen, in denen der Server ausgeliefert wird, und die Testebenen, die ihn ohne
gemeinsames sevDesk-Konto korrekt halten. Die Seite richtet sich an Mitwirkende; wie du jede Art
von Test ausführst, steht unter [Testen](../contributing/testing.de.md).

## Builds

Derselbe Quellcode wird in drei Formen ausgeliefert; kein Codepfad gehört nur zu einer davon.

- **npm** (`tsdown.config.ts` → `dist/`): das Paket `mcp-server-sevdesk`, Abhängigkeiten
  installiert npm. `npx -y mcp-server-sevdesk` führt es über stdio aus.
- **Container-Image** (`Dockerfile`): `dist/` mit den Produktionsabhängigkeiten auf distroless
  Node.js, standardmäßig `--http`, auf Wunsch `--stdio`.
- **Claude-Desktop-Erweiterung** (`pnpm mcpb`: `tsdown.mcpb.config.ts`, `scripts/build-mcpb.ts`):
  alles in einer Datei gebündelt, `server/index.mjs`, die nur eingebaute Module von Node.js
  importiert, dazu `mcpb/manifest.json`, das Icon, die Lizenz und die Hinweise jedes gebündelten
  Pakets und der eingebetteten Schriften. Das Manifest bildet die Einstellungen von Claude Desktop
  auf dieselben `SEVDESK_*`-Variablen ab, seine Werkzeugliste wird aus den Werkzeugdefinitionen
  erzeugt, und jede optionale Einstellung hat einen Standardwert, weil Claude Desktop eine leere
  als den wörtlichen Text `${user_config.…}` übergeben würde. Der Build prüft und packt das
  Bundle und startet dann den entpackten Server so, wie Claude Desktop es tut. Die CI baut es bei
  jedem Pull-Request; ein Release hängt es mit einer Provenance-Attestierung an das
  GitHub-Release.

Alle drei tragen die Schriften und das Icon der Seiten im JavaScript
(`src/pages/assets.generated.ts`, von `pnpm pages:assets` aus `assets/` geschrieben), das
Stylesheet der Seiten (`src/pages/styles.generated.ts`, von `pnpm pages:css` aus
`src/pages/pages.css` und `@lanfermann/ui` kompiliert; für beide scheitert ein Test, wenn sie von
ihren Quellen abweichen) und die Lizenztexte der Schriften und Icons (`licenses/`).

## Tests

Es gibt kein gemeinsames bezahltes Testkonto, deshalb laufen die meisten Tests gegen Fixtures.
Jedes Fixture hält seine Herkunft fest (`spec`, `community` oder `recorded`, dazu Datum und
Systemversion).

1. **Unit:** Hülle und Typumwandlung, Daten, Geld, Stufen, Schwärzung, Einfassung, der Codec der
   Bestätigungen, die Prüfung gegen ReceiptGuidance, der E-Rechnungs-Parser (offizielle Beispiele
   der KoSIT plus eine Sammlung von Angriffen) und der Abgleich für die Zuordnung.
2. **Vertrag:** Domänenfunktionen gegen Fixtures, bereitgestellt von einem Fake-Client im Speicher
   (`test/helpers/fake-client.ts`) oder einem geskripteten Fake-`fetch`
   (`test/helpers/fake-fetch.ts`). Jeder offene Eintrag im Abweichungsregister hat einen Test.
3. **Regressionen:** ein Test je bekannter Falle (zum Beispiel `preventSendBy`, `filename` auf
   oberster Ebene bei Belegen, keine Wiederholung von Schreibvorgängen, das stille Limit von 100
   Datensätzen, das Vorzeichen von Ausgaben).
4. **MCP-Integration:** Aufrufe im selben Prozess durch den echten Server: ein Snapshot von
   `tools/list` je Konfiguration der Stufen, jedes Werkzeug gegen Fixtures und ein Metadaten-Lint
   (ausdrückliche Annotationen, eindeutige Namen, Länge der Beschreibungen, Schemas mit Objekt als
   Wurzel, Ausgabe passend zu ihrem Schema).
5. **HTTP-Modus** (`test/unit/http/`, `test/integration/http-*.test.ts`): jeder Abbruch beim Start;
   Brücke, Router und Härtung an einem echten Socket (Ablehnungen nach Host und Origin, 413, 429,
   503, Abbrüche, Streaming); Bearer und OAuth von Ende zu Ende mit dem echten SDK-Client (CIMD,
   PKCE, `iss`, Rotation der Refresh-Tokens und erneute Vorlage, Widerruf); Angriffstests für
   versiegelte Tokens, Abgleich der Redirect-URIs, CIMD-SSRF, CSRF und Cookies; zwei Konten über
   einen Server, die nie Caches, Freigaben oder Bestätigungszustand teilen; mitgeschnittene Logs
   und Antworten, die nie ein Geheimnis enthalten. Die CI baut außerdem das Image und führt den
   HTTP-Smoke-Test in einem schreibgeschützten Container aus.
6. **Seiten** (`test/unit/pages/`): Jede Seite wird in jedem Zustand und in beiden Sprachen aus
   einem Satz Fixtures (`test/helpers/page-gallery.ts`) erzeugt und geprüft: gegen das, was ihre
   Policy blockieren würde (kein Skript, kein Inline-Style, nichts von außerhalb von `/assets/`
   geladen), auf beschriftete Felder und CSRF-geschützte Formulare und darauf, dass sie eine
   Sprache spricht; die Farb-Tokens werden im hellen und dunklen Modus auf Kontrast (WCAG AA)
   geprüft. `pnpm pages:preview` stellt dieselben Fixtures unter den echten Headern bereit, für
   einen Blick im Browser, mit allen Texten in beiden Sprachen nebeneinander.
   `test/integration/write-previews-de.test.ts` hält die deutsche Vorschau jedes bestätigten
   Werkzeugs gegen die englische und hält ihren Wortlaut in Snapshots fest.
7. **Paket-Smoke-Test:** `npm pack`, das Tarball installieren, das Programm ausführen, den
   MCP-Handshake abschließen, unter Linux, macOS und Windows mit Node 22 und 24.
8. **Live-Tests:** auf Wunsch, von Hand mit einem echten Token ausgeführt (`pnpm test:live`), nur
   lesend, außer ein Testkonto führt das Lebenszyklus-Szenario aus
   ([Runbook für die Aufnahmesitzung](../recording-session.de.md)).
9. **Evals für die Werkzeugauswahl** (`test/evals/`, `pnpm evals`): etwa 70 deutsche und englische
   Anfragen, bewertet nach den Werkzeugen, die das Modell in seiner ersten Antwort wählt;
   Modellantworten werden einmal aufgezeichnet und wieder abgespielt, und
   `.github/workflows/evals.yml` führt sie bei PRs aus, die Werkzeuge berühren (informativ, nicht
   verpflichtend).

Änderungen bei sevDesk werden getrennt beobachtet: Ein wöchentlicher Job vergleicht die
Spezifikation und den Feed mit API-Neuigkeiten mit dem gespeicherten Snapshot und öffnet bei
Abweichungen ein Issue ([spec/README.md](../../spec/README.md)).

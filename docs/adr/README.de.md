<!-- translated-from: docs/adr/README.md sha256:e7c50bf7fd93 -->

# Architekturentscheidungen

Ein ADR (Architecture Decision Record) hält eine wichtige Entscheidung fest: die Ausgangslage, was
wir gewählt haben, was es kostet und was wir verworfen haben. ADRs erklären, _warum_ der Code so
aussieht, wie er aussieht. Den Gesamtentwurf beschreibt die Seite [Architektur](../architecture.de.md).

| ADR                                                              | Titel                                                                              | Status                                                                                                                                                                                  | Datum      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [0001](0001-curated-tools-and-toolsets.de.md)                    | Kuratierte Aufgabenwerkzeuge, Werkzeuggruppen und ein nur lesendes generisches GET | Angenommen; Zielwerte für die Zahl der Werkzeuge aufgegeben (Nachtrag vom 2026-11-11 im ADR)                                                                                            | 2026-11-07 |
| [0002](0002-hand-written-zod-schemas.de.md)                      | Handgeschriebene zod-Schemas statt aus der Spezifikation generierter Typen         | Angenommen                                                                                                                                                                              | 2026-11-07 |
| [0003](0003-tiers-and-human-confirmation.de.md)                  | Berechtigungsstufen und Bestätigung durch einen Menschen                           | Angenommen; Browser-Modus über HTTP geändert durch [0007](0007-approval-inbox-over-http.de.md), Sprachen der Vorschau und Seiten durch [0010](0010-server-pages-in-two-languages.de.md) | 2026-11-07 |
| [0004](0004-stateless-remote-oauth.de.md)                        | Standardmäßig stdio, zustandsloses HTTP aus der Ferne mit OAuth                    | Ersetzt durch [0006](0006-built-in-authorization-server-and-grant-store.de.md)                                                                                                          | 2026-11-07 |
| [0005](0005-trunk-based-releases.de.md)                          | Trunk-basierte Entwicklung und automatisierte Releases                             | Angenommen                                                                                                                                                                              | 2026-11-07 |
| [0006](0006-built-in-authorization-server-and-grant-store.de.md) | Eingebauter Autorisierungsserver und ein kleiner Zugangsspeicher                   | Angenommen                                                                                                                                                                              | 2026-11-09 |
| [0007](0007-approval-inbox-over-http.de.md)                      | Freigabe-Postfach über HTTP                                                        | Angenommen; Browser-Sitzungen geändert durch [0008](0008-file-transfer-over-http.de.md), Seiten durch [0010](0010-server-pages-in-two-languages.de.md)                                  | 2026-11-09 |
| [0008](0008-file-transfer-over-http.de.md)                       | Dateiübertragung über HTTP                                                         | Angenommen; Seiten geändert durch [0010](0010-server-pages-in-two-languages.de.md)                                                                                                      | 2026-11-09 |
| [0009](0009-local-profiles-and-os-keychain.de.md)                | Lokale Profile und der Schlüsselbund des Betriebssystems                           | Angenommen                                                                                                                                                                              | 2026-11-09 |
| [0010](0010-server-pages-in-two-languages.de.md)                 | Die Seiten des Servers: ein Design, zwei Sprachen, Vorschauen auf Deutsch          | Vorgeschlagen                                                                                                                                                                           | 2026-11-10 |

## Ein neues ADR schreiben

1. Übernimm die Gliederung eines bestehenden ADR in `NNNN-short-title.md` mit der nächsten freien
   Nummer.
2. Abschnitte (auf Englisch, wie in den bestehenden ADRs): **Status** (`Proposed`, `Accepted`,
   `Superseded by NNNN` oder `Rejected`), **Date**, **Context**, **Decision**, **Consequences**,
   **Alternatives considered**. Fasse dich kurz und belege Quellen mit Links.
3. Öffne es als PR mit dem Status `Proposed`. Mit dem Merge wird es `Accepted`.
4. Schreibe eine angenommene Entscheidung nicht um. Ändert sie sich, schreibe ein neues ADR, das sie
   ersetzt, und ändere beim alten nur die Statuszeile. Ändert das neue ADR nur einen Teil, nennt die
   Statuszeile des alten diesen Teil (wie bei 0003).
5. Trage das ADR in die Tabelle oben ein.

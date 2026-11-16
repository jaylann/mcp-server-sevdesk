<!-- translated-from: docs/adr/0002-hand-written-zod-schemas.md sha256:7a3aa87277df -->

# ADR 0002: Handgeschriebene zod-Schemas statt aus der Spezifikation generierter Typen

- **Status:** Angenommen
- **Datum:** 2026-11-07

## Kontext

sevDesk veröffentlicht eine OpenAPI-3.0-Spezifikation unter
[api.sevdesk.de/openapi.yaml](https://api.sevdesk.de/openapi.yaml). Typen oder einen Client daraus
zu generieren liegt nahe, aber die Spezifikation ist auf eine Weise falsch, die generierten Code zur
Laufzeit bricht. Das [Abweichungsregister](../../spec/deviations.md) führt 27 bekannte Punkte auf,
darunter:

- 43 von 75 Schreiboperationen sind ohne die `{objects: …}`-Hülle dokumentiert, die sie tatsächlich
  zurückgeben
  ([D-001](../../spec/deviations.md#d-001-most-write-and-pdf-responses-are-wrapped-in-objects)).
- Skalare kommen als Strings an, manche typisierten Felder als Zahlen, und Enums sind zu eng (D-002,
  D-006 bis D-009).
- `required`-Listen nennen Eigenschaften, die es nicht gibt (D-004), oder mischen die beiden
  Buchhaltungsgenerationen (D-005).
- Endpunkte, die jeder Rechnungsablauf braucht, fehlen (D-024).

Den von der Community gepflegten Spiegel
[j-mastr/sevdesk-api](https://github.com/j-mastr/sevdesk-api) gibt es, weil das aus der offiziellen Spezifikation generierte PHP-SDK gewöhnliche Antworten nicht
deserialisieren konnte
([j-mastr/sevdesk-php-sdk#70](https://github.com/j-mastr/sevdesk-php-sdk/issues/70),
[j-mastr/sevdesk-api#68](https://github.com/j-mastr/sevdesk-api/pull/68)). sevDesk ändert
`info.version` nie, eine Versionsprüfung kann uns also nicht sagen, wann sich die Spezifikation
ändert. sevDesk ignoriert außerdem unbekannte Felder in Anfragen stillschweigend (D-003), ein
falscher Feldname scheitert also ohne Fehler.

## Entscheidung

- **Handgeschriebene zod-Schemas in `src/sevdesk/` sind die maßgebliche Quelle** für jede Anfrage
  und jede Antwort, die wir verwenden.
  - **Ausgehende** Schemas sind streng: Unbekannte Schlüssel werden abgelehnt, bevor etwas gesendet
    wird.
  - **Eingehende** Schemas sind nachsichtig: Sie wandeln String-Skalare um, nehmen Zahl und String
    gleichermaßen an, dulden unbekannte Enum-Werte und ignorieren zusätzliche Felder.
  - Die Domänenschicht macht aus geparsten Daten normalisierte DTOs; rohe sevDesk-Daten erreichen
    das Modell nie.
- **Die Spezifikation dient nur als Referenz.** Ein unveränderter Snapshot liegt in
  `spec/openapi.yaml`, die Metadaten seines Abrufs in `spec/upstream.json`
  ([spec/README.md](../../spec/README.md)).
- **Jede bekannte Abweichung wird registriert**, in `spec/deviations.md`, mit stabiler ID,
  Quellen, Auswirkung und einem Test.
- **Abweichungen werden beobachtet.** `scripts/check-spec-drift.ts` läuft wöchentlich in der CI. Es
  prüft die Spezifikation mit bedingten Anfragen und einem SHA-256, liest den RSS-Feed mit den
  API-Neuigkeiten von sevDesk und öffnet ein Issue mit einem Bericht, wenn sich eines davon ändert.
- **Fixtures halten ihre Herkunft fest** (`spec`, `community` oder `recorded`, mit Datum und
  Systemversion), sodass ein Test zeigt, worauf seine Erwartungen beruhen.
- **Eine Schema-Bibliothek.** Das JSON Schema, das Clients für die Ein- und Ausgaben der Werkzeuge
  sehen, erzeugt zod v4 selbst, kein handgeschriebener Konverter.

## Folgen

- Vorteil: Die Typen beschreiben, was die API tatsächlich tut, und Fehler beim Parsen weisen auf
  echte Änderungen hin.
- Vorteil: Abweichungen sind einmal dokumentiert, getestet und für Mitwirkende nachprüfbar.
- Vorteil: eine Bibliothek für Prüfung, Typen und JSON Schema.
- Nachteil: Jeder Endpunkt braucht handgeschriebene Schemas und Fixtures; Abdeckung kostet Arbeit.
- Nachteil: Ändert sevDesk sein Verhalten, ohne die Spezifikation anzufassen oder eine Neuigkeit zu
  veröffentlichen, merken wir es nur an scheiternden Parsern, Live-Tests oder Meldungen von
  Benutzern. Das nachsichtige Parsen verhindert, dass solche Änderungen Lesezugriffe brechen, und
  Fehler nennen das Feld, das nicht geparst werden konnte.

## Erwogene Alternativen

- **Typen und einen Client aus der offiziellen Spezifikation generieren** (zum Beispiel mit
  openapi-typescript oder orval). Verworfen: Der generierte Code wäre genau dort falsch, wo es
  darauf ankommt, und generierten Code nachzubessern skaliert nicht.
- **Aus dem Community-Spiegel generieren.** Als maßgebliche Quelle verworfen: Er ist besser, aber
  immer noch unvollständig und wird von Freiwilligen gepflegt. Wir nutzen ihn zum Abgleich.
- **Nur Typen, keine Prüfung zur Laufzeit.** Verworfen: sevDesk ignoriert unbekannte Felder
  stillschweigend, und die Form der Antworten schwankt; Fehler würden sich erst als falsche
  Buchhaltungsdaten zeigen.

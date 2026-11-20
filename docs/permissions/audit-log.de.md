<!-- translated-from: docs/permissions/audit-log.md sha256:c264228730f7 -->

# Audit-Log

Das Audit-Log beantwortet die Frage: „Was hat der Assistent in meiner Buchhaltung getan, und wer hat
es freigegeben?“ Diese Seite führt seine Ereignisse und Felder auf und sagt, was die Datei
garantiert; schalte es ein, bevor du eine Schreibstufe aktivierst
([Berechtigungen](../permissions.de.md#empfehlungen)).

Mit `SEVDESK_AUDIT_LOG=<path>` hängt der Server pro Ereignis jedes schreibenden Aufrufs eine
JSON-Zeile an diese Datei an, im Fernzugriff außerdem eine je Datei, die über eine Upload-Seite oder
einen Download-Link läuft. Ist die Variable gesetzt, die Datei aber nicht beschreibbar, werden
Schreibvorgänge abgelehnt. Im Fernzugriff umfasst ein Log jedes Konto, das der Server bedient.

## Ereignisse

| Ereignis                 | Wann                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `dry_run`                | Ein Probelauf hat seine Vorschau zurückgegeben.                                                                                             |
| `confirmation_requested` | Eine Bestätigung wurde angefordert, mit der Vorschau (und im Browser-Modus dem Referenzcode).                                               |
| `confirmation_refused`   | Ein erneuter Versuch legte eine Bestätigung vor, die schon verwendet, abgelaufen oder für andere Argumente erteilt war.                     |
| `approval_decided`       | Auf einer Freigabeseite wurde „Freigeben“ oder „Ablehnen“ gedrückt, oder der Server hat eine Freigabe zurückgezogen (dann mit `reason`).    |
| `declined`               | Du hast im Client abgelehnt oder die Freigabe im Browser abgelehnt.                                                                         |
| `executing`              | Die Aktion wird gleich gesendet, mit der Art der Freigabe: `elicit`, `browser`, `confirmation_off` oder `not_required` (die Stufe `write`). |
| `executed`               | Die Aktion wurde ausgeführt; mit den Datensätzen, die sie geändert hat.                                                                     |
| `failed`                 | Die Aktion ist gescheitert; mit der Art des Fehlers und allen Datensätzen, die ein früherer Schritt bereits geändert hat.                   |
| `file_received`          | Fernzugriff: Eine Datei wurde auf einer Upload-Seite hochgeladen.                                                                           |
| `file_link_created`      | Fernzugriff: Ein Werkzeug hat einen Download-Link angelegt.                                                                                 |
| `file_downloaded`        | Fernzugriff: Ein Download-Link wurde verwendet.                                                                                             |

## Felder

Jede Zeile beginnt mit `ts` (der Zeitpunkt, ISO 8601) und `v`, der Version des Zeilenformats (`1`),
gefolgt von `event`. Im Fernzugriff folgen `account` und `grant`. Die übrigen Felder hängen vom
Ereignis ab:

| Feld                 | Ereignisse                                                                     | Bedeutung                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`            | alle, nur im Fernzugriff                                                       | Die sevDesk-Konto-ID (im Bearer-Modus `bearer`, falls der Server sie nicht ermitteln konnte). Bei Dateizeilen das Konto, dessen Werkzeugaufruf die Upload-Seite oder den Link angelegt hat.                                                                                   |
| `grant`              | alle, nur im Fernzugriff                                                       | Die ID des OAuth-Zugangs oder `bearer`.                                                                                                                                                                                                                                       |
| `callId`             | Schreibereignisse                                                              | Gemeinsam für alle Zeilen einer Aktion, von der Anfrage bis zum Ergebnis.                                                                                                                                                                                                     |
| `tool`               | Schreibereignisse                                                              | Der Name des Werkzeugs.                                                                                                                                                                                                                                                       |
| `tier`               | Schreibereignisse                                                              | `write`, `commit` oder `external`.                                                                                                                                                                                                                                            |
| `argsHash`           | Schreibereignisse                                                              | Ein Hash des Werkzeugs und seiner Argumente, wie `args` sie zeigt (ohne `dryRun`).                                                                                                                                                                                            |
| `args`               | Schreibereignisse außer `approval_decided`                                     | Die Argumente: Token und Upload-IDs geschwärzt, eine IBAN maskiert, versteckte Zeichen als sichtbare `\u{…}`-Escapes geschrieben, Zeichenketten bis 20.000 Zeichen.                                                                                                           |
| `previewHash`        | `dry_run`, `confirmation_requested`, `approval_decided`, `executing`           | Ein Hash der Vorschau, die gezeigt und freigegeben wurde; bei Werkzeugen der Stufen `commit` und `external` umfasst er den englischen und den deutschen Text.                                                                                                                 |
| `preview`            | `dry_run`, `confirmation_requested`                                            | Die Vorschau, wie sie gezeigt wurde: `action` (ein Satz), `facts` (`label`, `value`), `warnings` und `irreversible`.                                                                                                                                                          |
| `approval`           | `executing`                                                                    | Wie die Aktion freigegeben wurde: `elicit`, `browser`, `confirmation_off` oder `not_required`.                                                                                                                                                                                |
| `reason`             | `confirmation_refused`, `approval_decided`                                     | `confirmation_refused`: `replayed_or_expired` oder `mismatch` (für ein anderes Werkzeug oder andere Argumente erteilt). `approval_decided`: `link_used_twice`, wenn der Server die Freigabe zurückgezogen hat, weil ihr lokaler Link in einem zweiten Browser geöffnet wurde. |
| `decision`           | `approval_decided`                                                             | `approved` oder `rejected`.                                                                                                                                                                                                                                                   |
| `reference`          | `confirmation_requested` im Browser-Modus, `approval_decided`, Dateiereignisse | Der Referenzcode, den die Seite und das Ergebnis des Werkzeugs zeigen. Nicht geheim.                                                                                                                                                                                          |
| `batch`, `batchSize` | `approval_decided`                                                             | Wenn eine Entscheidung mehrere Anfragen umfasste: eine Id, die ihre Zeilen teilen, und wie viele Anfragen sie umfasste.                                                                                                                                                       |
| `affected`           | `executed`, `failed`                                                           | Die geänderten Datensätze (`objectName`, `id`); bei `failed` die, die ein früherer Schritt bereits geändert hat.                                                                                                                                                              |
| `error`              | `failed`                                                                       | Die Art des Fehlers, etwa `validation`, `not_found`, `auth`, `timeout`, `network`, `server`, `aborted`, `internal` oder `output_invalid`.                                                                                                                                     |
| `kind`               | Dateiereignisse                                                                | `pdf`, `png`, `jpeg`, `xml`, `csv` oder `zip`.                                                                                                                                                                                                                                |
| `bytes`              | Dateiereignisse                                                                | Die Größe der Datei.                                                                                                                                                                                                                                                          |
| `sha256`             | Dateiereignisse                                                                | Der SHA-256 des Inhalts, hexadezimal. Dateizeilen enthalten nie den Dateinamen oder den Inhalt.                                                                                                                                                                               |

Eine längere Zeichenkette in `args` wird dort abgeschnitten und endet mit einem Hinweis, wie viele
Zeichen nicht protokolliert wurden.

Von einer IBAN in `args` bleiben nur die letzten vier Zeichen (`****3000`), wie in den Vorschauen;
bisher nimmt nur `sevdesk_bank_account_update` unter den Schreibwerkzeugen eine IBAN an. `argsHash`
ist dann der Hash der maskierten Argumente, sodass niemand die volle IBAN finden kann, indem er
Kandidaten hasht. Die Freigabe selbst bleibt an die echten Argumente gebunden: Eine Freigabe für
eine IBAN gilt nie für eine andere.

Zum Beispiel (gekürzt):

```json
{
  "ts": "2026-11-09T14:03:12.481Z",
  "v": 1,
  "event": "executed",
  "callId": "6f1c…",
  "tool": "sevdesk_invoice_finalize",
  "tier": "commit",
  "argsHash": "9b2e…",
  "args": { "id": 1042, "sentVia": "email" },
  "affected": [{ "objectName": "Invoice", "id": "1042" }]
}
```

`v` ändert sich nur, wenn ein Feld seine Bedeutung ändert oder entfällt; neue Felder können ohne
Änderung von `v` hinzukommen ([Kompatibilität](../compatibility.de.md)).

## Integrität

- **Die Datei.** Sie wird mit Modus 0600 angelegt (und auf 0600 verschärft, falls sie schon
  existiert), nur zum Anhängen geöffnet und nie über einen symbolischen Link. Unter macOS und Linux
  wird eine Datei abgelehnt, die einem anderen Benutzer gehört, gleich mit welchem Modus: Ihr
  Besitzer könnte sie umschreiben, und eine ACL kann Zugriff geben, den der Modus nicht zeigt.
  Ebenso alles, was keine gewöhnliche Datei ist, etwa eine benannte Pipe: Hört ihr Leser auf, könnte
  sie jedes Schreiben blockieren.
- **Ganze Zeilen.** Jede Zeile wird ganz geschrieben, oder das Schreiben schlägt fehl; ein
  unvollständiger Schreibvorgang wird fortgesetzt, nicht hingenommen.
- **Im Zweifel ablehnen.** Kann die Zeile `executing` nicht geschrieben werden, wird die Aktion
  nicht ausgeführt und nichts gesendet.
- **Nicht fälschungssicher.** Das Log ist lokal: Es hält für dich fest, was dieser Server getan hat,
  und schützt nicht vor jemandem, der den Rechner kontrolliert.

Im Fernzugriff enthalten die Vorschauen, die es festhält, Kundennamen, Beträge und E-Mail-Texte
jedes verbundenen Kontos ([Datenschutz](../../PRIVACY.de.md#fernzugriff)).

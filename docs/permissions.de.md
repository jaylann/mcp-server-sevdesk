<!-- translated-from: docs/permissions.md sha256:12d02d92671a -->

# Berechtigungen und Bestätigung

Ein sevDesk-API-Token kann alles, was sein Benutzer kann, und zwar im gesamten Konto: Es gibt keine
einschränkbaren Rechte, keine reinen Lese-Tokens und kein Ablaufdatum. sevDesk hat außerdem keine
Testumgebung, jeder Schreibvorgang ändert also Ihre echte Buchhaltung. Deshalb bringt der Server
seine eigenen minimalen Rechte mit: Berechtigungsstufen, die Sie wählen, eine Bestätigung durch
einen Menschen für jeden bindenden Schritt, Probeläufe und ein lokales Audit-Log. Diese Seite
erklärt jedes davon. Das Bedrohungsmodell dahinter steht in [SECURITY.de.md](../SECURITY.de.md).

## Stufen

Jedes Werkzeug gehört zu genau einer Stufe. Lesen und Schreiben teilen sich nie ein Werkzeug.

| Stufe      | Was sie erlaubt                                                                                                                                                                                                                          | Bestätigung |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `read`     | Auflisten, abrufen, suchen, Auswertungen, PDF-Vorschauen (die ein Dokument nie als versendet markieren), E-Rechnungen auslesen, Dokumentdateien und CSV-Exporte in `SEVDESK_OUTPUT_DIR` speichern (oder als Download-Link). Immer aktiv. | nein        |
| `write`    | Kontakte, Artikel, Entwürfe von Rechnungen, Gutschriften, Aufträgen und Belegen, Mahnungen, der DATEV-Export. Umkehrbar oder harmlos.                                                                                                    | nein        |
| `commit`   | Fertigstellen, Zahlungen buchen, Kontoumsätze zuordnen, Umsätze als privat markieren, stornieren, festschreiben (GoBD), zurücksetzen, Belegentwürfe löschen. Rechtlich bindend oder schwer rückgängig zu machen.                         | **ja**      |
| `external` | Rechnungen, Gutschriften und Aufträge per E-Mail versenden. Erreicht Dritte.                                                                                                                                                             | **ja**      |

Die Stufen wählen Sie mit `SEVDESK_ALLOW`, zum Beispiel `SEVDESK_ALLOW=write` oder
`SEVDESK_ALLOW=write,commit`; `all` aktiviert alle Stufen. `SEVDESK_READ_ONLY=1` schaltet alles
außer `read` ab, unabhängig davon, was in `SEVDESK_ALLOW` steht. Die [Werkzeugreferenz](tools.md)
nennt die Stufe jedes Werkzeugs.

Eine sinnvolle Reihenfolge: Beginnen Sie mit `read`, ergänzen Sie `write` mit einem
[Probelauf](#probelauf), und aktivieren Sie `commit` und `external` erst, wenn Sie den Entwürfen
vertrauen und Ihr Client Bestätigungen anzeigt
([Clients](clients.de.md#bestätigung-je-client)).

## Was das Modell sieht

- **Nur die Werkzeuge der aktivierten Stufen.** Werkzeuge darüber werden gar nicht erst
  registriert: Sie stehen nicht in `tools/list`, das Modell kann sie also weder sehen noch
  aufrufen.
- **Was deaktiviert ist und wer es ändern kann.** Die Anweisungen des Servers nennen die
  aktivierten und deaktivierten Stufen und sagen dem Modell, dass Sie, nicht es, weitere
  freischalten und dass es ein fehlendes Werkzeug nicht umgehen darf. `sevdesk_account_info`
  meldet Stufen, Werkzeuggruppen, Nur-Lesen, Probelauf und Bestätigungsart, damit das Modell es
  weiß, bevor es etwas versucht.
- **Passende Prompts.** Ein [Prompt](../README.de.md#prompts) erscheint nur, wenn die Werkzeuge,
  die er braucht, aktiviert sind; ein Schritt, dessen Werkzeuge deaktiviert sind, wird durch einen
  Hinweis auf die Einstellung ersetzt, die ihn freischaltet.
- **Nie ein Weg zur Freigabe.** Kein Argument eines Werkzeugs gibt etwas frei. Ein
  `confirm: true`, das das Modell setzt, gilt nicht als Bestätigung.

Die Stufe wird dreimal durchgesetzt: beim Registrieren der Werkzeuge, erneut bei jedem Aufruf und
im HTTP-Client, der die Mindeststufe jedes sevDesk-Endpunkts kennt (zum Beispiel brauchen
`bookAmount` und `enshrine` die Stufe `commit`, `sendViaEmail` die Stufe `external`) und eine
Anfrage eines Werkzeugs mit zu niedriger Stufe ablehnt. Im Fernzugriff mit OAuth bekommt jede
Verbindung die Stufen, die auf der Zustimmungsseite angehakt wurden, höchstens aber die aus
`SEVDESK_ALLOW` ([remote.de.md](remote.de.md#stufen-je-zugang)).

## Wie ein Schreibvorgang abläuft

1. **Argumente prüfen.** Unbekannte Parameter werden mit Namen abgelehnt. Text mit Zeichen, die
   ein Mensch nicht sehen würde (Zeichen mit Nullbreite, Bidi- und andere Steuerzeichen), wird
   abgelehnt, bevor etwas gelesen wird, damit nichts Verstecktes sevDesk erreicht.
2. **Vorbereiten.** Das Werkzeug liest, was es braucht, mit einem Client, der nicht schreiben
   kann, prüft den Aufruf lokal (Status, Beträge, Steuerregel × Steuersatz, Buchungskonten,
   Dubletten, offene Beträge) und erstellt eine Vorschau: die Aktion in einem Satz, Warnungen und
   die wichtigsten Angaben wie Beträge, Empfänger und den vollständigen E-Mail-Text. Die meisten
   Fehler werden hier abgelehnt, bevor etwas gesendet wird.
3. **Probelauf?** Dann ist die Vorschau das Ergebnis (Status `dry_run`), und der Aufruf endet.
4. **Bestätigen.** Bei `commit` und `external` sehen Sie die Vorschau und geben frei oder lehnen
   ab ([Bestätigungsarten](#bestätigungsarten)). Der Server bereitet danach erneut vor; hat sich
   der Datensatz in der Zwischenzeit geändert, fragt er erneut, statt auszuführen.
5. **Ausführen.** Das Audit-Log verzeichnet `executing` (kann diese Zeile nicht geschrieben
   werden, wird nichts gesendet), dann sendet das Werkzeug die Anfrage mit einem Client, der auf
   seine Stufe beschränkt ist. Schreibvorgänge werden nie wiederholt, damit eine Zeitüberschreitung
   keine Dublette erzeugen kann.
6. **Zurücklesen.** Das Ergebnis wird aus sevDesk zurückgelesen und zurückgegeben (Status
   `done`). Ein Schreibvorgang aus mehreren Schritten, der mittendrin scheitert, meldet die
   Datensätze, die er bereits geändert hat.

Ein Schreibwerkzeug antwortet mit einem von vier Status: `done`, `dry_run`, `approval_pending`
(wartet auf Ihre Entscheidung im Browser) oder `declined`.

## Probelauf

Ein Probelauf führt jede Prüfung eines Schreibvorgangs aus und gibt dessen Vorschau zurück, ohne
etwas an sevDesk zu senden und ohne jemanden zu fragen. Lesezugriffe finden trotzdem statt, die
Vorschau gibt also den aktuellen Datenstand wieder.

- Pro Aufruf: Das Modell übergibt `dryRun: true`. Sie können einfach danach fragen („Zeig mir
  zuerst, was du tun würdest“).
- Für alles: `SEVDESK_DRY_RUN=1`. Jedes Schreibwerkzeug gibt dann nur seine Vorschau zurück. Eine
  gute Einstellung für die ersten Sitzungen mit einer neuen Stufe.

## Bestätigungsarten

`SEVDESK_CONFIRM` legt fest, wie Sie Aufrufe der Stufen `commit` und `external` bestätigen.
Aufrufe der Stufe `write` brauchen keine Bestätigung.

### elicit

Die Voreinstellung. Der Client zeigt über MCP-Elicitation die Vorschau und einen Schalter „Approve
this action“, der zunächst aus ist. Ablehnen, Abbrechen oder ein nicht umgelegter Schalter ergeben
`declined`: Nichts ändert sich. Die ausstehende Bestätigung ist vom Server signiert und an das
Werkzeug, die Argumente und die Vorschau gebunden, 10 Minuten gültig und nur einmal verwendbar.

Nicht jeder Client unterstützt Elicitation ([Clients](clients.de.md#bestätigung-je-client)). Ein
Client, der nicht fragen kann, bekommt einen Fehler, der genau das sagt, und nichts wird gesendet;
wechseln Sie dann zu `browser`.

### browser

Der Aufruf gibt `approval_pending` mit einem kurzen Referenzcode zurück. Sie geben auf einer
Webseite frei und bitten den Assistenten dann, es mit denselben Argumenten erneut zu versuchen.

- **Über stdio** stellt der Server die Seite selbst auf `127.0.0.1` bereit und öffnet sie in Ihrem
  Standardbrowser. Mit `SEVDESK_CONFIRM_OPEN=0` schreibt er den Link nur in sein Log (stderr). Der
  Link ist geheim: Er erreicht nie das Modell, das Ergebnis des Werkzeugs oder das Audit-Log.
- **Im Fernzugriff** warten Freigaben im Freigabe-Postfach des Servers (`/approvals`), das Sie
  nach der Anmeldung öffnen ([remote.de.md](remote.de.md#das-freigabe-postfach)).

Jede Freigabe ist an das Werkzeug, die Argumente und die Vorschau gebunden, läuft nach 10 Minuten
ab und wird einmal verwendet; höchstens fünf warten gleichzeitig. Die Seite zeigt denselben
Referenzcode wie das Ergebnis des Werkzeugs, sodass Sie beide zuordnen können.

Die Seite gibt es auf Deutsch und Englisch; sie richtet sich nach der Sprache Ihres Browsers. Auf
Deutsch ist auch die Vorschau deutsch (die Aktion, die Angaben, die Warnungen, Beträge und Daten
in deutscher Schreibweise), während der Assistent, Probeläufe und das Audit-Log den englischen
Text derselben Anfrage behalten: Ordnen Sie beide über den Referenzcode zu. Die Seite zeigt, wie
lange die Anfrage noch gültig ist, und nimmt die Schaltflächen weg, sobald sie abgelaufen ist. Sie
führt kein Skript aus und lädt nichts von anderen Servern.

Die Grenze dieser Art: Ein Agent, der das Log des Servers lesen oder Ihren Browser steuern kann
(Browser-Automatisierung, ein Werkzeug zur Computersteuerung), könnte selbst freigeben. `browser`
schützt vor einem Modell, das nur redet, zum Beispiel einem, das von in sevDesk-Daten verstecktem
Text gesteuert wird. Bevorzugen Sie `elicit` in agentischen Clients, die Befehle ausführen können.

### off

Keine Bestätigung. Nur zusammen mit `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1` zulässig und nicht
empfohlen: Dann entscheidet das Modell allein, wann eine Rechnung fertiggestellt, gebucht,
storniert oder per E-Mail versendet wird. Die Claude-Desktop-Erweiterung bietet diese Art nicht an.

## Audit-Log

Mit `SEVDESK_AUDIT_LOG=<path>` hängt der Server pro Ereignis jedes schreibenden Aufrufs eine
JSON-Zeile an diese Datei an, im Fernzugriff außerdem eine je Datei, die über eine Upload-Seite
oder einen Download-Link läuft. Es beantwortet die Frage: „Was hat der Assistent in meiner
Buchhaltung getan, und wer hat es freigegeben?“

| Ereignis                 | Wann                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `dry_run`                | Ein Probelauf hat seine Vorschau zurückgegeben.                                                                                             |
| `confirmation_requested` | Eine Bestätigung wurde angefordert, mit der Vorschau (und im Browser-Modus dem Referenzcode).                                               |
| `confirmation_refused`   | Ein erneuter Versuch legte eine Bestätigung vor, die schon verwendet, abgelaufen oder für andere Argumente erteilt war.                     |
| `approval_decided`       | Auf einer Freigabeseite wurde „Freigeben“ oder „Ablehnen“ gedrückt.                                                                         |
| `declined`               | Sie haben im Client abgelehnt oder die Freigabe im Browser abgelehnt.                                                                       |
| `executing`              | Die Aktion wird gleich gesendet, mit der Art der Freigabe: `elicit`, `browser`, `confirmation_off` oder `not_required` (die Stufe `write`). |
| `executed`               | Die Aktion wurde ausgeführt; mit den Datensätzen, die sie geändert hat.                                                                     |
| `failed`                 | Die Aktion ist gescheitert; mit der Art des Fehlers und allen Datensätzen, die ein früherer Schritt bereits geändert hat.                   |
| `file_received`          | Fernzugriff: Eine Datei wurde auf einer Upload-Seite hochgeladen.                                                                           |
| `file_link_created`      | Fernzugriff: Ein Werkzeug hat einen Download-Link angelegt.                                                                                 |
| `file_downloaded`        | Fernzugriff: Ein Download-Link wurde verwendet.                                                                                             |

Jede Zeile beginnt mit `ts` (der Zeitpunkt, ISO 8601) und `v`, der Version des Zeilenformats
(`1`), gefolgt von `event`. Im Fernzugriff folgen `account` und `grant`. Die übrigen Felder hängen
vom Ereignis ab:

| Feld          | Ereignisse                                                                     | Bedeutung                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`     | alle, nur im Fernzugriff                                                       | Die sevDesk-Konto-ID (im Bearer-Modus `bearer`, falls der Server sie nicht ermitteln konnte). Bei Dateizeilen das Konto, dessen Werkzeugaufruf die Upload-Seite oder den Link angelegt hat. |
| `grant`       | alle, nur im Fernzugriff                                                       | Die ID des OAuth-Zugangs oder `bearer`.                                                                                                                                                     |
| `callId`      | Schreibereignisse                                                              | Gemeinsam für alle Zeilen einer Aktion, von der Anfrage bis zum Ergebnis.                                                                                                                   |
| `tool`        | Schreibereignisse                                                              | Der Name des Werkzeugs.                                                                                                                                                                     |
| `tier`        | Schreibereignisse                                                              | `write`, `commit` oder `external`.                                                                                                                                                          |
| `argsHash`    | Schreibereignisse                                                              | Ein Hash des Werkzeugs und seiner Argumente (ohne `dryRun`).                                                                                                                                |
| `args`        | Schreibereignisse außer `approval_decided`                                     | Die Argumente: Token und Upload-IDs geschwärzt, versteckte Zeichen als sichtbare `\u{…}`-Escapes geschrieben, Zeichenketten bis 20.000 Zeichen.                                             |
| `previewHash` | `dry_run`, `confirmation_requested`, `approval_decided`, `executing`           | Ein Hash der Vorschau, die gezeigt und freigegeben wurde; bei Werkzeugen der Stufen `commit` und `external` umfasst er den englischen und den deutschen Text.                               |
| `preview`     | `dry_run`, `confirmation_requested`                                            | Die Vorschau, wie sie gezeigt wurde: `action` (ein Satz), `facts` (`label`, `value`), `warnings` und `irreversible`.                                                                        |
| `approval`    | `executing`                                                                    | Wie die Aktion freigegeben wurde: `elicit`, `browser`, `confirmation_off` oder `not_required`.                                                                                              |
| `reason`      | `confirmation_refused`                                                         | `replayed_or_expired` oder `mismatch` (für ein anderes Werkzeug oder andere Argumente erteilt).                                                                                             |
| `decision`    | `approval_decided`                                                             | `approved` oder `rejected`.                                                                                                                                                                 |
| `reference`   | `confirmation_requested` im Browser-Modus, `approval_decided`, Dateiereignisse | Der Referenzcode, den die Seite und das Ergebnis des Werkzeugs zeigen. Nicht geheim.                                                                                                        |
| `affected`    | `executed`, `failed`                                                           | Die geänderten Datensätze (`objectName`, `id`); bei `failed` die, die ein früherer Schritt bereits geändert hat.                                                                            |
| `error`       | `failed`                                                                       | Die Art des Fehlers, etwa `validation`, `not_found`, `auth`, `timeout`, `network`, `server`, `aborted`, `internal` oder `output_invalid`.                                                   |
| `kind`        | Dateiereignisse                                                                | `pdf`, `png`, `jpeg`, `xml`, `csv` oder `zip`.                                                                                                                                              |
| `bytes`       | Dateiereignisse                                                                | Die Größe der Datei.                                                                                                                                                                        |
| `sha256`      | Dateiereignisse                                                                | Der SHA-256 des Inhalts, hexadezimal. Dateizeilen enthalten nie den Dateinamen oder den Inhalt.                                                                                             |

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

Die Datei wird mit Modus 0600 angelegt, nur zum Anhängen geöffnet und nie über einen symbolischen
Link. Kann die Zeile `executing` nicht geschrieben werden, wird die Aktion nicht ausgeführt. Das
Log ist lokal und nicht fälschungssicher: Es hält für Sie fest, was dieser Server getan hat, und
schützt nicht vor jemandem, der den Rechner kontrolliert. `v` ändert sich nur, wenn ein Feld seine
Bedeutung ändert oder entfällt; neue Felder können ohne Änderung von `v` hinzukommen
([Compatibility](compatibility.md)).

## Dateien

Werkzeuge lesen und schreiben lokale Dateien nur dort, wo Sie es erlauben:

- **Lesen** (Belege, E-Rechnungen) nur innerhalb der Ordner aus `SEVDESK_FILE_DIRS`: Die echten
  Pfade werden geprüft, symbolische Links dürfen nicht nach außen führen, der Dateityp wird am
  Inhalt erkannt, und die Größe ist begrenzt.
- **Schreiben** (PDFs, E-Rechnungs-XML, CSV- und DATEV-Exporte) nur in `SEVDESK_OUTPUT_DIR`: nur
  neue Dateien, mit Modus 0600, nie überschreibend.

Ohne diese Einstellungen greift kein Werkzeug auf Ihre Festplatte zu. Im Fernzugriff gelangen
Dateien stattdessen über Seiten zum Hochladen und Download-Links in Ihrem Browser zum Server und
zurück; diese brauchen eine Browser-Sitzung Ihres sevDesk-Kontos ([remote.de.md](remote.de.md#dateien-hochladen-und-herunterladen)).

## Empfehlungen

- **Verwenden Sie einen eigenen sevDesk-Benutzer** für das Token, damit Sie dessen Token
  zurücksetzen können, ohne Ihre eigene Anmeldung anzurühren.
- **Beginnen Sie mit `read`.** Ergänzen Sie `write` für die ersten Sitzungen mit
  `SEVDESK_DRY_RUN=1`, dann `commit` und `external` nur, wenn Sie sie brauchen, und in einem
  Client, der Bestätigungen anzeigt.
- **Behalten Sie `elicit`**, wo der Client es unterstützt; verwenden Sie `browser`, wo nicht, und
  nie `off` für ein Konto mit echten Daten.
- **Setzen Sie `SEVDESK_AUDIT_LOG`**, sobald Sie eine Schreibstufe aktivieren.
- **Halten Sie das Token aus Konfigurationsdateien heraus**: Schlüsselbund des Betriebssystems,
  eine Token-Datei oder die Claude-Desktop-Erweiterung
  ([Konfiguration](configuration.de.md#das-token-im-schlüsselbund-ablegen)).
- **Erlauben Sie enge Ordner**: einen Belegordner für `SEVDESK_FILE_DIRS`, einen leeren
  Exportordner für `SEVDESK_OUTPUT_DIR`, nicht Ihr Home-Verzeichnis.
- **Laden Sie nur die Werkzeuggruppen, die Sie brauchen** (`SEVDESK_TOOLSETS`); lassen Sie
  `advanced` aus, solange keine Aufgabe es braucht.
- Prüfen Sie die Vorschau, bevor Sie freigeben. Sie entsteht aus dem, was das Werkzeug gerade
  gelesen hat, nicht aus dem, was das Modell sagt.

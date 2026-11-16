<!-- translated-from: docs/permissions.md sha256:8405988d460f -->

# Berechtigungen und Bestätigung

Ein sevDesk-API-Token kann alles, was sein Benutzer kann, und zwar im gesamten Konto: Es gibt keine
einschränkbaren Rechte, keine reinen Lese-Tokens und kein Ablaufdatum. sevDesk hat außerdem keine
Testumgebung, jeder Schreibvorgang ändert also deine echte Buchhaltung. Deshalb bringt der Server
seine eigenen minimalen Rechte mit: Berechtigungsstufen, die du wählst, eine Bestätigung durch
einen Menschen für jeden bindenden Schritt, Probeläufe und ein lokales Audit-Log. Diese Seite
erklärt, wie du jedes davon verwendest; die Garantien hinter den Bestätigungen stehen unter
[Bestätigung durch einen Menschen](security/confirmation.de.md), das Bedrohungsmodell in der [Sicherheitsrichtlinie](../SECURITY.de.md).

## Stufen

Jedes Werkzeug gehört zu genau einer Stufe. Lesen und Schreiben teilen sich nie ein Werkzeug.

| Stufe      | Was sie erlaubt                                                                                                                                                                                                                          | Bestätigung |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `read`     | Auflisten, abrufen, suchen, Auswertungen, PDF-Vorschauen (die ein Dokument nie als versendet markieren), E-Rechnungen auslesen, Dokumentdateien und CSV-Exporte in `SEVDESK_OUTPUT_DIR` speichern (oder als Download-Link). Immer aktiv. | nein        |
| `write`    | Kontakte, Artikel, Entwürfe von Rechnungen, Gutschriften, Aufträgen und Belegen, Mahnungen, der DATEV-Export. Umkehrbar oder harmlos.                                                                                                    | nein        |
| `commit`   | Fertigstellen, Zahlungen buchen, Kontoumsätze zuordnen, Umsätze als privat markieren, stornieren, festschreiben (GoBD), zurücksetzen, Belegentwürfe löschen. Rechtlich bindend oder schwer rückgängig zu machen.                         | **ja**      |
| `external` | Rechnungen, Gutschriften und Aufträge per E-Mail versenden. Erreicht Dritte.                                                                                                                                                             | **ja**      |

Für Aufträge gilt dieselbe Linie: Ein Lieferschein zu einem Angebot ist ein `write`-Entwurf, ein
Angebot anzunehmen oder abzulehnen dagegen `commit`, ebenso seine Auftragsbestätigung anzulegen,
weil sevDesk das Angebot dabei als angenommen markiert.

Die Stufen wählst du mit `SEVDESK_ALLOW`, zum Beispiel `SEVDESK_ALLOW=write` oder
`SEVDESK_ALLOW=write,commit`; `all` aktiviert alle Stufen. `SEVDESK_READ_ONLY=1` schaltet alles
außer `read` ab, unabhängig davon, was in `SEVDESK_ALLOW` steht. Die [Werkzeugreferenz](tools.md)
nennt die Stufe jedes Werkzeugs.

Eine sinnvolle Reihenfolge: Beginne mit `read`, ergänze `write` mit einem
[Probelauf](#probelauf), und aktiviere `commit` und `external` erst, wenn du den Entwürfen
vertraust und dein Client Bestätigungen anzeigt
([Clients](clients.de.md#bestätigung-je-client)).

## Was das Modell sieht

- **Nur die Werkzeuge der aktivierten Stufen.** Werkzeuge darüber werden gar nicht erst
  registriert: Sie stehen nicht in `tools/list`, das Modell kann sie also weder sehen noch
  aufrufen.
- **Was deaktiviert ist und wer es ändern kann.** Die Anweisungen des Servers nennen die
  aktivierten und deaktivierten Stufen und sagen dem Modell, dass du, nicht es, weitere
  freischaltest und dass es ein fehlendes Werkzeug nicht umgehen darf. `sevdesk_account_info`
  meldet Stufen, Werkzeuggruppen, Nur-Lesen, Probelauf und Bestätigungsart, damit das Modell es
  weiß, bevor es etwas versucht.
- **Passende Prompts.** Ein [Prompt](../README.de.md#prompts) erscheint nur, wenn die Werkzeuge,
  die er braucht, aktiviert sind; ein Schritt, dessen Werkzeuge deaktiviert sind, wird durch einen
  Hinweis auf die Einstellung ersetzt, die ihn freischaltet.
- **Nie ein Weg zur Freigabe.** Kein Argument eines Werkzeugs gibt etwas frei. Ein
  `confirm: true`, das das Modell setzt, gilt nicht als Bestätigung.

Die Stufe wird bei jedem Aufruf erneut durchgesetzt und im HTTP-Client, der eine Anfrage an einen
sevDesk-Endpunkt oberhalb der Stufe des aufrufenden Werkzeugs ablehnt
([Sicherheitsmodell](architecture/safety.de.md#durchsetzung-an-drei-stellen)). Im Fernzugriff mit OAuth bekommt jede Verbindung
die Stufen, die auf der Zustimmungsseite angehakt wurden, höchstens aber die aus `SEVDESK_ALLOW`
([Fernzugriff (HTTP)](remote.de.md#stufen-je-zugang)).

## Wie ein Schreibvorgang abläuft

1. **Argumente prüfen.** Unbekannte Parameter werden mit Namen abgelehnt, ebenso Text mit Zeichen,
   die ein Mensch nicht sehen würde
   ([versteckte Zeichen](security/confirmation.de.md#versteckte-zeichen-in-argumenten)).
2. **Vorbereiten.** Das Werkzeug liest, was es braucht, mit einem Client, der nicht schreiben
   kann, prüft den Aufruf lokal (Status, Beträge, Steuerregel × Steuersatz, Buchungskonten,
   Dubletten, offene Beträge) und erstellt eine Vorschau: die Aktion in einem Satz, Warnungen und
   die wichtigsten Angaben wie Beträge, Empfänger und den vollständigen E-Mail-Text. Die meisten
   Fehler werden hier abgelehnt, bevor etwas gesendet wird.
3. **Probelauf?** Dann ist die Vorschau das Ergebnis (Status `dry_run`), und der Aufruf endet.
4. **Bestätigen.** Bei `commit` und `external` siehst du die Vorschau und gibst frei oder lehnst
   ab ([Bestätigungsarten](#bestätigungsarten)). Der Server bereitet danach erneut vor; hat sich
   der Datensatz in der Zwischenzeit geändert, fragt er erneut, statt auszuführen.
5. **Ausführen.** Das [Audit-Log](permissions/audit-log.de.md) verzeichnet `executing` (kann diese
   Zeile nicht geschrieben werden, wird nichts gesendet), dann sendet das Werkzeug die Anfrage mit
   einem Client, der auf seine Stufe beschränkt ist. Schreibvorgänge werden nie wiederholt, damit
   eine Zeitüberschreitung keine Dublette erzeugen kann.
6. **Zurücklesen.** Das Ergebnis wird aus sevDesk zurückgelesen und zurückgegeben (Status
   `done`). Ein Schreibvorgang aus mehreren Schritten, der mittendrin scheitert, meldet die
   Datensätze, die er bereits geändert hat.

Ein Schreibwerkzeug antwortet mit einem von vier Status: `done`, `dry_run`, `approval_pending`
(wartet auf deine Entscheidung im Browser) oder `declined`.

## Probelauf

Ein Probelauf führt jede Prüfung eines Schreibvorgangs aus und gibt dessen Vorschau zurück, ohne
etwas an sevDesk zu senden und ohne jemanden zu fragen. Lesezugriffe finden trotzdem statt, die
Vorschau gibt also den aktuellen Datenstand wieder.

- Pro Aufruf: Das Modell übergibt `dryRun: true`. Du kannst einfach danach fragen:

  > Zeig mir zuerst als Probelauf, was du tun würdest.

- Für alles: `SEVDESK_DRY_RUN=1`. Jedes Schreibwerkzeug gibt dann nur seine Vorschau zurück. Eine
  gute Einstellung für die ersten Sitzungen mit einer neuen Stufe.

## Bestätigungsarten

`SEVDESK_CONFIRM` legt fest, wie du Aufrufe der Stufen `commit` und `external` bestätigst.
Aufrufe der Stufe `write` brauchen keine Bestätigung. Gleich in welcher Art ist eine Bestätigung
10 Minuten gültig, wird einmal verwendet und deckt genau den Aufruf und die Vorschau ab, die du
gesehen hast ([was eine Freigabe
bindet](security/confirmation.de.md#was-eine-freigabe-bindet)).

### elicit

Die Voreinstellung. Der Client zeigt über MCP-Elicitation die Vorschau und einen Schalter „Approve
this action“, der zunächst aus ist. Ablehnen, Abbrechen oder ein nicht umgelegter Schalter ergeben
`declined`: Nichts ändert sich.

Nicht jeder Client unterstützt Elicitation ([Clients](clients.de.md#bestätigung-je-client)). Ein
Client, der nicht fragen kann, bekommt einen Fehler, der genau das sagt, und nichts wird gesendet;
wechsle dann zu `browser`. Die Elicitation verlässt sich darauf, dass die Client-Anwendung das
Formular ehrlich zeigt
([worauf sich die Elicitation verlässt](security/confirmation.de.md#worauf-sich-die-elicitation-verlässt)).

### browser

Der Aufruf gibt `approval_pending` mit einem kurzen Referenzcode zurück. Du gibst auf einer
Webseite frei und bittest den Assistenten dann, es mit denselben Argumenten erneut zu versuchen.

- **Über stdio** stellt der Server die Seite selbst auf `127.0.0.1` bereit und öffnet sie in deinem
  Standardbrowser. Mit `SEVDESK_CONFIRM_OPEN=0` schreibt er den Link nur in sein Log (stderr). Der
  Link ist geheim und erreicht nie das Modell
  ([die lokale Freigabeseite](security/confirmation.de.md#die-lokale-freigabeseite)).
- **Im Fernzugriff** warten Freigaben im Freigabe-Postfach des Servers (`/approvals`), das du
  nach der Anmeldung öffnest ([Freigaben](remote/approvals.de.md)).

Höchstens fünf Freigaben warten gleichzeitig. Die Seite zeigt denselben Referenzcode wie das
Ergebnis des Werkzeugs, sodass du beide zuordnen kannst.

Die Seite gibt es auf Deutsch und Englisch; sie richtet sich nach der Sprache deines Browsers. Auf
Deutsch ist auch die Vorschau deutsch (die Aktion, die Angaben, die Warnungen, Beträge und Daten
in deutscher Schreibweise), während der Assistent, Probeläufe und das Audit-Log den englischen
Text derselben Anfrage behalten: Ordne beide über den Referenzcode zu. Die Seite zeigt, wie
lange die Anfrage noch gültig ist, und nimmt die Schaltflächen weg, sobald sie abgelaufen ist. Sie
führt kein Skript aus und lädt nichts von anderen Servern.

Bevorzuge `elicit` in agentischen Clients, die Befehle ausführen können: Ein Agent, der das Log
des Servers lesen oder deinen Browser steuern kann, könnte selbst freigeben
([Grenzen](security/confirmation.de.md#grenzen-des-browser-modus)).

### off

Keine Bestätigung. Nur zusammen mit `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1` zulässig und nicht
empfohlen: Dann entscheidet das Modell allein, wann eine Rechnung fertiggestellt, gebucht,
storniert oder per E-Mail versendet wird. Die Claude-Desktop-Erweiterung bietet diese Art nicht an.

## Audit-Log

Mit `SEVDESK_AUDIT_LOG=<path>` hängt der Server pro Ereignis jedes schreibenden Aufrufs eine
JSON-Zeile an: Vorschauen, Bestätigungen, Ausführungen und Fehlschläge. Ereignisse, Felder und die
Garantien der Datei stehen unter [Audit-Log](permissions/audit-log.de.md).

## Dateien

Werkzeuge lesen und schreiben lokale Dateien nur dort, wo du es erlaubst:

- **Lesen** (Belege, E-Rechnungen) nur innerhalb der Ordner aus `SEVDESK_FILE_DIRS`.
- **Schreiben** (PDFs, E-Rechnungs-XML, CSV- und DATEV-Exporte) nur in `SEVDESK_OUTPUT_DIR`: nur
  neue Dateien, nie überschreibend.

Ohne diese Einstellungen greift kein Werkzeug auf deine Festplatte zu. Wie Pfade und Dateiinhalte
geprüft werden, steht unter [Lokale Dateien](security/local.de.md#lokale-dateien). Im Fernzugriff
gelangen Dateien stattdessen über Upload-Seiten und Download-Links in deinem Browser zum Server und
zurück; diese brauchen eine Browser-Sitzung deines sevDesk-Kontos ([Dateien](remote/files.de.md)).

## Empfehlungen

- **Verwende einen eigenen sevDesk-Benutzer** für das Token, damit du dessen Token zurücksetzen
  kannst, ohne deine eigene Anmeldung anzurühren.
- **Beginne mit `read`.** Ergänze `write` für die ersten Sitzungen mit `SEVDESK_DRY_RUN=1`, dann
  `commit` und `external` nur, wenn du sie brauchst, und in einem Client, der Bestätigungen
  anzeigt.
- **Behalte `elicit`**, wo der Client es unterstützt; verwende `browser`, wo nicht, und nie `off`
  für ein Konto mit echten Daten.
- **Setze `SEVDESK_AUDIT_LOG`**, sobald du eine Schreibstufe aktivierst.
- **Halte das Token aus Konfigurationsdateien heraus**: Schlüsselbund des Betriebssystems, eine
  Token-Datei oder die Claude-Desktop-Erweiterung ([Profile](configuration/profiles.de.md)).
- **Erlaube enge Ordner**: einen Belegordner für `SEVDESK_FILE_DIRS`, einen leeren Exportordner
  für `SEVDESK_OUTPUT_DIR`, nicht dein Home-Verzeichnis.
- **Lade nur die Werkzeuggruppen, die du brauchst** (`SEVDESK_TOOLSETS`); lass `advanced` aus,
  solange keine Aufgabe es braucht.
- **Prüfe die Vorschau, bevor du freigibst.** Sie entsteht aus dem, was das Werkzeug gerade gelesen
  hat, nicht aus dem, was das Modell sagt. Lies vor dem Fertigstellen, Versenden oder Festschreiben
  eines Dokuments dessen Anschrift, Texte und Positionen in der Vorschau: Ein Entwurf lässt sich
  ohne Bestätigung ändern, der Fußtext dort (etwa die Bankverbindung) ist also der, der verbindlich
  wird. Eine Warnung in der Vorschau nennt, was sie nicht zeigt, etwa das Layout des PDF
  ([Vorschauen verbindlicher Dokumente](security/confirmation.de.md#vorschauen-verbindlicher-dokumente)).

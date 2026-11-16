<!-- translated-from: docs/adr/0010-server-pages-in-two-languages.md sha256:c5523f0799ad -->

# ADR 0010: Die Seiten des Servers: ein Design, zwei Sprachen, Vorschauen auf Deutsch

- **Status:** Vorgeschlagen
- **Datum:** 2026-11-10
- **Ändert:** [ADR 0003](0003-tiers-and-human-confirmation.de.md) (die Vorschau zur Bestätigung gibt
  es auf Englisch und Deutsch, und der Hash der Vorschau deckt beide ab) sowie die Seiten aus
  [ADR 0003](0003-tiers-and-human-confirmation.de.md),
  [ADR 0007](0007-approval-inbox-over-http.de.md) und [ADR 0008](0008-file-transfer-over-http.de.md)
  (ihr Aussehen, ihre Sprache und ihre Content-Security-Policy)

## Kontext

Der Server zeigt einem Menschen zehn Seitenlayouts: die Freigabeseite (die lokale und die des
Postfachs), das Postfach, die Anmeldung, die beiden Schritte der Zustimmung, die Upload-Seite und
ihre Bestätigung sowie die Seiten, die ein Ergebnis oder einen Fehler melden. Es waren ungestaltete
Seiten in der Systemschrift mit zwei fast gleichen Stylesheets, nur auf Englisch, und sie hatten
nichts damit gemein, wie sich das Projekt sonst zeigt (`sevdeskmcp.lanfermann.dev`).

Das wiegt schwerer als bei einer Verwaltungsseite:

- Auf diesen Seiten entscheidet ein Mensch über rechtlich bindende Buchhaltung. Die Kunden von
  sevDesk sind deutsche Unternehmen, und wer freigibt, ist oft nicht die Person, die den Server
  eingerichtet hat. Wer „enshrine“ oder „partial booking“ im Kopf übersetzen muss, gibt weniger
  sorgfältig frei.
- Eine Seite, die neben dem Produkt, für das sie handelt, unfertig wirkt, lädt zum falschen Reflex
  ein: entweder Misstrauen gegenüber einer berechtigten Anfrage oder schnelles Freigeben, um sie
  loszuwerden.
- Die Vorschau, die ein Mensch freigibt, ist vertrauenswürdiger Text, den die Werkzeuge auf
  Englisch für das Modell schreiben ([ADR 0003](0003-tiers-and-human-confirmation.de.md)). Eine
  deutsche Seite um eine englische Vorschau übersetzt alles außer dem Teil, auf den es ankommt.

Die Einschränkungen der früheren Entscheidungen bleiben: kein Skript, jeder Wert maskiert, kein
Einbetten in Frames, Formulare, die nur an den Server senden, nichts von anderen abgerufen, Seiten
nie im Cache.

## Entscheidung

**Eine Seitenschicht.** `src/pages/` enthält, was alle Seiten teilen: ein Template-Tag, das jeden
eingesetzten Wert maskiert (`markup`), die Farb- und Schrift-Tokens aus dem Designsystem der
Website (Papier und Tinte, Tiefe aus geschichteten Schatten, Archivo und Martian Mono), ein
Stylesheet, einen Rahmen, die Komponenten und die Icons (Inline-SVG). Die Renderer bleiben, wo sie
waren (`src/safety/approval-page.ts`, `src/http/oauth/consent-page.ts`,
`src/http/transfer-pages.ts`), und bauen darauf auf. Stempelviolett ist dem einen vorbehalten, was
ein Modell nie kann: der Schaltfläche zum Freigeben und dem Stempel auf der Seite nach einer
Entscheidung. Hell und dunkel richten sich nach dem Browser.

Weiterhin kein Skript. Was sonst ein Skript erledigen würde, übernimmt CSS: Der Server schreibt die
Sekunden, die einer Anfrage bleiben, in den Style-Block der Seite, ein Balken läuft über diese Zeit
leer, und bei null blendet ein Keyframe die Schaltflächen aus und zeigt, dass die Anfrage abgelaufen
ist. Der absolute Ablaufzeitpunkt bleibt für Browser, die nichts davon können, auf der Seite stehen.

**Schriften und das Icon kommen vom Server selbst.** Sie sind in den Build eingebettet
(`pnpm pages:assets` schreibt `src/pages/assets.generated.ts`, ein Test prüft auf Abweichungen)
und werden von beiden Servern unter `GET /assets/<name>.<hash>.<ext>` ausgeliefert: unveränderlich,
`nosniff`, `Cross-Origin-Resource-Policy: same-origin`, 404 für jeden anderen Namen. Die Richtlinie
der Seiten gewinnt genau das hinzu:

```
default-src 'none'; style-src 'nonce-…'; font-src <origin>/assets/; img-src <origin>/assets/;
form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

Die Quellen sind auf den Pfad beschränkt, nicht auf `'self'`: Ein GET auf demselben Origin ist hier
nicht immer harmlos (`GET /files/<id>` zählt einen Download), und die Seiten brauchen nichts
außerhalb von `/assets/`.

**Deutsch und Englisch, gewählt vom Browser.** Jede Antwort wählt die Sprache aus
`Accept-Language` (die erste unterstützte; Englisch, wenn keine passt) und sagt das
(`<html lang>`, `Content-Language`, `Vary: Accept-Language`). Die Texte stehen in
`src/pages/text/en.ts` und `de.ts`; der deutsche Katalog hat den Typ des englischen, ein fehlender
Text kompiliert also nicht. Es gibt keinen Sprachumschalter und kein Cookie.

**Jedes Werkzeug, das ein Mensch bestätigt, schreibt seine Vorschau auch auf Deutsch.** Ein
`commit`- oder `external`-Werkzeug gibt `previewDe` neben `preview` zurück; der Typ von
`defineWriteTool` verlangt es. Beide entstehen aus denselben Daten an derselben Stelle
(`src/domain/preview-text.ts`: Helfer nehmen die Sprache entgegen, und ein Satz, den eine Prüfung
erzeugt, trägt beide Fassungen), mit Beträgen und Daten in deutscher Schreibweise, allein durch
String-Operationen. Bevor jemand gefragt wird, prüft der Schreibablauf das Paar: jede eine
vollständige Vorschau, gleich viele Angaben und Warnungen in der einen wie in der anderen, dasselbe
`irreversible`. Ein Paar, das abweicht, lässt den Aufruf scheitern; nichts wird gezeigt, als wäre
es vollständig.

Der Hash der Vorschau deckt beide Texte ab, eine Freigabe ist also an das gebunden, was jeder der
beiden Leser gesehen hat, und eine Änderung an einer der beiden Fassungen fragt erneut. Die
Freigabeseiten zeigen einem deutschen Leser die deutsche Vorschau. Das Modell, Probeläufe, das
Audit-Log und die eigene Bestätigungsabfrage eines Clients (Elicitation) behalten den englischen
Text: Dort gibt es keine Browsersprache, nach der man gehen könnte, und sie werden von Modellen
gelesen.

## Folgen

- Vorteil: Die Seite, auf der ein Mensch entscheidet, liest sich wie das Produkt, zu dem sie gehört,
  und spricht die Sprache des Lesers, auch in dem Satz, der sagt, was geschehen wird, und in den
  Warnungen.
- Vorteil: Die Sicherheitseigenschaften sind unverändert oder strenger. Maskieren ist jetzt die
  Voreinstellung des Template-Tags statt eines Aufrufs, an den jeder Renderer denken muss; ein Test
  stellt jede Seite in jedem Zustand und in beiden Sprachen dar und prüft sie gegen das, was die
  Richtlinie blockieren würde.
- Vorteil: Eine Freigabe deckt weiterhin den vollständigen Text ab (ADR 0003), jetzt in beiden
  Sprachen.
- Nachteil: Jedes bestätigte Werkzeug hat zwei Fassungen, die stimmen müssen. Die Prüfung des Paars
  garantiert dieselbe Form, nicht dieselbe Bedeutung: Ein deutscher Satz kann falsch sein, während
  die Struktur stimmt. Zusammengehalten wird das dadurch, dass beide Fassungen im Code nebeneinander
  stehen, dass `test/integration/write-previews-de.test.ts` die deutsche Vorschau jedes bestätigten
  Werkzeugs in einer prüfbaren Datei als Snapshot festhält und dass `pnpm pages:preview` jeden
  Seitentext in beiden Sprachen nebeneinander auflistet.
- Nachteil: Der deutsche Leser und das Modell sehen dieselbe Anfrage in anderen Worten und anderer
  Schreibweise (`1.190,00 EUR` und `1190.00 EUR`). Über den Referenzcode werden beide zugeordnet,
  wie bisher.
- Nachteil: Der Build wächst um etwa 290 KB (drei Schriftdateien und das Icon, Base64). Die
  Schriften stehen unter der SIL Open Font License; ihre Texte liegen in `licenses/` und werden mit
  dem Paket, dem Image und der Erweiterung ausgeliefert.
- Neutral: Deutsche Sätze sind etwa ein Drittel länger, deshalb stieg die Anzeigegrenze einer
  Warnung von 500 auf 900 Zeichen. Ein Test prüft, dass keine Vorschau eines ausgelieferten
  Werkzeugs in einer der beiden Sprachen eine Grenze erreicht.
- Neutral: Titel von Werkzeugen gibt es nur auf Englisch. Die deutsche Seite nennt das Werkzeug
  (`sevdesk_invoice_finalize`) ohne seinen Titel.
- Neutral: Countdown und Ablaufwechsel brauchen einen aktuellen Browser. Ohne sie zeigt die Seite
  trotzdem, wann die Anfrage abläuft, und der Server lehnt eine verspätete Entscheidung so oder so
  ab.
- Neutral: Der Hash der Vorschau bestätigter Werkzeuge hat sich geändert. Ausstehende Freigaben
  leben im Speicher und überstehen den Neustart eines Upgrades ohnehin nicht.

## Erwogene Alternativen

- **Schriften von einem Schriftdienst oder CDN.** Die Freigabeseite würde dann jedes Mal einem
  Dritten mitteilen, dass jemand gleich etwas freigibt. Verworfen.
- **`font-src 'self'; img-src 'self'`.** Einfacher zu lesen, weiter als nötig (siehe oben).
- **Schriften als `data:`-URIs im Style-Block.** Keine Route, aber 290 KB bei jedem Seitenaufruf,
  nichts im Cache und `font-src data:` in der Richtlinie. Verworfen.
- **Ein wenig Skript für den Countdown und einen Sprachumschalter.** Ein einziges Skript ist das
  Ende von „diese Seiten führen keinen Code aus“; CSS deckt den Countdown ab, und der Browser kennt
  die Sprache bereits.
- **Die Vorschau dort übersetzen, wo sie gezeigt wird** (ein Wörterbuch auf der Seite oder ein
  Modell). Was ein Mensch freigibt, muss genau das sein, was das Werkzeug geschrieben hat und was
  der Hash abdeckt. Verworfen.
- **Nur die englische Vorschau hashen.** Eine Freigabe auf der deutschen Seite wäre dann nicht an
  den gelesenen Text gebunden: Eine Änderung allein an der deutschen Fassung würde nicht erneut
  fragen. Verworfen.
- **Vorschauen als Nachrichten-IDs mit Parametern, je Sprache dargestellt.** Die sauberere Form,
  falls je eine dritte Sprache dazukommt. Heute würde sie jede Vorschau und jeden Test, der eine
  liest, umschreiben; zwei Fassungen nebeneinander erreichen dasselbe mit weit weniger Änderung und
  lassen sich später in diese Form bringen, ohne zu ändern, was eine Seite zeigt.
- **Deutsch auch für die Elicitation-Abfrage und Probeläufe.** Nichts sagt dem Server, welche
  Sprache die Person an einem MCP-Client liest, und diese Texte liest auch das Modell. So belassen.

## Nachtrag 2026-11-16: ein neues Zeichen, die alte Palette

Die Website nutzt das Designsystem, aus dem diese Entscheidung ihre Tokens nahm, nicht mehr: Sie
ist auf das Lanfermann-System umgezogen (Sofia Sans, Indigo), und sevDesk MCP hat ein neues
Zeichen bekommen, „Summe“, ein großes Sigma aus vier Balken, dessen Fuß in der Akzentfarbe steht.
Die Seiten übernehmen das Zeichen (die Wortmarke im Rahmen, `assets/icon.svg` als Icon) und
behalten Palette und Schriften wie oben beschrieben, bis auch sie auf das neue System umziehen.
Der Fuß des Zeichens steht in Stempelviolett, wie zuvor der Haken des alten Zeichens; sonst bleibt
die Farbe dem Freigeben vorbehalten.

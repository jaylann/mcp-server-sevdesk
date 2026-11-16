<!-- translated-from: docs/adr/0011-approvals-workspace.md sha256:ca6d9a3ddd83 -->

# ADR 0011: Ein Arbeitsplatz für Freigaben, mit Entscheidungen über mehrere Anfragen

- **Status:** Vorgeschlagen
- **Datum:** 2026-11-16
- **Ändert:** [ADR 0003](0003-tiers-and-human-confirmation.de.md) (die lokale Freigabeseite: ein
  Arbeitsplatz je Server statt einer Seite je Anfrage, eine Sitzung statt eines Cookies je
  Anfrage), [ADR 0007](0007-approval-inbox-over-http.de.md) (das Postfach wird derselbe
  Arbeitsplatz, und eine Entscheidung kann mehrere Anfragen umfassen) und
  [ADR 0010](0010-server-pages-in-two-languages.de.md) (ein Skript, nur auf den Seiten des
  Arbeitsplatzes)

## Kontext

Im Browser-Modus (`SEVDESK_CONFIRM=browser`) entscheidet ein Mensch jeden Schritt der Stufen
`commit` und `external` auf einer eigenen Seite:

- **Lokal** öffnet jede Anfrage einen Tab. Ein Assistent, der drei Rechnungen fertigstellt und dann
  per E-Mail versendet, öffnet binnen einer Minute sechs Tabs, jeder mit eigenem Link, eigenem
  Cookie und eigenem Countdown, über dem, woran der Benutzer gerade arbeitet. Höchstens fünf können
  warten.
- **Entfernt** listet das Postfach die Anfragen des Kontos, aber eine Zeile verlinkt nur auf ihre
  Seite. Fünf Anfragen zu entscheiden kostet fünf Wege hin und zurück, und die Liste ändert sich
  erst, wenn der Benutzer sie neu lädt.

Buchhaltung kommt in Stapeln: Ein Monatsabschluss stellt mehrere Rechnungen fertig und bucht
mehrere Umsätze, und wer freigibt, liest ähnliche Vorschauen hintereinander. Tabs, die sich stapeln,
laden zu dem Reflex ein, den [ADR 0010](0010-server-pages-in-two-languages.de.md) vermeiden wollte:
schnell freigeben, um sie loszuwerden. Die Elicitation, der Standard, ist nicht betroffen; dort
fragt der Client im Chat.

Was nach der Änderung gelten muss ([ADR 0003](0003-tiers-and-human-confirmation.de.md),
[ADR 0007](0007-approval-inbox-over-http.de.md), [Bestätigung](../security/confirmation.de.md)):

- Das Modell kann nie freigeben, und der lokale Link erreicht nie das Modell, ein
  Werkzeugergebnis oder das Audit-Log.
- Eine Freigabe bindet das Werkzeug, den Hash der Argumente, den Hash der englischen und deutschen
  Vorschau und bei verbindlichen Dokumenten den gespeicherten Datensatz. Sie gilt 10 Minuten, wird
  einmal verwendet, und der Server fragt erneut, wenn sich etwas geändert hat, das sie bindet.
- Vorschauen erscheinen vollständig, Warnungen zuerst, und die Schaltflächen kommen nach allem, was
  sie entscheiden.
- Höchstens fünf Anfragen warten je Konto.

## Entscheidung

**Ein Arbeitsplatz, dieselbe Seite in beiden Modi.** Eine Seite listet jede wartende Anfrage des
Kontos (Referenzcode, Werkzeug, die Aktion in einer Zeile, verbleibende Zeit) und die Anfragen, die
in den letzten Minuten entschieden wurden. Wer eine öffnet, sieht ihre vollständige Vorschau mit den
Schaltflächen zuletzt; nach der Entscheidung geht es zur nächsten wartenden Anfrage. Lokal ersetzt
der Arbeitsplatz die Seite je Anfrage, entfernt das Postfach unter `/approvals`. Ein Renderer
bedient beide.

**Entscheidungen über mehrere Anfragen, nur aus einer Durchsicht.** In der Liste angehakte Anfragen
öffnen eine Durchsicht: oben eine Zusammenfassung (wie viele, wie viele nicht rückgängig zu machen
sind, wie viele eine E-Mail versenden), dann jede ausgewählte Vorschau vollständig, eine nach der
anderen, dann ein Formular mit „N freigeben“ und „N ablehnen“.

- Der Server nimmt eine Entscheidung über mehrere Anfragen nur aus einer Durchsicht an, die er
  selbst gerendert hat: Das Formular trägt ein Kennzeichen (einen HMAC der Sitzung und der
  sortierten Ids), und jede andere Menge von Ids wird abgelehnt. Eine einzelne Anfrage ist eine
  Durchsicht von einer.
- Eine Durchsicht wird nur kleiner. Eine Anfrage, die abgelaufen ist, anderswo entschieden oder
  ersetzt wurde (ein geänderter Datensatz erzeugt eine neue Anfrage mit neuer Id), fällt heraus und
  wird gemeldet; sie wird nie mit den übrigen freigegeben.
- Jede Anfrage wird an ihrem eigenen Datensatz entschieden, mit einer eigenen Audit-Zeile
  `approval_decided`. Die Zeilen einer Entscheidung teilen eine Stapel-Id und ihre Größe, sodass
  eine fehlende Zeile auffällt.
- Höchstens fünf Anfragen je Entscheidung, die Grenze der wartenden. Nichts auf diesen Seiten ist
  fixiert oder klebt am Rand, sodass die Schaltflächen unter dem bleiben, was sie entscheiden; ein
  Test prüft das Stylesheet.

**Lokal: eine Sitzung je Browser, ein neuer Link nur, wenn kein Arbeitsplatz offen ist.** Das
ersetzt Link, Cookie und Formular-Token je Anfrage aus ADR 0003.

- Der Startlink bleibt ein Ticket zur einmaligen Verwendung (`/open/<ticket>`, 256 Bit) und die
  einzige URL, die der Server ins Log schreibt oder dem Öffner übergibt. Seine erste Verwendung legt
  eine Sitzung an und leitet zum Arbeitsplatz unter einem zufälligen Pfad weiter (`/w/<pfad>/`, 256
  Bit), der nie im Log steht.
- Das Cookie gilt nur für diesen Pfad: HttpOnly, `SameSite=Strict`, 12 Stunden. Browser trennen
  Cookies nicht nach Port, ein Cookie für `/` auf `127.0.0.1` erreichte also jeden anderen lokalen
  Server, den der Browser besucht ([Sicherheit entfernt](../security/remote.de.md) sagt dasselbe
  für ein Postfach über einfaches http); der zufällige Pfad hält es von ihnen fern. Eine
  Entscheidung braucht weiterhin das CSRF-Token der Sitzung, ein `Origin` vom selben Ursprung (oder
  `Sec-Fetch-Site: same-origin`) und den richtigen `Host`.
- Eine neue Anfrage öffnet nichts, solange ein Arbeitsplatz offen ist: Seine Seite hält die
  Live-Verbindung oder hielt sie in den letzten Sekunden. Die Anfrage erscheint dort, und die
  Logzeile nennt ihren Referenzcode. Sonst erzeugt der Server ein neues Ticket (das vorige, noch
  unbenutzte gilt dann nicht mehr) und öffnet es.
- Ein Ticket, das ein zweites Mal verwendet wird, aus einem anderen Browser, beendet jede Sitzung
  des Servers und zieht jede Anfrage zurück, die wartet oder freigegeben, aber noch nicht
  ausgeführt ist. Der Server kann nicht erkennen, welcher der beiden Browser der des Benutzers ist;
  alles zu beenden ist die Antwort, die dem falschen nichts in Reichweite lässt. Jede Seite und das
  Log sagen es, und der Assistent fragt erneut.
- Höchstens drei Sitzungen zugleich; eine vierte beendet die älteste.

**Entfernt: Anmeldung und Sitzung des Postfachs bleiben** (ADR 0007). Das Entscheidungsformular
erhält das Kennzeichen der Durchsicht, und jede Id wird gegen das Konto der Sitzung geprüft; eine
Id eines anderen Kontos wird als unbekannt gemeldet und nirgends entschieden.

**Ein Skript, nur auf den Seiten des Arbeitsplatzes.** Das ändert „kein Skript“ aus ADR 0010. Es
ist eine Datei, `assets/approvals.js`, eingebettet und wie die Schriften unter `/assets/`
ausgeliefert, mit Subresource Integrity. Die Richtlinie der Arbeitsplatzseiten erlaubt genau diese
Datei, Verbindungen nur zu den eigenen Pfaden des Arbeitsplatzes und Trusted Types. Das Skript:

- hält die Liste aktuell. Lokal meldet ein Strom von Server-Sent Events nur „etwas hat sich
  geändert“; entfernt lädt die Seite ihre Liste neu, wenn der Tab sichtbar wird, und alle 30
  Sekunden, solange er es ist, weil der HTTP-Router jede Antwort nach 120 Sekunden beendet. In
  beiden Fällen holt das Skript die Seite neu und tauscht Liste, Zähler und Titel aus: ein
  Renderer, keine Vorlagen im Browser.
- fügt Tasten hinzu: J und K (oder die Pfeiltasten) bewegen, X hakt an, A und D setzen den Fokus
  auf Freigeben oder Ablehnen und entscheiden nie („Ablehnen“ beginnt ebenfalls mit A), Enter auf
  der fokussierten Schaltfläche entscheidet wie ein Klick, Escape hebt die Auswahl auf.
- hat keinen eigenen Text und fügt kein Markup ein, das es selbst baut.

Jede Aktion funktioniert ohne das Skript: Links, ein GET-Formular für die Auswahl und
POST-Formulare, die zur nächsten Anfrage weiterleiten. Alle anderen Seiten (Anmeldung, Zustimmung,
Uploads, Ergebnisse) laufen weiterhin ohne Skript.

**Für das Modell ändert sich nichts.** Das Werkzeug gibt weiterhin `approval_pending` mit
Referenzcode und Ablaufzeit zurück, nie einen Link, und sein Text sagt, dass die Anfrage auf der
Seite Freigaben im Browser des Benutzers wartet. Nichts sagt dem Modell, dass Anfragen zusammen
entschieden werden können.

## Folgen

- Gut: ein Tab je Serverprozess, was immer der Assistent tut; neue Anfragen erscheinen dort, wo der
  Mensch schon ist.
- Gut: Ein Stapel ähnlicher Schritte wird in einem Zug gelesen und mit einem Klick entschieden;
  jeder Schritt erscheint trotzdem vollständig und wird an seinem eigenen Datensatz entschieden.
- Gut: dieselbe Seite und dieselben Tests für beide Modi.
- Schlecht: Lokal decken Cookie und Formular-Token nun eine Sitzung von bis zu 12 Stunden statt
  einer Anfrage ab. Wer einen gestohlenen Startlink verwendet, bevor der Browser des Benutzers es
  tut, kann bis zu fünf wartende Anfragen entscheiden, bis dieser Browser ankommt, statt einer. Der
  Rat bleibt: `SEVDESK_CONFIRM_OPEN=0` oder `elicit` auf einem Rechner, den man mit Menschen teilt,
  denen man nicht vertraut.
- Schlecht: Ein lokaler Angreifer, der ein Ticket zweimal verwendet, bricht jede wartende Anfrage
  ab. Der Benutzer sieht es; nichts wird ausgeführt.
- Schlecht: Ein Klick kann nun bis zu fünf verbindliche Schritte auslösen. Die Durchsicht zeigt
  jeden zuvor vollständig, und der Server lehnt jede andere Menge ab, aber nichts hält jemanden auf,
  der darüber hinwegscrollt.
- Schlecht: Die Seiten des Arbeitsplatzes führen ein Skript aus. Es ist eine geprüfte Datei unter
  einer Richtlinie, die nichts anderes zulässt, und die Seiten funktionieren ohne es; die Gründe aus
  ADR 0010 gelten weiter für jede andere Seite.
- Schlecht: Entfernt kommen Aktualisierungen bis zu 30 Sekunden spät, bis der Router eine Art
  Antwort kennt, die offen bleiben darf.
- Neutral: Zwei Serverprozesse auf einem Rechner (Claude Desktop und Claude Code zugleich) haben je
  einen Arbeitsplatz.

## Erwogene Alternativen

- **Eine Seite je Anfrage plus eine Liste.** Die Tabs blieben, und die Liste bräuchte ohnehin eine
  Sitzung.
- **Ein lokales Cookie für `/`.** Verworfen: Jeder andere lokale Server bekäme es.
- **Mehrere Anfragen aus der Liste freigeben, ohne Durchsicht.** Verworfen: Ein Klick würde
  Vorschauen verbindlich machen, die nie auf dem Bildschirm waren.
- **Tasten, die entscheiden (A gibt frei).** Verworfen: Ein Tastendruck landet bei dem, was gerade
  den Fokus hat, und die Entscheidung käme nicht mehr nach der Vorschau.
- **Eine JSON-API und Rendern im Browser.** Verworfen: zwei Renderer und Maskieren an zwei Stellen.
  Das Skript tauscht HTML aus, das der Server gerendert hat.
- **Neu laden per `<meta http-equiv="refresh">`, ohne Skript.** Verworfen: Es lädt eine Durchsicht
  neu, die der Benutzer gerade liest, und die Seiten verbieten `http-equiv`.
- **Eine Client-App aus dem Designsystem der Website.** Zurückgestellt bis zum Umzug der Seiten auf
  das neue Designsystem (ADR 0010, Nachtrag 2026-11-16); sie brächte ein Framework und ein
  Client-Bundle auf Seiten, die beides nicht brauchen.

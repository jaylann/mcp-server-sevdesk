<!-- translated-from: docs/adr/0007-approval-inbox-over-http.md sha256:64902e1eff54 -->

# ADR 0007: Freigabe-Postfach über HTTP

- **Status:** Angenommen; Browser-Sitzungen geändert durch
  [ADR 0008](0008-file-transfer-over-http.de.md) (sie öffnen auch die Seiten zum Hoch- und
  Herunterladen); Aussehen, Sprache und Richtlinie der Seiten geändert durch
  [ADR 0010](0010-server-pages-in-two-languages.de.md)
- **Datum:** 2026-11-09
- **Ändert:** [ADR 0003](0003-tiers-and-human-confirmation.de.md) (den Browser-Modus über HTTP)

## Kontext

[ADR 0003](0003-tiers-and-human-confirmation.de.md) verlangt für `commit`- und `external`-Werkzeuge
eine Bestätigung durch einen Menschen: standardmäßig über MCP-Elicitation oder über eine lokale
Freigabeseite (`SEVDESK_CONFIRM=browser`) für Clients ohne Elicitation. Die lokale Seite läuft auf
`127.0.0.1` des Rechners, auf dem der Server läuft, wird mit dem Öffner des Betriebssystems
geöffnet, und ihr Link ist eine Berechtigung, die das Modell nie erreicht. Nichts davon funktioniert
für einen entfernten Server:

- Der Server läuft anderswo; er kann den Browser des Benutzers nicht öffnen, und sein `127.0.0.1`
  ist nicht das des Benutzers.
- claude.ai, der wichtigste entfernte Client, bietet Berichten zufolge keine MCP-Elicitation
  (Berichte Dritter, Mitte 2026), und Clients aus der Zeit von 2025 lassen sich über zustandsloses
  HTTP gar nicht fragen ([ADR 0003](0003-tiers-and-human-confirmation.de.md), Folgen).
- Wie ADR 0003 festhielt, konnten entfernte Einrichtungen also nur `read` und `write` ausführen.
  Fertigstellen, Buchen oder Versenden aus claude.ai oder aus der mobilen Claude-App wäre unmöglich.

Der Fernzugriff bedient außerdem mehr als einen Zugang (Grant) und im OAuth-Modus mehr als ein
Konto aus einem Prozess. Die Freigaben aus ADR 0003 waren nur nach Werkzeug und Argumenten
geschlüsselt; eine Verbindung hätte also die Freigabe einer anderen verwenden können.

## Entscheidung

**Im HTTP-Modus verwendet `SEVDESK_CONFIRM=browser` ein Freigabe-Postfach, das der Server selbst
ausliefert**, unter `<public URL>/approvals` (`src/http/approval-routes.ts`). Elicitation bleibt der
Standard. Über stdio ändert sich nichts: die lokale Seite aus ADR 0003 (jetzt
`src/safety/approval-local.ts`).

**Die URL des Postfachs ist keine Berechtigung; der Browser weist das Konto nach.** Das Ergebnis des
Werkzeugs (`approval_pending`) nennt die URL des Postfachs, den Referenzcode und den Ablauf, und das
Modell darf alle drei sehen. Ohne Sitzung zeigt das Postfach nur ein Anmeldeformular und keine Daten
einer Freigabe. Ein Browser bekommt eine Sitzung auf einem von zwei Wegen:

- **Bei der OAuth-Zustimmung.** Der Browser, der die Zustimmungsseite abgeschlossen hat, auf der der
  Benutzer sein sevDesk-Token eingefügt hat, ist für dieses Konto angemeldet.
- **Durch Einfügen des sevDesk-Tokens.** Im OAuth-Modus wird es bei sevDesk und gegen
  `SEVDESK_OAUTH_ACCOUNTS` geprüft. Im Bearer-Modus muss es dem `SEVDESK_API_TOKEN` des Servers
  gleichen (Vergleich in konstanter Zeit). Das Bearer-Geheimnis meldet nie an: Der Client hält es,
  also könnte alles freigeben, was die Konfiguration des Clients lesen kann.

Anmeldeversuche sind auf 5 pro Minute und 20 pro Stunde je Client-Adresse begrenzt (IPv6 je /64).

**Das Sitzungs-Cookie.** `__Host-sevdesk_session`: versiegelt (kein sevDesk-Token darin), HttpOnly,
Secure, Pfad `/`, 12 Stunden gültig, mit einer neuen Sitzungs-ID bei jeder Anmeldung. Die Sitzung
steht im Zugangsspeicher und wird zusammen mit dem Zugang widerrufen, aus dem sie stammt; Abmelden
beendet sie. Ohne https (eine Testeinrichtung über Loopback) verzichtet das Cookie auf das Präfix
`__Host-` und auf `Secure`.

**`SameSite=Lax` plus CSRF-Tokens.** Der Benutzer folgt dem Link zum Postfach aus claude.ai heraus,
und das ist eine seitenübergreifende Navigation auf oberster Ebene. Ein `SameSite=Strict`-Cookie
würde bei diesem Klick nicht gesendet, und das Postfach würde jedes Mal erneut nach der Anmeldung
fragen. `Lax` sendet das Cookie bei diesem GET, aber nie bei einem seitenübergreifenden POST. Jede
Entscheidung ist ein POST, der außerdem ein an die Sitzung gebundenes CSRF-Token tragen muss (ein
HMAC der Sitzungs-ID unter dem CSRF-Schlüssel des Servers) und vom Postfach selbst kommen muss
(`Origin` gleich dem öffentlichen Origin oder `Sec-Fetch-Site: same-origin` ohne `Origin`; nie
`Origin: null`). GET-Anfragen ändern nichts. Die Seiten sind statisches HTML, jeder Wert ist
maskiert, mit einer strengen Content Security Policy, ohne Einbetten in Frames, und der Host wird
bei jeder Anfrage geprüft.

**Freigaben gehören zum Zugang und werden je Konto aufgelistet.** Jede Freigabe gehört dem
Prinzipal, der gefragt hat (Zugangs-ID oder `bearer`/`stdio`, dazu das Konto). Ein erneuter Versuch
nimmt nur eine Freigabe, die sein eigener Zugang angelegt hat; eine Verbindung kann also die
Freigabe einer anderen nicht verwenden, nicht einmal im selben Konto. Das Postfach listet und
entscheidet je Konto: Eine Sitzung für Konto A sieht alle Freigaben von A und sonst nichts.
Freigaben binden weiterhin Werkzeug, Hash der Argumente und Hash der Vorschau, laufen nach
10 Minuten ab und werden einmal verwendet (ADR 0003). Höchstens 5 Freigaben je Konto warten
gleichzeitig; ein Konto hält höchstens 20 Einträge und schafft Platz nur unter seinen eigenen. Der
Speicher hält insgesamt 100 Einträge. Ist er voll, kommt Platz nur von einem Konto, das mehr
Einträge hält als das fragende: Das größte solche Konto, das einen abgelehnten (sonst einen
wartenden) Eintrag hat, gibt seinen ältesten ab, und wenn nur freigegebene, ungenutzte Einträge
übrig sind, gibt das größte seinen ältesten freigegebenen ab; dessen Eigentümer wird beim erneuten
Versuch noch einmal gefragt, wie nach einem Ablauf. Ein Konto, das selbst die meisten hält, schafft
Platz unter seinen eigenen. So verliert kein Konto einen Eintrag an eines, das gleich viele oder
mehr hält. (Bis zum Review 2026-11, Runde 3, wurde ein freigegebener Eintrag nie für ein anderes
Konto verworfen, und das Anlegen wurde stattdessen abgelehnt: Fünf Konten mit je 20 ungenutzten
Freigaben sperrten dann jedes andere Konto aus.) Der Codec der Elicitation bindet denselben
Prinzipal, sodass ein `requestState`, der für ein Konto ausgestellt wurde, für ein anderes abgelehnt
wird.

**Aufteilung des Codes.** Der Freigabeserver aus ADR 0003 ist aufgeteilt in einen vom Transport
unabhängigen Speicher (`src/safety/approval-store.ts`), die lokale Seite (`approval-local.ts`) und
die Routen des Postfachs; die HTML-Helfer sind gemeinsam (`src/safety/web.ts`, `approval-page.ts`).

## Folgen

- Vorteil: `commit`- und `external`-Werkzeuge funktionieren aus claude.ai und den Claude-Apps heraus,
  mit derselben Vorschau, Bindung und einmaligen Verwendung wie über stdio.
- Vorteil: Freigeben braucht einen Nachweis des Kontos, keinen Link, der über das Modell, ein Log
  oder einen Screenshot nach außen gelangen könnte.
- Vorteil: Freigaben können nicht zwischen Konten oder Verbindungen wandern.
- Nachteil: Ein Agent, der den Browser des Benutzers steuern kann, während dieser angemeldet ist
  (Browser-Automatisierung, ein Werkzeug zur Computersteuerung), kann trotzdem selbst freigeben. Das
  Postfach schützt vor einem Modell, das nur redet, so wie die lokale Seite.
- Nachteil: Das Postfach fragt nach dem sevDesk-Token, eine nachgeahmte Seite könnte es also
  abgreifen. Benutzer dürfen es nur unter der Adresse ihres eigenen Servers einfügen; die
  Zustimmungsseite meldet den Browser an, die meisten Benutzer müssen es also nie im Postfach
  einfügen.
- Nachteil: Alle, die sich an einem Konto anmelden können, teilen sich sein Postfach und können über
  die Freigaben der anderen entscheiden. Sie halten das Token des Kontos ohnehin.
- Nachteil: Eine Sitzung hält in diesem Browser bis zu 12 Stunden. Auf einem gemeinsam genutzten
  Computer sollte man sich abmelden.
- Nachteil: Ausstehende Freigaben leben im Speicher: Ein Neustart macht sie ungültig, und das Modell
  fragt erneut.
- Nachteil: Bei vollem Speicher kann ein Konto, das die meisten Einträge hält, eine freigegebene,
  ungenutzte Anfrage an ein Konto verlieren, das weniger hält, und wird erneut gefragt. Den Speicher
  gegen ein Konto zu füllen braucht etwa so viele andere Konten, wie der Speicher Platz hat (100),
  jedes mit einem Eintrag.

## Erwogene Alternativen

- **Der Entwurf von stdio: ein geheimer Link je Freigabe.** Für HTTP verworfen: Der Link müsste den
  Menschen über das Ergebnis des Werkzeugs erreichen, das Modell würde ihn also sehen, und alles,
  was browsen kann, könnte ihn verwenden.
- **`SameSite=Strict`.** Verworfen: Das Cookie würde beim Klick aus claude.ai fehlen, der Benutzer
  sähe also jedes Mal das Anmeldeformular. CSRF-Tokens und die Prüfung des Origin schließen die
  Lücke, die `Lax` lässt.
- **Anmelden mit dem Bearer-Geheimnis.** Verworfen: Der Client hält es, es beweist also nichts über
  den Menschen.
- **Benachrichtigungen auf anderem Weg (E-Mail, Push).** Verworfen: Sie brauchen Dienste Dritter und
  trotzdem eine Seite, die das Konto nachweist.
- **Elicitation für `commit` und `external` verlangen.** Verworfen: claude.ai könnte sie dann nie
  nutzen.

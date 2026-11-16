<!-- translated-from: docs/adr/0003-tiers-and-human-confirmation.md sha256:3c9dddb10426 -->

# ADR 0003: Berechtigungsstufen und Bestätigung durch einen Menschen

- **Status:** Angenommen; der Browser-Modus über HTTP geändert durch
  [0007](0007-approval-inbox-over-http.de.md); die Sprachen der Vorschau und die Seiten geändert
  durch [0010](0010-server-pages-in-two-languages.de.md)
- **Datum:** 2026-11-07

## Kontext

- Ein sevDesk-API-Token hat **vollen Zugriff auf das Konto**: keine einschränkbaren Rechte, kein
  Ablauf, keine Variante nur zum Lesen.
- sevDesk hat **keine Testumgebung**. Jeder Schreibvorgang ändert die echte Buchhaltung.
- Manche Aktionen sind **rechtlich bindend oder unumkehrbar**: eine Rechnung fertigstellen, eine
  Zahlung buchen, stornieren, eine Gutschrift anlegen und `enshrine`, das ein Dokument nach GoBD
  festschreibt. Der Versand per E-Mail oder Brief **erreicht Dritte** und lässt sich nicht
  rückgängig machen.
- Daten, die aus sevDesk gelesen werden (Kontaktnamen, Beschreibungen, Verwendungszwecke von
  Überweisungen, Felder von E-Rechnungen), können von Außenstehenden stammen; **Prompt Injection**
  über Ergebnisse von Werkzeugen ist also realistisch.
- Die Freigabeabfragen der Clients unterscheiden sich von Client zu Client und stehen oft auf
  automatischer Freigabe. Ein Parameter `confirm: true` beweist nichts, denn das Modell füllt ihn
  aus.
- Ein Schreibvorgang mit Zeitüberschreitung kann trotzdem gelungen sein. Ihn zu wiederholen kann
  eine doppelte Rechnung oder eine doppelte Buchung erzeugen.

## Entscheidung

**Vier Stufen.** Jedes Werkzeug hat genau eine, und Lesen und Schreiben teilen sich nie ein
Werkzeug.

| Stufe      | Umfasst                                                                                          | Standard |
| ---------- | ------------------------------------------------------------------------------------------------ | -------- |
| `read`     | auflisten, abrufen, suchen, Auswertungen, PDF-Vorschau                                           | an       |
| `write`    | umkehrbare Änderungen: Kontakte, Artikel, Entwürfe, Entwürfe löschen                             | aus      |
| `commit`   | bindend oder unumkehrbar: fertigstellen, buchen, zuordnen, stornieren, Gutschrift, festschreiben | aus      |
| `external` | erreicht Dritte: Versand per E-Mail oder Brief                                                   | aus      |

`SEVDESK_ALLOW` führt die aktivierten Stufen auf; `SEVDESK_READ_ONLY=1` hat Vorrang davor.

**Durchsetzung auf drei Ebenen:**

1. **Registrierung:** Werkzeuge oberhalb der erlaubten Stufen werden nicht registriert, das Modell
   sieht sie also nie.
2. **Dispatcher:** Jeder Aufruf prüft die Stufe des Werkzeugs erneut gegen die Konfiguration.
3. **HTTP-Client:** Im Nur-Lese-Modus lehnt er jede Anfrage ab, die kein GET ist, und die GETs, die
   Zustand ändern (`getPdf` ohne `preventSendBy`, `sendByWithRender`). Jede Anfrage, die Daten
   ändert, trägt die Stufe des aufrufenden Werkzeugs (vom Framework eingetragen, nie vom Werkzeug),
   und der Client lehnt sie ab, wenn diese Stufe nicht aktiviert ist oder unter der Mindeststufe des
   Endpunkts liegt: `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, `resetToDraft`,
   `resetToOpen`, `changeParameter`, ein versendendes `getPdf` und DATEV-Exporte mit `enshrine`
   brauchen `commit`; `sendViaEmail` und `sendByWithRender` brauchen `external`; alles andere
   braucht `write`. Ein `write`-Werkzeug kann also nicht fertigstellen, buchen, stornieren oder
   versenden, auch nicht aus Versehen.

**Bestätigung durch einen Menschen für `commit` und `external`**, eingestellt mit
`SEVDESK_CONFIRM`:

Jedes Schreibwerkzeug ist geteilt in `prepare` (liest, prüft Vorbedingungen und erstellt eine
Vorschau: die Aktion, die wichtigsten Angaben, Warnungen und ob sie unumkehrbar ist; es bekommt
einen Client, der Schreibvorgänge ablehnt) und `execute` (macht genau die Schreibvorgänge aus der
Vorschau, mit einem Client, der die Stufe trägt). Das Framework (`src/tools/write-flow.ts`) führt
erst `prepare` aus, dann die Bestätigung, dann `execute`, sodass der Mensch immer das freigibt, was
tatsächlich ausgeführt wird:

- `elicit` (Standard): Der Werkzeugaufruf antwortet mit einer MCP-Elicitation über den Ablauf mit
  mehreren Runden (multi-round-trip request, MRTR) des SDK v2: ein Ergebnis `inputRequired` mit
  einem Formular aus einem einzigen Schalter („Approve this action“, zunächst aus) und der
  bereinigten Vorschau als Nachricht; der Client zeigt es an und wiederholt den Aufruf mit der
  Antwort. Der ausstehende `requestState` ist mit dem `createRequestStateCodec` des SDK versiegelt
  (HMAC-SHA256, ein zufälliger 32-Byte-Schlüssel je Server-Factory, also je Prozess, 10 Minuten
  gültig, an die Methode und den OAuth-Client gebunden) und wird vom SDK geprüft, bevor der erneute
  Aufruf das Werkzeug erreicht (`ServerOptions.requestState.verify`). Sein Inhalt bindet den Namen
  des Werkzeugs, einen SHA-256 über den Namen des Werkzeugs und das kanonische JSON der geparsten
  Argumente ohne `dryRun`, einen SHA-256 der kanonischen Vorschau, eine Nonce und eine Aufruf-ID für
  das Audit-Log. Beim erneuten Aufruf lehnt das Framework andere Argumente oder ein anderes Werkzeug
  ab, verbraucht die Nonce einmal (eine wiederverwendete Freigabe wird abgelehnt), führt `prepare`
  erneut aus und fragt noch einmal, mit dem Hinweis, dass sich der Datensatz geändert hat, wenn der
  Hash der Vorschau abweicht. Ablehnen, Abbrechen oder ein nicht umgelegter Schalter ergeben
  `declined` (keinen Fehler). Clients aus der Zeit von 2025 bedient die Kompatibilitätsschicht des
  SDK (`ServerOptions.inputRequired`, standardmäßig an), die eine echte `elicitation/create`-Anfrage
  über die Verbindung sendet und denselben Handler erneut betritt; ein Codepfad bedient also beide
  Generationen. Bevor es fragt, prüft das Framework die angegebenen Fähigkeiten des Clients so, wie
  das SDK es tut (die `_meta`-Hülle der Anfrage in der Generation von 2026, die Angabe beim
  `initialize` bei Verbindungen von 2025), und gibt einen Fehler zurück, mit dem man etwas anfangen
  kann, statt des Protokollfehlers des SDK, wenn die Formular-Elicitation fehlt.
- `browser`: Für Clients ohne Elicitation legt der Server eine lokale Freigabeseite an (ein
  HTTP-Server je Prozess, nur `127.0.0.1` und ein flüchtiger Port, gestartet bei der ersten
  Verwendung), öffnet sie im Browser des Benutzers mit dem Öffner des Betriebssystems
  (`SEVDESK_CONFIRM_OPEN`, standardmäßig an) und schreibt ihren Link nach stderr. Der Link erreicht
  das Modell nie: Das Werkzeug gibt `approval_pending` mit einem kurzen, nicht geheimen Referenzcode
  zurück, den auch die Seite zeigt, dazu den Ablauf und ob die Seite geöffnet wurde. Jede Freigabe
  bindet Werkzeug, Hash der Argumente und Hash der Vorschau, hat eine zufällige 256-Bit-ID, läuft
  nach 10 Minuten ab und wird einmal verwendet. Die Seite maskiert alles, hat eine strenge CSP und
  entscheidet über POST-Formulare, die auf ein CSRF-Token, ein `SameSite=Strict`-Cookie, Origin und
  Host geprüft werden. Das Modell ruft das Werkzeug erneut mit denselben Argumenten auf; das
  Framework führt die Aktion nur aus, wenn der Mensch freigegeben hat und die Vorschau unverändert
  ist.

  Der Link ist ein Startlink mit einem Ticket für eine Verwendung (`/open/<ticket>`, 256 Bit), nicht
  die Adresse der Seite (Review 2026-11, Runde 3). Der Öffner bekommt den Link als Argument, und
  eine Befehlszeile können andere lokale Benutzer lesen; vorher war die Adresse der Seite die
  Berechtigung, und wer sie abrief, bekam das Cookie und das Formular-Token. Jetzt setzt die erste
  Anfrage des Tickets das Cookie und leitet auf die Seite (`/approve/<id>`) weiter, die nur mit
  diesem Cookie etwas zeigt und entscheidet. Eine zweite Anfrage des Tickets aus einem anderen
  Browser zieht die Anfrage zurück, auch eine, die freigegeben, aber noch nicht ausgeführt wurde
  (der Server kann nicht erkennen, welcher der beiden der Browser des Benutzers ist; `withdraw` des
  Speichers), und der Öffner lehnt jede URL ab, die kein Startlink ist. Der Browser, der das Ticket
  verwendet hat, darf den Link erneut öffnen; ein vorausschauendes Laden (Prerendering) verbraucht
  es nicht.

- `off`: nur zusammen mit `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1` zulässig.

Ergebnisse von Schreibwerkzeugen sind verpackt als `{status: "done" | "dry_run" |
"approval_pending" | "declined", result?, preview?, approval?: {reference, expiresAt, opened}}`,
mit `result` (der eigenen Ausgabe des Werkzeugs) nur bei `done`.

Vorschauen werden vollständig gezeigt, Warnungen zuerst: Angaben behalten ihre Zeilenumbrüche (in
der Abfrage unter ihrer Beschriftung eingerückt, auf der Seite `pre-wrap`) und werden erst bei
12.000 Zeichen gekürzt, mit einer ausdrücklichen Markierung „[… N more characters not shown; open
the dry run to see everything]“. Der Hash der Vorschau deckt die vollständige rohe Vorschau ab.
Umgekehrt werden Argumente mit Zeichen, die ein Mensch nicht sehen würde (`findHiddenCharacters` in
`src/safety/fence.ts`: Steuer-, Format- und andere standardmäßig ignorierbare Zeichen, CR,
U+2028/2029, Tabulatoren), vor `prepare` abgelehnt, sodass sevDesk erreicht, was der Mensch gesehen
hat. Die Freigabeseite nimmt Entscheidungen nur von sich selbst an (`Origin` gleich ihrem Origin
oder `Sec-Fetch-Site: same-origin` ohne `Origin`; nie `Origin: null`, weshalb die Seite die
Referrer-Policy `same-origin` verwendet) und lässt höchstens fünf Freigaben gleichzeitig warten.

**Die Vorschau zeigt, was die Freigabe verbindlich macht.** Fertigstellen, Versenden und
Festschreiben wirken auf ein gespeichertes Dokument, und alles, was auf einem Entwurf gedruckt wird,
lässt sich mit der Stufe `write` schreiben, die niemanden fragt. Ihre Vorschauen führen deshalb den
gespeicherten Inhalt auf (`src/domain/lifecycle/content.ts`): den Anschriftsblock nach dem Kunden,
Betreff, Leistungszeitraum, Steuerregel und Hinweis, Kopf- und Fußtext wie gespeichert, die
Bedingungen eines Auftrags und jede Position mit ihren Zahlen und ihrem Text (bis zu 100, dann eine
Zeile mit der Zahl der nicht aufgeführten). Eine feste Warnung nennt, was nicht gezeigt wird
(Ansprechpartner, Land der Anschrift, Einheiten und verknüpfte Artikel, das Layout des PDF). Die
Angaben stammen aus demselben Lesevorgang wie das `binding` weiter unten, sodass Gezeigtes und
Gebundenes nicht auseinanderfallen können. Das Fertigstellen eines Belegs führt jedes Feld auf, das
`sevdesk_voucher_update_draft` schreibt (Daten, Positionen mit ihrem ganzen Buchungstext,
Anlagegut-Kennzeichen, ob eine Datei angehängt ist). Vorher (Review 2026-11, Runde 3) zeigten diese
Vorschauen nur Nummer, Kunde, Daten und Summen: Die Bindung stoppte eine Änderung, die nach der
Frage an den Menschen gemacht wurde, aber ein Fußtext, der vor der Frage geändert wurde, wurde
ungesehen freigegeben.

`enshrine` trägt immer eine Warnung „irreversible (GoBD)“.

**Kein Bestätigungsflag.** Werkzeuge haben kein `confirm`-Argument, das als Sperre wirkt.

**Keine Wiederholung von Schreibvorgängen.** POST und PUT werden nie wiederholt. Schreibvorgänge
suchen vorher nach Dubletten und lesen den Datensatz danach zurück. Nur GETs werden wiederholt.

**Unterstützende Maßnahmen:** Probelauf (`SEVDESK_DRY_RUN=1` oder `dryRun` je Aufruf: nur `prepare`
und die Vorschau, fragt nie), ein optionales Audit-Log im JSONL-Format (`SEVDESK_AUDIT_LOG`, Modus
0600, nur anhängend, Token geschwärzt; kann die `executing`-Zeile nicht geschrieben werden, wird
nichts gesendet), Einfassen nicht vertrauenswürdigen Texts und alle vier MCP-Annotationen für
Werkzeuge ausdrücklich an jedem Werkzeug angegeben.

## Folgen

- Vorteil: Eine Standardinstallation kann nichts ändern. Schreiben freizuschalten ist eine
  ausdrückliche, sichtbare Entscheidung.
- Vorteil: Bindende Aktionen brauchen einen Menschen, unabhängig von den eigenen
  Freigabeeinstellungen des Clients.
- Vorteil: drei unabhängige Ebenen, ein Fehler in einer öffnet also nicht alles.
- Nachteil: mehr Reibung für Benutzer, die volle Automatisierung wollen; sie müssen zweimal
  zustimmen (Stufen und Bestätigungsart).
- Nachteil: Clients ohne Elicitation brauchen den Browser-Modus, und der braucht einen lokalen
  Browser. Entfernte Einrichtungen ohne beides können nur `read` und `write` ausführen.
- Nachteil: Clients aus der Zeit von 2025 können über den zustandslosen HTTP-Modus gar nicht gefragt
  werden: Jede Anfrage bekommt ihre eigene Serverinstanz, die das `initialize` des Clients nie
  gesehen hat und ihm keine Anfragen senden kann. Sie bekommen einen Fehler, der auf
  `SEVDESK_CONFIRM=browser` verweist. Über stdio funktionieren Clients aus der Zeit von 2025 über
  die Kompatibilitätsschicht.
- Nachteil: Der Zustand der Bestätigung lebt in einem Prozess (zufälliger Schlüssel, Nonces und
  Freigaben im Speicher). Ein Neustart zwischen Frage und Freigabe macht die ausstehende Freigabe
  ungültig (der Benutzer wird erneut gefragt). **Arbeit für M5:** Der HTTP-Modus mit mehreren
  Prozessen braucht einen gemeinsamen Codec-Schlüssel und gemeinsame Speicher für Nonces und
  Freigaben oder Sticky Routing, bevor Bestätigungen über Instanzen hinweg funktionieren.
- Nachteil: Der Browser-Modus ist schwächer als Elicitation. Das Modell sieht den Link nie, aber ein
  Agent, der das stderr-Log des Servers lesen oder den Browser des Benutzers steuern kann, könnte
  trotzdem selbst freigeben; er hält nur ein Modell auf, das nichts kann außer reden. Elicitation
  bleibt der empfohlene Modus.
- Nachteil: Der Startlink schließt die Lücke der Prozessliste nur zum Teil. Ein anderer lokaler
  Benutzer, der das Ticket vorlegt, bevor der Browser des Benutzers es tut, hält die Seite, bis
  dieser Browser ankommt. Die Ankunft weist eine noch offene Anfrage zurück, aber eine Entscheidung
  in der Lücke bleibt bestehen: Die lokale Seite erreicht den Freigabespeicher nur über `get` und
  `decide`, und eine Entscheidung lässt sich nicht zurückziehen. Der Browser des Benutzers sagt dann,
  dass der Link anderswo verwendet und entschieden wurde. Eine noch nicht abgeholte Freigabe
  zurückzuziehen würde das schließen; Freigaben einige Sekunden zurückzuhalten wurde erwogen und
  verworfen, weil es jede Freigabe verzögert. Bis dahin: `SEVDESK_CONFIRM_OPEN=0` oder `elicit` auf
  einem Computer, den man mit Leuten teilt, denen man nicht vertraut.
- Nachteil: Ein Link, der zweimal in zwei verschiedenen Browsern (nicht demselben) geöffnet wird,
  bricht die Anfrage ab, und der Benutzer muss erneut fragen. Die Ablehnung wird als
  `approval_decided` mit `rejected` festgehalten.
- Nachteil: Elicitation vertraut der Client-Anwendung. Der Client zeigt das Formular und gibt die
  Antwort zurück; der signierte Zustand beweist, dass der Server gefragt hat, nicht, dass ein Mensch
  geantwortet hat, ein bösartiger oder kompromittierter Client kann also seine eigenen Aufrufe
  freigeben. Sie hält ein manipuliertes Modell auf, keinen feindlichen Client; für einen Client, dem
  man nicht vertraut, ist die Freigabe im Browser (Postfach) die stärkere Wahl.
  (Sicherheitsreview 2026-11, Befund 7; dokumentiert, der Standard bleibt unverändert.)
- Vorteil: Eine Freigabe deckt mehr ab als den Text der Vorschau. Ein Werkzeug kann ein `binding`
  hinzufügen (einen Digest von Inhalt, den die Vorschau weglässt); Fertigstellen, Festschreiben und
  Versenden binden das ganze gespeicherte Dokument, sodass zu einem Entwurf, der nach der Frage an
  den Menschen geändert wurde, erneut gefragt wird (Befund 1).
- Vorteil: Der Mensch liest das Dokument, das er verbindlich macht, nicht nur seine Nummer und
  Summen (Review 2026-11, Runde 3).
- Nachteil: Diese Vorschauen sind lang bei einem Dokument mit vielen Positionen oder langen Texten
  (keine zusätzliche Anfrage, aber mehr Text in der Abfrage und auf der Seite). Was weitere
  Lesevorgänge bräuchte, um mit Namen gezeigt zu werden (Ansprechpartner, Land, Einheiten), nennt
  stattdessen eine Warnung.
- Nachteil: Nach einer Zeitüberschreitung bei einem Schreibvorgang ist das Ergebnis unbekannt. Das
  Werkzeug meldet das und sagt dem Benutzer, wie er es prüft, statt es zu wiederholen.

## Erwogene Alternativen

- **Sich auf die Freigabeabfrage des Clients** und nur auf Annotationen verlassen. Verworfen: Das
  Verhalten unterscheidet sich je Client und steht oft auf automatischer Freigabe; Annotationen sind
  Hinweise, keine Durchsetzung.
- **Ein Parameter `confirm: true`.** Verworfen: Das Modell setzt ihn selbst.
- **`elicitInput` als Push in jeder Generation.** Verworfen: Die Revision 2026-07-28 hat keine
  Anfragen vom Server an den Client; der MRTR-Ablauf mit der Kompatibilitätsschicht des SDK deckt
  beide Generationen mit einem Handler ab.
- **Die ausstehende Bestätigung nur im Speicher des Servers halten, unter einem Token, das der
  Client zurückgibt.** Verworfen: Der zustandslose HTTP-Modus baut je Anfrage eine neue Instanz;
  ein signierter `requestState` mit einer Nonce-Menge je Prozess braucht keine Sitzung, und die
  Nonce macht Freigaben trotzdem einmalig.
- **Getrennte Pakete für nur lesend und voll.** Verworfen: schwerer zu installieren und zu pflegen,
  und das volle Paket braucht trotzdem eine Bestätigung.
- **Nur Erlaubnislisten je Werkzeug.** Als Hauptschutz verworfen: leicht falsch zu konfigurieren.
  Werkzeuggruppen und Stufen decken die üblichen Fälle ab.
- **Schreibvorgänge mit Idempotenzschlüsseln wiederholen.** Nicht möglich: sevDesk hat keine
  Idempotenzschlüssel.

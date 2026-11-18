<!-- translated-from: docs/security/confirmation.md sha256:09a2852d8197 -->

# Bestätigung durch einen Menschen

Was der Mensch sieht, bevor ein Aufruf der Stufe `commit` oder `external` läuft, wie diese Vorschau
gegen versteckten oder geänderten Text geschützt ist und was eine Freigabe bindet. Diese Seite
beschreibt die Garantien und ihre Grenzen; wie du eine Bestätigungsart wählst und verwendest, steht
unter [Berechtigungen](../permissions.de.md#bestätigungsarten).

## Die Vorschau

Jeder Aufruf der Stufen `commit` und `external` zeigt dem Menschen eine Vorschau, die das Werkzeug
aus dem gerade Gelesenen erstellt, nicht aus dem, was das Modell sagt: die Aktion in einem Satz,
dann die Warnungen und „This cannot be undone.“ bei unumkehrbaren Aktionen, dann die wichtigsten
Angaben (Datensatz, Kunde, Beträge, Daten, Empfänger, Texte).

- Der Satz der Aktion nennt ein Dokument mit seiner Art und ID („Rechnung 1001“), nie mit seiner
  Nummer: Auf einem Entwurf kann jeder in der sevDesk-Web-App eine beliebige Nummer eintragen, also
  steht die Nummer nur als Wert bei den Angaben, wie jeder andere aus sevDesk gelesene Text.
  Kontakte, Zahlungskonten, Tags und Artikel nennt er ebenso („Kontakt 1001“, „Zahlungskonto
  4002“), nie mit den Namen, die ihnen jemand in der Web-App gegeben hat.
- Aus den Werten werden unsichtbare, Bidi- und Steuerzeichen entfernt, damit gespeicherter Text dem
  Menschen nichts verbergen kann.
- Werte werden vollständig mit ihren Zeilenumbrüchen gezeigt (etwa ein E-Mail-Text), jede Zeile
  unter ihrer Beschriftung eingerückt, damit keine Zeile eines Werts sich als Beschriftung oder
  Warnung ausgeben kann.
- Ein Wert über 12.000 Zeichen endet mit „[… N more characters not shown; open the dry run to see
  everything]“, statt stillschweigend gekürzt zu werden, und der Probelauf gibt ihn vollständig
  zurück.
- Nur die Antwort des Menschen zählt. Kein Argument eines Werkzeugs kann etwas freigeben, und ein
  `confirm`-Flag, das das Modell setzt, wird nie als Freigabe angenommen.

## Vorschauen verbindlicher Dokumente

Fertigstellen, Versenden und Festschreiben machen ein gespeichertes Dokument verbindlich, und alles,
was auf einem Entwurf gedruckt wird (Texte, Anschrift, Positionen, Bedingungen), lässt sich mit der
Stufe `write` schreiben, die niemanden fragt. Deshalb führen diese Vorschauen das Dokument so auf,
wie sevDesk es speichert, nicht nur Nummer und Summen:

- die Anschrift, die auf dem Dokument steht, direkt nach dem Kunden (beide können sich
  unterscheiden); sind der Anschriftstext und die strukturierten Adressfelder beide gespeichert und
  verschieden, dann beide;
- Betreff, Leistungsdatum oder -zeitraum, Skonto, Steuerregel und Steuerhinweis, bei einem Auftrag
  die Zahlungs- und Lieferbedingungen, bei einer Gutschrift die Buchungskategorie und die Rechnung,
  die sie mindert;
- Kopftext und Fußtext wie gespeichert, mit ihren HTML-Tags, ungekürzt;
- jede Position: Bezeichnung, Menge × Einzelpreis (netto oder brutto), Steuersatz, Rabatt,
  Zeilensummen und ihr Text wie gespeichert. Bis zu 100 Positionen werden aufgeführt, so viele, wie
  die Entwurfswerkzeuge schreiben; eine längere Liste endet mit einer Zeile, die sagt, wie viele
  nicht aufgeführt sind und wie viele es insgesamt gibt;
- bei einem Beleg: Leistungsdatum oder -zeitraum, Fälligkeit, Steuerregel, jede Position mit
  Buchungskonto, Betrag, Steuersatz, Anlagegut-Kennzeichen und ihrem ganzen Buchungstext sowie die
  Angabe, ob eine Belegdatei angehängt ist.

Eine feste Warnung in jeder dieser Vorschauen nennt, was die Angaben nicht zeigen: den
Ansprechpartner, das Land der Anschrift, die Einheiten und verknüpften Artikel der Positionen und
das Layout des PDF; bei einem festzuschreibenden Beleg die Namen der Buchungskonten und den Inhalt
der Belegdatei.

## Versteckte Zeichen in Argumenten

Umgekehrt darf auch Text, den der Mensch nicht sehen kann, sevDesk nicht erreichen. Bevor etwas
gelesen oder gesendet wird, lehnt jedes Schreibwerkzeug (Probeläufe eingeschlossen) Argumente ab,
die Zeichen enthalten, die ein Mensch so nicht sehen würde: Steuer- und Formatzeichen (Nullbreite,
Bidi), andere standardmäßig ignorierbare Codepunkte (Variantenselektoren, U+034F, Hangul-Füller),
Wagenrückläufe, die Zeilen- und Absatztrenner sowie Tabulatoren. Der Fehler nennt das Argument und
die Codepunkte; Zeilenumbrüche sind erlaubt.

## Was eine Freigabe bindet

Gleich in welcher Bestätigungsart deckt eine Freigabe ab:

- den Namen des Werkzeugs und einen SHA-256 der Argumente (ohne `dryRun`);
- einen SHA-256 der vollständigen Vorschau, nicht dessen, was auf den Bildschirm passte. Bei
  Werkzeugen, die eine Bestätigung verlangen, umfasst er den englischen und den deutschen Text: Das
  Werkzeug schreibt die Vorschau in beiden Sprachen, und der Server lehnt ein Paar ab, das nicht
  dieselben Angaben und Warnungen enthält;
- bei einem verbindlichen Dokument einen Hash des ganzen Datensatzes und all seiner Positionen, so
  wie sevDesk sie geliefert hat (Texte, Anschrift, Zahlungsbedingungen, Positionen, Zeitpunkt der
  letzten Änderung), aus demselben Lesevorgang wie die Angaben.

Eine Freigabe läuft nach 10 Minuten ab und wird einmal verwendet. Beim erneuten Versuch bereitet
der Server die Aktion erneut vor und führt sie nur aus, wenn sich nichts geändert hat, was die
Freigabe bindet; sonst fragt er erneut, statt auszuführen. Zu einem Dokument, das geändert wurde,
nachdem der Mensch gefragt wurde, auch in einem Teil, den die Vorschau nicht zeigt, wird also erneut
gefragt, und ein Text, der vor der Frage geändert wurde, steht in der Vorschau, die der Mensch
liest.

## elicit

Mit `SEVDESK_CONFIRM=elicit` (Standard) antwortet der Aufruf mit einer MCP-Elicitation über den
Ablauf mit mehreren Runden aus 2026-07-28 (`input_required`): ein Formular mit einem einzigen
Schalter „Approve this action“, der zunächst aus ist. Der ausstehende Zustand reist als
`requestState` durch den Client, signiert mit HMAC-SHA256 (der Request-State-Codec des SDK, ein
zufälliger 256-Bit-Schlüssel je Serverprozess, 10 Minuten gültig, gebunden an die Methode, den
Client und im HTTP-Modus an den Zugang und das Konto). Neben dem, [was jede Freigabe
bindet](#was-eine-freigabe-bindet), trägt er eine Einmal-Nonce.

Beim erneuten Versuch lehnt der Server einen Zustand für andere Argumente oder ein anderes Werkzeug
ab und lehnt eine wiederverwendete Freigabe ab (die Nonce wird einmal verbraucht). Ablehnen,
Abbrechen oder ein nicht umgelegter Schalter ergeben `declined`: Nichts ändert sich. Für Clients aus
der Zeit von 2025 sendet die Kompatibilitätsschicht des SDK eine echte `elicitation/create`-Anfrage
über dieselbe Verbindung, sodass dieselben Prüfungen gelten. Clients, die keine
Formular-Elicitation angeben, und Clients aus der Zeit von 2025 über zustandsloses HTTP (die keine
Anfragen vom Server an den Client empfangen können) bekommen einen Fehler, der dem Benutzer sagt, zu
`browser` zu wechseln; nichts wird gesendet.

### Worauf sich die Elicitation verlässt

Die Elicitation vertraut der MCP-Client-Anwendung: Der Client zeigt das Formular und schickt die
Antwort zurück, und der signierte Zustand beweist nur, dass der Server gefragt hat, nicht, dass ein
Mensch geantwortet hat. Ein Client, der selbst bösartig oder kompromittiert ist (nicht ein
manipuliertes Modell in einem ehrlichen Client), kann von sich aus „freigeben“ antworten. Die
Elicitation hält eine Prompt Injection im Modell auf, das das Formular nicht beantworten kann; einen
feindlichen Client hält sie nicht auf. Mit einem Client, dem du nicht vertraust, verwendest du
`SEVDESK_CONFIRM=browser` (über HTTP das Freigabe-Postfach), wo der Mensch auf einer Seite
entscheidet, die der Server selbst ausliefert.

## Die lokale Freigabeseite

Mit `SEVDESK_CONFIRM=browser` über stdio legt der Server eine Freigabeseite an, die er selbst nur
auf `127.0.0.1` und einem flüchtigen Port bereitstellt, und öffnet sie im Browser des Benutzers mit
dem Öffner des Betriebssystems (`open`, `xdg-open` oder `cmd /c start`, gestartet mit einem
Argument-Array, ohne Shell). `SEVDESK_CONFIRM_OPEN=0` schaltet das Öffnen ab. Im Fernzugriff nutzt
`browser` stattdessen das Freigabe-Postfach des Servers
([Fernzugriff](remote.de.md#das-freigabe-postfach)).

### Der Startlink

Der Link der Seite ist geheim: Er geht in das Log des Servers (stderr, eine Zeile je Freigabe) und
an den Öffner, nie an das Modell, das Ergebnis des Werkzeugs oder das Audit-Log. Er ist ein
Startlink, `http://127.0.0.1:<port>/open/<ticket>`, mit einem zufälligen 256-Bit-Ticket, das einmal
funktioniert: Die erste Anfrage setzt ein Cookie für die Freigabeseite und leitet dorthin weiter.
Die Seite (`/approve/<id>`) und die Entscheidung brauchen dieses Cookie; die Adresse der Seite allein
zeigt nichts und gibt kein Cookie aus. Der Öffner nimmt keine andere Art von URL an, die Adresse der
Seite steht also nie in einer Befehlszeile.

Der Browser, der den Link verwendet hat, darf ihn erneut öffnen (der Öffner hat zweimal ausgelöst,
der Link wurde zusätzlich im Log angeklickt). Wird der Link ein zweites Mal von anderswo vorgelegt,
kann der Server nicht erkennen, welcher der beiden der Browser des Benutzers ist: Die Anfrage wird
zurückgezogen (eine dort schon erteilte Freigabe wird nicht ausgeführt), beide sehen eine Seite, die
sagt, dass der Link zweimal verwendet wurde, und der Assistent muss erneut fragen. Ein Browser, der
den Link vorab lädt (Prerendering aus der Adresszeile), verbraucht ihn nicht.

Der Aufruf gibt `approval_pending` mit einem kurzen, nicht geheimen Referenzcode zurück (auch auf
der Seite gezeigt, damit der Benutzer beide zuordnen kann), den Ablauf und ob die Seite geöffnet
wurde. Jede Freigabe hat eine zufällige 256-Bit-ID.

### Die Seite und die Entscheidung

Die Seite ist statisches HTML, jeder Wert ist maskiert, unter einer strengen Content Security Policy
(keine Skripte, kein Einbetten in Frames, Formulare nur an sich selbst; sie lädt nur ihre eigenen
Schriften und ihr Icon aus dem Pfad `/assets/` des Servers, nichts von anderen). Für einen Browser,
der Deutsch anfragt, ist sie deutsch, die Vorschau eingeschlossen, und die Freigabe ist an beide
Texte gebunden.

Approve und Reject sind POST-Formulare, die Folgendes tragen müssen:

- ein CSRF-Token der Seite je Freigabe;
- das `SameSite=Strict`-Cookie je Freigabe, das der Startlink gesetzt hat;
- `Host: 127.0.0.1:<port>` (jede Anfrage wird auf den Host geprüft, gegen DNS-Rebinding);
- einen Origin auf der Seite selbst: `Origin: http://127.0.0.1:<port>` oder, bei Clients, die kein
  `Origin` senden, das vom Browser gesetzte `Sec-Fetch-Site: same-origin`. `Origin: null` wird
  abgelehnt; die Seite verwendet die Referrer-Policy `same-origin`, unter der Browser den echten
  Origin senden (unter `no-referrer` würden sie `null` senden).

Höchstens fünf Freigaben warten gleichzeitig auf eine Entscheidung; darüber hinaus werden Aufrufe
abgelehnt, bis der Benutzer entscheidet oder die Anfragen ablaufen, damit ein Assistent in einer
Schleife den Browser nicht mit Tabs fluten kann.

### Grenzen des Browser-Modus

Das Modell sieht den Link nie, aber der Link ist trotzdem eine Berechtigung. Ein Agent, der das
stderr-Log des Servers lesen kann (zum Beispiel ein Client, der dem Modell MCP-Logs zeigt, oder
Shell-Zugriff auf die Logdatei) oder der den Browser des Benutzers steuern kann (eine offene Seite,
Browser-Automatisierung), kann trotzdem selbst freigeben. Der Browser-Modus schützt daher vor einem
Modell, das nur redet (zum Beispiel einem, das durch Prompt Injection in sevDesk-Daten gesteuert
wird), nicht vor einem Agenten mit solchem Zugriff. `elicit` bleibt der empfohlene Modus, besonders
in agentischen Clients, die Befehle ausführen können.

### Andere Benutzer desselben Computers

Andere Benutzer desselben Computers können die Befehlszeile des Öffners lesen (`ps`, `/proc`) und
damit den Startlink. Hat der Browser des Benutzers den Link schon verwendet, können sie nichts damit
anfangen: Sie bekommen eine Seite ohne Inhalt und ohne Cookie, und ihr Versuch bricht eine noch
nicht ausgeführte Anfrage ab, was der Benutzer sieht. Legen sie den Link vor, bevor der Browser des
Benutzers es tut, haben sie die Seite, bis dieser Browser ankommt; seine Ankunft zieht die Anfrage
dann zurück, auch wenn sie schon freigegeben wurde. Nur eine Aktion, die der Assistent in dieser
Lücke bereits ausgeführt hat (er hat das Werkzeug erneut aufgerufen, bevor der Browser des Benutzers
ankam), lässt sich nicht rückgängig machen; der Browser des Benutzers zeigt dann, dass der Link
anderswo verwendet und entschieden wurde.

Auf einem Computer, an dem sich Personen anmelden können, denen du nicht vertraust, setzt du deshalb
`SEVDESK_CONFIRM_OPEN=0` (der Link steht dann nur im Log des Servers, nicht in einer Befehlszeile)
oder verwendest `elicit`.

## Bestätigung abschalten

`SEVDESK_CONFIRM=off` wird nur zusammen mit `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1` angenommen. Die
Claude-Desktop-Erweiterung bietet keine Möglichkeit, es zu setzen
([Lokale Nutzung](local.de.md#claude-desktop-erweiterung)).

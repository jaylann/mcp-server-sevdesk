<!-- translated-from: SECURITY.md sha256:cbce7c246e05 -->

# Sicherheitsrichtlinie

## Eine Schwachstelle melden

Bitte **eröffnen Sie kein öffentliches Issue**. Melden Sie Schwachstellen vertraulich über
[GitHub Private Vulnerability Reporting](https://github.com/jaylann/mcp-server-sevdesk/security/advisories/new).
Sie erhalten innerhalb von 72 Stunden eine Eingangsbestätigung und für bestätigte Probleme
innerhalb von 14 Tagen eine Behebung oder einen Plan zur Abhilfe. Im Advisory werden Sie genannt,
sofern Sie das nicht anders wünschen.

Sicherheitskorrekturen erhält nur die neueste veröffentlichte Version.

## Bedrohungsmodell

Dieser Server steht zwischen einem KI-Modell und einem sevDesk-Konto. Der Entwurf geht davon aus:

1. **Das sevDesk-API-Token kann alles.** sevDesk-Tokens haben keine einschränkbaren Rechte und
   laufen nie ab; sie können alles, was ihr Benutzer kann, im gesamten Konto. Der Server setzt
   deshalb seine eigenen minimalen Rechte durch: Werkzeuge sind in Stufen gruppiert (`read`,
   `write`, `commit`, `external`), nur `read` ist standardmäßig aktiv, und Werkzeuge oberhalb der
   erlaubten Stufen werden nie registriert. Die Stufe wird erneut im Dispatcher und im HTTP-Client
   durchgesetzt, der außerdem die Mindeststufe jedes Endpunkts kennt (zum Beispiel brauchen
   `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, das Fertigstellen eines Belegs und das
   Ändern eines Kontoumsatzes die Stufe `commit`; `sendViaEmail` braucht `external`) und eine
   Anfrage eines Werkzeugs mit zu niedriger Stufe ablehnt.
2. **Das Modell kann manipuliert werden.** Text, der in sevDesk gespeichert ist (Kontaktnamen,
   Beschreibungen von Rechnungen und Belegen, Verwendungszwecke von Überweisungen, Inhalte von
   E-Rechnungen), kann von Dritten stammen und Prompt Injection enthalten. Solcher Text wird als
   nicht vertrauenswürdige Daten behandelt: In der Ausgabe ist er eingefasst, unsichtbares Unicode
   wird entfernt, und er erscheint nie in Fehlermeldungen. Rechtlich bindende oder nach außen
   wirkende Aktionen (`commit`, `external`) erfordern eine **Bestätigung durch einen Menschen**
   außerhalb der Kontrolle des Modells (MCP-Elicitation oder eine Freigabeseite, siehe unten); ein
   `confirm`-Flag des Modells wird nie als Freigabe angenommen.
3. **Es gibt keine Testumgebung.** Jeder Schreibvorgang ist echt. Schreibvorgänge werden nie
   automatisch wiederholt (um Dubletten zu vermeiden), zur Prüfung zurückgelesen, können als
   Probelauf laufen (`dryRun: true` oder `SEVDESK_DRY_RUN=1`: Das Werkzeug liest, prüft und gibt
   seine Vorschau zurück, sendet nichts und fragt niemanden) und können in einem lokalen Audit-Log
   festgehalten werden.
4. **Geheimnisse dürfen nicht nach außen gelangen.** Das Token wird aus der Umgebung, einer Datei
   oder dem Schlüsselbund des Betriebssystems gelesen; es wird nie protokolliert, ausgegeben oder in
   Fehler aufgenommen. Logs gehen nur nach stderr. Im Fernzugriff gilt dasselbe für die Bearer- und
   Server-Geheimnisse, verschlüsselte Tokens, Autorisierungscodes und Cookies.
5. **Auch lokale Dateien sind eine Grenze.** Das Modell nennt Dateien; der Server darf also nicht
   zu einem Weg werden, beliebige Dateien zu lesen oder zu schreiben. Werkzeuge lesen nur innerhalb
   von `SEVDESK_FILE_DIRS` (absolute Ordner; echte Pfade werden geprüft, symbolische Links dürfen
   nicht nach außen führen, die Datei wird geöffnet, ohne einem Link zu folgen, und über ihre Inode
   geprüft, ihr Typ wird am Inhalt erkannt, Größen sind begrenzt) und schreiben nur innerhalb von
   `SEVDESK_OUTPUT_DIR` (nur neue Dateien, Modus 0600, nie überschreibend). Ohne diese
   Einstellungen liest oder schreibt kein Werkzeug lokale Dateien. Empfangene E-Rechnungen sind
   feindliche Eingaben: Der XML-Parser lehnt DOCTYPEs und Entitäten ab, begrenzt Größe und
   Verschachtelungstiefe und liest ein Element nur in dem Namensraum, den das Rechnungsformat
   dafür festlegt; der Leser für PDF-Anhänge begrenzt die entpackten Größen, die Zahl der Werte,
   die er aus einem PDF aufbaut (eine Million), die Länge von Namen, Zahlen und Zeichenketten
   und den Leseaufwand je Byte der Datei; und jedes ausgelesene Textfeld gilt als nicht
   vertrauenswürdig. Ein PDF wird weiterhin im Serverprozess gelesen: Eine feindliche Datei an
   diesen Grenzen kann ihn mehrere Sekunden beschäftigen, aber nicht länger. Das ZIP des
   DATEV-Exports wird über einen vorsignierten Link geholt, den sevDesk zurückgibt; der Server
   akzeptiert dafür genau einen https-Host, folgt keinen Weiterleitungen, sendet keine
   Zugangsdaten, begrenzt die Größe und zeigt den Link nie dem Modell.
6. **Der Fernzugriff fügt eine Netzwerkgrenze hinzu.** Der HTTP-Transport startet nicht ohne
   Authentifizierung, lauscht standardmäßig auf 127.0.0.1 (jede andere Adresse braucht eine
   konfigurierte öffentliche URL) und prüft Host und Origin. Im OAuth-Modus ist er standardmäßig
   auf eigene Konten beschränkt (nur aufgeführte sevDesk-Konten können sich verbinden, nur erlaubte
   Clients können fragen), speichert keine sevDesk-Tokens (das Token jedes Benutzers reist
   verschlüsselt in den Tokens, die sein Client hält) und ordnet Freigaben, Bestätigungen und
   Caches dem Konto und Zugang jeder Anfrage zu. Siehe [Fernzugriff](#fernzugriff).

Nicht im Umfang: Schwachstellen in sevDesk selbst (melden Sie diese der sevdesk GmbH) und Angriffe,
die die Kontrolle über den Rechner voraussetzen, auf dem der Server läuft.

## Bestätigung durch einen Menschen

Jeder Aufruf der Stufen `commit` und `external` zeigt dem Menschen eine Vorschau, die das Werkzeug
aus dem gerade Gelesenen erstellt: die Aktion in einem Satz, dann die Warnungen und „This cannot be
undone.“ bei unumkehrbaren Aktionen, dann die wichtigsten Angaben (Datensatz, Kunde, Beträge,
Daten, Empfänger, Texte). Aus den Werten werden unsichtbare, Bidi- und Steuerzeichen entfernt,
damit gespeicherter Text dem Menschen nichts verbergen kann. Werte werden vollständig mit ihren
Zeilenumbrüchen gezeigt (etwa ein E-Mail-Text), jede Zeile unter ihrer Beschriftung eingerückt,
damit keine Zeile eines Werts sich als Beschriftung oder Warnung ausgeben kann; ein Wert über
12.000 Zeichen endet mit „[… N more characters not shown; open the dry run to see everything]“,
statt stillschweigend gekürzt zu werden, und der Probelauf gibt ihn vollständig zurück. Die
Freigabe bindet einen Hash der vollständigen Vorschau, nicht dessen, was auf den Bildschirm passte.
Nur die Antwort des Menschen zählt: Kein Argument eines Werkzeugs kann etwas freigeben.

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
der Belegdatei. Die Angaben und die Bindung der Freigabe stammen aus demselben Lesevorgang: Neben
der Vorschau deckt die Freigabe einen Hash des ganzen Datensatzes und all seiner Positionen ab, so
wie sevDesk sie geliefert hat (Texte, Anschrift, Zahlungsbedingungen, Positionen, Zeitpunkt der
letzten Änderung). Zu einem Dokument, das nach der Frage geändert wurde, auch in einem Teil, den
die Vorschau nicht zeigt, wird erneut gefragt; ein Text, der vor der Frage geändert wurde, steht in
der Vorschau, die der Mensch liest.

Umgekehrt darf auch Text, den der Mensch nicht sehen kann, sevDesk nicht erreichen. Bevor etwas
gelesen oder gesendet wird, lehnt jedes Schreibwerkzeug (Probeläufe eingeschlossen) Argumente ab,
die Zeichen enthalten, die ein Mensch so nicht sehen würde: Steuer- und Formatzeichen (Nullbreite,
Bidi), andere standardmäßig ignorierbare Codepunkte (Variantenselektoren, U+034F, Hangul-Füller),
Wagenrückläufe, die Zeilen- und Absatztrenner sowie Tabulatoren. Der Fehler nennt das Argument und
die Codepunkte; Zeilenumbrüche sind erlaubt.

**`SEVDESK_CONFIRM=elicit` (Standard).** Der Aufruf antwortet mit einer MCP-Elicitation über den
Ablauf mit mehreren Runden aus 2026-07-28 (`input_required`): ein Formular mit einem einzigen
Schalter „Approve this action“, der zunächst aus ist. Der ausstehende Zustand reist als
`requestState` durch den Client, signiert mit HMAC-SHA256 (der Request-State-Codec des SDK, ein
zufälliger 256-Bit-Schlüssel je Serverprozess, 10 Minuten gültig, gebunden an die Methode, den
Client und im HTTP-Modus an den Zugang und das Konto). Er bindet den Namen des Werkzeugs, einen
SHA-256 der Argumente (ohne `dryRun`), einen SHA-256 der Vorschau und eine Einmal-Nonce. Beim
erneuten Versuch lehnt der Server einen Zustand für andere Argumente oder ein anderes Werkzeug ab,
lehnt eine wiederverwendete Freigabe ab (die Nonce wird einmal verbraucht), bereitet die Aktion
erneut vor und fragt, falls sich die Vorschau in der Zwischenzeit geändert hat (der Datensatz wurde
bearbeitet), erneut, statt auszuführen. Ablehnen, Abbrechen oder ein nicht umgelegter Schalter
ergeben `declined`: Nichts ändert sich. Für Clients aus der Zeit von 2025 sendet die
Kompatibilitätsschicht des SDK eine echte `elicitation/create`-Anfrage über dieselbe Verbindung,
sodass dieselben Prüfungen gelten. Clients, die keine Formular-Elicitation angeben, und Clients aus
der Zeit von 2025 über zustandsloses HTTP (die keine Anfragen vom Server an den Client empfangen
können) bekommen einen Fehler, der dem Benutzer sagt, zu `browser` zu wechseln; nichts wird
gesendet.

Die Elicitation vertraut der MCP-Client-Anwendung: Der Client zeigt das Formular und schickt die
Antwort zurück, und der signierte Zustand beweist nur, dass der Server gefragt hat, nicht, dass ein
Mensch geantwortet hat. Ein Client, der selbst bösartig oder kompromittiert ist (nicht ein
manipuliertes Modell in einem ehrlichen Client), kann von sich aus „freigeben“ antworten. Die
Elicitation hält eine Prompt-Injection im Modell auf, das das Formular nicht beantworten kann; einen
feindlichen Client hält sie nicht auf. Mit einem Client, dem Sie nicht vertrauen, verwenden Sie
`SEVDESK_CONFIRM=browser` (über HTTP den Freigabe-Posteingang), wo der Mensch auf einer Seite
entscheidet, die der Server selbst ausliefert.

**`SEVDESK_CONFIRM=browser`** über stdio. Für Clients ohne Elicitation legt der Server eine
Freigabeseite an, die er selbst nur auf `127.0.0.1` und einem flüchtigen Port bereitstellt, und
öffnet sie im Browser des Benutzers mit dem Öffner des Betriebssystems (`open`, `xdg-open` oder
`cmd /c start`, gestartet mit einem Argument-Array, ohne Shell). `SEVDESK_CONFIRM_OPEN=0` schaltet
das Öffnen ab. Der Link der Seite ist geheim: Er geht in das Log des Servers (stderr, eine Zeile je
Freigabe) und an den Öffner, nie an das Modell, das Ergebnis des Werkzeugs oder das Audit-Log. Der
Link ist ein Startlink, `http://127.0.0.1:<port>/open/<ticket>`, mit einem zufälligen
256-Bit-Ticket, das einmal funktioniert: Die erste Anfrage setzt ein Cookie für die Freigabeseite
und leitet dorthin weiter. Die Seite (`/approve/<id>`) und die Entscheidung brauchen dieses
Cookie; die Adresse der Seite allein zeigt nichts und gibt kein Cookie aus. Der Öffner nimmt
keine andere Art von URL an, die Adresse der Seite steht also nie in einer Befehlszeile. Der
Browser, der den Link verwendet hat, darf ihn erneut öffnen (der Öffner hat zweimal ausgelöst,
der Link wurde zusätzlich im Log angeklickt). Wird der Link ein zweites Mal von anderswo
vorgelegt, kann der Server nicht erkennen, welcher der beiden der Browser des Benutzers ist: Die
Anfrage wird zurückgezogen (eine dort schon erteilte Freigabe wird nicht ausgeführt), beide sehen
eine Seite, die sagt, dass der Link zweimal verwendet wurde,
und der Assistent muss erneut fragen. Ein Browser, der den Link vorab lädt (Prerendering aus der
Adresszeile), verbraucht ihn nicht. Der
Aufruf gibt `approval_pending` mit einem kurzen, nicht geheimen Referenzcode zurück (auch auf der
Seite gezeigt, damit der Benutzer beide zuordnen kann), den Ablauf und ob die Seite geöffnet wurde.
Jede Freigabe bindet Werkzeug, Hash der Argumente und Hash der Vorschau, hat eine zufällige
256-Bit-ID, läuft nach 10 Minuten ab und wird einmal verwendet; ruft das Modell das Werkzeug nach
der Freigabe durch den Menschen mit denselben Argumenten erneut auf, bereitet der Server erneut vor
und führt die Aktion nur aus, wenn die Vorschau unverändert ist. Die Seite ist statisches HTML,
jeder Wert ist maskiert, unter einer strengen Content Security Policy (keine Skripte, kein
Einbetten in Frames, Formulare nur an sich selbst). Approve und Reject sind POST-Formulare, die ein
CSRF-Token der Seite je Freigabe tragen müssen, das `SameSite=Strict`-Cookie je Freigabe, das der
Startlink gesetzt hat, `Host: 127.0.0.1:<port>` (jede Anfrage wird auf den Host geprüft,
gegen DNS-Rebinding), und von der Seite selbst kommen müssen: `Origin: http://127.0.0.1:<port>`
oder, bei Clients, die kein `Origin` senden, das vom Browser gesetzte
`Sec-Fetch-Site: same-origin`. `Origin: null` wird abgelehnt; die Seite verwendet die
Referrer-Policy `same-origin`, unter der Browser den echten Origin senden (unter `no-referrer`
würden sie `null` senden). Höchstens fünf Freigaben warten gleichzeitig auf eine Entscheidung;
darüber hinaus werden Aufrufe abgelehnt, bis der Benutzer entscheidet oder die Anfragen ablaufen,
damit ein Assistent in einer Schleife den Browser nicht mit Tabs fluten kann. Im Fernzugriff nutzt
`browser` stattdessen das Freigabe-Postfach des Servers (siehe [Fernzugriff](#fernzugriff)).

**Grenze des Browser-Modus.** Das Modell sieht den Link nie, aber der Link ist trotzdem eine
Berechtigung. Ein Agent, der das stderr-Log des Servers lesen kann (zum Beispiel ein Client, der
dem Modell MCP-Logs zeigt, oder Shell-Zugriff auf die Logdatei) oder der den Browser des Benutzers
steuern kann (eine offene Seite, Browser-Automatisierung), kann trotzdem selbst freigeben. Der
Browser-Modus schützt daher vor einem Modell, das nur redet (zum Beispiel einem, das durch Prompt
Injection in sevDesk-Daten gesteuert wird), nicht vor einem Agenten mit solchem Zugriff. `elicit`
bleibt der empfohlene Modus, besonders in agentischen Clients, die Befehle ausführen können.

Andere Benutzer desselben Computers können die Befehlszeile des Öffners lesen (`ps`, `/proc`) und
damit den Startlink. Was sie damit tun können: nichts, sobald der Browser des Benutzers den Link
verwendet hat (sie bekommen eine Seite ohne Inhalt und ohne Cookie, und ihr Versuch bricht eine
noch nicht ausgeführte Anfrage ab, was der Benutzer sieht). Legen sie den Link vor, bevor der
Browser des Benutzers es tut, haben sie die Seite, bis dieser Browser ankommt: Seine Ankunft
zieht die Anfrage dann zurück, auch wenn sie schon freigegeben wurde. Nur eine Aktion, die der
Assistent in dieser Lücke bereits ausgeführt hat (er hat das Werkzeug erneut aufgerufen, bevor
der Browser des Benutzers ankam), lässt sich nicht rückgängig machen; der Browser des Benutzers
zeigt dann, dass der Link anderswo verwendet und entschieden wurde. Auf einem Computer, an dem sich
Personen anmelden können, denen Sie nicht vertrauen, setzen Sie deshalb `SEVDESK_CONFIRM_OPEN=0`
(der Link steht dann nur im Log des Servers, nicht in einer Befehlszeile) oder verwenden `elicit`.

**`SEVDESK_CONFIRM=off`** wird nur zusammen mit `SEVDESK_I_UNDERSTAND_NO_CONFIRM=1` angenommen.

## Audit-Log

Mit `SEVDESK_AUDIT_LOG=<path>` hängt jeder schreibende Aufruf JSON Lines an diese Datei an:
`dry_run` (mit der Vorschau), `confirmation_requested` (mit der Vorschau und im Browser-Modus
dem Referenzcode),
`confirmation_refused` (eine wiederverwendete, abgelaufene oder nicht passende Bestätigung),
`approval_decided` (Approve oder Reject auf der Freigabeseite gedrückt, mit dem Referenzcode),
`declined`, `executing` (mit der Art der Freigabe: `elicit`, `browser`, `confirmation_off` oder
`not_required` für die Stufe `write`), `executed` (mit den geänderten Datensätzen) und `failed` (mit
der Art des Fehlers und allen Datensätzen, die ein früherer Schritt bereits geändert hat). Jede
Zeile hat einen Zeitstempel, eine Aufruf-ID, die Anfrage, Entscheidung und Ausführung teilen, das
Werkzeug, seine Stufe, den Hash der Argumente, den Hash der Vorschau, die gezeigt und freigegeben
wurde, und die Argumente (Token geschwärzt, versteckte Zeichen als sichtbare `\u{…}`-Escapes
geschrieben, Zeichenketten bis 20.000 Zeichen, längere markiert). Im Fernzugriff hat jede Zeile
außerdem `account` (die sevDesk-Konto-ID; `bearer` im Bearer-Modus, falls die Abfrage des Kontos
beim Start fehlschlug) und `grant` (die ID des Zugangs oder `bearer`), und ein Log umfasst jedes
Konto, das der Server bedient. Die Datei wird mit Modus 0600 angelegt (und auf 0600 verschärft,
falls sie schon existiert), nur zum Anhängen geöffnet und nie über einen symbolischen Link. Unter
macOS und Linux wird eine Datei abgelehnt, die einem anderen Benutzer gehört, gleich mit welchem
Modus: Ihr Besitzer könnte sie umschreiben, und eine ACL kann Zugriff geben, den der Modus nicht
zeigt. Jede Zeile wird ganz geschrieben, oder das Schreiben schlägt fehl; ein unvollständiger
Schreibvorgang wird fortgesetzt, nicht hingenommen. Kann
die Zeile `executing` nicht geschrieben werden, wird die Aktion nicht ausgeführt und nichts
gesendet (fail closed). Das Log ist lokal und nicht fälschungssicher: Es hält für den Benutzer
fest, was dieser Server getan hat, und schützt nicht vor jemandem, der den Rechner kontrolliert.
Jede Zeile beginnt mit `ts` und der Formatversion `v` (derzeit `1`).

## Generischer Lesezugriff

`sevdesk_api_get` (Werkzeuggruppe `advanced`, standardmäßig aus) lässt das Modell einen GET-Pfad
wählen, was ein kuratiertes Werkzeug nie tut. Es hat vier unabhängige Schutzmechanismen:

1. Das konfigurierte sevDesk-Token irgendwo im Pfad oder in der Query wird abgelehnt, und die
   Ablehnung wiederholt den Pfad nicht.
2. `genericGetRefusal` lehnt, bevor etwas gesendet wird, Endpunkte ab, die Zustand ändern, Dateien
   liefern oder Hintergrundaufgaben starten (`getPdf`, `getXml`, `render`, `sendBy`, `bookAmount`,
   `enshrine`, `cancelInvoice`, die Endpunkte zum Zurücksetzen, `getNext…Number`, Segmente, die mit
   einem verändernden Verb beginnen, und alles unter `Export`, `ExportJob`, `Progress`, `Report`,
   `DocServer` und `SevSequence`), sowie gefährliche Query-Schlüssel: Zugangsdaten (sevDesk nimmt
   `?token=` an), Schlüssel zum Blättern, die das Werkzeug selbst setzt, `download`,
   `preventSendBy`, `enshrine…`, `useNextNumber` und Methoden-Overrides. Query-Schlüssel werden so
   normalisiert, wie PHP sie liest; so werden auch `Api.Key` oder `token[0]` erkannt.
3. Der Client ohne Schreibrechte lehnt jedes GET mit einer Nebenwirkung ab, das
   `resolveGetSafety` erkennt.
4. Der HTTP-Client lehnt es erneut ab, weil ein Lesezugriff keine Stufe angibt.

Antworten werden mit einer Grenze von 1 MiB gelesen, müssen JSON in der `{objects: …}`-Hülle von
sevDesk sein und werden wie nicht vertrauenswürdiger Text bereinigt: unsichtbare Zeichen entfernt,
Zeichenketten begrenzt, Binärinhalte (Dateien in Base64, Vorschaubilder) und Echos von `sevClient`
entfernt und aufgeführt, höchstens etwa 100 KB zurückgegeben. Das verbleibende Risiko ist ein
undokumentiertes GET mit einer Nebenwirkung, das keine dieser Regeln erfasst; deshalb ist die
Werkzeuggruppe standardmäßig aus.

## Lokale Token-Ablage und Profile

Über stdio kommt das Token aus der Umgebung, einer Datei (`SEVDESK_API_TOKEN_FILE`) oder dem
Schlüsselbund des Betriebssystems (`SEVDESK_API_TOKEN_KEYCHAIN`).

- **Schlüsselbund.** Einträge liegen unter dem festen Dienst `mcp-server-sevdesk`; die
  Konfiguration nennt nur die Bezeichnung, sodass eine feindliche Konfiguration den Server nicht
  dazu bringen kann, einen anderen Schlüsselbund-Eintrag (ein Passwort, ein anderes Token) zu
  lesen und an eine eigene `SEVDESK_BASE_URL` zu senden. Der Server führt das Hilfsprogramm des
  Betriebssystems (`/usr/bin/security` unter macOS, `secret-tool` unter Linux, Windows PowerShell
  mit WinRT `PasswordVault` unter Windows) mit einem
  Argument-Array aus, nie über eine Shell. Beim Ablegen reist das Token über stdin des
  Hilfsprogramms, nie in seinen Argumenten, die andere lokale Benutzer in der Prozessliste sehen
  könnten. Die Ausgabe des Hilfsprogramms ist begrenzt, wird nie protokolliert oder ausgegeben,
  und Fehler sind feste Texte. Der Schlüsselbund schützt das Token im Ruhezustand, in
  Konfigurationsdateien, Backups und Screenshots; er schützt nicht vor Code, der bereits als
  derselbe Benutzer läuft. Unter macOS vertraut der Eintrag `/usr/bin/security`, das ihn angelegt
  hat; jeder Prozess des Benutzers kann ihn also auf diesem Weg ohne Dialog lesen. Unter Windows
  ist das Skript konstant; Operation, Bezeichnung und Token reisen nur über stdin. Das Programm
  wird ausschließlich unter dem validierten, vertrauenswürdigen `SystemRoot` aufgelöst, nie über
  `PATH` oder das aktuelle Verzeichnis. Windows PowerShell muss im `FullLanguage`-Modus laufen;
  der Constrained Language Mode wird ohne Änderung der Richtlinie mit einem Hinweis auf
  `SEVDESK_API_TOKEN_FILE` oder das `.mcpb`-Bundle abgelehnt. Einträge im Credential Locker
  können über das Microsoft-Konto synchronisiert werden; eine geschützte Token-Datei ist die
  Alternative, wenn das Token auf diesem Gerät bleiben muss.
- **Die Kommandozeile.** `token set` liest das Token von stdin (in einem Terminal verdeckt), nie
  aus einem Argument, wo es in der Shell-Historie bliebe. Es prüft das Token bei sevDesk und legt
  nichts ab, was sevDesk ablehnt. Bezeichnungen, Profilnamen und unbekannte Argumente, die wie ein
  Token aussehen, werden nie ausgegeben.
- **Profile.** Ein Profil kann Stufen und Ordner erweitern; unter macOS und Linux müssen die
  Profildatei und ihr Ordner (auch der echte Ordner hinter einem symbolischen Link) daher dem
  Benutzer oder root gehören und dürfen für Gruppe und andere nicht beschreibbar sein; sonst wird
  die Datei abgelehnt. Unter Windows wird das nicht geprüft. Profile enthalten nie ein Token, nur
  den Ort, an dem es aufbewahrt wird, und das `token.env` eines Profils darf nur
  `SEVDESK_TOKEN_*`-Variablen nennen, sodass ein Profil kein beliebiges Geheimnis aus der Umgebung
  an eine eigene Basis-URL senden kann. Eine Variable, die sowohl in der Umgebung als auch im
  Profil gesetzt ist, ist ein Fehler; nur `SEVDESK_READ_ONLY=1` und `SEVDESK_DRY_RUN=1` in der
  Umgebung dürfen ein Profil stillschweigend verschärfen. Meldungen über die Datei zitieren nie
  ihren Inhalt.
- Der HTTP-Modus lehnt `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` und
  `SEVDESK_API_TOKEN_KEYCHAIN` ab: Ein Server hat keinen Benutzer-Schlüsselbund, und seine
  Konfiguration gehört in seine Umgebung.

## Claude-Desktop-Erweiterung

Das `.mcpb`-Paket betreibt denselben Server über stdio auf dem eingebauten Node.js von Claude
Desktop. Claude Desktop speichert das Token, eine als sensibel markierte Einstellung, im sicheren
Speicher des Betriebssystems (Schlüsselbund unter macOS, Anmeldeinformationsverwaltung unter
Windows) und übergibt es dem Server beim Start als `SEVDESK_API_TOKEN`; das Token erscheint nie in
der Kommandozeile. Das Paket enthält den Server und alle seine Abhängigkeiten in einer Datei, die
nur eingebaute Module von Node.js importiert, mit den Lizenzhinweisen jedes gebündelten Pakets. Die
Bestätigung lässt sich in der Erweiterung nicht abschalten: Sie bietet keine Möglichkeit,
`SEVDESK_I_UNDERSTAND_NO_CONFIRM` zu setzen. Das Paket ist noch nicht signiert; prüfen Sie einen
Download mit seiner Provenance-Attestierung (siehe [Lieferkette](#lieferkette)).

## Fernzugriff

Der HTTP-Transport (`--http`, Anleitung für den Betrieb in [docs/remote.de.md](docs/remote.de.md))
fügt eine Netzwerkgrenze hinzu und im OAuth-Modus mehrere Konten und Verbindungen in einem
Prozess. Die Entscheidungen sind
[ADR 0006](docs/adr/0006-built-in-authorization-server-and-grant-store.md) und
[ADR 0007](docs/adr/0007-approval-inbox-over-http.md).

**Netzwerk.** Der Server startet nicht ohne Authentifizierung. Er lauscht standardmäßig auf
`127.0.0.1` und braucht für jede andere Adresse eine öffentliche URL, und eine öffentliche URL muss
https verwenden, außer ihr Host ist ein Loopback-Name. Der `Host` jeder Anfrage muss einer der
konfigurierten Namen sein (gegen DNS-Rebinding; nur `/healthz` ist ausgenommen, für die
Zustandsprüfungen von Plattformen). Ein `Origin`-Header an `/mcp` muss einen erlaubten Host nennen
(die Prüfung vergleicht Hostnamen; `/mcp` sendet keine CORS-Header, sodass Webseiten auf anderen
Origins es nicht aufrufen können), und Formular-POSTs müssen von den eigenen Seiten des Servers
kommen (`Origin: null` wird abgelehnt). Bodys sind je Route begrenzt und müssen in kurzer Zeit
eintreffen, Anfragen haben Fristen, und Ratenbegrenzungen gelten je Client-Adresse (IPv6 je
/64-Netz). Der Server bearbeitet höchstens 64 Anfragen gleichzeitig: 8 je Client-Adresse (32 mit
`SEVDESK_OAUTH_ACCOUNTS=any`) und an `/mcp` 8 je sevDesk-Konto, gleich von welchen Adressen und
Verbindungen sie kommen (darüber 429). 8 der 64 bleiben den anderen Routen vorbehalten, sodass
Token-Erneuerung, Anmeldung, Freigabe-Postfach und Dateiseiten erreichbar bleiben, während `/mcp`
ausgelastet ist. Sieben Konten, die je ihre 8 ausschöpfen, können `/mcp` für die anderen weiterhin
füllen (503, bis eine Anfrage endet). Ein JSON-RPC-Batch, den nur Clients der Protokollversion
2025-03-26 senden, darf höchstens 8 Nachrichten enthalten und keine Anfrage-ID doppelt; sonst wird
er abgelehnt, bevor etwas davon läuft. Antworten tragen `nosniff`, `no-store, no-transform`
(damit Proxys Seiten nicht umschreiben), eine Referrer-Policy und über https HSTS. URLs, die der
Server ausgibt oder auf die er weiterleitet, werden aus der konfigurierten öffentlichen URL gebaut, nie aus
Headern der Anfrage. `SEVDESK_HTTP_TRUST_PROXY` muss der tatsächlichen Zahl der Proxys davor
entsprechen: Ein höherer Wert lässt Clients die IP-Adresse wählen, die die Ratenbegrenzung sieht.
Einfaches http wird nur für eine öffentliche Loopback-URL angenommen; beschränken Sie eine solche
Einrichtung auf kurze lokale Tests (siehe die Grenzen des Postfachs unten).

**Bearer-Modus.** Ein gemeinsames Geheimnis (zwei während eines Wechsels), mindestens 32 Zeichen
mit mindestens 16 verschiedenen und nie gleich dem sevDesk-Token. Der Server vergleicht ein HMAC
des vorgelegten Werts mit einem HMAC jedes konfigurierten Werts per `timingSafeEqual`, ohne beim
ersten Treffer aufzuhören. Wer das Geheimnis hält, kann die Stufen des Servers für dessen Konto
nutzen. Der Start warnt, wenn ein Bearer- oder Server-Geheimnis eher wie eine Passphrase als wie
zufällige Bytes aussieht.

**OAuth-Zustimmung und Erlaubnislisten.** Die Zustimmungsseite zeigt den Host der `client_id` des
Clients, den selbst angegebenen Namen des Clients (bereinigt und als solcher gekennzeichnet) und
den Host, auf den sie weiterleiten wird, mit einer Warnung, wenn jede Weiterleitung auf eine
Loopback-Adresse geht (eine App auf dem Rechner des Benutzers). Nur `read` ist vorausgewählt;
andere Stufen müssen angehakt werden. So weit kommen Clients nur, wenn ihr Metadaten-Dokument auf
einem Host in `SEVDESK_OAUTH_CLIENTS` liegt (Standard `claude.ai`), geprüft, bevor etwas abgerufen
wird: Ein Angreifer kann Ihre Zustimmungsseite nicht seinen eigenen Client präsentieren lassen
(Consent-Phishing). Nur sevDesk-Konten in `SEVDESK_OAUTH_ACCOUNTS` können die Zustimmung
abschließen; ein Server, dessen URL bekannt wird, wird so nicht zu einem Dienst für die Konten
Fremder; ein abgelehntes Konto wird als `account_refused` protokolliert. Beide Erlaubnislisten
gelten auch für jede Anfrage und Erneuerung: Wird ein Konto oder Client-Host entfernt und der
Server neu gestartet, werden seine bestehenden Zugänge bei der nächsten Nutzung widerrufen, und die
Postfach-Sitzungen des Kontos enden. Eine geprüfte Zustimmung lässt sich nur einmal abschließen,
und jedes Konto hält eine begrenzte Zahl gültiger Zugänge (eine neue Zustimmung darüber hinaus
ersetzt den ältesten des Kontos), damit ein Konto den Zugangsspeicher nicht für alle anderen füllen
kann. Die Seite verwendet ein `SameSite=Strict`-CSRF-Cookie mit einem passenden HMAC-Feld, nimmt
POSTs nur von sich selbst an, lässt sich nicht in Frames einbetten, und ihre Content Security
Policy sendet Formulare nur an sich selbst und an den geprüften Origin der Weiterleitung. Fehler im
Client, seinen Metadaten oder der Redirect-URI zeigen eine Fehlerseite und leiten nie weiter. Das
eingefügte sevDesk-Token wird bei sevDesk geprüft und nie wieder angezeigt.

**Metadaten von Clients abrufen (SSRF).** Eine `client_id`-URL abzurufen ist eine Anfrage, die der
Server für jemand anderen stellt. Die URL muss https auf einem DNS-Namen sein, ohne Query,
Fragment, Zugangsdaten oder Punkt-Segmente, auf einem erlaubten Host. Der Name wird einmal
aufgelöst, jede Adresse muss öffentlich sein (private, Loopback-, Link-Local-, CGNAT-,
Unique-Local-, Dokumentations- und Multicast-Bereiche werden abgelehnt, auch innerhalb von NAT64-,
6to4- und IPv4-gemappten Adressen), und die Verbindung geht an die geprüfte Adresse. Keine
Weiterleitungen, 3 Sekunden für den Verbindungsaufbau und 5 insgesamt, nur `application/json`,
höchstens 5 KiB. Das Dokument muss dieselbe `client_id` nennen, 1–10 Redirect-URIs aufführen und
darf kein Client-Secret haben. Ablehnungen werden als `cimd_blocked` protokolliert.

**OAuth-Tokens und Widerruf.** Nur PKCE mit S256; der Hash des Verifiers wird in konstanter Zeit
verglichen. Redirect-URIs müssen genau übereinstimmen (Loopback-Weiterleitungen: der Host genau,
beliebiger Port). Autorisierungscodes leben 60 Sekunden und werden einmal verwendet: Ein zweiter
Austausch widerruft den Zugang (`code_replay`). Access-Tokens leben 1 Stunde und gelten nur für
`<public URL>/mcp` (RFC 8707, genaue Übereinstimmung), und jede Anfrage schlägt den Zugang nach,
sodass ein Widerruf mit der nächsten Anfrage wirkt. Refresh-Tokens werden bei jeder Nutzung
ersetzt; das vorige wird nach einer Rotation noch 30 Sekunden angenommen, jede spätere Nutzung
widerruft den Zugang (`refresh_replay`). Jede Erneuerung prüft das sevDesk-Token erneut bei
sevDesk, und ein 401 widerruft den Zugang. Ein Zugang endet spätestens nach 90 Tagen. Alle Tokens
sind mit AES-256-GCM unter einem Schlüssel je Zweck verschlüsselt, mit authentifiziertem Typ,
Issuer und Schlüssel-ID, und tragen ein lesbares Präfix `sdmcp_`, damit Schwärzung und
Secret-Scanner sie finden. Der Zugriff endet mit `grants revoke` (ein Zugang, ein Konto oder alle),
dem `/revoke`-Aufruf des Clients (RFC 7009), einem neuen Server-Geheimnis ohne `_PREVIOUS` (alles)
oder einem neu erzeugten sevDesk-Token. Ein neu erzeugtes Token stoppt Werkzeugaufrufe sofort, weil
sevDesk das alte ablehnt, und widerruft jeden Zugang, der es hält, bei dessen nächster Erneuerung;
es beendet keine Postfach-Sitzungen, denn eine Anmeldung mit eingefügtem Token ist nicht an dieses
Token gebunden (sie gilt bis zu 12 Stunden), und eine Sitzung aus einer Zustimmung gilt, bis ihr
Zugang widerrufen wird. `grants revoke --account <id>` beendet die Zugänge und jede
Postfach-Sitzung des Kontos auf einmal. Ein Server, der seine Sperre auf das Zustandsverzeichnis an
einen anderen verliert, vertraut seinem Zugangsspeicher nicht mehr (OAuth-Anfragen scheitern mit
einem Serverfehler) und beendet sich, sodass er nie aus Zugängen antwortet, die er nicht mehr
aktuell halten kann.

**Was das Server-Geheimnis entschlüsseln kann.** Jeder Schlüssel stammt aus `SEVDESK_HTTP_SECRET`.
Wer es hat und einen Autorisierungscode, ein Access- oder Refresh-Token oder den Formularzustand
einer Zustimmungsseite abfängt (von einem Client, aus einem Proxy-Log, von einer Middlebox, die TLS
terminiert), kann das sevDesk-Token darin lesen. Das Geheimnis allein liefert kein sevDesk-Token,
weil der Server keines speichert. Bewahren Sie es in einem Secret-Speicher auf
(`SEVDESK_HTTP_SECRET_FILE`), nie im Image, im Repository oder in einer Deploy-Vorlage, und
schützen Sie auch das Zustandsverzeichnis: Mit dem Geheimnis und einer Kopie davon könnte jemand
eine Postfach-Sitzung für eine aufgeführte Sitzungs-ID fälschen. Wenn das Geheimnis nach außen
gelangt sein könnte, ersetzen Sie es ohne `_PREVIOUS` (jeder Client verbindet sich neu); wenn auch
Tokens nach außen gelangt sein könnten, erzeugen Sie die sevDesk-Tokens neu und führen
`grants revoke --account <id>` für die betroffenen Konten aus.

**Das Freigabe-Postfach.** Im Fernzugriff stellt `SEVDESK_CONFIRM=browser` ein Postfach unter
`<public URL>/approvals` bereit. Seine URL ist nicht geheim: Das Modell sieht sie im Ergebnis des
Werkzeugs, und ohne Sitzung zeigt das Postfach nur ein Anmeldeformular, keine Daten von Freigaben.
Ein Browser erhält eine Sitzung bei der OAuth-Zustimmung oder durch Einfügen des sevDesk-Tokens
(OAuth: bei sevDesk und gegen die Kontenliste geprüft; Bearer: in konstanter Zeit mit dem
`SEVDESK_API_TOKEN` des Servers verglichen, nie mit dem Bearer-Geheimnis, das der Client hält).
Anmeldungen sind auf 5 pro Minute und 20 pro Stunde je Client-Adresse begrenzt (IPv6 je
/64-Netz). Das Sitzungs-Cookie ist verschlüsselt und enthält kein sevDesk-Token, ist `HttpOnly`,
`Secure`, `SameSite=Lax` und mit `__Host-` präfixiert, gilt 12 Stunden, bekommt bei jeder Anmeldung
eine neue ID und endet mit seinem Zugang oder mit `grants revoke --account`. `Lax` ist nötig, weil
dem Link von claude.ai aus gefolgt wird, einer seitenübergreifenden Navigation; Entscheidungen sind
POSTs, die außerdem ein an die Sitzung gebundenes CSRF-Token tragen und aus dem Postfach selbst
kommen müssen (Origin oder `Sec-Fetch-Site: same-origin`; nie `Origin: null`). Jede Entscheidung
prüft, dass die Freigabe zum Konto der Sitzung gehört. Eine Freigabe gehört dem Zugang, der gefragt
hat: Ein erneuter Versuch aus einer anderen Verbindung, auch desselben Kontos, kann sie nicht
nutzen. Freigaben binden weiterhin Werkzeug, Argumente und Vorschau, laufen nach 10 Minuten ab,
werden einmal verwendet, und höchstens fünf je Konto warten gleichzeitig. Ein Konto behält
höchstens 20 Freigaben, wartende und entschiedene, und schafft Platz unter seinen eigenen. Der
Server behält insgesamt 100. Ist das erreicht, kommt Platz nur von einem Konto, das mehr Freigaben
hält als das anfragende: zuerst dessen älteste abgelehnte oder wartende, zuletzt eine erteilte,
die noch nicht verwendet wurde (ihr Besitzer wird beim nächsten Versuch erneut gefragt, wie nach
einem Ablauf). So verliert kein Konto eine Freigabe an eines, das gleich viele oder mehr hält, und
wenige Konten, die erteilte Freigaben ungenutzt lassen, können die anderen nicht am Fragen hindern.

**Grenzen des Postfachs.** Ein Agent, der einen angemeldeten Browser steuern kann
(Browser-Automatisierung, ein Werkzeug zur Computersteuerung), kann trotzdem selbst freigeben: Wie
die lokale Seite schützt das Postfach vor einem Modell, das nur redet. Eine nachgeahmte Seite
könnte das sevDesk-Token abgreifen; fügen Sie es nur unter `/approvals` Ihres eigenen Servers ein
(die meisten Benutzer müssen das nie, weil die Zustimmung den Browser anmeldet). Alle, die sich an
einem Konto anmelden können, teilen sich sein Postfach und können über seine Freigaben entscheiden;
sie halten ohnehin das Token dieses Kontos. Eine Sitzung bleibt in diesem Browser 12 Stunden
gültig; melden Sie sich an einem gemeinsam genutzten Rechner also ab; ein neu erzeugtes
sevDesk-Token beendet sie nicht (verwenden Sie `grants revoke --account`). Bei einer öffentlichen
Loopback-URL über einfaches http (Entwicklung) hat das Cookie kein `__Host-`-Präfix und kein
`Secure`-Flag, und Browser trennen Cookies nicht nach Port: Jeder andere Webserver, den der Browser
unter diesem Hostnamen erreicht, erhält das Sitzungs-Cookie und könnte Freigaben lesen und
entscheiden. Verwenden Sie für alles über einen kurzen lokalen Test hinaus https oder ein eigenes
Browserprofil. Ein Neustart macht ausstehende Freigaben ungültig.

**Logs.** Eine JSON-Zeile pro Anfrage auf stderr: die Routen-Vorlage, Status, Dauer, Client-IP und
die ersten 8 Zeichen der Zugangs-ID. Header, Bodys, Cookies und Query-Strings werden nie
protokolliert, und jede Zeile wird vom sevDesk-Token, den Bearer-Geheimnissen, dem
Server-Geheimnis, verschlüsselten Tokens und jeder Folge von 32 oder mehr Hex-Ziffern bereinigt
(die Form eines sevDesk-Tokens). Fehler, HTML-Seiten und Weiterleitungen enthalten nie ein
Geheimnis, und das Zugangsobjekt im Speicher lässt das sevDesk-Token aus, wenn es serialisiert oder
inspiziert wird. Sicherheitsereignisse werden mit Namen protokolliert (`refresh_replay`,
`code_replay`, `account_refused`, `cimd_blocked`).

**Was Aufgabe des Betreibers bleibt.** TLS vor dem Server (ein Reverse Proxy, der Rand einer
Plattform oder ein Tunnel; wer TLS terminiert, kann Tokens unterwegs sehen, wählen Sie also einen
Anbieter, dem Sie vertrauen, und nutzen Sie schnelle Tunnel nur für Tests), das Server-Geheimnis,
ein dauerhaftes Volume für das Zustandsverzeichnis, genau eine Instanz, enge Erlaubnislisten und
das Aktualisieren des Images.

## Fernzugriff: Dateien

Mit aktivem `SEVDESK_HTTP_FILES` (der Standard) erreichen Dateien die Werkzeuge über Upload-Seiten
und verlassen den Server als Download-Links
([docs/remote.de.md](docs/remote.de.md#dateien-hochladen-und-herunterladen),
[ADR 0008](docs/adr/0008-file-transfer-over-http.md)). Das Modell sieht und sendet nie den Inhalt
einer Datei.

**Links sind keine Berechtigungen.** `sevdesk_upload_request` gibt `<public URL>/uploads/<id>`
zurück und die liefernden Werkzeuge `<public URL>/files/<id>`: Das Modell sieht beide, also ist
keiner geheim. Jede Seite braucht die Browser-Sitzung des Freigabe-Postfachs für das Konto des
Datensatzes (gesetzt bei der OAuth-Zustimmung oder durch Anmeldung mit dem sevDesk-Token des
Kontos; im Bearer-Modus nie mit dem Bearer-Geheimnis). Ohne Sitzung zeigt eine Seite nur das
Anmeldeformular, dessen `next` nur die eigenen Datensatzpfade des Servers annimmt (keine offene
Weiterleitung). Ein Datensatz eines anderen Kontos antwortet genau wie eine unbekannte ID (404).
Werkzeuge lesen nur Uploads, die ihr eigener Zugang angefordert hat; ein anderer Zugang, auch
desselben Kontos, erhält dieselbe Ablehnung wie für eine unbekannte ID. IDs sind 256 Bit zufällig;
Fehlermeldungen, Zusammenfassungen und Logs enthalten sie nie.

**Uploads.** Die Seite zeigt nur vertrauenswürdige Werte (Zweck, angenommene Arten, Größengrenze,
Konto, Referenz, Ablauf), sodass ein durch Prompt Injection gesteuertes Modell keine Anweisungen
darauf setzen kann. Ein Upload ist ein POST vom selben Origin (`Origin: null` abgelehnt) mit einem
an die Sitzung gebundenen CSRF-Token, genau den Feldern `csrf` und `file`, und besteht seine
Prüfungen, bevor der Body gelesen wird: Ratenbegrenzung (10 pro Minute und 60 pro Stunde je
Client), die Sitzung, ein offenes Ticket dieses Kontos, ein angegebenes `Content-Length` (411 ohne)
innerhalb der Grenze (413) und höchstens zwei Bodys gleichzeitig (503). Der Dateityp wird am
Inhalt geprüft (Belege PDF, PNG, JPEG; E-Rechnungen XML, PDF); kein ZIP wird angenommen, Bilder
werden nie dekodiert, und der E-Rechnungs-Parser behält seine eigenen Schutzmechanismen gegen
feindliches XML und PDFs. Namen werden auf `[A-Za-z0-9._-]` bereinigt (Umlaute ausgeschrieben,
Pfadanteile, Steuer- und unsichtbare Zeichen, Anführungszeichen und Markup entfernt, höchstens 100
Zeichen, Endung aus dem Inhalt), immer maskiert und nie als Pfade verwendet. Jede Seite nimmt eine
Datei an; Uploads werden nie wieder ausgeliefert.

**Downloads.** Die Bytes werden während des Werkzeugaufrufs von sevDesk geholt (PDFs mit
`preventSendBy=true`); das Öffnen eines Links stellt keine Anfrage an sevDesk und hat keine
Nebenwirkung. Antworten sind nur Anhänge (`Content-Disposition: attachment` mit einem ASCII- und
einem RFC-5987-Namen), mit `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`,
`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`,
`Referrer-Policy: no-referrer` und `Cache-Control: no-store`: Eine Datei wird nie auf dem Origin
des Servers dargestellt, wo XML Skripte ausführen könnte. HEAD wird abgelehnt. Ein Link liefert
höchstens 5 Downloads. Eine Antwort wird in Stücken von 64 KiB geschrieben, und die Verbindung
wird geschlossen, wenn der Browser eine Minute lang keines davon abnimmt: Ein Browser, der nicht
mehr liest, kann die Datei nicht lange im Speicher halten, während eine langsame Verbindung, die
weiterliest, die ganze Datei bekommt.

**Speicherung.** Datensätze liegen nur im Speicher; die Bytes im Speicher oder in
`<stateDir>/files/` (Ordner 0700, Dateien 0600, exklusiv angelegt, ohne Links zu folgen, zufällige
Namen), verschlüsselt mit AES-256-GCM unter einem Schlüssel, der beim Start des Prozesses zufällig
erzeugt und nirgends gespeichert wird, mit authentifizierter Blob-ID, Konto und Art (ein zwischen
Datensätzen vertauschter Blob lässt sich nicht öffnen). Dateien werden gelöscht, wenn sie ablaufen,
und beim Herunterfahren, und der Ordner wird bei jedem Start geleert, nachdem die Sperre des
Zustandsverzeichnisses übernommen wurde (ein zweiter Server rührt die Dateien eines laufenden nie
an). Eine Kopie des Volumes oder des Server-Geheimnisses öffnet keine von ihnen. Upload-Seiten
leben 15 Minuten, Uploads und Links `SEVDESK_HTTP_FILES_TTL` (30 Minuten, höchstens 24 Stunden).

**Erschöpfung.** Ein Upload ist höchstens 20 MiB groß; ein Konto hält höchstens 5 offene
Upload-Seiten, 10 Uploads und Links und die Hälfte von `SEVDESK_HTTP_FILES_MAX_MB`; der Server
höchstens 1.000 Datensätze und das volle Budget. Nichts wird verdrängt, sodass ein Konto die
Dateien eines anderen nicht hinausdrängen kann; neue Anfragen werden abgelehnt, bis ältere
ablaufen.

**Logs und Audit.** Logzeilen und die Audit-Zeilen `file_received`, `file_link_created` und
`file_downloaded` tragen Konto, Zugang, Referenzcode, Art, Größe und SHA-256, nie IDs, Dateinamen
oder Inhalt; Anfragezeilen zeigen die Routen-Vorlagen `/uploads/*` und `/files/*`, und ein
`upload:`-Argument eines Werkzeugs wird als `upload:[REDACTED]` in das Audit-Log geschrieben.

**Grenzen.** Ein Agent, der einen angemeldeten Browser steuern kann, könnte selbst hoch- oder
herunterladen, so wie er im Postfach freigeben könnte. Bei einer öffentlichen Loopback-URL über
einfaches http erhalten andere lokale Webserver das Sitzungs-Cookie (der Start warnt). Wer TLS
terminiert, sieht die Dateien unterwegs. Mit `SEVDESK_OAUTH_ACCOUNTS=any` hält der Server
kurzzeitig Belege und Exporte anderer Leute (der Start warnt). Eine heruntergeladene Datei ist das,
was sevDesk geliefert hat.

## Lieferkette

Releases werden aus der CI mit npm-Provenance veröffentlicht (Trusted Publishing, keine langlebigen
Tokens), GitHub Actions sind per Commit-SHA festgelegt, und das Repository wird von CodeQL, Dependency
Review und OpenSSF Scorecard geprüft.

Das Container-Image `ghcr.io/jaylann/mcp-server-sevdesk` wird vom Release-Workflow aus Basis-Images
gebaut, die per Digest festgelegt sind. Es läuft als Benutzer ohne root-Rechte (uid 65532) auf
einer distroless-Basis mit Node.js, und jedes Release trägt eine Build-Provenance-Attestierung
sowie die SBOM und Provenance von BuildKit. Prüfen Sie ein Image, bevor Sie es betreiben, und legen
Sie dann den geprüften Digest fest:

```bash
gh attestation verify oci://ghcr.io/jaylann/mcp-server-sevdesk:<version> --owner jaylann
docker buildx imagetools inspect ghcr.io/jaylann/mcp-server-sevdesk:<version> --format '{{ json .SBOM }}'
```

Auch die Claude-Desktop-Erweiterung (`mcp-server-sevdesk-<version>.mcpb`) baut der Release-Workflow
und hängt sie mit einer Build-Provenance-Attestierung an das GitHub-Release:

```bash
gh attestation verify mcp-server-sevdesk-<version>.mcpb --owner jaylann
```

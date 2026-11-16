<!-- translated-from: docs/adr/0001-curated-tools-and-toolsets.md sha256:a86a1cad87da -->

# ADR 0001: Kuratierte Aufgabenwerkzeuge, Werkzeuggruppen und ein nur lesendes generisches GET

- **Status:** Angenommen; die Zielwerte der Entscheidung für die Zahl der Werkzeuge sind aufgegeben,
  siehe
  [Nachtrag 2026-11-11](#nachtrag-2026-11-11-zielwerte-für-die-zahl-der-werkzeuge-aufgegeben)
- **Datum:** 2026-11-07

## Kontext

Die sevDesk-API hat 154 dokumentierte Operationen (Stand der Spezifikation vom 2026-10-06) und
dazu mehrere undokumentierte, die echte Integrationen brauchen. Bestehende MCP-Server für sevDesk
bieten sie auf eine von drei Arten an:

- **Ein Werkzeug je Endpunkt.** Ein Server hat zum Beispiel 103 CRUD-Werkzeuge. Jede Eigenheit der
  API (stilles Abschneiden nach 100 Datensätzen, `getPdf` markiert Dokumente als versendet, die
  Steuerfelder von Update 2.0, der Pflichtwert `contactPerson`) wird zum Problem des Modells. Falsch
  fest eingetragene IDs waren der häufigste Fehlertyp, den wir in diesen Servern gefunden haben.
- **Wenige generische Werkzeuge**, die jede Operation mit einem rohen Body annehmen. Die
  Werkzeugliste ist kurz, aber das Modell muss die API kennen, und Schreibvorgänge umgehen jede
  Prüfung und Bestätigung.
- **Dynamische Werkzeuggruppen oder ein Werkzeugsuch-Gateway** auf dem Server: Meta-Werkzeuge, die
  zur Laufzeit Gruppen von Werkzeugen auflisten, durchsuchen oder aktivieren.

Was die Wahl geprägt hat:

- Die Treffsicherheit bei der Werkzeugwahl sinkt mit der Zahl der Werkzeuge, und jede
  Werkzeugdefinition kostet bei jeder Anfrage Kontext-Tokens
  ([RAG-MCP, arXiv:2505.03275](https://arxiv.org/abs/2505.03275);
  [Speakeasy, „Less is more“](https://www.speakeasy.com/mcp/tool-design/less-is-more)). Berichte
  sehen den kritischen Bereich zwischen einigen Dutzend und etwa 100 Werkzeugen.
- GitHub hat die dynamischen Werkzeuggruppen im Mai 2026 aus seinem MCP-Server entfernt
  ([github/github-mcp-server#2512](https://github.com/github/github-mcp-server/pull/2512)): Der
  Modus brachte einen zweiten Registrierungsweg und Meta-Werkzeuge mit, und der entfernte Server
  hat ihn nie angeboten.
- MCP-Clients stellen Werkzeugdefinitionen inzwischen selbst zurück und durchsuchen sie
  (schrittweise Erschließung). Ein Gateway auf dem Server macht diese Arbeit doppelt und versteckt
  Werkzeuge vor Clients, die das besser können.
- MCP 2026-07-28 hat keine Sitzung auf Protokollebene, und unser HTTP-Modus ist zustandslos
  ([ADR 0004](0004-stateless-remote-oauth.de.md)). „Aktiviere eine Werkzeuggruppe, dann erscheinen
  auf dieser Verbindung neue Werkzeuge“ passt nicht zu diesem Modell.

## Entscheidung

- **Kuratierte Werkzeuge in der Form von Aufgaben.** Jedes Werkzeug erledigt eine
  Buchhaltungsaufgabe und bringt das sevDesk-Wissen dafür mit: Der Entwurf einer Rechnung füllt
  `contactPerson` und wählt die Steuerfelder passend zur Systemversion des Kontos; das Erzeugen
  eines PDF setzt immer `preventSendBy`; Listenwerkzeuge blättern und fassen auf dem Server
  zusammen. Werkzeugnamen folgen `sevdesk_<resource>_<verb>`.
- **Eine Stufe je Werkzeug; Lesen und Schreiben teilen sich nie ein Werkzeug** (siehe
  [ADR 0003](0003-tiers-and-human-confirmation.de.md)).
- **Werkzeuggruppen** (`meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`,
  `banking`, `parts`, `reports`, `advanced`), gewählt mit `SEVDESK_TOOLSETS`. Die nur lesende
  Standardauswahl umfasst etwa 20 Werkzeuge; mit allem aktiviert bleiben es höchstens 45.
- **Statische Registrierung.** Die Werkzeugliste steht für die Lebensdauer einer Serverinstanz fest
  und wird nur beim Start nach Werkzeuggruppe und Stufe gefiltert. `tools/list` liefert eine Seite in
  stabiler Reihenfolge. Keine Meta-Werkzeuge, die Werkzeuge aktivieren, auflisten oder suchen.
- **Stammdaten als Nachschlagewerkzeug und Ressourcen.** Steuerregeln, Buchungskonten, Einheiten,
  Länder und Zahlungsarten kommen aus einem `lookup`-Werkzeug und aus MCP-Ressourcen statt als IDs
  in Beschreibungen.
- **Notausgang, nur lesend.** Die Werkzeuggruppe `advanced` (standardmäßig aus) enthält ein
  generisches `api_get` für jeden GET-Pfad, mit Prüfung des Pfads, und lehnt GETs ab, die Zustand
  ändern. Es gibt **kein generisches Schreibwerkzeug**: Jeder Schreibvorgang läuft über ein
  kuratiertes Werkzeug mit Prüfung, Probelauf und Bestätigung.

## Folgen

- Vorteil: Das Modell wählt aus einer kleinen Zahl klar benannter Werkzeuge; weniger Tokens je
  Anfrage.
- Vorteil: Sicherheit und API-Wissen stecken in getestetem Code, nicht in Prompts.
- Vorteil: Der Werkzeugbestand lässt sich prüfen. Ein `tools/list`-Snapshot je Stufenkonfiguration
  und ein Lint der Metadaten laufen in der CI, und PRs zeigen die Änderung am Werkzeugbestand.
- Nachteil: Die Abdeckung wächst nur so schnell, wie wir Werkzeuge schreiben. Eine Operation ohne
  kuratiertes Werkzeug ist über `api_get` nur lesend erreichbar und für Schreibvorgänge gar nicht.
- Nachteil: mehr Code zu pflegen als bei einer generierten 1:1-Abbildung. Mitwirkende können
  Endpunkte über ein Issue-Formular anfragen, und „ein Werkzeug in 5 Schritten hinzufügen“ ist unter
  [Änderungen vornehmen](../contributing/changes.de.md#ein-werkzeug-hinzufügen) beschrieben.

## Erwogene Alternativen

- **1:1-Abbildung der Endpunkte (generiert).** Verworfen: zu viele Werkzeuge für eine verlässliche
  Auswahl, schiebt die Eigenheiten der API dem Modell zu und erbt die Fehler der Spezifikation
  ([ADR 0002](0002-hand-written-zod-schemas.de.md)).
- **Generisches Aufrufwerkzeug für alle Methoden.** Für Schreibvorgänge verworfen: Es umgeht
  Prüfung, Stufen und Bestätigung. Für Lesezugriffe als `api_get` behalten.
- **Dynamische Werkzeuggruppen oder ein Werkzeugsuch-Gateway auf dem Server.** Verworfen: Clients
  erschließen Werkzeuge inzwischen selbst schrittweise, es passt nicht zu einem zustandslosen
  Server, und GitHub hat denselben Modus aufgegeben.

## Nachtrag 2026-11-11: Zielwerte für die Zahl der Werkzeuge aufgegeben

Die Entscheidung sagt, die nur lesende Standardauswahl umfasse „etwa 20 Werkzeuge“ und mit allem
aktiviert bleibe es „höchstens 45“. Beide Zahlen waren Schätzungen von vor dem ersten
geschriebenen Werkzeug, und keine hält: Mit Release 1.2.0 hat der Server 74 Werkzeuge (37 `read`,
16 `write`, 18 `commit`, 3 `external`; [docs/tools.md](../tools.md)). Die Standardkonfiguration
listet 31 davon, und ein Server mit allen Werkzeuggruppen, allen Stufen und Dateiübertragung listet
alle 74. Nichts im Code oder in den Tests erzwingt eine Zahl.

Aufgegeben sind die Zahlen, nicht die Werkzeuge, denn die Zahl folgt aus den übrigen Regeln dieser
Entscheidung und aus dem, was der Server abdeckt:

- Eine Aufgabe und eine Stufe je Werkzeug macht jeden Schritt im Lebenszyklus jedes Dokumenttyps zu
  einem eigenen Werkzeug: 18 `commit`-Werkzeuge (fertigstellen, eine Zahlung buchen, festschreiben,
  zurücksetzen, stornieren, einen Entwurf löschen sowie einen Kontoumsatz buchen, als privat
  markieren oder zurücksetzen) und 3 `external`-Werkzeuge (per E-Mail versenden). Weniger, breitere
  Werkzeuge würden diese Regel brechen.
- Die Abdeckung ist gewachsen: Belege mit Belegdateien, E-Rechnungen, Zuordnung von
  Kontoumsätzen, Umsatzsteuer-Auswertung und Gewinn- und Verlustrechnung sowie die DATEV- und
  CSV-Exporte.

Was die Liste begrenzt, die ein Modell sieht, ist unverändert: `SEVDESK_TOOLSETS` und
`SEVDESK_ALLOW` filtern sie beim Start, Werkzeuge oberhalb der aktivierten Stufen werden nicht
registriert, 7 Werkzeuge erscheinen nur, wo Dateien gelesen oder ausgeliefert werden können, und
Clients stellen Werkzeugdefinitionen selbst zurück (siehe Kontext). Der Rest der Entscheidung
gilt weiter: kuratierte Aufgabenwerkzeuge, statische Registrierung, keine Meta-Werkzeuge, kein
generisches Schreibwerkzeug.

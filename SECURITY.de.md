<!-- translated-from: SECURITY.md sha256:e9536cff9cfa -->

# Sicherheitsrichtlinie

Wie du eine Schwachstelle in mcp-server-sevdesk meldest, welche Versionen Korrekturen bekommen und
gegen welches Bedrohungsmodell der Server gebaut ist. Die ausführliche Analyse jedes Teils steht auf
den Seiten unter [Details](#details).

## Eine Schwachstelle melden

Bitte **eröffne kein öffentliches Issue**. Melde Schwachstellen vertraulich über
[GitHub Private Vulnerability Reporting](https://github.com/jaylann/mcp-server-sevdesk/security/advisories/new).
Du erhältst innerhalb von 72 Stunden eine Eingangsbestätigung und für bestätigte Probleme innerhalb
von 14 Tagen eine Behebung oder einen Plan zur Abhilfe. Im Advisory wirst du genannt, sofern du das
nicht anders wünschst.

## Unterstützte Versionen

Sicherheitskorrekturen erhält nur die neueste veröffentlichte Version.

## Bedrohungsmodell

Dieser Server steht zwischen einem KI-Modell und einem sevDesk-Konto. Der Entwurf geht davon aus:

1. **Das sevDesk-API-Token kann alles.** sevDesk-Tokens haben keine einschränkbaren Rechte und
   laufen nie ab; sie können alles, was ihr Benutzer kann, im gesamten Konto. Der Server setzt
   deshalb seine eigenen minimalen Rechte durch: Werkzeuge sind in Stufen gruppiert (`read`,
   `write`, `commit`, `external`), nur `read` ist standardmäßig aktiv, und Werkzeuge oberhalb der
   erlaubten Stufen werden nie registriert. Die Stufe wird bei jedem Aufruf erneut durchgesetzt und
   im HTTP-Client, der die Mindeststufe jedes sevDesk-Endpunkts kennt (zum Beispiel brauchen
   `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`, das Fertigstellen eines Belegs und das
   Ändern eines Kontoumsatzes die Stufe `commit`; `sendViaEmail` braucht `external`) und eine
   Anfrage eines Werkzeugs mit zu niedriger Stufe ablehnt.
   ([Berechtigungen](docs/permissions.de.md#stufen))
2. **Das Modell kann manipuliert werden.** Text, der in sevDesk gespeichert ist (Kontaktnamen,
   Beschreibungen von Rechnungen und Belegen, Verwendungszwecke von Überweisungen, Inhalte von
   E-Rechnungen), kann von Dritten stammen und Prompt Injection enthalten. Solcher Text wird als
   nicht vertrauenswürdige Daten behandelt: In der Ausgabe ist er eingefasst, unsichtbares Unicode
   wird entfernt, und er erscheint nie in Fehlermeldungen. Rechtlich bindende oder nach außen
   wirkende Aktionen (`commit`, `external`) erfordern eine **Bestätigung durch einen Menschen**
   außerhalb der Kontrolle des Modells (MCP-Elicitation oder eine Freigabeseite); ein
   `confirm`-Flag des Modells wird nie als Freigabe angenommen.
   ([Bestätigung durch einen Menschen](docs/security/confirmation.de.md))
3. **Es gibt keine Testumgebung.** Jeder Schreibvorgang ist echt. Schreibvorgänge werden nie
   automatisch wiederholt (um Dubletten zu vermeiden), zur Prüfung zurückgelesen, können als
   Probelauf laufen (`dryRun: true` oder `SEVDESK_DRY_RUN=1`: Das Werkzeug liest, prüft und gibt
   seine Vorschau zurück, sendet nichts und fragt niemanden) und können in einem lokalen Audit-Log
   festgehalten werden. ([Probelauf](docs/permissions.de.md#probelauf),
   [Audit-Log](docs/permissions/audit-log.de.md))
4. **Geheimnisse dürfen nicht nach außen gelangen.** Das Token wird aus der Umgebung, einer Datei
   oder dem Schlüsselbund des Betriebssystems gelesen; es wird nie protokolliert, ausgegeben oder in
   Fehler aufgenommen. Logs gehen nur nach stderr. Im Fernzugriff gilt dasselbe für die Bearer- und
   Server-Geheimnisse, versiegelte Tokens, Autorisierungscodes und Cookies.
   ([Lokale Nutzung](docs/security/local.de.md#lokale-token-ablage-und-profile),
   [Fernzugriff](docs/security/remote.de.md#logs))
5. **Auch lokale Dateien sind eine Grenze.** Das Modell nennt Dateien; der Server darf also nicht
   zu einem Weg werden, beliebige Dateien zu lesen oder zu schreiben. Werkzeuge lesen nur innerhalb
   von `SEVDESK_FILE_DIRS` und schreiben nur neue Dateien innerhalb von `SEVDESK_OUTPUT_DIR`; ohne
   diese Einstellungen greift kein Werkzeug auf lokale Dateien zu. Empfangene E-Rechnungen und PDFs
   werden als feindliche Eingaben mit Grenzen für Größe und Aufwand gelesen, und der DATEV-Export
   wird von genau einem Host ohne Zugangsdaten geholt. Ein Beleg von einem https-Link wird nur von
   den Hosts in `SEVDESK_FILE_URL_HOSTS` (standardmäßig keine) geladen, nur von öffentlichen
   Adressen und ohne Zugangsdaten.
   ([Lokale Dateien](docs/security/local.de.md#lokale-dateien),
   [Dateien von einem Link](docs/security/local.de.md#dateien-von-einem-link))
6. **Der Fernzugriff fügt eine Netzwerkgrenze hinzu.** Der HTTP-Transport startet nicht ohne
   Authentifizierung, lauscht standardmäßig auf 127.0.0.1 (jede andere Adresse braucht eine
   konfigurierte öffentliche URL) und prüft Host und Origin. Im OAuth-Modus ist er standardmäßig
   auf eigene Konten beschränkt (nur aufgeführte sevDesk-Konten können sich verbinden, nur Clients
   auf der Erlaubnisliste können fragen), speichert keine sevDesk-Tokens (das Token jedes Benutzers
   reist versiegelt in den Tokens, die sein Client hält) und ordnet Freigaben, Bestätigungen und
   Caches dem Konto und Zugang jeder Anfrage zu.
   ([Fernzugriff](docs/security/remote.de.md))

Die Bestätigungsarten haben bekannte Grenzen, die bei jeder von ihnen beschrieben sind: `elicit`
vertraut der MCP-Client-Anwendung, und ein Agent, der das Log des Servers lesen oder den Browser des
Benutzers steuern kann, kann eine `browser`-Bestätigung selbst freigeben
([Bestätigung durch einen Menschen](docs/security/confirmation.de.md#worauf-sich-die-elicitation-verlässt)).

### Nicht im Umfang

Schwachstellen in sevDesk selbst (melde diese der sevdesk GmbH) und Angriffe, die die Kontrolle über
den Rechner voraussetzen, auf dem der Server läuft.

## Details

| Seite                                                                | Was sie behandelt                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [Berechtigungen](docs/permissions.de.md)                             | Stufen, was das Modell sieht, wie ein Schreibvorgang abläuft, Probelauf, Bestätigungsarten, Empfehlungen.                    |
| [Audit-Log](docs/permissions/audit-log.de.md)                        | Ereignisse, Felder und die Integrität des lokalen Audit-Logs.                                                                |
| [Bestätigung durch einen Menschen](docs/security/confirmation.de.md) | Wie Vorschauen erstellt und gehärtet werden, was eine Freigabe bindet, die Elicitation und die lokale Freigabeseite.         |
| [Lokale Nutzung](docs/security/local.de.md)                          | Lokale Dateien und E-Rechnungen, das generische Lesewerkzeug, der Schlüsselbund, Profile und die Claude-Desktop-Erweiterung. |
| [Fernzugriff](docs/security/remote.de.md)                            | Netzwerk, Bearer und OAuth, Abruf von Client-Metadaten, Tokens und Widerruf, das Freigabe-Postfach, Dateiübertragung.        |
| [Lieferkette](docs/security/supply-chain.de.md)                      | Herkunftsnachweise der Releases, das Container-Image und die Prüfung der Claude-Desktop-Erweiterung.                         |
| [Sicherheitsmodell](docs/architecture/safety.de.md)                  | Wie Stufen, Bestätigungen, Sperren von Datensätzen und nicht vertrauenswürdiger Text im Code durchgesetzt werden.            |
| [Datenschutz](PRIVACY.de.md)                                         | Welche Daten wohin fließen und was gespeichert wird.                                                                         |

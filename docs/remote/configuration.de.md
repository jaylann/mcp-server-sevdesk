<!-- translated-from: docs/remote/configuration.md sha256:f21d66a8854d -->

# Konfigurationsreferenz

Jede Variable des [Fernzugriffs](../remote.de.md), wie sich die Variablen des stdio-Modus unter
`--http` ändern und wobei der Start abbricht oder warnt. Die Variablen, die mit stdio geteilt sind,
stehen unter [Konfiguration](../configuration.de.md#variablen).

Alle Variablen werden beim Start gelesen. Der Start meldet alle Probleme auf einmal und verweigert
sich, bis alle behoben sind. Variablen, die auf `_FILE` enden, lesen den Wert stattdessen aus einer
Datei (Docker- und Kubernetes-Secrets); setze die eine oder die andere.

## HTTP-Variablen

| Variable                                 | Standard                              | Bedeutung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_HTTP_AUTH`                      | (Pflicht)                             | `bearer` oder `oauth` ([Bearer oder OAuth](../remote.de.md#bearer-oder-oauth)).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SEVDESK_HTTP_HOST`                      | `127.0.0.1` (Image: `0.0.0.0`)        | Adresse, auf der der Server lauscht. Alles außer einer Loopback-Adresse braucht `SEVDESK_HTTP_PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SEVDESK_HTTP_PORT`                      | `$PORT`, sonst `8080` (Image: `8080`) | Port, 0–65535 (0 wählt einen freien Port, für Tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SEVDESK_HTTP_PUBLIC_URL`                |                                       | Der Origin, den Clients verwenden, zum Beispiel `https://mcp.example.com`: nur Schema, Host und Port, ohne Pfad, Query, Fragment oder Zugangsdaten. https, außer der Host ist `localhost`, `127.0.0.1` oder `[::1]`. Pflicht für OAuth und wenn der Server nicht nur auf Loopback lauscht. Der MCP-Endpunkt (und die OAuth-Ressource) ist `<origin>/mcp`, der OAuth-Issuer ist der Origin. Jede URL, die der Server ausgibt oder auf die er weiterleitet, wird daraus gebaut, nie aus Headern der Anfrage.                   |
| `SEVDESK_HTTP_ALLOWED_HOSTS`             |                                       | Weitere Hostnamen, die im `Host`-Header angenommen werden, durch Kommas getrennt. Der Host der öffentlichen URL wird immer angenommen (bei Loopback ohne öffentliche URL die Loopback-Namen).                                                                                                                                                                                                                                                                                                                                |
| `SEVDESK_HTTP_ALLOWED_ORIGINS`           |                                       | Weitere Werte, die im `Origin`-Header von `/mcp`-Anfragen angenommen werden, durch Kommas getrennt; die Prüfung vergleicht nur Hostnamen (beliebiges Schema, beliebiger Port). Der öffentliche Origin wird immer angenommen, und Anfragen ohne `Origin` passieren. `/mcp` sendet keine CORS-Header und beantwortet kein Preflight (`OPTIONS`); MCP-Clients, die in einer Webseite auf einem anderen Origin laufen, werden also nicht unterstützt: Das lässt nur Clients zu, die selbst einen solchen `Origin`-Header senden. |
| `SEVDESK_HTTP_TRUST_PROXY`               | `0`                                   | Reverse Proxys vor dem Server, 0–5. Die Client-IP (Ratenbegrenzung, Logs) ist der Eintrag, der so viele Stellen von rechts in `X-Forwarded-For` steht.                                                                                                                                                                                                                                                                                                                                                                       |
| `SEVDESK_HTTP_BEARER_TOKEN` (`_FILE`)    |                                       | Bearer-Modus, Pflicht: das Client-Geheimnis, oder zwei durch Komma getrennte Geheimnisse während eines Wechsels. Jedes mindestens 32 Zeichen mit mindestens 16 verschiedenen, ohne Leerraum und nicht das sevDesk-Token.                                                                                                                                                                                                                                                                                                     |
| `SEVDESK_HTTP_SECRET` (`_FILE`)          |                                       | OAuth, Pflicht: das Server-Geheimnis, mit dem alle Tokens und Cookies versiegelt werden; mindestens 32 zufällige Bytes, hex oder base64/base64url (`generate-secret`). Optional im Bearer-Modus, wo es Browser-Anmeldungen über einen Neustart hinweg gültig hält.                                                                                                                                                                                                                                                           |
| `SEVDESK_HTTP_SECRET_PREVIOUS` (`_FILE`) |                                       | Das vorige Server-Geheimnis, während du [es wechselst](operations.de.md#das-server-geheimnis-wechseln): Damit versiegelte Tokens werden weiter angenommen und bei der Erneuerung neu versiegelt.                                                                                                                                                                                                                                                                                                                             |
| `SEVDESK_HTTP_STATE_DIR`                 | Speicher (Image: `/data`)             | Absolutes Verzeichnis für den Zugangsspeicher und die verschlüsselten Dateien der Dateiübertragung (`files/`); angelegt mit Modus 0700 (ein bestehendes wird auf 0700 verschärft) und beim Start auf Schreibrechte geprüft. Ohne die Variable enden Zugänge und Browser-Sitzungen mit dem Prozess (der OAuth-Start warnt), und Dateien werden im Speicher gehalten.                                                                                                                                                          |
| `SEVDESK_HTTP_FILES`                     | `on`                                  | [Dateiübertragung](files.de.md): Upload-Seiten für Belege und E-Rechnungen und Download-Links für die Dateien, die Werkzeuge erzeugen. `on`/`off`, `1`/`0`, `true`/`false` oder `yes`/`no`. Aus: keine Seiten, kein `sevdesk_upload_request` und kein `sevdesk_uploads_list`; im OAuth-Modus außerdem kein Werkzeug, das eine Datei zum Lesen oder einen Ort zum Speichern braucht. Die PDF- und XML-Werkzeuge und die `sevdesk://`-Ressourcen bleiben: Ein Client liest Dokumentdateien weiterhin über MCP.                 |
| `SEVDESK_HTTP_FILES_MAX_MB`              | 256 mit Zustandsverzeichnis, sonst 64 | Mebibyte (MiB), die die hochgeladenen Dateien und Download-Links aller Konten zusammen belegen dürfen, 32 bis 4096. Ein Konto darf ein Viertel davon nutzen (mindestens 20 MiB, höchstens die Hälfte); Platz für einen Upload bleibt für Konten frei, die noch keine Dateien halten. Mit Zustandsverzeichnis liegen die Dateien auf der Festplatte, sonst im Speicher.                                                                                                                                                       |
| `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`     | `10`                                  | Reservierte Dateiplätze für Uploads, hochgeladene Dateien und Download-Links zusammen je sevDesk-Konto, eine ganze Zahl von 1 bis 1000. Die separaten Grenzen von 5 wartenden Seiten und insgesamt 1.000 Einträgen gelten weiterhin; die Byte-Kontingente bleiben unverändert.                                                                                                                                                                                                                                               |
| `SEVDESK_HTTP_FILES_TTL`                 | `30m`                                 | Maximale Gültigkeit einer hochgeladenen Datei und eines Download-Links, 5 Minuten bis 24 Stunden. Erfolgreich angehängte Uploads werden früher freigegeben.                                                                                                                                                                                                                                                                                                                                                                  |
| `SEVDESK_OAUTH_ACCOUNTS`                 |                                       | OAuth, Pflicht: die sevDesk-Konto-IDs, die sich verbinden dürfen, durch Kommas getrennt, oder `any` (der Start warnt).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SEVDESK_OAUTH_CLIENTS`                  | `claude.ai`                           | Hosts, die das Metadaten-Dokument eines Clients (seine `client_id`-URL) liefern dürfen, durch Kommas getrennt, oder `any` (der Start warnt).                                                                                                                                                                                                                                                                                                                                                                                 |
| `SEVDESK_OAUTH_ACCESS_TTL`               | `1h`                                  | Laufzeit des Access-Tokens, 5 Minuten bis 24 Stunden. Unter 10 Minuten warnt der Start: Claude erneuert 5 Minuten vor Ablauf und würde dann bei fast jeder Anfrage erneuern.                                                                                                                                                                                                                                                                                                                                                 |
| `SEVDESK_OAUTH_REFRESH_IDLE_TTL`         | `14d`                                 | Ein Refresh-Token, das so lange ungenutzt bleibt, läuft ab; 1 bis 90 Tage.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SEVDESK_OAUTH_GRANT_TTL`                | `90d`                                 | Laufzeit eines Zugangs ab der Zustimmung; 1 bis 365 Tage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Dauern schreibst du als ganze Zahl mit der Einheit `s`, `m`, `h` oder `d` (`90s`, `30m`, `1h`,
`14d`) oder als bloße Anzahl Sekunden.

## Andere Variablen im HTTP-Modus

Die [Variablen des stdio-Modus](../configuration.de.md#variablen) behalten ihre Bedeutung, mit
diesen Unterschieden:

- **`SEVDESK_API_TOKEN` (`_FILE`)**: Pflicht im Bearer-Modus; dort ist es das Konto, das der Server
  bedient, und das Token, mit dem sich ein Browser an den Seiten des Servers anmeldet
  (Freigabe-Postfach, Uploads und Downloads). Im OAuth-Modus nicht verwendet (der Start warnt, wenn
  es gesetzt ist): Jeder Benutzer fügt sein eigenes Token auf der Zustimmungsseite ein.
- **`SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH`**: abgelehnt. Der
  Schlüsselbund des Betriebssystems und lokale Profile sind für lokale Installationen über stdio;
  ein Container hat keinen Schlüsselbund.
- **`SEVDESK_ALLOW`, `SEVDESK_READ_ONLY`**: das Höchste, was eine Verbindung bekommen darf. Im
  OAuth-Modus bekommt jeder Zugang die Schnittmenge mit den Stufen, die auf der Zustimmungsseite
  angehakt wurden ([Stufen je Zugang](../remote.de.md#stufen-je-zugang)).
- **`SEVDESK_CONFIRM`**: `elicit` (der Standard) funktioniert mit Clients, die das Protokoll
  2026-07-28 sprechen und Formular-Elicitation unterstützen. Clients aus der Zeit von 2025 können
  über zustandsloses HTTP nicht gefragt werden; dazu gehört zum Zeitpunkt des Schreibens auch
  claude.ai. Der Start warnt daher, wenn `elicit` mit der Stufe `commit` oder `external` kombiniert
  ist. `browser` nutzt das [Freigabe-Postfach](approvals.de.md) des Servers.
- **`SEVDESK_CONFIRM_OPEN`**: im HTTP-Modus aus, sofern nicht ausdrücklich gesetzt, und dort ohne
  Wirkung: Freigaben warten im Postfach, das du selbst öffnest. `1` zusammen mit einem Lauschen
  außerhalb von Loopback wird abgelehnt.
- **`SEVDESK_FILE_DIRS`, `SEVDESK_OUTPUT_DIR`**: im OAuth-Modus abgelehnt, weil sich alle
  Verbindungen die Festplatte des Servers teilen würden. Dateien erreichen die Werkzeuge
  stattdessen über [Upload-Seiten und Download-Links](files.de.md) (`SEVDESK_HTTP_FILES`,
  standardmäßig an). Der Bearer-Modus behält sie; die Ordner liegen auf dem Server, nicht auf dem
  Rechner des Clients. Dort kann ein Dateiargument ein Pfad in `SEVDESK_FILE_DIRS` oder ein Upload
  sein, und `SEVDESK_OUTPUT_DIR` hat, wenn gesetzt, Vorrang vor Download-Links: Dateien werden dann
  auf dem Server gespeichert.
- **`SEVDESK_FILE_URL_HOSTS`**: wirkt in jedem Modus, auch mit OAuth: Es berührt keine Festplatte,
  und ein Link wird nur von den Hosts geladen, die du einträgst, von öffentlichen Adressen, ohne
  Zugangsdaten ([Dateien von einem Link](../configuration.de.md#dateien-von-einem-link)). Der
  Server erreicht diese Hosts dann für jedes verbundene Konto, mit höchstens zwei Downloads
  gleichzeitig je Konto und vier insgesamt.
- **`SEVDESK_AUDIT_LOG`**: ein Log für alle Konten; jede Zeile nennt das Konto und den Zugang. Es
  hält außerdem jeden empfangenen Upload, jeden angelegten Download-Link und jeden Download fest. Im
  Image ist das Root-Dateisystem schreibgeschützt; lege es also unter `/data` ab.
- **`SEVDESK_RATE_LIMIT`**: gilt je sevDesk-Konto, geteilt von allen seinen Verbindungen.

## Abbrüche und Warnungen beim Start

Der Start verweigert sich unter anderem bei:

- `--http` ohne `SEVDESK_HTTP_AUTH`;
- Bearer-Modus ohne gültiges Bearer-Geheimnis oder ohne sevDesk-Token;
- OAuth ohne `SEVDESK_HTTP_SECRET`, `SEVDESK_HTTP_PUBLIC_URL` oder `SEVDESK_OAUTH_ACCOUNTS` oder
  mit einem Geheimnis, das zu kurz oder nicht zufällig genug ist;
- einem Lauschen außerhalb von Loopback ohne öffentliche URL oder einer öffentlichen
  `http://`-URL, deren Host nicht Loopback ist;
- OAuth zusammen mit `SEVDESK_FILE_DIRS` oder `SEVDESK_OUTPUT_DIR` (die Meldung verweist auf die
  Upload-Seiten und Download-Links);
- `SEVDESK_API_TOKEN_KEYCHAIN`, `SEVDESK_PROFILE` oder `SEVDESK_PROFILES_PATH` (nur stdio);
- `SEVDESK_HTTP_FILES` mit einem Wert, der kein Schalterwert ist (siehe Tabelle),
  `SEVDESK_HTTP_FILES_MAX_MB` außerhalb von 32–4096, `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT`, das
  keine ganze Zahl von 1 bis 1000 ist, oder `SEVDESK_HTTP_FILES_TTL` außerhalb von 5 Minuten bis
  24 Stunden;
- `SEVDESK_CONFIRM_OPEN=1` bei einem Lauschen außerhalb von Loopback;
- einem Zustandsverzeichnis, das nicht beschreibbar ist, einer beschädigten `grants.jsonl`, einem
  Zustandsverzeichnis, das eine andere laufende Instanz nutzt, oder einem Ordner `files/` darin,
  der sich nicht leeren lässt;
- jedem anderen Wert außerhalb dessen, was die Tabellen oben erlauben, etwa einer Variablen, die
  zusammen mit ihrer `_FILE`-Variante gesetzt ist, `SEVDESK_HTTP_SECRET_PREVIOUS` ohne
  `SEVDESK_HTTP_SECRET`, mehr als zwei Bearer-Geheimnissen, einem relativen Zustandsverzeichnis,
  einer OAuth-Laufzeit außerhalb ihres Bereichs, einem ungültigen Host- oder Origin-Eintrag oder
  `any` gemischt mit IDs oder Hosts.

Der Start warnt (und startet) bei:

- `SEVDESK_CONFIRM=elicit` mit der Stufe `commit` oder `external`;
- `SEVDESK_OAUTH_ACCOUNTS=any` (mit aktiver Dateiübertragung auch, weil der Server dann kurzzeitig
  die Belege und Exporte jedes verbundenen Kontos hält und einige Konten zusammen seinen Platz für
  Dateien füllen können) und `SEVDESK_OAUTH_CLIENTS=any`;
- OAuth ohne Zustandsverzeichnis sowie `SEVDESK_API_TOKEN` oder einem Bearer-Geheimnis im
  OAuth-Modus;
- einem Server- oder Bearer-Geheimnis, das eher wie eine Passphrase als wie zufällige Bytes
  aussieht (verwende `generate-secret`);
- einem Lauschen außerhalb von Loopback mit einer öffentlichen Loopback-URL: Jeder, der den Port
  erreicht, kann den Server nutzen (siehe den
  [Docker-Schnellstart](../remote.de.md#schnellstart-bearer-modus-mit-docker));
- Dateiübertragung über einfaches http (das Cookie der Browser-Sitzung erreicht jeden Server unter
  diesem Hostnamen) und Dateiübertragung ohne Zustandsverzeichnis (Dateien werden im Speicher
  gehalten, bis zu `SEVDESK_HTTP_FILES_MAX_MB`);
- `SEVDESK_HTTP_FILES_MAX_MB`, `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` oder `SEVDESK_HTTP_FILES_TTL`
  zusammen mit `SEVDESK_HTTP_FILES=off` (sie haben dann keine Wirkung);
- `SEVDESK_OAUTH_ACCESS_TTL` unter 10 Minuten.

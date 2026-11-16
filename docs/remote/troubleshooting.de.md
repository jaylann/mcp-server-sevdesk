<!-- translated-from: docs/remote/troubleshooting.md sha256:4ff82441b027 -->

# Fehlersuche im Fernzugriff

Probleme, die nur mit `--http` auftreten: Clients verbinden, Proxys, Uploads, Zustimmung und das
Zustandsverzeichnis. Für Token-Fehler, fehlende Werkzeuge, Bestätigungen und andere Probleme, die
auch über stdio auftreten, siehe [Fehlersuche](../troubleshooting.de.md).

## Verbinden

**claude.ai meldet, den Server nicht erreichen oder sich nicht verbinden zu können.** claude.ai
verbindet sich aus dem Internet; prüfe also von außerhalb deines Netzes:

- `curl https://<host>/healthz` antwortet `{"status":"ok"}`;
- `curl https://<host>/.well-known/oauth-protected-resource/mcp` liefert JSON mit deiner
  öffentlichen URL;
- die URL des Connectors ist genau `SEVDESK_HTTP_PUBLIC_URL` plus `/mcp`;
- der Server läuft im OAuth-Modus (im Bearer-Modus antworten die Metadaten-Dokumente mit 404, und
  claude.ai kann sich nicht verbinden);
- das Zertifikat gilt für den Host, und nichts vor dem Server verlangt eine Anmeldung.

**Eine 401-Schleife: Die Zustimmung klappt, dann bittet claude.ai erneut um Verbindung.** Das
Access-Token gilt nur für `<public URL>/mcp`, ist mit dem aktuellen Geheimnis versiegelt und wird
gegen den Zugangsspeicher geprüft.

- Die URL des Connectors weicht von der öffentlichen URL ab (anderer Host, `http` statt `https`,
  ein abschließender Schrägstrich oder ein anderer Pfad): Korrigiere die URL oder
  `SEVDESK_HTTP_PUBLIC_URL`.
- Das Geheimnis hat sich seit der Zustimmung geändert, oder zwei Instanzen mit verschiedenen
  Geheimnissen bedienen dieselbe URL.
- Das Zustandsverzeichnis ist nicht dauerhaft, ein Neustart hat die Zugänge also vergessen. Binde
  dort ein Volume ein.
- Mehr als eine Instanz: Ein Zugang existiert nur im Speicher der Instanz, die ihn angelegt hat.

**Das Modell sagt, der Client könne nicht um Bestätigung gebeten werden.** Der Client hat über HTTP
keine Formular-Elicitation (claude.ai zum Zeitpunkt des Schreibens). Setze
`SEVDESK_CONFIRM=browser` und verwende das [Freigabe-Postfach](approvals.de.md).

## Hinter einem Proxy

**Anfragen werden wegen `Host` oder `Origin` abgelehnt.** Der Server nimmt nur den Host seiner
öffentlichen URL an. Die meisten Proxys (Caddy, Fly, Render, Railway, cloudflared) reichen den
ursprünglichen `Host` weiter; sendet deiner einen eigenen (einen internen Namen wie
`localhost:8080`), stelle ihn so ein, dass er den ursprünglichen Host weiterreicht, oder nimm
diesen Namen in `SEVDESK_HTTP_ALLOWED_HOSTS` auf. Ein Client, der einen anderen `Origin`-Header als
den öffentlichen Origin sendet, braucht ihn in `SEVDESK_HTTP_ALLOWED_ORIGINS`; ein MCP-Client, der
in einer Webseite auf einem anderen Origin läuft, kann gar nicht funktionieren, weil `/mcp` kein
CORS unterstützt. `/healthz` wird nie wegen seines Hosts abgelehnt. Beide Ablehnungen antworten mit 403.

**Viele Antworten mit 429, oder jede Anfrage mit der IP des Proxys protokolliert.** Setze hinter
einem Proxy `SEVDESK_HTTP_TRUST_PROXY` auf die Anzahl der Proxys, die etwas an `X-Forwarded-For`
anhängen; sonst teilen sich alle Clients die Ratenbegrenzung der Adresse des Proxys. Setze den
Wert nie höher als die tatsächliche Anzahl: Clients könnten sonst ihre eigene IP-Adresse wählen.
Eine 429, deren Meldung das sevDesk-Konto nennt, ist eine andere Grenze: Für dieses Konto laufen
bereits 8 Anfragen an `/mcp`, gleich von welchen Adressen ([Grenzen](operations.de.md#grenzen)).
Sie vergeht, sobald eine davon endet.

**Antworten hängen oder kommen alle auf einmal.** Ein Proxy puffert die gestreamten Antworten.
Schalte die Pufferung für den Server ab: Caddy `flush_interval -1` (die Compose-Vorlage tut das),
nginx `proxy_buffering off`.

**Uploads scheitern hinter einem Proxy.** Die Upload-Seite antwortet mit den eigenen Worten des
Servers; alles andere kommt vom Proxy.

- „Size missing“ (411): Der Proxy hat den Upload ohne `Content-Length` weitergeleitet (in Chunks).
  Lass ihn das `Content-Length` des Browsers weiterreichen oder Request-Bodys puffern: nginx tut
  das standardmäßig (`proxy_request_buffering on`); Caddy reicht es unverändert weiter.
- Eine 413-Seite des Proxys, nicht das „File too large“ des Servers: Die Body-Grenze des Proxys
  liegt unter der des Servers (etwas über 20 MiB für eine Datei, bis zum verbleibenden Byte-Anteil
  des Kontos für mehrere Dateien auf einer Seite; siehe [Reverse Proxys](files.de.md#reverse-proxys)).
  nginx: `client_max_body_size 65m;` beim Standard mit Zustandsverzeichnis, oder `201m` für die
  absolute Obergrenze (Standard 1 MB). Caddy hat keine Grenze, sofern du keine setzt.
- Eine Zeitüberschreitung (408) bei großen Dateien über eine langsame Verbindung: Der Body muss
  innerhalb von 90 Sekunden eintreffen, mit durchschnittlich mindestens 16 KB/s, und darf nie
  10 Sekunden lang pausieren. Ein Proxy, der Request-Bodys puffert (nginx standardmäßig), reicht
  sie mit voller Geschwindigkeit weiter.

## Uploads und Download-Links

**Ein Link aus dem Chat zeigt das Anmeldeformular.** Der Browser hat keine Sitzung dieses Kontos:
Es ist nicht der Browser, in dem du zugestimmt hast (die Claude-Apps öffnen Links unter Umständen
in ihrem eigenen Browser), die 12 Stunden sind vorbei, du hast dich abgemeldet, oder er ist an
einem anderen Konto angemeldet. Melde dich in diesem Formular mit dem sevDesk-API-Token des Kontos
an; es bringt dich zur Seite zurück.

**„Upload page not found“ oder „File not found“.** Der Link ist unbekannt, gehört zu einem anderen
sevDesk-Konto, wurde bereits erfolgreich angehängt, oder der Server wurde inzwischen neu gestartet
(ein Neustart macht jeden Upload und jeden Link ungültig). „Expired“ und „used up“ bedeuten, was
sie sagen. Bitte das Modell um einen neuen Upload-Link oder darum, die Datei erneut zu erzeugen.

**„No space for the file“ (507), oder das Modell meldet, dass die Grenze erreicht ist.** Die
Uploads und Links des Kontos füllen sein Viertel von `SEVDESK_HTTP_FILES_MAX_MB`, die Konten
zusammen füllen den Platz, oder das Konto hat `SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT` erreicht
(Standard 10). Erfolgreiches Anhängen gibt Uploads sofort frei. Bei einer erreichten Anzahlgrenze
wartest du bis zum Ablaufzeitpunkt des Kontos, den die Ablehnung nennt, oder erhöhst diese
Einstellung; bei Platzmangel wartest du auf den Ablauf von Dateien oder erhöhst
`SEVDESK_HTTP_FILES_MAX_MB`. „Server busy“ (503) heißt, dass gerade zwei andere Uploads eintreffen,
„Upload in progress“ (503), dass ein anderer Upload desselben Kontos eintrifft; versuche es gleich
noch einmal ([Grenzen und Laufzeiten](files.de.md#grenzen-und-laufzeiten)).

## Zustimmung

**Die Zustimmungsseite lehnt das Konto oder den Client ab.** Sie nennt die Konto-ID oder den
Client-Host; nimm ihn in `SEVDESK_OAUTH_ACCOUNTS` oder `SEVDESK_OAUTH_CLIENTS` auf und starte neu,
wenn du ihn zulassen willst. Einen Eintrag zu entfernen und neu zu starten widerruft auch die
bestehenden Zugänge dieses Kontos oder Clients bei ihrer nächsten Nutzung und beendet die
Browser-Sitzungen des Kontos.

**Die Zustimmungsseite meldet zu viele Verbindungen.** Der Zugangsspeicher ist voll. `grants list`
zeigt die Zugänge; widerrufe die, die niemand nutzt ([Befehle](operations.de.md#befehle)).

## Zustandsverzeichnis und Instanzen

**Das Zustandsverzeichnis ist nicht beschreibbar.** Das Image läuft als uid 65532. Ein benanntes
Docker-Volume übernimmt seinen Eigentümer aus dem Image und funktioniert einfach; ein Bind-Mount
oder eine Plattform-Disk mit root als Eigentümer braucht die Lösung unter
[Volumes und der Container-Benutzer](deployment.de.md#volumes-und-der-container-benutzer). Ohne
beschreibbares Volume setzt du `SEVDESK_HTTP_STATE_DIR` auf einen leeren Wert: Der Zustand wird
dann im Speicher gehalten, und jeder Neustart meldet alle Clients ab.

**Der Start meldet, dass eine andere Instanz das Zustandsverzeichnis nutzt.** Nur ein laufender
Server darf es nutzen. Nach einem Absturz gilt die alte Sperre nach 30 Sekunden als veraltet, und
der nächste Start übernimmt sie. Laufen wirklich zwei (eine zweite Replica oder Machine), reduziere
auf eine. Ein laufender Server, der seine Sperre von einem anderen übernommen findet, vertraut
seinem Zugangsspeicher nicht mehr: OAuth-Anfragen scheitern mit einem Serverfehler (Clients
behalten ihre Tokens), und der Prozess beendet sich, sodass die Plattform ihn neu startet.

**Der Start bricht ab oder warnt.** Der Start meldet alle Probleme auf einmal; was jedes bedeutet,
steht unter [Abbrüche und Warnungen beim Start](configuration.de.md#abbrüche-und-warnungen-beim-start).

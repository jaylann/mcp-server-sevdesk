<!-- translated-from: docs/recording-session/remote-check.md sha256:fc65cfe84e9c -->

# M5: Prüfung des Fernzugriffs

Eine Prüfung des Fernzugriffs von Hand, gegen das Testkonto der
[Aufnahmesitzung](../recording-session.de.md), etwa 60 bis 90 Minuten. Sie ist für Maintainer vor
einem Release, das den HTTP-Modus berührt.

Der Fernzugriff ([Fernzugriff](../remote.de.md)) wird einmal von Hand geprüft: das lokal gebaute
Image, ein temporärer Tunnel, ein benutzerdefinierter Connector in claude.ai und Claude Code über
HTTP. Die automatisierten Tests decken das Protokoll ab; dieser Lauf prüft die echten Clients, den
Proxy davor und die Logs. Führe ihn aus, solange die Testphase noch läuft, und nie gegen ein
Produktivkonto: Der Connector bekommt die Stufe `commit`.

## Was du brauchst

- Ein laufendes Docker, installiertes `cloudflared`, ein claude.ai-Konto und Claude Code.
- Die Token-Datei des Testkontos aus
  [Schritt 2](../recording-session.de.md#2-ein-api-token-anlegen-etwa-5-minuten)
  (`~/.config/sevdesk-trial.token`) und ein erledigtes `pnpm build`.
- Einen Lauf-Tag für alles, was du anlegst, in derselben Form wie bei den geskripteten Läufen:
  `MCP-E2E <yyyymmdd-hhmm>-m5`.

## Einrichtung

```bash
# 1. Das Image, gebaut aus diesem Checkout.
docker build -t mcp-server-sevdesk:m5 .

# 2. Ein Tunnel. Lass ihn laufen und notiere den Origin https://….trycloudflare.com, den er ausgibt.
cloudflared tunnel --url http://localhost:8080

# 3. In einem zweiten Terminal: die Konto-ID des Testkontos und ein frisches Server-Geheimnis, in
#    einer env-Datei, die nur du lesen kannst, außerhalb des Repositorys.
SEVDESK_API_TOKEN_FILE=~/.config/sevdesk-trial.token node dist/index.js account-id
umask 077
{
  echo "SEVDESK_HTTP_SECRET=$(node dist/index.js generate-secret)"
  echo "SEVDESK_OAUTH_ACCOUNTS=<the account id>"
  echo "SEVDESK_HTTP_PUBLIC_URL=https://<random>.trycloudflare.com"
} > ~/.config/sevdesk-m5.env

# 4. Der Server im OAuth-Modus, schreibgeschützt, mit einem Access-Token für 5 Minuten, damit bald
#    eine Erneuerung stattfindet.
docker volume create sevdesk-m5-data
docker run -d --name sevdesk-m5 --read-only -p 127.0.0.1:8080:8080 \
  --env-file ~/.config/sevdesk-m5.env -v sevdesk-m5-data:/data \
  -e SEVDESK_HTTP_AUTH=oauth -e SEVDESK_HTTP_TRUST_PROXY=1 \
  -e SEVDESK_CONFIRM=browser -e SEVDESK_ALLOW=read,write,commit \
  -e SEVDESK_AUDIT_LOG=/data/audit.jsonl -e SEVDESK_OAUTH_ACCESS_TTL=5m \
  mcp-server-sevdesk:m5
docker logs -f sevdesk-m5     # in einem dritten Terminal, für den ganzen Lauf
curl -sS https://<random>.trycloudflare.com/healthz
```

Die Adresse des Tunnels ändert sich bei jedem Start von `cloudflared`. Wenn du ihn neu startest,
aktualisiere `SEVDESK_HTTP_PUBLIC_URL` und lege den Container (und den Connector) neu an.

## Schritte

1. **Connector in claude.ai.** Einstellungen → Connectors → Benutzerdefinierten Connector
   hinzufügen, Name `sevDesk MCP-E2E`, URL `https://<random>.trycloudflare.com/mcp`. Prüfe auf der
   Zustimmungsseite, dass der Client `claude.ai` ist und die Weiterleitung zu `claude.ai` geht, hake
   `write` und `commit` an, füge das Token des Testkontos ein und bestätige.
2. **Ein Lesezugriff.** Frag in einem neuen Chat mit eingeschaltetem Connector:

   > Welche Version des Buchhaltungssystems nutzt mein sevDesk-Konto, und wie viele offene
   > Rechnungen gibt es?

   Die Antwort kommt aus dem Testkonto; `docker logs` zeigt `/mcp`-Anfragen mit einem Präfix des
   Zugangs und ohne Token.

3. **Ein Entwurf.** Bitte um einen Kontakt und einen Rechnungsentwurf, benannt nach dem Lauf-Tag
   (wie bei den M3- und M4-Läufen):

   > Leg einen Kontakt `MCP-E2E <tag> Kunde` an und einen Rechnungsentwurf für ihn, eine Position,
   > 100 EUR netto, 19 %

4. **Über das Postfach fertigstellen.** Bitte Claude, diesen Entwurf fertigzustellen. Das Werkzeug
   antwortet `approval_pending` mit einem Referenzcode und der Adresse des Postfachs. Öffne
   `https://<random>.trycloudflare.com/approvals` in dem Browser, in dem du zugestimmt hast: Er ist
   schon angemeldet. Öffne die Anfrage mit diesem Referenzcode, prüfe die Vorschau (Kunde, Beträge,
   „cannot be undone“), gib sie frei und bitte Claude, es erneut zu versuchen. Das Ergebnis ist
   `done`.
5. **Erneuerung.** Warte mehr als 5 Minuten und stell dann noch eine Lesefrage. Sie funktioniert
   ohne neue Zustimmung; das Log zeigt eine `/token`-Anfrage mit Status 200 (eine Erneuerung mit
   Rotation).
6. **Claude Code über OAuth.**
   `claude mcp add --transport http sevdesk-m5 https://<random>.trycloudflare.com/mcp`, dann `/mcp`
   in Claude Code und authentifizieren: Die Zustimmungsseite öffnet sich mit dem Client von Claude
   Code und einer Warnung zur Weiterleitung auf Loopback. Sein Metadatendokument liegt auf
   `claude.ai`, die Standard-Erlaubnisliste für Clients nimmt ihn also an; lehnt die Seite den
   Client trotzdem ab, notiere den Host, den sie nennt. Bitte um einen Lesezugriff.
7. **Negativprüfungen** (jede muss mit dem Status im Kommentar abgelehnt werden; notiere alles
   andere):

   ```bash
   T=https://<random>.trycloudflare.com
   # Kein Authorization-Header: 401 mit WWW-Authenticate, das die Ressourcen-Metadaten nennt.
   curl -sS -i -X POST "$T/mcp" -H 'content-type: application/json' -d '{}' | head -n 20
   # Ein fremder Origin: 403, vor der Authentifizierung.
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$T/mcp" -H 'Origin: https://evil.example' \
     -H 'content-type: application/json' -d '{}'
   # Ein falscher Host, direkt an den Container: 403; /healthz ist ausgenommen und antwortet 200.
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/mcp \
     -H 'Host: evil.example' -H 'content-type: application/json' -d '{}'
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://localhost:8080/healthz
   ```

   Dann die Erlaubnisliste der Konten: Lege den Container mit `SEVDESK_OAUTH_ACCOUNTS=1` neu an
   (eine ID, die nicht die des Testkontos ist), starte eine neue Zustimmung aus Claude Code
   (`/mcp`, neu authentifizieren) und füge das Token des Testkontos ein. Die Seite lehnt es ab und
   zeigt die Konto-ID des Testkontos; das Log hat eine Warnung `account_refused`. Auch die
   bestehende Verbindung von claude.ai hört auf zu funktionieren: Die Erlaubnisliste gilt für jede
   Anfrage, deshalb wird ihr Zugang bei der nächsten Nachricht widerrufen (eine Warnung
   `grant_revoked` mit dem Grund `account_removed`). Lege den Container danach mit der richtigen ID
   neu an und verbinde claude.ai erneut.

8. **Neustart.** Bitte Claude, etwas fertigzustellen, das eine Freigabe braucht (oder die Rechnung
   aus Schritt 4 zu stornieren), sodass eine Freigabe aussteht, dann `docker restart sevdesk-m5`.
   Der Connector funktioniert weiter ohne neue Zustimmung (die Zugänge liegen im Volume), und das
   Postfach listet die ausstehende Freigabe nicht mehr: Das Modell muss erneut fragen. Lehne diese
   neue Anfrage im Postfach ab.
9. **Zugänge.** Liste die Zugänge auf, widerrufe den von claude.ai und prüfe, dass claude.ai bei
   der nächsten Nachricht darum bittet, sich neu zu verbinden:

   ```bash
   docker run --rm -v sevdesk-m5-data:/data mcp-server-sevdesk:m5 grants list
   docker run --rm -v sevdesk-m5-data:/data mcp-server-sevdesk:m5 grants revoke <grant id>
   ```

10. **Claude Code im Bearer-Modus.** Sichere das Log des OAuth-Containers, ersetze den Container
    durch einen im Bearer-Modus und verbinde Claude Code mit einem Header:

    ```bash
    mkdir -p ~/.config/sevdesk-m5-logs
    docker logs sevdesk-m5 > ~/.config/sevdesk-m5-logs/oauth.log 2>&1
    docker rm -f sevdesk-m5
    umask 077
    {
      echo "SEVDESK_HTTP_BEARER_TOKEN=$(node dist/index.js generate-secret)"
      echo "SEVDESK_API_TOKEN=$(cat ~/.config/sevdesk-trial.token)"
      echo "SEVDESK_HTTP_PUBLIC_URL=https://<random>.trycloudflare.com"
    } > ~/.config/sevdesk-m5-bearer.env
    docker run -d --name sevdesk-m5 --read-only -p 127.0.0.1:8080:8080 \
      --env-file ~/.config/sevdesk-m5-bearer.env -v sevdesk-m5-data:/data \
      -e SEVDESK_HTTP_AUTH=bearer -e SEVDESK_HTTP_TRUST_PROXY=1 mcp-server-sevdesk:m5
    claude mcp add --transport http sevdesk-m5-bearer https://<random>.trycloudflare.com/mcp \
      --header "Authorization: Bearer $(sed -n 's/^SEVDESK_HTTP_BEARER_TOKEN=//p' ~/.config/sevdesk-m5-bearer.env)"
    ```

    Bitte um einen Lesezugriff. Ein falscher Bearer-Wert bekommt 401.

11. **Kein Geheimnis in irgendeinem Log.** Kopiere die Logs aus dem Container und dem Volume und
    durchsuche sie nach jedem Geheimnis des Laufs und nach versiegelten Tokens. Beide Suchen dürfen
    nichts ausgeben:

    ```bash
    cd ~/.config/sevdesk-m5-logs
    docker logs sevdesk-m5 > bearer.log 2>&1
    docker cp sevdesk-m5:/data/audit.jsonl . && docker cp sevdesk-m5:/data/grants.jsonl .
    printf '%s\n' "$(cat ~/.config/sevdesk-trial.token)" > patterns.txt
    sed -n 's/^SEVDESK_HTTP_SECRET=//p' ~/.config/sevdesk-m5.env >> patterns.txt
    sed -n 's/^SEVDESK_HTTP_BEARER_TOKEN=//p' ~/.config/sevdesk-m5-bearer.env >> patterns.txt
    rg -n -F -f patterns.txt oauth.log bearer.log audit.jsonl grants.jsonl
    rg -n 'sdmcp_' oauth.log bearer.log audit.jsonl grants.jsonl
    ```

## Aufräumen

1. Räume die markierten Datensätze auf wie nach den geskripteten Läufen: Lösche den Kontakt und
   alle Entwürfe in der Web-App; eine fertiggestellte Rechnung lässt sich nicht löschen, also
   storniere sie (über den Connector, mit dem Postfach) oder lass sie mit dem Testkonto
   verschwinden ([Das Testkonto beenden](../recording-session.de.md#7-das-testkonto-beenden-etwa-5-minuten)).
2. Entferne den Connector in claude.ai (Einstellungen → Connectors) und die Server in Claude Code
   (`claude mcp remove sevdesk-m5`, `claude mcp remove sevdesk-m5-bearer`).
3. `docker rm -f sevdesk-m5`, `docker volume rm sevdesk-m5-data`, `cloudflared` beenden.
4. `rm -r ~/.config/sevdesk-m5.env ~/.config/sevdesk-m5-bearer.env ~/.config/sevdesk-m5-logs`.

## Was du aus M5 committest, und was nie

- Committe: die Korrekturen, die der Lauf verlangt (Code, Tests, die
  [Doku zum Fernzugriff](../remote.de.md)), und die Befunde (welche Schritte bestanden, die
  Statuscodes der Negativprüfungen, alles, was ein Client anders gemacht hat als dokumentiert) in
  der PR-Beschreibung.
- Committe nie: die env-Dateien, das Server-Geheimnis, Bearer-Werte, das Token des Testkontos, die
  kopierten Logs, `audit.jsonl` oder `grants.jsonl`, die Tunnel-URL neben der Konto-ID oder
  Screenshots von claude.ai oder dem Postfach, die Kontodaten zeigen.

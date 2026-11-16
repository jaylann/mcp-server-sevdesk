<!-- translated-from: docs/adr/0004-stateless-remote-oauth.md sha256:0e77bd29f934 -->

# ADR 0004: Standardmäßig stdio, zustandsloses HTTP aus der Ferne mit OAuth

- **Status:** Ersetzt durch [0006](0006-built-in-authorization-server-and-grant-store.de.md)
- **Datum:** 2026-11-07

## Kontext

- Fernzugriff ist die am häufigsten gewünschte Funktion unter Benutzern von sevDesk-MCP-Servern
  (benutzerdefinierte Connectoren in claude.ai, mobile Apps, gemeinsame Einrichtungen im Team).
  Entfernte MCP-Clients erwarten Streamable HTTP und OAuth.
- sevDesk selbst hat **kein OAuth und keine einschränkbaren Rechte**. Sein API-Token läuft nie ab
  und gewährt vollen Zugriff.
- Es gibt gehostete sevDesk-MCP-Dienste, die die Tokens ihrer Benutzer speichern. Ein Token-Speicher
  ist ein Risiko: Ein einziger Einbruch legt jedes verbundene Konto offen.
- MCP 2026-07-28 hat keine Sitzung auf Protokollebene, und das SDK v2 bietet einen zustandslosen
  Handler (`createMcpHandler(...).fetch`).
- Die lokale Nutzung (Claude Desktop, Claude Code, Cursor, VS Code) funktioniert am besten über
  stdio mit dem Token in der lokalen Umgebung.

## Entscheidung

- **stdio ist der Standard**-Transport.
- **Streamable HTTP** (`--http`) ist **zustandslos**: Jede Anfrage trägt alles Nötige, jede Instanz
  kann also jede Anfrage bedienen.
- **HTTP startet nicht ohne Authentifizierung.** Zwei Modi:
  - `bearer`: ein statisches gemeinsames Geheimnis, in konstanter Zeit verglichen. Für private
    Bereitstellungen hinter einer anderen Zugangskontrolle.
  - `oauth`: Der Server ist sein eigener OAuth-2.1-Autorisierungsserver, mit PKCE, Clients, die sich
    über Client ID Metadata Documents (CIMD) statt über Dynamic Client Registration ausweisen, und
    einer Prüfung der Ressource (Zielgruppe) nach [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)
    bei jedem Token.
- **Keine Token-Speicherung.** Auf der Zustimmungsseite fügt der Benutzer sein sevDesk-Token einmal
  ein. Es wird mit AES-GCM unter einem Server-Schlüssel verschlüsselt und im _Zugang_ (Grant) mitgeführt,
  sodass der Server keine Datenbank mit Tokens hält. Zugänge lassen sich widerrufen; der genaue
  Mechanismus (Wechsel des Server-Schlüssels für alle Zugänge, eine Sperrliste für einzelne
  Zugänge) wird festgelegt, wenn M5 gebaut wird.
- **Härtung:** Prüfung von Origin und Host, Bindung an 127.0.0.1, sofern nicht anders konfiguriert,
  Ratenbegrenzungen und dieselben Stufen und Bestätigungen wie über stdio
  ([ADR 0003](0003-tiers-and-human-confirmation.de.md)).
- **Nur zum Selbstbetreiben.** Wir veröffentlichen ein Docker-Image und Vorlagen für die
  Bereitstellung, betreiben aber keine öffentliche Instanz. Nach 1.0 sehen wir uns das erneut an;
  der zustandslose Entwurf hält diese Möglichkeit offen.

## Folgen

- Vorteil: Im Ruhezustand gibt es nichts zu erbeuten; Skalieren ist trivial; funktioniert mit
  Clients, die OAuth verlangen.
- Vorteil: Benutzer behalten die Kontrolle: Sie wählen, wo der Server läuft, und können Zugänge
  widerrufen.
- Nachteil: Der Server-Schlüssel schützt jeden Zugang. Er muss aus einem Secret-Speicher kommen,
  und ihn zu wechseln meldet alle ab.
- Nachteil: Das sevDesk-Token selbst läuft nie ab; Laufzeiten der Zugänge und Widerruf sind also
  die einzige zeitliche Grenze, die wir durchsetzen können.
- Nachteil: keine Liste aktiver Sitzungen, da nichts gespeichert wird.
- Nachteil: Wer selbst betreibt, muss TLS bereitstellen (einen Reverse Proxy) und den
  Server-Schlüssel verwalten.

## Erwogene Alternativen

- **Sitzungen mit Zustand und eine Token-Datenbank.** Verworfen: ein Speicher, der geschützt
  und gesichert werden muss, und schwerer zu skalieren.
- **Dynamic Client Registration.** Zugunsten von CIMD verworfen, das einen offenen
  Registrierungsendpunkt und Zustand je Client vermeidet.
- **Clients senden das sevDesk-Token direkt als Bearer-Token.** Verworfen: Es verteilt ein nie
  ablaufendes Token mit vollem Zugriff in jede Client-Konfiguration, ohne Bindung an eine
  Zielgruppe.
- **Eine öffentliche gehostete Instanz.** Zurückgestellt: Sie würde uns zu Verwahrern des
  Buchhaltungszugriffs anderer Leute machen.

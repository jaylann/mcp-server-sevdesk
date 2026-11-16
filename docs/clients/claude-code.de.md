<!-- translated-from: docs/clients/claude-code.md sha256:78da4093945a -->

# Claude Code

Diese Seite richtet den Server in Claude Code ein: als lokalen Server, als Plugin `sevdesk` mit
seinem Buchhaltungs-Skill oder verbunden mit einem Server, den du selbst betreibst. Die anderen
Clients findest du unter [Clients](../clients.de.md).

## Was funktioniert

- **Werkzeuge und Prompts.** Die [Prompts](../../README.de.md#prompts) des Servers erscheinen im
  `/`-Menü als `/sevdesk:month_end_close (MCP)`; `/mcp__sevdesk__month_end_close 2026-10` führt
  einen mit einem Argument aus. Mit `/mcp` siehst du den Server und seine Werkzeuge.
- **Bestätigungen** erscheinen in interaktiven Sitzungen als Dialog, mit der Voreinstellung
  `SEVDESK_CONFIRM=elicit` ([Bestätigungsarten](../permissions.de.md#bestätigungsarten)). Im
  Print-Modus (`claude -p`) kann niemand antworten: Verwende
  [Probeläufe](../permissions.de.md#probelauf) oder `SEVDESK_CONFIRM=browser`.
- **Fernzugriff:** OAuth und Bearer-Modus funktionieren beide
  ([Fernzugriff einrichten](#fernzugriff-einrichten)).

## Lokal einrichten

Claude Code braucht Node.js 22.12 oder neuer für `npx`. Trage den Server für alle deine Projekte
ein (`--scope user`), mit dem Token aus dem Schlüsselbund:

```bash
npx -y mcp-server-sevdesk token set work
claude mcp add --env SEVDESK_API_TOKEN_KEYCHAIN=work --scope user sevdesk -- npx -y mcp-server-sevdesk
```

Weitere Einstellungen sind weitere `--env NAME=value`-Optionen vor `--scope`. Alles nach `--` ist
der Befehl, den Claude Code ausführt. Den Schlüsselbund erklärt
[Profile und Schlüsselbund](../configuration/profiles.de.md#das-token-im-schlüsselbund-ablegen).

In die gemeinsame `.mcp.json` eines Projekts gehört nie ein Token. Verweise stattdessen auf eine
Variable, die Claude Code aus der Umgebung einsetzt, in der es gestartet wurde; jede Person
exportiert dann die Bezeichnung ihres eigenen Schlüsselbund-Eintrags:

```json
{
  "mcpServers": {
    "sevdesk": {
      "command": "npx",
      "args": ["-y", "mcp-server-sevdesk"],
      "env": { "SEVDESK_API_TOKEN_KEYCHAIN": "${SEVDESK_API_TOKEN_KEYCHAIN}" }
    }
  }
}
```

### Das Plugin

Das Repository ist zugleich ein Plugin-Marktplatz für Claude Code. Das Plugin `sevdesk` startet
diesen Server und bringt einen Buchhaltungs-Skill mit: deutsche Steuerregeln und die passenden
Steuerregeln in sevDesk (einschließlich §13b Reverse Charge und §19 Kleinunternehmer), gängige
SKR03- und SKR04-Konten, GoBD, die E-Rechnungspflichten und Abläufe Schritt für Schritt für
Belege, E-Rechnungen, den Bankabgleich, die Umsatzsteuer-Vorprüfung, den Monats- und
Jahresabschluss.

```text
/plugin marketplace add jaylann/mcp-server-sevdesk
/plugin install sevdesk@mcp-server-sevdesk
```

Ab Claude Code 2.1.275 genügt ein Schritt:
`/plugin install sevdesk --marketplace jaylann/mcp-server-sevdesk`.

Das Plugin startet das Release, zu dem es gehört (`npx -y mcp-server-sevdesk@<version>`), damit
nie eine neue npm-Version läuft, bevor du das Plugin aktualisierst. Es übergibt die
`SEVDESK_*`-Variablen der Umgebung, in der Claude Code gestartet wurde, zum Beispiel aus deinem
Shell-Profil. Es braucht mindestens eine Token-Variable und bleibt nur lesend, solange du
`SEVDESK_ALLOW` nicht setzt:

```bash
export SEVDESK_API_TOKEN_KEYCHAIN=work   # oder SEVDESK_API_TOKEN / SEVDESK_API_TOKEN_FILE
export SEVDESK_ALLOW=write               # optional; ohne die Variable nur lesend
```

Das Plugin übergibt jede Variable, die nicht verwendeten kommen also leer an; ein leerer Wert gilt
als nicht gesetzt ([Konfiguration](../configuration.de.md)).

## Fernzugriff einrichten

Verbinde Claude Code mit einem Server, den du im [Fernzugriff](../remote.de.md) betreibst. Der
MCP-Endpunkt ist immer `<public URL>/mcp`.

Mit OAuth:

```bash
claude mcp add --transport http sevdesk https://<host>/mcp
```

Führe dann `/mcp` in Claude Code aus und wähle die Authentifizierung: Die Zustimmungsseite öffnet
sich in deinem Browser und leitet dich zu Claude Code zurück. Claude Code weist sich mit einem
eigenen Metadaten-Dokument aus, das wie das von claude.ai unter `claude.ai` liegt (der Standardwert
von `SEVDESK_OAUTH_CLIENTS` deckt es also ab), und mit einer Loopback-Weiterleitung, auf die die
Zustimmungsseite hinweist.

Mit einem Bearer-Geheimnis (lies es aus einer Datei oder deinem Passwortmanager, statt es
einzutippen):

```bash
claude mcp add --transport http sevdesk https://<host>/mcp \
  --header "Authorization: Bearer $MCP_BEARER_SECRET"
```

Welchen Modus du wählst: [Bearer oder OAuth](../remote.de.md#bearer-oder-oauth). Über HTTP braucht
eine Bestätigung im Chat außerdem einen Client, der das Protokoll 2026-07-28 mit
Formular-Elicitation spricht; sonst setzt du `SEVDESK_CONFIRM=browser` auf dem Server und gibst in
seinem [Freigabe-Postfach](../remote/approvals.de.md) frei.

## Stolperfallen

- **Shell-Historie.** Vermeide `--env SEVDESK_API_TOKEN=<token>` auf der Kommandozeile: Das Token
  bleibt sonst in deiner Shell-Historie. Verwende den Schlüsselbund oder eine Token-Datei.
- **Der Print-Modus** kann keine Bestätigungen beantworten (siehe
  [Was funktioniert](#was-funktioniert)).
- **Plugin-Einstellungen** kommen aus der Umgebung, in der Claude Code gestartet wurde, nicht aus
  einer Konfigurationsdatei: Starte Claude Code neu, nachdem du dein Shell-Profil geändert hast.

<!-- translated-from: docs/configuration/profiles.md sha256:23724cbaeef0 -->

# Profile und Schlüsselbund

Diese Seite zeigt, wie du das sevDesk-Token mit dem Schlüsselbund des Betriebssystems aus der
Konfiguration deines Clients heraushältst und wie du mehrere Konten oder Einrichtungen in einer
Profildatei hältst. Beides funktioniert nur über stdio, nicht mit `--http`. Die Bedrohungsanalyse
dazu steht unter [Lokale Nutzung](../security/local.de.md); alle übrigen Variablen unter
[Konfiguration](../configuration.de.md).

## Das Token im Schlüsselbund ablegen

Statt das Token in die Konfiguration deines Clients zu schreiben, lege es einmal im Schlüsselbund
deines Betriebssystems ab und gib dem Server nur seine Bezeichnung:

```bash
npx -y mcp-server-sevdesk token set work
```

Der Befehl fragt nach dem Token (die Eingabe ist verdeckt), prüft es bei sevDesk, legt es unter der
Bezeichnung `work` ab und gibt die Konto-ID aus. Lehnt sevDesk das Token ab, wird nichts abgelegt;
ist sevDesk nicht erreichbar, wird es mit einer Warnung abgelegt. Konfiguriere den Server dann mit
`"SEVDESK_API_TOKEN_KEYCHAIN": "work"` statt `SEVDESK_API_TOKEN`. Eine Bezeichnung hat bis zu 64
Buchstaben, Ziffern, `.`, `_` oder `-` und beginnt mit einem Buchstaben oder einer Ziffer.

- `token check work` prüft das abgelegte Token bei sevDesk; `token delete work` entfernt es.
- Das Token wird nie von der Kommandozeile übernommen, wo es in deiner Shell-Historie bliebe. Um es
  aus einer Datei abzulegen, leite es per Pipe ein:
  `npx -y mcp-server-sevdesk token set work < token.txt`, und lösche die Datei danach. Diese
  Umleitung funktioniert in POSIX-Shells und `cmd.exe`; in PowerShell verwendest du
  `Get-Content -Raw token.txt | npx -y mcp-server-sevdesk token set work`.

### Wo das Token liegt

- **macOS:** der Anmeldeschlüsselbund, Objekt `mcp-server-sevdesk`, Account = deine Bezeichnung.
- **Linux:** der Secret Service über `secret-tool` (Paket `libsecret-tools` unter Debian und
  Ubuntu, `libsecret` unter Fedora), mit laufendem und entsperrtem GNOME Keyring oder KWallet. Auf
  einem Server ohne grafische Oberfläche verwendest du `SEVDESK_API_TOKEN_FILE`.
- **Windows:** der Credential Locker über WinRT `PasswordVault`, Ressource `mcp-server-sevdesk`,
  Benutzername = deine Bezeichnung. Verwendet Windows PowerShell unter
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, ohne Profile oder Suche im
  `PATH`. Lass `SystemRoot` auf das Windows-Installationsverzeichnis zeigen. PowerShell 7 (`pwsh`)
  wird nicht verwendet. Der Constrained Language Mode kann auch ohne `Add-Type` nicht auf diese API
  zugreifen; verwende `SEVDESK_API_TOKEN_FILE` oder die
  [Claude-Desktop-Erweiterung](../clients/claude-desktop.de.md#die-erweiterung), wenn Windows
  PowerShell fehlt oder eingeschränkt ist. Einträge im Credential Locker können über dein
  Microsoft-Konto synchronisiert werden; verwende eine geschützte Token-Datei, wenn das Token auf
  diesem Gerät bleiben muss.

Der Schlüsselbund hält das Token aus Konfigurationsdateien, Backups und Screenshots heraus. Er
schützt nicht vor Programmen, die bereits unter deinem Benutzerkonto laufen
([Lokale Token-Ablage und Profile](../security/local.de.md#lokale-token-ablage-und-profile)).

## Profile

Profile halten mehrere Einrichtungen in einer Datei, zum Beispiel zwei sevDesk-Konten oder eine nur
lesende und eine buchende Einrichtung desselben Kontos, und wählen eine mit `SEVDESK_PROFILE` aus.
Lege `~/.config/mcp-server-sevdesk/profiles.json` an (oder zeige mit `SEVDESK_PROFILES_PATH` auf
einen anderen Ort; die Standardorte je Betriebssystem stehen unter
[Profilauswahl](../configuration.de.md#profilauswahl)):

```json
{
  "version": 1,
  "profiles": {
    "work": {
      "token": { "keychain": "work" },
      "allow": ["write"],
      "fileDirs": ["/Users/me/Belege"],
      "auditLog": "/Users/me/.local/state/sevdesk-work.jsonl"
    },
    "client-a": {
      "token": { "file": "/Users/me/.config/sevdesk/client-a.token" },
      "readOnly": true
    }
  }
}
```

Setze dann `"SEVDESK_PROFILE": "work"` im `env` des Clients. Der Server schreibt beim Start
`using profile "work"` in sein Log.

### Schlüssel

| Schlüssel   | Setzt                | Wert                                                                                           |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `token`     | die Token-Quelle     | `{"keychain": "<label>"}`, `{"file": "/absolute/path"}` oder `{"env": "SEVDESK_TOKEN_<NAME>"}` |
| `allow`     | `SEVDESK_ALLOW`      | eine Liste oder eine durch Kommas getrennte Zeichenkette                                       |
| `readOnly`  | `SEVDESK_READ_ONLY`  | `true` oder `false`                                                                            |
| `dryRun`    | `SEVDESK_DRY_RUN`    | `true` oder `false`                                                                            |
| `confirm`   | `SEVDESK_CONFIRM`    | eine Zeichenkette                                                                              |
| `toolsets`  | `SEVDESK_TOOLSETS`   | eine Liste oder eine durch Kommas getrennte Zeichenkette                                       |
| `fileDirs`  | `SEVDESK_FILE_DIRS`  | eine Liste absoluter Pfade                                                                     |
| `outputDir` | `SEVDESK_OUTPUT_DIR` | eine Zeichenkette                                                                              |
| `auditLog`  | `SEVDESK_AUDIT_LOG`  | eine Zeichenkette                                                                              |
| `baseUrl`   | `SEVDESK_BASE_URL`   | eine Zeichenkette                                                                              |
| `rateLimit` | `SEVDESK_RATE_LIMIT` | eine Zahl                                                                                      |
| `timeoutMs` | `SEVDESK_TIMEOUT_MS` | eine Zahl                                                                                      |

Jeder Schlüssel setzt die Variable mit derselben Bedeutung und wird genauso geprüft
([Variablen](../configuration.de.md#variablen)).

### Regeln

- **Die Datei enthält nie ein Token.** `token` sagt, wo es aufbewahrt wird: eine Bezeichnung im
  Schlüsselbund, ein absoluter Dateipfad oder eine Variable namens `SEVDESK_TOKEN_<NAME>`, die du
  im `env` des Clients setzt. Ohne `token` gelten die üblichen Token-Variablen.
- **Kein stilles Überschreiben.** Eine Variable, die sowohl in der Umgebung als auch im Profil
  gesetzt ist, ist ein Fehler, der beide nennt. Erlaubt ist nur das Verschärfen:
  `SEVDESK_READ_ONLY=1` und `SEVDESK_DRY_RUN=1` in der Umgebung haben immer Vorrang.
- **Die Datei muss dir gehören.** Unter macOS und Linux müssen die Datei und ihr Ordner dir (oder
  root) gehören und dürfen für Gruppe und andere nicht beschreibbar sein (`chmod go-w`), weil ein
  Profil Stufen und Ordner erweitern kann. Unter Windows wird das nicht geprüft.
- Die Datei ist striktes JSON mit höchstens 64 KiB und `"version": 1`; unbekannte Schlüssel werden
  abgelehnt.
- Profile funktionieren nur über stdio, nicht mit `--http`.

### Profile auflisten

```bash
npx -y mcp-server-sevdesk profiles list
```

Der Befehl zeigt jedes Profil mit dem Ort seines Tokens, seinen Stufen und Werkzeuggruppen und
markiert das Profil, das `SEVDESK_PROFILE` nennt. Er gibt nie ein Token aus.

## Mehrere Konten ohne Profile

Über stdio kannst du den Server auch einmal pro Konto unter verschiedenen Namen in deinem Client
eintragen, jeweils mit eigenem Token. Profile halten diese Einrichtungen stattdessen an einem Ort.

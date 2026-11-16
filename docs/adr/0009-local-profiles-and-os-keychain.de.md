<!-- translated-from: docs/adr/0009-local-profiles-and-os-keychain.md sha256:0d2df021b1b5 -->

# ADR 0009: Lokale Profile und der Schlüsselbund des Betriebssystems

- **Status:** Angenommen
- **Datum:** 2026-11-09

## Kontext

Ein sevDesk-API-Token hat vollen Zugriff auf sein Konto, keine einschränkbaren Rechte und keinen
Ablauf. Über stdio bekam der Server es auf einem von zwei Wegen, beide im Klartext:

- `SEVDESK_API_TOKEN` in der Konfiguration des MCP-Clients (`claude_desktop_config.json`,
  `.mcp.json`, die Einstellungen von Claude Code). Diese Dateien werden synchronisiert, gesichert,
  in Dotfiles-Repositorys aufbewahrt und gezeigt, wenn jemand für Hilfe seinen Bildschirm teilt.
- `SEVDESK_API_TOKEN_FILE`, das das Token in eine andere Klartextdatei verlegt.

Wer mehr als ein sevDesk-Konto führt (die eigene Firma und einen Mandanten, ein Testkonto) oder eine
nur lesende und eine buchende Einrichtung desselben Kontos, wiederholt außerdem einen ganzen Block
Variablen in jedem Client-Eintrag und kann leicht das falsche Token mit den falschen Stufen paaren.

Der Fernzugriff hat eigene Antworten (OAuth mit Zustimmungsseite, Docker-Secrets), und ein
Container hat keinen Schlüsselbund. Diese Entscheidung betrifft nur lokale Installationen.

## Entscheidung

**Der Schlüsselbund des Betriebssystems ist eine dritte Quelle für das Token, nur über stdio.**
`SEVDESK_API_TOKEN_KEYCHAIN=<label>` liest das Token, das unter dieser Bezeichnung abgelegt ist
(`src/safety/keychain.ts`). Genau eine von `SEVDESK_API_TOKEN`, `SEVDESK_API_TOKEN_FILE` und
`SEVDESK_API_TOKEN_KEYCHAIN` darf gesetzt sein.

| Plattform         | Lesen                                        | Ablegen                                   |
| ----------------- | -------------------------------------------- | ----------------------------------------- |
| macOS             | `/usr/bin/security find-generic-password -w` | `security -i`, der Befehl über stdin      |
| Linux und weitere | `secret-tool lookup` (libsecret)             | `secret-tool store`, das Token über stdin |
| Windows           | Windows PowerShell / WinRT `PasswordVault`   | `PasswordVault.Add`, das Token über stdin |

- **Fester Dienst, nur die Bezeichnung.** Jeder Eintrag liegt unter dem Dienst
  `mcp-server-sevdesk`; die Konfiguration nennt nur die Bezeichnung (das Konto des Eintrags), die mit
  einem Buchstaben oder einer Ziffer beginnen muss und höchstens 64 Buchstaben, Ziffern, `.`, `_`
  oder `-` enthalten darf. Eine feindliche Konfiguration kann den Server deshalb nicht dazu bringen,
  einen anderen Schlüsselbund-Eintrag (ein GitHub-Token, ein Passwort) zu lesen und an eine eigene
  `SEVDESK_BASE_URL` zu senden. Eine Bezeichnung, die wie ein Token aussieht, wird abgelehnt und nie
  ausgegeben.
- **Das Hilfsprogramm läuft ohne Shell**, aus einem Argument-Array. Beim Ablegen reist das Token
  über stdin des Hilfsprogramms, nie in seinen Argumenten, die andere lokale Benutzer in der
  Prozessliste sehen können. `security -i` parst diese stdin-Zeile selbst; abgelegt werden deshalb
  nur Tokens aus `[A-Za-z0-9_-]` (sevDesk-Tokens sind 32 Hex-Zeichen), und nichts muss maskiert
  werden.
- **Auflösung des Hilfsprogramms unter Windows.** Nur das absolute
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, mit `-NoLogo`, `-NoProfile`,
  `-NonInteractive` und `-Command`. `SystemRoot` ist geerbte, vertrauenswürdige Konfiguration des
  Betriebssystems: Es muss ein lokales Verzeichnis mit absolutem Laufwerkspfad sein, ohne
  Verzeichniswechsel nach oben, Geräte- oder UNC-Pfade und Steuerzeichen. Fehlende oder ungültige
  Werte werden im Zweifel abgelehnt; es gibt keinen Rückgriff auf das aktuelle Verzeichnis, `PATH`,
  `pwsh` oder eine Ausnahme von der Ausführungsrichtlinie. Die normale System32-Umleitung von Windows
  gilt für 32-Bit-Node. Das verhindert das Unterschieben eines Programms über das aktuelle
  Verzeichnis oder `PATH`, nicht eine kompromittierte Prozessumgebung oder Windows-Installation.
- **Protokoll unter Windows.** Ein konstantes Skript verwendet WinRT
  `Windows.Security.Credentials.PasswordVault` ohne `Add-Type`; die Ressource ist immer
  `mcp-server-sevdesk`, der Benutzername die geprüfte Bezeichnung. Operation, Bezeichnung und Token
  reisen als drei ASCII-Zeilen über stdin und werden nie in das Skript eingesetzt. `Add` legt ab oder
  ersetzt, `Retrieve` liest, und `Remove` löscht nur dieses Paar. Ein Erfolg liefert genau
  `TOKEN:<token>` oder `OK` plus Zeilenumbruch. Unerwartete Ausgabe wird abgelehnt. Abgefangene
  Ausnahmen werden auf private Exit-Codes reduziert: 2 für HRESULT `0x80070490` (nicht gefunden),
  3 für `0x80070005` (verweigert), 4 für einen nicht unterstützten Sprachmodus, 5 für ungültige
  Eingabe, 1 für andere Fehler. Weder Ausnahmemeldungen noch Ausgaben des Hilfsprogramms werden
  weitergegeben.
- **Korrektur zum Constrained Language Mode.** `Add-Type` zu vermeiden macht `PasswordVault` im CLM
  **nicht** nutzbar: Windows PowerShell erlaubt Konstruktion und Methodenaufrufe nur für seine
  [erlaubten Typen](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes?view=powershell-5.1#constrainedlanguage-mode).
  Das Hilfsprogramm verlangt `FullLanguage`, lehnt andere Modi ab, bevor es stdin liest, und
  verweist auf `SEVDESK_API_TOKEN_FILE` oder das `.mcpb`-Bundle. Es schaltet die Richtlinie nie ab.
  Die Unterstützung für CLM aus dem ursprünglichen Vorschlag bleibt offen; ein echter Durchlauf von
  Ablegen, Prüfen und Löschen unter Windows und eine Prüfung des Serverstarts stehen ebenfalls aus
  (die Umsetzung wurde unter macOS mit eingeschleustem Spawn getestet).
- **Ausgaben werden nie wiedergegeben.** stdout ist auf 4 KiB begrenzt, stderr wird verworfen, das
  Hilfsprogramm wird beim Start nach 15 s beendet (120 s für die Befehle der Kommandozeile, bei
  denen eine Person womöglich einen Dialog beantworten muss), und Fehler sind feste Texte, die nach
  dem Exit-Code gewählt werden (`security` endet mit dem unteren Byte des OSStatus: 44 nicht
  gefunden, 128 verweigert, 36 gesperrt ohne Dialog). Der gelesene Wert wird wie jedes Token
  geprüft.
- **Kommandozeile.** `token set <label>` fragt in einem Terminal verdeckt nach dem Token oder liest
  es von stdin, nie aus der Befehlszeile. Es prüft das Token zuerst bei sevDesk (`GET /SevClient`)
  und legt nichts ab, was sevDesk ablehnt; ist sevDesk nicht erreichbar, legt es das Token mit einer
  Warnung ab. Es liest den Eintrag zur Bestätigung zurück und gibt nur die Bezeichnung und die
  Konto-ID aus. `token check <label>` liest den Eintrag und prüft ihn bei sevDesk;
  `token delete <label>` entfernt ihn.

**Profile: benannte Einrichtungen in einer Datei, gewählt mit `SEVDESK_PROFILE`**
(`src/accounts/profiles.ts`, `src/accounts/local-config.ts`).

- **Ort:** `SEVDESK_PROFILES_PATH` (absolut), sonst
  `$XDG_CONFIG_HOME/mcp-server-sevdesk/profiles.json` oder
  `~/.config/mcp-server-sevdesk/profiles.json` (auch unter macOS), unter Windows
  `%APPDATA%\mcp-server-sevdesk\profiles.json`. Der Server liest die Datei nur, wenn
  `SEVDESK_PROFILE` gesetzt ist.
- **Format:** striktes JSON, höchstens 64 KiB, `{"version": 1, "profiles": {"<name>": {…}}}`,
  unbekannte Schlüssel werden abgelehnt. Die Schlüssel eines Profils sind `token`, `allow`,
  `readOnly`, `dryRun`, `confirm`, `toolsets`, `fileDirs`, `outputDir`, `auditLog`, `baseUrl`,
  `rateLimit` und `timeoutMs`.
- **Tokens nur als Verweis.** `token` ist `{"keychain": "<label>"}`, `{"file": "/absolute/path"}`
  oder `{"env": "SEVDESK_TOKEN_<NAME>"}`. Ein in die Datei geschriebenes Token wird abgelehnt und nie
  ausgegeben; `env` darf nur `SEVDESK_TOKEN_*`-Variablen nennen, sodass ein Profil kein fremdes
  Geheimnis aus der Umgebung an sevDesk oder an eine eigene Basis-URL senden kann.
- **Ein Profil legt sich über dieselben Variablen.** Jeder Schlüssel setzt seine
  `SEVDESK_*`-Variable, und das Ergebnis läuft durch das unveränderte
  `readSettings`/`loadConfig`. Ein Profil kann nichts ausdrücken, was die Umgebung nicht kann, und
  jede Prüfung (https-Basis-URL, das Abschalten der Bestätigung, absolute Ordner) gilt unverändert.
  Probleme nennen den Schlüssel des Profils, aus dem sie stammen.
- **Konflikte sind Fehler.** Eine Variable, die sowohl in der Umgebung als auch durch das Profil
  gesetzt ist, ist ein Konfigurationsfehler, der beide nennt; niemand muss sich also merken, welche
  gewinnt. Die eine Ausnahme verschärft: `SEVDESK_READ_ONLY=1` und `SEVDESK_DRY_RUN=1` in der
  Umgebung gewinnen immer. Ein unbekannter Profilname listet die vorhandenen auf.
- **Vertrauen (POSIX).** Ein Profil kann Stufen und Ordner erweitern; die Datei und ihr Ordner (wie
  angegeben und nach Auflösen symbolischer Links, z. B. ein Dotfiles-Checkout) müssen deshalb dem
  Benutzer oder root gehören und dürfen für Gruppe und andere nicht beschreibbar sein; sonst wird
  die Datei abgelehnt. Eine Token-Datei eines Profils, die andere lesen können, bekommt nur eine
  Warnung. Unter Windows wird nichts geprüft.
- `profiles list` zeigt für jedes Profil die Quelle des Tokens (`keychain:work`, `file:/…`,
  `env:SEVDESK_TOKEN_…`), Stufen und Werkzeuggruppen, nie ein Token. Das Startlog nennt das
  verwendete Profil.

**Der HTTP-Modus lehnt** `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` und
`SEVDESK_API_TOKEN_KEYCHAIN` **ab**: Ein Server hat eine einzige Quelle für seine Konfiguration,
seine Umgebung.

## Folgen

- Vorteil: Das Token muss nicht mehr in der Konfigurationsdatei eines Clients oder in einer
  Klartextdatei stehen.
- Vorteil: mehrere Konten oder Einrichtungen aus einer Client-Konfiguration, jede mit eigenen
  Stufen, Ordnern und eigenem Audit-Log, umgeschaltet mit einer Variablen.
- Vorteil: Profile bringen keine neue Bedeutung von Einstellungen mit: dieselbe Prüfung, dieselben
  Meldungen, und die Umgebung lässt sich nicht stillschweigend überschreiben.
- Nachteil: Der Schlüsselbund schützt das Token im Ruhezustand, nicht vor Code, der bereits als
  derselbe Benutzer läuft. Unter macOS vertraut der Eintrag `/usr/bin/security`, das ihn angelegt
  hat; jeder Prozess des Benutzers kann ihn also über dieses Programm ohne Dialog lesen (wie bei
  anderen Kommandozeilenprogrammen, die den Schlüsselbund verwenden).
- Nachteil: Linux braucht `secret-tool` und einen laufenden, entsperrten Secret Service (GNOME
  Keyring, KWallet); Rechner ohne Oberfläche sollten weiter `SEVDESK_API_TOKEN_FILE` verwenden.
- Nachteil: Windows braucht Windows PowerShell im Modus `FullLanguage`; die Profildatei wird dort
  nicht auf Berechtigungen geprüft. `PasswordVault` verwendet den Credential Locker, nicht die
  generischen Anmeldeinformationen von Win32 `CredWrite`. Seine Einträge können
  [mit dem Microsoft-Konto synchronisiert werden](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker);
  wer nur lokale Ablage verlangt, sollte stattdessen eine geschützte Token-Datei verwenden.
- Nachteil: Jeder Start über stdio mit einer Bezeichnung für den Schlüsselbund startet ein
  Hilfsprogramm, und ein gesperrter Schlüsselbund kann den Start bis zu 15 s aufhalten.
- Nachteil: Ein Client, der eine Variable immer setzt (zum Beispiel ein Plugin mit einem Standardwert
  für `SEVDESK_ALLOW`), gerät in Konflikt mit Profilen, die sie ebenfalls setzen; solche Clients
  müssen nicht gesetzte Variablen leer lassen.

## Erwogene Alternativen

- **Ein natives Schlüsselbund-Modul** (`keytar`, inzwischen archiviert, oder neuere
  N-API-Bindings). Verworfen: native Binärdateien je Plattform und Node-Version und mehr
  Angriffsfläche in der Lieferkette für ein einziges Nachschlagen; die Kommandozeilenprogramme
  liefert das Betriebssystem mit.
- **Das Token in den Argumenten des Hilfsprogramms übergeben**
  (`security add-generic-password -w <token>`). Verworfen: in der Prozessliste sichtbar, solange das
  Hilfsprogramm läuft.
- **Die Konfiguration jeden Dienst oder Eintrag im Schlüsselbund nennen lassen.** Verworfen: Eine
  feindliche Konfiguration könnte fremde Geheimnisse lesen und an eine eigene Basis-URL senden.
- **Tokens in der Profildatei.** Verworfen: Das wäre eine zweite Klartextdatei mit Token.
- **TOML, YAML oder JSON mit Kommentaren.** Verworfen: Jedes braucht einen Parser als Abhängigkeit;
  striktes JSON genügt für ein Dutzend Schlüssel.
- **Stiller Vorrang** (Profil vor Umgebung oder umgekehrt). Verworfen: Ein Client, der
  `SEVDESK_ALLOW` setzt, würde ein Profil stillschweigend erweitern oder einengen. Ein ausdrücklicher
  Fehler ist klarer; nur die sichere Richtung (nur lesend, Probelauf) ist ohne Fehler erlaubt.
- **Eine verschlüsselte Token-Datei mit Passphrase.** Verworfen: Die Passphrase braucht selbst einen
  sicheren Ort, und das ist der Schlüsselbund.

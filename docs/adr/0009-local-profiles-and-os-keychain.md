# ADR 0009: Local profiles and the OS keychain

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

A sevDesk API token has full access to its account, no scopes and no expiry. Over stdio the
server got it in one of two ways, both plain text:

- `SEVDESK_API_TOKEN` in the MCP client's configuration (`claude_desktop_config.json`, `.mcp.json`,
  Claude Code's settings). Those files are synced, backed up, kept in dotfiles repositories and
  shown when people share their screen to get help.
- `SEVDESK_API_TOKEN_FILE`, which moves the token into another plain-text file.

People who keep more than one sevDesk account (their own company and a client, a trial account),
or a read-only and a bookkeeping setup of the same account, also repeat a whole block of variables
in every client entry and can easily pair the wrong token with the wrong tiers.

The remote mode has its own answers (OAuth with a consent page, Docker secrets), and a container
has no keychain. This decision is about local installs only.

## Decision

**The OS keychain is a third token source, over stdio only.** `SEVDESK_API_TOKEN_KEYCHAIN=<label>`
reads the token stored under that label (`src/safety/keychain.ts`). Exactly one of
`SEVDESK_API_TOKEN`, `SEVDESK_API_TOKEN_FILE` and `SEVDESK_API_TOKEN_KEYCHAIN` may be set.

| Platform        | Read                                         | Store                                   |
| --------------- | -------------------------------------------- | --------------------------------------- |
| macOS           | `/usr/bin/security find-generic-password -w` | `security -i`, the command on stdin     |
| Linux and other | `secret-tool lookup` (libsecret)             | `secret-tool store`, the token on stdin |
| Windows         | Windows PowerShell / WinRT `PasswordVault`   | `PasswordVault.Add`, the token on stdin |

- **Fixed service, label only.** Every item lives under the service `mcp-server-sevdesk`; the
  configuration names only the label (the item's account), which must start with a letter or
  digit and contain at most 64 letters, digits, `.`, `_` or `-`. A hostile configuration can
  therefore not make the server read some other keychain item (a GitHub token, a password) and send
  it to a custom `SEVDESK_BASE_URL`. A label that looks like a token is refused and never echoed.
- **The helper runs without a shell**, from an argument array. When storing, the token travels on
  the helper's stdin, never in its arguments, which other local users can see in the process list.
  `security -i` parses that stdin line itself, so only tokens of `[A-Za-z0-9_-]` are stored
  (sevDesk tokens are 32 hex characters) and nothing needs quoting.
- **Windows helper resolution.** Use only the absolute
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with `-NoLogo`, `-NoProfile`,
  `-NonInteractive` and `-Command`. `SystemRoot` is inherited trusted OS configuration: it must be a
  local drive-absolute directory, with no traversal, device/UNC paths or control characters.
  Missing or invalid values fail closed; there is no fallback to the current directory, `PATH`,
  `pwsh` or an execution-policy override. Windows' normal System32 redirection applies to 32-bit
  Node. This prevents cwd/PATH executable substitution, not a compromised process environment
  or Windows installation.
- **Windows protocol.** One constant script uses WinRT `Windows.Security.Credentials.PasswordVault`
  without `Add-Type`; the resource is always `mcp-server-sevdesk`, the username is the validated
  label. Operation, label and token travel as three ASCII lines on stdin, never interpolated
  into the script. `Add` stores/replaces, `Retrieve` reads, and `Remove` deletes only that pair.
  Success returns exactly `TOKEN:<token>` or `OK` plus a newline. Unexpected output is refused.
  Caught exceptions are reduced to private exit codes: 2 for HRESULT `0x80070490` (not found),
  3 for `0x80070005` (denied), 4 for an unsupported language mode, 5 for invalid input, 1 for
  other failures. Neither exception messages nor helper output are surfaced.
- **Constrained Language Mode correction.** Avoiding `Add-Type` does **not** make `PasswordVault`
  usable in CLM: Windows PowerShell only permits construction and method invocation for its
  [allowed types](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes?view=powershell-5.1#constrainedlanguage-mode).
  The helper requires `FullLanguage`, refuses other modes before reading stdin, and points to
  `SEVDESK_API_TOKEN_FILE` or the `.mcpb` bundle. It never disables the policy. CLM support from
  the original proposal remains open; a real Windows set/check/delete and server-start check
  is also required (the implementation was tested with injected spawn on macOS).
- **Output is never echoed.** stdout is capped at 4 KiB, stderr is discarded, the helper is killed
  after 15 s at startup (120 s for the CLI commands, where a person may have to answer a dialog),
  and errors are fixed texts chosen by exit code (`security` exits with the low byte of the
  OSStatus: 44 not found, 128 denied, 36 locked without a dialog). The value read is checked like
  any token.
- **CLI.** `token set <label>` asks for the token with hidden input on a terminal, or reads it from
  stdin, never from the command line. It checks the token with sevDesk (`GET /SevClient`) first and
  stores nothing sevDesk rejects; when sevDesk cannot be reached it stores the token with a
  warning. It reads the item back to confirm and prints only the label and the account id.
  `token check <label>` reads the item and checks it with sevDesk; `token delete <label>` removes
  it.

**Profiles: named setups in one file, picked with `SEVDESK_PROFILE`**
(`src/accounts/profiles.ts`, `src/accounts/local-config.ts`).

- **Location:** `SEVDESK_PROFILES_PATH` (absolute), else
  `$XDG_CONFIG_HOME/mcp-server-sevdesk/profiles.json` or `~/.config/mcp-server-sevdesk/profiles.json`
  (also on macOS), on Windows `%APPDATA%\mcp-server-sevdesk\profiles.json`. The server reads it only
  when `SEVDESK_PROFILE` is set.
- **Format:** strict JSON, at most 64 KiB, `{"version": 1, "profiles": {"<name>": {…}}}`, unknown
  keys refused. A profile's keys are `token`, `allow`, `readOnly`, `dryRun`, `confirm`, `toolsets`,
  `fileDirs`, `outputDir`, `auditLog`, `baseUrl`, `rateLimit` and `timeoutMs`.
- **Tokens by reference only.** `token` is `{"keychain": "<label>"}`, `{"file": "/absolute/path"}`
  or `{"env": "SEVDESK_TOKEN_<NAME>"}`. A token written into the file is refused and never echoed;
  `env` may only name `SEVDESK_TOKEN_*` variables, so a profile cannot send an unrelated secret
  from the environment to sevDesk or to a custom base URL.
- **A profile is an overlay of the same variables.** Each key sets its `SEVDESK_*` variable, and
  the result goes through the unchanged `readSettings`/`loadConfig`. A profile can express nothing
  the environment cannot, and every check (https base URL, the confirmation opt-out, absolute
  folders) applies unchanged. Problems name the profile key they came from.
- **Conflicts are errors.** A variable set both in the environment and by the profile is a
  configuration error naming both, so nobody has to remember which one wins. The one exception
  tightens: `SEVDESK_READ_ONLY=1` and `SEVDESK_DRY_RUN=1` in the environment always win. An unknown
  profile name lists the available ones.
- **Trust (POSIX).** A profile can widen tiers and folders, so the file and its folder (as written
  and after resolving symlinks, e.g. a dotfiles checkout) must belong to the user or root and must
  not be writable by group or others; otherwise the file is refused. A profile's token file that
  others can read gets a warning only. Windows is not checked.
- `profiles list` shows each profile's token source (`keychain:work`, `file:/…`,
  `env:SEVDESK_TOKEN_…`), tiers and toolsets, never a token. The startup log names the profile in
  use.

**HTTP mode refuses** `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` and `SEVDESK_API_TOKEN_KEYCHAIN`:
a server keeps one source of configuration, its environment.

## Consequences

- Good: the token no longer has to sit in a client's configuration file or in a plain-text file.
- Good: several accounts or setups from one client configuration, each with its own tiers,
  folders and audit log, switched with one variable.
- Good: profiles add no new settings semantics: the same validation, the same messages, and the
  environment cannot be silently overridden.
- Bad: the keychain protects the token at rest, not against code that already runs as the same
  user. On macOS the item trusts `/usr/bin/security`, which created it, so any process of the user
  can read it through that tool without a dialog (as with other command-line tools that use the
  keychain).
- Bad: Linux needs `secret-tool` and a running, unlocked Secret Service (GNOME Keyring, KWallet);
  headless machines should keep using `SEVDESK_API_TOKEN_FILE`.
- Bad: Windows needs Windows PowerShell in `FullLanguage` mode; the profiles file is not
  permission-checked there. `PasswordVault` uses the Credential Locker, not Win32 `CredWrite`
  generic credentials. Its entries can [roam with the Microsoft account](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker);
  users who require local-only storage should use a protected token file instead.
- Bad: every stdio start with a keychain label spawns a helper, and a locked keychain can hold the
  start for up to 15 s.
- Bad: a client that always sets a variable (for example a plugin that defaults `SEVDESK_ALLOW`)
  conflicts with profiles that set it too; such clients must leave unset variables empty.

## Alternatives considered

- **A native keychain module** (`keytar`, now archived, or newer N-API bindings). Rejected: native
  binaries per platform and Node version, and more supply-chain surface for one lookup; the
  command-line helpers ship with the OS.
- **Passing the token in the helper's arguments** (`security add-generic-password -w <token>`).
  Rejected: visible in the process list while the helper runs.
- **Letting the configuration name any keychain service or item.** Rejected: a hostile
  configuration could read unrelated secrets and send them to a custom base URL.
- **Tokens inside the profiles file.** Rejected: that is a second plain-text token file.
- **TOML, YAML or JSON with comments.** Rejected: each needs a parser dependency; strict JSON is
  enough for a dozen keys.
- **Silent precedence** (profile over environment, or the reverse). Rejected: a client that sets
  `SEVDESK_ALLOW` would silently widen or narrow a profile. An explicit error is clearer; only the
  safe direction (read-only, dry-run) is allowed without one.
- **An encrypted token file with a passphrase.** Rejected: the passphrase needs a safe place of its
  own, which is the keychain.

# Profiles and keychain

This page shows how to keep the sevDesk token out of your client's configuration with the OS
keychain, and how to keep several accounts or setups in one profiles file. Both work over stdio
only, not with `--http`. Their threat analysis is in [Local security](../security/local.md); every
other variable is in [Configuration](../configuration.md).

## Keep the token in the OS keychain

Instead of writing the token into your client's configuration, store it once in your operating
system's keychain and give the server only its label:

```bash
npx -y mcp-server-sevdesk token set work
```

The command asks for the token (the input is hidden), checks it with sevDesk, stores it under the
label `work` and prints the account id. If sevDesk rejects the token, nothing is stored; if
sevDesk cannot be reached, it is stored with a warning. Then configure the server with
`"SEVDESK_API_TOKEN_KEYCHAIN": "work"` instead of `SEVDESK_API_TOKEN`. A label is up to 64
letters, digits, `.`, `_` or `-` and starts with a letter or digit.

- `token check work` checks the stored token with sevDesk; `token delete work` removes it.
- The token is never taken from the command line, where it would stay in your shell history. To
  store it from a file, pipe it in: `npx -y mcp-server-sevdesk token set work < token.txt`, then
  delete the file. That redirection works in POSIX shells and `cmd.exe`; in PowerShell, use
  `Get-Content -Raw token.txt | npx -y mcp-server-sevdesk token set work`.

### Where the token is kept

- **macOS:** the login keychain, item `mcp-server-sevdesk`, account = your label.
- **Linux:** the Secret Service through `secret-tool` (package `libsecret-tools` on Debian and
  Ubuntu, `libsecret` on Fedora), with GNOME Keyring or KWallet running and unlocked. On a
  headless server, use `SEVDESK_API_TOKEN_FILE`.
- **Windows:** the Credential Locker through WinRT `PasswordVault`, resource
  `mcp-server-sevdesk`, username = your label. Uses Windows PowerShell at
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, without profiles or a PATH
  lookup. Keep `SystemRoot` set to the Windows installation directory. PowerShell 7 (`pwsh`)
  is not used. Constrained Language Mode cannot access this API, even without `Add-Type`;
  use `SEVDESK_API_TOKEN_FILE` or the
  [Claude Desktop extension](../clients/claude-desktop.md#the-extension) if Windows PowerShell is
  missing or restricted. Credential Locker entries can roam with your Microsoft account; use a
  protected token file if the token must stay on this device.

The keychain keeps the token out of configuration files, backups and screenshots. It does not
protect against programs that already run under your user account
([Local token storage and profiles](../security/local.md#local-token-storage-and-profiles)).

## Profiles

Profiles keep several setups in one file, for example two sevDesk accounts, or a read-only and a
bookkeeping setup of the same account, and pick one with `SEVDESK_PROFILE`. Create
`~/.config/mcp-server-sevdesk/profiles.json` (or point `SEVDESK_PROFILES_PATH` elsewhere; the
defaults per operating system are in [Profile selection](../configuration.md#profile-selection)):

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

Then set `"SEVDESK_PROFILE": "work"` in the client's `env`. The server logs `using profile "work"`
at startup.

### Keys

| Key         | Sets                 | Value                                                                                        |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `token`     | the token source     | `{"keychain": "<label>"}`, `{"file": "/absolute/path"}` or `{"env": "SEVDESK_TOKEN_<NAME>"}` |
| `allow`     | `SEVDESK_ALLOW`      | a list or a comma-separated string                                                           |
| `readOnly`  | `SEVDESK_READ_ONLY`  | `true` or `false`                                                                            |
| `dryRun`    | `SEVDESK_DRY_RUN`    | `true` or `false`                                                                            |
| `confirm`   | `SEVDESK_CONFIRM`    | a string                                                                                     |
| `toolsets`  | `SEVDESK_TOOLSETS`   | a list or a comma-separated string                                                           |
| `fileDirs`  | `SEVDESK_FILE_DIRS`  | a list of absolute paths                                                                     |
| `outputDir` | `SEVDESK_OUTPUT_DIR` | a string                                                                                     |
| `auditLog`  | `SEVDESK_AUDIT_LOG`  | a string                                                                                     |
| `baseUrl`   | `SEVDESK_BASE_URL`   | a string                                                                                     |
| `rateLimit` | `SEVDESK_RATE_LIMIT` | a number                                                                                     |
| `timeoutMs` | `SEVDESK_TIMEOUT_MS` | a number                                                                                     |

Each key sets the variable of the same meaning and is checked the same way
([Variables](../configuration.md#variables)).

### Rules

- **The file never holds a token.** `token` says where it is kept: a keychain label, an absolute
  file path, or a variable named `SEVDESK_TOKEN_<NAME>` that you set in the client's `env`. Without
  `token`, the usual token variables apply.
- **No silent overrides.** A variable set both in the environment and by the profile is an error
  that names both. Only tightening is allowed: `SEVDESK_READ_ONLY=1` and `SEVDESK_DRY_RUN=1` in
  the environment always win.
- **The file must be yours.** On macOS and Linux the file and its folder must belong to you (or
  root) and must not be writable by group or others (`chmod go-w`), because a profile can widen
  tiers and folders. Windows does not check this.
- The file is strict JSON of at most 64 KiB with `"version": 1`; unknown keys are refused.
- Profiles work over stdio only, not with `--http`.

### List the profiles

```bash
npx -y mcp-server-sevdesk profiles list
```

It shows every profile with where its token is kept, its tiers and toolsets, and marks the one
`SEVDESK_PROFILE` names. It never prints a token.

## Several accounts without profiles

Over stdio you can also add the server once per account under different names in your client, each
with its own token. Profiles keep those setups in one place instead.

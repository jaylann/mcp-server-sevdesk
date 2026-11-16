# Local use

The security analysis of what the server touches on your own machine: local files, the generic
read tool, the token in the keychain, profiles and the Claude Desktop extension. How to set these
up is in [Configuration](../configuration.md) and [Profiles](../configuration/profiles.md); the
audit log's integrity is described with the log itself
([Audit log](../permissions/audit-log.md#integrity)).

## Local files

The model names files, so the server must not become a way to read or write arbitrary files.
Without `SEVDESK_FILE_DIRS` and `SEVDESK_OUTPUT_DIR`, no tool reads or writes local files.

- **Reading** happens only inside `SEVDESK_FILE_DIRS` (absolute folders). Real paths are checked,
  symbolic links may not lead outside, the file is opened without following a link and checked by
  inode, its type is recognized by content, and sizes are capped.
- **Writing** happens only inside `SEVDESK_OUTPUT_DIR`: new files only, mode 0600, never
  overwriting.

Received e-invoices are hostile input. The XML parser refuses DOCTYPEs and entities, caps size and
nesting depth and reads an element only in the namespace the invoice format defines for it. The
PDF attachment reader caps decompressed sizes, the number of values it builds from a PDF (one
million), the length of names, numbers and strings, and the parsing work per byte of the file.
Every parsed text field is treated as untrusted. A PDF is still parsed inside the server process,
so a hostile file at these limits can keep it busy for several seconds, but no longer.

The DATEV export ZIP is fetched from a presigned link that sevDesk returns. The server accepts
exactly one https host for it, follows no redirects, sends no credentials, caps the size and never
shows the link to the model.

## Generic read surface

`sevdesk_api_get` (toolset `advanced`, off by default) lets the model choose a GET path, which a
curated tool never does. It has four independent guards:

1. The configured sevDesk token anywhere in the path or the query is refused, and the refusal does
   not repeat the path.
2. `genericGetRefusal` refuses, before anything is sent, endpoints that change state, return files
   or start jobs (`getPdf`, `getXml`, `render`, `sendBy`, `bookAmount`, `enshrine`, `cancelInvoice`,
   the reset endpoints, `getNext…Number`, segments that start with a mutating verb, and everything
   under `Export`, `ExportJob`, `Progress`, `Report`, `DocServer` and `SevSequence`), and dangerous
   query keys: credentials (sevDesk accepts `?token=`), paging keys the tool sets itself,
   `download`, `preventSendBy`, `enshrine…`, `useNextNumber` and method overrides. Query keys are
   normalized the way PHP reads them, so `Api.Key` or `token[0]` are caught too.
3. The read-only client refuses every GET with a side effect that `resolveGetSafety` recognizes.
4. The HTTP client refuses it again, because a read declares no tier.

Answers are read with a 1 MiB cap, must be JSON in sevDesk's `{objects: …}` envelope, and are
cleaned as untrusted text: invisible characters removed, strings capped, binary content (base64
files, thumbnails) and `sevClient` echoes removed and listed, and at most about 100 KB returned.
The residual risk is an undocumented GET with a side effect that none of these rules matches; the
toolset is off by default for that reason.

## Local token storage and profiles

Over stdio the token comes from the environment, a file (`SEVDESK_API_TOKEN_FILE`) or the OS
keychain (`SEVDESK_API_TOKEN_KEYCHAIN`). It is never logged, echoed or included in errors.

### Keychain

Items live under the fixed service `mcp-server-sevdesk`; configuration names only the label, so a
hostile configuration cannot make the server read another keychain item (a password, another
token) and send it to a custom `SEVDESK_BASE_URL`. The server runs the operating system's helper
(`/usr/bin/security` on macOS, `secret-tool` on Linux, Windows PowerShell with WinRT
`PasswordVault` on Windows) with an argument array, never through a shell. When storing, the token
travels on the helper's stdin, never in its arguments, which other local users could see in the
process list. The helper's output is capped, never logged or echoed, and errors are fixed texts.

The keychain protects the token at rest, in configuration files, backups and screenshots; it does
not protect against code that already runs as the same user. On macOS the item trusts
`/usr/bin/security`, which created it, so any process of the user can read it that way without a
dialog.

On Windows the script is constant; operation, label and token travel only on stdin. The executable
is resolved only beneath a validated, trusted `SystemRoot`, never through `PATH` or the current
directory. Windows PowerShell must run in `FullLanguage` mode; Constrained Language Mode is refused
without changing policy, with a pointer to `SEVDESK_API_TOKEN_FILE` or the `.mcpb` bundle.
Credential Locker entries can roam with the Microsoft account; a protected token file is the
alternative when the token must stay on this device.

### The command line

`token set` reads the token from stdin (hidden on a terminal), never from an argument, where it
would stay in the shell history. It checks the token with sevDesk and stores nothing sevDesk
rejects. Labels, profile names and unknown arguments that look like a token are never echoed.

### Profiles

A profile can widen tiers and folders, so on macOS and Linux the profiles file and its folder (also
the real folder behind a symbolic link) must belong to the user or root and must not be writable by
group or others; otherwise the file is refused. Windows does not check this.

Profiles never hold a token, only where it is kept, and a profile's `token.env` may name only
`SEVDESK_TOKEN_*` variables, so a profile cannot send an arbitrary secret from the environment to a
custom base URL. A variable set both in the environment and by the profile is an error; only
`SEVDESK_READ_ONLY=1` and `SEVDESK_DRY_RUN=1` in the environment may tighten a profile silently.
Messages about the file never quote its content.

The HTTP mode refuses `SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` and `SEVDESK_API_TOKEN_KEYCHAIN`:
a server has no user keychain, and its configuration belongs in its environment.

## Claude Desktop extension

The `.mcpb` bundle runs the same server over stdio on Claude Desktop's built-in Node.js. Claude
Desktop stores the token, a setting marked sensitive, in the operating system's secure storage
(Keychain on macOS, Credential Manager on Windows) and passes it to the server as
`SEVDESK_API_TOKEN` when it starts it; the token never appears in the command line.

The bundle contains the server and all its dependencies in one file that imports only Node.js
built-ins, with the license notices of every bundled package. Confirmation cannot be switched off
in the extension: it offers no way to set `SEVDESK_I_UNDERSTAND_NO_CONFIRM`. The bundle is not
signed yet; verify a download with its provenance attestation
([Supply chain](supply-chain.md#the-claude-desktop-extension)).

# Configuration

All settings are environment variables. Over stdio you set them in the `env` of your MCP client's
server entry ([Clients](clients.md)); in [remote mode](remote.md) they go into the server's
environment. Only a token is required. Everything else defaults to the safest option: read-only,
human confirmation for binding steps, no access to local files.

The server reads the variables once at startup, reports every problem at once and does not start
until all of them are fixed. Restart the client (or the server) after a change.

Value formats:

- **Flags** take `1`, `true`, `yes` or `on`, and `0`, `false`, `no` or `off`.
- **Lists** are comma-separated and case-insensitive, for example `write,commit`.
- **Folder lists** are separated like `PATH`: `:` on macOS and Linux, `;` on Windows. Every entry
  must be an absolute path.
- An **empty value** counts as unset. Clients that pass every variable (such as the Claude Code
  plugin) can leave the unused ones empty.

## Variables

### Token

Set exactly one of these three.

| Variable                     | Default | Meaning                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_API_TOKEN`          |         | Your sevDesk API token (sevDesk: Settings → Users → API token), ideally of a dedicated user. The raw token, without a `Bearer ` prefix. Required over stdio and in bearer mode; not used in OAuth mode, where every user pastes their own on the consent page.                          |
| `SEVDESK_API_TOKEN_FILE`     |         | Read the token from this file instead (trimmed). For Docker and Kubernetes secrets, or a file only you can read (`chmod 600`).                                                                                                                                                          |
| `SEVDESK_API_TOKEN_KEYCHAIN` |         | Over stdio: read the token from the operating system's keychain, stored under this label with [`token set`](#keep-the-token-in-the-os-keychain). macOS and Linux; not available on Windows yet. A label is up to 64 letters, digits, `.`, `_` or `-` and starts with a letter or digit. |

### Permissions

| Variable                          | Default         | Meaning                                                                                                                                                                                                                                                  |
| --------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_ALLOW`                   | `read`          | The [permission tiers](permissions.md#tiers) to enable: a list of `read`, `write`, `commit`, `external`, or `all`. `read` is always on.                                                                                                                  |
| `SEVDESK_READ_ONLY`               | `0`             | `1` allows only read tools, whatever `SEVDESK_ALLOW` says.                                                                                                                                                                                               |
| `SEVDESK_DRY_RUN`                 | `0`             | `1` turns every write into a [dry run](permissions.md#dry-run): write tools check the call and return a preview (status `dry_run`); nothing is sent and nobody is asked. Per call: `dryRun: true`.                                                       |
| `SEVDESK_CONFIRM`                 | `elicit`        | How a human confirms `commit` and `external` calls: `elicit` (a prompt in your client), `browser` (an approval page in your browser) or `off`. See [Confirmation modes](permissions.md#confirmation-modes).                                              |
| `SEVDESK_I_UNDERSTAND_NO_CONFIRM` | `0`             | Must be `1` for `SEVDESK_CONFIRM=off` to be accepted.                                                                                                                                                                                                    |
| `SEVDESK_CONFIRM_OPEN`            | `1` (HTTP: `0`) | Browser mode over stdio: open each approval page in your default browser. `0` only writes its link to the server log (stderr). The link is never shown to the model. No effect in remote mode, where `1` is refused unless the server binds to loopback. |

### Tools and output

| Variable                    | Default   | Meaning                                                                                                                                                                                                                                      |
| --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEVDESK_TOOLSETS`          | `default` | The [toolsets](#toolsets) to load: a list of `meta`, `contacts`, `invoices`, `credit-notes`, `orders`, `vouchers`, `banking`, `parts`, `reports`, `advanced`, or `default` (everything except `advanced`) or `all`. `meta` is always loaded. |
| `SEVDESK_STRUCTURED_OUTPUT` | `auto`    | `auto`, `on` or `off`: whether tools declare an output schema and return typed `structuredContent` next to the JSON text. See [Structured output](#structured-output).                                                                       |

### Files and the audit log

| Variable             | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SEVDESK_FILE_DIRS`  |         | Folders that receipts and e-invoices may be read from, for voucher drafts (`sevdesk_voucher_create_draft`, `sevdesk_voucher_update_draft`), `sevdesk_einvoice_parse` and `sevdesk_voucher_import_einvoice`. Symbolic links must stay inside; nothing else on your disk can be read. Without it, those tools take no local files (and the two e-invoice tools are not offered). |
| `SEVDESK_OUTPUT_DIR` |         | The folder where `sevdesk_document_save`, `sevdesk_csv_export` and `sevdesk_datev_export` may write files (PDFs, e-invoice XML, CSV and DATEV exports). These tools are offered only when it is set. They create new files only, with mode 0600, and never overwrite one.                                                                                                      |
| `SEVDESK_AUDIT_LOG`  |         | Path of an append-only JSON Lines log of every write call (mode 0600): previews, confirmations, executions and failures. If it is set but cannot be written, writes are refused. See [Audit log](permissions.md#audit-log).                                                                                                                                                    |

In remote mode the folders are on the server. OAuth mode refuses both folder variables and uses
upload pages and download links instead ([remote.md](remote.md#files-uploads-and-download-links)).

### Connection

| Variable             | Default                        | Meaning                                                                                              |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `SEVDESK_RATE_LIMIT` | `4`                            | Requests per second to sevDesk, 0.1–50. sevDesk publishes no limit.                                  |
| `SEVDESK_TIMEOUT_MS` | `30000`                        | Timeout of one request in milliseconds, 1000–300000.                                                 |
| `SEVDESK_BASE_URL`   | `https://my.sevdesk.de/api/v1` | The API base URL. https only, without a username, password, query string or fragment. Rarely needed. |

### Profile selection

| Variable                | Default                                      | Meaning                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SEVDESK_PROFILE`       |                                              | Over stdio: use this profile from the profiles file ([Profiles](#profiles)).                                                                                                                                       |
| `SEVDESK_PROFILES_PATH` | `~/.config/mcp-server-sevdesk/profiles.json` | Where the profiles file is, as an absolute path. Default on Linux and macOS: `$XDG_CONFIG_HOME/mcp-server-sevdesk/profiles.json` if that variable is set; on Windows `%APPDATA%\mcp-server-sevdesk\profiles.json`. |

`SEVDESK_PROFILE`, `SEVDESK_PROFILES_PATH` and `SEVDESK_API_TOKEN_KEYCHAIN` work over stdio only;
the HTTP server refuses to start with them.

### HTTP mode

`--http` reads further variables (`SEVDESK_HTTP_*`, `SEVDESK_OAUTH_*`) and changes the meaning of
some of the variables above. Both are described in the
[remote mode configuration reference](remote.md#configuration-reference).

## Toolsets

A toolset is a group of tools for one area. `SEVDESK_TOOLSETS` picks the toolsets, and
`SEVDESK_ALLOW` picks the tiers within them: a tool is offered only when both enable it. Loading
fewer toolsets makes the tool list shorter, which helps models choose and saves tokens.

| Toolset        | Covers                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta`         | Account overview, reference data (tax rules, booking accounts, units, countries, …), saving document files, upload requests in remote mode. Always loaded. |
| `contacts`     | Customers and suppliers: search, get, create, update, next customer number.                                                                                |
| `invoices`     | Invoices (Rechnungen): list, get, drafts, invoices from orders, reminders (Mahnungen), the lifecycle, PDF, e-invoice XML and readiness check.              |
| `credit-notes` | Credit notes (Gutschriften): list, get, drafts, credit notes from invoices, the lifecycle, PDF.                                                            |
| `orders`       | Orders (Angebote, Auftragsbestätigungen, Lieferscheine): list, get, drafts, finalize, send, PDF.                                                           |
| `vouchers`     | Vouchers (Belege): list, get, drafts with the receipt attached, e-invoice parsing and import, the lifecycle.                                               |
| `banking`      | Bank accounts and transactions, reconciliation suggestions, booking transactions against documents, private transactions.                                  |
| `parts`        | Parts (Artikel) including stock: list, get, create, update.                                                                                                |
| `reports`      | Summaries, receivables and payables aging, cash position, changes since a date, VAT summary, profit and loss, CSV and DATEV exports.                       |
| `advanced`     | `sevdesk_api_get`, a read-only GET of any sevDesk endpoint. Off by default.                                                                                |

Every tool, with its toolset, tier and arguments, is listed in the [tool reference](tools.md).

### The advanced toolset

`advanced` is off unless you name it (`SEVDESK_TOOLSETS=default,advanced`) or load `all`. It has
one tool, `sevdesk_api_get`: a read-only GET of a sevDesk endpoint that no other tool covers, for
example the text templates (`/TextTemplate`), units of parts (`/PartUnity`) or attached documents
(`/Document`).

- It refuses everything that could change data, return files or start jobs (`getPdf`, `sendBy`,
  `bookAmount`, `enshrine`, the next-number endpoints, exports and reports, …) before anything is
  sent, and it never puts a token into the URL.
- Answers are sevDesk's raw objects, cleaned as untrusted text: invisible characters removed,
  long strings cut, binary content (base64 files, thumbnails) removed and listed. At most about
  100 KB are returned per call (answers over 1 MiB are refused); `nextOffset` continues a longer
  list.
- Prefer the curated tools: they check inputs, explain fields and format money and dates.

The toolset is off by default because a generic read cannot know every endpoint as well as a
curated tool; see [SECURITY.md](../SECURITY.md#generic-read-surface).

## Structured output

Every tool returns its result as a JSON text block. With structured output it also declares an
`outputSchema` in `tools/list` and returns the same data as typed `structuredContent`, which
clients can validate and display.

| Value  | Behavior                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `auto` | Structured output only for clients on MCP protocol revision 2026-07-28 or later, because some older clients mishandle it. |
| `on`   | Always.                                                                                                                   |
| `off`  | Never; only the JSON text.                                                                                                |

## Limits

| What                                       | Limit                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| List tools                                 | Pages of 1–100 records (default 25); results say how many records were left out.                         |
| Requests to sevDesk                        | `SEVDESK_RATE_LIMIT` per second (default 4) and at most 4 at a time; reads may be retried, writes never. |
| Receipts and e-invoices read from a folder | 20 MiB per file; the XML inside an e-invoice PDF 5 MiB.                                                  |
| Document files (PDF, XML)                  | 20 MiB.                                                                                                  |
| `sevdesk_api_get`                          | 1–1000 rows per call, about 100 KB returned, answers over 1 MiB refused.                                 |
| Browser approvals                          | 10 minutes each, used once, at most 5 waiting at a time.                                                 |
| Server instructions                        | At most 1,500 characters.                                                                                |

Remote mode adds limits of its own (body sizes, rate limits per client, upload sizes): see
[remote.md](remote.md#limits).

## Keep the token in the OS keychain

Instead of writing the token into your client's configuration, store it once in your operating
system's keychain and give the server only its label:

```sh
npx -y mcp-server-sevdesk token set work
```

The command asks for the token (the input is hidden), checks it with sevDesk, stores it under the
label `work` and prints the account id. If sevDesk rejects the token, nothing is stored; if
sevDesk cannot be reached, it is stored with a warning. Then configure the server with
`"SEVDESK_API_TOKEN_KEYCHAIN": "work"` instead of `SEVDESK_API_TOKEN`.

- `token check work` checks the stored token with sevDesk; `token delete work` removes it.
- The token is never taken from the command line, where it would stay in your shell history. To
  store it from a file, pipe it in: `npx -y mcp-server-sevdesk token set work < token.txt`, then
  delete the file.
- **macOS:** the login keychain, item `mcp-server-sevdesk`, account = your label.
- **Linux:** the Secret Service through `secret-tool` (package `libsecret-tools` on Debian and
  Ubuntu, `libsecret` on Fedora), with GNOME Keyring or KWallet running and unlocked. On a
  headless server, use `SEVDESK_API_TOKEN_FILE`.
- **Windows:** not supported yet. Use `SEVDESK_API_TOKEN_FILE`, or the
  [Claude Desktop extension](clients.md#claude-desktop), which keeps the token in Windows'
  credential storage.

The keychain keeps the token out of configuration files, backups and screenshots. It does not
protect against programs that already run under your user account (see
[SECURITY.md](../SECURITY.md#local-token-storage-and-profiles)).

## Profiles

Profiles keep several setups in one file, for example two sevDesk accounts, or a read-only and a
bookkeeping setup of the same account, and pick one with `SEVDESK_PROFILE`. Create
`~/.config/mcp-server-sevdesk/profiles.json` (or point `SEVDESK_PROFILES_PATH` elsewhere):

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

Each key sets the variable of the same meaning and is checked the same way. Rules:

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
- `npx -y mcp-server-sevdesk profiles list` shows every profile with where its token is kept, its
  tiers and toolsets, and marks the one `SEVDESK_PROFILE` names. It never prints a token.
- Profiles work over stdio only, not with `--http`.

## Command line

`mcp-server-sevdesk` without arguments serves MCP over stdio; that is what MCP clients run. The
other commands are for you. Run them with `npx -y mcp-server-sevdesk <command>`, or with Docker
as `docker run --rm ghcr.io/jaylann/mcp-server-sevdesk:<version> <command>`.

| Command                    | What it does                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--stdio`                  | Serve MCP over stdio (the default).                                                                                             |
| `--http`                   | Serve MCP over Streamable HTTP; needs `SEVDESK_HTTP_AUTH` ([remote.md](remote.md)).                                             |
| `token set <label>`        | Store a sevDesk token in the OS keychain; asks for it, or reads it from stdin. See [above](#keep-the-token-in-the-os-keychain). |
| `token check <label>`      | Check the token stored under the label with sevDesk.                                                                            |
| `token delete <label>`     | Delete the token stored under the label.                                                                                        |
| `profiles list`            | List the profiles of the profiles file.                                                                                         |
| `account-id`               | Print the sevDesk account id of the configured token (any token source, or a profile), for `SEVDESK_OAUTH_ACCOUNTS`.            |
| `grants list [--json]`     | Remote mode: list the OAuth grants in `SEVDESK_HTTP_STATE_DIR`.                                                                 |
| `grants revoke <grant-id>` | Remote mode: revoke one grant; `--account <id>` revokes every grant of an account, `--all` all of them.                         |
| `generate-secret`          | Print 32 random bytes for `SEVDESK_HTTP_SECRET` or a bearer secret.                                                             |
| `healthcheck`              | Ask the local HTTP server for `/healthz` (the container health check).                                                          |
| `--version`, `--help`      | Print the version or the help.                                                                                                  |

Exit codes: `0` success, `1` failure (the reason is printed to stderr), `2` unknown command or
argument. The remote-mode commands are described in detail in
[remote.md](remote.md#commands).
